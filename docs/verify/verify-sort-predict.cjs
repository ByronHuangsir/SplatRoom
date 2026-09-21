// 顺序延迟补偿（`SORT_PREDICT_*`，见 src/splat/splat.ts）的回归套件。
//
// 背景：修掉"派发路径死掉"之后用户复报"快速旋转依然错位、短暂停留就消失"。剩下的一半是
// **顺序延迟**：派发时用的是当下位姿，而一次全量排序要 λ 毫秒才落地，这段时间相机又转过了 ω·λ。
// 修法是派发时把位姿外推到落地时刻（`SORT_PREDICT_*`，量化见
// docs/perf/交互期降级-实现与实测.md §6.9 与 docs/probes/sort-lag.cjs）。
//
// 本套件断言的是**机制本身**（小夹具即可，不需要 20M）：
//   1. 旋转中派发给 worker 的相机方向 == 解析上的 Rodrigues 外推（用当次的速度估计与 horizon
//      自己算一遍）—— 这同时验证了"补偿生效""外推量正确""方向没写反"
//   2. 外推的旋转方向就是转动方向（`cross(cur, posted)·rotRate > 0`）
//   3. 派发方向仍是单位向量（Rodrigues 保长度）
//   4. λ（= horizon）落在合理区间、速度估计无 NaN
//   5. 停手补帧那一次**不**外推（静止帧要精确）
//   6. `window.__SPLATROOM_SORT_PREDICT__ = false` 关掉补偿
//
// 为什么用"与解析值比较"而不是"领先了几度"：小夹具上 λ 只有几毫秒，"领先角"本身就接近 0，
// 阈值型断言会变成"夹具越快越容易假红"。解析比较与夹具速度无关。
//
// 证据采集是**重试式**的：小夹具上派发受 200 ms 下限与 2.5° 转角门限约束，且套件常与其他套件
// 串跑（机器忙 ⇒ 帧少 ⇒ 派发少），所以每个阶段最多重试 3 次、每次转 4 s，直到拿到证据；
// 拿不到就带着帧数/闸门状态等诊断信息报红（而不是以"0 个样本"这种无法定位原因的方式失败）。
//
// usage: node docs/verify/verify-sort-predict.cjs "<url>" [model]
const path = require('path');
const puppeteer = require(path.join(__dirname, '..', '..', 'node_modules', 'puppeteer-core'));

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
    });
    const errors = [];
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1500);

    await page.evaluate(async (m) => {
        const buf = await (await fetch('./' + m)).arrayBuffer();
        window.__loadErr = null;
        window.scene.events.invoke('import', [{ filename: m, contents: new File([buf], m) }])
            .catch((e) => { window.__loadErr = String(e).slice(0, 200); });
    }, MODEL);

    for (let i = 0; i < 60; i++) {
        await sleep(1000);
        const st = await page.evaluate(() => ({
            n: window.scene.getElementsByType('splat').length,
            err: window.__loadErr
        }));
        if (st.n > 0) break;
        if (st.err) throw new Error(st.err);
    }
    await sleep(2500);

    // 装钩子：记录每次发给 worker 的相机方向、同一时刻的真实方向，以及**解析上的期望值**
    // （用当次的速度估计与 horizon 自己算一遍 Rodrigues 外推）。断言"实现 == 解析期望"，
    // 比断言"领先了几度"稳：小夹具上 λ 只有几毫秒，"领先角"本来就接近 0。
    await page.evaluate(() => {
        const scene = window.scene;
        const splat = scene.getElementsByType('splat').slice(-1)[0];
        const inst = splat.entity.gsplat.instance;
        const ws = inst.sorter;
        const localDir = () => {
            const inv = inst.meshInstance.node.getWorldTransform().clone().invert();
            const d = scene.camera.mainCamera.getWorldTransform().getZ().clone();
            const o = d.clone();
            inv.transformVector(d, o);
            return o.normalize();
        };
        const ang = (a, b) => {
            const dot = Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y + a.z * b.z));
            return (Math.acos(dot) * 180) / Math.PI;
        };
        // 与 src/splat/splat.ts 的 _predictSortPose 同一套数学（阈值 0.5° 也照抄）
        const expectedDir = (cur, rotRate, horizon) => {
            const rlen = Math.hypot(rotRate.x, rotRate.y, rotRate.z);
            const angle = rlen * horizon;
            if (!(angle > (0.5 * Math.PI) / 180)) {
                return { x: cur.x, y: cur.y, z: cur.z };
            }
            const nx = rotRate.x / rlen;
            const ny = rotRate.y / rlen;
            const nz = rotRate.z / rlen;
            const c = Math.cos(angle);
            const s = Math.sin(angle);
            const d = nx * cur.x + ny * cur.y + nz * cur.z;
            const x = cur.x * c + (ny * cur.z - nz * cur.y) * s + nx * d * (1 - c);
            const y = cur.y * c + (nz * cur.x - nx * cur.z) * s + ny * d * (1 - c);
            const z = cur.z * c + (nx * cur.y - ny * cur.x) * s + nz * d * (1 - c);
            const len = Math.hypot(x, y, z);
            return { x: x / len, y: y / len, z: z / len };
        };
        window.__posts = [];
        window.__frames = 0;
        scene.events.on('prerender', () => { window.__frames++; });
        const real = ws.worker.postMessage.bind(ws.worker);
        ws.worker.postMessage = (msg, ...rest) => {
            if (msg && msg.cameraDirection) {
                const cur = localDir();
                const rotRate = { x: splat._sortRotRate.x, y: splat._sortRotRate.y, z: splat._sortRotRate.z };
                const horizon = splat._sortPredictHorizon();
                window.__posts.push({
                    posted: { x: msg.cameraDirection.x, y: msg.cameraDirection.y, z: msg.cameraDirection.z },
                    cur: { x: cur.x, y: cur.y, z: cur.z },
                    rotRate,
                    horizon,
                    aheadDeg: ang(cur, msg.cameraDirection),
                    expectedErrDeg: ang(expectedDir(cur, rotRate, horizon), msg.cameraDirection),
                    len: Math.hypot(msg.cameraDirection.x, msg.cameraDirection.y, msg.cameraDirection.z),
                    t: performance.now()
                });
            }
            return real(msg, ...rest);
        };
        window.__diag = () => ({
            frames: window.__frames,
            moving: scene.cameraMotion.moving,
            lastDispatchAgeMs: Math.round(performance.now() - splat._sortLastDispatch),
            pendingSinceNonZero: splat._sortPendingSince !== 0,
            latencyMs: +splat._sortLatencyMs.toFixed(1),
            horizonMs: +splat._sortPredictHorizon().toFixed(1),
            engaged: scene.motionQuality.engaged,
            renderScale: scene.motionQuality.renderScale
        });
    });

    // 旋转：本应用按需渲染，程序化的 setAzimElev 不会把场景标脏 ⇒ 必须每帧 forceRender，
    // 否则 onPreRender（运动检测、闸门、外推都在里面）根本不会跑。
    const rotate = (ms, degPerStep = 6) => page.evaluate(async ([duration, step]) => {
        const cam = window.scene.camera;
        const scene = window.scene;
        const t0 = performance.now();
        let stop = false;
        const loop = () => {
            scene.forceRender = true;
            if (!stop) requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
        while (performance.now() - t0 < duration) {
            cam.setAzimElev(cam.azim + step, cam.elevation, 0);
            await new Promise((r) => setTimeout(r, 16));
        }
        stop = true;
    }, [ms, degPerStep]);

    const checks = [];
    const check = (name, pass, detail) => checks.push({ name, pass, detail });

    // 旋转并采集派发证据（最多 3 次、每次 4 s；拿不到也要留下可诊断的细节）
    const collectRotating = async (ms = 4000) => {
        let posts = [];
        let diag = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            await page.evaluate(() => { window.__posts.length = 0; });
            const spin = rotate(ms);
            await sleep(500);
            posts = await page.evaluate(() => window.__posts.slice());
            diag = await page.evaluate(() => window.__diag());
            await spin;
            await sleep(200);
            if (posts.length > 0) break;
        }
        return { posts, diag };
    };

    // 停手后应当补一帧干净排序（也重试：每次"转一下 + 停 1.5 s"）
    const collectSettle = async () => {
        let posts = [];
        for (let attempt = 0; attempt < 3; attempt++) {
            await page.evaluate(() => { window.__posts.length = 0; });
            await sleep(1500);
            posts = await page.evaluate(() => window.__posts.slice());
            if (posts.length > 0) break;
            await rotate(1200);
        }
        return posts;
    };

    try {
        // 先静止一会儿，让 λ 有一个样本（否则 horizon 还是初值 200 ms）
        await sleep(700);

        // ---- 1/2/3/4: 旋转中补偿生效 ----
        const spinPhase = await collectRotating();
        const rotating = spinPhase.posts;
        const comp = rotating.filter(p => p.aheadDeg > 0.05);
        const maxExpectedErr = rotating.length ? Math.max(...rotating.map(p => p.expectedErrDeg)) : 999;
        const lenErr = rotating.length ? Math.max(...rotating.map(p => Math.abs(p.len - 1))) : 1;
        const maxAhead = rotating.length ? Math.max(...rotating.map(p => p.aheadDeg)) : 0;
        const d = spinPhase.diag;

        check('rotating: the dispatched pose matches the analytic Rodrigues extrapolation',
            rotating.length > 0 && maxExpectedErr < 0.05,
            `posts=${rotating.length} compensated=${comp.length} maxErrVsAnalytic=${maxExpectedErr.toFixed(4)}deg ` +
            `(maxAhead=${maxAhead.toFixed(2)}deg, frames=${d.frames}, lastDispatchAge=${d.lastDispatchAgeMs}ms, moving=${d.moving})`);
        check('rotating: the extrapolated direction is still a unit vector',
            rotating.length > 0 && lenErr < 1e-3,
            `posts=${rotating.length} max |len-1| = ${lenErr.toExponential(2)}`);
        check('rotating: horizon is the measured sort latency and stays bounded',
            d.horizonMs > 0 && d.horizonMs <= 600 && Number.isFinite(d.latencyMs),
            `latency=${d.latencyMs} ms horizon=${d.horizonMs} ms`);
        const rates = rotating.map(p => p.rotRate).filter(Boolean);
        const finiteRates = rates.length > 0 && rates.every(r => [r.x, r.y, r.z].every(Number.isFinite));
        const lastRate = rates.length ? rates[rates.length - 1] : null;
        check('rotating: the velocity estimate is finite (no NaN from a degenerate axis)',
            finiteRates,
            `samples=${rates.length} last=[${lastRate ? [lastRate.x, lastRate.y, lastRate.z].map(v => v.toExponential(2)).join(', ') : 'n/a'}]`);

        // 领先方向必须是"转动方向"（不是反的）：外推的旋转轴与速度估计的轴同向。
        // 判据：cross(cur, posted) 与 rotRate 的点积 > 0（角度太小时判据无意义，跳过并说明）。
        let signOk = null;
        let signDetail = 'no compensated post captured while rotating';
        const big = comp.filter(p => p.aheadDeg > 0.2);
        if (big.length) {
            const p = big[big.length - 1];
            const cx = p.cur.y * p.posted.z - p.cur.z * p.posted.y;
            const cy = p.cur.z * p.posted.x - p.cur.x * p.posted.z;
            const cz = p.cur.x * p.posted.y - p.cur.y * p.posted.x;
            const dot = cx * p.rotRate.x + cy * p.rotRate.y + cz * p.rotRate.z;
            signOk = dot > 0;
            signDetail = `cross(cur, posted)·rotRate = ${dot.toExponential(2)} (must be > 0; ahead=${p.aheadDeg.toFixed(2)}deg)`;
        }
        check('rotating: the extrapolation points along the direction of travel', signOk === true, signDetail);

        // 双步外推的第二步必须真的在采样：回包 → 被某帧消费的实测延迟要折进 horizon。
        // 少了这一截，顺序会系统性落后"一个帧长"（20M 上实测 ~10~35 ms，375°/s 就是 4~13°）。
        // 见 docs/perf/交互期降级-实现与实测.md §6.12
        const consume = await page.evaluate(() => {
            const splat = window.scene.getElementsByType('splat').slice(-1)[0];
            return {
                ms: splat._sortConsumeMs,
                samples: splat._sortConsumeSamples,
                horizon: splat._sortPredictHorizon(),
                latency: splat._sortLatencyMs
            };
        });
        check('rotating: the second-step (reply -> consumed-on-screen) latency is sampled into the horizon',
            consume.samples > 0 && consume.ms >= 0 && consume.ms <= 100 && consume.horizon >= consume.latency,
            `consume=${consume.ms.toFixed(1)}ms (samples=${consume.samples}) latency=${consume.latency.toFixed(1)}ms ` +
            `horizon=${consume.horizon.toFixed(1)}ms`);

        // ---- 5: 停手补帧不外推 ----
        const settlePosts = await collectSettle();
        const settleLast = settlePosts.length ? settlePosts[settlePosts.length - 1] : null;
        check('settled: the settle-time sort is NOT extrapolated (exact pose)',
            settleLast !== null && settleLast.aheadDeg < 1.0,
            `settle posts=${settlePosts.length} aheadDeg=${settleLast ? settleLast.aheadDeg.toFixed(3) : 'n/a'} ` +
            `horizon=${settleLast ? settleLast.horizon.toFixed(1) : 'n/a'}ms`);

        // ---- 6: 逃生开关 ----
        await page.evaluate(() => { window.__SPLATROOM_SORT_PREDICT__ = false; });
        const offPhase = await collectRotating();
        const maxOff = offPhase.posts.length ? Math.max(...offPhase.posts.map(p => p.aheadDeg)) : null;
        check('window.__SPLATROOM_SORT_PREDICT__ = false disables the compensation',
            maxOff !== null && maxOff < 1.0,
            `posts=${offPhase.posts.length} maxAheadDeg=${maxOff === null ? 'n/a' : maxOff.toFixed(3)} ` +
            `(frames=${offPhase.diag.frames}, lastDispatchAge=${offPhase.diag.lastDispatchAgeMs}ms)`);
        await page.evaluate(() => { delete window.__SPLATROOM_SORT_PREDICT__; });

        await sleep(500);
    } catch (e) {
        check('suite ran without throwing', false, String(e).slice(0, 200));
    }

    console.log(JSON.stringify({ checks, failed: checks.filter((c) => !c.pass).length, errors: errors.slice(0, 5) }, null, 1));
    await browser.close();
    process.exit(0);
})().catch((e) => {
    console.log(JSON.stringify({ fatal: String(e).slice(0, 400) }));
    process.exit(1);
});
