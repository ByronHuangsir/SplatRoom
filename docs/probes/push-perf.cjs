// How long does ONE slider push take to land (the thing that makes dragging feel sticky)?
// usage: node push-perf.cjs <modelNameUnderDist> [url]
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const MODEL = process.argv[2] || 'test-model.ply';
const URL = process.argv[3] || 'http://localhost:3621/?gpu=webgpu';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'], protocolTimeout: 1800000 });
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
    await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 900000 });
    await sleep(10000);

    const out = await page.evaluate(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const scene = window.scene;
        const splat = scene.getElementsByType('splat').slice(-1)[0];
        scene.events.fire('selection', splat);
        await sleep(600);
        scene.events.fire('camera.focus');
        await sleep(4000);
        scene.events.fire('tool.rectSelection');
        await sleep(800);
        scene.events.fire('selection.resetRange');
        await sleep(300);
        const t0 = performance.now();
        await scene.events.invoke('select.rect', 'set', { start: { x: 0.35, y: 0.35 }, end: { x: 0.65, y: 0.65 } });
        const gestureMs = Math.round(performance.now() - t0);
        await sleep(1200);

        const count = () => {
            const st = splat.splatData.getProp('state');
            let n = 0;
            for (let i = 0; i < st.length; i++) if (st[i] & 1) n++;
            return n;
        };
        const base = count();
        const pushes = [];
        for (const v of [0.5, 1, 2, 5]) {
            const t = performance.now();
            scene.events.fire('selection.setScreenRange', { x: { low: v } });
            // wait for the pump to actually land (the count must change)
            let landed = null;
            for (let i = 0; i < 60; i++) {
                await sleep(20);
                const c = count();
                if (c !== base) { landed = c; break; }
            }
            pushes.push({ v, ms: landed === null ? 'no change' : Math.round(performance.now() - t), selected: landed });
            console.log('  [probe] x.low ' + v + ' -> ' + pushes[pushes.length - 1].ms + ' ms');
            scene.events.fire('selection.resetRange');
            await sleep(400);
        }
        // and a depth push (the drag of 最近 / 最远)
        for (const v of [0.5, 1]) {
            const t = performance.now();
            scene.events.fire('selection.setDepthRange', { near: v });
            let landed = null;
            for (let i = 0; i < 60; i++) {
                await sleep(20);
                const c = count();
                if (c !== base) { landed = c; break; }
            }
            pushes.push({ depthNear: v, ms: landed === null ? 'no change' : Math.round(performance.now() - t), selected: landed });
            scene.events.fire('selection.resetRange');
            await sleep(400);
        }
        return { numSplats: splat.splatData.numSplats, gestureMs, base, pushes };
    });
    console.log(`model ${MODEL}: ${out.numSplats} splats | gesture ${out.gestureMs} ms | selected ${out.base}`);
    for (const p of out.pushes) {
        console.log(`  push ${p.v !== undefined ? 'x.low ' + p.v : 'depth.near ' + p.depthNear} -> landed in ${p.ms} ms (selected ${p.selected})`);
    }
    await browser.close();
})().catch(e => { console.log('FATAL ' + String(e).slice(0, 300)); process.exit(1); });
