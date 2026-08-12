// Diagnose: why does hiding background not change the rendered pixels?
const puppeteer = require('puppeteer-core');
const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: 'new',
        args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    const logs = [];
    page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

    await page.goto('http://localhost:3000/seg-lab/?model=scene.ply', { waitUntil: 'networkidle0' });
    await sleep(3000);

    // 1) Probe resource/texture state
    const dbg = await page.evaluate(() => (window.__segDebug ? window.__segDebug() : 'no-debug'));
    console.log('=== DEBUG STATE ===');
    console.log(JSON.stringify(dbg, null, 2));

    // 2) Click center to select seed (auto-hide)
    await page.mouse.click(700, 450);
    await sleep(1800);
    const statAfterSeed = await page.evaluate(() => document.getElementById('stat').textContent);
    console.log('stat after seed click:', statAfterSeed);

    // 3) Screenshot A (hidden bg)
    const bufA = await page.screenshot();
    const md5A = crypto.createHash('md5').update(bufA).digest('hex');

    // 4) Toggle hide-bg OFF (show all) via debug fn
    const tog = await page.evaluate(() => window.__segToggleHideBg());
    console.log('toggle result:', JSON.stringify(tog));
    await sleep(1500);
    const bufB = await page.screenshot();
    const md5B = crypto.createHash('md5').update(bufB).digest('hex');

    console.log('=== PIXEL COMPARE ===');
    console.log('md5A:', md5A, 'size', bufA.length);
    console.log('md5B:', md5B, 'size', bufB.length);
    console.log('PIXELS CHANGED:', md5A !== md5B);

    logs.slice(-20).forEach((l) => console.log(l));
    await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
