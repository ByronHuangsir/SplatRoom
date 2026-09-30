/**
 * 主线程侧的 selection worker 客户端（薄封装 + 回退）。
 *
 * 设计要点：
 *   • **失败一定回退**：worker 不可用 / 出错 / 超时 / 槽位预算超了，所有接口都返回 `null`，
 *     调用方（editor.ts 的 runRangeSelection）随即走原来那条主线程逐点路径。语义不会有第二种结果。
 *   • **x/y/z 只传一次**：数据换了（`Splat.replaceData` 之类 ⇒ `getProp('x')` 返回新的数组对象）
 *     才重传。重传是**分块 + 让出宏任务**做的，主线程单次占用被压在几毫秒，不会自己变成新的卡顿源。
 *   • **state 每次手势传一份**（20M 点 = 20MB），用完由 worker 转移回来复用缓冲，避免每次重新分配。
 *   • 关掉它：`window.__SPLATROOM_SELECT_WORKER__ = false`（A/B 量测与排障用）。
 */
import type { DepthTravel, RangeProjectionCache, SelectionRangeView, SelectionRegionSpec } from './selection-core';
import { Splat } from './splat';

/**
 * worker 里算出来的尾巴（`tailFractionsCore` 的返回）。
 * 深度轴是**命中点深度分布的分位数表**（`DepthTravel`，65536 桶的累积占比 ≈ 256KB，
 * 结构化克隆一次不到 1ms —— 它必须回到主线程，因为「百分比 → 深度」是在主线程拿着滑块值算的）。
 */
export type WorkerTails = {
    depth: DepthTravel | null;
    x: { near: number, far: number } | null;
    y: { near: number, far: number } | null;
};

export type WorkerAnalyzeResult = {
    extent: { min: number, max: number };
    tails: WorkerTails;
};

export type WorkerSelectResult = {
    preMask: Uint8Array;
    hit: Uint8Array;
    managed: Uint8Array;
    cache: RangeProjectionCache | null;
};

type SlotRecord = {
    id: number;
    numSplats: number;
    srcX: Float32Array;
    srcY: Float32Array;
    srcZ: Float32Array;
    bytes: number;
    /** 深度拾取用的 opacity：已同步的列对象身份 + 当时的 activated 标志（null = 还没同步过） */
    srcOpacity: Float32Array | null;
    opacityActivated: boolean;
    opacityBytes: number;
};

type Pending = {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_TIMEOUT_MS = 30000;
/** worker 侧常驻数据的总字节预算：超过就让主线程自己算（回退），不去赌内存 */
const SLOT_BUDGET_BYTES = 1.6 * 1024 * 1024 * 1024;
/** 分块上传的块大小（元素数，Float32 ⇒ 8MB/块）：每块之间让出宏任务，主线程不会长时间被占 */
const SYNC_CHUNK = 1 << 21;
/** 复用缓冲池的上限（只放 state 那 20MB 级的缓冲） */
const POOL_MAX = 6;

let worker: Worker | null = null;
let workerBroken = false;
let msgId = 0;
let nextSlot = 1;
let slotBytes = 0;
let syncGen = 0;
const pending = new Map<number, Pending>();
const slots = new WeakMap<Splat, SlotRecord>();
const inflight = new WeakMap<Splat, Promise<number | null>>();
const buffers: Uint8Array[] = [];

const flagOn = () => {
    if (typeof window === 'undefined') {
        return false;
    }
    // 默认开；显式 false 关（A/B 与排障）
    return (window as any).__SPLATROOM_SELECT_WORKER__ !== false;
};

const workerUrl = (): string => {
    const base = typeof document !== 'undefined' ? document.baseURI : (self as any).location.href;
    return new URL('selection-worker.js', base).toString();
};

const failAll = (reason: string) => {
    const err = new Error(reason);
    for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(err);
    }
    pending.clear();
};

const getWorker = (): Worker | null => {
    if (workerBroken) {
        return null;
    }
    if (!worker) {
        try {
            worker = new Worker(workerUrl(), { type: 'module' });
            worker.onmessage = (e: MessageEvent) => {
                const msg = e.data;
                const p = pending.get(msg.id);
                if (!p) {
                    return;
                }
                pending.delete(msg.id);
                clearTimeout(p.timer);
                p.resolve(msg);
            };
            worker.onerror = (e: ErrorEvent) => {
                // worker 崩了：标记不可用，所有等待中的调用改走回退路径
                workerBroken = true;
                failAll(`selection-worker error: ${e.message || 'unknown'}`);
            };
            worker.onmessageerror = () => {
                workerBroken = true;
                failAll('selection-worker messageerror');
            };
        } catch (err) {
            workerBroken = true;
            return null;
        }
    }
    return worker;
};

const request = (payload: any, transfers: Transferable[]): Promise<any> => {
    const w = getWorker();
    if (!w) {
        return Promise.reject(new Error('no-worker'));
    }
    const id = ++msgId;
    return new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error('selection-worker timeout'));
        }, DEFAULT_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        w.postMessage({ id, ...payload }, transfers);
    });
};

/** 让出一个宏任务（微任务不会让心跳/渲染插进来，而定时器最小间隔在浏览器里被夹到 ~1ms） */
const yieldMacrotask = (() => {
    const channel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
    const queue: Array<() => void> = [];
    if (channel) {
        channel.port1.onmessage = () => {
            const fn = queue.shift();
            if (fn) {
                fn();
            }
        };
    }
    return () => new Promise<void>((resolve) => {
        if (!channel) {
            setTimeout(resolve, 0);
            return;
        }
        queue.push(resolve);
        channel.port2.postMessage(0);
    });
})();

const takeBuffer = (bytes: number): Uint8Array => {
    for (let i = buffers.length - 1; i >= 0; i--) {
        if (buffers[i].byteLength >= bytes) {
            return buffers.splice(i, 1)[0];
        }
    }
    return new Uint8Array(bytes);
};

const giveBuffer = (buf: Uint8Array | null | undefined) => {
    if (buf && buffers.length < POOL_MAX) {
        buffers.push(buf);
    }
};

/** 调试/量测用：当前是否真的会走 worker。 */
export const selectionWorkerActive = () => flagOn() && !workerBroken && !!worker;

/**
 * 确保某个 splat 的 x/y/z 已经在 worker 里。返回槽号；不可用 / 超预算时返回 null（调用方回退）。
 *
 * 同一个 splat 上只会有一份在途的拷贝（预取与手势可能同时来）—— 见 `inflight`。
 */
export const prepareSlot = (splat: Splat): Promise<number | null> => {
    const running = inflight.get(splat);
    if (running) {
        return running;
    }
    const p = doPrepareSlot(splat);
    inflight.set(splat, p);
    const clear = () => {
        if (inflight.get(splat) === p) {
            inflight.delete(splat);
        }
    };
    p.then(clear, clear);
    return p;
};

/** 真正干活的那个（绝不 reject：失败一律返回 null，调用方走回退路径）。 */
const doPrepareSlot = async (splat: Splat): Promise<number | null> => {
    if (!flagOn()) {
        return null;
    }
    const data = splat.splatData as any;
    const numSplats = data?.numSplats ?? 0;
    if (!numSplats) {
        return null;
    }
    const x = data.getProp('x') as Float32Array;
    const y = data.getProp('y') as Float32Array;
    const z = data.getProp('z') as Float32Array;
    if (!x || !y || !z) {
        return null;
    }

    const existing = slots.get(splat);
    if (existing && existing.numSplats === numSplats && existing.srcX === x && existing.srcY === y && existing.srcZ === z) {
        return existing.id;
    }

    const bytes = numSplats * 12;
    // 数据换了就**复用同一个槽号**（worker 侧整条记录被覆盖，旧数组随即可回收），不新增槽
    const slot = existing ? existing.id : nextSlot++;
    if (existing) {
        slotBytes -= existing.bytes + existing.opacityBytes;
        slots.delete(splat);
    }
    if (slotBytes + bytes > SLOT_BUDGET_BYTES) {
        return null;
    }

    // 分块拷贝（每块之间让出宏任务）：240MB 一次性 copy + 首次触碰会是一段几百毫秒的主线程占用
    const cx = new Float32Array(numSplats);
    const cy = new Float32Array(numSplats);
    const cz = new Float32Array(numSplats);
    for (let o = 0; o < numSplats; o += SYNC_CHUNK) {
        const e = Math.min(o + SYNC_CHUNK, numSplats);
        cx.set(x.subarray(o, e), o);
        cy.set(y.subarray(o, e), o);
        cz.set(z.subarray(o, e), o);
        await yieldMacrotask();
    }

    try {
        await request({ type: 'sync', slot, gen: ++syncGen, numSplats, x: cx, y: cy, z: cz }, [cx.buffer, cy.buffer, cz.buffer]);
    } catch (err) {
        return null;
    }
    slots.set(splat, { id: slot, numSplats, srcX: x, srcY: y, srcZ: z, bytes, srcOpacity: null, opacityActivated: false, opacityBytes: 0 });
    slotBytes += bytes;
    return slot;
};

/** 提前把数据推进 worker（选中选择工具时就开始，别把 240MB 拷贝压在第一次手势上）。 */
export const prewarmSplats = (splats: Splat[]) => {
    if (!flagOn()) {
        return;
    }
    for (const splat of splats) {
        // 失败无所谓：手势里还会再试一次，仍失败就走回退路径
        void prepareSlot(splat).catch(() => { /* 回退路径照常工作 */ });
    }
};

/** 第一步：上传 state + 量深度范围 / 三条轴的尾巴。失败返回 null。 */
export const workerAnalyze = async (
    slot: number,
    spec: SelectionRegionSpec,
    state: Uint8Array,
    pose: {
        viewProjection: ArrayLike<number>;
        worldTransform: ArrayLike<number>;
        width: number;
        height: number;
        cameraPosition: { x: number, y: number, z: number };
        viewDir: { x: number, y: number, z: number };
    },
    bounds: { x0: number, y0: number, x1: number, y1: number },
    extent: { min: number, max: number } | null
): Promise<WorkerAnalyzeResult | null> => {
    const buf = takeBuffer(state.length);
    buf.set(state);
    try {
        const r = await request({ type: 'begin', slot, state: buf, spec, pose, bounds, extent }, [buf.buffer]);
        if (r.error) {
            giveBuffer(r.state);
            return null;
        }
        return { extent: r.extent, tails: r.tails };
    } catch (err) {
        return null;
    }
};

/** 第二步：全量投影 + 掩码 + 投影缓存（算完 transfer 回来，零拷贝）。失败返回 null。 */
export const workerSelect = async (
    slot: number,
    spec: SelectionRegionSpec,
    view: SelectionRangeView,
    cacheMin: number,
    cacheMax: number
): Promise<WorkerSelectResult | null> => {
    try {
        const r = await request({ type: 'select', slot, spec, view, cacheMin, cacheMax }, []);
        if (r.error) {
            return null;
        }
        giveBuffer(r.stateBack);
        return { preMask: r.preMask, hit: r.hit, managed: r.managed, cache: r.cache ?? null };
    } catch (err) {
        return null;
    }
};

// ---------------------------------------------------------------------------
// unified（引擎 GPU 排序）通路的拾取：把 `cpu-pick.ts` 的 O(n) 循环搬进本 worker。
// 与上面两条共用一个 worker、同一套槽位与预算；**失败一律返回 null**，调用方
// （scene/picker.ts）随即退回主线程的原实现 —— 语义不会有第二种结果。
// ---------------------------------------------------------------------------

/** 拾取请求里与几何无关的公共部分（矩阵只传数值，结构化克隆 16 个 float） */
export type WorkerPickCommon = {
    showDeleted: boolean;
    projection: ArrayLike<number>;
    view: ArrayLike<number>;
    worldTransform: ArrayLike<number>;
    width: number;
    height: number;
    near?: number;
    far?: number;
};

/**
 * 深度拾取（'depths' 模式）需要的 opacity 列：惰性同步一次（分块 + 让出宏任务，与 x/y/z 同款）。
 * 身份判定用「列对象身份 + 当时的 activated 标志」——激活会把列的值原地改写（对象不变），
 * 所以 activated 变了也算脏。失败返回 false（调用方走主线程回退）。
 */
export const preparePickOpacity = async (splat: Splat): Promise<boolean> => {
    if (!flagOn()) {
        return false;
    }
    const slot = await prepareSlot(splat);
    if (slot == null) {
        return false;
    }
    const data = splat.splatData as any;
    const numSplats = data?.numSplats ?? 0;
    const opacity = data?.getProp?.('opacity') as Float32Array | null;
    const rec = slots.get(splat);
    if (!numSplats || !opacity || !rec) {
        return false;
    }
    const activated = !!data.activated;
    if (rec.srcOpacity === opacity && rec.opacityActivated === activated) {
        return true;
    }
    const bytes = numSplats * 4;
    if (slotBytes + bytes > SLOT_BUDGET_BYTES) {
        return false;
    }

    const co = new Float32Array(numSplats);
    for (let o = 0; o < numSplats; o += SYNC_CHUNK) {
        const e = Math.min(o + SYNC_CHUNK, numSplats);
        co.set(opacity.subarray(o, e), o);
        await yieldMacrotask();
    }

    try {
        const r = await request({ type: 'pick-opacity', slot, gen: ++syncGen, numSplats, opacity: co, activated }, [co.buffer]);
        if (r.error) {
            return false;
        }
    } catch (err) {
        return false;
    }

    // await 期间记录可能已被换掉（模型数据更换）：只认领还是原来那条的记录
    const rec2 = slots.get(splat);
    if (rec2 !== rec) {
        return false;
    }
    if (rec.srcOpacity) {
        slotBytes -= rec.opacityBytes;
    }
    rec.srcOpacity = opacity;
    rec.opacityActivated = activated;
    rec.opacityBytes = bytes;
    slotBytes += bytes;
    return true;
};

/** 发一次拾取请求：state 拷进池化缓冲转移过去，worker 算完原样转移回来。失败返回 null。 */
const pickRequest = async (splat: Splat, payload: Record<string, unknown>, state: Uint8Array): Promise<any | null> => {
    if (!flagOn()) {
        return null;
    }
    const slot = await prepareSlot(splat);
    if (slot == null) {
        return null;
    }
    const buf = takeBuffer(state.length);
    buf.set(state);
    try {
        const r = await request({ type: 'pick', slot, ...payload, state: buf }, [buf.buffer]);
        if (r.state) {
            giveBuffer(r.state);
        }
        if (r.error) {
            return null;
        }
        return r;
    } catch (err) {
        return null;
    }
};

/** 矩形拾取（`readIds` 的矩形/环模式）。返回 ids（行主序，0xFFFFFFFF = 背景）或 null（回退）。 */
export const workerPickRect = async (
    splat: Splat,
    common: WorkerPickCommon,
    state: Uint8Array,
    px0: number,
    py0: number,
    pw: number,
    ph: number
): Promise<{ ids: Uint32Array, tested: number } | null> => {
    const r = await pickRequest(splat, { mode: 'rect', ...common, px0, py0, pw, ph }, state);
    return r ? { ids: r.ids, tested: r.tested ?? 0 } : null;
};

/** 单点拾取（`readId`："半径内最近的候选里取最前"）。返回 id/depth 或 null（回退）。 */
export const workerPickNearest = async (
    splat: Splat,
    common: WorkerPickCommon,
    state: Uint8Array,
    px: number,
    py: number,
    radius: number
): Promise<{ id: number, depth: number } | null> => {
    const r = await pickRequest(splat, { mode: 'nearest', ...common, px, py, radius }, state);
    return r ? { id: r.id, depth: r.depth } : null;
};

/**
 * 深度拾取（`readDepths`）：worker 里先做并集包围盒一趟（带 opacity 记账），落空的采样点
 * 逐个退回 nearest（与主线程原实现同款）。返回按 validIdx 顺序的归一化深度（NaN = 没有表面）
 * 或 null（回退）。opacity 由 `preparePickOpacity` 惰性同步。
 */
export const workerPickDepths = async (
    splat: Splat,
    common: WorkerPickCommon,
    state: Uint8Array,
    pointsX: Int32Array,
    pointsY: Int32Array,
    validIdx: Int32Array,
    px0: number,
    py0: number,
    pw: number,
    ph: number
): Promise<Float32Array | null> => {
    if (!await preparePickOpacity(splat)) {
        return null;
    }
    const r = await pickRequest(splat, { mode: 'depths', ...common, pointsX, pointsY, validIdx, px0, py0, pw, ph }, state);
    return r ? r.depths : null;
};
