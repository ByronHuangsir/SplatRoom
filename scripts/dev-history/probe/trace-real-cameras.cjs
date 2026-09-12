/* Trace cameras fill on the REAL 14M model (the user's actual failing case). */
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
        const app = sc.app;
        const splats = sc.events.invoke('scene.splats');
        const splat = splats[0];
        const inst = splat.entity.gsplat.instance;
        const mi = inst.meshInstance;

        const culler = app.renderer?.culler;
        const origCull = culler?.cullMeshInstances?.bind(culler);
        let pushCount = 0, cullCalls = 0;
        if (origCull) {
            culler.cullMeshInstances = function (camera, drawCalls, out) {
                const before = inst.cameras.length;
                const r = origCull(camera, drawCalls, out);
                const after = inst.cameras.length;
                cullCalls++;
                if (after > before) pushCount++;
                return r;
            };
        }

        const snap = () => ({
            camerasLen: inst.cameras.length,
            instancingCount: mi.instancingCount,
            numSplats: inst.material.getParameter('numSplats')?.value ?? null,
            sorterPending: !!inst.sorter?.pendingSorted,
            sortInFlight: inst.sorter?._sortInFlight,
            hasPendingCamera: !!inst.sorter?._pendingCamera,
            aabbCenter: mi._aabb ? [mi._aabb.center.x, mi._aabb.center.y, mi._aabb.center.z] : null,
            aabbHalf: mi._aabb ? [mi._aabb.halfExtents.x, mi._aabb.halfExtents.y, mi._aabb.halfExtents.z] : null,
            groupActive: sc.groupRenderer?.isActive,
            mergedExists: !!sc.groupRenderer?.mergedEntity
        });

        const before = snap();
        for (let i = 0; i < 8; i++) {
            sc.forceRender = true;
            await new Promise(r => setTimeout(r, 600));
        }
        const after = snap();
        if (origCull) culler.cullMeshInstances = origCull;
        return { before, after, pushCount, cullCalls };
    });

    console.log(JSON.stringify({ trace, errors }, null, 2));
    await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
