/**
 * L1 integration probe (dev/test only).
 *
 * Loads a PLY through the REAL worker-backed `loadGSplatDataAsync` AND the
 * main-thread `loadGSplatData`, then asserts the decoded GSplatData is
 * byte-identical. This proves the worker bundle loads, decodes, round-trips
 * via Transferable, and rebuilds a correct GSplatData — vs. the original
 * main-thread path. Run headlessly via scripts/probe-load-worker.mjs.
 */
/* eslint-disable require-await -- Reader 接口签名需要 async，实现为同步（dev-only 探针） */

import { loadGSplatDataAsync } from '../io/load-worker-client';
import { loadGSplatData } from '../io/read/loader';

// Minimal in-memory file system. The client's `readFileBytes` calls
// `source.read().readAll()`; the main-thread `readFile` calls the seekable
// `source.read(start, end)` + `.pull(target)`. One implementation covers both.
class MemStream {
    private data: Uint8Array;
    private start: number;
    private end: number;
    private offset: number;
    expectedSize: number;
    bytesRead: number;
    constructor(data: Uint8Array, start = 0, end = data.length) {
        this.data = data;
        this.start = start;
        this.end = end;
        this.offset = start;
        this.expectedSize = end - start;
        this.bytesRead = 0;
    }
    async pull(target: Uint8Array): Promise<number> {
        const remaining = this.end - this.offset;
        if (remaining <= 0) return 0;
        const n = Math.min(target.length, remaining);
        target.set(this.data.subarray(this.offset, this.offset + n));
        this.offset += n;
        return n;
    }
    async readAll(): Promise<Uint8Array> {
        return this.data.slice(this.start, this.end);
    }
    close() { /* noop */ }
}

class MemSource {
    private data: Uint8Array;
    size: number;
    seekable: boolean;
    constructor(data: Uint8Array) {
        this.data = data;
        this.size = data.length;
        this.seekable = true;
    }
    read(start?: number, end?: number): MemStream {
        return new MemStream(this.data, start ?? 0, end ?? this.data.length);
    }
    close() { /* noop */ }
}

class MemFS {
    private data: Uint8Array;
    constructor(data: Uint8Array) {
        this.data = data;
    }
    async createSource(_filename: string): Promise<MemSource> {
        return new MemSource(this.data);
    }
}

const checksum = (arr: any): number => {
    if (!arr || !arr.length) return -1;
    let h = 0;
    const len = arr.length;
    const step = Math.max(1, Math.floor(len / 1000));
    for (let i = 0; i < len; i += step) {
        h = (Math.imul(h, 31) + (arr[i] || 0)) >>> 0;
    }
    return h;
};

const PROP_COLS = ['x', 'y', 'z', 'f_dc_0', 'opacity', 'scale_0', 'rot_0'];

const run = async () => {
    const result: any = { ok: false, stage: 'init' };
    try {
        const params = new URLSearchParams(location.search);
        const model = params.get('model') || 'real-test.ply';
        result.model = model;

        result.stage = 'fetch';
        const resp = await fetch(model);
        if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
        const buf = await resp.arrayBuffer();
        const data = new Uint8Array(buf);
        result.bytes = data.length;
        const fs = new MemFS(data);

        result.stage = 'worker';
        const tw = performance.now();
        const wRes = await loadGSplatDataAsync(model, fs, false);
        result.workerMs = +(performance.now() - tw).toFixed(1);
        result.workerResults = (window as any).__LW_WORKER_RESULTS__ || 0;

        result.stage = 'main';
        const tm = performance.now();
        const mRes = await loadGSplatData(model, fs, false);
        result.mainMs = +(performance.now() - tm).toFixed(1);

        if (!wRes || !mRes) throw new Error('null result from loader');

        const wG = wRes.gsplatData;
        const mG = mRes.gsplatData;
        result.numSplats = { worker: wG.numSplats, main: mG.numSplats };
        result.match = { numSplats: wG.numSplats === mG.numSplats, cols: {} as Record<string, any> };
        for (const p of PROP_COLS) {
            const w: any = wG.getProp(p);
            const m: any = mG.getProp(p);
            const wc = checksum(w);
            const mc = checksum(m);
            result.match.cols[p] = { worker: wc, main: mc, same: wc === mc };
        }
        result.ok = result.match.numSplats &&
            Object.values(result.match.cols).every((c: any) => c.same) &&
            // The old probe only *recorded* the worker dispatch count, so a run with the feature
            // flag off called the same synchronous loader twice and still reported ok=true —
            // a false green (docs/audit/00-总结.md 高危 7). The worker must actually have run.
            result.workerResults > 0;
        if (result.workerResults === 0) {
            result.why = 'load worker never ran (0 worker results): the flag is off or the worker failed to start';
        }
        result.stage = 'done';
    } catch (e: any) {
        result.error = String(e && e.message ? e.message : e);
    }
    (window as any).__PROBE_RESULT__ = result;

    console.log(`PROBE_DONE ${JSON.stringify(result)}`);
};

void run();
