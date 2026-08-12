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

import {
    loadGSplatData,
    dataTableToGSplatData,
    defaultLodIndex
} from './read/loader';
import { getInputFormat } from '@playcanvas/splat-transform';

type LoadResult = { gsplatData: any; transform: any };

type Pending = {
    resolve: (r: LoadResult | null) => void;
    reject: (e: any) => void;
    pickLod?: (lodCounts: readonly number[]) => Promise<number | null>;
    filename: string;
    fileSystem: any;
    skipReorder?: boolean;
};

// Feature flag — enabled only by setting window.__SPLATROOM_ENABLE_LOAD_WORKER__ = true.
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
        typeof document !== 'undefined'
            ? document.baseURI
            : (self as any).location.href;
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
        return;
    }
};

/**
 * Async, worker-backed replacement for `loadGSplatData`. Same signature.
 * Returns null when the user cancels LOD selection (multi-LOD files).
 */
export const loadGSplatDataAsync = async (
    filename: string,
    fileSystem: any,
    skipReorder?: boolean,
    pickLod?: (lodCounts: readonly number[]) => Promise<number | null>
): Promise<LoadResult | null> => {
    if (!USE_LOAD_WORKER) {
        return loadGSplatData(filename, fileSystem, skipReorder, pickLod);
    }

    let buffer: ArrayBuffer;
    try {
        buffer = await readFileBytes(fileSystem, filename);
    } catch {
        // Reading the bytes failed (unsupported FS, etc.) — fall back.
        return loadGSplatData(filename, fileSystem, skipReorder, pickLod);
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
            loadGSplatData(filename, fileSystem, skipReorder, pickLod)
                .then(resolve)
                .catch(reject);
        }
    });

    try {
        return await result;
    } catch {
        // Worker path failed — last-resort main-thread decode.
        return loadGSplatData(filename, fileSystem, skipReorder, pickLod);
    }
};
