const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const BAR = '#selection-range-bar';
(async () => {
    const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1500, height: 900 });
    page.on('pageerror', e => console.log('[pageerror] ' + String(e).slice(0, 300)));
    await page.goto('http://localhost:3621/?gpu=webgpu', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 90000 });
    await sleep(1500);
    await page.evaluate(async () => {
        const buf = await (await fetch('./test-model.ply')).arrayBuffer();
        await window.scene.events.invoke('import', [{ filename: 'test-model.ply', contents: new File([buf], 'test-model.ply') }]);
    });
    await sleep(3000);
    await page.evaluate(() => window.scene.events.fire('tool.rectSelection'));
    await sleep(900);
    const geom = () => page.evaluate((sel) => {
        const track = document.querySelector(`${sel} .select-range-row[data-axis="x"] .select-range-track`);
        const t = track.getBoundingClientRect();
        const box = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left - t.left), w: Math.round(b.width) }; };
        const blocks = Array.from(track.querySelectorAll('.select-range-block')).map(b => ({ side: b.getAttribute('data-block'), ...box(b) }));
        const outers = Array.from(track.querySelectorAll('.select-range-handle-outer')).map(h => ({ name: h.getAttribute('data-handle'), ...box(h) }));
        return { track: Math.round(t.width), blocks, outers, core: box(track.querySelector('.select-range-core')), range: window.scene.events.invoke('selection.screenRange').x };
    }, BAR);
    const set = (patch) => page.evaluate((p) => window.scene.events.fire('selection.setScreenRange', { x: p }), patch);
    console.log('== default ==');
    console.log(JSON.stringify(await geom()));
    for (const [low, high] of [[30, 70], [45, 55], [48, 52], [49.5, 50.5]]) {
        await set({ low, high, outerLow: low, outerHigh: high });
        await sleep(350);
        const g = await geom();
        const gap = g.core.w;
        console.log(`core ${low}..${high} (span ${high - low}): blocks ${g.blocks.map(b => b.x + '+' + b.w).join(' ')}  core-gap ${gap}px  outers ${g.outers.map(o => o.x).join(',')}`);
    }
    // now expand from a narrow core and see the window adapt
    await set({ low: 48, high: 52, outerLow: -20, outerHigh: 120 });
    await sleep(350);
    console.log('narrow core + big 扩边:', JSON.stringify(await geom()));
    // live drag: pull the low block to the right and watch it track the pointer
    await page.evaluate(() => window.scene.events.fire('selection.resetRange'));
    await sleep(300);
    const start = await page.evaluate((sel) => {
        const t = document.querySelector(`${sel} .select-range-row[data-axis="x"] .select-range-track`).getBoundingClientRect();
        const b = document.querySelector(`${sel} .select-range-row[data-axis="x"] .select-range-block[data-block="low"]`).getBoundingClientRect();
        return { fromX: b.left + b.width / 2, y: t.top + t.height / 2 };
    }, BAR);
    await page.mouse.move(start.fromX, start.y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) {
        await page.mouse.move(start.fromX + i * 22, start.y, { steps: 1 });
        await sleep(60);
        const s = await page.evaluate(() => window.scene.events.invoke('selection.screenRange').x);
        const c = await geom();
        console.log(`  drag step ${i}: pointer +${i * 22}px -> low ${s.low} (high ${s.high}) core-gap ${c.core.w}px`);
    }
    await page.mouse.up();
    await browser.close();
})().catch(e => { console.log('FATAL ' + e); process.exit(1); });