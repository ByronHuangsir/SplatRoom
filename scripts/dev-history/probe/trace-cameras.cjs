/* Definitively trace: does culler fill instance.cameras during real render?
   Check _isVisible, aabb, and whether sort() gets called per frame. */
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
    page.on('pageerror', e => errors.push(String(e).slice(0, 200)));

    await page.goto('http://localhost:3000/?load=/test-crop.ply', { waitUntil: 'networkidle2', timeout: 90000 });
    await sleep(5000);

    // hook culler.cullMeshInstances to count cameras pushes per frame
    const trace = await page.evaluate(async () => {
        const sc = window.scene;
        const app = sc.app;
        const splat = sc.events.invoke('scene.splats')[0];
        const inst = splat.entity.gsplat.instance;
        const mi = inst.meshInstance;

        // snapshot culler
        const culler = app.renderer?.culler;
        const origCull = culler?.cullMeshInstances?.bind(culler);
        let pushCount = 0, visibleCount = 0;
        if (origCull) {
            culler.cullMeshInstances = function (camera, drawCalls, out) {
                const before = inst.cameras.length;
                const r = origCull(camera, drawCalls, out);
                const after = inst.cameras.length;
                if (after > before) pushCount++;
                visibleCount += drawCalls.filter(d => d.visible).length;
                return r;
            };
        }

        const snap = () => ({
            camerasLen: inst.cameras.length,
            instancingCount: mi.instancingCount,
            numSplats: inst.material.getParameter('numSplats')?.value ?? null,
            aabbCenter: mi._aabb ? [mi._aabb.center.x, mi._aabb.center.y, mi._aabb.center.z] : null,
            aabbHalf: mi._aabb ? [mi._aabb.halfExtents.x, mi._aabb.halfExtents.y, mi._aabb.halfExtents.z] : null,
            meshVisible: mi.visible,
            meshInstanceVisible: mi.visibleThisFrame,
            updateAabb: mi._updateAabb
        });

        const before = snap();
        // run 10 frames
        for (let i = 0; i < 10; i++) {
            sc.forceRender = true;
            await new Promise(r => setTimeout(r, 150));
        }
        const after = snap();
        // restore
        if (origCull) culler.cullMeshInstances = origCull;
        return { before, after, pushCount, visibleCount };
    });

    console.log(JSON.stringify({ trace, errors }, null, 2));
    await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
