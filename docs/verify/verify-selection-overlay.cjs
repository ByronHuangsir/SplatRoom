// Verify the second render target's consumers (selection underlay tint + outline pass)
// on a chosen backend. Both read RT1 of the splat MRT, which is written by the custom
// shader as `output.color1` — the piece that had no equivalent in the engine's WGSL
// shader before the port.
//
// usage: node docs/verify/verify-selection-overlay.cjs "<url>" [model]
const puppeteer = require('puppeteer-core');
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
    let lit = 0;
    const n = img.width * img.height;
    for (let i = 0; i < img.data.length; i += img.channels) {
        const r = img.data[i];
        const g = img.data[i + 1];
        const b = img.data[i + 2];
        sum += r + g + b;
        if (Math.max(r, g, b) > 60) lit++;
    }
    return { meanLum: Math.round(sum / (n * 3)), litPct: +((lit / n) * 100).toFixed(1) };
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
    const errors = [];
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`); });
        page.on('pageerror', e => errors.push('pageerror: ' + String(e).slice(0, 200)));

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

        // select all: with the outline pass off the underlay adds RT1's 20% tint on top of RT0
        await page.evaluate(async () => {
            window.scene.events.fire('select.none');
            await new Promise(r => setTimeout(r, 600));
        });
        await settle(page);
        const unselected = await stats(page);

        const outlineMode = await page.evaluate(() => window.scene.events.invoke('view.outlineSelection'));

        await page.evaluate(async () => {
            window.scene.events.fire('select.all');
            await new Promise(r => setTimeout(r, 1200));
        });
        await settle(page);
        const selected = await stats(page);

        // turn the outline pass on (it reads RT1's alpha as a coverage mask)
        await page.evaluate(async () => {
            window.scene.events.fire('view.setOutlineSelection', true);
            await new Promise(r => setTimeout(r, 1200));
        });
        await settle(page);
        const outlined = await stats(page);
        const outlineAfter = await page.evaluate(() => window.scene.events.invoke('view.outlineSelection'));

        const checks = [
            { name: 'model visible', pass: unselected.litPct > 20, detail: `${unselected.litPct}% lit` },
            {
                name: 'selection underlay brightens the model (RT1 rgb)',
                pass: selected.meanLum > unselected.meanLum * 1.02,
                detail: `mean ${unselected.meanLum} -> ${selected.meanLum}`
            },
            {
                name: 'outline pass changes the frame (RT1 alpha)',
                pass: outlined.meanLum !== selected.meanLum,
                detail: `outlineSelection ${outlineMode} -> ${outlineAfter}, mean ${selected.meanLum} -> ${outlined.meanLum}`
            }
        ];
        console.log(JSON.stringify({ backend, unselected, selected, outlined, checks, failed: checks.filter(c => !c.pass).length, errors }, null, 2));
        if (checks.some(c => !c.pass) || errors.length) process.exitCode = 1;
    } catch (e) {
        console.log(JSON.stringify({ fatal: String(e).slice(0, 400), errors }, null, 2));
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
