// O1 探针：选区变更到底触发了多少次 GPU 包围盒 pass，以及一次推杆的真实延迟。
//
// 为什么需要它：`docs/audit/01-量级复查-perf.md` 的 O1 说"每次推杆省一帧 + 4 次同步回读"，
// 但那个数字是用"推杆端到端耗时"反推的 —— 端到端里还混着掩码/区间/状态位/flush 这些 O(n) 的活。
// 这里把两件事分开量：
//   ① `Splat.updateLocalBounds` 的**调用次数与总耗时**（实例上包一层，只统计，不改行为）；
//   ② 一次推杆的**状态落地延迟** —— `fire('selection.setScreenRange')` 到 `splat.stateChanged`
//      的那一刻（那就是"画面该变色了"的时刻）。
//
// 用法：node docs/probes/o1-bound-probe.cjs [model] [url]
//   model 必须是 dist 下的文件名，默认 test-model.ply；
//   T1 档先 `copy D:\DeepSeek\SplatRoomV2\_tmp\scan.ply dist\scan.ply`，跑完**记得删掉**（否则会进 asar）。
const puppeteer = require('C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const MODEL = process.argv[2] || 'test-model.ply';
const URL = process.argv[3] || 'http://localhost:3621/?gpu=webgpu';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'], protocolTimeout: 1800000 });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    page.on('pageerror', e => console.log('[pageerror] ' + String(e).slice(0, 200)));
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 90000 });
    await sleep(1500);
    await page.evaluate(async (m) => {
        const buf = await (await fetch('./' + m)).arrayBuffer();
        await window.scene.events.invoke('import', [{ filename: m, contents: new File([buf], m) }]);
    }, MODEL);
    await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 900000 });
    await sleep(8000);

    const out = await page.evaluate(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const scene = window.scene;
        const splat = scene.getElementsByType('splat').slice(-1)[0];
        scene.events.fire('selection', splat);
        await sleep(600);
        scene.events.fire('camera.focus');
        await sleep(3000);
        scene.events.fire('tool.rectSelection');
        await sleep(600);
        scene.events.fire('selection.resetRange');
        await sleep(300);

        // ---- 只统计不改行为：把实例上的 updateLocalBounds 包一层 ----
        const stat = { calls: 0, ms: 0 };
        const orig = splat.updateLocalBounds.bind(splat);
        splat.updateLocalBounds = async function (...args) {
            const t = performance.now();
            try {
                return await orig(...args);
            } finally {
                stat.calls++;
                stat.ms += performance.now() - t;
            }
        };

        // ---- 状态落地延迟：fire 之后到 splat.stateChanged 的间隔 ----
        // 一次只发一杆、等它落地再发下一杆：否则前一次还在飞的时候 firedAt 会被
        // 下一次覆盖，量出来的延迟会偏小（第一版就踩了这个）。
        let firedAt = 0;
        let onLanded = null;
        const latencies = [];
        scene.events.on('splat.stateChanged', () => {
            if (firedAt) latencies.push(performance.now() - firedAt);
            const cb = onLanded;
            onLanded = null;
            if (cb) cb();
        });
        const countSelected = () => {
            const st = splat.splatData.getProp('state');
            let n = 0;
            for (let i = 0; i < st.length; i++) if (st[i] & 1) n++;
            return n;
        };

        const tGesture = performance.now();
        await scene.events.invoke('select.rect', 'set', { start: { x: 0.35, y: 0.35 }, end: { x: 0.65, y: 0.65 } });
        const gestureMs = Math.round(performance.now() - tGesture);
        // 手势自身的 pass 与后续补算都算清（停手补算是 setTimeout 120ms 后）
        await sleep(1500);
        const gestureBounds = { calls: stat.calls, ms: Math.round(stat.ms) };

        // 一次"拖动"：连推 12 次，一杆落地再发下一杆（模拟滑块 change 事件的节奏）
        stat.calls = 0;
        stat.ms = 0;
        latencies.length = 0;
        const base = countSelected();
        const t0 = performance.now();
        for (let k = 0; k < 12; k++) {
            const landed = new Promise(res => { onLanded = res; });
            firedAt = performance.now();
            scene.events.fire('selection.setScreenRange', { x: { low: 0.4 + k * 0.2 } });
            await landed;
            await sleep(60);
        }
        const pushWallMs = performance.now() - t0;
        // 停手后等补算（BOUND_SETTLE_MS = 120ms + 一次 pass）
        await sleep(1200);
        const select = countSelected();
        firedAt = 0;

        // 直接量一次包围盒 pass 的**纯耗时**（审计 01-量级复查-perf.md §5 "最需要先测的三个数" 之一：
        // 13M 上一次 calcBound.run() 到底是 25ms 还是 90ms）。延迟 5 杆，吃尾部的稳定性。
        const rawPass = [];
        for (let k = 0; k < 5; k++) {
            const t = performance.now();
            await orig();
            rawPass.push(+(performance.now() - t).toFixed(1));
            await sleep(50);
        }

        return {
            numSplats: splat.splatData.numSplats,
            gestureMs,
            gestureBounds,
            drag: {
                pushes: 12,
                wallMs: Math.round(pushWallMs),
                boundCalls: stat.calls,
                boundMs: Math.round(stat.ms),
                latencyAvg: latencies.length ? +(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2) : null,
                latencyMax: latencies.length ? +Math.max(...latencies).toFixed(2) : null,
                latencyN: latencies.length,
                selectedBefore: base,
                selectedAfter: select
            },
            rawPass
        };
    });

    console.log(`--- O1 probe: model=${MODEL} splats=${out.numSplats} ---`);
    console.log(`gesture (select.rect)            : ${out.gestureMs} ms  [bound pass ${out.gestureBounds.calls}x / ${out.gestureBounds.ms} ms]`);
    console.log(`12-push drag (serialized)        : wall ${out.drag.wallMs} ms`);
    console.log(`  bound passes during the drag   : ${out.drag.boundCalls}x / ${out.drag.boundMs} ms`);
    console.log(`  push -> state landing latency  : avg ${out.drag.latencyAvg} ms, max ${out.drag.latencyMax} ms (n=${out.drag.latencyN})`);
    console.log(`  selection ${out.drag.selectedBefore} -> ${out.drag.selectedAfter}`);
    console.log(`  isolated bound pass (n=5)      : ${out.rawPass.join(', ')} ms`);
    await browser.close();
})().catch(e => { console.log('FATAL ' + String(e).slice(0, 300)); process.exit(1); });
