// puppeteer-e2e.js — 复现用户的"框选→隐藏背景"流程
const puppeteer = require('puppeteer-core');
const path = require('path');

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
    const errors = [];
    page.on('console', msg => {
        if (msg.type() === 'error' || msg.type() === 'warning') {
            errors.push(`[${msg.type()}] ${msg.text()}`);
        }
    });
    page.on('pageerror', err => errors.push('[pageerror] ' + err.message));

    await page.goto('http://localhost:3000/seg-lab/?model=scene.ply', {
        waitUntil: 'networkidle0', timeout: 30000,
    });

    await page.waitForFunction(() => window.scene && window.scene.N > 0, { timeout: 15000 });
    const md5 = async () => {
        return await page.evaluate(async () => {
            const c = document.querySelector('#app');
            const r = new Uint8Array(c.width * c.height * 4);
            const ctx = c.getContext('webgl2');
            const pix = new Uint8Array(c.width * c.height * 4);
            ctx.readPixels(0, 0, c.width, c.height, ctx.RGBA, ctx.UNSIGNED_BYTE, pix);
            // quick md5 via a label: count non-black pixels
            let n = 0, rs = 0, gs = 0, bs = 0;
            for (let i = 0; i < pix.length; i += 4) {
                if (pix[i] | pix[i+1] | pix[i+2]) { n++; rs += pix[i]; gs += pix[i+1]; bs += pix[i+2]; }
            }
            return { n, rs, gs, bs, sum: rs + gs + bs };
        });
    };

    // initial screen
    await new Promise(r => setTimeout(r, 500));
    await page.screenshot({ path: '/tmp/seg-1-initial.png' });
    const sInit = await md5();

    // switch to 框选区域 mode
    await page.evaluate(() => {
        const b = [...document.querySelectorAll('#modeBar button')].find(b => b.textContent.includes('框选'));
        b.click();
    });
    await new Promise(r => setTimeout(r, 200));

    // perform box drag from (800, 400) to (1100, 600)
    await page.mouse.move(800, 400);
    await page.mouse.down();
    await page.mouse.move(950, 500, { steps: 5 });
    await page.mouse.move(1100, 600, { steps: 5 });
    await page.mouse.up();
    await new Promise(r => setTimeout(r, 800));
    await page.screenshot({ path: '/tmp/seg-2-afterbox.png' });
    const sAfter = await md5();
    const stat2 = await page.evaluate(() => document.getElementById('stat').textContent);

    // click 隐藏背景 (should be a no-op since already on)
    await page.click('#btnHideBg');
    await new Promise(r => setTimeout(r, 500));
    await page.screenshot({ path: '/tmp/seg-3-toggle1.png' });
    const sToggle1 = await md5();
    const stat3 = await page.evaluate(() => document.getElementById('stat').textContent);

    // toggle back
    await page.click('#btnHideBg');
    await new Promise(r => setTimeout(r, 500));
    await page.screenshot({ path: '/tmp/seg-4-toggle2.png' });
    const sToggle2 = await md5();
    const stat4 = await page.evaluate(() => document.getElementById('stat').textContent);

    console.log('init pixels', JSON.stringify(sInit));
    console.log('after box:', JSON.stringify(sAfter), '|', stat2);
    console.log('toggle1:  ', JSON.stringify(sToggle1), '|', stat3);
    console.log('toggle2:  ', JSON.stringify(sToggle2), '|', stat4);
    console.log('errors:', errors.length, errors.slice(0, 5));

    await browser.close();
})();
