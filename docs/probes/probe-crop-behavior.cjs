// 归档自 _tmp（2026-09-26），REPO 路径已按 docs/probes/ 调整。
// 探针 69：unified 裁剪盒的**行为**验收（缩小盒子 → 必须切；预览 → 必须变淡而不是消失）。
//
// 探针 66/67/68 已经把"多切"的两种嫌疑排除掉了（矩阵链正确、相机矩阵一致、模型局部坐标在 ±0.418
// 落在 ±0.5 的盒子里），所以这一轮只做行为层面的逐步测量，缩小盒子用 **pivot 的 scale**
// （box 的判定是 `0.5 - max|local|`，radius* 只管圆柱/椭球）。
//
// usage: node _tmp/probe-crop-behavior.cjs [unified|main]
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..', '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
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
    return { mean: [+(r / n).toFixed(1), +(g / n).toFixed(1), +(b / n).toFixed(1)], litPct: +((lit / n) * 100).toFixed(2) };
};

(async () => {
    cleanupOrphanBrowsers();
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 900000
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 620 });
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 180)); });
    page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 220)));
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
        const f = path.join(REPO, '_tmp', `cb-${MODE}-${name}.png`);
        fs.writeFileSync(f, Buffer.from(await page.screenshot({ encoding: 'base64' }), 'base64'));
        return analyze(f);
    };

    const out = {};
    out.base = await shoot('0-base');

    // 初始化 + 用 cropBox.setState 缩小到 55%，开裁剪
    // （不能用 pivot.setLocalScale：`cropBox.changed` 会把 pivot 按内部 config 重新同步回去，
    //   实测 before/after 一模一样 —— 那次"缩小"根本没发生，判定因此全成了误报。）
    out.setup = await page.evaluate(async () => {
        const scene = window.scene;
        scene.events.fire('cropBox.initialize');
        await window.__frames(2);
        const cb = scene.events.invoke('cropBox');
        const pivot = cb.pivot;
        const pos = pivot.getLocalPosition().clone();
        const scale = pivot.getLocalScale().clone();
        const rot = pivot.getLocalRotation().clone();
        const before = { pos: pos.toArray(), scale: scale.toArray() };
        // ⚠️ `setState(pos, extentScale, rot)` 里那个 scale 是**半尺寸**：实测传 [1.31,0.66,0.396]
        // 之后 pivot 变成 [2.62,1.32,0.79]（正好 2 倍）。所以要缩到原来的 1/4，要传 original × 0.125。
        const shrunk = scale.clone().mulScalar(0.125);
        cb.setState(pos, shrunk, rot);
        scene.events.fire('cropBox.changed');
        scene.events.fire('cropBox.setClipping', true);
        await window.__frames(4);
        return { before, after: { scale: pivot.getLocalScale().toArray() }, requested: shrunk.toArray(), enabled: cb.enabled, preview: cb.preview };
    });
    out.shrunk = await shoot('1-shrunk');

    out.preview = await page.evaluate(() => window.scene.events.fire('cropBox.setPreview', true)).then(() => shoot('2-preview'));

    out.off = await page.evaluate(async () => {
        window.scene.events.fire('cropBox.setPreview', false);
        window.scene.events.fire('cropBox.setClipping', false);
        await window.__frames(4);
    }).then(() => shoot('3-off'));

    console.log(`\n=== 裁剪盒行为（${MODE}）===`);
    console.log(`  setup=${JSON.stringify(out.setup)}`);
    for (const k of ['base', 'shrunk', 'preview', 'off']) {
        console.log(`  ${k.padEnd(8)} ${JSON.stringify(out[k])}`);
    }
    console.log('\n=== 判定 ===');
    const drop = +(out.base.litPct - out.shrunk.litPct).toFixed(2);
    console.log(`  缩小盒子后亮点占比 ${out.base.litPct}% → ${out.shrunk.litPct}%（下降 ${drop}）⇒ ${drop > 3 ? 'PASS（切掉了）' : 'FAIL（没切）'}`);
    const previewGain = +(out.preview.litPct - out.shrunk.litPct).toFixed(2);
    console.log(`  预览模式 ${out.preview.litPct}%（比裁剪态 +${previewGain}）⇒ ${previewGain > 1 ? 'PASS（外面回来了但更淡）' : 'FAIL（预览没生效）'}`);
    console.log(`  关掉后 ${out.off.litPct}%（与基线差 ${Math.abs(out.off.litPct - out.base.litPct).toFixed(2)}）⇒ ${Math.abs(out.off.litPct - out.base.litPct) < 2 ? 'PASS' : 'FAIL'}`);
    if (errs.length) console.log(`  错误：${JSON.stringify(errs.slice(0, 3))}`);

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
