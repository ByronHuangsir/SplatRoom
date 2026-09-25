// 归档自 _tmp（2026-09-26 凌晨：?unified=1 导入卡死修复 + 打包验收），REPO 路径已按 docs/probes/ 调整。
// 探针 36：`?unified=1` 从启动就打开时，导入到底卡在哪一步。
//
// 已知（探针 35）：那条路上 `scene.events.invoke('import', ...)` 的 promise **永不 settle**
// （600 秒协议超时），而且没有 splat 元素、页面无报错。
// 这一版**不 await 导入**（fire-and-forget），15 秒后把现场全打出来：
//   · 所有 console 输出（含引擎/我们的 warn）；
//   · elements 列表与 `findComponents('gsplat')` 计数；
//   · splat 元素上组件的 `instance` / `_placement` / `resource` 状态；
//   · 引擎 manager 侧（world / renderer / renderCounter）。
//
// usage: node _tmp/probe-unified-import-hang.cjs [model]
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..', '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL = process.argv[2] || 'test-model.ply';
const UNIFIED = process.argv[3] !== '0';

(async () => {
    cleanupOrphanBrowsers();
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 300000
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 640, height: 440 });
    const logs = [];
    page.on('console', (m) => logs.push(`${m.type()}: ${m.text().slice(0, 240)}`));
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 400)));

    const url = UNIFIED ? 'http://localhost:3100/?gpu=webgpu&unified=1' : 'http://localhost:3100/?gpu=webgpu';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1500);

    // fire-and-forget：不 await，让它在后台跑；卡住也能继续观察
    // 抓住被弹出来的错误框内容（导入链会把异常转成 popup 等用户点确定 ⇒ 无人操作时就是"卡死"）
    await page.evaluate(() => {
        const ev = window.scene.events;
        window.__SR_POPUPS__ = [];
        const orig = ev.invoke.bind(ev);
        ev.invoke = function (name, ...rest) {
            if (name === 'showPopup') {
                try {
                    const arg = rest[0] || {};
                    window.__SR_POPUPS__.push({
                        title: arg.header ?? arg.title ?? null,
                        text: typeof (arg.text ?? arg.message) === 'string'
                            ? String(arg.text ?? arg.message).slice(0, 600)
                            : JSON.stringify(arg.text ?? arg.message ?? arg).slice(0, 600)
                    });
                } catch (e) { window.__SR_POPUPS__.push({ err: String(e) }); }
            }
            return orig(name, ...rest);
        };
        // 同时抓 window.onerror / unhandledrejection（有些异常不走 popup）
        window.__SR_UNCAUGHT__ = [];
        window.addEventListener('error', (e) => {
            window.__SR_UNCAUGHT__.push(`error: ${e.message} @ ${String(e.filename).slice(-60)}:${e.lineno}`);
        });
        window.addEventListener('unhandledrejection', (e) => {
            window.__SR_UNCAUGHT__.push(`rejection: ${String(e.reason && e.reason.stack ? e.reason.stack : e.reason).slice(0, 400)}`);
        });
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
                window.__SR_IMPORT_STATE__ = 'threw: ' + String(e).slice(0, 300);
            }
        })();
    }, MODEL);

    for (const wait of [3000, 5000, 7000]) {
        await sleep(wait);
        const st = await page.evaluate(() => window.__SR_IMPORT_STATE__);
        if (st === 'done' || String(st).startsWith('threw')) break;
    }
    await sleep(2000);

    const res = await page.evaluate(() => ({
        importState: window.__SR_IMPORT_STATE__,
        popups: window.__SR_POPUPS__ ?? [],
        uncaught: window.__SR_UNCAUGHT__ ?? [],
        elements: (window.scene.elements || []).map(e => ({ type: e.type ?? null, hasGsplat: !!(e.entity && e.entity.gsplat) })),
        gsplatComponents: (() => {
            const out = [];
            window.scene.app.root.findComponents('gsplat').forEach((c) => {
                out.push({
                    unified: c.unified ?? null,
                    hasInstance: !!c.instance,
                    hasPlacement: !!c._placement,
                    placementResource: !!c._placement?.resource,
                    hasResource: !!c.resource,
                    assetLoaded: !!(c.asset && c.asset.loaded),
                    numSplats: c._placement?.resource?.gsplatData?.numSplats ?? c.instance?.resource?.gsplatData?.numSplats ?? null
                });
            });
            return out;
        })()
    }));
    console.log(JSON.stringify({ model: MODEL, unified: UNIFIED, res, errs: errs.slice(0, 5), logs: logs.slice(-16) }, null, 1));
    console.log('\n=== 现场 ===');
    console.log(`  导入状态：${res.importState}`);
    console.log(`  弹窗（${res.popups.length}）：`);
    for (const p of res.popups) console.log(`    [${p.title}] ${p.text}`);
    console.log(`  未捕获（${res.uncaught.length}）：`);
    for (const u of res.uncaught) console.log(`    ${u}`);
    console.log(`  elements：${JSON.stringify(res.elements)}`);
    console.log(`  gsplat 组件：${JSON.stringify(res.gsplatComponents)}`);
    console.log(`  console 尾部：`);
    for (const l of logs.slice(-10)) console.log(`    ${l}`);
    if (errs.length) console.log(`  页面错误：${JSON.stringify(errs.slice(0, 3))}`);

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
