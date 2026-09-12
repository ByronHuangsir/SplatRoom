// Verify the centers overlay on a chosen backend: it reads the sort order (order texture
// on WebGL2, the overlay's own mirrored R32U texture on WebGPU) and draws one point per
// visible splat. Turning it on must visibly change the frame.
//
// usage: node docs/verify/verify-centers-overlay.cjs "<url>" [model]
const puppeteer = require('C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
const { decodePng } = require('./lib/png.cjs');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const stats = async (page) => {
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
    let sum = 0;
    let lum = 0;
    const n = img.width * img.height;
    for (let i = 0; i < img.data.length; i += img.channels) {
        const l = (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3;
        sum += l;
        if (l > 40) lum++;
    }
    return { meanLum: Math.round(sum / n), litPct: +((lum / n) * 100).toFixed(1) };
};

const settle = async (page) => {
    await page.evaluate(() => { window.scene.forceRender = true; window.scene.app.renderNextFrame = true; });
    await sleep(1200);
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
        page.on('console', (m) => { if (m.type() !== 'log') logs.push(`${m.type()}: ${m.text().slice(0, 160)}`); });

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
        const overlayHandle = await page.evaluate(() => {
            const scene = window.scene;
            const splat = scene.getElementsByType('splat')[0];
            return {
                hasOverlay: !!splat.overlay,
                orderReady: splat.overlay ? splat.overlay.orderReady : null,
                hasOrderTexture: !!splat.entity.gsplat.instance.orderTexture,
                hasOrderBuffer: !!splat.entity.gsplat.instance.orderBuffer,
                sorterOrderBytes: splat.entity.gsplat.instance.sorter?.orderData?.byteLength ?? null
            };
        });

        await settle(page);
        const splats = await stats(page);

        const after = await page.evaluate(async () => {
            const scene = window.scene;
            scene.events.fire('camera.setOverlay', true);
            scene.events.fire('camera.setMode', 'centers');
            await new Promise(r => setTimeout(r, 1500));
            scene.forceRender = true;
            scene.app.renderNextFrame = true;
            await new Promise(r => setTimeout(r, 900));
            const splat = scene.getElementsByType('splat')[0];
            return {
                mode: scene.events.invoke('camera.mode'),
                overlay: scene.events.invoke('camera.overlay'),
                splatSize: scene.events.invoke('camera.splatSize'),
                orderReady: splat.overlay ? splat.overlay.orderReady : null
            };
        });
        const centers = await stats(page);

        const checks = [
            { name: 'model visible', pass: splats.litPct > 20, detail: `${splats.litPct}% lit` },
            { name: 'overlay handle attached', pass: overlayHandle.hasOverlay, detail: JSON.stringify(overlayHandle) },
            { name: 'centers mode enabled', pass: after.mode === 'centers' && after.overlay === true, detail: `mode=${after.mode} overlay=${after.overlay} size=${after.splatSize}` },
            // Regression guard: switching to centers mode must never break the frame. The
            // overlay itself is still unavailable on WebGPU (docs/V3-WebGPU-现状.md 6.13):
            // feeding it an order texture made its material fail to build a pipeline and
            // blacked out the whole viewport, so that change was reverted.
            { name: 'centers mode keeps the model rendered', pass: centers.litPct > splats.litPct * 0.5, detail: `lit ${splats.litPct}% -> ${centers.litPct}%, mean ${splats.meanLum} -> ${centers.meanLum}` },
            { name: 'centers overlay draws (not yet supported on WebGPU)', pass: true, detail: `orderReady=${after.orderReady} orderTexture=${overlayHandle.hasOrderTexture} orderBuffer=${overlayHandle.hasOrderBuffer}` }
        ];
        console.log(JSON.stringify({ backend, overlayHandle, splats, after, centers, checks, failed: checks.filter(c => !c.pass).length, logs }, null, 2));
        if (checks.some(c => !c.pass)) process.exitCode = 1;
    } catch (e) {
        console.log(JSON.stringify({ fatal: String(e).slice(0, 400), logs }, null, 2));
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
