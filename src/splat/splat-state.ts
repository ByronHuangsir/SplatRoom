import { Texture } from 'playcanvas';

import { STATE_DELETED, STATE_LOCKED, STATE_SELECTED } from './state-bits';
import { IndexRanges } from '../core/index-ranges';

// 位值住在 splat/state-bits.ts（不引 playcanvas），因为 worker 侧的投影循环也要用同一份定义，
// 而 worker 一旦间接引到 playcanvas 就会把整个引擎打进 worker bundle。
enum State {
    selected = STATE_SELECTED,
    locked = STATE_LOCKED,
    deleted = STATE_DELETED
}

/**
 * 掩码与"手势开始时的选区"怎么合成本次要选的行 —— 与 editor.ts 的 `opKind` 一一对应。
 * 放成数字是为了让"按掩码写一整趟"的内层循环里没有字符串比较（O2）。
 */
enum SelectionOp {
    set = 0,
    add = 1,
    remove = 2,
    intersect = 3
}

/**
 * 让出一个**宏**任务。
 *
 * 为什么必须是宏任务：`await Promise.resolve()` 这类微任务只在同一个任务内部插队，而心跳
 * （`setInterval`）、渲染（rAF）、输入事件全都排在宏任务队列里 —— 用微任务"让出"等于没让，
 * 主线程照样被一整段占住（这正是 20M 夹具上"端到端 1082ms 里有 320ms 一次不让"的成因）。
 *
 * 为什么**不用** `scheduler.yield()`（20M 夹具实测，见 _tmp/p01-yield-ab.json）：
 * 它把续体排成一条比定时器**更高优先级**的任务链，于是"让出"了却谁也没插进来 ——
 * 同一个手势窗口里，心跳量到的单次阻塞是 193.8 / 262.3 ms（和不让出时一样糟），
 * rAF 也照样 102–147ms；换成 MessageChannel / setTimeout(0) 后同样的代码是 30.7–35.8 ms、
 * rAF 25ms。所以这里默认 MessageChannel（不受 setTimeout 的 4ms 嵌套钳制），
 * setTimeout(0) 只作为没有 MessageChannel 时的兜底。
 *
 * 量测开关：`window.__SPLATROOM_YIELD__ = 'channel' | 'timeout' | 'scheduler'`
 * 强制某一条，用来在真机上 A/B（默认 auto = channel）。
 */
type YieldKind = 'scheduler' | 'channel' | 'timeout';

const channelYield = (() => {
    const channel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
    const queue: Array<() => void> = [];
    if (channel) {
        channel.port1.onmessage = () => {
            const fn = queue.shift();
            if (fn) {
                fn();
            }
        };
    }
    return (resolve: () => void) => {
        if (!channel) {
            setTimeout(resolve, 0);
            return;
        }
        queue.push(resolve);
        channel.port2.postMessage(0);
    };
})();

const yieldMacrotask = (): Promise<void> => new Promise<void>((resolve) => {
    const forced = typeof window !== 'undefined' ? (window as any).__SPLATROOM_YIELD__ : undefined;
    const kind: YieldKind = forced === 'timeout' || forced === 'scheduler' ? forced : 'channel';

    if (kind === 'scheduler') {
        const sched = (globalThis as any).scheduler;
        if (!sched || typeof sched.yield !== 'function') {
            channelYield(resolve);
            return;
        }
        // 失败也照样 resolve：让出失败最多是"这一片没让成"，不该把一次选择干掉
        sched.yield().then(resolve, resolve);
    } else if (kind === 'timeout') {
        setTimeout(resolve, 0);
    } else {
        channelYield(resolve);
    }
});

/**
 * 分块写状态位的内层块（行数）与"该让出了"的时间阈值（ms）。
 *
 * 单块耗时 ≈ 块内行数 × 每行成本；20M 夹具上整趟 `writeSelectionMask` 是 135–180ms ⇒ 取 2^18 行
 * 时单块 ≈ 1.7–2.3ms。阈值 8ms 把单次连续占用压到「8ms + 一块」，同时把让出次数压到 ~20 次
 * （每次让出的固定成本 0.1–1ms，合计 2–20ms）——总时长基本不变，但主线程每 ~10ms 就有一次机会。
 */
const WRITE_BLOCK_ROWS = 1 << 18;
const WRITE_YIELD_MS = 8;

// M2-2（P1-1）：脏区间上传的参数。
//
// 脏 span 数量上限：超过就把所有 span 合并成一条 [min, max]。8 条足够覆盖典型手势
// （一次框选/推杆通常是 1–3 条；散点编辑是几条到几十条 run，合并成一条也不劣于旧实现
// —— 旧实现从头到尾只有一条 [dirtyLo, dirtyHi]）。
const MAX_DIRTY_SPANS = 8;
// 脏字节占全表的比例达到这个阈值时改走引擎整块路径（lock/set/unlock）。这不是保守兜底，
// 是各后端的最优解：整块路径只做 1 次 CPU 拷贝（buffer.set）+ 1 次全量上传；直传路径要做
// 3 次（staging 拷贝 + 上传 + 镜像拷贝），20M 实测 7.3ms vs 1.7ms。半表以下的脏集
// 直传只搬脏字节，才是收益区。20M 上阈值 ≈ 10MB，高于 4MB 的验收上限，
// 所以「上传 ≤ 4MB」的手势路径永远走直传。
const FULL_UPLOAD_FRACTION = 0.5;

/**
 * 把字节数向上取整到 WebGPU `writeTexture` 要求的 256 对齐行距。
 */
const roundUp256 = (n: number) => (n + 255) & ~255;

// CPU/GPU mirror of the per-splat state byte (selected/locked/deleted bits).
// Mutators record dirty spans; flush() uploads only those spans to the GPU
// texture and refreshes the cached counts. Replaces the implicit "remember to
// call updateState() after mutating state[]" contract with an encapsulated owner.
class SplatState {
    // shared with splatData.getProp('state') so existing read consumers keep
    // working without any indirection. SplatState is the sole writer.
    readonly data: Uint8Array;
    private readonly gpu: Texture;

    // M2-2: dirty tracking is now a small list of non-overlapping spans
    // (mutators mark each touched run) instead of a single [lo, hi] envelope.
    // Spans are kept sorted and merged; when the list overflows it collapses
    // to one envelope span. `dirtyLo`/`dirtyHi` getters preserve the old
    // single-span read API (verify-crop-export-state reads them).
    private spans: Array<[number, number]> = [];

    // 探针钩子（docs/verify 与 _tmp 探针读，不参与任何逻辑）：
    // 上一次 flush 实际上传的字节数与走的是哪条路径（sub / full / none）。
    lastFlushBytes = 0;
    lastFlushPath: 'sub' | 'full' | 'none' = 'none';

    // WebGPU 子矩形上传的行距 padding 复用缓冲（按需增长，只在 flush 之间存活）。
    private staging: Uint8Array | null = null;

    // cached counts, refreshed by flush().
    numSelected = 0;
    numLocked = 0;
    numDeleted = 0;

    // O2/O4/M2-2: true when the three counts above are already exact for the current bytes.
    // Bulk mutators (setBits/clearBits/toggleBits) now maintain the three counts
    // incrementally as long as they were exact on entry, so a full-table recount
    // only happens once (the seed flush after import). writeSelectionMask keeps
    // its own incremental numSelected maintenance for the same reason.
    private countsExact = false;

    constructor(data: Uint8Array, gpu: Texture) {
        this.data = data;
        this.gpu = gpu;

        // mark everything dirty so the first flush uploads whatever was loaded
        // from disk (ply state column) and seeds the cached counts.
        this.markSpans(0, data.length);
    }

    /** 旧单区间 API 的兼容读法：第一条 span 的 lo（无脏为 -1）。 */
    get dirtyLo(): number {
        return this.spans.length > 0 ? this.spans[0][0] : -1;
    }

    /** 旧单区间 API 的兼容读法：最后一条 span 的 hi（无脏为 -1）。 */
    get dirtyHi(): number {
        return this.spans.length > 0 ? this.spans[this.spans.length - 1][1] : -1;
    }

    /**
     * 记一条脏区间 [lo, hi)。span 列表保持有序、不重叠、不邻接（相邻就合并）；
     * 超过 MAX_DIRTY_SPANS 条时合并成一条 [min, max] 包络。
     */
    private markSpans(lo: number, hi: number) {
        if (hi <= lo) return;
        const spans = this.spans;
        if (spans.length === 0) {
            spans.push([lo, hi]);
            return;
        }
        // 找插入点：第一条 lo 大于新 hi 的 span
        let i = 0;
        while (i < spans.length && spans[i][1] < lo) i++;
        // 新 span 与 [i, j) 内的 span 都重叠或邻接
        let j = i;
        let nlo = lo;
        let nhi = hi;
        while (j < spans.length && spans[j][0] <= hi) {
            if (spans[j][0] < nlo) nlo = spans[j][0];
            if (spans[j][1] > nhi) nhi = spans[j][1];
            j++;
        }
        spans.splice(i, j - i, [nlo, nhi]);
        if (spans.length > MAX_DIRTY_SPANS) {
            const first = spans[0][0];
            const last = spans[spans.length - 1][1];
            spans.length = 0;
            spans.push([first, last]);
        }
    }

    /**
     * recount 语义下的互斥桶编号：deleted > locked > selected > 无（与 recount() 一一对应）。
     */
    private static bucket(s: number): number {
        if (s & State.deleted) return 3;
        if (s & State.locked) return 2;
        if (s & State.selected) return 1;
        return 0;
    }

    private bump(bucket: number, delta: number) {
        if (bucket === 1) this.numSelected += delta;
        else if (bucket === 2) this.numLocked += delta;
        else if (bucket === 3) this.numDeleted += delta;
    }

    setBits(ranges: IndexRanges, mask: number): void {
        const { data } = this;
        const exact = this.countsExact;
        ranges.forEachRun((start, end) => {
            for (let i = start; i < end; i++) {
                const before = data[i];
                const after = before | mask;
                if (after === before) continue;
                data[i] = after;
                if (exact) {
                    const b0 = SplatState.bucket(before);
                    const b1 = SplatState.bucket(after);
                    if (b0 !== b1) {
                        this.bump(b0, -1);
                        this.bump(b1, 1);
                    }
                }
            }
            this.markSpans(start, end);
        });
        // countsExact 不变：exact 时这趟已增量维护；非 exact（导入后第一次 flush 前）
        // 保持 false，由 seed flush 的 recount 兜底 —— 与 writeSelectionMask 同一约定。
    }

    clearBits(ranges: IndexRanges, mask: number): void {
        const { data } = this;
        const exact = this.countsExact;
        ranges.forEachRun((start, end) => {
            for (let i = start; i < end; i++) {
                const before = data[i];
                const after = before & ~mask;
                if (after === before) continue;
                data[i] = after;
                if (exact) {
                    const b0 = SplatState.bucket(before);
                    const b1 = SplatState.bucket(after);
                    if (b0 !== b1) {
                        this.bump(b0, -1);
                        this.bump(b1, 1);
                    }
                }
            }
            this.markSpans(start, end);
        });
    }

    toggleBits(ranges: IndexRanges, mask: number): void {
        const { data } = this;
        const exact = this.countsExact;
        ranges.forEachRun((start, end) => {
            for (let i = start; i < end; i++) {
                const before = data[i];
                const after = before ^ mask;
                if (after === before) continue;
                data[i] = after;
                if (exact) {
                    const b0 = SplatState.bucket(before);
                    const b1 = SplatState.bucket(after);
                    if (b0 !== b1) {
                        this.bump(b0, -1);
                        this.bump(b1, 1);
                    }
                }
            }
            this.markSpans(start, end);
        });
    }

    /**
     * O2（docs/audit/00-总结.md）：**一趟**按掩码写选中位，替掉「掩码 → `fromPredicate` 构建区间 →
     * clearBits(pre) + clearBits(applied) + setBits(post)」这几趟全扫，顺带在同一趟里增量维护
     * `numSelected`（省掉 flush 的全表 recount）。
     *
     * 三个输入的含义：
     *   `preMask` —— 手势开始时的选中集（不含 locked）；
     *   `mask`     —— 本次掩码（255 = 命中），由 selectRange / selectRangeFromCache 产出；
     *   `managed`  —— 本算子接管的行的位图（手势开始时 = preMask ∪ mask；之后**只增不减**，
     *                 由掩码产出那一趟顺手置位，见 selectRange 的 `mark` 参数）。
     * 只有被接管的行才写：locked（隐藏）的行带着 selected 位落在接管范围之外，必须原样保留。
     * 被接管的行上，选中位完全由 `want`（当前掩码 + preMask 的组合）决定 ——
     * 这正是旧实现 clearBits(pre)+clearBits(applied)+setBits(post) 的净效果。
     *
     * **分块 + 让出宏任务**（2026-09-20）：20M 夹具上这一趟是 135–180ms 的**单次**主线程占用，
     * 占"框选期间最长阻塞"的一半。现在按行区间分块、块间让出宏任务（见 yieldMacrotask），
     * 单次连续占用降到 ~10ms 量级，而**逐位结果与一趟跑完完全相同**：每一行的判定只依赖这一行
     * 自己的 preMask/mask/managed/data，块边界不改变任何一行的输入或输出；`lo`/`hi` 跨块累积、
     * 脏标记仍在整趟结束时调一次，`numSelected` 的增量维护也是纯加法。
     * 让出期间别的历史算子不会插进来 —— 所有状态写入都从 edit-history 的 commandQueue 走。
     */
    applySelectionMask(preMask: Uint8Array, mask: Uint8Array, managed: Uint8Array, op: SelectionOp): Promise<void> {
        return this.writeSelectionMask(preMask, mask, managed, op, false);
    }

    /** 撤销用：把"当前掩码会选中的行"清掉（等价于旧实现里的 clearBits(applied)）。 */
    revertSelectionMask(preMask: Uint8Array, mask: Uint8Array, managed: Uint8Array, op: SelectionOp): Promise<void> {
        return this.writeSelectionMask(preMask, mask, managed, op, true);
    }

    private async writeSelectionMask(
        preMask: Uint8Array,
        mask: Uint8Array,
        managed: Uint8Array,
        op: SelectionOp,
        revert: boolean
    ): Promise<void> {
        const { data } = this;
        const n = data.length;
        let lo = Infinity;
        let hi = -1;
        let lastYield = performance.now();

        for (let base = 0; base < n; base += WRITE_BLOCK_ROWS) {
            const blockEnd = Math.min(base + WRITE_BLOCK_ROWS, n);

            for (let i = base; i < blockEnd; i++) {
                if (managed[i] === 0) {
                    continue;
                }
                const had = preMask[i] !== 0;
                const hit = mask[i] === 255;
                let want: boolean;
                switch (op) {
                    case SelectionOp.add: want = had || hit; break;
                    case SelectionOp.remove: want = had && !hit; break;
                    case SelectionOp.intersect: want = had && hit; break;
                    default: want = hit; break;
                }

                const before = data[i];
                let after: number;
                if (revert) {
                    // 撤销只清"本算子写进去的那些行"
                    if (!want || (before & State.selected) === 0) {
                        continue;
                    }
                    after = before & ~State.selected;
                } else {
                    after = want ? (before | State.selected) : (before & ~State.selected);
                    if (after === before) {
                        continue;
                    }
                }

                data[i] = after;
                if (i < lo) lo = i;
                if (i + 1 > hi) hi = i + 1;

                // 计数：recount 的口径是 deleted > locked > selected > 无 的互斥桶，而这里只动
                // selected 位，所以只有"既没删也没锁"的行会进出 numSelected
                if ((before & (State.deleted | State.locked)) === 0) {
                    if (revert) {
                        this.numSelected--;
                    } else if (want) {
                        this.numSelected++;
                    } else {
                        this.numSelected--;
                    }
                }
            }

            // 还有剩下的块、而且这一片已经连续占了 ≥ WRITE_YIELD_MS ⇒ 让出一次宏任务
            if (blockEnd < n && performance.now() - lastYield >= WRITE_YIELD_MS) {
                await yieldMacrotask();
                lastYield = performance.now();
            }
        }

        if (hi > 0) this.markSpans(lo, hi);
        // countsExact 保持不变：本趟是**相对**当前计数增量维护的，之前的脏状态由 flush 兜底
    }

    // recount selected/locked/deleted from scratch. cheap relative to a GPU
    // readback (single CPU pass over numSplats bytes) and only triggered from
    // flush, so the same call that uploads to GPU also refreshes counts.
    // M2-2: after the seed flush this runs at most once more per import —
    // all mutators maintain the counts incrementally now.
    private recount() {
        const { data } = this;
        let numSelected = 0;
        let numLocked = 0;
        let numDeleted = 0;
        for (let i = 0; i < data.length; ++i) {
            const s = data[i];
            if (s & State.deleted) {
                numDeleted++;
            } else if (s & State.locked) {
                numLocked++;
            } else if (s & State.selected) {
                numSelected++;
            }
        }
        this.numSelected = numSelected;
        this.numLocked = numLocked;
        this.numDeleted = numDeleted;
        this.countsExact = true;
    }

    /**
     * M2-2（P1-1）：把一条脏 span 按行扩展后**只上传那几行**到 GPU 状态纹理。
     *
     * 两条后端各有一条直传路径（都不经过 `Texture.lock()`，因此没有全表 memcpy、也不碰
     * 引擎的 staging/回读）：
     *   WebGPU：`wgpu.queue.writeTexture` 子矩形写。引擎的数据纹理宽度是 `ceil(sqrt(n))`
     *           （20M → 4473），**不是 256 的倍数**，所以多行写必须把行距 padding 到 256 ——
     *           用一块复用的 staging 缓冲逐行拷过去（行内 padding 区不会被读取）。
     *           仓库先例：`splat.ts` 的 `writeCurveTable`（uCurve 直传）。
     *   WebGL2：`gl.texSubImage2D` 直写（`UNPACK_ALIGNMENT=1`，任意行宽都合法）。
     *
     * 同时把脏字节镜像进引擎的 `_levels[0]`（`getSource(0)`）：上下文恢复时引擎会从这份
     * CPU 镜像重传纹理，不镜像的话恢复后选中/删除状态会回退到上次整块上传的样子。
     *
     * @returns 是否成功（false ⇒ 调用方退回整块上传，语义与旧实现完全一致）
     */
    private uploadSpan(lo: number, hi: number, W: number): boolean {
        const { data, gpu } = this;
        const n = data.length;
        const texH = gpu.height;
        const y0 = Math.floor(lo / W);
        const y1 = Math.min(texH, Math.ceil(hi / W));
        if (y1 <= y0) return true;

        const device = (gpu as any).device as any;
        const rows = y1 - y0;
        let ok = false;
        try {
            if (device?.wgpu?.queue && (gpu as any).impl?.gpuTexture) {
                // ---- WebGPU：queue.writeTexture 子矩形（行距 padding 到 256） ----
                const queue = device.wgpu.queue;
                const gpuTexture = (gpu as any).impl.gpuTexture;
                const padded = roundUp256(W);
                const needed = padded * (rows - 1) + W;
                if (!this.staging || this.staging.length < needed) {
                    this.staging = new Uint8Array(needed);
                }
                const staging = this.staging;
                for (let r = 0; r < rows; r++) {
                    const srcOff = (y0 + r) * W;
                    const valid = Math.min(W, n - srcOff);
                    const dstOff = r * padded;
                    if (valid > 0) {
                        staging.set(data.subarray(srcOff, srcOff + valid), dstOff);
                    }
                    if (valid < W) {
                        // 末尾不完整的行：纹理里 numSplats 之后本来就是 0，这里补零保持一致
                        staging.fill(0, dstOff + Math.max(valid, 0), dstOff + W);
                    }
                }
                // 与引擎 uploadTypedArrayData 同样的顺序保证：先把挂起的命令编出去，再排队写
                device.submit?.();
                queue.writeTexture(
                    { texture: gpuTexture, origin: [0, y0, 0] },
                    staging,
                    { offset: 0, bytesPerRow: padded, rowsPerImage: rows },
                    { width: W, height: rows }
                );
                ok = true;
            } else if (device?.gl && (gpu as any).impl?._glTexture) {
                // ---- WebGL2：gl.texSubImage2D 直写（UNPACK_ALIGNMENT=1） ----
                const gl = device.gl;
                const impl = (gpu as any).impl;
                const glTex = impl._glTexture;
                const format = impl._glFormat ?? gl.RED;
                const type = impl._glPixelType ?? gl.UNSIGNED_BYTE;
                const prevAlign = gl.getParameter(gl.UNPACK_ALIGNMENT);
                gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
                try {
                    gl.bindTexture(gl.TEXTURE_2D, glTex);
                    // 完整行一次写；末尾不完整的行单独写一行（宽度 = 有效字节数）
                    const fullRows = n >= y1 * W ? rows : rows - 1;
                    if (fullRows > 0) {
                        gl.texSubImage2D(
                            gl.TEXTURE_2D, 0, 0, y0, W, fullRows, format, type,
                            data.subarray(y0 * W, (y0 + fullRows) * W)
                        );
                    }
                    if (fullRows < rows) {
                        const lastY = y1 - 1;
                        const valid = n - lastY * W;
                        if (valid > 0) {
                            gl.texSubImage2D(
                                gl.TEXTURE_2D, 0, 0, lastY, valid, 1, format, type,
                                data.subarray(lastY * W, n)
                            );
                        }
                    }
                    ok = true;
                } finally {
                    gl.pixelStorei(gl.UNPACK_ALIGNMENT, prevAlign);
                }
            }
        } catch (e) {
            console.warn('[SplatState] sub-rect upload failed, falling back to full upload:', e);
            ok = false;
        }

        if (!ok) return false;

        // 镜像到引擎的 CPU level（上下文恢复时从这里重传）；只拷本 span 的字节
        const level = (gpu as any).getSource?.(0);
        if (level && level.set) {
            const mirrorHi = Math.min(hi, level.length);
            if (mirrorHi > lo) {
                level.set(data.subarray(lo, mirrorHi), lo);
            }
        }
        return true;
    }

    // upload dirty spans to the GPU texture and refresh cached counts.
    // idempotent and cheap when nothing is dirty.
    // M2-2 (P1-1): only the dirty spans reach the GPU. A gesture-sized edit
    // uploads kilobytes-to-megabytes instead of the whole 1-byte-per-splat
    // table (20M model: 20 MB per flush, measured 17-20ms — see
    // docs/perf/交互期降级-实现与实测.md §9). A dirty set covering at least
    // half the table (select-all, the seed flush after import) takes the
    // engine's full lock/set/unlock path, which is cheaper at that size
    // (one copy + one upload vs three passes for the direct path) and also
    // seeds the engine's CPU level mirror in the same pass.
    flush(): void {
        if (this.spans.length === 0) {
            this.lastFlushBytes = 0;
            this.lastFlushPath = 'none';
            return;
        }
        const gpu = this.gpu;
        const W = gpu.width;
        const texBytes = W * gpu.height;
        const dirtyBytes = this.spans.reduce((sum, s) => sum + (s[1] - s[0]), 0);

        if (dirtyBytes >= texBytes * FULL_UPLOAD_FRACTION) {
            this.fullUpload();
        } else if (this.directUploadReady()) {
            let uploaded = 0;
            let allOk = true;
            for (const [lo, hi] of this.spans) {
                if (!this.uploadSpan(lo, hi, W)) {
                    allOk = false;
                    break;
                }
                const y0 = Math.floor(lo / W);
                const y1 = Math.min(gpu.height, Math.ceil(hi / W));
                uploaded += (y1 - y0) * W;
            }
            if (!allOk) {
                this.fullUpload();
            } else {
                this.lastFlushBytes = uploaded;
                this.lastFlushPath = 'sub';
            }
        } else {
            this.fullUpload();
        }
        // O4: the recount is a full-table scan that only the seed flush needs now —
        // bulk mutators and the per-mask writer both maintain the counts.
        if (!this.countsExact) {
            this.recount();
        }
        this.spans.length = 0;
    }

    /**
     * 直传通道是否就绪：引擎的 CPU level（`_levels[0]`，seed flush 建立）存在，
     * 且当前后端拿得到直写入口（WebGPU 的 queue+gpuTexture / WebGL2 的 gl+_glTexture）。
     * level 不存在时必须走引擎整块路径，否则上下文恢复时没有 CPU 镜像可重传。
     */
    private directUploadReady(): boolean {
        const gpu = this.gpu as any;
        const device = gpu?.device as any;
        const level = gpu?.getSource?.(0);
        if (!level || !level.set) return false;
        if (device?.wgpu?.queue && gpu.impl?.gpuTexture) return true;
        if (device?.gl && gpu.impl?._glTexture) return true;
        return false;
    }

    /** 整块上传（引擎 lock/set/unlock，会同时写好 _levels[0] 镜像）。 */
    private fullUpload() {
        const buffer = this.gpu.lock() as Uint8Array;
        buffer.set(this.data);
        this.gpu.unlock();
        this.lastFlushBytes = buffer.length;
        this.lastFlushPath = 'full';
    }
}

export { State, SplatState, SelectionOp };
