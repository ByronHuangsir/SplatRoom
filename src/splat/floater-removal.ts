import { Splat } from './splat';
import { State } from './splat-state';

/**
 * 去浮云检测 —— 单灵敏度驱动，判定核心是"这个高斯周围有多空"。
 *
 * 旧版是四条独立策略的**或**：透明度低于阈值、体积大于均值+kσ、27 格邻居数偏少、离质心过远。
 * 问题在于前三条各自的阈值都是"分布尾部"：贴着物体表面的高斯本来就常常又大又透明（软边、雾面、
 * 地面片），于是被"大"和"透明"两条直接命中 —— 实测一个 40 点的表面贴片（低透明度 + 大体积）在默认
 * 灵敏度下被**全部**选中，而真正的飘团反而只被"离质心过远"一条抓到。也就是说旧版选的不是"飘在空中的"，
 * 而是"长得异常的"。
 *
 * 现在改为**几何判定优先**：
 *
 *   1. 主判据（隔离）：看这个高斯**紧邻的一小圈格子里还有没有别人** —— 格子边长 ≈ 典型点间距的
 *      1.2 倍，检查 3×3×3 格。飘在空中的孤立点周围是空的；而贴着表面的点，哪怕它又大又透明，
 *      紧邻格子里也挤着一堆表面点，天然不会被误选。这里刻意**不**做"邻居数少于全局中位数"这类比较：
 *      点云外缘、薄片边缘本身邻居就少，那样比较会把边界当成浮云（实测在一个干净模型上误报 62 个）。
 *   2. 次判据（三者同时成立，保守）：又透明 **且** 体积异常 **且** 远离点云稳健中心。
 *      用来兜住"一团浓密但确实飘在很远处的雾状高斯" —— 单看邻居数是不会判它孤立的。
 *
 * 分工：这里只负责**零散的飘点**；成团的飘云（团内彼此相邻、整团远离主体）请用面板下方的**连通簇**
 * —— 它按体素连通性整团识别（合成模型上 3 团共 77 点可被完整选中）。
 *
 * 灵敏度仍然只有一个滑条：升高会同时放宽"紧邻格子允许几个邻居"和次判据的三条阈值。
 * maxPoints：预览传 8000（抽样加速），应用传 Infinity（全量精确掩码）。
 */

export interface FloaterResult {
    mask: Uint8Array;               // 255 = floater, 0 = normal
    count: number;
    details: {
        opacity: number;    // 命中里同时满足"透明"的点数
        volume: number;     // 命中里同时满足"体积异常"的点数
        isolation: number;  // 由隔离判据（主判据）命中的点数
        distance: number;   // 命中里同时满足"远离中心"的点数
    };
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** 点云中位半径 × 0.3（与对比工具一致）：估计典型点间距，供隔离网格 / 连通簇体素自适应。 */
export function estimateCellSize(x: Float32Array, y: Float32Array, z: Float32Array, n: number): number {
    let cx = 0, cy = 0, cz = 0;
    const sample = Math.min(n, 2000);
    const step = Math.max(1, Math.floor(n / sample));
    for (let i = 0; i < sample; i++) {
        const idx = i * step;
        cx += x[idx]; cy += y[idx]; cz += z[idx];
    }
    cx /= sample; cy /= sample; cz /= sample;
    const dists = new Float32Array(sample);
    for (let i = 0; i < sample; i++) {
        const idx = i * step;
        const dx = x[idx] - cx, dy = y[idx] - cy, dz = z[idx] - cz;
        dists[i] = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    dists.sort();
    return dists[Math.floor(sample / 2)] * 0.3 || 1;
}

// Voxel keys are packed into one float64 for Map lookups: 17 bits per axis keeps the value at
// 51 bits, which a double holds exactly (21 bits would need 63 and silently lose precision).
const KEY_BITS = 17;
const KEY_STRIDE = 1 << KEY_BITS;
const KEY_LIMIT = KEY_STRIDE - 1;
const packKey = (ix: number, iy: number, iz: number) => (ix * KEY_STRIDE + iy) * KEY_STRIDE + iz;

/**
 * 检测浮云。sensitivity 0-100；maxPoints=Infinity 时全量精确检测（应用删除用），
 * 否则采样检测（预览用，速度更快）。
 */
export function detectFloaters(splat: Splat, sensitivity: number, maxPoints = 8000): FloaterResult {
    const splatData = splat.splatData;
    const numSplats = splatData.numSplats;
    const state = splatData.getProp('state') as Uint8Array;
    const x = splatData.getProp('x') as Float32Array;
    const y = splatData.getProp('y') as Float32Array;
    const z = splatData.getProp('z') as Float32Array;
    const opacity = splatData.getProp('opacity') as Float32Array;
    const scale0 = splatData.getProp('scale_0') as Float32Array;
    const scale1 = splatData.getProp('scale_1') as Float32Array;
    const scale2 = splatData.getProp('scale_2') as Float32Array;

    const mask = new Uint8Array(numSplats);
    const details = { opacity: 0, volume: 0, isolation: 0, distance: 0 };
    const sens = Math.max(0, Math.min(100, sensitivity));
    const isValid = (i: number) => (state[i] & (State.deleted | State.locked)) === 0;

    const empty: FloaterResult = { mask, count: 0, details };
    if (!x || !y || !z || numSplats === 0) {
        return empty;
    }

    // 采样步长：预览采样 / 应用全量
    const step = Number.isFinite(maxPoints) ? Math.max(1, Math.floor(numSplats / Math.max(1, maxPoints))) : 1;

    const sampleIdx: number[] = [];
    for (let i = 0; i < numSplats; i += step) {
        if (isValid(i)) {
            sampleIdx.push(i);
        }
    }
    const sampleCount = sampleIdx.length;
    if (sampleCount === 0) {
        return empty;
    }

    // ---- 1) 典型点间距 + 采样点的包围盒（体素坐标相对下界，便于打包进位） ----
    let spacing = 1e-6;
    try {
        spacing = Math.max(estimateCellSize(x, y, z, numSplats), 1e-6);
    } catch (e) {
        spacing = 1e-6;
    }

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const i of sampleIdx) {
        if (x[i] < minX) minX = x[i];
        if (y[i] < minY) minY = y[i];
        if (z[i] < minZ) minZ = z[i];
        if (x[i] > maxX) maxX = x[i];
        if (y[i] > maxY) maxY = y[i];
        if (z[i] > maxZ) maxZ = z[i];
    }
    const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || spacing;
    const diag = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2) || 1;

    // ---- 2) 隔离判据：紧邻的 3×3×3 格子里还有几个别人 ----
    const cellSize = Math.max(spacing * 1.2, extent / KEY_LIMIT);
    const inv = 1 / cellSize;

    const grid = new Map<number, number>();
    const cellOf = new Int32Array(sampleCount * 3);
    for (let s = 0; s < sampleCount; s++) {
        const i = sampleIdx[s];
        const ix = Math.min(KEY_LIMIT, Math.max(0, Math.floor((x[i] - minX) * inv)));
        const iy = Math.min(KEY_LIMIT, Math.max(0, Math.floor((y[i] - minY) * inv)));
        const iz = Math.min(KEY_LIMIT, Math.max(0, Math.floor((z[i] - minZ) * inv)));
        cellOf[s * 3] = ix;
        cellOf[s * 3 + 1] = iy;
        cellOf[s * 3 + 2] = iz;
        const key = packKey(ix, iy, iz);
        grid.set(key, (grid.get(key) || 0) + 1);
    }

    // 灵敏度：0 → 紧邻一圈里只要还有别人就不算孤立（几乎只挑真正孤零零的点）；100 → 允许 8 个邻居
    const neighbourBudget = Math.round(sens * 0.08);

    // ---- 3) 次判据：又透明 且 体积异常 且 远离稳健中心（三者同时成立才算） ----
    const opacityThreshold = Math.max(0.05, 0.10 + sens * 0.0035);
    const volumeK = Math.max(1.2, 3.2 - sens * 0.02);
    const distanceFrac = Math.max(0.15, 0.55 - sens * 0.004);
    const distanceSq = (distanceFrac * diag) ** 2;

    // 稳健中心：逐轴中位数（少量远处飞点拖不动它）
    const sortedX = sampleIdx.map(i => x[i]).sort((a, b) => a - b);
    const sortedY = sampleIdx.map(i => y[i]).sort((a, b) => a - b);
    const sortedZ = sampleIdx.map(i => z[i]).sort((a, b) => a - b);
    const centreX = sortedX[sortedX.length >> 1];
    const centreY = sortedY[sortedY.length >> 1];
    const centreZ = sortedZ[sortedZ.length >> 1];

    const volumes = new Float32Array(sampleCount);
    let sumV = 0, sumSq = 0, countV = 0;
    for (let s = 0; s < sampleCount; s++) {
        const i = sampleIdx[s];
        if (scale0 && scale1 && scale2) {
            const v = Math.exp(scale0[i]) * Math.exp(scale1[i]) * Math.exp(scale2[i]);
            volumes[s] = v;
            sumV += v;
            sumSq += v * v;
            countV++;
        }
    }
    let volumeThreshold = Infinity;
    if (countV > 0) {
        const mean = sumV / countV;
        const std = Math.sqrt(Math.max(0, sumSq / countV - mean * mean));
        volumeThreshold = mean + volumeK * std;
    }

    // ---- 4) 合并 ----
    let count = 0;
    for (let s = 0; s < sampleCount; s++) {
        const i = sampleIdx[s];
        const ix = cellOf[s * 3];
        const iy = cellOf[s * 3 + 1];
        const iz = cellOf[s * 3 + 2];

        let neighbours = 0;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    neighbours += grid.get(packKey(ix + dx, iy + dy, iz + dz)) || 0;
                }
            }
        }
        neighbours--;   // 减自身

        const isolated = neighbours <= neighbourBudget;

        const dx = x[i] - centreX;
        const dy = y[i] - centreY;
        const dz = z[i] - centreZ;
        const far = dx * dx + dy * dy + dz * dz > distanceSq;
        const transparent = !!opacity && sigmoid(opacity[i]) < opacityThreshold;
        const big = volumes[s] > volumeThreshold;
        const secondary = transparent && big && far;

        if (isolated || secondary) {
            mask[i] = 255;
            count++;
            if (isolated) details.isolation++;
            if (transparent) details.opacity++;
            if (big) details.volume++;
            if (far) details.distance++;
        }
    }

    return { mask, count, details };
}
