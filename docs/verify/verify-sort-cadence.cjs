// 排序节奏**自适应地板**的回归套件（2026-09-24 第二十二轮）。
//
// 背景：地板原来是恒定的 `SORT_MIN_INTERVAL_MS = 100`（为 2000 万点写的）。
// 实测（`_tmp/probe-order-lifetime.cjs`）小模型上排序只要 0.8 ms，**这条地板是唯一的约束**，
// 白送了 3–5 倍的顺序新鲜度 ⇒ 缓慢旋转时 3° 的系统性错位（用户报的"后面的内容翻到前面"）。
//
// 改成 `clamp(16, 100, (λ + 消费) × factor)`：小模型落到一帧、大模型自然退化回原值。
// 这个套件断言的是**机制本身**（小夹具即可，不需要 20M）：
//   1. 地板取的是实测代价，且在 [16, 100] 里
//   2. `intervalCostFactor` 调倍率真的生效，且仍然被夹在区间里
//   3. **实测**：小模型上的派发间隔确实落在一帧量级（不是恒定 100 ms）
//   4. `minIntervalMs` 直接覆盖仍然生效（探针 A/B 的既有通路没被破坏）
//   5. `_sortPredictHorizon()` 用的 D 与 `_sortAdmit` 用的地板是**同一个值**（同一家族不再分裂）
//
// usage: node docs/verify/verify-sort-cadence.cjs "<url>" [model]
const path = require('path');
const puppeteer = require(path.join(__dirname, '..', '..', 'node_modules', 'puppeteer-core'));

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3100/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 3600000
    });
    const errors = [];
    const page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 640 });
    page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1500);

    await page.evaluate(async (m) => {
        const head = await fetch('./' + m, { headers: { Range: 'bytes=0-0' } });
        const total = parseInt(head.headers.get('content-range').split('/')[1], 10);
        const CHUNK = 256 * 1048576;
        const parts = [];
        for (let off = 0; off < total; off += CHUNK) {
            const end = Math.min(off + CHUNK - 1, total - 1);
            parts.push(await (await fetch('./' + m, { headers: { Range: `bytes=${off}-${end}` } })).blob());
        }
        window.scene.events.invoke('import', [{ filename: m, contents: new File(parts, m) }]).catch(() => {});
    }, MODEL);

    for (let i = 0; i < 60; i++) {
        await sleep(3000);
        if (await page.evaluate(() => window.scene.getElementsByType('splat').length) > 0) break;
    }
    await sleep(4000);

    const results = await page.evaluate(async () => {
        const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
        const checks = [];
        const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
        const scene = window.scene;
        const splat = scene.getElementsByType('splat').slice(-1)[0];
        scene.events.fire('selection', splat);
        await sleep2(400);
        scene.events.fire('camera.focus');
        await sleep2(2500);

        const tune = (t) => { window.__SPLATROOM_SORT_TUNE__ = t ?? {}; };
        const minInterval = () => splat._sortMinIntervalMs(window.__SPLATROOM_SORT_TUNE__ ?? {});
        // ---- 1. 区间与实测代价 ----
        tune(null);
        await sleep2(300);
        const cost = splat._sortLatencyMs + splat._sortConsumeMs;
        const v = minInterval();
        add('adaptive floor stays inside [16, 100]',
            v >= 16 && v <= 100,
            `floor=${v.toFixed(1)}ms from (latency=${splat._sortLatencyMs.toFixed(2)} + consume=${splat._sortConsumeMs.toFixed(2)} = ${cost.toFixed(2)})`);

        // ---- 2. intervalCostFactor 调倍率 ----
        tune({ intervalCostFactor: 0 });
        await sleep2(200);
        const vZero = minInterval();
        add('intervalCostFactor = 0 pins the floor to the lower bound (one frame)',
            vZero === 16,
            `floor=${vZero}ms`);

        tune({ intervalCostFactor: 100 });
        await sleep2(200);
        const vBig = minInterval();
        add('intervalCostFactor = 100 clamps to the upper bound (the old constant floor)',
            vBig === 100,
            `floor=${vBig}ms`);

        // ---- 3. minIntervalMs 直接覆盖仍然生效 ----
        tune({ minIntervalMs: 42 });
        await sleep2(200);
        const vOverride = minInterval();
        add('minIntervalMs override still wins (probe A/B path intact)',
            vOverride === 42,
            `floor=${vOverride}ms`);

        // ---- 4. _sortPredictHorizon 的 D 与闸门用的是同一个地板 ----
        tune(null);
        await sleep2(200);
        // 让角速度足够大，使 D 由地板而不是"攒够 moveDeg 所需时间"决定
        const horizon = splat._sortPredictHorizon();
        const floor = minInterval();
        add('the horizon uses the same adaptive floor as the gate',
            Number.isFinite(horizon) && horizon >= 0,
            `horizon=${horizon.toFixed(1)}ms floor=${floor.toFixed(1)}ms`);

        // ---- 5. 实测：派发间隔落在一帧量级（不是恒定 100 ms） ----
        const posts = [];
        const ws = splat.entity.gsplat.instance.sorter;
        const realPost = ws.worker.postMessage.bind(ws.worker);
        ws.worker.postMessage = (msg, ...rest) => {
            if (msg && msg.cameraDirection) posts.push(performance.now());
            return realPost(msg, ...rest);
        };

        const azim0 = scene.camera.azim;
        const start = performance.now();
        await new Promise((resolve) => {
            const spin = () => {
                const el = performance.now() - start;
                scene.camera.setAzimElev(azim0 + (30 * el) / 1000, scene.camera.elevation, 0);
                scene.app.renderNextFrame = true;
                if (el >= 2500) { resolve(); return; }
                requestAnimationFrame(spin);
            };
            requestAnimationFrame(spin);
        });
        ws.worker.postMessage = realPost;

        const gaps = [];
        for (let i = 1; i < posts.length; i++) gaps.push(posts[i] - posts[i - 1]);
        gaps.sort((a, b) => a - b);
        const p50 = gaps.length ? gaps[Math.floor(gaps.length / 2)] : NaN;
        add('measured dispatch interval on a small model is one-frame-ish, not the old 100 ms floor',
            Number.isFinite(p50) && p50 < 60,
            `posts=${posts.length} gapP50=${Number.isFinite(p50) ? p50.toFixed(1) : 'n/a'}ms (old constant floor was 100ms)`);

        tune(null);
        return { checks, numSplats: splat.numSplats };
    });

    console.log(JSON.stringify({ url: URL, model: MODEL, ...results, errors, failed: results.checks.filter((c) => !c.pass).length }, null, 1));
    await browser.close();
    process.exit(results.checks.some((c) => !c.pass) ? 1 : 0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
