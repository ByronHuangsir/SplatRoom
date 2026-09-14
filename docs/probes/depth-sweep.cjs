// How much of the depth axis's 0..100 actually contains splats? Sweeps the far/near bound on the
// real 931k scan and counts what each step removes — i.e. "does the first slide show a change?".
// usage: node depth-sweep.cjs [model] [url]
const puppeteer = require('C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const MODEL = process.argv[2] || 'big-model.ply';
const URL = process.argv[3] || 'http://localhost:3621/?gpu=webgpu';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    page.on('pageerror', e => console.log('[pageerror] ' + String(e).slice(0, 200)));
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 90000 });
    await sleep(1500);
    await page.evaluate(async (m) => {
        const buf = await (await fetch('./' + m)).arrayBuffer();
        await window.scene.events.invoke('import', [{ filename: m, contents: new File([buf], m) }]);
    }, MODEL);
    await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 600000 });
    await sleep(6000);

    const count = () => page.evaluate(() => {
        const splat = window.scene.getElementsByType('splat').slice(-1)[0];
        const st = splat.splatData.getProp('state');
        let n = 0;
        for (let i = 0; i < st.length; i++) if (st[i] & 1) n++;
        return n;
    });
    // a real rect gesture so the depth axis is live
    const numSplats = await page.evaluate(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const scene = window.scene;
        const splat = scene.getElementsByType('splat').slice(-1)[0];
        scene.events.fire('selection', splat);
        await sleep(600);
        scene.events.fire('camera.focus');
        await sleep(3000);
        scene.events.fire('tool.rectSelection');
        await sleep(800);
        scene.events.fire('selection.resetRange');
        await sleep(300);
        await scene.events.invoke('select.rect', 'set', { start: { x: 0.3, y: 0.3 }, end: { x: 0.7, y: 0.7 } });
        await sleep(2000);
        return splat.splatData.numSplats;
    });
    const full = await count();
    console.log(`model ${MODEL}: ${numSplats} splats | through-pass (0..100) selects ${full}`);

    const sweep = async (key, values) => {
        const rows = [];
        for (const v of values) {
            await page.evaluate((k, val) => window.scene.events.fire('selection.setDepthRange', { [k]: val }), key, v);
            await sleep(350);
            rows.push({ v, n: await count() });
        }
        await page.evaluate(() => window.scene.events.fire('selection.resetRange'));
        await sleep(300);
        return rows;
    };

    const far = await sweep('far', [100, 99.9, 99.5, 99, 98, 97, 95, 93, 90, 85, 80, 70, 60]);
    console.log('\n最远 trim (far -> selected):');
    let prev = full;
    for (const r of far) {
        const drop = prev - r.n;
        console.log(`  far ${String(r.v).padStart(6)} -> ${String(r.n).padStart(7)}  (removed ${String(drop).padStart(6)}, ${((drop / Math.max(full, 1)) * 100).toFixed(2)}% of the selection)`);
        prev = r.n;
    }

    const near = await sweep('near', [0, 0.1, 0.5, 1, 2, 3, 5, 7, 10, 15, 20, 30, 40]);
    console.log('\n最近 trim (near -> selected):');
    prev = full;
    for (const r of near) {
        const drop = prev - r.n;
        console.log(`  near ${String(r.v).padStart(5)} -> ${String(r.n).padStart(7)}  (removed ${String(drop).padStart(6)}, ${((drop / Math.max(full, 1)) * 100).toFixed(2)}% of the selection)`);
        prev = r.n;
    }
    await browser.close();
})().catch(e => { console.log('FATAL ' + e); process.exit(1); });
