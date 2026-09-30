/**
 * M3-2：朴素二进制 PLY 的**单遍**物化器（worker 导入路径专用）。
 *
 * splat-transform 的 `readPly` + `materializeToDataTable` 是两遍：
 *   ① 记录 → 分层交错 chunk 缓冲（position/geometric/color/other）；
 *   ② 分层缓冲 → 59+ 个命名列（再全量抄一遍）。
 * 对"单个 vertex 元素、全部 float 属性"的普通 3DGS PLY（绝大多数导入），
 * 本模块直接从记录字节写命名列 —— 一遍完成，并在扫块时**顺手算位置范围**
 * （喂给 morton 排序，省掉库的 240MB 范围扫描），逐块报进度。
 *
 * **逐字节一致性**：列集合、列顺序（x,y,z,rot_0..3,scale_0..2,opacity,f_dc_0..2,
 * f_rest_0..N, extras 按文件序）、列内容（float32 原样搬运）、2DGS 的
 * scale_2 = -Infinity 合成、transform = Transform.PLY —— 全部对齐
 * `materializeToDataTable` 的产物。`verify-import-worker.cjs` 拿 worker 导入
 * 与主线程库路径逐列比字节，就是这层保证的回归网。
 *
 * 不适用（返回 null，调用方回退库路径，行为与今天完全一致）：
 *   ascii / big-endian / 压缩 PLY（packed_position）/ 多元素 / 含非 float 属性 /
 *   list 属性 / f_rest 数不是 0/9/24/45 / 缺标准列（库支持部分层，这里保守回退）/
 *   文件尺寸与头不符（库会抛错，回退让它去抛同一条错）。
 */
import { Transform } from '@playcanvas/splat-transform';

import type { Extent } from './morton-fast';

type DirectColumn = {
    name: string;
    dataType: 'float32' | 'uint32';
    data: Float32Array | Uint32Array;
};

type DirectTable = {
    columns: DirectColumn[];
    numRows: number;
    transform: Transform;
    /** 物化时顺手算的位置范围（morton 顶层直接用，省一次全扫） */
    extent: Extent;
};

const HEADER_MAX = 256 * 1024;
// 读块大小：8 MiB，向下对齐到记录步长的整数倍
const BLOCK_BYTES = 8 * 1024 * 1024;

const POSITION_COLS = ['x', 'y', 'z'];
const ROT_COLS = ['rot_0', 'rot_1', 'rot_2', 'rot_3'];
const SCALE_COLS = ['scale_0', 'scale_1', 'scale_2'];
const DC_COLS = ['f_dc_0', 'f_dc_1', 'f_dc_2'];
const STANDARD = new Set([...POSITION_COLS, ...ROT_COLS, ...SCALE_COLS, 'opacity', ...DC_COLS]);
const REST_RE = /^f_rest_(\d+)$/;
const VALID_REST_COUNTS = new Set([0, 9, 24, 45]);

const tryMaterializePlyDirect = async (
    blob: Blob,
    onProgress?: (fraction: number) => void
): Promise<DirectTable | null> => {
    // ---- 头部解析（一次小读） ----
    const headText = await blob.slice(0, Math.min(HEADER_MAX, blob.size)).text();
    const endTag = headText.indexOf('end_header');
    if (!headText.startsWith('ply') || endTag < 0) {
        return null;
    }
    // end_header 后面的换行（\n 或 \r\n）
    let headerBytes = endTag + 'end_header'.length;
    if (headText[headerBytes] === '\r') headerBytes++;
    if (headText[headerBytes] === '\n') headerBytes++;

    const lines = headText.slice(0, endTag).split('\n');
    let format = '';
    type Prop = { name: string; type: string };
    type Elem = { name: string; count: number; props: Prop[] };
    const elements: Elem[] = [];
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('comment') || line === 'ply') {
            continue;
        }
        const parts = line.split(/\s+/);
        if (parts[0] === 'format') {
            format = parts[1];
        } else if (parts[0] === 'element') {
            elements.push({ name: parts[1], count: parseInt(parts[2], 10), props: [] });
        } else if (parts[0] === 'property') {
            if (parts[1] === 'list' || elements.length === 0) {
                return null;   // list 属性 / 悬挂 property：回退
            }
            elements[elements.length - 1].props.push({ name: parts[2], type: parts[1] });
        }
    }
    if (format !== 'binary_little_endian' || elements.length !== 1 || elements[0].name !== 'vertex') {
        return null;
    }
    const vertex = elements[0];
    const numRows = vertex.count;
    if (!Number.isFinite(numRows) || numRows <= 0) {
        return null;
    }
    const props = vertex.props;
    if (props.length === 0 || props.some(p => p.type !== 'float')) {
        return null;   // 含非 float（uchar 颜色、double 等）→ 库路径
    }
    const recordStride = props.length * 4;
    // 与库一致的完整性守卫（尺寸不符时库会抛错；回退让它抛同一条）
    if (blob.size !== headerBytes + numRows * recordStride) {
        return null;
    }

    // ---- 列规划（与 materializeToDataTable 的产物逐项对齐） ----
    const offsetOf = new Map<string, number>();
    props.forEach((p, i) => offsetOf.set(p.name, i));
    const has = (n: string) => offsetOf.has(n);
    if (![...POSITION_COLS, ...ROT_COLS, 'scale_0', 'scale_1', 'opacity', ...DC_COLS].every(has)) {
        return null;   // 缺标准列：库支持部分层，这里保守回退
    }
    const synthScale2 = !has('scale_2');   // 2DGS：合成 -Infinity（与库一致）
    let restCount = 0;
    for (const p of props) {
        const m = p.name.match(REST_RE);
        if (m) {
            restCount = Math.max(restCount, parseInt(m[1], 10) + 1);
        }
    }
    if (!VALID_REST_COUNTS.has(restCount)) {
        return null;
    }
    const extras = props.filter(p => !STANDARD.has(p.name) && !REST_RE.test(p.name));

    // 输出列（顺序即 materializeToDataTable 的顺序）
    const plan: { name: string; srcWord: number | null; data: Float32Array }[] = [];
    const pushCol = (name: string, srcWord: number | null) => {
        plan.push({ name, srcWord, data: new Float32Array(numRows) });
    };
    POSITION_COLS.forEach(n => pushCol(n, offsetOf.get(n)!));
    ROT_COLS.forEach(n => pushCol(n, offsetOf.get(n)!));
    pushCol('scale_0', offsetOf.get('scale_0')!);
    pushCol('scale_1', offsetOf.get('scale_1')!);
    pushCol('scale_2', synthScale2 ? null : offsetOf.get('scale_2')!);
    pushCol('opacity', offsetOf.get('opacity')!);
    DC_COLS.forEach(n => pushCol(n, offsetOf.get(n)!));
    for (let r = 0; r < restCount; r++) {
        const name = `f_rest_${r}`;
        if (!has(name)) {
            return null;   // f_rest 序号有洞（如 0..43 + 45）：库按最高序数建列，回退对齐
        }
        pushCol(name, offsetOf.get(name)!);
    }
    extras.forEach(e => pushCol(e.name, offsetOf.get(e.name)!));

    if (synthScale2) {
        plan[9].data.fill(-Infinity);   // scale_2 列（3 位置 + 4 旋转 + 2 缩放之后，固定第 10 列）
    }

    // ---- 单遍扫描：记录 → 命名列，顺手算位置范围 ----
    // 预取下一块：Blob.arrayBuffer() 的拷贝在浏览器后台线程上做，与当前块的
    // 散布循环重叠（实测 20M 物化 10.2s → ~7s）。
    const colArrays = plan.map(p => p.data);
    const srcWords = new Int32Array(plan.map(p => p.srcWord ?? -1));
    const xWord = offsetOf.get('x')!, yWord = offsetOf.get('y')!, zWord = offsetOf.get('z')!;
    let mx = Infinity, my = Infinity, mz = Infinity;
    let Mx = -Infinity, My = -Infinity, Mz = -Infinity;

    const strideWords = recordStride >> 2;
    const blockRecords = Math.max(1, Math.floor(BLOCK_BYTES / recordStride));
    const readBlock = (rowStart: number, count: number) => blob.slice(headerBytes + rowStart * recordStride, headerBytes + (rowStart + count) * recordStride).arrayBuffer();

    let row = 0;
    let pending: Promise<ArrayBuffer> | null = null;
    let pendingCount = 0;
    while (row < numRows) {
        const count = Math.min(blockRecords, numRows - row);
        const buf = pending ? await pending : await readBlock(row, count);
        pending = null;
        // 预取下一块（不等 promise，散布完再 await）
        if (row + count < numRows) {
            pendingCount = Math.min(blockRecords, numRows - row - count);
            pending = readBlock(row + count, pendingCount);
        }
        const rec = new Float32Array(buf);
        for (let i = 0; i < count; i++) {
            const base = i * strideWords;
            const di = row + i;
            for (let j = 0; j < colArrays.length; j++) {
                const w = srcWords[j];
                if (w >= 0) {
                    colArrays[j][di] = rec[base + w];
                }
            }
            const px = rec[base + xWord], py = rec[base + yWord], pz = rec[base + zWord];
            if (px < mx) mx = px;
            if (px > Mx) Mx = px;
            if (py < my) my = py;
            if (py > My) My = py;
            if (pz < mz) mz = pz;
            if (pz > Mz) Mz = pz;
        }
        row += count;
        onProgress?.(row / numRows);
    }

    return {
        columns: plan.map(p => ({ name: p.name, dataType: 'float32' as const, data: p.data })),
        numRows,
        transform: Transform.PLY.clone(),
        extent: { mx, my, mz, Mx, My, Mz }
    };
};

export {
    tryMaterializePlyDirect,
    type DirectTable,
    type DirectColumn
};
