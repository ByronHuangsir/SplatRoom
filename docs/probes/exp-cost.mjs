// 纯 node 微基准：引擎逐行打包里那几百万次 `Math.exp` 值多少（第二十三轮，评估用）。
//
// 背景：`SplatIterator.read` 在 `activated === false` 时对每个高斯算 3 次 `Math.exp`（scale），
// `updateColorData` 再算 1 次（opacity 的 sigmoid）—— 6000 万行就是 2.4 亿次 exp。
// 有人会想"把 opacity/scale 预激活（worker 里算好）、再把 `gsplatData.activated = true`"，
// 本脚本就是量这个想法的**上限**：同一批数据、同样的循环，只差那 4 次 exp。
//
// 用法：node docs/probes/exp-cost.mjs [rows]        默认 6e7（= 1.35 亿那只抽稀后的行数）
const N = Number(process.argv[2] || 60_000_000);

// 造数据：scale 用 log 空间（与真实 PLY 一致），位置随机
const x = new Float32Array(N);
const s0 = new Float32Array(N);
const s1 = new Float32Array(N);
const s2 = new Float32Array(N);
const op = new Float32Array(N);
for (let i = 0; i < N; i++) {
    x[i] = Math.sin(i * 0.0001) * 10;
    s0[i] = Math.log(0.01 + (i % 7) * 0.001);
    s1[i] = Math.log(0.009 + (i % 5) * 0.001);
    s2[i] = Math.log(0.011 + (i % 3) * 0.001);
    op[i] = Math.sin(i * 0.0003) * 2;
}

const outA = new Uint16Array(N * 4);       // 假装是引擎的 transformB 纹理
const outB = new Uint16Array(N * 4);

const timeIt = (fn, label) => {
    const t0 = process.hrtime.bigint();
    const sink = fn();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`${label.padEnd(34)} ${ms.toFixed(0).padStart(6)} ms   (sink=${sink})`);
    return ms;
};

let acc = 0;
// ① 现状：每行 3 次 exp（scale）+ 1 次 exp（opacity sigmoid）
const withExp = timeIt(() => {
    for (let i = 0; i < N; i++) {
        const a = Math.exp(s0[i]);
        const b = Math.exp(s1[i]);
        const c = Math.exp(s2[i]);
        const d = 1 / (1 + Math.exp(-op[i]));
        outA[i * 4] = (a * 1000) & 0xffff;
        outB[i * 4] = (b * 1000) & 0xffff;
        outA[i * 4 + 1] = (c * 1000) & 0xffff;
        outB[i * 4 + 1] = (d * 1000) & 0xffff;
    }
    return N;
}, `现状：3×exp(scale) + sigmoid(opacity)`);

// ② 预激活：列里已经是线性值 ⇒ 一次 exp 都不用
const act0 = new Float32Array(N);
const act1 = new Float32Array(N);
const act2 = new Float32Array(N);
const actOp = new Float32Array(N);
for (let i = 0; i < N; i++) {
    act0[i] = Math.exp(s0[i]);
    act1[i] = Math.exp(s1[i]);
    act2[i] = Math.exp(s2[i]);
    actOp[i] = 1 / (1 + Math.exp(-op[i]));
}
const noExp = timeIt(() => {
    for (let i = 0; i < N; i++) {
        const a = act0[i];
        const b = act1[i];
        const c = act2[i];
        const d = actOp[i];
        outA[i * 4] = (a * 1000) & 0xffff;
        outB[i * 4] = (b * 1000) & 0xffff;
        outA[i * 4 + 1] = (c * 1000) & 0xffff;
        outB[i * 4 + 1] = (d * 1000) & 0xffff;
    }
    return N;
}, `预激活：0 次 exp（列已是线性值）`);

// ③ 转折成本：**预激活本身**要在 worker 里跑一遍（同一批 exp，只是换到另一个线程）
const pre = timeIt(() => {
    for (let i = 0; i < N; i++) {
        act0[i] = Math.exp(s0[i]);
        act1[i] = Math.exp(s1[i]);
        act2[i] = Math.exp(s2[i]);
        actOp[i] = 1 / (1 + Math.exp(-op[i]));
    }
    return N;
}, `预激活那一趟本身（worker 里跑）`);

console.log(JSON.stringify({
    rows: N,
    withExpMs: Math.round(withExp),
    noExpMs: Math.round(noExp),
    preActivateMs: Math.round(pre),
    savingMs: Math.round(withExp - noExp),
    savingPct: +((100 * (withExp - noExp)) / withExp).toFixed(1),
    verdict: '这就是"预激活"能省下的**上限**（主线程那 4 次 exp）；预激活本身 = 同样的 exp 换到 worker 跑'
}, null, 1));
