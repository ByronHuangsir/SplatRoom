// 探针 74：20M 档那 ~8.9GB 到底花在哪（**逐项量**，不猜）。
//
// 背景（探针 48）：导入 2000 万点 / 4.96GB 的 PLY 之后，渲染进程 JS 堆 **8870MB**（上限 4192MB），
// 而抽样到的 11 列只有 782MB。要回答"剩下的 8GB 是什么"，必须把导入后的**真实对象**逐项读出来：
//   ① 数据表的**全部列**（含 45 列 f_rest）—— 这是"可编辑数据"，不是冗余；
//   ② 应用侧附加列（state / transform）+ 常驻映射表；
//   ③ 引擎资源自己的纹理（那一份在显存，但也有 CPU 侧镜像）；
//   ④ 剩下的"解释不了的部分"（临时副本、读取缓冲、GC 未回收的旧世代…）。
//
// usage: node _tmp/probe-memory-breakdown.cjs [model] [webgpu|webgl2]
const path = require('path');
const REPO = path.join(__dirname, '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const { launchPatched: _launchPatched } = require('../verify/lib/browser.cjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL = process.argv[2] || 'splat_20m.ply';
const BACKEND = process.argv[3] || 'webgpu';

const mb = (v) => +(v / 1048576).toFixed(1);

(async () => {
    cleanupOrphanBrowsers();
    const browser = await _launchPatched(puppeteer, {
        executablePath: EDGE, headless: 'new',
        // `--expose-gc`：把"未回收垃圾"和"真正常驻"分开 —— 不然 ④ 那一栏说不清是什么。
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--js-flags=--expose-gc'],
        protocolTimeout: 1800000
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 620 });
    const crash = { dead: false };
    page.on('error', (e) => { crash.dead = true; console.log('[CRASH]', String(e).slice(0, 200)); });
    page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));

    await page.goto(`http://localhost:3100/?gpu=${BACKEND}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1500);
    const heap0 = await page.evaluate(() => performance.memory ? mb0() : null).catch(() => null);
    function mb0() { return null; }

    console.log(`导入 ${MODEL} …`);
    const t0 = Date.now();
    await page.evaluate(async (m) => {
        const head = await fetch('./' + m, { headers: { Range: 'bytes=0-0' } });
        const total = parseInt(head.headers.get('content-range').split('/')[1], 10);
        const CHUNK = 256 * 1048576;
        const parts = [];
        for (let off = 0; off < total; off += CHUNK) {
            const end = Math.min(off + CHUNK - 1, total - 1);
            parts.push(await (await fetch('./' + m, { headers: { Range: `bytes=${off}-${end}` } })).blob());
        }
        window.__fileBytes = total;
        await window.scene.events.invoke('import', [{ filename: m, contents: new File(parts, m) }]);
    }, MODEL);
    let ok = false;
    for (let i = 0; i < 400; i++) {
        await sleep(1000);
        if (crash.dead) break;
        ok = await page.evaluate(() => (window.scene.elements || []).some((e) => e.entity && e.entity.gsplat)).catch(() => false);
        if (ok) break;
    }
    console.log(`导入 ${ok ? '完成' : '失败'} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (!ok) { console.log(JSON.stringify({ crash })); try { await browser.close(); } catch { } return; }
    await sleep(2000);
    // 强制 GC 若干轮：把"导入期临时对象还没回收"和"真正常驻"分开
    const gcInfo = await page.evaluate(() => {
        const before = performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null;
        const hasGc = typeof globalThis.gc === 'function';
        if (hasGc) {
            for (let i = 0; i < 5; i++) globalThis.gc();
        }
        const after = performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null;
        return { hasGc, before, after };
    });
    console.log(`强制 GC：${JSON.stringify(gcInfo)}`);
    await sleep(2000);

    const out = await page.evaluate(() => {
        const scene = window.scene;
        const el = (scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        const data = el.splatData;
        const numSplats = data.numSplats;
        const mem = performance.memory;

        // ① 全部列
        const cols = [];
        let colTotal = 0;
        try {
            const elem = data.getElement ? data.getElement('vertex') : null;
            const props = elem ? elem.properties : null;
            if (props) {
                for (const p2 of props) {
                    const bytes = p2.storage ? p2.storage.byteLength : 0;
                    cols.push([p2.name, bytes]);
                    colTotal += bytes;
                }
            }
        } catch (e) { /* ignore */ }
        cols.sort((a, b) => b[1] - a[1]);
        const byPrefix = {};
        for (const [name, bytes] of cols) {
            const key = /^f_rest/.test(name) ? 'f_rest_* (SH 高阶)' : name;
            byPrefix[key] = (byPrefix[key] || 0) + bytes;
        }

        // ③ 引擎资源的纹理（名字 + 尺寸 + 格式）
        const comp = el.entity.gsplat;
        const resource = comp?.instance?.resource ?? comp?.resource ?? comp?._placement?.resource ?? el.asset?.resource;
        const textures = [];
        let texBytes = 0;
        let texCpuBytes = 0;
        // PlayCanvas 的真实枚举（之前用猜的，差了 4 倍）：RGBA8=7、RGBA16F=12、R32F=15、R32U=37、RGBA32U=49、R8=52
        const bytesPerPixel = (fmt) => {
            if (fmt === 7) return 4;
            if (fmt === 12) return 8;
            if (fmt === 15) return 4;
            if (fmt === 37) return 4;
            if (fmt === 49) return 16;
            if (fmt === 52) return 1;
            return 4;
        };
        try {
            resource?.streams?.textures?.forEach((tex, name) => {
                const bytes = tex.width * tex.height * bytesPerPixel(tex.format);
                // 关键：这张纹理**是否还持有 CPU 侧那份数据**（`lock()` 分配的那块）
                let cpuBytes = 0;
                try {
                    const levels = tex._levels || tex.levels || [];
                    for (const lv of levels) {
                        if (lv && lv.data && lv.data.byteLength) cpuBytes += lv.data.byteLength;
                    }
                } catch (e) { /* ignore */ }
                textures.push([name, tex.width, tex.height, tex.format, bytes, cpuBytes]);
                texBytes += bytes;
                texCpuBytes += cpuBytes;
            });
        } catch (e) { /* ignore */ }

        return {
            numSplats,
            heapMB: mem ? +(mem.usedJSHeapSize / 1048576).toFixed(1) : null,
            limitMB: mem ? +(mem.jsHeapSizeLimit / 1048576).toFixed(1) : null,
            fileBytes: window.__fileBytes,
            colCount: cols.length,
            colTotalBytes: colTotal,
            topColumns: cols.slice(0, 8),
            byPrefix,
            texTotalBytes: texBytes,
            texCpuTotalBytes: texCpuBytes,
            textures: textures.sort((a, b) => b[4] - a[4]).slice(0, 8),
            stateBytes: (data.getProp('state') || { byteLength: 0 }).byteLength,
            transformBytes: (data.getProp('transform') || { byteLength: 0 }).byteLength,
            importReduction: el.importReduction ?? null
        };
    });

    console.log('\n=== 内存构成 ===');
    console.log(`  高斯数 ${out.numSplats}；文件 ${(out.fileBytes / 1073741824).toFixed(2)}GB`);
    console.log(`  JS 堆 ${out.heapMB}MB / 上限 ${out.limitMB}MB`);
    console.log(`  ① 数据表全部列：${out.colCount} 列、合计 ${mb(out.colTotalBytes)}MB`);
    for (const [k, v] of Object.entries(out.byPrefix).sort((a, b) => b[1] - a[1]).slice(0, 6)) {
        console.log(`       ${k} = ${mb(v)}MB`);
    }
    console.log(`  ② 应用附加列：state ${mb(out.stateBytes)}MB + transform ${mb(out.transformBytes)}MB`);
    console.log(`  ③ 引擎资源纹理：显存合计 ${mb(out.texTotalBytes)}MB；其中 **CPU 侧还留着的** ${mb(out.texCpuTotalBytes)}MB`);
    for (const [name, w, h, fmt, b, cpu] of out.textures) console.log(`       ${name} ${w}x${h} fmt=${fmt} 显存=${mb(b)}MB CPU=${mb(cpu)}MB`);
    const accounted = out.colTotalBytes + out.stateBytes + out.transformBytes;
    console.log(`  ④ 未解释（JS 堆 − ①②，其中应当包含③的 CPU 那部分）：${mb((out.heapMB * 1048576) - accounted)}MB`);
    console.log(`  抽稀信息：${JSON.stringify(out.importReduction)}`);

    try { await browser.close(); } catch { }
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
