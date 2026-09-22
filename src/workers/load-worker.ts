/**
 * Import worker — 把"读取 → 抽稀 → 物化 → morton 重排"整段搬离主线程。
 *
 * 与旧版的区别（第十五轮交接笔记 HANDOFF 58）：
 *   • 旧版要主线程先把**整个文件读成一个 ArrayBuffer** 再 transfer 进来 —— 对 7 GB 的 PLY
 *     根本不可能（先撞 ~2 GB 的 ArrayBuffer 墙，再回退主线程）；
 *   • 现在**只传 `Blob`/`File`**（结构化克隆，不复制字节、不占额外内存），worker 自己用
 *     `BlobReadFileSystem` 按 4 MB 分块读。于是 1.35 亿高斯那档的 50 多秒主线程占用整个搬走，
 *     峰值内存还少一份整文件副本。
 *
 * 流程与主线程的 `loadGSplatData()` **逐步一致**（这样列数据与顺序才能逐字节相同）：
 *   `readFile()` → （超过设备预算时 `makeStridedSource()` 抽稀）→ `materializeToDataTable()`
 *   → `sortMortonOrder()` + `permuteRowsInPlace()` → 把列缓冲 **Transferable** 传回主线程。
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

import { importBudget, type DeviceFacts } from '../core/splat-tier';
import { BlobReadFileSystem } from '../io/read/file-systems';
import { makeStridedSource } from '../io/read/strided-source';

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
// LOD selection bridge: when a file has multiple LODs we ask the main thread
// to resolve which one to load (it may show a popup), then continue.
// ---------------------------------------------------------------------------
type LodCallback = (lod: number | null) => void;

const pendingLod = new Map<number, LodCallback>();

const requestLod = (id: number, lodCounts: readonly number[]): Promise<number | null> => {
    return new Promise((resolve) => {
        pendingLod.set(id, resolve);
        (self as any).postMessage({ id, type: 'needLod', lodCounts: [...lodCounts] });
    });
};

const handleLoad = async (msg: any) => {
    const { id, filename, inputFormat, skipReorder, blob, deviceFacts, useBudget, budgetOverride } = msg;
    try {
        const memFs = new BlobReadFileSystem();
        memFs.set(filename, blob);

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

        const pool = createChunkDataPool({ chunkSize: source.meta.chunkSize });
        let reduction: { from: number; to: number; tier: string; device: string; reason: string } | null = null;
        try {
            let single = sources[0];
            if (source.meta.numLods > 1) {
                single = selectLod(source, lod ?? defaultLodIndex(source.meta.lodCounts));
            }

            // 导入预算：超过本机能力时**在物化之前**按等距抽样降行数
            // （与主线程路径用的是同一个模块、同一套判定）
            const numGaussians = single.meta.numGaussians;
            if (useBudget && deviceFacts && Number.isFinite(numGaussians)) {
                const budget = importBudget(numGaussians, deviceFacts as DeviceFacts);
                // 手动覆盖由**主线程**读页面全局后随消息传进来（`budgetOverride`）：
                // worker 里读不到页面的 `window.__SPLATROOM_IMPORT_BUDGET__`，
                // 以前这里读 `self.__SPLATROOM_IMPORT_BUDGET__` ⇒ 套件里强制预算只对主线程路径生效，
                // "两条路径同一个预算"那条断言其实是空过的（第十六轮修正）。
                const forced = Number(budgetOverride ?? 0);
                const forcedOverride = Number.isFinite(forced) && forced > 0;
                const target = forcedOverride ? Math.min(forced, numGaussians) : budget.budget;
                const mustReduce = numGaussians > target;
                const reason = mustReduce ?
                    (forcedOverride && target !== budget.budget ? 'forced-budget' : budget.reason) :
                    'within-budget';
                // 主线程的 `loadGSplatData()` 会在这里回调 `onBudget`（UI 换成"正在简化导入"的
                // 带文字进度条 + 记 `splat.importReduction`）。worker 路径要在**真正开始抽稀之前**
                // 把同一份判定送回主线程，否则用户什么提示都看不到（第十六轮实测：
                // 主线程路径 `importReduction = {from:134652397, to:60000000, …}`，worker 路径 null）。
                (self as any).postMessage({
                    id, type: 'budget', budget: { ...budget, budget: target, reduced: mustReduce, reason }
                });
                if (mustReduce) {
                    single = makeStridedSource(single, target, (fraction: number) => {
                        (self as any).postMessage({ id, type: 'progress', fraction });
                    });
                    reduction = {
                        from: numGaussians,
                        to: target,
                        tier: budget.tier,
                        device: budget.device,
                        reason
                    };
                }
            }

            const dataTable = await materializeToDataTable(single, pool);
            if (!dataTable) {
                (self as any).postMessage({ id, type: 'cancelled' });
                return;
            }

            // morton 重排：判据与主线程 `loadGSplatData()` 完全一致
            const isCompressedPly = filename.toLowerCase().endsWith('.compressed.ply');
            if (inputFormat !== 'sog' && !isCompressedPly && !skipReorder) {
                const indices = new Uint32Array(dataTable.numRows);
                for (let i = 0; i < indices.length; i++) {
                    indices[i] = i;
                }
                sortMortonOrder(dataTable, indices);
                dataTable.permuteRowsInPlace(indices);
            }

            // Transfer each column buffer directly. splat-transform's
            // materializeToDataTable and permuteRowsInPlace produce independent,
            // exact-size buffers per column (verified), so no copy is needed —
            // copying would double the peak memory (~3.6GB for a 5M-splat PLY).
            // Only fall back to a slice if a column shares its ArrayBuffer with
            // another (byteOffset/length mismatch) to keep every transferable unique.
            const columns = dataTable.columns.map((c: any) => {
                const data = c.data;
                const buffer = (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) ?
                    data.buffer :
                    data.slice().buffer;
                return {
                    name: c.name,
                    dataType: c.dataType,
                    ctorName: data.constructor.name,
                    data: buffer
                };
            });
            const transfer = columns.map((c: any) => c.data);
            (self as any).postMessage(
                { id, type: 'result', numRows: dataTable.numRows, transform: dataTable.transform, columns, reduction },
                transfer
            );
        } finally {
            pool.destroy();
            for (const s of sources) {
                await s.close();
            }
        }
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
