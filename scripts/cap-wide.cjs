// Demonstrate cap plane actually rendering: temporarily set capWidth=0.15
// (test-only override of the 0.003 production value) and slice through the
// shell so the cap band has real gaussian splats contributing fragments.
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
    await page.goto('http://localhost:3000/?load=/test-crop.ply', { waitUntil: 'networkidle2', timeout: 90000 });
    await sleep(4000);

    await page.evaluate(async () => {
        const sc = window.scene;
        sc.events.fire('tool.crop');
        await new Promise(r => setTimeout(r, 600));
        const cb = sc.events.invoke('cropBox');
        cb.enabled = true;
        cb.shape = 'sphere';
        cb.uniformScale = true;
        cb.radiusX = 0.5; cb.radiusY = 0.5; cb.radiusZ = 0.5;   // cuts into the shell (shell local r ~0.85~1.0)
        // Also temporarily boost capWidth to 0.15 (test only — production 0.003)
        // by patching the material after splat.ts sets it each frame.
        const origSet = sc.events.invoke('scene.splats')[0].entity.gsplat.instance.material.setParameter.bind(
            sc.events.invoke('scene.splats')[0].entity.gsplat.instance.material
        );
        for (let i = 0; i < 14; i++) {
            sc.forceRender = true;
            await new Promise(r => setTimeout(r, 80));
            // override after splat.ts writes it
            sc.events.invoke('scene.splats').forEach(s => {
                const m = s.entity.gsplat.instance.material;
                m.setParameter('uCropBoxCapWidth', 0.15);
                m.setParameter('uCropBoxCapAlpha', 0.8);
            });
        }
        const c = cb.countSplatsInside(sc.events.invoke('scene.splats'));
        const inst = sc.events.invoke('scene.splats')[0].entity.gsplat.instance;
        console.log('inside=' + c.inside + '/' + c.total + ' capWidth=' + inst.material.getParameter('uCropBoxCapWidth').data);
    });
    await page.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/cap-wide.png' });
    await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });