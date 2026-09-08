/**
 * LOD build worker (V3) — decimates a large splat into coarser proxy levels
 * off the main thread. The main thread transfers the source column buffers
 * here (zero-copy), we run splat-transform's adaptive decimation for each
 * requested target count, and transfer every level's columns back. The main
 * thread wraps each level into a GSplatData + gsplat Asset.
 */
import {
    Column, DataTable, createChunkDataPool,
    dataTableToChunkSource, decimateSourceAdaptive,
    materializeToDataTable
} from '@playcanvas/splat-transform';

export interface LodWorkerRequest {
    id: number;
    type: 'build-lod';
    N: number;
    /** Absolute gaussian counts to decimate to, ascending. */
    targets: number[];
    columns: { name: string; data: Float32Array | Uint8Array }[];
    /** Comments carried into each level's GSplatData. */
    comments?: string[];
}

interface LodWorkerResponse {
    id: number;
    type: 'lod-progress';
    progress: number;
}

interface LodWorkerResult {
    id: number;
    type: 'lod-result';
    /** One entry per target, with the decimated columns. */
    levels: { count: number; columns: { name: string; data: Float32Array | Uint8Array }[] }[];
}

self.onmessage = async (e: MessageEvent<LodWorkerRequest>) => {
    const msg = e.data;
    if (msg.type !== 'build-lod') return;
    const { id, columns } = msg;
    const post = (payload: object, transfers?: Transferable[]) => {
        (self as any).postMessage(payload, transfers);
    };

    try {
        const table = new DataTable(columns.map(c => new Column(c.name, c.data)));
        const chunk = dataTableToChunkSource(table, Math.max(msg.N, 1));
        const pool = createChunkDataPool({ chunkSize: Math.max(msg.N, 1) });

        const levels: { count: number; columns: { name: string; data: Float32Array | Uint8Array }[] }[] = [];
        for (let t = 0; t < msg.targets.length; t++) {
            const target = Math.max(1, Math.min(msg.targets[t], msg.N - 1));
            const out: any = await decimateSourceAdaptive(chunk, pool, { targetCount: target });
            const coarse = out?.source ?? out;
            const dec = await materializeToDataTable(coarse, pool);

            post({ id, type: 'lod-progress', progress: (t + 0.6) / msg.targets.length });

            const levelCols = dec.columns.map((c: any) => {
                // transfer the underlying buffer where possible
                const data = c.data;
                return { name: c.name, data };
            });
            levels.push({ count: dec.numRows, columns: levelCols });
        }
        pool.destroy();

        // transfer all level column buffers back in one message
        const transfers: ArrayBuffer[] = [];
        for (const lv of levels) {
            for (const c of lv.columns) transfers.push(c.data.buffer as ArrayBuffer);
        }
        post({ id, type: 'lod-result', levels }, transfers);
    } catch (err) {
        post({ id, type: 'lod-error', message: (err as Error)?.message ?? String(err) });
    }
};
