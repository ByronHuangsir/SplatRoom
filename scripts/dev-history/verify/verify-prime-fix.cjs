// Verify: Prime removed → model renders correctly (no "near small / far big")
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
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
    await page.goto('http://localhost:3000/?load=/test-crop.ply', { waitUntil: 'networkidle2', timeout: 90000 });
    await sleep(8000); // give sort plenty of time
    const state = await page.evaluate(async () => {
        const sc = window.scene;
        const splat = sc.events.invoke('scene.splats')[0];
        const inst = splat.entity.gsplat.instance;
        // force several renders so onPreRender (our sort fallback) actually runs
        for (let i = 0; i < 8; i++) {
            sc.forceRender = true;
            await new Promise((r) => setTimeout(r, 200));
        }
        return {
            instancingCount: inst.meshInstance.instancingCount,
            numSplats: inst.material.getParameter('numSplats')?.value,
            camerasLen: inst.cameras?.length ?? -1,
            sorterHasLastCamera: !!(inst.sorter?.lastCameraPosition?.x !== undefined && inst.sorter?.lastCameraPosition?.x !== 0),
            groupRendererActive: sc.groupRenderer?.isActive ?? false,
            mergedEntityExists: !!sc.groupRenderer?.mergedEntity,
            splatLayers: inst.meshInstance.layers,
            meshInstanceVisible: inst.meshInstance.visible
        };
    });
    await page.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/repro-after-fix.png' });
    console.log(JSON.stringify({ state, errs }, null, 2));
    await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });