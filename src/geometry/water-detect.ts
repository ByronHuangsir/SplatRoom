import { Vec3 } from 'playcanvas';

import { Splat } from '../splat';
import { State } from '../splat-state';
import { RegionDetectionResult } from './region-detect';

/**
 * L1 — 水域识别
 *
 * 在全局平面检测（region-detect）基础上，对识别出的平面内点按特征聚类，
 * 找出"水面"：通常具有
 *   • 低纹理 / 低曲率（已由平面拟合保证）
 *   • 颜色偏蓝 / 低饱和（RGB 中 B 通道占优，饱和度低）
 *   • 镜面反射（SH 系数中一阶/高阶分量偏强 → 高光感）
 *
 * 输出水域高斯索引子集，供后续"平整 / 移除 / 补漏"使用。
 */

export interface WaterDetectionResult {
    /** 判定为水面的高斯索引（splat-local 空间）。 */
    water: Uint32Array;
    /** 每个候选的得分（0..1），用于 UI 显示。 */
    scores: Float32Array;
    /** 判据：低饱和 + 偏蓝 + 反射性。 */
    thresholds: { satMax: number; blueMin: number; specMin: number };
}

interface WaterFeatures {
    r: number;
    g: number;
    b: number;
    /** 饱和度 0..1（RGB 最大最小差 / 和）。 */
    sat: number;
    /** 蓝色优势：b - max(r,g)。 */
    blueBias: number;
    /** 反射性：SH 一阶及以上能量占比（0..1）。 */
    specular: number;
}

function decodeColor(dc0: number, dc1: number, dc2: number): [number, number, number] {
    // GSplat 颜色编码：0.5 + 0.5 * value（sRGB 线性）
    return [dc0 * 0.5 + 0.5, dc1 * 0.5 + 0.5, dc2 * 0.5 + 0.5];
}

/**
 * 识别平面内点中的水面，以及平面下方"幽灵高斯团"。
 *
 * 幽灵团（用户观察）：水面等不稳定平面会在其下方形成远离水平面的高斯团，
 * 颜色/纹理与地面、水面相近，但位置远离平面（通常是错误重建的漂浮物）。
 *
 * @param splat - 目标 splat
 * @param region - 全局平面检测结果（inliers 为平面内点）
 * @param options - 阈值（可选，默认经验值）
 * - satMax / blueMin / specMin：平面内水面的颜色/反射判据
 * - ghostDist：距平面超过该距离即视为"远离"（默认 = 平面范围直径的 0.25 或 3×容差）
 * - ghostColorTol：颜色距离容差（与平面主色比较，默认 0.18）
 */
export function detectWater(
    splat: Splat,
    region: RegionDetectionResult,
    options?: {
        satMax?: number;
        blueMin?: number;
        specMin?: number;
        ghostDist?: number;
        ghostColorTol?: number;
    }
): WaterDetectionResult {
    const sd = splat.splatData;
    const xs = sd.getProp('x') as Float32Array;
    const ys = sd.getProp('y') as Float32Array;
    const zs = sd.getProp('z') as Float32Array;
    const dc0 = sd.getProp('f_dc_0') as Float32Array;
    const dc1 = sd.getProp('f_dc_1') as Float32Array;
    const dc2 = sd.getProp('f_dc_2') as Float32Array;
    const sh = sd.getProp('sh') as Float32Array;
    const state = sd.getProp('state') as Uint8Array;
    const numSh = sh ? sh.length / sd.numSplats : 0;

    const satMax = options?.satMax ?? 0.55;
    const blueMin = options?.blueMin ?? 0.06;
    const specMin = options?.specMin ?? 0.02;
    const ghostColorTol = options?.ghostColorTol ?? 0.18;

    const inliers = region.inliers;
    const n = inliers.length;
    const water: number[] = [];
    const scores = new Float32Array(n);
    const { plane } = region;
    const { origin, normal } = plane;

    // ---- 平面主色：平面内点的平均颜色（作为"水面/地面"参照色）----
    let mr = 0, mg = 0, mb = 0, mc = 0;
    for (let k = 0; k < n; k++) {
        const i = inliers[k];
        if (state && (state[i] & State.deleted) !== 0) continue;
        const [r, g, b] = decodeColor(dc0[i], dc1[i], dc2[i]);
        mr += r; mg += g; mb += b; mc++;
    }
    const majR = mc > 0 ? mr / mc : 0.5;
    const majG = mc > 0 ? mg / mc : 0.5;
    const majB = mc > 0 ? mb / mc : 0.5;

    // ---- 幽灵团距离阈值：平面范围直径的 0.25，或显式传入 ----
    let ghostDist = options?.ghostDist ?? 0;
    if (ghostDist <= 0) {
        const spanU = region.bounds.maxU - region.bounds.minU;
        const spanV = region.bounds.maxV - region.bounds.minV;
        const diag = Math.hypot(spanU, spanV);
        ghostDist = Math.max(diag * 0.25, 1e-3);
    }

    for (let k = 0; k < n; k++) {
        const i = inliers[k];
        if (state && (state[i] & State.deleted) !== 0) continue;

        const [r, g, b] = decodeColor(dc0[i], dc1[i], dc2[i]);
        const mx = Math.max(r, g, b);
        const mn = Math.min(r, g, b);
        const sat = mx > 1e-6 ? (mx - mn) / (mx + mn) : 0;
        const blueBias = b - Math.max(r, g);

        // 反射性：SH 中非零阶（一阶及以上）能量占比。SH 存储顺序：
        // 0: DC, 1-3: 一阶, 4-8: 二阶… 用除 DC 外的能量 / 总能量近似
        let specular = 0;
        if (sh && numSh >= 3) {
            const base = i * numSh;
            let total = 0, ac = 0;
            for (let c = 0; c < 3; c++) {
                const dc = sh[base + c];
                total += dc * dc;
            }
            // 一阶 + 二阶能量（位置 3..numSh-1）
            for (let c = 3; c < numSh; c++) {
                const v = sh[base + c];
                total += v * v;
                ac += v * v;
            }
            specular = total > 1e-9 ? ac / total : 0;
        }

        // 距平面距离（带符号：平面下方为负）
        const dx = xs[i] - origin.x;
        const dy = ys[i] - origin.y;
        const dz = zs[i] - origin.z;
        const signedDist = dx * normal.x + dy * normal.y + dz * normal.z;

        // ---- 判据 A：平面内水面（低饱和 + 蓝色优势 + 反射性）----
        const onPlaneWater = sat <= satMax && blueBias >= blueMin && specular >= specMin;

        // ---- 判据 B：幽灵团（远离平面 + 颜色纹理接近平面主色）----
        // 用户观察：水面下方远离水平面、但颜色/纹理与地面水面相近的高斯团。
        const colorDist = Math.hypot(r - majR, g - majG, b - majB);
        const ghost = Math.abs(signedDist) > ghostDist && colorDist <= ghostColorTol;

        const isWater = onPlaneWater || ghost;
        if (isWater) water.push(i);

        const score = Math.min(1,
            (1 - sat / satMax) * 0.3 +
            (blueBias / (blueMin + blueBias)) * 0.25 +
            Math.min(1, specular / Math.max(specMin, 1e-6)) * 0.2 +
            (ghost ? 0.25 : 0)
        );
        scores[k] = score;
    }

    return {
        water: new Uint32Array(water),
        scores,
        thresholds: { satMax, blueMin, specMin }
    };
}
