// Final check via REAL button clicks (no debug hooks)
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
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });

    await page.goto('http://localhost:3000/seg-lab/?model=scene.ply', { waitUntil: 'networkidle0' });
    await sleep(3000);

    // click an object (seed) -> auto hide
    await page.mouse.click(700, 450);
    await sleep(1500);
    const s1 = await page.evaluate(() => document.getElementById('stat').textContent);
    const a1 = await page.screenshot();
    const m1 = crypto.createHash('md5').update(a1).digest('hex');

    // click 隐藏背景 button (real) -> toggle to show all
    await page.click('#btnHideBg');
    await sleep(1500);
    const s2 = await page.evaluate(() => document.getElementById('stat').textContent);
    const a2 = await page.screenshot();
    const m2 = crypto.createHash('md5').update(a2).digest('hex');

    // click 隐藏背景 again (real) -> hide again
    await page.click('#btnHideBg');
    await sleep(1500);
    const s3 = await page.evaluate(() => document.getElementById('stat').textContent);
    const a3 = await page.screenshot();
    const m3 = crypto.createHash('md5').update(a3).digest('hex');

    console.log('after seed  :', s1);
    console.log('after btn#1 :', s2);
    console.log('after btn#2 :', s3);
    console.log('md5 seed-hide:', m1);
    console.log('md5 show-all :', m2);
    console.log('md5 hide-again:', m3);
    console.log('hide != show :', m1 !== m2);
    console.log('show != hide2:', m2 !== m3);
    console.log('errors:', errs.length ? errs : 'NONE');

    await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
