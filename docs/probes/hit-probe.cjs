const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const BAR = '#selection-range-bar';
(async () => {
    const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1500, height: 900 });
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
    const info = await page.evaluate((sel) => {
        const row = document.querySelector(`${sel} .select-range-row[data-axis="x"]`);
        const track = row.querySelector('.select-range-track');
        const t = track.getBoundingClientRect();
        const bar = row.querySelector('.select-range-handle-outer[data-handle="outerLow"]');
        const b = bar.getBoundingClientRect();
        const x = b.left + b.width / 2;
        const y = t.top + t.height / 2;
        const hit = document.elementFromPoint(x, y);
        return {
            bar: { left: Math.round(b.left), width: Math.round(b.width), top: Math.round(b.top), height: Math.round(b.height) },
            point: [Math.round(x), Math.round(y)],
            hitClass: hit ? (hit.className || hit.tagName) : null,
            hitHandle: hit && hit.getAttribute ? hit.getAttribute('data-handle') : null,
            barPointerEvents: getComputedStyle(bar).pointerEvents,
            barZ: getComputedStyle(bar).zIndex
        };
    }, BAR);
    console.log(JSON.stringify(info, null, 1));
    await browser.close();
})().catch(e => { console.log('FATAL ' + e); process.exit(1); });