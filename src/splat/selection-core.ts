/**
 * 屏幕选择的**纯计算核心** —— 与 playcanvas / DOM 完全无关，主线程与 selection-worker 共用同一份。
 *
 * 为什么要拆出来（2026-09-20，用户 2000 万点实测：一次框选端到端 1275ms、主线程全程被占）：
 * 这一层里的一次全量投影（`selectRangeCore`）在 20M 上就是几百毫秒，是最贵的一段。把它搬进
 * worker 需要**同一套代码**在主线程和 worker 里都能跑，所以这里不引 `Splat`、不引 `playcanvas`、
 * 不碰 DOM —— `selection-range.ts` 保留原来的 `Splat` 门面（薄包装），worker 直接引这里的 core。
 *
 * 语义上这里的每一个函数都是**从 selection-range.ts 原样搬过来的**（连循环里的运算顺序都没动），
 * 所以 worker 算出来的掩码与主线程算出来的**逐位相同** —— 这是"不许改变选择语义"的实现方式，
 * 不是靠"看起来一样"。
 */
import { STATE_DELETED, STATE_LOCKED, STATE_SELECTED } from './state-bits';

/**
 * 屏幕选择的深度**范围**（对齐线上编辑器：选区深度 / 最近-最远）。
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
 */
export interface SelectionRangeRegion {
    /** 设备像素（原点左上）是否属于这次选择 */
    contains: (px: number, py: number) => boolean;
}

/**
 * 2D 区域的**可序列化**描述：主线程造一个，worker 用 `regionFromSpec` 还原成同一套判定。
 *
 * 为什么需要：`SelectionRangeRegion.contains` 是个闭包，跨 worker 传不过去。以前每种工具在
 * editor.ts 里各自写一份箭头函数，如果 worker 那边再抄一遍，两边就有漂移的可能（"矩形算得对、
 * 套索差半个像素"这种 bug 最难查）。所以判定只有 `regionFromSpec` 一处实现，主线程与 worker
 * 都从 spec 还原 —— 传过去的只是一组数字 / 一个 alpha 缓冲。
 */
export type SelectionRegionSpec =
    /** `select.rect`：归一化后的设备像素矩形（左右/上下已 min-max 过） */
    | { kind: 'rect', px0: number, py0: number, px1: number, py1: number }
    /** `select.point`：点周围的 slack 像素方框 */
    | { kind: 'point', x: number, y: number, slack: number }
    /** `select.byMask`：套索 / 多边形 / 2D 笔刷 / 洪泛画出来的 alpha 掩码 */
    | { kind: 'alpha', alpha: Uint8Array, cw: number, ch: number, width: number, height: number };

/** spec → 判定函数。主线程与 worker 唯一的区域实现。 */
export const regionFromSpec = (spec: SelectionRegionSpec): SelectionRangeRegion => {
    if (spec.kind === 'rect') {
        const { px0, py0, px1, py1 } = spec;
        return {
            contains: (px: number, py: number) => px >= px0 && px <= px1 && py >= py0 && py <= py1
        };
    }
    if (spec.kind === 'point') {
        const { x, y, slack } = spec;
        return {
            contains: (px: number, py: number) => Math.abs(px - x) <= slack && Math.abs(py - y) <= slack
        };
    }
    const { alpha, cw, ch, width, height } = spec;
    return {
        contains: (px: number, py: number) => {
            const mx = Math.floor((px / width) * cw);
            const my = Math.floor((py / height) * ch);
            if (mx < 0 || my < 0 || mx >= cw || my >= ch) {
                return false;
            }
            return alpha[my * cw + mx] > 0;
        }
    };
};

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
 * 投影循环要的那几列。主线程从 `splat.splatData.getProp(...)` 取，worker 用自己的常驻副本。
 * `state` 允许为 null：`selectRangeFromCacheCore` 原本就容忍它（`state && ...`）。
 */
export interface SplatColumns {
    numSplats: number;
    x: Float32Array;
    y: Float32Array;
    z: Float32Array;
    state: Uint8Array | null;
}

/**
 * 三条轴的两条"空尾巴"。模型沿视轴的前后两端常常是**稀疏的**（远处的离群高斯、扫描噪声），而包围盒是
 * 按最外沿算的，于是滑块有一段行程什么都没发生。
 *
 * 做法：按框内高斯的实际分布，把两端各占 `TAIL_SHARE` 的那一段压进滑块行程的 `TAIL_PERCENT` 里；
 * 0/100 仍然对应两端 → **没有东西够不着**，"默认整段穿透"的语义不变。
 *
 * 左右/上下两个轴的中段仍然线性（就是本文件下面的 `tailMap`）；深度轴的**中段**换成了按命中点深度
 * 分布的分位数等分（见 `DepthTravel` / `depthTravel`），因为这条轴的线性中段在噪声撑爆 AABB 的
 * 扫描件上完全没有行程 —— 那是用户报的 ③。
 */
export const TAIL_PERCENT = 0.5;
export const TAIL_SHARE = 0.02;

/** 左右 / 上下两个轴的尾巴直方图分辨率（见 tailBins）。 */
const TAIL_BINS = 512;

/**
 * 深度轴的直方图分辨率。
 *
 * 为什么与左右 / 上下不一样：深度轴的行程映射要按命中点的深度分布做**分位数插值**（见 depthTravel），
 * 桶宽直接决定这张映射能分辨多细的结构。实测（20M 夹具：AABB 半径 8297、真正看得见的密集区只有 153）：
 * 512 桶下桶宽是 32 个世界单位，整块密集区只能落在 5 个桶里 —— 分位数映射会把 20% 的质量挤在一步上，
 * "一根针"原样保留。65536 桶下桶宽 0.25 个世界单位（密集区 ≈ 604 桶），一次 0.1 的推杆
 * （0.1% 的质量 ≈ 19k 点）跨 0.8 个桶 —— 已经细过数据自身的密度。
 * 代价实测可以忽略：同一趟采样扫描 + 40 万次桶写入，512 桶 1.07ms / 16384 桶 1.07ms / 65536 桶 1.12ms
 * （耗时被采样上限锁在投影那几个乘法上，与桶数无关）。
 */
const DEPTH_BINS = 65536;

/**
 * 深度轴的「滑块百分比 → 深度」映射表：**命中点（框内 + 落在选择区域里 + 未删除/未锁定）深度分布的分位数**。
 *
 * 为什么换掉"沿 AABB 范围线性 + 两端压紧"（用户报的 ③「选择范围调整，无法扩展，只能收缩」，
 * 2000 万点 / WebGPU 实测，全屏框选 19,282,378 = 100%）：
 *
 *   | 深度范围 | 选中点数 | 占比 |
 *   |---|---|---|
 *   | 0–100   | 19,282,378 | 100% |
 *   | 10–90   | 17,956,371 | 93.1% |
 *   | 25–75   | 16,468,657 | 85.4% |
 *   | 40–60   | 13,930,757 | 72.2% |
 *   | 48–52   |  2,644,133 | 13.7% |
 *   | 49–51   |  1,332,551 |  6.9% |
 *   | 50–50.5 |    358,006 |  1.9% |
 *
 * 拖 0→40 只掉 28%，而 48→50 一步掉 264 万：这张扫描件的 AABB 被远处噪声撑到半径 8297，真正看得见的
 * 密集区只有 153（×54），而 0-100 是**沿 AABB 线性铺开**的 ⇒ 密集区挤在深度 ≈50 的一根针尖上，
 * 滑块绝大部分行程"拉了没反应"、靠近针尖一步几百万点。体感就是"无法扩展、只能收缩"。
 *
 * 换成命中点深度分布的分位数之后，**中段每一单位行程切掉的质量是等分的（≈1%）**：密集区（质量占大头）
 * 拿到与它质量相称的行程，稀疏的噪声段拿到很少的行程，且每一步的能量在所有位置一致 ——
 * 既没有"拉了没反应"的死区，也没有"一步几百万点"的针尖。改前/改后两张实测表见
 * `docs/probes/selection-range-20m.cjs`（同一夹具、同一命令）。
 *
 * 与 `tailMap` 的关系（**替换中段，两端一条不改**，不是两套并列的机制）：
 *   0%           → u = 0        （AABB 近端 = 整段穿透，含噪声尾巴，"没有东西够不着"）
 *   0..0.5%      → 线性升到 u = `nearEdge`（尾巴桶上沿 ⇒ 第一次推杆就切掉近端 ~2% 的质量，3.14.0 的约定）
 *   0.5%..99.5%  → **按命中点深度分位数等分**（本表，就是这里换掉的那一段）
 *   99.5%..100%  → 线性升到 u = 1（AABB 远端）
 *   −50 / 150    → 两端按同样的斜率线性外推（扩边要能扩出去，绝不夹取）
 * 采样太少（<20 个命中点）或分布退化（近端尾巴越过远端尾巴）时 `depthTravelFromBins` 返回 null，
 * `rangeDistances` 退回与旧实现**逐位相同**的纯线性映射。左右 / 上下两个轴继续用 `tailMap`。
 *
 * **已知下限（量化格，不是映射的锅）**：推杆用的是 `RangeProjectionCache`，它的深度是 16 位量化的
 * （A3，6 B/点），格宽 = 模型深度跨度 / 65535。这块夹具的深度跨度是 11466 个世界单位 ⇒ 格宽 0.175，
 * 而等分映射在密集区里 0.5 个百分点的窗口只有 0.06 个世界单位宽 —— **比一格还窄的窗口会被量化吃掉**：
 * 实测 `50–50.5` 选中 0（若把缓存改成 float32 则是 95,684 = 0.496%；`48–52` 这种 4 个百分点的窗口
 * 两边都给 3.888%，不受影响）。这里选择保留 16 位，是为了让"**同一个 depth window → 同一批点**"
 * 与改动前逐位相同（只剩映射层变了）—— 想要更细的窗口就得动缓存，那是另一笔取舍。
 */
export type DepthTravel = {
    /** 累积占比：`cdf[b]` = 深度落在桶 0..b 里的命中点占全部命中点的比例（单调不减，末项 = 1） */
    cdf: Float32Array;
    /** 近端尾巴的边界：**累积刚过 TAIL_SHARE** 那一桶的上沿（0..1 的深度比例） */
    nearEdge: number;
    /** 远端尾巴的边界：**反向累积刚过 TAIL_SHARE** 那一桶的下沿（0..1 的深度比例） */
    farEdge: number;
};

/**
 * 0-100 的行程 -> [0,1] 的实际比例，尾巴压紧、中间线性。**左右 / 上下两个轴用的就是它**
 * （它们的行程本来就按窗口内的实际分布压紧）。
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
 * 命中点深度直方图 → 分位数表（`DepthTravel`）。**落在同一条采样扫描里**，不额外扫一遍。
 *
 * 尾巴边界与 `tailBins` 同一套约定（近端取"累积刚过 TAIL_SHARE"那一桶的**上沿**、远端取对应桶的**下沿**），
 * 只是分辨率更高（`DEPTH_BINS`）—— 好让中段的等分细过数据自身的密度。
 *
 * 分母用的是**桶内总数**而不是 `counted`：深度理论上必然落在 [extent.min, extent.max] 里，
 * 但正好落在远端那个点上的高斯会算出 `bd === BINS`（被丢弃），用桶内总数才能让 `cdf` 以精确的 1 收尾。
 */
const depthTravelFromBins = (bins: Uint32Array): DepthTravel | null => {
    const BINS = bins.length;
    let total = 0;
    for (let b = 0; b < BINS; b++) {
        total += bins[b];
    }
    if (!total) {
        return null;
    }
    const target = total * TAIL_SHARE;
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
    const nearEdge = (nearBin + 1) / BINS;
    const farEdge = farBin / BINS;
    // 与 tailBins 同一条护栏：分布退化成一个点时不压（外层退回线性）
    if (!(nearEdge < farEdge)) {
        return null;
    }
    const cdf = new Float32Array(BINS);
    // 用 double 累加、只把结果存成 float32：65536 桶下单个样本的增量（≈2.5e-6）在 float32 里
    // 接近 1 时会被吃掉，累加必须在 double 里做
    let acc = 0;
    for (let b = 0; b < BINS; b++) {
        acc += bins[b];
        cdf[b] = acc / total;
    }
    return { cdf, nearEdge, farEdge };
};

/** 分位数表取反：质量占比 `s`（0..1）→ 沿视轴的深度比例；桶内按"质量在桶内均匀分布"线性插值。 */
const quantileFromCdf = (cdf: Float32Array, s: number) => {
    const BINS = cdf.length;
    let lo = 0;
    let hi = BINS - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cdf[mid] >= s) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    const before = lo > 0 ? cdf[lo - 1] : 0;
    const inBin = cdf[lo] - before;
    const t = inBin > 0 ? (s - before) / inBin : 0;
    return (lo + (t < 0 ? 0 : (t > 1 ? 1 : t))) / BINS;
};

/**
 * 深度轴：滑块百分比 → 沿视轴的深度比例 u ∈ [0,1]（结构见 `DepthTravel` 的注释）。
 *
 * 两端与 `tailMap` 逐位相同；只有 [TAIL_PERCENT, 100 - TAIL_PERCENT] 这一段从中段线性换成了
 * 命中点深度分位数等分。外推（扩边 -50 / 150）与 `tailMap` 一样按端点斜率线性走，不夹取。
 */
const depthTravel = (pct: number, travel?: DepthTravel | null) => {
    const t = pct * 0.01;
    if (!travel) {
        // 采样太少 / 分布退化：退回与旧实现逐位相同的纯线性映射
        return t;
    }
    const edge = TAIL_PERCENT * 0.01;
    const { cdf, nearEdge, farEdge } = travel;
    // 近端尾巴 + 0 以下的外推（同一斜率：夹了外柄就再也扩不出去）
    if (t <= edge) {
        return (t / edge) * nearEdge;
    }
    // 远端尾巴 + 100 以上的外推
    if (t >= 1 - edge) {
        return farEdge + ((t - (1 - edge)) / edge) * (1 - farEdge);
    }
    // 中段：质量占比从 TAIL_SHARE 线性走到 1 - TAIL_SHARE，深度由分位数表给出
    const s = TAIL_SHARE + ((t - edge) / (1 - 2 * edge)) * (1 - 2 * TAIL_SHARE);
    const u = quantileFromCdf(cdf, s);
    // 夹在两条尾巴边界之间：尾巴桶可能比 TAIL_SHARE 厚得多（一整面墙落在一个桶里就会），
    // 不夹的话 t 一越过 edge 边界就**往回跳**（拖进去反而选得更多），也不再单调
    return u < nearEdge ? nearEdge : (u > farEdge ? farEdge : u);
};

/**
 * 三条轴的两条"稀疏尾巴"，**一次采样扫描算完**（深度 + 左右 + 上下）。
 *
 * 采样：13M 点的模型上一次全扫要 ~500ms，而分布只要趋势 —— 按 stride 抽 ≤40 万点（实测这一步
 * 从 1.5s 降到 ~30ms）。
 */
export const tailFractionsCore = (
    data: SplatColumns,
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
    depth: DepthTravel | null;
    x: { near: number, far: number } | null;
    y: { near: number, far: number } | null;
} => {
    const empty: {
        depth: DepthTravel | null;
        x: { near: number, far: number } | null;
        y: { near: number, far: number } | null;
    } = { depth: null, x: null, y: null };
    const numSplats = data.numSplats;
    const span = extent.max - extent.min;
    if (!numSplats || !(span > 1e-6)) {
        return empty;
    }
    const px = data.x;
    const py = data.y;
    const pz = data.z;
    const state = data.state;
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

    const BINS = TAIL_BINS;
    const binsDepth = new Uint32Array(DEPTH_BINS);
    const binsX = new Uint32Array(BINS);
    const binsY = new Uint32Array(BINS);
    const contains = region.contains;
    const stride = Math.max(1, Math.floor(numSplats / 400000));
    let counted = 0;

    for (let i = 0; i < numSplats; i += stride) {
        if ((state[i] & (STATE_DELETED | STATE_LOCKED)) !== 0) {
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
        // 深度直方图用 DEPTH_BINS（行程映射的分辨率，见 DEPTH_BINS），左右/上下用 TAIL_BINS
        const bd = Math.floor((((wx - cameraPosition.x) * viewDir.x + (wy - cameraPosition.y) * viewDir.y + (wz - cameraPosition.z) * viewDir.z) - extent.min) / span * DEPTH_BINS);
        const bx = Math.floor(((sx - x0) / (x1 - x0)) * BINS);
        const by = Math.floor(((sy - y0) / (y1 - y0)) * BINS);
        if (bd >= 0 && bd < DEPTH_BINS) {
            binsDepth[bd]++;
        }
        if (bx >= 0 && bx < BINS) {
            binsX[bx]++;
        }
        if (by >= 0 && by < BINS) {
            binsY[by]++;
        }
    }
    // 采样数太少就不再相信直方图 —— 但阈值**不能是绝对的 200**（docs/audit/01-量级复查-bug.md 第 10 条）：
    // 单击（7×7 的框）与小框在 13M 上 stride=32，采样后往往只剩几十个点，于是 tails=null ⇒
    // 退回纯线性映射 ⇒ "第一次推杆一个高斯都删不掉"，表现就是「上下左右时好时坏、连拉几次没反应」。
    // 512 桶下 20 个样本已经足够定位首次非空桶（桶里只有个位数时按"至少 1 个点"取边界），
    // 所以门槛降到 20；真到 0~19 个点时才退回线性。深度轴的门槛一样（它的分位数表同样是在这条
    // 扫描里用同一批样本建的）。
    if (counted < 20) {
        return empty;
    }
    return { depth: depthTravelFromBins(binsDepth), x: tailBins(binsX, counted), y: tailBins(binsY, counted) };
};

/**
 * 把 0-100% 映射到沿视轴的范围 [min, max]。
 *
 * `travel` 是**命中点深度分布的分位数表**（见 `DepthTravel` / `depthTravel`）：
 * 0%→最近端、`TAIL_PERCENT`%→近端尾巴边界、`100-TAIL_PERCENT`%→远端尾巴边界、100%→最远端，
 * 中间按分位数等分。不给（采样太少 / 分布退化）就退回纯线性 —— 与旧实现逐位相同。
 *
 * **判定逻辑一个字都没动**：同一个数值区间选出的集合仍然逐位相同，变的只有
 * 「滑块百分比 → 区间」这一层（`selectRangeCore` / `selectRangeFromCacheCore` 里那两个
 * `distance < minDistance || distance > maxDistance` 的比较）。
 */
export const rangeDistances = (
    min: number,
    max: number,
    nearPct: number,
    farPct: number,
    travel?: DepthTravel | null
) => {
    const span = max - min;
    return {
        minDistance: min + span * depthTravel(nearPct, travel),
        maxDistance: min + span * depthTravel(farPct, travel)
    };
};

/**
 * 每个高斯的投影缓存：屏幕坐标 + 沿视轴的深度。
 *
 * 为什么需要：拖动滑块时每一次重切都要把 13M 点重新投影一遍（实测在 merged-scene 上**一次推杆
 * 840–1016ms**），而**投影结果在一次手势里是不变的** —— 变的只有窗口和深度范围。所以在手势那一次
 * 本来就有的全扫里顺手把 sx / sy / dist 存下来，之后每次推杆只做比较（实测 ~50ms）。
 * `sx < 0` 表示这个高斯被相机/视口剔掉了。
 */
export type RangeProjectionCache = {
    sx: Int16Array;
    sy: Int16Array;
    /**
     * A3（docs/audit/00-总结.md）：沿视轴的深度**量化到 16 位**（8 B/点 → 6 B/点）。
     * 反解：`distance = distMin + dist[i] * distScale`。
     * 量化区间用**模型沿视轴的深度范围**（包围盒在该轴上的投影，见 viewExtentFromBound），
     * 所有高斯都在这个区间里，所以两端（0/100 = 整段穿透）仍然精确落在 0 与 65535 上。
     *
     * ③ 改深度行程映射时**故意没动它**：判定逻辑（这一层比较）必须与改动前逐位相同，
     * 而"同一个 depth window → 同一批点"这条只有在这块量化保持原样时才严格成立。
     * 代价见 depthTravel 的注释（比一格还窄的窗口会被量化吃掉）。
     */
    dist: Uint16Array;
    /** 量化区间下限（世界单位） */
    distMin: number;
    /** 每个量化步长对应的世界单位： (max - min) / 65535 */
    distScale: number;
    /** 1 / distScale（写量化值时用乘法代替除法：一次手势就是 n 次除法） */
    distInvScale: number;
};

/**
 * 缓存的内存预算是**按字节**算的（不再是写死的 2400 万点）：Int16 + Int16 + Uint16 = 6 B/点。
 * 192MB ÷ 6 B ≈ 3200 万点，正好覆盖 30M 那一档。超过预算时 createRangeCache 返回 null，
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
    const scale = span > 0 ? span / 65535 : 0;
    return {
        sx,
        sy: new Int16Array(numSplats),
        dist: new Uint16Array(numSplats),
        distMin,
        // 退化（范围为零）时把所有点都量化到 0，反解恒等于 distMin，与线性映射一致
        distScale: scale,
        distInvScale: scale > 0 ? 1 / scale : 0
    };
};

/**
 * 选区框（设备像素）+ 左右/上下两个百分比范围 → 实际要选的屏幕窗口。
 * 百分比相对**选区框**量：left 0 / right 100 / top 0 / bottom 100 = 整个框（默认，等于不裁）。
 * `tails` 是框内内容区的实际位置（见 tailFractionsCore）：把空边距压紧，第一次推杆就有反应。
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
 *
 * 参数按**结构**取（center / halfExtents），所以这里不需要引 playcanvas 的 BoundingBox。
 */
export const viewExtentFromBound = (
    bound: { center: { x: number, y: number, z: number }, halfExtents: { x: number, y: number, z: number } },
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
export const selectRangeCore = (
    data: SplatColumns,
    region: SelectionRangeRegion,
    view: SelectionRangeView,
    cache?: RangeProjectionCache | null,
    out?: Uint8Array | null,
    mark?: Uint8Array | null
): Uint8Array => {
    const numSplats = data.numSplats;
    const reused = !!out && out.length >= numSplats;
    const mask = reused ? out : new Uint8Array(numSplats);
    if (reused) {
        mask.fill(0);
    }

    const x = data.x;
    const y = data.y;
    const z = data.z;
    const state = data.state;
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
        if ((state[i] & (STATE_DELETED | STATE_LOCKED)) !== 0) {
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
            // 乘法而不是除法：这一趟在手势里对每个点都跑，13M 上一次就是 13M 次除法
            const q = ((distance - cache.distMin) * cache.distInvScale + 0.5) | 0;
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
 * ~50ms（13M 点实测）。缓存由手势那一次的全扫填好（selectRangeCore 的 `cache` 参数），窗口一变就只需
 * 重跑这一层。
 */
export const selectRangeFromCacheCore = (
    data: SplatColumns,
    region: SelectionRangeRegion,
    view: SelectionRangeView,
    cache: RangeProjectionCache,
    out?: Uint8Array | null,
    mark?: Uint8Array | null
): Uint8Array => {
    const numSplats = data.numSplats;
    const state = data.state;
    const { sx: cxs, sy: cys, dist: cd } = cache;
    const distMin = cache.distMin;
    const distScale = cache.distScale;
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
        if (state && (state[i] & (STATE_DELETED | STATE_LOCKED)) !== 0) {
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
export const viewExtentFromSplatsCore = (
    data: SplatColumns,
    world: ArrayLike<number>,
    cameraPosition: { x: number, y: number, z: number },
    viewDir: { x: number, y: number, z: number }
): { min: number, max: number } | null => {
    const numSplats = data.numSplats;
    const x = data.x;
    const y = data.y;
    const z = data.z;
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

/**
 * 手势开始时"已选中且没被锁"的行 → 位图。原本这段在 editor.ts 里是一趟 20M 循环，
 * 现在与投影同一趟数据放在 worker（见 selection-worker.ts 的 `select` 请求）。
 */
export const preMaskCore = (state: Uint8Array | null, numSplats: number, out: Uint8Array) => {
    if (!state) {
        out.fill(0);
        return out;
    }
    for (let i = 0; i < numSplats; i++) {
        const s = state[i];
        out[i] = (s & STATE_SELECTED) !== 0 && (s & STATE_LOCKED) === 0 ? 255 : 0;
    }
    return out;
};
