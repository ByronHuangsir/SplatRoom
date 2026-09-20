// 裁切盒形状（box/cylinder/sphere）冒烟测试：
// 1. 模型 + crop 工具激活
// 2. 依次切换 cylinder / sphere，改 radius / height → 渲染多帧
// 3. shader 无编译错误、无 page error、截图非空
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        headless: 'new',
        args: [
            '--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
            '--use-gl=angle', '--use-angle=swiftshader',
            '--enable-webgl', '--enable-webgl2', '--window-size=1440,900', '--hide-scrollbars'
        ]
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const errors = [];
    const consoleErrors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });

    await page.goto('http://localhost:3000/?load=/test-crop.ply', {
        waitUntil: 'networkidle2', timeout: 90000
    });
    await page.waitForFunction(() => !!(window.scene && window.scene.events), { timeout: 30000 });
    await sleep(2500);

    const render = async (label) => {
        const r = await page.evaluate(async (label) => {
            const sc = window.scene;
            if (!sc) return { ok: false, reason: 'no scene' };
            sc.forceRender = true;
            for (let i = 0; i < 10; i++) {
                sc.forceRender = true;
                await new Promise((r) => setTimeout(r, 40));
            }
            const cb = sc.events.invoke('cropBox');
            return { ok: !!cb, label };
        }, label);
        await sleep(200);
        return r;
    };

    // 激活 crop 工具
    const activated = await page.evaluate(async () => {
        const sc = window.scene;
        sc.events.fire('tool.crop');
        await new Promise((r) => setTimeout(r, 800));
        const cb = sc.events.invoke('cropBox');
        if (!cb) return { ok: false };
        cb.enabled = true;
        cb.preview = false;
        return { ok: true, shape: cb.shape, radius: cb.radius, height: cb.height };
    });

    // box（基线）
    await render('box');

    // cylinder + 调参
    const cyl = await page.evaluate(async () => {
        const cb = window.scene.events.invoke('cropBox');
        cb.shape = 'cylinder';
        cb.radius = 0.3;
        cb.height = 0.6;
        return { shape: cb.shape, radius: cb.radius, height: cb.height };
    });
    await render('cylinder');
    const cylShot = path.join(__dirname, 'shape-cylinder.png');
    await page.screenshot({ path: cylShot });
    const cylSize = fs.statSync(cylShot).size;

    // sphere + 调参
    const sph = await page.evaluate(async () => {
        const cb = window.scene.events.invoke('cropBox');
        cb.shape = 'sphere';
        cb.radius = 0.42;
        return { shape: cb.shape, radius: cb.radius };
    });
    await render('sphere');
    const sphShot = path.join(__dirname, 'shape-sphere.png');
    await page.screenshot({ path: sphShot });
    const sphSize = fs.statSync(sphShot).size;

    console.log(JSON.stringify({ activated, cyl, sph, cylSize, sphSize, errors, consoleErrors }, null, 2));
    await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
