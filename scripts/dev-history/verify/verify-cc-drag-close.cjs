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
    const errs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 250)));
    await page.goto('http://localhost:3000/?load=/test-crop.ply', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => !!window.scene, { timeout: 30000 }).catch(() => {});
    await sleep(400);

    const out = await page.evaluate(async () => {
        const sc = window.scene;
        const res = {};
        // show
        sc.events.invoke('show.controlCustomizeDialog');
        await new Promise(r => setTimeout(r, 300));
        const dlg = document.querySelector('#control-customize-dialog');
        const dialogEl = document.querySelector('#control-customize-dialog #dialog');
        res.afterShow = {
            hiddenClass: dlg.classList.contains('pcui-hidden'),
            display: getComputedStyle(dlg).display,
            dialogLeft: dialogEl.style.left, dialogTop: dialogEl.style.top, dialogTransform: dialogEl.style.transform
        };

        // drag header by (300, 200)
        const hdr = document.querySelector('#control-customize-dialog #header');
        const r = dialogEl.getBoundingClientRect();
        hdr.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + 100, clientY: r.top + 16, isPrimary: true, pointerId: 7, bubbles: true }));
        hdr.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + 100 + 300, clientY: r.top + 16 + 200, isPrimary: true, pointerId: 7, bubbles: true }));
        hdr.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + 100 + 300, clientY: r.top + 16 + 200, isPrimary: true, pointerId: 7, bubbles: true }));
        await new Promise(r => setTimeout(r, 100));
        res.afterDrag = {
            left: dialogEl.style.left,
            top: dialogEl.style.top,
            transform: dialogEl.style.transform
        };

        // click close button → should hide
        const closeBtn = document.querySelector('#control-customize-dialog .close-button');
        closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise(r => setTimeout(r, 200));
        res.afterClose = {
            hiddenClass: dlg.classList.contains('pcui-hidden'),
            display: getComputedStyle(dlg).display
        };

        // reopen still works
        sc.events.invoke('show.controlCustomizeDialog');
        await new Promise(r => setTimeout(r, 200));
        res.afterReopen = {
            hiddenClass: dlg.classList.contains('pcui-hidden'),
            display: getComputedStyle(dlg).display
        };
        return res;
    });
    console.log(JSON.stringify({ out, errs }, null, 2));
    await page.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/cc-drag-close.png' });
    await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });