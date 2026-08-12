// Verify Level-1 surface refine now detects & compresses outliers.
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
    const logs = [];
    page.on('console', (m) => logs.push('[' + m.type() + '] ' + m.text()));
    page.on('pageerror', (e) => logs.push('PAGEERROR: ' + String(e).slice(0, 300)));
    try {
        await page.goto(BASE + '?load=/test.ply&filename=test.ply', { waitUntil: 'networkidle0', timeout: 60000 });
        let loaded = false;
        for (let i = 0; i < 60; i++) {
            await sleep(500);
            loaded = await page.evaluate(`(() => { const sc = window.scene; if (!sc) return false; for (const e of sc.elements) if (e.type==='splat' && e.splatData) return true; return false; })()`);
            if (loaded) break;
        }
        console.log('loaded:', loaded);
        await sleep(1200);
        await page.screenshot({ path: OUT_DIR + '/refine-before.png' });

        // apply level-1 refine with default params (threshold 1.5 via panel default)
        await page.evaluate(`window.scene.events.fire('surfaceRefine.apply', { strength: 0.6, edgeSplit: true, smoothNormals: true, outlierThreshold: 1.5 })`);
        await sleep(3000);
        await page.screenshot({ path: OUT_DIR + '/refine-after.png' });

        // apply with aggressive settings to see how counts scale
        await page.evaluate(`window.scene.events.fire('surfaceRefine.apply', { strength: 1.0, edgeSplit: true, smoothNormals: true, outlierThreshold: 1.0 })`);
        await sleep(3000);
        await page.screenshot({ path: OUT_DIR + '/refine-after-aggressive.png' });

        console.log('=== SurfaceRefine console output ===');
        console.log(logs.join('\n') || '(none)');
    } catch (err) {
        console.log('ERR', err);
    } finally {
        await browser.close();
    }
})();
