// 顺序延迟补偿的**参数扫描**（2026-09-21 第七轮）：更长速度窗 + 双步外推。
//
// 两件事：
//   ① 度量口径修正 —— `disp` 改在**消费时刻**采样（`applyPendingSorted` 真正把顺序上传、
//      并且这一帧就会用它渲染），而不是"回包时刻"。旧口径读的是 worker 刚回包的那份顺序，
//      比屏幕上正在用的**新一档**（差一个"第二步延迟"≈24 ms）。用旧口径评"把 horizon 加上
//      第二步"必然看起来是过冲，所以必须先修口径再比参数。
//      两个口径同一次运行里都记：`dispConsume`（主）/ `dispReply`（旧，保持与历史数字可比）。
//   ② 配置扫描 —— 速度窗 120/200/300 ms × 第二步权重 0/1 × 额外常数 0/15 ms，
//      每档还量一次**反向**（转速反向后的 600 ms 内），因为长窗口在换向时必然滞后。
//
// 参数通过 `window.__SPLATROOM_SORT_TUNE__` 运行时注入（只给探针用，见 src/splat/splat.ts）。
//
// 用法：node docs/probes/sort-tune.cjs "<url>" [model] [degPerFrame] [set] [steadyMs] [only]
//   set = core（默认，5 档关键配置）| all（8 档）| ab（只测"旧版 vs 双步"两档，配 steadyMs 拉高样本量）
//   only = 逗号分隔的标签子串过滤（例如 "旧版,双步"）
const path = require('path');
const REPO = path.join(__dirname, '..', '..');
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const { BROWSER_PATH: EDGE } = require('../verify/lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-20m-fill.ply';
const DEG = parseFloat(process.argv[4] || '6');
const SET = process.argv[5] || 'core';
const STEADY_MS = parseFloat(process.argv[6] || '2600');
const ONLY = process.argv[7] || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 3600000
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
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

    for (let i = 0; i < 120; i++) {
        await sleep(5000);
        if (await page.evaluate(() => window.scene.getElementsByType('splat').length) > 0) break;
    }
    await sleep(8000);

    const out = await page.evaluate(async ([degPerFrame, set, steadyMs, only]) => {
        const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
        const scene = window.scene;
        const splat = scene.getElementsByType('splat').slice(-1)[0];
        scene.events.fire('selection', splat);
        await sleep2(500);
        scene.events.fire('camera.focus');
        await sleep2(4000);

        const inst = splat.entity.gsplat.instance;
        const ws = inst.sorter;

        // ---- disp 度量（两个口径共用同一套数学）----------------------------------------------
        const data = splat.splatData;
        const cx = data.getProp('x');
        const cy = data.getProp('y');
        const cz = data.getProp('z');
        const K = 4000;
        const samplePos = new Int32Array(K);
        const depth = new Float32Array(K);
        const curRank = new Int32Array(K);
        const trueRank = new Int32Array(K);
        const idxByDepth = new Int32Array(K);
        const idxByOrder = new Int32Array(K);
        const localPose = () => {
            const inv = inst.meshInstance.node.getWorldTransform().clone().invert();
            const node = scene.camera.mainCamera;
            const d = node.getWorldTransform().getZ().clone();
            const o = d.clone();
            inv.transformVector(d, o);
            const p = node.getWorldTransform().getTranslation().clone();
            const q = p.clone();
            inv.transformPoint(p, q);
            return { pos: q, dir: o.normalize() };
        };
        const dispOf = (orderArr, pos, dir) => {
            const n = orderArr.length;
            let seed = 123456789;
            for (let i = 0; i < K; i++) {
                seed = (seed * 1103515245 + 12345) & 0x7fffffff;
                samplePos[i] = seed % n;
            }
            for (let i = 0; i < K; i++) {
                const v = orderArr[samplePos[i]];
                depth[i] = (cx[v] - pos.x) * dir.x + (cy[v] - pos.y) * dir.y + (cz[v] - pos.z) * dir.z;
            }
            for (let i = 0; i < K; i++) {
                idxByDepth[i] = i;
                idxByOrder[i] = i;
            }
            idxByDepth.sort((a, b) => depth[a] - depth[b]);
            idxByOrder.sort((a, b) => samplePos[a] - samplePos[b]);
            for (let r = 0; r < K; r++) {
                curRank[idxByOrder[r]] = r;
                trueRank[idxByDepth[r]] = r;
            }
            let f = 0;
            let rv = 0;
            for (let i = 0; i < K; i++) {
                f += Math.abs(trueRank[i] - curRank[i]);
                rv += Math.abs((K - 1 - trueRank[i]) - curRank[i]);
            }
            return Math.min(f, rv) / K / (K - 1);
        };
        const dispNow = (orderArr) => {
            try {
                const { pos, dir } = localPose();
                return dispOf(orderArr, pos, dir);
            } catch (e) {
                return -1;
            }
        };

        // ---- 采集：三个口径 ----------------------------------------------------------------
        //   consume：帧即将使用新顺序的那一刻（每个排序周期里的**最优点**）
        //   reply  ：worker 回包那一刻（比 consume 略新）
        //   timer  ：每 200 ms 随机相位采样（**典型帧**，含"一个周期末尾、新顺序还没来"的最差点）
        //            —— 这个口径才和历史头条数字（0.156 @375°/s）可比
        let samplesConsume = [];     // { t, disp }
        let samplesReply = [];       // { t, disp }
        let samplesTimer = [];       // { t, disp }
        let phaseMark = 0;

        const realApply = ws.applyPendingSorted.bind(ws);
        ws.applyPendingSorted = () => {
            // 这一帧将要用的就是 pendingSorted 里的顺序；此刻量到的 disp == 屏幕上会看到的错位
            if (ws.pendingSorted) {
                const d = dispNow(new Uint32Array(ws.orderData));
                samplesConsume.push({ t: performance.now() - phaseMark, disp: d });
            }
            return realApply();
        };
        ws.on('updated', () => {
            if (ws.orderData) {
                const d = dispNow(new Uint32Array(ws.orderData));
                samplesReply.push({ t: performance.now() - phaseMark, disp: d });
            }
        });
        let timerOn = true;
        const timerLoop = () => {
            if (!timerOn) {
                return;
            }
            if (ws.orderData) {
                samplesTimer.push({ t: performance.now() - phaseMark, disp: dispNow(new Uint32Array(ws.orderData)) });
            }
            setTimeout(timerLoop, 200);
        };
        setTimeout(timerLoop, 200);

        const pick = (arr, p) => (arr.length ? +arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))].toFixed(3) : null);
        const stat = (arr) => {
            const v = arr.filter(x => x >= 0);
            return { n: v.length, p50: pick(v, 0.5), p95: pick(v, 0.95), max: v.length ? +Math.max(...v).toFixed(3) : null };
        };

        const cam = scene.camera;
        const spin = async (ms, dir) => {
            const t0 = performance.now();
            let stop = false;
            const loop = () => {
                scene.forceRender = true;
                if (!stop) requestAnimationFrame(loop);
            };
            requestAnimationFrame(loop);
            while (performance.now() - t0 < ms) {
                cam.setAzimElev(cam.azim + dir * degPerFrame, cam.elevation, 0);
                await sleep2(16);
            }
            stop = true;
        };

        const runOne = async (label, tune, predict) => {
            window.__SPLATROOM_SORT_PREDICT__ = predict;
            window.__SPLATROOM_SORT_TUNE__ = tune;
            samplesConsume = [];
            samplesReply = [];
            samplesTimer = [];
            phaseMark = performance.now();

            await spin(1400, +1);                       // 收敛：速度窗 + 两个 EMA
            samplesConsume = [];
            samplesReply = [];
            samplesTimer = [];
            const tMeasure = performance.now() - phaseMark;
            await spin(steadyMs, +1);                   // 恒速段（样本数 = steadyMs / 排序周期）
            const steadyC = samplesConsume.filter(s => s.t >= tMeasure).map(s => s.disp);
            const steadyR = samplesReply.filter(s => s.t >= tMeasure).map(s => s.disp);
            const steadyT = samplesTimer.filter(s => s.t >= tMeasure).map(s => s.disp);

            // 反向段：量"换向之后 600 ms 内"的错位（长窗口在这里必然滞后）
            const tRev = performance.now() - phaseMark;
            samplesConsume = [];
            samplesTimer = [];
            await spin(1400, -1);
            const revC = samplesConsume.filter(s => s.t >= tRev && s.t < tRev + 600).map(s => s.disp);
            const revT = samplesTimer.filter(s => s.t >= tRev && s.t < tRev + 600).map(s => s.disp);

            return {
                label,
                predict,
                tune,
                latencyMs: +splat._sortLatencyMs.toFixed(1),
                consumeMs: +splat._sortConsumeMs.toFixed(1),
                consumeSamples: splat._sortConsumeSamples,
                horizonMs: +splat._sortPredictHorizon().toFixed(1),
                steadyConsume: stat(steadyC),
                steadyReply: stat(steadyR),
                steadyTimer: stat(steadyT),
                reverseConsume: stat(revC),
                reverseTimer: stat(revT)
            };
        };

        const coreConfigs = [
            ['predict OFF（参考）', {}, false],
            ['旧版：窗120 / 不算第二步', { windowMs: 120, consumeWeight: 0, extraMs: 0 }, true],
            ['双步：窗120 / 权重1', { windowMs: 120, consumeWeight: 1, extraMs: 0 }, true],
            ['双步：窗120 / 权重1 / +15ms', { windowMs: 120, consumeWeight: 1, extraMs: 15 }, true],
            ['长窗：窗200 / 权重1', { windowMs: 200, consumeWeight: 1, extraMs: 0 }, true]
        ];
        const extraConfigs = [
            ['长窗：窗300 / 权重1', { windowMs: 300, consumeWeight: 1, extraMs: 0 }, true],
            ['长窗：窗300 / 权重1 / +15ms', { windowMs: 300, consumeWeight: 1, extraMs: 15 }, true],
            ['窗200 / 权重1 / 半步(0.5)', { windowMs: 200, consumeWeight: 0.5, extraMs: 0 }, true]
        ];
        const configs = (set === 'all' ? coreConfigs.concat(extraConfigs) : coreConfigs)
            .filter(([label]) => !only || only.split(',').some(tok => tok && label.includes(tok)));

        const results = [];
        for (const [label, tune, predict] of configs) {
            results.push(await runOne(label, tune, predict));
        }

        // 复原
        delete window.__SPLATROOM_SORT_TUNE__;
        delete window.__SPLATROOM_SORT_PREDICT__;
        await sleep2(1200);
        const settled = { disp: dispNow(new Uint32Array(ws.orderData)) };

        return { degPerFrame, set, steadyMs, only, settled, results };
    }, [DEG, SET, STEADY_MS, ONLY]);

    console.log(JSON.stringify({ model: MODEL, url: URL, ...out, errors: errs.slice(0, 5) }, null, 1));
    await browser.close();
    process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ fatal: String(e).slice(0, 400) })); process.exit(1); });
