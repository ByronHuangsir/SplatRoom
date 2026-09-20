// Verify that the box/sphere selection tools fade the model while they are active.
//
// The volume is much easier to place when the model behind it is faded out; the tools set the
// same transparency the camera-path control uses (exp(-2), i.e. -2 on the colour panel's
// transparency slider) for every splat, and put each splat's own value back when the tool is
// deactivated - unless the user changed it in the meantime.
//
// usage: node docs/verify/verify-volume-dim.cjs "<url>" [model]
const puppeteer = require('puppeteer-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const DIM = Math.exp(-2);

(async () => {
    const logs = [];
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
    });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });
        page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text().slice(0, 200)); });
        page.on('pageerror', e => logs.push('pageerror: ' + String(e).slice(0, 200)));
        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForFunction('!!window.scene', { timeout: 90000 });
        await sleep(1500);
        await page.evaluate(async (model) => {
            const buf = await (await fetch('./' + model)).arrayBuffer();
            await window.scene.events.invoke('import', [{ filename: model, contents: new File([buf], model) }]);
        }, MODEL);
        await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 120000 });
        await sleep(3000);

        const backend = await page.evaluate(() => (window.scene.graphicsDevice.isWebGPU ? 'webgpu' : 'webgl2'));

        // brightness of the viewport, so the fade is verified on screen and not just in state
        const meanLum = async () => {
            const png = Buffer.from(await page.screenshot({ type: 'png', clip: { x: 320, y: 120, width: 640, height: 400 } }));
            const { decodePng } = require('./lib/png.cjs');
            const img = decodePng(png);
            let sum = 0;
            for (let i = 0; i < img.data.length; i += img.channels) {
                sum += (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3;
            }
            return +(sum / (img.width * img.height)).toFixed(2);
        };

        const readTransparency = () => page.evaluate(() =>
            window.scene.getElementsByType('splat').map(s => +s.transparency.toFixed(6)));

        const fire = async (event, arg) => {
            await page.evaluate((e, a) => window.scene.events.fire(e, a), event, arg);
            await sleep(700);
        };

        const before = await readTransparency();
        const lumBefore = await meanLum();

        // activate the box tool
        await fire('tool.boxSelection');
        const boxActive = await readTransparency();
        const lumBox = await meanLum();

        // switching to the sphere tool must not undo the fade (the tools overlap for a moment)
        await fire('tool.sphereSelection');
        const sphereActive = await readTransparency();

        // leave the tools: the model comes back
        await fire('tool.deactivate');
        const afterDeactivate = await readTransparency();
        const lumAfter = await meanLum();

        // a transparency the user changes while the tool is active is left alone
        await fire('tool.boxSelection');
        await page.evaluate(() => {
            window.scene.getElementsByType('splat').forEach((s) => {
                s.transparency = 0.5;
            });
        });
        await sleep(500);
        await fire('tool.deactivate');
        const afterUserEdit = await readTransparency();

        const close = (a, b, tol = 1e-4) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
        const allDim = (list) => list.every(v => Math.abs(v - DIM) < 1e-4);

        const checks = [
            {
                name: 'activating the box tool fades the model to exp(-2)',
                pass: allDim(boxActive),
                detail: `transparency ${JSON.stringify(boxActive)} (expected ${DIM.toFixed(6)})`
            },
            {
                name: 'the fade is visible on screen',
                pass: lumBox < lumBefore * 0.8,
                detail: `viewport mean luminance ${lumBefore} -> ${lumBox} with the tool active`
            },
            {
                name: 'switching to the sphere tool keeps the model faded',
                pass: allDim(sphereActive),
                detail: `transparency ${JSON.stringify(sphereActive)}`
            },
            {
                name: 'leaving the tools restores the previous transparency',
                pass: close(afterDeactivate, before),
                detail: `${JSON.stringify(before)} -> ${JSON.stringify(afterDeactivate)}`
            },
            {
                name: 'the fade is visible and reversible on screen',
                pass: Math.abs(lumAfter - lumBefore) < Math.max(1.5, lumBefore * 0.02),
                detail: `viewport mean luminance ${lumAfter} after deactivating (was ${lumBefore} before)`
            },
            {
                name: 'a transparency the user set while the tool was active is kept',
                pass: close(afterUserEdit, [0.5, 0.5, 0.5].slice(0, afterUserEdit.length), 1e-4) ||
                    afterUserEdit.every(v => Math.abs(v - 0.5) < 1e-4),
                detail: `transparency after leaving the tool ${JSON.stringify(afterUserEdit)} (user set 0.5)`
            },
            {
                name: 'no console errors',
                pass: logs.length === 0,
                detail: logs.length ? JSON.stringify(logs.slice(0, 3)) : 'clean'
            }
        ];

        console.log(JSON.stringify({
            backend,
            url: URL,
            transparency: { before, boxActive, sphereActive, afterDeactivate, afterUserEdit },
            luminance: { before: lumBefore, boxActive: lumBox, afterDeactivate: lumAfter },
            checks,
            failed: checks.filter(c => !c.pass).length,
            logs
        }, null, 2));
        if (checks.some(c => !c.pass)) process.exitCode = 1;
    } catch (e) {
        console.log(JSON.stringify({ fatal: String(e).slice(0, 400), logs }, null, 2));
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
