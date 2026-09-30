// Load worker A/B: does the import go through the worker by default, does it produce the SAME
// model, and does it actually shorten the main-thread freeze?
//
// Context: the load worker was opt-in via `window.__SPLATROOM_ENABLE_LOAD_WORKER__ === true`
// (nothing set it, so decode + morton sort + row reorder ran on the main thread — the ~15 s freeze
// on a 13M import). 第十六轮把它改成"默认打开、传 `Blob`、worker 自己分块读 + 抽稀 + 物化 + 重排"。
//
// 这条套件跑两次导入，只差一个开关：
//   A. **默认**（不设任何开关）—— 必须走 worker；
//   B. `window.__SPLATROOM_ENABLE_LOAD_WORKER__ = false` —— 回退主线程，必须一次 worker 都不用。
// 断言：
//   1. A 的 `__LW_WORKER_RESULTS__` > 0、B 的 = 0（只断言一边是抓不住"两次都走 worker"的假绿的，
//      见 HANDOFF 坑 60：开关是模块顶层常量，必须用 evaluateOnNewDocument 注入）；
//   2. 高斯数一致；
//   3. `x/y/z/opacity/state/rot_0` 的 FNV 校验和逐列一致（行重排错位会保持数量却打乱每个属性）；
//   4. **导入姿态一致且有限**（旋转是真 Quat：结构化克隆会丢原型 ⇒ NaN，HANDOFF 坑 59）；
//   5. 主线程最长阻塞（20 ms 心跳 gap）：夹具够大（> 2M 高斯）时要求 worker 那边**至少减半**，
//      小夹具上只打印数字（2000 点夹具本来就没有可测量的阻塞）。
//
// usage: node docs/verify/verify-load-worker.cjs [url] [model]
//   model 默认 test-model.ply（`dist/` 下已有）。要量真实收益用 20M 夹具：
//   node docs/verify/verify-load-worker.cjs "<url>" test-20m-fill.ply
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const { BROWSER_PATH: EDGE , launchPatched: _launchPatched } = require('./lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const modelPath = path.join(__dirname, '..', '..', 'dist', MODEL);

/** @param {'default'|'off'} mode */
const runOnce = async (browser, mode) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + String(e).slice(0, 200)));
    // 必须在页面脚本执行前注入：`USE_LOAD_WORKER` 是模块顶层常量
    await page.evaluateOnNewDocument((m) => {
        window.__LW_WORKER_RESULTS__ = 0;
        if (m === 'off') {
            window.__SPLATROOM_ENABLE_LOAD_WORKER__ = false;
        }
    }, mode);
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForFunction('!!window.scene', { timeout: 90000, polling: 500 });
    await sleep(1500);

    // 把模型取回页面拼成 `File`。**不能用 `fetch().arrayBuffer()`**：单块 `ArrayBuffer`
    // 的上限实测是 1.5 GB 可以 / 2 GB 失败（HANDOFF 43、`docs/probes/alloc-wall.cjs`），
    // 20M 夹具是 4.4 GB ⇒ 直接 `TypeError: Failed to fetch`。按 `Range` 分块取（与拖入真实文件等价）。
    const built = await page.evaluate(async (m, chunkMb) => {
        try {
            const head = await fetch('./' + m, { headers: { Range: 'bytes=0-0' } });
            const total = parseInt(head.headers.get('content-range')?.split('/')[1] || '0', 10) ||
                +(head.headers.get('content-length') || 0);
            if (!total) {
                // 不带 content-range 的静态服务：退回整块读（只对小模型可行）
                const buf = await (await fetch('./' + m)).arrayBuffer();
                window.__buf = new Uint8Array(buf);
                return { ok: true, bytes: buf.byteLength, parts: 1, mode: 'arrayBuffer' };
            }
            const chunk = chunkMb * 1024 * 1024;
            const parts = [];
            for (let off = 0; off < total; off += chunk) {
                const r = await fetch('./' + m, { headers: { Range: `bytes=${off}-${Math.min(off + chunk, total) - 1}` } });
                if (r.status !== 206) return { ok: false, error: `Range not supported (status ${r.status})` };
                parts.push(await r.blob());
            }
            window.__file = new File(parts, m);
            return { ok: true, bytes: window.__file.size, parts: parts.length, mode: `range-${chunkMb}MB` };
        } catch (e) {
            return { ok: false, error: String(e).slice(0, 200) };
        }
    }, MODEL, 64);
    if (!built.ok) {
        console.log(JSON.stringify({ fatal: 'could not fetch the fixture: ' + built.error, model: MODEL }));
        await browser.close();
        process.exitCode = 1;
        return;
    }

    const out = await page.evaluate(async (m) => {
        const sleep2 = (ms) => new Promise(r => setTimeout(r, ms));
        const scene = window.scene;
        const res = { started: Date.now() };
        // 20ms heartbeat: the max gap is how long the main thread was blocked, i.e. the "freeze"
        // the user feels. Moving the decode into the worker should show up here, not in wall time.
        const gaps = [];
        let last = performance.now();
        const iv = setInterval(() => {
            const now = performance.now();
            gaps.push(now - last);
            last = now;
        }, 20);
        const p = scene.events.invoke('import', [{
            filename: m,
            contents: window.__file || new File([window.__buf], m)
        }])
            .then(() => { res.importMs = Date.now() - res.started; })
            .catch((e) => { res.importError = String(e).slice(0, 300); });
        for (let i = 0; i < 40; i++) {
            await sleep2(5000);
            console.log('[diag] t=' + ((Date.now() - res.started) / 1000).toFixed(0) + 's splats=' + scene.getElementsByType('splat').length);
            if (res.importMs !== undefined || res.importError) break;
        }
        await Promise.race([p, sleep2(1000)]);
        clearInterval(iv);
        const sorted = gaps.slice().sort((a, b) => b - a);
        res.maxGapMs = Math.round(sorted[0] ?? 0);
        res.blocksOver100ms = gaps.filter(g => g > 100).length;
        const splats = scene.getElementsByType('splat');
        res.numSplats = splats[0] ? splats[0].splatData.numSplats : 0;
        // Column checksums: "same gaussian count" is NOT enough — a row-reorder bug in the worker
        // would keep the count and still shuffle every attribute, which shows up downstream as
        // selections and colours being subtly wrong. FNV-1a over the raw bytes.
        const checksum = (arr) => {
            if (!arr) return 'missing';
            const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
            let h = 0x811c9dc5;
            for (let i = 0; i < bytes.length; i++) {
                h ^= bytes[i];
                h = Math.imul(h, 0x01000193) >>> 0;
            }
            return h.toString(16) + ':' + bytes.length;
        };
        res.checksums = {};
        if (splats[0]) {
            for (const name of ['x', 'y', 'z', 'opacity', 'state', 'rot_0']) {
                res.checksums[name] = checksum(splats[0].splatData.getProp(name));
            }
            // 导入姿态：结构化克隆会丢掉 `Quat`/`Vec3` 的原型，`setLocalRotation()` 按
            // `instanceof Quat` 分流 ⇒ 普通对象会写出 NaN 旋转矩阵（HANDOFF 坑 59）。
            const r = splats[0].entity.getLocalRotation();
            const s = splats[0].entity.getLocalScale();
            res.transform = {
                rotProto: Object.getPrototypeOf(r) === Object.prototype ? 'plain' : 'class',
                rot: [r.x, r.y, r.z, r.w].map(v => Number.isFinite(v) ? +v.toFixed(6) : String(v)),
                scale: [s.x, s.y, s.z].map(v => Number.isFinite(v) ? +v.toFixed(6) : String(v))
            };
        }
        res.workerResults = window.__LW_WORKER_RESULTS__ || 0;
        return res;
    }, MODEL);
    await page.close();
    return { ...out, errors };
};

(async () => {
    if (!fs.existsSync(modelPath)) {
        console.log(JSON.stringify({ fatal: `model not found: ${modelPath}` }));
        process.exitCode = 1;
        return;
    }
    const browser = await _launchPatched(puppeteer, { executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'], protocolTimeout: 1800000 });
    const on = await runOnce(browser, 'default');
    const off = await runOnce(browser, 'off');
    await browser.close();

    // 夹具够大才要求"阻塞至少减半"：2000 点夹具上两次的 gap 都接近心跳粒度，比不出东西。
    const big = (on.numSplats || 0) > 2000000;
    const checks = [
        {
            name: 'the default path really uses the worker (no flag needed)',
            pass: on.workerResults > 0,
            detail: `默认 workerResults=${on.workerResults}（必须 >0）, import ${on.importMs}ms`
        },
        {
            name: 'the opt-out flag really disables it (so the counter above is a real signal)',
            pass: off.workerResults === 0,
            detail: `__SPLATROOM_ENABLE_LOAD_WORKER__=false 时 workerResults=${off.workerResults}（必须 =0）, import ${off.importMs}ms`
        },
        {
            name: 'both paths load the same gaussian count',
            pass: on.numSplats > 0 && on.numSplats === off.numSplats,
            detail: `worker=${on.numSplats}, main=${off.numSplats}`
        },
        {
            name: 'both paths load byte-identical columns (x/y/z/opacity/state/rot_0)',
            pass: Object.keys(on.checksums || {}).every(k => on.checksums[k] === off.checksums?.[k]),
            detail: JSON.stringify({ worker: on.checksums, main: off.checksums })
        },
        {
            name: 'the import transform is a real Quat on both paths (no NaN rotation)',
            pass: !!on.transform && !!off.transform &&
                JSON.stringify(on.transform) === JSON.stringify(off.transform) &&
                on.transform.rotProto === 'class',
            detail: `worker ${JSON.stringify(on.transform)} vs main ${JSON.stringify(off.transform)}`
        },
        {
            name: big
                ? 'the worker at least halves the longest main-thread block (>2M splats fixture)'
                : 'longest main-thread block (informational: fixture too small to compare)',
            pass: big ? on.maxGapMs * 2 <= off.maxGapMs : true,
            detail: `worker ${on.maxGapMs}ms（>100ms 阻塞 ${on.blocksOver100ms} 次）vs main ${off.maxGapMs}ms（${off.blocksOver100ms} 次）; wall ${on.importMs} vs ${off.importMs}ms; numSplats=${on.numSplats}`
        },
        {
            name: 'no page errors on either path',
            pass: on.errors.length === 0 && off.errors.length === 0,
            detail: JSON.stringify([...on.errors, ...off.errors]).slice(0, 300)
        }
    ];

    console.log(JSON.stringify({ model: MODEL, worker: on, mainThread: off, checks, failed: checks.filter(c => !c.pass).length }, null, 1));
    if (checks.some(c => !c.pass)) process.exitCode = 1;
})().catch(e => { console.log(JSON.stringify({ fatal: String(e && e.stack || e).slice(0, 500) })); process.exitCode = 1; });
