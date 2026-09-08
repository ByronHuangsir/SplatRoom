import { Column, DataTable, MemoryFileSystem, writeFile } from '@playcanvas/splat-transform';
import { BoundingBox, GSplatData, Quat, Vec3 } from 'playcanvas';

import { MergeModel } from './merge-model';

/**
 * 合并工具（模块 3）— 合并导出。
 *
 * 把选中的多个模型的高斯数据合并为一个 GSplatData（世界坐标已烘焙），
 * 输出为单个 PLY 文件下载。逻辑与主编辑器 group-renderer 的
 * buildMergedGSplatData 同源（此处为独立实现，避免跨模块耦合）。
 */

const POS_COLS = ['x', 'y', 'z'];
const ROT_COLS = ['rot_0', 'rot_1', 'rot_2', 'rot_3'];
// 注意：splat-transform 的 PLY 格式要求 f_rest_* 是「每系数 × 3 通道」的展开列数，
// 即 1 阶=9、2 阶=24、3 阶=45（不是系数个数 3/8/15）。写错会导致主程序加载报
// "unrecognized f_rest_* count 15" 且丢失大部分球谐系数（颜色异常）。
const SH_REST_COUNTS = [0, 9, 24, 45];

const _v3 = new Vec3();
const _quat = new Quat();
const _quat2 = new Quat();

/** 合并多个模型为单个 GSplatData（世界坐标）。 */
export function buildMergedGSplatData(models: MergeModel[]): GSplatData {
    let maxSHBands = 0;
    for (const m of models) {
        const bands = (m.entity.gsplat.instance.resource as any).shBands ?? 0;
        if (bands > maxSHBands) maxSHBands = bands;
    }
    const maxRestCols = SH_REST_COUNTS[maxSHBands] ?? 0;

    const merged = new Map<string, { data: any }>();

    for (const m of models) {
        const sd = m.gsplatData;
        const num = sd.numSplats;
        const wm = m.entity.getWorldTransform();
        const worldRot = m.entity.getRotation().clone();
        // 模型缩放烘焙：GSplat scale 为 log 域，均匀缩放因子以 log 加法合成（旋转已并入 splat rot）
        const localScale = m.entity.getLocalScale();
        const scaleLog = new Vec3(
            localScale.x > 0 ? Math.log(localScale.x) : 0,
            localScale.y > 0 ? Math.log(localScale.y) : 0,
            localScale.z > 0 ? Math.log(localScale.z) : 0
        );
        const props = sd.getElement('vertex').properties as any[];
        const propMap = new Map<string, any>();
        for (const p of props) propMap.set(p.name, p);

        let thisRestCount = 0;
        for (const p of props) {
            if (p.name.startsWith('f_rest_')) {
                const idx = parseInt(p.name.split('_')[2], 10);
                if (idx + 1 > thisRestCount) thisRestCount = idx + 1;
                if (idx >= maxRestCols) continue;
            }
            if (!merged.has(p.name)) merged.set(p.name, { data: new (p.storage.constructor)(0) });
        }

        const hasPos = POS_COLS.every(c => propMap.has(c));
        const hasRot = ROT_COLS.every(c => propMap.has(c));
        const xs = propMap.get('x')?.storage as Float32Array;
        const ys = propMap.get('y')?.storage as Float32Array;
        const zs = propMap.get('z')?.storage as Float32Array;
        const srcR0 = hasRot ? propMap.get('rot_0').storage as Float32Array : null;
        const srcR1 = hasRot ? propMap.get('rot_1').storage as Float32Array : null;
        const srcR2 = hasRot ? propMap.get('rot_2').storage as Float32Array : null;
        const srcR3 = hasRot ? propMap.get('rot_3').storage as Float32Array : null;

        const newX = new Float32Array(num), newY = new Float32Array(num), newZ = new Float32Array(num);
        const newR0 = hasRot ? new Float32Array(num) : null;
        const newR1 = hasRot ? new Float32Array(num) : null;
        const newR2 = hasRot ? new Float32Array(num) : null;
        const newR3 = hasRot ? new Float32Array(num) : null;
        for (let i = 0; i < num; i++) {
            _v3.set(xs[i], ys[i], zs[i]);
            wm.transformPoint(_v3, _v3);
            newX[i] = _v3.x; newY[i] = _v3.y; newZ[i] = _v3.z;
            if (hasRot) {
                // PLY rot_0..3 = (w,x,y,z)；PlayCanvas Quat = (x,y,z,w)
                _quat.set(srcR1![i], srcR2![i], srcR3![i], srcR0![i]);
                _quat2.copy(worldRot).mul(_quat).normalize();
                newR0![i] = _quat2.w; newR1![i] = _quat2.x; newR2![i] = _quat2.y; newR3![i] = _quat2.z;
            }
        }
        concat(merged, 'x', newX);
        concat(merged, 'y', newY);
        concat(merged, 'z', newZ);
        if (hasRot) {
            concat(merged, 'rot_0', newR0!); concat(merged, 'rot_1', newR1!);
            concat(merged, 'rot_2', newR2!); concat(merged, 'rot_3', newR3!);
        }

        // 其余列（scale/颜色/opacity/SH rest）拼接；scale 列需烘焙模型缩放
        for (const p of props) {
            const name = p.name;
            if (POS_COLS.includes(name) || ROT_COLS.includes(name)) continue;
            if (name.startsWith('f_rest_')) {
                const idx = parseInt(name.split('_')[2], 10);
                if (idx >= maxRestCols) continue;
                concat(merged, name, p.storage);
            } else if (name === 'scale_0' || name === 'scale_1' || name === 'scale_2') {
                const src = p.storage as Float32Array;
                const logAdd = name === 'scale_0' ? scaleLog.x : name === 'scale_1' ? scaleLog.y : scaleLog.z;
                if (Math.abs(logAdd) < 1e-9) {
                    concat(merged, name, src);
                } else {
                    const out = new Float32Array(num);
                    for (let i = 0; i < num; i++) out[i] = src[i] + logAdd;
                    concat(merged, name, out);
                }
            } else {
                concat(merged, name, p.storage);
            }
        }
        // 低 SH 模型的 rest 列补零对齐
        for (let r = thisRestCount; r < maxRestCols; r++) {
            const colName = `f_rest_${r}`;
            if (!merged.has(colName)) merged.set(colName, { data: new Float32Array(0) });
            concat(merged, colName, new Float32Array(num));
        }
    }

    const columns: Column[] = [];
    for (const [name, col] of merged) {
        columns.push(new Column(name, col.data));
    }
    const dataTable = new DataTable(columns);
    return dataTableToGSplatData(dataTable);
}

function concat(map: Map<string, { data: any }>, name: string, newData: any): void {
    const col = map.get(name);
    if (!col) return;
    const old = col.data;
    const combined = new old.constructor(old.length + newData.length);
    combined.set(old, 0);
    combined.set(newData, old.length);
    col.data = combined;
}

function dataTableToGSplatData(dataTable: DataTable): GSplatData {
    const columnTypeToGSplatType = (t: string | null): string => {
        switch (t) {
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
    const properties = dataTable.columns.map((col: Column) => ({
        type: columnTypeToGSplatType(col.dataType),
        name: col.name,
        storage: col.data,
        byteSize: col.data.BYTES_PER_ELEMENT
    }));
    return new GSplatData([{ name: 'vertex', count: dataTable.numRows, properties }]);
}

/** 手动计算合并数据的世界 AABB（calcAabb 不可信）。 */
export function computeMergedAabb(gsplatData: GSplatData): BoundingBox {
    const xs = gsplatData.getProp('x') as Float32Array;
    const ys = gsplatData.getProp('y') as Float32Array;
    const zs = gsplatData.getProp('z') as Float32Array;
    const n = gsplatData.numSplats;
    const aabb = new BoundingBox();
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const stride = Math.max(1, Math.floor(n / 500000));
    for (let i = 0; i < n; i += stride) {
        const x = xs[i], y = ys[i], z = zs[i];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
    }
    aabb.center.set((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5);
    aabb.halfExtents.set((maxX - minX) * 0.5, (maxY - minY) * 0.5, (maxZ - minZ) * 0.5);
    return aabb;
}

/** 导出合并数据为单个 PLY，返回 Uint8Array。 */
export async function exportMergedPly(gsplatData: GSplatData, outName: string): Promise<Uint8Array> {
    const props = gsplatData.getElement('vertex').properties as any[];
    const columns = props.map((p: any) => new Column(p.name, p.storage));
    const dataTable = new DataTable(columns);
    const outFs = new MemoryFileSystem();
    await writeFile({
        filename: outName,
        outputFormat: 'ply',
        dataTable,
        options: {},
        createDevice: undefined
    } as any, outFs);
    const data = outFs.results.get(outName);
    if (!data) throw new Error('PLY 导出失败：没有输出数据');
    return data;
}

/**
 * 把数据写入用户指定的输出文件夹（"设置输出文件夹…"按钮的可选目标）。
 */
export async function writeToDir(
    dir: FileSystemDirectoryHandle,
    name: string,
    data: Uint8Array
): Promise<void> {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(data as any);
    await w.close();
}

/**
 * 使用浏览器原生「存储为」对话框保存文件。
 *
 * 需要支持 File System Access API 的浏览器（Chromium 桌面版 Chrome/Edge，
 * 且页面为安全上下文 https）。调用即弹出系统保存对话框，用户可设置
 * 文件名与导出位置。返回用户最终确定的文件名；用户取消时抛出 AbortError。
 *
 * 若环境不支持，抛出 Error('NOT_SUPPORTED')，由调用方回退到下载/文件夹写入。
 */
// 浏览器原生「存储为」对话框：先同步拿 picker handle（必须在用户手势内），
//  再异步通过 getData() 回调准备数据，最后写入 handle。
//  用户取消时抛出 AbortError；环境不支持时抛出 'NOT_SUPPORTED'。
export async function saveWithPicker(
    suggestedName: string,
    getData: () => Promise<Uint8Array>
): Promise<{ name: string }> {
    const picker = (window as any).showSaveFilePicker;
    if (typeof picker !== 'function') {
        throw new Error('NOT_SUPPORTED');
    }
    // 这一行必须在用户手势的同步链上调用，否则浏览器报 SecurityError
    const handle = (await picker({
        suggestedName,
        types: [
            {
                description: 'PLY 高斯点云',
                accept: { 'application/octet-stream': ['.ply'] }
            }
        ]
    })) as FileSystemFileHandle;
    // handle 拿到后再做耗时的数据生成
    const data = await getData();
    const writable = await handle.createWritable();
    await writable.write(data as any);
    await writable.close();
    return { name: handle.name };
}
