/**
 * V3 streaming-loading helpers — file-native LOD levels.
 *
 * A structural multi-LOD source (`.lod` bundle, streamed `.sog`, `.lcc2`)
 * carries its coarse levels *in the file*, so attaching them as runtime
 * proxies costs no decimation/sampling: after the app has materialized the
 * finest level (LOD 0) for the main view, the coarser levels (LOD 1..n-1,
 * much smaller) are read back from the same source and registered via
 * Splat.setLodAssets. The distance-driven switcher then swaps to file-native
 * low detail when the camera is far — i.e. the browser keeps progressively
 * using lighter data without re-generating proxies.
 */
import { readFile, selectLod, materializeToDataTable, createChunkDataPool, getInputFormat, type ReadFileSystem } from '@playcanvas/splat-transform';

import { columnsToGsplatData, createLodAsset } from './lod';
import type { Splat } from '../splat/splat';

/**
 * Materialise the coarse levels (LOD 1..n-1) of a structural multi-LOD file
 * source into GSplatData layers (skipping LOD 0, which the app already
 * loaded as the main data). Returns [] when the file has a single level.
 */
const materializeCoarseLodLevels = async (
    fileSystem: ReadFileSystem,
    filename: string
): Promise<{ count: number; data: ReturnType<typeof columnsToGsplatData> }[]> => {
    const inputFormat = getInputFormat(filename);
    const sources = await readFile({ filename, inputFormat, options: {}, params: [], fileSystem });
    const src = sources[0];
    try {
        const n = src.meta.numLods;
        if (n <= 1) return [];
        const pool = createChunkDataPool({ chunkSize: src.meta.chunkSize });
        const out: { count: number; data: ReturnType<typeof columnsToGsplatData> }[] = [];
        for (let L = 1; L < n; L++) {
            const level = selectLod(src, L);
            const table = await materializeToDataTable(level, pool);
            const data = columnsToGsplatData(table.numRows, table.columns as any);
            out.push({ count: table.numRows, data });
        }
        pool.destroy();
        return out;
    } finally {
        for (const s of sources) await s.close();
    }
};

/**
 * Register file-native coarse levels onto a splat as runtime LOD proxies.
 * Best-effort: any failure (single-LOD file, unsupported format, read error)
 * is swallowed — the splat simply keeps running at full resolution.
 */
export const attachLodFromFile = async (fileSystem: ReadFileSystem, filename: string, splat: Splat) => {
    if (!splat?.splatData || splat.splatData.numSplats < 900_000) return;
    try {
        const levels = await materializeCoarseLodLevels(fileSystem, filename);
        if (levels.length === 0) return;
        const scene = splat.scene as any;
        const app = scene?.app;
        if (!app) return;
        const assets = levels.map((lv, i) => ({
            numSplats: lv.count,
            asset: createLodAsset(app, lv.data as any, i, splat.name || 'splat')
        }));
        splat.setLodAssets(assets);
    } catch (e) {
        // non-fatal — file has no usable coarse levels or the read failed
        console.warn('[lod] attachLodFromFile skipped:', (e as Error)?.message ?? e);
    }
};
