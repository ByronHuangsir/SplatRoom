import { estimateCellSize } from './floater-removal';
import { Splat } from './splat';
import { State } from './splat-state';

/**
 * 连通簇过滤 —— 按体素连通性找"游离的浮云团"。
 *
 * 思路对齐 PlayCanvas `splat-transform` 的 `--filter-cluster`（"只保留包含 seed 的连通簇"，
 * 官方文档原话是它 "isolates the central scene and discards stray floaters"）：把高斯中心量化到
 * 体素网格，对**被占用的体素**做 6 邻域连通分量标记，再按簇大小决定去留。这比"去浮云"的四信号
 * 启发式更"几何"：一片薄结构只要连着主体就整片保住，而真正飘在空中的一团（哪怕每个点都不算
 * 低透明度/超大体积）会被整体识别出来。
 *
 * 两种模式：
 *   small   —— 删除小于阈值的簇（阈值 = 最大簇点数的百分比 minPct），例如删掉所有"碎屑团"
 *   largest —— 只保留最大簇，其余全算（等价于"只留主体"，忽略阈值）
 *
 * 体素边长**跟着点云自身的疏密走**：以"中位半径 × 0.3"估计典型点间距，再乘一个系数
 * （detail 0 → 3.0×，50 → 1.75×，100 → 0.5×）。这样默认情况下同一片点云天然是一个连通簇
 * ——如果按模型对角线定死体素大小，稀疏点云会被切成一堆互不相连的小格，簇统计就没有意义了；
 * 而把 detail 拉到最细，就是主动要求"按更细的间距重新分团"（会切出更多簇，这是预期行为）。
 * 只统计非删除/非锁定的高斯（与去浮云一致），返回的掩码按 splat 的原始索引对齐。
 */

export interface ClusterOptions {
    /** 0-100：越高体素越小（划分越细）。默认 50。 */
    detail?: number;
    /** 'small' 删除小簇 / 'largest' 只保留最大簇。默认 'small'。 */
    mode?: 'small' | 'largest';
    /** small 模式下的阈值：小于「最大簇点数 × minPct%」的簇算小簇。默认 2。 */
    minPct?: number;
}

export interface ClusterResult {
    mask: Uint8Array;            // 255 = 命中（要删的）
    count: number;               // 命中点数
    clusterCount: number;        // 连通簇总数
    largestSize: number;         // 最大簇点数
    smallClusterCount: number;   // 被判为"小簇"的簇数
    voxelSize: number;           // 实际使用的体素边长
}

// Voxel keys are packed into a single float64 for Map lookups. 17 bits per axis keeps the packed
// value at 51 bits, which a double represents exactly; 21 bits would need 63 and silently lose
// precision (measured: 12 of 18 voxels decoded back to the wrong coordinates, which shredded the
// connectivity graph). Coordinates are taken relative to the model's lower bound so they always
// start near zero, and the voxel size is raised if a model would need more than 2^17 cells on an
// axis.
const KEY_BITS = 17;
const KEY_STRIDE = 1 << KEY_BITS;          // 131072 cells per axis
const KEY_LIMIT = KEY_STRIDE - 1;

/** 把体素坐标打包成一个整数键（用于 Map 查找）。 */
const packKey = (ix: number, iy: number, iz: number) => {
    return (ix * KEY_STRIDE + iy) * KEY_STRIDE + iz;
};

export function detectClusters(splat: Splat, options: ClusterOptions = {}): ClusterResult {
    const detail = Math.max(0, Math.min(100, options.detail ?? 50));
    const mode = options.mode === 'largest' ? 'largest' : 'small';
    const minPct = Math.max(0, options.minPct ?? 2);

    const splatData = splat.splatData;
    const numSplats = splatData.numSplats;
    const state = splatData.getProp('state') as Uint8Array;
    const x = splatData.getProp('x') as Float32Array;
    const y = splatData.getProp('y') as Float32Array;
    const z = splatData.getProp('z') as Float32Array;

    const mask = new Uint8Array(numSplats);
    const empty: ClusterResult = {
        mask, count: 0, clusterCount: 0, largestSize: 0, smallClusterCount: 0, voxelSize: 0
    };
    if (!x || !y || !z || numSplats === 0) {
        return empty;
    }

    // ---- 1) bounds over the valid gaussians ----
    const valid = (i: number) => (state[i] & (State.deleted | State.locked)) === 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let validCount = 0;
    for (let i = 0; i < numSplats; i++) {
        if (!valid(i)) continue;
        validCount++;
        if (x[i] < minX) minX = x[i];
        if (y[i] < minY) minY = y[i];
        if (z[i] < minZ) minZ = z[i];
        if (x[i] > maxX) maxX = x[i];
        if (y[i] > maxY) maxY = y[i];
        if (z[i] > maxZ) maxZ = z[i];
    }
    if (validCount === 0) {
        return empty;
    }

    const diag = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2) || 1;
    // voxel size follows the point cloud's own density: median radius estimate * factor, where
    // the factor runs from 3x (coarse) down to 0.5x (fine) across the detail slider. It is raised
    // if the model would need more cells per axis than the packed key can address.
    const spacing = Math.max(estimateCellSize(x, y, z, numSplats), diag * 1e-6);
    const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || diag;
    const voxelSize = Math.max(spacing * (3.0 - (detail / 100) * 2.5), extent / KEY_LIMIT, diag * 1e-6);

    // ---- 2) voxelize: voxel key -> voxel index, and point -> voxel index ----
    // coordinates are relative to the lower bound, so they are non-negative and small enough to
    // pack exactly
    const voxelOfPoint = new Int32Array(numSplats).fill(-1);
    const keys: number[] = [];               // voxel index -> packed key
    const voxelCoords: number[] = [];        // voxel index -> (ix, iy, iz) flattened, for neighbours
    const keyToIndex = new Map<number, number>();
    const inv = 1 / voxelSize;
    for (let i = 0; i < numSplats; i++) {
        if (!valid(i)) continue;
        const ix = Math.min(KEY_LIMIT, Math.floor((x[i] - minX) * inv));
        const iy = Math.min(KEY_LIMIT, Math.floor((y[i] - minY) * inv));
        const iz = Math.min(KEY_LIMIT, Math.floor((z[i] - minZ) * inv));
        const key = packKey(ix, iy, iz);
        let vi = keyToIndex.get(key);
        if (vi === undefined) {
            vi = keys.length;
            keys.push(key);
            voxelCoords.push(ix, iy, iz);
            keyToIndex.set(key, vi);
        }
        voxelOfPoint[i] = vi;
    }

    const voxelCount = keys.length;
    if (voxelCount === 0) {
        return empty;
    }

    // ---- 3) connected components over the occupied voxels (26-neighbour flood fill) ----
    // the voxel coordinates are kept alongside the key, so neighbours never have to be decoded back
    // out of the packed key
    //
    // 26-neighbour rather than 6: a splat cloud is a surface sampling, not a solid, so cells that
    // touch only along an edge or a corner are still the same sheet. Measured on a synthetic
    // 40-gaussian blob that happened to straddle a voxel corner, 6-connectivity reported it as two
    // separate clusters; with 26 it stays one, which is what "this blob is one floater" means.
    const label = new Int32Array(voxelCount).fill(-1);
    const stack = new Int32Array(voxelCount);
    let clusterCount = 0;

    for (let v = 0; v < voxelCount; v++) {
        if (label[v] !== -1) continue;
        const id = clusterCount++;
        let sp = 0;
        stack[sp++] = v;
        label[v] = id;
        while (sp > 0) {
            const cur = stack[--sp];
            const ix = voxelCoords[cur * 3];
            const iy = voxelCoords[cur * 3 + 1];
            const iz = voxelCoords[cur * 3 + 2];
            for (let dx = -1; dx <= 1; dx++) {
                const nx = ix + dx;
                if (nx < 0 || nx > KEY_LIMIT) continue;
                for (let dy = -1; dy <= 1; dy++) {
                    const ny = iy + dy;
                    if (ny < 0 || ny > KEY_LIMIT) continue;
                    for (let dz = -1; dz <= 1; dz++) {
                        if (dx === 0 && dy === 0 && dz === 0) continue;
                        const nz = iz + dz;
                        if (nz < 0 || nz > KEY_LIMIT) continue;
                        const nv = keyToIndex.get(packKey(nx, ny, nz));
                        if (nv !== undefined && label[nv] === -1) {
                            label[nv] = id;
                            stack[sp++] = nv;
                        }
                    }
                }
            }
        }
    }

    // ---- 4) cluster sizes (in gaussians, not voxels) ----
    const sizes = new Int32Array(clusterCount);
    for (let i = 0; i < numSplats; i++) {
        const vi = voxelOfPoint[i];
        if (vi >= 0) {
            sizes[label[vi]]++;
        }
    }
    let largestSize = 0;
    let largestId = -1;
    for (let c = 0; c < clusterCount; c++) {
        if (sizes[c] > largestSize) {
            largestSize = sizes[c];
            largestId = c;
        }
    }

    // ---- 5) mask ----
    const threshold = (largestSize * minPct) / 100;
    const smallMask = new Uint8Array(clusterCount);
    let smallClusterCount = 0;
    for (let c = 0; c < clusterCount; c++) {
        const isSmall = c !== largestId && (mode === 'largest' || sizes[c] < threshold);
        if (isSmall) {
            smallMask[c] = 1;
            smallClusterCount++;
        }
    }

    let count = 0;
    for (let i = 0; i < numSplats; i++) {
        const vi = voxelOfPoint[i];
        if (vi >= 0 && smallMask[label[vi]]) {
            mask[i] = 255;
            count++;
        }
    }

    return {
        mask,
        count,
        clusterCount,
        largestSize,
        smallClusterCount,
        voxelSize
    };
}
