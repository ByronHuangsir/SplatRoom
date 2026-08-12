/**
 * Load worker — runs the heavy splat decode + morton reorder off the main
 * thread. The main thread reads the raw file bytes once (I/O only) and
 * transfers them here; we materialize the splat data and return the column
 * buffers (zero-copy Transferable) so the main thread only wraps them in a
 * PlayCanvas GSplatData and uploads to the GPU.
 *
 * This mirrors the editor's `loadGSplatData` hot path but moves the CPU-bound
 * `materializeToDataTable` + `sortMortonOrder`/`permuteRowsInPlace` into this
 * worker, keeping the UI responsive during 10M+ loads.
 */

import {
    readFile,
    materializeToDataTable,
    createChunkDataPool,
    selectLod,
    sortMortonOrder,
    Options,
    WebPCodec,
    WorkerQueue
} from '@playcanvas/splat-transform';

// Mirror the app main-thread setup so the bundled engine + WebP wasm resolve
// correctly inside this worker realm (separate from the main bundle's globals).
WebPCodec.wasmUrl = new URL('static/lib/webp/webp.wasm', self.location.href).toString();
// Force inline WebP decode — avoids spawning a nested worker from inside this
// worker (which would need its own bundling/URL resolution).
WorkerQueue.maxWorkers = 0;

const LOD_MAX_SPLATS = 20_000_000;

const defaultLodIndex = (lodCounts: readonly number[]): number => {
    const candidates = lodCounts.map((count, index) => ({ count, index }));
    const under = candidates.filter(c => c.count < LOD_MAX_SPLATS);
    if (under.length > 0) {
        return under.reduce((a, b) => (b.count > a.count ? b : a)).index;
    }
    return candidates.reduce((a, b) => (b.count < a.count ? b : a)).index;
};

const defaultOptions: Options = {
    iterations: 10,
    lodSelect: [],
    unbundled: false,
    lodChunkCount: 512,
    lodChunkExtent: 16
};

// ---------------------------------------------------------------------------
// Minimal in-memory ReadFileSystem.
// This exactly mirrors splat-transform's own `MemoryReadFileSystem` /
// `MemoryReadSource` / `MemoryReadStream` (dist/index.mjs) so `readFile` can
// consume a transferred ArrayBuffer without us depending on any unexported
// internal class.
// ---------------------------------------------------------------------------
class MemoryReadStream {
    data: Uint8Array;
    offset: number;
    end: number;
    bytesRead = 0;
    expectedSize: number;
    constructor(data: Uint8Array, start: number, end: number) {
        this.data = data;
        this.offset = start;
        this.end = end;
        this.expectedSize = end - start;
    }
    async pull(target: Uint8Array): Promise<number> {
        const remaining = this.end - this.offset;
        if (remaining <= 0) return 0;
        const n = Math.min(target.length, remaining);
        target.set(this.data.subarray(this.offset, this.offset + n));
        this.offset += n;
        this.bytesRead += n;
        return n;
    }
    async readAll(): Promise<Uint8Array> {
        const capacity = this.expectedSize || 65536;
        let buffer = new Uint8Array(capacity);
        let length = 0;
        while (true) {
            if (length >= buffer.length) {
                const nb = new Uint8Array(buffer.length * 2);
                nb.set(buffer);
                buffer = nb;
            }
            const n = await this.pull(buffer.subarray(length));
            if (n === 0) break;
            length += n;
        }
        return buffer.subarray(0, length);
    }
    close() {
        /* no-op */
    }
}

class MemoryReadSource {
    data: Uint8Array;
    size: number;
    seekable = true;
    constructor(data: ArrayBuffer | Uint8Array) {
        this.data = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        this.size = this.data.length;
    }
    read(start?: number, end?: number): MemoryReadStream {
        const s = start ?? 0;
        const e = end ?? this.data.length;
        return new MemoryReadStream(this.data, s, e);
    }
    close() {
        /* no-op */
    }
}

class MemoryReadFileSystem {
    buffers = new Map<string, ArrayBuffer | Uint8Array>();
    set(name: string, data: ArrayBuffer | Uint8Array) {
        this.buffers.set(name, data);
    }
    get(name: string) {
        return this.buffers.get(name);
    }
    async createSource(filename: string): Promise<MemoryReadSource> {
        const data = this.buffers.get(filename);
        if (!data) throw new Error(`Entry not found: ${filename}`);
        return new MemoryReadSource(data);
    }
}

// ---------------------------------------------------------------------------
// LOD selection bridge: when a file has multiple LODs we ask the main thread
// to resolve which one to load (it may show a popup), then continue.
// ---------------------------------------------------------------------------
const pendingLod = new Map<number, (lod: number | null) => void>();

const requestLod = (id: number, lodCounts: readonly number[]): Promise<number | null> => {
    return new Promise((resolve) => {
        pendingLod.set(id, resolve);
        (self as any).postMessage({ id, type: 'needLod', lodCounts: [...lodCounts] });
    });
};

const materializeFirst = async (sources: any[], lod: number | null): Promise<any> => {
    const source = sources[0];
    const pool = createChunkDataPool({ chunkSize: source.meta.chunkSize });
    try {
        let single = source;
        if (source.meta.numLods > 1) {
            const { lodCounts } = source.meta;
            const idx = lod != null ? lod : defaultLodIndex(lodCounts);
            if (idx === null) return null;
            single = selectLod(source, idx);
        }
        return await materializeToDataTable(single, pool);
    } finally {
        for (const s of sources) await s.close();
        pool.destroy();
    }
};

const handleLoad = async (msg: any) => {
    const { id, filename, buffer, inputFormat, skipReorder } = msg;
    try {
        const memFs = new MemoryReadFileSystem();
        memFs.set(filename, buffer);
        const sources = await readFile({
            filename,
            inputFormat,
            options: defaultOptions,
            params: [],
            fileSystem: memFs
        });
        const source = sources[0];
        let lod: number | null = null;
        if (source.meta.numLods > 1) {
            lod = await requestLod(id, source.meta.lodCounts);
            if (lod === null) {
                (self as any).postMessage({ id, type: 'cancelled' });
                return;
            }
        }
        const dataTable = await materializeFirst(sources, lod);
        if (!dataTable) {
            (self as any).postMessage({ id, type: 'cancelled' });
            return;
        }
        const isCompressedPly = filename.toLowerCase().endsWith('.compressed.ply');
        if (inputFormat !== 'sog' && !isCompressedPly && !skipReorder) {
            const indices = new Uint32Array(dataTable.numRows);
            for (let i = 0; i < indices.length; i++) indices[i] = i;
            sortMortonOrder(dataTable, indices);
            dataTable.permuteRowsInPlace(indices);
        }
        // Slice each column into its own buffer so every transferable is unique
        // (permuteRowsInPlace may otherwise share ArrayBuffers across columns).
        const columns = dataTable.columns.map((c: any) => {
            const copy = c.data.slice();
            return {
                name: c.name,
                dataType: c.dataType,
                ctorName: c.data.constructor.name,
                data: copy.buffer
            };
        });
        const transfer = columns.map((c: any) => c.data);
        (self as any).postMessage(
            { id, type: 'result', numRows: dataTable.numRows, transform: dataTable.transform, columns },
            transfer
        );
    } catch (err: any) {
        (self as any).postMessage({ id, type: 'error', message: err?.message ?? String(err) });
    }
};

(self as any).onmessage = async (e: MessageEvent) => {
    const msg = e.data;
    if (msg.type === 'lod') {
        const p = pendingLod.get(msg.id);
        if (p) {
            pendingLod.delete(msg.id);
            p(msg.lod);
        }
        return;
    }
    if (msg.type === 'load') {
        await handleLoad(msg);
    }
};
