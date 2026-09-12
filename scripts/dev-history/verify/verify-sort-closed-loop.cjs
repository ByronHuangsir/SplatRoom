const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
               '--enable-webgl', '--enable-webgl2', '--window-size=800,600', '--disable-gpu-vsync']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600 });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
    await page.goto('http://localhost:3000/?load=/test-crop.ply', { waitUntil: 'networkidle2', timeout: 90000 });
    await sleep(5000);
    const trace = await page.evaluate(async () => {
        const sc = window.scene;
        const splat = sc.events.invoke('scene.splats')[0];
        const inst = splat.entity.gsplat.instance;
        let setCameraCalls = 0, applyCounts = 0;
        const origSet = inst.sorter.setCamera.bind(inst.sorter);
        inst.sorter.setCamera = (p, d) => { setCameraCalls++; return origSet(p, d); };
        const origApply = inst.sorter.applyPendingSorted.bind(inst.sorter);
        inst.sorter.applyPendingSorted = () => { const c = origApply(); if (c >= 0) applyCounts++; return c; };
        const snap = () => ({
            instancingCount: inst.meshInstance.instancingCount,
            sortInFlight: inst.sorter?._sortInFlight,
            hasPendingCam: !!inst.sorter?._pendingCamera
        });
        const before = snap();
        // move camera
        sc.camera.setAzimElev(sc.camera.azim + 45, sc.camera.elevation, 0);
        sc.camera.onUpdate(0);
        for (let i = 0; i < 8; i++) { sc.forceRender = true; await new Promise(r => setTimeout(r, 250)); }
        const after = snap();
        inst.sorter.setCamera = origSet;
        inst.sorter.applyPendingSorted = origApply;
        return { before, after, setCameraCalls, applyCounts };
    });
    console.log(JSON.stringify({ trace, errors }, null, 2));
    await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
