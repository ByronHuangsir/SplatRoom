// 导入残留主线程工作的**归因**口径（第十九轮）：用 CDP 的 CPU profiler 采样，直接点名热点函数。
//
// 背景（第十六/十八轮实测）：把"读 → 抽稀 → 物化 → morton 重排"搬进 worker 之后，
// 1.35 亿高斯那档（预算后 6000 万行）主线程仍有一段 **11.6 s** 的连续阻塞
// （20M 夹具 9.8 s，且与行数成正比 ≈194 ms/百万行）。这一段发生在**数据已经就绪之后**，
// 跟解码无关，所以不能再靠"分阶段打点"猜 —— 直接上 profiler。
//
// usage: node docs/probes/import-profile.cjs [url] [model] [chunkMb] [budget]
const path = require('path');
const puppeteer = require(path.join(__dirname, '..', '..', 'node_modules', 'puppeteer-core'));

const { BROWSER_PATH: EDGE , launchPatched: _launchPatched } = require('../verify/lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'huge-134m.ply';
const CHUNK_MB = Number(process.argv[4] || 256);
const BUDGET = Number(process.argv[5] || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = await _launchPatched(puppeteer, {
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 0
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1500);

    // 把大文件按 Range 分块取回页面拼成 File（与拖入真实文件等价）
    const built = await page.evaluate(async (m, chunkMb) => {
        const head = await fetch('./' + m, { headers: { Range: 'bytes=0-0' } });
        const total = parseInt(head.headers.get('content-range').split('/')[1], 10);
        const chunk = chunkMb * 1024 * 1024;
        const parts = [];
        for (let off = 0; off < total; off += chunk) {
            const r = await fetch('./' + m, { headers: { Range: `bytes=${off}-${Math.min(off + chunk, total) - 1}` } });
            parts.push(await r.blob());
        }
        window.__file = new File(parts, m);
        return { bytes: window.__file.size };
    }, MODEL, CHUNK_MB);

    const client = await page.createCDPSession();
    await client.send('Profiler.enable');
    await client.send('Profiler.setSamplingInterval', { interval: 200 });   // 200 µs

    await page.evaluate(async (m, budget) => {
        if (budget > 0) {
            window.__SPLATROOM_IMPORT_BUDGET__ = budget;
        }
        window.__importDone = false;
        window.__importErr = null;
        const t0 = performance.now();
        window.__file = window.__file;
        window.scene.events.invoke('import', [{ filename: m, contents: window.__file }])
            .then(() => {
                window.__importDone = true;
                window.__importMs = performance.now() - t0;
            })
            .catch((e) => {
                window.__importErr = String(e).slice(0, 300);
            });
    }, MODEL, BUDGET);

    await client.send('Profiler.start');
    // 等到 import 完成（或超时）
    let done = false;
    for (let i = 0; i < 900; i++) {
        await sleep(1000);
        try {
            done = await page.evaluate(() => !!(window.__importDone || window.__importErr));
        } catch {
            break;
        }
        if (done) break;
    }
    await sleep(1500);   // 收尾（首帧、LOD 生成等）

    const { profile } = await client.send('Profiler.stop');

    // 自时间聚合 + **调用链**（光看函数名认不出压缩后的 `H_.read` 是什么）。
    // 注意：CDP 的 profiler 节点里给的是 `children`（没有 `parent`），要自己反向建表。
    const byId = new Map();
    const parentOf = new Map();
    for (const n of profile.nodes) {
        byId.set(n.id, n);
        for (const c of n.children ?? []) {
            parentOf.set(c, n.id);
        }
    }
    const selfMicros = new Map();
    const total = profile.samples.length;
    for (let i = 0; i < total; i++) {
        const id = profile.samples[i];
        const dt = profile.timeDeltas[i] ?? 200;
        selfMicros.set(id, (selfMicros.get(id) ?? 0) + dt);
    }
    const label = (n) => {
        const cf = n.callFrame;
        const url = (cf.url || '').split('/').pop();
        return `${cf.functionName || '(anon)'}${url ? `@${url}:${cf.lineNumber + 1}` : ''}`;
    };
    const chainOf = (n) => {
        const out = [];
        let cur = n;
        let depth = 0;
        while (cur && depth < 12) {
            out.push(label(cur));
            const pid = parentOf.get(cur.id);
            cur = pid !== undefined ? byId.get(pid) : null;
            depth++;
        }
        return out.reverse().join(' <- ');
    };
    const rows = [];
    const totalMicros = [...selfMicros.values()].reduce((a, b) => a + b, 0);
    for (const [id, micros] of selfMicros) {
        const n = byId.get(id);
        if (!n) continue;
        const cf = n.callFrame;
        const url = (cf.url || '').split('/').pop();
        rows.push({
            fn: cf.functionName || '(anonymous)',
            url: `${url}:${cf.lineNumber + 1}`,
            selfMs: Math.round(micros / 1000),
            pct: +(100 * micros / Math.max(1, totalMicros)).toFixed(1),
            chain: chainOf(n)
        });
    }
    rows.sort((a, b) => b.selfMs - a.selfMs);

    const state = await page.evaluate(() => {
        const els = window.scene.getElementsByType('splat');
        const s = els.slice(-1)[0];
        return {
            importMs: window.__importMs ? Math.round(window.__importMs) : null,
            err: window.__importErr,
            // 关键：**导入后到底有几个 splat 元素 / 几份 GSplatResource**。
            // 若 >1，说明有一份资源被白白创建（profiler 里 `Q_` 出现了两条不同的调用链）。
            splatElements: els.length,
            resources: els.map((e) => ({
                numSplats: e.numSplats,
                assetSplats: e.asset?.resource?.gsplatData?.numSplats ?? null,
                resourceId: e.asset?.resource?.id ?? null,
                lodAssets: (e.lodAssets ?? []).length
            })),
            numSplats: s ? s.numSplats : null,
            reduction: s ? s.importReduction : null
        };
    });

    console.log(JSON.stringify({
        url: URL, model: MODEL, budget: BUDGET || null, bytes: built.bytes,
        wallMs: Math.round(profile.endTime - profile.startTime), samples: total,
        state, top: rows.slice(0, 16).map(r => ({ fn: r.fn, url: r.url, selfMs: r.selfMs, pct: r.pct, chain: r.chain }))
    }, null, 1));

    await browser.close();
    process.exit(0);
})().catch((e) => {
    console.log(JSON.stringify({ fatal: String(e && e.stack || e).slice(0, 700) }));
    process.exit(1);
});
