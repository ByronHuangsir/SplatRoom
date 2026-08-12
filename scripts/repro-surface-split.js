// Verify Level-1 refine SPLIT logic: flattening the bump must not leave
// see-through / holes. The bump model (sphere + 180 large protruding gaussians)
// used to end up semi-transparent because big gaussians were shrunk, not split.
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = 'http://localhost:3000/';
const OUT_DIR = 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/.workbuddy/debug-shots';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const getSplatInfo = () => `(() => {
    const sc = window.scene;
    if (!sc) return null;
    for (const e of sc.elements) {
        if (e.type === 'splat' && e.splatData) {
            return { numSplats: e.splatData.numSplats };
        }
    }
    return null;
})()`;

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
        await page.goto(BASE + '?load=/test-bump.ply&filename=test-bump.ply', { waitUntil: 'networkidle0', timeout: 60000 });
        let loaded = false;
        for (let i = 0; i < 60; i++) {
            await sleep(500);
            loaded = await page.evaluate(`(() => { const sc = window.scene; if (!sc) return false; for (const e of sc.elements) if (e.type==='splat' && e.splatData) return true; return false; })()`);
            if (loaded) break;
        }
        console.log('loaded:', loaded);
        await sleep(1200);
        console.log('BEFORE numSplats:', JSON.stringify(await page.evaluate(getSplatInfo)));
        await page.screenshot({ path: OUT_DIR + '/split-before.png' });

        // apply level-1 refine (default: strength 0.6, edgeSplit ON, threshold 1.5)
        await page.evaluate(`window.scene.events.fire('surfaceRefine.apply', { strength: 0.6, edgeSplit: true, smoothNormals: true, outlierThreshold: 1.5 })`);
        await sleep(3000);
        console.log('AFTER numSplats:', JSON.stringify(await page.evaluate(getSplatInfo)));
        await page.screenshot({ path: OUT_DIR + '/split-after.png' });

        // aggressive: threshold 1.0, strength 1.0 — more splits
        await page.evaluate(`window.scene.events.fire('surfaceRefine.apply', { strength: 1.0, edgeSplit: true, smoothNormals: true, outlierThreshold: 1.0 })`);
        await sleep(3000);
        console.log('AGGRESSIVE numSplats:', JSON.stringify(await page.evaluate(getSplatInfo)));
        await page.screenshot({ path: OUT_DIR + '/split-after-agg.png' });

        console.log('=== SurfaceRefine console output ===');
        console.log(logs.filter(l => l.includes('SurfaceRefine') || l.includes('PAGEERROR')).join('\n') || '(none)');
    } catch (err) {
        console.log('ERR', err);
    } finally {
        await browser.close();
    }
})();
