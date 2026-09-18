// High bit flags a single index entry (1 uint32) vs a range pair [start, count] (2 uint32s).
// This limits index values to 2^31 - 1, which is sufficient for any practical gaussian count.
const SINGLE_BIT = 0x80000000;
const INDEX_MASK = 0x7FFFFFFF;

// O3 (docs/audit/00-总结.md): fromPredicate runs on every selection op, and it used to
// `push` into a growable JS `number[]` and then convert (`new Uint32Array(ranges)`) —
// a reallocation chain plus a full copy, worst case 8 bytes per entry of garbage
// (a fragmented 13M-row selection meant ~104MB of `number[]` plus the copy).
// Instead write straight into this reusable Uint32Array, doubling when it fills, and
// hand back one exact-size copy at the end.
const SCRATCH_MIN = 1024;
// don't retain a pathological scratch (a maximally fragmented selection can produce
// one entry per row): above this we still use the buffer for the call, then drop it
const SCRATCH_MAX_KEEP = 1 << 22;   // 4M entries = 16MB
let scratch = new Uint32Array(SCRATCH_MIN);

/**
 * Create a cursor-based membership predicate from sorted unique IDs. Returns a function
 * that tests whether a given index is in the set.
 *
 * The cursor is advanced past every id below `i` before the comparison, so callers may
 * skip `i` values (short-circuit `&&`, or an early-out on a state bit) without losing
 * hits: a stale cursor used to make every later id read as "not hit" — silently, which
 * is exactly the shape of bug this container exists to avoid.
 */
const sortedPredicate = (sortedIds: Uint32Array): (i: number) => boolean => {
    const n = sortedIds.length;
    let cursor = 0;
    return (i: number) => {
        while (cursor < n && sortedIds[cursor] < i) cursor++;
        if (cursor < n && sortedIds[cursor] === i) {
            cursor++;
            return true;
        }
        return false;
    };
};

/**
 * A compact container for storing and iterating sets of indices. Internally stores contiguous
 * runs as [start, count] pairs and lone indices as single entries with a high-bit flag.
 * Efficient for spatially coherent data where selections form long contiguous runs.
 */
class IndexRanges {
    readonly data: Uint32Array;

    private constructor(data: Uint32Array) {
        this.data = data;
    }

    /**
     * Build ranges by scanning [0, total) and including indices where pred returns true.
     * Single pass, O(total).
     */
    static fromPredicate(total: number, pred: (i: number) => boolean) {
        if (scratch.length < SCRATCH_MIN) {
            scratch = new Uint32Array(SCRATCH_MIN);
        }
        let out = scratch;
        let n = 0;

        // called once per contiguous run (not per index), so the closure is free
        const flush = (start: number, count: number) => {
            const needed = count === 1 ? 1 : 2;
            if (n + needed > out.length) {
                const grown = new Uint32Array(Math.max(out.length * 2, n + needed));
                grown.set(out.subarray(0, n));
                out = grown;
                scratch = grown.length <= SCRATCH_MAX_KEEP ? grown : scratch;
            }
            if (count === 1) {
                out[n++] = start | SINGLE_BIT;
            } else {
                out[n++] = start;
                out[n++] = count;
            }
        };

        let rangeStart = -1;

        for (let i = 0; i < total; ++i) {
            if (pred(i)) {
                if (rangeStart === -1) rangeStart = i;
            } else if (rangeStart !== -1) {
                flush(rangeStart, i - rangeStart);
                rangeStart = -1;
            }
        }
        if (rangeStart !== -1) {
            flush(rangeStart, total - rangeStart);
        }

        return new IndexRanges(out.slice(0, n));
    }

    /** Whether there are no indices. */
    get empty() {
        return this.data.length === 0;
    }

    /**
     * Iterate each contiguous run as a half-open [start, end) pair. O(runs), not O(indices),
     * so callers can do their own tight per-index loop with no closure in the hot path.
     */
    forEachRun(fn: (start: number, end: number) => void) {
        const { data } = this;
        let r = 0;
        while (r < data.length) {
            if (data[r] & SINGLE_BIT) {
                const index = data[r] & INDEX_MASK;
                fn(index, index + 1);
                r += 1;
            } else {
                fn(data[r], data[r] + data[r + 1]);
                r += 2;
            }
        }
    }

    /** Iterate each index. */
    forEach(fn: (index: number) => void) {
        this.forEachRun((start, end) => {
            for (let i = start; i < end; i++) {
                fn(i);
            }
        });
    }
}

export { IndexRanges, sortedPredicate };
