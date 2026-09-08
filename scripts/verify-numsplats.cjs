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
    await sleep(20000);
    // check after a few forced frames (initial load → sort should land)
    const state = await page.evaluate(async () => {
        const sc = window.scene;
        const splat = sc.events.invoke('scene.splats')[0];
        const inst = splat.entity.gsplat.instance;
        const snap = () => ({
            instancingCount: inst.meshInstance.instancingCount,
            numSplats: inst.material.getParameter('numSplats')?.value ?? null,
            sorterPending: !!inst.sorter?.pendingSorted,
            lastCam: inst.lastCameraPosition ? [inst.lastCameraPosition.x, inst.lastCameraPosition.y, inst.lastCameraPosition.z] : null
        });
        const t0 = snap();
        for (let i = 0; i < 6; i++) { sc.forceRender = true; await new Promise(r => setTimeout(r, 500)); }
        const t1 = snap();
        // check the raw material parameter value via uniforms
        const uniforms = inst.material.uniforms || {};
        return { t0, t1 };
    });
    console.log(JSON.stringify({ state, errors }, null, 2));
    await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
