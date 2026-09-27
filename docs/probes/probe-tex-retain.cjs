// 探针 76：那 ~1.85GB 的纹理 CPU 缓冲到底还被谁引用着。
//
// 线索链：探针 75 的分配追踪显示，导入期的两笔大头是 `di.lock`（纹理 `lock()`）各 ~1850MB；
// 探针 74 量到 `texture._levels[i].data` 是 **0MB**（表面上看已释放）；而"活着的 7209MB"减去
// 能对账的部分（列 4787 + 附加列 57 + centers 229 + worker 229）还剩 ~1.9GB 对不上。
// ⇒ 所以那 1.8GB 很可能还活着，只是**不在 `_levels[i].data` 这个字段上**。
//
// 做法：把资源/纹理对象**逐属性递归走一遍**（限深度 3），凡是 `byteLength`/`length` 折算后
// ≥1MB 的都登记下来，带属性路径。
//
// usage: node _tmp/probe-tex-retain.cjs [model]
const path = require('path');
const REPO = path.join(__dirname, '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL = process.argv[2] || 'splat_20m.ply';
const mb = (v) => +(v / 1048576).toFixed(1);

(async () => {
    cleanupOrphanBrowsers();
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--js-flags=--expose-gc'],
        protocolTimeout: 1800000
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 620 });
    page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
    await page.goto('http://localhost:3100/?gpu=webgl2', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1500);
    console.log(`导入 ${MODEL} …`);
    await page.evaluate(async (m) => {
        const head = await fetch('./' + m, { headers: { Range: 'bytes=0-0' } });
        const total = parseInt(head.headers.get('content-range').split('/')[1], 10);
        const CHUNK = 256 * 1048576;
        const parts = [];
        for (let off = 0; off < total; off += CHUNK) {
            const end = Math.min(off + CHUNK - 1, total - 1);
            parts.push(await (await fetch('./' + m, { headers: { Range: `bytes=${off}-${end}` } })).blob());
        }
        await window.scene.events.invoke('import', [{ filename: m, contents: new File(parts, m) }]);
    }, MODEL);
    for (let i = 0; i < 400; i++) {
        await sleep(1000);
        if (await page.evaluate(() => (window.scene.elements || []).some((e) => e.entity && e.entity.gsplat)).catch(() => false)) break;
    }
    await sleep(3000);
    await page.evaluate(() => { if (typeof gc === 'function') for (let i = 0; i < 5; i++) gc(); });
    await sleep(1500);

    const out = await page.evaluate(() => {
        const scene = window.scene;
        const el = (scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        const comp = el.entity.gsplat;
        const resource = comp?.instance?.resource ?? comp?.resource ?? comp?._placement?.resource ?? el.asset?.resource;

        const found = [];
        const seen = new WeakSet();
        const sizeOf = (v) => {
            if (!v) return 0;
            if (typeof v.byteLength === 'number' && v.byteLength > 0) return v.byteLength;
            if (typeof v.length === 'number' && v.BYTES_PER_ELEMENT) return v.length * v.BYTES_PER_ELEMENT;
            return 0;
        };
        const walk = (obj, path, depth) => {
            if (!obj || typeof obj !== 'object' || depth > 4) return;
            if (seen.has(obj)) return;
            seen.add(obj);
            // Map/Set 要单独走 —— Object.keys 对它们是空的（第一版就是这样把 7 张流纹理整个跳过了）
            if (obj instanceof Map) {
                let i = 0;
                obj.forEach((v, k) => { walk(v, `${path}<map:${String(k)}>`, depth + 1); i++; });
                return;
            }
            if (obj instanceof Set) {
                let i = 0;
                obj.forEach((v) => { walk(v, `${path}<set:${i++}>`, depth + 1); });
                return;
            }
            let keys = [];
            try { keys = Object.keys(obj); } catch (e) { return; }
            for (const k of keys) {
                let v;
                try { v = obj[k]; } catch (e) { continue; }
                const bytes = sizeOf(v);
                if (bytes >= 1048576) {
                    found.push({ path: `${path}.${k}`, bytes, ctor: v.constructor ? v.constructor.name : '?' });
                } else if (v && typeof v === 'object') {
                    walk(v, `${path}.${k}`, depth + 1);
                }
            }
        };

        walk(resource, 'resource', 0);
        // 也走一遍 entity/instance/node（有些缓冲挂在组件上）
        walk(comp, 'gsplatComponent', 0);

        const byPath = found.sort((a, b) => b.bytes - a.bytes).slice(0, 20);
        const total = found.reduce((a, b) => a + b.bytes, 0);
        return {
            heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
            foundCount: found.length,
            foundTotalBytes: total,
            top: byPath
        };
    });

    console.log(`\n=== 资源/组件上还挂着的 ≥1MB 缓冲 ===`);
    console.log(`  JS 堆 ${out.heapMB}MB；找到 ${out.foundCount} 处、合计 ${mb(out.foundTotalBytes)}MB`);
    for (const f of out.top) console.log(`    ${String(mb(f.bytes)).padStart(8)}MB ${f.ctor.padEnd(14)} ${f.path}`);

    try { await browser.close(); } catch { }
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
