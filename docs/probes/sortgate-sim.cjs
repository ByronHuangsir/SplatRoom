// P0-2 判据状态机的离线仿真：把 splat.ts 里那段分支逻辑原样搬过来，
// 用合成时间线回放，检查四种典型场景不会出现"该派不派 / 不该派乱派 / 停手永不补帧"。
// 用法：node sortgate-sim.cjs
const MIN = 100;   // SORT_MIN_INTERVAL_MS
const SETTLE = 150; // SORT_SETTLE_MS

// splat.ts 的逻辑（逐行对应）
const run = (frames, label) => {
    let lastDispatch = 0;
    let settleAt = 0;
    const dispatches = [];
    // frames: [{ t, moved }]
    for (const f of frames) {
        const now = f.t;
        if (f.moved) {
            if (now - lastDispatch >= MIN) {
                lastDispatch = now;
                settleAt = 0;
                dispatches.push({ t: now, why: 'interval' });
            } else if (settleAt === 0) {
                settleAt = now + SETTLE;
            }
        } else if (settleAt !== 0 && now >= settleAt) {
            settleAt = 0;
            lastDispatch = now;
            dispatches.push({ t: now, why: 'settle' });
        }
    }
    return { label, dispatches, count: dispatches.length };
};

const timeline = (pattern, from, to, step = 16) => {
    const frames = [];
    for (let t = from; t < to; t += step) {
        frames.push({ t, moved: pattern(t) });
    }
    return frames;
};

const results = [];

// 1) 连续运动 2 秒：派发次数应 ≈ 2000/100 = 20（而不是 125 帧）
const moving = run(timeline(() => true, 0, 2000), '连续运动 2 秒（每帧都在动）');
results.push({ ...moving, expect: '≈20 次（2000ms/100ms），且全部是 interval 派发' });

// 2) 运动 400ms 后停：应有一次 settle 补帧（且只补一次）
const stopAfter = run(timeline((t) => t < 400, 0, 1200), '运动 400ms → 静止 800ms');
results.push({ ...stopAfter, expect: 'interval 派发 + 恰好 1 次 settle 补帧' });

// 3) 完全静止 2 秒：一次都不该派
const idle = run(timeline(() => false, 0, 2000), '完全静止 2 秒');
results.push({ ...idle, expect: '0 次' });

// 4) 极短抖动（单帧移动 + 长静止）：应有 1 次 interval 派发，且不重复补帧
const jitter = run([{ t: 0, moved: true }, ...timeline(() => false, 16, 2000)], '单帧抖动 → 静止');
results.push({ ...jitter, expect: '1 次（interval 就已用最新位姿，settle 应被清掉，不再补）' });

// 5) 慢速拖拽（每 3 帧动一次，共 1 秒）：派发次数应 ≈ 10
const slow = run(timeline((t) => Math.floor(t / 48) % 2 === 0, 0, 1000), '慢速拖拽 1 秒（每 3 帧动一次）');
results.push({ ...slow, expect: '≈10 次' });

// 6) 抖动式运动（动 5 帧停 1 帧，总 2 秒）：不能出现"每帧都派"
const jittery = run(timeline((t) => Math.floor(t / 16) % 6 !== 5, 0, 2000), '抖动式运动 2 秒（动 5 帧停 1 帧）');
results.push({ ...jittery, expect: '≈20 次，且不出现每帧派发' });

console.log(JSON.stringify(results.map(r => ({
    label: r.label,
    dispatches: r.count,
    interval: r.dispatches.filter(d => d.why === 'interval').length,
    settle: r.dispatches.filter(d => d.why === 'settle').length,
    firstFew: r.dispatches.slice(0, 4).map(d => `${d.t}ms/${d.why}`),
    expect: r.expect
})), null, 2));
