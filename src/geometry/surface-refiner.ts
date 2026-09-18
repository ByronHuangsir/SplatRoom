/**
 * Surface Refinement Engine for Gaussian Splatting (SplatRoom 2.0).
 *
 * One-click pipeline, shared single analysis pass:
 *
 *   1. Analyze  --covariance eigen-decomposition + neighbourhood PCA surface
 *                 analysis (real normals, local thickness, signed distance,
 *                 local density) --see surface-analyzer.ts.
 *   2. Flatten  --compress the largest axis of OUTWARD-protruding outliers
 *                 down toward the local thickness and align them to the real
 *                 neighbourhood normal.
 *   3. Split     --subdivide still-oversized surface gaussians into smaller
 *                 pieces along the surface normal, with strict global budget
 *                 control (total added 'N×3%, ' per gaussian) so density
 *                 gain never explodes.
 *   4. Cleanup   --remove only gaussians that are BOTH isolated AND outside
 *                 the local surface (signedDist > 2× thickness). Interior
 *                 points and surface-fitting edges are never removed, so the
 *                 model cannot be punched through.
 *
 * Undo/redo snapshots and the independent Level-2 helper are preserved.
 */

import { Asset, GSplatData, GSplatResource } from 'playcanvas';

import {
    analyzeAll,
    detectOutliers,
    GaussShape,
    type GaussAnalysisColumns,
    type OutlierStats
} from './surface-analyzer';
import type { Splat } from '../splat/splat';

// ---- shared constants ------------------------------------------------------

// Splats to EXCLUDE from refinement: only locked(2) and deleted(4) rows are
// skipped --a merely-selected(1) gaussian must still be processed.
const SKIP_STATE_MASK = 6; // State.locked | State.deleted

// ---- types ----------------------------------------------------------------

export interface SurfaceRefineOptions {
    /** Compression strength for protruding outliers [0-1]. Default 0.6 */
    strength?: number;
    /** Whether to split oversized gaussians (density fill). Default true */
    edgeSplit?: boolean;
    /** Whether to remove isolated gaussians outside the surface. Default true */
    removeScatter?: boolean;
    /** Target size for split gaussians (world units). Default auto from scene scale */
    targetSplitSize?: number;
}

export interface SurfaceRefineResult {
    /** Gaussians flattened (compressed + realigned) */
    flattened: number;
    /** New gaussians added by splitting */
    splitAdded: number;
    /** Gaussians removed by scatter cleanup */
    removed: number;
    /** Outliers detected (flatten candidates) */
    outlierCount: number;
    /** Surface-shaped gaussians */
    surfaceCount: number;
    /** Count before the operation */
    totalBefore: number;
    /** Count after the operation */
    totalAfter: number;
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
        x: data.getProp('x') as Float32Array,
        y: data.getProp('y') as Float32Array,
        z: data.getProp('z') as Float32Array,
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
        opacity: arrs.opacity ? new Float32Array(arrs.opacity) : undefined
    };
}

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

// ---- built-in tuning constants (kept out of the UI) ------------------------

const SPLIT_BUDGET_FRACTION = 0.03;   // added gaussians '3% of original count
const SPLIT_MAX_PER_GAUSS = 4;        // at most 4 pieces per split source
const SPLIT_SIZE_RATIO = 0.003;       // target split size = diag × ratio
const SPLIT_TRIGGER_RATIO = 2.5;      // split when maxScale > targetSize × ratio
const SPLIT_OUTSIDE_FACTOR = 2.0;     // split only gaussians ON the surface (signedDist < thickness × factor)
const CLEANUP_MIN_NEIGHBORS = 5;      // below this neighbour count = isolated (coarse density)
const CLEANUP_DIST_FACTOR = 1.0;      // delete only when clearly outside: signedDist > thickness × factor
const CLEANUP_EDGE_FRAC = 0.25;       // edge gaussians (scaled, kept) below median×frac
const GIANT_RATIO = 0.05;             // gaussian larger than diag × ratio = "giant"
const GIANT_ALPHA = 0.25;             // giant AND more transparent than this -remove (piercing blob)
const OUTLIER_MAX_SCALE_RATIO = 0.2;  // outlier detection scale cap (diag × ratio); raised so big blobs are processed
// Isolation = nearest-neighbour distance far beyond the local feature scale
// (10× local thickness, 4× own max scale). Interior points surrounded by the
// surface have small nnDist and are never flagged as isolated, so cleanup can
// not punch holes even if the centroid-based normal sign is imperfect.
const ISOLATE_THICKNESS_FACTOR = 10;
const ISOLATE_SCALE_FACTOR = 4;
// Penetration: the gaussian CENTRE sits OUTSIDE the surface (signedDist >
// thickness) yet its radius reaches far past "centre distance + thickness" --// i.e. it spans across the surface. On-surface bumps (signedDist '0) are NOT
// penetration: they are flattened instead.
const PENETRATE_MIN_RATIO = 8;        // maxScale > thickness × ratio
const PENETRATE_SPAN_FACTOR = 1.5;    // maxScale > (signedDist + thickness) × factor
// Detached cluster: wide-region density AND local density both far below the
// medians --a group of scatter points floating off the body (they have mutual
// neighbours, so nnDist isolation alone misses them). Thresholds are strict so
// model boundary / thin-part points (still on the surface) are not removed.
const REGION_SPARSE_FRAC = 0.1;
const LOCAL_SPARSE_FRAC = 0.3;
// Relative scale/alpha vs the surface MEDIANS: protruding / scattered points
// are typically much larger or much more transparent than the body gaussians.
const SCALE_REL_FACTOR = 3;      // maxScale > 3× median surface scale
const ALPHA_REL_FACTOR = 0.5;    // alpha < 0.5× median surface alpha

// ---- core refinement logic ------------------------------------------------

/**
 * One-click surface refinement: flatten + split + cleanup in a single pass
 * over one shared analysis. Works on a clone so the live data is only swapped
 * in when the returned asset is applied.
 *
 * The CPU-bound pipeline runs in a Web Worker (surface-worker.js) so complex
 * models do not freeze the UI; the main thread clones the data, transfers the
 * column buffers, and rebuilds the output GSplatData/Asset from the returned
 * buffers. Falls back to an identical main-thread implementation when the
 * worker is unavailable. Progress is reported through the scene's
 * `progressUpdate` event.
 */
export async function refineSurface(
    splat: Splat,
    options: SurfaceRefineOptions = {}
): Promise<{ asset: Asset; result: SurfaceRefineResult }> {
    const gsplatData = cloneGSplatData(splat.splatData);

    // Extract the per-gaussian columns the pipeline mutates (transferable).
    const getFloat = (name: string): Float32Array => {
        const p = gsplatData.getProp(name);
        return p as Float32Array;
    };
    const x = getFloat('x');
    const y = getFloat('y');
    const z = getFloat('z');
    const s0 = getFloat('scale_0');
    const s1 = getFloat('scale_1');
    const s2 = getFloat('scale_2');
    const r0 = getFloat('rot_0');
    const r1 = getFloat('rot_1');
    const r2 = getFloat('rot_2');
    const r3 = getFloat('rot_3');
    const op = getFloat('opacity');
    const state = gsplatData.getProp('state') as Uint8Array;
    const N = gsplatData.numSplats;

    // Generic extra columns carried through unchanged (SH/DC coefficients--.
    const known = new Set(['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3', 'opacity', 'state']);
    const extra: { name: string; data: Float32Array }[] = [];
    for (const el of gsplatData.elements) {
        for (const p of el.properties) {
            if (known.has(p.name)) continue;
            if (p.storage instanceof Float32Array) {
                extra.push({ name: p.name, data: p.storage });
            }
        }
    }

    // Progress report through the shared events bus.
    const fireProgress = (progress: number, text?: string) => {
        splat.scene.events.fire('progressUpdate', { progress, text });
    };

    const { refineSurfaceInWorker } = await import('../workers/surface-worker-client');

    // A2: the fallback buffers are only built if the worker path actually fails. `gsplatData` here
    // is a CLONE of the splat, and the clone's arrays are the ones transferred (detached) — the
    // splat's own storage is untouched, so it can be re-cloned on demand. That replaces the
    // unconditional pre-transfer copy (741MB on a 13M model, for a path that normally never runs).
    const buildBuffers = (data: typeof gsplatData) => {
        const get = (name: string) => data.getProp(name) as Float32Array;
        const extraCols: { name: string; data: Float32Array }[] = [];
        const knownNames = new Set(['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3', 'opacity', 'state']);
        for (const el of data.elements) {
            for (const prop of el.properties) {
                if (knownNames.has(prop.name)) continue;
                if (prop.storage instanceof Float32Array) {
                    extraCols.push({ name: prop.name, data: prop.storage });
                }
            }
        }
        return {
            x: get('x'),
            y: get('y'),
            z: get('z'),
            s0: get('scale_0'),
            s1: get('scale_1'),
            s2: get('scale_2'),
            r0: get('rot_0'),
            r1: get('rot_1'),
            r2: get('rot_2'),
            r3: get('rot_3'),
            op: get('opacity'),
            state: data.getProp('state') as Uint8Array,
            extra: extraCols,
            N: data.numSplats
        };
    };

    const outcome = await refineSurfaceInWorker({
        x, y, z, s0, s1, s2, r0, r1, r2, r3, op, state, extra, N
    }, {
        strength: options.strength ?? 0.6,
        edgeSplit: options.edgeSplit !== false,
        removeScatter: options.removeScatter !== false,
        targetSplitSize: options.targetSplitSize ?? 0
    }, f => fireProgress(Math.round(95 * f)), () => buildBuffers(cloneGSplatData(splat.splatData)));

    // Rebuild the GSplatData from the returned columns.
    // getProp returns the storage (typed array), not the property descriptor,
    // so read byteSize/type from the vertex property list (state must stay
    // byteSize 1, otherwise any stride-based consumer misreads the column).
    const vertexProps = gsplatData.getElement('vertex').properties as any[];
    const propOf = (name: string) => vertexProps.find((p: any) => p.name === name);
    const outProps = outcome.columns.map((c) => {
        const srcProp = propOf(c.name);
        const byteSize = srcProp?.byteSize ?? (c.data instanceof Uint8Array ? 1 : c.data.BYTES_PER_ELEMENT ?? 4);
        const type = srcProp?.type ?? (c.data instanceof Uint8Array ? 'uchar' : 'float');
        return {
            type,
            name: c.name,
            byteSize,
            storage: c.data
        };
    });
    const outData = new GSplatData([{ name: 'vertex', count: outcome.totalAfter, properties: outProps }], gsplatData.comments.slice());

    const device = splat.scene.app.graphicsDevice;
    const resource = new GSplatResource(device, outData);
    const asset = createLoadedAsset(resource, 'surface-refined', splat.name || 'splat');
    splat.scene.app.assets.add(asset);

    return {
        asset,
        result: {
            flattened: outcome.flattened,
            splitAdded: outcome.splitAdded,
            removed: outcome.removed,
            outlierCount: outcome.outlierCount,
            surfaceCount: outcome.surfaceCount,
            totalBefore: outcome.totalBefore,
            totalAfter: outcome.totalAfter
        }
    };
}

/**
 * Deep-copy the current scale and rotation arrays for undo/redo.
 */
function snapshotScaleRotation(splat: Splat) {
    const arrs = extractArrays(splat);
    return cloneArrays(arrs);
}

export type ScaleRotationSnapshot = ReturnType<typeof snapshotScaleRotation>;

/**
 * Restore a previously saved snapshot into the live arrays.
 */
function restoreSnapshot(splat: Splat, snap: ScaleRotationSnapshot) {
    const arrs = extractArrays(splat);
    restoreArrays(arrs, snap);
}

// ==========================================================================
// Level 2 --outside-scatter cleanup (standalone helper)
// Removes only isolated gaussians clearly outside the local surface and
// scales down surface-fitting edges (kept). Interior points are protected.
// ==========================================================================

export interface SurfaceRefineLevel2Params {
    edgeRadiusScale: number;
    radiusFraction: number;
    scatterMinNeighbors: number;
    opacityThreshold: number;
    removeScatter: boolean;
    edgeNbrFrac: number;
}

/**
 * Standalone cleanup pass over a GSplatData (typically already flattened).
 * Returns a NEW GSplatData. Async --neighbour counting is chunked.
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
    const op = data.getProp('opacity') as Float32Array;
    const state = data.getProp('state') as Uint8Array;
    const N = data.numSplats;

    const shBands = (data as any).shBands ?? 0;
    const numCoeffs = ([0, 3, 8, 15][shBands] ?? 0);
    const sh: Float32Array[] = [];
    for (let i = 0; i < numCoeffs * 3; i++) {
        sh.push(data.getProp(`f_rest_${i}`) as Float32Array);
    }

    // Shared analysis for real normals / signed distance / density.
    const analyses = await analyzeAll([r0, r1, r2, r3], [s0, s1, s2]);

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < N; i++) {
        if ((state[i] & SKIP_STATE_MASK) !== 0) continue;
        if (x[i] < minX) minX = x[i]; if (y[i] < minY) minY = y[i]; if (z[i] < minZ) minZ = z[i];
        if (x[i] > maxX) maxX = x[i]; if (y[i] > maxY) maxY = y[i]; if (z[i] > maxZ) maxZ = z[i];
    }
    const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
    const bounds = { min: [minX, minY, minZ] as [number, number, number], max: [maxX, maxY, maxZ] as [number, number, number] };

    const stats = await detectOutliers(analyses, [x, y, z], bounds, {
        cellSize: Math.max(diag * params.radiusFraction * 2, 1e-6)
    });

    // Yield once so the spinner can paint before the rebuild pass.
    await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
    });

    const minNeighbors = Math.max(1, params.scatterMinNeighbors);
    const edgeThreshold = stats.medianDensity * params.edgeNbrFrac;
    const logFactor = Math.log(Math.max(0.1, params.edgeRadiusScale));
    const distFactor = CLEANUP_DIST_FACTOR;

    const isEdge = new Uint8Array(N);
    const isRemove = new Uint8Array(N);
    let removeCount = 0;

    for (let i = 0; i < N; i++) {
        if ((state[i] & SKIP_STATE_MASK) !== 0) continue;
        const alpha = 1 / (1 + Math.exp(-op[i]));
        const transparent = alpha < params.opacityThreshold;
        const isolated = analyses.density[i] < minNeighbors;

        // Edge: low density but NOT clearly outside -scale down, keep.
        if (analyses.density[i] < edgeThreshold && analyses.signedDist[i] <= analyses.thickness[i] * distFactor) {
            isEdge[i] = 1;
        }

        // Remove: isolated (or transparent) AND clearly outside the surface.
        // Interior points (signedDist '0) are always protected.
        if (params.removeScatter && (isolated || transparent) && analyses.signedDist[i] > analyses.thickness[i] * distFactor) {
            isRemove[i] = 1;
            removeCount++;
        }
    }

    const outCount = N - removeCount;
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
    const oOp = new Float32Array(outCount);
    const oState = new Uint8Array(outCount);
    const oSh: Float32Array[] = sh.map(() => new Float32Array(outCount));

    let w = 0;
    for (let i = 0; i < N; i++) {
        if ((state[i] & SKIP_STATE_MASK) !== 0 || isRemove[i]) continue;
        oX[w] = x[i]; oY[w] = y[i]; oZ[w] = z[i];
        if (isEdge[i]) {
            oS0[w] = s0[i] + logFactor;
            oS1[w] = s1[i] + logFactor;
            oS2[w] = s2[i] + logFactor;
        } else {
            oS0[w] = s0[i]; oS1[w] = s1[i]; oS2[w] = s2[i];
        }
        oR0[w] = r0[i]; oR1[w] = r1[i]; oR2[w] = r2[i]; oR3[w] = r3[i];
        oOp[w] = op[i]; oState[w] = 0;
        for (let s2i = 0; s2i < sh.length; s2i++) oSh[s2i][w] = sh[s2i][i];
        w++;
    }

    const outProps: any[] = [
        { type: 'float', name: 'x', storage: oX.subarray(0, w), byteSize: 4 },
        { type: 'float', name: 'y', storage: oY.subarray(0, w), byteSize: 4 },
        { type: 'float', name: 'z', storage: oZ.subarray(0, w), byteSize: 4 },
        { type: 'float', name: 'scale_0', storage: oS0.subarray(0, w), byteSize: 4 },
        { type: 'float', name: 'scale_1', storage: oS1.subarray(0, w), byteSize: 4 },
        { type: 'float', name: 'scale_2', storage: oS2.subarray(0, w), byteSize: 4 },
        { type: 'float', name: 'rot_0', storage: oR0.subarray(0, w), byteSize: 4 },
        { type: 'float', name: 'rot_1', storage: oR1.subarray(0, w), byteSize: 4 },
        { type: 'float', name: 'rot_2', storage: oR2.subarray(0, w), byteSize: 4 },
        { type: 'float', name: 'rot_3', storage: oR3.subarray(0, w), byteSize: 4 },
        { type: 'float', name: 'opacity', storage: oOp.subarray(0, w), byteSize: 4 },
        { type: 'uint8', name: 'state', storage: oState.subarray(0, w), byteSize: 1 }
    ];
    for (let s2i = 0; s2i < sh.length; s2i++) {
        outProps.push({ type: 'float', name: `f_rest_${s2i}`, storage: oSh[s2i].subarray(0, w), byteSize: 4 });
    }
    // Preserve DC colour channels if present (f_dc_0..2 copied via generic loop
    // is not handled above --kept for compatibility when present in the input).
    const dc0 = data.getProp('f_dc_0') as Float32Array | undefined;
    const dc1 = data.getProp('f_dc_1') as Float32Array | undefined;
    const dc2 = data.getProp('f_dc_2') as Float32Array | undefined;
    if (dc0 && dc1 && dc2) {
        const oDc0 = new Float32Array(w), oDc1 = new Float32Array(w), oDc2 = new Float32Array(w);
        let k = 0;
        for (let i = 0; i < N; i++) {
            if ((state[i] & SKIP_STATE_MASK) !== 0 || isRemove[i]) continue;
            oDc0[k] = dc0[i]; oDc1[k] = dc1[i]; oDc2[k] = dc2[i];
            k++;
        }
        outProps.splice(10, 0,
            { type: 'float', name: 'f_dc_0', storage: oDc0, byteSize: 4 },
            { type: 'float', name: 'f_dc_1', storage: oDc1, byteSize: 4 },
            { type: 'float', name: 'f_dc_2', storage: oDc2, byteSize: 4 }
        );
    }

    return new GSplatData([{ name: 'vertex', count: w, properties: outProps }]);
}

export { GaussShape };
