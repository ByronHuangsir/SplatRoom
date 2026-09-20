// 双半径 + 等比联动 + box 质心固定 冒烟测试
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        headless: 'new',
        args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--enable-webgl2', '--window-size=1440,900', '--hide-scrollbars']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const errors = [];
    const consoleErrors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });

    await page.goto('http://localhost:3000/?load=/test-crop.ply', { waitUntil: 'networkidle2', timeout: 90000 });
    await new Promise((r) => setTimeout(r, 4000));

    const out = await page.evaluate(async () => {
        const sc = window.scene;
        sc.events.fire('tool.crop');
        await new Promise((r) => setTimeout(r, 800));
        const cb = sc.events.invoke('cropBox');
        const sh = window.__shapeHandles;
        const res = {};

        // 手柄胶囊样式 + 数量
        res.handleType = sh.handles[0].render?.type ?? 'none';

        // ---- 双半径独立（非等比）----
        cb.shape = 'cylinder';
        cb.uniformScale = false;
        cb.radiusX = 0.4;
        cb.radiusZ = 0.25;                 // R1 != R2 → 椭圆柱
        res.cylElliptic = [cb.radiusX, cb.radiusZ];

        // ---- 等比联动：R1 变化 → R2 同步 ----
        cb.uniformScale = true;
        cb.radiusX = 0.42;                 // setter 应联动 radiusZ
        res.cylUniform = [cb.radiusX, cb.radiusZ];
        cb.uniformScale = false;

        // ---- 球体双半径（椭球）----
        cb.shape = 'sphere';
        cb.radiusX = 0.38;
        cb.radiusZ = 0.22;
        res.sphereElliptic = [cb.radiusX, cb.radiusZ];

        // ---- box 等比：质心固定 + 三轴跟随 ----
        cb.shape = 'box';
        cb.uniformScale = true;
        cb.extent.set(1.0, 1.0, 1.0);
        cb.center.set(3, 4, 5);
        const e = cb.extent.clone(); e.x = 1.5;    // 模拟拖 X+ 面
        const cBefore = [cb.center.x, cb.center.y, cb.center.z];
        cb.setState(cb.center.clone(), e, cb.rotation.clone());
        res.boxUniform = {
            extent: [cb.extent.x, cb.extent.y, cb.extent.z],
            center: [cb.center.x, cb.center.y, cb.center.z],
            centerUnchanged: cb.center.x === cBefore[0] && cb.center.y === cBefore[1] && cb.center.z === cBefore[2]
        };

        // 渲染多帧（shader 椭圆判定编译）
        for (let i = 0; i < 12; i++) {
            sc.forceRender = true;
            await new Promise((r) => setTimeout(r, 40));
        }
        return res;
    });

    console.log(JSON.stringify({ out, errors, consoleErrors }, null, 2));
    await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
