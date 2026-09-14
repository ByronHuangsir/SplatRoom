// Does the dragged block stay under the pointer today? Logs pointerX vs the block centre every step.
const puppeteer = require('C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
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

    const probe = (pointerX) => page.evaluate((sel, px) => {
        const row = document.querySelector(`${sel} .select-range-row[data-axis="x"]`);
        const t = row.querySelector('.select-range-track').getBoundingClientRect();
        const b = row.querySelector('.select-range-block[data-block="low"]').getBoundingClientRect();
        const hit = document.elementFromPoint(px, t.top + t.height / 2);
        return {
            value: window.scene.events.invoke('selection.screenRange').x.low,
            blockCentre: Math.round(b.left + b.width / 2 - t.left),
            pointerInTrack: Math.round(px - t.left),
            hit: hit ? (hit.getAttribute('data-handle') || hit.className) : null
        };
    }, BAR, pointerX);

    const start = await page.evaluate((sel) => {
        const t = document.querySelector(`${sel} .select-range-row[data-axis="x"] .select-range-track`).getBoundingClientRect();
        const b = document.querySelector(`${sel} .select-range-row[data-axis="x"] .select-range-block[data-block="low"]`).getBoundingClientRect();
        return { fromX: b.left + b.width / 2, y: t.top + t.height / 2 };
    }, BAR);
    await page.mouse.move(start.fromX, start.y);
    await page.mouse.down();
    console.log('step   pointer@track  blockCentre  drift  value  hit');
    for (let i = 0; i <= 10; i++) {
        const px = start.fromX + i * 22;
        if (i > 0) {
            await page.mouse.move(px, start.y, { steps: 1 });
            await sleep(80);
        }
        const s = await probe(px);
        console.log(`  ${String(i * 22).padStart(3)}px  ${String(s.pointerInTrack).padStart(9)}  ${String(s.blockCentre).padStart(11)}  ${String(s.blockCentre - s.pointerInTrack).padStart(5)}  ${String(s.value).padStart(5)}  ${s.hit}`);
    }
    await page.mouse.up();
    await browser.close();
})().catch(e => { console.log('FATAL ' + e); process.exit(1); });
