/* Verify main-view sort fallback: after the fix, inst.sort(mainCam) is called
   every frame → sorter.setCamera fires → worker sorts → applyPendingSorted
   updates instancingCount + numSplats. Test on the REAL 14M model. */
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

    // Track sort() calls + setCamera submissions
    const trace = await page.evaluate(async () => {
        const sc = window.scene;
        const splat = sc.events.invoke('scene.splats')[0];
        const inst = splat.entity.gsplat.instance;

        let sortCalls = 0, setCameraCalls = 0, applyCounts = [];
        const origSort = inst.sort.bind(inst);
        inst.sort = (cam) => { sortCalls++; return origSort(cam); };
        const origSetCamera = inst.sorter.setCamera.bind(inst.sorter);
        inst.sorter.setCamera = (p, d) => { setCameraCalls++; return origSetCamera(p, d); };

        const snap = () => ({
            instancingCount: inst.meshInstance.instancingCount,
            numSplats: inst.material.getParameter('numSplats')?.value ?? null,
            sorterPending: !!inst.sorter?.pendingSorted,
            sortInFlight: inst.sorter?._sortInFlight,
            lastCamPos: inst.lastCameraPosition ? [inst.lastCameraPosition.x, inst.lastCameraPosition.y, inst.lastCameraPosition.z] : null
        });

        const before = snap();
        for (let i = 0; i < 6; i++) {
            sc.forceRender = true;
            await new Promise(r => setTimeout(r, 500));
        }
        const after = snap();

        // restore
        inst.sort = origSort;
        inst.sorter.setCamera = origSetCamera;
        return { before, after, sortCalls, setCameraCalls };
    });

    console.log(JSON.stringify({ trace, errors }, null, 2));
    await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
