// 时间线/数据面板高度调整验证：上沿 handle 存在 + 拖拽改高度
const puppeteer = require('C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
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

    await page.goto('http://localhost:3000/', { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise((r) => setTimeout(r, 3500));

    const out = await page.evaluate(async () => {
        // 显示 timeline 面板
        window.scene.events.fire('statusBar.panelChanged', 'timeline');
        await new Promise((r) => setTimeout(r, 300));
        const panel = document.querySelector('#timeline-panel');
        const handle = document.querySelector('#timeline-panel-resize-handle');
        const before = panel.offsetHeight;

        // 模拟拖拽 handle（上沿，向下 60px → 高度增加）
        const rect = handle.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dispatch = (type, x, y) => handle.dispatchEvent(new PointerEvent(type, {
            clientX: x, clientY: y, isPrimary: true, pointerId: 1, bubbles: true
        }));
        dispatch('pointerdown', cx, cy);
        dispatch('pointermove', cx, cy + 60);   // 向下拖 60px → height +60
        dispatch('pointerup', cx, cy + 60);
        await new Promise((r) => setTimeout(r, 100));
        const after = panel.offsetHeight;

        // 数据面板 handle 存在性
        window.scene.events.fire('statusBar.panelChanged', 'splatData');
        await new Promise((r) => setTimeout(r, 300));
        const dataHandle = document.querySelector('#data-panel-resize-handle');

        return {
            timelineHandleExists: !!handle,
            before, after, delta: after - before,
            dataHandleExists: !!dataHandle
        };
    });

    console.log(JSON.stringify({ out, errors }, null, 2));
    await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
