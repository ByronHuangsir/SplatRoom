/**
 * Main-thread client for the load worker.
 *
 * `loadGSplatDataAsync` is a drop-in replacement for `loadGSplatData`: it reads
 * the raw file bytes on the main thread (I/O only, async) and hands them to the
 * worker, which performs the CPU-bound decode + morton reorder. The result is
 * reconstructed into a PlayCanvas GSplatData on the main thread.
 *
 * Any failure (worker unavailable, transfer error, decode error) transparently
 * falls back to the original synchronous `loadGSplatData` so the feature is
 * safe to enable by default — set `window.__SPLATROOM_NO_LOAD_WORKER__ = true`
 * to disable for A/B testing / debugging.
 */

import { getInputFormat } from '@playcanvas/splat-transform';

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
    filename: string;
    fileSystem: any;
    skipReorder?: boolean;
};

// Feature flag — still opt-in, and that is now a MEASURED requirement rather than an oversight.
//
// docs/audit/00-总结.md 高危 7 pointed out that nothing in the repo sets
// `__SPLATROOM_ENABLE_LOAD_WORKER__`, so the worker never ran and every import decoded on the main
// thread (the ~15s freeze on 13M). Flipping it to "on by default" was tried and **reverted**:
// with the worker enabled, the very same rect gesture selects the whole model instead of the ~10%
// inside the box (measured on the 2000-splat fixture: 2000 selected vs 213, and a depth push then
// yields 0 instead of 202), and the loaded columns are byte-identical either way — so the worker
// output differs in something the column hashes do not capture (centres/sorting metadata). Until
// that is found, enabling it silently corrupts selections, which is far worse than a slow import.
// The 假绿 in lw-probe is fixed (it now requires workerResults > 0), so the worker can be
// validated properly before it is ever turned on for real.
const USE_LOAD_WORKER =
    (typeof window !== 'undefined') && (window as any).__SPLATROOM_ENABLE_LOAD_WORKER__ === true;

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
        (window as any).__LW_WORKER_RESULTS__ = ((window as any).__LW_WORKER_RESULTS__ || 0) + 1;
        const dataTable = {
            columns: msg.columns.map((c: any) => ({
                name: c.name,
                dataType: c.dataType,
                data: new ctorMap[c.ctorName](c.data)
            })),
            numRows: msg.numRows,
            transform: msg.transform
        };
        const gsplatData = dataTableToGSplatData(dataTable as any);
        p.resolve({ gsplatData, transform: msg.transform });
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
 * Async, worker-backed replacement for `loadGSplatData`. Same signature.
 * Returns null when the user cancels LOD selection (multi-LOD files).
 *
 * `options` (设备预算 / 抽稀进度) 只在**主线程降级路径**里生效：worker 分支会把整个文件
 * 读成一个 ArrayBuffer 再 transfer，几 GB 的模型根本走不通（见文件顶部说明），
 * 所以这里不把预算传给 worker，保持原行为。
 */
export const loadGSplatDataAsync = async (
    filename: string,
    fileSystem: any,
    skipReorder?: boolean,
    pickLod?: (lodCounts: readonly number[]) => Promise<number | null>,
    options?: LoadOptions
): Promise<LoadResult | null> => {
    if (!USE_LOAD_WORKER) {
        return loadGSplatData(filename, fileSystem, skipReorder, pickLod, options);
    }

    let buffer: ArrayBuffer;
    try {
        buffer = await readFileBytes(fileSystem, filename);
    } catch {
        // Reading the bytes failed (unsupported FS, etc.) — fall back.
        return loadGSplatData(filename, fileSystem, skipReorder, pickLod, options);
    }

    const inputFormat = getInputFormat(filename);

    const result = new Promise<LoadResult | null>((resolve, reject) => {
        const id = ++msgId;
        pending.set(id, { resolve, reject, pickLod, filename, fileSystem, skipReorder });
        try {
            getWorker().postMessage(
                { id, type: 'load', filename, buffer, inputFormat, skipReorder },
                [buffer]
            );
        } catch {
            pending.delete(id);
            // Transfer failed — fall back to main-thread decode.
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
        }, 120000);
    });

    try {
        return await result;
    } catch {
        // Worker path failed — last-resort main-thread decode.
        return loadGSplatData(filename, fileSystem, skipReorder, pickLod, options);
    }
};
