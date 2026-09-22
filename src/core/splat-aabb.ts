/**
 * 高斯场景的轴对齐包围盒 —— **逐行镜像引擎的实现**（`GSplatData.calcAabb`）。
 *
 * 为什么要自己算（第二十二轮）：`GSplatResource` 的构造函数里**无条件**调用
 * `gsplatData.calcAabb(this.aabb)`，那是一趟全表扫描（读 x/y/z + scale_0..2 并做 `Math.exp`），
 * 1.35 亿那档（抽稀后 6000 万行）实测 **2.2 s**，占掉导入残留阻塞的 21%。
 * 而同一批列在导入 worker 里就有 —— 在那边顺手算一遍（不占主线程），
 * 主线程构造资源时把 `calcAabb` 临时指到"直接填这个盒子"，构造完再还原。
 *
 * **必须与引擎逐位一致**（包围盒会参与取景/裁剪/网格 instance 的 `_aabb`）：
 * 引擎的算法是（`node_modules/playcanvas/build/playcanvas.mjs` 的 `calcAabb`）：
 * ```
 * scale2 = max(scale_0[i], scale_1[i], scale_2[i])
 * 若 x/y/z/scale2 任一非有限 ⇒ 跳过该行
 * scaleVal = 2 * (activated ? scale2 : exp(scale2))      // 我们的数据 activated=false
 * 用 px±scaleVal 逐行扩 min/max；全被跳过时**不改动 result**
 * center = (min+max)/2 ; halfExtents = (max-min)/2
 * ```
 * 纯函数、不依赖 playcanvas ⇒ 可以在 node 里单测（`docs/verify/verify-splat-aabb.mts`）。
 */

export interface SplatAabbColumns {
    x: Float32Array | null;
    y: Float32Array | null;
    z: Float32Array | null;
    s0: Float32Array | null;
    s1: Float32Array | null;
    s2: Float32Array | null;
}

/** 与引擎 `BoundingBox` 的 center/halfExtents 同形（结构化克隆友好） */
export interface SplatAabb {
    center: [number, number, number];
    halfExtents: [number, number, number];
}

/**
 * 按引擎的算法算包围盒。
 *
 * @param cols - x/y/z 与 scale_0..2（任一缺失 ⇒ 返回 `null`）
 * @param count - 行数
 * @param activated - 对应引擎的 `GSplatData.activated`（我们的导入数据一律 `false`）
 * @returns 盒子；**没有任何有效行时返回 `null`**（引擎那种情况下不改动 result，行为等价于"别覆盖"）
 */
export const computeSplatAabb = (
    cols: SplatAabbColumns, count: number, activated = false
): SplatAabb | null => {
    const { x, y, z, s0, s1, s2 } = cols;
    if (!x || !y || !z || !s0 || !s1 || !s2) {
        return null;
    }
    let mx = 0;
    let my = 0;
    let mz = 0;
    let Mx = 0;
    let My = 0;
    let Mz = 0;
    let first = true;
    for (let i = 0; i < count; i++) {
        const px = x[i];
        const py = y[i];
        const pz = z[i];
        const scale2 = Math.max(s0[i], s1[i], s2[i]);
        if (!isFinite(px) || !isFinite(py) || !isFinite(pz) || !isFinite(scale2)) {
            continue;
        }
        const scaleVal = 2 * (activated ? scale2 : Math.exp(scale2));
        if (first) {
            first = false;
            mx = px - scaleVal;
            my = py - scaleVal;
            mz = pz - scaleVal;
            Mx = px + scaleVal;
            My = py + scaleVal;
            Mz = pz + scaleVal;
        } else {
            mx = Math.min(mx, px - scaleVal);
            my = Math.min(my, py - scaleVal);
            mz = Math.min(mz, pz - scaleVal);
            Mx = Math.max(Mx, px + scaleVal);
            My = Math.max(My, py + scaleVal);
            Mz = Math.max(Mz, pz + scaleVal);
        }
    }
    if (first) {
        return null;
    }
    return {
        center: [(mx + Mx) * 0.5, (my + My) * 0.5, (mz + Mz) * 0.5],
        halfExtents: [(Mx - mx) * 0.5, (My - my) * 0.5, (Mz - mz) * 0.5]
    };
};
