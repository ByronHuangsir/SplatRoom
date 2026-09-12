// Make cap plane visible: cut a sphere INSIDE the model so half the
// gaussians are inside, half outside — the cross-section band hits cap.
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
    const errs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
    await page.goto('http://localhost:3000/?load=/test-crop.ply', { waitUntil: 'networkidle2', timeout: 90000 });
    await sleep(4000);

    await page.evaluate(async () => {
        const sc = window.scene;
        sc.events.fire('tool.crop');
        await new Promise(r => setTimeout(r, 600));
        const cb = sc.events.invoke('cropBox');
        cb.enabled = true;
        cb.shape = 'sphere';
        cb.radiusX = 0.3; cb.radiusY = 0.3; cb.radiusZ = 0.3;   // cut INSIDE the shell (shell local radius ~0.85~1.0)
        cb.uniformScale = true;
        for (let i = 0; i < 14; i++) { sc.forceRender = true; await new Promise(r => setTimeout(r, 80)); }
        const c = cb.countSplatsInside(sc.events.invoke('scene.splats'));
        const inst = sc.events.invoke('scene.splats')[0].entity.gsplat.instance;
        const capW = inst.material.getParameter('uCropBoxCapWidth').data;
        const capA = inst.material.getParameter('uCropBoxCapAlpha').data;
        return { inside: c.inside, total: c.total, capW, capA };
    }).then(r => console.log('cfg:', JSON.stringify(r)));

    await page.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/cap-cut-inside.png' });
    await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });