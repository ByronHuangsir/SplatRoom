// 手柄样式 + 拖拽语义（单轴 vs 等比）冒烟测试：
// 1. shape 手柄是 capsule（type: 'capsule'）
// 2. uniform OFF：拖 cylinder X+ 缘手柄 → 只改 extent.x（x != z 椭圆）
// 3. uniform ON：拖 X+ 缘 → setState enforce → x == z（正圆）
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
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));

    await page.goto('http://localhost:3000/?load=/test-crop.ply', { waitUntil: 'networkidle2', timeout: 90000 });
    await new Promise((r) => setTimeout(r, 4000));

    const out = await page.evaluate(async () => {
        const sc = window.scene;
        sc.events.fire('tool.crop');
        await new Promise((r) => setTimeout(r, 800));
        const cb = sc.events.invoke('cropBox');
        const sh = window.__shapeHandles;
        const res = {};

        cb.shape = 'cylinder';
        cb.uniformScale = false;
        cb.extent.set(1.0, 2.0, 1.0);   // 初始正圆
        cb.radius = 0.35;
        sc.forceRender = true;
        await new Promise((r) => setTimeout(r, 150));

        // 手柄类型
        res.handleType = sh.handles[0].render?.type ?? 'none';
        res.handleCount = sh.handles.length;

        // ===== 等比开启时：被拖动的轴（差异最大）主导，其他跟随 =====
        // box：拖 X+ → 三轴都 = 新 X（其他面跟着往质心调整）
        cb.shape = 'box';
        cb.uniformScale = true;
        cb.extent.set(1.0, 2.0, 0.5);
        let e = cb.extent.clone(); e.x = 1.4;
        cb.setState(cb.center.clone(), e, cb.rotation.clone());
        res.boxX = [cb.extent.x, cb.extent.y, cb.extent.z];
        // box：拖 Y+ → 三轴 = 新 Y
        cb.extent.set(1.0, 2.0, 0.5);
        e = cb.extent.clone(); e.y = 2.6;
        cb.setState(cb.center.clone(), e, cb.rotation.clone());
        res.boxY = [cb.extent.x, cb.extent.y, cb.extent.z];

        // cylinder：拖 X+ 缘 → R1/R2（x/z）同步 = 新 X，高度（y）自由
        cb.shape = 'cylinder';
        cb.uniformScale = true;
        cb.extent.set(1.0, 2.0, 1.0);
        e = cb.extent.clone(); e.x = 1.4;
        cb.setState(cb.center.clone(), e, cb.rotation.clone());
        res.cylX = [cb.extent.x, cb.extent.y, cb.extent.z];
        // cylinder：高度轴变化 → x/z 保持等长（R1=R2），y 自由
        cb.extent.set(1.0, 2.0, 1.0);
        e = cb.extent.clone(); e.y = 2.6;
        cb.setState(cb.center.clone(), e, cb.rotation.clone());
        res.cylY = [cb.extent.x, cb.extent.y, cb.extent.z];

        // sphere：拖 X+ → 三轴 = 新 X（R1/R2 等长同步）
        cb.shape = 'sphere';
        cb.uniformScale = true;
        cb.extent.set(1.0, 2.0, 0.5);
        e = cb.extent.clone(); e.x = 1.4;
        cb.setState(cb.center.clone(), e, cb.rotation.clone());
        res.sphereX = [cb.extent.x, cb.extent.y, cb.extent.z];

        // 等比关闭：各手柄自由（只改被拖轴）
        cb.uniformScale = false;
        cb.shape = 'box';
        cb.extent.set(1.0, 2.0, 0.5);
        e = cb.extent.clone(); e.x = 1.4;
        cb.setState(cb.center.clone(), e, cb.rotation.clone());
        res.boxFree = [cb.extent.x, cb.extent.y, cb.extent.z];

        res.after = { extent: [cb.extent.x, cb.extent.y, cb.extent.z] };
        return res;
    });

    console.log(JSON.stringify({ out, errors }, null, 2));
    await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
