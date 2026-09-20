// 修复验证：1) 球体手柄切换回来后重新挂载（reattach）；2) 渲染菜单子面板已 append。
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
        const fh = window.__faceHandles;
        const res = {};

        // 循环切换 box → sphere → box → sphere，检查 sphere 手柄重新挂载
        cb.shape = 'sphere';
        sc.forceRender = true;
        await new Promise((r) => setTimeout(r, 150));
        res.sphere1 = { count: sh.handles.length, parented: sh.handles[0].parent !== null };

        cb.shape = 'box';
        sc.forceRender = true;
        await new Promise((r) => setTimeout(r, 150));
        res.boxFaceParented = fh.handles[0].parent !== null;   // box 手柄应挂载
        res.boxShapeDetached = sh.handles[0].parent === null;  // shape 手柄应 detach

        cb.shape = 'sphere';
        sc.forceRender = true;
        await new Promise((r) => setTimeout(r, 150));
        res.sphere2 = { count: sh.handles.length, parented: sh.handles[0].parent !== null };  // 应 true（重新挂载）

        // 渲染菜单：统计 menu-panel 子面板数量（image + turntable 子菜单都 append）
        const menuPanels = document.querySelectorAll('.menu-panel').length;
        res.menuPanels = menuPanels;
        return res;
    });

    console.log(JSON.stringify({ out, errors }, null, 2));
    await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
