/**
 * Runtime LOD (V3) — data-layer helpers.
 *
 * SplatRoom renders every gaussian of a model at once; very large scans
 * (multi-million splats) pay full sort + vertex cost on every camera move.
 * This module builds lower-resolution "proxy" levels and swaps the active
 * GSplatData as the camera zooms out (re-using Splat.replaceData).
 *
 * 代理层现在是**纯 stride 抽样**（M3-4，见文件末尾 §为什么不再用 decimation）：
 * 抽样的每一行都**就是**源数据的某一行，行号可按 `floor(i * N / target)` 现算，
 * 不需要存映射表 —— 这是"代理层要能反映全分辨率的删除状态"的前提。
 */
import { Asset, GSplatData, GSplatResource } from 'playcanvas';

// ---- GSplatData ⇄ DataTable -------------------------------------------------

/** Enumerate a GSplatData's per-vertex float/uchar columns as name + storage. */
const vertexColumns = (data: GSplatData): { name: string; storage: Float32Array | Uint8Array }[] => {
    const props = data.getElement('vertex')?.properties as any[] ?? [];
    const cols: { name: string; storage: Float32Array | Uint8Array }[] = [];
    for (const p of props) {
        const s = p?.storage;
        if (s instanceof Float32Array) {
            cols.push({ name: p.name, storage: s });
        } else if (p?.type === 'uchar' && s instanceof Uint8Array) {
            // state column is carried verbatim (decimate keeps rows as-is)
            cols.push({ name: p.name, storage: s });
        }
    }
    return cols;
};

/**
 * 代理层只保留**渲染必需**的列（M3-3）。
 *
 * 依据（实测，`_tmp/probe-browse-baseline.cjs`，20M / SH3 = 59 列）：
 * 建两层代理（7M + 2M）要多花 **2963 MB JS 堆**、6.6 s —— 因为抽样把全部 59 列
 * 都复制了一份，而其中 45 列是 SH3 的 `f_rest`（视角相关颜色）。
 * 粗层是"远距离 / 运动中"的替身，高阶 SH 在这里既看不出来也不值那个价：
 * 只留 14 列 float（位置 + 基础色 + 不透明度 + 缩放 + 旋转）+ `state`，
 * 20M 的两层从 ~2.1 GB 降到 ~0.5 GB（**−83 %**），抽样也要少走 3/4 的列。
 *
 * `state` 必须留：`Splat.bindAsset()` 在没有 state 列时会新建一份全 0 的
 * （splat.ts:605），那样用户删掉的点会在代理层上**复活**（删了又出现）。
 *
 * 逃生门：`window.__SPLATROOM_LOD_FULL_COLUMNS__ = true` 回到全列（旧行为）。
 */
const PROXY_RENDER_COLUMN_NAMES = new Set([
    'x', 'y', 'z',
    'f_dc_0', 'f_dc_1', 'f_dc_2',
    'opacity',
    'scale_0', 'scale_1', 'scale_2',
    'rot_0', 'rot_1', 'rot_2', 'rot_3'
]);
const PROXY_EXTRA_COLUMN_NAMES = new Set(['state']);
/** 缺了这些列就画不出来 —— 遇到这种源头（自定义列名的 PLY）整体回退，宁可多花内存。 */
const PROXY_REQUIRED = ['x', 'y', 'z', 'f_dc_0', 'opacity', 'scale_0', 'rot_0'];

export const proxyColumns = (
    cols: { name: string; storage: Float32Array | Uint8Array }[]
): { name: string; storage: Float32Array | Uint8Array }[] => {
    if ((globalThis as any).__SPLATROOM_LOD_FULL_COLUMNS__ === true) return cols;
    const kept = cols.filter(c => PROXY_RENDER_COLUMN_NAMES.has(c.name) || PROXY_EXTRA_COLUMN_NAMES.has(c.name));
    for (const n of PROXY_REQUIRED) {
        if (!kept.some(c => c.name === n)) return cols;
    }
    return kept;
};

/**
 * Build a proxy level by uniform row sampling (stride gather). Used for very
 * large models where a full splat-transform decimation is too heavy: the
 * source is never deep-copied (decimation needs a full working copy for its
 * sort/coalesce), so for tens of millions of splats the copy alone would
 * freeze the UI for minutes. Sampling gathers ~`targetCount` rows evenly and
 * yields between column passes so the progress bar stays live.
 *
 * `columns` 让调用方先按 `proxyColumns()` 瘦身再抽样（M3-3）：抽 14 列和抽 59 列
 * 的墙钟时间差 4 倍，而目标内存差 4 倍。
 */
const sampleGsplatData = async (
    source: GSplatData,
    targetCount: number,
    comments: string[] = [],
    onProgress?: (fraction: number) => void,
    columns?: { name: string; storage: Float32Array | Uint8Array }[]
): Promise<GSplatData> => {
    const cols = columns ?? vertexColumns(source);
    const N = source.numSplats;
    const target = Math.max(1, Math.min(targetCount, N));
    // 不减点数时逐列拷一份（不共享源数组，避免代理层与源互相影响）
    if (target >= N) {
        return columnsToGsplatData(
            N,
            cols.map(c => ({ name: c.name, data: new (c.storage.constructor as any)(c.storage) })),
            comments
        );
    }
    const step = N / target;

    // allocate target columns once
    const outs = cols.map((c) => {
        const Ctor = c.storage.constructor;
        return new (Ctor as any)(target) as Float32Array | Uint8Array;
    });

    // gather each column: source row i*step (clamped) → target row i
    for (let ci = 0; ci < cols.length; ci++) {
        const srcCol = cols[ci].storage;
        const dstCol = outs[ci];
        if (srcCol instanceof Float32Array && dstCol instanceof Float32Array) {
            for (let i = 0; i < target; i++) {
                const srcIdx = Math.min(N - 1, Math.floor(i * step));
                dstCol[i] = srcCol[srcIdx];
            }
        } else if (srcCol instanceof Uint8Array && dstCol instanceof Uint8Array) {
            for (let i = 0; i < target; i++) {
                const srcIdx = Math.min(N - 1, Math.floor(i * step));
                dstCol[i] = srcCol[srcIdx];
            }
        }
        // let the UI paint between column passes (progress bar stays visible)
        onProgress?.((ci + 1) / (cols.length + 1));
        if (ci + 1 < cols.length) {
            await new Promise<void>((resolve) => {
                setTimeout(resolve, 0);
            });
        }
    }
    return columnsToGsplatData(
        target,
        cols.map((c, ci) => ({ name: c.name, data: outs[ci] })),
        comments
    );
};
/** Distance (camera/model-radius) at which the closest proxy engages. */
const LOD_NEAR_RATIO = 6.5;
/** Distance at which the most reduced proxy engages. */
const LOD_FAR_RATIO = 18;

// runtime-tunable engagement distances (defaults above; tweakable for tuning)
let cfgNear = LOD_NEAR_RATIO;
let cfgFar = LOD_FAR_RATIO;
/** Override the near/far engagement distances (camera-distance/model-radius). */
export const setLodDistances = (nearRatio: number, farRatio: number) => {
    if (Number.isFinite(nearRatio) && nearRatio > 1) cfgNear = nearRatio;
    if (Number.isFinite(farRatio) && farRatio > cfgNear) cfgFar = farRatio;
};
/** Read the current engagement distances. */
export const getLodDistances = () => ({ near: cfgNear, far: cfgFar });

/**
 * Pure distance→LOD decision with per-level engagement thresholds and
 * hysteresis. Proxy indices run coarsest-first: level 0 = most reduced (used
 * at the greatest distance), level n-1 = closest proxy.
 *
 * @param distRatio - camera distance / model radius.
 * @param levelCount - number of proxy levels (>0).
 * @param currentLevel - currently active proxy, -1 = full resolution.
 * @returns the level to switch to: -1 (full) … levelCount-1.
 */
export const suggestLodLevel = (
    distRatio: number,
    levelCount: number,
    currentLevel: number,
    nearRatio?: number,
    farRatio?: number
): number => {
    const near = nearRatio ?? cfgNear;
    const far = farRatio ?? cfgFar;
    const n = Math.max(1, levelCount);
    const span = Math.max(1e-6, far - near);
    // per-level engagement distance, coarsest first: level 0 engages at
    // farRatio, the closest proxy (n-1) at nearRatio
    const T = (i: number) => near + span * (n - 1 - i) / Math.max(1, n - 1);
    const upK = 1.25;  // coarsening needs to clear the band by this factor
    const dnK = 0.8;   // refining needs to drop below the band by this factor

    // ideal (no hysteresis): coarsest level whose band the distance exceeds
    let ideal = -1;
    for (let i = 0; i < n; i++) {
        if (distRatio >= T(i)) {
            ideal = i; break;
        }
    }

    // treat "full resolution" as the finest end (index n) for comparisons
    const curEff = currentLevel < 0 ? n : Math.min(currentLevel, n - 1);
    const idealEff = ideal < 0 ? n : ideal;
    if (curEff === idealEff) return currentLevel < 0 ? -1 : curEff;

    if (idealEff > curEff) {
        // refining (→ finer proxy or back to full)
        if (currentLevel < 0) return -1; // already full
        return distRatio <= T(currentLevel) * dnK ? ideal : currentLevel;
    }
    // coarsening
    if (currentLevel < 0) return ideal; // first engagement: enter its band
    return distRatio >= T(ideal) * upK ? ideal : currentLevel;
};

/**
 * Fractions of the original count worth keeping as proxy levels, based on
 * size. Small models need no LOD; the largest get an extra far level.
 * @returns ascending-per-distance fractions, e.g. [0.4, 0.12]; empty = no LOD.
 */
export const planLodFractions = (numSplats: number): number[] => {
    if (numSplats > 2_500_000) return [0.35, 0.10];
    if (numSplats > 900_000) return [0.35];
    return [];
};

// ---- Asset binding (main thread only) ---------------------------------------

/**
 * Wrap a decimated GSplatData into a registered gsplat Asset. Requires a
 * graphics device (main thread). The returned asset is independent: a proxy
 * level the splat can swap to via replaceData without touching the base data.
 */
export const createLodAsset = (
    app: any,
    gsplatData: GSplatData,
    level: number,
    baseName: string
): Asset => {
    const device = app.graphicsDevice;
    const resource = new GSplatResource(device, gsplatData);
    const name = `lod-${baseName}-${level}-${Date.now()}`;
    const asset = new Asset(name, 'gsplat', { url: `lod-${name}`, filename: name });
    asset.resource = resource;
    asset.loaded = true;
    asset.loading = false;
    app.assets.add(asset);
    return asset;
};

/** Build a GSplatData from an explicit row count + column list (worker output). */
export const columnsToGsplatData = (
    count: number,
    columns: { name: string; data: Float32Array | Uint8Array }[],
    comments: string[] = []
): GSplatData => {
    const props = columns.map((c) => {
        const isU8 = c.data instanceof Uint8Array;
        return {
            type: isU8 ? 'uchar' : 'float',
            name: c.name,
            byteSize: isU8 ? 1 : 4,
            storage: c.data
        };
    });
    return new GSplatData([{ name: 'vertex', count, properties: props }], comments);
};

interface LodLevelResult {
    count: number;
    data: GSplatData;
}

/**
 * Build `fractions.length` proxy levels by stride sampling（M3-4 起是**唯一**的构建路径）。
 *
 * 走主线程、逐列之间 `setTimeout(0)` 让出一手（见 `sampleGsplatData`），所以进度条
 * 能真的重绘；也不必为了 worker 传输而深拷贝全部列（20M 上那是几个 GB 的瞬时内存）。
 */
const buildLodLevels = async (
    source: GSplatData,
    fractions: number[],
    comments: string[] = [],
    onProgress?: (f: number) => void
): Promise<LodLevelResult[]> => {
    const N = source.numSplats;
    // M3-3：先瘦身（只留渲染必需列 + state），再抽样 —— 少走 3/4 的列、省 3/4 的目标内存
    const srcCols = proxyColumns(vertexColumns(source));
    const out: LodLevelResult[] = [];
    for (let i = 0; i < fractions.length; i++) {
        const target = Math.max(1, Math.round(fractions[i] * N));
        const data = await sampleGsplatData(
            source,
            target,
            comments,
            f => onProgress?.((i + f) / fractions.length),
            srcCols
        );
        out.push({ count: data.numSplats, data });
    }
    return out;
};

/**
 * Full main-thread pipeline: build proxy GSplatData levels and wrap them into
 * GPU assets ready for Splat.replaceData. Requires the app (graphics device).
 */
export const buildLodAssets = async (
    app: any,
    source: GSplatData,
    fractions: number[],
    baseName: string,
    onProgress?: (f: number) => void
): Promise<{ count: number; asset: Asset }[]> => {
    const levels = await buildLodLevels(source, fractions, source.comments ?? [], onProgress);
    // 逐层创建 + **每层之间让出一手宏任务**（第十九轮，`docs/probes/import-profile.cjs` 的归因）：
    // 代理层的"打包"是引擎在 `GSplatResource` 构造里同步做的（60M 主模型 2 层代理实测 ≈5 s），
    // 一次性建完就是一段 5 秒的连续冻结；逐层让出后最长阻塞≈减半，进度条也真的能重绘。
    const out: { count: number; asset: Asset }[] = [];
    for (let i = 0; i < levels.length; i++) {
        if (i > 0) {
            await new Promise<void>((resolve) => {
                setTimeout(resolve, 0);
            });
        }
        out.push({ count: levels[i].count, asset: createLodAsset(app, levels[i].data, i, baseName) });
    }
    return out;
};

/**
 * 代理层第 `i` 行对应全分辨率的第几行。
 *
 * 与 `sampleGsplatData` 的 gather 公式**必须逐字一致**（`Math.min(N-1, floor(i * N/target))`）——
 * 这不是"顺便记下来"，而是 M3-4 的正确性前提：代理层的 `state` 列要靠它从全分辨率搬，
 * 公式一旦对不上，搬过去的就是**别的点的删除标记**。
 *
 * 现算而不存表：20M 的两层映射本来要 36 MB，而这条公式是 O(1)。
 */
export const proxyRowToSourceRow = (i: number, sourceCount: number, proxyCount: number): number => {
    if (proxyCount <= 0 || sourceCount <= 0) return 0;
    return Math.min(sourceCount - 1, Math.floor(i * (sourceCount / proxyCount)));
};

// ---- §为什么不再用 decimation（M3-4）----------------------------------------
//
// 原先 N ≤ 200 万走 `@playcanvas/splat-transform` 的 `decimateSourceAdaptive`
// （worker 里跑），N > 200 万才抽样。M3-4 把它整个换成抽样，原因是实测证据：
//
//   * `decimateSourceAdaptive` 是**合并型**抽样，不是行过滤。四组实验
//     （`_tmp/probe-decimate-rowmap.mjs`、`-rowmap2.mjs`、`-morton.mjs`、`-real.mjs`）
//     结论一致：输出的**每一行都找不到对应的源行** —— 真实 `test-model.ply` 上
//     2000 → 700 是 **0/700 精确命中**（坐标逐个变过）。
//   * 于是 `state` 列也不可能被"逐行照搬"（`lod.ts` 原来那句注释是错的）：
//     实测输出里 `state` 甚至被换成了 `Uint32Array`、值与源行对不上。
//     ⇒ 90 万~200 万点模型的代理层**一直在复活用户删掉的点**（现存 bug）。
//   * 更根本的：合并型抽样**拿不到行映射**，而 M3-4 的"代理层要反映全分辨率的删除"
//     必须有映射。
//
// 代价（已量化，`_tmp/probe-proxy-quality.mjs`）：同样抽到 35%，均匀合成模型的
// 体素覆盖率 97.0% → 81.8%。但那是**病态数据**（每个点都不可省）；真实扫描件上
// M3-3 实测 20M → 2M（10%）的画面覆盖率只掉 0.6%（55.75% → 55.41%），因为扫描件
// 高度冗余。换来的是"行号可现算 + state 可信 + 少一条 worker 通路"。
//
// 顺带：导入链会把点按 morton 序排好，所以 stride 抽样在空间上是**均匀分层**的，
// 不是盲目等距。
