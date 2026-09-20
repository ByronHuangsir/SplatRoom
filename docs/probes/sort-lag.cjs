// 顺序延迟补偿（`SORT_PREDICT_*`，见 src/splat/splat.ts）的量化验证。
//
// 直接量"顺序离正确深度顺序有多远"，而不是量时间：
//   取 K 个样点（固定种子），把它们**在当前生效的排序表里**的次序、与它们**按当前相机算出的
//   真实深度次序**各排一次，两者的平均归一化秩差就是 `disp`：
//     disp = 0     完全正确（停手补帧后的画面应接近 0）
//     disp ≈ 0.33  与随机排序无异
//   这正是"背面内容跑到前面"的直接度量（局部逆序 = 该遮挡的没遮挡）。
//
// 参考点：`settledDisp`（停手后的补帧）必须接近 0 —— 它同时验证了这套度量本身是有效的。
// 然后在同样的快速旋转下比较 基线（不做延迟补偿）与 补偿（外推到落地时刻）。
//
// 用法：node docs/probes/sort-lag.cjs "<url>" [model] [seconds]
// 环境变量 SORT_LAG_MODE=baseline|predict|both（默认 both，同一个页面里先后测一遍）
//          SORT_LAG_DEG_PER_FRAME=6（默认；2 ≈ 125°/s 的"正常拖拽"，6 ≈ 375°/s 的"猛甩"）
const path = require('path');
const REPO = path.join(__dirname, '..', '..');
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-20m-fill.ply';
const SECONDS = parseFloat(process.argv[4] || '3');
const MODE = process.env.SORT_LAG_MODE || 'both';
const DEG_PER_FRAME = parseFloat(process.env.SORT_LAG_DEG_PER_FRAME || '6');
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

    const out = await page.evaluate(async ([seconds, mode, degPerFrame]) => {
        const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
        const scene = window.scene;
        const splat = scene.getElementsByType('splat').slice(-1)[0];
        scene.events.fire('selection', splat);
        await sleep2(500);
        scene.events.fire('camera.focus');
        await sleep2(4000);

        const inst = splat.entity.gsplat.instance;
        const ws = inst.sorter;

        // 主相机的局部位姿（与派发给 worker 的 cameraPosition/cameraDirection 同一坐标系）
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

        // ---- 顺序误差度量 -------------------------------------------------------------------
        //
        // ⚠️ 不能读 `sorter.centers`：引擎在 `GSplatSorter.init()` 里把 centers 的 buffer **transfer**
        // 给 worker 了，主线程那份已经是 detached（length 0）⇒ 读出来全 undefined、深度全 NaN、
        // 度量退化成"随机"（第一版就是这么错的：连 settle 之后都读到 0.19）。
        // 正确做法：排序表里的**值**就是 splatData 的原始下标（着色器就是拿它取数的），
        // 所以对"排序表位置 p"取它的值 v = order[p]，再用 splatData 的第 v 个中心算深度。
        const K = 4000;
        const data = splat.splatData;
        const cx = data.getProp('x');
        const cy = data.getProp('y');
        const cz = data.getProp('z');
        const samplePos = new Int32Array(K);
        const depth = new Float32Array(K);
        const curRank = new Int32Array(K);
        const trueRank = new Int32Array(K);
        const idxByDepth = new Int32Array(K);
        const idxByOrder = new Int32Array(K);

        const measure = () => {
            const orderArr = new Uint32Array(ws.orderData);      // 当前生效的排序表
            const n = orderArr.length;
            const { pos, dir } = localPose();
            // 固定种子、均匀抽"排序表里的位置"（避免每次测到不同的样点集）
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
            // 归一化平均秩差；两个排序方向都试（引擎"由远及近"的约定换版本可能翻），取小的那个
            let dFwd = 0;
            let dRev = 0;
            for (let i = 0; i < K; i++) {
                dFwd += Math.abs(trueRank[i] - curRank[i]);
                dRev += Math.abs((K - 1 - trueRank[i]) - curRank[i]);
            }
            return Math.min(dFwd, dRev) / K / (K - 1);
        };
        const measureSafe = () => {
            try {
                return measure();
            } catch (e) {
                return -1;
            }
        };

        // ---- 派发/落地簿记（顺带报告延迟 λ）--------------------------------------------------
        const real = ws.worker.postMessage.bind(ws.worker);
        const pending = [];
        let posts = 0;
        ws.worker.postMessage = (msg, ...rest) => {
            if (msg && msg.cameraDirection) {
                posts++;
                pending.push(performance.now());
                if (pending.length > 4) pending.shift();
            }
            return real(msg, ...rest);
        };
        const latencies = [];
        ws.on('updated', () => {
            const t = pending.shift();
            if (t !== undefined) latencies.push(performance.now() - t);
        });

        // 帧成本
        const deltas = [];
        let last = performance.now();
        let stop = false;
        const loop = () => {
            const now = performance.now();
            deltas.push(now - last);
            last = now;
            scene.forceRender = true;
            if (!stop) requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);

        const pick = (arr, p) => (arr.length ? +arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))].toFixed(3) : null);
        const cam = scene.camera;

        // 参考点：停手、让补帧落地之后的顺序误差（度量有效性自检，应接近 0）
        await sleep2(1200);
        const settledDisp = measureSafe();

        const runOne = async (predict) => {
            window.__SPLATROOM_SORT_PREDICT__ = predict;
            latencies.length = 0;
            // 先转 1 秒让速度估计（120 ms 窗口）收敛
            const warm = performance.now();
            while (performance.now() - warm < 1000) {
                cam.setAzimElev(cam.azim + degPerFrame, cam.elevation, 0);
                await sleep2(16);
            }
            latencies.length = 0;
            const disps = [];
            const t0 = performance.now();
            let nextSample = 0;
            while (performance.now() - t0 < seconds * 1000) {
                cam.setAzimElev(cam.azim + degPerFrame, cam.elevation, 0);
                await sleep2(16);
                // 旋转中每隔 200 ms 量一次（量本身要读 20M 的顺序表，别每帧都做）
                if (performance.now() - t0 >= nextSample) {
                    nextSample += 200;
                    disps.push(measureSafe());
                }
            }
            return {
                predict,
                samples: disps.length,
                dispP50: pick(disps, 0.5),
                dispP95: pick(disps, 0.95),
                dispMax: disps.length ? +Math.max(...disps).toFixed(3) : null,
                latencyMsP50: pick(latencies, 0.5)
            };
        };

        const runs = [];
        if (mode === 'baseline' || mode === 'both') runs.push(await runOne(false));
        if (mode === 'predict' || mode === 'both') runs.push(await runOne(true));
        // 收尾：停手后应当回到 ~0
        await sleep2(1500);
        const restoreDisp = measureSafe();
        stop = true;
        await sleep2(300);

        deltas.shift();
        const sorted = deltas.slice().sort((a, b) => a - b);
        const fpick = (p) => (sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(1) : null);
        const pct = (a, b) => (a ? +(((a - b) / a) * 100).toFixed(1) : null);

        return {
            posts,
            samplesPerRun: runs.length ? runs[0].samples : 0,
            settledDisp,
            runs,
            restoreDisp,
            dispDropPercent: runs.length === 2 ? pct(runs[0].dispP50, runs[1].dispP50) : null,
            frames: sorted.length,
            frameP50: fpick(0.5),
            frameP95: fpick(0.95)
        };
    }, [SECONDS, MODE, DEG_PER_FRAME]);

    console.log(JSON.stringify({ model: MODEL, seconds: SECONDS, mode: MODE, degPerFrame: DEG_PER_FRAME, ...out, errors: errs.slice(0, 5) }, null, 1));
    await browser.close();
    process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ fatal: String(e).slice(0, 400) })); process.exit(1); });
