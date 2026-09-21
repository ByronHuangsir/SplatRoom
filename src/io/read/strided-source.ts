/**
 * "抽稀视口"：把一个惰性 `ChunkSource` 包成**行数更少**的同类源。
 *
 * 干什么用：`1亿gs.ply`（134,652,397 点 × 56 B = 7.02 GiB）今天会在
 * `materializeToDataTable` 处把每一列都物化成 Float32Array（14 列 × 538 MB ≈ 7 GiB），
 * 然后在主线程上做 morton 排序 + `permuteRowsInPlace`，实测导入 > 10 分钟仍未完成、
 * 渲染进程常驻 10.7 GB —— 这就是用户说的"打不开"。
 *
 * 做法：**在物化之前**把行数降下来。本包装器对外宣称 `numGaussians = target`，
 * 内部把每一次读请求（chunk 或 gather）翻译成对底层源的 gather 读，
 * 行号按等距抽样映射 `floor(i * total / target)`。
 * 于是下游 `materializeToDataTable` 只分配 `target` 行的列，峰值内存按比例下降
 * （1.3 亿 → 6000 万点：7.02 GiB → 3.1 GiB；→ 2000 万点：7.02 GiB → 1.05 GiB），
 * 而且**只解码被保留的那些行**（56 B 定长 PLY 的 gather 是按行读字节区间）。
 *
 * 为什么用等距抽样而不是 splat-transform 的 `decimateSourceAdaptive`：
 * 本仓库已有结论（`src/lod/lod.ts:87-94`）：自适应抽稀需要一份完整工作副本，
 * "for tens of millions of splats the copy alone would freeze the UI for minutes"。
 * 抽样只多一份目标大小的列，且能逐块报进度。
 *
 * 约定 / 边界：
 *   • 只用于**单 LOD** 的惰性源（`readFile` 的返回值；它支持 chunk 与 gather 两种选择）。
 *     不要包 `decimateSource` 的输出（那是 stream-once，只能顺序读一遍）。
 *   • `target >= total` 时原样返回底层源（不做任何包装）。
 *   • 保序：映射单调不减，所以下游拿到的仍然是"按原文件顺序"的点云子集。
 */
import type { ChunkData, ChunkSource, ChunkSourceMetadata, ReadRequest } from '@playcanvas/splat-transform';

type StridedSource = ChunkSource & {
    /** 抽样后的行数（= 对外宣称的 numGaussians） */
    readonly targetCount: number;
    /** 原行数 */
    readonly sourceCount: number;
};

/**
 * 包一个等距抽样的只读视口。
 *
 * @param inner - 底层惰性源（会被本视口接管所有权：`close()` 会转发给它）
 * @param targetCount - 保留多少行（≥1；≥ 原行数时直接返回 `inner`）
 * @param onProgress - 可选进度回调（0..1），按"已服务过的目标块数"推进
 * @returns 一个 `ChunkSource`，`meta` 已改写成抽样后的行数
 */
export const makeStridedSource = (
    inner: ChunkSource,
    targetCount: number,
    onProgress?: (fraction: number) => void
): StridedSource => {
    const meta = inner.meta;
    const total = meta.numGaussians;
    const target = Math.max(1, Math.min(Math.floor(targetCount), total));

    if (target >= total) {
        // 不抽稀：直接透传（并补上两个只读字段，方便调用方统一处理）
        return Object.assign(inner, { targetCount: total, sourceCount: total }) as StridedSource;
    }

    const step = total / target;
    const chunkSize = Math.max(1, meta.chunkSize);

    // 目标行 → 源行（单调不减；target <= total 时严格递增）
    const mapRow = (row: number): number => {
        const src = Math.floor(row * step);
        return src >= total ? total - 1 : src;
    };

    // 复用同一块 scratch（每次 read 都是顺序的，不会有重入）
    let scratch = new Uint32Array(chunkSize);

    const outMeta: ChunkSourceMetadata = {
        ...meta,
        numGaussians: target,
        numLods: 1,
        lodCounts: [target],
        numChunks: [Math.ceil(target / chunkSize)]
    };

    const totalChunks = outMeta.numChunks[0];
    let chunksServed = 0;
    const countBuffer = (targetCount_: number) => {
        chunksServed++;
        if (onProgress) onProgress(Math.min(1, chunksServed / totalChunks));
        return targetCount_;
    };

    const read = async (request: ReadRequest): Promise<void> => {
        const { position, geometric, color, other } = request;
        const lod = (request as { lod?: number }).lod ?? 0;

        if ('indices' in request) {
            // gather：把目标行号逐个映射到源行号，再对底层源做一次 gather
            const { indices, indexOffset, count } = request;
            if (scratch.length < count) scratch = new Uint32Array(count);
            for (let i = 0; i < count; i++) {
                scratch[i] = mapRow(indices[indexOffset + i]);
            }
            await inner.read({
                indices: scratch,
                indexOffset: 0,
                count,
                lod,
                position,
                geometric,
                color,
                other
            } as ReadRequest);
            countBuffer(count);
            return;
        }

        // chunk：目标块 [chunkIndex*chunkSize, +count) → 源行 gather
        const chunkIndex = request.chunkIndex;
        const start = chunkIndex * chunkSize;
        const count = Math.max(0, Math.min(chunkSize, target - start));
        if (count === 0) {
            countBuffer(0);
            return;
        }
        if (scratch.length < count) scratch = new Uint32Array(count);
        for (let i = 0; i < count; i++) {
            scratch[i] = mapRow(start + i);
        }
        await inner.read({
            indices: scratch,
            indexOffset: 0,
            count,
            lod,
            position,
            geometric,
            color,
            other
        } as ReadRequest);
        countBuffer(count);
    };

    const result: StridedSource = {
        meta: outMeta,
        targetCount: target,
        sourceCount: total,
        read,
        close: () => inner.close()
    };
    return result;
};

/** 类型再导出，方便调用方给 scratch 缓冲区定型（避免 any）。 */
export type { ChunkData };
