// 3.11.0: how does the drag feel when the thickness is already very thin?
// Sets the x core to a given span, then drags the low block 22px at a time (real mouse) and
// records the value + the on-screen gap, so we can quote "how many px for one 0.1 step".
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

    const state = () => page.evaluate((sel) => {
        const track = document.querySelector(`${sel} .select-range-row[data-axis="x"] .select-range-track`);
        const t = track.getBoundingClientRect();
        const blocks = Array.from(track.querySelectorAll('.select-range-block')).map(b => {
            const bb = b.getBoundingClientRect();
            return { side: b.getAttribute('data-block'), x: Math.round(bb.left - t.left), w: Math.round(bb.width) };
        });
        return { blocks, gap: Math.round(track.querySelector('.select-range-core').getBoundingClientRect().width), range: window.scene.events.invoke('selection.screenRange').x };
    }, BAR);
    const set = (patch) => page.evaluate((p) => window.scene.events.fire('selection.setScreenRange', { x: p }), patch);

    for (const span of [2, 0.5, 0.2, 0.1]) {
        const low = 50, high = +(50 + span).toFixed(1);
        await set({ low, high, outerLow: low, outerHigh: high });
        await sleep(400);
        const before = await state();
        const start = await page.evaluate((sel) => {
            const t = document.querySelector(`${sel} .select-range-row[data-axis="x"] .select-range-track`).getBoundingClientRect();
            const b = document.querySelector(`${sel} .select-range-row[data-axis="x"] .select-range-block[data-block="low"]`).getBoundingClientRect();
            return { fromX: b.left + b.width / 2, y: t.top + t.height / 2 };
        }, BAR);
        await page.mouse.move(start.fromX, start.y);
        await page.mouse.down();
        const trace = [];
        for (let i = 1; i <= 6; i++) {
            await page.mouse.move(start.fromX + i * 22, start.y, { steps: 1 });
            await sleep(70);
            const s = await state();
            trace.push({ px: i * 22, low: s.range.low, gap: s.gap, blockW: s.blocks.map(b => b.w).join('/') });
        }
        await page.mouse.up();
        // how many px for one 0.1 step, from the first step that actually moved
        const moved = trace.filter(p => p.low > before.range.low);
        const pxPerStep = moved.length ? (moved[0].px / +((moved[0].low - before.range.low) / 0.1).toFixed(2)) : null;
        console.log(`span ${span}: gap ${before.gap}px, blockW ${before.blocks.map(b => b.w).join('/')} -> ` +
            trace.map(p => `${p.px}px:${p.low}`).join(' ') +
            `  (${pxPerStep ? pxPerStep.toFixed(0) + 'px per 0.1 step' : 'no step in 132px'})`);
        await page.evaluate(() => window.scene.events.fire('selection.resetRange'));
        await sleep(250);
    }
    await browser.close();
})().catch(e => { console.log('FATAL ' + e); process.exit(1); });
