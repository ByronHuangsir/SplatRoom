// Reproduce: main view "near small / far big" after timeline + camera keyframes
// (PiP active). Check whether PiP swap pollutes the main view's sorter/order.
const puppeteer = require('C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        headless: 'new',
        args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
               '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--enable-webgl2',
               '--window-size=1440,900', '--hide-scrollbars']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));

    await page.goto('http://localhost:3000/?load=/test-crop.ply', { waitUntil: 'networkidle2', timeout: 90000 });
    await sleep(5000);

    const out = await page.evaluate(async () => {
        const sc = window.scene;
        const res = {};

        // 1) baseline: main view sort state BEFORE PiP active
        const splat = sc.events.invoke('scene.splats')[0];
        const inst = splat.entity.gsplat.instance;
        res.baseline = {
            sorterCtor: inst.sorter?.constructor?.name,
            orderTexName: inst.orderTexture?.name,
            matOrderName: inst.material.getParameter('splatOrder')?.name,
            instancingCount: inst.meshInstance.instancingCount,
            numSplatsParam: inst.material.getParameter('numSplats')
        };

        // 2) open timeline panel → PiP checks (needs camera track keyframes)
        sc.events.fire('statusBar.panelChanged', 'timeline');
        await new Promise((r) => setTimeout(r, 300));

        // add camera keyframes at frame 0 and 30 (activates hasTrack → PiP enabled)
        const controller = sc.events.invoke('animation.controller');
        const track = controller.getTrack('camera');
        track.addKey(0);
        sc.events.fire('timeline.frame', 0);
        track.addKey(30);
        sc.events.fire('timeline.frame', 30);
        await new Promise((r) => setTimeout(r, 300));

        res.pip = {
            enabled: sc.cameraPreview.enabled,
            hasTrack: sc.cameraPreview.hasTrack
        };

        // 3) let PiP run a few frames
        for (let i = 0; i < 12; i++) {
            sc.forceRender = true;
            await new Promise((r) => setTimeout(r, 120));
        }

        // 4) main view sort state AFTER PiP ran — is it still the main pipeline?
        const inst2 = splat.entity.gsplat.instance;
        res.afterPip = {
            sorterCtor: inst2.sorter?.constructor?.name,
            orderTexName: inst2.orderTexture?.name,
            matOrderName: inst2.material.getParameter('splatOrder')?.name,
            instancingCount: inst2.meshInstance.instancingCount,
            numSplatsParam: inst2.material.getParameter('numSplats'),
            pipSortEntries: sc.cameraPreview._pipSort?.size ?? -1,
            pipUpdateCounter: sc.cameraPreview._pipUpdateCounter
        };

        // 5) play the timeline for ~1s (drives animCamera + PiP), then re-check
        sc.events.fire('timeline.setPlaying', true);
        for (let i = 0; i < 10; i++) {
            await new Promise((r) => setTimeout(r, 100));
        }
        sc.events.fire('timeline.setPlaying', false);
        await new Promise((r) => setTimeout(r, 300));

        const inst3 = splat.entity.gsplat.instance;
        res.afterPlay = {
            sorterCtor: inst3.sorter?.constructor?.name,
            matOrderName: inst3.material.getParameter('splatOrder')?.name,
            instancingCount: inst3.meshInstance.instancingCount,
            numSplatsParam: inst3.material.getParameter('numSplats'),
            cameraViewMode: sc.camera.cameraViewMode
        };

        return res;
    });

    await page.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/repro-pip-main.png' });
    console.log(JSON.stringify({ out, errors }, null, 2));
    await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
