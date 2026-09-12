const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        headless: 'new',
        args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-gl=angle',
               '--use-angle=swiftshader', '--enable-webgl', '--enable-webgl2', '--window-size=1440,900', '--hide-scrollbars']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e).slice(0, 300)));
    await page.goto('http://localhost:3000/?load=/test-crop.ply', { waitUntil: 'networkidle2', timeout: 90000 });
    await sleep(4000);
    const out = await page.evaluate(async () => {
        const sc = window.scene;
        sc.events.fire('tool.crop');
        await new Promise(r => setTimeout(r, 600));
        const cb = sc.events.invoke('cropBox');
        cb.enabled = true; cb.shape = 'sphere'; cb.radiusX = 0.4; cb.radiusY = 0.3; cb.radiusZ = 0.4;
        sc.events.fire('statusBar.panelChanged', 'timeline');
        await new Promise(r => setTimeout(r, 300));
        const track = sc.events.invoke('animation.controller').getTrack('camera');
        track.addKey(0); sc.events.fire('timeline.frame', 0);
        track.addKey(30); sc.events.fire('timeline.frame', 30);
        await new Promise(r => setTimeout(r, 300));
        for (let i = 0; i < 24; i++) { sc.forceRender = true; await new Promise(r => setTimeout(r, 120)); }
        const inst = sc.events.invoke('scene.splats')[0].entity.gsplat.instance;
        const orderUniform = inst.material.getParameter('splatOrder');
        const mainTex = inst.orderTexture;
        let entryMainOrderRestored = 'no-entry';
        if (sc.cameraPreview._pipSort) {
            for (const e of sc.cameraPreview._pipSort.values()) {
                if (e.instance === inst) {
                    entryMainOrderRestored = inst.material.getParameter('splatOrder').data === e.mainOrder;
                }
            }
        }
        return {
            pipEnabled: sc.cameraPreview.enabled,
            uniformType: orderUniform ? orderUniform.constructor.name : 'none',
            uniformDataIsMainTex: orderUniform ? orderUniform.data === mainTex : false,
            pipSortSize: sc.cameraPreview._pipSort ? sc.cameraPreview._pipSort.size : -1,
            entryMainOrderRestored,
            instancingCount: inst.meshInstance.instancingCount,
            cropEnabledParam: inst.material.getParameter('uCropBoxEnabled') ? inst.material.getParameter('uCropBoxEnabled').data : null
        };
    });
    console.log(JSON.stringify({ out, errors }, null, 2));
    await page.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/pip-crop-view.png' });
    await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
