// WebGPU preference safety check.
//
// The WebGPU backend cannot render splats in this build (see
// docs/V3-WebGPU-现状.md), so a stored WebGPU preference must never put the user
// in front of a black viewport: the app has to refuse it, fall back to WebGL2,
// reset the stored preference and explain itself in a popup. `?gpu=webgpu` stays
// available for backend development.
//
// usage: node docs/verify/verify-webgpu-fallback.cjs [url]
const puppeteer = require('C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
const { decodePng } = require('./lib/png.cjs');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/';
const MODEL = process.argv[3] || 'test-model.ply';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const launch = () => puppeteer.launch({
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

        // 1. a stored WebGPU preference must be refused
        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForFunction('!!window.scene', { timeout: 90000 });
        await page.evaluate(() => window.localStorage.setItem('splatroom.gpuBackend', 'webgpu'));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction('!!window.scene', { timeout: 90000 });
        await sleep(3000);

        const fallback = await page.evaluate(() => {
            const popup = document.querySelector('#popup');
            return {
                backend: window.scene.graphicsDevice.isWebGPU ? 'webgpu' : 'webgl2',
                stored: window.localStorage.getItem('splatroom.gpuBackend'),
                popupVisible: !!popup && !popup.classList.contains('pcui-hidden'),
                popupText: (popup?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 220)
            };
        });
        const t = fallback.popupText.toLowerCase();
        checks.push({ name: 'stored WebGPU preference is refused', pass: fallback.backend === 'webgl2', detail: fallback.backend });
        checks.push({ name: 'stored preference reset to webgl2', pass: fallback.stored === 'webgl2', detail: String(fallback.stored) });
        checks.push({ name: 'popup explains the fallback', pass: fallback.popupVisible && /webgpu/i.test(t) && /webgl2/i.test(t), detail: fallback.popupText.slice(0, 120) });

        // a model still displays after the fallback
        await page.evaluate(async (model) => {
            const buf = await (await fetch('./' + model)).arrayBuffer();
            await window.scene.events.invoke('import', [{ filename: model, contents: new File([buf], model) }]);
        }, MODEL);
        await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 120000 });
        await sleep(4000);
        await page.evaluate(() => { window.scene.forceRender = true; window.scene.app.renderNextFrame = true; });
        await sleep(1000);
        const ratio = await viewportStats(page);
        checks.push({ name: 'model renders after the fallback', pass: ratio > 0.05, detail: `${(ratio * 100).toFixed(1)}% of the sampled viewport is coloured` });

        // 2. the development override still reaches the WebGPU device
        await page.goto(`${URL}?gpu=webgpu`, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForFunction('!!window.scene', { timeout: 90000 });
        await sleep(1500);
        const override = await page.evaluate(() => ({
            backend: window.scene.graphicsDevice.isWebGPU ? 'webgpu' : 'webgl2',
            stored: window.localStorage.getItem('splatroom.gpuBackend'),
            popupVisible: (() => {
                const popup = document.querySelector('#popup');
                return !!popup && !popup.classList.contains('pcui-hidden');
            })()
        }));
        checks.push({ name: '?gpu=webgpu still selects the WebGPU device', pass: override.backend === 'webgpu', detail: override.backend });
        checks.push({ name: 'override does not rewrite the stored preference', pass: override.stored === 'webgl2', detail: String(override.stored) });
        checks.push({ name: 'override shows no fallback popup', pass: !override.popupVisible });

        console.log(JSON.stringify({ fallback, ratio, override, checks, failed: checks.filter(c => !c.pass).length, errors }, null, 2));
        if (checks.some(c => !c.pass) || errors.length) process.exitCode = 1;
    } catch (err) {
        console.log(JSON.stringify({ fatal: String(err).slice(0, 700), errors }, null, 2));
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
