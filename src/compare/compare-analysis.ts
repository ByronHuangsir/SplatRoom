/**
 * CompareAnalysis — per-viewport 2-D overlay for analysing Gaussian splats.
 *
 * Four analysis modes:
 *   1. density      — local point density heatmap (green→red)
 *   2. sharpness    — peak / edge detection with adjustable sensitivity
 *   3. floaters     — detect outlier ("floating cloud") points
 *   4. penetration  — identify thin / penetrable regions along view rays
 *
 * Each mode runs on the CPU using gsplatData.getCenters() and projects the
 * result onto a 2-D canvas overlay.  The overlay is cheap to redraw on
 * camera-change and does NOT modify the 3-D rendering pipeline.
 */

import { Vec3, Vec4, Mat4 } from 'playcanvas';

const SH_C0 = 0.28209479177387814;

// ===========================================================================
// Types
// ===========================================================================

export type AnalysisMode = 'density' | 'sharpness' | 'floaters' | 'penetration' | null;

export interface AnalysisOverlay {
    canvas: HTMLCanvasElement;
    /**
     * Position the overlay canvas in screen space and (optionally) declare a
     * stats-panel region to clip out.  The clip rect is in canvas pixel coords
     * (origin at top-left of the overlay canvas), so pass { x: 0, y: 0, w: panelW,
     * h: vh } for a left-side panel.
     */
    setRect: (x: number, y: number, w: number, h: number) => void;
    refresh: (mode: AnalysisMode, sensitivity: number, gsplatData: any,
              worldMat: Mat4, projMat: Mat4, viewMat: Mat4,
              sourceCanvas?: HTMLCanvasElement,
              sourceRect?: { x: number; y: number; w: number; h: number }) => void;
    dispose: () => void;
    show: () => void;
    hide: () => void;
}

// ===========================================================================
// Helpers — 3-D → 2-D projection
// ===========================================================================

const tmp4 = new Vec4();

function projectPoint(lx: number, ly: number, lz: number,
    worldMat: Mat4, projMat: Mat4, viewMat: Mat4,
    canvasW: number, canvasH: number): [number, number, number] | null {
    // transform local → world via entity world matrix, then view, then projection
    const wp = new Vec3();
    worldMat.transformPoint(new Vec3(lx, ly, lz), wp);
    // world → clip via view*proj
    const vp = new Vec4(wp.x, wp.y, wp.z, 1);
    viewMat.transformVec4(vp, vp);
    if (vp.w <= 0) return null;
    projMat.transformVec4(vp, vp);
    if (vp.w <= 0) return null;
    const ndcX = vp.x / vp.w;
    const ndcY = vp.y / vp.w;
    const ndcZ = vp.z / vp.w;
    if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) return null;
    // NDC[-1,1] → overlay canvas pixels (1:1 mapping)
    const sx = (ndcX + 1) * 0.5 * canvasW;
    const sy = (1 - (ndcY + 1) * 0.5) * canvasH;
    return [sx, sy, ndcZ];
}

// ===========================================================================
// Density heatmap (mode 1)
// ===========================================================================

function computeDensity(centers: Float32Array, gsplatData: any): Float32Array {
    const n = centers.length / 3;
    // Voxel cell size: median point-to-centroid distance * 2
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) {
        cx += centers[i * 3];
        cy += centers[i * 3 + 1];
        cz += centers[i * 3 + 2];
    }
    cx /= n; cy /= n; cz /= n;
    // median distance from centroid
    const dists = new Float32Array(Math.min(n, 3000));
    const step = Math.max(1, Math.floor(n / 3000));
    for (let i = 0; i < dists.length; i++) {
        const idx = i * step;
        const dx = centers[idx * 3] - cx;
        const dy = centers[idx * 3 + 1] - cy;
        const dz = centers[idx * 3 + 2] - cz;
        dists[i] = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    dists.sort();
    const medDist = dists[Math.floor(dists.length / 2)] || 1;
    const cellSize = medDist * 2;

    // spatial hash: cell key → count
    const grid = new Map<number, number>();
    const invCell = 1 / cellSize;
    for (let i = 0; i < n; i++) {
        const gx = Math.floor(centers[i * 3] * invCell);
        const gy = Math.floor(centers[i * 3 + 1] * invCell);
        const gz = Math.floor(centers[i * 3 + 2] * invCell);
        // simple 3-D spatial hash
        const key = (gx * 73856093 ^ gy * 19349663 ^ gz * 83492791) >>> 0;
        grid.set(key, (grid.get(key) || 0) + 1);
    }

    const scores = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const gx = Math.floor(centers[i * 3] * invCell);
        const gy = Math.floor(centers[i * 3 + 1] * invCell);
        const gz = Math.floor(centers[i * 3 + 2] * invCell);
        const key = (gx * 73856093 ^ gy * 19349663 ^ gz * 83492791) >>> 0;
        scores[i] = grid.get(key) || 0;
    }
    return scores;
}

// ===========================================================================
// Sharpness detection (mode 2) — local variance of point distances
// ===========================================================================

function computeSharpness(centers: Float32Array, sensitivity: number): Float32Array {
    const n = centers.length / 3;
    const SAMPLE = Math.min(n, 5000);
    const scores = new Float32Array(n);

    // build a 3-D density grid: count splats per voxel
    const cellSize = estimateCellSize(centers) * 2;
    const invCell = 1 / cellSize;
    const density = new Map<number, number>();

    for (let i = 0; i < SAMPLE; i++) {
        const gx = Math.floor(centers[i * 3] * invCell);
        const gy = Math.floor(centers[i * 3 + 1] * invCell);
        const gz = Math.floor(centers[i * 3 + 2] * invCell);
        const key = (gx * 73856093 ^ gy * 19349663 ^ gz * 83492791) >>> 0;
        density.set(key, (density.get(key) || 0) + 1);
    }

    // for each sampled point, compute local density gradient magnitude —
    // an edge cell is one whose neighbour cells have very different density
    // (e.g., high near surface, low at boundary).
    let globalMax = 0;
    const raw = new Float32Array(SAMPLE);
    for (let i = 0; i < SAMPLE; i++) {
        const gx = Math.floor(centers[i * 3] * invCell);
        const gy = Math.floor(centers[i * 3 + 1] * invCell);
        const gz = Math.floor(centers[i * 3 + 2] * invCell);
        // sample 7 neighbour-cell densities (skip self, use ±x, ±y, ±z)
        const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
        let sum = 0;
        let count = 0;
        for (const [dx, dy, dz] of dirs) {
            const nKey = ((gx + dx) * 73856093 ^ (gy + dy) * 19349663 ^ (gz + dz) * 83492791) >>> 0;
            sum += density.get(nKey) || 0;
            count++;
        }
        const neighborAvg = sum / count;
        const selfDens = density.get((gx * 73856093 ^ gy * 19349663 ^ gz * 83492791) >>> 0) || 0;
        // gradient = difference between self and average of neighbours
        const grad = Math.abs(selfDens - neighborAvg);
        raw[i] = grad;
        if (grad > globalMax) globalMax = grad;
    }

    // normalise then apply sensitivity threshold
    // sensitivity 0..100 → threshold 0.10 .. 0.95 (inverted)
    const sens = Math.max(0, Math.min(100, sensitivity));
    const threshold = 0.95 - sens / 100 * 0.85;   // sens 25 → 0.74
    if (globalMax <= 0) return scores;
    for (let i = 0; i < SAMPLE; i++) {
        const t = raw[i] / globalMax;
        // sigmoid transition
        scores[i] = 1 / (1 + Math.exp(-(t - threshold) * 10));
    }
    return scores;
}

// ===========================================================================
// Floater detection (mode 3) — isolated points with few neighbours
// ===========================================================================

// ===========================================================================
// Floater detection (mode 3) — combine position isolation with opacity + volume
//
// A "floater" is a Gaussian splat that doesn't belong to the main surface.
// SplatRoom exposes four signals that together indicate floaters:
//   1. Position isolation — how few neighbours in a given radius
//   2. Nearest-neighbour distance — true floaters are far from anything
//   3. Opacity — floaters are typically faded (low alpha)
//   4. Volume — floaters often have unusually large size (or unusually small)
// ===========================================================================

function getFloatProperty(gd: any, name: string, n: number): Float32Array | null {
    if (!gd || !gd.getProp) return null;
    try {
        const arr = gd.getProp(name) as Float32Array | null;
        if (!arr || arr.length === 0) return null;
        if (arr.length === n) return arr;
        // length mismatch (e.g. when post-sigmoid not available) → sample
        const out = new Float32Array(n);
        const step = Math.floor(arr.length / n);
        for (let i = 0; i < n; i++) out[i] = arr[Math.min(arr.length - 1, i * step)];
        return out;
    } catch (_) {
        return null;
    }
}

/**
 * Multi-signal floater score (0..1) per splat.  Sensitivity (0..100) acts as
 * a global score threshold: 0 → only show top 5% (very confident); 100 →
 * show everything with score > 0.
 *
 *  - isolationScore: 1 - neighbour-count / 6    (sparse ⇒ high)
 *  - distanceScore:  sigmoid(dist / spacing)    (far ⇒ high)
 *  - opacityScore:   1 - opacity                (faded ⇒ high)
 *  - volumeScore:    |log(volume / median)| / 3 (unusually small or large ⇒ high)
 *
 *  final = w1 * isolation + w2 * distance + w3 * opacity + w4 * volume
 */
function computeFloaters(centers: Float32Array, gsplatData: any, sensitivity: number): Float32Array {
    // Ported from SplatRoom's `floater-removal.ts detectFloaters()`.
    // Four independent strategies, any one of which can flag a floater.
    //
    // Strategies are identical to SplatRoom:
    //   1. isolation  — few neighbours in 27-cell window
    //   2. opacity    — very low opacity (α < threshold)
    //   3. volume     — abnormally large volume (>> mean + k·σ)
    //   4. distance   — far from centroid (> fraction of scene diagonal)
    //
    // sensitivity (0-100) controls per-strategy aggressiveness:
    //   0  = conservative defaults (few floaters detected)
    //   100 = aggressive (any slight anomaly counts)

    const numSplats = centers.length / 3;
    const N = Math.min(numSplats, 8000);   // max sampled points
    const mask = new Float32Array(numSplats);   // 0..1 floater score
    const sens = Math.max(0, Math.min(100, sensitivity));

    // pull raw properties (same as floater-removal.ts)
    const xs: Float32Array = gsplatData?.getProp?.('x') as Float32Array || centers;
    const ys: Float32Array = gsplatData?.getProp?.('y') as Float32Array || centers;
    const zs: Float32Array = gsplatData?.getProp?.('z') as Float32Array || centers;
    const op: Float32Array = gsplatData?.getProp?.('opacity') as Float32Array | null;
    const s0: Float32Array = gsplatData?.getProp?.('scale_0') as Float32Array | null;
    const s1: Float32Array = gsplatData?.getProp?.('scale_1') as Float32Array | null;
    const s2: Float32Array = gsplatData?.getProp?.('scale_2') as Float32Array | null;

    const step = Math.max(1, Math.floor(numSplats / N));

    // ── strategy 2: opacity (low alpha = faded splat = likely noise) ──
    // More aggressive: lower threshold → flag more faded splats.
    if (op) {
        // sens 0→0.45, 65→0.30, 100→0.12
        const thr = Math.max(0.04, 0.48 - sens * 0.0034);
        for (let i = 0; i < N; i++) {
            const idx = Math.min(numSplats - 1, i * step);
            const alpha = 1 / (1 + Math.exp(-op[idx]));
            if (alpha < thr) mask[idx] = 1;
        }
    }

    // ── strategy 3: volume (abnormally large splats) ──
    // More aggressive: tighter k so moderately oversized splats are flagged.
    if (s0 && s1 && s2) {
        let sumV = 0, sumSq = 0, count = 0;
        const vols = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            const idx = Math.min(numSplats - 1, i * step);
            const v = Math.exp(s0[idx]) * Math.exp(s1[idx]) * Math.exp(s2[idx]);
            vols[i] = v;
            sumV += v;
            sumSq += v * v;
            count++;
        }
        if (count > 0) {
            const mean = sumV / count;
            const variance = Math.max(0, sumSq / count - mean * mean);
            const std = Math.sqrt(variance);
            // sens 0→1.8σ, 65→0.85σ, 100→0.35σ — very aggressive
            const k = Math.max(0.35, 1.8 - sens * 0.0145);
            const thr = mean + k * std;
            for (let i = 0; i < N; i++) {
                if (vols[i] > thr) {
                    const idx = Math.min(numSplats - 1, i * step);
                    if (mask[idx] < 1) mask[idx] = 1;
                }
            }
        }
    }

    // ── strategy 1: density-adaptive isolation ──
    // Instead of a fixed minNeighbors threshold, compare each cell's
    // neighbour sum to the average of the densest 20% cells.  A point is
    // flagged as a floater if its local density is < lowFrac × denseAvg.
    {
        const spacing = estimateCellSize(centers);
        const cellSize = spacing * (5 - sens * 0.03);  // sens 0→5×, 65→3×, 100→2×
        const invCell = 1 / cellSize;
        const grid = new Map<string, number>();

        for (let i = 0; i < N; i++) {
            const idx = Math.min(numSplats - 1, i * step);
            const gx = Math.floor(xs[idx] * invCell);
            const gy = Math.floor(ys[idx] * invCell);
            const gz = Math.floor(zs[idx] * invCell);
            const key = `${gx},${gy},${gz}`;
            grid.set(key, (grid.get(key) || 0) + 1);
        }

        // gather all cell counts, sort, pick top 20% as "dense" reference
        const allCounts = Array.from(grid.values());
        allCounts.sort((a, b) => b - a);  // descending
        const denseCount = Math.max(1, Math.ceil(allCounts.length * 0.20));
        let denseSum = 0;
        for (let i = 0; i < denseCount; i++) denseSum += allCounts[i];
        const denseAvg = denseSum / denseCount;   // avg splats per cell in densest 20%

        // threshold: sens 0→0.12 (very strict, only extreme voids), sens 100→0.01 (everything)
        const lowFrac = Math.max(0.01, 0.14 - sens * 0.0013);
        const minNeighbors = Math.max(1, Math.round(denseAvg * lowFrac));

        for (let i = 0; i < N; i++) {
            const idx = Math.min(numSplats - 1, i * step);
            const gx = Math.floor(xs[idx] * invCell);
            const gy = Math.floor(ys[idx] * invCell);
            const gz = Math.floor(zs[idx] * invCell);
            let neighbors = 0;
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dz = -1; dz <= 1; dz++) {
                        neighbors += grid.get(`${gx + dx},${gy + dy},${gz + dz}`) || 0;
                    }
                }
            }
            neighbors--; // minus self
            if (neighbors < minNeighbors && mask[idx] < 1) mask[idx] = 1;
        }
    }

    // ── strategy 4: distance from centroid ──
    {
        let cx = 0, cy = 0, cz = 0, diag = 0;
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < N; i++) {
            const idx = Math.min(numSplats - 1, i * step);
            cx += xs[idx]; cy += ys[idx]; cz += zs[idx];
            if (xs[idx] < minX) minX = xs[idx];
            if (ys[idx] < minY) minY = ys[idx];
            if (zs[idx] < minZ) minZ = zs[idx];
            if (xs[idx] > maxX) maxX = xs[idx];
            if (ys[idx] > maxY) maxY = ys[idx];
            if (zs[idx] > maxZ) maxZ = zs[idx];
        }
        if (N > 0) {
            cx /= N; cy /= N; cz /= N;
            diag = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2);
            const frac = Math.max(0.01, 0.55 - sens * 0.004);  // sens 0→0.55, 65→0.29, 100→0.15
            const distThrSq = (frac * diag) ** 2;
            for (let i = 0; i < N; i++) {
                const idx = Math.min(numSplats - 1, i * step);
                const dx = xs[idx] - cx;
                const dy = ys[idx] - cy;
                const dz = zs[idx] - cz;
                if (dx * dx + dy * dy + dz * dz > distThrSq && mask[idx] < 1) mask[idx] = 1;
            }
        }
    }
    return mask;
}

// ===========================================================================
// Penetration detection — replaced by drawPenetrationHoles() inside the
// closure (depth-sorted alpha accumulation).  The old ray-stack approach
// had incorrect projection math and ignored opacity entirely.
// ===========================================================================
// Color mapping: score → [r, g, b, a]
// ===========================================================================
// Density: contour-style colours — cool (low) → hot (high)
// ===========================================================================

function densityContour(t: number): string {
    // t: 0 (sparse/cool) … 1 (dense/hot)
    // HSL gradient: 240° (blue) → 180° (cyan) → 120° (green) → 60° (yellow) → 0° (red)
    const h = 240 - 240 * t;  // 240→0
    const s = 85;
    const l = 25 + 35 * t;    // darker at low density, brighter at high
    return `hsl(${h},${s}%,${l}%)`;
}

// ===========================================================================
// Sharpness / peak: green (low) → yellow → red (high), focus-peaking style
// ===========================================================================

function peakColor(t: number): string {
    // t: 0 (no edge) → 1 (sharp edge)
    const h = 120 - 120 * t;  // 120° green → 0° red through yellow
    const s = 90;
    const l = 50;
    return `hsl(${h},${s}%,${l}%)`;
}

// HSL → RGB helper (returns [0..255])
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
    let r: number, g: number, b: number;
    if (s === 0) {
        r = g = b = l;
    } else {
        const hue2rgb = (p: number, q: number, t: number) => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1 / 6) return p + (q - p) * 6 * t;
            if (t < 1 / 2) return q;
            if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
            return p;
        };
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue2rgb(p, q, h + 1 / 3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1 / 3);
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

// ===========================================================================
// Estimate a good cell size from the data
// ===========================================================================

function estimateCellSize(centers: Float32Array): number {
    const n = centers.length / 3;
    let cx = 0, cy = 0, cz = 0;
    const sample = Math.min(n, 2000);
    const step = Math.max(1, Math.floor(n / sample));
    for (let i = 0; i < sample; i++) {
        const idx = i * step;
        cx += centers[idx * 3];
        cy += centers[idx * 3 + 1];
        cz += centers[idx * 3 + 2];
    }
    cx /= sample; cy /= sample; cz /= sample;
    const dists = new Float32Array(sample);
    for (let i = 0; i < sample; i++) {
        const idx = i * step;
        const dx = centers[idx * 3] - cx;
        const dy = centers[idx * 3 + 1] - cy;
        const dz = centers[idx * 3 + 2] - cz;
        dists[i] = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    dists.sort();
    return dists[Math.floor(sample / 2)] * 0.3 || 1;
}

// ===========================================================================
// Public factory
// ===========================================================================

export function createAnalysisOverlay(): AnalysisOverlay {
    const canvas = document.createElement('canvas');
    canvas.className = 'compare-analysis-overlay';
    Object.assign(canvas.style, {
        position: 'fixed',          // matches PlayCanvas canvas stacking
        left: '0px',
        top: '0px',
        pointerEvents: 'none',
        zIndex: '100',              // above PlayCanvas canvas
        mixBlendMode: 'normal'
    } as CSSStyleDeclaration);
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d')!;
    let visible = false;

    function show() {
        visible = true;
        canvas.style.display = '';
    }
    function hide() {
        visible = false;
        canvas.style.display = 'none';
    }

    function setRect(x: number, y: number, w: number, h: number) {
        canvas.style.left = `${x}px`;
        canvas.style.top = `${y}px`;
        canvas.width = w;
        canvas.height = h;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
    }

    let lastCenters: Float32Array | null = null;

    // Apply clip that EXCLUDES the stats panel region, then blit a source
    //  canvas to the overlay.  Uses `clip('evenodd')` to subtract the panel
    //  rect from the full overlay rect.
    function blitExcludingClip(src: CanvasImageSource, dx: number, dy: number, dw: number, dh: number) {
        // overlay canvas now covers ONLY the 3-D rendering region (set in
        // compare-scene.ts layoutStatsPanels), so the stats panel is
        // completely outside our draw area.  No clip needed.
        ctx.drawImage(src, dx, dy, dw, dh);
    }

    function withClipMask(fn: () => void) {
        fn();
    }
    let lastGd: any = null;

    function getCenters(gd: any): Float32Array | null {
        if (gd === lastGd && lastCenters) return lastCenters;
        try {
            lastCenters = gd.getCenters?.() ?? null;
            lastGd = gd;
        } catch (_) {
            lastCenters = null;
        }
        return lastCenters;
    }

    function refresh(mode: AnalysisMode, sensitivity: number,
        gsplatData: any, worldMat: Mat4, projMat: Mat4, viewMat: Mat4,
        sourceCanvas?: HTMLCanvasElement,
        sourceRect?: { x: number; y: number; w: number; h: number }) {
        if (!mode || !visible) {
            ctx.clearRect(0, 0, canvas.width, canvas.height); return;
        }
        const cw = canvas.width;
        const ch = canvas.height;
        ctx.clearRect(0, 0, cw, ch);

        if (!cw || !ch) return;

        // image-based analysis: read pixels from the source 3-D canvas and
        // run a simple Sobel-style edge detector for sharpness, or compute
        // a heatmap from per-cell luma for density.
        if (mode === 'sharpness' && sourceCanvas) {
            return drawImageSharpness(sourceCanvas, sensitivity, sourceRect);
        }
        if (mode === 'density' && sourceCanvas) {
            return drawImageDensity(sourceCanvas, sensitivity, sourceRect);
        }
        if (mode === 'penetration') {
            // combined hole detection: Gaussian-based (transmittance + cumulative
            // opacity) + pixel-based (brightness).  Pixel-based catches cases
            // where the Gaussian surface is opaque but the rendered pixel is
            // dark because the background showing through is dark.
            const centers2 = getCenters(gsplatData);
            if (!centers2 || centers2.length === 0) return;
            return drawPenetrationHoles(centers2, gsplatData, sensitivity,
                worldMat, projMat, viewMat, cw, ch,
                sourceCanvas, sourceRect);
        }

        // fallback: per-point rendering for the remaining modes
        const centers = getCenters(gsplatData);
        if (!centers || centers.length === 0) return;
        const n = centers.length / 3;
        // 8000 采样（与浮云分析 v1 初版一致）—— 保持覆盖面广
        const sample = Math.min(n, 8000);
        const step = Math.max(1, Math.floor(n / sample));

        // ---- compute feature scores ----
        let scores: Float32Array | null = null;

        switch (mode) {
            case 'floaters': {
                scores = computeFloaters(centers, gsplatData, sensitivity);
                break;
            }
        }

        if (!scores) return;

        // ---- project all sample points + accumulate per-pixel data ----
        // grid cells for contour / focus-peaking rendering
        // density uses a coarser grid for the smooth-blob contour look;
        // sharpness uses a finer grid for crisp edge detection.
        const div = mode === 'density' ? 8 : 4;
        const gw = Math.max(2, Math.floor(cw / div));
        const gh = Math.max(2, Math.floor(ch / div));
        const grid = new Float32Array(gw * gh);
        const gridWeight = new Float32Array(gw * gh);
        let gridMax = 0;

        const depthBuf = new Float32Array(cw * ch).fill(Infinity);

        const pointScreenX: number[] = [];
        const pointScreenY: number[] = [];
        const pointScore: number[] = [];
        const pointRadius: number[] = [];  // screen-space radius
        const pointR: number[] = [];      // floater's RGB colour
        const pointG: number[] = [];
        const pointB: number[] = [];

        const fovRad = (50 * Math.PI) / 180;  // default scene FOV

        for (let i = 0; i < sample; i++) {
            const idx = Math.min(n - 1, i * step);
            const sp = projectPoint(
                centers[idx * 3], centers[idx * 3 + 1], centers[idx * 3 + 2],
                worldMat, projMat, viewMat,
                cw, ch
            );
            if (!sp) continue;
            const [sx, sy, sz] = sp;
            const px = Math.floor(sx);
            const py = Math.floor(sy);
            if (px < 0 || px >= cw || py < 0 || py >= ch) continue;

            // depth test
            const dIdx = py * cw + px;
            if (sz >= depthBuf[dIdx]) continue;
            depthBuf[dIdx] = sz;

            // accumulate into coarse grid
            const gx = Math.min(gw - 1, Math.floor(sx / cw * gw));
            const gy = Math.min(gh - 1, Math.floor(sy / ch * gh));
            const gi = gy * gw + gx;
            grid[gi] += scores[idx];
            gridWeight[gi] += 1;

            if (mode === 'sharpness' || mode === 'floaters') {
                pointScreenX.push(sx);
                pointScreenY.push(sy);
                pointScore.push(scores[idx]);
                if (mode === 'floaters') {
                    // compute the floater's true projected radius from its
                    // actual gaussian scales (s0/s1/s2) and distance to
                    // camera.  size on screen ≈ max_scale / dist · fovFactor
                    const camDist = Math.max(0.005, ndcDepthToDist(sz, fovRad, ch));
                    let maxScale = 0.5;  // sensible default world-unit radius
                    try {
                        const s0 = gsplatData.getProp('scale_0') as Float32Array;
                        const s1 = gsplatData.getProp('scale_1') as Float32Array;
                        const s2 = gsplatData.getProp('scale_2') as Float32Array;
                        if (s0 && s1 && s2 && idx < s0.length) {
                            // raw scale is log-space → linear
                            const a = Math.exp(s0[idx]);
                            const b = Math.exp(s1[idx]);
                            const c = Math.exp(s2[idx]);
                            maxScale = Math.max(a, b, c);
                        }
                    } catch (_) {}
                    // fovFactor: pixels per world unit at distance 1 ≈
                    // canvas_h / (2 * tan(fov/2)) ≈ canvas_h / 0.93
                    const fovFactor = ch / (2 * Math.tan(fovRad / 2));
                    let screenR = (maxScale / camDist) * fovFactor;
                    // 原始范围 [8, 80] —— 大圆点形成柔和覆盖
                    screenR = Math.max(8, Math.min(80, screenR));
                    pointRadius.push(screenR);
                    // keep floater's RGB in case future reverts need it
                    const r = sigmoidDc(gsplatData, idx, 0);
                    const g = sigmoidDc(gsplatData, idx, 1);
                    const b = sigmoidDc(gsplatData, idx, 2);
                    pointR.push(r);
                    pointG.push(g);
                    pointB.push(b);
                }
            }
        }
        if (mode !== 'sharpness' && mode !== 'floaters') {
            pointScreenX.length = 0;
            pointScreenY.length = 0;
            pointScore.length = 0;
            pointRadius.length = 0;
        }

        // extra helpers for floaters
        function sigmoidDc(gd: any, idx: number, ch: 0 | 1 | 2): number {
            const name = ch === 0 ? 'f_dc_0' : ch === 1 ? 'f_dc_1' : 'f_dc_2';
            try {
                const arr = gd.getProp(name) as Float32Array;
                if (arr && idx < arr.length) {
                    // f_dc → post-sigmoid RGB, then amplify around 0.5 so pastel
                    // f_dc values stretch into vivid colors.
                    const v = 0.5 + SH_C0 * arr[idx];
                    let s = 1 / (1 + Math.exp(-v));
                    // amplify deviation from 0.5 (×2.5) → vivid colour
                    s = 0.5 + (s - 0.5) * 2.5;
                    return Math.max(0, Math.min(1, s));
                }
            } catch (_) {}
            return 0.5;
        }
        function ndcDepthToDist(ndcZ: number, fov: number, canvasH: number): number {
            // ndcZ is in [-1, 1] after perspective division.
            // Approximate camera distance from ndc depth.
            // For typical perspective: dist ≈ near / ndc_at_X (rough)
            // Simpler: map ndc to a pseudo-distance using FOV
            if (ndcZ >= 1.0) return 100;
            if (ndcZ <= -1.0) return 100;
            const t = (ndcZ + 1) * 0.5;   // 0..1
            return 0.1 + t * 80;           // 0.1 (near) to 80 (far)
        }

        // normalise grid
        for (let i = 0; i < grid.length; i++) {
            if (gridWeight[i] > 0) grid[i] /= gridWeight[i];
            if (grid[i] > gridMax) gridMax = grid[i];
        }

        const imageData = ctx.createImageData(gw, gh);
        if (mode === 'floaters') {
            // ── 1) pale-yellow highlight: marks the floater's gaussian area ──
            // translucent warm-yellow blob sized to the projected splat kernel.
            for (let i = 0; i < pointScreenX.length; i++) {
                const s = pointScore[i];
                if (s < 0.5) continue;
                const x = pointScreenX[i];
                const y = pointScreenY[i];
                const R = pointRadius[i] || 30;
                const grad = ctx.createRadialGradient(x, y, 0, x, y, R);
                grad.addColorStop(0.0, 'rgba(255, 245, 180, 0.85)');
                grad.addColorStop(0.35, 'rgba(255, 230, 120, 0.55)');
                grad.addColorStop(0.70, 'rgba(255, 200, 80, 0.25)');
                grad.addColorStop(1.0, 'rgba(255, 170, 50, 0)');
                ctx.fillStyle = grad;
                ctx.beginPath();
                ctx.arc(x, y, R, 0, Math.PI * 2);
                ctx.fill();
            }
            // ── 2) blue core dots: mark each floater's gaussian centre ──
            for (let i = 0; i < pointScreenX.length; i++) {
                const s = pointScore[i];
                if (s < 0.5) continue;
                const x = pointScreenX[i];
                const y = pointScreenY[i];
                const R = 5;
                const halo = ctx.createRadialGradient(x, y, 0, x, y, R);
                halo.addColorStop(0.2, 'rgba(70, 220, 255, 0.90)');
                halo.addColorStop(0.6, 'rgba(30, 170, 255, 0.55)');
                halo.addColorStop(1.0, 'rgba(15, 90, 220, 0)');
                ctx.fillStyle = halo;
                ctx.beginPath();
                ctx.arc(x, y, R, 0, Math.PI * 2);
                ctx.fill();
                const core = ctx.createRadialGradient(x, y, 0, x, y, R * 0.4);
                core.addColorStop(0.0, 'rgba(255, 255, 255, 0.95)');
                core.addColorStop(0.7, 'rgba(150, 240, 255, 0.6)');
                core.addColorStop(1.0, 'rgba(60, 200, 255, 0)');
                ctx.fillStyle = core;
                ctx.beginPath();
                ctx.arc(x, y, R * 0.4, 0, Math.PI * 2);
                ctx.fill();
            }
            return;
        }

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = gw;
        tempCanvas.height = gh;
        const tempCtx = tempCanvas.getContext('2d')!;
        tempCtx.putImageData(imageData, 0, 0);
        ctx.imageSmoothingEnabled = true;
        blitExcludingClip(tempCanvas, 0, 0, cw, ch);
    }

    // ----------------------------------------------------------------------
    // Image-based analysis: read the current 3-D framebuffer and derive
    // edge sharpness / density from the pixels themselves.
    // ----------------------------------------------------------------------

    // scratch image data reused between frames
    const srcImage = document.createElement('canvas');
    const srcCtx = srcImage.getContext('2d', { willReadFrequently: true })!;
    let srcImageData: ImageData | null = null;
    let srcImageDataW = 0;
    let srcImageDataH = 0;

    function ensureSourceImage(src: HTMLCanvasElement) {
        if (srcImageDataW === src.width && srcImageDataH === src.height) return;
        srcImage.width = src.width;
        srcImage.height = src.height;
        srcImageDataW = src.width;
        srcImageDataH = src.height;
        srcCtx.clearRect(0, 0, src.width, src.height);
        srcImageData = null;
    }

    function readSource(src: HTMLCanvasElement): ImageData | null {
        if (src.width === 0 || src.height === 0) return null;
        try {
            srcCtx.drawImage(src, 0, 0);
            srcImageData = srcCtx.getImageData(0, 0, src.width, src.height);
        } catch (e) {
            // tainted canvas (e.g. cross-origin) — can't read pixels
            return null;
        }
        return srcImageData;
    }

    // Sobel edge detection on the source 3-D framebuffer.  Pixels with
    //  large luminance gradient are highlighted red (focus peaking).
    function drawImageSharpness(src: HTMLCanvasElement, sensitivity: number,
        sourceRect?: { x: number; y: number; w: number; h: number }) {
        if (src.width === 0 || src.height === 0) return;
        const cw = canvas.width, ch = canvas.height;
        if (cw === 0 || ch === 0) return;

        // viewport region within source canvas (in source pixels)
        const rx = sourceRect ? sourceRect.x * src.width : 0;
        const ry = sourceRect ? sourceRect.y * src.height : 0;
        const rw = sourceRect ? sourceRect.w * src.width : src.width;
        const rh = sourceRect ? sourceRect.h * src.height : src.height;

        // copy only the viewport region of source into our scratch canvas
        const srcCanvas = document.createElement('canvas');
        srcCanvas.width = Math.max(1, Math.floor(rw));
        srcCanvas.height = Math.max(1, Math.floor(rh));
        const sCtx = srcCanvas.getContext('2d', { willReadFrequently: true })!;
        sCtx.clearRect(0, 0, srcCanvas.width, srcCanvas.height);
        sCtx.drawImage(src, rx, ry, rw, rh, 0, 0, srcCanvas.width, srcCanvas.height);
        let data: ImageData;
        try {
            data = sCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
        } catch (_) {
            return;
        }
        const sw = data.width, sh = data.height;
        const id = data.data;
        const out = ctx.createImageData(cw, ch);
        const od = out.data;
        const sxr = sw / cw;
        const syr = sh / ch;

        const luma = (i: number) => 0.299 * id[i] + 0.587 * id[i + 1] + 0.114 * id[i + 2];
        const getLuma = (sx: number, sy: number): number => {
            const sxi = Math.max(0, Math.min(sw - 1, sx | 0));
            const syi = Math.max(0, Math.min(sh - 1, sy | 0));
            return luma((syi * sw + sxi) * 4);
        };
        const k = 1;
        const sens = Math.max(0, Math.min(100, sensitivity));
        const threshold = Math.max(5, 40 - sens * 0.35);  // sens 25 → 31.25

        let maxE = 0;
        const edges = new Float32Array(cw * ch);
        for (let y = 1; y < ch - 1; y++) {
            const syA = Math.floor((y - k) * syr);
            const syB = Math.floor(y * syr);
            const syC = Math.floor((y + k) * syr);
            for (let x = 1; x < cw - 1; x++) {
                const sxA = Math.floor((x - k) * sxr);
                const sxB = Math.floor(x * sxr);
                const sxC = Math.floor((x + k) * sxr);
                const tl = getLuma(sxA, syA);
                const t  = getLuma(sxB, syA);
                const tr = getLuma(sxC, syA);
                const l  = getLuma(sxA, syB);
                const r  = getLuma(sxC, syB);
                const bl = getLuma(sxA, syC);
                const b  = getLuma(sxB, syC);
                const br = getLuma(sxC, syC);
                const gx = -tl - 2 * l - bl + tr + 2 * r + br;
                const gy = -tl - 2 * t - tr + bl + 2 * b + br;
                const e = Math.sqrt(gx * gx + gy * gy);
                edges[y * cw + x] = e;
                if (e > maxE) maxE = e;
            }
        }

        // paint red where edge > threshold
        for (let y = 1; y < ch - 1; y++) {
            for (let x = 1; x < cw - 1; x++) {
                const e = edges[y * cw + x];
                if (e < threshold) continue;
                const t = Math.min(1, e / Math.max(1, maxE));
                const idx2 = (y * cw + x) * 4;
                od[idx2]     = 255;
                od[idx2 + 1] = Math.round(30 + 180 * (1 - t));
                od[idx2 + 2] = Math.round(20 + 60 * (1 - t));
                od[idx2 + 3] = Math.round(180 + 75 * t);
            }
        }
        ctx.putImageData(out, 0, 0);
    }

    // Heatmap from the source 3-D framebuffer: average luma per coarse
    //  cell, smoothed into a contour-like overlay.
    function drawImageDensity(src: HTMLCanvasElement, _sensitivity: number,
        sourceRect?: { x: number; y: number; w: number; h: number }) {
        if (src.width === 0 || src.height === 0) return;
        const cw = canvas.width, ch = canvas.height;
        if (cw === 0 || ch === 0) return;

        const rx = sourceRect ? sourceRect.x * src.width : 0;
        const ry = sourceRect ? sourceRect.y * src.height : 0;
        const rw = sourceRect ? sourceRect.w * src.width : src.width;
        const rh = sourceRect ? sourceRect.h * src.height : src.height;

        const srcCanvas = document.createElement('canvas');
        srcCanvas.width = Math.max(1, Math.floor(rw));
        srcCanvas.height = Math.max(1, Math.floor(rh));
        const sCtx = srcCanvas.getContext('2d', { willReadFrequently: true })!;
        sCtx.clearRect(0, 0, srcCanvas.width, srcCanvas.height);
        sCtx.drawImage(src, rx, ry, rw, rh, 0, 0, srcCanvas.width, srcCanvas.height);
        let data: ImageData;
        try {
            data = sCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
        } catch (_) {
            return;
        }
        const sw = data.width, sh = data.height;
        const id = data.data;
        const luma = (i: number) => 0.299 * id[i] + 0.587 * id[i + 1] + 0.114 * id[i + 2];

        // build a coarse grid of average luma
        const div = 8;
        const gw = Math.max(2, Math.floor(cw / div));
        const gh = Math.max(2, Math.floor(ch / div));
        const grid = new Float32Array(gw * gh);
        const gridN = new Float32Array(gw * gh);
        for (let oy = 0; oy < gh; oy++) {
            for (let ox = 0; ox < gw; ox++) {
                const x0 = Math.floor(ox * cw / gw * sw / cw);
                const y0 = Math.floor(oy * ch / gh * sh / ch);
                const x1 = Math.floor((ox + 1) * cw / gw * sw / cw);
                const y1 = Math.floor((oy + 1) * ch / gh * sh / ch);
                let sum = 0, n = 0;
                for (let y = y0; y < y1; y++) {
                    for (let x = x0; x < x1; x++) {
                        const xi = Math.min(sw - 1, x);
                        const yi = Math.min(sh - 1, y);
                        sum += luma((yi * sw + xi) * 4);
                        n++;
                    }
                }
                if (n > 0) {
                    grid[oy * gw + ox] = sum / n;
                    gridN[oy * gw + ox] = n;
                }
            }
        }
        // smooth 3x3
        const smoothed = new Float32Array(grid.length);
        for (let oy = 0; oy < gh; oy++) {
            for (let ox = 0; ox < gw; ox++) {
                let s = 0, w = 0;
                for (let dy = -1; dy <= 1; dy++) {
                    const y2 = oy + dy;
                    if (y2 < 0 || y2 >= gh) continue;
                    for (let dx = -1; dx <= 1; dx++) {
                        const x2 = ox + dx;
                        if (x2 < 0 || x2 >= gw) continue;
                        const k = (dx === 0 && dy === 0) ? 4 : (dx === 0 || dy === 0) ? 2 : 1;
                        s += grid[y2 * gw + x2] * k;
                        w += k;
                    }
                }
                smoothed[oy * gw + ox] = w > 0 ? s / w : 0;
            }
        }
        let sMax = 0;
        for (let i = 0; i < smoothed.length; i++) if (smoothed[i] > sMax) sMax = smoothed[i];

        const imageData = ctx.createImageData(gw, gh);
        for (let oy = 0; oy < gh; oy++) {
            for (let ox = 0; ox < gw; ox++) {
                const i = oy * gw + ox;
                const t = sMax > 0 ? smoothed[i] / sMax : 0;
                if (gridN[i] === 0 || t < 0.05) {
                    imageData.data[i * 4 + 3] = 0; continue;
                }
                const h = 240 - 240 * t;
                const s = 0.95, l = 0.35 + 0.30 * t;
                const [r, g, b] = hslToRgb(h / 360, s, l);
                imageData.data[i * 4]     = r;
                imageData.data[i * 4 + 1] = g;
                imageData.data[i * 4 + 2] = b;
                imageData.data[i * 4 + 3] = Math.round((0.4 + 0.55 * t) * 255);
            }
        }
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = gw;
        tempCanvas.height = gh;
        tempCanvas.getContext('2d')!.putImageData(imageData, 0, 0);
        ctx.imageSmoothingEnabled = true;
        blitExcludingClip(tempCanvas, 0, 0, cw, ch);
    }

    /**
     * Combined hole detection: Gaussian point cloud + rendered pixel brightness.
     *
     * A "hole" is a region where the object's surface is broken, allowing
     * background Gaussians (or dark voids) to visually show through.  There
     * are two complementary signals:
     *
     *   A. Gaussian-based (works on the point cloud, no rendered frame needed):
     *      • Transmittance curve T[i] = Π(1−αⱼ) (TSPE-GS, AAAI 2026):
     *        steep cliff = solid surface, gentle slope = hole
     *      • Cumulative opacity O[i] = Σ(αⱼ+ε) (Unbiased Depth, 2025):
     *        considers Gaussian COUNT, not just opacity product
     *      • Cliff steepness cliffDrop = max(T[i−1] × αᵢ): how concentrated
     *        is the opacity contribution
     *
     *   B. Pixel-based (samples the rendered framebuffer at each cell):
     *      Mid-gray / shadow / dead-black pixels indicate background showing
     *      through the surface.  This catches cases where the Gaussian
     *      surface is locally opaque but the background behind it is dark —
     *      the rendered pixel is dark too, but it's a hole, not a shadow.
     *      Compare each cell's luma against a local neighborhood median:
     *      significantly darker than neighbors = likely hole, not shadow
     *      (shadows affect neighbors uniformly).
     *
     * Algorithm:
     *   1. Project Gaussians into 48×48 grid; bin {depth, alpha}
     *   2. Sample pixel luma at each grid cell from sourceCanvas (if available)
     *   3. Per cell: sort front→back.  Surface/behind separation:
     *        Primary: T closure (T < 0.15)
     *        Fallback: depth gap (> 2× mean)
     *      Compute T_surface, O_surface, cliffDrop, frontCount, behindCount
     *   4. Hole score combines FOUR signals:
     *      a. Gaussian transparency  = T_surface          (GATE)
     *      b. Cumulative opacity density = O_surface / frontCount  (METHOD 2)
     *      c. Cliff steepness = 1 − cliffDrop/0.3        (gentleSlope)
     *      d. Pixel darkness = max(0, 1 − luma/median)   (pixel signal)
     *      gaussianScore = transparency × (0.4×gentleSlope + 0.3×cumulOpac + 0.3×sparsity)
     *      pixelScore    = darkness × hasSurfaceFactor
     *      score = max(gaussianScore, pixelScore) × sensMul × behind-gate
     *
     * Rendered as a contour-style heatmap (smoothed 3×3 + bilinear 4× + 8 bands).
     */
    function drawPenetrationHoles(
        centers: Float32Array,
        gsplatData: any,
        sensitivity: number,
        worldMat: Mat4, projMat: Mat4, viewMat: Mat4,
        cw: number, ch: number,
        sourceCanvas?: HTMLCanvasElement,
        sourceRect?: { x: number; y: number; w: number; h: number }
    ) {
        const n = centers.length / 3;
        if (n === 0 || cw === 0 || ch === 0) return;

        // ── analysis grid — adaptive resolution ──
        // Finer viewports get finer cells (~24 px per cell), clamped 32–96.
        // A fixed 48² grid misses holes smaller than one cell on large viewports.
        const GRID = Math.max(32, Math.min(96, Math.round(cw / 24)));
        const gw = GRID, gh = GRID;

        // ── sample ──  (~13 per cell, scaled with the grid area) ──
        const sample = Math.min(n, GRID * GRID * 13);
        const step = Math.max(1, Math.floor(n / sample));

        // ── opacity data (raw; needs sigmoid: α = 1/(1+e^(-raw))) ──
        const opacityRaw = getFloatProperty(gsplatData, 'opacity', n);

        // ── scale data (GOF-style density weighting: large gaussians contribute
        //    proportionally less to surface density, so a few big translucent
        //    blobs cannot fake a solid surface) ──
        const scale0 = getFloatProperty(gsplatData, 'scale_0', n);
        const scale1 = getFloatProperty(gsplatData, 'scale_1', n);
        const scale2 = getFloatProperty(gsplatData, 'scale_2', n);

        // Per-cell dynamic arrays (sparse: avg ~6 entries per populated cell)
        const cellDepths: number[][] = new Array(gw * gh);
        const cellAlphas: number[][] = new Array(gw * gh);
        const cellScaleEff: number[][] = new Array(gw * gh);
        for (let i = 0; i < gw * gh; i++) {
            cellDepths[i] = []; cellAlphas[i] = []; cellScaleEff[i] = [];
        }

        // ── temporaries (reused, zero per-iteration allocation) ──
        const wp = new Vec3();
        const vp4 = new Vec4();

        // ── Step 1: project + bin ──

        // ── Step 1: project + bin ──
        for (let i = 0; i < sample; i++) {
            const idx = Math.min(n - 1, i * step);
            const lx = centers[idx * 3], ly = centers[idx * 3 + 1], lz = centers[idx * 3 + 2];

            // local → world
            worldMat.transformPoint(wp.set(lx, ly, lz), wp);

            // world → view  (save depth before proj overwrites vp4.z)
            vp4.set(wp.x, wp.y, wp.z, 1);
            viewMat.transformVec4(vp4, vp4);
            if (vp4.w <= 0) continue;
            const viewZ = vp4.z;   // view-space Z: negative; more negative = farther

            // view → clip → NDC → pixels  (reuse vp4)
            projMat.transformVec4(vp4, vp4);
            if (vp4.w <= 0) continue;
            const ndcX = vp4.x / vp4.w;
            const ndcY = vp4.y / vp4.w;
            if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) continue;
            const sx = (ndcX + 1) * 0.5 * cw;
            const sy = (1 - (ndcY + 1) * 0.5) * ch;

            // bin into grid
            const gx = Math.floor((sx / cw) * gw);
            const gy = Math.floor((sy / ch) * gh);
            if (gx < 0 || gx >= gw || gy < 0 || gy >= gh) continue;

            // alpha (sigmoid activation on raw opacity)
            let alpha = 0.5;
            if (opacityRaw) {
                alpha = 1 / (1 + Math.exp(-opacityRaw[idx]));
            }

            const ci = gy * gw + gx;
            cellDepths[ci].push(viewZ);
            cellAlphas[ci].push(alpha);
            // effective linear size (geometric mean of the log-space scales)
            let sEff = 1;
            if (scale0 && scale1 && scale2) {
                sEff = Math.exp((scale0[idx] + scale1[idx] + scale2[idx]) / 3);
            }
            cellScaleEff[ci].push(sEff);
        }

        // ── Step 1.5: sample pixel luma at each grid cell (pixel-based signal) ──
        // Holes often manifest as dark pixels (background showing through).  We
        // sample the source framebuffer at each grid cell center, then compare
        // each cell's luma against a local neighborhood median — significantly
        // darker than neighbors = likely hole (shadows affect neighbors too).
        const cellLuma = new Float32Array(gw * gh);  // 0–1 luma per cell (0 if no source)
        const cellLumaCount = new Uint16Array(gw * gh);  // sample count (for averaging)

        if (sourceCanvas && sourceCanvas.width > 0 && sourceCanvas.height > 0) {
            // sourceRect defines the region of sourceCanvas that maps to (0..cw, 0..ch).
            // Default: full sourceCanvas → full overlay.
            const sRect = sourceRect || {
                x: 0, y: 0, w: sourceCanvas.width, h: sourceCanvas.height
            };
            const srcCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
            if (srcCtx) {
                // Read in coarse blocks (one per grid cell) for performance.
                // Each grid cell covers (cw/gw × ch/gh) source pixels — sample
                // a small NxN patch and average luma.
                const N = 3;  // 3×3 sample patch per cell
                for (let gy = 0; gy < gh; gy++) {
                    for (let gx = 0; gx < gw; gx++) {
                        // cell center in overlay pixels → source pixels
                        const cx = (gx + 0.5) * cw / gw;
                        const cy = (gy + 0.5) * ch / gh;
                        const sx0 = sRect.x + (cx / cw) * sRect.w;
                        const sy0 = sRect.y + (cy / ch) * sRect.h;
                        const sw = sRect.w / gw;
                        const sh = sRect.h / gh;
                        let sumL = 0, cnt = 0;
                        for (let dy = 0; dy < N; dy++) {
                            for (let dx = 0; dx < N; dx++) {
                                const px = Math.floor(sx0 + (dx + 0.5) / N * sw);
                                const py = Math.floor(sy0 + (dy + 0.5) / N * sh);
                                if (px < 0 || py < 0 ||
                                    px >= sourceCanvas.width || py >= sourceCanvas.height) continue;
                                // Sample 2×2 block average (smooths noise)
                                const d = srcCtx.getImageData(
                                    Math.max(0, px - 1), Math.max(0, py - 1), 2, 2
                                ).data;
                                for (let i = 0; i < 4; i++) {
                                    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
                                    // Rec. 709 luma
                                    sumL += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
                                    cnt++;
                                }
                            }
                        }
                        const ci = gy * gw + gx;
                        if (cnt > 0) {
                            cellLuma[ci] = sumL / cnt;
                            cellLumaCount[ci] = cnt;
                        }
                    }
                }
            }
        }

        // Compute local-median luma for each cell (5×5 neighborhood).
        // Cells significantly darker than their local median = potential hole.
        const cellDarkness = new Float32Array(gw * gh);  // 0 = bright/normal, 1 = much darker than neighbors
        {
            // Pre-compute cell-level median (for global fallback)
            const globalLumas: number[] = [];
            for (let c = 0; c < gw * gh; c++) {
                if (cellLumaCount[c] > 0) globalLumas.push(cellLuma[c]);
            }
            globalLumas.sort((a, b) => a - b);
            const globalMed = globalLumas.length > 0 ?
                globalLumas[Math.floor(globalLumas.length / 2)] :
                0.5;

            for (let gy = 0; gy < gh; gy++) {
                for (let gx = 0; gx < gw; gx++) {
                    const ci = gy * gw + gx;
                    if (cellLumaCount[ci] === 0) continue;

                    // Multi-scale darkness: evaluate 5×5 AND 9×9 neighbourhood
                    // medians, keep the stronger (darker) response — a small hole
                    // shows against a 5×5 window, a large hole against 9×9.
                    let darkness = 0;
                    for (const R of [2, 4]) {
                        const nbr: number[] = [];
                        for (let dy = -R; dy <= R; dy++) {
                            for (let dx = -R; dx <= R; dx++) {
                                if (dx === 0 && dy === 0) continue;
                                const nx = gx + dx, ny = gy + dy;
                                if (nx < 0 || nx >= gw || ny < 0 || ny >= gh) continue;
                                const ni = ny * gw + nx;
                                if (cellLumaCount[ni] > 0) nbr.push(cellLuma[ni]);
                            }
                        }
                        let med: number;
                        if (nbr.length >= 3) {
                            nbr.sort((a, b) => a - b);
                            med = nbr[Math.floor(nbr.length / 2)];
                        } else {
                            med = globalMed;
                        }
                        // Darkness: 0 if bright (≥ median), 1 if ≤40% of median.
                        const ratio = cellLuma[ci] / Math.max(0.01, med);
                        const d = ratio >= 1.0 ? 0 :
                            ratio <= 0.4 ? 1 :
                                (1.0 - ratio) / 0.6;
                        if (d > darkness) darkness = d;
                    }
                    cellDarkness[ci] = darkness;
                }
            }
        }

        // ── Step 2: per-cell transmittance analysis (TSPE-GS + Unbiased Depth) ──
        // Transmittance T[i] = Π_{j≤i}(1−αⱼ) models how much light passes through.
        // Cumulative opacity O[i] = Σ(αⱼ+ε) considers Gaussian count + opacity
        // (Unbiased Depth method 2).  Both curves are computed in one pass.
        //
        // A solid surface creates a steep "cliff" in T (drops from ~1 to ~0
        // in a narrow depth range).  A hole creates a "gentle slope" (T stays
        // high → can see through).  No global parameters needed — the curve
        // shape itself is the surface-quality signal.
        //
        // Surface/behind separation:
        //   Primary: T closure — first i where T[i] < CLOSURE_T = surface end
        //   Fallback: depth gap — if T never closes, look for a depth
        //             discontinuity (> 2× mean gap) to split surface/behind

        const CLOSURE_T = 0.15;   // transmittance threshold: 85% opaque = surface closed
        const OPAC_EPS = 0.1;     // cumulative-opacity baseline (Unbiased Depth, ε)

        // Median effective gaussian size across all binned samples — baseline for
        // the GOF-style density weighting (larger gaussians → lower density).
        const allScales: number[] = [];
        for (const arr of cellScaleEff) {
            for (const s of arr) allScales.push(s);
        }
        allScales.sort((a, b) => a - b);
        const medScaleEff = allScales.length > 0 ? allScales[allScales.length >> 1] : 1;

        const T_surface = new Float32Array(gw * gh);    // transmittance at surface end
        const O_surface = new Float32Array(gw * gh);    // cumulative opacity at surface end
        const cliffDrop = new Float32Array(gw * gh);    // max single-Gaussian opacity contribution
        const depthSpread = new Float32Array(gw * gh);  // expected-depth spread (surface+background mix)
        const frontCount = new Float32Array(gw * gh);   // surface-layer Gaussian count
        const behindCount = new Float32Array(gw * gh);  // behind-layer Gaussian count
        const hasSurface = new Uint8Array(gw * gh);

        for (let c = 0; c < gw * gh; c++) {
            const depths = cellDepths[c];
            const alphas = cellAlphas[c];
            const len = depths.length;
            if (len === 0) continue;
            hasSurface[c] = 1;

            // insertion sort front→back (viewZ descending), keeping depths /
            // alphas / scale-weights in sync
            const sEffArr = cellScaleEff[c];
            const hasScale = sEffArr.length === len;
            for (let i = 1; i < len; i++) {
                const d = depths[i], a = alphas[i];
                const s = hasScale ? sEffArr[i] : 1;
                let j = i - 1;
                while (j >= 0 && depths[j] < d) {
                    depths[j + 1] = depths[j];
                    alphas[j + 1] = alphas[j];
                    if (hasScale) sEffArr[j + 1] = sEffArr[j];
                    j--;
                }
                depths[j + 1] = d;
                alphas[j + 1] = a;
                if (hasScale) sEffArr[j + 1] = s;
            }

            // ── compute transmittance + density-weighted opacity + E[d] + closure ──
            let T = 1.0;            // cumulative transmittance
            let O = 0.0;            // cumulative density-weighted opacity (with ε)
            let maxDrop = 0;        // cliff steepness: max(T[i-1] × αᵢ)
            let closureIdx = -1;    // first i where T < CLOSURE_T
            let T_at_closure = 1.0; // T value at closure point
            let O_at_closure = 0.0; // O value at closure point
            let eNum = 0;           // Σ T·α·d  (expected-depth numerator)
            let eDen = 0;           // Σ T·α    (expected-depth denominator)

            for (let i = 0; i < len; i++) {
                const drop = T * alphas[i];   // opacity contribution of this Gaussian
                if (drop > maxDrop) maxDrop = drop;
                // GOF-style density weight: a gaussian much larger than the median
                // effective size contributes proportionally less to surface density,
                // so a few big translucent blobs cannot fake a solid surface.
                const sEff = hasScale ? sEffArr[i] : 1;
                const w = medScaleEff > 0 ? Math.max(0.1, Math.min(1, medScaleEff / sEff)) : 1;
                eNum += T * alphas[i] * depths[i];
                eDen += T * alphas[i];
                T *= (1 - alphas[i]);
                O += (alphas[i] + OPAC_EPS) * w;    // density-weighted cumulative opacity
                if (closureIdx < 0 && T < CLOSURE_T) {
                    closureIdx = i;
                    T_at_closure = T;
                    O_at_closure = O;
                }
            }

            // Expected depth (unbiased depth): far from the front surface when a
            // transparent/holey region mixes surface + background layers.
            const expDepth = eDen > 1e-6 ? eNum / eDen : depths[0];
            const depthRange = Math.max(1e-6, depths[len - 1] - depths[0]);
            depthSpread[c] = Math.max(0, Math.min(1, (expDepth - depths[0]) / depthRange));

            cliffDrop[c] = maxDrop;

            // ── surface / behind separation ──
            let surfaceEnd: number;
            let Tsurf: number;
            let Osurf: number;

            if (closureIdx >= 0) {
                // Transmittance closed → surface is opaque enough.
                // Surface = [0, closureIdx], behind = rest.
                surfaceEnd = closureIdx + 1;
                Tsurf = T_at_closure;   // ≤ CLOSURE_T → low transparency
                Osurf = O_at_closure;
            } else {
                // T never closed → surface is transparent (potential hole).
                // Fallback: depth gap detection to separate surface from behind.
                surfaceEnd = len;
                Tsurf = T;   // T_final (high → transparent → hole signal)
                Osurf = O;

                if (len >= 4) {
                    let sumGap = 0;
                    let maxGap = 0;
                    let maxGapIdx = 1;
                    for (let i = 1; i < len; i++) {
                        const gap = depths[i - 1] - depths[i];   // positive (front→back)
                        sumGap += gap;
                        if (gap > maxGap) {
                            maxGap = gap; maxGapIdx = i;
                        }
                    }
                    const meanGap = sumGap / (len - 1);
                    if (meanGap > 0 && maxGap > meanGap * 2) {
                        // Depth discontinuity found — split here.
                        surfaceEnd = maxGapIdx;
                        // Recompute T and O at the gap point.
                        Tsurf = 1.0;
                        Osurf = 0.0;
                        for (let i = 0; i < maxGapIdx; i++) {
                            Tsurf *= (1 - alphas[i]);
                            Osurf += alphas[i] + OPAC_EPS;
                        }
                    }
                }
            }

            T_surface[c] = Tsurf;
            O_surface[c] = Osurf;
            frontCount[c] = surfaceEnd;
            behindCount[c] = len - surfaceEnd;
        }

        // ── Step 3: median baseline for surface density ──
        // (used only for the sparsity metric; transparency is absolute)
        const sCounts: number[] = [];
        for (let c = 0; c < gw * gh; c++) {
            if (hasSurface[c]) sCounts.push(frontCount[c]);
        }
        if (sCounts.length === 0) return;
        sCounts.sort((a, b) => a - b);
        const medCount = sCounts[Math.floor(sCounts.length / 2)] || 1;

        // ── Step 4: combined hole score (Gaussian + pixel signals) ──
        // Gaussian-based score (transparency-gated):
        //   transparency (GATE) = T_surface          (TSPE-GS transmittance)
        //   cumulOpac (25%)      = O_surface / frontCount (Unbiased Depth, GOF density-weighted)
        //   gentleSlope (30%)    = 1 − cliffDrop / 0.3     (cliff steepness)
        //   sparsity (25%)       = 1 − frontCount / median (relative density)
        //   depthSpread (20%)    = expected-depth spread (surface+background mix)
        //
        // Pixel-based score (catches surface-opaque-but-background-dark cases):
        //   darkness = max(0, 1 − cellLuma / localMedianLuma)  (5×5 and 9×9, max)
        //   pixelScore = darkness × (sparse surface → amplified; dense surface → damped)
        //
        // Combined score = max(gaussianScore, pixelScore) × sensMul × behind-gate
        //   Using max() (not weighted average) so EITHER signal can flag a hole.

        const sens = Math.max(0, Math.min(100, sensitivity));
        const sensMul = 1.0 + sens * 0.015;   // 5–100 → ~1.08–2.5

        const DENSE_CLIFF = 0.3;   // cliffDrop ≥ this = dense surface (not a hole)

        const holeScore = new Float32Array(gw * gh);
        for (let c = 0; c < gw * gh; c++) {
            if (!hasSurface[c]) continue;

            // ── Gaussian-based signals ──
            const transparency = T_surface[c];                                  // 0=opaque, 1=clear
            const gentleSlope  = Math.max(0, 1 - cliffDrop[c] / DENSE_CLIFF);   // 0=dense, 1=diffuse
            const sparsity     = Math.max(0, 1 - frontCount[c] / medCount);     // relative to median
            // Cumulative-opacity density: low average (α+ε) → sparse/transparent surface
            //   ε=0.1, so 5 Gaussians give O=5×(avg_α+0.1); divide by 5 → avg_α+0.1
            //   For solid surface (avg_α ≈ 0.5): cumulOpac ≈ 0.6 → densityScore = 0.0
            //   For hole (avg_α ≈ 0.05): cumulOpac ≈ 0.15 → densityScore = 1.0
            //   (opacity is density-weighted by gaussian size — a few big translucent
            //    blobs cannot fake a solid surface)
            const cumulOpac = Math.max(0, Math.min(1, 1 - O_surface[c] / Math.max(1, frontCount[c]) / 0.5));
            const behind     = behindCount[c] > 0 ? Math.min(1, behindCount[c] / 3) : 0;

            const holeIntensity =
                0.30 * gentleSlope +
                0.25 * cumulOpac +
                0.25 * sparsity +
                0.20 * depthSpread[c];                                          // ∈ [0, 1]
            const gaussianScore = transparency * (0.3 + 0.7 * holeIntensity) * (0.5 + 0.5 * behind);

            // ── Pixel-based signal ──
            // darkness in [0,1].  Amplify if surface is also Gaussian-sparse
            // (so we don't false-positive on dark-but-opaque shadows).
            const pixelBoost = 0.5 + 0.5 * sparsity;  // sparse surface → pixel dark = more credible
            const pixelScore = cellDarkness[c] * pixelBoost * 0.7;  // 0.7 cap so pixel alone isn't dominant

            // ── Combined ──
            const s = Math.max(gaussianScore, pixelScore) * sensMul;
            holeScore[c] = Math.min(1, s);
        }

        // ── Step 5: contour-style heatmap rendering ──
        // 5a. Smooth the score grid (3×3 centre-weighted blur, 1 pass) to
        //     eliminate cell-boundary artefacts and produce organic shapes.
        const smoothed = new Float32Array(gw * gh);
        for (let y = 0; y < gh; y++) {
            for (let x = 0; x < gw; x++) {
                const c = y * gw + x;
                if (!hasSurface[c]) {
                    smoothed[c] = 0; continue;
                }
                let sum = 0, wsum = 0;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = x + dx, ny = y + dy;
                        if (nx < 0 || nx >= gw || ny < 0 || ny >= gh) continue;
                        const ni = ny * gw + nx;
                        if (!hasSurface[ni]) continue;
                        const w = (dx === 0 && dy === 0) ? 4 : 1;
                        sum += holeScore[ni] * w;
                        wsum += w;
                    }
                }
                smoothed[c] = wsum > 0 ? sum / wsum : holeScore[c];
            }
        }
        holeScore.set(smoothed);

        // 5b. Precompute 8 discrete contour-band colours (cyan 180° → red 0°).
        const BANDS = 8;
        const bandRgb: number[][] = [];
        const bandAlpha: number[] = [];
        for (let i = 0; i <= BANDS; i++) {
            const bt = i / BANDS;
            const h = (180 - 180 * bt) / 360;
            bandRgb.push(hslToRgb(h, 0.85, 0.5));
            bandAlpha.push(Math.round((0.12 + 0.68 * bt) * 255));
        }

        // 5c. Render at 4× grid resolution with bilinear interpolation.
        //     Each output pixel interpolates from the 4 nearest grid cells,
        //     then the score is quantised into a contour band.
        const SCALE = 4;
        const rw = gw * SCALE, rh = gh * SCALE;
        const renderData = ctx.createImageData(rw, rh);

        for (let py = 0; py < rh; py++) {
            const fy = (py + 0.5) / SCALE - 0.5;
            const y0 = Math.max(0, Math.min(gh - 1, Math.floor(fy)));
            const y1 = Math.min(gh - 1, y0 + 1);
            const ty = Math.max(0, Math.min(1, fy - y0));

            for (let px = 0; px < rw; px++) {
                const fx = (px + 0.5) / SCALE - 0.5;
                const x0 = Math.max(0, Math.min(gw - 1, Math.floor(fx)));
                const x1 = Math.min(gw - 1, x0 + 1);
                const tx = Math.max(0, Math.min(1, fx - x0));

                const s00 = holeScore[y0 * gw + x0];
                const s01 = holeScore[y0 * gw + x1];
                const s10 = holeScore[y1 * gw + x0];
                const s11 = holeScore[y1 * gw + x1];
                const s0 = s00 * (1 - tx) + s01 * tx;
                const s1 = s10 * (1 - tx) + s11 * tx;
                const score = s0 * (1 - ty) + s1 * ty;

                const t = Math.min(1, score * 1.5);
                if (t < 0.06) continue;

                const bi = Math.min(BANDS, Math.floor(t * BANDS));
                const c = bandRgb[bi];
                const idx = (py * rw + px) * 4;
                renderData.data[idx]     = c[0];
                renderData.data[idx + 1] = c[1];
                renderData.data[idx + 2] = c[2];
                renderData.data[idx + 3] = bandAlpha[bi];
            }
        }

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = rw;
        tempCanvas.height = rh;
        tempCanvas.getContext('2d')!.putImageData(renderData, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(tempCanvas, 0, 0, cw, ch);
    }

    function dispose() {
        canvas.remove();
    }

    return { canvas, setRect, refresh, dispose, show, hide };
}
