// 在 puppeteer 里直接读取 splatColor 纹理,确认 GPU 端的 alpha 是否真的变化
const puppeteer = require('puppeteer-core');

(async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: 'new',
        args: [
            '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
            '--ignore-gpu-blocklist', '--no-sandbox', '--disable-dev-shm-usage',
        ],
        defaultViewport: { width: 1400, height: 900 },
    });
    const page = await browser.newPage();
    const logs = [];
    page.on('console', m => { if (m.type() === 'log' || m.text().includes('[probe]')) logs.push(m.text()); });

    await page.goto('http://localhost:3000/seg-lab/?model=scene.ply', { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForFunction(() => document.getElementById('stat') &&
        document.getElementById('stat').textContent.includes('高斯已加载'), { timeout: 15000 });
    await new Promise(r => setTimeout(r, 1000));

    // 探针: 调用 __segDebug 之类的手工暴露,但因为 seg-app 是 v=5 已清理,我用直接读取 dom 里的对象
    const probe = await page.evaluate(() => {
        // 从 dom 拿不到 → 必须通过 onDataReady 的副作用
        // 直接遍历所有的 pc.WebglTexture 不容易,改成读申请
        // 替代方案: 直接读 pc.Application 实例的内部 gsplat
        // 这里借 window.scene 的存在可能没有,走一遍 window
        // 简单办法: 直接通过 pc.Application 单例
        const allCanvases = [...document.querySelectorAll('canvas')];
        // 反查: window 上是否有 _segDebug
        const keys = Object.keys(window).filter(k => /seg|splat|pc/i.test(k));
        return { keys };
    });
    console.log('window keys:', JSON.stringify(probe));

    // 通过主入口拿 app instance
    await page.evaluate(() => {
        // 暴露一个 debug accessor to data via re-loading
        // 不行就借助 pc._lastCreatedEntity 来 hack
    });

    // 用 Action: 通过在 seg-app.js 同一个 module instance 添加 export —— 不可行,
    // 改为: 改 seg-app.js 加一个临时调试入口,然后再运行

    await browser.close();
})();
