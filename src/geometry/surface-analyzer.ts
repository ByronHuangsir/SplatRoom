/**
 * Surface / Outlier Analyzer for Gaussian Splatting (SplatRoom 2.0).
 *
 * From each Gaussian's quaternion rotation + log-scale triple we reconstruct
 * the 3×3 covariance matrix Σ = R·S·Sᵗ·Rᵗ, then eigen-decompose it (Jacobi
 * for symmetric 3x3) to obtain eigenvalues / eigenvectors.
 *
 * Additionally we build a spatial grid in ONE pass (O(N)) and accumulate per
 * cell: point count, position sum and position covariance. Every Gaussian then
 * gathers its 27-neighbourhood statistics to estimate:
 *
 *   localNormal    — neighbourhood PCA surface normal (real neighbour normal,
 *                    not the gaussian's own minor axis)
 *   localThickness — RMS scatter of neighbours along the normal (surrogate for
 *                    distance-to-tangent-plane std-dev, no second pass)
 *   signedDist     — signed distance of this gaussian to the neighbourhood
 *                    plane: positive = OUTSIDE the surface (along normal)
 *   localDensity   — number of neighbours (hole / sparse-region detection)
 *
 * The outlier flag combines scale ratio and signed distance so only gaussians
 * that protrude OUTWARD past the local thickness are flagged; interior noise
 * is never marked (protects against punching holes).
 */

// ---- types ----------------------------------------------------------------

export const enum GaussShape {
    VOLUMETRIC = 0,  // sphere-like (all three axes similar)
    SURFACE = 1,  // pancake (one axis much smaller)
    LINE = 2   // cigar   (two axes much smaller)
}

export interface GaussAnalysis {
    /** Unit-length surface normal (eigenvector of smallest eigenvalue) */
    normal: [number, number, number];
    /** Flatness ratio λ₃ / λ₁  [0=flat, 1=sphere] */
    flatness: number;
    /** Edge-like ratio λ₃ / λ₂ */
    edgeness: number;
    /** Eigenvalues in descending order */
    eigenvals: [number, number, number];
    /** Linear scales in descending order */
    scales: [number, number, number];
    /** Shape classification */
    shape: GaussShape;
    /** Local surface normal estimated from neighbours (PCA). Falls back to own normal when too few neighbours. */
    localNormal: [number, number, number];
    /** Local surface thickness: RMS neighbour scatter along the normal. */
    localThickness: number;
    /** Signed distance to the neighbourhood plane. Positive = outside the surface. */
    signedDist: number;
    /** Number of neighbours within the 27-cell neighbourhood. */
    localDensity: number;
    /** Neighbour count in a wider region (0.04×diag cells, 27 cells) — detects clusters detached from the main surface. */
    regionDensity: number;
    /** Distance to the nearest gaussian (fine grid). Infinity-like when fully isolated. */
    nnDist: number;
    /** Outlier score: maxScale / localThickness (higher = more protruding) */
    outlierScore: number;
    /** True if this gaussian should be refined */
    isOutlier: boolean;
}

export interface OutlierStats {
    total: number;
    outlierCount: number;
    surfaceCount: number;
    lineCount: number;
    volumetricCount: number;
    meanScore: number;
    maxScore: number;
    /** Median neighbour density (sparse-region baseline for split/cleanup). */
    medianDensity: number;
    /** Median REGION density (wider neighbourhood) — baseline for detached-cluster detection. */
    medianRegionDensity: number;
}

/**
 * Compact per-gaussian analysis storage (one column per field). The previous
 * `GaussAnalysis[]` object array costs ~250 bytes per gaussian (JS object
 * overhead) — over 1 GB for a 5M-splat model, which OOM-crashes the surface
 * refine worker. Column stores are ~37 bytes per gaussian (185 MB for 5M).
 */
export interface GaussAnalysisColumns {
    /** Local surface normal (unit length), 3 columns. */
    nx: Float32Array;
    ny: Float32Array;
    nz: Float32Array;
    /** Local surface thickness: RMS neighbour scatter along the normal. */
    thickness: Float32Array;
    /** Signed distance to the neighbourhood plane. Positive = outside. */
    signedDist: Float32Array;
    /** Number of neighbours within the 27-cell neighbourhood. */
    density: Float32Array;
    /** Neighbour count in a wider region (0.04×diag cells). */
    regionDensity: Float32Array;
    /** Distance to the nearest gaussian (fine grid). */
    nnDist: Float32Array;
    /** Outlier score: maxScale / localThickness. */
    score: Float32Array;
    /** Precomputed max linear scale (scales[0]). */
    maxScale: Float32Array;
    /** 1 when this gaussian should be refined. */
    isOutlier: Uint8Array;
    /** Shape class (GaussShape) for stats; not consumed downstream. */
    shape: Uint8Array;
}

// ---- helpers --------------------------------------------------------------

const EPS = 1e-10;

/** Yield to the event loop so a progress UI can paint between chunks. */
const yield0 = () => new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
});

export function quatToRotationMatrix(q: [number, number, number, number]): [
    [number, number, number],
    [number, number, number],
    [number, number, number]
] {
    const [x, y, z, w] = q;
    const x2 = 2 * x, y2 = 2 * y, z2 = 2 * z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;

    return [
        [1 - (yy + zz), xy + wz,       xz - wy],
        [xy - wz,       1 - (xx + zz), yz + wx],
        [xz + wy,       yz - wx,       1 - (xx + yy)]
    ];
}

function mat3mul(
    a: [number, number, number][],
    b: [number, number, number][]
): [number, number, number][] {
    const c: [number, number, number][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            let s = 0;
            for (let k = 0; k < 3; k++) s += a[i][k] * b[k][j];
            c[i][j] = s;
        }
    }
    return c;
}

function mat3transpose(m: [number, number, number][]): [number, number, number][] {
    const t: [number, number, number][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) t[j][i] = m[i][j];
    }
    return t;
}

export function computeCovariance(
    R: [number, number, number][],
    linearScale: [number, number, number]
): [number, number, number][] {
    const s0 = linearScale[0], s1 = linearScale[1], s2 = linearScale[2];
    const rs: [number, number, number][] = [
        [R[0][0] * s0, R[0][1] * s1, R[0][2] * s2],
        [R[1][0] * s0, R[1][1] * s1, R[1][2] * s2],
        [R[2][0] * s0, R[2][1] * s1, R[2][2] * s2]
    ];
    return mat3mul(rs, mat3transpose(rs));
}

export function eigenDecompSym3x3(
    A: [number, number, number][]
): { values: [number, number, number]; vectors: [number, number, number][] } {
    const a = A.map(row => [...row]) as [number, number, number][];
    const V: [number, number, number][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

    const MAX_SWEEPS = 20;
    const TOL = 1e-12;

    for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
        let p = 0, q = 1;
        let maxOff = 0;
        for (let i = 0; i < 2; i++) {
            for (let j = i + 1; j < 3; j++) {
                const v = Math.abs(a[i][j]);
                if (v > maxOff) {
                    maxOff = v; p = i; q = j;
                }
            }
        }
        if (maxOff < TOL) break;

        const theta = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]);
        const c = Math.cos(theta), s = Math.sin(theta);

        for (let k = 0; k < 3; k++) {
            if (k === p || k === q) continue;
            const akp = a[k][p], akq = a[k][q];
            a[k][p] = a[p][k] = c * akp - s * akq;
            a[k][q] = a[q][k] = s * akp + c * akq;
        }
        const app = a[p][p], aqq = a[q][q], apq = a[p][q];
        a[p][p] = c * c * app + s * s * aqq - 2 * c * s * apq;
        a[q][q] = s * s * app + c * c * aqq + 2 * c * s * apq;
        a[p][q] = a[q][p] = 0;

        for (let k = 0; k < 3; k++) {
            const vkp = V[k][p], vkq = V[k][q];
            V[k][p] = c * vkp - s * vkq;
            V[k][q] = s * vkp + c * vkq;
        }
    }

    const vals: [number, number, number] = [a[0][0], a[1][1], a[2][2]];
    const order = [0, 1, 2];
    order.sort((i, j) => vals[j] - vals[i]);
    const sortedVals: [number, number, number] = [vals[order[0]], vals[order[1]], vals[order[2]]];
    const sortedVecs: [number, number, number][] = [
        [V[0][order[0]], V[1][order[0]], V[2][order[0]]],
        [V[0][order[1]], V[1][order[1]], V[2][order[1]]],
        [V[0][order[2]], V[1][order[2]], V[2][order[2]]]
    ];

    return { values: sortedVals, vectors: sortedVecs };
}

export function classifyShape(flatness: number, edgeness: number): GaussShape {
    if (flatness >= 0.55) return GaussShape.VOLUMETRIC;
    if (edgeness >= 0.4) return GaussShape.LINE;
    return GaussShape.SURFACE;
}

export function analyzeOne(
    quat: [number, number, number, number],
    linearScale: [number, number, number]
): Omit<GaussAnalysis, 'localNormal' | 'localThickness' | 'signedDist' | 'localDensity' | 'regionDensity' | 'nnDist' | 'outlierScore' | 'isOutlier'> {
    const R = quatToRotationMatrix(quat);
    const cov = computeCovariance(R, linearScale);
    const { values, vectors } = eigenDecompSym3x3(cov);

    const l1 = values[0], l2 = values[1], l3 = values[2];
    const flatness = l1 > EPS ? l3 / l1 : 1;
    const edgeness = l2 > EPS ? l3 / l2 : 1;
    const shape = classifyShape(flatness, edgeness);

    return {
        normal: [vectors[2][0], vectors[2][1], vectors[2][2]],
        flatness,
        edgeness,
        eigenvals: values,
        scales: [Math.sqrt(l1), Math.sqrt(l2), Math.sqrt(l3)],
        shape
    };
}

/**
 * Batch-analyse all gaussians in a splat into compact column storage.
 *
 * @param quatArrays - [rot_0, rot_1, rot_2, rot_3] each Float32Array(N)
 * @param scaleArrays - [scale_0, scale_1, scale_2] each Float32Array(N)
 * (values are in log space, we exp() internally)
 * @param onProgress - optional callback with fraction [0..1], invoked between chunks
 */
export async function analyzeAll(
    quatArrays: [Float32Array, Float32Array, Float32Array, Float32Array],
    scaleArrays: [Float32Array, Float32Array, Float32Array],
    onProgress?: (fraction: number) => void
): Promise<GaussAnalysisColumns> {
    const N = quatArrays[0].length;
    const CHUNK = 20000;

    const [r0, r1, r2, r3] = quatArrays;
    const [s0, s1, s2] = scaleArrays;

    const cols: GaussAnalysisColumns = {
        nx: new Float32Array(N),
        ny: new Float32Array(N),
        nz: new Float32Array(N),
        thickness: new Float32Array(N),
        signedDist: new Float32Array(N),
        density: new Float32Array(N),
        regionDensity: new Float32Array(N),
        nnDist: new Float32Array(N),
        score: new Float32Array(N),
        maxScale: new Float32Array(N),
        isOutlier: new Uint8Array(N),
        shape: new Uint8Array(N)
    };

    for (let start = 0; start < N; start += CHUNK) {
        const end = Math.min(N, start + CHUNK);
        for (let i = start; i < end; i++) {
            const quat: [number, number, number, number] = [r0[i], r1[i], r2[i], r3[i]];
            const scale: [number, number, number] = [Math.exp(s0[i]), Math.exp(s1[i]), Math.exp(s2[i])];
            const base = analyzeOne(quat, scale);
            cols.maxScale[i] = base.scales[0];
            cols.shape[i] = base.shape;
            // defaults filled by detectOutliers; safe fallbacks until then
            cols.thickness[i] = 1;
            cols.score[i] = 1;
        }
        onProgress?.(end / N);
        if (end < N) await yield0();
    }

    return cols;
}

// ---- neighbourhood surface estimation (grid stats) ------------------------

function vlen(v: [number, number, number]): number {
    return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1;
}

// Pack a 3D cell coordinate into a single collision-free integer key.
// Coordinates are offset to non-negative then bit-packed into a uint32
// (10 bits per axis → supports coords in [-512, 511]; grids larger than that
// are impossible in practice since cell sizes scale with the scene diagonal).
// The previous FNV hash collided heavily (e.g. 8% on a 0..100 coordinate
// cube), silently merging distinct cells and corrupting neighbour counts,
// NN distances and region densities.
function cellKey(cx: number, cy: number, cz: number): number {
    return ((cx + 512) & 0x3FF) | (((cy + 512) & 0x3FF) << 10) | (((cz + 512) & 0x3FF) << 20);
}

export interface OutlierDetectionOptions {
    /** Grid cell size (world units). Default 2% of scene diagonal. */
    cellSize?: number;
    /** Minimum neighbours required to trust the PCA normal. */
    minNeighbors?: number;
    /** Outlier score threshold: maxScale / localThickness. */
    outlierThreshold?: number;
    /** Hard upper bound on scale (relative to scene diagonal). */
    maxScaleRatio?: number;
    /** Signed-distance protrusion factor: outlier must stick out this many × localThickness. Default 1.5. */
    protrusionFactor?: number;
    /**
     * Early-exit factor for the exact nearest-neighbour search. nnDist is only
     * ever compared against a threshold of the form `maxScale × factor` (see
     * surface-refiner isolation test), so once a neighbour within
     * `maxScale × thisFactor` is found the true nnDist is guaranteed to be
     * smaller — the "isolated" verdict can never flip. Passing a finite value
     * turns the O(N × 125×cellDensity) distance scan into an early exit for
     * dense regions (the common case). Default Infinity = exact distance.
     */
    nnEarlyOutFactor?: number;
}

/** Per-cell accumulator: count + position sum + position covariance sum. */
interface CellAcc {
    count: number;
    sx: number; sy: number; sz: number;
    cxx: number; cxy: number; cxz: number;
    cyy: number; cyz: number; czz: number;
}

const dot3 = (a: [number, number, number], b: [number, number, number]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * For every gaussian: estimate a local tangent-plane from neighbourhood PCA,
 * compute local thickness, signed distance to the plane and neighbour density,
 * then flag outward-protruding outliers.
 *
 * @param onProgress - optional callback with fraction [0..1], invoked between chunks
 */
export async function detectOutliers(
    analyses: GaussAnalysisColumns,
    positions: [Float32Array, Float32Array, Float32Array],
    bounds: { min: [number, number, number]; max: [number, number, number] },
    options: OutlierDetectionOptions = {},
    onProgress?: (fraction: number) => void
): Promise<OutlierStats> {
    const [px, py, pz] = positions;
    const N = analyses.nx.length;
    const CHUNK = 20000;

    const diag = Math.sqrt(
        (bounds.max[0] - bounds.min[0]) ** 2 +
        (bounds.max[1] - bounds.min[1]) ** 2 +
        (bounds.max[2] - bounds.min[2]) ** 2
    );

    const cellSize = options.cellSize ?? Math.max(diag * 0.02, 1e-6);
    const minNeighbors = options.minNeighbors ?? 5;
    const outlierThreshold = options.outlierThreshold ?? 2.5;
    const maxScaleRatio = options.maxScaleRatio ?? 0.05;
    // Protrusion threshold: a gaussian is an outlier when its signed distance
    // to the local tangent plane exceeds this × local thickness. 1.5 selects
    // real surface bumps while ignoring benign surface undulation; interior
    // points (negative signedDist) are always excluded.
    const protrusionFactor = options.protrusionFactor ?? 1.5;
    // nnDist is only ever compared against maxScale × nnEarlyOutFactor in the
    // refine pass; once a neighbour within that distance is found the verdict
    // is fixed, so the exact scan can stop early for dense regions.
    const nnEarlyOutFactor = options.nnEarlyOutFactor ?? Infinity;
    const invCell = 1 / cellSize;
    const diagCap = diag * maxScaleRatio;

    // ---- Pass 1: accumulate per-cell statistics (O(N)) ----
    const cells = new Map<number, CellAcc>();
    let gx = 0, gy = 0, gz = 0;   // global position sum for scene centroid
    for (let start = 0; start < N; start += CHUNK) {
        const end = Math.min(N, start + CHUNK);
        for (let i = start; i < end; i++) {
            gx += px[i]; gy += py[i]; gz += pz[i];
            const cx = Math.floor(px[i] * invCell);
            const cy = Math.floor(py[i] * invCell);
            const cz = Math.floor(pz[i] * invCell);
            const key = cellKey(cx, cy, cz);
            let acc = cells.get(key);
            if (!acc) {
                acc = { count: 0, sx: 0, sy: 0, sz: 0, cxx: 0, cxy: 0, cxz: 0, cyy: 0, cyz: 0, czz: 0 };
                cells.set(key, acc);
            }
            acc.count++;
            acc.sx += px[i]; acc.sy += py[i]; acc.sz += pz[i];
            acc.cxx += px[i] * px[i]; acc.cxy += px[i] * py[i]; acc.cxz += px[i] * pz[i];
            acc.cyy += py[i] * py[i]; acc.cyz += py[i] * pz[i]; acc.czz += pz[i] * pz[i];
        }
        onProgress?.(0.25 * (end / N));
        if (end < N) await yield0();
    }
    const centroid: [number, number, number] = N > 0 ? [gx / N, gy / N, gz / N] : [0, 0, 0];

    // ---- Fine grid for exact nearest-neighbour distance (isolation check) ----
    // 0.01×diag cells, searched 5×5×5 (covers 0.05×diag) — precise enough to
    // tell "scatter point floating just off the body" from "truly isolated".
    const fineCellSize = Math.max(diag * 0.01, 1e-6);
    const fineInv = 1 / fineCellSize;
    const fineCells = new Map<number, number[]>();
    for (let start = 0; start < N; start += CHUNK) {
        const end = Math.min(N, start + CHUNK);
        for (let i = start; i < end; i++) {
            const key = cellKey(
                Math.floor(px[i] * fineInv),
                Math.floor(py[i] * fineInv),
                Math.floor(pz[i] * fineInv)
            );
            let arr = fineCells.get(key);
            if (!arr) {
                arr = []; fineCells.set(key, arr);
            }
            arr.push(i);
        }
        onProgress?.(0.25 + 0.15 * (end / N));
        if (end < N) await yield0();
    }

    const nearestNeighbour = (i: number, earlyOutDist = Infinity): number => {
        const gcx = Math.floor(px[i] * fineInv);
        const gcy = Math.floor(py[i] * fineInv);
        const gcz = Math.floor(pz[i] * fineInv);
        // early-out only applies when a finite threshold is given; a non-finite
        // earlyOutDist (Infinity) must keep scanning for the TRUE minimum.
        const finiteEarlyOut = Number.isFinite(earlyOutDist);
        const earlyOut2 = finiteEarlyOut ? earlyOutDist * earlyOutDist : -1;
        let best = Infinity;
        for (let dx = -2; dx <= 2; dx++) {
            for (let dy = -2; dy <= 2; dy++) {
                for (let dz = -2; dz <= 2; dz++) {
                    const arr = fineCells.get(cellKey(gcx + dx, gcy + dy, gcz + dz));
                    if (!arr) continue;
                    for (const idx of arr) {
                        if (idx === i) continue;
                        const ddx = px[i] - px[idx];
                        const ddy = py[i] - py[idx];
                        const ddz = pz[i] - pz[idx];
                        const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
                        if (d2 < best) {
                            best = d2;
                            // Found a neighbour closer than the isolation
                            // threshold: the true nnDist can only be smaller,
                            // so "isolated" can never be true — stop early.
                            if (finiteEarlyOut && best <= earlyOut2) {
                                return Math.sqrt(best);
                            }
                        }
                    }
                }
            }
        }
        return best === Infinity ? Infinity : Math.sqrt(best);
    };

    // ---- Region grid (0.04×diag cells) for detached-cluster density ----
    // A cluster floating off the body has few points even in a wide
    // neighbourhood, while boundary/thin parts of the model still have the
    // rest of the surface filling the wide neighbourhood.
    const regionCellSize = Math.max(diag * 0.04, 1e-6);
    const regionInv = 1 / regionCellSize;
    const regionCells = new Map<number, number>();
    for (let start = 0; start < N; start += CHUNK) {
        const end = Math.min(N, start + CHUNK);
        for (let i = start; i < end; i++) {
            const key = cellKey(
                Math.floor(px[i] * regionInv),
                Math.floor(py[i] * regionInv),
                Math.floor(pz[i] * regionInv)
            );
            regionCells.set(key, (regionCells.get(key) ?? 0) + 1);
        }
        onProgress?.(0.4 + 0.1 * (end / N));
        if (end < N) await yield0();
    }

    const regionDensityOf = (i: number): number => {
        const gcx = Math.floor(px[i] * regionInv);
        const gcy = Math.floor(py[i] * regionInv);
        const gcz = Math.floor(pz[i] * regionInv);
        let count = 0;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    count += regionCells.get(cellKey(gcx + dx, gcy + dy, gcz + dz)) ?? 0;
                }
            }
        }
        return count;
    };

    const regionDensities = new Float32Array(N);

    // ---- Pass 2: per-gaussian neighbourhood analysis (O(N × 27)) ----
    let outlierCount = 0;
    let meanScore = 0;
    let maxScore = 0;
    let surfaceCount = 0;
    let lineCount = 0;
    let volumetricCount = 0;
    const densities = new Float32Array(N);

    for (let start = 0; start < N; start += CHUNK) {
        const end = Math.min(N, start + CHUNK);
        for (let i = start; i < end; i++) {
            const shape = analyses.shape[i];
            if (shape === GaussShape.SURFACE) surfaceCount++;
            else if (shape === GaussShape.LINE) lineCount++;
            else volumetricCount++;

            const cx = Math.floor(px[i] * invCell);
            const cy = Math.floor(py[i] * invCell);
            const cz = Math.floor(pz[i] * invCell);

            // Gather 27-neighbourhood accumulation
            let count = 0;
            let sx = 0, sy = 0, sz = 0;
            let cxx = 0, cxy = 0, cxz = 0, cyy = 0, cyz = 0, czz = 0;
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dz = -1; dz <= 1; dz++) {
                        const acc = cells.get(cellKey(cx + dx, cy + dy, cz + dz));
                        if (!acc) continue;
                        count += acc.count;
                        sx += acc.sx; sy += acc.sy; sz += acc.sz;
                        cxx += acc.cxx; cxy += acc.cxy; cxz += acc.cxz;
                        cyy += acc.cyy; cyz += acc.cyz; czz += acc.czz;
                    }
                }
            }

            densities[i] = count;
            const maxScale = analyses.maxScale[i];
            analyses.nnDist[i] = nearestNeighbour(i, maxScale * nnEarlyOutFactor);
            analyses.regionDensity[i] = regionDensityOf(i);
            regionDensities[i] = analyses.regionDensity[i];

            if (count < minNeighbors) {
            // Too isolated for a local plane: use the scene-centroid direction
            // as a pseudo-outward normal. signedDist = distance from the
            // centroid (always positive → treated as "outside"), so the cleanup
            // pass can delete truly isolated floaters; interior points that DO
            // have neighbours never reach this branch.
                const dx = px[i] - centroid[0];
                const dy = py[i] - centroid[1];
                const dz = pz[i] - centroid[2];
                const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
                analyses.nx[i] = dx / dl;
                analyses.ny[i] = dy / dl;
                analyses.nz[i] = dz / dl;
                analyses.thickness[i] = maxScale;
                analyses.signedDist[i] = dl;
                analyses.density[i] = count;
                analyses.score[i] = 1;
                analyses.isOutlier[i] = 0;   // isolated points are handled by cleanup, not flattening
                meanScore += 1;
                continue;
            }

            // Centroid + covariance of the neighbourhood
            const invC = 1 / count;
            const cx0 = sx * invC, cy0 = sy * invC, cz0 = sz * invC;
            const cov: [number, number, number][] = [
                [cxx * invC - cx0 * cx0, cxy * invC - cx0 * cy0, cxz * invC - cx0 * cz0],
                [cxy * invC - cx0 * cy0, cyy * invC - cy0 * cy0, cyz * invC - cy0 * cz0],
                [cxz * invC - cx0 * cz0, cyz * invC - cy0 * cz0, czz * invC - cz0 * cz0]
            ];

            const { vectors } = eigenDecompSym3x3(cov);
            // Normal = eigenvector of the smallest eigenvalue (column 2)
            let nx = vectors[2][0], ny = vectors[2][1], nz = vectors[2][2];
            const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (l < 1e-9) {
                nx = 0; ny = 0; nz = 1;
            } else {
                nx /= l; ny /= l; nz /= l;
            }

            // Flip so the normal points OUTWARD from the scene centroid. This keeps
            // the sign of signedDist globally consistent: interior points get a
            // negative signed distance and are protected from cleanup.
            const outx = px[i] - centroid[0];
            const outy = py[i] - centroid[1];
            const outz = pz[i] - centroid[2];
            if (outx * nx + outy * ny + outz * nz < 0) {
                nx = -nx; ny = -ny; nz = -nz;
            }

            // Local thickness = RMS scatter of neighbours along the normal
            const thickness = Math.sqrt(Math.max(0,
                nx * nx * cov[0][0] + ny * ny * cov[1][1] + nz * nz * cov[2][2] +
            2 * nx * ny * cov[0][1] + 2 * nx * nz * cov[0][2] + 2 * ny * nz * cov[1][2]
            )) || maxScale;

            // Signed distance to the neighbourhood plane (positive = outward)
            const signedDist = (px[i] - cx0) * nx + (py[i] - cy0) * ny + (pz[i] - cz0) * nz;

            analyses.nx[i] = nx;
            analyses.ny[i] = ny;
            analyses.nz[i] = nz;
            analyses.thickness[i] = thickness;
            analyses.signedDist[i] = signedDist;
            analyses.density[i] = count;

            const score = thickness > 0 ? maxScale / thickness : 1;
            analyses.score[i] = score;
            meanScore += score;
            maxScore = Math.max(maxScore, score);

            // Outlier = gaussian clearly protruding OUTWARD from the local
            // surface. The old scale-ratio test (maxScale / localThickness >
            // 2.5) fails on dense modern scans: in a tightly-packed surface the
            // neighbourhood thickness scales WITH the gaussian size, so the
            // ratio stays < 1 even for real bumps (measured p99 ≈ 0.7 on a
            // 7M-point bronze bell). Protrusion is measured by signed distance
            // to the local tangent plane instead: a bump sticks out more than
            // ~1.5× the local surface thickness. Deep-interior points are
            // excluded (negative signedDist).
            const isOutlier = signedDist > thickness * protrusionFactor &&
                shape !== GaussShape.LINE &&
                maxScale < diagCap;
            analyses.isOutlier[i] = isOutlier ? 1 : 0;

            if (isOutlier) outlierCount++;
        }
        onProgress?.(0.5 + 0.45 * (end / N));
        if (end < N) await yield0();
    }

    // Median neighbour density (sparse-region baseline)
    const sorted = Array.from(densities).sort((a, b) => a - b);
    const medianDensity = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 1;

    // Median REGION density (detached-cluster baseline)
    const sortedRegion = Array.from(regionDensities).sort((a, b) => a - b);
    const medianRegionDensity = sortedRegion.length > 0 ? sortedRegion[Math.floor(sortedRegion.length / 2)] : 1;

    return {
        total: N,
        outlierCount,
        surfaceCount,
        lineCount,
        volumetricCount,
        meanScore: N > 0 ? meanScore / N : 0,
        maxScore,
        medianDensity,
        medianRegionDensity
    };
}
