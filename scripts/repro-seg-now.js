// Repro: load seg-lab and capture console + errors
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
            '--disable-gpu-sandbox',
            '--enable-features=Vulkan'
        ]
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });

    const logs = [];
    page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}\n${err.stack || ''}`));
    page.on('requestfailed', (req) => logs.push(`[requestfailed] ${req.url()} ${req.failure()?.errorText}`));
    page.on('response', (resp) => {
        if (resp.status() >= 400) logs.push(`[http${resp.status()}] ${resp.url()}`);
    });

    const url = 'http://localhost:3000/seg-lab/?model=scene.ply';
    console.log('Loading', url);
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 }).catch((e) => logs.push('[goto] ' + e.message));
    await new Promise((r) => setTimeout(r, 4000));

    const statText = await page.evaluate(() => document.getElementById('stat')?.textContent || '');
    const splatLoaded = await page.evaluate(() => {
        return {
            N: window.N,
            hasData: !!window.data,
            mask: window.mask ? window.mask.length : 0,
            stat: document.getElementById('stat')?.textContent
        };
    });
    console.log('stat:', statText);
    console.log('window state:', JSON.stringify(splatLoaded, null, 2));
    console.log('--- console ---');
    logs.forEach((l) => console.log(l));

    await page.screenshot({ path: path.join(__dirname, 'seg-lab-repro.png'), fullPage: false });
    await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
