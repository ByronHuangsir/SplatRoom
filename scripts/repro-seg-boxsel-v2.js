// repro-seg-boxsel-v2.js — 完整复现"框选 + 隐藏背景"流程
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
    const errors = [];
    const logs = [];
    page.on('console', msg => {
        const t = msg.text();
        if (msg.type() === 'error') errors.push('[err] ' + t);
        else if (t.includes('[seg-app]')) logs.push(t);
    });
    page.on('pageerror', err => errors.push('[pageerror] ' + err.message));

    await page.goto('http://localhost:3000/seg-lab/?model=scene.ply', {
        waitUntil: 'networkidle0', timeout: 30000,
    });
    await page.waitForFunction(() => document.getElementById('stat') &&
        document.getElementById('stat').textContent.includes('高斯已加载'), { timeout: 15000 });
    await new Promise(r => setTimeout(r, 800));
    await page.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/seg-1-initial.png' });

    // 切到框选模式
    await page.evaluate(() => {
        [...document.querySelectorAll('#modeBar button')]
            .find(b => b.textContent.includes('框选')).click();
    });
    await new Promise(r => setTimeout(r, 200));

    // 框选 (800,400) → (1100,600)
    await page.mouse.move(800, 400);
    await page.mouse.down();
    await page.mouse.move(950, 500, { steps: 5 });
    await page.mouse.move(1100, 600, { steps: 5 });
    await page.mouse.up();
    await new Promise(r => setTimeout(r, 1000));
    await page.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/seg-2-afterbox.png' });
    const stat2 = await page.evaluate(() => document.getElementById('stat').textContent);
    console.log('AFTER BOX:', stat2);

    // 切换隐藏背景 (it's on)
    await page.click('#btnHideBg');
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/seg-3-toggle1.png' });
    const stat3 = await page.evaluate(() => document.getElementById('stat').textContent);
    console.log('TOGGLE 1:', stat3);

    // 再切回去
    await page.click('#btnHideBg');
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/seg-4-toggle2.png' });
    const stat4 = await page.evaluate(() => document.getElementById('stat').textContent);
    console.log('TOGGLE 2:', stat4);

    // 读取像素差异
    const pixelDiff = await page.evaluate(async () => {
        const c = document.querySelector('#app');
        const ctx = c.getContext('webgl2');
        const pix = new Uint8Array(c.width * c.height * 4);
        ctx.readPixels(0, 0, c.width, c.height, ctx.RGBA, ctx.UNSIGNED_BYTE, pix);
        // 找最饱和像素: num "bright" pixels
        let bright = 0;
        let sumR = 0, sumG = 0, sumB = 0;
        for (let i = 0; i < pix.length; i += 4) {
            const r = pix[i], g = pix[i+1], b = pix[i+2];
            // bright = any channel > 100
            if (r > 80 || g > 80 || b > 80) bright++;
            sumR += r; sumG += g; sumB += b;
        }
        return { bright, sumR, sumG, sumB, total: pix.length / 4 };
    });
    console.log('FINAL PIXELS:', JSON.stringify(pixelDiff));
    console.log('LOGS:', logs);
    console.log('ERRORS:', errors);

    await browser.close();
})();
