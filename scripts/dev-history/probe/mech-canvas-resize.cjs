/* Directly test the canvasResize path: simulate timeline panel resize by setting
   canvasResize (as ResizeObserver would) and verify render integrity.
   Also test: does opening timeline + resize actually change canvas-container size? */
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

    const result = await page.evaluate(async () => {
        const sc = window.scene;
        const canvas = sc.canvas;
        const gd = sc.app.graphicsDevice;
        const out = {};

        // 1. baseline snapshot
        out.baseline = {
            canvasW: canvas.width, canvasH: canvas.height,
            gdW: gd.width, gdH: gd.height,
            canvasResize: sc.canvasResize
        };

        // 2. manually set canvasResize (simulate ResizeObserver firing with a
        //    slightly different size, as the timeline panel resize would)
        sc.canvasResize = { width: canvas.width, height: canvas.height - 50 };
        sc.forceRender = true;
        await new Promise(r => setTimeout(r, 300));
        out.afterResize = {
            canvasW: canvas.width, canvasH: canvas.height,
            gdW: gd.width, gdH: gd.height,
            canvasResize: sc.canvasResize
        };

        // 3. restore canvasResize to original
        sc.canvasResize = { width: out.baseline.canvasW, height: out.baseline.canvasH };
        sc.forceRender = true;
        await new Promise(r => setTimeout(r, 300));
        out.afterRestore = {
            canvasW: canvas.width, canvasH: canvas.height,
            gdW: gd.width, gdH: gd.height,
            canvasResize: sc.canvasResize
        };

        // 4. What does the ResizeObserver actually observe? Check canvas-container size
        const cc = document.getElementById('canvas-container');
        const tl = document.getElementById('timeline-panel');
        out.container = cc ? {
            cw: cc.clientWidth, ch: cc.clientHeight,
            rectW: cc.getBoundingClientRect().width, rectH: cc.getBoundingClientRect().height
        } : null;
        out.timelinePos = tl ? tl.getBoundingClientRect().toJSON() : null;
        out.hasResizeObserver = !!sc.canvasResize; // just informational
        return out;
    });

    await page.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/resize-mech.png' });
    console.log(JSON.stringify({ result, errors }, null, 2));
    await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
