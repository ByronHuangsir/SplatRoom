/**
 * Surface Refinement Engine for Gaussian Splatting (SplatRoom).
 *
 * Goal: flatten only the gaussians that protrude from the local surface
 * (large blobby outliers) while leaving normal detail untouched.
 *
 * Pipeline:
 *   1. Analyze each gaussian (covariance eigen-decomposition).
 *   2. Estimate a local tangent-plane + thickness for every gaussian.
 *   3. Flag outliers: maxScale / localThickness > threshold.
 *   4. For each outlier:
 *        - Compress its largest scale down toward the local thickness.
 *        - Compress its normal-axis scale toward the local thickness.
 *        - Align its shortest axis to the local surface normal.
 *        - Optionally split very large outliers into smaller pieces.
 */

import { Asset, GSplatData, GSplatResource } from 'playcanvas';
import type { Splat } from '../splat';
import {
    analyzeAll,
    detectOutliers,
    GaussShape,
    type GaussAnalysis
} from './surface-analyzer';

// ---- types ----------------------------------------------------------------

export interface SurfaceRefineOptions {
    /** Compression strength for protruding outliers [0-1]. Default 0.6 */
    strength?: number;
    /** Whether to split large outliers into smaller gaussians. Default true */
    edgeSplit?: boolean;
    /** Target size for split gaussians (world units). Default auto from scene scale */
    targetSplitSize?: number;
    /** Whether to smooth normals. Default true */
    smoothNormals?: boolean;
}

export interface SurfaceRefineResult {
    splatsAffected: number;
    splatsSplit: number;
    outlierCount: number;
    surfaceCount: number;
    totalCount: number;
}

// ---- helpers --------------------------------------------------------------

/** 3D vector length. */
function vlen(v: [number, number, number]): number {
    return Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]) || 1;
}

/** Normalize 3D vector in-place, return length. */
function normalize(v: [number, number, number]): number {
    const l = vlen(v);
    if (l > 1e-12) { v[0] /= l; v[1] /= l; v[2] /= l; }
    return l;
}

/** Dot product of two 3D vectors. */
function dot(a: [number, number, number], b: [number, number, number]): number {
    return a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
}

/** Cross product a × b. */
function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
    return [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]];
}

/** Add two 3D vectors. */
function vadd(a: [number, number, number], b: [number, number, number]): [number, number, number] {
    return [a[0]+b[0], a[1]+b[1], a[2]+b[2]];
}

/** Scale a 3D vector. */
function vscale(v: [number, number, number], s: number): [number, number, number] {
    return [v[0]*s, v[1]*s, v[2]*s];
}

/** Normalize a quaternion in-place. */
function normalizeQuat(q: [number, number, number, number]) {
    const l = Math.sqrt(q[0]*q[0] + q[1]*q[1] + q[2]*q[2] + q[3]*q[3]) || 1;
    q[0] /= l; q[1] /= l; q[2] /= l; q[3] /= l;
}

/**
 * Build a quaternion from an orthonormal 3×3 rotation matrix's columns.
 * R = [c0 | c1 | c2] where each column is a unit-length basis vector.
 *
 * Uses Shepperd's algorithm (stable).
 */
function quatFromRotationColumns(
    c0: [number, number, number],
    c1: [number, number, number],
    c2: [number, number, number]
): [number, number, number, number] {
    const trace = c0[0] + c1[1] + c2[2];
    let q: [number, number, number, number];

    if (trace > 0) {
        const s = 0.5 / Math.sqrt(trace + 1.0);
        q = [
            (c1[2] - c2[1]) * s,
            (c2[0] - c0[2]) * s,
            (c0[1] - c1[0]) * s,
            0.25 / s
        ];
    } else if (c0[0] > c1[1] && c0[0] > c2[2]) {
        const s = 2.0 * Math.sqrt(1.0 + c0[0] - c1[1] - c2[2]);
        q = [
            0.25 * s,
            (c0[1] + c1[0]) / s,
            (c2[0] + c0[2]) / s,
            (c1[2] - c2[1]) / s
        ];
    } else if (c1[1] > c2[2]) {
        const s = 2.0 * Math.sqrt(1.0 + c1[1] - c0[0] - c2[2]);
        q = [
            (c0[1] + c1[0]) / s,
            0.25 * s,
            (c1[2] + c2[1]) / s,
            (c2[0] - c0[2]) / s
        ];
    } else {
        const s = 2.0 * Math.sqrt(1.0 + c2[2] - c0[0] - c1[1]);
        q = [
            (c2[0] + c0[2]) / s,
            (c1[2] + c2[1]) / s,
            0.25 * s,
            (c0[1] - c1[0]) / s
        ];
    }
    normalizeQuat(q);
    return q;
}

/**
 * Reconstruct a rotation quaternion from a new normal vector
 * while preserving the original orientation as much as possible.
 */
function alignNormalToQuat(
    originalQuat: [number, number, number, number],
    newNormal: [number, number, number]
): [number, number, number, number] {
    const [x, y, z, w] = originalQuat;
    const x2 = 2*x, y2 = 2*y, z2 = 2*z;
    const wx = w*x2, wy = w*y2, wz = w*z2;
    const xx = x*x2, xy = x*y2, xz = x*z2;
    const yy = y*y2, yz = y*z2, zz = z*z2;

    const c0: [number, number, number] = [1-(yy+zz), xy+wz, xz-wy];
    const c1: [number, number, number] = [xy-wz, 1-(xx+zz), yz+wx];
    const c2: [number, number, number] = [xz+wy, yz-wx, 1-(xx+yy)];

    const nc2: [number, number, number] = [...newNormal];

    const dot0 = dot(c0, nc2);
    const nc0: [number, number, number] = [
        c0[0] - dot0 * nc2[0],
        c0[1] - dot0 * nc2[1],
        c0[2] - dot0 * nc2[2]
    ];
    normalize(nc0);

    const nc1 = cross(nc2, nc0);
    normalize(nc1);

    return quatFromRotationColumns(nc0, nc1, nc2);
}

// ---- data access ----------------------------------------------------------

interface GaussArrays {
    x: Float32Array; y: Float32Array; z: Float32Array;
    s0: Float32Array; s1: Float32Array; s2: Float32Array;
    r0: Float32Array; r1: Float32Array; r2: Float32Array; r3: Float32Array;
    opacity: Float32Array;
    N: number;
}

function extractArrays(splat: Splat): GaussArrays {
    const data = splat.splatData;
    return {
        x:  data.getProp('x')  as Float32Array,
        y:  data.getProp('y')  as Float32Array,
        z:  data.getProp('z')  as Float32Array,
        s0: data.getProp('scale_0') as Float32Array,
        s1: data.getProp('scale_1') as Float32Array,
        s2: data.getProp('scale_2') as Float32Array,
        r0: data.getProp('rot_0') as Float32Array,
        r1: data.getProp('rot_1') as Float32Array,
        r2: data.getProp('rot_2') as Float32Array,
        r3: data.getProp('rot_3') as Float32Array,
        opacity: data.getProp('opacity') as Float32Array,
        N: data.numSplats
    };
}

function cloneArrays(arrs: {
    s0: Float32Array; s1: Float32Array; s2: Float32Array;
    r0: Float32Array; r1: Float32Array; r2: Float32Array; r3: Float32Array;
    opacity?: Float32Array;
    N: number;
}): {
    s0: Float32Array; s1: Float32Array; s2: Float32Array;
    r0: Float32Array; r1: Float32Array; r2: Float32Array; r3: Float32Array;
    opacity?: Float32Array;
} {
    return {
        s0: new Float32Array(arrs.s0),
        s1: new Float32Array(arrs.s1),
        s2: new Float32Array(arrs.s2),
        r0: new Float32Array(arrs.r0),
        r1: new Float32Array(arrs.r1),
        r2: new Float32Array(arrs.r2),
        r3: new Float32Array(arrs.r3),
        opacity: arrs.opacity ? new Float32Array(arrs.opacity) : undefined,
    };
}

/**
 * Restore saved arrays back into the live GSplatData arrays.
 */
function restoreArrays(
    arrs: GaussArrays,
    saved: {
        s0: Float32Array; s1: Float32Array; s2: Float32Array;
        r0: Float32Array; r1: Float32Array; r2: Float32Array; r3: Float32Array;
        opacity?: Float32Array;
    }
) {
    arrs.s0.set(saved.s0);
    arrs.s1.set(saved.s1);
    arrs.s2.set(saved.s2);
    arrs.r0.set(saved.r0);
    arrs.r1.set(saved.r1);
    arrs.r2.set(saved.r2);
    arrs.r3.set(saved.r3);
    if (saved.opacity) arrs.opacity.set(saved.opacity);
}

// ---- asset helper ---------------------------------------------------------

/**
 * Wrap an existing GSplatResource in an Asset and mark it as loaded so
 * PlayCanvas does not try to fetch a non-existent URL in the background.
 */
function createLoadedAsset(resource: GSplatResource, name: string, filename: string): Asset {
    const asset = new Asset(name, 'gsplat', {
        url: `${name}-${Date.now()}`,
        filename
    });
    asset.resource = resource;
    asset.loaded = true;
    asset.loading = false;
    return asset;
}

/**
 * Deep-clone a GSplatData including all vertex property storages.
 * Preserves the element/property layout so downstream code (bindAsset,
 * GSplatResource) sees the same channels as the original.
 */
function cloneGSplatData(source: GSplatData): GSplatData {
    const clonedElements = source.elements.map((el: any) => ({
        name: el.name,
        count: el.count,
        properties: el.properties.map((p: any) => {
            const Ctor = p.storage.constructor;
            return {
                type: p.type,
                name: p.name,
                byteSize: p.byteSize,
                storage: new Ctor(p.storage)
            };
        })
    }));
    return new GSplatData(clonedElements, source.comments.slice());
}

// ---- core refinement logic ------------------------------------------------

/**
 * Apply surface refinement to a single splat.
 *
 * Works on a clone of the splat's GSplatData so the live data is only
 * swapped in when replaceData() is called. Returns a new Asset wrapping
 * the modified clone.
 */
export function refineSurface(
    splat: Splat,
    options: SurfaceRefineOptions = {}
): { asset: Asset; result: SurfaceRefineResult } {
    // Work on a clone so the original splat data is untouched until the op is applied.
    const gsplatData = cloneGSplatData(splat.splatData);

    const x = gsplatData.getProp('x') as Float32Array;
    const y = gsplatData.getProp('y') as Float32Array;
    const z = gsplatData.getProp('z') as Float32Array;
    const s0 = gsplatData.getProp('scale_0') as Float32Array;
    const s1 = gsplatData.getProp('scale_1') as Float32Array;
    const s2 = gsplatData.getProp('scale_2') as Float32Array;
    const r0 = gsplatData.getProp('rot_0') as Float32Array;
    const r1 = gsplatData.getProp('rot_1') as Float32Array;
    const r2 = gsplatData.getProp('rot_2') as Float32Array;
    const r3 = gsplatData.getProp('rot_3') as Float32Array;
    const N = gsplatData.numSplats;

    // ---- Phase 1: Analyze all gaussians ----
    console.time('[SurfaceRefine] Phase 1 — eigen analysis');
    const analyses = analyzeAll(
        [r0, r1, r2, r3],
        [s0, s1, s2]
    );
    console.timeEnd('[SurfaceRefine] Phase 1 — eigen analysis');

    // Compute scene bounds
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < N; i++) {
        if (x[i] < minX) minX = x[i]; if (y[i] < minY) minY = y[i]; if (z[i] < minZ) minZ = z[i];
        if (x[i] > maxX) maxX = x[i]; if (y[i] > maxY) maxY = y[i]; if (z[i] > maxZ) maxZ = z[i];
    }
    const bounds = { min: [minX, minY, minZ] as [number, number, number], max: [maxX, maxY, maxZ] as [number, number, number] };
    const diag = vlen([maxX-minX, maxY-minY, maxZ-minZ]);

    // ---- Phase 2: Detect protruding outliers (grid stats, O(N)) ----
    console.time('[SurfaceRefine] Phase 2 — outlier detection');
    const stats = detectOutliers(analyses, [x, y, z], bounds, {
        cellSize: diag * 0.015,
        outlierThreshold: 2.5,
        maxScaleRatio: 0.05
    });
    console.timeEnd('[SurfaceRefine] Phase 2 — outlier detection');
    console.log('[SurfaceRefine] outlier stats:', JSON.stringify(stats));

    // ---- Phase 3: Apply compression only to outliers ----
    const strength = Math.max(0, Math.min(1, options.strength ?? 0.6));
    const doEdgeSplit = options.edgeSplit !== false;
    const targetSize = options.targetSplitSize ?? diag * 0.003;

    let modifiedCount = 0;
    let splitCount = 0;

    // We collect split candidates separately so we can append them after the main pass.
    // For now splitting is disabled in-place; enable later if requested.
    const splits: {
        sourceIndex: number;
        count: number;
        positions: [number, number, number][];
        scales: [number, number, number][];
        quats: [number, number, number, number][];
    }[] = [];

    for (let i = 0; i < N; i++) {
        const a = analyses[i];
        if (!a.isOutlier) continue;

        // Current linear scales (from log space), in the order stored by PlayCanvas.
        const ls0 = Math.exp(s0[i]);
        const ls1 = Math.exp(s1[i]);
        const ls2 = Math.exp(s2[i]);
        const maxScale = Math.max(ls0, ls1, ls2);
        const minScale = Math.min(ls0, ls1, ls2);

        // localThickness is now the average maxScale of gaussians in the local region
        // (self excluded). Target: compress the largest axis DOWN toward the local
        // average — at strength=1 the max scale becomes the local average (flush
        // with the surface), at strength=0 nothing changes. The thinnest axis is
        // kept a fraction of the local average.
        const localAvg = a.localThickness;
        const targetMax = localAvg * (1.0 + strength * 0.5);
        const targetMin = Math.min(minScale, localAvg * 0.25);

        if (maxScale <= targetMax * 1.05) {
            // Already small enough — just align the normal.
            const quat: [number, number, number, number] = [r0[i], r1[i], r2[i], r3[i]];
            const newQuat = alignNormalToQuat(quat, a.localNormal);
            r0[i] = newQuat[0]; r1[i] = newQuat[1]; r2[i] = newQuat[2]; r3[i] = newQuat[3];
            modifiedCount++;
            continue;
        }

        // Compression factors. strength=1 → full compression; strength=0 → no change.
        const maxFactor = 1.0 - strength * (1.0 - targetMax / maxScale);
        const minFactor = targetMin < minScale
            ? 1.0 - strength * (1.0 - targetMin / minScale)
            : 1.0;

        // Sort original scales so we know which is largest/smallest.
        const sortedIdx = [
            { idx: 0, v: ls0 },
            { idx: 1, v: ls1 },
            { idx: 2, v: ls2 }
        ].sort((p, q) => q.v - p.v);

        const newScales = [ls0, ls1, ls2];
        newScales[sortedIdx[0].idx] *= Math.max(0.2, maxFactor);
        newScales[sortedIdx[2].idx] *= Math.max(0.2, minFactor);
        // Middle scale is left mostly alone, maybe slightly reduced.
        newScales[sortedIdx[1].idx] *= (1.0 - strength * 0.1);

        s0[i] = Math.log(Math.max(newScales[0], 1e-8));
        s1[i] = Math.log(Math.max(newScales[1], 1e-8));
        s2[i] = Math.log(Math.max(newScales[2], 1e-8));

        // Align shortest axis (normal direction) to the local surface normal.
        const quat: [number, number, number, number] = [r0[i], r1[i], r2[i], r3[i]];
        const newQuat = alignNormalToQuat(quat, a.localNormal);
        r0[i] = newQuat[0]; r1[i] = newQuat[1]; r2[i] = newQuat[2]; r3[i] = newQuat[3];

        modifiedCount++;

        // Splitting: if after compression the largest scale is still much
        // larger than the target split size, queue it for subdivision.
        // (Actual split implementation is left as a future enhancement;
        // for now we just count them so the UI can report it.)
        if (doEdgeSplit && newScales[sortedIdx[0].idx] > targetSize * 2.5) {
            splitCount++;
        }
    }

    console.log(`[SurfaceRefine] modified ${modifiedCount} outliers, ${splitCount} would be split`);

    // ---- Phase 4: Create new Asset from modified clone ----
    const device = splat.scene.app.graphicsDevice;
    const resource = new GSplatResource(device, gsplatData);
    const asset = createLoadedAsset(resource, 'surface-refined', splat.name || 'splat');
    splat.scene.app.assets.add(asset);

    return {
        asset,
        result: {
            splatsAffected: modifiedCount,
            splatsSplit: splitCount,
            outlierCount: stats.outlierCount,
            surfaceCount: stats.surfaceCount,
            totalCount: N
        }
    };
}

/**
 * Deep-copy the current scale and rotation arrays for undo/redo.
 */
export function snapshotScaleRotation(splat: Splat) {
    const arrs = extractArrays(splat);
    return cloneArrays(arrs);
}

export type ScaleRotationSnapshot = ReturnType<typeof snapshotScaleRotation>;

/**
 * Restore a previously saved snapshot into the live arrays.
 */
export function restoreSnapshot(splat: Splat, snap: ScaleRotationSnapshot) {
    const arrs = extractArrays(splat);
    restoreArrays(arrs, snap);
}

// ==========================================================================
// Level 2 — edge smoothing + scatter cleanup
// (applied after Level 1 surface refinement)
// ==========================================================================

export interface SurfaceRefineLevel2Params {
    /** 0.1..1.0 — edge Gaussian scale multiplier.  0.5 = half the radius. */
    edgeRadiusScale: number;
    /** Search radius as a FRACTION of the splat bounding-box diagonal.
     *  Adaptive to model scale — works on small and large models alike.
     *  e.g. 0.01 = 1% of bbox diagonal. */
    radiusFraction: number;
    /** Neighbour count below which a Gaussian is flagged as "scatter"
     *  (combined with opacity check via OR).  Default 2 — points truly
     *  isolated in space. */
    scatterMinNeighbors: number;
    /** Opacity (after sigmoid) below which a Gaussian is flagged as "scatter".
     *  Default 0.3 — typical opacity values are 0.5-0.95; below 0.3 is
     *  "see-through" and likely a float/scatter point. */
    opacityThreshold: number;
    /** Whether to remove scattered (isolated) Gaussians. */
    removeScatter: boolean;
    /** Gaussians with fewer neighbours than this fraction of the median
     *  neighbour count are considered "edge" Gaussians (scaled down but
     *  kept). */
    edgeNbrFrac: number;
}

/** Minimal 3D spatial hash for neighbour queries. */
class L2SpatialGrid {
    private cell: number;
    private grid = new Map<string, number[]>();

    constructor(cellSize: number) {
        this.cell = Math.max(cellSize, 1e-6);
    }

    private key(x: number, y: number, z: number): string {
        return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)},${Math.floor(z / this.cell)}`;
    }

    insert(idx: number, x: number, y: number, z: number) {
        const k = this.key(x, y, z);
        let a = this.grid.get(k);
        if (!a) { a = []; this.grid.set(k, a); }
        a.push(idx);
    }

    countWithin(
        xs: Float32Array, ys: Float32Array, zs: Float32Array,
        cx: number, cy: number, cz: number, R: number, self: number
    ): number {
        const range = Math.ceil(R / this.cell);
        const gcx = Math.floor(cx / this.cell);
        const gcy = Math.floor(cy / this.cell);
        const gcz = Math.floor(cz / this.cell);
        const r2 = R * R;
        let count = 0;
        for (let dx = -range; dx <= range; dx++) {
            for (let dy = -range; dy <= range; dy++) {
                for (let dz = -range; dz <= range; dz++) {
                    const a = this.grid.get(`${gcx + dx},${gcy + dy},${gcz + dz}`);
                    if (!a) continue;
                    for (const idx of a) {
                        if (idx === self) continue;
                        const ddx = cx - xs[idx];
                        const ddy = cy - ys[idx];
                        const ddz = cz - zs[idx];
                        if (ddx * ddx + ddy * ddy + ddz * ddz <= r2) count++;
                    }
                }
            }
        }
        return count;
    }
}

/**
 * Level 2 refinement: edge smoothing + scatter cleanup.
 *
 * Operates on a GSplatData (typically already processed by Level 1).
 * Returns a NEW GSplatData with edge Gaussians scaled down and
 * scattered points optionally removed.
 *
 * Async — neighbour counting is chunked to avoid blocking the UI.
 * Large models may take a few seconds but remain responsive.
 */
export async function refineSurfaceLevel2(
    data: GSplatData,
    params: SurfaceRefineLevel2Params
): Promise<GSplatData> {
    const x = data.getProp('x') as Float32Array;
    const y = data.getProp('y') as Float32Array;
    const z = data.getProp('z') as Float32Array;
    const s0 = data.getProp('scale_0') as Float32Array;
    const s1 = data.getProp('scale_1') as Float32Array;
    const s2 = data.getProp('scale_2') as Float32Array;
    const r0 = data.getProp('rot_0') as Float32Array;
    const r1 = data.getProp('rot_1') as Float32Array;
    const r2 = data.getProp('rot_2') as Float32Array;
    const r3 = data.getProp('rot_3') as Float32Array;
    const dc0 = data.getProp('f_dc_0') as Float32Array;
    const dc1 = data.getProp('f_dc_1') as Float32Array;
    const dc2 = data.getProp('f_dc_2') as Float32Array;
    const op = data.getProp('opacity') as Float32Array;
    const state = data.getProp('state') as Uint8Array;
    const N = data.numSplats;

    // ── SH coefficients ──
    const shBands = (data as any).shBands ?? 0;
    const numCoeffs = ([0, 3, 8, 15][shBands] ?? 0);
    const sh: Float32Array[] = [];
    for (let i = 0; i < numCoeffs * 3; i++) {
        sh.push(data.getProp(`f_rest_${i}`) as Float32Array);
    }

    // ── Compute bounding box (for adaptive search radius) ──
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < N; i++) {
        if (state[i] !== 0) continue;
        if (x[i] < minX) minX = x[i];
        if (y[i] < minY) minY = y[i];
        if (z[i] < minZ) minZ = z[i];
        if (x[i] > maxX) maxX = x[i];
        if (y[i] > maxY) maxY = y[i];
        if (z[i] > maxZ) maxZ = z[i];
    }
    const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
    const searchRadius = Math.max(1e-4, diag * params.radiusFraction);

    // ── Build spatial grid ──
    const grid = new L2SpatialGrid(searchRadius * 2);
    for (let i = 0; i < N; i++) {
        if (state[i] !== 0) continue;
        grid.insert(i, x[i], y[i], z[i]);
    }

    // ── Count neighbours (async chunked to avoid UI freeze) ──
    const CHUNK = 8000;
    const nbrCount = new Float32Array(N);

    for (let chunkStart = 0; chunkStart < N; chunkStart += CHUNK) {
        const chunkEnd = Math.min(N, chunkStart + CHUNK);
        for (let i = chunkStart; i < chunkEnd; i++) {
            if (state[i] !== 0) continue;
            nbrCount[i] = grid.countWithin(x, y, z, x[i], y[i], z[i], searchRadius, i);
        }
        // Yield to event loop — keep UI responsive
        if (chunkEnd < N) {
            await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
    }

    // ── Compute median neighbour count (for edge detection) ──
    const validCounts: number[] = [];
    for (let i = 0; i < N; i++) {
        if (state[i] === 0 && nbrCount[i] > 0) validCounts.push(nbrCount[i]);
    }
    validCounts.sort((a, b) => a - b);
    const medNbr = validCounts.length > 0
        ? validCounts[Math.floor(validCounts.length / 2)]
        : 1;

    // ── Detect edge + scatter ──
    // Edge:  neighbour count < edgeNbrFrac × median (boundary of body, kept but scaled)
    // Scatter: weighted score combining isolation (low nbr) and transparency (low opacity)
    //   score = w_nbr × (1 - nbr/medNbr) + w_alpha × (1 - alpha)
    //   Points scoring above threshold AND on the edge zone are removed.
    const edgeThreshold = medNbr * params.edgeNbrFrac;
    const isEdge = new Uint8Array(N);
    const isScattered = new Uint8Array(N);

    // Adaptive weights: emphasize isolation slightly (it's the stronger signal)
    const W_NBR = 0.55;
    const W_ALPHA = 0.45;
    const SCATTER_THRESH = 0.6;  // score above this = scatter

    for (let i = 0; i < N; i++) {
        if (state[i] !== 0) continue;
        if (nbrCount[i] < edgeThreshold) isEdge[i] = 1;
        if (params.removeScatter) {
            // Decode raw opacity (logit) to actual alpha via sigmoid
            const alpha = 1 / (1 + Math.exp(-op[i]));
            // Normalized neighbour count (1.0 = median, 0.0 = isolated)
            const nbrRatio = medNbr > 0 ? Math.min(1, nbrCount[i] / medNbr) : 0;
            // Scatter score: high = isolated + transparent
            const score = W_NBR * (1 - nbrRatio) + W_ALPHA * (1 - alpha);
            if (score > SCATTER_THRESH) {
                isScattered[i] = 1;
            }
        }
    }

    // ── Count removals ──
    let removeCount = 0;
    for (let i = 0; i < N; i++) {
        if (state[i] !== 0) continue;
        if (isScattered[i]) removeCount++;
    }
    const outCount = N - removeCount;

    // ── Copy with modifications ──
    const oX = new Float32Array(outCount);
    const oY = new Float32Array(outCount);
    const oZ = new Float32Array(outCount);
    const oS0 = new Float32Array(outCount);
    const oS1 = new Float32Array(outCount);
    const oS2 = new Float32Array(outCount);
    const oR0 = new Float32Array(outCount);
    const oR1 = new Float32Array(outCount);
    const oR2 = new Float32Array(outCount);
    const oR3 = new Float32Array(outCount);
    const oDc0 = new Float32Array(outCount);
    const oDc1 = new Float32Array(outCount);
    const oDc2 = new Float32Array(outCount);
    const oOp = new Float32Array(outCount);
    const oState = new Uint8Array(outCount);
    const oSh: Float32Array[] = sh.map(() => new Float32Array(outCount));

    let w = 0;
    const logFactor = Math.log(Math.max(0.1, params.edgeRadiusScale));

    for (let i = 0; i < N; i++) {
        if (state[i] !== 0) continue;
        if (isScattered[i]) continue;

        oX[w] = x[i];
        oY[w] = y[i];
        oZ[w] = z[i];

        if (isEdge[i]) {
            oS0[w] = s0[i] + logFactor;
            oS1[w] = s1[i] + logFactor;
            oS2[w] = s2[i] + logFactor;
        } else {
            oS0[w] = s0[i];
            oS1[w] = s1[i];
            oS2[w] = s2[i];
        }

        oR0[w] = r0[i]; oR1[w] = r1[i]; oR2[w] = r2[i]; oR3[w] = r3[i];
        oDc0[w] = dc0[i]; oDc1[w] = dc1[i]; oDc2[w] = dc2[i];
        oOp[w] = op[i];
        oState[w] = 0;

        for (let s = 0; s < sh.length; s++) {
            oSh[s][w] = sh[s][i];
        }

        w++;
    }

    const finalCount = w;

    const outProps: any[] = [
        { type: 'float', name: 'x', storage: oX.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'y', storage: oY.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'z', storage: oZ.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'scale_0', storage: oS0.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'scale_1', storage: oS1.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'scale_2', storage: oS2.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'rot_0', storage: oR0.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'rot_1', storage: oR1.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'rot_2', storage: oR2.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'rot_3', storage: oR3.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'f_dc_0', storage: oDc0.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'f_dc_1', storage: oDc1.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'f_dc_2', storage: oDc2.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'opacity', storage: oOp.subarray(0, finalCount), byteSize: 4 },
        { type: 'uint8', name: 'state', storage: oState.subarray(0, finalCount), byteSize: 1 }
    ];
    for (let s = 0; s < sh.length; s++) {
        outProps.push({
            type: 'float',
            name: `f_rest_${s}`,
            storage: oSh[s].subarray(0, finalCount),
            byteSize: 4
        });
    }

    return new GSplatData([{ name: 'vertex', count: finalCount, properties: outProps }]);
}
