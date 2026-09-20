// 手柄模式冒烟测试：验证按钮→事件→active 态，以及浏览模式 class 应用/恢复
const puppeteer = require('puppeteer-core');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        headless: 'new',
        args: [
            '--no-sandbox',
            '--ignore-gpu-blocklist',
            '--enable-unsafe-swiftshader',
            '--use-gl=angle',
            '--use-angle=swiftshader',
            '--enable-webgl', '--enable-webgl2',
            '--window-size=1440,900',
            '--hide-scrollbars'
        ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));

    await page.goto('http://localhost:3000/', { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('#right-toolbar-gamepad', { timeout: 30000 });
    await sleep(800); // 等 UI 完全初始化

    const before = await page.$eval('#right-toolbar-gamepad', (el) => el.className);

    // 点击手柄按钮 → 应切换 active（enabled）
    await page.click('#right-toolbar-gamepad');
    await sleep(400);
    const afterOn = await page.$eval('#right-toolbar-gamepad', (el) => el.className);

    // 直接通过事件总线进入浏览模式
    const browseFire = await page.evaluate(() => {
        const cam = window.scene && window.scene.camera;
        if (!cam || !cam.gamepad) return { ok: false, reason: 'no gamepad' };
        cam.gamepad.events.fire('gamepad.setSubMode', 'browse');
        return { ok: true };
    });
    await sleep(400);
    const browseDom = await page.evaluate(() => {
        const cc = document.getElementById('canvas-container');
        const hint = document.getElementById('gamepad-browse-hint');
        return {
            hasBrowseClass: cc ? cc.classList.contains('browse-mode') : false,
            hintDisplay: hint ? getComputedStyle(hint).display : 'missing'
        };
    });

    // 退出浏览模式
    await page.evaluate(() => {
        const cam = window.scene && window.scene.camera;
        cam.gamepad.events.fire('gamepad.setSubMode', 'normal');
    });
    await sleep(300);
    const browseDomOff = await page.evaluate(() => {
        const cc = document.getElementById('canvas-container');
        return cc ? cc.classList.contains('browse-mode') : false;
    });

    // 再次点击按钮 → 关闭手柄模式（active 移除）
    await page.click('#right-toolbar-gamepad');
    await sleep(300);
    const afterOff = await page.$eval('#right-toolbar-gamepad', (el) => el.className);

    console.log(JSON.stringify({
        before, afterOn, afterOff,
        browseFire,
        browseDom,
        browseDomOff,
        errors
    }, null, 2));

    await browser.close();
})().catch((e) => {
    console.error('FATAL', e);
    process.exit(1);
});
