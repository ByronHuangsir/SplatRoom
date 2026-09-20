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

// CPU/GPU mirror of the per-splat state byte (selected/locked/deleted bits).
// Mutators record a dirty range; flush() uploads to the GPU texture and refreshes
// the cached counts. Replaces the implicit "remember to call updateState() after
// mutating state[]" contract with an encapsulated owner.
class SplatState {
    // shared with splatData.getProp('state') so existing read consumers keep
    // working without any indirection. SplatState is the sole writer.
    readonly data: Uint8Array;
    private readonly gpu: Texture;
    private dirtyLo = -1;
    private dirtyHi = -1;

    // cached counts, refreshed by flush().
    numSelected = 0;
    numLocked = 0;
    numDeleted = 0;

    // O2/O4: true when the three counts above are already exact for the current bytes.
    // Set false by every bulk mutator (their rows are cheaper to re-derive in one pass than
    // to book-keep row by row), kept true by the per-mask writer, which maintains them
    // incrementally. flush() therefore only pays the full recount after a bulk edit.
    private countsExact = false;

    constructor(data: Uint8Array, gpu: Texture) {
        this.data = data;
        this.gpu = gpu;

        // mark everything dirty so the first flush uploads whatever was loaded
        // from disk (ply state column) and seeds the cached counts.
        this.dirtyLo = 0;
        this.dirtyHi = data.length;
    }

    private markDirty(lo: number, hi: number) {
        if (this.dirtyLo < 0) {
            this.dirtyLo = lo;
            this.dirtyHi = hi;
        } else {
            if (lo < this.dirtyLo) this.dirtyLo = lo;
            if (hi > this.dirtyHi) this.dirtyHi = hi;
        }
    }

    setBits(ranges: IndexRanges, mask: number): void {
        const { data } = this;
        let lo = Infinity;
        let hi = -1;
        // O3: walk the compact runs and spin the per-index loop inline. The old
        // `ranges.forEach(i => ...)` paid a closure call per index — 39–52M calls per
        // push on a 13M model — for work that is a byte-wise OR.
        ranges.forEachRun((start, end) => {
            if (start < lo) lo = start;
            if (end > hi) hi = end;
            for (let i = start; i < end; i++) {
                data[i] |= mask;
            }
        });
        if (hi > 0) this.markDirty(lo, hi);
        this.countsExact = false;
    }

    clearBits(ranges: IndexRanges, mask: number): void {
        const { data } = this;
        let lo = Infinity;
        let hi = -1;
        ranges.forEachRun((start, end) => {
            if (start < lo) lo = start;
            if (end > hi) hi = end;
            for (let i = start; i < end; i++) {
                data[i] &= ~mask;
            }
        });
        if (hi > 0) this.markDirty(lo, hi);
        this.countsExact = false;
    }

    toggleBits(ranges: IndexRanges, mask: number): void {
        const { data } = this;
        let lo = Infinity;
        let hi = -1;
        ranges.forEachRun((start, end) => {
            if (start < lo) lo = start;
            if (end > hi) hi = end;
            for (let i = start; i < end; i++) {
                data[i] ^= mask;
            }
        });
        if (hi > 0) this.markDirty(lo, hi);
        this.countsExact = false;
    }

    /**
     * O2（docs/audit/00-总结.md）：**一趟**按掩码写选中位，替掉「掩码 → `fromPredicate` 构建区间 →
     * clearBits(pre) + clearBits(applied) + setBits(post)」这几趟全扫，顺带在同一趟里增量维护
     * `numSelected`（省掉 flush 的全表 recount）。
     *
     * 三个输入的含义：
     *   `preMask`  —— 手势开始时的选中集（不含 locked）；
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
     * `markDirty` 仍在整趟结束时调一次，`numSelected` 的增量维护也是纯加法。
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

        if (hi > 0) this.markDirty(lo, hi);
        // countsExact 保持不变：本趟是**相对**当前计数增量维护的，之前的脏状态由 flush 兜底
    }

    // recount selected/locked/deleted from scratch. cheap relative to a GPU
    // readback (single CPU pass over numSplats bytes) and only triggered from
    // flush, so the same call that uploads to GPU also refreshes counts.
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

    // upload dirty bytes to the GPU texture and refresh cached counts.
    // idempotent and cheap when nothing is dirty.
    flush(): void {
        if (this.dirtyLo < 0) return;
        // full upload. sub-rect upload is a worthwhile future optimisation
        // (would drop a 4M-byte upload to a few KB for small selections) but
        // requires engine-side support; current path keeps the same behaviour
        // as the prior `updateState` lock/set/unlock pair.
        const buffer = this.gpu.lock() as Uint8Array;
        buffer.set(this.data);
        this.gpu.unlock();
        // O4: the recount is a full-table scan (13M bytes: 15–30ms) that a bulk edit needs
        // but the per-mask writer already keeps up to date, so only pay it when a bulk
        // mutator touched the bytes since the last flush.
        if (!this.countsExact) {
            this.recount();
        }
        this.dirtyLo = -1;
        this.dirtyHi = -1;
    }
}

export { State, SplatState, SelectionOp };
