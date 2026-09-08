/**
 * Runtime LOD (V3) — data-layer helpers.
 *
 * SplatRoom renders every gaussian of a model at once; very large scans
 * (multi-million splats) pay full sort + vertex cost on every camera move.
 * This module builds lower-resolution "proxy" levels with splat-transform's
 * adaptive decimation and swaps the active GSplatData as the camera zooms
 * out (re-using Splat.replaceData).
 *
 * The data layer is pure (no WebGL / Asset), so it can run in a Web Worker
 * and is testable in Node: a Splat's GSplatData columns convert to a
 * splat-transform DataTable, `decimateSourceAdaptive` produces a coarser
 * table, and the result converts back into a GSplatData.
 */
import { Column, DataTable, decimateSourceAdaptive, createChunkDataPool, materializeToDataTable, dataTableToChunkSource } from '@playcanvas/splat-transform';
import { Asset, GSplatData, GSplatResource } from 'playcanvas';

// ---- GSplatData ⇄ DataTable -------------------------------------------------

/** Enumerate a GSplatData's per-vertex float/uchar columns as name + storage. */
const vertexColumns = (data: GSplatData): { name: string; storage: Float32Array | Uint8Array }[] => {
    const props = data.getElement('vertex')?.properties as any[] ?? [];
    const cols: { name: string; storage: Float32Array | Uint8Array }[] = [];
    for (const p of props) {
        const s = p?.storage;
        if (s instanceof Float32Array) {
            cols.push({ name: p.name, storage: s });
        } else if (p?.type === 'uchar' && s instanceof Uint8Array) {
            // state column is carried verbatim (decimate keeps rows as-is)
            cols.push({ name: p.name, storage: s });
        }
    }
    return cols;
};

/**
 * Convert a PlayCanvas GSplatData into a splat-transform DataTable (canonical
 * column order). Non-float/uchar columns (transform palette etc.) are dropped;
 * the caller recreates them on the way back if needed.
 */
export const gsplatDataToDataTable = (data: GSplatData): DataTable => {
    const cols = vertexColumns(data).map(c => new Column(c.name, c.storage));
    return new DataTable(cols);
};

/** Convert a splat-transform DataTable back into a PlayCanvas GSplatData. */
export const dataTableToGsplatData = (table: DataTable, comments: string[] = []): GSplatData => {
    const props = table.columns.map((c: any) => {
        const typed = c.data as Float32Array | Uint8Array;
        const isU8 = typed instanceof Uint8Array;
        return {
            type: isU8 ? 'uchar' : 'float',
            name: c.name,
            byteSize: isU8 ? 1 : 4,
            storage: typed
        };
    });
    return new GSplatData([{ name: 'vertex', count: table.numRows, properties: props }], comments);
};

/**
 * Decimate one GSplatData to an approximate `targetCount` gaussians, keeping
 * the same column set. Pure CPU (splat-transform adaptive decimation); safe to
 * run off the main thread.
 */
export const decimateGsplatData = async (
    source: GSplatData,
    targetCount: number,
    comments: string[] = []
): Promise<GSplatData> => {
    const table = gsplatDataToDataTable(source);
    const chunk = dataTableToChunkSource(table, source.numSplats);
    const pool = createChunkDataPool({ chunkSize: Math.max(source.numSplats, 1) });
    try {
        // splat-transform types the return as the source itself, but the
        // adaptive decimator may wrap it as { source, spill } when a spill
        // target was configured — accept both shapes.
        const out: any = await decimateSourceAdaptive(chunk, pool, { targetCount });
        const coarse = out?.source ?? out;
        const decimated = await materializeToDataTable(coarse, pool);
        return dataTableToGsplatData(decimated, comments);
    } finally {
        pool.destroy();
    }
};
/**
 * Fractions of the original count worth keeping as proxy levels, based on
 * size. Small models need no LOD; the largest get an extra far level.
 * @returns ascending-per-distance fractions, e.g. [0.4, 0.12]; empty = no LOD.
 */
export const planLodFractions = (numSplats: number): number[] => {
    if (numSplats > 2_500_000) return [0.35, 0.10];
    if (numSplats > 900_000) return [0.35];
    return [];
};

// ---- Asset binding (main thread only) ---------------------------------------

/**
 * Wrap a decimated GSplatData into a registered gsplat Asset. Requires a
 * graphics device (main thread). The returned asset is independent: a proxy
 * level the splat can swap to via replaceData without touching the base data.
 */
export const createLodAsset = (
    app: any,
    gsplatData: GSplatData,
    level: number,
    baseName: string
): Asset => {
    const device = app.graphicsDevice;
    const resource = new GSplatResource(device, gsplatData);
    const name = `lod-${baseName}-${level}-${Date.now()}`;
    const asset = new Asset(name, 'gsplat', { url: `lod-${name}`, filename: name });
    asset.resource = resource;
    asset.loaded = true;
    asset.loading = false;
    app.assets.add(asset);
    return asset;
};

/** Build a GSplatData from an explicit row count + column list (worker output). */
export const columnsToGsplatData = (
    count: number,
    columns: { name: string; data: Float32Array | Uint8Array }[],
    comments: string[] = []
): GSplatData => {
    const props = columns.map((c) => {
        const isU8 = c.data instanceof Uint8Array;
        return {
            type: isU8 ? 'uchar' : 'float',
            name: c.name,
            byteSize: isU8 ? 1 : 4,
            storage: c.data
        };
    });
    return new GSplatData([{ name: 'vertex', count, properties: props }], comments);
};

// ---- Web Worker client: decimate on a background thread ---------------------

interface LodLevelResult {
    count: number;
    data: GSplatData;
}

let lodWorker: Worker | null = null;
let lodSeq = 0;
const lodPending = new Map<number, {
    resolve:(levels: { count: number; columns: { name: string; data: Float32Array | Uint8Array }[] }[]) => void;
    reject: (e: any) => void;
    onProgress?: (f: number) => void;
}>();

const lodWorkerUrl = (): string => {
    const base = typeof document !== 'undefined' ? document.baseURI : (self as any).location.href;
    return new URL('lod-worker.js', base).toString();
};

const getLodWorker = (): Worker => {
    if (!lodWorker) {
        lodWorker = new Worker(lodWorkerUrl(), { type: 'module' });
        lodWorker.onmessage = (e: MessageEvent) => {
            const msg = e.data;
            const p = lodPending.get(msg.id);
            if (!p) return;
            if (msg.type === 'lod-progress') {
                p.onProgress?.(msg.progress);
                return;
            }
            lodPending.delete(msg.id);
            if (msg.type === 'lod-result') {
                p.resolve(msg.levels);
            } else if (msg.type === 'lod-error') {
                p.reject(new Error(msg.message || 'lod-worker error'));
            }
        };
        lodWorker.onerror = (e: ErrorEvent) => {
            for (const [id, p] of lodPending) {
                lodPending.delete(id);
                p.reject(new Error(e.message || 'lod-worker error'));
            }
            lodWorker = null;
        };
    }
    return lodWorker;
};

/**
 * Decimate `source` into `fractions.length` proxy levels on a Web Worker and
 * wrap each into a GSplatData (not yet GPU assets). Falls back to the
 * synchronous main-thread path when the worker is unavailable.
 */
export const buildLodLevels = async (
    source: GSplatData,
    fractions: number[],
    comments: string[] = [],
    onProgress?: (f: number) => void
): Promise<LodLevelResult[]> => {
    const N = source.numSplats;
    const targets = fractions.map(f => Math.max(1, Math.round(f * N)));
    // deep copies for transfer (source columns must not be detached)
    const cols = vertexColumns(source).map((c) => {
        const data = c.storage;
        const copy = new (data.constructor as any)(data) as Float32Array | Uint8Array;
        return { name: c.name, data: copy };
    });

    let levels: { count: number; columns: { name: string; data: Float32Array | Uint8Array }[] }[];
    try {
        const worker = getLodWorker();
        levels = await new Promise((resolve, reject) => {
            const id = ++lodSeq;
            lodPending.set(id, { resolve, reject, onProgress });
            try {
                worker.postMessage(
                    { id, type: 'build-lod', N, targets, columns: cols, comments },
                    cols.map(c => c.data.buffer)
                );
            } catch (e) {
                lodPending.delete(id);
                reject(e);
            }
        });
    } catch {
        // worker failed — fall back to the synchronous in-thread path
        levels = [];
        for (const f of fractions) {
            const target = Math.max(1, Math.round(f * N));
            const dec = await decimateGsplatData(source, target, comments);
            const c = vertexColumns(dec);
            levels.push({ count: dec.numSplats, columns: c.map(x => ({ name: x.name, data: x.storage })) });
            onProgress?.((levels.length) / fractions.length);
        }
    }

    return levels.map(lv => ({
        count: lv.count,
        data: columnsToGsplatData(lv.count, lv.columns, comments)
    }));
};

/**
 * Full main-thread pipeline: build proxy GSplatData levels and wrap them into
 * GPU assets ready for Splat.replaceData. Requires the app (graphics device).
 */
export const buildLodAssets = async (
    app: any,
    source: GSplatData,
    fractions: number[],
    baseName: string,
    onProgress?: (f: number) => void
): Promise<{ count: number; asset: Asset }[]> => {
    const levels = await buildLodLevels(source, fractions, source.comments ?? [], onProgress);
    return levels.map((lv, i) => ({
        count: lv.count,
        asset: createLodAsset(app, lv.data, i, baseName)
    }));
};
