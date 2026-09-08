const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        headless: 'new',
        args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-gl=angle',
               '--use-angle=swiftshader', '--enable-webgl', '--window-size=1440,900', '--hide-scrollbars']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto('http://localhost:3000/?load=/test-crop.ply', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => !!window.scene, { timeout: 30000 }).catch(() => {});
    await sleep(500);
    await page.evaluate(() => { window.scene.events.invoke('show.controlCustomizeDialog'); });
    await sleep(600);
    // verify dialog visible via pcui hidden class
    const diag = await page.evaluate(() => {
        const el = document.querySelector('#control-customize-dialog');
        return {
            hasPcuiHidden: el ? el.classList.contains('pcui-hidden') : 'no-el',
            display: el ? getComputedStyle(el).display : 'no-el',
            w: el ? el.offsetWidth : 0,
            h: el ? el.offsetHeight : 0
        };
    });
    console.log('diag:', JSON.stringify(diag));
    await page.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/cc-dialog-page.png' });
    await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });