// Verify seg-lab interactions: click center → seed → segmentation → highlight.
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
        await page.goto('http://localhost:3000/seg-lab/?model=test.ply', { waitUntil: 'networkidle0', timeout: 60000 });
        await sleep(3000);
        await page.screenshot({ path: OUT_DIR + '/seglab-loaded.png' });

        // click in the canvas center where the model renders
        const w = 1440, h = 900;
        const cx = Math.round(w * 0.62), cy = Math.round(h * 0.5);
        await page.mouse.click(cx, cy);
        await sleep(1500);
        const stat1 = await page.evaluate(`(() => {
            const s = document.getElementById('stat').textContent;
            // also check if anything was selected — try to find a global hook
            return s;
        })()`);
        console.log('after click:', stat1);
        await page.screenshot({ path: OUT_DIR + '/seglab-after-click.png' });

        // click "highlight"
        await page.click('#btnHighlight');
        await sleep(800);
        await page.screenshot({ path: OUT_DIR + '/seglab-highlight.png' });

        // click "hide background"
        await page.click('#btnHideBg');
        await sleep(800);
        await page.screenshot({ path: OUT_DIR + '/seglab-hidebg.png' });
    } catch (err) {
        console.log('ERR', err);
    } finally {
        await browser.close();
    }
})();