/**
 * Writer utilities for splat serialization.
 */

import type { Writer } from '@playcanvas/splat-transform';

/**
 * Compress the incoming stream with gzip.
 */
class GZipWriter implements Writer {
    write: (data: Uint8Array) => Promise<void>;
    close: () => Promise<void>;
    abort: () => Promise<void>;

    private cursor = 0;

    get bytesWritten(): number {
        return this.cursor;
    }

    constructor(writer: Writer) {
        const stream = new CompressionStream('gzip');
        const streamWriter = stream.writable.getWriter();
        const streamReader = stream.readable.getReader();

        // hook up the reader side of the compressed stream.
        //
        // 这条 promise 只在 `close()` 里被 await，所以**必须自己带住 rejection**：`abort()` 会让
        // 压缩流的可读侧报错，于是 `streamReader.read()` 抛出的错误没有人接手 ⇒ 未处理的 promise
        // rejection（Electron 里会冒到 devtools/主进程），而且此后调用 `close()` 还会从 `await reader`
        // 位置抛出一个误导性的 `AbortError`，把真实原因盖掉。这里把 rejection 记下来，abort 路径
        // 不产生噪声，close 路径仍然能看到真实的写失败（如果发生过）。
        let readerError: unknown = null;
        const reader = (async () => {
            while (true) {
                const { done, value } = await streamReader.read();
                if (done) break;
                await writer.write(value);
            }
        })().catch((err) => {
            readerError = err;
        });

        this.write = async (data: Uint8Array) => {
            this.cursor += data.byteLength;
            await streamWriter.ready;
            await streamWriter.write(data as unknown as ArrayBuffer);
        };

        this.close = async () => {
            // close the writer, we're done
            await streamWriter.close();

            // wait for the reader to finish sending data（它的 rejection 已在上面接住；
            // 若读者真的失败了，这里把**真实原因**抛出去，而不是让 AbortError 盖掉它）
            await reader;
            if (readerError) {
                throw readerError;
            }
        };

        this.abort = async () => {
            try {
                await streamWriter.abort();
            } catch {
                // already failing — ignore
            }
            try {
                await writer.abort();
            } catch {
                // already failing — ignore
            }
            // 等读者那条 promise 落地（它的错误已经被接住），避免它在我们返回之后才拒绝
            await reader;
        };
    }
}

/**
 * Wrapper that tracks write progress.
 */
class ProgressWriter implements Writer {
    write: (data: Uint8Array) => Promise<void>;
    close: () => void;
    abort: () => Promise<void>;

    private cursor = 0;

    get bytesWritten(): number {
        return this.cursor;
    }

    constructor(writer: Writer, totalBytes: number, progress?: (progress: number, total: number) => void) {
        this.write = async (data: Uint8Array) => {
            this.cursor += data.byteLength;
            await writer.write(data);
            progress?.(this.cursor, totalBytes);
        };

        this.close = () => {
            if (this.cursor !== totalBytes) {
                throw new Error(`ProgressWriter: expected ${totalBytes} bytes, but wrote ${this.cursor} bytes`);
            }
            progress?.(this.cursor, totalBytes);
        };

        this.abort = async () => {
            try {
                await writer.abort();
            } catch {
                // already failing — ignore
            }
        };
    }
}

export { GZipWriter, ProgressWriter };
