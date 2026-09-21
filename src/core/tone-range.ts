// 黑场 / 白场 → 映射系数（**唯一实现**，视口 / 导出 / 直方图 / 范围选择必须共用这一份）。
//
// 2026-09-21 修（用户报"黑场拉到底变成过曝"）：
// 原来这套换算在四个地方各写了一遍，而且**互不一致**：
//   • 视口（`splat.ts`）：`denom = max(0.001, whitePoint - blackPoint)`、`offset = -blackPoint`
//     ⇒ 两者相等时 denom 掉到 0.001 ⇒ **scale = 1000**、offset = -blackPoint
//     ⇒ 片元着色器 `color * 1000 − 1` ⇒ 整幅画面冲白（实测冲白像素 **98.9%**，而用户想要的是压黑）。
//   • 导出/离屏（`color-grade.ts`）：先把两值**排序**再取 `max(0.001, hi - lo)`
//     ⇒ 相等时同样 scale=1000（也过曝），但在"白场 < 黑场"（`whitePoint - blackPoint` 为负）时
//     与视口给出**完全不同的结果**（实测交叉参数 bp=1.2/wp=0.8：视口 scale=1000 过曝、导出 2.5 正常）。
//   • 直方图（`calc-histogram.ts`）与范围选择（`select-by-range.ts`）：`1 / (whitePoint - blackPoint)`
//     **完全没有护栏** ⇒ 相等时是 `Infinity`、交叉时是负数 ⇒ 这两条 GPU 通路拿到 Inf/NaN。
//
// 现在统一成：**有序区间 + 最小间距**。`MIN_TONE_RANGE` 不是随手取的 0.001：
//   • 上限约束：1/0.05 = 20，最坏也就是把 [bp, bp+0.05] 拉伸到 [0,1]（硬切），不会出现 1000× 增益；
//   • 下界约束：足够小，用户把黑场拉到底仍然是"几乎全黑"（color*20 − 20 ⇒ color ≥ 1 才亮）。
// UI 侧（`color-panel.ts` 的两个 change 护栏）用同一个常量保证**滑块永远到不了范围 0**，
// 于是"拉到底 = 压黑"而不是"过曝"。

/** 黑场与白场之间允许的最小间距（低于它就没有可映射的色阶了） */
const MIN_TONE_RANGE = 0.05;

/**
 * 由黑场/白场算出**有序**区间与映射系数。
 *
 * 层级映射（levels）本应是 `out = (in - lo) / (hi - lo)`，也就是 `in * scale + offsetBase`，
 * 其中 `offsetBase = -lo * scale`。**offsetBase 必须乘上 scale** —— 原来四个地方写的都是
 * `offset = -lo + brightness`（没乘），只有在 `hi - lo == 1` 时才是对的；范围一变小，
 * `color*scale - lo` 会把黑场之上的中间调整体抬亮，于是"拉黑场"变成了"提亮"（实测平均亮度
 * 0.29 → 0.58 → 0.99 一路变亮）。这是用户报"黑场拉到底变成过曝"的更根本那一半。
 *
 * @param blackPoint - 黑场（UI 反向映射：黑场滑块 −1..1 → blackPoint +1..−1）
 * @param whitePoint - 白场（UI 反向映射：白场滑块 0..2 → whitePoint 2..0）
 */
const toneRange = (blackPoint: number, whitePoint: number) => {
    const a = Number.isFinite(blackPoint) ? blackPoint : 0;
    const b = Number.isFinite(whitePoint) ? whitePoint : 1;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const range = Math.max(MIN_TONE_RANGE, hi - lo);
    const scale = 1 / range;
    return { lo, hi, range, scale, offsetBase: -lo * scale };
};

export { MIN_TONE_RANGE, toneRange };
