// 归档自 _tmp（2026-09-26 凌晨：?unified=1 导入卡死修复 + 打包验收），REPO 路径已按 docs/probes/ 调整。
// 探针 38：验证 `writeCurveTable` 的直传结果**内容正确**（这是我今天改过的地方）。
//
// 背景：曲线 LUT 的直传（`queue.writeTexture`）以前是**坏的** ——
// `const height = CURVE_CHANNELS`（那是通道名数组）⇒ `Number(array)` = NaN ⇒ 抛错 ⇒ 每次都退回
// `lock()` 兜底；而 `lock()` 在 unified 导入路径上会永久挂住（就是 §4d 的"导入卡死"）。
// 现在直传改成了两处修复（`CURVE_CHANNELS.length` + 把单行扩成 4 行），必须验证**内容**：
//   · 纹理是 33×4 的 R32F；
//   · 四行都等于恒等表 `i/32`（直传把同一行复制进 4 个通道）。
// 读法：CPU 通路下 `Texture.lock()` 可用（不会挂），拿它把 GPU 内容读回来核对。
//
// usage: node _tmp/probe-curve-table.cjs [model]
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..', '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const { launchPatched: _launchPatched } = require('../verify/lib/browser.cjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL = process.argv[2] || 'test-model.ply';

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
    page.on('console', (m) => logs.push(m.text().slice(0, 200)));

    await page.goto('http://localhost:3100/?gpu=webgpu', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1200);
    await page.evaluate(async (m) => {
        const head = await fetch('./' + m, { headers: { Range: 'bytes=0-0' } });
        const total = parseInt(head.headers.get('content-range').split('/')[1], 10);
        const CHUNK = 256 * 1048576;
        const parts = [];
        for (let off = 0; off < total; off += CHUNK) {
            const end = Math.min(off + CHUNK - 1, total - 1);
            parts.push(await (await fetch('./' + m, { headers: { Range: `bytes=${off}-${end}` } })).blob());
        }
        await window.scene.events.invoke('import', [{ filename: m, contents: new File(parts, m) }]);
    }, MODEL);
    for (let i = 0; i < 40; i++) {
        await sleep(1000);
        if (await page.evaluate(() => (window.scene.elements || []).some((e) => e.entity && e.entity.gsplat))) break;
    }
    await sleep(1500);

    const res = await page.evaluate(() => {
        const scene = window.scene;
        const splat = (scene.elements || []).find(e => e.entity && e.entity.gsplat);
        if (!splat) return { error: 'no splat element' };
        const tex = splat.curveTexture;
        if (!tex) return { error: 'no curveTexture' };
        const out = { width: tex.width, height: tex.height, format: tex.format };
        let data;
        try {
            data = tex.lock();
        } catch (e) {
            return { ...out, error: 'lock threw: ' + String(e).slice(0, 200) };
        }
        try {
            const samples = 33;
            const rows = [];
            for (let ch = 0; ch < 4; ch++) {
                const row = [];
                for (let i = 0; i < samples; i++) row.push(+data[ch * samples + i].toFixed(5));
                rows.push(row);
            }
            out.rows = rows.map(r => ({ first3: r.slice(0, 3), mid: r[16], last2: r.slice(-2) }));
            // 期望：本行 = i/32
            const expected = (i) => +( i / (samples - 1)).toFixed(5);
            out.matchesIdentity = rows.every(r => r.every((v, i) => Math.abs(v - expected(i)) < 1e-5));
            out.length = data.length;
        } finally {
            tex.unlock();
        }
        return out;
    });

    console.log(JSON.stringify({ model: MODEL, res, curveWarn: logs.filter(l => /uCurve|curve/i.test(l)).slice(0, 4) }, null, 1));
    console.log('\n=== 判定（曲线 LUT 直传的内容）===');
    if (res.error) console.log('  ⚠️ ' + res.error);
    else {
        console.log(`  纹理：${res.width}×${res.height}，float 长度 ${res.length}`);
        console.log(`  四行样本（首 3 / 中 / 末 2）：${JSON.stringify(res.rows)}`);
        console.log(`  ⇒ ${res.matchesIdentity ? '**内容正确**：四行都等于恒等表 i/32（直传把单行扩成了 4 行）' : '**内容不对**，需要看上面的实际值'}`);
    }
    if (logs.some(l => /uCurve direct upload failed/.test(l))) console.log('  ⚠️ 仍有 "uCurve direct upload failed" 警告');

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
