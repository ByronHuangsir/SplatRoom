// Reproduce the surface-refine issue on the user's real model.
// Loads the PLY with splat-transform, runs the surface worker pipeline
// (dist/surface-worker.js) with a mocked self, and reports what happens.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const [, , plyPath, outJson] = process.argv;

// ---- Minimal MemoryReadFileSystem (mirrors load-worker.ts) ----
class MemoryReadStream {
    constructor(data, start = 0, end) {
        this.data = data;
        this.offset = start;
        this.end = end ?? data.length;
        this.expectedSize = (end ?? data.length) - start;
        this.bytesRead = 0;
    }
    async pull(target) {
        const remaining = this.end - this.offset;
        if (remaining <= 0) return 0;
        const n = Math.min(target.length, remaining);
        target.set(this.data.subarray(this.offset, this.offset + n));
        this.offset += n;
        this.bytesRead += n;
        return n;
    }
    async readAll() {
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
    close() {}
}
class MemoryReadSource {
    constructor(data) {
        this.data = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        this.size = this.data.length;
        this.seekable = true;
    }
    read(start = 0, end) {
        const s = start ?? 0;
        return new MemoryReadStream(this.data, s, end ?? this.data.length);
    }
    close() {}
}
class MemoryReadFileSystem {
    buffers = new Map();
    set(name, data) { this.buffers.set(name, data); }
    async createSource(filename) {
        const data = this.buffers.get(filename);
        if (!data) throw new Error(`Entry not found: ${filename}`);
        return new MemoryReadSource(data);
    }
}

const splatTransform = await import('@playcanvas/splat-transform');
const { GSplatData } = await import('playcanvas');
const { readFile: rf, materializeToDataTable, createChunkDataPool } = splatTransform;

const buf = await readFile(plyPath);
const memFs = new MemoryReadFileSystem();
memFs.set('model.ply', buf);

const inputFormat = splatTransform.getInputFormat('model.ply');
console.log('inputFormat:', inputFormat, 'size:', buf.length);

const sources = await rf({
    filename: 'model.ply',
    inputFormat,
    options: { iterations: 10, lodSelect: [], unbundled: false, lodChunkCount: 512, lodChunkExtent: 16 },
    params: [],
    fileSystem: memFs
});
console.log('readFile done, sources:', sources.length);
const source = sources[0];
console.log('numLods:', source.meta.numLods, 'chunkSize:', source.meta.chunkSize);

const pool = createChunkDataPool({ chunkSize: source.meta.chunkSize });
const dataTable = await materializeToDataTable(source, pool);

// Manually convert DataTable -> GSplatData (mirrors loader.ts dataTableToGSplatData)
const typeMap = { float32: 'float', uint8: 'uchar', uint16: 'ushort', uint32: 'uint', int8: 'char', int16: 'short', int32: 'int' };
const properties = dataTable.columns.map((col) => ({
    type: typeMap[col.dataType] ?? 'float',
    name: col.name,
    storage: col.data,
    byteSize: col.data.BYTES_PER_ELEMENT
}));
const gsplatData = new GSplatData([{ name: 'vertex', count: dataTable.numRows, properties }]);
if (gsplatData.getProp('scale_0') && gsplatData.getProp('scale_1') && !gsplatData.getProp('scale_2')) {
    const scale2 = new Float32Array(gsplatData.numSplats).fill(Math.log(1e-6));
    gsplatData.addProp('scale_2', scale2);
}
const N = gsplatData.numSplats;
console.log('numSplats:', N);
console.log('props:', gsplatData.elements[0].properties.map(p => p.name).join(','));
await source.close();

// ---- 2. extract columns ----
const getFloat = (name) => gsplatData.getProp(name);
const x = getFloat('x'), y = getFloat('y'), z = getFloat('z');
const s0 = getFloat('scale_0'), s1 = getFloat('scale_1'), s2 = getFloat('scale_2');
const r0 = getFloat('rot_0'), r1 = getFloat('rot_1'), r2 = getFloat('rot_2'), r3 = getFloat('rot_3');
const op = getFloat('opacity');
let state = gsplatData.getProp('state');
const known = new Set(['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3', 'opacity', 'state']);
const extra = [];
for (const el of gsplatData.elements) {
    for (const p of el.properties) {
        if (known.has(p.name)) continue;
        if (p.storage instanceof Float32Array) extra.push({ name: p.name, data: p.storage });
    }
}
console.log('extra columns:', extra.map(c => c.name).join(',') || '(none)');
if (!state) {
    console.log('NOTE: no state column — creating zero-filled');
    state = new Uint8Array(N);
}

// ---- 3. mock worker and run ----
let captured = null;
const progressLog = [];
globalThis.self = {
    location: { href: 'file:///D:/DeepSeek/SplatRoomV2/SplatRoomV2-5/dist/index.html' },
    postMessage: (payload) => {
        if (payload.type === 'refine-progress') {
            progressLog.push(payload.progress);
            return;
        }
        captured = payload;
    },
    onmessage: null
};

const code = await readFile(new URL('../dist/surface-worker.js', import.meta.url), 'utf8');
const tmp = new URL('../dist/.real-model-worker.mjs', import.meta.url);
await writeFile(tmp, code, 'utf8');
const mod = await import(pathToFileURL(fileURLToPath(tmp)).href);

const input = {
    id: 1,
    type: 'refine',
    options: { strength: 0.6, edgeSplit: true, removeScatter: true, targetSplitSize: 0 },
    x, y, z, s0, s1, s2, r0, r1, r2, r3, op,
    state,
    extra,
    N
};

console.log('starting worker pipeline (real model)...');
const t0 = performance.now();
globalThis.self.onmessage({ data: input });

let waited = 0;
while (!captured && waited < 600) {
    await new Promise(r => setTimeout(r, 100));
    waited++;
}
const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
const out = captured;
if (!out) {
    console.error(`FAIL: worker never posted after ${elapsed}s`);
    process.exit(1);
}
console.log(`worker posted after ${elapsed}s`);
console.log('progress messages:', progressLog.length, 'first:', progressLog[0]?.toFixed(2), 'last:', progressLog[progressLog.length - 1]?.toFixed(2));
console.log('flattened:', out.flattened, 'splitAdded:', out.splitAdded, 'removed:', out.removed);
console.log('outlierCount:', out.outlierCount, 'surfaceCount:', out.surfaceCount);
console.log('totalBefore:', out.totalBefore, 'totalAfter:', out.totalAfter, 'outCount:', out.outCount);

if (outJson) {
    const summary = {
        ply: plyPath,
        numSplats: N,
        elapsedSec: parseFloat(elapsed),
        flattened: out.flattened,
        splitAdded: out.splitAdded,
        removed: out.removed,
        outlierCount: out.outlierCount,
        surfaceCount: out.surfaceCount,
        totalBefore: out.totalBefore,
        totalAfter: out.totalAfter
    };
    await writeFile(outJson, JSON.stringify(summary, null, 2), 'utf8');
    console.log('saved:', outJson);
}

// sanity: no NaN in output columns
const names = ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3', 'opacity'];
let nan = 0;
for (const n of names) {
    const a = out[n];
    if (!a) { console.error('MISSING col', n); nan++; continue; }
    for (let i = 0; i < out.outCount; i++) {
        if (Number.isNaN(a[i])) { nan++; if (nan < 5) console.log('NaN at', n, i); }
    }
}
console.log('NaN count:', nan);
process.exit(nan === 0 ? 0 : 1);
