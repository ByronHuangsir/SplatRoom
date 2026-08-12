// 裁切盒手柄 + 等比开关冒烟测试：
// 1. cylinder 有 4 个 shape 手柄、sphere 有 2 个
// 2. uniformScale=true：box → extent 三轴相等；cylinder → x==z；sphere → 三轴相等
// 3. 三种形状 × 等比开 → 渲染稳定、shader 零错误
const puppeteer = require('C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
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

    await page.goto('http://localhost:3000/?load=/test-crop.ply', { waitUntil: 'networkidle2', timeout: 90000 });
    await new Promise((r) => setTimeout(r, 4000));

    const render = async () => {
        await page.evaluate(() => {
            const sc = window.scene;
            sc.forceRender = true;
            for (let i = 0; i < 8; i++) {
                sc.forceRender = true;
                return new Promise((r) => setTimeout(r, 40));
            }
        });
        await sleep(250);
    };

    const test = await page.evaluate(async () => {
        const sc = window.scene;
        sc.events.fire('tool.crop');
        await new Promise((r) => setTimeout(r, 800));
        const cb = sc.events.invoke('cropBox');
        const sh = window.__shapeHandles;
        const out = {};

        // cylinder: 4 handles, uniform → x==z
        cb.shape = 'cylinder';
        cb.extent.set(1.2, 2.5, 0.8);   // 故意非等比
        cb.uniformScale = true;
        sc.forceRender = true;
        await new Promise((r) => setTimeout(r, 150));   // 等 prerender 重建手柄
        out.cyl = {
            handleCount: sh.handles.length,
            firstParented: sh.handles[0].parent !== null,
            extent: [cb.extent.x, cb.extent.y, cb.extent.z],
            radius: cb.radius,
            height: cb.height
        };
        cb.uniformScale = false;
        cb.shape = 'sphere';
        cb.extent.set(1.1, 2.0, 0.6);
        cb.uniformScale = true;
        sc.forceRender = true;
        await new Promise((r) => setTimeout(r, 150));
        out.sphere = {
            handleCount: sh.handles.length,
            firstParented: sh.handles[0].parent !== null,
            extent: [cb.extent.x, cb.extent.y, cb.extent.z]
        };
        cb.uniformScale = false;
        cb.shape = 'box';
        cb.extent.set(1.5, 2.2, 0.7);
        cb.uniformScale = true;
        sc.forceRender = true;
        await new Promise((r) => setTimeout(r, 150));
        out.box = {
            handleCount: sh.handles.length,
            firstParented: sh.handles[0].parent !== null,   // box 时应已 detach
            extent: [cb.extent.x, cb.extent.y, cb.extent.z]
        };
        // 渲染多帧（shader 编译 + cap 路径）
        for (let i = 0; i < 12; i++) {
            sc.forceRender = true;
            await new Promise((r) => setTimeout(r, 40));
        }
        return out;
    });

    await render();
    console.log(JSON.stringify({ test, errors, consoleErrors }, null, 2));
    await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
