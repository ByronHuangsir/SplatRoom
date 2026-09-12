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

        // Hook worker.postMessage to count setCamera dispatches
        let setCameraCalls = 0;
        const origPost = sorter.worker.postMessage.bind(sorter.worker);
        sorter.worker.postMessage = (msg, ...rest) => {
            if (msg && (msg.cameraPosition || msg.cameraDirection)) {
                setCameraCalls++;
            }
            return origPost(msg, ...rest);
        };

        // Hook 'updated' event to count sort completions
        let sortCompleted = 0;
        sorter.on('updated', () => sortCompleted++);

        // Slow rotation: 60 small increments (each ~0.75°, total 45°)
        for (let i = 0; i < 60; i++) {
            sc.camera.setAzimElev(sc.camera.azim + 0.75, sc.camera.elevation, 0);
            sc.camera.onUpdate(0);
            sc.forceRender = true;
            await new Promise(r => requestAnimationFrame(r));
        }
        // wait for worker to drain
        for (let i = 0; i < 30; i++) {
            sc.forceRender = true;
            await new Promise(r => setTimeout(r, 100));
        }

        // Restore hooks
        sorter.worker.postMessage = origPost;

        return {
            setCameraCalls,
            sortCompleted,
            finalAzim: sc.camera.azim,
            pendingSorted: !!sorter.pendingSorted,
            sortInFlight: sorter._sortInFlight
        };
    });
    console.log(JSON.stringify({ result, errors }, null, 2));
    await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });