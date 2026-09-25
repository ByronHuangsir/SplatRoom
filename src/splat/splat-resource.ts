/**
 * 取一个 gsplat 组件背后的 `GSplatResource`（**两条渲染通路通用**）。
 *
 * ## 为什么要单独抽一个
 *
 * 引擎有两条 splat 通路（见 `docs/排序错序-结构性解法-引擎GPU排序通路-2026-09-23.md`）：
 *   per-instance（现状）：资源挂在 `component.instance.resource` 上；
 *   unified（引擎 GPU 排序）：**`component.instance` 是 `null`** —— 引擎改用
 *     `component._placement`，资源挂在 `component.resource` / `component._placement.resource` 上
 *     （`GSplatComponent.get resource()` 本身两种模式都可用，已核对 playcanvas 2.21.3）。
 *
 * 仓库里原先有十几处直接写 `component.instance.resource` 的代码，在 unified 通路上全是
 * TypeError；而这些异常大多发生在**导入链或事件回调**里，会被导入的 catch 接住并转成
 * 错误弹窗 ⇒ **无人点确定时导入 promise 永不 settle**，表现就是"`?unified=1` 导入卡死"
 * （`docs/待办-引擎WebGPU-compute.md` §4d 追了好几轮的那个坑）。
 * 所以统一从这里取资源，别再各写各的。
 */
export const splatResourceOf = (component: any): any => {
    if (!component) {
        return null;
    }
    return component.instance?.resource ?? component.resource ?? component._placement?.resource ?? null;
};
