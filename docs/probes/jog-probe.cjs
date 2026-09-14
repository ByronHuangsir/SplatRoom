// 3.13.0 mechanic: two blocks parked at fixed homes, a push-drag with an accelerating taper,
// and an automatic return on release. No numbers anywhere.
const puppeteer = require('C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const BAR = '#selection-range-bar';
(async () => {
    const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1500, height: 900 });
    page.on('pageerror', e => console.log('[pageerror] ' + String(e).slice(0, 200)));
    await page.goto('http://localhost:3621/?gpu=webgpu', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 90000 });
    await sleep(1200);
    await page.evaluate(async () => {
        const buf = await (await fetch('./test-model.ply')).arrayBuffer();
        await window.scene.events.invoke('import', [{ filename: 'test-model.ply', contents: new File([buf], 'test-model.ply') }]);
    });
    await sleep(2500);
    await page.evaluate(() => window.scene.events.fire('tool.rectSelection'));
    await sleep(900);

    const state = () => page.evaluate((sel) => {
        const row = document.querySelector(`${sel} .select-range-row[data-axis="x"]`);
        const t = row.querySelector('.select-range-track').getBoundingClientRect();
        const r = window.scene.events.invoke('selection.screenRange').x;
        const box = (el) => { const b = el.getBoundingClientRect(); return +(((b.left + b.width / 2) - t.left) / t.width).toFixed(3); };
        return {
            low: r.low, high: r.high,
            lowAt: box(row.querySelector('.select-range-block[data-block="low"]')),
            highAt: box(row.querySelector('.select-range-block[data-block="high"]')),
            outerBars: row.querySelectorAll('.select-range-handle-outer').length,
            bands: row.querySelectorAll('.select-range-band').length,
            numbers: (row.textContent.match(/[0-9]/g) || []).length,
            texts: Array.from(row.querySelectorAll('.select-range-label')).map(l => l.textContent)
        };
    }, BAR);

    const s0 = await state();
    console.log('rest:', JSON.stringify({ low: s0.low, high: s0.high, lowAt: s0.lowAt, highAt: s0.highAt, outerBars: s0.outerBars, bands: s0.bands, digitsInRow: s0.numbers, labels: s0.texts }));

    const drag = async (handle, steps, stepPx) => {
        const g = await page.evaluate((sel, h) => {
            const row = document.querySelector(`${sel} .select-range-row[data-axis="x"]`);
            const track = row.querySelector('.select-range-track');
            const el = track.querySelector(`.select-range-handle[data-handle="${h}"]`);
            const t = track.getBoundingClientRect();
            const b = el.getBoundingClientRect();
            return { fromX: b.left + b.width / 2, y: t.top + t.height / 2 };
        }, BAR, handle);
        await page.mouse.move(g.fromX, g.y);
        await page.mouse.down();
        const trace = [];
        for (let i = 1; i <= steps; i++) {
            await page.mouse.move(g.fromX + i * stepPx, g.y, { steps: 1 });
            await sleep(70);
            const s = await page.evaluate((sel, h) => {
                const row = document.querySelector(`${sel} .select-range-row[data-axis="x"]`);
                const t = row.querySelector('.select-range-track').getBoundingClientRect();
                const b = row.querySelector(`.select-range-block[data-block="${h}"]`).getBoundingClientRect();
                const r = window.scene.events.invoke('selection.screenRange').x;
                return { value: r[h], blockAt: +(((b.left + b.width / 2) - t.left) / t.width).toFixed(3) };
            }, BAR, handle);
            trace.push({ px: i * stepPx, ...s });
        }
        await page.mouse.up();
        await sleep(400);
        const released = await state();
        return { trace, released };
    };

    // the same 20px nudge near home vs far from home -> the taper
    const near = await drag('low', 1, 20);
    const far = await drag('low', 10, 20);
    const nearDelta = +(near.released.low - s0.low).toFixed(1);
    const farDelta = +(far.trace[9].value - far.trace[8].value).toFixed(2);
    console.log(`near-home 20px  -> low ${s0.low} -> ${near.released.low} (Δ${nearDelta})`);
    console.log(`far (200px in) next 20px -> Δ${farDelta}  values ${far.trace.map(t => t.value).join(' ')}`);
    console.log('release returns home:', JSON.stringify({ lowAt: near.released.lowAt, highAt: near.released.highAt }));

    // the block follows the pointer while held, and parks inside the rail
    await page.evaluate(() => window.scene.events.fire('selection.resetRange'));
    await sleep(400);
    const g = await page.evaluate((sel) => {
        const row = document.querySelector(`${sel} .select-range-row[data-axis="x"]`);
        const t = row.querySelector('.select-range-track').getBoundingClientRect();
        const b = row.querySelector('.select-range-block[data-block="low"]').getBoundingClientRect();
        return { fromX: b.left + b.width / 2, y: t.top + t.height / 2, trackLeft: t.left, trackWidth: t.width };
    }, BAR);
    await page.mouse.move(g.fromX, g.y);
    await page.mouse.down();
    const held = [];
    for (const dx of [0, 40, 100, 200, 400, 700]) {
        await page.mouse.move(g.fromX + dx, g.y, { steps: 1 });
        await sleep(80);
        const s = await page.evaluate((sel) => {
            const row = document.querySelector(`${sel} .select-range-row[data-axis="x"]`);
            const t = row.querySelector('.select-range-track').getBoundingClientRect();
            const b = row.querySelector('.select-range-block[data-block="low"]').getBoundingClientRect();
            return { at: +(((b.left + b.width / 2) - t.left) / t.width).toFixed(3), low: window.scene.events.invoke('selection.screenRange').x.low };
        }, BAR);
        held.push(`${dx}px -> block ${s.at} low ${s.low}`);
    }
    await page.mouse.up();
    await sleep(400);
    console.log('held drag:', held.join(' | '));
    console.log('after release:', JSON.stringify(await state()));
    await browser.close();
})().catch(e => { console.log('FATAL ' + e); process.exit(1); });
