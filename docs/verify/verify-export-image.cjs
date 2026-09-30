// Verify the image export ("snapshot") path on a chosen backend.
//
// render.image renders into the camera's offscreen targets and reads them back with
// colorBuffer.read(..., { immediate: true }) — the same readback the pick/bound paths use,
// and the one that needed `immediate` on WebGPU. The harness passes a fake file stream so
// the encoded bytes can be inspected instead of triggering a download.
//
// usage: node docs/verify/verify-export-image.cjs "<url>" [model]
const puppeteer = require('puppeteer-core');

const { BROWSER_PATH: EDGE , launchPatched: _launchPatched } = require('./lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const logs = [];
    const browser = await _launchPatched(puppeteer, {
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
    });
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

        const runExport = (settings) => page.evaluate(async (s) => {
            const scene = window.scene;
            window.__exported = null;
            const stream = {
                write: async (bytes) => { window.__exported = { len: bytes.length, head: Array.from(bytes.slice(0, 4)), tail: Array.from(bytes.slice(-2)) }; },
                close: async () => { }
            };
            const started = performance.now();
            let result = null;
            let error = null;
            try {
                result = await scene.events.invoke('render.image', s, stream);
            } catch (e) {
                error = String(e).slice(0, 300);
            }
            return { result, error, ms: Math.round(performance.now() - started), exported: window.__exported };
        }, settings);

        const jpeg = await runExport({
            width: 320, height: 200, transparentBg: false, showDebug: false,
            format: 'jpeg', quality: 0.92, projection: 'perspective', levelHorizon: true
        });

        // a control export at a different resolution: the settings must actually reach the
        // render, so the encoded frame cannot be byte-identical to the first one
        const control = await runExport({
            width: 160, height: 120, transparentBg: false, showDebug: false,
            format: 'jpeg', quality: 0.92, projection: 'perspective', levelHorizon: true
        });

        const isJpeg = (e) => !!e && e.head[0] === 255 && e.head[1] === 216 && e.tail[0] === 255 && e.tail[1] === 217;

        const checks = [
            {
                name: 'export renders and encodes',
                pass: jpeg.result === true && !!jpeg.exported && jpeg.exported.len > 0,
                detail: `result=${jpeg.result} len=${jpeg.exported ? jpeg.exported.len : null} in ${jpeg.ms}ms ${jpeg.error ?? ''}`
            },
            {
                name: 'exported bytes are a JPEG',
                pass: isJpeg(jpeg.exported),
                detail: `head=${JSON.stringify(jpeg.exported?.head)} tail=${JSON.stringify(jpeg.exported?.tail)}`
            },
            {
                name: 'exported image contains the model (not an empty frame)',
                pass: !!jpeg.exported && jpeg.exported.len > 4000,
                detail: `${jpeg.exported?.len} bytes for a 320x200 frame (an all-background frame stays far smaller)`
            },
            {
                name: 'export follows the requested settings (smaller frame differs)',
                pass: !!jpeg.exported && !!control.exported && control.exported.len !== jpeg.exported.len && control.exported.len > 0,
                detail: `320x200 -> ${jpeg.exported?.len} bytes, 160x120 -> ${control.exported?.len} bytes`
            }
        ];

        console.log(JSON.stringify({ backend, jpeg, control, checks, failed: checks.filter(c => !c.pass).length, logs }, null, 2));
        if (checks.some(c => !c.pass) || logs.length) process.exitCode = 1;
    } catch (e) {
        console.log(JSON.stringify({ fatal: String(e).slice(0, 400), logs }, null, 2));
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
