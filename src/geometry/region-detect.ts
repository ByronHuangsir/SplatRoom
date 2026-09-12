import { Vec3 } from 'playcanvas';

import { fitPlane, Plane } from './plane-fit';
import { Splat } from '../splat/splat';
import { State } from '../splat/splat-state';

/**
 * L1 — 自动区域识别（地面/水域/大平面）
 *
 * 在 planar-fix（盒内手动）与 surface-refiner（局部细化）之外，提供
 * **全局自动检测**：从高斯中心点云用 RANSAC 拟合最大平面（通常即地面或
 * 大面积墙面），并把识别出的平面高斯按连通性聚类，供后续平整 / 补漏 /
 * 水域识别复用。
 *
 * 全部在 splat-local 空间计算（与 GSplatData x/y/z 列一致）。
 */

export interface RegionDetectionResult {
    /** RANSAC 拟合出的最大平面。 */
    plane: Plane;
    /** 属于该平面的高斯索引（splat-local 空间）。 */
    inliers: Uint32Array;
    /** 内点坐标的 u/v 投影范围（沿平面 u/v 轴的极值，用于构造 session）。 */
    bounds: { minU: number; maxU: number; minV: number; maxV: number };
    /** 拟合残差（平均绝对距离），越小平面越"平"。 */
    meanResidual: number;
    /** 内点数 / 参与采样总数。 */
    inlierRatio: number;
    /** 连通聚类：每组为 inliers 的一个子集（如地面 vs 墙面）。 */
    clusters: Uint32Array[];
}

/** 读 splat 中心（跳过 deleted），返回数组 + 原始索引。 */
function collectCenters(splat: Splat): { xs: Float32Array; ys: Float32Array; zs: Float32Array; indices: number[]; count: number } {
    const sd = splat.splatData;
    const xs = sd.getProp('x') as Float32Array;
    const ys = sd.getProp('y') as Float32Array;
    const zs = sd.getProp('z') as Float32Array;
    const state = sd.getProp('state') as Uint8Array;
    const n = sd.numSplats;

    const indices: number[] = [];
    for (let i = 0; i < n; i++) {
        if (state && (state[i] & State.deleted) !== 0) continue;
        indices.push(i);
    }
    return { xs, ys, zs, indices, count: indices.length };
}

/**
 * 全局平面检测：**法线引导的整体分类**（替代任意方向 RANSAC）。
 *
 * 模型可能未与 XZ 平面对齐（Y 轴方向有差异），因此不硬编码"地面朝上"，
 * 而是从模型自身几何自适应：
 *   1. KNN 邻域 PCA 估计每个采样点的法线
 *   2. 法线方向聚类（球面分桶，± 符号合并）→ 取最密集方向簇 = 主导平面法线
 *   3. 沿该法线做高度直方图 → 主密度连续层 = 地面/最大平面层
 *   4. 在该层内用小容差 RANSAC 精化 → 精确平面 + 内点
 *
 * 这样墙面（法线水平）、曲面（法线分散）自动排除；模型整体旋转也能正确
 * 识别（法线方向自适应，不依赖 +Y）。
 *
 * 性能：法线估计在降采样子集（≤ sampleCap）上进行；全量内点收集分块 yield。
 *
 * @param splat - 目标 splat
 * @param options - 参数
 * @returns Promise<RegionDetectionResult | null>
 */
export async function detectDominantPlane(
    splat: Splat,
    options?: { iterations?: number; distanceTol?: number; minInliers?: number; seed?: number; sampleCap?: number; onProgress?: (f: number) => void }
): Promise<RegionDetectionResult | null> {
    const {
        iterations = 200,
        distanceTol,
        minInliers = 1000,
        seed = 12345,
        sampleCap = 50000,
        onProgress
    } = options ?? {};
    const { xs, ys, zs, indices, count } = collectCenters(splat);
    if (count < 100) return null;

    // 包围盒对角线（用于尺度估算）
    let diag = 0;
    {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (let k = 0; k < count; k++) {
            const i = indices[k];
            if (xs[i] < minX) minX = xs[i];
            if (xs[i] > maxX) maxX = xs[i];
            if (ys[i] < minY) minY = ys[i];
            if (ys[i] > maxY) maxY = ys[i];
            if (zs[i] < minZ) minZ = zs[i];
            if (zs[i] > maxZ) maxZ = zs[i];
        }
        const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
        diag = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    const tol = distanceTol ?? Math.max(diag * 0.01, 1e-3);

    // ---- 降采样：法线估计在子集上进行 ----
    const useCount = Math.min(count, sampleCap);
    const sampleIdx = new Int32Array(useCount);
    if (useCount === count) {
        for (let k = 0; k < useCount; k++) sampleIdx[k] = k;
    } else {
        for (let k = 0; k < useCount; k++) {
            sampleIdx[k] = Math.floor(k * count / useCount);
        }
    }

    // ---- 1. 邻域法线估计（KNN PCA，空间哈希加速）----
    onProgress?.(0.05);
    // 网格尺寸：按点云平均间距自适应（采样 512 点最近邻估算）
    let avgGap = 0;
    {
        const sample = Math.min(512, useCount);
        for (let k = 0; k < sample; k++) {
            const i = indices[sampleIdx[k]];
            let best2 = Infinity;
            for (let j = 0; j < sample; j++) {
                if (j === k) continue;
                const jj = indices[sampleIdx[j]];
                const dx = xs[i] - xs[jj], dy = ys[i] - ys[jj], dz = zs[i] - zs[jj];
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 < best2) best2 = d2;
            }
            if (best2 < Infinity) avgGap += Math.sqrt(best2);
        }
        avgGap /= sample;
    }
    const cell = Math.max(avgGap * 2.5, 1e-4);
    const grid = new Map<string, number[]>();
    const keyOf = (i: number) => {
        const cx = Math.floor(xs[i] / cell);
        const cy = Math.floor(ys[i] / cell);
        const cz = Math.floor(zs[i] / cell);
        return `${cx},${cy},${cz}`;
    };
    for (let k = 0; k < useCount; k++) {
        const i = indices[sampleIdx[k]];
        const kk = keyOf(i);
        let arr = grid.get(kk);
        if (!arr) {
            arr = []; grid.set(kk, arr);
        }
        arr.push(k);
    }

    // 每个采样点法线（存 index 为 indices[sampleIdx[k]] 的实际索引）
    const normals = new Float32Array(useCount * 3);
    const NB_CHUNK = 4096;
    for (let start = 0; start < useCount; start += NB_CHUNK) {
        const end = Math.min(useCount, start + NB_CHUNK);
        for (let k = start; k < end; k++) {
            const i = indices[sampleIdx[k]];
            const cx = Math.floor(xs[i] / cell), cy = Math.floor(ys[i] / cell), cz = Math.floor(zs[i] / cell);
            const nb: number[] = [];
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dz = -1; dz <= 1; dz++) {
                        const arr = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
                        if (arr) for (const j of arr) nb.push(j);
                    }
                }
            }
            if (nb.length < 6) continue;
            // PCA 协方差
            let mx = 0, my = 0, mz = 0;
            for (const j of nb) {
                const ji = indices[sampleIdx[j]];
                mx += xs[ji]; my += ys[ji]; mz += zs[ji];
            }
            mx /= nb.length; my /= nb.length; mz /= nb.length;
            let c00 = 0, c01 = 0, c02 = 0, c11 = 0, c12 = 0, c22 = 0;
            for (const j of nb) {
                const ji = indices[sampleIdx[j]];
                const dx = xs[ji] - mx, dy = ys[ji] - my, dz = zs[ji] - mz;
                c00 += dx * dx; c01 += dx * dy; c02 += dx * dz;
                c11 += dy * dy; c12 += dy * dz;
                c22 += dz * dz;
            }
            const n = pcMinEigen([[c00, c01, c02], [c01, c11, c12], [c02, c12, c22]]);
            normals[k * 3] = n[0]; normals[k * 3 + 1] = n[1]; normals[k * 3 + 2] = n[2];
        }
        if (end < useCount) {
            await new Promise<void>((resolve) => {
                setTimeout(resolve, 0);
            });
            onProgress?.(0.05 + 0.35 * (end / useCount));
        }
    }
    onProgress?.(0.4);
    await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
    });

    // ---- 2. 法线方向聚类（球面分桶，± 合并）----
    // 桶：theta(仰角) 8 档 × phi(方位) 12 档，法线取上半球（符号对齐到首个非零法线）
    const THETA = 8, PHI = 12;
    const bucket = new Map<string, number[]>();
    // 参考方向：取所有法线的平均（粗略朝外），符号统一
    let rx = 0, ry = 0, rz = 0, rn = 0;
    for (let k = 0; k < useCount; k++) {
        const n0 = normals[k * 3], n1 = normals[k * 3 + 1], n2 = normals[k * 3 + 2];
        const len = Math.hypot(n0, n1, n2);
        if (len < 1e-9) continue;
        rx += n0 / len; ry += n1 / len; rz += n2 / len; rn++;
    }
    if (rn === 0) return null;
    const rlen = Math.hypot(rx, ry, rz) || 1;
    rx /= rlen; ry /= rlen; rz /= rlen;

    for (let k = 0; k < useCount; k++) {
        let n0 = normals[k * 3], n1 = normals[k * 3 + 1], n2 = normals[k * 3 + 2];
        const len = Math.hypot(n0, n1, n2);
        if (len < 1e-9) continue;
        n0 /= len; n1 /= len; n2 /= len;
        // 符号统一到参考方向
        if (n0 * rx + n1 * ry + n2 * rz < 0) {
            n0 = -n0; n1 = -n1; n2 = -n2;
        }
        // 球面坐标
        const theta = Math.floor(Math.acos(Math.min(1, Math.max(-1, n1))) / Math.PI * THETA) % THETA;
        let phi = Math.floor(Math.atan2(n0, n2) / Math.PI * PHI);
        if (phi < 0) phi += PHI;
        const bk = `${theta},${phi}`;
        let arr = bucket.get(bk);
        if (!arr) {
            arr = []; bucket.set(bk, arr);
        }
        arr.push(k);
    }
    // 找最密集桶（主导法线方向）
    let bestBucket: string | null = null;
    let bestCount = 0;
    for (const [bk, arr] of bucket) {
        if (arr.length > bestCount) {
            bestCount = arr.length; bestBucket = bk;
        }
    }
    if (!bestBucket || bestCount < Math.max(20, useCount * 0.02)) return null;
    onProgress?.(0.5);

    // 主导法线 = 该桶法线平均（符号统一后）
    const bkArr = bucket.get(bestBucket);
    let nx = 0, ny = 0, nz = 0;
    for (const k of bkArr) {
        nx += normals[k * 3]; ny += normals[k * 3 + 1]; nz += normals[k * 3 + 2];
    }
    const blen = Math.hypot(nx, ny, nz) || 1;
    nx /= blen; ny /= blen; nz /= blen;
    // 确保法线朝上（Y>0 优先；模型旋转时也无妨——只是定义"地面"的方向）
    if (ny < 0) {
        nx = -nx; ny = -ny; nz = -nz;
    }

    // ---- 3. 沿主导法线高度分层 ----
    // 把（子集）点投影到法线轴，做直方图，找主密度连续层
    const proj: { idx: number; t: number }[] = [];
    for (let k = 0; k < useCount; k++) {
        const i = indices[sampleIdx[k]];
        const t = xs[i] * nx + ys[i] * ny + zs[i] * nz;
        proj.push({ idx: i, t });
    }
    proj.sort((a, b) => a.t - b.t);
    const pMin = proj[0].t, pMax = proj[proj.length - 1].t;
    const LAYERS = 48;
    const layerW = (pMax - pMin) / LAYERS || 1;
    const layerCount = new Array(LAYERS).fill(0);
    for (const p of proj) {
        const b = Math.min(LAYERS - 1, Math.max(0, Math.floor((p.t - pMin) / layerW)));
        layerCount[b]++;
    }
    // 找密度最高的层（宽度加权：取连续高密度段）
    let bestLayer = 0;
    for (let b = 0; b < LAYERS; b++) {
        if (layerCount[b] > layerCount[bestLayer]) bestLayer = b;
    }
    // 层厚：以该层为中心扩展（±2 层），作为初始内点带
    const layerHalf = Math.max(2, Math.ceil(useCount * 0.004 / Math.max(1, layerCount[bestLayer])));
    const tLow = pMin + Math.max(0, bestLayer - layerHalf) * layerW;
    const tHigh = pMin + Math.min(LAYERS, bestLayer + layerHalf + 1) * layerW;
    onProgress?.(0.6);
    await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
    });

    // ---- 4. 层内精化 RANSAC（小容差）----
    // 用主导法线方向 + 层内点的 t 中值构造初始平面，再做少量 RANSAC 精化
    const layerPts: number[] = [];
    for (const p of proj) {
        if (p.t >= tLow && p.t <= tHigh) layerPts.push(p.idx);
    }
    if (layerPts.length < 20) return null;

    // 初始平面：法线 = 主导法线，过层内点质心
    let cx2 = 0, cy2 = 0, cz2 = 0;
    for (const i of layerPts) {
        cx2 += xs[i]; cy2 += ys[i]; cz2 += zs[i];
    }
    cx2 /= layerPts.length; cy2 /= layerPts.length; cz2 /= layerPts.length;
    const origin = new Vec3(cx2, cy2, cz2);
    let plane: Plane;
    try {
        plane = fitPlaneFromNormal(origin, new Vec3(nx, ny, nz));
    } catch {
        return null;
    }

    // 精化 RANSAC：在层内随机 3 点拟合，取残差最小的
    let rng = seed;
    const rand = () => {
        rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5;
        return (rng >>> 0) / 4294967296;
    };
    const pts: Vec3[] = [new Vec3(), new Vec3(), new Vec3()];
    const layerTol = Math.max(tol * 0.5, (tHigh - tLow) * 0.35);
    let bestPlane: Plane = plane;
    let bestRes = Infinity;
    const refineIters = Math.min(iterations, 60);
    for (let iter = 0; iter < refineIters; iter++) {
        const a = layerPts[Math.floor(rand() * layerPts.length)];
        const b = layerPts[Math.floor(rand() * layerPts.length)];
        const c = layerPts[Math.floor(rand() * layerPts.length)];
        if (a === b || b === c || a === c) continue;
        pts[0].set(xs[a], ys[a], zs[a]);
        pts[1].set(xs[b], ys[b], zs[b]);
        pts[2].set(xs[c], ys[c], zs[c]);
        let cand: Plane;
        try {
            cand = fitPlane(pts);
        } catch {
            continue;
        }
        // 仅接受与主导法线接近的候选（|dot| > 0.5），避免漂移到其他方向
        const cd = Math.abs(cand.normal.x * nx + cand.normal.y * ny + cand.normal.z * nz);
        if (cd < 0.5) continue;
        // 残差：层内点到平面平均距离
        let resSum = 0, cnt = 0;
        const cn = cand.normal;
        const cd2 = cand.origin.x * cn.x + cand.origin.y * cn.y + cand.origin.z * cn.z;
        for (const i of layerPts) {
            const d = Math.abs(xs[i] * cn.x + ys[i] * cn.y + zs[i] * cn.z - cd2);
            if (d <= layerTol) {
                resSum += d; cnt++;
            }
        }
        if (cnt > 0) {
            const res = resSum / cnt;
            if (res < bestRes) {
                bestRes = res; bestPlane = cand;
            }
        }
    }
    plane = bestPlane;
    onProgress?.(0.75);
    await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
    });

    // ---- 全量内点收集（分块 + yield）----
    const allInliers: number[] = [];
    let resSumFull = 0;
    const CHUNK = 20000;
    const n = plane.normal;
    const d = plane.origin.x * n.x + plane.origin.y * n.y + plane.origin.z * n.z;
    // 内点容差：用层厚（更贴合真实地面起伏）而非全局 diag*1%
    const inlierTol = Math.max(layerTol, (tHigh - tLow) * 0.5);
    for (let start = 0; start < count; start += CHUNK) {
        const end = Math.min(count, start + CHUNK);
        for (let k = start; k < end; k++) {
            const i = indices[k];
            const dist = Math.abs(xs[i] * n.x + ys[i] * n.y + zs[i] * n.z - d);
            if (dist <= inlierTol) {
                allInliers.push(i);
                resSumFull += dist;
            }
        }
        if (end < count) {
            await new Promise<void>((resolve) => {
                setTimeout(resolve, 0);
            });
            onProgress?.(0.75 + 0.15 * (end / count));
        }
    }

    // ---- 内点 u/v 投影范围 ----
    onProgress?.(0.92);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    const { origin: o2, u, v } = plane;
    for (let start = 0; start < allInliers.length; start += CHUNK) {
        const end = Math.min(allInliers.length, start + CHUNK);
        for (let k = start; k < end; k++) {
            const i = allInliers[k];
            const dx = xs[i] - o2.x;
            const dy = ys[i] - o2.y;
            const dz = zs[i] - o2.z;
            const pu = dx * u.x + dy * u.y + dz * u.z;
            const pv = dx * v.x + dy * v.y + dz * v.z;
            if (pu < minU) minU = pu;
            if (pu > maxU) maxU = pu;
            if (pv < minV) minV = pv;
            if (pv > maxV) maxV = pv;
        }
        if (end < allInliers.length) {
            await new Promise<void>((resolve) => {
                setTimeout(resolve, 0);
            });
        }
    }

    // ---- 连通聚类 ----
    onProgress?.(0.97);
    const clusters = clusterInliers(allInliers, xs, ys, zs);

    // ---- 簇法线过滤：剔除法线与主导方向不一致的簇（墙面/斜面）----
    // 地面与墙面在几何上相连（墙脚），连通聚类无法分离；但法线方向不同
    // （地面沿主导法线、墙面垂直）。对每个簇采样估法线，保留法线与主导
    // 方向一致占比高的簇。
    // 注意：此处用全量点坐标重建独立网格（cluster 内是全量高斯索引）。
    const keptClusters: Uint32Array[] = [];
    const keptAll: number[] = [];
    const fullGrid = new Map<string, number[]>();
    const fullKey = (i: number) => {
        const cx = Math.floor(xs[i] / cell);
        const cy = Math.floor(ys[i] / cell);
        const cz = Math.floor(zs[i] / cell);
        return `${cx},${cy},${cz}`;
    };
    for (const i of allInliers) {
        const kk = fullKey(i);
        let arr = fullGrid.get(kk);
        if (!arr) {
            arr = []; fullGrid.set(kk, arr);
        }
        arr.push(i);
    }
    const NORM_SAMPLE = 200;
    for (const cluster of clusters) {
        if (cluster.length === 0) continue;
        // 簇内采样估法线（KNN PCA，用 fullGrid）
        const step = Math.max(1, Math.floor(cluster.length / NORM_SAMPLE));
        let alignCount = 0, totalCount = 0;
        for (let k = 0; k < cluster.length; k += step) {
            const i = cluster[k];
            const cx = Math.floor(xs[i] / cell), cy = Math.floor(ys[i] / cell), cz = Math.floor(zs[i] / cell);
            const nb: number[] = [];
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dz = -1; dz <= 1; dz++) {
                        const arr = fullGrid.get(`${cx + dx},${cy + dy},${cz + dz}`);
                        if (arr) for (const j of arr) nb.push(j);
                    }
                }
            }
            if (nb.length < 6) continue;
            let mx = 0, my = 0, mz = 0;
            for (const j of nb) {
                mx += xs[j]; my += ys[j]; mz += zs[j];
            }
            mx /= nb.length; my /= nb.length; mz /= nb.length;
            let c00 = 0, c01 = 0, c02 = 0, c11 = 0, c12 = 0, c22 = 0;
            for (const j of nb) {
                const dx = xs[j] - mx, dy = ys[j] - my, dz = zs[j] - mz;
                c00 += dx * dx; c01 += dx * dy; c02 += dx * dz;
                c11 += dy * dy; c12 += dy * dz;
                c22 += dz * dz;
            }
            const cn = pcMinEigen([[c00, c01, c02], [c01, c11, c12], [c02, c12, c22]]);
            const cl = Math.hypot(cn[0], cn[1], cn[2]) || 1;
            const align = Math.abs(cn[0] * nx + cn[1] * ny + cn[2] * nz) / cl;
            totalCount++;
            if (align > 0.6) alignCount++;
        }
        // 保留法线一致占比 ≥ 70% 的簇；最大簇始终保留（防极端采样偏差）
        const isMain = clusters[0] && cluster === clusters[0];
        if (totalCount === 0 || alignCount / totalCount >= 0.7 || isMain) {
            keptClusters.push(cluster);
            for (const i of cluster) keptAll.push(i);
        }
    }
    const finalInliers = keptAll.length > 0 ? keptAll : allInliers;
    onProgress?.(1);

    return {
        plane,
        inliers: new Uint32Array(finalInliers),
        bounds: { minU, maxU, minV, maxV },
        meanResidual: finalInliers.length > 0 ? resSumFull / finalInliers.length : 0,
        inlierRatio: finalInliers.length / count,
        clusters: keptClusters
    };
}

/** 从法线与原点构造平面（u/v 基由法线生成）。 */
function fitPlaneFromNormal(origin: Vec3, normal: Vec3): Plane {
    const n = normal.clone().normalize();
    const ref = Math.abs(n.y) < 0.99 ? new Vec3(0, 1, 0) : new Vec3(1, 0, 0);
    const u = new Vec3().cross(ref, n).normalize();
    const v = new Vec3().cross(n, u).normalize();
    return { origin, normal: n, u, v };
}

/**
 * 3x3 对称阵最小特征值对应特征向量（雅可比迭代）。
 * 返回未归一化向量。
 */
function pcMinEigen(m: [number, number, number][]): [number, number, number] {
    const a = m.map(r => [...r]);
    const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let iter = 0; iter < 50; iter++) {
        let p = 0, q = 1, maxOff = 0;
        for (let i = 0; i < 3; i++) {
            for (let j = i + 1; j < 3; j++) {
                if (Math.abs(a[i][j]) > maxOff) {
                    maxOff = Math.abs(a[i][j]); p = i; q = j;
                }
            }
        }
        if (maxOff < 1e-12) break;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 3; k++) {
            const akp = a[k][p], akq = a[k][q];
            a[k][p] = c * akp - s * akq;
            a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
            const apk = a[p][k], aqk = a[q][k];
            a[p][k] = c * apk - s * aqk;
            a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
            const vkp = v[k][p], vkq = v[k][q];
            v[k][p] = c * vkp - s * vkq;
            v[k][q] = s * vkp + c * vkq;
        }
    }
    const evals = [a[0][0], a[1][1], a[2][2]];
    const minIdx = evals.indexOf(Math.min(...evals));
    return [v[0][minIdx], v[1][minIdx], v[2][minIdx]];
}

/** 按 R 邻域把平面内点分成连通簇。R 取点云平均间距的 ~2.5 倍。 */
function clusterInliers(inliers: number[], xs: Float32Array, ys: Float32Array, zs: Float32Array): Uint32Array[] {
    const n = inliers.length;
    if (n === 0) return [];

    // 估算平均间距（采样 512 点的最近邻均值）
    let avgGap = 0;
    const sample = Math.min(512, n);
    for (let k = 0; k < sample; k++) {
        const i = inliers[k];
        let best2 = Infinity;
        for (let j = 0; j < sample; j++) {
            if (j === k) continue;
            const jj = inliers[j];
            const dx = xs[i] - xs[jj], dy = ys[i] - ys[jj], dz = zs[i] - zs[jj];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < best2) best2 = d2;
        }
        if (best2 < Infinity) avgGap += Math.sqrt(best2);
    }
    avgGap /= sample;
    const R = Math.max(avgGap * 2.5, 1e-4);

    // 空间网格 + 并查集
    const cell = Math.max(R, 1e-6);
    const grid = new Map<string, number[]>();
    const keyOf = (i: number) => {
        const cx = Math.floor(xs[i] / cell);
        const cy = Math.floor(ys[i] / cell);
        const cz = Math.floor(zs[i] / cell);
        return `${cx},${cy},${cz}`;
    };
    for (let k = 0; k < n; k++) {
        const kk = keyOf(inliers[k]);
        let arr = grid.get(kk);
        if (!arr) {
            arr = [];
            grid.set(kk, arr);
        }
        arr.push(k);
    }

    const parent = new Int32Array(n);
    for (let k = 0; k < n; k++) parent[k] = k;
    const find = (x: number): number => {
        while (parent[x] !== x) {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        return x;
    };
    const union = (a: number, b: number) => {
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent[ra] = rb;
    };

    const range = Math.ceil(R / cell);
    for (let k = 0; k < n; k++) {
        const i = inliers[k];
        const cx = Math.floor(xs[i] / cell);
        const cy = Math.floor(ys[i] / cell);
        const cz = Math.floor(zs[i] / cell);
        for (let dx = -range; dx <= range; dx++) {
            for (let dy = -range; dy <= range; dy++) {
                for (let dz = -range; dz <= range; dz++) {
                    const arr = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
                    if (!arr) continue;
                    for (const j of arr) {
                        if (j === k) continue;
                        const jj = inliers[j];
                        const ddx = xs[i] - xs[jj], ddy = ys[i] - ys[jj], ddz = zs[i] - zs[jj];
                        if (ddx * ddx + ddy * ddy + ddz * ddz <= R * R) union(k, j);
                    }
                }
            }
        }
    }

    // 收集簇
    const groups = new Map<number, number[]>();
    for (let k = 0; k < n; k++) {
        const r = find(k);
        let arr = groups.get(r);
        if (!arr) {
            arr = [];
            groups.set(r, arr);
        }
        arr.push(inliers[k]);
    }
    // 按大小降序
    const sorted = [...groups.values()].sort((a, b) => b.length - a.length);
    return sorted.map(g => new Uint32Array(g));
}
