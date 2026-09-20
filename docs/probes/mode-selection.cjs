// Does the selection set depend on the display mode (中心 centers / 环 rings)?
// If the counts are identical, "环模式下不穿透" is a VISUAL issue (what is drawn), not a selection bug.
// usage: node mode-selection.cjs [model] [url]
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
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
    await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 240000 });
    await sleep(3500);

    const run = (mode) => page.evaluate(async (m) => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const scene = window.scene;
        scene.events.fire('camera.setMode', m);
        await sleep(700);
        const splat = scene.getElementsByType('splat').slice(-1)[0];
        scene.events.fire('selection', splat);
        await sleep(400);
        scene.events.fire('camera.focus');
        await sleep(2500);
        scene.events.fire('tool.rectSelection');
        await sleep(700);
        scene.events.fire('selection.resetRange');
        await sleep(300);
        scene.events.fire('select.none');
        await sleep(800);
        await scene.events.invoke('select.rect', 'set', { start: { x: 0.4, y: 0.4 }, end: { x: 0.6, y: 0.6 } });
        await sleep(1500);
        const st = splat.splatData.getProp('state');
        // 深度方向的铺开量：穿透选中会跨整个模型，只看表面就只剩一层
        const zz = splat.splatData.getProp('z');
        let zmin = Infinity, zmax = -Infinity;
        for (let i = 0; i < st.length; i++) if (st[i] & 1) { if (zz[i] < zmin) zmin = zz[i]; if (zz[i] > zmax) zmax = zz[i]; }
        const spread = zmax > zmin ? +(zmax - zmin).toFixed(3) : 0;
        let n = 0;
        for (let i = 0; i < st.length; i++) if (st[i] & 1) n++;
        // the indices, so the two modes can be compared as SETS and not just counts
        const idx = [];
        for (let i = 0; i < st.length; i += Math.max(1, Math.floor(st.length / 500))) if (st[i] & 1) idx.push(i);
        return {
            mode: scene.events.invoke('camera.mode'),
            selected: n,
            spread,
            sample: idx.slice(0, 20),
            depth: scene.events.invoke('selection.depthRange'),
            range: scene.events.invoke('selection.screenRange').x,
            ringSize: splat.material ? splat.material.getParameter('ringSize') : null
        };
    }, mode);

    const centers = await run('centers');
    const rings = await run('rings');
    console.log('centers:', JSON.stringify(centers));
    console.log('rings  :', JSON.stringify(rings));
    console.log('same count:', centers.selected === rings.selected, '| same sample indices:', JSON.stringify(centers.sample) === JSON.stringify(rings.sample));
    await browser.close();
})().catch(e => { console.log('FATAL ' + String(e).slice(0, 300)); process.exit(1); });
