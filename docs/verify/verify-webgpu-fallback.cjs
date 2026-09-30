// Graphics-backend preference check.
//
// Both backends render splats now, so the stored preference must be HONOURED: a stored
// 'webgpu' has to reach the WebGPU device (no silent fallback), the settings panel has to
// persist a change, and `?gpu=…` must still win over the stored value for the harnesses.
//
// usage: node docs/verify/verify-webgpu-fallback.cjs [url] [model]
const puppeteer = require('puppeteer-core');
const { decodePng } = require('./lib/png.cjs');

const { BROWSER_PATH: EDGE , launchPatched: _launchPatched } = require('./lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/';
const MODEL = process.argv[3] || 'test-model.ply';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const launch = () => _launchPatched(puppeteer, {
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
});

const viewportStats = async (page) => {
    const rect = await page.evaluate(() => {
        const c = document.querySelector('canvas').getBoundingClientRect();
        return { x: c.x, y: c.y, w: c.width, h: c.height };
    });
    const png = await page.screenshot({
        type: 'png',
        clip: {
            x: Math.round(rect.x + rect.w * 0.35),
            y: Math.round(rect.y + rect.h * 0.3),
            width: 300,
            height: 220
        }
    });
    const img = decodePng(Buffer.from(png));
    const { width, height, channels, data } = img;
    let colourful = 0;
    for (let i = 0; i < data.length; i += channels) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        if (Math.max(r, g, b) - Math.min(r, g, b) > 20) colourful++;
    }
    return +(colourful / (width * height)).toFixed(4);
};

const loadModel = async (page) => {
    await page.evaluate(async (model) => {
        const buf = await (await fetch('./' + model)).arrayBuffer();
        await window.scene.events.invoke('import', [{ filename: model, contents: new File([buf], model) }]);
    }, MODEL);
    await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 120000 });
    await sleep(4000);
    await page.evaluate(() => { window.scene.forceRender = true; window.scene.app.renderNextFrame = true; });
    await sleep(1000);
};

(async () => {
    const checks = [];
    const errors = [];
    const browser = await launch();
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        page.on('pageerror', e => errors.push('pageerror: ' + String(e).slice(0, 300)));
        page.on('console', (m) => {
            if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 300));
        });

        // 1. a stored WebGPU preference must be honoured on the next start
        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForFunction('!!window.scene', { timeout: 90000 });
        await page.evaluate(() => window.localStorage.setItem('splatroom.gpuBackend', 'webgpu'));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction('!!window.scene', { timeout: 90000 });
        await sleep(3000);

        const stored = await page.evaluate(() => {
            const popup = document.querySelector('#popup');
            return {
                backend: window.scene.graphicsDevice.isWebGPU ? 'webgpu' : 'webgl2',
                pref: window.localStorage.getItem('splatroom.gpuBackend'),
                popupVisible: !!popup && !popup.classList.contains('pcui-hidden'),
                popupText: (popup?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
            };
        });
        checks.push({ name: 'stored WebGPU preference is honoured', pass: stored.backend === 'webgpu', detail: stored.backend });
        checks.push({ name: 'stored preference is left untouched', pass: stored.pref === 'webgpu', detail: String(stored.pref) });
        checks.push({ name: 'no fallback popup while WebGPU works', pass: !stored.popupVisible, detail: stored.popupText });

        await loadModel(page);
        const ratioGpu = await viewportStats(page);
        checks.push({ name: 'model renders on the stored WebGPU backend', pass: ratioGpu > 0.05, detail: `${(ratioGpu * 100).toFixed(1)}% of the sampled viewport is coloured` });

        // 2. a stored WebGL2 preference reaches the WebGL2 device
        await page.evaluate(() => window.localStorage.setItem('splatroom.gpuBackend', 'webgl2'));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction('!!window.scene', { timeout: 90000 });
        await sleep(2500);
        const storedGl = await page.evaluate(() => (window.scene.graphicsDevice.isWebGPU ? 'webgpu' : 'webgl2'));
        checks.push({ name: 'stored WebGL2 preference is honoured', pass: storedGl === 'webgl2', detail: storedGl });

        // 3. the URL override still wins over the stored value (harnesses rely on it)
        await page.goto(`${URL}?gpu=webgpu`, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForFunction('!!window.scene', { timeout: 90000 });
        await sleep(1500);
        const override = await page.evaluate(() => ({
            backend: window.scene.graphicsDevice.isWebGPU ? 'webgpu' : 'webgl2',
            pref: window.localStorage.getItem('splatroom.gpuBackend'),
            popupVisible: (() => {
                const popup = document.querySelector('#popup');
                return !!popup && !popup.classList.contains('pcui-hidden');
            })()
        }));
        checks.push({ name: '?gpu=webgpu overrides the stored preference', pass: override.backend === 'webgpu', detail: override.backend });
        checks.push({ name: 'override does not rewrite the stored preference', pass: override.pref === 'webgl2', detail: String(override.pref) });
        checks.push({ name: 'override shows no popup', pass: !override.popupVisible });

        await page.goto(`${URL}?gpu=webgl2`, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForFunction('!!window.scene', { timeout: 90000 });
        await sleep(1500);
        const overrideGl = await page.evaluate(() => (window.scene.graphicsDevice.isWebGPU ? 'webgpu' : 'webgl2'));
        checks.push({ name: '?gpu=webgl2 overrides the stored WebGPU preference', pass: overrideGl === 'webgl2', detail: overrideGl });

        console.log(JSON.stringify({ stored, ratioGpu, storedGl, override, overrideGl, checks, failed: checks.filter(c => !c.pass).length, errors }, null, 2));
        if (checks.some(c => !c.pass) || errors.length) process.exitCode = 1;
    } catch (err) {
        console.log(JSON.stringify({ fatal: String(err).slice(0, 700), errors }, null, 2));
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
