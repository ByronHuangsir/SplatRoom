// Verify cap uniforms actually reach GPU + shader branch is reachable
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

    const out = await page.evaluate(async () => {
        const sc = window.scene;
        sc.events.fire('tool.crop');
        await new Promise(r => setTimeout(r, 600));
        const cb = sc.events.invoke('cropBox');
        cb.enabled = true; cb.shape = 'sphere';
        cb.radiusX = 0.45; cb.radiusY = 0.45; cb.radiusZ = 0.45;   // larger, will enclose some points
        for (let i = 0; i < 12; i++) { sc.forceRender = true; await new Promise(r => setTimeout(r, 80)); }

        const inst = sc.events.invoke('scene.splats')[0].entity.gsplat.instance;
        const mat = inst.material;
        const capW = mat.getParameter('uCropBoxCapWidth');
        const capA = mat.getParameter('uCropBoxCapAlpha');
        const capC = mat.getParameter('uCropBoxCapColor');
        const shape = mat.getParameter('uCropBoxShape');
        const enabled = mat.getParameter('uCropBoxEnabled');
        const rx = mat.getParameter('uCropBoxRadiusX');
        const ry = mat.getParameter('uCropBoxRadiusY');
        const rz = mat.getParameter('uCropBoxRadiusZ');

        return {
            capWidthOnGpu: capW ? capW.data : null,
            capAlphaOnGpu: capA ? capA.data : null,
            capColorOnGpu: capC ? Array.from(capC.data) : null,
            shapeOnGpu: shape ? shape.data : null,
            enabledOnGpu: enabled ? enabled.data : null,
            rxOnGpu: rx ? rx.data : null,
            ryOnGpu: ry ? ry.data : null,
            rzOnGpu: rz ? rz.data : null,
            count: cb.countSplatsInside(sc.events.invoke('scene.splats'))
        };
    });
    console.log(JSON.stringify({ out, errs }, null, 2));
    await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });