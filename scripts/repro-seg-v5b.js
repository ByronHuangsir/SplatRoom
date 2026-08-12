// Verify two key paths on v=5: default fallback (no query) + explicit scene.ply
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function check(url, label) {
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: 'new',
        args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    await page.goto(url, { waitUntil: 'networkidle0' });
    await sleep(2500);
    await page.mouse.click(700, 450);
    await sleep(1500);
    const stat = await page.evaluate(() => document.getElementById('stat').textContent);
    console.log(`[${label}] stat: ${stat}`);
    console.log(`         errors: ${errs.length ? errs.join(' | ') : 'NONE'}`);
    await browser.close();
    return errs.length === 0;
}

(async () => {
    const a = await check('http://localhost:3000/seg-lab/', 'DEFAULT no-query');
    const b = await check('http://localhost:3000/seg-lab/?model=scene.ply', 'EXPLICIT scene.ply');
    process.exit((a && b) ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
