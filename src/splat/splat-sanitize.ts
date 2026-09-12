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
    const lin = Math.exp(Math.max(s0, s1, s2));
    if (lin <= diag * GIANT_SCALE_RATIO) return false;
    if (Math.abs(dc0) + Math.abs(dc1) + Math.abs(dc2) >= GREY_DC_EPS) return false;
    if (Math.abs(op) >= GREY_OPACITY_EPS) return false;
    return true;
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

/** Count giant-grey splats. Cheap single pass; call before offering removal. */
export const detectGiantGreySplats = (data: GSplatData): GiantSplatReport => {
    const N = data.numSplats;
    const p = getProps(data);
    if (!p.x || !p.y || !p.z || !p.s0 || !p.s1 || !p.s2 || !p.dc0 || !p.dc1 || !p.dc2 || !p.op) {
        return { total: N, giantGrey: 0, diag: 0, removable: false };
    }
    const diag = sceneDiagonal(p.x, p.y, p.z);
    let giantGrey = 0;
    for (let i = 0; i < N; i++) {
        if (isGiantGrey(p.s0[i], p.s1[i], p.s2[i], p.dc0[i], p.dc1[i], p.dc2[i], p.op[i], diag)) {
            giantGrey++;
        }
    }
    return { total: N, giantGrey, diag, removable: giantGrey > N * MIN_REMOVE_FRACTION };
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
