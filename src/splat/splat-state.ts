import { Texture } from 'playcanvas';

import { IndexRanges } from '../core/index-ranges';

enum State {
    selected = 1,
    locked = 2,
    deleted = 4
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
     */
    applySelectionMask(preMask: Uint8Array, mask: Uint8Array, managed: Uint8Array, op: SelectionOp): void {
        this.writeSelectionMask(preMask, mask, managed, op, false);
    }

    /** 撤销用：把"当前掩码会选中的行"清掉（等价于旧实现里的 clearBits(applied)）。 */
    revertSelectionMask(preMask: Uint8Array, mask: Uint8Array, managed: Uint8Array, op: SelectionOp): void {
        this.writeSelectionMask(preMask, mask, managed, op, true);
    }

    private writeSelectionMask(
        preMask: Uint8Array,
        mask: Uint8Array,
        managed: Uint8Array,
        op: SelectionOp,
        revert: boolean
    ): void {
        const { data } = this;
        const n = data.length;
        let lo = Infinity;
        let hi = -1;

        for (let i = 0; i < n; i++) {
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
