/**
 * Surface refine worker --runs the full analyze + flatten + split + cleanup
 * pipeline off the main thread so complex models (millions of gaussians) do
 * not freeze the UI. The main thread clones the splat data, transfers the
 * per-gaussian column buffers here (zero-copy), and receives back the same
 * buffers (with mutations applied) plus the result stats. PlayCanvas-specific
 * wrapping (GSplatData / GSplatResource / Asset) stays on the main thread.
 */

import {
    analyzeAll,
    detectOutliers,
    type GaussAnalysisColumns,
    type OutlierStats
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

// ---- core pipeline (mirrors refineSurface in surface-refiner.ts) -----------

export interface RefineWorkerInput {
    id: number;
    type: 'refine';
    options: {
        strength: number;
        edgeSplit: boolean;
        removeScatter: boolean;
        targetSplitSize: number;
    };
    // per-gaussian columns, all length N (Float32Array / Uint8Array)
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
    // generic extra columns copied through unchanged (e.g. SH coefficients)
    extra: { name: string; data: Float32Array }[];
    N: number;
}

export interface RefineWorkerResult {
    id: number;
    type: 'refine-result';
    flattened: number;
    splitAdded: number;
    removed: number;
    outlierCount: number;
    surfaceCount: number;
    totalBefore: number;
    totalAfter: number;
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
    extra: { name: string; data: Float32Array }[];
    outCount: number;
}

const yield0 = () => new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
});
const CHUNK = 50000;

// Splats to EXCLUDE from refinement. state is a bitmask (selected=1, locked=2,
// deleted=4, splat-state.ts): only locked and deleted rows are skipped --// a merely-selected gaussian must still be processed, otherwise refining after
// any selection silently deletes the selected region.
const SKIP_STATE_MASK = 6; // State.locked | State.deleted

// Report pipeline progress to the main thread. The worker's own heavy loops
// call this between chunks so the UI progress bar advances instead of sitting
// at 0% for minutes on large models.
const postProgress = (id: number, progress: number) => {
    (self as any).postMessage({ id, type: 'refine-progress', progress });
};

// Throttle: at most one progress message per ~200ms to avoid flooding the
// main thread with hundreds of messages.
const makeProgressReporter = (id: number, start: number, end: number) => {
    let last = 0;
    return (frac: number) => {
        const now = performance.now();
        if (now - last < 200) return;
        last = now;
        postProgress(id, start + (end - start) * Math.min(1, frac));
    };
};

self.onmessage = async (e: MessageEvent<RefineWorkerInput>) => {
    const msg = e.data;
    if (msg.type !== 'refine') return;

    const {
        x, y, z, s0, s1, s2, r0, r1, r2, r3, op, state, extra, N
    } = msg;
    const { strength: strengthRaw, edgeSplit: doSplit, removeScatter: doCleanup, targetSplitSize } = msg.options;

    // ---- shared analysis ----
    const analyses: GaussAnalysisColumns = await analyzeAll(
        [r0, r1, r2, r3],
        [s0, s1, s2],
        makeProgressReporter(msg.id, 0, 0.25)
    );

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const boundsReporter = makeProgressReporter(msg.id, 0.25, 0.28);
    for (let start = 0; start < N; start += CHUNK) {
        const end = Math.min(N, start + CHUNK);
        for (let i = start; i < end; i++) {
            if ((state[i] & SKIP_STATE_MASK) !== 0) continue;
            if (x[i] < minX) minX = x[i]; if (y[i] < minY) minY = y[i]; if (z[i] < minZ) minZ = z[i];
            if (x[i] > maxX) maxX = x[i]; if (y[i] > maxY) maxY = y[i]; if (z[i] > maxZ) maxZ = z[i];
        }
        boundsReporter(end / N);
        if (end < N) await yield0();
    }
    const bounds = { min: [minX, minY, minZ] as [number, number, number], max: [maxX, maxY, maxZ] as [number, number, number] };
    const diag = vlen([maxX - minX, maxY - minY, maxZ - minZ]) || 1;

    const stats: OutlierStats = await detectOutliers(analyses, [x, y, z], bounds, {
        maxScaleRatio: OUTLIER_MAX_SCALE_RATIO,
        // Early-exit exact-NN: isolation only ever compares nnDist against
        // max(thickness*10, maxScale*4), so finding a neighbour within
        // maxScale*4 fixes the verdict — huge speedup on dense models.
        nnEarlyOutFactor: ISOLATE_SCALE_FACTOR
    }, makeProgressReporter(msg.id, 0.28, 0.62));

    // ---- surface baselines ----
    const scaleArr: number[] = [];
    const alphaArr: number[] = [];
    const baseReporter = makeProgressReporter(msg.id, 0.62, 0.66);
    for (let start = 0; start < N; start += CHUNK) {
        const end = Math.min(N, start + CHUNK);
        for (let i = start; i < end; i++) {
            if ((state[i] & SKIP_STATE_MASK) !== 0) continue;
            scaleArr.push(analyses.maxScale[i]);
            alphaArr.push(1 / (1 + Math.exp(-op[i])));
        }
        baseReporter(end / N);
        if (end < N) await yield0();
    }
    scaleArr.sort((a, b) => a - b);
    alphaArr.sort((a, b) => a - b);
    const medianScale = scaleArr.length > 0 ? scaleArr[scaleArr.length >> 1] : 1e-6;
    const medianAlpha = alphaArr.length > 0 ? alphaArr[alphaArr.length >> 1] : 1;

    const strength = Math.max(0, Math.min(1, strengthRaw));
    const targetSize = targetSplitSize > 0 ? targetSplitSize : diag * SPLIT_SIZE_RATIO;

    // ---- pass 0: cleanup detection ----
    // Count deleted/locked splats up front: they must be dropped from the
    // rebuilt output AND from outCount, otherwise the output arrays keep a
    // trailing run of default (all-zero) rows that get exported as garbage
    // (position 0, scale 1, grey, half-transparent) --a real case produced
    // 5M such splats and every viewer black-screened.
    let numDeleted = 0;
    for (let i = 0; i < N; i++) {
        if ((state[i] & SKIP_STATE_MASK) !== 0) numDeleted++;
    }
    const removeFlag = new Uint8Array(N);
    let removed = 0;
    const cleanupReporter = makeProgressReporter(msg.id, 0.66, 0.74);
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
            cleanupReporter(end / N);
            if (end < N) await yield0();
        }
    }

    // ---- pass 1: flatten protruding outliers ----
    let flattened = 0;
    const splitSources: { index: number; k: number; score: number }[] = [];
    const flattenReporter = makeProgressReporter(msg.id, 0.74, 0.88);

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
        flattenReporter(end / N);
        if (end < N) await yield0();
    }

    // ---- pass 2: budget-controlled splitting ----
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

    // ---- pass 3: rebuild arrays (remove deleted + scatter + append splits) ----
    // outCount must subtract deleted/locked splats: the rebuild loop skips them
    // (`state[i] !== 0`) so a larger outCount would leave trailing all-zero
    // rows in every output column. deleted splats also force a rebuild so they
    // are actually removed (previously a file with only deleted splats and no
    // removed/split would return the raw arrays unchanged, keeping them).
    const outCount = N - numDeleted - removed + splitAdded;
    const needsRebuild = removed > 0 || splitAdded > 0 || numDeleted > 0;
    if (!needsRebuild) {
        // Only flattening: buffers already mutated in place.
        postResult(msg, {
            flattened,
            splitAdded: 0,
            removed,
            outlierCount: stats.outlierCount,
            surfaceCount: stats.surfaceCount,
            totalBefore: N,
            totalAfter: N,
            outCount: N
        });
        return;
    }

    // Build a generic property list: the named columns + extra SH columns.
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
    const rebuildReporter = makeProgressReporter(msg.id, 0.88, 1);
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
                // Keep the child cluster centred on the source gaussian: the
                // children spread along the normal by t (span range) below, so
                // no extra world-unit offset — the old hardcoded 1-unit shift
                // scattered children far off the surface on small models.
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
                        // opacity unchanged (keeps coverage), SH/DC/rot inherited
                        (out as any)[w] = srcArr[i];
                    }
                    w++;
                }
            }
        }
        rebuildReporter(end / N);
        if (end < N) await yield0();
    }

    // Slice to the actually-written row count: outArrays were sized to
    // outCount and the rebuild writes exactly `w` rows, so slicing removes any
    // hypothetical trailing garbage and keeps the transferred buffers tight.
    const outX = (outArrays[0] as Float32Array).subarray(0, w);
    const outY = (outArrays[1] as Float32Array).subarray(0, w);
    const outZ = (outArrays[2] as Float32Array).subarray(0, w);
    const outS0 = (outArrays[3] as Float32Array).subarray(0, w);
    const outS1 = (outArrays[4] as Float32Array).subarray(0, w);
    const outS2 = (outArrays[5] as Float32Array).subarray(0, w);
    const outR0 = (outArrays[6] as Float32Array).subarray(0, w);
    const outR1 = (outArrays[7] as Float32Array).subarray(0, w);
    const outR2 = (outArrays[8] as Float32Array).subarray(0, w);
    const outR3 = (outArrays[9] as Float32Array).subarray(0, w);
    const outOp = (outArrays[10] as Float32Array).subarray(0, w);
    const outState = (outArrays[11] as Uint8Array).subarray(0, w);
    const outExtra = extra.map((c, ci) => ({ name: c.name, data: (outArrays[12 + ci] as Float32Array).subarray(0, w) }));

    postResult(msg, {
        flattened,
        splitAdded,
        removed,
        outlierCount: stats.outlierCount,
        surfaceCount: stats.surfaceCount,
        totalBefore: N,
        totalAfter: w,
        outCount: w,
        outX,
        outY,
        outZ,
        outS0,
        outS1,
        outS2,
        outR0,
        outR1,
        outR2,
        outR3,
        outOp,
        outState,
        outExtra
    });
};

function postResult(
    msg: RefineWorkerInput,
    res: {
        flattened: number; splitAdded: number; removed: number;
        outlierCount: number; surfaceCount: number; totalBefore: number; totalAfter: number; outCount: number;
        outX?: Float32Array; outY?: Float32Array; outZ?: Float32Array;
        outS0?: Float32Array; outS1?: Float32Array; outS2?: Float32Array;
        outR0?: Float32Array; outR1?: Float32Array; outR2?: Float32Array; outR3?: Float32Array;
        outOp?: Float32Array; outState?: Uint8Array;
        outExtra?: { name: string; data: Float32Array }[];
    }
) {
    const transfers: ArrayBuffer[] = [];
    const payload: any = {
        id: msg.id,
        type: 'refine-result',
        flattened: res.flattened,
        splitAdded: res.splitAdded,
        removed: res.removed,
        outlierCount: res.outlierCount,
        surfaceCount: res.surfaceCount,
        totalBefore: res.totalBefore,
        totalAfter: res.totalAfter,
        outCount: res.outCount,
        // Explicit extra-column list: the client rebuilds the GSplatData from
        // these (plus the base columns posted below), so it must know which
        // payload keys are extra columns rather than guessing.
        extra: res.outExtra ?? msg.extra
    };

    // Include mutated buffers (or the rebuilt ones when splitting/removal
    // occurred). If the buffers were rebuilt, outX etc. are provided; otherwise
    // the original (mutated) buffers are returned in place.
    const arrays: { name: string; data: Float32Array | Uint8Array }[] = res.outX ?
        [
            { name: 'x', data: res.outX }, { name: 'y', data: res.outY }, { name: 'z', data: res.outZ },
            { name: 'scale_0', data: res.outS0 }, { name: 'scale_1', data: res.outS1 }, { name: 'scale_2', data: res.outS2 },
            { name: 'rot_0', data: res.outR0 }, { name: 'rot_1', data: res.outR1 }, { name: 'rot_2', data: res.outR2 },
            { name: 'rot_3', data: res.outR3 }, { name: 'opacity', data: res.outOp }, { name: 'state', data: res.outState },
            ...(res.outExtra ?? [])
        ] :
        [
            { name: 'x', data: msg.x }, { name: 'y', data: msg.y }, { name: 'z', data: msg.z },
            { name: 'scale_0', data: msg.s0 }, { name: 'scale_1', data: msg.s1 }, { name: 'scale_2', data: msg.s2 },
            { name: 'rot_0', data: msg.r0 }, { name: 'rot_1', data: msg.r1 }, { name: 'rot_2', data: msg.r2 },
            { name: 'rot_3', data: msg.r3 }, { name: 'opacity', data: msg.op }, { name: 'state', data: msg.state },
            ...msg.extra
        ];

    for (const a of arrays) {
        if (!a.data) continue;
        payload[a.name] = a.data;
        const buf = a.data.buffer;
        if (buf && buf.byteLength > 0 && typeof buf.slice === 'function') {
            transfers.push(buf as ArrayBuffer);
        }
    }

    (self as any).postMessage(payload, transfers);
}
