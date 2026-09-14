import { BoundingBox, Vec3 } from 'playcanvas';

import { Splat } from './splat';
import { State } from './splat-state';

/**
 * 屏幕选择的**深度范围**（对齐线上编辑器：选区深度 / 最近-最远）。
 *
 * 语义：屏幕选择工具（矩形/套索/多边形/2D 笔刷/单击）**默认穿透整个模型** —— 只要高斯投影落在选择的
 * 2D 区域里就选中，不管它在多深。两个滑块再把这段"穿透空间"切出一部分：
 *
 *   最近 = 选中的最近处（占模型自身深度范围的百分比，0 = 模型最近的一端）
 *   最远 = 选中的最远处（100 = 模型最远的一端）
 *
 * 默认 0 / 100 = 整段，也就是"完整穿透"。范围按**手势当时相机的视轴**量取（沿视轴的模型范围
 * [tMin, tMax] 线性映射到 0-100%），所以：正面拉框 → 转到侧面看 → 拖滑块，被切的是同一个世界空间
 * 的板层，而不是随着视角漂移。
 *
 * 与上一版（selection-band.ts，每个像素读一次深度 pass 的前表面）的区别：
 *   - **不需要深度回读**：判定全在 CPU，没有 GPU 同步等待，也就没有"点一下等一秒"；
 *   - 不再只能"从前表面往后 T"：前后两侧都能收，且默认就是整个模型。
 *
 * 深度值一律是"沿视轴的距离"（世界单位，透视/正交同一条公式），与投影无关。
 */

export interface SelectionRangeRegion {
    /** 设备像素（原点左上）是否属于这次选择 */
    contains: (px: number, py: number) => boolean;
}

export interface SelectionRangeView {
    /** 视投影矩阵（camera.projectionMatrix * camera.viewMatrix） */
    viewProjection: number[] | Float32Array;
    /**
     * 模型的**世界变换**（splat.worldTransform）：splatData 里的 xyz 是模型局部坐标，GPU 路径会乘上它。
     * 漏掉它时，导入时被归一化/缩放过的大模型（真实扫描）投影全错，合成小模型（单位阵）看不出问题。
     */
    worldTransform: number[] | Float32Array;
    /** 相机位置与视方向（世界空间，单位向量） */
    cameraPosition: { x: number, y: number, z: number };
    viewDir: { x: number, y: number, z: number };
    /** 画布尺寸（设备像素） */
    width: number;
    height: number;
    /** 选中的深度范围：沿视轴、相对相机平面的距离 */
    minDistance: number;
    maxDistance: number;
    /** 选中的屏幕窗口（设备像素，原点左上）：左右 / 上下两个双柄范围切出来的内框 */
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
}

/** 把 0-100% 映射到沿视轴的范围 [min, max]。 */
export const rangeDistances = (min: number, max: number, nearPct: number, farPct: number) => {
    const span = max - min;
    return {
        minDistance: min + span * (nearPct * 0.01),
        maxDistance: min + span * (farPct * 0.01)
    };
};

/**
 * 选区框（设备像素）+ 左右/上下两个百分比范围 → 实际要选的屏幕窗口。
 * 百分比相对**选区框**量：left 0 / right 100 / top 0 / bottom 100 = 整个框（默认，等于不裁）。
 */
export const screenWindow = (
    bounds: { x0: number, y0: number, x1: number, y1: number },
    range: { left: number, right: number, top: number, bottom: number }
) => {
    const x0 = Math.min(bounds.x0, bounds.x1);
    const x1 = Math.max(bounds.x0, bounds.x1);
    const y0 = Math.min(bounds.y0, bounds.y1);
    const y1 = Math.max(bounds.y0, bounds.y1);
    const w = x1 - x0;
    const h = y1 - y0;
    return {
        minX: x0 + w * (range.left * 0.01),
        maxX: x0 + w * (range.right * 0.01),
        minY: y0 + h * (range.top * 0.01),
        maxY: y0 + h * (range.bottom * 0.01)
    };
};

/**
 * 模型沿视轴的深度范围：用世界空间包围盒的 8 个角在视轴上投影。
 * 比逐个高斯扫一遍便宜得多，且与"整个穿透空间"的直觉一致（模型自身的前后两端）。
 * 包围盒不可用时返回 null，调用方退化成从高斯数据里算。
 */
export const viewExtentFromBound = (
    bound: BoundingBox,
    cameraPosition: { x: number, y: number, z: number },
    viewDir: { x: number, y: number, z: number }
): { min: number, max: number } | null => {
    const center = bound.center;
    const half = bound.halfExtents;

    const lengthSq = half.x * half.x + half.y * half.y + half.z * half.z;
    if (!Number.isFinite(center.x) || !Number.isFinite(center.y) || !Number.isFinite(center.z) || !(lengthSq > 1e-12)) {
        return null;
    }

    // distance of the bound centre along the view axis, then the box's own
    // projection radius on that axis (a support function, no corner loop needed)
    const cx = center.x - cameraPosition.x;
    const cy = center.y - cameraPosition.y;
    const cz = center.z - cameraPosition.z;
    const tCenter = cx * viewDir.x + cy * viewDir.y + cz * viewDir.z;
    const radius = Math.abs(half.x * viewDir.x) + Math.abs(half.y * viewDir.y) + Math.abs(half.z * viewDir.z);

    return { min: tCenter - radius, max: tCenter + radius };
};

/**
 * 用 2D 区域 + 深度范围生成选择掩码（255 = 选中），按 splat 原始索引对齐，已排除删除/锁定的高斯。
 */
export const selectRange = (splat: Splat, region: SelectionRangeRegion, view: SelectionRangeView): Uint8Array => {
    const splatData = splat.splatData;
    const numSplats = splatData.numSplats;
    const mask = new Uint8Array(numSplats);

    const x = splatData.getProp('x') as Float32Array;
    const y = splatData.getProp('y') as Float32Array;
    const z = splatData.getProp('z') as Float32Array;
    const state = splatData.getProp('state') as Uint8Array;
    if (!x || !y || !z || numSplats === 0) {
        return mask;
    }

    const m = view.viewProjection;
    const world = view.worldTransform;
    const { width, height, cameraPosition, viewDir } = view;
    const minDistance = Math.min(view.minDistance, view.maxDistance);
    const maxDistance = Math.max(view.minDistance, view.maxDistance);
    const minX = Math.min(view.minX, view.maxX);
    const maxX = Math.max(view.minX, view.maxX);
    const minY = Math.min(view.minY, view.maxY);
    const maxY = Math.max(view.minY, view.maxY);
    const contains = region.contains;

    for (let i = 0; i < numSplats; i++) {
        if ((state[i] & (State.deleted | State.locked)) !== 0) {
            continue;
        }

        // local -> world (the model transform the GPU path applies too)
        const lx = x[i], ly = y[i], lz = z[i];
        const px = world[0] * lx + world[4] * ly + world[8] * lz + world[12];
        const py = world[1] * lx + world[5] * ly + world[9] * lz + world[13];
        const pz = world[2] * lx + world[6] * ly + world[10] * lz + world[14];

        // this splat's distance along the view axis
        const distance =
            (px - cameraPosition.x) * viewDir.x +
            (py - cameraPosition.y) * viewDir.y +
            (pz - cameraPosition.z) * viewDir.z;
        if (distance < minDistance || distance > maxDistance) {
            continue;
        }

        // project to pixels (clip -> NDC -> pixels, y down like the pickers)
        const cw = m[3] * px + m[7] * py + m[11] * pz + m[15];
        if (cw <= 0) {
            continue;
        }
        const cx = m[0] * px + m[4] * py + m[8] * pz + m[12];
        const cy = m[1] * px + m[5] * py + m[9] * pz + m[13];
        const ndcX = cx / cw;
        const ndcY = cy / cw;
        if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) {
            continue;
        }
        const sx = Math.min(width - 1, Math.max(0, Math.floor((ndcX * 0.5 + 0.5) * width)));
        const sy = Math.min(height - 1, Math.max(0, Math.floor((1 - (ndcY * 0.5 + 0.5)) * height)));

        // the 2D region (the gesture) AND the 左右 / 上下 window trim
        if (sx < minX || sx > maxX || sy < minY || sy > maxY) {
            continue;
        }
        if (contains(sx, sy)) {
            mask[i] = 255;
        }
    }

    return mask;
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
): { min: number, max: number } | null => {
    const splatData = splat.splatData;
    const numSplats = splatData.numSplats;
    const x = splatData.getProp('x') as Float32Array;
    const y = splatData.getProp('y') as Float32Array;
    const z = splatData.getProp('z') as Float32Array;
    if (!x || !y || !z || numSplats === 0) {
        return null;
    }

    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < numSplats; i++) {
        const lx = x[i], ly = y[i], lz = z[i];
        const px = world[0] * lx + world[4] * ly + world[8] * lz + world[12];
        const py = world[1] * lx + world[5] * ly + world[9] * lz + world[13];
        const pz = world[2] * lx + world[6] * ly + world[10] * lz + world[14];
        const distance =
            (px - cameraPosition.x) * viewDir.x +
            (py - cameraPosition.y) * viewDir.y +
            (pz - cameraPosition.z) * viewDir.z;
        if (distance < min) min = distance;
        if (distance > max) max = distance;
    }

    return min <= max ? { min, max } : null;
};

/** 便于调用方拼桩的相机姿态快照。 */
export const vec3Like = (v: Vec3) => ({ x: v.x, y: v.y, z: v.z });
