// 探针 75：那 2365MB"未解释"的常驻内存到底是什么 —— 直接给出**分配点**。
//
// 探针 74 已经把能对账的部分量清了：① 数据表 64 列 4787MB（其中 SH 高阶 3433MB）、
// ② 应用附加列 57MB、③ 引擎纹理显存 1831MB 但 **CPU 侧一份都没留**（0MB，猜错了）。
// 剩下的 2365MB 且强制 GC 也不降（是**活的**）。
//
// 做法：在页面脚本之前把几个 typed array 构造器包一层，只登记**单次 ≥16MB** 的分配
// （带 5 层调用栈），导入完成后按"仍未被释放"的最大几笔 + 按调用点聚合列出。
// 说明：这里量的是"分配过多少"，不是"此刻还剩多少" —— 所以要配合"GC 后堆没降"这个事实一起看：
// 分配点集中在哪里，那里就是嫌疑。
//
// usage: node _tmp/probe-alloc-trace.cjs [model]
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
    page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 200)); });

    // 在页面脚本之前装好分配登记器
    await page.evaluateOnNewDocument(() => {
        const BIG = 16 * 1048576;
        window.__bigAllocs = [];
        for (const name of ['Float32Array', 'Uint32Array', 'Uint16Array', 'Uint8Array', 'Int32Array', 'ArrayBuffer']) {
            const Orig = window[name];
            if (typeof Orig !== 'function') continue;
            const bpe = Orig.BYTES_PER_ELEMENT || 1;
            const Wrapped = new Proxy(Orig, {
                construct(target, args) {
                    let bytes = 0;
                    if (typeof args[0] === 'number') bytes = args[0] * bpe;
                    else if (args[0] && typeof args[0].byteLength === 'number') bytes = args[0].byteLength;
                    if (bytes >= BIG) {
                        let stack = '';
                        try { stack = new Error().stack.split('\n').slice(2, 7).join(' | '); } catch (e) { /* ignore */ }
                        window.__bigAllocs.push({ name, bytes, stack: stack.slice(0, 400) });
                    }
                    return new target(...args);
                }
            });
            window[name] = Wrapped;
        }
    });

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
    await sleep(2000);

    const out = await page.evaluate(() => {
        const list = window.__bigAllocs || [];
        const total = list.reduce((a, b) => a + b.bytes, 0);
        // 按"分配点"聚合（取栈里第一段非匿名行）
        const bySite = new Map();
        for (const a of list) {
            const site = a.stack.split(' | ').find(l => !l.includes('probe') && !l.includes('anonymous')) || a.stack.split(' | ')[0];
            const key = site.trim().slice(0, 160);
            const cur = bySite.get(key) || { count: 0, bytes: 0 };
            cur.count++;
            cur.bytes += a.bytes;
            bySite.set(key, cur);
        }
        return {
            heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
            allocCount: list.length,
            allocTotalBytes: total,
            topSites: Array.from(bySite.entries()).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 12),
            biggest: list.slice().sort((a, b) => b.bytes - a.bytes).slice(0, 8)
        };
    });

    console.log(`\n=== 大块分配登记（≥16MB）===`);
    console.log(`  JS 堆 ${out.heapMB}MB；共 ${out.allocCount} 笔、合计 ${mb(out.allocTotalBytes)}MB`);
    console.log('  按分配点聚合（前 12）：');
    for (const [site, v] of out.topSites) {
        console.log(`    ${String(mb(v.bytes)).padStart(8)}MB × ${String(v.count).padStart(3)}  ${site}`);
    }
    console.log('  单笔最大（前 8）：');
    for (const a of out.biggest) {
        console.log(`    ${String(mb(a.bytes)).padStart(8)}MB ${a.name}  ${a.stack.slice(0, 220)}`);
    }

    try { await browser.close(); } catch { }
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
