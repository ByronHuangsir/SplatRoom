/**
 * Main-thread client for the surface refine worker.
 *
 * `refineSurfaceInWorker` runs the CPU-bound analyze/flatten/split/cleanup
 * pipeline off the main thread. The caller clones the GSplatData, transfers the
 * per-gaussian column buffers (zero-copy), and receives back the mutated
 * buffers + stats to rebuild the output GSplatData.
 *
 * Any failure (worker unavailable, transfer error, worker crash) transparently
 * falls back to a main-thread computation so the feature keeps working even in
 * constrained environments.
 */

import {
    analyzeAll,
    detectOutliers,
    type GaussAnalysisColumns
} from '../geometry/surface-analyzer';

// ---- mirrored tuning constants (must match surface-refiner.ts) -------------

const SPLIT_BUDGET_FRACTION = 0.03;
const SPLIT_MAX_PER_GAUSS = 4;
const SPLIT_SIZE_RATIO = 0.003;
const SPLIT_TRIGGER_RATIO = 2.5;
const SPLIT_OUTSIDE_FACTOR = 2.0;
const CLEANUP_MIN_NEIGHBORS = 5;
const CLEANUP_DIST_FACTOR = 1.0;
const GIANT_RATIO = 0.05;
const GIANT_ALPHA = 0.25;
const OUTLIER_MAX_SCALE_RATIO = 0.2;
const ISOLATE_THICKNESS_FACTOR = 10;
const ISOLATE_SCALE_FACTOR = 4;
const PENETRATE_MIN_RATIO = 8;
const PENETRATE_SPAN_FACTOR = 1.5;
const REGION_SPARSE_FRAC = 0.1;
const LOCAL_SPARSE_FRAC = 0.3;
const SCALE_REL_FACTOR = 3;
const ALPHA_REL_FACTOR = 0.5;

// ---- helpers (must match surface-refiner.ts bit-for-bit) -------------------

// Splats to EXCLUDE from refinement: only locked(2) and deleted(4) rows are
// skipped --a merely-selected(1) gaussian must still be processed.
const SKIP_STATE_MASK = 6; // State.locked | State.deleted

function vlen(v: [number, number, number]): number {
    return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1;
}

function normalize(v: [number, number, number]): number {
    const l = vlen(v);
    if (l > 1e-12) {
        v[0] /= l; v[1] /= l; v[2] /= l;
    }
    return l;
}

function dot(a: [number, number, number], b: [number, number, number]): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalizeQuat(q: [number, number, number, number]) {
    const l = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]) || 1;
    q[0] /= l; q[1] /= l; q[2] /= l; q[3] /= l;
}

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

function alignNormalToQuat(
    originalQuat: [number, number, number, number],
    newNormal: [number, number, number]
): [number, number, number, number] {
    const [x, y, z, w] = originalQuat;
    const x2 = 2 * x, y2 = 2 * y, z2 = 2 * z;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;

    const c0: [number, number, number] = [1 - (yy + zz), xy + wz, xz - wy];
    const c1: [number, number, number] = [xy - wz, 1 - (xx + zz), yz + wx];
    const c2: [number, number, number] = [xz + wy, yz - wx, 1 - (xx + yy)];

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

// ---- public API ------------------------------------------------------------

export interface RefineBuffers {
    x: Float32Array;
    y: Float32Array;
    z: Float32Array;
    s0: Float32Array;
    s1: Float32Array;
    s2: Float32Array;
    r0: Float32Array;
    r1: Float32Array;
    r2: Float32Array;
    r3: Float32Array;
    op: Float32Array;
    state: Uint8Array;
    /** Generic columns copied through unchanged (e.g. SH coefficients). */
    extra: { name: string; data: Float32Array }[];
    N: number;
}

export interface RefineOutcome {
    flattened: number;
    splitAdded: number;
    removed: number;
    outlierCount: number;
    surfaceCount: number;
    totalBefore: number;
    totalAfter: number;
    /** Rebuilt columns (length = totalAfter). Present when removal/split happened. */
    columns: { name: string; data: Float32Array | Uint8Array }[];
    /** True when the pipeline ran in the worker, false when main-thread fallback. */
    usedWorker: boolean;
}

let worker: Worker | null = null;
let msgId = 0;
const pending = new Map<number, {
    resolve:(r: RefineOutcome) => void;
    reject: (e: any) => void;
    onProgress?: (fraction: number) => void;
}>();

const workerUrl = (): string => {
    const base =
        typeof document !== 'undefined' ?
            document.baseURI :
            (self as any).location.href;
    return new URL('surface-worker.js', base).toString();
};

const getWorker = (): Worker => {
    if (!worker) {
        worker = new Worker(workerUrl(), { type: 'module' });
        worker.onmessage = (e: MessageEvent) => {
            const msg = e.data;
            const p = pending.get(msg.id);
            if (!p) return;
            if (msg.type === 'refine-progress') {
                // forward worker pipeline progress to the UI progress bar
                p.onProgress?.(msg.progress);
                return;
            }
            if (msg.type === 'refine-result') {
                pending.delete(msg.id);
                // The worker posts columns under their FULL property names
                // ('scale_0', 'rot_0', 'opacity', ...) — reading the short
                // aliases (msg.s0 / msg.r0 / msg.op) yields undefined for
                // every one, and the rebuilt GSplatData silently loses those
                // columns → GSplatResource.calcAabb throws
                // 'Cannot read properties of undefined (reading "0")' on the
                // scale columns. Match the exact payload keys.
                const columns = [
                    { name: 'x', data: msg.x }, { name: 'y', data: msg.y }, { name: 'z', data: msg.z },
                    { name: 'scale_0', data: msg.scale_0 }, { name: 'scale_1', data: msg.scale_1 }, { name: 'scale_2', data: msg.scale_2 },
                    { name: 'rot_0', data: msg.rot_0 }, { name: 'rot_1', data: msg.rot_1 }, { name: 'rot_2', data: msg.rot_2 },
                    { name: 'rot_3', data: msg.rot_3 }, { name: 'opacity', data: msg.opacity }, { name: 'state', data: msg.state },
                    ...(msg.extra ?? [])
                ];
                p.resolve({
                    flattened: msg.flattened,
                    splitAdded: msg.splitAdded,
                    removed: msg.removed,
                    outlierCount: msg.outlierCount,
                    surfaceCount: msg.surfaceCount,
                    totalBefore: msg.totalBefore,
                    totalAfter: msg.totalAfter,
                    columns,
                    usedWorker: true
                });
            }
        };
        worker.onerror = (e: ErrorEvent) => {
            const err = new Error(e.message || 'surface-worker error');
            for (const [id, p] of pending) {
                pending.delete(id);
                p.reject(err);
            }
            // Drop the dead worker so the next refine recreates it (a fresh
            // worker may succeed even if this instance crashed/never loaded).
            worker = null;
        };
    }
    return worker;
};

const CHUNK = 50000;
const yield0 = () => new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
});

/** Main-thread fallback --identical math, runs when the worker is unavailable. */
export async function refineSurfaceMainThread(
    bufs: RefineBuffers,
    options: { strength: number; edgeSplit: boolean; removeScatter: boolean; targetSplitSize: number },
    onProgress?: (fraction: number) => void
): Promise<RefineOutcome> {
    const { x, y, z, s0, s1, s2, r0, r1, r2, r3, op, state, extra, N } = bufs;
    const { strength: strengthRaw, edgeSplit: doSplit, removeScatter: doCleanup, targetSplitSize } = options;

    const analyses: GaussAnalysisColumns = await analyzeAll(
        [r0, r1, r2, r3],
        [s0, s1, s2],
        f => onProgress?.(0.4 * f)
    );

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let start = 0; start < N; start += CHUNK) {
        const end = Math.min(N, start + CHUNK);
        for (let i = start; i < end; i++) {
            if ((state[i] & SKIP_STATE_MASK) !== 0) continue;
            if (x[i] < minX) minX = x[i]; if (y[i] < minY) minY = y[i]; if (z[i] < minZ) minZ = z[i];
            if (x[i] > maxX) maxX = x[i]; if (y[i] > maxY) maxY = y[i]; if (z[i] > maxZ) maxZ = z[i];
        }
        if (end < N) await yield0();
    }
    const bounds = { min: [minX, minY, minZ] as [number, number, number], max: [maxX, maxY, maxZ] as [number, number, number] };
    const diag = vlen([maxX - minX, maxY - minY, maxZ - minZ]) || 1;

    const stats = await detectOutliers(analyses, [x, y, z], bounds, {
        maxScaleRatio: OUTLIER_MAX_SCALE_RATIO,
        nnEarlyOutFactor: ISOLATE_SCALE_FACTOR
    }, f => onProgress?.(0.4 + 0.4 * f));

    const scaleArr: number[] = [];
    const alphaArr: number[] = [];
    for (let start = 0; start < N; start += CHUNK) {
        const end = Math.min(N, start + CHUNK);
        for (let i = start; i < end; i++) {
            if ((state[i] & SKIP_STATE_MASK) !== 0) continue;
            scaleArr.push(analyses.maxScale[i]);
            alphaArr.push(1 / (1 + Math.exp(-op[i])));
        }
        if (end < N) await yield0();
    }
    scaleArr.sort((a, b) => a - b);
    alphaArr.sort((a, b) => a - b);
    const medianScale = scaleArr.length > 0 ? scaleArr[scaleArr.length >> 1] : 1e-6;
    const medianAlpha = alphaArr.length > 0 ? alphaArr[alphaArr.length >> 1] : 1;
    onProgress?.(0.82);

    const strength = Math.max(0, Math.min(1, strengthRaw));
    const targetSize = targetSplitSize > 0 ? targetSplitSize : diag * SPLIT_SIZE_RATIO;

    // deleted/locked splats must be dropped from the rebuilt output AND from
    // outCount; otherwise the arrays keep trailing all-zero rows that get
    // exported as garbage (position 0, scale 1, grey, half-transparent).
    let numDeleted = 0;
    for (let i = 0; i < N; i++) {
        if ((state[i] & SKIP_STATE_MASK) !== 0) numDeleted++;
    }

    const removeFlag = new Uint8Array(N);
    let removed = 0;
    if (doCleanup) {
        const medRegion = stats.medianRegionDensity;
        const medLocal = stats.medianDensity;
        for (let start = 0; start < N; start += CHUNK) {
            const end = Math.min(N, start + CHUNK);
            for (let i = start; i < end; i++) {
                if ((state[i] & SKIP_STATE_MASK) !== 0) continue;
                const alpha = 1 / (1 + Math.exp(-op[i]));
                const maxScale = analyses.maxScale[i];
                const thickness = Math.max(analyses.thickness[i], 1e-8);
                const outside = analyses.signedDist[i] > thickness * CLEANUP_DIST_FACTOR;

                const penetrating = analyses.signedDist[i] > thickness &&
                    maxScale > thickness * PENETRATE_MIN_RATIO &&
                    maxScale > (analyses.signedDist[i] + thickness) * PENETRATE_SPAN_FACTOR;
                const giantIsolated = analyses.density[i] < CLEANUP_MIN_NEIGHBORS && maxScale > diag * GIANT_RATIO;
                // Big transparent splats are only removed when they clearly
                // stick OUTSIDE the surface — a large transparent background /
                // ground splat inside or beneath the model must be kept.
                const giantTransparent = outside && maxScale > diag * GIANT_RATIO && alpha < GIANT_ALPHA;
                const isolated = outside && analyses.nnDist[i] > Math.max(thickness * ISOLATE_THICKNESS_FACTOR, maxScale * ISOLATE_SCALE_FACTOR);
                // Detached sparse cluster must ALSO be outside the surface:
                // thin model edges / rim walls have genuinely low local density
                // but sit ON the surface --without the outside() guard they get
                // misclassified as scatter and wrongly removed.
                const sparseCluster = outside &&
                    analyses.regionDensity[i] < medRegion * REGION_SPARSE_FRAC &&
                    analyses.density[i] < medLocal * LOCAL_SPARSE_FRAC;
                const relOutlier = outside &&
                    (maxScale > medianScale * SCALE_REL_FACTOR || alpha < medianAlpha * ALPHA_REL_FACTOR);

                if (penetrating || giantIsolated || giantTransparent || isolated || sparseCluster || relOutlier) {
                    removeFlag[i] = 1;
                    removed++;
                }
            }
            if (end < N) await yield0();
        }
    }

    let flattened = 0;
    const splitSources: { index: number; k: number; score: number }[] = [];

    for (let start = 0; start < N; start += CHUNK) {
        const end = Math.min(N, start + CHUNK);
        for (let i = start; i < end; i++) {
            if ((state[i] & SKIP_STATE_MASK) !== 0 || removeFlag[i] || !analyses.isOutlier[i]) continue;
            const n: [number, number, number] = [analyses.nx[i], analyses.ny[i], analyses.nz[i]];

            // Pull the protruding centre back toward the local surface plane.
            // This is what actually flattens bumps on dense scans where the
            // gaussians are small and spherical (scale <= thickness): rotating
            // a sphere changes nothing visually, and the old code never
            // shrank the scales because maxScale <= targetMax short-circuited
            // into a rotation-only branch — the refine reported "flattened"
            // gaussians but the render looked identical.
            if (analyses.signedDist[i] > 0) {
                const pull = analyses.signedDist[i] * strength;
                x[i] -= n[0] * pull;
                y[i] -= n[1] * pull;
                z[i] -= n[2] * pull;
            }

            const ls0 = Math.exp(s0[i]);
            const ls1 = Math.exp(s1[i]);
            const ls2 = Math.exp(s2[i]);
            const maxScale = Math.max(ls0, ls1, ls2);
            const localAvg = Math.max(analyses.thickness[i], 1e-8);
            const targetMax = localAvg * (1.0 + strength * 0.5);

            // Rotate so the scale_2 axis (the normal direction after this
            // rotation) aligns with the local surface normal: pancake bumps
            // lie flat against the surface.
            const quat: [number, number, number, number] = [r0[i], r1[i], r2[i], r3[i]];
            const newQuat = alignNormalToQuat(quat, n);
            r0[i] = newQuat[0]; r1[i] = newQuat[1]; r2[i] = newQuat[2]; r3[i] = newQuat[3];

            // Cap the normal-direction scale toward the local surface
            // thickness (spherical bumps become flat discs lying on the
            // surface). Only ever shrinks, never grows.
            const normalTarget = localAvg * (0.6 - 0.4 * strength);
            const s2New = Math.min(ls2, normalTarget);
            const scales = [ls0, ls1, ls2];
            scales[2] = s2New;

            // Cap the max scale (oversized protruding gaussians).
            let maxFactor = 1.0;
            if (maxScale > targetMax * 1.05) {
                maxFactor = Math.max(0.2, 1.0 - strength * (1.0 - targetMax / maxScale));
            }
            const maxIdx = maxScale === ls0 ? 0 : (maxScale === ls1 ? 1 : 2);
            scales[maxIdx] *= maxFactor;

            // Mild shrink of the remaining axis.
            for (let k = 0; k < 3; k++) {
                if (k !== maxIdx && k !== 2) scales[k] *= (1.0 - strength * 0.1);
            }

            s0[i] = Math.log(Math.max(scales[0], 1e-8));
            s1[i] = Math.log(Math.max(scales[1], 1e-8));
            s2[i] = Math.log(Math.max(scales[2], 1e-8));

            flattened++;

            if (doSplit &&
            analyses.signedDist[i] < analyses.thickness[i] * SPLIT_OUTSIDE_FACTOR &&
            Math.max(scales[0], scales[1], scales[2]) > targetSize * SPLIT_TRIGGER_RATIO) {
                const k = Math.min(Math.max(2, Math.floor(Math.max(scales[0], scales[1], scales[2]) / targetSize)), SPLIT_MAX_PER_GAUSS);
                splitSources.push({ index: i, k, score: analyses.score[i] });
            }
        }
        if (end < N) await yield0();
    }
    onProgress?.(0.95);

    let splitAdded = 0;
    const splitSourceK = new Map<number, number>();
    if (splitSources.length > 0) {
        // budget is relative to LIVE splats (deleted/locked are skipped by the
        // rebuild), so a layer with many deleted rows doesn't over-amplify
        const budget = Math.floor((N - numDeleted) * SPLIT_BUDGET_FRACTION);
        splitSources.sort((a, b) => b.score - a.score);
        for (const src of splitSources) {
            if (splitAdded + src.k > budget) break;
            splitAdded += src.k;
            splitSourceK.set(src.index, src.k);
        }
    }

    // outCount subtracts deleted/locked splats (the rebuild loop skips them) and
    // their presence forces a rebuild so they are actually removed.
    const outCount = N - numDeleted - removed + splitAdded;
    const needsRebuild = removed > 0 || splitAdded > 0 || numDeleted > 0;
    if (!needsRebuild) {
        onProgress?.(1);
        return {
            flattened,
            splitAdded: 0,
            removed,
            outlierCount: stats.outlierCount,
            surfaceCount: stats.surfaceCount,
            totalBefore: N,
            totalAfter: N,
            columns: [
                { name: 'x', data: x }, { name: 'y', data: y }, { name: 'z', data: z },
                { name: 'scale_0', data: s0 }, { name: 'scale_1', data: s1 }, { name: 'scale_2', data: s2 },
                { name: 'rot_0', data: r0 }, { name: 'rot_1', data: r1 }, { name: 'rot_2', data: r2 },
                { name: 'rot_3', data: r3 }, { name: 'opacity', data: op }, { name: 'state', data: state },
                ...extra
            ],
            usedWorker: false
        };
    }

    const propDescs: { name: string; data: Float32Array | Uint8Array }[] = [
        { name: 'x', data: x }, { name: 'y', data: y }, { name: 'z', data: z },
        { name: 'scale_0', data: s0 }, { name: 'scale_1', data: s1 }, { name: 'scale_2', data: s2 },
        { name: 'rot_0', data: r0 }, { name: 'rot_1', data: r1 }, { name: 'rot_2', data: r2 },
        { name: 'rot_3', data: r3 }, { name: 'opacity', data: op }, { name: 'state', data: state },
        ...extra.map(c => ({ name: c.name, data: c.data }))
    ];

    const outArrays: (Float32Array | Uint8Array)[] = propDescs.map((p) => {
        const Ctor = (p.data as any).constructor;
        return new Ctor(outCount);
    });

    let w = 0;
    for (let start = 0; start < N; start += CHUNK) {
        const end = Math.min(N, start + CHUNK);
        for (let i = start; i < end; i++) {
            if ((state[i] & SKIP_STATE_MASK) !== 0) continue;
            if (removeFlag[i]) continue;
            for (let p = 0; p < propDescs.length; p++) {
                (outArrays[p] as any)[w] = propDescs[p].data[i];
            }
            w++;

            const k = splitSourceK.get(i) ?? 0;
            if (k > 0) {
                const n: [number, number, number] = [analyses.nx[i], analyses.ny[i], analyses.nz[i]];
                // Keep the child cluster centred on the source gaussian (no
                // hardcoded 1-unit offset along the normal — it scattered
                // children far off the surface on small models).
                const nx = x[i];
                const ny = y[i];
                const nz = z[i];
                const shrink = 1 / Math.sqrt(k);
                const span = Math.max(Math.exp(s0[i]), Math.exp(s1[i]), Math.exp(s2[i])) * 0.8;

                for (let j = 0; j < k; j++) {
                    const t = (j / Math.max(k - 1, 1) - 0.5) * span;
                    for (let p = 0; p < propDescs.length; p++) {
                        const name = propDescs[p].name;
                        const out = outArrays[p];
                        const srcArr = propDescs[p].data;
                        if (name === 'x') {
                            (out as Float32Array)[w] = nx + n[0] * t; continue;
                        }
                        if (name === 'y') {
                            (out as Float32Array)[w] = ny + n[1] * t; continue;
                        }
                        if (name === 'z') {
                            (out as Float32Array)[w] = nz + n[2] * t; continue;
                        }
                        if (name === 'scale_0' || name === 'scale_1' || name === 'scale_2') {
                            if (srcArr instanceof Float32Array && out instanceof Float32Array) {
                                out[w] = srcArr[i] + Math.log(shrink);
                            }
                            continue;
                        }
                        (out as any)[w] = srcArr[i];
                    }
                    w++;
                }
            }
        }
        if (end < N) await yield0();
    }

    onProgress?.(1);
    return {
        flattened,
        splitAdded,
        removed,
        outlierCount: stats.outlierCount,
        surfaceCount: stats.surfaceCount,
        totalBefore: N,
        totalAfter: w,
        columns: outArrays.map((d, idx) => ({ name: propDescs[idx].name, data: (d as any).subarray(0, w) })),
        usedWorker: false
    };
}

/**
 * Run the surface refine pipeline, preferring the worker. Falls back to the
 * main-thread implementation on any worker failure.
 */
export const refineSurfaceInWorker = async (
    bufs: RefineBuffers,
    options: { strength: number; edgeSplit: boolean; removeScatter: boolean; targetSplitSize: number },
    onProgress?: (fraction: number) => void,
    // A2 (docs/audit/00-总结.md): the fallback copy used to be taken UNCONDITIONALLY before the
    // transfer — 741MB on a 13M model, duplicated on the main thread for a path that only runs if
    // the worker fails or times out (10 minutes). It is now a provider the caller supplies, so the
    // bytes are only materialised when the fallback actually fires. The caller can rebuild them
    // from data the transfer does not touch (the splat itself), which is what surface-refiner does.
    fallbackProvider?: () => RefineBuffers
): Promise<RefineOutcome> => {
    let w: Worker | null = null;
    try {
        w = getWorker();
    } catch {
        return refineSurfaceMainThread(bufs, options, onProgress);
    }

    // The transferred buffers are DETACHED on the main thread the moment
    // postMessage runs (their typed arrays become length 0), so a fallback needs pristine bytes from
    // somewhere. They used to be copied here, up front, for every refine (see the signature note).
    // `fallbackProvider` supplies them lazily instead; when the caller does not supply one we keep
    // the old eager copy so this entry point stays safe on its own.
    const fallbackBufs: RefineBuffers = fallbackProvider ? null : {
        x: bufs.x.slice(),
        y: bufs.y.slice(),
        z: bufs.z.slice(),
        s0: bufs.s0.slice(),
        s1: bufs.s1.slice(),
        s2: bufs.s2.slice(),
        r0: bufs.r0.slice(),
        r1: bufs.r1.slice(),
        r2: bufs.r2.slice(),
        r3: bufs.r3.slice(),
        op: bufs.op.slice(),
        state: bufs.state.slice(),
        extra: bufs.extra.map(c => ({ name: c.name, data: c.data.slice() })),
        N: bufs.N
    };

    const result = new Promise<RefineOutcome>((resolve, reject) => {
        const id = ++msgId;
        pending.set(id, { resolve, reject, onProgress });
        try {
            w!.postMessage({
                id,
                type: 'refine',
                options,
                x: bufs.x,
                y: bufs.y,
                z: bufs.z,
                s0: bufs.s0,
                s1: bufs.s1,
                s2: bufs.s2,
                r0: bufs.r0,
                r1: bufs.r1,
                r2: bufs.r2,
                r3: bufs.r3,
                op: bufs.op,
                state: bufs.state,
                extra: bufs.extra,
                N: bufs.N
            }, [
                bufs.x.buffer, bufs.y.buffer, bufs.z.buffer,
                bufs.s0.buffer, bufs.s1.buffer, bufs.s2.buffer,
                bufs.r0.buffer, bufs.r1.buffer, bufs.r2.buffer, bufs.r3.buffer,
                bufs.op.buffer, bufs.state.buffer,
                ...bufs.extra.map(c => c.data.buffer)
            ]);
        } catch (e) {
            pending.delete(id);
            reject(new Error(`surface-worker transfer failed: ${(e as any)?.message ?? e}`));
        }
    });

    try {
        // Guard against a worker that never responds (e.g. crashed silently
        // in a packaged asar / file:// environment): if no result arrives in
        // a generous window, fall back to the main-thread implementation so
        // the operation still completes.
        const outcome = await Promise.race([
            result,
            new Promise<RefineOutcome>((_, reject) => {
                setTimeout(() => reject(new Error('surface-worker timeout')), 10 * 60 * 1000);
            })
        ]);
        onProgress?.(1);
        return outcome;
    } catch (e) {
        // Worker path failed or timed out -- last-resort main-thread compute on pristine bytes:
        // either the lazily rebuilt buffers (provider) or the eagerly kept copy.
        console.warn('[surface-refine] worker failed, using main-thread fallback:', (e as any)?.message ?? e);
        const pristine = fallbackBufs ?? fallbackProvider?.();
        if (!pristine) {
            throw e instanceof Error ? e : new Error(String(e));
        }
        return refineSurfaceMainThread(pristine, options, onProgress);
    }
};
