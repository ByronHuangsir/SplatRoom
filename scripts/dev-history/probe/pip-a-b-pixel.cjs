// A/B: 4k model. Compare MAIN VIEW pixels BEFORE vs AFTER PiP activation.
// Hooks the culler to record whether instance.cameras gets populated during
// an actual render frame (which triggers the engine's update() → sort()).
const puppeteer = require('C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
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
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
    await page.goto('http://localhost:3000/?load=/test-crop.ply', { waitUntil: 'networkidle2', timeout: 90000 });
    await sleep(6000);

    const analyze = () => page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        const w = Math.min(320, canvas.width), h = Math.min(180, canvas.height);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        ctx.drawImage(canvas, 0, 0, w, h);
        const d = ctx.getImageData(0, 0, w, h).data;
        let sum = 0, sum2 = 0, n = w * h, sat = 0;
        for (let i = 0; i < n; i++) {
            const r = d[i*4], g = d[i*4+1], b = d[i*4+2];
            const l = (r+g+b)/3; sum += l; sum2 += l*l;
            const mx = Math.max(r,g,b), mn = Math.min(r,g,b);
            sat += mx === 0 ? 0 : (mx-mn)/mx;
        }
        const mean = sum/n;
        return { mean: mean.toFixed(1), std: Math.sqrt(sum2/n - mean*mean).toFixed(1), sat: (sat/n).toFixed(3) };
    });

    // Baseline pixel stats
    const base = await analyze();
    // Hook culler: log cameras during an actual render
    const hook = await page.evaluate(() => {
        const sc = window.scene;
        const splat = sc.events.invoke('scene.splats')[0];
        const inst = splat.entity.gsplat.instance;
        const origCull = sc.app.renderer.culler.cullMeshInstances?.bind(sc.app.renderer.culler);
        const log = [];
        if (origCull) {
            sc.app.renderer.culler.cullMeshInstances = (...args) => {
                const before = inst.cameras?.length ?? -1;
                origCull(...args);
                log.push({ before, after: inst.cameras?.length ?? -1 });
                return args[args.length - 1];
            };
        }
        return { hooked: !!origCull };
    });
    // force a few renders to see cull logs
    await page.evaluate(async () => { const sc = window.scene; for (let i=0;i<5;i++){ sc.forceRender=true; await new Promise(r=>setTimeout(r,300)); } });
    const cullLog = await page.evaluate(() => {
        const sc = window.scene;
        const splat = sc.events.invoke('scene.splats')[0];
        const inst = splat.entity.gsplat.instance;
        return {
            log: window.__cullLog || null,
            instancingCount: inst.meshInstance.instancingCount,
            numSplats: inst.material.getParameter('numSplats')?.value,
            camerasNow: inst.cameras?.length ?? -1,
            sorterCtor: inst.sorter?.constructor?.name
        };
    });

    console.log('BASELINE', JSON.stringify({ base, hook, cullLog }, null, 2));
    await page.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/ab-base.png' });

    // ---- Activate PiP ----
    await page.evaluate(async () => {
        const sc = window.scene;
        sc.events.fire('statusBar.panelChanged', 'timeline');
        await new Promise((r) => setTimeout(r, 300));
        const ctrl = sc.events.invoke('animation.controller');
        const t = ctrl.getTrack('camera');
        t.addKey(0); sc.events.fire('timeline.frame', 0);
        t.addKey(30); sc.events.fire('timeline.frame', 30);
        await new Promise((r) => setTimeout(r, 300));
        for (let i = 0; i < 8; i++) { sc.forceRender = true; await new Promise((r) => setTimeout(r, 200)); }
    });
    const pip = await analyze();
    const pipState = await page.evaluate(() => {
        const sc = window.scene;
        const splat = sc.events.invoke('scene.splats')[0];
        const inst = splat.entity.gsplat.instance;
        return {
            pipEnabled: sc.cameraPreview.enabled,
            pipHasTrack: sc.cameraPreview.hasTrack,
            instancingCount: inst.meshInstance.instancingCount,
            numSplats: inst.material.getParameter('numSplats')?.value,
            matOrderIsPip: inst.material.getParameter('splatOrder') === sc.cameraPreview._pipSort?.get(sc.cameraPreview._mergedKey)?.pipOrder || false,
            sorterCtor: inst.sorter?.constructor?.name,
            pipEntries: sc.cameraPreview._pipSort?.size ?? -1
        };
    });
    console.log('AFTER-PIP', JSON.stringify({ pip, pipState }, null, 2));
    await page.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/ab-pip.png' });
    console.log(JSON.stringify({ errs }));
    await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });