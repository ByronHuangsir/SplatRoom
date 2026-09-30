const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { decodePng } = require(path.join(__dirname, '..', 'verify', 'lib', 'png.cjs'));
const { BROWSER_PATH: EDGE , launchPatched: _launchPatched } = require('../verify/lib/browser.cjs');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
    const browser = await _launchPatched(puppeteer, { executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
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
    const geo = await page.evaluate(() => {
        const bar = document.getElementById('selection-range-bar');
        const rows = [];
        for (const r of bar.querySelectorAll('.select-range-row')) {
            const t = r.querySelector('.select-range-track').getBoundingClientRect();
            const rel = (b) => [Math.round(b.left - t.left), Math.round(b.width)];
            const blocks = Array.from(r.querySelectorAll('.select-range-block')).map(b => ({ side: b.getAttribute('data-block'), box: rel(b.getBoundingClientRect()), label: b.textContent }));
            const handles = Array.from(r.querySelectorAll('.select-range-handle')).map(h => ({ name: h.getAttribute('data-handle'), box: rel(h.getBoundingClientRect()) }));
            const core = rel(r.querySelector('.select-range-core').getBoundingClientRect());
            rows.push({ axis: r.getAttribute('data-axis'), track: Math.round(t.width), blocks, handles, core });
        }
        return { panel: [Math.round(document.getElementById('selection-range-bar').getBoundingClientRect().width), Math.round(document.getElementById('selection-range-bar').getBoundingClientRect().height)], rows };
    });
    console.log(JSON.stringify(geo, null, 1));
    const box = await page.evaluate(() => { const b = document.getElementById('selection-range-bar').getBoundingClientRect(); return { x: Math.floor(b.left) - 4, y: Math.floor(b.top) - 4, width: Math.ceil(b.width) + 8, height: Math.ceil(b.height) + 8 }; });
    await page.screenshot({ path: path.join(__dirname, '..', '..', '..', '_tmp', 'panel2.png'), clip: box });
    await browser.close();
})().catch(e => { console.log('FATAL ' + e); process.exit(1); });