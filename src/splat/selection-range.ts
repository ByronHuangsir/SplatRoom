/**
 * 屏幕选择（矩形 / 套索 / 多边形 / 2D 笔刷 / 单击）的 `Splat` 门面。
 *
 * 真正的计算在 `selection-core.ts`（纯函数、不引 playcanvas / DOM），这样同一份代码可以同时跑在
 * 主线程和 `selection-worker.ts` 里 —— 2026-09-20 用户实测：2000 万点上一次框选端到端 1275ms 且
 * 主线程全程被占，把这一层搬进 worker 是唯一"既快又不动语义"的办法（同一套循环 ⇒ 掩码逐位相同）。
 *
 * 这里保留原来的导出名与签名，调用方（editor.ts）不需要知道计算跑在哪个线程。
 */
import {
    RangeProjectionCache,
    SelectionRangeRegion,
    SelectionRangeView,
    SplatColumns,
    selectRangeCore,
    selectRangeFromCacheCore,
    tailFractionsCore,
    viewExtentFromSplatsCore
} from './selection-core';
import { Splat } from './splat';

export {
    CACHE_BYTES_PER_SPLAT,
    CACHE_MAX_BYTES,
    CACHE_MAX_SPLATS,
    TAIL_PERCENT,
    TAIL_SHARE,
    createRangeCache,
    preMaskCore,
    rangeDistances,
    regionFromSpec,
    screenWindow,
    viewExtentFromBound
} from './selection-core';
export type { RangeProjectionCache, SelectionRangeRegion, SelectionRangeView, SelectionRegionSpec, SplatColumns } from './selection-core';

/** `splat.splatData` 里投影循环要的那几列（worker 用的是自己那份常驻副本，见 selection-worker.ts）。 */
export const splatColumns = (splat: Splat): SplatColumns => {
    const splatData = splat.splatData;
    return {
        numSplats: splatData.numSplats,
        x: splatData.getProp('x') as Float32Array,
        y: splatData.getProp('y') as Float32Array,
        z: splatData.getProp('z') as Float32Array,
        state: splatData.getProp('state') as Uint8Array
    };
};

/**
 * 三条轴的两条"稀疏尾巴"，**一次采样扫描算完**（深度 + 左右 + 上下）。
 *
 * 采样：13M 点的模型上一次全扫要 ~500ms，而分布只要趋势 —— 按 stride 抽 ≤40 万点（实测这一步
 * 从 1.5s 降到 ~30ms）。
 */
export const tailFractions = (
    splat: Splat,
    view: {
        viewProjection: ArrayLike<number>;
        worldTransform: ArrayLike<number>;
        width: number;
        height: number;
        cameraPosition: { x: number, y: number, z: number };
        viewDir: { x: number, y: number, z: number };
    },
    extent: { min: number, max: number },
    bounds: { x0: number, y0: number, x1: number, y1: number },
    region: SelectionRangeRegion
) => tailFractionsCore(splatColumns(splat), view, extent, bounds, region);

/**
 * 用 2D 区域 + 深度范围生成选择掩码（255 = 选中），按 splat 原始索引对齐，已排除删除/锁定的高斯。
 *
 * `out` / `mark` 是 O2 的两个可选出口（见 docs/audit/00-总结.md O2）：
 * `out` 让调用方复用自己的掩码缓冲（不然 13M 上每一杆都新分配 13MB），函数内部会先清零；
 * `mark` 是"这次手势被本算子接管的行"的只增位图 —— 命中掩码的行顺手置 1，
 * 于是写状态位那一趟不必再单独扫一遍掩码来合并（见 SplatState.applySelectionMask）。
 */
export const selectRange = (
    splat: Splat,
    region: SelectionRangeRegion,
    view: SelectionRangeView,
    cache?: RangeProjectionCache | null,
    out?: Uint8Array | null,
    mark?: Uint8Array | null
): Uint8Array => selectRangeCore(splatColumns(splat), region, view, cache, out, mark);

/**
 * 用缓存里的投影结果重算掩码：**不做投影**，只比较窗口 / 深度 / 形状，所以一次推杆从 ~900ms 掉到
 * ~50ms（13M 点实测）。缓存由手势那一次的全扫填好（selectRange 的 `cache` 参数），窗口一变就只需
 * 重跑这一层。
 */
export const selectRangeFromCache = (
    splat: Splat,
    region: SelectionRangeRegion,
    view: SelectionRangeView,
    cache: RangeProjectionCache,
    out?: Uint8Array | null,
    mark?: Uint8Array | null
): Uint8Array => {
    const columns = splatColumns(splat);
    const cxs = cache.sx;
    if (columns.numSplats === 0 || cxs.length < columns.numSplats) {
        return selectRangeCore(columns, region, view, null, out, mark);
    }
    return selectRangeFromCacheCore(columns, region, view, cache, out, mark);
};

/**
 * 退化的包围盒（WebGPU 的 bound 回读会返回全零，见 splat.updateLocalBounds）下，
 * 直接从高斯数据里量一次沿视轴的范围。代价是一次全量扫描，只在异常路径上跑。
 */
export const viewExtentFromSplats = (
    splat: Splat,
    world: number[] | Float32Array,
    cameraPosition: { x: number, y: number, z: number },
    viewDir: { x: number, y: number, z: number }
): { min: number, max: number } | null => viewExtentFromSplatsCore(splatColumns(splat), world, cameraPosition, viewDir);

/** 便于调用方拼桩的相机姿态快照。 */
export const vec3Like = (v: { x: number, y: number, z: number }) => ({ x: v.x, y: v.y, z: v.z });
