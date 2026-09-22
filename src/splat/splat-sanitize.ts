import { GSplatData } from 'playcanvas';

/**
 * Sanitizer for "giant grey splat" artifacts.
 *
 * Some edit pipelines (surface flattening / planar fix on dense scans) can
 * leave behind a layer of *uninitialized* gaussians: neutral grey colour
 * (f_dc ≈ 0 → linear RGB 0.5), half-transparent (opacity ≈ 0 → sigmoid 0.5)
 * and absurdly large (linear scale >> scene size). Rendering millions of those
 * explodes fragment fill-rate: every one of them covers a large screen area
 * and must still be depth-sorted + blended → GPU timeout (monitor black
 * screen / driver TDR) → WebGL context lost (blank white UI). A real-world
 * case: a 6.08M-splat file where 5M splats (82%) formed one such layer.
 *
 * Detection is deliberately conservative so real large splats are never
 * touched: a splat is only flagged when ALL of the following hold —
 *   - linear max scale > GIANT_SCALE_RATIO × scene diagonal (0.5%);
 *   - |f_dc_0|+|f_dc_1|+|f_dc_2| < GREY_DC_EPS (neutral grey, uninitialized);
 *   - |opacity| < GREY_OPACITY_EPS (raw logit ≈ 0 → ~50% alpha).
 */

const GIANT_SCALE_RATIO = 0.005;   // detection: linear max scale > 0.5% of scene diagonal
const SHRINK_SCALE_RATIO = 0.001;  // shrink target: linear max scale = 0.1% of diagonal
const GREY_DC_EPS = 0.01;          // |f_dc_0|+|f_dc_1|+|f_dc_2| below this = neutral grey
const GREY_OPACITY_EPS = 0.1;      // |opacity| (logit) below this = ~half transparent
const MIN_REMOVE_FRACTION = 0.05;  // only offer removal when > 5% of splats match

const isGiantGrey = (
    s0: number, s1: number, s2: number,
    dc0: number, dc1: number, dc2: number,
    op: number, diag: number
): boolean => {
    // 判定顺序 = 语义不变（三个条件是与关系），但**把 `Math.exp` 挪到最后**：
    // 巨型灰高斯是极少数，绝大多数行会在前两个廉价比较就被否掉，于是省掉 99% 的 exp
    // （6000 万行那档实测能省掉几百毫秒，见 docs/导入残留阻塞-归因与LOD时机-2026-09-22.md）
    if (Math.abs(dc0) + Math.abs(dc1) + Math.abs(dc2) >= GREY_DC_EPS) return false;
    if (Math.abs(op) >= GREY_OPACITY_EPS) return false;
    return Math.exp(Math.max(s0, s1, s2)) > diag * GIANT_SCALE_RATIO;
};

export interface GiantSplatReport {
    total: number;
    giantGrey: number;
    diag: number;
    /** True when enough splats match that removing them is worth offering. */
    removable: boolean;
}

const getProps = (data: GSplatData) => ({
    x: data.getProp('x') as Float32Array | null,
    y: data.getProp('y') as Float32Array | null,
    z: data.getProp('z') as Float32Array | null,
    s0: data.getProp('scale_0') as Float32Array | null,
    s1: data.getProp('scale_1') as Float32Array | null,
    s2: data.getProp('scale_2') as Float32Array | null,
    dc0: data.getProp('f_dc_0') as Float32Array | null,
    dc1: data.getProp('f_dc_1') as Float32Array | null,
    dc2: data.getProp('f_dc_2') as Float32Array | null,
    op: data.getProp('opacity') as Float32Array | null
});

const sceneDiagonal = (x: Float32Array, y: Float32Array, z: Float32Array): number => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const N = x.length;
    for (let i = 0; i < N; i++) {
        if (x[i] < minX) minX = x[i];
        if (x[i] > maxX) maxX = x[i];
        if (y[i] < minY) minY = y[i];
        if (y[i] > maxY) maxY = y[i];
        if (z[i] < minZ) minZ = z[i];
        if (z[i] > maxZ) maxZ = z[i];
    }
    return Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2);
};

/** 巨型灰高斯的判定所需的全部列（`null` = 这一列不存在，直接跳过检测） */
export interface GiantDetectColumns {
    x: Float32Array | null;
    y: Float32Array | null;
    z: Float32Array | null;
    s0: Float32Array | null;
    s1: Float32Array | null;
    s2: Float32Array | null;
    dc0: Float32Array | null;
    dc1: Float32Array | null;
    dc2: Float32Array | null;
    op: Float32Array | null;
}

/**
 * 按列检测（第十九/二十轮）：**这份实现是纯函数、不依赖 GSplatData**，
 * 所以它既能跑在主线程（回退路径），也能跑在**导入 worker** 里 —— worker 已经握着物化好的列，
 * 顺手统计一遍就把主线程的"逐行扫描"整段搬走了（1.35 亿那档原来占主线程约 1.2 s）。
 */
export const detectGiantGreyFromColumns = (p: GiantDetectColumns, total: number): GiantSplatReport => {
    if (!p.x || !p.y || !p.z || !p.s0 || !p.s1 || !p.s2 || !p.dc0 || !p.dc1 || !p.dc2 || !p.op) {
        return { total, giantGrey: 0, diag: 0, removable: false };
    }
    const diag = sceneDiagonal(p.x, p.y, p.z);
    let giantGrey = 0;
    for (let i = 0; i < total; i++) {
        if (isGiantGrey(p.s0[i], p.s1[i], p.s2[i], p.dc0[i], p.dc1[i], p.dc2[i], p.op[i], diag)) {
            giantGrey++;
        }
    }
    return { total, giantGrey, diag, removable: giantGrey > total * MIN_REMOVE_FRACTION };
};

/** Count giant-grey splats. Cheap single pass; call before offering removal. */
export const detectGiantGreySplats = (data: GSplatData): GiantSplatReport => {
    return detectGiantGreyFromColumns(getProps(data), data.numSplats);
};

/**
 * Rebuild the GSplatData without the giant-grey splats. Returns the new data
 * plus the number removed. The input data is left untouched.
 */
export const removeGiantGreySplats = (data: GSplatData, report: GiantSplatReport): { data: GSplatData, removed: number } => {
    const N = data.numSplats;
    const p = getProps(data);
    if (!p.x || !p.y || !p.z || !p.s0 || !p.s1 || !p.s2 || !p.dc0 || !p.dc1 || !p.dc2 || !p.op) {
        return { data, removed: 0 };
    }
    // Reuse the caller's diag when available; recompute otherwise.
    const diag = report.diag > 0 ? report.diag : sceneDiagonal(p.x, p.y, p.z);

    const keep = new Uint8Array(N);
    let kept = 0;
    for (let i = 0; i < N; i++) {
        const drop = isGiantGrey(p.s0[i], p.s1[i], p.s2[i], p.dc0[i], p.dc1[i], p.dc2[i], p.op[i], diag);
        keep[i] = drop ? 0 : 1;
        if (!drop) kept++;
    }

    const element = data.getElement('vertex');
    const properties = element.properties.map((prop: any) => {
        const src = prop.storage as Float32Array;
        const Ctor = (src as any).constructor as new (n: number) => Float32Array;
        const dst = new Ctor(kept);
        let w = 0;
        for (let i = 0; i < N; i++) {
            if (keep[i]) dst[w++] = src[i];
        }
        return {
            type: prop.type,
            name: prop.name,
            byteSize: prop.byteSize,
            storage: dst
        };
    });

    const out = new GSplatData([{ name: 'vertex', count: kept, properties }], (data as any).comments?.slice());
    return { data: out, removed: N - kept };
};

/**
 * Shrink the giant-grey splats' scale in place (no rebuild, no data loss):
 * all three axes are shifted by the same log amount so the ellipsoid shape is
 * preserved while its max axis lands on `diag * SHRINK_SCALE_RATIO`. This
 * keeps the "background ball" coverage the user wants while bringing the
 * fragment fill-rate back to a sane level. Returns the number shrunk.
 */
export const shrinkGiantGreySplats = (data: GSplatData, report: GiantSplatReport): number => {
    const N = data.numSplats;
    const p = getProps(data);
    if (!p.x || !p.y || !p.z || !p.s0 || !p.s1 || !p.s2 || !p.dc0 || !p.dc1 || !p.dc2 || !p.op) {
        return 0;
    }
    const diag = report.diag > 0 ? report.diag : sceneDiagonal(p.x, p.y, p.z);
    const shrinkLog = Math.log(diag * SHRINK_SCALE_RATIO);
    let shrunk = 0;
    for (let i = 0; i < N; i++) {
        const mx = Math.max(p.s0[i], p.s1[i], p.s2[i]);
        if (mx <= shrinkLog) continue;
        if (!isGiantGrey(p.s0[i], p.s1[i], p.s2[i], p.dc0[i], p.dc1[i], p.dc2[i], p.op[i], diag)) continue;
        const delta = shrinkLog - mx;
        p.s0[i] += delta;
        p.s1[i] += delta;
        p.s2[i] += delta;
        shrunk++;
    }
    return shrunk;
};
