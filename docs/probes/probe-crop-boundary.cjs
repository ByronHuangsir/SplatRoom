// 归档自 _tmp（2026-09-26），REPO 路径已按 docs/probes/ 调整。
// 探针 70：**盒子刚好等于模型包围盒**（`initialize` 的默认状态）时，两条通路的表现。
//
// 为什么单测这个：探针 69 把盒子真正缩小后，两条通路的结果**两位小数都一致**
// （亮点占比都 48.62%、预览都 +3.4~3.7、关掉都精确回到基线）。但"默认的盒子"那一档
// 之前给出过不一致的读数（unified 掉 5%、主线掉 0.06%），要把它钉死：
//   ① 默认盒子 + 开裁剪：两边应当都**几乎不变**（模型本来就在盒子里）；
//   ② 预览模式：如果真有"掉 5%"，那么预览（不丢弃、只变淡）应当把像素找回来；
//   ③ 关掉：回到基线。
//
// usage: node _tmp/probe-crop-boundary.cjs [main|unified]
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..', '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const { launchPatched: _launchPatched } = require('../verify/lib/browser.cjs');
const { decodePng } = require(path.join(REPO, 'docs', 'verify', 'lib', 'png.cjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODE = process.argv[2] === 'main' ? 'main' : 'unified';

const analyze = (file) => {
    const P = decodePng(fs.readFileSync(file));
    let r = 0, g = 0, b = 0, lit = 0;
    const n = P.width * P.height;
    for (let i = 0; i < P.data.length; i += P.channels) {
        const R = P.data[i], G = P.data[i + 1], B = P.data[i + 2];
        r += R; g += G; b += B;
        if (R + G + B > 60) lit++;
    }
    return { mean: [+(r / n).toFixed(2), +(g / n).toFixed(2), +(b / n).toFixed(2)], litPct: +((lit / n) * 100).toFixed(2) };
};

(async () => {
    cleanupOrphanBrowsers();
    const browser = await _launchPatched(puppeteer, {
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 900000
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 620 });
    page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)));
    await page.goto(MODE === 'main' ? 'http://localhost:3100/?gpu=webgpu' : 'http://localhost:3100/?gpu=webgpu&unified=1', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1200);
    await page.evaluate(async () => {
        const res = await fetch('./test-model.ply');
        const blob = await res.blob();
        await window.scene.events.invoke('import', [{ filename: 'test-model.ply', contents: new File([blob], 'test-model.ply') }]);
    });
    for (let i = 0; i < 80; i++) {
        await sleep(500);
        if (await page.evaluate(() => (window.scene.elements || []).some((e) => e.entity && e.entity.gsplat))) break;
    }
    await page.evaluate(() => {
        const scene = window.scene;
        const el = (scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        scene.events.fire('selection', el);
        scene.events.fire('camera.focus');
        window.__frames = async (k) => {
            for (let i = 0; i < k; i++) { scene.app.renderNextFrame = true; await new Promise((r) => requestAnimationFrame(r)); }
        };
    });
    await sleep(2500);

    const shoot = async (name) => {
        await page.evaluate(() => window.__frames(4));
        await sleep(250);
        const f = path.join(REPO, '_tmp', `cbb-${MODE}-${name}.png`);
        fs.writeFileSync(f, Buffer.from(await page.screenshot({ encoding: 'base64' }), 'base64'));
        return analyze(f);
    };

    const out = {};
    out.base = await shoot('0-base');
    // 默认盒子（不改任何尺寸）+ 开裁剪
    await page.evaluate(async () => {
        const scene = window.scene;
        scene.events.fire('cropBox.initialize');
        await window.__frames(2);
        scene.events.fire('cropBox.setClipping', true);
        await window.__frames(4);
    });
    out.clipped = await shoot('1-clipped-default-box');
    await page.evaluate(async () => { window.scene.events.fire('cropBox.setPreview', true); await window.__frames(4); });
    out.preview = await shoot('2-preview');
    await page.evaluate(async () => {
        window.scene.events.fire('cropBox.setPreview', false);
        window.scene.events.fire('cropBox.setClipping', false);
        await window.__frames(4);
    });
    out.off = await shoot('3-off');

    const cb = await page.evaluate(() => {
        const c = window.scene.events.invoke('cropBox');
        const p = c.pivot;
        return { enabled: c.enabled, scale: p.getLocalScale().toArray().map(v => +v.toFixed(3)), pos: p.getLocalPosition().toArray().map(v => +v.toFixed(3)) };
    });

    console.log(`\n=== 默认盒子（box = 模型包围盒）· ${MODE} ===`);
    console.log(`  cropBox: ${JSON.stringify(cb)}`);
    for (const k of ['base', 'clipped', 'preview', 'off']) console.log(`  ${k.padEnd(8)} ${JSON.stringify(out[k])}`);
    console.log('\n=== 判定 ===');
    const d = +(out.base.litPct - out.clipped.litPct).toFixed(2);
    const back = +(out.preview.litPct - out.clipped.litPct).toFixed(2);
    console.log(`  开裁剪后亮点占比变化：${d >= 0 ? '-' : '+'}${Math.abs(d)} ⇒ ${Math.abs(d) < 1 ? 'PASS（默认盒子不该切）' : 'FAIL（切掉了：模型本来就在盒子里）'}`);
    console.log(`  预览比裁剪态 +${back} ⇒ ${Math.abs(d) > 1 ? (back > 1 ? 'PASS（丢掉的像素淡着回来了）' : 'FAIL（没回来 ⇒ 不是"外侧被丢弃"而是别的丢法）') : '（无需判定）'}`);
    console.log(`  关掉后与基线差 ${Math.abs(out.off.litPct - out.base.litPct).toFixed(2)} ⇒ ${Math.abs(out.off.litPct - out.base.litPct) < 0.5 ? 'PASS' : 'FAIL'}`);

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
