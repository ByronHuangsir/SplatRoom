/* Critical test: move the camera, verify worker sort re-runs (setCamera fires,
   instancingCount updates). This is the user's exact scenario: camera drag →
   "near small far big" if sort is frozen. */
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
               '--enable-webgl', '--enable-webgl2', '--window-size=800,600', '--disable-gpu-vsync',
               '--js-flags=--max-old-space-size=4096']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600 });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e).slice(0, 200)));

    console.log('loading real model...');
    await page.goto('http://localhost:3000/?load=/test-scene.ply', { waitUntil: 'networkidle2', timeout: 300000 });
    await sleep(25000);

    const trace = await page.evaluate(async () => {
        const sc = window.scene;
        const splat = sc.events.invoke('scene.splats')[0];
        const inst = splat.entity.gsplat.instance;

        let setCameraCalls = 0, applyCounts = 0;
        const origSetCamera = inst.sorter.setCamera.bind(inst.sorter);
        inst.sorter.setCamera = (p, d) => { setCameraCalls++; return origSetCamera(p, d); };
        // hook applyPendingSorted to count applied results
        const origApply = inst.sorter.applyPendingSorted.bind(inst.sorter);
        inst.sorter.applyPendingSorted = () => { const c = origApply(); if (c >= 0) applyCounts++; return c; };

        const snap = (tag) => ({
            tag,
            instancingCount: inst.meshInstance.instancingCount,
            lastCamPos: inst.lastCameraPosition ? [inst.lastCameraPosition.x, inst.lastCameraPosition.y, inst.lastCameraPosition.z] : null,
            sortInFlight: inst.sorter?._sortInFlight,
            hasPendingCam: !!inst.sorter?._pendingCamera
        });

        const before = snap('before-move');

        // Move camera via orbit (setAzimElev)
        sc.camera.setAzimElev(sc.camera.azim + 60, sc.camera.elevation, 0);
        sc.camera.onUpdate(0);
        sc.forceRender = true;
        await new Promise(r => setTimeout(r, 800));
        const mid = snap('after-move');

        // more frames to let worker finish
        for (let i = 0; i < 5; i++) { sc.forceRender = true; await new Promise(r => setTimeout(r, 600)); }
        const after = snap('after-settle');

        // restore
        inst.sorter.setCamera = origSetCamera;
        inst.sorter.applyPendingSorted = origApply;
        return { before, mid, after, setCameraCalls, applyCounts };
    });

    console.log(JSON.stringify({ trace, errors }, null, 2));
    await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
