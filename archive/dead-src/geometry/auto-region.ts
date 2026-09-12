import { Vec3 } from 'playcanvas';

import { Splat } from '../splat';
import { PlanarFixParams, PlanarFixSession, applyFix } from './planar-fix';
import { detectDominantPlane } from './region-detect';
import { detectWater, WaterDetectionResult } from './water-detect';

/**
 * L1 — 自动地面/水域识别 + 平整 + 补漏（一键管线）
 *
 * 无需用户手动框选盒子：
 *   1. RANSAC 全局平面检测 → 最大平面（通常为地面/大面积平面）
 *   2. 平面内点连通聚类 → 主簇 = 地面区域
 *   3. （可选）水域识别 → 平面内低饱和偏蓝反射子集
 *   4. 用检测到的平面构造 PlanarFixSession → 复用 applyFix 熨平 + 填洞
 *
 * 结果返回新 GSplatData（与 applyFix 一致），由调用方替换/预览。
 */

export interface AutoRegionOptions {
    /** RANSAC 参数。 */
    detect?: { iterations?: number; distanceTol?: number; minInliers?: number };
    /** 是否同时识别水域并返回。 */
    detectWater?: boolean;
    /** applyFix 参数（熨平强度 / 填充密度等）。 */
    fix?: Partial<PlanarFixParams>;
    /** 地面识别的厚度（slab 半厚，沿法线方向）。默认取检测容差的 3 倍。 */
    slabThickness?: number;
    /** 是否对识别出的水面也做熨平（默认 false —— 水面通常保留）。 */
    flattenWater?: boolean;
}

export interface AutoRegionResult {
    /** 检测到的地面平面。 */
    plane: PlanarFixSession;
    /** 地面内点数 / 总点数。 */
    inlierRatio: number;
    /** 水域检测结果（detectWater 开启时）。 */
    water: WaterDetectionResult | null;
    /** 熨平 + 补漏后的数据（未执行时 null）。 */
    fixed: ReturnType<typeof applyFix> | null;
    /** 执行了哪些操作。 */
    actions: { flatten: boolean; fillHoles: boolean; waterDetected: number };
}

/**
 * 一键：识别地面 + 熨平 + 补漏（返回新数据，不改原 splat）。
 *
 * @param splat - 目标 splat
 * @param options - 可选参数
 */
export async function autoRegionFix(splat: Splat, options?: AutoRegionOptions): Promise<AutoRegionResult> {
    const detect = options?.detect;
    const region = await detectDominantPlane(splat, {
        iterations: detect?.iterations ?? 400,
        distanceTol: detect?.distanceTol,
        minInliers: detect?.minInliers ?? 1000
    });

    if (!region) {
        return {
            plane: null as unknown as PlanarFixSession,
            inlierRatio: 0,
            water: null,
            fixed: null,
            actions: { flatten: false, fillHoles: false, waterDetected: 0 }
        };
    }

    // 水面识别（可选）
    const water = options?.detectWater ?
        detectWater(splat, region) :
        null;

    // 构造 PlanarFixSession：slab 沿法线方向，半厚 = 检测容差 * 3（默认）
    const tol = options?.detect?.distanceTol ?? regionPlaneTol(splat, region);
    const halfT = options?.slabThickness ?? tol * 3;
    const b = region.bounds;
    // 内点 u/v 范围外扩 10% 作为 session 覆盖（避免边界缺失）
    const pu = (b.maxU - b.minU), pv = (b.maxV - b.minV);
    const session: PlanarFixSession = {
        plane: region.plane,
        thickness: halfT * 2,
        halfU: Math.max(pu * 0.55, halfT * 2),
        halfV: Math.max(pv * 0.55, halfT * 2),
        backEps: halfT * 0.5
    };

    const fix: PlanarFixParams = {
        flattenStrength: options?.fix?.flattenStrength ?? 1.0,
        fillDensity: options?.fix?.fillDensity ?? 1.0,
        removeFloaters: options?.fix?.removeFloaters ?? true,
        colorTolerance: options?.fix?.colorTolerance ?? 0.25,
        transparency: options?.fix?.transparency ?? 0.1
    };

    const fixed = applyFix(splat, session, fix);

    return {
        plane: session,
        inlierRatio: region.inlierRatio,
        water,
        fixed,
        actions: {
            flatten: true,
            fillHoles: true,
            waterDetected: water ? water.water.length : 0
        }
    };
}

// ---- 内部辅助 ----

/** 平面检测的默认距离容差（基于包围盒对角线 1%）。 */
function regionPlaneTol(splat: Splat, region: { plane: { origin: Vec3; normal: Vec3 } }): number {
    const sd = splat.splatData;
    const xs = sd.getProp('x') as Float32Array;
    const ys = sd.getProp('y') as Float32Array;
    const zs = sd.getProp('z') as Float32Array;
    const n = sd.numSplats;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
        if (xs[i] < minX) minX = xs[i];
        if (xs[i] > maxX) maxX = xs[i];
        if (ys[i] < minY) minY = ys[i];
        if (ys[i] > maxY) maxY = ys[i];
        if (zs[i] < minZ) minZ = zs[i];
        if (zs[i] > maxZ) maxZ = zs[i];
    }
    const diag = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2);
    return Math.max(diag * 0.01, 1e-3);
}
