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
    /** 选中的屏幕窗口（设备像素，原点左上）：外柄（= 扩边之后）切出来的范围 */
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    /**
     * 内柄切出来的**核心窗口**：2D 区域的形状（矩形 / 套索）只在核心窗口里生效，
     * 核心与外柄之间那一圈"扩边带"是按矩形加的（否则套索永远扩不出去，因为 2D 区域本身挡着）。
     */
    coreMinX: number;
    coreMaxX: number;
    coreMinY: number;
    coreMaxY: number;
    /**
     * 只选**看得见的表面**时给的薄壳厚度（世界单位）；不给 = 老行为（整段穿透）。
     * 环模式（camera.mode === 'rings'）下用户要求"不要穿透，只选表面"，见 keepSurface。
     */
    surfaceEpsilon?: number;
}

/**
 * 深度轴的两条"空尾巴"。模型沿视轴的前后两端常常是**稀疏的**（远处的离群高斯、扫描噪声），而包围盒是
 * 按最外沿算的，于是滑块有一段行程什么都没发生。实测真实扫描（93 万点，框内 37.4 万点）：
 *
 *   深度%  0–7.5    10      12.5–30   32.5–82.5   85     87.5    90–100
 *   点数   2,045    11,996  ~1,000    ~5,000/档   85,934 149,895 21,523     ← 尾巴占 5.7%
 *
 * 把「最远」从 100% 收到 98% **一个高斯都删不掉**，一直要收到 ~90% 才有感觉，然后 90→85 一下删掉
 * 四分之一 —— 用户的原话是"需要在首次滑动滑块就能看到选区范围的变化，尤其是最远的那个"。
 *
 * 所以按**本次手势框内**高斯的实际深度分布，把两端各占 `TAIL_SHARE` 比例的那一段压进行程的
 * `TAIL_PERCENT` 里：0% 仍对应最近端、100% 仍对应最远端（**没有东西够不着**，"默认整段穿透"的语义
 * 也不变），但第一次推杆就已经在删真实高斯了。
 */
export const TAIL_PERCENT = 0.5;
export const TAIL_SHARE = 0.02;

/**
 * 0-100 的行程 -> [0,1] 的实际比例，尾巴压紧、中间线性。
 * `tails` 是内容区在 [0,1] 里的位置（不给就纯线性）。
 * **不做 0..100 的夹取**：扩边会把百分比推到 -50 / 150，那一段按同样的斜率线性外推
 * （夹掉的话外柄就再也扩不出去了）。
 */
const tailMap = (pct: number, tails?: { near: number, far: number } | null) => {
    const t = pct * 0.01;
    if (!tails) {
        return t;
    }
    const low = tails.near;
    const high = tails.far;
    const edge = TAIL_PERCENT * 0.01;
    if (t <= edge) {
        return (t / edge) * low;
    }
    if (t >= 1 - edge) {
        return high + ((t - (1 - edge)) / edge) * (1 - high);
    }
    return low + ((t - edge) / (1 - 2 * edge)) * (high - low);
};

/** 直方图里从两端往中间数，找累积占比刚超过 `TAIL_SHARE` 的桶（= 内容区边界）。 */
const tailBins = (bins: Uint32Array, counted: number) => {
    const target = counted * TAIL_SHARE;
    const BINS = bins.length;
    let cumulative = 0;
    let nearBin = 0;
    for (let b = 0; b < BINS; b++) {
        cumulative += bins[b];
        if (cumulative >= target) {
            nearBin = b;
            break;
        }
    }
    cumulative = 0;
    let farBin = BINS - 1;
    for (let b = BINS - 1; b >= 0; b--) {
        cumulative += bins[b];
        if (cumulative >= target) {
            farBin = b;
            break;
        }
    }
    const near = (nearBin + 1) / BINS;
    const far = farBin / BINS;
    // 只要分布不是一个点，就照常压（**不再要求尾巴必须贴到两端**：框画得紧时也要有同样的
    // 第一下响应，否则"有时候有反应、有时候没有"，见 3.16.0）
    if (!(near < far)) {
        return null;
    }
    return { near, far };
};

/**
 * 三条轴的两条"稀疏尾巴"，**一次采样扫描算完**（深度 + 左右 + 上下）。
 *
 * 为什么需要：比例尺是按**包围盒 / 用户随手拖的框**算的，而真实模型的边缘常常是空的 ——
 * 13M 点的 merged-scene 里，框内 12.1M 点挤在一个高度层上，两端却稀得几乎没有点；深度轴上"最远"
 * 从 100% 收到 98% 一个高斯都删不掉。不处理的话"第一次滑动看不到选区变化"。
 *
 * 做法：按框内高斯的实际分布，把两端各占 `TAIL_SHARE` 的那一段压进滑块行程的 `TAIL_PERCENT` 里；
 * 0/100 仍然对应两端 → **没有东西够不着**，"默认整段穿透"的语义不变。
 *
 * 采样：13M 点的模型上一次全扫要 ~500ms，而分布只要趋势 —— 按 stride 抽 ≤40 万点（实测这一步
 * 从 1.5s 降到 ~30ms），拖动时的实时重切只用一次全扫。
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
): {
    depth: { near: number, far: number } | null;
    x: { near: number, far: number } | null;
    y: { near: number, far: number } | null;
} => {
    const empty: {
        depth: { near: number, far: number } | null;
        x: { near: number, far: number } | null;
        y: { near: number, far: number } | null;
    } = { depth: null, x: null, y: null };
    const data = splat.splatData;
    const numSplats = data.numSplats;
    const span = extent.max - extent.min;
    if (!data || !numSplats || !(span > 1e-6)) {
        return empty;
    }
    const px = data.getProp('x') as Float32Array;
    const py = data.getProp('y') as Float32Array;
    const pz = data.getProp('z') as Float32Array;
    const state = data.getProp('state') as Uint8Array;
    if (!px || !py || !pz) {
        return empty;
    }

    const m = view.viewProjection;
    const world = view.worldTransform;
    const { width, height, cameraPosition, viewDir } = view;
    const x0 = Math.min(bounds.x0, bounds.x1);
    const x1 = Math.max(bounds.x0, bounds.x1);
    const y0 = Math.min(bounds.y0, bounds.y1);
    const y1 = Math.max(bounds.y0, bounds.y1);
    if (!(x1 - x0 > 1) || !(y1 - y0 > 1)) {
        return empty;
    }

    const BINS = 512;
    const binsDepth = new Uint32Array(BINS);
    const binsX = new Uint32Array(BINS);
    const binsY = new Uint32Array(BINS);
    const contains = region.contains;
    const stride = Math.max(1, Math.floor(numSplats / 400000));
    let counted = 0;

    for (let i = 0; i < numSplats; i += stride) {
        if ((state[i] & (State.deleted | State.locked)) !== 0) {
            continue;
        }
        const lx = px[i], ly = py[i], lz = pz[i];
        const wx = world[0] * lx + world[4] * ly + world[8] * lz + world[12];
        const wy = world[1] * lx + world[5] * ly + world[9] * lz + world[13];
        const wz = world[2] * lx + world[6] * ly + world[10] * lz + world[14];
        const cw = m[3] * wx + m[7] * wy + m[11] * wz + m[15];
        if (cw <= 0) {
            continue;
        }
        const ndcX = (m[0] * wx + m[4] * wy + m[8] * wz + m[12]) / cw;
        const ndcY = (m[1] * wx + m[5] * wy + m[9] * wz + m[13]) / cw;
        if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) {
            continue;
        }
        const sx = Math.min(width - 1, Math.max(0, Math.floor((ndcX * 0.5 + 0.5) * width)));
        const sy = Math.min(height - 1, Math.max(0, Math.floor((1 - (ndcY * 0.5 + 0.5)) * height)));
        if (sx < x0 || sx > x1 || sy < y0 || sy > y1 || !contains(sx, sy)) {
            continue;
        }
        counted++;
        const bd = Math.floor((((wx - cameraPosition.x) * viewDir.x + (wy - cameraPosition.y) * viewDir.y + (wz - cameraPosition.z) * viewDir.z) - extent.min) / span * BINS);
        const bx = Math.floor(((sx - x0) / (x1 - x0)) * BINS);
        const by = Math.floor(((sy - y0) / (y1 - y0)) * BINS);
        if (bd >= 0 && bd < BINS) {
            binsDepth[bd]++;
        }
        if (bx >= 0 && bx < BINS) {
            binsX[bx]++;
        }
        if (by >= 0 && by < BINS) {
            binsY[by]++;
        }
    }
    if (counted < 200) {
        return empty;
    }
    return { depth: tailBins(binsDepth, counted), x: tailBins(binsX, counted), y: tailBins(binsY, counted) };
};

/**
 * 把 0-100% 映射到沿视轴的范围 [min, max]。
 * `tails` 给的是内容区在 [0,1] 里的比例：0%→最近端、`TAIL_PERCENT`%→内容区近端、
 * `100-TAIL_PERCENT`%→内容区远端、100%→最远端（尾巴压紧、其余线性）。不给就还是纯线性。
 */
export const rangeDistances = (
    min: number,
    max: number,
    nearPct: number,
    farPct: number,
    tails?: { near: number, far: number } | null
) => {
    const span = max - min;
    return {
        minDistance: min + span * tailMap(nearPct, tails),
        maxDistance: min + span * tailMap(farPct, tails)
    };
};

/**
 * 每个高斯的投影缓存：屏幕坐标 + 沿视轴的深度。
 *
 * 为什么需要：拖动滑块时每一次重切都要把 13M 点重新投影一遍（实测在 merged-scene 上**一次推杆
 * 840–1016ms**，也就是"还是有一些不顺滑"），而**投影结果在一次手势里是不变的** —— 变的只有窗口和
 * 深度范围。所以在手势那一次本来就有的全扫里顺手把 sx / sy / dist 存下来，之后每次推杆只做
 * 比较（实测 ~50ms）。`sx < 0` 表示这个高斯被相机/视口剔掉了（写不进去也不用写）。
 */
export type RangeProjectionCache = {
    sx: Int16Array;
    sy: Int16Array;
    /**
     * A3（docs/audit/00-总结.md）：沿视轴的深度**量化到 16 位**（8 B/点 → 6 B/点）。
     * 反解：`distance = distMin + dist[i] * distScale`。
     * 量化区间用**模型沿视轴的深度范围**（包围盒在该轴上的投影，见 viewExtentFromBound），
     * 所有高斯都在这个区间里，所以两端（0/100 = 整段穿透）仍然精确落在 0 与 65535 上 ——
     * 只有区间内部会引入 ≤ (extent / 65535) 的误差（13M 房间扫描实测 ≈ 0.001 世界单位，
     * 而深度窗口的步长是 extent 的 0.5% ≈ 0.33，差三个数量级）。
     */
    dist: Uint16Array;
    /** 量化区间下限（世界单位） */
    distMin: number;
    /** 每个量化步长对应的世界单位： (max - min) / 65535 */
    distScale: number;
};

/**
 * 缓存的内存预算是**按字节**算的（不再是写死的 2400 万点）：Int16 + Int16 + Uint16 = 6 B/点。
 * 192MB ÷ 6 B ≈ 3200 万点，正好覆盖 30M 那一档（原来 8 B/点 + 2400 万上限会把 30M 直接拒掉，
 * 于是每次推杆退回全量重投影，实测 ~2 秒）。超过预算时 createRangeCache 返回 null，
 * 调用方会退回逐点投影，并且应当给用户一个可见提示（不再是静默变慢）。
 */
export const CACHE_BYTES_PER_SPLAT = 6;
export const CACHE_MAX_BYTES = 192 * 1024 * 1024;
export const CACHE_MAX_SPLATS = Math.floor(CACHE_MAX_BYTES / CACHE_BYTES_PER_SPLAT);

export const createRangeCache = (numSplats: number, distMin: number, distMax: number): RangeProjectionCache | null => {
    if (!(numSplats > 0) || numSplats > CACHE_MAX_SPLATS) {
        return null;
    }
    const sx = new Int16Array(numSplats);
    sx.fill(-1);
    const span = distMax - distMin;
    return {
        sx,
        sy: new Int16Array(numSplats),
        dist: new Uint16Array(numSplats),
        distMin,
        // 退化（范围为零）时把所有点都量化到 0，反解恒等于 distMin，与线性映射一致
        distScale: span > 0 ? span / 65535 : 0
    };
};

/**
 * 选区框（设备像素）+ 左右/上下两个百分比范围 → 实际要选的屏幕窗口。
 * 百分比相对**选区框**量：left 0 / right 100 / top 0 / bottom 100 = 整个框（默认，等于不裁）。
 * `tails` 是框内内容区的实际位置（见 tailFractions）：把空边距压紧，第一次推杆就有反应。
 */
export const screenWindow = (
    bounds: { x0: number, y0: number, x1: number, y1: number },
    range: { left: number, right: number, top: number, bottom: number },
    tails?: { x: { near: number, far: number } | null, y: { near: number, far: number } | null } | null
) => {
    const x0 = Math.min(bounds.x0, bounds.x1);
    const x1 = Math.max(bounds.x0, bounds.x1);
    const y0 = Math.min(bounds.y0, bounds.y1);
    const y1 = Math.max(bounds.y0, bounds.y1);
    const w = x1 - x0;
    const h = y1 - y0;
    return {
        minX: x0 + w * tailMap(range.left, tails?.x),
        maxX: x0 + w * tailMap(range.right, tails?.x),
        minY: y0 + h * tailMap(range.top, tails?.y),
        maxY: y0 + h * tailMap(range.bottom, tails?.y)
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
): Uint8Array => {
    const splatData = splat.splatData;
    const numSplats = splatData.numSplats;
    const reused = !!out && out.length >= numSplats;
    const mask = reused ? out : new Uint8Array(numSplats);
    if (reused) {
        mask.fill(0);
    }

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
    const coreMinX = Math.min(view.coreMinX, view.coreMaxX);
    const coreMaxX = Math.max(view.coreMinX, view.coreMaxX);
    const coreMinY = Math.min(view.coreMinY, view.coreMaxY);
    const coreMaxY = Math.max(view.coreMinY, view.coreMaxY);
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

        if (cache) {
            // 投影结果与窗口无关，存下来给后面的推杆用（见 RangeProjectionCache）。
            // 深度按模型自身的深度范围量化到 16 位（A3），两端精确、内部误差远小于窗口步长。
            cache.sx[i] = sx;
            cache.sy[i] = sy;
            const q = cache.distScale > 0 ? Math.round((distance - cache.distMin) / cache.distScale) : 0;
            cache.dist[i] = q < 0 ? 0 : (q > 65535 ? 65535 : q);
        }

        if (distance < minDistance || distance > maxDistance) {
            continue;
        }

        // outside the outer window (外柄) -> not selected
        if (sx < minX || sx > maxX || sy < minY || sy > maxY) {
            continue;
        }
        // inside the outer window: the drawn shape (rect / lasso alpha / click box) decides,
        // except in the 扩边 band between the core and the outer handles, which is rectangular
        const inCore = sx >= coreMinX && sx <= coreMaxX && sy >= coreMinY && sy <= coreMaxY;
        if (inCore && !contains(sx, sy)) {
            continue;
        }
        mask[i] = 255;
        if (mark) {
            mark[i] = 1;
        }
    }

    // 环模式：只留看得见的表面（需要投影缓存，见 keepSurface）
    if (view.surfaceEpsilon !== undefined && cache) {
        keepSurface(mask, cache, numSplats, width, height, view.surfaceEpsilon);
    }

    return mask;
};

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
    const splatData = splat.splatData;
    const numSplats = splatData.numSplats;
    const state = splatData.getProp('state') as Uint8Array;
    const { sx: cxs, sy: cys, dist: cd } = cache;
    const distMin = cache.distMin;
    const distScale = cache.distScale;
    if (numSplats === 0 || cxs.length < numSplats) {
        return selectRange(splat, region, view, null, out, mark);
    }
    const reused = !!out && out.length >= numSplats;
    const mask = reused ? out : new Uint8Array(numSplats);
    if (reused) {
        mask.fill(0);
    }

    const minDistance = Math.min(view.minDistance, view.maxDistance);
    const maxDistance = Math.max(view.minDistance, view.maxDistance);
    const minX = Math.min(view.minX, view.maxX);
    const maxX = Math.max(view.minX, view.maxX);
    const minY = Math.min(view.minY, view.maxY);
    const maxY = Math.max(view.minY, view.maxY);
    const coreMinX = Math.min(view.coreMinX, view.coreMaxX);
    const coreMaxX = Math.max(view.coreMinX, view.coreMaxX);
    const coreMinY = Math.min(view.coreMinY, view.coreMaxY);
    const coreMaxY = Math.max(view.coreMinY, view.coreMaxY);
    const contains = region.contains;

    for (let i = 0; i < numSplats; i++) {
        const sx = cxs[i];
        if (sx < 0) {
            continue;
        }
        if (state && (state[i] & (State.deleted | State.locked)) !== 0) {
            continue;
        }
        const distance = distMin + cd[i] * distScale;
        if (distance < minDistance || distance > maxDistance) {
            continue;
        }
        const sy = cys[i];
        if (sx < minX || sx > maxX || sy < minY || sy > maxY) {
            continue;
        }
        const inCore = sx >= coreMinX && sx <= coreMaxX && sy >= coreMinY && sy <= coreMaxY;
        if (inCore && !contains(sx, sy)) {
            continue;
        }
        mask[i] = 255;
        if (mark) {
            mark[i] = 1;
        }
    }

    if (view.surfaceEpsilon !== undefined) {
        keepSurface(mask, cache, numSplats, view.width, view.height, view.surfaceEpsilon);
    }

    return mask;
};

/**
 * 只保留**看得见的表面**：按屏幕像素取最近深度，把比它厚过 `epsilon` 的高斯剔除。
 *
 * 用户要求：*"选择工具在环模式下不要穿透，只选择表面的内容"* —— 环模式下选中的高斯画成小圆环，
 * 整段穿透等于"背后一大堆也亮着"，反而看不出自己框住了哪一层表面。
 *
 * CPU 侧的最近深度缓冲（每像素一个 float）：一次建图 + 一次过滤，都是 O(n)，
 * 不需要恢复当年删掉的 GPU id 拾取通道。
 */
const keepSurface = (
    mask: Uint8Array,
    cache: RangeProjectionCache,
    numSplats: number,
    width: number,
    height: number,
    epsilon: number
) => {
    const nearest = new Float32Array(width * height).fill(Infinity);
    const { sx: cxs, sy: cys, dist: cd } = cache;
    for (let i = 0; i < numSplats; i++) {
        if (mask[i] === 0) {
            continue;
        }
        const p = cys[i] * width + cxs[i];
        if (cd[i] < nearest[p]) {
            nearest[p] = cd[i];
        }
    }
    for (let i = 0; i < numSplats; i++) {
        if (mask[i] === 0) {
            continue;
        }
        if (cd[i] > nearest[cys[i] * width + cxs[i]] + epsilon) {
            mask[i] = 0;
        }
    }
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
