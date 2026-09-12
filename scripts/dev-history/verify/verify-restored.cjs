/* Verify restored build: no Prime in splat, engine-driven sort works, resize handle present. */
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

    // force renders so onPreRender / sort run
    await page.evaluate(async () => {
        const sc = window.scene;
        for (let i = 0; i < 12; i++) { sc.forceRender = true; await new Promise(r => setTimeout(r, 200)); }
    });

    const state = await page.evaluate(() => {
        const sc = window.scene;
        const splat = sc.events.invoke('scene.splats')[0];
        const inst = splat.entity.gsplat.instance;
        const hasResize = !!document.querySelector('#timeline-panel-resize-handle');
        const hasAudio = !!document.querySelector('#audio-tracks, .audio-track-row, #audio-tools-bar');
        return {
            instancingCount: inst.meshInstance.instancingCount,
            numSplats: inst.material.getParameter('numSplats')?.value ?? null,
            camerasLen: inst.cameras?.length ?? -1,
            sorterHasCam: !!inst.lastCameraPosition,
            hasResize,
            hasAudio,
            splatCount: sc.events.invoke('scene.splats').length
        };
    });

    // verify resize handle works: open timeline, drag up
    await page.evaluate(() => { window.scene.events.fire('statusBar.panelChanged', 'timeline'); });
    await sleep(300);
    const resizeTest = await page.evaluate(() => {
        const tl = document.querySelector('#timeline-panel');
        if (!tl) return { err: 'no timeline panel' };
        const h = tl.querySelector('#timeline-panel-resize-handle');
        if (!h) return { err: 'no resize handle' };
        const r = h.getBoundingClientRect();
        const before = tl.offsetHeight;
        h.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + 10, clientY: r.top, isPrimary: true, pointerId: 1, bubbles: true }));
        h.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + 10, clientY: r.top - 80, isPrimary: true, pointerId: 1, bubbles: true }));
        h.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + 10, clientY: r.top - 80, isPrimary: true, pointerId: 1, bubbles: true }));
        const after = tl.offsetHeight;
        return { before, after, delta: after - before };
    });

    await page.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/restored-build.png' });
    console.log(JSON.stringify({ state, resizeTest, errors }, null, 2));
    await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
