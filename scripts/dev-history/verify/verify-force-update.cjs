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

        // Hook: detect forceUpdate messages dispatched to worker
        let forceUpdateMsgs = 0, totalMsgs = 0;
        const origPost = sorter.worker.postMessage.bind(sorter.worker);
        sorter.worker.postMessage = (msg, ...rest) => {
            totalMsgs++;
            if (msg && msg.forceUpdate === true) forceUpdateMsgs++;
            return origPost(msg, ...rest);
        };

        let sortCompleted = 0;
        sorter.on('updated', () => sortCompleted++);

        // VERY SLOW rotation: 60 frames at 0.005 rad/frame (~0.3°/frame, total ~17°)
        // Each frame delta is << 1e-3 → worker epsilon would normally short-circuit
        for (let i = 0; i < 60; i++) {
            sc.camera.setAzimElev(sc.camera.azim + 0.3, sc.camera.elevation, 0);
            sc.camera.onUpdate(0);
            sc.forceRender = true;
            await new Promise(r => requestAnimationFrame(r));
        }
        // wait drain
        for (let i = 0; i < 30; i++) { sc.forceRender = true; await new Promise(r => setTimeout(r, 100)); }

        sorter.worker.postMessage = origPost;
        return {
            totalMsgs, forceUpdateMsgs, sortCompleted,
            pendingSorted: !!sorter.pendingSorted,
            sortInFlight: sorter._sortInFlight
        };
    });
    console.log(JSON.stringify({ result, errors }, null, 2));
    await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });