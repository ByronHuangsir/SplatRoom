/**
 * Browser FileSystem implementation for splat-transform compatibility.
 * Provides FileSystem abstraction for browser file operations.
 */

import { type FileSystem, type Writer } from '@playcanvas/splat-transform';

import { BlobFileWriter } from './blob-file-system';

/**
 * Writer implementation for FileSystemWritableFileStream (File System Access API).
 */
class BrowserFileWriter implements Writer {
    private stream: FileSystemWritableFileStream;
    private cursor: number = 0;
    private ready: Promise<void>;

    constructor(stream: FileSystemWritableFileStream) {
        this.stream = stream;
        this.ready = this.stream.seek(0);
    }

    get bytesWritten(): number {
        return this.cursor;
    }

    async write(data: Uint8Array): Promise<void> {
        await this.ready;
        this.cursor += data.byteLength;
        await this.stream.write(data as unknown as ArrayBuffer);
    }

    async close(): Promise<void> {
        await this.ready;
        await this.stream.truncate(this.cursor);
        await this.stream.close();
    }

    async abort(): Promise<void> {
        await this.ready;
        try {
            await this.stream.abort();
        } catch {
            // already failing — ignore
        }
    }
}

/**
 * Trigger a browser download for a blob.
 */
const triggerDownloadBlob = (blob: Blob, filename: string): void => {
    const url = window.URL.createObjectURL(blob);

    const lnk = document.createElement('a');
    lnk.download = filename;
    lnk.href = url;

    // create a "fake" click-event to trigger the download
    if (document.createEvent) {
        const e = document.createEvent('MouseEvents');
        e.initMouseEvent('click', true, true, window,
            0, 0, 0, 0, 0, false, false, false,
            false, 0, null);
        lnk.dispatchEvent(e);
    } else {
        // @ts-ignore
        lnk.fireEvent?.('onclick');
    }

    window.URL.revokeObjectURL(url);
};

/**
 * Writer implementation that triggers a browser download on close.
 * Uses MemoryFileSystem internally for efficient buffer management.
 */
class BrowserDownloadWriter implements Writer {
    private writer: BlobFileWriter;
    private filename: string;

    constructor(filename: string) {
        this.filename = filename;
        // 2026-09-18（用户报的 ④）：这里原来用 MemoryFileSystem，它的 close() 会把整份输出
        // **拼成一整块连续内存**（实测 93 万点导出 231MB 时就是一次 209.7MB 的单次分配）。
        // 换成按块收集 + 直接拼 Blob：字节序列一样，但不再需要 O(输出) 的连续分配。
        this.writer = new BlobFileWriter();
    }

    get bytesWritten(): number {
        return this.writer.bytesWritten;
    }

    write(data: Uint8Array): void {
        this.writer.write(data);
    }

    close(): void {
        this.writer.close();
        triggerDownloadBlob(this.writer.blob, this.filename);
    }

    abort(): void {
        // discard buffered data without triggering a download
        this.writer.abort();
    }
}

/**
 * FileSystem implementation for browser environments.
 * Supports both File System Access API (stream) and fallback download.
 */
class BrowserFileSystem implements FileSystem {
    private stream?: FileSystemWritableFileStream;
    private filename: string;

    /**
     * Create a BrowserFileSystem.
     * @param filename - The filename for downloads (fallback mode)
     * @param stream - Optional FileSystemWritableFileStream for direct file access
     */
    constructor(filename: string, stream?: FileSystemWritableFileStream) {
        this.filename = filename;
        this.stream = stream;
    }

    createWriter(_filename: string): Writer {
        if (this.stream) {
            return new BrowserFileWriter(this.stream);
        }
        return new BrowserDownloadWriter(this.filename);
    }

    mkdir(_path: string): Promise<void> {
        // No-op in browser - directories not supported
        return Promise.resolve();
    }
}

export { BrowserFileSystem };
