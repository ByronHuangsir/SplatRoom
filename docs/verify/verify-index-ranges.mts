// IndexRanges 的纯 node 回归（O3 改写了 fromPredicate / 新增 forEachRun / 修了 sortedPredicate 的游标）。
//
// 这个文件不进浏览器批量（批量脚本只收 verify-*.cjs），跑法是：
//   node --experimental-strip-types docs/verify/verify-index-ranges.mts
//
// 覆盖：
//   1. 运行长度编码正确（单个索引用高位置位、连续段用 [start,count]）
//   2. fromPredicate 的结果与"直接扫一遍"的参考实现逐位一致
//   3. **scratch 复用**：连续几十次大小不一的调用（含跨扩容点）互不污染
//   4. forEachRun 与 forEach 等价
//   5. sortedPredicate 在"调用方跳过一些 i"时仍然正确（修掉的游标 bug）
import { IndexRanges, sortedPredicate } from '../../src/core/index-ranges.ts';

let failed = 0;
const checks: { name: string, pass: boolean, detail: string }[] = [];

const check = (name: string, pass: boolean, detail = '') => {
    checks.push({ name, pass, detail });
    if (!pass) failed++;
};

// 参考实现：谓词 -> 索引数组
const reference = (total: number, pred: (i: number) => boolean) => {
    const out: number[] = [];
    for (let i = 0; i < total; i++) if (pred(i)) out.push(i);
    return out;
};

const expand = (ranges: IndexRanges) => {
    const out: number[] = [];
    ranges.forEach(i => out.push(i));
    return out;
};

const same = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

// ---- 1. 基本编码 ----
{
    const r = IndexRanges.fromPredicate(10, i => i === 3 || i === 7 || (i >= 5 && i <= 8));
    // {3} {5,6,7,8}
    const data = Array.from(r.data);
    // 3 -> 单个（高位置位）；5..8 -> 长度 4 的段
    check('encoding: lone index carries the high bit',
        (data[0] & 0x80000000) !== 0 && (data[0] & 0x7fffffff) === 3, JSON.stringify(data));
    check('encoding: run stored as [start, count]',
        data[1] === 5 && data[2] === 4, JSON.stringify(data));
    check('encoding: expand round-trips', same(expand(r), [3, 5, 6, 7, 8]), expand(r).join(','));
}

// ---- 2. 与参考实现一致（各种形状）----
{
    const cases: { name: string, total: number, pred: (i: number) => boolean }[] = [
        { name: 'empty', total: 0, pred: () => true },
        { name: 'nothing', total: 1000, pred: () => false },
        { name: 'everything', total: 1000, pred: () => true },
        { name: 'every other', total: 5000, pred: i => i % 2 === 0 },
        { name: 'head', total: 5000, pred: i => i < 17 },
        { name: 'tail', total: 5000, pred: i => i >= 4983 },
        { name: 'one in 997', total: 20000, pred: i => i % 997 === 0 },
        { name: 'blocks', total: 12345, pred: i => (i % 1000) < 3 }
    ];
    for (const c of cases) {
        const got = expand(IndexRanges.fromPredicate(c.total, c.pred));
        const want = reference(c.total, c.pred);
        check(`predicate match: ${c.name}`, same(got, want),
            `got ${got.length} want ${want.length}`);
    }
}

// ---- 3. scratch 复用（跨扩容）----
{
    // 交替选取会产生大量段条目，逼着 scratch 反复扩容；再用小选择验证它被正确复用
    const big = 1 << 17;            // 131072 个索引 -> 最多 131072 个段条目
    const sizes = [0, 1, 2, 3, 7, 64, 1024, 4096, big];
    let ok = true;
    let detail = '';
    for (let round = 0; round < 4; round++) {
        for (const total of sizes) {
            const stride = 1 + (round % 3);
            const pred = (i: number) => (i % stride) === (round % stride);
            const got = expand(IndexRanges.fromPredicate(total, pred));
            const want = reference(total, pred);
            if (!same(got, want)) {
                ok = false;
                detail = `round ${round} total ${total} stride ${stride}: got ${got.length} want ${want.length}`;
                break;
            }
        }
        if (!ok) break;
    }
    check('scratch reuse: interleaved sizes stay independent', ok, detail);

    // 病态：最大碎片化（隔一个选一个，131072 行 -> 65536 个单点条目）
    const n = 1 << 17;
    const frag = expand(IndexRanges.fromPredicate(n, i => i % 2 === 0));
    check('scratch reuse: heavily fragmented selection is exact',
        frag.length === n / 2 && frag[0] === 0 && frag[frag.length - 1] === n - 2,
        `len ${frag.length}`);
}

// ---- 4. forEachRun 与 forEach 等价 ----
{
    const r = IndexRanges.fromPredicate(5000, i => i === 0 || (i >= 100 && i < 200) || i === 4999);
    const runs: [number, number][] = [];
    r.forEachRun((start, end) => runs.push([start, end]));
    const expected: [number, number][] = [[0, 1], [100, 200], [4999, 5000]];
    check('forEachRun: half-open runs',
        JSON.stringify(runs) === JSON.stringify(expected), JSON.stringify(runs));

    const flat: number[] = [];
    r.forEachRun((start, end) => { for (let i = start; i < end; i++) flat.push(i); });
    check('forEachRun: same set as forEach', same(flat, expand(r)), `${flat.length} vs ${expand(r).length}`);
}

// ---- 5. sortedPredicate 的游标（调用方可能跳过一些 i）----
{
    // 不跳过：全部调用
    {
        const ids = new Uint32Array([3, 7, 10]);
        const hit = sortedPredicate(ids);
        const got: number[] = [];
        for (let i = 0; i < 12; i++) if (hit(i)) got.push(i);
        check('sortedPredicate: dense calls', same(got, [3, 7, 10]), got.join(','));
    }
    // 跳过：只在偶数 i 上调用（模拟 `a && hit(i)` 短路）
    {
        const ids = new Uint32Array([3, 4, 7, 10]);
        const hit = sortedPredicate(ids);
        const got: number[] = [];
        for (let i = 0; i < 12; i++) {
            if (i % 2 === 0 && hit(i)) got.push(i);
        }
        // 只有 4 和 10 是偶数：命中必须仍然被报出来，而且**不能**把后面的 id 弄丢
        check('sortedPredicate: survived skipped calls', same(got, [4, 10]), got.join(','));
    }
    // 完全跳过前面所有 id
    {
        const ids = new Uint32Array([1, 2, 3, 50]);
        const hit = sortedPredicate(ids);
        check('sortedPredicate: cursor catches up past skipped ids',
            hit(50) === true && hit(51) === false, '');
    }
}

console.log('--- verify-index-ranges ---');
for (const c of checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '   ' + c.detail}`);
}
console.log(JSON.stringify({ checks, failed }, null, 2));
process.exit(failed === 0 ? 0 : 1);
