/* Open timeline panel (pcui unhide) + drag resize handle via real mouse events.
   Check if canvas-container / canvas size changes (the 14:41 concern). */
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
               '--enable-webgl', '--enable-webgl2', '--window-size=1440,900', '--disable-gpu-vsync']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e).slice(0, 300)));

    await page.goto('http://localhost:3000/?load=/test-crop.ply', { waitUntil: 'networkidle2', timeout: 90000 });
    await sleep(5000);

    const snap = () => page.evaluate(() => {
        const sc = window.scene;
        const cc = document.getElementById('canvas-container');
        const tl = document.getElementById('timeline-panel');
        return {
            canvasW: sc.canvas.width, canvasH: sc.canvas.height,
            gdW: sc.app.graphicsDevice.width, gdH: sc.app.graphicsDevice.height,
            canvasResize: sc.canvasResize,
            ccRect: cc ? cc.getBoundingClientRect().toJSON() : null,
            tlRect: tl ? tl.getBoundingClientRect().toJSON() : null,
            tlHidden: tl ? tl.classList.contains('pcui-hidden') : 'no-tl'
        };
    });

    // open timeline via status bar event
    await page.evaluate(() => { window.scene.events.fire('statusBar.panelChanged', 'timeline'); });
    await sleep(400);
    const open = await snap();

    // drag resize handle using page.mouse (real events)
    const handleBox = await page.evaluate(() => {
        const tl = document.getElementById('timeline-panel');
        const h = tl?.querySelector('#timeline-panel-resize-handle');
        if (!tl || !h) return null;
        const r = h.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, tlH: tl.offsetHeight };
    });
    let dragResult = null;
    if (handleBox) {
        await page.mouse.move(handleBox.x, handleBox.y);
        await page.mouse.down();
        await page.mouse.move(handleBox.x, handleBox.y - 120, { steps: 5 });
        await sleep(200);
        await page.mouse.up();
        await sleep(400);
        dragResult = await snap();
        dragResult.tlH = await page.evaluate(() => document.getElementById('timeline-panel').offsetHeight);
    }

    await page.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/timeline-open-resize.png' });
    console.log(JSON.stringify({ open, handleBox, dragResult, errors }, null, 2));
    await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
