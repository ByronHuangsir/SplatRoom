import { Splat } from '../splat';
import { applyFix, PlanarFixParams } from './planar-fix';
import { detectDominantPlane, RegionDetectionResult } from './region-detect';
import { detectWater, WaterDetectionResult } from './water-detect';

/**
 * L2 — 语义区域选择与处理（地面 / 水域）
 *
 * 将 L1 的几何检测（RANSAC 平面 + 水域特征）组织为**语义选区**：
 *   • ground — 最大平面内点（可选连通主簇）
 *   • water  — 平面内低饱和偏蓝反射子集
 *
 * 输出：
 *   • selection：Uint8Array 掩码（1 = 属于该语义区域），可直接喂给现有
 *     选区系统（selection.set / select.byMask 风格）或直接处理。
 *   • fixed：对 ground 区域执行 applyFix（熨平 + 补漏）后的新数据（可选）。
 *
 * 无需重训模型：L1 几何先验 + 可调阈值 = 轻量语义。真正的文本/CLIP 语义
 * 分割（Gaussian Grouping 式）需要训练数据，超出编辑器范围，留作远期。
 */

export type SemanticRegion = 'ground' | 'water' | 'both';

export interface SemanticOptions {
    /** 识别哪些区域。 */
    region?: SemanticRegion;
    /** RANSAC 参数。 */
    detect?: { iterations?: number; distanceTol?: number; minInliers?: number; sampleCap?: number };
    /** 水域阈值（含幽灵团）。 */
    water?: { satMax?: number; blueMin?: number; specMin?: number; ghostDist?: number; ghostColorTol?: number };
    /** applyFix 参数（仅 ground 熨平时使用）。 */
    fix?: Partial<PlanarFixParams>;
    /** 熨平地面（true）还是仅选中（false）。 */
    flattenGround?: boolean;
    /** 检测进度回调（0..1）。 */
    onProgress?: (f: number) => void;
}

export interface SemanticResult {
    region: SemanticRegion;
    /** 1 = 属于目标语义区域（长度 numSplats）。 */
    selection: Uint8Array;
    /** 地面检测（region = ground/both 时）。 */
    ground: RegionDetectionResult | null;
    /** 水域检测（region = water/both 时）。 */
    water: WaterDetectionResult | null;
    /** 熨平后的数据（flattenGround 时）。 */
    fixed: ReturnType<typeof applyFix> | null;
    /** 计数。 */
    counts: { ground: number; water: number };
}

/**
 * 语义区域检测 → 选区掩码（+ 可选熨平）。
 *
 * @param splat - 目标 splat
 * @param options - 参数
 */
export async function semanticSelect(splat: Splat, options?: SemanticOptions): Promise<SemanticResult> {
    const region: SemanticRegion = options?.region ?? 'ground';
    const mask = new Uint8Array(splat.splatData.numSplats);

    let ground: RegionDetectionResult | null = null;
    let water: WaterDetectionResult | null = null;

    // ---- 地面检测（ground / both）----
    if (region === 'ground' || region === 'both') {
        ground = await detectDominantPlane(splat, {
            iterations: options?.detect?.iterations ?? 400,
            distanceTol: options?.detect?.distanceTol,
            minInliers: options?.detect?.minInliers ?? 1000,
            sampleCap: options?.detect?.sampleCap,
            onProgress: options?.onProgress
        });
        if (ground) {
            for (const i of ground.inliers) mask[i] = 1;
            // 默认只取最大连通簇（排除墙体/远处平面）
            const main = ground.clusters[0];
            if (main && main.length > 0) {
                const other = new Set<number>();
                for (let c = 1; c < ground.clusters.length; c++) {
                    for (const i of ground.clusters[c]) other.add(i);
                }
                if (other.size > 0 && main.length > other.size * 2) {
                    for (const i of other) mask[i] = 0;
                }
            }
        }
    }

    // ---- 水域检测（water / both）----
    if (region === 'water' || region === 'both') {
        if (ground) {
            water = detectWater(splat, ground, options?.water);
            if (water && (region === 'water')) {
                mask.fill(0);
                for (const i of water.water) mask[i] = 1;
            }
        }
    }

    // ---- 熨平地面（可选）----
    let fixed: ReturnType<typeof applyFix> | null = null;
    if (ground && options?.flattenGround) {
        const tol = options?.detect?.distanceTol ?? autoTol(splat);
        const halfT = tol * 3;
        const b = ground.bounds;
        const session = {
            plane: ground.plane,
            thickness: halfT * 2,
            halfU: Math.max((b.maxU - b.minU) * 0.55, halfT * 2),
            halfV: Math.max((b.maxV - b.minV) * 0.55, halfT * 2),
            backEps: halfT * 0.5
        };
        const params: PlanarFixParams = {
            flattenStrength: options?.fix?.flattenStrength ?? 1.0,
            fillDensity: options?.fix?.fillDensity ?? 1.0,
            removeFloaters: options?.fix?.removeFloaters ?? true,
            colorTolerance: options?.fix?.colorTolerance ?? 0.25,
            transparency: options?.fix?.transparency ?? 0.1
        };
        fixed = applyFix(splat, session, params);
    }

    return {
        region,
        selection: mask,
        ground,
        water,
        fixed,
        counts: {
            ground: ground ? ground.inliers.length : 0,
            water: water ? water.water.length : 0
        }
    };
}

/** 默认容差（包围盒对角线 1%）。 */
function autoTol(splat: Splat): number {
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
