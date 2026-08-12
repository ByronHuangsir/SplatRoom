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
    await sleep(4000);

    const result = await page.evaluate(async () => {
        const sc = window.scene;
        const splat = sc.events.invoke('scene.splats')[0];
        const inst = splat.entity.gsplat.instance;
        const sorter = inst.sorter;

        const before = {
            engineLastPos: sorter.lastCameraPosition ? { x: sorter.lastCameraPosition.x, y: sorter.lastCameraPosition.y, z: sorter.lastCameraPosition.z } : null,
            engineLastDir: sorter.lastCameraDirection ? { x: sorter.lastCameraDirection.x, y: sorter.lastCameraDirection.y, z: sorter.lastCameraDirection.z } : null,
            instancingCount: inst.meshInstance.instancingCount,
            currentAzim: sc.camera.azim
        };

        // Slow rotation: 30 small increments (~1.5° each = 45° total)
        // Typical mouse drag — each frame is < 1e-3 delta to engine's epsilon.
        for (let i = 0; i < 30; i++) {
            sc.camera.setAzimElev(sc.camera.azim + 1.5, sc.camera.elevation, 0);
            sc.camera.onUpdate(0);
            sc.forceRender = true;
            await new Promise(r => requestAnimationFrame(r));
        }
        // wait extra frames for worker to complete
        for (let i = 0; i < 8; i++) {
            sc.forceRender = true;
            await new Promise(r => requestAnimationFrame(r));
        }
        const after = {
            engineLastPos: sorter.lastCameraPosition ? { x: sorter.lastCameraPosition.x, y: sorter.lastCameraPosition.y, z: sorter.lastCameraPosition.z } : null,
            engineLastDir: sorter.lastCameraDirection ? { x: sorter.lastCameraDirection.x, y: sorter.lastCameraDirection.y, z: sorter.lastCameraDirection.z } : null,
            instancingCount: inst.meshInstance.instancingCount,
            currentAzim: sc.camera.azim
        };
        const camZ = sc.camera.mainCamera.getWorldTransform().getZ();
        return { before, after, currentCamDir: { x: camZ.x, y: camZ.y, z: camZ.z } };
    });
    console.log(JSON.stringify({ result, errors }, null, 2));
    await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });