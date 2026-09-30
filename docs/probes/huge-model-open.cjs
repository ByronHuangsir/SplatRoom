// 超大模型（>1 亿高斯）"能不能打开"的分阶段口径。
//
// 背景：用户桌面上的 `1亿gs.ply` = **134,652,397** 个高斯、14 个 float 属性
// （x,y,z,f_dc_0..2,opacity,scale_0..2,rot_0..3 = **56 B/高斯**、无 SH 高阶）⇒ 7.02 GB。
//
// ⚠️ 两个**必须区分**的读取路径（2026-09-22 实测）：
//   • **朴素路径**（`fetch(url).arrayBuffer()`）：**7.5 GB 直接失败**（`TypeError: Failed to fetch`），
//     连 4.72 GB 的 20M 夹具也失败。实测单块 ArrayBuffer 的墙在 **1.5 GB 可以 / 2 GB 失败**
//     （`docs/probes/alloc-wall.cjs`）。`file-handler.ts:404` 的 **URL 分支**用的就是这条路径。
//   • **应用真实路径**（拖入/打开文件 → `File` → `@playcanvas/splat-transform` 的 `BlobReadSource`
//     按 4 MB `slice().arrayBuffer()` 流式读）：**没有这条墙**。所以本探针默认用"多块 Blob 拼成的
//     File"来喂应用（与拖动一个真实文件等价），朴素路径只在 `--naive` 时用。
//
// usage: node docs/probes/huge-model-open.cjs "<url>" [model] [waitSec] [jsHeapMb] [chunkMb|naive] [budget]
//   model           默认 huge-134m.ply（`dist\` 下需有硬链接）
//   waitSec         导入后最多等多久（默认 180）
//   jsHeapMb        0 = 不加 `--js-flags`（默认，复现用户环境）；非 0 则给渲染进程设 max-old-space-size
//   chunkMb         分块大小（默认 256）；填 `naive` 则走 `fetch().arrayBuffer()` 对照
//   budget          非 0 时设 `window.__SPLATROOM_IMPORT_BUDGET__`（模拟低配机器 / 手动试更小的导入）
const path = require('path');
const puppeteer = require(path.join(__dirname, '..', '..', 'node_modules', 'puppeteer-core'));

const { BROWSER_PATH: EDGE , launchPatched: _launchPatched } = require('../verify/lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'huge-134m.ply';
const WAIT = Number(process.argv[4] || 180);
const HEAP = Number(process.argv[5] || 0);
const CHUNK_ARG = String(process.argv[6] || '256');
const NAIVE = CHUNK_ARG === 'naive';
const CHUNK_MB = NAIVE ? 0 : Number(CHUNK_ARG);
const BUDGET = Number(process.argv[7] || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const args = ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'];
    if (HEAP) args.push(`--js-flags=--max-old-space-size=${HEAP}`);

    const report = {
        url: URL, model: MODEL, jsHeapMb: HEAP, waitSec: WAIT, forcedBudget: BUDGET || null,
        mode: NAIVE ? 'naive-arrayBuffer' : `chunked-${CHUNK_MB}MB`, console: [], stages: [], ok: false
    };
    const browser = await _launchPatched(puppeteer, { executablePath: EDGE, headless: 'new', args, protocolTimeout: 0 });
    let rendererGone = null;
    browser.on('disconnected', () => { if (!rendererGone) rendererGone = 'browser disconnected'; });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    page.on('pageerror', (e) => report.console.push('pageerror: ' + String(e).slice(0, 300)));
    page.on('error', (e) => { rendererGone = 'page error: ' + String(e).slice(0, 200); });
    page.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning') {
            report.console.push(`${m.type()}: ${m.text().slice(0, 300)}`);
        }
    });

    const snapshot = async (tag) => {
        try {
            const stages = await page.evaluate(() => window.__stages || []);
            if (stages.length) report.stages = stages;
            if (tag) report.lastTag = tag;
            return true;
        } catch (e) {
            if (!rendererGone) rendererGone = `${tag}: ${String(e).slice(0, 160)}`;
            return false;
        }
    };

    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    if (BUDGET > 0) {
        await page.evaluate((b) => { window.__SPLATROOM_IMPORT_BUDGET__ = b; }, BUDGET);
    }
    await sleep(1500);

    await page.evaluate(() => {
        window.__stages = [];
        window.__t0 = performance.now();
        // 分级策略事件（tier.policy / import.reduced）留个记录，便于断言接线是否生效
        window.__tierEvents = [];
        window.scene.events.on('tier.policyChanged', (info) => window.__tierEvents.push({ type: 'tier.policyChanged', ...info }));
        window.scene.events.on('import.reduced', (info) => window.__tierEvents.push({ type: 'import.reduced', ...info }));
        window.__push = (name, obj = {}) => {
            const mem = performance.memory ? {
                usedHeapMb: +(performance.memory.usedJSHeapSize / 1048576).toFixed(0),
                totalHeapMb: +(performance.memory.totalJSHeapSize / 1048576).toFixed(0),
                limitMb: +(performance.memory.jsHeapSizeLimit / 1048576).toFixed(0)
            } : null;
            window.__stages.push({ name, ms: +(performance.now() - window.__t0).toFixed(0), mem, ...obj });
        };
        // 出帧 + 亮像素占比（口径同 gpu-frame-probe.cjs：max(r,g,b) > 60）
        window.__lit = async () => {
            const scene = window.scene;
            for (let i = 0; i < 4; i++) { scene.forceRender = true; await new Promise((r) => requestAnimationFrame(() => r())); }
            const src = scene.canvas;
            const off = document.createElement('canvas');
            const sw = Math.min(src.width, 640);
            const sh = Math.max(1, Math.round(src.height * (sw / src.width)));
            off.width = sw; off.height = sh;
            const ctx = off.getContext('2d');
            ctx.drawImage(src, 0, 0, sw, sh);
            const d = ctx.getImageData(0, 0, sw, sh).data;
            let lit = 0, n = 0;
            for (let i = 0; i < d.length; i += 4) {
                if (Math.max(d[i], d[i + 1], d[i + 2]) > 60) lit++;
                n++;
            }
            return { litPercent: +((lit / n) * 100).toFixed(1), canvas: [src.width, src.height] };
        };
    });

    // ---- 阶段 1：把文件读进页面 ----
    // 默认：分块取（`Range` + `blob()`）拼成多块 File —— 与"用户拖进一个真实文件"等价。
    // `naive`：`fetch().arrayBuffer()` 单块读 —— 记录这条路径的墙（4.7 GB 以上必失败）。
    const step1 = page.evaluate(async (m, chunkMb, naive) => {
        try {
            window.__push('fetch:start', { mode: naive ? 'naive' : `chunked-${chunkMb}MB` });
            const head = await fetch('./' + m, { headers: { Range: 'bytes=0-0' } });
            const total = parseInt(head.headers.get('content-range').split('/')[1], 10) ||
                +(head.headers.get('content-length') || 0);
            window.__push('fetch:headers', { contentLength: total, gb: +(total / 1073741824).toFixed(3) });

            if (naive) {
                const res = await fetch('./' + m);
                const buf = await res.arrayBuffer();
                window.__push('fetch:arrayBuffer', { bytes: buf.byteLength });
                window.__file = new File([buf], m);
                return { ok: true, bytes: buf.byteLength, parts: 1 };
            }

            const parts = [];
            const chunk = chunkMb * 1024 * 1024;
            const t0 = performance.now();
            for (let off = 0; off < total; off += chunk) {
                const end = Math.min(off + chunk, total) - 1;
                const r = await fetch('./' + m, { headers: { Range: `bytes=${off}-${end}` } });
                if (r.status !== 206) {
                    window.__push('fetch:range-unsupported', { status: r.status, off });
                    return { ok: false, error: `Range not supported (status ${r.status})` };
                }
                parts.push(await r.blob());
                if (parts.length % 5 === 0) {
                    window.__push('fetch:progress', { parts: parts.length, mb: Math.round((off + chunk) / 1048576) });
                }
            }
            const file = new File(parts, m);
            window.__push('fetch:file-ready', {
                parts: parts.length, size: file.size, ms: +(performance.now() - t0).toFixed(0)
            });
            window.__file = file;
            return { ok: true, bytes: file.size, parts: parts.length };
        } catch (e) {
            window.__push('fetch:FAILED', { error: String(e).slice(0, 300) });
            return { ok: false, error: String(e).slice(0, 300) };
        }
    }, MODEL, CHUNK_MB, NAIVE).catch((e) => ({ ok: false, fatal: String(e).slice(0, 300) }));

    const pollUntil = async (cond, deadlineMs, tag) => {
        const t1 = Date.now();
        while (Date.now() - t1 < deadlineMs) {
            await sleep(3000);
            const alive = await snapshot(tag);
            if (!alive) return false;
            try {
                if (await page.evaluate(cond)) return true;
            } catch { return false; }
        }
        return false;
    };

    const s1 = await step1;
    report.step1 = s1;
    await snapshot('after-fetch');

    if (!s1.ok) {
        report.verdict = 'fetch/arrayBuffer 阶段就失败（连文件都读不进内存）';
        report.rendererGone = rendererGone;
        console.log(JSON.stringify(report, null, 1));
        await browser.close().catch(() => { });
        process.exit(0);
    }

    // ---- 阶段 2：交给应用导入（用 phase 1 里准备好的那个 File）----
    await page.evaluate((m) => {
        window.__importErr = null;
        window.__importDone = false;
        window.__push('import:start', { fileSize: window.__file ? window.__file.size : 0 });
        window.scene.events.invoke('import', [{ filename: m, contents: window.__file }])
            .then(() => { window.__importDone = true; window.__push('import:resolved'); })
            .catch((e) => { window.__importErr = String(e).slice(0, 400); window.__push('import:rejected', { error: window.__importErr }); });
    }, MODEL).catch((e) => report.console.push('import-eval: ' + String(e).slice(0, 200)));

    const imported = await pollUntil(
        () => window.__importDone || window.__importErr || window.scene.getElementsByType('splat').length > 0,
        WAIT * 1000, 'waiting-import'
    );
    report.imported = imported;
    await snapshot('after-import');

    const state = await page.evaluate(() => {
        const splats = window.scene.getElementsByType('splat');
        const s = splats.slice(-1)[0];
        return {
            splatElements: splats.length,
            numSplats: s ? s.numSplats : null,
            importReduction: s ? s.importReduction : null,
            tierEvents: window.__tierEvents,
            lodAuto: window.scene.events.invoke('lod.autoEnabled'),
            lodAssets: s && s.lodAssets ? s.lodAssets.map(a => a.numSplats) : null,
            motionQuality: window.scene.motionQuality ? {
                levels: window.scene.motionQuality.levels.map(l => l.renderScale),
                engageGpuMs: window.scene.motionQuality.engageGpuMs,
                budgetMs: window.scene.motionQuality.budgetMs,
                minSplatsWithoutTiming: window.scene.motionQuality.minSplatsWithoutTiming
            } : null,
            importDone: window.__importDone,
            importError: window.__importErr
        };
    }).catch((e) => ({ error: String(e).slice(0, 200) }));
    report.state = state;

    if (state && state.numSplats) {
        const lit = await page.evaluate(() => window.__lit()).catch((e) => ({ error: String(e).slice(0, 200) }));
        report.render = lit;
        // 简单帧时间（强制出帧 40 次）
        const frames = await page.evaluate(async () => {
            const scene = window.scene;
            const ts = [];
            for (let i = 0; i < 40; i++) {
                const t = performance.now();
                scene.forceRender = true;
                await new Promise((r) => requestAnimationFrame(() => r()));
                ts.push(performance.now() - t);
            }
            ts.sort((a, b) => a - b);
            return { n: ts.length, p50: +ts[Math.floor(ts.length * 0.5)].toFixed(1), p95: +ts[Math.floor(ts.length * 0.95)].toFixed(1) };
        }).catch((e) => ({ error: String(e).slice(0, 200) }));
        report.frames = frames;
    }

    report.ok = !!(state && state.numSplats);
    report.rendererGone = rendererGone;
    report.verdict = report.ok
        ? '打开了'
        : (rendererGone ? `渲染进程死了：${rendererGone}` : (state && state.importError ? `导入报错：${state.importError}` : '导入未完成/超时'));

    console.log(JSON.stringify(report, null, 1));
    await browser.close().catch(() => { });
    process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ fatal: String(e).slice(0, 600) })); process.exit(1); });
