const puppeteer = require('C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
    const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'], protocolTimeout: 300000 });
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    await page.goto(process.argv[2] || 'http://localhost:3621/?gpu=webgpu', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 90000 });
    await sleep(1500);
    await page.evaluate(async () => {
        const buf = await (await fetch('./test-model.ply')).arrayBuffer();
        await window.scene.events.invoke('import', [{ filename: 'test-model.ply', contents: new File([buf], 'test-model.ply') }]);
    });
    await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 120000 });
    await sleep(2500);
    const read = () => page.evaluate(() => {
        const bar = document.querySelector('#selection-range-bar');
        return { mode: window.scene.events.invoke('camera.mode'), hidden: bar ? bar.classList.contains('pcui-hidden') : null, exists: !!bar };
    });
    const out = {};
    await page.evaluate(() => window.scene.events.fire('tool.rectSelection'));
    await sleep(800);
    out.centers = await read();
    await page.evaluate(() => window.scene.events.fire('camera.setMode', 'rings'));
    await sleep(800);
    out.rings = await read();
    await page.evaluate(() => window.scene.events.fire('camera.setMode', 'centers'));
    await sleep(800);
    out.backToCenters = await read();
    await page.evaluate(() => window.scene.events.fire('tool.deactivate'));
    await sleep(600);
    out.deactivated = await read();
    console.log(JSON.stringify(out));
    const ok = out.centers.hidden === false && out.rings.hidden === true && out.backToCenters.hidden === false && out.deactivated.hidden === true;
    console.log(ok ? 'OK: 环模式隐藏、中心模式显示、退出工具隐藏' : 'MISMATCH');
    await browser.close();
})().catch(e => { console.log('FATAL ' + String(e).slice(0, 300)); process.exit(1); });
