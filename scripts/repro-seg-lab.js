// Verify seg-lab loads, renders the model, and picks a gaussian.
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
    const logs = [];
    page.on('console', (m) => logs.push('[' + m.type() + '] ' + m.text()));
    page.on('pageerror', (e) => logs.push('PAGEERROR: ' + String(e).slice(0, 300)));
    try {
        await page.goto('http://localhost:3000/seg-lab/?model=test.ply', { waitUntil: 'networkidle0', timeout: 60000 });
        await sleep(3000);
        const st = await page.evaluate(`(() => {
            const statEl = document.getElementById('stat');
            const canvas = document.getElementById('app');
            return {
                stat: statEl ? statEl.textContent : null,
                hasCanvas: !!canvas,
                canvasW: canvas ? canvas.width : 0,
                canvasH: canvas ? canvas.height : 0,
                globalKeys: typeof pc !== 'undefined' ? 'pc ok' : 'pc MISSING'
            };
        })()`);
        console.log('state:', JSON.stringify(st, null, 1));
        await page.screenshot({ path: OUT_DIR + '/seglab-init.png' });
        console.log('=== console ===');
        console.log(logs.join('\n').slice(0, 800) || '(none)');
    } catch (err) {
        console.log('ERR', err);
    } finally {
        await browser.close();
    }
})();
