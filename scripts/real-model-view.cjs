/* Try rendering the REAL 668MB model headless at low res with long waits.
   Purpose: see if main view has the "near small far big" symptom with the
   restored (no-Prime) splat.ts. */
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
    page.on('console', m => { if (m.type() === 'error') errors.push('C:' + m.text().slice(0, 200)); });

    console.log('loading real model...');
    await page.goto('http://localhost:3000/?load=/test-scene.ply', { waitUntil: 'networkidle2', timeout: 300000 });
    await sleep(20000); // let 668MB model parse + first sort

    // force renders
    await page.evaluate(async () => {
        const sc = window.scene;
        for (let i = 0; i < 8; i++) { sc.forceRender = true; await new Promise(r => setTimeout(r, 1000)); }
    });

    const state = await page.evaluate(() => {
        const sc = window.scene;
        const splat = sc.events.invoke('scene.splats')[0];
        const inst = splat?.entity?.gsplat?.instance;
        if (!inst) return { err: 'no instance' };
        return {
            numSplats: splat.splatData.numSplats,
            instancingCount: inst.meshInstance.instancingCount,
            camerasLen: inst.cameras?.length ?? -1,
            fov: sc.camera.fov,
            fovFactor: sc.camera.fovFactor,
            azim: sc.camera.azim,
            elev: sc.camera.elevation,
            canvasW: sc.canvas.width, canvasH: sc.canvas.height,
            gdW: sc.app.graphicsDevice.width, gdH: sc.app.graphicsDevice.height
        };
    });

    await page.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/real-model-view.png' });
    console.log(JSON.stringify({ state, errors }, null, 2));
    await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
