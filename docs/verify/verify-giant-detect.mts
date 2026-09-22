// 纯 node 单测：巨型灰高斯检测（`src/splat/splat-sanitize.ts`）。
//
// 为什么单独钉它（第十九/二十轮）：这份统计原来跑在主线程、要全表扫（1.35 亿那档抽稀后 6000 万行，
// 实测占掉约 1.2 s 的一段阻塞）。第二十轮把它搬进了**导入 worker**（`detectGiantGreyFromColumns`），
// 顺手还把 `Math.exp` 挪到判定链的最后（省掉 99% 的 exp）。两处改动都必须**逐位保持判定语义**，
// 所以这里用一份**独立参考实现**（照文档规则重写，不复用生产代码）做对照。
//
// usage: node --experimental-strip-types docs/verify/verify-giant-detect.mts
import { detectGiantGreyFromColumns } from '../../src/splat/splat-sanitize.ts';

const checks: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

const GIANT_SCALE_RATIO = 0.005;
const GREY_DC_EPS = 0.01;
const GREY_OPACITY_EPS = 0.1;
const MIN_REMOVE_FRACTION = 0.05;

/** 独立参考实现：照 `splat-sanitize.ts` 头部的三条规则重写（故意不复用生产代码） */
const referenceDetect = (cols: {
    x: Float32Array, y: Float32Array, z: Float32Array,
    s0: Float32Array, s1: Float32Array, s2: Float32Array,
    dc0: Float32Array, dc1: Float32Array, dc2: Float32Array, op: Float32Array
}, n: number) => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
        minX = Math.min(minX, cols.x[i]); maxX = Math.max(maxX, cols.x[i]);
        minY = Math.min(minY, cols.y[i]); maxY = Math.max(maxY, cols.y[i]);
        minZ = Math.min(minZ, cols.z[i]); maxZ = Math.max(maxZ, cols.z[i]);
    }
    const diag = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2);
    let giantGrey = 0;
    for (let i = 0; i < n; i++) {
        const lin = Math.exp(Math.max(cols.s0[i], cols.s1[i], cols.s2[i]));
        const isGiant = lin > diag * GIANT_SCALE_RATIO;
        const isGrey = Math.abs(cols.dc0[i]) + Math.abs(cols.dc1[i]) + Math.abs(cols.dc2[i]) < GREY_DC_EPS;
        const isFaint = Math.abs(cols.op[i]) < GREY_OPACITY_EPS;
        if (isGiant && isGrey && isFaint) {
            giantGrey++;
        }
    }
    return { total: n, giantGrey, diag, removable: giantGrey > n * MIN_REMOVE_FRACTION };
};

/** 造一批列：`giantEvery` 为 0 表示不种巨型灰；否则每隔这么多行种一个 */
const makeColumns = (n: number, giantEvery = 0) => {
    const f = () => new Float32Array(n);
    const cols = {
        x: f(), y: f(), z: f(),
        s0: f(), s1: f(), s2: f(),
        dc0: f(), dc1: f(), dc2: f(), op: f()
    };
    for (let i = 0; i < n; i++) {
        // 场景是 10×10×10，对角线 ≈ 17.32 ⇒ 巨型阈值 = 0.0866
        cols.x[i] = (i % 100) / 10;
        cols.y[i] = ((i * 7) % 100) / 10;
        cols.z[i] = ((i * 13) % 100) / 10;
        const logScale = Math.log(0.01);            // 线性 1 cm：正常高斯
        cols.s0[i] = logScale;
        cols.s1[i] = logScale;
        cols.s2[i] = logScale;
        cols.dc0[i] = 0.5;                          // 有颜色（不是灰）
        cols.dc1[i] = 0.4;
        cols.dc2[i] = 0.3;
        cols.op[i] = 2.0;                           // 不透明
    }
    if (giantEvery > 0) {
        for (let i = 0; i < n; i += giantEvery) {
            const big = Math.log(2.0);              // 线性 2 m ⇒ 远超阈值
            cols.s0[i] = big; cols.s1[i] = big; cols.s2[i] = big;
            cols.dc0[i] = 0.001; cols.dc1[i] = 0.001; cols.dc2[i] = 0.001;   // 中性灰
            cols.op[i] = 0.02;                                              // 半透明
        }
    }
    return cols;
};

// ---- 1. 与独立参考实现逐位一致 ----
for (const [n, every] of [[200, 0], [200, 10], [1000, 25], [1000, 21]] as const) {
    const cols = makeColumns(n, every);
    const mine = detectGiantGreyFromColumns({
        x: cols.x, y: cols.y, z: cols.z,
        s0: cols.s0, s1: cols.s1, s2: cols.s2,
        dc0: cols.dc0, dc1: cols.dc1, dc2: cols.dc2, op: cols.op
    }, n);
    const ref = referenceDetect(cols, n);
    check(`matches the reference implementation (n=${n}, planted every ${every || '—'})`,
        mine.giantGrey === ref.giantGrey && mine.removable === ref.removable &&
        Math.abs(mine.diag - ref.diag) < 1e-6 && mine.total === ref.total,
        `giantGrey=${mine.giantGrey}（参考 ${ref.giantGrey}）、diag=${mine.diag.toFixed(3)}、` +
        `removable=${mine.removable}（参考 ${ref.removable}）`);
}

// ---- 2. `removable` 的阈值语义：> 5% 才算 ----
const below = detectGiantGreyFromColumns((() => {
    const c = makeColumns(1000, 0);
    for (let i = 0; i < 49; i++) {   // 4.9% < 5%
        const big = Math.log(2.0);
        c.s0[i] = big; c.s1[i] = big; c.s2[i] = big;
        c.dc0[i] = 0; c.dc1[i] = 0; c.dc2[i] = 0; c.op[i] = 0;
    }
    return { x: c.x, y: c.y, z: c.z, s0: c.s0, s1: c.s1, s2: c.s2, dc0: c.dc0, dc1: c.dc1, dc2: c.dc2, op: c.op };
})(), 1000);
const above = detectGiantGreyFromColumns((() => {
    const c = makeColumns(1000, 0);
    for (let i = 0; i < 51; i++) {   // 5.1% > 5%
        const big = Math.log(2.0);
        c.s0[i] = big; c.s1[i] = big; c.s2[i] = big;
        c.dc0[i] = 0; c.dc1[i] = 0; c.dc2[i] = 0; c.op[i] = 0;
    }
    return { x: c.x, y: c.y, z: c.z, s0: c.s0, s1: c.s1, s2: c.s2, dc0: c.dc0, dc1: c.dc1, dc2: c.dc2, op: c.op };
})(), 1000);
check('removable only when the matching fraction is above 5%',
    below.giantGrey === 49 && below.removable === false && above.giantGrey === 51 && above.removable === true,
    `4.9% ⇒ removable=${below.removable}（${below.giantGrey}/1000）；5.1% ⇒ removable=${above.removable}（${above.giantGrey}/1000）`);

// ---- 3. 判定链顺序换了，但"三个条件缺一不可"的语义没变 ----
const orderCase = (() => {
    const c = makeColumns(4, 0);
    const big = Math.log(2.0);
    // ① 巨型 + 灰 + 半透明（命中）
    c.s0[0] = big; c.s1[0] = big; c.s2[0] = big; c.dc0[0] = 0; c.dc1[0] = 0; c.dc2[0] = 0; c.op[0] = 0;
    // ② 巨型 + 有颜色（不命中：颜色这条否掉）
    c.s0[1] = big; c.s1[1] = big; c.s2[1] = big; c.dc0[1] = 1; c.dc1[1] = 0; c.dc2[1] = 0; c.op[1] = 0;
    // ③ 巨型 + 灰 + 不透明（不命中：透明度这条否掉）
    c.s0[2] = big; c.s1[2] = big; c.s2[2] = big; c.dc0[2] = 0; c.dc1[2] = 0; c.dc2[2] = 0; c.op[2] = 3;
    // ④ **灰 + 半透明但很小**（不命中：尺寸这条否掉 —— 这正是"exp 挪到最后"要走的快路径）
    c.dc0[3] = 0; c.dc1[3] = 0; c.dc2[3] = 0; c.op[3] = 0;
    return detectGiantGreyFromColumns({
        x: c.x, y: c.y, z: c.z, s0: c.s0, s1: c.s1, s2: c.s2, dc0: c.dc0, dc1: c.dc1, dc2: c.dc2, op: c.op
    }, 4);
})();
check('all three conditions are still required (giant AND grey AND faint)',
    orderCase.giantGrey === 1,
    `4 行里只有第 1 行命中（巨型+灰+半透明）⇒ giantGrey=${orderCase.giantGrey}`);

// ---- 4. 尺寸阈值 = 0.5% 对角线，且是严格比较（两侧各留 0.01% 余量，避免浮点边界抖动）----
const boundary = (() => {
    const c = makeColumns(2, 0);
    // 用**这批列真实的**对角线（别用假设值 —— 第一版按 sqrt(300) 写，实际只有 17.147，
    // 于是"正好卡在阈值上"那行也算成了巨型，测试自己错了）
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < 2; i++) {
        minX = Math.min(minX, c.x[i]); maxX = Math.max(maxX, c.x[i]);
        minY = Math.min(minY, c.y[i]); maxY = Math.max(maxY, c.y[i]);
        minZ = Math.min(minZ, c.z[i]); maxZ = Math.max(maxZ, c.z[i]);
    }
    const diag = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2);
    const threshold = diag * GIANT_SCALE_RATIO;
    c.s0[0] = Math.log(threshold * 0.9999); c.s1[0] = c.s0[0]; c.s2[0] = c.s0[0];   // 略小于阈值
    c.s0[1] = Math.log(threshold * 1.0001); c.s1[1] = c.s0[1]; c.s2[1] = c.s0[1];   // 略大于阈值
    for (const i of [0, 1]) { c.dc0[i] = 0; c.dc1[i] = 0; c.dc2[i] = 0; c.op[i] = 0; }
    return {
        report: detectGiantGreyFromColumns({
            x: c.x, y: c.y, z: c.z, s0: c.s0, s1: c.s1, s2: c.s2, dc0: c.dc0, dc1: c.dc1, dc2: c.dc2, op: c.op
        }, 2),
        diag,
        threshold
    };
})();
check('the size threshold is 0.5% of the scene diagonal (just below ⇒ not a giant, just above ⇒ giant)',
    boundary.report.giantGrey === 1 && Math.abs(boundary.report.diag - boundary.diag) < 1e-6,
    `对角线 ${boundary.diag.toFixed(3)} ⇒ 阈值 ${boundary.threshold.toFixed(4)}；` +
    `99.99% 阈值 → 不算、100.01% → 算 ⇒ giantGrey=${boundary.report.giantGrey}`);

// ---- 5. 缺列 ⇒ 直接给"没有巨型灰"，不炸 ----
const missing = detectGiantGreyFromColumns({
    x: new Float32Array(10), y: new Float32Array(10), z: new Float32Array(10),
    s0: new Float32Array(10), s1: new Float32Array(10), s2: new Float32Array(10),
    dc0: new Float32Array(10), dc1: new Float32Array(10), dc2: new Float32Array(10),
    op: null
}, 10);
check('a missing column yields a safe empty report (no giant scan, nothing removable)',
    missing.total === 10 && missing.giantGrey === 0 && missing.diag === 0 && missing.removable === false,
    `opacity 缺失 ⇒ ${JSON.stringify(missing)}`);

const failed = checks.filter(c => !c.pass).length;
console.log(JSON.stringify({ checks, failed }, null, 1));
process.exit(failed === 0 ? 0 : 1);
