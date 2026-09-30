// Verify a core editing feature on a chosen backend: hide-all must empty the viewport.
const puppeteer = require('puppeteer-core');
const { decodePng } = require('./lib/png.cjs');

const { BROWSER_PATH: EDGE , launchPatched: _launchPatched } = require('./lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const stats = async (page) => {
    const rect = await page.evaluate(() => {
        const c = document.querySelector('canvas').getBoundingClientRect();
        return { x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.width), h: Math.round(c.height) };
    });
    const png = await page.screenshot({ type: 'png', clip: { x: Math.round(rect.x + rect.w * 0.32), y: Math.round(rect.y + rect.h * 0.25), width: Math.round(rect.w * 0.5), height: Math.round(rect.h * 0.5) } });
    const img = decodePng(Buffer.from(png));
    let colourful = 0;
    let sum = 0;
    const n = img.width * img.height;
    for (let i = 0; i < img.data.length; i += img.channels) {
        const r = img.data[i];
        const g = img.data[i + 1];
        const b = img.data[i + 2];
        if (Math.max(r, g, b) - Math.min(r, g, b) > 20) colourful++;
        sum += r + g + b;
    }
    return { colourfulPct: +((colourful / n) * 100).toFixed(1), meanLum: Math.round(sum / (n * 3)) };
};

(async () => {
    const browser = await _launchPatched(puppeteer, {
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
        await page.evaluate(() => { window.scene.forceRender = true; window.scene.app.renderNextFrame = true; });
        await sleep(800);
        const before = await stats(page);

        // hide all selected splats -> the state texture must take effect in the WGSL shader
        const state = await page.evaluate(async () => {
            const scene = window.scene;
            scene.events.fire('select.all');
            await new Promise(r => setTimeout(r, 1200));
            const splat = scene.getElementsByType('splat')[0];
            const selected = splat.numSelected ?? null;
            scene.events.fire('select.hide');
            await new Promise(r => setTimeout(r, 1500));
            scene.forceRender = true;
            scene.app.renderNextFrame = true;
            await new Promise(r => setTimeout(r, 900));
            return { backend: scene.graphicsDevice.isWebGPU ? 'webgpu' : 'webgl2', selected };
        });
        const after = await stats(page);

        const checks = [
            { name: 'model visible before hiding', pass: before.colourfulPct > 3, detail: `${before.colourfulPct}% colourful, mean ${before.meanLum}` },
            { name: 'select.all selected splats', pass: (state.selected ?? 0) > 0, detail: `selected=${state.selected}` },
            { name: 'hide removes the model from the viewport', pass: after.colourfulPct < before.colourfulPct * 0.35, detail: `${after.colourfulPct}% colourful, mean ${after.meanLum}` }
        ];
        console.log(JSON.stringify({ backend: state.backend, before, state, after, checks, failed: checks.filter(c => !c.pass).length, errors: logs }, null, 2));
        if (checks.some(c => !c.pass) || logs.length) process.exitCode = 1;
    } catch (e) {
        console.log(JSON.stringify({ fatal: String(e).slice(0, 400), errors: logs }, null, 2));
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
