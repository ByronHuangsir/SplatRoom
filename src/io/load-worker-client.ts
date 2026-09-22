/**
 * Main-thread client for the load worker.
 *
 * `loadGSplatDataAsync` is a drop-in replacement for `loadGSplatData`: it hands the
 * worker the raw `File`/`Blob` (structured clone — no byte copy) and the worker does
 * the I/O, decode, optional strided decimation and morton reorder itself, posting the
 * column buffers back as Transferables. The result is reconstructed into a PlayCanvas
 * GSplatData here.
 *
 * 两个必须记住的边界规矩：
 *   • **类实例过不了结构化克隆**（只留自有属性、丢原型）。`Transform` 里的 `Quat`
 *     到这里是普通对象，而 `setLocalRotation()` 用 `instanceof Quat` 分流 —— 必须
 *     用 `rehydrateTransform()` 还原，否则旋转矩阵整块 NaN（模型不显示、体工具
 *     体积 NaN、框选为空）。第十六轮的实测回归见 docs/verify/verify-import-worker.cjs。
 *   • 任意失败（worker 不可用 / 传输失败 / 解码失败）都透明回退到同步的
 *     `loadGSplatData`，所以默认打开是安全的；逃生开关是
 *     `window.__SPLATROOM_ENABLE_LOAD_WORKER__ = false`（**模块顶层读一次**，
 *     要在页面脚本执行前设好，探针用 `page.evaluateOnNewDocument`）。
 */

import { getInputFormat, Transform } from '@playcanvas/splat-transform';
import { Quat, Vec3 } from 'playcanvas';

import {
    loadGSplatData,
    dataTableToGSplatData,
    defaultLodIndex,
    type LoadOptions
} from './read/loader';

type LoadResult = {
    gsplatData: any;
    transform: any;
    /** 导入时按设备预算抽稀过才有（见 src/core/splat-tier.ts） */
    reduction?: { from: number; to: number; tier: string; device: string; reason: string };};

type Pending = {
    resolve: (r: LoadResult | null) => void;
    reject: (e: any) => void;
    pickLod?: (lodCounts: readonly number[]) => Promise<number | null>;
    /** 抽稀进度回调（worker 里逐块上报） */
    onProgress?: (fraction: number) => void;
    /** 导入预算判定回调（worker 在抽稀前上报，与主线程路径同一个形状） */
    onBudget?: (budget: any) => void;
    filename: string;
    fileSystem: any;
    skipReorder?: boolean;
};

/**
 * 把 worker 传回来的 `Transform` 还原成真正的类实例。
 *
 * **这是必须的，不是洁癖**：结构化克隆只保留自有属性、丢掉原型，所以到主线程的
 * `transform.rotation` 是个普通对象。而 `GraphNode.setLocalRotation()` 用
 * `x instanceof Quat` 分流，非 Quat 会走 `localRotation.set(obj, undefined, undefined, undefined)`
 * ⇒ 四元数变成 (obj, NaN, NaN, NaN) ⇒ 旋转矩阵整块 NaN（第十六轮实测：模型不显示、
 * 体工具体积 NaN、框选一个点都选不到）。`Vec3` 同理（`copy()` 会丢）。
 */
const rehydrateTransform = (t: any): any => {
    if (!t) {
        return t;
    }
    const tr = t.translation;
    const ro = t.rotation;
    if (!ro) {
        return t;
    }
    return new Transform(
        new Vec3(tr?.x ?? 0, tr?.y ?? 0, tr?.z ?? 0),
        new Quat(ro.x ?? 0, ro.y ?? 0, ro.z ?? 0, ro.w ?? 1),
        typeof t.scale === 'number' ? t.scale : 1
    );
};

// Feature flag. 第十五轮起**默认开启**（worker 收 `Blob` 自己分块读，
// 不再要主线程整块读文件），逃生开关：`window.__SPLATROOM_ENABLE_LOAD_WORKER__ = false`。
//
// 历史（HANDOFF 58）：旧版默认开启过一次又回滚 —— 同一次框选手势会选满整模
// （2000 点夹具实测 2000 vs 213，列字节完全相同）。那一版把整文件读成一个
// ArrayBuffer 再 transfer，几 GB 的模型根本走不通；本版改成传 Blob 之后
// **必须重新验证**：`docs/verify/verify-import-worker.cjs` 会逐列比对
// "worker 导入 vs 主线程导入"的字节，并各做一次框选手势比较选中集。
const USE_LOAD_WORKER =
    (typeof window !== 'undefined') && (window as any).__SPLATROOM_ENABLE_LOAD_WORKER__ !== false;

const ctorMap: Record<string, any> = {
    Int8Array,
    Uint8Array,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array
};

let worker: Worker | null = null;
let msgId = 0;
const pending = new Map<number, Pending>();

const workerUrl = (): string => {
    const base =
        typeof document !== 'undefined' ?
            document.baseURI :
            (self as any).location.href;
    return new URL('load-worker.js', base).toString();
};

const getWorker = (): Worker => {
    if (!worker) {
        worker = new Worker(workerUrl(), { type: 'module' });
        worker.onmessage = (e: MessageEvent) => {
            void handleWorkerMessage(e);
        };
        worker.onerror = (e: ErrorEvent) => {
            // Worker failed to load / crashed — reject everything so each caller
            // falls back to the main-thread decode.
            const err = new Error(e.message || 'load-worker error');
            for (const [id, p] of pending) {
                pending.delete(id);
                p.reject(err);
            }
        };
    }
    return worker;
};

const readFileBytes = async (fileSystem: any, filename: string): Promise<ArrayBuffer> => {
    const source = await fileSystem.createSource(filename);
    try {
        const stream = source.read();
        const bytes = await stream.readAll();
        // `readAll` may return an over-allocated view; copy out the exact span
        // so the worker sees precisely the file bytes.
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    } finally {
        source.close();
    }
};

const handleWorkerMessage = async (e: MessageEvent) => {
    const msg = e.data;
    const p = pending.get(msg.id);
    if (!p) return;

    if (msg.type === 'needLod') {
        const lod = p.pickLod ? await p.pickLod(msg.lodCounts) : defaultLodIndex(msg.lodCounts);
        getWorker().postMessage({ id: msg.id, type: 'lod', lod });
        return;
    }

    if (msg.type === 'result') {
        pending.delete(msg.id);
        // 两个探针可读的全局：走了几次 worker、worker 原样传回来的 transform
        // （套件用后者证明"普通对象 → 还原成 Quat"这一步真的发生了）
        (window as any).__LW_WORKER_RESULTS__ = ((window as any).__LW_WORKER_RESULTS__ || 0) + 1;
        (window as any).__LW_LAST_TRANSFORM__ = msg.transform;
        const transform = rehydrateTransform(msg.transform);
        const dataTable = {
            columns: msg.columns.map((c: any) => ({
                name: c.name,
                dataType: c.dataType,
                data: new ctorMap[c.ctorName](c.data)
            })),
            numRows: msg.numRows,
            transform
        };
        const gsplatData = dataTableToGSplatData(dataTable as any);
        p.resolve({ gsplatData, transform, reduction: msg.reduction ?? undefined });
        return;
    }

    if (msg.type === 'budget') {
        // worker 在开始抽稀前报上来的导入预算判定（与主线程路径同一个 `importBudget()`）：
        // UI 靠它把 spinner 换成带文字的进度条、并记下 `splat.importReduction`
        p.onBudget?.(msg.budget);
        return;
    }

    if (msg.type === 'progress') {
        p.onProgress?.(msg.fraction);
        return;
    }

    if (msg.type === 'cancelled') {
        pending.delete(msg.id);
        p.resolve(null);
        return;
    }

    if (msg.type === 'error') {
        pending.delete(msg.id);
        p.reject(new Error(msg.message));

    }
};

/**
 * Async, worker-backed replacement for `loadGSplatData`.
 * Returns null when the user cancels LOD selection (multi-LOD files).
 *
 * 第十五轮起 worker 分支**不再整块读文件**：直接把 `Blob`/`File` 结构化克隆给 worker
 * （不复制字节），worker 自己按 4 MB 分块读 + 抽稀 + 物化 + morton 重排，再把列缓冲
 * Transferable 传回来。所以 `options`（设备预算 / 抽稀进度）**两条路径都生效**，
 * 结果也逐步一致（列与顺序逐字节相同）。
 *
 * @param filename - 文件名（worker 内用它做 FS 的键，也是格式判定的依据）
 * @param fileSystem - 主线程的 ReadFileSystem（**只在回退路径用**）
 * @param skipReorder - 跳过 morton 重排（已在序的文件 / 动画帧）
 * @param pickLod - 多 LOD 文件时询问主线程选哪一层
 * @param options - 导入预算 / 抽稀进度 / 强制全量
 * @param blob - 单文件导入时的原始 `File`/`Blob`；给了才走 worker（多文件容器没有它）
 */
export const loadGSplatDataAsync = async (
    filename: string,
    fileSystem: any,
    skipReorder?: boolean,
    pickLod?: (lodCounts: readonly number[]) => Promise<number | null>,
    options?: LoadOptions,
    blob?: Blob | null
): Promise<LoadResult | null> => {
    if (!USE_LOAD_WORKER || !blob) {
        return loadGSplatData(filename, fileSystem, skipReorder, pickLod, options);
    }

    const inputFormat = getInputFormat(filename);

    const result = new Promise<LoadResult | null>((resolve, reject) => {
        const id = ++msgId;
        pending.set(id, { resolve, reject, pickLod, filename, fileSystem, skipReorder, onProgress: options?.onDecimateProgress, onBudget: options?.onBudget });
        try {
            // `Blob` 是结构化克隆的（引用传递，不复制字节）；transfer 列表为空。
            // 手动预算覆盖在主线程读页面全局，随消息带进 worker（worker 读不到页面全局）。
            getWorker().postMessage({
                id,
                type: 'load',
                filename,
                inputFormat,
                skipReorder,
                blob,
                deviceFacts: options?.deviceFacts ?? null,
                useBudget: !options?.ignoreBudget,
                budgetOverride: Number((window as any).__SPLATROOM_IMPORT_BUDGET__ ?? 0) || 0
            });
        } catch {
            pending.delete(id);
            // 克隆失败 —— 回退主线程解码
            loadGSplatData(filename, fileSystem, skipReorder, pickLod, options)
            .then(resolve)
            .catch(reject);
        }
        // Worker hang safety: if the worker stalls (huge file, driver hiccup,
        // crash without onerror) the promise would never settle and the
        // spinner would spin forever. Reject after a generous timeout so the
        // caller falls back to the main-thread decode path. When the worker
        // responds normally, pending is cleared and this timer no-ops.
        setTimeout(() => {
            const entry = pending.get(id);
            if (entry) {
                pending.delete(id);
                entry.reject(new Error('load worker timed out'));
            }
        }, 600000);
    });

    try {
        return await result;
    } catch {
        // Worker path failed — last-resort main-thread decode.
        return loadGSplatData(filename, fileSystem, skipReorder, pickLod, options);
    }
};
