// probe-only e2e: enable __debugSeg, box-select, then probe GPU buffer content
const puppeteer = require('puppeteer-core');

(async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: 'new',
        args: [
            '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
            '--ignore-gpu-blocklist', '--no-sandbox', '--disable-dev-shm-usage',
        ],
        defaultViewport: { width: 1400, height: 900 },
    });
    const page = await browser.newPage();
    const logs = [];
    page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', err => logs.push('[pageerror] ' + err.message));

    await page.goto('http://localhost:3000/seg-lab/?model=scene.ply', { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.getElementById('stat') &&
        document.getElementById('stat').textContent.includes('高斯已加载'), { timeout: 15000 });
    await new Promise(r => setTimeout(r, 1000));

    await page.evaluate(() => { window.__debugSeg = true; });
    console.log('debug flag enabled');

    // 框选
    await page.evaluate(() => {
        [...document.querySelectorAll('#modeBar button')].find(b => b.textContent.includes('框选')).click();
    });
    await new Promise(r => setTimeout(r, 200));
    await page.mouse.move(800, 400);
    await page.mouse.down();
    await page.mouse.move(950, 500, { steps: 5 });
    await page.mouse.move(1100, 600, { steps: 5 });
    await page.mouse.up();
    await new Promise(r => setTimeout(r, 1000));

    const stat = await page.evaluate(() => document.getElementById('stat').textContent);
    console.log('STAT after box:', stat);
    console.log('--- [probe] logs ---');
    logs.forEach(l => console.log(l));

    await browser.close();
})();
