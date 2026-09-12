// Compare cap plane visibility: temporarily set capAlpha=0 vs production 0.08
// to confirm the white-cloud artifact is cap-driven.
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

    // Setup: sphere cutting INTO the shell so cap region is populated
    await page.evaluate(async () => {
        const sc = window.scene;
        sc.events.fire('tool.crop');
        await new Promise(r => setTimeout(r, 600));
        const cb = sc.events.invoke('cropBox');
        cb.enabled = true;
        cb.shape = 'sphere';
        cb.uniformScale = true;
        cb.radiusX = 0.5; cb.radiusY = 0.5; cb.radiusZ = 0.5;
        for (let i = 0; i < 14; i++) { sc.forceRender = true; await new Promise(r => setTimeout(r, 80)); }
    });
    await sleep(400);
    await page.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/cap-after-008.png' });

    // Now temporarily set capAlpha=0 to confirm the artifact is cap-driven
    await page.evaluate(async () => {
        const splats = window.scene.events.invoke('scene.splats');
        for (let i = 0; i < 6; i++) {
            window.scene.forceRender = true;
            await new Promise(r => setTimeout(r, 80));
            splats.forEach(s => {
                const m = s.entity.gsplat.instance.material;
                m.setParameter('uCropBoxCapWidth', 0.003);
                m.setParameter('uCropBoxCapAlpha', 0.0);
            });
        }
    });
    await sleep(200);
    await page.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/cap-after-zero.png' });
    await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });