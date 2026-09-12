import {
    createChunkDataPool,
    getInputFormat,
    getOutputFormat,
    MemoryFileSystem,
    MemoryReadFileSystem,
    readFile,
    writeSource,
    WebPCodec,
    WorkerQueue
} from '@playcanvas/splat-transform';
import { createGraphicsDevice } from 'playcanvas';

import { webgpuTranspilerUrls } from '../core/gpu-backend';

/**
 * 格式工厂（邵青）— SplatRoom 工具菜单模块 2。
 *
 * 浏览器内 3D 高斯格式转换器，基于 @playcanvas/splat-transform 3.x：
 *   📥 读  PLY / Compressed PLY / SOG / SPZ / SPLAT / KSPLAT / LCC / LCC2
 *   📤 写  PLY / Compressed PLY / SPLAT / SPZ / SOG(bundle) / CSV / GLB
 *
 * 支持：
 *   - 单文件转换（选中 1 个文件 → 直接下载）
 *   - 批量转换（选中 N 个文件 → 串行转换，失败不中断，完成后打包 ZIP 一次下载）
 *
 * 独立窗口入口：`?mode=splatfactory`（src/main.ts 分支）。
 */

// 显式指定 SOG writer 的 WebP worker 及其 wasm 的 URL（基于页面地址）。
// bundle 里的 `new URL('./worker.mjs', import.meta.url)` 在 rollup 下保留原样，
// 依赖 dist/worker.mjs 恰好存在；这里显式设置后无论 http/file 协议都稳定，
// 避免 module worker 404 时静默挂起（进度卡 45% 的根因）。
const sfBase = new URL('.', window.location.href).toString();
WorkerQueue.workerUrl = new URL('worker.mjs', sfBase).toString();
WebPCodec.wasmUrl = new URL('lib/webp.wasm', sfBase).toString();

// ---------- formats ----------

const READ_ACCEPT = '.ply,.splat,.spz,.sog,.ksplat,.lcc,.lcc2,.mjs,.csv';

const OUTPUT_FORMATS: { id: string; label: string; ext: string; needsGpu: boolean }[] = [
    { id: 'ply', label: 'PLY（标准）', ext: '.ply', needsGpu: false },
    { id: 'compressed-ply', label: 'Compressed PLY（压缩）', ext: '.compressed.ply', needsGpu: false },
    { id: 'splat', label: 'SPLAT（Antimatter15）', ext: '.splat', needsGpu: false },
    { id: 'csv', label: 'CSV（调试/分析）', ext: '.csv', needsGpu: false },
    { id: 'sog-bundle', label: 'SOG（PlayCanvas 单文件）', ext: '.sog', needsGpu: true },
    { id: 'spz', label: 'SPZ（Niantic 压缩）', ext: '.spz', needsGpu: true },
    { id: 'glb', label: 'GLB（gLTF 高斯扩展）', ext: '.glb', needsGpu: true }
];

const ACCEPT_EXTS = new Set(READ_ACCEPT.split(',').map(s => s.trim().toLowerCase()));

// ---------- DOM helpers ----------

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
};

const fmtBytes = (n: number) => {
    if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${n} B`;
};

const downloadBlob = (name: string, data: Uint8Array) => {
    const blob = new Blob([data.buffer as ArrayBuffer]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
};

// ---------- minimal ZIP writer (STORE, no external deps) ----------
// Splat 数据本身已是压缩/二进制格式，STORE 模式（无压缩）速度最快且体积 ≈ 原文件总和。

const crc32 = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return (data: Uint8Array): number => {
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
        return (crc ^ 0xFFFFFFFF) >>> 0;
    };
})();

const buildZip = (entries: { name: string; data: Uint8Array }[]): Uint8Array => {
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    const DOS_DATE = 0x5000; // 2021-01-01, hour=0
    let offset = 0;

    for (const e of entries) {
        const nameBytes = enc.encode(e.name);
        const crc = crc32(e.data);
        const size = e.data.length;

        // local file header: 30 bytes + name
        const lh = new DataView(new ArrayBuffer(30));
        lh.setUint32(0, 0x04034b50, true);   // signature
        lh.setUint16(4, 20, true);           // version needed
        lh.setUint16(6, 0x0800, true);       // flags: UTF-8 filename
        lh.setUint16(8, 0, true);            // method: STORE
        lh.setUint16(10, 0, true);           // mod time
        lh.setUint16(12, DOS_DATE, true);    // mod date
        lh.setUint32(14, crc, true);
        lh.setUint32(18, size, true);
        lh.setUint32(22, size, true);
        lh.setUint16(26, nameBytes.length, true);
        lh.setUint16(28, 0, true);           // extra len
        parts.push(new Uint8Array(lh.buffer), nameBytes, e.data);

        // central directory header: 46 bytes + name
        const ch = new DataView(new ArrayBuffer(46));
        ch.setUint32(0, 0x02014b50, true);   // signature
        ch.setUint16(4, 20, true);           // version made by
        ch.setUint16(6, 20, true);           // version needed
        ch.setUint16(8, 0x0800, true);       // flags: UTF-8 filename
        ch.setUint16(10, 0, true);           // method: STORE
        ch.setUint16(12, 0, true);           // mod time
        ch.setUint16(14, DOS_DATE, true);    // mod date
        ch.setUint32(16, crc, true);
        ch.setUint32(20, size, true);
        ch.setUint32(24, size, true);
        ch.setUint16(28, nameBytes.length, true);
        ch.setUint16(30, 0, true);           // extra len
        ch.setUint16(32, 0, true);           // comment len
        ch.setUint16(34, 0, true);           // disk number
        ch.setUint16(36, 0, true);           // internal attrs
        ch.setUint32(38, 0, true);           // external attrs
        ch.setUint32(42, offset, true);      // local header offset
        central.push(new Uint8Array(ch.buffer), nameBytes);

        offset += 30 + nameBytes.length + size;
    }

    const cdStart = offset;
    const cdSize = central.reduce((a, b) => a + b.length, 0);

    // end of central directory: 22 bytes
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);   // signature
    eocd.setUint16(4, 0, true);            // disk number
    eocd.setUint16(6, 0, true);            // cd start disk
    eocd.setUint16(8, entries.length, true);
    eocd.setUint16(10, entries.length, true);
    eocd.setUint32(12, cdSize, true);
    eocd.setUint32(16, cdStart, true);
    eocd.setUint16(20, 0, true);           // comment len

    const out = new Uint8Array(cdStart + cdSize + 22);
    let p = 0;
    for (const part of parts) {
        out.set(part, p); p += part.length;
    }
    for (const part of central) {
        out.set(part, p); p += part.length;
    }
    out.set(new Uint8Array(eocd.buffer), p);
    return out;
};

// zip 条目名唯一化（同名输出加序号后缀）
const uniqueName = (name: string, used: Set<string>): string => {
    let n = name;
    let i = 1;
    while (used.has(n)) {
        const dot = name.lastIndexOf('.');
        n = dot > 0 ? `${name.slice(0, dot)} (${i})${name.slice(dot)}` : `${name} (${i})`;
        i++;
    }
    used.add(n);
    return n;
};

// ---------- folder support (File System Access API + drag-entry) ----------

const isAcceptedName = (name: string): boolean => ACCEPT_EXTS.has(`.${(name.split('.').pop() || '').toLowerCase()}`);

/**
 * 递归读取一个 FileSystemDirectoryHandle（"添加文件夹"按钮，showDirectoryPicker
 * 返回可写句柄），返回其中所有受支持的高斯文件。子目录递归包含。
 */
const readDirHandleRecursive = async (dir: FileSystemDirectoryHandle): Promise<File[]> => {
    const out: File[] = [];
    for await (const [name, handle] of (dir as any).entries()) {
        if (handle.kind === 'file') {
            if (isAcceptedName(name)) {
                const f = await handle.getFile();
                out.push(f);
            }
        } else if (handle.kind === 'directory') {
            out.push(...(await readDirHandleRecursive(handle)));
        }
    }
    return out;
};

/**
 * 递归读取拖拽目录（DataTransferItem.webkitGetAsEntry → FileSystemDirectoryEntry，
 * 只读，拿不到写句柄），返回所有受支持的高斯文件。
 */
const readEntryRecursive = async (entry: any): Promise<File[]> => {
    if (entry.isFile) {
        const f = await new Promise<File>((res, rej) => {
            entry.file(res, rej);
        });
        return isAcceptedName(f.name) ? [f] : [];
    }
    if (entry.isDirectory) {
        const reader = entry.createReader();
        const entries: any[] = [];
        for (;;) {
            const batch = await new Promise<any[]>((res, rej) => {
                reader.readEntries(res, rej);
            });
            if (!batch.length) break;
            entries.push(...batch);
        }
        const nested = await Promise.all(entries.map(readEntryRecursive));
        return nested.flat();
    }
    return [];
};

/**
 * 把转换结果写入文件夹句柄下的 output/ 子目录（自动创建）。
 */
const writeToOutputDir = async (
    dir: FileSystemDirectoryHandle,
    name: string,
    data: Uint8Array
): Promise<void> => {
    const outDir = await dir.getDirectoryHandle('output', { create: true });
    const fh = await outDir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(data as any);
    await w.close();
};

/**
 * 把转换结果直接写入用户指定的输出文件夹（"设置输出文件夹…"按钮，不建子目录）。
 */
const writeToDir = async (
    dir: FileSystemDirectoryHandle,
    name: string,
    data: Uint8Array
): Promise<void> => {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(data as any);
    await w.close();
};

// ---------- core conversion (pure, no UI / no download) ----------

type GpuDevice = Awaited<ReturnType<typeof createGraphicsDevice>>;
type OutputFormat = typeof OUTPUT_FORMATS[number];

const createGpuDevice = async (): Promise<GpuDevice> => {
    const c = document.createElement('canvas');
    c.width = 8; c.height = 8;
    c.style.display = 'none';
    document.body.appendChild(c);
    // WebGPU first: SOG export's SH k-means is a WGSL compute pass and can
    // only run on a WebGPU device; WebGL2 cannot execute it.
    if (navigator.gpu) {
        try {
            return await createGraphicsDevice(c, {
                deviceTypes: ['webgpu'],
                antialias: false,
                preserveDrawingBuffer: true,
                // same requirement as the main renderer: our passes are GLSL, so
                // the WebGPU device needs the transpilers to compile them
                ...webgpuTranspilerUrls()
            } as any);
        } catch { /* fall through to WebGL2 */ }
    }
    try {
        return await createGraphicsDevice(c, {
            deviceTypes: ['webgl2'],
            antialias: false,
            preserveDrawingBuffer: true
        } as any);
    } catch (e) {
        throw new Error(`GPU 初始化失败：${e instanceof Error ? e.message : String(e)}`);
    }
};

const convertFileCore = async (
    file: File,
    fmt: OutputFormat,
    device: GpuDevice | null,
    onStage?: (stage: string, pct: number) => void
): Promise<{ outName: string; outData: Uint8Array }> => {
    const data = new Uint8Array(await file.arrayBuffer());
    const inName = file.name;
    onStage?.('读取文件…', 5);

    const readFs = new MemoryReadFileSystem();
    readFs.set(inName, data);
    const sources = await readFile({
        filename: inName,
        inputFormat: getInputFormat(inName),
        fileSystem: readFs
    });

    onStage?.('转换写入中…', 45);
    const pool = createChunkDataPool();
    const base = inName.replace(/\.[^/.]+$/, '');
    const outName = base + fmt.ext;
    const outFs = new MemoryFileSystem();

    await writeSource({
        filename: outName,
        outputFormat: getOutputFormat(outName, {}),
        source: sources[0],
        pool,
        options: {},
        // SOG's SH k-means is a WGSL compute pass: only usable on a WebGPU
        // device. With a WebGL2 device, omit the device so the library falls
        // back to its CPU k-means implementation.
        createDevice: device && (fmt.id !== 'sog' || (device as any).isWebGPU) ?
            () => Promise.resolve(device as any) :
            undefined
    }, outFs);
    for (const s of sources) {
        try {
            s.close();
        } catch { /* noop */ }
    }

    const outData = outFs.results.get(outName);
    if (!outData) throw new Error('转换完成但没有输出数据');
    onStage?.('完成', 95);
    return { outName, outData };
};

// ---------- app ----------

// eslint-disable-next-line require-await -- 启动入口保持 async 供调用方 await，函数体无同步等待
export const startSplatFactoryApp = async () => {
    document.body.style.margin = '0';
    document.body.style.overflow = 'hidden';
    document.body.style.background = '#16181c';

    const root = el('div', 'sf-root');
    root.innerHTML = `
        <style>
            .sf-root { position: fixed; inset: 0; background: #16181c; color: #e8e8e8;
                font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; display: flex;
                flex-direction: column; }
            .sf-header { display: flex; align-items: center; gap: 16px; padding: 14px 24px;
                background: #1e2228; border-bottom: 1px solid #333a42; }
            .sf-title { font-size: 17px; font-weight: 700; color: #ffb454; }
            .sf-subtitle { font-size: 12px; color: #9aa4af; }
            .sf-back { margin-left: auto; color: #7eb6ff; cursor: pointer; font-size: 13px; }
            .sf-back:hover { text-decoration: underline; }
            .sf-body { flex: 1; overflow-y: auto; padding: 28px; display: flex; flex-direction: column;
                gap: 20px; max-width: 760px; margin: 0 auto; width: 100%; box-sizing: border-box; }
            .sf-card { background: #1e2228; border: 1px solid #333a42; border-radius: 10px; padding: 18px; }
            .sf-card h3 { margin: 0 0 10px 0; font-size: 13px; text-transform: uppercase;
                letter-spacing: .5px; color: #ffb454; }
            .sf-drop { border: 2px dashed #3d4650; border-radius: 8px; padding: 26px; text-align: center;
                cursor: pointer; color: #9aa4af; font-size: 13px; transition: border-color .15s; }
            .sf-drop:hover, .sf-drop.sf-over { border-color: #ffb454; color: #e8e8e8; }
            .sf-file { margin-top: 10px; font-size: 13px; color: #c9d1d9; word-break: break-all; }
            .sf-file b { color: #7eb6ff; }
            .sf-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
            .sf-row label { font-size: 13px; color: #9aa4af; }
            select.sf-select { background: #262b32; color: #e8e8e8; border: 1px solid #3d4650;
                border-radius: 6px; padding: 7px 10px; font-size: 13px; }
            .sf-btn { background: #ffb454; color: #1a1d21; border: none; border-radius: 8px;
                padding: 10px 22px; font-size: 14px; font-weight: 700; cursor: pointer; }
            .sf-btn:disabled { opacity: .5; cursor: not-allowed; }
            .sf-btn.sf-ghost { background: transparent; color: #9aa4af; border: 1px solid #3d4650;
                font-weight: 400; font-size: 13px; padding: 7px 14px; }
            .sf-btn.sf-ghost:hover { color: #e8e8e8; border-color: #7eb6ff; }
            .sf-progress { height: 6px; background: #262b32; border-radius: 3px; overflow: hidden; }
            .sf-progress > div { height: 100%; width: 0%; background: #ffb454; transition: width .2s; }
            .sf-log { font-size: 12px; color: #9aa4af; white-space: pre-wrap; max-height: 140px;
                overflow-y: auto; font-family: ui-monospace, Consolas, monospace; }
            .sf-result { margin-top: 8px; font-size: 13px; color: #7ee2a8; }
            .sf-note { font-size: 11px; color: #6b7580; margin-top: 4px; }
            .sf-list { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
            .sf-row-item { display: flex; align-items: center; gap: 10px; background: #1a1e24;
                border: 1px solid #2c333b; border-radius: 6px; padding: 7px 10px; font-size: 12px; }
            .sf-row-name { flex: 1; color: #c9d1d9; word-break: break-all; min-width: 0; }
            .sf-row-size { color: #6b7580; white-space: nowrap; }
            .sf-badge { padding: 2px 8px; border-radius: 10px; font-size: 11px; white-space: nowrap; }
            .sf-badge-pending { background: #262b32; color: #9aa4af; }
            .sf-badge-converting { background: #3d3a1e; color: #ffd75e; }
            .sf-badge-done { background: #16341f; color: #7ee2a8; }
            .sf-badge-error { background: #3d1e1e; color: #ff8a8a; }
            .sf-del { background: transparent; border: none; color: #6b7580; cursor: pointer;
                font-size: 13px; padding: 0 4px; line-height: 1; }
            .sf-del:hover { color: #ff8a8a; }
            .sf-row-actions { display: flex; gap: 8px; margin-top: 10px; align-items: center; }
            .sf-empty { font-size: 12px; color: #6b7580; margin-top: 8px; }
        </style>
    `;
    document.body.appendChild(root);

    // header
    const header = el('div', 'sf-header');
    header.appendChild(el('div', 'sf-title', '格式工厂（邵青）'));
    header.appendChild(el('div', 'sf-subtitle', '3D 高斯格式转换 · 支持批量'));
    const back = el('div', 'sf-back', '← 返回编辑器');
    back.onclick = () => window.close();
    header.appendChild(back);
    root.appendChild(header);

    // body
    const body = el('div', 'sf-body');
    root.appendChild(body);

    // ---- file picker card (multi-select + folder) ----
    const fileCard = el('div', 'sf-card');
    fileCard.appendChild(el('h3', null, '① 选择源文件（支持多选 / 文件夹）'));
    const drop = el('div', 'sf-drop', '点击选择或拖拽高斯文件 / 文件夹到这里\n支持 .ply / .splat / .spz / .sog / .ksplat / .lcc / .lcc2 / .mjs / .csv，可一次选多个');
    drop.style.whiteSpace = 'pre-line';
    const fileInfo = el('div', 'sf-file', '未选择文件');
    fileCard.appendChild(drop);
    fileCard.appendChild(fileInfo);
    const listWrap = el('div', 'sf-list');
    fileCard.appendChild(listWrap);
    const emptyHint = el('div', 'sf-empty', '选择或拖入多个文件 / 文件夹后，可一次性批量转换。');
    listWrap.appendChild(emptyHint);
    const rowActions = el('div', 'sf-row-actions');
    const pickBtn = el('button', 'sf-btn sf-ghost', '选择文件…') as HTMLButtonElement;
    const addFolderBtn = el('button', 'sf-btn sf-ghost', '添加文件夹…') as HTMLButtonElement;
    const clearBtn = el('button', 'sf-btn sf-ghost', '清空列表') as HTMLButtonElement;
    clearBtn.disabled = true;
    rowActions.appendChild(pickBtn);
    rowActions.appendChild(addFolderBtn);
    rowActions.appendChild(clearBtn);
    fileCard.appendChild(rowActions);
    body.appendChild(fileCard);

    // ---- options card ----
    const optCard = el('div', 'sf-card');
    optCard.appendChild(el('h3', null, '② 输出格式与转换'));
    const optRow = el('div', 'sf-row');
    optRow.appendChild(el('label', null, '输出格式：'));
    const fmtSelect = document.createElement('select');
    fmtSelect.className = 'sf-select';
    for (const f of OUTPUT_FORMATS) {
        const o = document.createElement('option');
        o.value = f.id;
        o.textContent = f.label;
        fmtSelect.appendChild(o);
    }
    optRow.appendChild(fmtSelect);
    const convertBtn = el('button', 'sf-btn', '开始转换') as HTMLButtonElement;
    convertBtn.disabled = true;
    optRow.appendChild(convertBtn);
    // "输出到当前目录" 勾选项：输出不打包，直接写入输入文件夹下的 output/ 子目录
    const saveRow = el('div', 'sf-row');
    const saveCheck = document.createElement('input');
    saveCheck.type = 'checkbox';
    saveCheck.id = 'sf-save-folder';
    saveCheck.style.accentColor = '#ffb454';
    const saveLabel = el('label', null, '输出到当前目录');
    saveLabel.setAttribute('for', 'sf-save-folder');
    saveLabel.style.cursor = 'pointer';
    // "设置输出文件夹…" 按钮：输出直接写入用户指定的文件夹（与上方勾选互斥）
    const setOutBtn = el('button', 'sf-btn sf-ghost', '设置输出文件夹…') as HTMLButtonElement;
    const saveNote = el('div', 'sf-note', '勾选后：输出文件不打包 ZIP，直接写入输入文件夹下的 output/ 子文件夹（需通过「添加文件夹…」加入；拖拽文件夹 / 单个文件因无写入权限，会改为直接下载）。也可点「设置输出文件夹…」把结果直接写入任意指定文件夹，两者互斥。');
    saveRow.appendChild(saveCheck);
    saveRow.appendChild(saveLabel);
    saveRow.appendChild(setOutBtn);
    const progressWrap = el('div', 'sf-progress');
    const progressBar = el('div');
    progressWrap.appendChild(progressBar);
    optCard.appendChild(optRow);
    optCard.appendChild(saveRow);
    optCard.appendChild(saveNote);
    optCard.appendChild(progressWrap);
    const status = el('div', 'sf-log', '');
    optCard.appendChild(status);
    const result = el('div', 'sf-result', '');
    optCard.appendChild(result);
    optCard.appendChild(el('div', 'sf-note', '提示：选择 1 个文件 → 转换后直接下载；多个文件 → 批量转换，失败不中断。未勾选「输出到当前目录」时打包为 ZIP 一次下载。SOG / SPZ / GLB 需要 GPU 编码。'));
    body.appendChild(optCard);

    // ---- state ----
    type RowState = 'pending' | 'converting' | 'done' | 'error';
    interface FileEntry {
        file: File;
        state: RowState;
        pct: number;
        outName?: string;
        outBytes?: number;
        outData?: Uint8Array;
        error?: string;
        // 来源文件夹（仅"添加文件夹…"按钮可拿可写句柄）；拖拽文件夹只读无句柄
        folderHandle?: FileSystemDirectoryHandle | null;
        fromFolder?: boolean;
    }
    let entries: FileEntry[] = [];
    let busy = false;
    // 用户指定的输出文件夹（"设置输出文件夹…"按钮）；与 saveCheck 互斥
    let outputDirHandle: FileSystemDirectoryHandle | null = null;

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = READ_ACCEPT;
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);

    const addFiles = (list: FileList | File[], folderHandle?: FileSystemDirectoryHandle | null, fromFolder = false) => {
        const seen = new Set(entries.map(e => `${e.file.name}|${e.file.size}|${e.file.lastModified}`));
        let added = 0;
        for (const f of Array.from(list)) {
            const ext = `.${(f.name.split('.').pop() || '').toLowerCase()}`;
            if (!ACCEPT_EXTS.has(ext)) {
                status.textContent = `⚠ 跳过不支持的文件：${f.name}`;
                continue;
            }
            const key = `${f.name}|${f.size}|${f.lastModified}`;
            if (seen.has(key)) continue;
            seen.add(key);
            entries.push({ file: f, state: 'pending', pct: 0, folderHandle: folderHandle ?? null, fromFolder });
            added++;
        }
        if (added === 0 && entries.length === 0) {
            status.textContent = '未添加任何文件（请选择支持的高斯格式）';
        }
        renderList();
        updateBtnLabel();
    };

    const renderList = () => {
        listWrap.innerHTML = '';
        if (entries.length === 0) {
            listWrap.appendChild(emptyHint);
            fileInfo.textContent = '未选择文件';
            return;
        }
        fileInfo.innerHTML = '';
        fileInfo.appendChild(el('span', null, '已选择 '));
        const b = el('b', null, String(entries.length));
        fileInfo.appendChild(b);
        fileInfo.appendChild(el('span', null, ' 个文件：'));
        const doneCount = entries.filter(e => e.state === 'done').length;
        const errCount = entries.filter(e => e.state === 'error').length;
        if (doneCount || errCount) {
            fileInfo.appendChild(el('span', null, `（成功 ${doneCount}${errCount ? ` / 失败 ${errCount}` : ''}）`));
        }
        const folderCount = entries.filter(e => e.fromFolder).length;
        if (folderCount) {
            fileInfo.appendChild(el('span', null, `  📁 ${folderCount} 个来自文件夹`));
        }
        entries.forEach((e, i) => {
            const row = el('div', 'sf-row-item');
            row.appendChild(el('span', 'sf-row-name', (e.fromFolder ? '📁 ' : '') + e.file.name));
            row.appendChild(el('span', 'sf-row-size', fmtBytes(e.file.size)));
            let badgeText = '待转换';
            if (e.state === 'converting') badgeText = `转换中 ${Math.round(e.pct)}%`;
            else if (e.state === 'done') badgeText = `✓ ${e.outBytes !== undefined ? fmtBytes(e.outBytes) : '完成'}`;
            else if (e.state === 'error') badgeText = '✗ 失败';
            const badge = el('span', `sf-badge sf-badge-${e.state}`, badgeText);
            if (e.state === 'error' && e.error) badge.title = e.error;
            row.appendChild(badge);
            if (e.state !== 'converting') {
                const del = el('button', 'sf-del', '✕') as HTMLButtonElement;
                del.title = e.state === 'done' ? '从列表移除（保留已下载的 zip）' : '移除';
                del.onclick = () => {
                    if (busy) return;
                    entries.splice(i, 1);
                    renderList();
                    updateBtnLabel();
                };
                row.appendChild(del);
            }
            listWrap.appendChild(row);
        });
    };

    const updateBtnLabel = () => {
        convertBtn.disabled = busy || entries.length === 0;
        convertBtn.textContent = entries.length > 1 ? `批量转换（${entries.length} 个文件）` : '开始转换';
        clearBtn.disabled = busy || entries.length === 0;
        pickBtn.disabled = busy;
        addFolderBtn.disabled = busy;
        setOutBtn.disabled = busy;
        drop.style.opacity = busy ? '.5' : '1';
        drop.style.cursor = busy ? 'default' : 'pointer';
    };

    const setRowState = (i: number, state: RowState, extra?: { pct?: number; outName?: string; outBytes?: number; outData?: Uint8Array; error?: string }) => {
        const e = entries[i];
        e.state = state;
        if (extra?.pct !== undefined) e.pct = extra.pct;
        if (extra?.outName !== undefined) e.outName = extra.outName;
        if (extra?.outBytes !== undefined) e.outBytes = extra.outBytes;
        if (extra?.outData !== undefined) e.outData = extra.outData;
        if (extra?.error !== undefined) e.error = extra.error;
        renderList();
    };

    // progress: single file → internal pct; batch → (done + current pct) / total
    const updateProgress = () => {
        if (entries.length <= 1) return; // single-file progress handled by convertFile
        const total = entries.length;
        let doneCount = 0;
        let cur = 0;
        for (const e of entries) {
            if (e.state === 'done') doneCount++;
            else if (e.state === 'converting') cur = e.pct / 100;
        }
        progressBar.style.width = `${(((doneCount + cur) / total) * 100).toFixed(1)}%`;
    };

    pickBtn.onclick = () => input.click();
    // "设置输出文件夹…"：选择目标文件夹，转换结果直接写入（与勾选互斥）
    setOutBtn.onclick = async () => {
        if (busy) return;
        if (typeof (window as any).showDirectoryPicker !== 'function') {
            status.textContent = '当前环境不支持「设置输出文件夹」（需要 Chromium 桌面浏览器 / SplatRoom 桌面版）';
            return;
        }
        try {
            const dir = await (window as any).showDirectoryPicker({ mode: 'readwrite' }) as FileSystemDirectoryHandle;
            outputDirHandle = dir;
            saveCheck.checked = false;   // 互斥：选择了输出文件夹后取消"输出到当前目录"
            setOutBtn.textContent = `📁 ${dir.name}`;
            setOutBtn.title = `输出文件夹：${dir.name}（再次点击可更换）`;
            status.textContent = `输出文件夹已设置为：${dir.name}，转换结果将直接写入该文件夹`;
        } catch (e) {
            if ((e as any)?.name !== 'AbortError') {
                status.textContent = `✗ 设置输出文件夹失败：${e instanceof Error ? e.message : String(e)}`;
            }
        }
    };
    // 勾选"输出到当前目录"时清除已设置的输出文件夹（互斥）
    saveCheck.onchange = () => {
        if (saveCheck.checked && outputDirHandle) {
            outputDirHandle = null;
            setOutBtn.textContent = '设置输出文件夹…';
            setOutBtn.title = '';
        }
    };
    addFolderBtn.onclick = async () => {
        if (busy) return;
        if (typeof (window as any).showDirectoryPicker !== 'function') {
            status.textContent = '当前环境不支持「添加文件夹」（需要 Chromium 桌面浏览器 / SplatRoom 桌面版）';
            return;
        }
        try {
            const dir = await (window as any).showDirectoryPicker({ mode: 'readwrite' }) as FileSystemDirectoryHandle;
            const files = await readDirHandleRecursive(dir);
            if (!files.length) {
                status.textContent = `文件夹中没有找到支持的高斯文件：${dir.name}`;
                return;
            }
            addFiles(files, dir, true);
            status.textContent = `已从文件夹添加 ${files.length} 个文件：${dir.name}`;
        } catch (e) {
            if ((e as any)?.name !== 'AbortError') {
                status.textContent = `✗ 添加文件夹失败：${e instanceof Error ? e.message : String(e)}`;
            }
        }
    };
    input.onchange = () => {
        if (input.files && input.files.length) {
            addFiles(input.files);
            input.value = '';
        }
    };
    drop.onclick = () => {
        if (!busy) input.click();
    };
    drop.ondragover = (e) => {
        e.preventDefault(); if (!busy) drop.classList.add('sf-over');
    };
    drop.ondragleave = () => drop.classList.remove('sf-over');
    drop.ondrop = async (e) => {
        e.preventDefault();
        drop.classList.remove('sf-over');
        if (busy) return;
        // 拖拽文件夹：webkitGetAsEntry → 递归读取（只读，无写句柄）
        try {
            const items = e.dataTransfer?.items;
            if (items && items.length) {
                const entries2: any[] = [];
                for (const it of Array.from(items)) {
                    const entry = (it as any).webkitGetAsEntry?.();
                    if (entry) entries2.push(entry);
                }
                if (entries2.length) {
                    const lists = await Promise.all(entries2.map(readEntryRecursive));
                    const dirFiles = lists.flat();
                    if (dirFiles.length) {
                        addFiles(dirFiles, null, true);
                        status.textContent = `已从拖拽文件夹添加 ${dirFiles.length} 个文件（只读，无法写入 output/）`;
                        return;
                    }
                }
            }
        } catch { /* fall through to plain file drop */ }
        const files = e.dataTransfer?.files;
        if (files && files.length) addFiles(files);
    };
    clearBtn.onclick = () => {
        if (busy) return;
        entries = [];
        result.textContent = '';
        status.textContent = '';
        progressBar.style.width = '0%';
        renderList();
        updateBtnLabel();
    };

    // ---- single-file conversion (direct download / folder write) ----
    const convertFile = async (
        file: File,
        fmtId: string,
        opts?: { folderHandle?: FileSystemDirectoryHandle | null }
    ): Promise<{ outName: string; outBytes: number; savedToFolder?: string }> => {
        const fmt = OUTPUT_FORMATS.find(f => f.id === fmtId) ?? OUTPUT_FORMATS[0];
        result.textContent = '';
        status.textContent = '读取文件…';
        progressBar.style.width = '5%';
        try {
            let device: GpuDevice | null = null;
            if (fmt.needsGpu) {
                status.textContent = '初始化 GPU…';
                device = await createGpuDevice();
            }
            const r = await convertFileCore(file, fmt, device, (stage, pct) => {
                status.textContent = stage;
                progressBar.style.width = `${pct}%`;
            });
            progressBar.style.width = '100%';
            // 优先级：指定输出文件夹 → 勾选"输出到当前目录"（输入文件夹 output/）→ 下载
            if (outputDirHandle) {
                await writeToDir(outputDirHandle, r.outName, r.outData);
                result.textContent = `✓ 转换完成：${r.outName}（${fmtBytes(r.outData.length)}），已保存到 ${outputDirHandle.name}/`;
                status.textContent = `读取：${file.name}（${fmtBytes(file.size)}） → 保存：${outputDirHandle.name}/${r.outName}`;
                if (device) {
                    try {
                        (device as any).destroy?.();
                    } catch { /* noop */ }
                }
                return { outName: r.outName, outBytes: r.outData.length, savedToFolder: outputDirHandle.name };
            }
            const useFolder = !!(saveCheck.checked && opts?.folderHandle);
            if (useFolder) {
                await writeToOutputDir(opts!.folderHandle!, r.outName, r.outData);
                result.textContent = `✓ 转换完成：${r.outName}（${fmtBytes(r.outData.length)}），已保存到 ${opts!.folderHandle!.name}/output/`;
                status.textContent = `读取：${file.name}（${fmtBytes(file.size)}） → 保存：${opts!.folderHandle!.name}/output/${r.outName}`;
                if (device) {
                    try {
                        (device as any).destroy?.();
                    } catch { /* noop */ }
                }
                return { outName: r.outName, outBytes: r.outData.length, savedToFolder: `${opts!.folderHandle!.name}/output` };
            }
            downloadBlob(r.outName, r.outData);
            result.textContent = `✓ 转换完成：${r.outName}（${fmtBytes(r.outData.length)}），已开始下载`;
            status.textContent = `读取：${file.name}（${fmtBytes(file.size)}） → 输出：${r.outName}（${fmtBytes(r.outData.length)}）`;
            if (device) {
                try {
                    (device as any).destroy?.();
                } catch { /* noop */ }
            }
            return { outName: r.outName, outBytes: r.outData.length };
        } catch (e) {
            status.textContent = `✗ ${e instanceof Error ? e.message : String(e)}`;
            result.textContent = '';
            throw e;
        }
    };

    // ---- batch conversion (serial, fail-safe, zip download) ----
    const runBatch = async (): Promise<{ ok: number; failed: number; zipName: string; zipBytes: number }> => {
        const fmt = OUTPUT_FORMATS.find(f => f.id === fmtSelect.value) ?? OUTPUT_FORMATS[0];
        busy = true;
        updateBtnLabel();
        result.textContent = '';
        status.textContent = '准备批量转换…';
        progressBar.style.width = '2%';
        // reset states
        for (const e of entries) {
            e.state = 'pending'; e.pct = 0; e.outName = undefined; e.outBytes = undefined; e.error = undefined;
        }
        renderList();

        let device: GpuDevice | null = null;
        if (fmt.needsGpu) {
            try {
                status.textContent = '初始化 GPU（批量复用）…';
                device = await createGpuDevice();
            } catch (e) {
                busy = false;
                updateBtnLabel();
                status.textContent = `✗ ${e instanceof Error ? e.message : String(e)}`;
                throw e;
            }
        }

        try {
            const total = entries.length;
            for (let i = 0; i < total; i++) {
                const entry = entries[i];
                setRowState(i, 'converting', { pct: 2 });
                status.textContent = `批量转换中 ${i + 1}/${total}：${entry.file.name}`;
                try {
                    const r = await convertFileCore(entry.file, fmt, device, (stage, pct) => {
                        status.textContent = `批量转换中 ${i + 1}/${total}：${entry.file.name}（${stage}）`;
                        setRowState(i, 'converting', { pct });
                        updateProgress();
                    });
                    setRowState(i, 'done', { outName: r.outName, outBytes: r.outData.length, outData: r.outData });
                } catch (e) {
                    setRowState(i, 'error', { error: e instanceof Error ? e.message : String(e) });
                    status.textContent = `✗ ${entry.file.name}：${e instanceof Error ? e.message : String(e)}`;
                }
                updateProgress();
            }

            // summary: save-to-folder (勾选时直接写 output/，不打 zip) or zip
            const doneEntries = entries.filter(e => e.state === 'done');
            const failed = total - doneEntries.length;
            if (doneEntries.length > 0) {
                // 优先级：指定输出文件夹 → 勾选"输出到当前目录" → zip
                if (outputDirHandle) {
                    let saved = 0;
                    const savedTo: string[] = [];
                    for (const e of doneEntries) {
                        try {
                            await writeToDir(outputDirHandle, e.outName!, e.outData!);
                            saved++;
                            savedTo.push(e.outName!);
                        } catch {
                            downloadBlob(e.outName!, e.outData!);
                        }
                    }
                    progressBar.style.width = '100%';
                    result.textContent = `✓ 批量转换完成：成功 ${saved} 个已写入「${outputDirHandle.name}」${doneEntries.length - saved ? `，${doneEntries.length - saved} 个写入失败已改为下载` : ''}（失败 ${failed} 个）`;
                    status.textContent = `已写入 ${outputDirHandle.name}/：${savedTo.join('、') || '无'}`;
                    return { ok: doneEntries.length, failed, zipName: '', zipBytes: 0 };
                }
                if (saveCheck.checked) {
                    // 逐个写入来源文件夹的 output/ 子目录；无写句柄的 fallback 下载
                    let saved = 0;
                    let downloaded = 0;
                    const savedTo: string[] = [];
                    for (const e of doneEntries) {
                        const dir = e.folderHandle;
                        if (dir) {
                            try {
                                await writeToOutputDir(dir, e.outName!, e.outData!);
                                saved++;
                                savedTo.push(e.outName!);
                            } catch {
                                downloadBlob(e.outName!, e.outData!);
                                downloaded++;
                            }
                        } else {
                            downloadBlob(e.outName!, e.outData!);
                            downloaded++;
                        }
                    }
                    progressBar.style.width = '100%';
                    result.textContent = `✓ 批量转换完成：成功 ${saved} 个已写入 output/ 文件夹${downloaded ? `，${downloaded} 个已直接下载（无文件夹写入权限）` : ''}（失败 ${failed} 个）`;
                    status.textContent = `已写入：${savedTo.join('、') || '无'}${downloaded ? `；已下载：${downloaded} 个` : ''}`;
                    return { ok: doneEntries.length, failed, zipName: '', zipBytes: 0 };
                }
                const used = new Set<string>();
                const zipEntries = doneEntries.map(e => ({
                    name: uniqueName(e.outName ?? e.file.name, used),
                    data: e.outData!
                }));
                const zipData = buildZip(zipEntries);
                const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                const zipName = `splatroom-batch-${ts}.zip`;
                downloadBlob(zipName, zipData);
                progressBar.style.width = '100%';
                result.textContent = `✓ 批量转换完成：成功 ${doneEntries.length} 个 / 失败 ${failed} 个，已打包下载 ${zipName}（${fmtBytes(zipData.length)}）`;
                status.textContent = `ZIP 包含 ${zipEntries.length} 个文件：${zipEntries.map(z => z.name).join('、')}`;
                return { ok: doneEntries.length, failed, zipName, zipBytes: zipData.length };
            }
            result.textContent = `✗ 批量转换全部失败（${failed} 个）`;
            return { ok: 0, failed, zipName: '', zipBytes: 0 };
        } finally {
            if (device) {
                try {
                    (device as any).destroy?.();
                } catch { /* noop */ }
            }
            busy = false;
            updateBtnLabel();
        }
    };

    convertBtn.onclick = async () => {
        if (busy || entries.length === 0) return;
        if (entries.length === 1) {
            busy = true;
            updateBtnLabel();
            try {
                await convertFile(entries[0].file, fmtSelect.value, { folderHandle: entries[0].folderHandle });
            } catch { /* errors shown in status */ } finally {
                busy = false;
                updateBtnLabel();
            }
            return;
        }
        try {
            await runBatch();
        } catch { /* errors shown in status */ }
    };

    // ---- expose for tests / headless verification ----
    (window as any).__splatFactory = {
        convertFile,
        batchConvert: async (files: File[], fmtId: string) => {
            const fmt = OUTPUT_FORMATS.find(f => f.id === fmtId) ?? OUTPUT_FORMATS[0];
            let device: GpuDevice | null = null;
            if (fmt.needsGpu) device = await createGpuDevice();
            const results: { name: string; outName: string; outData: Uint8Array }[] = [];
            let ok = 0;
            const errors: string[] = [];
            try {
                for (const f of files) {
                    try {
                        const r = await convertFileCore(f, fmt, device);
                        results.push({ name: f.name, outName: r.outName, outData: r.outData });
                        ok++;
                    } catch (e) {
                        errors.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
                    }
                }
            } finally {
                if (device) {
                    try {
                        (device as any).destroy?.();
                    } catch { /* noop */ }
                }
            }
            const used = new Set<string>();
            const zipEntries = results.map(r => ({ name: uniqueName(r.outName, used), data: r.outData }));
            const zipData = buildZip(zipEntries);
            return { total: files.length, ok, failed: files.length - ok, errors, zipBytes: zipData.length, zip: zipData };
        },
        buildZip,
        readDirHandleRecursive,
        readEntryRecursive,
        writeToOutputDir,
        writeToDir,
        OUTPUT_FORMATS
    };
};
