// Verify the orthographic camera on a chosen backend. The app drives the camera with
// ASPECT_MANUAL and switches projection at runtime, so the custom WebGPU code paths have to
// build the ortho matrix themselves (see src/splat/gpu-projection.ts) instead of assuming
// perspective. Switching must visibly change the frame, and switching back must restore it.
//
// usage: node docs/verify/verify-ortho-camera.cjs "<url>" [model]
const puppeteer = require('puppeteer-core');
const { decodePng } = require('./lib/png.cjs');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const grab = async (page) => {
    const rect = await page.evaluate(() => {
        const c = document.querySelector('canvas').getBoundingClientRect();
        return { x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.width), h: Math.round(c.height) };
    });
    const png = await page.screenshot({
        type: 'png',
        clip: {
            x: Math.round(rect.x + rect.w * 0.32),
            y: Math.round(rect.y + rect.h * 0.25),
            width: Math.round(rect.w * 0.5),
            height: Math.round(rect.h * 0.5)
        }
    });
    const img = decodePng(Buffer.from(png));
    let lit = 0;
    let sum = 0;
    const n = img.width * img.height;
    for (let i = 0; i < img.data.length; i += img.channels) {
        if (img.data[i] + img.data[i + 1] + img.data[i + 2] > 30) lit++;
        sum += img.data[i] + img.data[i + 1] + img.data[i + 2];
    }
    return { litPct: +((lit / n) * 100).toFixed(1), meanLum: Math.round(sum / (n * 3)), img };
};

const diffPx = (a, b, threshold = 8) => {
    let changed = 0;
    const n = Math.min(a.img.data.length, b.img.data.length);
    const ch = a.img.channels;
    for (let i = 0; i < n; i += ch) {
        if (Math.abs(a.img.data[i] - b.img.data[i]) > threshold ||
            Math.abs(a.img.data[i + 1] - b.img.data[i + 1]) > threshold ||
            Math.abs(a.img.data[i + 2] - b.img.data[i + 2]) > threshold) {
            changed++;
        }
    }
    return changed;
};

const setOrtho = async (page, ortho) => {
    return page.evaluate(async (value) => {
        const scene = window.scene;
        scene.camera.ortho = value;
        scene.forceRender = true;
        scene.app.renderNextFrame = true;
        await new Promise(r => setTimeout(r, 1500));
        scene.forceRender = true;
        scene.app.renderNextFrame = true;
        await new Promise(r => setTimeout(r, 900));
        const cam = scene.camera.mainCamera.camera;
        return { ortho: scene.camera.ortho, projection: cam.projection, orthoHeight: cam.orthoHeight };
    }, ortho);
};

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
    });
    const logs = [];
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        page.on('console', (m) => { if (m.type() === 'error') logs.push(`error: ${m.text().slice(0, 200)}`); });
        page.on('pageerror', e => logs.push('pageerror: ' + String(e).slice(0, 200)));

        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForFunction('!!window.scene', { timeout: 90000 });
        await sleep(1500);
        await page.evaluate(async (model) => {
            const buf = await (await fetch('./' + model)).arrayBuffer();
            await window.scene.events.invoke('import', [{ filename: model, contents: new File([buf], model) }]);
        }, MODEL);
        await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 120000 });
        await sleep(3500);

        const backend = await page.evaluate(() => (window.scene.graphicsDevice.isWebGPU ? 'webgpu' : 'webgl2'));

        await setOrtho(page, false);
        const perspective = await grab(page);

        const orthoState = await setOrtho(page, true);
        const ortho = await grab(page);

        await setOrtho(page, false);
        const restored = await grab(page);

        const orthoPx = diffPx(perspective, ortho);
        const restorePx = diffPx(perspective, restored);

        const checks = [
            { name: 'model visible in perspective', pass: perspective.litPct > 20, detail: `${perspective.litPct}% lit, mean ${perspective.meanLum}` },
            {
                name: 'orthographic projection switches',
                pass: orthoState.ortho === true && orthoState.projection === 1,
                detail: JSON.stringify(orthoState)
            },
            {
                name: 'orthographic view renders the model',
                pass: ortho.litPct > 20 && orthoPx > 10000,
                detail: `${orthoPx} px changed, ${ortho.litPct}% lit (perspective ${perspective.litPct}%), mean ${ortho.meanLum}`
            },
            {
                name: 'switching back restores the perspective frame',
                pass: restorePx < perspective.img.width * perspective.img.height * 0.02,
                detail: `${restorePx} px still differ, ${restored.litPct}% lit, mean ${restored.meanLum}`
            }
        ];

        console.log(JSON.stringify({
            backend,
            perspective: { litPct: perspective.litPct, meanLum: perspective.meanLum },
            ortho: { litPct: ortho.litPct, meanLum: ortho.meanLum },
            restored: { litPct: restored.litPct, meanLum: restored.meanLum },
            px: { ortho: orthoPx, restore: restorePx },
            checks, failed: checks.filter(c => !c.pass).length, logs
        }, null, 2));
        if (checks.some(c => !c.pass) || logs.length) process.exitCode = 1;
    } catch (e) {
        console.log(JSON.stringify({ fatal: String(e).slice(0, 400), logs }, null, 2));
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
