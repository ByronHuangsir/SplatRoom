// Verify drag moves the panel's COMPUTED position (not just inline style)
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        headless: 'new',
        args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-gl=angle',
               '--use-angle=swiftshader', '--enable-webgl', '--window-size=1440,900', '--hide-scrollbars']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto('http://localhost:3000/?load=/test-crop.ply', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => !!window.scene, { timeout: 30000 }).catch(() => {});
    await sleep(400);

    const out = await page.evaluate(async () => {
        const sc = window.scene;
        const res = {};
        sc.events.invoke('show.controlCustomizeDialog');
        await new Promise(r => setTimeout(r, 300));
        const dialogEl = document.querySelector('#control-customize-dialog #dialog');
        const hdr = document.querySelector('#control-customize-dialog #header');

        const rect0 = dialogEl.getBoundingClientRect();
        res.before = { left: Math.round(rect0.left), top: Math.round(rect0.top), w: Math.round(rect0.width), h: Math.round(rect0.height) };

        // drag by +250,+150 from header center
        const startX = rect0.left + 200, startY = rect0.top + 16;
        hdr.dispatchEvent(new PointerEvent('pointerdown', { clientX: startX, clientY: startY, isPrimary: true, pointerId: 9, bubbles: true }));
        hdr.dispatchEvent(new PointerEvent('pointermove', { clientX: startX + 250, clientY: startY + 150, isPrimary: true, pointerId: 9, bubbles: true }));
        hdr.dispatchEvent(new PointerEvent('pointerup', { clientX: startX + 250, clientY: startY + 150, isPrimary: true, pointerId: 9, bubbles: true }));
        await new Promise(r => setTimeout(r, 150));

        const rect1 = dialogEl.getBoundingClientRect();
        res.after = {
            left: Math.round(rect1.left), top: Math.round(rect1.top),
            inlineLeft: dialogEl.style.left, inlineTop: dialogEl.style.top,
            computedLeft: getComputedStyle(dialogEl).left, computedTop: getComputedStyle(dialogEl).top,
            transform: getComputedStyle(dialogEl).transform
        };
        return res;
    });
    console.log(JSON.stringify({ out }, null, 2));
    await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });