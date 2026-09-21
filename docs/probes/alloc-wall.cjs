// 干净的"单块 ArrayBuffer 上限"口径（不做任何 I/O，避免被 GC/网络干扰）。
//
// 起因：`1亿gs.ply`（7.54 GB）在 `res.arrayBuffer()` 处报 `TypeError: Failed to fetch`，
// 而 4.72 GB 的 20M 夹具能读进来。要修就得知道墙在哪：是"单块 ArrayBuffer 有硬上限"，
// 还是"读文件路径本身有上限"。本探针只做分配：`new ArrayBuffer(n)` + 真的写一遍每个 4 MB。
//
// usage: node docs/probes/alloc-wall.cjs "<url>" [maxGb]
const path = require('path');
const puppeteer = require(path.join(__dirname, '..', '..', 'node_modules', 'puppeteer-core'));

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MAX_GB = Number(process.argv[3] || 16);

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--js-flags=--expose-gc'],
        protocolTimeout: 0
    });
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('pageerror: ' + String(e).slice(0, 200)));
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });

    const out = await page.evaluate(async (maxGb) => {
        const rows = [];
        const gcs = [];
        const ladder = [0.25, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8, 10, 12, 14, 16].filter(g => g <= maxGb);
        for (const gb of ladder) {
            const bytes = Math.round(gb * 1073741824);
            let row = { gb, bytes };
            try {
                const t0 = performance.now();
                const a = new ArrayBuffer(bytes);
                const u8 = new Uint8Array(a);
                for (let i = 0; i < u8.length; i += 4194304) u8[i] = 1;   // 每 4 MB 真的写一次
                row = { ...row, ok: true, ms: +(performance.now() - t0).toFixed(0) };
                // 释放并确认真的回收了
                if (globalThis.gc) { globalThis.gc(); }
                row.afterGc = performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(0) : null;
            } catch (e) {
                row = { ...row, ok: false, error: String(e).slice(0, 160) };
                rows.push(row);
                break;   // 到这里就停：更大的尺寸没有意义
            }
            rows.push(row);
            await new Promise((r) => setTimeout(r, 50));
        }
        const mem = performance.memory ? {
            limitMb: +(performance.memory.jsHeapSizeLimit / 1048576).toFixed(0),
            usedMb: +(performance.memory.usedJSHeapSize / 1048576).toFixed(0)
        } : null;
        // 顺带量一下 Blob/File 路径：`new Blob([...])` 与 `File.arrayBuffer()` 的可用上限
        let blobTest = null;
        try {
            const maxOk = rows.filter(r => r.ok).map(r => r.gb).pop() ?? 0;
            if (maxOk > 0) {
                const gb = Math.min(maxOk, 4);
                const buf = new Uint8Array(Math.round(gb * 1073741824));
                const blob = new Blob([buf]);
                const back = await blob.arrayBuffer();
                blobTest = { gb, ok: back.byteLength === buf.byteLength };
                buf.length = 0;  // 释放
            }
        } catch (e) {
            blobTest = { ok: false, error: String(e).slice(0, 160) };
        }
        return { rows, mem, blobTest, ua: navigator.userAgent };
    }, MAX_GB);

    console.log(JSON.stringify(out, null, 1));
    await browser.close().catch(() => { });
    process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ fatal: String(e).slice(0, 400) })); process.exit(1); });
