/**
 * 一个"按块收集、最后直接拼成 Blob"的 FileSystem，用来自 `splat-transform` 的 writer 拿输出。
 *
 * 为什么需要（docs/audit/00-总结.md 的 A2 尾巴，2026-09-18 用户报的 ④）：
 * `MemoryFileSystem` 在 `close()` 里会把所有分块拼成**一整块连续内存**，于是"导出多大就一次性分配多大"。
 * 用分配跟踪实测（93 万点 / 48 列 SH，输出 231MB）：`MemoryFileSystem.close` 那次是
 * **209.7MB 的单次分配**，同批还有 192MB 池分配 + 59MB×3 分块，18 次共 861.9MB 瞬时。
 * 这个模式随输出体积线性放大 —— 1300 万点就是 700MB+ 的单次分配，正是
 * "Array buffer allocation failed while saving file" 的来源。
 *
 * 这里改成：每块 `slice()` 一份收起来（单次分配最大就是一块），`close()` 什么都不用拼，
 * `blob` 直接 `new Blob(chunks)` —— 浏览器会把块列表当成分段数据，**不需要连续内存**。
 * 字节序列与拼成一块时完全一致（块顺序不变），所以输出字节不变。
 *
 * 注意 `slice()`：序列化器可能复用同一块 scratch 缓冲，直接存引用会拿到被覆盖的内容。
 */
import type { FileSystem, Writer } from '@playcanvas/splat-transform';

class BlobFileWriter implements Writer {
    private chunks: BlobPart[] = [];
    private size = 0;

    get bytesWritten(): number {
        return this.size;
    }

    write(data: Uint8Array): void {
        // 拷贝一份：调用方可能在下一块复用同一个缓冲
        this.chunks.push(data.slice());
        this.size += data.byteLength;
    }

    close(): void {
        // nothing to flush: the chunks ARE the file
    }

    abort(): void {
        this.chunks = [];
        this.size = 0;
    }

    /** 分块拼成的 Blob（不产生 O(输出) 的连续分配）。 */
    get blob(): Blob {
        return new Blob(this.chunks, { type: 'application/octet-stream' });
    }
}

class BlobFileSystem implements FileSystem {
    readonly writers = new Map<string, BlobFileWriter>();

    createWriter(filename: string): Writer {
        const writer = new BlobFileWriter();
        this.writers.set(filename, writer);
        return writer;
    }

    mkdir(_path: string): Promise<void> {
        return Promise.resolve();
    }
}

export { BlobFileSystem, BlobFileWriter };
