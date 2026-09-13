import { Splat } from './splat';
import { State } from './splat-state';

/**
 * 去浮云检测 —— 单灵敏度驱动，判据只有一个：**这一点周围在"视觉尺度"上是空的**。
 *
 * 判据：以该点为中心取一个半宽 R 的方块（R = RADIUS_FACTOR × 典型点间距），数里面有多少个高斯；
 * 若邻居数低于 **模型自身典型密度的一个比例**（比例由灵敏度决定），就判为浮云。
 *
 * 为什么是"比例"而不是绝对邻居数：真实扫描的采样密度相差几个数量级（同一模型里贴着物体的地方
 * 每平方厘米几百个点，空处一个都没有），任何固定的邻居数阈值都只能对一个密度有效。而"表面采样密度"
 * 本身可以当作尺子：均匀采样的一片表面上，半宽 R 的方块里恒有约 (2R/spacing)² 个点，与模型无关，
 * 所以阈值取"中位邻居数 × 比例"之后整个判据是无量纲的、可跨模型迁移。
 *
 * 为什么半径要跟着点间距走（这是这次修的核心 bug）：旧实现用"中位半径 × 0.3"当典型点间距，
 * 在真实扫描上它给的是**场景尺度**而不是采样间距 —— 实测用户的模型真值 0.00164，旧估计 0.371，
 * 差 226 倍，于是方块大得能装下几百个点，"周围是空的"永不成立，检测器在真实数据上基本选不中任何东西
 * （这正是"现在基本上选不中浮云"的原因）。现在 estimateSpacing() 取**最近邻距离的中位数**。
 *
 * 判据（两个分支取或）：
 *
 *   hardLimit = floor(limit × 0.15)   →  count ≤ hardLimit 就判为浮云（不管透明度）
 *   limit     = reference × 比例      →  count ≤ limit 且 不透明度 ≤ opacityLimit 才算
 *
 * 第一分支兜住"空间上真正孤零零的点"（一个孤立高斯、合成模型里的 stray，邻居数 0，
 * 不论它多不透明都必须能选中）；第二分支是主力，要求**又稀疏又偏透明**。
 *
 * 为什么要加"偏透明"这一条（2026-09-13 第二轮用户反馈后加的）：用户指出这个工具"把墙面、窗户、
 * 地面、桌面都给删掉了，反而是中间的浮云没有删除"。用他给的真值做逐项体检后发现，**没有任何点级统计量
 * 能把"浮云"和"那间房子的稀疏表面"分开**（这是他那个扫描的客观性质：主体采样 1.6 mm，墙面/地面采样
 * 10-17 mm，两者都"稀疏"）：
 *
 *   | 判据 | 手工删除点(caught) | 误删的墙面等 | 结论 |
 *   | --- | --- | --- | --- |
 *   | cMid（半径 34.5×间距的邻居数） | 36 | 29 | 分不开 |
 *   | cFine（半径 3×间距） | 0 | 0 | 分不开 |
 *   | 5 cm 局部密度的对比度 densRatio | 0.93 | 0.72 | 反了（墙更"突兀"） |
 *   | 最近邻距离 / 局部采样间距 gapRatio | 0.95 | 1.00 | 分不开 |
 *   | 8 邻居的单位向量均值 oneSided | 0.68 | 0.94 | 反了（扫描线各向异性） |
 *   | maxScale | 0.014 | 0.030 | 反了（粗采样的墙反而更大） |
 *   | 不透明度 | **0.081** | **0.158** | **唯一分开的一项** |
 *   | 到中心距离（归一化） | 0.144 | 0.277 | 分得开，但那是这张扫描的布局，不能当准则 |
 *   | 采样自适应连通分量（size/extent） | 小团 | 大团 | 但 25% 的合法点在"小团"里（细表面被切碎） |
 *
 * 所以保留不透明度这一条（也是上游 `--filter-floaters` 的默认 op 0.1），并把重点放到**让用户能控制
 * 范围**上：`scope` 可以把判定限制在当前行选区内、或排除当前选区。实测该模型（灵敏度 50）：
 * 不加透明度 → 选中 20,934（2.25%），其中只有 12.8% 是用户手工删掉的；加了之后 → 约 1.1%，
 * 其中 18-19% 是，且被选中的点里只有 ~4% 是"不透明"的（也就是视觉上最显眼的那些墙面被排除了）。
 *
 * 老实说：在这张扫描上**自动化没法既删浮云又不碰房间表面**（最好是 F1 0.26）。这个工具的正确定位是
 * **挑选候选 + 让用户圈范围 + 先"仅选中"预览**，而不是一键清理。
 *
 * 校准（用户提供的真实案例：hk 扫描 931,720 高斯，手工删掉 6,849 个 = 0.735%）：
 *   - 手工删除**在空间上是局部的**：751 个有点的 0.25 方块里只有 211 个（28%）有删除点，
 *     一半的删除集中在 6 个方块里。所以"精确复现手工结果"这件事在统计上不成立 —— 任何阈值规则
 *     都会同时选中他们没清理过的区域里同样稀疏的点，全局精确率因此被压在 11-13%。
 *   - 只看**他们清理过的方块**（这才是同一件事的公平比较）：规则选中的点里约 1/3 正好是他们的删除点，
 *     命中率(lift) 15-18 倍；也就是说规则确实在测同一个现象，多出来的部分是同一类、只是他们没清到。
 *   - 该模型上灵敏度 → 选中量（出厂代码实测，半径 0.0577 = 34.5 × 间距 0.00167）：
 *       灵敏度 0   → 邻居上限 18  → 选中 9,751 (1.05%)，覆盖手工删除的 15.3%
 *       灵敏度 25  → 33           → 14,310 (1.54%)，25.3%
 *       灵敏度 50  → 61（默认）   → 20,934 (2.25%)，39.3%
 *       灵敏度 75  → 113          → 29,770 (3.20%)，57.1%
 *       灵敏度 100 → 211          → 47,184 (5.06%)，76.3%
 *   - 检测耗时：93 万点约 0.5 s（全量精确，不抽样）。
 *
 * 和旧版的另外两点差别：
 *   - 不再用"透明 + 体积大 + 离中心远"这三条：实测它们与"漂浮"无关（贴着表面的软边高斯又大又透明，
 *     会被整片选中），而且真实案例里手工删掉的点反而**更靠近**模型中心（0.152 vs 0.296 归一化距离）。
 *   - 成团的浮云（团内彼此相邻）以前归下方"连通簇"，现在密度判据也会把它们整团选中 —— 一个 3 个单位
 *     外、12~40 个点的独立小团确实是浮云。连通簇仍然保留，因为它提供的是另一套语义：
 *     "按簇大小阈值删" / "只保留最大簇"。
 *
 * 不再有抽样预览：判定计数必须建立在**全量**网格上（只拿抽样点建网格会让密度整体变稀，所有点都显得
 * 孤立），而"每个点的邻居数"这一遍本来就覆盖全部点，所以抽样省不下时间、还会让小计数失真
 * （实测 8 个孤立点时抽样估计给出 0 或 15）。现在计数网格在格子数可控时用密集数组（counting sort），
 * 否则退回 Map。
 */

export interface FloaterResult {
    mask: Uint8Array;               // 255 = floater, 0 = normal
    count: number;                  // 命中点数
    details: {
        spacing: number;            // 估计的典型点间距（世界单位）
        radius: number;             // 判据半径（= 方块半宽）
        reference: number;          // 模型自身的典型邻居数（中位）
        limit: number;              // 稀疏上限（= reference × 比例）
        hardLimit: number;          // 极稀疏上限（不看透明度）
        opacityLimit: number;       // 不透明度上限（sigmooid 后）
        scope: FloaterScope;        // 判定范围
        candidates: number;         // 范围内参与判定的点数
    };
}

/** 'all' 全模型 / 'selection' 只看当前已选中的高斯 / 'exclude' 跳过当前已选中的高斯。 */
export type FloaterScope = 'all' | 'selection' | 'exclude';

export interface FloaterOptions {
    scope?: FloaterScope;
}

/** 判据半径 = RADIUS_FACTOR × 典型点间距（3×3×3 格的半宽 = 1.5 × 格边长）。 */
const RADIUS_FACTOR = 34.5;
/** 灵敏度 0 → 典型密度的 0.5%，100 → 8%（对数插值）。 */
const RATIO_MIN = 0.005;
const RATIO_MAX = 0.08;
/**
 * 极稀疏分支：邻居数低于 limit × 这个比例时，不看透明度直接判为浮云。
 * 实测（真实案例，默认灵敏度）：这个比例 0 → 选中 9,298（0.998%），其中 18.3% 是用户手工删掉的；
 * 0.15 → 11,823（1.269%），15.1%；多出来的几乎都是"不透明"的点（视觉上最显眼的墙面/桌面）。
 * 所以压到 0.02：只兜住"整个方块里最多一两个邻居"这种一眼就是孤点的情形。
 */
const HARD_FRACTION = 0.02;
/** 不透明度上限：灵敏度 0 → 0.10，100 → 0.15（上游 --filter-floaters 默认 op 0.1 同一思路）。 */
const OPACITY_MIN = 0.10;
const OPACITY_MAX = 0.15;

/** 网格键打包成 float64：每轴 17 位共 51 位，double 能精确表示（21 位需要 63 位、会静默丢精度）。 */
const KEY_BITS = 17;
const KEY_STRIDE = 1 << KEY_BITS;
const KEY_LIMIT = KEY_STRIDE - 1;
const packKey = (ix: number, iy: number, iz: number) => (ix * KEY_STRIDE + iy) * KEY_STRIDE + iz;

/**
 * 典型点间距 = **最近邻距离的中位数**（抽样估计）。
 *
 * 对全点云建一个 64³ 的计数网格（counting sort，不用 Map），再对约 2000 个抽样点逐个向外扩圈找最近邻。
 * 网格格子边长 = 包围盒 / 64，远大于最近邻距离，所以第 0~1 圈就足够找到真正的最近邻（找到后按
 * "剩余点至少离 rings-1 格" 提前收敛）。
 */
export function estimateSpacing(
    x: Float32Array, y: Float32Array, z: Float32Array, n: number,
    isValid?: (i: number) => boolean
): number {
    if (n <= 0) {
        return 1e-6;
    }

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let validCount = 0;
    for (let i = 0; i < n; i++) {
        if (isValid && !isValid(i)) {
            continue;
        }
        const px = x[i], py = y[i], pz = z[i];
        if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) {
            continue;
        }
        validCount++;
        if (px < minX) minX = px;
        if (py < minY) minY = py;
        if (pz < minZ) minZ = pz;
        if (px > maxX) maxX = px;
        if (py > maxY) maxY = py;
        if (pz > maxZ) maxZ = pz;
    }
    if (validCount < 2) {
        return 1e-6;
    }

    const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
    if (!(extent > 0)) {
        return 1e-6;
    }

    // ---- counting sort of every valid point into a dim^3 grid ----
    const dim = 64;
    const cell = extent / dim;
    const inv = 1 / cell;
    const cellTotal = dim * dim * dim;
    const start = new Int32Array(cellTotal + 1);
    const cellOf = new Int32Array(validCount);
    const pointOf = new Int32Array(validCount);
    let w = 0;
    for (let i = 0; i < n; i++) {
        if (isValid && !isValid(i)) {
            continue;
        }
        const px = x[i], py = y[i], pz = z[i];
        if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) {
            continue;
        }
        const a = Math.min(dim - 1, Math.max(0, Math.floor((px - minX) * inv)));
        const b = Math.min(dim - 1, Math.max(0, Math.floor((py - minY) * inv)));
        const c = Math.min(dim - 1, Math.max(0, Math.floor((pz - minZ) * inv)));
        const ci = (a * dim + b) * dim + c;
        cellOf[w] = ci;
        pointOf[w] = i;
        start[ci + 1]++;
        w++;
    }
    for (let c = 0; c < cellTotal; c++) {
        start[c + 1] += start[c];
    }
    const cursor = Int32Array.from(start.subarray(0, cellTotal));
    const items = new Int32Array(validCount);
    for (let k = 0; k < validCount; k++) {
        items[cursor[cellOf[k]]++] = pointOf[k];
    }

    // ---- nearest neighbour for a strided sample of points ----
    const dim2 = dim * dim;
    const sampleTarget = 2000;
    const step = Math.max(1, Math.floor(validCount / sampleTarget));
    const dists: number[] = [];
    for (let k = 0; k < validCount; k += step) {
        const ci = cellOf[k];
        const qa = Math.floor(ci / dim2);
        const qb = Math.floor(ci / dim) % dim;
        const qc = ci % dim;
        const p = pointOf[k];
        const px = x[p], py = y[p], pz = z[p];
        let best2 = Infinity;
        for (let r = 0; r <= 4; r++) {
            // after rings 0..r-1 only cells at Chebyshev distance >= r remain, and any point in
            // those is at least (r-1) cells away, so this bound is safe
            if (best2 <= ((r - 1) * cell) * ((r - 1) * cell)) {
                break;
            }
            const loX = Math.max(0, qa - r), hiX = Math.min(dim - 1, qa + r);
            const loY = Math.max(0, qb - r), hiY = Math.min(dim - 1, qb + r);
            const loZ = Math.max(0, qc - r), hiZ = Math.min(dim - 1, qc + r);
            for (let a = loX; a <= hiX; a++) {
                for (let b = loY; b <= hiY; b++) {
                    for (let c = loZ; c <= hiZ; c++) {
                        if (r > 0 && Math.max(Math.abs(a - qa), Math.abs(b - qb), Math.abs(c - qc)) !== r) {
                            continue;
                        }
                        const nci = (a * dim + b) * dim + c;
                        const from = start[nci];
                        const to = start[nci + 1];
                        for (let t = from; t < to; t++) {
                            const j = items[t];
                            if (j === p) {
                                continue;
                            }
                            const dx = x[j] - px, dy = y[j] - py, dz = z[j] - pz;
                            const d2 = dx * dx + dy * dy + dz * dz;
                            if (d2 > 0 && d2 < best2) {
                                best2 = d2;
                            }
                        }
                    }
                }
            }
        }
        if (Number.isFinite(best2) && best2 > 0) {
            dists.push(Math.sqrt(best2));
        }
    }
    if (dists.length === 0) {
        // degenerate: every sampled point coincides with another one
        return extent * 1e-3;
    }
    dists.sort((a, b) => a - b);
    return dists[dists.length >> 1];
}

/** 灵敏度 → 邻居数上限占典型密度的比例（对数插值）。 */
function ratioForSensitivity(sensitivity: number): number {
    const t = Math.max(0, Math.min(100, sensitivity)) / 100;
    return RATIO_MIN * Math.pow(RATIO_MAX / RATIO_MIN, t);
}

/**
 * 检测浮云。sensitivity 0-100。全量精确检测：计数网格与每个点的邻居数都覆盖全部有效高斯。
 * options.scope 把**判定**限制在当前行选区内（或排除选区），计数与参考密度仍按全模型统计
 * —— 参考密度必须是全模型的，否则在小选区里"大家都稀疏"，比例判据就失去意义了。
 */
export function detectFloaters(splat: Splat, sensitivity: number, options: FloaterOptions = {}): FloaterResult {
    const splatData = splat.splatData;
    const numSplats = splatData.numSplats;
    const state = splatData.getProp('state') as Uint8Array;
    const x = splatData.getProp('x') as Float32Array;
    const y = splatData.getProp('y') as Float32Array;
    const z = splatData.getProp('z') as Float32Array;
    const opacity = splatData.getProp('opacity') as Float32Array | null;
    const scope: FloaterScope = options.scope === 'selection' || options.scope === 'exclude' ? options.scope : 'all';

    const mask = new Uint8Array(numSplats);
    const details = {
        spacing: 0,
        radius: 0,
        reference: 0,
        limit: 0,
        hardLimit: 0,
        opacityLimit: 0,
        scope,
        candidates: 0
    };
    const empty: FloaterResult = { mask, count: 0, details };
    if (!x || !y || !z || numSplats === 0) {
        return empty;
    }

    const isValid = (i: number) => (state[i] & (State.deleted | State.locked)) === 0;
    const isSelected = (i: number) => (state[i] & State.selected) !== 0;
    const inScope = (i: number) => scope === 'all' ||
        (scope === 'selection' ? isSelected(i) : !isSelected(i));

    // ---- 1) typical point spacing + bounds ----
    let spacing: number;
    try {
        spacing = Math.max(estimateSpacing(x, y, z, numSplats, isValid), 1e-6);
    } catch (e) {
        spacing = 1e-6;
    }

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let validCount = 0;
    for (let i = 0; i < numSplats; i++) {
        if (!isValid(i)) {
            continue;
        }
        validCount++;
        if (x[i] < minX) minX = x[i];
        if (y[i] < minY) minY = y[i];
        if (z[i] < minZ) minZ = z[i];
        if (x[i] > maxX) maxX = x[i];
        if (y[i] > maxY) maxY = y[i];
        if (z[i] > maxZ) maxZ = z[i];
    }
    if (validCount === 0) {
        return empty;
    }

    const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || spacing;
    const radius = Math.max(spacing * RADIUS_FACTOR, extent * 1e-4);
    const cellSize = radius / 1.5;              // 3x3x3 cells -> half width 1.5 cells = radius
    const inv = 1 / cellSize;

    // ---- 2) count grid over EVERY valid point ----
    // The grid must see the whole cloud: counting only a sample would thin the density by the
    // sampling ratio and make every point look sparse. A dense counting-sort array is used whenever
    // the grid stays small enough, which is several times faster than a Map on million-point models.
    const cellX = new Int32Array(numSplats);
    const cellY = new Int32Array(numSplats);
    const cellZ = new Int32Array(numSplats);
    const gridNX = Math.min(KEY_LIMIT, Math.floor((maxX - minX) * inv)) + 1;
    const gridNY = Math.min(KEY_LIMIT, Math.floor((maxY - minY) * inv)) + 1;
    const gridNZ = Math.min(KEY_LIMIT, Math.floor((maxZ - minZ) * inv)) + 1;
    const denseCells = gridNX * gridNY * gridNZ;
    const useDense = denseCells <= 8e6;
    const denseGrid = useDense ? new Int32Array(denseCells) : null;
    const sparseGrid = useDense ? null : new Map<number, number>();

    for (let i = 0; i < numSplats; i++) {
        if (!isValid(i)) {
            continue;
        }
        const ix = Math.min(gridNX - 1, Math.max(0, Math.floor((x[i] - minX) * inv)));
        const iy = Math.min(gridNY - 1, Math.max(0, Math.floor((y[i] - minY) * inv)));
        const iz = Math.min(gridNZ - 1, Math.max(0, Math.floor((z[i] - minZ) * inv)));
        cellX[i] = ix;
        cellY[i] = iy;
        cellZ[i] = iz;
        if (useDense) {
            denseGrid[(ix * gridNY + iy) * gridNZ + iz]++;
        } else {
            const key = packKey(ix, iy, iz);
            sparseGrid.set(key, (sparseGrid.get(key) || 0) + 1);
        }
    }

    // ---- 3) neighbour count of every valid point, plus the median that defines "typical density" ----
    const counts = new Int32Array(numSplats);
    const medianSamples: number[] = [];
    const medianStep = Math.max(1, Math.floor(validCount / 200000));
    let validIndex = 0;
    for (let i = 0; i < numSplats; i++) {
        if (!isValid(i)) {
            continue;
        }
        const ix = cellX[i], iy = cellY[i], iz = cellZ[i];
        let neighbours = 0;
        if (useDense) {
            const loX = Math.max(0, ix - 1), hiX = Math.min(gridNX - 1, ix + 1);
            const loY = Math.max(0, iy - 1), hiY = Math.min(gridNY - 1, iy + 1);
            const loZ = Math.max(0, iz - 1), hiZ = Math.min(gridNZ - 1, iz + 1);
            for (let a = loX; a <= hiX; a++) {
                for (let b = loY; b <= hiY; b++) {
                    const rowBase = (a * gridNY + b) * gridNZ;
                    for (let c = loZ; c <= hiZ; c++) {
                        neighbours += denseGrid[rowBase + c];
                    }
                }
            }
        } else {
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dz = -1; dz <= 1; dz++) {
                        neighbours += sparseGrid.get(packKey(ix + dx, iy + dy, iz + dz)) || 0;
                    }
                }
            }
        }
        neighbours--;                       // the point itself
        counts[i] = neighbours;
        if (validIndex % medianStep === 0) {
            medianSamples.push(neighbours);
        }
        validIndex++;
    }
    medianSamples.sort((a, b) => a - b);
    const reference = medianSamples.length ? medianSamples[medianSamples.length >> 1] : 0;
    const limit = Math.max(0, Math.round(reference * ratioForSensitivity(sensitivity)));
    const hardLimit = Math.max(0, Math.floor(limit * HARD_FRACTION));
    const t = Math.max(0, Math.min(100, sensitivity)) / 100;
    const opacityLimit = OPACITY_MIN + t * (OPACITY_MAX - OPACITY_MIN);

    // ---- 4) mask: sparse (and faint, unless it is isolated outright) ----
    // no opacity property at all -> the faintness clause cannot be evaluated, so only the count decides
    const hasOpacity = !!opacity;
    const sigmoid = (v: number) => 1 / (1 + Math.exp(-v));
    let hits = 0;
    let candidates = 0;
    for (let i = 0; i < numSplats; i++) {
        if (!isValid(i) || !inScope(i)) {
            continue;
        }
        candidates++;
        const count = counts[i];
        if (count <= hardLimit || (count <= limit && (!hasOpacity || sigmoid(opacity[i]) <= opacityLimit))) {
            mask[i] = 255;
            hits++;
        }
    }

    details.spacing = spacing;
    details.radius = radius;
    details.reference = reference;
    details.limit = limit;
    details.hardLimit = hardLimit;
    details.opacityLimit = opacityLimit;
    details.scope = scope;
    details.candidates = candidates;

    return { mask, count: hits, details };
}
