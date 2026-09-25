// "大文件 I/O 墙"定位：7 GB 的 PLY 到底卡在哪一层？
//
// 背景：`docs/probes/huge-model-open.cjs` 实测 `1亿gs.ply`（7,540,534,597 B）
// 在 `res.arrayBuffer()` 处抛 `TypeError: Failed to fetch`（12.98 s），而 4.72 GB 的 20M 夹具能正常读入。
// 本探针把三层分开量：
//   ① 服务端：整段流式读完（`res.body.getReader()` 循环，丢弃数据）能不能拿到 7.5 GB；
//   ② 客户端分配：页内直接 `new Float32Array(N)`（真的写一遍，避免 lazy 映射）能到多少 GB；
//   ③ 客户端单块读：`arrayBuffer()` 在 4.0 / 4.5 / 5.0 / 6.0 / 7.0 GB 上的成败（用 Range 请求切大小）。
//
// usage: node docs/probes/huge-io-wall.cjs "<url>" [model] [maxAllocGb]
const path = require('path');
const puppeteer = require(path.join(__dirname, '..', '..', 'node_modules', 'puppeteer-core'));

const { BROWSER_PATH: EDGE } = require('../verify/lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'huge-134m.ply';
const MAX_ALLOC_GB = Number(process.argv[4] || 12);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 0
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600 });
    page.on('pageerror', (e) => console.log('pageerror: ' + String(e).slice(0, 200)));
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1000);

    const out = { url: URL, model: MODEL };

    // ---- ① 纯流式（不进单个 ArrayBuffer）----
    out.stream = await page.evaluate(async (m) => {
        const t0 = performance.now();
        try {
            const res = await fetch('./' + m);
            const total = +(res.headers.get('content-length') || 0);
            const reader = res.body.getReader();
            let got = 0, chunks = 0;
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                got += value.byteLength;
                chunks++;
                if (chunks % 400 === 0) {
                    // 让事件循环喘口气，避免把这当作"读取阻塞"的结论
                    await new Promise((r) => setTimeout(r, 0));
                }
            }
            return { ok: true, total, got, chunks, ms: +(performance.now() - t0).toFixed(0) };
        } catch (e) {
            return { ok: false, error: String(e).slice(0, 300), ms: +(performance.now() - t0).toFixed(0) };
        }
    }, MODEL);
    console.log('=== ① 流式读完（不进单块 ArrayBuffer）===');
    console.log(JSON.stringify(out.stream, null, 1));

    // ---- ② 纯分配上限（Float32Array + 每 4 MB 写一次）----
    out.alloc = await page.evaluate(async (maxGb) => {
        const rows = [];
        const sizes = [2, 3, 3.5, 4, 4.25, 4.5, 5, 5.5, 6, 7, 8, 10, 12].filter(g => g <= maxGb);
        for (const gb of sizes) {
            const bytes = Math.round(gb * 1073741824);
            try {
                const t0 = performance.now();
                const a = new Float32Array(bytes / 4);
                const stride = 1048576; // 每 4 MB 写一次
                for (let i = 0; i < a.length; i += stride) a[i] = i;
                rows.push({ gb, ok: true, first: a[0], lastTouched: a[a.length - (a.length % stride) - stride], ms: +(performance.now() - t0).toFixed(0) });
                // 立刻释放，免得后面的尺寸被前面的占用影响
                if (globalThis.gc) globalThis.gc();
            } catch (e) {
                rows.push({ gb, ok: false, error: String(e).slice(0, 200) });
                break;
            }
            await new Promise((r) => setTimeout(r, 50));
        }
        const mem = performance.memory ? {
            limitMb: +(performance.memory.jsHeapSizeLimit / 1048576).toFixed(0),
            usedMb: +(performance.memory.usedJSHeapSize / 1048576).toFixed(0)
        } : null;
        return { rows, mem };
    }, MAX_ALLOC_GB);
    console.log('=== ② 页内分配上限（Float32Array，真的写一遍）===');
    console.log(JSON.stringify(out.alloc, null, 1));

    // ---- ③ 单块读：用 Range 请求切出不同大小，看 arrayBuffer() 在哪里失败 ----
    out.rangeRead = await page.evaluate(async (m) => {
        const rows = [];
        const sizesGb = [2, 4, 4.5, 5, 6, 7];
        for (const gb of sizesGb) {
            const end = Math.round(gb * 1073741824) - 1;
            try {
                const t0 = performance.now();
                const res = await fetch('./' + m, { headers: { Range: `bytes=0-${end}` } });
                const status = res.status;
                const buf = await res.arrayBuffer();
                rows.push({ gb, ok: true, status, bytes: buf.byteLength, ms: +(performance.now() - t0).toFixed(0) });
            } catch (e) {
                rows.push({ gb, ok: false, error: String(e).slice(0, 200) });
                break;
            }
            await new Promise((r) => setTimeout(r, 100));
        }
        return rows;
    }, MODEL);
    console.log('=== ③ 单块 arrayBuffer() 的墙（Range 请求）===');
    console.log(JSON.stringify(out.rangeRead, null, 1));

    out.memFinal = await page.evaluate(() => (performance.memory ? {
        limitMb: +(performance.memory.jsHeapSizeLimit / 1048576).toFixed(0),
        usedMb: +(performance.memory.usedJSHeapSize / 1048576).toFixed(0),
        totalMb: +(performance.memory.totalJSHeapSize / 1048576).toFixed(0)
    } : null));

    console.log(JSON.stringify(out, null, 1));
    await browser.close().catch(() => { });
    process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ fatal: String(e).slice(0, 600) })); process.exit(1); });
