// Measure the id pick (V2's rings-mode selection = pickRect ids) in isolation.
// The depth pass turned out to be perfectly healthy when measured; the id pick returned only 3 ids in
// my integration, so this finds out whether the pick itself works and how the region args behave.
// usage: node pickpass-probe.cjs [model] [url]
const puppeteer = require('puppeteer-core');
const { BROWSER_PATH: EDGE } = require('../verify/lib/browser.cjs');
const MODEL = process.argv[2] || 'test-model.ply';
const URL = process.argv[3] || 'http://localhost:3621/?gpu=webgpu';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 600000
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    page.on('pageerror', e => console.log('[pageerror] ' + String(e).slice(0, 200)));
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 90000 });
    await sleep(1500);
    await page.evaluate(async (m) => {
        const buf = await (await fetch('./' + m)).arrayBuffer();
        await window.scene.events.invoke('import', [{ filename: m, contents: new File([buf], m) }]);
    }, MODEL);
    await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 300000 });
    await sleep(4000);

    const out = await page.evaluate(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const scene = window.scene;
        const splat = scene.getElementsByType('splat').slice(-1)[0];
        scene.events.fire('selection', splat);
        await sleep(500);
        scene.events.fire('camera.focus');
        await sleep(4000);
        scene.events.fire('tool.rectSelection');
        await sleep(800);

        scene.events.fire('camera.setMode', 'rings');
        await sleep(800);
        const { width, height } = scene.targetSize;
        const summarise = (label, ids) => {
            const set = new Set(ids);
            let min = Infinity;
            let max = -Infinity;
            let zeros = 0;
            for (const v of ids) {
                if (v < min) min = v;
                if (v > max) max = v;
                if (v === 0) zeros++;
            }
            return {
                label,
                returned: ids.length,
                distinct: set.size,
                min: ids.length ? min : null,
                max: ids.length ? max : null,
                zeroIds: zeros,
                first8: ids.slice(0, 8)
            };
        };

        const results = [];
        for (const [label, x0, y0, w, h] of [
            ['single pixel (centre)', 0.5, 0.5, 1 / width, 1 / height],
            ['small 10% box', 0.45, 0.45, 0.1, 0.1],
            ['large 40% box', 0.3, 0.3, 0.4, 0.4],
            ['full screen', 0, 0, 1, 1]
        ]) {
            scene.camera.pickPrep(splat, 'set');
            const t0 = performance.now();
            const ids = await scene.camera.pickRect(x0, y0, w, h);
            results.push({ ...summarise(label, ids), ms: Math.round(performance.now() - t0) });
        }

        // and the same box the rings-mode wiring uses, to compare with the 3-ids result
        const bx0 = Math.round(width * 0.4);
        const bx1 = Math.round(width * 0.6);
        const by0 = Math.round(height * 0.4);
        const by1 = Math.round(height * 0.6);
        scene.camera.pickPrep(splat, 'set');
        const wired = await scene.camera.pickRect(bx0 / width, by0 / height, (bx1 - bx0) / width, (by1 - by0) / height);
        results.push(summarise('the rings wiring box (0.4-0.6)', wired));

        return { backend: scene.graphicsDevice.isWebGPU ? 'webgpu' : 'webgl2', target: [width, height], numSplats: splat.splatData.numSplats, results };
    });
    console.log(`backend ${out.backend} | target ${out.target.join('x')} | ${out.numSplats} splats`);
    for (const r of out.results) console.log(JSON.stringify(r));
    await browser.close();
})().catch(e => { console.log('FATAL ' + String(e).slice(0, 300)); process.exit(1); });
