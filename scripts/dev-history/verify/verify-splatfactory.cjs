// End-to-end: format factory page renders + converts test PLY → SPLAT (no GPU)
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        headless: 'new',
        args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-gl=angle',
               '--use-angle=swiftshader', '--enable-webgl', '--enable-webgl2', '--window-size=1440,900', '--hide-scrollbars']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
    page.on('console', m => { if (m.type() === 'error' && !m.text().includes('404')) errs.push('CONSOLE:' + m.text().slice(0, 200)); });

    await page.goto('http://localhost:3000/?mode=splatfactory', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => !!window.__splatFactory, { timeout: 30000 }).catch(() => {});
    await sleep(400);

    // 1. UI renders
    const ui = await page.evaluate(() => {
        const title = document.querySelector('.sf-title')?.textContent;
        const hasDrop = !!document.querySelector('.sf-drop');
        const fmtOptions = Array.from(document.querySelectorAll('.sf-select option')).map(o => o.textContent);
        const hasConvertBtn = !!document.querySelector('.sf-btn');
        return { title, hasDrop, fmtOptions, hasConvertBtn };
    });

    // 2. real conversion: fetch test-crop.ply → File → convertFile to 'splat'
    const conv = await page.evaluate(async () => {
        const res = await fetch('/test-crop.ply');
        const buf = await res.arrayBuffer();
        const file = new File([buf], 'test-crop.ply', { type: 'application/octet-stream' });
        const sf = window.__splatFactory;
        const r = await sf.convertFile(file, 'splat');
        // verify the result bytes begin with a splat magic-ish check (optional)
        return r;
    });

    // 3. convert to CSV (text-based, no GPU)
    const convCsv = await page.evaluate(async () => {
        const res = await fetch('/test-crop.ply');
        const buf = await res.arrayBuffer();
        const file = new File([buf], 'test-crop.ply');
        const sf = window.__splatFactory;
        return await sf.convertFile(file, 'csv');
    });

    console.log(JSON.stringify({ ui, conv, convCsv, errs }, null, 2));
    await page.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/sf-ui.png' });
    await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });