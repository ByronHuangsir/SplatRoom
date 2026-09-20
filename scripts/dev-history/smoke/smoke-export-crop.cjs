// 导出裁剪冒烟测试：裁切盒裁剪后导出 PLY，应只含盒内高斯（< 原始 4000），
// 且导出后 state 恢复（盒外高斯不再标记 deleted）。
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
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });

    await page.goto('http://localhost:3000/?load=/test-crop.ply', { waitUntil: 'networkidle2', timeout: 90000 });
    await new Promise((r) => setTimeout(r, 4000));

    const out = await page.evaluate(async () => {
        const sc = window.scene;
        // 原模型高斯数
        const sp0 = sc.events.invoke('scene.splats');
        const total = sp0.length ? sp0[0].splatData.numSplats : 0;

        // 激活 crop + 球体大半径（保留 ~35-50% 高斯，避免全裁空）
        sc.events.fire('tool.crop');
        await new Promise((r) => setTimeout(r, 800));
        const cb = sc.events.invoke('cropBox');
        cb.enabled = true;
        cb.shape = 'sphere';
        cb.uniformScale = false;
        cb.radiusX = 0.48;
        cb.radiusZ = 0.48;
        cb.extent.set(1, 1, 1);
        sc.forceRender = true;
        await new Promise((r) => setTimeout(r, 300));

        // mock writable stream 捕获导出数据
        const chunks = [];
        const mockStream = {
            seek: async () => {},
            write: async (d) => { chunks.push(new Uint8Array(d)); },
            truncate: async () => {},
            close: async () => {},
            abort: async () => {}
        };
        await sc.events.invoke('scene.write', 'ply', {
            filename: 'cropped.ply',
            splatIdx: 'all',
            serializeSettings: {}
        }, mockStream);

        // 合并并解析 PLY header
        const blob = new Blob(chunks);
        const buf = new Uint8Array(await blob.arrayBuffer());
        const headStr = new TextDecoder().decode(buf.slice(0, 4096));
        const m = headStr.match(/element vertex (\d+)/);
        const exported = m ? parseInt(m[1], 10) : -1;

        // 导出后 state 恢复检查
        const sp = sc.events.invoke('scene.splats');
        const state = sp[0].splatData.getProp('state');
        let deleted = 0;
        for (let i = 0; i < state.length; i++) if ((state[i] & 4) !== 0) deleted++;

        return { total, exported, deletedAfterExport: deleted, radius: cb.radiusX };
    });

    console.log(JSON.stringify({ out, errors, consoleErrors }, null, 2));
    await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
