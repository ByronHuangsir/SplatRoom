// Verify multi-object segmentation: seed on the red object center → only it
// is selected (~400), the sphere + other objects fade out.
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT_DIR = 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/.workbuddy/debug-shots';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1440,900']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    try {
        await page.goto('http://localhost:3000/seg-lab/?model=scene.ply', { waitUntil: 'networkidle0', timeout: 60000 });
        await sleep(3500);
        await page.screenshot({ path: OUT_DIR + '/segscene-loaded.png' });

        // seed on the red object (1.35, 0.25, 1.15) via global helpers
        const r1 = await page.evaluate(`(() => {
            seeds.clear();
            let bi = -1, bd = Infinity;
            for (let i = 0; i < N; i++) {
                const d = (px[i]-1.35)**2 + (py[i]-0.25)**2 + (pz[i]-1.15)**2;
                if (d < bd) { bd = d; bi = i; }
            }
            seeds.add(bi);
            runSegmentation();
            let c = 0; for (let i = 0; i < N; i++) c += mask[i];
            return { seed: bi, selected: c, stat: document.getElementById('stat').textContent };
        })()`);
        console.log('red object:', JSON.stringify(r1));
        await sleep(800);
        await page.screenshot({ path: OUT_DIR + '/segscene-red-selected.png' });

        // now seed on the blue object (-1.30, -0.15, 1.05)
        const r2 = await page.evaluate(`(() => {
            seeds.clear();
            let bi = -1, bd = Infinity;
            for (let i = 0; i < N; i++) {
                const d = (px[i]+1.30)**2 + (py[i]+0.15)**2 + (pz[i]-1.05)**2;
                if (d < bd) { bd = d; bi = i; }
            }
            seeds.add(bi);
            runSegmentation();
            let c = 0; for (let i = 0; i < N; i++) c += mask[i];
            return { seed: bi, selected: c };
        })()`);
        console.log('blue object:', JSON.stringify(r2));
        await sleep(800);
        await page.screenshot({ path: OUT_DIR + '/segscene-blue-selected.png' });

        // reset → everything back
        await page.evaluate(`resetAll()`);
        await sleep(600);
        await page.screenshot({ path: OUT_DIR + '/segscene-reset.png' });
    } catch (err) {
        console.log('ERR', err);
    } finally {
        await browser.close();
    }
})();