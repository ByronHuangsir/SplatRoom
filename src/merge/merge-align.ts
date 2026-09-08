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

    // 奇异值 + 左奇异向量（U 列 = H v_i / s_i）
    const U = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const sig = [0, 0, 0];
    const hv: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    // 最大奇异值（相对零判定基准）：平面/共线标记点的近零特征值（如 1e-14 残差）
    // 开方后仍可能 > 1e-9，若按绝对阈值当有效列处理，U 列会被数值噪声污染，
    // Gram-Schmidt 归一化后仍落在已有平面内，R 缺一维（det=0）→ 误报"变换异常"
    const sMax = Math.sqrt(Math.max(0, lambda[order[0]]));
    for (let i = 0; i < 3; i++) {
        // symmetricEig3 的 vectors 布局：列 = 特征向量
        const v = [V[0][order[i]], V[1][order[i]], V[2][order[i]]];
        hv[0][i] = H[0][0] * v[0] + H[0][1] * v[1] + H[0][2] * v[2];
        hv[1][i] = H[1][0] * v[0] + H[1][1] * v[1] + H[1][2] * v[2];
        hv[2][i] = H[2][0] * v[0] + H[2][1] * v[1] + H[2][2] * v[2];
        const s = Math.sqrt(Math.max(0, lambda[order[i]]));
        sig[i] = s;
        if (s > 1e-9 && s > 1e-6 * sMax) {
            U[0][i] = hv[0][i] / s; U[1][i] = hv[1][i] / s; U[2][i] = hv[2][i] / s;
        }
    }
    // 全部 U 列统一 Gram-Schmidt 正交归一化（按奇异值降序）。
    // 秩不足的列（近似共线/共面标记点）由下方零列处理补正交方向，
    // 保证 R 始终正交（det=±1），不依赖奇异值绝对大小。
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < i; j++) {
            const dot = U[0][i] * U[0][j] + U[1][i] * U[1][j] + U[2][i] * U[2][j];
            U[0][i] -= dot * U[0][j];
            U[1][i] -= dot * U[1][j];
            U[2][i] -= dot * U[2][j];
        }
        const len = Math.hypot(U[0][i], U[1][i], U[2][i]);
        if (len < 1e-12) {
            // 秩不足导致的零列：依次尝试三个坐标轴方向，取第一个
            // 与已确定列正交化后非零者（单一 [1,0,0] 可能在已张成平面内
            // 被完全消去而归零——例如 U0/U1 张成 XY 平面时需用 Z 轴补列）
            let done = false;
            for (const axis of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
                let ux = axis[0], uy = axis[1], uz = axis[2];
                for (let j = 0; j < i; j++) {
                    const dot = ux * U[0][j] + uy * U[1][j] + uz * U[2][j];
                    ux -= dot * U[0][j];
                    uy -= dot * U[1][j];
                    uz -= dot * U[2][j];
                }
                const l = Math.hypot(ux, uy, uz);
                if (l > 1e-9) {
                    U[0][i] = ux / l; U[1][i] = uy / l; U[2][i] = uz / l;
                    done = true;
                    break;
                }
            }
            if (!done) {
                U[0][i] = 1; U[1][i] = 0; U[2][i] = 0;
            }
        } else {
            U[0][i] /= len; U[1][i] /= len; U[2][i] /= len;
        }
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
    const Utd = Ut.map((row, ri) => (ri === 2 ? row.map(v => v * d) : row));
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
        for (let p = 0; p < 2; p++) {
            for (let q = p + 1; q < 3; q++) {
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
    }
    return { vectors: eig, values: [a[0][0], a[1][1], a[2][2]] };
}

function transpose3(m: number[][]): number[][] {
    return [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]];
}
function mul3(a: number[][], b: number[][]): number[][] {
    const o = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            o[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    return o;
}
function determinant3(m: number[][]): number {
    return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
         m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
         m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
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
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            m[i][j] = e2[i][0] * e1[j][0] + e2[i][1] * e1[j][1] + e2[i][2] * e1[j][2];
        }
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
    for (let i = 0; i < n; i++) {
        x += p[i * 3]; y += p[i * 3 + 1]; z += p[i * 3 + 2];
    }
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
    const a = [[c00, c01, c02], [c01, c11, c12], [c02, c12, c22]];
    const eig = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let iter = 0; iter < 32; iter++) {
        let off = 0;
        for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] * a[p][q];
        if (off < 1e-20) break;
        for (let p = 0; p < 2; p++) {
            for (let q = p + 1; q < 3; q++) {
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
    get cellSize(): number {
        return this.cell;
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
                        if (d2 < bestD2) {
                            bestD2 = d2; best = i;
                        }
                    }
                }
            }
        }
        return { index: best, dist2: bestD2 };
    }
    /** 加权最近：几何距离 + 颜色距离（colorScale 归一化颜色差异到几何尺度）。 */
    nearestWeighted(
        pts: Float32Array,
        colors: Float32Array | null,
        colorScale: number,
        x: number,
        y: number,
        z: number,
        cr = 0,
        cg = 0,
        cb = 0
    ): { index: number; dist2: number; colorD2: number } {
        let best = -1;
        let bestCost = Infinity;
        let bestD2 = Infinity;
        let bestC2 = Infinity;
        const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell), cz = Math.floor(z / this.cell);
        for (let ix = cx - 1; ix <= cx + 1; ix++) {
            for (let iy = cy - 1; iy <= cy + 1; iy++) {
                for (let iz = cz - 1; iz <= cz + 1; iz++) {
                    const arr = this.map.get(`${ix}|${iy}|${iz}`);
                    if (!arr) continue;
                    for (const i of arr) {
                        const dx = pts[i * 3] - x, dy = pts[i * 3 + 1] - y, dz = pts[i * 3 + 2] - z;
                        const d2 = dx * dx + dy * dy + dz * dz;
                        let cost = d2;
                        let c2 = 0;
                        if (colors) {
                            c2 = (colors[i * 3] - cr) * (colors[i * 3] - cr) +
                                 (colors[i * 3 + 1] - cg) * (colors[i * 3 + 1] - cg) +
                                 (colors[i * 3 + 2] - cb) * (colors[i * 3 + 2] - cb);
                            cost += c2 * colorScale * colorScale;
                        }
                        if (cost < bestCost) {
                            bestCost = cost;
                            best = i;
                            bestD2 = d2;
                            bestC2 = c2;
                        }
                    }
                }
            }
        }
        return { index: best, dist2: bestD2, colorD2: bestC2 };
    }
    /** 收集 3×3×3 邻格内的点索引（供法线估计等）。 */
    collect(x: number, y: number, z: number, out: number[]): void {
        const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell), cz = Math.floor(z / this.cell);
        for (let ix = cx - 1; ix <= cx + 1; ix++) {
            for (let iy = cy - 1; iy <= cy + 1; iy++) {
                for (let iz = cz - 1; iz <= cz + 1; iz++) {
                    const arr = this.map.get(`${ix}|${iy}|${iz}`);
                    if (arr) {
                        for (const i of arr) out.push(i);
                    }
                }
            }
        }
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
                        if (nn.index >= 0) {
                            score += nn.dist2; cnt++;
                        }
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
            if (nn.index >= 0) {
                score += nn.dist2; cnt++;
            } else miss++;
        }
        if (cnt === 0) return Infinity;
        // 平均距离 + 无对应点惩罚（重叠少 → 惩罚大）
        return score / cnt + (miss / SAMPLES) * diag * diag;
    };
    const consider = (T: Mat4) => {
        const s = score(T);
        if (s < bestScore) {
            bestScore = s; bestT = T;
        }
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
// eslint-disable-next-line require-await -- 对外 API 保持 async 供调用方 await，当前实现同步
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
    const cur = srcPtsAligned;
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
        const s = Math.sqrt(tr + 1) * 2;
        q.w = 0.25 * s;
        q.x = (d[6] - d[9]) / s;
        q.y = (d[8] - d[2]) / s;
        q.z = (d[1] - d[4]) / s;
    } else if (d[0] > d[5] && d[0] > d[10]) {
        const s = Math.sqrt(1 + d[0] - d[5] - d[10]) * 2;
        q.w = (d[6] - d[9]) / s;
        q.x = 0.25 * s;
        q.y = (d[1] + d[4]) / s;
        q.z = (d[8] + d[2]) / s;
    } else if (d[5] > d[10]) {
        const s = Math.sqrt(1 + d[5] - d[0] - d[10]) * 2;
        q.w = (d[8] - d[2]) / s;
        q.x = (d[1] + d[4]) / s;
        q.y = 0.25 * s;
        q.z = (d[6] + d[9]) / s;
    } else {
        const s = Math.sqrt(1 + d[10] - d[0] - d[5]) * 2;
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
    screenPxRadius = 18,
    screenH = 1080
): { model: MergeModel; pos: Vec3; dist: number; index: number } | null {
    let best: { model: MergeModel; pos: Vec3; dist: number; index: number; screenD2?: number } | null = null;
    for (const m of models) {
        if (!m.visible) continue;
        const xs = m.gsplatData.getProp('x') as Float32Array;
        const ys = m.gsplatData.getProp('y') as Float32Array;
        const zs = m.gsplatData.getProp('z') as Float32Array;
        // 各向异性 scale（GSplat scale_0..2 为 log 域，需 exp 得到实际尺度）
        const sxArr = m.gsplatData.getProp('scale_0') as Float32Array | undefined;
        const syArr = m.gsplatData.getProp('scale_1') as Float32Array | undefined;
        const szArr = m.gsplatData.getProp('scale_2') as Float32Array | undefined;
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
            // 估算 splat 半径（取最大尺度 3σ；scale 为 log 域 → exp）
            if (sxArr && syArr && szArr) {
                const r = Math.max(Math.exp(sxArr[i]), Math.exp(syArr[i]), Math.exp(szArr[i])) * 3;
                if (r > maxSplatRadius) maxSplatRadius = r;
            }
        }
        if (!bestP || bestIdx < 0) continue;
        const wp = new Vec3(bestP.x, bestP.y, bestP.z);
        wm.transformPoint(wp, wp);
        const dist = wp.distance(rayOrigin);
        if (dist > maxDist) continue;
        // 屏幕像素阈值 → 世界距离的精确映射（与 scene.worldPerPixelAt 一致）：
        //   每像素世界尺寸 = 2*d*tan(fov/2)/canvasHeight
        // screenPxRadius < 0 或 Infinity 表示"不过滤，返回最近 splat"（用于拖拽跟随）。
        const camDist = wp.distance(rayOrigin) || 1;
        const fovRad = (50 * Math.PI) / 180;  // 与 merge-scene.fov=50 一致
        const pxWorld = (2 * camDist * Math.tan(fovRad / 2)) / Math.max(1, screenH);
        const screenTol = Number.isFinite(screenPxRadius) && screenPxRadius >= 0 ? screenPxRadius : Infinity;
        const worldTol = Math.max(maxSplatRadius, screenTol === Infinity ? Infinity : screenTol * pxWorld);
        if (worldTol !== Infinity && bestD2 > worldTol * worldTol) continue;   // 最近 splat 离射线太远，认为未命中
        if (!best || dist < best.dist) {
            best = { model: m, pos: wp, dist, index: bestIdx };
        }
    }
    return best;
}

// ------------------------------------------------------------------
// 相似识别（标记点粗配准 + 颜色/几何/法线融合 ICP，求解相似变换含缩放）
//
// 用途：标记对齐只提供「粗略种子」，最终配准由算法自动完成——
//   - 几何一致性：点-点残差（ICP 主项）
//   - 平面一致性：点到面残差（dst 邻域 PCA 法线）+ 法线方向一致性
//   - 颜色一致性：f_dc 颜色距离加权最近邻（color-ICP）
//   - 形状一致性：Umeyama 相似变换（刚体 + 均匀缩放）拟合整体形状
// 种子扰动多候选：标记配准 ± 随机扰动生成多起点，综合评分选最优，
// 因此标记点不必精确，只负责把两模型大致带到同一朝向。
// ------------------------------------------------------------------

export interface SimilarityOptions {
    /** ICP 最大迭代（默认 24） */
    maxIter?: number;
    /** 每模型采样点数（默认 12000） */
    sample?: number;
    /** 颜色一致性权重（默认 0.8） */
    weightColor?: number;
    /** 颜色距离归一化系数 = 模型对角线的比例（默认 0.02） */
    colorScaleFrac?: number;
    /** 种子扰动候选数（默认 8） */
    seeds?: number;
    /** 扰动角度 ±°（默认 6） */
    perturbAngleDeg?: number;
    /** 扰动平移/缩放比例（默认 0.04） */
    perturbScaleFrac?: number;
    // 标记点锚点对（src=源模型当前世界点，dst=目标模型世界点）：
    //  ICP 迭代与评分中的硬约束，保证最终对齐保持标记点对应。
    anchorPairs?: { src: number[]; dst: number[] }[];
    /** 锚点权重（对应点复制倍数，默认 6） */
    anchorWeight?: number;
}

export interface SimilarityResult {
    /** 总相似变换（src 世界 → dst 世界，含缩放） */
    T: Mat4;
    /** 均匀缩放因子 */
    s: number;
    /** 旋转角（度） */
    rotAngleDeg: number;
    /** 综合评分（越小越好） */
    score: number;
    /** 几何残差（点-点均方根，单位²） */
    geomError: number;
    /** 平面残差（点到面均方，单位²） */
    planeError: number;
    /** 颜色残差（f_dc 均方） */
    colorError: number;
    /** 法线不一致均值（0=完全一致，1=完全垂直） */
    normalScore: number;
    /** 覆盖度（有对应点的采样比例，0-1） */
    coverage: number;
    /** 标记点残差（变换后锚点源到目标平均距离，单位） */
    markerError: number;
    iters: number;
}

const yieldFrame = () => new Promise<void>((r) => {
    setTimeout(r, 0);
});

/** Umeyama 相似变换（刚体 + 均匀缩放）：pA → pB。返回 R(旋转)、t(平移)、s(缩放)。 */
export function umeyamaSimilarity(pA: Float32Array, pB: Float32Array): { R: Mat4; t: Vec3; s: number } {
    const n = pA.length / 3;
    if (n < 3) throw new Error('至少需要 3 组对应点');
    let cx = 0, cy = 0, cz = 0, dx = 0, dy = 0, dz = 0;
    for (let i = 0; i < n; i++) {
        cx += pA[i * 3]; cy += pA[i * 3 + 1]; cz += pA[i * 3 + 2];
        dx += pB[i * 3]; dy += pB[i * 3 + 1]; dz += pB[i * 3 + 2];
    }
    cx /= n; cy /= n; cz /= n; dx /= n; dy /= n; dz /= n;

    // H = Σ (a-cA)(b-cB)^T；varA = Σ|a-cA|²
    const H = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    let varA = 0;
    for (let i = 0; i < n; i++) {
        const ax = pA[i * 3] - cx, ay = pA[i * 3 + 1] - cy, az = pA[i * 3 + 2] - cz;
        const bx = pB[i * 3] - dx, by = pB[i * 3 + 1] - dy, bz = pB[i * 3 + 2] - dz;
        H[0][0] += ax * bx; H[0][1] += ax * by; H[0][2] += ax * bz;
        H[1][0] += ay * bx; H[1][1] += ay * by; H[1][2] += ay * bz;
        H[2][0] += az * bx; H[2][1] += az * by; H[2][2] += az * bz;
        varA += ax * ax + ay * ay + az * az;
    }

    // S = H^T H（对称），特征分解 S = V Λ V^T
    const S = [
        [H[0][0] * H[0][0] + H[1][0] * H[1][0] + H[2][0] * H[2][0], H[0][0] * H[0][1] + H[1][0] * H[1][1] + H[2][0] * H[2][1], H[0][0] * H[0][2] + H[1][0] * H[1][2] + H[2][0] * H[2][2]],
        [H[0][1] * H[0][0] + H[1][1] * H[1][0] + H[2][1] * H[2][0], H[0][1] * H[0][1] + H[1][1] * H[1][1] + H[2][1] * H[2][1], H[0][1] * H[0][2] + H[1][1] * H[1][2] + H[2][1] * H[2][2]],
        [H[0][2] * H[0][0] + H[1][2] * H[1][0] + H[2][2] * H[2][0], H[0][2] * H[0][1] + H[1][2] * H[1][1] + H[2][2] * H[2][1], H[0][2] * H[0][2] + H[1][2] * H[1][2] + H[2][2] * H[2][2]]
    ];
    const { vectors: V, values: lambda } = symmetricEig3(S);
    const order = [0, 1, 2].sort((a, b) => Math.abs(lambda[b]) - Math.abs(lambda[a]));

    // 奇异值 + 左奇异向量（U 列 = H v_i / s_i）
    const U = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const sig = [0, 0, 0];
    const hv: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const sMax = Math.sqrt(Math.max(0, lambda[order[0]]));
    for (let i = 0; i < 3; i++) {
        const v = [V[0][order[i]], V[1][order[i]], V[2][order[i]]];
        hv[0][i] = H[0][0] * v[0] + H[0][1] * v[1] + H[0][2] * v[2];
        hv[1][i] = H[1][0] * v[0] + H[1][1] * v[1] + H[1][2] * v[2];
        hv[2][i] = H[2][0] * v[0] + H[2][1] * v[1] + H[2][2] * v[2];
        const s = Math.sqrt(Math.max(0, lambda[order[i]]));
        sig[i] = s;
        // 相对零判定（同 kabsch）：σ_i > 1e-6·σ_max 才视为有效
        if (s > 1e-9 && s > 1e-6 * sMax) {
            U[0][i] = hv[0][i] / s; U[1][i] = hv[1][i] / s; U[2][i] = hv[2][i] / s;
        }
    }
    // 全部 U 列统一 Gram-Schmidt 正交归一化（同 kabsch：防近零奇异值导致
    // U 列数值爆炸、R 非正交，避免标记点近似共线时误报"变换异常"）
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < i; j++) {
            const dot = U[0][i] * U[0][j] + U[1][i] * U[1][j] + U[2][i] * U[2][j];
            U[0][i] -= dot * U[0][j];
            U[1][i] -= dot * U[1][j];
            U[2][i] -= dot * U[2][j];
        }
        const len = Math.hypot(U[0][i], U[1][i], U[2][i]);
        if (len < 1e-12) {
            // 秩不足导致的零列：依次尝试三个坐标轴方向（同 kabsch）
            let done = false;
            for (const axis of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
                let ux = axis[0], uy = axis[1], uz = axis[2];
                for (let j = 0; j < i; j++) {
                    const dot = ux * U[0][j] + uy * U[1][j] + uz * U[2][j];
                    ux -= dot * U[0][j];
                    uy -= dot * U[1][j];
                    uz -= dot * U[2][j];
                }
                const l = Math.hypot(ux, uy, uz);
                if (l > 1e-9) {
                    U[0][i] = ux / l; U[1][i] = uy / l; U[2][i] = uz / l;
                    done = true;
                    break;
                }
            }
            if (!done) {
                U[0][i] = 1; U[1][i] = 0; U[2][i] = 0;
            }
        } else {
            U[0][i] /= len; U[1][i] /= len; U[2][i] /= len;
        }
    }

    // R = V * diag(1,1,det(V U^T)) * U^T
    const Vc = order.map(k => [V[0][k], V[1][k], V[2][k]]);
    const Ut = transpose3(U);
    const Vmat = transpose3(Vc);
    const VUt = mul3(Vmat, Ut);
    const det = determinant3(VUt);
    const d = det < 0 ? -1 : 1;
    const Utd = Ut.map((row, ri) => (ri === 2 ? row.map(v => v * d) : row));
    const r = mul3(Vmat, Utd);

    const R = new Mat4();
    R.set([
        r[0][0], r[1][0], r[2][0], 0,
        r[0][1], r[1][1], r[2][1], 0,
        r[0][2], r[1][2], r[2][2], 0,
        0, 0, 0, 1
    ]);
    // 缩放：s = Σ(σ_i·d_i)/Σ|a'|²（d_i = 1,1,d）
    const s = (sig[0] + sig[1] + d * sig[2]) / (varA || 1e-12);
    const rc = new Vec3(cx, cy, cz);
    R.transformVector(rc, rc);
    const t = new Vec3(dx - s * rc.x, dy - s * rc.y, dz - s * rc.z);
    return { R, t, s };
}

/** 从模型采样点与颜色（世界坐标；f_dc 线性距离即可）。 */
function sampleModelData(m: MergeModel, maxN: number): { pts: Float32Array; colors: Float32Array } {
    const sd = m.gsplatData;
    const xs = sd.getProp('x') as Float32Array;
    const ys = sd.getProp('y') as Float32Array;
    const zs = sd.getProp('z') as Float32Array;
    const c0 = sd.getProp('f_dc_0') as Float32Array | undefined;
    const c1 = sd.getProp('f_dc_1') as Float32Array | undefined;
    const c2 = sd.getProp('f_dc_2') as Float32Array | undefined;
    const n = sd.numSplats;
    const step = Math.max(1, Math.floor(n / Math.max(1, maxN)));
    const count = Math.ceil(n / step);
    const pts = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const wm = m.entity.getWorldTransform();
    const p = new Vec3();
    let k = 0;
    for (let i = 0; i < n; i += step) {
        p.set(xs[i], ys[i], zs[i]);
        wm.transformPoint(p, p);
        pts[k * 3] = p.x; pts[k * 3 + 1] = p.y; pts[k * 3 + 2] = p.z;
        if (c0 && c1 && c2) {
            colors[k * 3] = c0[i]; colors[k * 3 + 1] = c1[i]; colors[k * 3 + 2] = c2[i];
        }
        k++;
    }
    return { pts, colors };
}

/** 邻域 PCA 法线估计（最小特征向量；未定向，评分用 |dot| 即可）。 */
function estimateNormals(pts: Float32Array, n: number, grid: HashGrid, k = 8): Float32Array {
    const out = new Float32Array(n * 3);
    const cand: number[] = [];
    const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < n; i++) {
        const x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2];
        cand.length = 0;
        grid.collect(x, y, z, cand);
        if (cand.length < 3) {
            out[i * 3 + 1] = 1; continue;
        }
        const dists = new Array(cand.length);
        for (let t = 0; t < cand.length; t++) {
            const j = cand[t];
            const dx = pts[j * 3] - x, dy = pts[j * 3 + 1] - y, dz = pts[j * 3 + 2] - z;
            dists[t] = dx * dx + dy * dy + dz * dz;
        }
        const ord = cand.map((_, t) => t).sort((a, b) => dists[a] - dists[b]).slice(0, Math.min(k, cand.length));
        let mx = 0, my = 0, mz = 0;
        for (const t of ord) {
            const j = cand[t]; mx += pts[j * 3]; my += pts[j * 3 + 1]; mz += pts[j * 3 + 2];
        }
        const m = ord.length;
        mx /= m; my /= m; mz /= m;
        cov[0][0] = cov[0][1] = cov[0][2] = 0;
        cov[1][0] = cov[1][1] = cov[1][2] = 0;
        cov[2][0] = cov[2][1] = cov[2][2] = 0;
        for (const t of ord) {
            const j = cand[t];
            const ux = pts[j * 3] - mx, uy = pts[j * 3 + 1] - my, uz = pts[j * 3 + 2] - mz;
            cov[0][0] += ux * ux; cov[0][1] += ux * uy; cov[0][2] += ux * uz;
            cov[1][1] += uy * uy; cov[1][2] += uy * uz; cov[2][2] += uz * uz;
        }
        cov[1][0] = cov[0][1]; cov[2][0] = cov[0][2]; cov[2][1] = cov[1][2];
        const { vectors, values } = symmetricEig3(cov);
        let minI = 0;
        if (values[1] < values[minI]) minI = 1;
        if (values[2] < values[minI]) minI = 2;
        out[i * 3] = vectors[0][minI]; out[i * 3 + 1] = vectors[1][minI]; out[i * 3 + 2] = vectors[2][minI];
    }
    return out;
}

/** 批量应用变换。 */
function applyTransformCopy(pts: Float32Array, T: Mat4): Float32Array {
    const n = pts.length / 3;
    const out = new Float32Array(pts.length);
    const tmp = new Vec3();
    for (let i = 0; i < n; i++) {
        tmp.set(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
        T.transformPoint(tmp, tmp);
        out[i * 3] = tmp.x; out[i * 3 + 1] = tmp.y; out[i * 3 + 2] = tmp.z;
    }
    return out;
}

/** 从相似变换分解 R（正交）、t、s。 */
function decomposeSimilarity(T: Mat4): { R: Mat4; t: Vec3; s: number } {
    const r = T.data;
    const sx = Math.hypot(r[0], r[1], r[2]) || 1;
    const sy = Math.hypot(r[4], r[5], r[6]) || 1;
    const sz = Math.hypot(r[8], r[9], r[10]) || 1;
    const s = (sx + sy + sz) / 3;
    const R = new Mat4();
    R.set([
        r[0] / sx, r[1] / sx, r[2] / sx, 0,
        r[4] / sy, r[5] / sy, r[6] / sy, 0,
        r[8] / sz, r[9] / sz, r[10] / sz, 0,
        0, 0, 0, 1
    ]);
    return { R, t: new Vec3(r[12], r[13], r[14]), s };
}

// 颜色+几何加权 ICP（Umeyama 相似变换迭代）。srcInit 为已应用初始变换的点。
//  anchors 为标记点锚点对：每轮迭代强制加入对应点集（源端固定，目标端为标记点
//  目标位置），使最终变换保持标记点对齐；anchorWeight 为复制倍数（权重）。
function colorWeightedIcp(
    srcInit: Float32Array,
    srcColors: Float32Array,
    dstPts: Float32Array,
    dstColors: Float32Array,
    grid: HashGrid,
    diag: number,
    colorScale: number,
    maxIter: number,
    anchors?: { src: number[]; dst: number[] }[],
    anchorWeight = 6
): { T: Mat4; iters: number } {
    const n1 = srcInit.length / 3;
    const anchorTotal = (anchors?.length ?? 0) * anchorWeight;
    const maxCorr = n1 + anchorTotal;
    const pa = new Float32Array(maxCorr * 3);
    const pb = new Float32Array(maxCorr * 3);
    const tmp = new Vec3();
    let total = new Mat4().setIdentity();
    const cur = srcInit.slice();
    // 锚点源当前位置（与 cur 同步变换；初始 = 候选变换后的锚点位置）
    const anchorCur: number[] = [];
    if (anchors) {
        for (const a of anchors) anchorCur.push(a.src[0], a.src[1], a.src[2]);
    }
    // 内点阈值自适应：首轮放宽（diag*0.05），之后随平均误差收紧（2.5σ）
    const maxDistInit = diag * 0.05;
    let maxDist = maxDistInit;
    let prevErr = Infinity;
    let iters = 0;
    for (let it = 0; it < maxIter; it++) {
        iters = it + 1;
        if (it > 0 && Number.isFinite(prevErr)) {
            const adapt = 2.5 * Math.sqrt(Math.max(prevErr, 1e-12));
            maxDist = Math.min(maxDistInit, Math.max(diag * 0.005, adapt));
        }
        let k = 0, errSum = 0;
        for (let i = 0; i < n1; i++) {
            const nn = grid.nearestWeighted(
                dstPts, dstColors, colorScale,
                cur[i * 3], cur[i * 3 + 1], cur[i * 3 + 2],
                srcColors[i * 3], srcColors[i * 3 + 1], srcColors[i * 3 + 2]
            );
            if (nn.index < 0) continue;
            if (nn.dist2 > maxDist * maxDist) continue;   // 几何内点筛选（剔除杂散对应）
            pa[k * 3] = cur[i * 3]; pa[k * 3 + 1] = cur[i * 3 + 1]; pa[k * 3 + 2] = cur[i * 3 + 2];
            pb[k * 3] = dstPts[nn.index * 3]; pb[k * 3 + 1] = dstPts[nn.index * 3 + 1]; pb[k * 3 + 2] = dstPts[nn.index * 3 + 2];
            errSum += nn.dist2;
            k++;
        }
        // 标记锚点约束：强制加入对应点集（复制 anchorWeight 次加权）。
        // 源端用 anchorCur（与 cur 同步），目标端为标记点目标位置。
        if (anchors) {
            for (let w = 0; w < anchorWeight; w++) {
                for (let ai = 0; ai < anchors.length; ai++) {
                    pa[k * 3] = anchorCur[ai * 3]; pa[k * 3 + 1] = anchorCur[ai * 3 + 1]; pa[k * 3 + 2] = anchorCur[ai * 3 + 2];
                    pb[k * 3] = anchors[ai].dst[0]; pb[k * 3 + 1] = anchors[ai].dst[1]; pb[k * 3 + 2] = anchors[ai].dst[2];
                    const ddx = anchorCur[ai * 3] - anchors[ai].dst[0];
                    const ddy = anchorCur[ai * 3 + 1] - anchors[ai].dst[1];
                    const ddz = anchorCur[ai * 3 + 2] - anchors[ai].dst[2];
                    errSum += ddx * ddx + ddy * ddy + ddz * ddz;
                    k++;
                }
            }
        }
        if (k < 30) break;   // 对应点太少（两模型重叠极少）
        const err = errSum / k;
        if (Math.abs(prevErr - err) / Math.max(prevErr, 1e-9) < 1e-5 || err < 1e-10) break;
        prevErr = err;
        const { R, t, s } = umeyamaSimilarity(pa.subarray(0, k * 3), pb.subarray(0, k * 3));
        // 缩放阻尼：限制单轮缩放幅度，防止早期对应错误导致缩放发散
        const sClamped = Math.max(0.85, Math.min(1.18, s));
        const r = R.data;
        const Tk = new Mat4();
        Tk.set([
            sClamped * r[0], sClamped * r[1], sClamped * r[2], 0,
            sClamped * r[4], sClamped * r[5], sClamped * r[6], 0,
            sClamped * r[8], sClamped * r[9], sClamped * r[10], 0,
            t.x, t.y, t.z, 1
        ]);
        total = Tk.clone().mul(total);
        for (let i = 0; i < n1; i++) {
            tmp.set(cur[i * 3], cur[i * 3 + 1], cur[i * 3 + 2]);
            Tk.transformPoint(tmp, tmp);
            cur[i * 3] = tmp.x; cur[i * 3 + 1] = tmp.y; cur[i * 3 + 2] = tmp.z;
        }
        // 锚点源同步变换（保持与 cur 同一坐标系）
        if (anchors) {
            for (let ai = 0; ai < anchors.length; ai++) {
                tmp.set(anchorCur[ai * 3], anchorCur[ai * 3 + 1], anchorCur[ai * 3 + 2]);
                Tk.transformPoint(tmp, tmp);
                anchorCur[ai * 3] = tmp.x; anchorCur[ai * 3 + 1] = tmp.y; anchorCur[ai * 3 + 2] = tmp.z;
            }
        }
    }
    return { T: total, iters };
}

/** 综合评分：几何 + 平面（点到面）+ 颜色 + 法线一致性 + 覆盖度 + 标记锚点残差。越小越好。 */
function evaluateAlignment(
    srcPts: Float32Array,
    srcColors: Float32Array,
    srcNormals: Float32Array,
    dstPts: Float32Array,
    dstColors: Float32Array,
    dstNormals: Float32Array,
    grid: HashGrid,
    diag: number,
    colorScale: number,
    T: Mat4,
    weights: { g: number; p: number; c: number; n: number; cov: number; m: number },
    anchors?: { src: number[]; dst: number[] }[]
): { score: number; geomError: number; planeError: number; colorError: number; normalScore: number; coverage: number; s: number; markerError: number } {
    const n1 = srcPts.length / 3;
    const { R, s } = decomposeSimilarity(T);
    const tmp = new Vec3();
    const nrm = new Vec3();
    let geom = 0, plane = 0, color = 0, norm = 0, cnt = 0;
    for (let i = 0; i < n1; i++) {
        tmp.set(srcPts[i * 3], srcPts[i * 3 + 1], srcPts[i * 3 + 2]);
        T.transformPoint(tmp, tmp);
        const nn = grid.nearestWeighted(
            dstPts, dstColors, colorScale, tmp.x, tmp.y, tmp.z,
            srcColors[i * 3], srcColors[i * 3 + 1], srcColors[i * 3 + 2]
        );
        if (nn.index < 0) continue;
        geom += nn.dist2;
        color += nn.colorD2;
        const nx = dstNormals[nn.index * 3], ny = dstNormals[nn.index * 3 + 1], nz = dstNormals[nn.index * 3 + 2];
        const px = dstPts[nn.index * 3] - tmp.x, py = dstPts[nn.index * 3 + 1] - tmp.y, pz = dstPts[nn.index * 3 + 2] - tmp.z;
        plane += (px * nx + py * ny + pz * nz) ** 2;   // 点到面
        nrm.set(srcNormals[i * 3], srcNormals[i * 3 + 1], srcNormals[i * 3 + 2]);
        R.transformVector(nrm, nrm);
        norm += 1 - Math.abs(nrm.x * nx + nrm.y * ny + nrm.z * nz);
        cnt++;
    }
    if (cnt === 0) {
        return { score: Infinity, geomError: Infinity, planeError: Infinity, colorError: Infinity, normalScore: Infinity, coverage: 0, s, markerError: Infinity };
    }
    geom /= cnt; color /= cnt; plane /= cnt; norm /= cnt;
    const coverage = cnt / n1;
    // 标记锚点残差：变换后锚点源到目标平均距离（硬约束评分项）
    let markerErr = 0;
    if (anchors && anchors.length > 0) {
        for (const a of anchors) {
            tmp.set(a.src[0], a.src[1], a.src[2]);
            T.transformPoint(tmp, tmp);
            const dx = tmp.x - a.dst[0], dy = tmp.y - a.dst[1], dz = tmp.z - a.dst[2];
            markerErr += dx * dx + dy * dy + dz * dz;
        }
        markerErr = Math.sqrt(markerErr / anchors.length);
    }
    const score =
        weights.g * (geom / (diag * diag)) +
        weights.p * (plane / (diag * diag)) +
        weights.c * (color / (colorScale * colorScale)) +
        weights.n * norm +
        weights.cov * (1 - coverage) +
        weights.m * ((markerErr * markerErr) / (diag * diag)) * 4;   // 锚点项高权重
    return { score, geomError: geom, planeError: plane, colorError: color, normalScore: norm, coverage, s, markerError: markerErr };
}

/** 种子扰动（确定性伪随机）：绕随机轴 ±angDeg、平移 ±frac·diag、缩放 ±frac（以 scaleBase 为中心）。 */
function perturbTransform(base: Mat4, angDeg: number, frac: number, diag: number, seed: number, scaleBase = 1): Mat4 {
    const rnd = (s: number) => {
        const x = (s * 9301 + 49297) % 233280;
        return x / 233280;
    };
    const a1 = rnd(seed * 7 + 1) * Math.PI * 2;
    const a2 = rnd(seed * 7 + 2) * 2 - 1;
    const a3 = rnd(seed * 7 + 3) * 2 - 1;
    const axis = new Vec3(Math.cos(a1) * Math.sqrt(1 - a2 * a2), a2, Math.sin(a1) * Math.sqrt(1 - a2 * a2)).normalize();
    const ang = (rnd(seed * 7 + 4) * 2 - 1) * (angDeg * Math.PI) / 180;
    const q = new Quat().setFromAxisAngle(axis, ang);
    const sc = scaleBase * (1 + (rnd(seed * 7 + 5) * 2 - 1) * frac);
    const tx = (rnd(seed * 7 + 6) * 2 - 1) * frac * diag;
    const ty = (rnd(seed * 7 + 7) * 2 - 1) * frac * diag;
    const tz = (rnd(seed * 7 + 8) * 2 - 1) * frac * diag;
    const P = new Mat4().setTRS(new Vec3(tx, ty, tz), q, new Vec3(sc, sc, sc));
    return P.clone().mul(base);
}

/** 由标记锚点对估计缩放先验：锚点间距离比（dst/src）的中位数。 */
function anchorScalePrior(anchors: { src: number[]; dst: number[] }[] | undefined): number {
    if (!anchors || anchors.length < 3) return 1;
    const ratios: number[] = [];
    for (let i = 0; i < anchors.length; i++) {
        for (let j = i + 1; j < anchors.length; j++) {
            const sx = anchors[i].src[0] - anchors[j].src[0];
            const sy = anchors[i].src[1] - anchors[j].src[1];
            const sz = anchors[i].src[2] - anchors[j].src[2];
            const dx = anchors[i].dst[0] - anchors[j].dst[0];
            const dy = anchors[i].dst[1] - anchors[j].dst[1];
            const dz = anchors[i].dst[2] - anchors[j].dst[2];
            const sl = Math.hypot(sx, sy, sz);
            const dl = Math.hypot(dx, dy, dz);
            if (sl > 1e-9 && dl > 1e-9) ratios.push(dl / sl);
        }
    }
    if (ratios.length === 0) return 1;
    ratios.sort((a, b) => a - b);
    return ratios[Math.floor(ratios.length / 2)];
}

/** 提取变换旋转角（度）。 */
function rotationAngleDeg(T: Mat4): number {
    const { R } = decomposeSimilarity(T);
    const r = R.data;
    const trace = r[0] + r[5] + r[10];
    const ang = Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2)));
    return (ang * 180) / Math.PI;
}

/**
 * 相似识别：以 seedT（标记点 Kabsch 粗配准）为种子，生成扰动多候选，
 * 每个候选跑颜色+几何 ICP（Umeyama 相似变换），综合评分（几何/平面/颜色/法线/覆盖）
 * 选最优，返回 src → dst 的总相似变换（含缩放）。
 */
export async function similarityRecognize(
    src: MergeModel,
    dst: MergeModel,
    seedT: Mat4 | null,
    opts: SimilarityOptions = {},
    onProgress?: (stage: string, pct: number) => void
): Promise<SimilarityResult> {
    const sample = opts.sample ?? 12000;
    const { pts: srcPts, colors: srcColors } = sampleModelData(src, sample);
    const { pts: dstPts, colors: dstColors } = sampleModelData(dst, sample);
    const n1 = srcPts.length / 3, n2 = dstPts.length / 3;
    if (n1 < 50 || n2 < 50) throw new Error('模型采样点数过少，无法识别');

    const diag = Math.sqrt(
        (dst.worldBound.halfExtents.x * 2) ** 2 +
        (dst.worldBound.halfExtents.y * 2) ** 2 +
        (dst.worldBound.halfExtents.z * 2) ** 2
    );
    const colorScale = Math.max(diag * (opts.colorScaleFrac ?? 0.02), 1e-6);
    const cell = Math.max(diag / 128, 1e-4);
    const grid = new HashGrid(dstPts, n2, cell);
    onProgress?.('估计法线…', 4);
    await yieldFrame();
    const dstNormals = estimateNormals(dstPts, n2, grid);
    const srcNormals = estimateNormals(srcPts, n1, new HashGrid(srcPts, n1, cell));
    await yieldFrame();

    const weights = { g: 1.0, p: 1.2, c: opts.weightColor ?? 0.8, n: 0.6, cov: 0.5, m: 1.5 };
    const anchors = opts.anchorPairs;
    const anchorWeight = opts.anchorWeight ?? 6;
    // 缩放先验：由标记锚点距离比估计（尺度差异大的模型若从纯刚体候选起步，
    // ICP 内点阈值会剔除全部对应导致无法启动）
    const scalePrior = anchorScalePrior(anchors);
    // 标记先验基准变换（无 seedT 时）：缩放绕 src 锚点质心（s0）+ 平移到 dst 锚点质心，
    // 使第一个候选就处于标记对齐附近；扰动候选围绕该基准微调
    let candBase = new Mat4().setIdentity();
    if (!seedT && anchors && anchors.length >= 3) {
        const c = [0, 0, 0], d = [0, 0, 0];
        for (const a of anchors) {
            c[0] += a.src[0]; c[1] += a.src[1]; c[2] += a.src[2];
            d[0] += a.dst[0]; d[1] += a.dst[1]; d[2] += a.dst[2];
        }
        c[0] /= anchors.length; c[1] /= anchors.length; c[2] /= anchors.length;
        d[0] /= anchors.length; d[1] /= anchors.length; d[2] /= anchors.length;
        const T1 = new Mat4().set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -c[0], -c[1], -c[2], 1]);
        const S = new Mat4().set([scalePrior, 0, 0, 0, 0, scalePrior, 0, 0, 0, 0, scalePrior, 0, 0, 0, 0, 1]);
        const T2 = new Mat4().set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, d[0], d[1], d[2], 1]);
        candBase = T2.clone().mul(S).mul(T1);
    }
    const angDeg = opts.perturbAngleDeg ?? 6;
    const frac = opts.perturbScaleFrac ?? 0.04;
    const seeds = Math.max(1, opts.seeds ?? 8);
    const cands: Mat4[] = [];
    if (seedT) {
        // 显式种子（自动对齐/外部调用）：扰动围绕种子
        cands.push(seedT.clone());
        for (let i = 0; i < seeds; i++) cands.push(perturbTransform(seedT, angDeg, frac, diag, i, 1));
    } else {
        // 标记对齐：候选基准 = 标记先验（缩放+平移），扰动围绕它微调
        cands.push(candBase.clone());
        for (let i = 0; i < seeds; i++) cands.push(perturbTransform(candBase, angDeg, frac * 0.5, diag, i, 1));
    }

    let best: SimilarityResult | null = null;
    for (let ci = 0; ci < cands.length; ci++) {
        onProgress?.('相似识别…', 10 + (ci / cands.length) * 60);
        await yieldFrame();
        const srcInit = applyTransformCopy(srcPts, cands[ci]);
        // 锚点源随候选变换到同一坐标系（srcInit = cands·srcPts）
        let candAnchors: { src: number[]; dst: number[] }[] | undefined;
        if (anchors) {
            candAnchors = anchors.map((a) => {
                const p = new Vec3(a.src[0], a.src[1], a.src[2]);
                cands[ci].transformPoint(p, p);
                return { src: [p.x, p.y, p.z], dst: [a.dst[0], a.dst[1], a.dst[2]] };
            });
        }
        const { T, iters } = colorWeightedIcp(srcInit, srcColors, dstPts, dstColors, grid, diag, colorScale, opts.maxIter ?? 30, candAnchors, anchorWeight);
        const totalT = T.clone().mul(cands[ci]);
        const e = evaluateAlignment(srcPts, srcColors, srcNormals, dstPts, dstColors, dstNormals, grid, diag, colorScale, totalT, weights, anchors);
        if (!best || e.score < best.score) {
            best = {
                T: totalT,
                s: e.s,
                rotAngleDeg: rotationAngleDeg(totalT),
                score: e.score,
                geomError: e.geomError,
                planeError: e.planeError,
                colorError: e.colorError,
                normalScore: e.normalScore,
                coverage: e.coverage,
                markerError: e.markerError,
                iters
            };
        }
    }
    onProgress?.('评分完成', 97);
    await yieldFrame();
    if (!best || !Number.isFinite(best.score)) throw new Error('相似识别失败：未找到有效对齐');
    return best;
}
