// Verify the outer finally in CameraPreview.onPostRender restores the main
// view sorter + splatOrder texture even when the PiP render throws mid-phase.
// NOTE: material.getParameter('splatOrder') returns a Uniform object; the
// texture is at `.data` (see material.js getParameter → parameters[name]).
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        headless: 'new',
        args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
               '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--enable-webgl2',
               '--window-size=1440,900', '--hide-scrollbars', '--disable-gpu-vsync']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
    await page.goto('http://localhost:3000/?load=/test-crop.ply', { waitUntil: 'networkidle2', timeout: 90000 });
    await sleep(5000);

    const out = await page.evaluate(async () => {
        const sc = window.scene;
        const splat = sc.events.invoke('scene.splats')[0];
        const inst = splat.entity.gsplat.instance;
        const orderOf = () => inst.material.getParameter('splatOrder')?.data;

        sc.events.fire('statusBar.panelChanged', 'timeline');
        await new Promise((r) => setTimeout(r, 300));
        const ctrl = sc.events.invoke('animation.controller');
        const t = ctrl.getTrack('camera');
        t.addKey(0); sc.events.fire('timeline.frame', 0);
        t.addKey(30); sc.events.fire('timeline.frame', 30);
        await new Promise((r) => setTimeout(r, 300));

        const mainSorter = inst.sorter;
        const mainOrder = inst.orderTexture;
        const cp = sc.cameraPreview;
        const origCapture = cp.captureToCanvas?.bind(cp);

        const run = async (n) => { for (let i = 0; i < n; i++) { sc.forceRender = true; await new Promise((r) => setTimeout(r, 120)); } };

        // 1) normal PiP frames
        await run(10);
        const normal = {
            sorterIsMain: inst.sorter === mainSorter,
            orderIsMain: orderOf() === mainOrder,
            orderName: orderOf()?.name,
            instancingCount: inst.meshInstance.instancingCount
        };

        // 2) inject throw in capture (Phase 5 body) → inner finally + outer finally
        if (origCapture) cp.captureToCanvas = () => { throw new Error('injected-capture-failure'); };
        await run(12);
        const afterCaptureThrow = {
            sorterIsMain: inst.sorter === mainSorter,
            orderIsMain: orderOf() === mainOrder,
            orderName: orderOf()?.name
        };
        if (origCapture) cp.captureToCanvas = origCapture;

        // 3) more frames after restore
        await run(6);
        const afterRestore = {
            sorterIsMain: inst.sorter === mainSorter,
            orderIsMain: orderOf() === mainOrder
        };

        return { normal, afterCaptureThrow, afterRestore, pipEnabled: cp.enabled, pipHasTrack: cp.hasTrack, mainOrderName: mainOrder?.name };
    });

    console.log(JSON.stringify({ out, errs }, null, 2));
    await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });