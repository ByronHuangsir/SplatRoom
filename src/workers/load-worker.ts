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
    Options,
    WebPCodec,
    WorkerQueue
} from '@playcanvas/splat-transform';

import { computeSplatAabb } from '../core/splat-aabb';
import { importBudget, type DeviceFacts } from '../core/splat-tier';
import { BlobReadFileSystem } from '../io/read/file-systems';
import { permuteColumnsInPlace, sortMortonColumnsFast } from '../io/read/morton-fast';
import { tryMaterializePlyDirect } from '../io/read/ply-direct';
import { makeStridedSource } from '../io/read/strided-source';
import { detectGiantGreyFromColumns } from '../splat/splat-sanitize';

// Mirror the app main-thread setup so the bundled engine + WebP wasm resolve
// correctly inside this worker realm (separate from the main bundle's globals).
WebPCodec.wasmUrl = new URL('static/lib/webp/webp.wasm', self.location.href).toString();
// Force inline WebP decode — avoids spawning a nested worker from inside this
// worker (which would need its own bundling/URL resolution).
WorkerQueue.maxWorkers = 0;

const LOD_MAX_SPLATS = 20_000_000;

// 与 `src/io/read/loader.ts` 里同名函数保持一致：空输入返回 null。
// 这两份是**重复实现**（worker 不能 import 主线程的 io 层），改一处必须改另一处 ——
// 原来两边都少了空数组守卫，`reduce` 无初值会直接抛。
const defaultLodIndex = (lodCounts: readonly number[]): number | null => {
    if (lodCounts.length === 0) {
        return null;
    }
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
    // M3-2：分阶段计时（探针/进度条共用）。phase 消息在**每个阶段结束时**发一条；
    // 汇总也随 result 带回，主线程探针读 `window.__IMPORT_PHASES__`。
    const phases: Record<string, number> = {};
    let phaseT0 = performance.now();
    const markPhase = (name: string) => {
        const now = performance.now();
        phases[name] = (phases[name] ?? 0) + (now - phaseT0);
        phaseT0 = now;
        (self as any).postMessage({ id, type: 'phase', phase: name, ms: phases[name] });
    };
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
        markPhase('readFile');

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
                // 没有明确层号时才回退；`defaultLodIndex` 现在可能返回 null（元数据里没有任何层），
                // 那种情况下 `selectLod(source, null)` 会拿 null 当层号 —— 明确退回第一层
                const fallbackLod = defaultLodIndex(source.meta.lodCounts);
                single = selectLod(source, lod ?? fallbackLod ?? 0);
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

            // M3-2：朴素 float PLY（未抽稀、单 LOD）走**单遍**物化（记录→命名列直写，
            // 顺手算 morton 顶层范围，逐块报进度）；其余格式/抽稀/多 LOD 一律回退库路径。
            const postProgress = (phase: string, fraction: number) => {
                (self as any).postMessage({ id, type: 'progress', phase, fraction });
            };
            let dataTable: any = null;
            if (!reduction && source.meta.numLods === 1 && inputFormat === 'ply') {
                let lastPost = 0;
                dataTable = await tryMaterializePlyDirect(blob, (fraction: number) => {
                    const now = performance.now();
                    if (now - lastPost >= 100 || fraction >= 1) {
                        lastPost = now;
                        postProgress('materialize', fraction);
                    }
                });
            }
            if (!dataTable) {
                dataTable = await materializeToDataTable(single, pool);
            }
            markPhase('materialize');
            if (!dataTable) {
                (self as any).postMessage({ id, type: 'cancelled' });
                return;
            }

            // morton 重排：判据与主线程 `loadGSplatData()` 完全一致
            // M3-2：排序/重排用 morton-fast（与库语义逐字节一致的基数排序版，两路径共用）
            const isCompressedPly = filename.toLowerCase().endsWith('.compressed.ply');
            if (inputFormat !== 'sog' && !isCompressedPly && !skipReorder) {
                // ⚠️ 这里只按名取 x/y/z 的**临时**引用，不能缓存成 map ——
                // 紧随其后的 permute 会 `column.data = dst` 并把旧缓冲交回池子复用，
                // 缓存下来的旧引用会被后续列的置换结果覆写（实测：统计/包围盒读到错列）。
                // 统计用的 colByName 必须在 permute **之后**重建（本函数下方）。
                const colData = (name: string) => (dataTable.columns.find((c: any) => c.name === name)?.data ?? null);
                const indices = new Uint32Array(dataTable.numRows);
                for (let i = 0; i < indices.length; i++) {
                    indices[i] = i;
                }
                sortMortonColumnsFast(
                    colData('x'), colData('y'), colData('z'),
                    indices, dataTable.extent ?? null
                );
                markPhase('morton');
                let lastPermutePost = 0;
                permuteColumnsInPlace(dataTable.columns, indices, (fraction: number) => {
                    const now = performance.now();
                    if (now - lastPermutePost >= 100 || fraction >= 1) {
                        lastPermutePost = now;
                        postProgress('permute', fraction);
                    }
                });
                markPhase('permute');
            }

            // 列索引（统计 / 包围盒用）—— 必须在 permute 之后构建（见上方警告）
            const colByName = new Map<string, Float32Array>();
            for (const c of dataTable.columns) {
                colByName.set(c.name, c.data as Float32Array);
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

            // 巨型灰高斯检测（第十九/二十轮）：这份统计要扫全部行（1.35 亿那档抽稀后 6000 万行），
            // 原来跑在主线程、占掉约 1.2 s。worker 手上就是同一批列，顺手统计一遍，
            // 主线程就**完全不用**再逐行扫了（只有用户真选"移除/缩小"时才在主线程动数据）。
            let giantSplat: any = null;
            try {
                giantSplat = detectGiantGreyFromColumns({
                    x: colByName.get('x') ?? null,
                    y: colByName.get('y') ?? null,
                    z: colByName.get('z') ?? null,
                    s0: colByName.get('scale_0') ?? null,
                    s1: colByName.get('scale_1') ?? null,
                    s2: colByName.get('scale_2') ?? null,
                    dc0: colByName.get('f_dc_0') ?? null,
                    dc1: colByName.get('f_dc_1') ?? null,
                    dc2: colByName.get('f_dc_2') ?? null,
                    op: colByName.get('opacity') ?? null
                }, dataTable.numRows);
            } catch {
                giantSplat = null;   // 检测失败不影响导入：主线程会走回退扫描
            }
            markPhase('giantSplat');

            // 包围盒（第二十二轮）：引擎构造 `GSplatResource` 时会无条件全表扫一遍算它
            // （6000 万行实测 2.2 s，占主线程），而 worker 手上就是同一批列 —— 在这儿顺手算，
            // 主线程只需把结果填进去（`asset-loader` 里临时接管 `calcAabb`）。
            let aabb: any = null;
            try {
                aabb = computeSplatAabb({
                    x: colByName.get('x') ?? null,
                    y: colByName.get('y') ?? null,
                    z: colByName.get('z') ?? null,
                    s0: colByName.get('scale_0') ?? null,
                    s1: colByName.get('scale_1') ?? null,
                    s2: colByName.get('scale_2') ?? null
                }, dataTable.numRows, false);
            } catch {
                aabb = null;   // 算不出来就让引擎自己算（行为退化，不影响正确性）
            }
            markPhase('aabb');

            (self as any).postMessage(
                { id, type: 'result', numRows: dataTable.numRows, transform: dataTable.transform, columns, reduction, giantSplat, aabb, phases },
                transfer
            );
        } finally {
            pool.destroy();
            for (const s of sources) {
                await s.close();
            }
        }
    } catch (err: any) {
        (self as any).postMessage({ id, type: 'error', message: err?.message ?? String(err), stack: String(err?.stack ?? '').slice(0, 500) });
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
