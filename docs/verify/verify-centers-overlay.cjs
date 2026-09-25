// Verify the centers overlay on a chosen backend: it reads the sort order (order texture
// on WebGL2, the overlay's own mirrored R32U texture on WebGPU) and draws one point per
// visible splat. Turning it on must visibly change the frame.
//
// usage: node docs/verify/verify-centers-overlay.cjs "<url>" [model]
const puppeteer = require('puppeteer-core');
const { decodePng } = require('./lib/png.cjs');

const { BROWSER_PATH: EDGE } = require('./lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// grab the same crop of the viewport (away from the UI panels) and report both its
// statistics and the decoded pixels, so two grabs can be compared pixel by pixel
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
    let sum = 0;
    let lum = 0;
    const n = img.width * img.height;
    for (let i = 0; i < img.data.length; i += img.channels) {
        const l = (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3;
        sum += l;
        if (l > 40) lum++;
    }
    return {
        meanLum: Math.round(sum / n),
        litPct: +((lum / n) * 100).toFixed(1),
        px: n,
        img
    };
};

// how many pixels differ between two grabs of the same static camera
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
            const instance = splat.entity.gsplat.instance;
            return {
                hasOverlay: !!scene.splatOverlay,
                orderReady: scene.splatOverlay ? scene.splatOverlay.orderReady : null,
                hasOrderTexture: !!instance.orderTexture,
                hasOrderBuffer: !!instance.orderBuffer,
                hasMirrorTexture: !!(scene.splatOverlay && scene.splatOverlay.gpuOrderTexture),
                sorterOrderBytes: instance.sorter?.orderData?.byteLength ?? null,
                drawCount: scene.splatOverlay ? scene.splatOverlay.mesh.primitive[0].count : null
            };
        });

        await settle(page);
        const splats = await grab(page);

        const after = await page.evaluate(async () => {
            const scene = window.scene;
            scene.events.fire('camera.setOverlay', true);
            scene.events.fire('camera.setMode', 'centers');
            await new Promise(r => setTimeout(r, 1500));
            scene.forceRender = true;
            scene.app.renderNextFrame = true;
            await new Promise(r => setTimeout(r, 900));
            return {
                mode: scene.events.invoke('camera.mode'),
                overlay: scene.events.invoke('camera.overlay'),
                splatSize: scene.events.invoke('camera.splatSize'),
                orderReady: scene.splatOverlay ? scene.splatOverlay.orderReady : null,
                enabled: scene.splatOverlay ? scene.splatOverlay.enabled : null,
                drawCount: scene.splatOverlay ? scene.splatOverlay.mesh.primitive[0].count : null,
                mirrorHead: (() => {
                    const t = scene.splatOverlay && scene.splatOverlay.gpuOrderTexture;
                    if (!t) return null;
                    const d = t.lock();
                    const head = Array.from(d.slice(0, 8));
                    t.unlock();
                    return head;
                })()
            };
        });
        const centers = await grab(page);

        // with the order data in place, the dots must actually land on screen
        const changed = diffPx(splats, centers);
        const changedPct = +((changed / splats.px) * 100).toFixed(2);

        const checks = [
            { name: 'model visible', pass: splats.litPct > 20, detail: `${splats.litPct}% lit` },
            { name: 'overlay handle attached', pass: overlayHandle.hasOverlay, detail: JSON.stringify(overlayHandle) },
            { name: 'centers mode enabled', pass: after.mode === 'centers' && after.overlay === true, detail: `mode=${after.mode} overlay=${after.overlay} size=${after.splatSize}` },
            // Regression guard: switching to centers mode must never break the frame. Feeding
            // the overlay a bad order texture used to fail its pipeline and black out the
            // whole viewport (docs/V3-WebGPU-现状.md 6.13).
            { name: 'centers mode keeps the model rendered', pass: centers.litPct > splats.litPct * 0.5, detail: `lit ${splats.litPct}% -> ${centers.litPct}%, mean ${splats.meanLum} -> ${centers.meanLum}` },
            { name: 'centers overlay draws points', pass: after.orderReady === true && after.enabled === true && changed > 200, detail: `orderReady=${after.orderReady} drawCount=${after.drawCount} changedPx=${changed} (${changedPct}%)` }
        ];
        console.log(JSON.stringify({ backend, overlayHandle, splats: { meanLum: splats.meanLum, litPct: splats.litPct }, after, centers: { meanLum: centers.meanLum, litPct: centers.litPct }, changed, changedPct, checks, failed: checks.filter(c => !c.pass).length, logs }, null, 2));
        if (checks.some(c => !c.pass)) process.exitCode = 1;
    } catch (e) {
        console.log(JSON.stringify({ fatal: String(e).slice(0, 400), logs }, null, 2));
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
