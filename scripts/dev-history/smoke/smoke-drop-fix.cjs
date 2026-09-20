// 拖拽修复冒烟测试：验证 drop/dragover 在 document 任意位置都被 preventDefault
//（浏览器默认"打开/下载"行为被拦截），且应用无报错。
const puppeteer = require('puppeteer-core');
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
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));

    await page.goto('http://localhost:3000/', { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(1500);

    // 在 document 的多个位置 dispatch dragover + drop，验证都被 preventDefault
    const result = await page.evaluate(() => {
        const targets = [
            { name: 'body', el: document.body },
            { name: 'app-container', el: document.getElementById('app-container') },
            { name: 'canvas', el: document.getElementById('canvas') }
        ];
        const out = [];
        for (const t of targets) {
            if (!t.el) { out.push({ name: t.name, missing: true }); continue; }
            const dt = new DataTransfer();
            const over = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true });
            t.el.dispatchEvent(over);
            const drop = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
            t.el.dispatchEvent(drop);
            out.push({
                name: t.name,
                dragoverPrevented: over.defaultPrevented,
                dropPrevented: drop.defaultPrevented
            });
        }
        return out;
    });

    console.log(JSON.stringify({ dropTargets: result, errors }, null, 2));
    await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
