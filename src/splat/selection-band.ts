import { Splat } from './splat';
import { State } from './splat-state';

/**
 * 屏幕选择的**深度厚度**：把"只选最前面那一层"放宽成"选前表面往后 T 的一段带"。
 *
 * 背景：屏幕选择（矩形/套索/多边形/2D 笔刷/单击）在"深度"打开时走 id 拾取 —— 每个像素只有一个 id，
 * 于是永远只能选到最前面的高斯（SuperSplat 的 selection depth 语义）。用户希望能像球刷的"厚度"那样，
 * 沿视线再多选一段深度，于是有了这个模块：
 *
 *   1. 渲染一次**深度 pass**（每像素最前表面的归一化深度），用相机已有的 `depthPrep`；
 *   2. 把该次选择覆盖的区域**只读一次**（`readDepths` 的并集读取），在 CPU 侧得到"每像素前表面深度"；
 *   3. 遍历全部高斯：投影到像素 → 落在选择区域内 → 取该像素的前表面深度 → 若它到该高斯的**沿视线距离**
 *      不超过 T，就选中。
 *
 * 深度 pass 写的是**线性**归一化深度（顶点着色器里 `(viewZ - near) / (far - near)`，见 splat-shader 的
 * `pickMode == 1`），所以还原成沿视线距离就是一条线性反函数 —— 透视和正交同一条公式。一开始按 NDC 的
 * 非线性公式反推，前表面被算成 0.09（真实约 1.0），厚度带永远判不到，这里记一笔免得重犯。
 *
 * 全程 CPU（93 万点实测 60-120 ms），不需要额外回读：唯一的同步等待就是那一次深度读取。
 */

export interface DepthBandRegion {
    /** 像素是否属于这次选择（矩形边界 / 套索与笔刷的画布 alpha） */
    contains: (px: number, py: number) => boolean;
}

export interface DepthBandOptions {
    // 选择区域（device 像素坐标，原点左上）
    region: DepthBandRegion;
    // 前表面深度查询：归一化深度 0-1，null 表示该像素没有几何
    frontDepth: (px: number, py: number) => number | null;
    // 视投影矩阵（camera.projectionMatrix * camera.viewMatrix）
    viewProjection: number[] | Float32Array;
    // 模型的**世界变换**（splat.worldTransform）：splatData 里的 xyz 是模型局部坐标，
    // GPU 路径会乘上它（intersect 着色器里的 matrix_model），CPU 这边必须一致 —— 漏掉它时，
    // 导入时被归一化/缩放过的大模型（真实扫描）投影全错，厚度带一个点都选不中，而合成小模型
    // （变换是单位阵）却看不出问题。分组的逐行调色板变换这里没有应用（那种情况仍退回 id 拾取）。
    worldTransform: number[] | Float32Array;
    // 相机位置与视方向（世界空间，单位向量）
    cameraPosition: { x: number, y: number, z: number };
    viewDir: { x: number, y: number, z: number };
    // 近/远裁剪面，用于把归一化深度还原成沿视线的距离
    near: number;
    far: number;
    // 厚度（世界单位）
    thickness: number;
    // 画布尺寸（device 像素）
    width: number;
    height: number;
}

/** 深度 pass 的线性归一化深度 → 沿视线的距离。 */
const normalizedToViewDistance = (norm: number, near: number, far: number) => {
    return near + norm * (far - near);
};

/**
 * 用"前表面 + 厚度"生成一份选择掩码。返回的掩码按 splat 的原始索引对齐（255 = 选中），
 * 已排除删除/锁定的高斯。
 */
export function selectDepthBand(splat: Splat, options: DepthBandOptions): Uint8Array {
    const splatData = splat.splatData;
    const numSplats = splatData.numSplats;
    const x = splatData.getProp('x') as Float32Array;
    const y = splatData.getProp('y') as Float32Array;
    const z = splatData.getProp('z') as Float32Array;
    const state = splatData.getProp('state') as Uint8Array;

    const mask = new Uint8Array(numSplats);
    if (!x || !y || !z || numSplats === 0) {
        return mask;
    }

    const m = options.viewProjection;
    const world = options.worldTransform;
    const { width, height, cameraPosition, viewDir, near, far, thickness } = options;

    for (let i = 0; i < numSplats; i++) {
        if ((state[i] & (State.deleted | State.locked)) !== 0) {
            continue;
        }

        // local -> world (the model transform the GPU path applies too)
        const lx = x[i], ly = y[i], lz = z[i];
        const px = world[0] * lx + world[4] * ly + world[8] * lz + world[12];
        const py = world[1] * lx + world[5] * ly + world[9] * lz + world[13];
        const pz = world[2] * lx + world[6] * ly + world[10] * lz + world[14];

        // this splat's distance along the view direction
        const viewDistance =
            (px - cameraPosition.x) * viewDir.x +
            (py - cameraPosition.y) * viewDir.y +
            (pz - cameraPosition.z) * viewDir.z;
        if (viewDistance <= 0) {
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

        if (!options.region.contains(sx, sy)) {
            continue;
        }

        const front = options.frontDepth(sx, sy);
        if (front === null) {
            continue;
        }

        const frontDistance = normalizedToViewDistance(front, near, far);
        const behind = viewDistance - frontDistance;
        // behind < 0 means this splat sits in front of the recorded surface (it was
        // occluded in the depth pass): keep it, it belongs to the visible layer
        if (behind <= thickness) {
            mask[i] = 255;
        }
    }

    return mask;
}
