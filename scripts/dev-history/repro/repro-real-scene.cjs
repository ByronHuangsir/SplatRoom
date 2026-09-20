// Reproduce "near small / far big" with the USER'S REAL model (668MB, 14M gaussians).
// Load, wait for sort, screenshot, sample sort state over time.
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
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 400)));
    page.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE:' + m.text().slice(0, 300)); });

    console.log('loading model (668MB)...');
    await page.goto('http://localhost:3000/?load=/test-scene.ply', { waitUntil: 'networkidle2', timeout: 180000 });
    await sleep(15000); // big model: give load + first sort time

    const out = await page.evaluate(async () => {
        const sc = window.scene;
        const splat = sc.events.invoke('scene.splats')[0];
        if (!splat) return { error: 'no splat loaded' };
        const inst = splat.entity.gsplat.instance;
        const res = { samples: [] };
        // sample sort state 5x over ~5s while forcing renders
        for (let i = 0; i < 5; i++) {
            sc.forceRender = true;
            await new Promise((r) => setTimeout(r, 1000));
            res.samples.push({
                t: i,
                instancingCount: inst.meshInstance.instancingCount,
                numSplats: inst.material.getParameter('numSplats')?.value,
                camerasLen: inst.cameras?.length ?? -1,
                sortLastCamStr: inst.sorter?.lastCameraPosition ? `${inst.sorter.lastCameraPosition.x.toFixed(2)},${inst.sorter.lastCameraPosition.y.toFixed(2)},${inst.sorter.lastCameraPosition.z.toFixed(2)}` : 'none',
                orderTexExists: !!inst.orderTexture,
                totalSplats: inst.resource.streams.textureDimensions.x * inst.resource.streams.textureDimensions.y
            });
        }
        // camera state
        const cam = sc.camera;
        res.camera = {
            fov: cam.fov,
            distance: cam.distance,
            focalPoint: cam.focalPoint ? [cam.focalPoint.x, cam.focalPoint.y, cam.focalPoint.z] : null,
            azim: cam.azim,
            elev: cam.elevation,
            cameraViewMode: cam.cameraViewMode
        };
        res.bound = sc.bound ? {
            center: sc.bound.center ? [sc.bound.center.x, sc.bound.center.y, sc.bound.center.z] : null,
            halfExtents: sc.bound.halfExtents ? [sc.bound.halfExtents.x, sc.bound.halfExtents.y, sc.bound.halfExtents.z] : null
        } : null;
        return res;
    });

    await page.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/repro-real-1.png' });
    // also try orbit after (camera moved → sort should re-run)
    await page.evaluate(() => { window.scene.camera.setAzimElev(window.scene.camera.azim + 30, window.scene.camera.elevation, 0); window.scene.forceRender = true; });
    await sleep(3000);
    await page.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/repro-real-2.png' });

    console.log(JSON.stringify({ out, errs }, null, 2));
    await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });