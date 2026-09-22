// 纯 node 单测：包围盒的"逐行镜像引擎"实现（`src/core/splat-aabb.ts`）。
//
// 为什么必须钉死（第二十二轮）：导入时引擎构造 `GSplatResource` 会无条件全表算一遍 AABB
// （6000 万行实测 2.2 s，全在主线程），我们改成**在 worker 里按同一算法先算好**、主线程只填结果。
// 包围盒会参与取景 / 裁剪 / 网格 instance 的 `_aabb` ⇒ **必须与引擎逐位一致**，
// 所以这里用一份**照引擎源码重写的参考实现**（`node_modules/playcanvas/build/playcanvas.mjs`
// 的 `GSplatData.calcAabb`）做对照，并把两个坑位（非有限值跳过、全跳过时不改动）都覆盖。
//
// usage: node --experimental-strip-types docs/verify/verify-splat-aabb.mts
import { computeSplatAabb, type SplatAabb } from '../../src/core/splat-aabb.ts';

const checks: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

/** 参考实现：照引擎 `calcAabb` 重写（故意不复用生产代码） */
const reference = (
    x: Float32Array, y: Float32Array, z: Float32Array,
    s0: Float32Array, s1: Float32Array, s2: Float32Array,
    n: number, activated: boolean
): SplatAabb | null => {
    let mx = 0, my = 0, mz = 0, Mx = 0, My = 0, Mz = 0;
    let first = true;
    for (let i = 0; i < n; i++) {
        const px = x[i], py = y[i], pz = z[i];
        const scale2 = Math.max(s0[i], s1[i], s2[i]);
        if (!isFinite(px) || !isFinite(py) || !isFinite(pz) || !isFinite(scale2)) {
            continue;
        }
        const sv = 2 * (activated ? scale2 : Math.exp(scale2));
        if (first) {
            first = false;
            mx = px - sv; my = py - sv; mz = pz - sv;
            Mx = px + sv; My = py + sv; Mz = pz + sv;
        } else {
            mx = Math.min(mx, px - sv); my = Math.min(my, py - sv); mz = Math.min(mz, pz - sv);
            Mx = Math.max(Mx, px + sv); My = Math.max(My, py + sv); Mz = Math.max(Mz, pz + sv);
        }
    }
    return first ? null : {
        center: [(mx + Mx) * 0.5, (my + My) * 0.5, (mz + Mz) * 0.5],
        halfExtents: [(Mx - mx) * 0.5, (My - my) * 0.5, (Mz - mz) * 0.5]
    };
};

const same = (a: SplatAabb | null, b: SplatAabb | null) => {
    if (!a || !b) {
        return a === b;
    }
    return a.center.every((v, i) => v === b.center[i]) && a.halfExtents.every((v, i) => v === b.halfExtents[i]);
};

const make = (n: number) => ({
    x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n),
    s0: new Float32Array(n), s1: new Float32Array(n), s2: new Float32Array(n)
});

// ---- 1. 与参考实现逐位一致（随机数据）----
let mismatch = 0;
let sample: string = '';
for (let trial = 0; trial < 20; trial++) {
    const n = 37 + trial * 13;
    const c = make(n);
    for (let i = 0; i < n; i++) {
        c.x[i] = Math.sin(i * 0.7) * 5;
        c.y[i] = Math.cos(i * 1.3) * 3;
        c.z[i] = Math.sin(i * 2.1) * 7;
        c.s0[i] = Math.log(0.01 + (i % 5) * 0.004);
        c.s1[i] = Math.log(0.008 + (i % 3) * 0.005);
        c.s2[i] = Math.log(0.012 + (i % 7) * 0.002);
    }
    const mine = computeSplatAabb({ x: c.x, y: c.y, z: c.z, s0: c.s0, s1: c.s1, s2: c.s2 }, n, false);
    const ref = reference(c.x, c.y, c.z, c.s0, c.s1, c.s2, n, false);
    if (!same(mine, ref)) {
        mismatch++;
        sample = `n=${n}: mine=${JSON.stringify(mine)} ref=${JSON.stringify(ref)}`;
    }
}
check('matches the reference implementation bit-for-bit across 20 random scenes',
    mismatch === 0,
    mismatch === 0 ? '20 组随机数据（n=37…284）逐位一致（center 与 halfExtents 都按 === 比较）' : sample);

// ---- 2. 逐行语义：scale 用 exp（activated=false），且用 max(s0,s1,s2) ----
const one = make(1);
one.x[0] = 1; one.y[0] = 2; one.z[0] = 3;
one.s0[0] = Math.log(0.5); one.s1[0] = Math.log(2.0); one.s2[0] = Math.log(0.25);
const single = computeSplatAabb({ x: one.x, y: one.y, z: one.z, s0: one.s0, s1: one.s1, s2: one.s2 }, 1, false);
check('uses exp(max(scale_0..2)) as the per-splat radius (not the raw log value, not the min)',
    // 注意容差：scale 存在 Float32Array 里，log→exp 往返会有 ~1e-8 的相对误差
    // （实测光秃秃的 4.0000000076），所以用相对容差而不是 1e-9
    !!single &&
    Math.abs(single.halfExtents[0] - 4) < 1e-6 &&
    Math.abs(single.center[0] - 1) < 1e-9 &&
    Math.abs(single.center[1] - 2) < 1e-9 &&
    Math.abs(single.center[2] - 3) < 1e-9,
    single ? `一个 scale=log(0.5)/log(2)/log(0.25) 的高斯 ⇒ 半径 ${single.halfExtents[0]}（=2×2.0，浮点往返误差 ~1e-8）、中心 [${single.center.join(', ')}]` : 'null');

// ---- 3. 非有限值整行跳过（与引擎一致），全跳过时返回 null（不改动 result）----
const dirty = make(4);
dirty.x[0] = 0; dirty.y[0] = 0; dirty.z[0] = 0;
dirty.x[1] = NaN; dirty.y[1] = 0; dirty.z[1] = 0;
dirty.x[2] = 0; dirty.y[2] = 0; dirty.z[2] = 0;
dirty.x[3] = 0; dirty.y[3] = 0; dirty.z[3] = 0;
for (const i of [0, 1, 2, 3]) {
    dirty.s0[i] = Math.log(1); dirty.s1[i] = Math.log(1); dirty.s2[i] = Math.log(1);
}
dirty.s1[2] = NaN;                       // scale 非有限 ⇒ 整行跳过
const dirtyBox = computeSplatAabb({ x: dirty.x, y: dirty.y, z: dirty.z, s0: dirty.s0, s1: dirty.s1, s2: dirty.s2 }, 4, false);
check('rows with a non-finite position or scale are skipped entirely (like the engine)',
    !!dirtyBox &&
    Math.abs(dirtyBox.halfExtents[0] - 2) < 1e-9 &&
    Math.abs(dirtyBox.halfExtents[1] - 2) < 1e-9 &&
    Math.abs(dirtyBox.halfExtents[2] - 2) < 1e-9,
    dirtyBox ? `4 行里 2 行含 NaN（位置 1 行、scale 1 行）⇒ 盒子只由有效行决定：半径 ${dirtyBox.halfExtents.join('/')}` : 'null');

const allBad = make(2);
allBad.x[0] = NaN; allBad.x[1] = Infinity;
for (const i of [0, 1]) {
    allBad.s0[i] = 0; allBad.s1[i] = 0; allBad.s2[i] = 0;
    allBad.y[i] = 0; allBad.z[i] = 0;
}
const emptyBox = computeSplatAabb({ x: allBad.x, y: allBad.y, z: allBad.z, s0: allBad.s0, s1: allBad.s1, s2: allBad.s2 }, 2, false);
check('when every row is skipped the report is null (meaning "leave the box alone", like the engine)',
    emptyBox === null,
    `全 NaN/Infinity ⇒ ${JSON.stringify(emptyBox)}（` + 'null' + ' 是我们的调用方"别覆盖"的信号）');

// ---- 4. 缺列 ⇒ null（调用方回退让引擎自己算）----
const missing = computeSplatAabb({ x: new Float32Array(4), y: new Float32Array(4), z: new Float32Array(4), s0: null, s1: new Float32Array(4), s2: new Float32Array(4) }, 4, false);
check('a missing scale column yields null so the caller falls back to the engine',
    missing === null,
    `scale_0 缺失 ⇒ ${JSON.stringify(missing)}`);

// ---- 5. activated=true 时不取 exp（引擎的另一个分支；我们的导入数据走 false）----
const act = make(1);
act.x[0] = 0; act.y[0] = 0; act.z[0] = 0;
act.s0[0] = 0.5; act.s1[0] = 0.25; act.s2[0] = 0.1;
const actBox = computeSplatAabb({ x: act.x, y: act.y, z: act.z, s0: act.s0, s1: act.s1, s2: act.s2 }, 1, true);
check('activated=true uses the raw scale (the engine has this branch; our imports use false)',
    !!actBox && Math.abs(actBox.halfExtents[0] - 2 * 0.5) < 1e-9,
    actBox ? `activated=true、scale=0.5 ⇒ 半径 ${actBox.halfExtents[0]}（不做 exp）` : 'null');

const failed = checks.filter(c => !c.pass).length;
console.log(JSON.stringify({ checks, failed }, null, 1));
process.exit(failed === 0 ? 0 : 1);
