// Clean A/B: render main view WITHOUT PiP, then WITH PiP active,
// comparing exact object references of sorter / orderTexture / splatOrder param.
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        headless: 'new',
        args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
               '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--enable-webgl2',
               '--window-size=1440,900', '--hide-scrollbars']
    });

    // ===== run A: NO PiP (timeline closed, no camera keyframes) =====
    const pageA = await browser.newPage();
    await pageA.setViewport({ width: 1440, height: 900 });
    const errsA = [];
    pageA.on('pageerror', (e) => errsA.push(String(e).slice(0, 300)));
    await pageA.goto('http://localhost:3000/?load=/test-crop.ply', { waitUntil: 'networkidle2', timeout: 90000 });
    await sleep(6000);
    const outA = await pageA.evaluate(() => {
        const sc = window.scene;
        const splat = sc.events.invoke('scene.splats')[0];
        const inst = splat.entity.gsplat.instance;
        return {
            sorterRef: inst.sorter,
            orderTexRef: inst.orderTexture,
            matOrderVal: inst.material.getParameter('splatOrder')?.value,
            instancingCount: inst.meshInstance.instancingCount,
            numSplatsParam: inst.material.getParameter('numSplats')?.value
        };
    });
    await pageA.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/repro-no-pip.png' });
    await pageA.close();

    // ===== run B: WITH PiP active (timeline open + camera keyframes) =====
    const pageB = await browser.newPage();
    await pageB.setViewport({ width: 1440, height: 900 });
    const errsB = [];
    pageB.on('pageerror', (e) => errsB.push(String(e).slice(0, 300)));
    await pageB.goto('http://localhost:3000/?load=/test-crop.ply', { waitUntil: 'networkidle2', timeout: 90000 });
    await sleep(5000);
    const outB = await pageB.evaluate(async () => {
        const sc = window.scene;
        const splat = sc.events.invoke('scene.splats')[0];
        const inst = splat.entity.gsplat.instance;
        // baseline snapshot BEFORE PiP
        const before = {
            sorterRef: inst.sorter,
            orderTexRef: inst.orderTexture,
            matOrderVal: inst.material.getParameter('splatOrder')?.value
        };
        // activate PiP
        sc.events.fire('statusBar.panelChanged', 'timeline');
        await new Promise((r) => setTimeout(r, 300));
        const ctrl = sc.events.invoke('animation.controller');
        const camTrack = ctrl.getTrack('camera');
        camTrack.addKey(0);
        sc.events.fire('timeline.frame', 0);
        camTrack.addKey(30);
        sc.events.fire('timeline.frame', 30);
        await new Promise((r) => setTimeout(r, 300));
        // let PiP run a few frames
        for (let i = 0; i < 15; i++) {
            sc.forceRender = true;
            await new Promise((r) => setTimeout(r, 120));
        }
        // AFTER PiP snapshot — is main view sorter/orderTexture still the SAME ref?
        const inst2 = splat.entity.gsplat.instance;
        return {
            before,
            after: {
                sorterRef: inst2.sorter,
                orderTexRef: inst2.orderTexture,
                matOrderVal: inst2.material.getParameter('splatOrder')?.value,
                instancingCount: inst2.meshInstance.instancingCount,
                numSplatsParam: inst2.material.getParameter('numSplats')?.value,
                sorterChanged: inst2.sorter !== before.sorterRef,
                orderTexChanged: inst2.orderTexture !== before.orderTexRef,
                matOrderChanged: inst2.material.getParameter('splatOrder')?.value !== before.matOrderVal,
                pipEnabled: sc.cameraPreview.enabled,
                pipEntries: sc.cameraPreview._pipSort?.size ?? -1
            }
        };
    });
    await pageB.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/repro-with-pip.png' });
    await pageB.close();

    console.log('=== NO PiP ===');
    console.log(JSON.stringify({ outA, errsA }, null, 2));
    console.log('=== WITH PiP ===');
    console.log(JSON.stringify({ outB, errsB }, null, 2));
    await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });