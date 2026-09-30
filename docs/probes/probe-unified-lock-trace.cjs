// 归档自 _tmp（2026-09-26 凌晨：?unified=1 导入卡死修复 + 打包验收），REPO 路径已按 docs/probes/ 调整。
// 探针 37：找出 unified 导入里**到底哪一次 `Texture.lock()` 没返回**。
//
// 已知：
//   · `?unified=1` 从启动就打开时，`scene.events.invoke('import', ...)` 的 promise 永不 settle；
//   · 曲线表那次直传以前是坏的（`Number(CURVE_CHANNELS)` = NaN）⇒ 每次都会走 `lock()` 兜底 ——
//     已修；但导入**仍然**不 settle ⇒ 还有第二处卡点。
//   · 仓库里 `lock()` 的调用点有两处：`bindAsset`（曲线表）与 `setCurves`。
// 做法：把已有纹理的**原型**上的 `lock` 包一层（记录名字、开始时间、是否返回），
// 然后在 `?unified=1` 下 fire-and-forget 导入，15 秒后看哪些 lock 没回来。
//
// usage: node _tmp/probe-unified-lock-trace.cjs [model]
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..', '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const { launchPatched: _launchPatched } = require('../verify/lib/browser.cjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL = process.argv[2] || 'test-model.ply';
const UNIFIED = process.argv[3] !== '0';

(async () => {
    cleanupOrphanBrowsers();
    const browser = await _launchPatched(puppeteer, {
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 300000
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 640, height: 440 });
    const logs = [];
    page.on('console', (m) => logs.push(`${m.type()}: ${m.text().slice(0, 200)}`));
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));

    const url = UNIFIED ? 'http://localhost:3100/?gpu=webgpu&unified=1' : 'http://localhost:3100/?gpu=webgpu';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1500);

    const patched = await page.evaluate(() => {
        const scene = window.scene;
        const tex = (scene.app.graphicsDevice.textures || [])[0];
        if (!tex) return { ok: false, why: 'no texture to steal prototype from' };
        let proto = Object.getPrototypeOf(tex);
        // 往上找到真正定义 lock 的那一层
        while (proto && !Object.prototype.hasOwnProperty.call(proto, 'lock')) proto = Object.getPrototypeOf(proto);
        if (!proto) return { ok: false, why: 'lock not found on prototype chain' };
        window.__SR_LOCK__ = [];
        const orig = proto.lock;
        proto.lock = function (...a) {
            const rec = { name: this && this.name, t0: Date.now(), returned: false };
            window.__SR_LOCK__.push(rec);
            try {
                const r = orig.apply(this, a);
                rec.returned = true;
                rec.ms = Date.now() - rec.t0;
                rec.len = r && r.length;
                return r;
            } catch (e) {
                rec.threw = String(e).slice(0, 200);
                throw e;
            }
        };
        return { ok: true, proto: proto.constructor ? proto.constructor.name : '?' };
    });

    await page.evaluate((m) => {
        window.__SR_IMPORT_STATE__ = 'started';
        (async () => {
            try {
                const head = await fetch('./' + m, { headers: { Range: 'bytes=0-0' } });
                const total = parseInt(head.headers.get('content-range').split('/')[1], 10);
                const CHUNK = 256 * 1048576;
                const parts = [];
                for (let off = 0; off < total; off += CHUNK) {
                    const end = Math.min(off + CHUNK - 1, total - 1);
                    parts.push(await (await fetch('./' + m, { headers: { Range: `bytes=${off}-${end}` } })).blob());
                }
                window.__SR_IMPORT_STATE__ = 'fetched';
                await window.scene.events.invoke('import', [{ filename: m, contents: new File(parts, m) }]);
                window.__SR_IMPORT_STATE__ = 'done';
            } catch (e) {
                window.__SR_IMPORT_STATE__ = 'threw: ' + String(e).slice(0, 200);
            }
        })();
    }, MODEL);

    await sleep(15000);

    const res = await page.evaluate(() => ({
        importState: window.__SR_IMPORT_STATE__,
        locks: (window.__SR_LOCK__ || []).map(r => ({ name: r.name, returned: r.returned, ms: r.ms ?? null, len: r.len ?? null, threw: r.threw ?? null })),
        gsplatComps: (() => {
            const out = [];
            window.scene.app.root.findComponents('gsplat').forEach((c) => {
                out.push({
                    unified: c.unified ?? null,
                    hasPlacement: !!c._placement,
                    hasResource: !!c.resource,
                    assetLoaded: !!(c.asset && c.asset.loaded)
                });
            });
            return out;
        })()
    }));

    console.log(JSON.stringify({ model: MODEL, unified: UNIFIED, patched, res, errs: errs.slice(0, 3), logs: logs.slice(-12) }, null, 1));
    console.log('\n=== 判定 ===');
    console.log(`  原型补丁：${JSON.stringify(patched)}`);
    console.log(`  导入状态：${res.importState}`);
    console.log(`  lock 调用（${res.locks.length} 次）：`);
    for (const l of res.locks) console.log(`    ${l.name}: returned=${l.returned} ms=${l.ms} len=${l.len}${l.threw ? ' threw=' + l.threw : ''}`);
    console.log(`  gsplat 组件：${JSON.stringify(res.gsplatComps)}`);
    if (errs.length) console.log(`  页面错误：${JSON.stringify(errs.slice(0, 2))}`);

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
