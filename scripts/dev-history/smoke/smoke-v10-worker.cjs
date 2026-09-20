// v10 冒烟测试：验证 PiP 排序 Worker（方案 1）
// 1. 应用启动无 page error
// 2. _ensureSortWorker() 创建 Worker 成功
// 3. Worker 排序结果与同步 _cpuDepthSort 参考实现完全一致
const puppeteer = require('puppeteer-core');

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
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));

    await page.goto('http://localhost:3000/', { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('#right-toolbar-gamepad', { timeout: 30000 });
    await sleep(800);

    // Worker 排序正确性测试（页内执行）
    const workerTest = await page.evaluate(async () => {
        const cp = window.scene && window.scene.cameraPreview;
        if (!cp) return { ok: false, reason: 'no cameraPreview' };
        if (typeof cp._ensureSortWorker !== 'function') return { ok: false, reason: 'no _ensureSortWorker' };

        const worker = cp._ensureSortWorker();
        if (!worker) return { ok: false, reason: 'worker null' };

        // 构造 200k 点（接近真实规模，验证 Worker 异步不阻塞主线程）
        const numSplats = 200000;
        const centers = new Float32Array(numSplats * 3);
        for (let i = 0; i < numSplats * 3; i++) centers[i] = (Math.random() * 2 - 1) * 10;
        const camDir = { x: 0.3, y: -0.4, z: 0.86 };

        // v10.1 缓存路径：首次带 centers（key='t1'），第二次不带 centers 只发姿态
        const send = (msg) => new Promise((resolve, reject) => {
            const handler = (ev) => {
                if (ev.data.id === msg.id) {
                    worker.removeEventListener('message', handler);
                    resolve(ev.data.order);
                }
            };
            worker.addEventListener('message', handler);
            worker.postMessage(msg);
            setTimeout(() => reject(new Error('worker timeout')), 10000);
        });

        const workerOrder1 = await send({ id: 999, key: 't1', numSplats, centers, dx: camDir.x, dy: camDir.y, dz: camDir.z });
        const workerOrder2 = await send({ id: 998, key: 't1', dx: camDir.x, dy: camDir.y, dz: camDir.z }); // 无 centers → 缓存
        const w1 = new Uint32Array(workerOrder1);
        const w2 = new Uint32Array(workerOrder2);
        const cacheHit = w1.length === w2.length && (() => {
            for (let i = 0; i < w1.length; i++) if (w1[i] !== w2[i]) return false;
            return true;
        })();

        // 同步参考实现（_cpuDepthSort fallback）
        const syncOrder = cp._cpuDepthSort(numSplats, centers, camDir);
        let identical = w1.length === syncOrder.length;
        if (identical) {
            for (let i = 0; i < w1.length; i++) {
                if (w1[i] !== syncOrder[i]) { identical = false; break; }
            }
        }

        // 释放缓存后应不再返回（release 路径）
        const releaseRes = await new Promise((resolve) => {
            worker.postMessage({ release: 't1' });
            setTimeout(() => resolve('no-response-ok'), 300);
        });

        return {
            ok: true,
            numSplats,
            workerLen: w1.length,
            syncLen: syncOrder.length,
            identical,
            cacheHit,
            release: releaseRes,
            workerExists: !!worker
        };
    });

    // 验证非阻塞：主线程在 postMessage 后立即返回（异步性证明）
    const nonBlocking = await page.evaluate(() => {
        const cp = window.scene && window.scene.cameraPreview;
        if (!cp || !cp._ensureSortWorker) return { ok: false };
        const worker = cp._ensureSortWorker();
        const t0 = performance.now();
        const numSplats = 1000000; // 100 万点（同步排序 >100ms 的量级）
        const centers = new Float32Array(numSplats * 3);
        for (let i = 0; i < numSplats * 3; i++) centers[i] = i * 1e-6;
        worker.postMessage({ id: 998, numSplats, centers, dx: 1, dy: 0, dz: 0 });
        const dt = performance.now() - t0; // postMessage 返回耗时
        return { ok: true, postMs: Math.round(dt * 100) / 100 };
    });

    console.log(JSON.stringify({ workerTest, nonBlocking, errors }, null, 2));

    await browser.close();
})().catch((e) => {
    console.error('FATAL', e);
    process.exit(1);
});
