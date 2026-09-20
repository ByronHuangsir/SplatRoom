// Diagnose: is the sorter's applyPendingSorted ever returning a real count?
// Sample instancingCount / numSplats / cameras[] over 10 seconds at startup.
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
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
    await page.goto('http://localhost:3000/?load=/test-crop.ply', { waitUntil: 'networkidle2', timeout: 90000 });

    const samples = await page.evaluate(async () => {
        const sc = window.scene;
        const splat = sc.events.invoke('scene.splats')[0];
        const inst = splat.entity.gsplat.instance;
        const out = [];
        // sample every ~500ms for 10s
        for (let i = 0; i < 20; i++) {
            sc.forceRender = true;
            await new Promise((r) => setTimeout(r, 500));
            const sorter = inst.sorter;
            out.push({
                t: i * 500,
                sortPending: !!sorter?.uploadStream?.busy,
                sorterCtor: sorter?.constructor?.name,
                camerasLen: inst.cameras?.length ?? -1,
                instancingCount: inst.meshInstance.instancingCount,
                numSplats: inst.material.getParameter('numSplats')?.value,
                sortCamera: sorter?.lastCameraPosition?.toString?.() ?? 'none',
                totalSplats: inst.resource.streams.textureDimensions.x * inst.resource.streams.textureDimensions.y
            });
        }
        return out;
    });

    console.log(JSON.stringify({ samples, errs }, null, 2));
    await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });