#!/usr/bin/env node
/**
 * #504 — headless load-decode benchmark.
 *
 * Validates the off-main-thread decode core that `src/workers/load-worker.ts`
 * runs, and measures the per-stage CPU cost (readFile / materialize / morton
 * reorder) that L1 moves off the main thread. Runs the SAME logic the worker
 * uses, so a clean run proves splat-transform decodes correctly in a
 * worker-like (no-DOM) context and that the minimal in-memory ReadFileSystem
 * satisfies its contract.
 *
 * Usage: node scripts/bench-load-worker.mjs <file.ply> [<file2.ply> ...]
 */

import { readFile, getInputFormat, materializeToDataTable, createChunkDataPool, selectLod, sortMortonOrder } from '@playcanvas/splat-transform';
import { readFileSync } from 'node:fs';

const LOD_MAX_SPLATS = 20_000_000;
const defaultLodIndex = (lodCounts) => {
    const c = lodCounts.map((count, index) => ({ count, index }));
    const under = c.filter(x => x.count < LOD_MAX_SPLATS);
    if (under.length > 0) return under.reduce((a, b) => (b.count > a.count ? b : a)).index;
    return c.reduce((a, b) => (b.count < a.count ? b : a)).index;
};
const defaultOptions = { iterations: 10, lodSelect: [], unbundled: false, lodChunkCount: 512, lodChunkExtent: 16 };

// Minimal in-memory ReadFileSystem (mirrors the worker's own implementation).
class MemoryReadStream {
    constructor(data, start, end) { this.data = data; this.offset = start; this.end = end; this.expectedSize = end - start; this.bytesRead = 0; }
    async pull(target) {
        const remaining = this.end - this.offset;
        if (remaining <= 0) return 0;
        const n = Math.min(target.length, remaining);
        target.set(this.data.subarray(this.offset, this.offset + n));
        this.offset += n; this.bytesRead += n; return n;
    }
    async readAll() {
        const cap = this.expectedSize || 65536;
        let buf = new Uint8Array(cap); let len = 0;
        while (true) {
            if (len >= buf.length) { const nb = new Uint8Array(buf.length * 2); nb.set(buf); buf = nb; }
            const n = await this.pull(buf.subarray(len));
            if (n === 0) break; len += n;
        }
        return buf.subarray(0, len);
    }
    close() {}
}
class MemoryReadSource {
    constructor(data) { this.data = data instanceof ArrayBuffer ? new Uint8Array(data) : data; this.size = this.data.length; this.seekable = true; }
    read(start, end) { const s = start ?? 0; const e = end ?? this.data.length; return new MemoryReadStream(this.data, s, e); }
    close() {}
}
class MemoryReadFileSystem {
    constructor() { this.buffers = new Map(); }
    set(name, data) { this.buffers.set(name, data); }
    async createSource(filename) { const data = this.buffers.get(filename); if (!data) throw new Error('not found: ' + filename); return new MemoryReadSource(data); }
}

const materializeFirst = async (sources, lod) => {
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

const decodeBuffer = async (filename, buffer, skipReorder) => {
    const inputFormat = getInputFormat(filename);
    const memFs = new MemoryReadFileSystem();
    memFs.set(filename, buffer);
    const t0 = performance.now();
    const sources = await readFile({ filename, inputFormat, options: defaultOptions, params: [], fileSystem: memFs });
    const t1 = performance.now();
    const source = sources[0];
    let lod = null;
    if (source.meta.numLods > 1) lod = defaultLodIndex(source.meta.lodCounts);
    const dataTable = await materializeFirst(sources, lod);
    const t2 = performance.now();
    const isCompressedPly = filename.toLowerCase().endsWith('.compressed.ply');
    if (inputFormat !== 'sog' && !isCompressedPly && !skipReorder) {
        const indices = new Uint32Array(dataTable.numRows);
        for (let i = 0; i < indices.length; i++) indices[i] = i;
        sortMortonOrder(dataTable, indices);
        dataTable.permuteRowsInPlace(indices);
    }
    const t3 = performance.now();
    return {
        numRows: dataTable.numRows,
        readMs: +(t1 - t0).toFixed(1),
        materializeMs: +(t2 - t1).toFixed(1),
        mortonMs: +(t3 - t2).toFixed(1),
        totalMs: +(t3 - t0).toFixed(1)
    };
};

const main = async () => {
    const files = process.argv.slice(2);
    if (files.length === 0) {
        console.error('usage: node bench-load-worker.mjs <file.ply> [...]');
        process.exit(1);
    }
    console.log('file                    gaussians    read(ms)  materialize(ms)  morton(ms)  total(ms)');
    console.log(''.padEnd(92, '-'));
    for (const f of files) {
        const filename = f.split(/[\\/]/).pop();
        const buffer = readFileSync(f);
        const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        const r = await decodeBuffer(filename, ab, false);
        const name = (filename + ' (' + (ab.byteLength / 1e6).toFixed(1) + 'MB)').padEnd(22);
        console.log(
            name +
            String(r.numRows).padStart(9) +
            String(r.readMs).padStart(11) +
            String(r.materializeMs).padStart(16) +
            String(r.mortonMs).padStart(12) +
            String(r.totalMs).padStart(11)
        );
    }
};

main().catch(e => { console.error('BENCH ERROR:', e); process.exit(1); });
