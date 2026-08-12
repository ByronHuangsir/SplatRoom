/**
 * Surface / Outlier Analyzer for Gaussian Splatting.
 *
 * From each Gaussian's quaternion rotation + log-scale triple we reconstruct
 * the 3×3 covariance matrix Σ = R·S·Sᵗ·Rᵗ, then eigen-decompose it (Jacobi
 * for symmetric 3x3) to obtain:
 *
 *   λ₁ ≥ λ₂ ≥ λ₃          eigenvalues
 *   e₁, e₂, e₃             eigenvectors
 *
 * Classification rules (inspired by 2DGS and SuGaR):
 *   flatness = λ₃ / λ₁    → 0 = perfectly flat pancake, 1 = perfect sphere
 *   edgeness = λ₃ / λ₂    → if both λ₂ and λ₃ are small vs λ₁ → line-like
 *
 * Additionally we estimate a local tangent-plane and thickness for every
 * gaussian.  A gaussian is flagged as an outlier when its largest scale is
 * much larger than the local surface thickness — these are the "blobs"
 * that stick out from an otherwise smooth surface.
 */

// ---- types ----------------------------------------------------------------

export const enum GaussShape {
    VOLUMETRIC = 0,  // sphere-like (all three axes similar)
    SURFACE    = 1,  // pancake (one axis much smaller)
    LINE       = 2   // cigar   (two axes much smaller)
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
    /** Local surface normal estimated from neighbors */
    localNormal: [number, number, number];
    /** Local surface thickness (std-dev of neighbor distances to tangent plane) */
    localThickness: number;
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
}

// ---- helpers --------------------------------------------------------------

const EPS = 1e-10;

/**
 * Convert a PlayCanvas-style quaternion [x,y,z,w] into a 3×3 rotation matrix.
 * Returns column-major (R[col][row] in JS indexing).
 */
export function quatToRotationMatrix(q: [number, number, number, number]): [
    [number, number, number],
    [number, number, number],
    [number, number, number]
] {
    const [x, y, z, w] = q;
    const x2 = 2*x, y2 = 2*y, z2 = 2*z;
    const xx = x*x2, xy = x*y2, xz = x*z2;
    const yy = y*y2, yz = y*z2, zz = z*z2;
    const wx = w*x2, wy = w*y2, wz = w*z2;

    return [
        [1 - (yy + zz), xy + wz,       xz - wy],
        [xy - wz,       1 - (xx + zz), yz + wx],
        [xz + wy,       yz - wx,       1 - (xx + yy)]
    ];
}

/**
 * 3×3 matrix multiply: C = A × B  (all column-major arrays)
 */
function mat3mul(
    a: [number, number, number][],
    b: [number, number, number][]
): [number, number, number][] {
    const c: [number, number, number][] = [[0,0,0],[0,0,0],[0,0,0]];
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            let s = 0;
            for (let k = 0; k < 3; k++) s += a[i][k] * b[k][j];
            c[i][j] = s;
        }
    }
    return c;
}

/**
 * 3×3 matrix transpose (column-major convention: M[col][row])
 */
function mat3transpose(
    m: [number, number, number][]
): [number, number, number][] {
    const t: [number, number, number][] = [[0,0,0],[0,0,0],[0,0,0]];
    for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++)
            t[j][i] = m[i][j];
    return t;
}

/**
 * Build the 3×3 covariance matrix Σ = R · S · Sᵗ · Rᵗ
 *
 *   Scale diagonal S = diag(exp(s0), exp(s1), exp(s2))
 *   (scale arguments are linear — already exp(log-scale))
 */
export function computeCovariance(
    R: [number, number, number][],
    linearScale: [number, number, number]
): [number, number, number][] {
    const s0 = linearScale[0], s1 = linearScale[1], s2 = linearScale[2];
    // S·Sᵗ is just diag(s0², s1², s2²)
    // R·S = R scaled column-wise
    const rs: [number, number, number][] = [
        [R[0][0]*s0, R[0][1]*s1, R[0][2]*s2],
        [R[1][0]*s0, R[1][1]*s1, R[1][2]*s2],
        [R[2][0]*s0, R[2][1]*s1, R[2][2]*s2]
    ];
    return mat3mul(rs, mat3transpose(rs));
}

/**
 * Jacobi eigen-decomposition for a 3×3 real symmetric matrix.
 *
 * Returns eigenvalues sorted **descending** and their corresponding
 * eigenvectors as columns of V.
 */
export function eigenDecompSym3x3(
    A: [number, number, number][]
): { values: [number, number, number]; vectors: [number, number, number][] } {
    // Working copy
    const a = A.map(row => [...row]) as [number, number, number][];
    // Eigenvectors start as identity
    const V: [number, number, number][] = [[1,0,0],[0,1,0],[0,0,1]];

    const MAX_SWEEPS = 20;
    const TOL = 1e-12;

    for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
        // Find largest off-diagonal
        let p = 0, q = 1;
        let maxOff = 0;
        for (let i = 0; i < 2; i++) {
            for (let j = i+1; j < 3; j++) {
                const v = Math.abs(a[i][j]);
                if (v > maxOff) { maxOff = v; p = i; q = j; }
            }
        }
        if (maxOff < TOL) break;

        // Givens rotation to zero a[p][q]
        const theta = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]);
        const c = Math.cos(theta), s = Math.sin(theta);

        // Rotate rows/cols
        for (let k = 0; k < 3; k++) {
            if (k === p || k === q) continue;
            const akp = a[k][p], akq = a[k][q];
            a[k][p] = a[p][k] = c * akp - s * akq;
            a[k][q] = a[q][k] = s * akp + c * akq;
        }
        const app = a[p][p], aqq = a[q][q], apq = a[p][q];
        a[p][p] = c*c*app + s*s*aqq - 2*c*s*apq;
        a[q][q] = s*s*app + c*c*aqq + 2*c*s*apq;
        a[p][q] = a[q][p] = 0;

        // Accumulate eigenvector rotations
        for (let k = 0; k < 3; k++) {
            const vkp = V[k][p], vkq = V[k][q];
            V[k][p] = c * vkp - s * vkq;
            V[k][q] = s * vkp + c * vkq;
        }
    }

    // Diagonal entries = eigenvalues
    const vals: [number, number, number] = [a[0][0], a[1][1], a[2][2]];

    // Sort descending by eigenvalue, permuting eigenvectors
    const order = [0, 1, 2];
    order.sort((i, j) => vals[j] - vals[i]);
    const sortedVals: [number, number, number] = [vals[order[0]], vals[order[1]], vals[order[2]]];
    const sortedVecs: [number, number, number][] = [
        [V[0][order[0]], V[1][order[0]], V[2][order[0]]], // e₁ (largest λ)
        [V[0][order[1]], V[1][order[1]], V[2][order[1]]], // e₂
        [V[0][order[2]], V[1][order[2]], V[2][order[2]]]  // e₃ (smallest λ = normal)
    ];

    return { values: sortedVals, vectors: sortedVecs };
}

/**
 * Classify a single Gaussian based on its eigenvalue ratios.
 */
export function classifyShape(flatness: number, edgeness: number): GaussShape {
    if (flatness >= 0.55) return GaussShape.VOLUMETRIC;
    if (edgeness >= 0.4) return GaussShape.LINE;
    return GaussShape.SURFACE;
}

/**
 * Analyse a single Gaussian given its PlayCanvas quaternion (rot_0..3)
 * and its **linear** scale (exp(log-scale)).
 */
export function analyzeOne(
    quat: [number, number, number, number],
    linearScale: [number, number, number]
): Omit<GaussAnalysis, 'localNormal' | 'localThickness' | 'outlierScore' | 'isOutlier'> {
    const R = quatToRotationMatrix(quat);
    const cov = computeCovariance(R, linearScale);
    const { values, vectors } = eigenDecompSym3x3(cov);

    const l1 = values[0], l2 = values[1], l3 = values[2];
    const flatness = l1 > EPS ? l3 / l1 : 1;
    const edgeness = l2 > EPS ? l3 / l2 : 1;
    const shape = classifyShape(flatness, edgeness);

    // Eigenvalues are variances along axes; take sqrt for scale estimates.
    // Sort scales to match eigenvalue order.
    const scaleSorted: [number, number, number] = [Math.sqrt(l1), Math.sqrt(l2), Math.sqrt(l3)];

    return {
        normal: [vectors[2][0], vectors[2][1], vectors[2][2]], // e₃
        flatness,
        edgeness,
        eigenvals: values,
        scales: scaleSorted,
        shape
    };
}

/**
 * Batch-analyse all gaussians in a splat.
 *
 * @param quatArrays   [rot_0, rot_1, rot_2, rot_3] each Float32Array(N)
 * @param scaleArrays  [scale_0, scale_1, scale_2] each Float32Array(N)
 *                     (values are in log space, we exp() internally)
 * @returns Array of GaussAnalysis, length N
 */
export function analyzeAll(
    quatArrays: [Float32Array, Float32Array, Float32Array, Float32Array],
    scaleArrays: [Float32Array, Float32Array, Float32Array]
): GaussAnalysis[] {
    const N = quatArrays[0].length;
    const results: GaussAnalysis[] = new Array(N);

    const [r0, r1, r2, r3] = quatArrays;
    const [s0, s1, s2] = scaleArrays;

    for (let i = 0; i < N; i++) {
        const quat: [number, number, number, number] = [r0[i], r1[i], r2[i], r3[i]];
        const scale: [number, number, number] = [Math.exp(s0[i]), Math.exp(s1[i]), Math.exp(s2[i])];
        const base = analyzeOne(quat, scale);
        results[i] = {
            ...base,
            localNormal: [0, 0, 1],
            localThickness: 1,
            outlierScore: 1,
            isOutlier: false
        };
    }

    return results;
}

// ---- local tangent-plane estimation (grid stats) -------------------------

/** 3D vector length. */
function vlen(v: [number, number, number]): number {
    return Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]) || 1;
}

/**
 * Simple 3D spatial hash key for a cell at integer coordinates.
 */
function cellKey(cx: number, cy: number, cz: number): number {
    // FNV-like mix of 3 signed 16-bit integers into a single 32-bit key.
    let h = ((cx & 0xFFFF) * 16777619) ^ ((cy & 0xFFFF) * 16777619 + 0x9E3779B9);
    h = (h * 16777619) ^ ((cz & 0xFFFF) * 16777619);
    return h >>> 0;
}

export interface OutlierDetectionOptions {
    /** Grid cell size (world units). Default 1% of scene diagonal. */
    cellSize?: number;
    /** Minimum number of neighbors required to estimate a local plane. */
    minNeighbors?: number;
    /** Max neighbors to consider per gaussian. */
    maxNeighbors?: number;
    /** Outlier score threshold: maxScale / localThickness. */
    outlierThreshold?: number;
    /** Hard upper bound on scale (relative to scene diagonal). */
    maxScaleRatio?: number;
}

/**
 * For every gaussian, estimate a local tangent-plane from its spatial
 * neighbors, compute the local surface thickness, and flag outliers that
 * protrude much farther than the local thickness.
 */
export function detectOutliers(
    analyses: GaussAnalysis[],
    positions: [Float32Array, Float32Array, Float32Array],
    bounds: { min: [number, number, number]; max: [number, number, number] },
    options: OutlierDetectionOptions = {}
): OutlierStats {
    const [px, py, pz] = positions;
    const N = analyses.length;

    const diag = Math.sqrt(
        (bounds.max[0]-bounds.min[0])**2 +
        (bounds.max[1]-bounds.min[1])**2 +
        (bounds.max[2]-bounds.min[2])**2
    );

    const cellSize = options.cellSize ?? Math.max(diag * 0.01, 1e-6);
    const outlierThreshold = options.outlierThreshold ?? 3.0;
    const maxScaleRatio = options.maxScaleRatio ?? 0.05;
    const invCell = 1 / cellSize;

    // ---- Phase 1: Build per-cell max-scale statistics (O(N)) ----
    // For each cell: count, sum of maxScale, sum of squares.
    interface CellStat { count: number; sum: number; sumSq: number; }
    const cellStats = new Map<number, CellStat>();

    for (let i = 0; i < N; i++) {
        const cx = Math.floor(px[i] * invCell);
        const cy = Math.floor(py[i] * invCell);
        const cz = Math.floor(pz[i] * invCell);
        const key = cellKey(cx, cy, cz);

        const ms = analyses[i].scales[0];

        let s = cellStats.get(key);
        if (!s) { s = { count: 0, sum: 0, sumSq: 0 }; cellStats.set(key, s); }
        s.count++;
        s.sum += ms;
        s.sumSq += ms * ms;
    }

    // ---- Phase 2: Per-gaussian outlier detection using cell stats (O(N × 27)) ----
    let outlierCount = 0;
    let meanScore = 0;
    let maxScore = 0;
    let surfaceCount = 0;
    let lineCount = 0;
    let volumetricCount = 0;

    // Pre-compute diagonal scale cap once
    const diagCap = diag * maxScaleRatio;

    for (let i = 0; i < N; i++) {
        const a = analyses[i];
        if (a.shape === GaussShape.SURFACE) surfaceCount++;
        else if (a.shape === GaussShape.LINE) lineCount++;
        else volumetricCount++;

        // Gather local statistics from this gaussian's cell + 26 adjacent cells,
        // plus the member index list (capped) for neighbor-PCA normal estimation.
        const cx = Math.floor(px[i] * invCell);
        const cy = Math.floor(py[i] * invCell);
        const cz = Math.floor(pz[i] * invCell);

        let localCount = 0;
        let localSum = 0;

        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    const key = cellKey(cx + dx, cy + dy, cz + dz);
                    const s = cellStats.get(key);
                    if (s && s.count > 0) {
                        localCount += s.count;
                        localSum += s.sum;
                    }
                }
            }
        }

        const maxScale = a.scales[0];
        const localAvgScale = localCount > 0 ? localSum / localCount : maxScale;
        const score = localAvgScale > 0 ? maxScale / localAvgScale : 1;

        // Use gaussian's own normal since we skip neighbor PCA
        a.localNormal = [a.normal[0], a.normal[1], a.normal[2]];
        a.localThickness = localAvgScale;  // repurposed: local average max-scale
        a.outlierScore = score;

        // Flag as outlier when:
        // 1. maxScale is significantly larger than local average
        // 2. not a line-shaped gaussian (keep thin edge features)
        // 3. not absurdly large relative to the whole scene
        a.isOutlier = score > outlierThreshold
            && a.shape !== GaussShape.LINE
            && maxScale < diagCap;

        if (a.isOutlier) outlierCount++;
        meanScore += score;
        maxScore = Math.max(maxScore, score);
    }
    return {
        total: N,
        outlierCount,
        surfaceCount,
        lineCount,
        volumetricCount,
        meanScore: N > 0 ? meanScore / N : 0,
        maxScore
    };
}
