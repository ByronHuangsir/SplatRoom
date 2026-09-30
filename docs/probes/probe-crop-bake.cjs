// 探针 72：**直接在 GPU 上看**片元拿到的盒局部坐标（不在 CPU 侧推）。
//
// 上一轮（探针 66~71）把"默认盒子多啃一层壳"的四个嫌疑都量掉了（矩阵链、相机矩阵、mul2 顺序、
// 软边淡出），角点张开只解释了 0.6 个百分点。这一轮改用仓库里现成的烘焙机制直接把坐标画出来：
//   cropBoxProbe = 1 ⇒ 白 = 该像素被判到盒外（max|local| > 0.5）
//   cropBoxProbe = 2 ⇒ 灰度 = max|local|（0.5 对应中灰；亮于中灰即盒外）
//   cropBoxProbe = 3 ⇒ 同 2，但用 flat 的中心坐标
// 判据：**白色占比**应当与"开启裁剪时掉的亮点占比"（约 4.4%）一致；如果它远大于 4.4%，
// 说明糖在别处；如果中心坐标（3）也是 4.4%，说明着色器拿到的矩阵与 CPU 侧算的不一致。
//
// usage: node _tmp/probe-crop-bake.cjs
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const { launchPatched: _launchPatched } = require('../verify/lib/browser.cjs');
const { decodePng } = require(path.join(REPO, 'docs', 'verify', 'lib', 'png.cjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const analyze = (file) => {
    const P = decodePng(fs.readFileSync(file));
    let white = 0, lit = 0, sum = 0;
    const n = P.width * P.height;
    for (let i = 0; i < P.data.length; i += P.channels) {
        const R = P.data[i], G = P.data[i + 1], B = P.data[i + 2];
        if (R > 200 && G > 200 && B > 200) white++;
        if (R + G + B > 60) lit++;
        sum += R;
    }
    return { whitePct: +((white / n) * 100).toFixed(2), litPct: +((lit / n) * 100).toFixed(2), meanR: +(sum / n).toFixed(2) };
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

    // 烘焙必须在**场景构造前**设好（材质名/着色器按它生成）—— 用 evaluateOnNewDocument。
    for (const probe of [0, 1, 2, 3]) {
        const p = await browser.newPage();
        await p.setViewport({ width: 900, height: 620 });
        await p.evaluateOnNewDocument((v) => {
            globalThis.__SPLATROOM_UNIFIED_BAKE__ = { cropBoxProbe: v };
        }, probe);
        await p.goto('http://localhost:3100/?gpu=webgpu&unified=1', { waitUntil: 'domcontentloaded', timeout: 120000 });
        await p.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
        await sleep(1200);
        await p.evaluate(async () => {
            const res = await fetch('./test-model.ply');
            const blob = await res.blob();
            await window.scene.events.invoke('import', [{ filename: 'test-model.ply', contents: new File([blob], 'test-model.ply') }]);
        });
        for (let i = 0; i < 80; i++) {
            await sleep(500);
            if (await p.evaluate(() => (window.scene.elements || []).some((e) => e.entity && e.entity.gsplat))) break;
        }
        await p.evaluate(() => {
            const scene = window.scene;
            const el = (scene.elements || []).find((e) => e.entity && e.entity.gsplat);
            scene.events.fire('selection', el);
            scene.events.fire('camera.focus');
            scene.events.fire('cropBox.initialize');
            window.__frames = async (k) => {
                for (let i = 0; i < k; i++) { scene.app.renderNextFrame = true; await new Promise((r) => requestAnimationFrame(r)); }
            };
        });
        await sleep(2500);

        // ① 不开裁剪，先看仪器本身（此时盒坐标仍然算好了，只是不参与判定）
        await p.evaluate(() => window.__frames(4));
        await sleep(250);
        const f0 = path.join(REPO, '_tmp', `bake-${probe}-raw.png`);
        fs.writeFileSync(f0, Buffer.from(await p.screenshot({ encoding: 'base64' }), 'base64'));
        const raw = analyze(f0);

        // ② 开裁剪，量实际掉多少像素
        await p.evaluate(async () => {
            window.scene.events.fire('cropBox.setClipping', true);
            await window.__frames(4);
        });
        await sleep(250);
        const f1 = path.join(REPO, '_tmp', `bake-${probe}-clipped.png`);
        fs.writeFileSync(f1, Buffer.from(await p.screenshot({ encoding: 'base64' }), 'base64'));
        const clipped = analyze(f1);

        console.log(`probe=${probe}: 原始 ${JSON.stringify(raw)} / 开裁剪 ${JSON.stringify(clipped)}`);
        await p.close();
    }

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
