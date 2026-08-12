// End-to-end click test: load → wait → click center of viewport → read stat
const puppeteer = require('puppeteer-core');
const path = require('path');

(async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: 'new',
        args: [
            '--no-sandbox',
            '--use-gl=angle',
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
            '--ignore-gpu-blocklist',
        ]
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });

    const logs = [];
    page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));

    await page.goto('http://localhost:3000/seg-lab/?model=scene.ply', { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 3000));

    console.log('=== before click ===');
    console.log('stat:', await page.evaluate(() => document.getElementById('stat').textContent));

    // Click center of viewport (where big white sphere is rendered)
    await page.mouse.click(700, 450);
    await new Promise((r) => setTimeout(r, 2000));

    console.log('=== after click (700,450 - white sphere) ===');
    console.log('stat:', await page.evaluate(() => document.getElementById('stat').textContent));

    // Take screenshot after click to see fade effect
    await page.screenshot({ path: path.join(__dirname, 'seg-lab-after-click.png') });

    // Click blue sphere location (the script placed at x=-1.30, y=-0.15, z=1.05)
    // we don't know exact screen position - just try a few offset points
    for (const [x, y, label] of [[900, 600, 'bottom-right (likely red)'], [400, 700, 'bottom-left (likely pink/purple area)']]) {
        await page.mouse.click(x, y);
        await new Promise((r) => setTimeout(r, 1500));
        console.log(`=== after click ${label} ===`);
        console.log('stat:', await page.evaluate(() => document.getElementById('stat').textContent));
    }

    console.log('--- console (last 30) ---');
    logs.slice(-30).forEach((l) => console.log(l));

    await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
