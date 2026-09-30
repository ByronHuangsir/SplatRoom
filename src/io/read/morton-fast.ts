/**
 * M3-2：morton 排序 + 列重排的快速实现。
 *
 * 与 splat-transform 的 `sortMortonColumns` / `DataTable.permuteRowsInPlace`
 * **逐步一致**（同样的网格量化、同样的稳定顺序、同样的 >256 桶递归细化规则），
 * 输出逐字节相同，差别只在：
 *   1. 排序用**稳定 LSD 基数排序**（2×15 bit 两遍）替代带 JS 比较器的
 *      `Uint32Array.sort` —— 20M 上 7.3s → ~1.5s（比较器每元素要做两次随机读，
 *      且 V8 的 TimSort 对 typed array + 比较器是回调驱动的）；
 *   2. permute 带进度回调（每列一次），循环结构不变 —— 纯置换，
 *      `dst[i] = src[indices[i]]` 的结果与循环顺序无关。
 *
 *  worker（`load-worker.ts`）与主线程（`read/loader.ts`）**都用这一份**，
 *  两条导入路径的产物保持逐字节一致（`verify-import-worker.cjs` 的硬断言）。
 */

type FloatCols = Float32Array | Float64Array;

// https://fgiesen.wordpress.com/2009/12/13/decoding-morton-codes/
// 与库里的 encodeMorton3 逐位相同。
const Part1By2 = (v: number): number => {
    v &= 0x000003ff;
    v = (v ^ (v << 16)) & 0xff0000ff;
    v = (v ^ (v << 8)) & 0x0300f00f;
    v = (v ^ (v << 4)) & 0x030c30c3;
    v = (v ^ (v << 2)) & 0x09249249;
    return v;
};

const encodeMorton3 = (x: number, y: number, z: number): number => (Part1By2(z) << 2) + (Part1By2(y) << 1) + Part1By2(x);

type Extent = {
    mx: number; my: number; mz: number;
    Mx: number; My: number; Mz: number;
};

// 稳定 LSD 基数排序：把 (idx, code) 对按 30 位无符号码排序，两遍 15 bit。
// 码必须跟着元素一起走（不能按"位置索引"查码 —— 排序后位置与元素脱钩，
// 那样读到的是别的元素的码，排序结果整个错掉；实测 20M 上错序导致
// 等码桶检测失效、递归细化爆栈）。结果写回 `sub` 与 `codes`（排好序的码序）。
const radixSortPairs = (
    sub: Uint32Array, codes: Uint32Array,
    idxScratch: Uint32Array, codeScratch: Uint32Array
): void => {
    const n = sub.length;
    const COUNT = 1 << 15;
    const count = new Uint32Array(COUNT);
    const dstIdx = idxScratch.subarray(0, n);
    const dstCode = codeScratch.subarray(0, n);

    // pass 0：低 15 位（sub/codes → dst）
    count.fill(0);
    for (let i = 0; i < n; i++) {
        count[codes[i] & 0x7fff]++;
    }
    let sum = 0;
    for (let i = 0; i < COUNT; i++) {
        const c = count[i];
        count[i] = sum;
        sum += c;
    }
    for (let i = 0; i < n; i++) {
        const c = codes[i];
        const p = count[c & 0x7fff]++;
        dstIdx[p] = sub[i];
        dstCode[p] = c;
    }

    // pass 1：高 15 位（dst → sub/codes）
    count.fill(0);
    for (let i = 0; i < n; i++) {
        count[dstCode[i] >>> 15]++;
    }
    sum = 0;
    for (let i = 0; i < COUNT; i++) {
        const c = count[i];
        count[i] = sum;
        sum += c;
    }
    for (let i = 0; i < n; i++) {
        const c = dstCode[i];
        const p = count[c >>> 15]++;
        sub[p] = dstIdx[i];
        codes[p] = c;
    }
};

/**
 * 把 `indices` 原地排成 morton 序（列式 x/y/z）。
 * 语义与 splat-transform `sortMortonColumns` 完全一致：
 * 同一层 10-bit/轴量化 + 稳定排序 + 等码桶 >256 行时按桶内实际范围递归细化。
 *
 * @param extent - 可选：顶层位置范围（调用方在物化时顺手算好的）。不给就自己扫一遍。
 */
const sortMortonColumnsFast = (
    x: FloatCols, y: FloatCols, z: FloatCols,
    indices: Uint32Array,
    extent?: Extent | null
): void => {
    if (indices.length === 0) {
        return;
    }
    // 每层共用的 scratch（长度按顶层分配，子层只用前缀）
    const codes = new Uint32Array(indices.length);
    const idxScratch = new Uint32Array(indices.length);
    const codeScratch = new Uint32Array(indices.length);

    const generate = (sub: Uint32Array, topExtent: Extent | null): void => {
        const n = sub.length;
        if (n === 0) {
            return;
        }
        let mx = Infinity, my = Infinity, mz = Infinity;
        let Mx = -Infinity, My = -Infinity, Mz = -Infinity;
        if (topExtent) {
            ({ mx, my, mz, Mx, My, Mz } = topExtent);
        } else {
            for (let i = 0; i < n; ++i) {
                const g = sub[i];
                const px = x[g], py = y[g], pz = z[g];
                if (px < mx) mx = px;
                if (px > Mx) Mx = px;
                if (py < my) my = py;
                if (py > My) My = py;
                if (pz < mz) mz = pz;
                if (pz > Mz) Mz = pz;
            }
        }
        const xlen = Mx - mx, ylen = My - my, zlen = Mz - mz;
        if (!isFinite(xlen) || !isFinite(ylen) || !isFinite(zlen)) {
            return;   // 与库一致：非法范围直接放弃排序
        }
        if (xlen === 0 && ylen === 0 && zlen === 0) {
            return;   // 所有点相同
        }
        const xmul = (xlen === 0) ? 0 : 1024 / xlen;
        const ymul = (ylen === 0) ? 0 : 1024 / ylen;
        const zmul = (zlen === 0) ? 0 : 1024 / zlen;
        // codes[i] 是 sub[i]（本层当前第 i 个元素）的码 —— 位置语义，与库一致
        for (let i = 0; i < n; ++i) {
            const g = sub[i];
            const ix = Math.min(1023, (x[g] - mx) * xmul) >>> 0;
            const iy = Math.min(1023, (y[g] - my) * ymul) >>> 0;
            const iz = Math.min(1023, (z[g] - mz) * zmul) >>> 0;
            codes[i] = encodeMorton3(ix, iy, iz);
        }
        // 排完后 codes 变为**排好序的码序**（radixSortPairs 原地写回）
        radixSortPairs(sub, codes, idxScratch, codeScratch);

        // 等码桶检测（排好序后同码相邻，顺序读 codes 即可）；>256 行的桶递归细化 —— 与库一致。
        // 先把桶范围收集出来再递归：codes/scratch 会被子层复用，边扫边递归会读到子层写掉的值。
        const buckets: number[] = [];
        let start = 0;
        for (let i = 1; i < n; i++) {
            if (codes[i] !== codes[start]) {
                if (i - start > 256) {
                    buckets.push(start, i);
                }
                start = i;
            }
        }
        if (n - start > 256) {
            buckets.push(start, n);
        }
        for (let b = 0; b < buckets.length; b += 2) {
            generate(sub.subarray(buckets[b], buckets[b + 1]), null);
        }
    };

    generate(indices, extent ?? null);
};

/**
 * 按 `indices` 原地重排所有列（`dst[i] = src[indices[i]]`）。
 * 与 `DataTable.permuteRowsInPlace` 逐字节一致（纯置换，与循环顺序无关），
 * 缓冲按尺寸复用；`onProgress` 每列结束报一次（0..1）。
 */
const permuteColumnsInPlace = (
    columns: readonly { data: ArrayLike<number> & { constructor: any }, [k: string]: any }[],
    indices: Uint32Array,
    onProgress?: (fraction: number) => void
): void => {
    const cache = new Map<number, ArrayBuffer>();
    const getBuffer = (size: number) => {
        const cached = cache.get(size);
        if (cached) {
            cache.delete(size);
            return cached;
        }
        return new ArrayBuffer(size);
    };
    const returnBuffer = (buffer: ArrayBuffer) => {
        cache.set(buffer.byteLength, buffer);
    };
    const n = indices.length;
    for (let c = 0; c < columns.length; c++) {
        const column = columns[c];
        const src = column.data as any;
        const dst = new src.constructor(getBuffer(src.byteLength));
        for (let i = 0; i < n; i++) {
            dst[i] = src[indices[i]];
        }
        returnBuffer(src.buffer);
        column.data = dst;
        onProgress?.((c + 1) / columns.length);
    }
};

export {
    sortMortonColumnsFast,
    permuteColumnsInPlace,
    type Extent
};
