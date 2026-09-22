// 导入到底把主线程占了多久：**同一台机器、同一个 7 GB 文件**，导入 worker 关/开各跑一次。
//
// 背景（第十五、十六轮）：`1亿gs.ply` = 134,652,397 高斯 / 7.02 GB。
//   • 关 worker：读文件 → 抽稀 → 物化 6000 万行 → morton 重排 全在主线程，
//     用户看到的就是"窗口白屏 / 进度条不动、点什么都没反应"的那几十秒；
//   • 开 worker：同一段逻辑搬进 worker，主线程只剩 I/O 回调与最后一手
//     `dataTableToGSplatData()`（Transferable 零拷贝）。
//
// 口径（都是页面里量的，不靠肉眼）：
//   • maxBlockMs      —— 主线程最长一次连续占用（25 ms 心跳的间隔最大值）
//   • blocksOver1s / blocksOver5s —— 超过 1 s / 5 s 的阻塞次数
//   • longTaskMs      —— PerformanceObserver('longtask') 的阻塞总时长与条数
//   • importMs        —— import 事件从发起到 resolve 的墙钟（含 fetch 之后的全部）
//
// usage: node docs/probes/import-stall.cjs "<url>" [model] [chunkMb] [budget] [waitSec]
const path = require('path');
const puppeteer = require(path.join(__dirname, '..', '..', 'node_modules', 'puppeteer-core'));

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'huge-134m.ply';
const CHUNK_MB = Number(process.argv[4] || 256);
const BUDGET = Number(process.argv[5] || 0);
const WAIT = Number(process.argv[6] || 900);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const runArm = async (browser, worker) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));

    // 开关必须在页面脚本执行前设好：`USE_LOAD_WORKER` 是模块顶层常量
    await page.evaluateOnNewDocument((on, budget) => {
        window.__SPLATROOM_ENABLE_LOAD_WORKER__ = on;
        window.__LW_WORKER_RESULTS__ = 0;
        if (budget > 0) {
            window.__SPLATROOM_IMPORT_BUDGET__ = budget;
        }
    }, worker, BUDGET);

    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1500);

    // 主线程阻塞计（必须在导入之前装好）：除了最大值，还记**绝对时间窗**，
    // 用来判断阻塞落在 `import` resolve 之前（解码/物化）还是之后（GPU 上传 / 首次排序）。
    await page.evaluate(() => {
        window.__stall = { samples: 0, maxGap: 0, over1s: 0, over5s: 0, gaps: [], windows: [], longTaskMs: 0, longTaskCount: 0, longTaskMax: 0 };
        let last = performance.now();
        window.__stallTimer = setInterval(() => {
            const now = performance.now();
            const gap = now - last;
            const s = window.__stall;
            s.samples++;
            s.maxGap = Math.max(s.maxGap, gap);
            if (gap > 1000) {
                s.over1s++;
                s.windows.push({ start: Math.round(last - window.__importT0), end: Math.round(now - window.__importT0), gap: Math.round(gap) });
            }
            if (gap > 5000) s.over5s++;
            if (gap > 200) s.gaps.push(Math.round(gap));
            last = now;
        }, 25);
        try {
            window.__stallObserver = new PerformanceObserver((list) => {
                for (const e of list.getEntries()) {
                    const s = window.__stall;
                    s.longTaskMs += e.duration;
                    s.longTaskCount++;
                    s.longTaskMax = Math.max(s.longTaskMax, e.duration);
                }
            });
            window.__stallObserver.observe({ entryTypes: ['longtask'] });
        } catch (e) {
            window.__stall.longTaskError = String(e);
        }
    });

    // 把 7 GB 文件按 Range 分块取回页面、拼成 File（等价于用户拖入真实文件）
    const built = await page.evaluate(async (m, chunkMb) => {
        try {
            const head = await fetch('./' + m, { headers: { Range: 'bytes=0-0' } });
            const total = parseInt(head.headers.get('content-range').split('/')[1], 10) ||
                +(head.headers.get('content-length') || 0);
            const chunk = chunkMb * 1024 * 1024;
            const parts = [];
            const t0 = performance.now();
            for (let off = 0; off < total; off += chunk) {
                const r = await fetch('./' + m, { headers: { Range: `bytes=${off}-${Math.min(off + chunk, total) - 1}` } });
                if (r.status !== 206) return { ok: false, error: `range status ${r.status}` };
                parts.push(await r.blob());
            }
            window.__file = new File(parts, m);
            return { ok: true, bytes: window.__file.size, parts: parts.length, fetchMs: Math.round(performance.now() - t0) };
        } catch (e) {
            return { ok: false, error: String(e).slice(0, 300) };
        }
    }, MODEL, CHUNK_MB);

    if (!built.ok) {
        await page.close();
        return { worker, built, errors };
    }

    // 导入前把计数器清零：下面的数字只覆盖"导入"这一段
    await page.evaluate(() => {
        const s = window.__stall;
        s.maxGap = 0; s.over1s = 0; s.over5s = 0; s.gaps = []; s.windows = [];
        s.longTaskMs = 0; s.longTaskCount = 0; s.longTaskMax = 0; s.samples = 0;
        window.__importDone = false;
        window.__importErr = null;
        window.__importT0 = performance.now();
    });

    await page.evaluate((m) => {
        window.scene.events.invoke('import', [{ filename: m, contents: window.__file }])
            .then(() => {
                window.__importDone = true;
                window.__importMs = performance.now() - window.__importT0;
                window.__importResolvedAt = Math.round(performance.now() - window.__importT0);
            })
            .catch((e) => { window.__importErr = String(e).slice(0, 400); });
    }, MODEL).catch((e) => errors.push('import-eval: ' + String(e).slice(0, 200)));

    // 主线程被占住时 page.evaluate 会排队等待 —— 这正是我们要观察的现象，
    // 所以轮询间隔给足，且每次轮询都必须等到主线程空出来才返回。
    const t0 = Date.now();
    let done = false;
    while (Date.now() - t0 < WAIT * 1000) {
        await sleep(2000);
        try {
            done = await page.evaluate(() => !!(window.__importDone || window.__importErr));
        } catch {
            break;
        }
        if (done) break;
    }

    const out = await page.evaluate(() => {
        const s = window.__stall;
        const splat = window.scene.getElementsByType('splat').slice(-1)[0];
        s.gaps.sort((a, b) => b - a);
        return {
            importDone: window.__importDone,
            importErr: window.__importErr,
            importMs: window.__importMs ? Math.round(window.__importMs) : null,
            importResolvedAt: window.__importResolvedAt ?? null,
            maxBlockMs: Math.round(s.maxGap),
            over1s: s.over1s,
            over5s: s.over5s,
            topGaps: s.gaps.slice(0, 8),
            // 每段 >1s 阻塞的绝对时间窗（相对 import 起点）+ 它落在 resolve 前还是后
            blockWindows: (s.windows || []).map(w => ({
                ...w,
                phase: window.__importResolvedAt === undefined ? 'unknown' :
                    (w.start < window.__importResolvedAt ? 'before-resolve' : 'after-resolve')
            })).sort((a, b) => b.gap - a.gap).slice(0, 6),
            longTaskCount: s.longTaskCount,
            longTaskMs: Math.round(s.longTaskMs),
            longTaskMax: Math.round(s.longTaskMax),
            workerResults: window.__LW_WORKER_RESULTS__ || 0,
            numSplats: splat ? splat.numSplats : null,
            importReduction: splat ? splat.importReduction : null,
            tier: window.__tierEvents && window.__tierEvents.length ? window.__tierEvents[window.__tierEvents.length - 1].tier : null
        };
    }).catch((e) => ({ error: String(e).slice(0, 200) }));

    await page.close();
    return { worker, built, ...out, errors };
};

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 0
    });
    const off = await runArm(browser, false);
    const on = await runArm(browser, true);
    const row = (r) => ({
        arm: r.worker ? 'worker 开' : 'worker 关',
        importMs: r.importMs, importResolvedAt: r.importResolvedAt,
        maxBlockMs: r.maxBlockMs, over1s: r.over1s, over5s: r.over5s,
        longTaskMs: r.longTaskMs, longTaskCount: r.longTaskCount, longTaskMax: r.longTaskMax,
        numSplats: r.numSplats, reduction: r.importReduction, workerResults: r.workerResults
    });
    console.log(JSON.stringify({
        url: URL, model: MODEL, chunkMb: CHUNK_MB, budget: BUDGET || null,
        off: row(off), on: row(on),
        topGapsOff: off.topGaps, topGapsOn: on.topGaps,
        windowsOff: off.blockWindows, windowsOn: on.blockWindows,
        errors: [...(off.errors || []), ...(on.errors || [])].slice(0, 4)
    }, null, 1));
    await browser.close();
    process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ fatal: String(e && e.stack || e).slice(0, 800) })); process.exit(1); });
