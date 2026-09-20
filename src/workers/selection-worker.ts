/**
 * 选择计算 worker —— 把 2000 万点级的那几趟全扫从主线程搬走。
 *
 * 背景（用户实测，2026-09-20）：`select.rect` 在 20M / 62 列夹具上端到端 1275.7ms，**主线程全程被占**
 * （心跳法最大间隔 ≈ 端到端）。拆开看，贵的是这几趟：全量投影 + 掩码写入（`selectRangeCore`）、
 * 手势开始选区的 `preMask`、`managed` 合并、以及 120MB 投影缓存的分配与填充。
 *
 * 搬法：这几趟需要的只有 **x / y / z / state 四列 + 一组数字**（相机姿态、窗口、区域判定），
 * 全都可以整块交给 worker。worker 里跑的是 `selection-core.ts` 里**与主线程同一份**循环，
 * 所以掩码逐位相同 —— 语义不是"看起来没变"，是同一段代码算出来的。
 *
 * 数据所有权：
 *   • x / y / z 只在模型数据换掉（`Splat.replaceData` 之类）时才重传一次（240MB，零拷贝转移），
 *     之后靠**数组对象身份**判断是否需要重传（见 selection-worker-client.ts 的 sync）；
 *   • state 每次手势传一份新的（20M 点 = 20MB），因为选中位一直在变；用完转移回主线程复用；
 *   • 掩码 / 缓存算完**转移**回主线程（零拷贝），main 侧因此还是拿到普通的 Uint8Array / typed array，
 *     `RangeEntry.cache`、`entry.hit`、`entry.managed` 的用法一个字都不用改。
 */
import {
    createRangeCache,
    preMaskCore,
    regionFromSpec,
    selectRangeCore,
    tailFractionsCore,
    viewExtentFromSplatsCore,
    type SelectionRangeView,
    type SelectionRegionSpec,
    type SplatColumns
} from '../splat/selection-core';

/** 常驻数据上传：x/y/z 在 worker 侧长期持有，只有模型数据换掉时才重传。 */
type SyncRequest = {
    id: number;
    type: 'sync';
    slot: number;
    /** 单调递增的世代号：预取与手势并发时，晚发的（新数据的）那一份必须赢，旧的直接丢弃 */
    gen: number;
    numSplats: number;
    x: Float32Array;
    y: Float32Array;
    z: Float32Array;
};

/**
 * 一次手势的第一步：上传当前 state，量深度范围（包围盒退化时）与三条轴的稀疏尾巴。
 *
 * 分成两步而不是一步，是因为 `tails` 要回到主线程去参与 `rangeDistances` / `screenWindow`，
 * 而那两个函数吃的是**主线程的 UI 值**（三个滑块的百分比）—— 把它们搬进 worker 只会多一份拷贝，
 * 换不来任何收益。
 */
type BeginRequest = {
    id: number;
    type: 'begin';
    slot: number;
    state: Uint8Array;
    spec: SelectionRegionSpec;
    pose: {
        viewProjection: ArrayLike<number>;
        worldTransform: ArrayLike<number>;
        width: number;
        height: number;
        cameraPosition: { x: number, y: number, z: number };
        viewDir: { x: number, y: number, z: number };
    };
    bounds: { x0: number, y0: number, x1: number, y1: number };
    /** 主线程已经用包围盒算出来的深度范围；退化（WebGPU 回读全零）时给 null，由 worker 从数据里量 */
    extent: { min: number, max: number } | null;
};

/** 一次手势的第二步：全量投影 + 掩码 + 投影缓存。 */
type SelectRequest = {
    id: number;
    type: 'select';
    slot: number;
    spec: SelectionRegionSpec;
    view: SelectionRangeView;
    /** 投影缓存深度的量化区间（= 模型的深度范围 extent，与主线程原来传给 createRangeCache 的完全一致） */
    cacheMin: number;
    cacheMax: number;
};

type Request = SyncRequest | BeginRequest | SelectRequest;

type Slot = {
    numSplats: number;
    columns: SplatColumns;
    /** 上传世代（见 SyncRequest.gen）：比它旧的 sync 一律丢弃 */
    gen: number;
    /** 手势开始时上传的那份 state（`begin` 覆盖，`select` 用完转移回主线程） */
    state: Uint8Array | null;
};

const slots = new Map<number, Slot>();

const post = (payload: any, transfers: Transferable[] = []) => {
    (self as any).postMessage(payload, transfers);
};

const handleSync = (msg: SyncRequest) => {
    const old = slots.get(msg.slot);
    if (old && old.gen > msg.gen) {
        // 迟到的旧数据：丢掉（否则会把新数据覆盖回去）
        return;
    }
    const columns: SplatColumns = {
        numSplats: msg.numSplats,
        x: msg.x,
        y: msg.y,
        z: msg.z,
        state: null
    };
    slots.set(msg.slot, { numSplats: msg.numSplats, columns, gen: msg.gen, state: null });
};

const handleBegin = (msg: BeginRequest) => {
    const slot = slots.get(msg.slot);
    if (!slot) {
        // 槽丢了（主线程换了模型数据）：把 state 还回去，并让主线程走回退路径
        return { error: 'no-slot', state: msg.state };
    }
    slot.state = msg.state;
    slot.columns.state = msg.state;

    const region = regionFromSpec(msg.spec);
    const extent = msg.extent ??
        viewExtentFromSplatsCore(slot.columns, msg.pose.worldTransform, msg.pose.cameraPosition, msg.pose.viewDir);
    if (!extent) {
        // 列不可用 ⇒ 主线程退回落地的逐点路径（它自己会再算一遍 extent）
        slot.state = null;
        slot.columns.state = null;
        return { error: 'no-extent', state: msg.state };
    }

    const tails = tailFractionsCore(slot.columns, msg.pose, extent, msg.bounds, region);
    // state 在 select 之前还要用，先留着；这里不转移
    return { ok: true, extent, tails };
};

const handleSelect = (msg: SelectRequest) => {
    const slot = slots.get(msg.slot);
    if (!slot) {
        return { error: 'no-slot' };
    }
    const n = slot.numSplats;
    const region = regionFromSpec(msg.spec);

    // 这三块每次都新分配：它们要**转移**回主线程（零拷贝），转移之后 worker 侧就失效了。
    // 分配与首次写入（页错误）都发生在 worker 线程上 —— 这正是这次改动的要点。
    const preMask = new Uint8Array(n);
    const hit = new Uint8Array(n);
    const managed = new Uint8Array(n);

    const cache = createRangeCache(n, msg.cacheMin, msg.cacheMax);
    selectRangeCore(slot.columns, region, msg.view, cache, hit, managed);
    preMaskCore(slot.state, n, preMask);
    // managed = 手势开始就选中的行 ∪ 本次掩码命中的行（只增不减，见 SplatState.applySelectionMask）。
    // 原本这是主线程上独立的一趟 20M 循环，现在并进 worker。
    for (let i = 0; i < n; i++) {
        if (preMask[i] !== 0) {
            managed[i] = 1;
        }
    }

    const transfers: Transferable[] = [preMask.buffer, hit.buffer, managed.buffer];
    if (cache) {
        transfers.push(cache.sx.buffer, cache.sy.buffer, cache.dist.buffer);
    }
    // state 用完了：转移回主线程复用（省掉每次手势 20MB 的新分配 + 页错误）
    const stateBack = slot.state;
    slot.state = null;
    slot.columns.state = null;
    if (stateBack) {
        transfers.push(stateBack.buffer);
    }

    return { ok: true, preMask, hit, managed, cache, stateBack, transfers };
};

self.onmessage = (e: MessageEvent<Request>) => {
    const msg = e.data;
    try {
        if (msg.type === 'sync') {
            handleSync(msg);
            post({ id: msg.id, type: 'sync', ok: true });
            return;
        }
        if (msg.type === 'begin') {
            const r: any = handleBegin(msg);
            post({ id: msg.id, type: 'begin', ...r }, r.state ? [r.state.buffer] : []);
            return;
        }
        if (msg.type === 'select') {
            const r: any = handleSelect(msg);
            post({ id: msg.id, type: 'select', ...r }, r.transfers ?? []);
            return;
        }
        post({ id: (msg as any).id, error: 'unknown-request' });
    } catch (err) {
        post({ id: (msg as any).id, error: String(err && (err as Error).message ? (err as Error).message : err) });
    }
};
