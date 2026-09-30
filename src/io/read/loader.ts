/**
 * Unified loader for all splat file formats using splat-transform.
 */

import {
    getInputFormat,
    readFile,
    createChunkDataPool,
    materializeToDataTable,
    selectLod,
    Column,
    ColumnType,
    DataTable,
    Options,
    ChunkSource,
    ReadFileSystem,
    Transform,
    ZipReadFileSystem
} from '@playcanvas/splat-transform';
import { GSplatData } from 'playcanvas';

import { permuteColumnsInPlace, sortMortonColumnsFast } from './morton-fast';
import { makeStridedSource } from './strided-source';
import { importBudget, type DeviceFacts, type ImportBudget } from '../../core/splat-tier';

type LoadResult = {
    gsplatData: GSplatData;
    transform: Transform;
    /** 导入时是否按设备预算抽稀过（`undefined` = 没抽稀） */
    reduction?: {
        from: number;
        to: number;
        tier: string;
        device: string;
        reason: 'within-budget' | 'over-hard-limit' | 'over-device-cap' | 'forced-budget';
    };
};

// 导入选项（都可选；不传 = 今天的原样行为）
type LoadOptions = {
    /** 设备事实：给了就按 `importBudget()` 决定是否抽稀 */
    deviceFacts?: DeviceFacts;
    /** 预算算出来时回调一次（无论是否抽稀），供 UI 决定要不要显示进度条 */
    onBudget?: (budget: ImportBudget) => void;
    /** 抽稀进度（0..1）；只在真的抽稀时调用 */
    onDecimateProgress?: (fraction: number) => void;
    /** M3-2：worker 分阶段计时上报（主线程路径不触发） */
    onPhase?: (phase: string, ms: number) => void;
    /** M3-2：worker 全程进度上报（phase: 'materialize' | 'permute'，fraction 0..1） */
    onLoadProgress?: (phase: string, fraction: number) => void;
    /** 强制不抽稀（探针/回归对照：`window.__SPLATROOM_IMPORT_FULL__ = true`） */
    ignoreBudget?: boolean;
};

// invoked when a file contains multiple LODs. returns the LOD index to load,
// or null to cancel the load.
type PickLod = (lodCounts: readonly number[]) => Promise<number | null>;

// maximum splat count considered reasonable to load, used to select a default
// LOD level for multi-LOD formats (e.g. LCC)
const LOD_MAX_SPLATS = 20_000_000;

// pick the most detailed LOD under the splat limit, or the least detailed
// when all levels exceed it
//
// 空输入返回 `null`（= 没有可选的层）：原来最后那句 `reduce` 没有初值，空数组会直接抛
// `TypeError: Reduce of empty array with no initial value`，而调用点（worker 客户端的 needLod
// 分支）在没有别的兜底时会把整个导入挂到 10 分钟看门狗。返回 null 让调用方能干净地处理。
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

/**
 * Default options for readFile.
 */
const defaultOptions: Options = {
    iterations: 10,
    lodSelect: [],
    unbundled: false,
    lodChunkCount: 512,
    lodChunkExtent: 16
};

/**
 * Map splat-transform column types to GSplatData property types.
 */
const columnTypeToGSplatType = (colType: ColumnType | null): string => {
    switch (colType) {
        case 'int8': return 'char';
        case 'uint8': return 'uchar';
        case 'int16': return 'short';
        case 'uint16': return 'ushort';
        case 'int32': return 'int';
        case 'uint32': return 'uint';
        case 'float32': return 'float';
        case 'float64': return 'double';
        default: return 'float';
    }
};

/**
 * Convert a splat-transform DataTable to PlayCanvas GSplatData.
 */
const dataTableToGSplatData = (dataTable: DataTable): GSplatData => {
    const properties = dataTable.columns.map((col: Column) => ({
        type: columnTypeToGSplatType(col.dataType),
        name: col.name,
        storage: col.data,
        byteSize: col.data.BYTES_PER_ELEMENT
    }));

    const gsplatData = new GSplatData([{
        name: 'vertex',
        count: dataTable.numRows,
        properties
    }]);

    // Support loading 2D splats by adding scale_2 property with almost 0 scale
    if (gsplatData.getProp('scale_0') && gsplatData.getProp('scale_1') && !gsplatData.getProp('scale_2')) {
        const scale2 = new Float32Array(gsplatData.numSplats).fill(Math.log(1e-6));
        gsplatData.addProp('scale_2', scale2);

        // Place the new scale_2 property just after scale_1
        const props = gsplatData.getElement('vertex').properties;
        props.splice(props.findIndex((prop: any) => prop.name === 'scale_1') + 1, 0, props.splice(props.length - 1, 1)[0]);
    }

    return gsplatData;
};

/**
 * Materialize the first source returned by readFile into a DataTable.
 * readFile returns lazy ChunkSource[]; multi-LOD sources (e.g. LCC) are
 * reduced to a single LOD before materializing - chosen by the pickLod
 * callback when supplied, otherwise the most detailed level with a
 * reasonable splat count. Returns null if pickLod cancels the load.
 *
 * Before materializing, the row count is optionally reduced to the device's
 * import budget (see `src/core/splat-tier.ts`): the source stays lazy, so the
 * columns are allocated at the reduced size instead of the full 7 GiB.
 */
const materializeFirst = async (
    sources: ChunkSource[],
    pickLod?: PickLod,
    options?: LoadOptions
): Promise<{ table: DataTable; reduction?: LoadResult['reduction'] } | null> => {
    const source = sources[0];
    const pool = createChunkDataPool({ chunkSize: source.meta.chunkSize });
    try {
        let single = source;
        if (source.meta.numLods > 1) {
            const { lodCounts } = source.meta;
            const lod = pickLod ? await pickLod(lodCounts) : defaultLodIndex(lodCounts);
            if (lod === null) {
                return null;
            }
            single = selectLod(source, lod);
        }

        // 导入预算：只看数量与设备能力，预算之内一个点都不动
        let reduction: LoadResult['reduction'];
        const numGaussians = single.meta.numGaussians;
        if (options?.deviceFacts && !options.ignoreBudget && Number.isFinite(numGaussians)) {
            const budget = importBudget(numGaussians, options.deviceFacts);
            // 运行时覆盖（探针/套件/想手动试的用户）：`window.__SPLATROOM_IMPORT_BUDGET__ = 6000000`
            const forced = Number((globalThis as any).__SPLATROOM_IMPORT_BUDGET__ ?? 0);
            const forcedOverride = Number.isFinite(forced) && forced > 0;
            const target = forcedOverride ? Math.min(forced, numGaussians) : budget.budget;
            const mustReduce = numGaussians > target;
            const reason = mustReduce ?
                (forcedOverride && target !== budget.budget ? 'forced-budget' : budget.reason) :
                'within-budget';
            options.onBudget?.({ ...budget, budget: target, reduced: mustReduce, reason });
            if (mustReduce) {
                single = makeStridedSource(single, target, options.onDecimateProgress);
                reduction = {
                    from: numGaussians,
                    to: target,
                    tier: budget.tier,
                    device: budget.device,
                    reason
                };
            }
        }

        const table = await materializeToDataTable(single, pool);
        return { table, reduction };
    } finally {
        for (const s of sources) {
            await s.close();
        }
        pool.destroy();
    }
};

/**
 * Load a file using splat-transform and convert to GSplatData.
 * Returns null if the user cancels LOD selection.
 * @param filename - The filename to load
 * @param fileSystem - The file system to read from
 * @param skipReorder - Skip morton reordering (for files already in morton order or animation playback)
 * @param pickLod - Invoked when the file contains multiple LODs to choose which to load
 * @param options - 导入选项（设备预算 / 抽稀进度 / 强制全量）
 */
const loadGSplatData = async (
    filename: string,
    fileSystem: ReadFileSystem,
    skipReorder?: boolean,
    pickLod?: PickLod,
    options?: LoadOptions
): Promise<LoadResult | null> => {
    const inputFormat = getInputFormat(filename);
    const lowerFilename = filename.toLowerCase();

    // Handle bundled SOG (.sog extension) - wrap with ZipReadFileSystem
    if (inputFormat === 'sog' && lowerFilename.endsWith('.sog')) {
        const source = await fileSystem.createSource(filename);
        const zipFs = new ZipReadFileSystem(source);
        try {
            const sources = await readFile({
                filename: 'meta.json',
                inputFormat: 'sog',
                options: defaultOptions,
                params: [],
                fileSystem: zipFs
            });
            const materialized = await materializeFirst(sources, pickLod, options);
            if (!materialized) {
                return null;
            }
            return {
                gsplatData: dataTableToGSplatData(materialized.table),
                transform: materialized.table.transform,
                reduction: materialized.reduction
            };
        } finally {
            zipFs.close();
        }
    }

    // Read the file using splat-transform
    const sources = await readFile({
        filename,
        inputFormat,
        options: defaultOptions,
        params: [],
        fileSystem
    });

    const materialized = await materializeFirst(sources, pickLod, options);
    if (!materialized) {
        return null;
    }
    const dataTable = materialized.table;

    // Reorder data into morton order for better render performance.
    // Skip reordering for:
    // - SOG format (already in morton order)
    // - Compressed PLY (already in morton order from write-compressed-ply)
    // - When skipReorder is true (ssproj files are already ordered, animation frames need speed)
    //
    // M3-2：排序/重排与导入 worker 共用 morton-fast（与库 `sortMortonOrder` +
    // `permuteRowsInPlace` 语义逐字节一致的基数排序版，两条导入路径产物保持一致）。
    const isCompressedPly = lowerFilename.endsWith('.compressed.ply');
    if (inputFormat !== 'sog' && !isCompressedPly && !skipReorder) {
        const indices = new Uint32Array(dataTable.numRows);
        for (let i = 0; i < indices.length; i++) {
            indices[i] = i;
        }
        sortMortonColumnsFast(
            dataTable.getColumnByName('x').data as Float32Array,
            dataTable.getColumnByName('y').data as Float32Array,
            dataTable.getColumnByName('z').data as Float32Array,
            indices
        );
        permuteColumnsInPlace(dataTable.columns, indices);
    }

    // Convert to GSplatData
    return {
        gsplatData: dataTableToGSplatData(dataTable),
        transform: dataTable.transform,
        reduction: materialized.reduction
    };
};

/**
 * Validate that GSplatData contains required properties.
 */
const validateGSplatData = (gsplatData: GSplatData): void => {
    const required = [
        'x', 'y', 'z',
        'scale_0', 'scale_1', 'scale_2',
        'rot_0', 'rot_1', 'rot_2', 'rot_3',
        'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity'
    ];

    const missing = required.filter(x => !gsplatData.getProp(x));
    if (missing.length > 0) {
        throw new Error(`This file does not contain gaussian splatting data. The following properties are missing: ${missing.join(', ')}`);
    }
};

export {
    dataTableToGSplatData,
    defaultLodIndex,
    loadGSplatData,
    validateGSplatData,
    type LoadOptions,
    type LoadResult
};
