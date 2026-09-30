// Regression for the load-time crash reported as
//   Cannot read properties of undefined (reading 'width')  at SplatOverlay.attach
//
// GSplatInstance.orderTexture only exists on WebGL2 (WebGPU sorts into a storage
// buffer) and the instance's sorter is created lazily, so selecting a splat whose
// instance is not set up yet used to throw inside the selection.changed handler
// and abort the load. This test forces that state and asserts:
//   1. no page error,
//   2. the centers overlay stays disabled while the instance is bare,
//   3. it recovers (entity enabled) once the instance is usable again.
//
// usage: node docs/verify/verify-overlay-missing-order-texture.cjs [url]
const puppeteer = require('puppeteer-core');

const { BROWSER_PATH: EDGE , launchPatched: _launchPatched } = require('./lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3100/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await _launchPatched(puppeteer, {
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
    });

    const errors = [];
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        page.on('pageerror', e => errors.push('pageerror: ' + String(e).slice(0, 400)));
        page.on('console', (m) => {
            if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 400));
        });

        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForFunction('!!window.scene', { timeout: 60000 });
        await sleep(2000);

        await page.evaluate(async () => {
            const buf = await (await fetch('./test-model.ply')).arrayBuffer();
            await window.scene.events.invoke('import', [{ filename: 'test-model.ply', contents: new File([buf], 'test-model.ply') }]);
        });
        await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 60000 });
        await sleep(2500);

        const report = await page.evaluate(async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const scene = window.scene;
            const events = scene.events;
            const splat = scene.getElementsByType('splat')[0];
            events.fire('selection.set', splat);
            await sleep(400);

            // make the centers overlay eligible to render
            events.fire('camera.setMode', 'centers');
            events.fire('camera.setOverlay', true);
            await sleep(400);

            const overlay = scene.splatOverlay ?? null;
            const overlayEntity = overlay?.entity ?? null;
            const instance = splat.entity.gsplat.instance;

            const out = { checks: [] };
            const check = (name, pass, detail) => out.checks.push({ name, pass, detail: detail === undefined ? '' : String(detail) });

            check('overlay found', !!overlay);
            if (!overlay) return out;

            check('overlay renders when the instance is healthy', overlayEntity.enabled === true);

            // --- force the reported race: instance without sorter/order texture ---
            const savedSorter = instance.sorter;
            const savedOrder = instance.orderTexture;

            instance.sorter = null;
            try {
                instance.orderTexture = undefined;
            } catch (e) {
                Object.defineProperty(instance, 'orderTexture', { value: undefined, configurable: true, writable: true });
            }

            events.fire('selection.changed', splat);
            await sleep(600);

            check('attach survives a bare instance', true);
            check('overlay stays disabled while not ready', overlayEntity.enabled === false, `orderReady=${overlay.orderReady}`);

            // --- recovery ---
            instance.sorter = savedSorter;
            instance.orderTexture = savedOrder;
            await sleep(800);

            check('overlay recovers once the instance is usable', overlayEntity.enabled === true, `orderReady=${overlay.orderReady}`);

            return out;
        });

        const failed = report.checks.filter(c => !c.pass);
        console.log(JSON.stringify({ ...report, failed: failed.length, errors }, null, 2));
        if (failed.length || errors.length) process.exitCode = 1;
    } catch (err) {
        console.log(JSON.stringify({ fatal: String(err).slice(0, 700), errors }, null, 2));
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
