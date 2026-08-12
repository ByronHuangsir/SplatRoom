// Quick test: with the shader HARDCODED to render a constant quad at screen center,
// does anything appear at ortho+axis (px) vs ortho+45deg?
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = 'http://localhost:3000/';
const OUT_DIR = 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/.workbuddy/debug-shots';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1440,900']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 200)));
    try {
        await page.goto(BASE + '?load=/test.ply&filename=test.ply', { waitUntil: 'networkidle0', timeout: 60000 });
        let loaded = false;
        for (let i = 0; i < 60; i++) {
            await sleep(500);
            loaded = await page.evaluate(`(() => { const sc = window.scene; if (!sc) return false; for (const e of sc.elements) if (e.type==='splat' && e.splatData) return true; return false; })()`);
            if (loaded) break;
        }
        console.log('loaded:', loaded);
        await sleep(1500);
        await page.screenshot({ path: OUT_DIR + '/hc-default.png' });

        await page.evaluate(`window.scene.events.fire('camera.align', 'px')`);
        await sleep(1000);
        await page.screenshot({ path: OUT_DIR + '/hc-px-ortho.png' });

        await page.evaluate(`(() => { window.scene.camera.setAzimElev(45, 20, 0); window.scene.camera.ortho = true; })()`);
        await sleep(800);
        await page.screenshot({ path: OUT_DIR + '/hc-45-ortho.png' });
        console.log('done');
    } catch (err) {
        console.log('ERR', err);
    } finally {
        await browser.close();
    }
})();
