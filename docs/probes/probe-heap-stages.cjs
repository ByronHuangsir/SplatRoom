// 归档自 _tmp（2026-09-26），REPO 路径已按 docs/probes/ 调整。
// 探针 48：把"导入一个真实大模型"的渲染进程内存**按阶段拆开**。
//
// 起因：探针 47 在真实 6.5M 模型（1.52GB）上量到导入完成后 JS 堆 **3394MB / 上限 4192MB**
// （81%）。而用户真正在用的是 4.62GB（≈20M 高斯）那一档 —— 如果这 3.4GB 真的是模型本身，
// 20M 就必然撞上渲染进程 OOM（= 白屏、无弹窗、永不恢复，正是用户报的现象）。
//
// 但也可能是**探针自己的**分块 fetch（6×256MB Blob）被计进 usedJSHeapSize —— 那样 20M 的
// 复现就是假的。所以在跑 20M 之前先把这 3.4GB 拆开：
//   ① 页面空载基线；② 分块 fetch 拼出 File 之后（还没导入）；③ 导入完成后；
//   ④ 模型列的实际字节数（splatData 里物化了多少）。
// 只有 ③−② 才是"应用导入这个模型"的代价。
//
// usage: node _tmp/probe-heap-stages.cjs [model]
const path = require('path');
const REPO = path.join(__dirname, '..', '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL = process.argv[2] || 'splat_70452.ply';

(async () => {
    cleanupOrphanBrowsers();
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 900000
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 620 });
    page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
    page.on('error', (e) => console.log('[CRASH]', String(e).slice(0, 200)));

    const snap = async (label) => {
        const m = await page.evaluate(() => {
            const m = performance.memory;
            return m ? { usedMB: +(m.usedJSHeapSize / 1048576).toFixed(1), totalMB: +(m.totalJSHeapSize / 1048576).toFixed(1), limitMB: +(m.jsHeapSizeLimit / 1048576).toFixed(1) } : null;
        }).catch(() => null);
        console.log(`  ${label.padEnd(34)} ${m ? `used=${m.usedMB}MB total=${m.totalMB}MB limit=${m.limitMB}MB` : '(无 performance.memory)'}`);
        return m;
    };

    await page.goto('http://localhost:3100/?gpu=webgl2', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(2500);
    const s0 = await snap('① 页面空载');

    const fetched = await page.evaluate(async (m) => {
        const head = await fetch('./' + m, { headers: { Range: 'bytes=0-0' } });
        const total = parseInt(head.headers.get('content-range').split('/')[1], 10);
        const CHUNK = 256 * 1048576;
        const parts = [];
        for (let off = 0; off < total; off += CHUNK) {
            const end = Math.min(off + CHUNK - 1, total - 1);
            parts.push(await (await fetch('./' + m, { headers: { Range: `bytes=${off}-${end}` } })).blob());
        }
        window.__parts = parts;
        window.__file = new File(parts, m);
        return { total, chunks: parts.length, fileSize: window.__file.size };
    }, MODEL);
    const s1 = await snap(`② fetch 拼出 File（${(fetched.total / 1048576).toFixed(0)}MB / ${fetched.chunks} 块）`);

    const t = Date.now();
    await page.evaluate(async () => {
        await window.scene.events.invoke('import', [{ filename: window.__file.name, contents: window.__file }]);
    });
    let ok = false;
    for (let i = 0; i < 300; i++) {
        await sleep(1000);
        ok = await page.evaluate(() => (window.scene.elements || []).some((e) => e.entity && e.entity.gsplat)).catch(() => false);
        if (ok) break;
    }
    const importMs = Date.now() - t;
    const s2 = await snap(`③ 导入完成（${importMs}ms）`);

    const detail = await page.evaluate(() => {
        const el = (window.scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        if (!el) return null;
        const out = { numSplats: el.splatData.numSplats, columns: [], totalMB: 0 };
        try {
            for (const name of ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'opacity', 'scale_0', 'rot_0', 'state']) {
                const d = el.splatData.getProp(name);
                if (d && d.byteLength) {
                    out.columns.push([name, +(d.byteLength / 1048576).toFixed(1)]);
                    out.totalMB += d.byteLength / 1048576;
                }
            }
            out.totalMB = +out.totalMB.toFixed(1);
        } catch (e) { out.error = String(e).slice(0, 120); }
        return out;
    });

    console.log(`\n=== ${MODEL} 内存分阶段 ===`);
    console.log(`  ${fetched.total} 字节 / ${fetched.chunks} 块；导入 ${importMs}ms`);
    console.log(`  ① 空载 ${s0 ? s0.usedMB : '?'}MB → ② fetch 后 ${s1 ? s1.usedMB : '?'}MB → ③ 导入后 ${s2 ? s2.usedMB : '?'}MB`);
    if (s0 && s1 && s2) {
        console.log(`  ⇒ 分块 fetch 的净代价 = ${(s1.usedMB - s0.usedMB).toFixed(1)}MB（文件 ${(fetched.total / 1048576).toFixed(0)}MB）`);
        console.log(`  ⇒ 应用导入的净代价 = ${(s2.usedMB - s1.usedMB).toFixed(1)}MB`);
        console.log(`  ⇒ 导入后占上限 ${((s2.usedMB / s2.limitMB) * 100).toFixed(1)}%`);
    }
    if (detail) {
        console.log(`  模型列：${detail.numSplats} 高斯，抽样的 ${detail.columns.length} 列合计 ${detail.totalMB}MB`);
        console.log(`    ${detail.columns.map(([n, mb]) => `${n}=${mb}MB`).join(' ')}${detail.error ? ' err=' + detail.error : ''}`);
    } else {
        console.log('  模型列：读不到（元素不在）');
    }

    try { await browser.close(); } catch { /* gone */ }
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
