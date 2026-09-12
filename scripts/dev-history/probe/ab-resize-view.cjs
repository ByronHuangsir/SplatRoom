/* A/B test: does dragging the timeline panel resize handle break the main view?
   Compare canvas size, graphicsDevice size, instancingCount before/after resize. */
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
    await page.evaluate(async () => {
        const sc = window.scene;
        for (let i = 0; i < 10; i++) { sc.forceRender = true; await new Promise(r => setTimeout(r, 200)); }
    });

    const snap = () => page.evaluate(() => {
        const sc = window.scene;
        const splat = sc.events.invoke('scene.splats')[0];
        const inst = splat.entity.gsplat.instance;
        const canvas = sc.canvas;
        const gd = sc.app.graphicsDevice;
        return {
            canvasW: canvas.width, canvasH: canvas.height,
            clientW: canvas.clientWidth, clientH: canvas.clientHeight,
            gdW: gd.width, gdH: gd.height,
            instancingCount: inst.meshInstance.instancingCount,
            sortCam: inst.sorter ? [inst.sorter.lastCameraPosition?.x, inst.sorter.lastCameraPosition?.y, inst.sorter.lastCameraPosition?.z] : null,
            canvasResize: sc.canvasResize
        };
    });

    const before = await snap();

    // Open timeline + drag resize handle up 100px
    await page.evaluate(() => { window.scene.events.fire('statusBar.panelChanged', 'timeline'); });
    await sleep(300);
    const resizeInfo = await page.evaluate(() => {
        const tl = document.querySelector('#timeline-panel');
        const h = tl?.querySelector('#timeline-panel-resize-handle');
        if (!tl || !h) return { err: 'no handle' };
        const r = h.getBoundingClientRect();
        h.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + 10, clientY: r.top, isPrimary: true, pointerId: 1, bubbles: true }));
        h.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + 10, clientY: r.top - 100, isPrimary: true, pointerId: 1, bubbles: true }));
        h.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + 10, clientY: r.top - 100, isPrimary: true, pointerId: 1, bubbles: true }));
        return { h0: tl.offsetHeight, h1: tl.offsetHeight };
    });
    await sleep(400);
    await page.evaluate(async () => {
        const sc = window.scene;
        for (let i = 0; i < 8; i++) { sc.forceRender = true; await new Promise(r => setTimeout(r, 200)); }
    });
    const after = await snap();

    await page.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/resize-ab.png' });
    console.log(JSON.stringify({ before, resizeInfo, after, errors }, null, 2));
    await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
