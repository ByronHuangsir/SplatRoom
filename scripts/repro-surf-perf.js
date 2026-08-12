// Performance test: Level-1 surface refine on a 100k-gaussian model.
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = 'http://localhost:3000/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1200,800']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    const logs = [];
    page.on('console', (m) => { const t = m.text(); if (t.includes('SurfaceRefine')) logs.push(t); });
    page.on('pageerror', (e) => logs.push('PAGEERROR: ' + String(e).slice(0, 300)));
    const t0 = Date.now();
    try {
        await page.goto(BASE + '?load=/test-big.ply&filename=test-big.ply', { waitUntil: 'networkidle0', timeout: 120000 });
        let loaded = false;
        for (let i = 0; i < 120; i++) {
            await sleep(500);
            loaded = await page.evaluate(`(() => { const sc = window.scene; if (!sc) return false; for (const e of sc.elements) if (e.type==='splat' && e.splatData) return true; return false; })()`);
            if (loaded) break;
        }
        console.log('loaded:', loaded, 'after', ((Date.now() - t0) / 1000).toFixed(1) + 's');

        // measure apply time from inside the page
        const t1 = Date.now();
        await page.evaluate(`window.scene.events.fire('surfaceRefine.apply', { strength: 0.6, edgeSplit: true, smoothNormals: true, outlierThreshold: 1.5 })`);
        // wait for the async op to finish (spinner stops) by polling a flag we set via console
        let finished = false;
        for (let i = 0; i < 120; i++) {
            await sleep(500);
            if (logs.some(l => l.includes('modified ') || l.includes('result:'))) { finished = true; break; }
            if (Date.now() - t1 > 90000) break; // 90s hard cap
        }
        console.log('apply finished:', finished, 'after', ((Date.now() - t1) / 1000).toFixed(1) + 's');
        console.log('=== logs ===');
        console.log(logs.join('\n') || '(none)');
    } catch (err) {
        console.log('ERR', String(err).slice(0, 200));
        console.log('elapsed', ((Date.now() - t0) / 1000).toFixed(1) + 's');
    } finally {
        await browser.close();
    }
})();
