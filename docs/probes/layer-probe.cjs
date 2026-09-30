// Which element sits under the pointer across the low block, at the default (zero expansion) state?
const puppeteer = require('puppeteer-core');
const { BROWSER_PATH: EDGE , launchPatched: _launchPatched } = require('../verify/lib/browser.cjs');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const BAR = '#selection-range-bar';
(async () => {
    const browser = await _launchPatched(puppeteer, { executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1500, height: 900 });
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

    const scan = (label) => page.evaluate((sel, label) => {
        const row = document.querySelector(`${sel} .select-range-row[data-axis="x"]`);
        const t = row.querySelector('.select-range-track').getBoundingClientRect();
        const y = t.top + t.height / 2;
        const b = row.querySelector('.select-range-block[data-block="low"]').getBoundingClientRect();
        const out = [];
        for (let dx = -14; dx <= 14; dx += 2) {
            const el = document.elementFromPoint(b.left + b.width / 2 + dx, y);
            out.push(`${dx >= 0 ? '+' : ''}${dx}:${el ? (el.getAttribute('data-handle') || (el.getAttribute('data-block') ? 'block-' + el.getAttribute('data-block') : el.className.split(' ')[0])) : 'null'}`);
        }
        const zs = {};
        for (const cls of ['.select-range-block[data-block="low"]', '.select-range-block[data-block="high"]', '.select-range-handle-outer[data-handle="outerLow"]', '.select-range-handle-outer[data-handle="outerHigh"]']) {
            const el = row.querySelector(cls);
            if (el) { const cs = getComputedStyle(el); zs[cls] = `${cs.zIndex}/${cs.pointerEvents}/${Math.round(el.getBoundingClientRect().left - t.left)}+${Math.round(el.getBoundingClientRect().width)}`; }
        }
        return { label, out, zs, range: window.scene.events.invoke('selection.screenRange').x };
    }, BAR, label);

    const def = await scan('default (0..100, no expansion)');
    console.log(def.label, JSON.stringify(def.range));
    console.log('  across the low block:', def.out.join(' '));
    console.log('  layers:', JSON.stringify(def.zs));

    // collapse the core, then see what is grabbable and whether it can be widened again
    await page.evaluate(() => window.scene.events.fire('selection.setScreenRange', { x: { low: 50, high: 50, outerLow: 50, outerHigh: 50 } }));
    await sleep(400);
    const col = await scan('collapsed (50..50)');
    console.log(col.label, JSON.stringify(col.range));
    console.log('  across the low block:', col.out.join(' '));
    console.log('  layers:', JSON.stringify(col.zs));

    // try to pull it open with a real mouse drag to the left
    const geo = await page.evaluate((sel) => {
        const row = document.querySelector(`${sel} .select-range-row[data-axis="x"]`);
        const t = row.querySelector('.select-range-track').getBoundingClientRect();
        const b = row.querySelector('.select-range-block[data-block="low"]').getBoundingClientRect();
        return { x: b.left + b.width / 2, y: t.top + t.height / 2 };
    }, BAR);
    await page.mouse.move(geo.x, geo.y);
    await page.mouse.down();
    await page.mouse.move(geo.x - 80, geo.y, { steps: 8 });
    await page.mouse.up();
    await sleep(600);
    console.log('after dragging the collapsed block left 80px:', JSON.stringify(await page.evaluate(() => window.scene.events.invoke('selection.screenRange').x)));
    await browser.close();
})().catch(e => { console.log('FATAL ' + e); process.exit(1); });
