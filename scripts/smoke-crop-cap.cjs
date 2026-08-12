// 裁切盒切面板（cap plane）冒烟测试：
// 1. 应用 + ?load 模型启动无错误
// 2. 激活 crop 工具并启用 → 渲染多帧 → shader 无编译错误（cap uniforms/逻辑）
// 3. 截图确认画面非空白（cap 面板渲染路径正常）
const puppeteer = require('C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
const path = require('path');
const fs = require('fs');

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
    const consoleErrors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
    page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300));
    });

    await page.goto('http://localhost:3000/?load=/test-crop.ply', {
        waitUntil: 'networkidle2', timeout: 90000
    });
    await sleep(2500); // 等模型加载 + 首次排序

    // 激活 crop 工具并启用（非 preview，真正裁切）
    const cropState = await page.evaluate(async () => {
        const sc = window.scene;
        if (!sc) return { ok: false, reason: 'no scene' };
        sc.events.fire('tool.crop');
        await new Promise((r) => setTimeout(r, 800));
        const cb = sc.events.invoke('cropBox');
        if (!cb) return { ok: false, reason: 'no cropBox after tool.crop' };
        cb.enabled = true;
        cb.preview = false;
        cb.softEdge = 0.005;
        sc.events.fire('cropBox.changed');
        sc.forceRender = true;
        // 强制渲染多帧，触发 shader 编译 + cap 路径
        for (let i = 0; i < 20; i++) {
            sc.forceRender = true;
            await new Promise((r) => setTimeout(r, 50));
        }
        return { ok: true, enabled: cb.enabled, preview: cb.preview };
    });

    // 截图
    const shot = path.join(__dirname, 'crop-cap-shot.png');
    await page.screenshot({ path: shot, type: 'png' });
    const shotSize = fs.statSync(shot).size;

    console.log(JSON.stringify({ cropState, shotSize, errors, consoleErrors }, null, 2));

    await browser.close();
})().catch((e) => {
    console.error('FATAL', e);
    process.exit(1);
});
