// Real mouse-click path test: project the red object center to screen coords,
// click there, and check whether segmentation runs.
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
    page.on('pageerror', (e) => logs.push('PAGEERROR: ' + String(e).slice(0, 400)));
    try {
        await page.goto('http://localhost:3000/seg-lab/?model=scene.ply', { waitUntil: 'networkidle0', timeout: 60000 });
        await sleep(3500);

        // project the red object center to screen coords
        const sc = await page.evaluate(`(() => {
            const screenPos = new pc.Vec3();
            cameraEntity.camera.worldToScreen(new pc.Vec3(1.35, 0.25, 1.15), screenPos);
            return { x: screenPos.x, y: screenPos.y };
        })()`);
        console.log('screen pos of red object:', JSON.stringify(sc));

        // real click
        await page.mouse.click(Math.round(sc.x), Math.round(sc.y));
        await sleep(1500);
        const st = await page.evaluate(`document.getElementById('stat').textContent`);
        console.log('stat after real click:', st);
        await page.screenshot({ path: OUT_DIR + '/seg-realclick.png' });

        console.log('=== console (tail) ===');
        console.log(logs.slice(-12).join('\n'));
    } catch (err) {
        console.log('ERR', err);
    } finally {
        await browser.close();
    }
})();