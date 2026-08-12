import { Mat4, Quat, Vec3 } from 'playcanvas';
import { MergeModel } from './merge-model';

/**
 * 合并工具（模块 3）— 对齐算法。
 *
 * - kabsch()          ：对应点对求最优刚体变换（3+ 点，SVD-free 实现）
 * - pcaPrealign()     ：主轴粗对齐（不同角度扫描的初始姿态）
 * - autoAlign()       ：自动对齐 = PCA 粗对齐 + 网格哈希 ICP 精修
 * - raycastPick()     ：屏幕射线 → 模型表面最近点（对应点对齐选点用）
 */

/** Kabsch 求刚体变换（pA → pB）。输入为 N×3 紧凑 Float32Array。 */
export function kabsch(pA: Float32Array, pB: Float32Array): { R: Mat4; t: Vec3 } {
    const n = pA.length / 3;
    if (n < 3) throw new Error('至少需要 3 组对应点');
    let cx = 0, cy = 0, cz = 0, dx = 0, dy = 0, dz = 0;
    for (let i = 0; i < n; i++) {
        cx += pA[i * 3]; cy += pA[i * 3 + 1]; cz += pA[i * 3 + 2];
        dx += pB[i * 3]; dy += pB[i * 3 + 1]; dz += pB[i * 3 + 2];
    }
    cx /= n; cy /= n; cz /= n; dx /= n; dy /= n; dz /= n;

    // H = Σ (a-cA)(b-cB)^T（3×3）
    const H = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < n; i++) {
        const ax = pA[i * 3] - cx, ay = pA[i * 3 + 1] - cy, az = pA[i * 3 + 2] - cz;
        const bx = pB[i * 3] - dx, by = pB[i * 3 + 1] - dy, bz = pB[i * 3 + 2] - dz;
        H[0][0] += ax * bx; H[0][1] += ax * by; H[0][2] += ax * bz;
        H[1][0] += ay * bx; H[1][1] += ay * by; H[1][2] += ay * bz;
        H[2][0] += az * bx; H[2][1] += az * by; H[2][2] += az * bz;
    }

    // S = H^T H（对称），特征分解 S = V Λ V^T
    const S = [
        [H[0][0] * H[0][0] + H[1][0] * H[1][0] + H[2][0] * H[2][0], H[0][0] * H[0][1] + H[1][0] * H[1][1] + H[2][0] * H[2][1], H[0][0] * H[0][2] + H[1][0] * H[1][2] + H[2][0] * H[2][2]],
        [H[0][1] * H[0][0] + H[1][1] * H[1][0] + H[2][1] * H[2][0], H[0][1] * H[0][1] + H[1][1] * H[1][1] + H[2][1] * H[2][1], H[0][1] * H[0][2] + H[1][1] * H[1][2] + H[2][1] * H[2][2]],
        [H[0][2] * H[0][0] + H[1][2] * H[1][0] + H[2][2] * H[2][0], H[0][2] * H[0][1] + H[1][2] * H[1][1] + H[2][2] * H[2][1], H[0][2] * H[0][2] + H[1][2] * H[1][2] + H[2][2] * H[2][2]]
    ];
    const { vectors: V, values: lambda } = symmetricEig3(S);
    const order = [0, 1, 2].sort((a, b) => Math.abs(lambda[b]) - Math.abs(lambda[a]));

    // 奇异值 + 左奇异向量（U 列 = H v_i / s_i；s_i≈0 时补正交基）
    const U = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const sig = [0, 0, 0];
    const hv: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) {
        // symmetricEig3 的 vectors 布局：列 = 特征向量
        const v = [V[0][order[i]], V[1][order[i]], V[2][order[i]]];
        hv[0][i] = H[0][0] * v[0] + H[0][1] * v[1] + H[0][2] * v[2];
        hv[1][i] = H[1][0] * v[0] + H[1][1] * v[1] + H[1][2] * v[2];
        hv[2][i] = H[2][0] * v[0] + H[2][1] * v[1] + H[2][2] * v[2];
        const s = Math.sqrt(Math.max(0, lambda[order[i]]));
        sig[i] = s;
        if (s > 1e-9) {
            U[0][i] = hv[0][i] / s; U[1][i] = hv[1][i] / s; U[2][i] = hv[2][i] / s;
        }
    }
    // 补零奇异值的列（Gram-Schmidt 正交补）
    for (let i = 0; i < 3; i++) {
        if (sig[i] > 1e-9) continue;
        // 与已确定的 U 列正交
        let cand = [1, 0, 0];
        for (let t = 0; t < 3; t++) {
            let c = cand;
            if (t > 0) c = t === 1 ? [0, 1, 0] : [0, 0, 1];
            let ok = true;
            for (let j = 0; j < 3; j++) {
                if (sig[j] > 1e-9) {
                    const dot = c[0] * U[0][j] + c[1] * U[1][j] + c[2] * U[2][j];
                    if (Math.abs(dot) > 0.99) { ok = false; break; }
                }
            }
            if (ok) { cand = c; break; }
        }
        // Gram-Schmidt
        for (let j = 0; j < 3; j++) {
            if (sig[j] > 1e-9) {
                const dot = cand[0] * U[0][j] + cand[1] * U[1][j] + cand[2] * U[2][j];
                cand = [cand[0] - dot * U[0][j], cand[1] - dot * U[1][j], cand[2] - dot * U[2][j]];
            }
        }
        const len = Math.hypot(cand[0], cand[1], cand[2]) || 1;
        U[0][i] = cand[0] / len; U[1][i] = cand[1] / len; U[2][i] = cand[2] / len;
    }

    // R = V * diag(1,1,det(V U^T)) * U^T（det 修正只缩 U^T 第三行）
    // 注意：Vc 每"行"是一个特征向量（order.map 产出），等价于标准 V 的转置，
    // 所以此处先转置回"列 = 特征向量"再参与矩阵乘法。
    const Vc = order.map(k => [V[0][k], V[1][k], V[2][k]]);
    const Ut = transpose3(U);
    const Vmat = transpose3(Vc);
    const VUt = mul3(Vmat, Ut);
    const det = determinant3(VUt);
    const d = det < 0 ? -1 : 1;
    const Utd = Ut.map((row, ri) => ri === 2 ? row.map(v => v * d) : row);
    const r = mul3(Vmat, Utd);

    const R = new Mat4();
    // PlayCanvas Mat4.set 是列主序：m00,m10,m20,m30, m01,m11,...
    R.set([
        r[0][0], r[1][0], r[2][0], 0,
        r[0][1], r[1][1], r[2][1], 0,
        r[0][2], r[1][2], r[2][2], 0,
        0, 0, 0, 1
    ]);
    const tc = new Vec3(dx, dy, dz);
    const rc = new Vec3(cx, cy, cz);
    R.transformVector(rc, rc);
    const t = new Vec3(tc.x - rc.x, tc.y - rc.y, tc.z - rc.z);
    return { R, t };
}

/**
 * 对称 3×3 矩阵特征分解（雅可比旋转）。
 * 返回 { vectors: 特征向量（行 = 输入行，列 = 特征向量）, values }。
 */
function symmetricEig3(m: number[][]): { vectors: number[][]; values: number[] } {
    const a = m.map(r => [...r]);
    const eig = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let iter = 0; iter < 64; iter++) {
        let off = 0;
        for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] * a[p][q];
        if (off < 1e-24) break;
        for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) {
            if (Math.abs(a[p][q]) < 1e-24) continue;
            const theta = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]);
            const c = Math.cos(theta), s = Math.sin(theta);
            for (let k = 0; k < 3; k++) {
                const a1 = a[p][k] * c - a[q][k] * s;
                const a2 = a[p][k] * s + a[q][k] * c;
                a[p][k] = a1; a[q][k] = a2;
            }
            for (let k = 0; k < 3; k++) {
                const b1 = a[k][p] * c - a[k][q] * s;
                const b2 = a[k][p] * s + a[k][q] * c;
                a[k][p] = b1; a[k][q] = b2;
            }
            for (let k = 0; k < 3; k++) {
                const v1 = eig[k][p] * c - eig[k][q] * s;
                const v2 = eig[k][p] * s + eig[k][q] * c;
                eig[k][p] = v1; eig[k][q] = v2;
            }
        }
    }
    return { vectors: eig, values: [a[0][0], a[1][1], a[2][2]] };
}

function transpose3(m: number[][]): number[][] {
    return [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]];
}
function mul3(a: number[][], b: number[][]): number[][] {
    const o = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        o[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
    }
    return o;
}
function scale3(m: number[][], s: number): number[][] {
    return m.map(r => r.map(v => v * s));
}
function determinant3(m: number[][]): number {
    return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
         - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
         + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}

/** PCA 主轴粗对齐：把 src 质心移到 dst 质心 + 主轴方向对齐。 */
export function pcaPrealign(srcPts: Float32Array, dstPts: Float32Array): Mat4 {
    const n1 = srcPts.length / 3, n2 = dstPts.length / 3;
    const c1 = centroid(srcPts, n1), c2 = centroid(dstPts, n2);
    const e1 = pcaAxes(srcPts, n1, c1);
    const e2 = pcaAxes(dstPts, n2, c2);
    // 对齐基：R = E2 * E1^T
    const R = new Mat4();
    const m: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        m[i][j] = e2[i][0] * e1[j][0] + e2[i][1] * e1[j][1] + e2[i][2] * e1[j][2];
    }
    R.set([
        m[0][0], m[1][0], m[2][0], 0,
        m[0][1], m[1][1], m[2][1], 0,
        m[0][2], m[1][2], m[2][2], 0,
        0, 0, 0, 1
    ]);
    const t = new Vec3(c2.x - c1.x, c2.y - c1.y, c2.z - c1.z);
    const result = new Mat4().setFromEulerAngles(0, 0, 0);
    result.setTranslate(t.x, t.y, t.z);
    result.mul2(result, R);
    return result;
}

function centroid(p: Float32Array, n: number): Vec3 {
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < n; i++) { x += p[i * 3]; y += p[i * 3 + 1]; z += p[i * 3 + 2]; }
    return new Vec3(x / n, y / n, z / n);
}

function pcaAxes(p: Float32Array, n: number, c: Vec3): number[][] {
    let c00 = 0, c01 = 0, c02 = 0, c11 = 0, c12 = 0, c22 = 0;
    for (let i = 0; i < n; i++) {
        const x = p[i * 3] - c.x, y = p[i * 3 + 1] - c.y, z = p[i * 3 + 2] - c.z;
        c00 += x * x; c01 += x * y; c02 += x * z;
        c11 += y * y; c12 += y * z;
        c22 += z * z;
    }
    c00 /= n; c01 /= n; c02 /= n; c11 /= n; c12 /= n; c22 /= n;
    // 雅可比特征分解（对称 3×3）
    let a = [[c00, c01, c02], [c01, c11, c12], [c02, c12, c22]];
    let eig = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let iter = 0; iter < 32; iter++) {
        let off = 0;
        for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] * a[p][q];
        if (off < 1e-20) break;
        for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) {
            if (Math.abs(a[p][q]) < 1e-20) continue;
            const theta = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]);
            const c = Math.cos(theta), s = Math.sin(theta);
            for (let k = 0; k < 3; k++) {
                const a1 = a[p][k] * c - a[q][k] * s;
                const a2 = a[p][k] * s + a[q][k] * c;
                a[p][k] = a1; a[q][k] = a2;
            }
            for (let k = 0; k < 3; k++) {
                const b1 = a[k][p] * c - a[k][q] * s;
                const b2 = a[k][p] * s + a[k][q] * c;
                a[k][p] = b1; a[k][q] = b2;
            }
            for (let k = 0; k < 3; k++) {
                const v1 = eig[k][p] * c - eig[k][q] * s;
                const v2 = eig[k][p] * s + eig[k][q] * c;
                eig[k][p] = v1; eig[k][q] = v2;
            }
        }
    }
    // 按特征值降序（eig 列 = 特征向量）
    const lambda = [a[0][0], a[1][1], a[2][2]];
    const order = [0, 1, 2].sort((x, y) => Math.abs(lambda[y]) - Math.abs(lambda[x]));
    return order.map(k => [eig[0][k], eig[1][k], eig[2][k]]);
}

/** 空间哈希最近邻（用于 ICP）。 */
class HashGrid {
    private cell = 1;
    private map = new Map<string, number[]>();
    constructor(pts: Float32Array, n: number, cellSize: number) {
        this.cell = Math.max(cellSize, 1e-6);
        for (let i = 0; i < n; i++) {
            const key = this.key(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
            const arr = this.map.get(key);
            if (arr) arr.push(i); else this.map.set(key, [i]);
        }
    }
    private key(x: number, y: number, z: number): string {
        return `${Math.floor(x / this.cell)}|${Math.floor(y / this.cell)}|${Math.floor(z / this.cell)}`;
    }
    /** 找最近点（搜索 3×3×3 邻格）。 */
    nearest(pts: Float32Array, x: number, y: number, z: number): { index: number; dist2: number } {
        let best = -1;
        let bestD2 = Infinity;
        const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell), cz = Math.floor(z / this.cell);
        for (let ix = cx - 1; ix <= cx + 1; ix++) {
            for (let iy = cy - 1; iy <= cy + 1; iy++) {
                for (let iz = cz - 1; iz <= cz + 1; iz++) {
                    const arr = this.map.get(`${ix}|${iy}|${iz}`);
                    if (!arr) continue;
                    for (const i of arr) {
                        const dx = pts[i * 3] - x, dy = pts[i * 3 + 1] - y, dz = pts[i * 3 + 2] - z;
                        const d2 = dx * dx + dy * dy + dz * dz;
                        if (d2 < bestD2) { bestD2 = d2; best = i; }
                    }
                }
            }
        }
        return { index: best, dist2: bestD2 };
    }
}

/**
 * 主轴粗对齐：枚举主轴排列(6) × 符号(8) = 48 个候选变换，用 dst 哈希网格
 * 评分（平均最近邻距离）选最优。
 *
 * PCA 主轴的符号（±）与顺序（近各向同性点云特征值接近时排列会抖动）都有
 * 歧义——单次 PCA 粗对齐对旋转模型不可靠（曾导致自动对齐失败）。48 候选
 * 覆盖所有组合，评分选最优后交给 ICP 精修。
 */
export function bestSymbolAlign(srcPts: Float32Array, dstPts: Float32Array): Mat4 {
    const n1 = srcPts.length / 3, n2 = dstPts.length / 3;
    const c1 = centroid(srcPts, n1), c2 = centroid(dstPts, n2);
    const E1 = pcaAxes(srcPts, n1, c1);   // 主轴向量（按特征值降序）
    const E2 = pcaAxes(dstPts, n2, c2);

    const diag = Math.sqrt(
        (maxRange(dstPts, 0)) ** 2 + (maxRange(dstPts, 1)) ** 2 + (maxRange(dstPts, 2)) ** 2
    );
    const grid = new HashGrid(dstPts, n2, Math.max(diag / 64, 1e-4));

    let bestT: Mat4 | null = null;
    let bestScore = Infinity;
    const tmp = new Vec3();
    const SAMPLES = 800;
    const step = Math.max(1, Math.floor(n1 / SAMPLES));

    const PERMS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

    for (const perm of PERMS) {
        const e1 = [E1[perm[0]], E1[perm[1]], E1[perm[2]]];
        for (let sx = -1; sx <= 1; sx += 2) {
            for (let sy = -1; sy <= 1; sy += 2) {
                for (let sz = -1; sz <= 1; sz += 2) {
                    const s = [sx, sy, sz];
                    // R = sum_k s[k] * outer(E2[k], e1[k])
                    const Rm = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
                    for (let k = 0; k < 3; k++) {
                        const a = E2[k], b = e1[k];
                        const sk = s[k];
                        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) Rm[i][j] += sk * a[i] * b[j];
                    }
                    const tx = c2.x - (Rm[0][0] * c1.x + Rm[0][1] * c1.y + Rm[0][2] * c1.z);
                    const ty = c2.y - (Rm[1][0] * c1.x + Rm[1][1] * c1.y + Rm[1][2] * c1.z);
                    const tz = c2.z - (Rm[2][0] * c1.x + Rm[2][1] * c1.y + Rm[2][2] * c1.z);
                    const T = new Mat4();
                    T.set([
                        Rm[0][0], Rm[1][0], Rm[2][0], 0,
                        Rm[0][1], Rm[1][1], Rm[2][1], 0,
                        Rm[0][2], Rm[1][2], Rm[2][2], 0,
                        tx, ty, tz, 1
                    ]);
                    // 评分
                    let score = 0;
                    let cnt = 0;
                    for (let i = 0; i < n1; i += step) {
                        tmp.set(srcPts[i * 3], srcPts[i * 3 + 1], srcPts[i * 3 + 2]);
                        T.transformPoint(tmp, tmp);
                        const nn = grid.nearest(dstPts, tmp.x, tmp.y, tmp.z);
                        if (nn.index >= 0) { score += nn.dist2; cnt++; }
                    }
                    if (cnt > 0) {
                        const avg = score / cnt;
                        if (avg < bestScore) {
                            bestScore = avg;
                            bestT = T;
                        }
                    }
                }
            }
        }
    }
    if (!bestT) throw new Error('主轴枚举未找到有效对齐');
    return bestT;
}

/**
 * 综合粗对齐：主轴枚举（48 候选）+ 方向采样多起点（104 候选）统一评分。
 *
 * 主轴枚举对"主轴明确的物体"高效；但各向同性点云（主轴随机）、中心对称
 * 物体（翻转等价解）、部分重叠模型都会让它失效。方向采样不依赖形状假设，
 * 均匀覆盖 SO(3)（黄金螺旋 26 方向 × 4 转角），两者取评分最优者。
 * 评分 = 变换后 src 采样点在 dst 网格中的平均最近邻距离（仅统计有对应者），
 * 并叠加少量"无对应点惩罚"以区分部分重叠场景。
 */
export function bestTransformAlign(srcPts: Float32Array, dstPts: Float32Array): Mat4 {
    const n1 = srcPts.length / 3, n2 = dstPts.length / 3;
    const diag = Math.sqrt(
        (maxRange(dstPts, 0)) ** 2 + (maxRange(dstPts, 1)) ** 2 + (maxRange(dstPts, 2)) ** 2
    );
    const grid = new HashGrid(dstPts, n2, Math.max(diag / 64, 1e-4));

    let bestT: Mat4 | null = null;
    let bestScore = Infinity;
    const tmp = new Vec3();

    const score = (T: Mat4): number => {
        let score = 0;
        let cnt = 0;
        let miss = 0;
        const SAMPLES = 800;
        const step = Math.max(1, Math.floor(n1 / SAMPLES));
        for (let i = 0; i < n1; i += step) {
            tmp.set(srcPts[i * 3], srcPts[i * 3 + 1], srcPts[i * 3 + 2]);
            T.transformPoint(tmp, tmp);
            const nn = grid.nearest(dstPts, tmp.x, tmp.y, tmp.z);
            if (nn.index >= 0) { score += nn.dist2; cnt++; }
            else miss++;
        }
        if (cnt === 0) return Infinity;
        // 平均距离 + 无对应点惩罚（重叠少 → 惩罚大）
        return score / cnt + (miss / SAMPLES) * diag * diag;
    };
    const consider = (T: Mat4) => {
        const s = score(T);
        if (s < bestScore) { bestScore = s; bestT = T; }
    };

    // 1) 主轴枚举（排列 × 符号 = 48）
    const c1 = centroid(srcPts, n1), c2 = centroid(dstPts, n2);
    const E1 = pcaAxes(srcPts, n1, c1);
    const E2 = pcaAxes(dstPts, n2, c2);
    const PERMS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    for (const perm of PERMS) {
        const e1 = [E1[perm[0]], E1[perm[1]], E1[perm[2]]];
        for (let sx = -1; sx <= 1; sx += 2) {
            for (let sy = -1; sy <= 1; sy += 2) {
                for (let sz = -1; sz <= 1; sz += 2) {
                    const s = [sx, sy, sz];
                    const Rm = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
                    for (let k = 0; k < 3; k++) {
                        const a = E2[k], b = e1[k];
                        const sk = s[k];
                        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) Rm[i][j] += sk * a[i] * b[j];
                    }
                    const tx = c2.x - (Rm[0][0] * c1.x + Rm[0][1] * c1.y + Rm[0][2] * c1.z);
                    const ty = c2.y - (Rm[1][0] * c1.x + Rm[1][1] * c1.y + Rm[1][2] * c1.z);
                    const tz = c2.z - (Rm[2][0] * c1.x + Rm[2][1] * c1.y + Rm[2][2] * c1.z);
                    const T = new Mat4();
                    T.set([
                        Rm[0][0], Rm[1][0], Rm[2][0], 0,
                        Rm[0][1], Rm[1][1], Rm[2][1], 0,
                        Rm[0][2], Rm[1][2], Rm[2][2], 0,
                        tx, ty, tz, 1
                    ]);
                    consider(T);
                }
            }
        }
    }

    // 2) 方向采样多起点：黄金螺旋 26 方向 × 4 转角 = 104 候选（绕 src 质心）
    const q = new Quat();
    for (let i = 0; i < 26; i++) {
        const y = 1 - (i / 25) * 2;
        const rr = Math.sqrt(Math.max(0, 1 - y * y));
        const th = i * 2.399963;
        const ax = new Vec3(rr * Math.cos(th), y, rr * Math.sin(th));
        for (let k = 0; k < 4; k++) {
            const angDeg = k * 90;
            q.setFromAxisAngle(ax, (angDeg * Math.PI) / 180);
            const Rm = rotationMatrix(q);
            const tx = c2.x - (Rm[0][0] * c1.x + Rm[0][1] * c1.y + Rm[0][2] * c1.z);
            const ty = c2.y - (Rm[1][0] * c1.x + Rm[1][1] * c1.y + Rm[1][2] * c1.z);
            const tz = c2.z - (Rm[2][0] * c1.x + Rm[2][1] * c1.y + Rm[2][2] * c1.z);
            const T = new Mat4();
            T.set([
                Rm[0][0], Rm[1][0], Rm[2][0], 0,
                Rm[0][1], Rm[1][1], Rm[2][1], 0,
                Rm[0][2], Rm[1][2], Rm[2][2], 0,
                tx, ty, tz, 1
            ]);
            consider(T);
        }
    }

    if (!bestT) throw new Error('粗对齐未找到有效候选');
    return bestT;
}

/** 四元数 → 3×3 旋转矩阵（行 = Rm[i][j] 数学约定）。 */
function rotationMatrix(q: Quat): number[][] {
    const { x, y, z, w } = q;
    return [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]
    ];
}

function maxRange(pts: Float32Array, axis: number): number {
    let min = Infinity, max = -Infinity;
    const n = pts.length / 3;
    for (let i = 0; i < n; i++) {
        const v = pts[i * 3 + axis];
        if (v < min) min = v;
        if (v > max) max = v;
    }
    return max - min;
}

/**
 * 自动对齐：src 模型变换到与 dst 重叠（主轴符号枚举粗对齐 + 点对 ICP 精修）。
 * 返回 src 应叠加的变换增量（直接应用到 src.entity 的 local transform）。
 */
export async function autoAlign(
    src: MergeModel,
    dst: MergeModel,
    onProgress?: (stage: string, pct: number) => void
): Promise<void> {
    const MAX_PTS = 20000;
    const srcPts = src.samplePoints(MAX_PTS);
    const dstPts = dst.samplePoints(MAX_PTS);
    const n1 = srcPts.length / 3, n2 = dstPts.length / 3;

    onProgress?.('计算粗对齐…', 5);
    // 粗对齐：主轴枚举（48 候选）+ 方向采样多起点（104 候选）统一评分选最优
    // 覆盖：主轴明确的物体 / 各向同性点云 / 主轴歧义 / 部分重叠等场景
    const pre = bestTransformAlign(srcPts, dstPts);

    // 应用粗对齐得到新的 src 世界点
    const srcPtsAligned = new Float32Array(n1 * 3);
    const tmp = new Vec3();
    for (let i = 0; i < n1; i++) {
        tmp.set(srcPts[i * 3], srcPts[i * 3 + 1], srcPts[i * 3 + 2]);
        pre.transformPoint(tmp, tmp);
        srcPtsAligned[i * 3] = tmp.x;
        srcPtsAligned[i * 3 + 1] = tmp.y;
        srcPtsAligned[i * 3 + 2] = tmp.z;
    }

    // ICP 精修（网格哈希最近邻 + Kabsch）
    const diag = Math.sqrt(
        (dst.worldBound.halfExtents.x * 2) ** 2 +
        (dst.worldBound.halfExtents.y * 2) ** 2 +
        (dst.worldBound.halfExtents.z * 2) ** 2
    );
    const cell = Math.max(diag / 128, 1e-4);
    const grid = new HashGrid(dstPts, n2, cell);
    const ITER = 14;
    let total = new Mat4().setIdentity();
    let cur = srcPtsAligned;
    let prevError = Infinity;

    for (let it = 0; it < ITER; it++) {
        onProgress?.('ICP 迭代…', 10 + (it / ITER) * 80);
        // 对应点（a → b）
        const pa = new Float32Array(n1 * 3);
        const pb = new Float32Array(n1 * 3);
        let k = 0;
        let errSum = 0;
        for (let i = 0; i < n1; i++) {
            const nn = grid.nearest(dstPts, cur[i * 3], cur[i * 3 + 1], cur[i * 3 + 2]);
            if (nn.index < 0) continue;
            pa[k * 3] = cur[i * 3]; pa[k * 3 + 1] = cur[i * 3 + 1]; pa[k * 3 + 2] = cur[i * 3 + 2];
            pb[k * 3] = dstPts[nn.index * 3]; pb[k * 3 + 1] = dstPts[nn.index * 3 + 1]; pb[k * 3 + 2] = dstPts[nn.index * 3 + 2];
            errSum += nn.dist2;
            k++;
        }
        if (k < 30) break; // 对应点太少（两模型重叠极少）
        const err = errSum / k;
        if (Math.abs(prevError - err) / prevError < 1e-3 || err < 1e-8) break;
        prevError = err;
        const { R, t } = kabsch(pa.subarray(0, k * 3), pb.subarray(0, k * 3));
        // 变换矩阵 T = [R t]
        const T = new Mat4();
        const r = R.data;
        T.set([
            r[0], r[1], r[2], 0,
            r[4], r[5], r[6], 0,
            r[8], r[9], r[10], 0,
            t.x, t.y, t.z, 1
        ]);
        total = total.clone().mul(T);
        // 更新 cur（全量）作为下一次迭代的源位置
        for (let i = 0; i < n1; i++) {
            tmp.set(cur[i * 3], cur[i * 3 + 1], cur[i * 3 + 2]);
            T.transformPoint(tmp, tmp);
            cur[i * 3] = tmp.x; cur[i * 3 + 1] = tmp.y; cur[i * 3 + 2] = tmp.z;
        }
    }
    onProgress?.('应用变换…', 95);

    // total 是预对齐后的 src 世界点 → dst 的残差变换；pre 是 PCA 粗对齐变换。
    // src 是 contentRoot 直接子级（世界 = local），新的 local = total * pre * cur。
    const curLocal = src.entity.getLocalTransform();
    const nextLocal = total.clone().mul(pre).mul(curLocal);
    nextLocal.getTranslation(tmp);
    src.entity.setLocalPosition(tmp);
    src.entity.setLocalRotation(matToQuat(nextLocal));
    const sc = nextLocal.getScale();
    src.entity.setLocalScale(sc);
    src.computeWorldAabb();
    onProgress?.('完成', 100);
}

/** 3×3 矩阵 → 四元数（PlayCanvas Mat4 无 getRotation，手写提取）。 */
export function matToQuat(m: Mat4): Quat {
    const d = m.data;
    const q = new Quat();
    const tr = d[0] + d[5] + d[10];
    if (tr > 0) {
        let s = Math.sqrt(tr + 1) * 2;
        q.w = 0.25 * s;
        q.x = (d[6] - d[9]) / s;
        q.y = (d[8] - d[2]) / s;
        q.z = (d[1] - d[4]) / s;
    } else if (d[0] > d[5] && d[0] > d[10]) {
        let s = Math.sqrt(1 + d[0] - d[5] - d[10]) * 2;
        q.w = (d[6] - d[9]) / s;
        q.x = 0.25 * s;
        q.y = (d[1] + d[4]) / s;
        q.z = (d[8] + d[2]) / s;
    } else if (d[5] > d[10]) {
        let s = Math.sqrt(1 + d[5] - d[0] - d[10]) * 2;
        q.w = (d[8] - d[2]) / s;
        q.x = (d[1] + d[4]) / s;
        q.y = 0.25 * s;
        q.z = (d[6] + d[9]) / s;
    } else {
        let s = Math.sqrt(1 + d[10] - d[0] - d[5]) * 2;
        q.w = (d[1] - d[4]) / s;
        q.x = (d[8] + d[2]) / s;
        q.y = (d[6] + d[9]) / s;
        q.z = 0.25 * s;
    }
    q.normalize();
    return q;
}

/** 屏幕射线拾取：返回命中的模型与最近点（遍历所有可见模型）。 */
export function raycastPick(
    models: MergeModel[],
    rayOrigin: Vec3,
    rayDir: Vec3,
    maxDist = Infinity,
    screenPxRadius = 18
): { model: MergeModel; pos: Vec3; dist: number; index: number } | null {
    let best: { model: MergeModel; pos: Vec3; dist: number; index: number; screenD2?: number } | null = null;
    for (const m of models) {
        if (!m.visible) continue;
        const xs = m.gsplatData.getProp('x') as Float32Array;
        const ys = m.gsplatData.getProp('y') as Float32Array;
        const zs = m.gsplatData.getProp('z') as Float32Array;
        // 各向异性 scale（用于估算 splat 屏幕半径）
        const sxArr = m.gsplatData.getProp('scale_x') as Float32Array | undefined;
        const syArr = m.gsplatData.getProp('scale_y') as Float32Array | undefined;
        const szArr = m.gsplatData.getProp('scale_z') as Float32Array | undefined;
        const n = m.gsplatData.numSplats;
        const wm = m.entity.getWorldTransform();
        const inv = new Mat4();
        inv.copy(wm).invert();
        const lo = new Vec3(rayOrigin.x, rayOrigin.y, rayOrigin.z);
        const ld = new Vec3(rayDir.x, rayDir.y, rayDir.z);
        inv.transformPoint(lo, lo);
        inv.transformVector(ld, ld);
        ld.normalize();
        // 采样密度：单模型最多 50 万点；stride = 1（不再丢点，保证命中精度）
        const stride = 1;
        // 该模型在射线方向上最近 splat 的距离平方
        let bestD2 = Infinity;
        let bestP: Vec3 | null = null;
        let bestIdx = -1;
        // 该模型在射线方向上最大半径估计（3σ 平均），用于判断 splat 屏幕投影
        let maxSplatRadius = 0;
        for (let i = 0; i < n; i += stride) {
            const px = xs[i] - lo.x, py = ys[i] - lo.y, pz = zs[i] - lo.z;
            const t = px * ld.x + py * ld.y + pz * ld.z;
            if (t < 0) continue;
            const dx = px - ld.x * t, dy = py - ld.y * t, dz = pz - ld.z * t;
            const d2 = dx * dx + dy * dy + dz * dz;
            // 命中点 = 射线到 splat 中心的最近点（lo + ld * t），而不是 splat 中心本身
            // 这样 marker 落在用户点击的真实 3D 位置，视觉上完全贴住点击像素
            if (d2 < bestD2) {
                bestD2 = d2;
                bestP = new Vec3(lo.x + ld.x * t, lo.y + ld.y * t, lo.z + ld.z * t);
                bestIdx = i;
            }
            // 估算 splat 半径（取最大尺度 3σ）
            if (sxArr && syArr && szArr) {
                const r = Math.max(sxArr[i], syArr[i], szArr[i]) * 3;
                if (r > maxSplatRadius) maxSplatRadius = r;
            }
        }
        if (!bestP || bestIdx < 0) continue;
        const wp = new Vec3(bestP.x, bestP.y, bestP.z);
        wm.transformPoint(wp, wp);
        const dist = wp.distance(rayOrigin);
        if (dist > maxDist) continue;
        // 距离平方的"等价屏幕像素"近似：3D 距离 / 相机距离 * fov比例 / canvas高度 * heightPx
        // 这里用相机距模型中心的距离估算 FOV 下的世界→像素比
        const camDist = wp.distance(rayOrigin) || 1;
        const fovScale = camDist * Math.tan((50 * Math.PI / 180) / 2);  // 与 panel 取一致的 fov=50
        // 屏幕阈值 → 世界距离：fovScale 近似对应半屏高度；将像素阈值映射为相对比例。
        // screenPxRadius < 0 或 Infinity 表示"不过滤，返回最近 splat"（用于拖拽跟随）。
        const tolRatio = Number.isFinite(screenPxRadius) && screenPxRadius >= 0
            ? screenPxRadius / 1000
            : Infinity;
        const worldTol = Math.max(maxSplatRadius, tolRatio === Infinity ? Infinity : fovScale * tolRatio);
        if (worldTol !== Infinity && bestD2 > worldTol * worldTol) continue;   // 最近 splat 离射线太远，认为未命中
        if (!best || dist < best.dist) {
            best = { model: m, pos: wp, dist, index: bestIdx };
        }
    }
    return best;
}
