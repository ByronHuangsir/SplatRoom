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
import { cpuPickNearest, cpuPickRect } from '../splat/cpu-pick';
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

/**
 * 深度拾取（`readDepths`）需要的 opacity 列：单独一条惰性上传。
 *
 * 为什么不并进 `sync`：x/y/z 是**每次手势都要**的，opacity 只有深度拾取要；20M 点上它是 80MB，
 * 没有必要让"从不用深度刷的用户"也付这份常驻。gen 与 sync 共用同一把单调计数器，
 * 数据更换（sync）之后旧的 opacity 记录随之作废（见 handleSync 里整条记录被覆盖）。
 */
type PickOpacityRequest = {
    id: number;
    type: 'pick-opacity';
    slot: number;
    gen: number;
    numSplats: number;
    opacity: Float32Array;
    activated: boolean;
};

/**
 * unified（引擎 GPU 排序）通路的拾取（原来在主线程跑 `cpu-pick.ts` 的那两趟 O(n) 循环）。
 *
 * x/y/z 用槽里常驻的那份；state 每次手势拷进**池化缓冲**转移过来（用完原样转移回去，
 * 与 `begin`/`select` 的 state 同一套约定）。矩阵只传数值（结构化克隆，16 个 float）。
 * 三种 mode 与 `src/scene/picker.ts` 原来的三处调用一一对应：
 *   · 'rect'    —— `readIds` 的矩形拾取（含环模式）；
 *   · 'nearest' —— `readId` 的单点拾取（"半径内最近的候选里取最前"）；
 *   · 'depths'  —— `readDepths` 的深度 pass：并集包围盒一趟（带 opacity 记账），
 *                  落空的采样点再逐个退回 nearest（与主线程原实现逐行同款）。
 */
type PickRequest = {
    id: number;
    type: 'pick';
    slot: number;
    mode: 'rect' | 'nearest' | 'depths';
    state: Uint8Array;
    showDeleted: boolean;
    projection: ArrayLike<number>;
    view: ArrayLike<number>;
    worldTransform: ArrayLike<number>;
    width: number;
    height: number;
    near?: number;
    far?: number;
    /** rect / depths：目标矩形（像素，y 向下，与 GPU 那条路的归一化坐标换算一致） */
    px0?: number;
    py0?: number;
    pw?: number;
    ph?: number;
    /** nearest */
    px?: number;
    py?: number;
    radius?: number;
    /** depths：采样点像素坐标（与 pointsX/pointsY 同长）与有效下标表 */
    pointsX?: Int32Array;
    pointsY?: Int32Array;
    validIdx?: Int32Array;
};

type Request = SyncRequest | BeginRequest | SelectRequest | PickOpacityRequest | PickRequest;

type Slot = {
    numSplats: number;
    columns: SplatColumns;
    /** 上传世代（见 SyncRequest.gen）：比它旧的 sync 一律丢弃 */
    gen: number;
    /** 手势开始时上传的那份 state（`begin` 覆盖，`select` 用完转移回主线程） */
    state: Uint8Array | null;
    /** 深度拾取用的 opacity 列（惰性上传，只在第一次深度拾取时；`sync`（数据更换）会清掉它） */
    opacity: Float32Array | null;
    /** 上传 opacity 那一刻 `data.activated` 的值（cpu-pick 的 alpha 语义开关，与列一起判定新鲜度） */
    opacityActivated: boolean;
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
    // 整条记录被覆盖：旧数据的 opacity 随之作废（主线程会在下一次深度拾取时重传）
    slots.set(msg.slot, { numSplats: msg.numSplats, columns, gen: msg.gen, state: null, opacity: null, opacityActivated: false });
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

const handlePickOpacity = (msg: PickOpacityRequest) => {
    const slot = slots.get(msg.slot);
    if (!slot || slot.gen > msg.gen || slot.numSplats !== msg.numSplats) {
        // 槽丢了 / 已被更新的数据覆盖：这份 opacity 直接丢（主线程没记成功，下次会重传）
        return { error: 'no-slot' };
    }
    slot.opacity = msg.opacity;
    slot.opacityActivated = msg.activated;
    return { ok: true };
};

const handlePick = (msg: PickRequest) => {
    const slot = slots.get(msg.slot);
    if (!slot) {
        return { error: 'no-slot', state: msg.state, transfers: [msg.state.buffer] };
    }
    const common = {
        numSplats: slot.numSplats,
        x: slot.columns.x,
        y: slot.columns.y,
        z: slot.columns.z,
        state: msg.state,
        showDeleted: msg.showDeleted,
        projection: msg.projection,
        view: msg.view,
        worldTransform: msg.worldTransform,
        width: msg.width,
        height: msg.height,
        near: msg.near,
        far: msg.far
    };
    // state 无论如何都要转移回主线程（池化复用）——所以每条返回路径的载荷里都必须带着它，
    // 否则转移列表里的 buffer 两边都拿不到，池子会一直漏
    const transfers: Transferable[] = [msg.state.buffer];
    const stateBack = { state: msg.state };

    if (msg.mode === 'nearest') {
        const r = cpuPickNearest({ ...common, px: msg.px as number, py: msg.py as number, radius: msg.radius });
        return { ok: true, ...stateBack, id: r.id, depth: r.depth, transfers };
    }

    if (msg.mode === 'rect') {
        const r = cpuPickRect({ ...common, px0: msg.px0 as number, py0: msg.py0 as number, pw: msg.pw as number, ph: msg.ph as number });
        transfers.push(r.ids.buffer);
        return { ok: true, ...stateBack, ids: r.ids, tested: r.tested, transfers };
    }

    // 'depths'：先并集包围盒一趟（带 opacity 的深度记账），落空的采样点再逐个退回 nearest
    if (!slot.opacity) {
        return { error: 'no-opacity', ...stateBack, transfers };
    }
    const px0 = msg.px0 as number;
    const py0 = msg.py0 as number;
    const pw = msg.pw as number;
    const rect = cpuPickRect({
        ...common,
        opacity: slot.opacity,
        activated: slot.opacityActivated,
        px0,
        py0,
        pw,
        ph: msg.ph as number
    });
    const validIdx = msg.validIdx as Int32Array;
    const pointsX = msg.pointsX as Int32Array;
    const pointsY = msg.pointsY as Int32Array;
    const out = new Float32Array(validIdx.length);
    for (let k = 0; k < validIdx.length; k++) {
        const i = validIdx[k];
        const v = rect.normalizedDepth[(pointsY[i] - py0) * pw + (pointsX[i] - px0)];
        if (Number.isFinite(v)) {
            out[k] = v;
            continue;
        }
        // 与主线程原实现同款：中心点落空时退回"半径内最近的候选"（否则球刷/深度带会以为这片没有表面）
        const nearest = cpuPickNearest({ ...common, px: pointsX[i] + 0.5, py: pointsY[i] + 0.5, radius: 6 });
        out[k] = Number.isFinite(nearest.depth) ? nearest.depth : NaN;
    }
    transfers.push(out.buffer);
    return { ok: true, ...stateBack, depths: out, tested: rect.tested, transfers };
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
        if (msg.type === 'pick-opacity') {
            const r: any = handlePickOpacity(msg);
            post({ id: msg.id, type: 'pick-opacity', ...r });
            return;
        }
        if (msg.type === 'pick') {
            const r: any = handlePick(msg);
            post({ id: msg.id, type: 'pick', ...r }, r.transfers ?? []);
            return;
        }
        post({ id: (msg as any).id, error: 'unknown-request' });
    } catch (err) {
        post({ id: (msg as any).id, error: String(err && (err as Error).message ? (err as Error).message : err) });
    }
};
