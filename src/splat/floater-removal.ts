import { Splat } from './splat';
import { State } from './splat-state';

/**
 * 去浮云检测（简化版）—— 单灵敏度驱动四信号融合。
 *
 * 原实现暴露 5 个参数（透明度阈值 / 体积倍数 / 隔离半径 / 最少邻居 / 距离阈值），
 * 方向不明确、不适合新手。现改为单个「灵敏度」(0-100) 内部联动全部策略：
 *   - 透明度：α 低于阈值（大透明点）       sens 高 → 阈值高，删更多
 *   - 体积：  体积 > 均值 + k×标准差         sens 高 → k 小，删更多
 *   - 隔离：  27 邻域格邻居数 < 密度参考     sens 高 → 网格更细、判据更松
 *   - 距离：  距质心 > 场景对角线×比例        sens 高 → 比例小，删更多
 *
 * 灵敏度映射与对比工具的浮云分析一致（已调校）：
 *   sens=0 保守（仅最可疑）→ sens=100 激进（任何轻微异常都算）。
 *
 * maxPoints：预览传 8000（采样加速），应用传 Infinity（全量精确掩码）。
 */

export interface FloaterResult {
    mask: Uint8Array;               // 255 = floater, 0 = normal
    count: number;
    details: {
        opacity: number;    // 透明度策略检出数
        volume: number;     // 体积策略检出数
        isolation: number;  // 隔离策略检出数
        distance: number;   // 距离策略检出数
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

    // 采样步长：预览采样 / 应用全量
    const step = Number.isFinite(maxPoints) ? Math.max(1, Math.floor(numSplats / Math.max(1, maxPoints))) : 1;
    const N = Math.ceil(numSplats / step);
    const idxAt = (i: number) => Math.min(numSplats - 1, i * step);
    const flag = (idx: number) => {
        if (mask[idx] !== 255) mask[idx] = 255;
    };

    // ---- 策略 1：透明度（大透明点 = 噪声） ----
    // sens 0→0.48, 65→0.30, 100→0.12
    if (opacity) {
        const thr = Math.max(0.04, 0.48 - sens * 0.0034);
        for (let i = 0; i < N; i++) {
            const idx = idxAt(i);
            if (isValid(idx) && sigmoid(opacity[idx]) < thr) {
                flag(idx);
                details.opacity++;
            }
        }
    }

    // ---- 策略 2：体积（异常大的高斯） ----
    // sens 0→1.8σ, 65→0.85σ, 100→0.35σ
    if (scale0 && scale1 && scale2) {
        let sumV = 0, sumSq = 0, count = 0;
        const vols = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            const idx = idxAt(i);
            if (isValid(idx)) {
                const v = Math.exp(scale0[idx]) * Math.exp(scale1[idx]) * Math.exp(scale2[idx]);
                vols[i] = v;
                sumV += v;
                sumSq += v * v;
                count++;
            }
        }
        if (count > 0) {
            const mean = sumV / count;
            const variance = Math.max(0, sumSq / count - mean * mean);
            const std = Math.sqrt(variance);
            const k = Math.max(0.35, 1.8 - sens * 0.0145);
            const thr = mean + k * std;
            for (let i = 0; i < N; i++) {
                const idx = idxAt(i);
                if (isValid(idx) && vols[i] > thr) {
                    flag(idx);
                    details.volume++;
                }
            }
        }
    }

    // ---- 策略 3：空间隔离（密度自适应网格） ----
    // 不用固定邻居数：以「最密 20% 单元格的平均密度 × lowFrac」为参考
    if (x && y && z && N > 0) {
        const spacing = estimateCellSize(x, y, z, N);
        const cellSize = spacing * (5 - sens * 0.03);   // sens 0→5×, 65→3×, 100→2×
        const invCell = 1 / cellSize;
        const grid = new Map<string, number>();
        for (let i = 0; i < N; i++) {
            const idx = idxAt(i);
            if (!isValid(idx)) continue;
            const gx = Math.floor(x[idx] * invCell);
            const gy = Math.floor(y[idx] * invCell);
            const gz = Math.floor(z[idx] * invCell);
            const key = `${gx},${gy},${gz}`;
            grid.set(key, (grid.get(key) || 0) + 1);
        }
        const allCounts = Array.from(grid.values());
        allCounts.sort((a, b) => b - a);
        const denseCount = Math.max(1, Math.ceil(allCounts.length * 0.20));
        let denseSum = 0;
        for (let i = 0; i < denseCount; i++) denseSum += allCounts[i];
        const denseAvg = denseSum / denseCount;
        // sens 0→0.12（极严格），100→0.01（几乎所有空洞都算）
        const lowFrac = Math.max(0.01, 0.14 - sens * 0.0013);
        const minNeighbors = Math.max(1, Math.round(denseAvg * lowFrac));

        for (let i = 0; i < N; i++) {
            const idx = idxAt(i);
            if (!isValid(idx)) continue;
            const gx = Math.floor(x[idx] * invCell);
            const gy = Math.floor(y[idx] * invCell);
            const gz = Math.floor(z[idx] * invCell);
            let neighbors = 0;
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dz = -1; dz <= 1; dz++) {
                        neighbors += grid.get(`${gx + dx},${gy + dy},${gz + dz}`) || 0;
                    }
                }
            }
            neighbors--;   // 减自身
            if (neighbors < minNeighbors) {
                flag(idx);
                details.isolation++;
            }
        }
    }

    // ---- 策略 4：距质心过远 ----
    // sens 0→0.55, 65→0.29, 100→0.15（场景对角线比例）
    if (x && y && z && N > 0) {
        let cx = 0, cy = 0, cz = 0;
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        let count = 0;
        for (let i = 0; i < N; i++) {
            const idx = idxAt(i);
            if (!isValid(idx)) continue;
            cx += x[idx]; cy += y[idx]; cz += z[idx];
            if (x[idx] < minX) minX = x[idx];
            if (y[idx] < minY) minY = y[idx];
            if (z[idx] < minZ) minZ = z[idx];
            if (x[idx] > maxX) maxX = x[idx];
            if (y[idx] > maxY) maxY = y[idx];
            if (z[idx] > maxZ) maxZ = z[idx];
            count++;
        }
        if (count > 0) {
            cx /= count; cy /= count; cz /= count;
            const diag = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2);
            const frac = Math.max(0.01, 0.55 - sens * 0.004);
            const distSq = (frac * diag) ** 2;
            for (let i = 0; i < N; i++) {
                const idx = idxAt(i);
                if (!isValid(idx)) continue;
                const dx = x[idx] - cx, dy = y[idx] - cy, dz = z[idx] - cz;
                if (dx * dx + dy * dy + dz * dz > distSq) {
                    flag(idx);
                    details.distance++;
                }
            }
        }
    }

    // 统计唯一浮云数
    let count = 0;
    for (let i = 0; i < numSplats; i++) {
        if (mask[i] === 255) count++;
    }
    return { mask, count, details };
}
