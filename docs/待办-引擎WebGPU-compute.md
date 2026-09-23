# 独立待办：引擎侧 WebGPU compute 不落地 + `StorageBuffer` 读回不可信

> 立项人：用户（2026-09-23），原话：**"留一个钩子，引擎侧的 WebGPU compute + 读回，未来可以单列一个项目。"**
> 这不是本项目（SplatRoom）的一条功能线，而是一个**引擎缺陷**：修好它之前，任何"用 GPU compute
> 做投影/排序/压缩"的方案在 PlayCanvas 2.21.x / 2.22.x + 我们的 WebGPU 路径上都跑不起来。

## 1. 现象（2026-09-23 阶段 0 spike 实测，证据链完整）

把上游 SuperSplat v3.3.0 的 compute 通路（MIT）接进本项目后：**接线全对、派发每帧都在跑、
WebGPU 零条校验错误、pipeline 是对象、绑定槽位逐槽自检通过、画面一个高斯都没有。**

| 事实 | 怎么测的 |
| --- | --- |
| 引擎的 `device.computeDispatch` 真的被调用（`project-splats` 25624×1 + 间接参数 1×1），无异常 | 包装 `device.computeDispatch` 记录 |
| `compute.impl.pipeline` 是对象、bind group / uniform buffer 齐全、storage buffer 都绑到真实 `GPUBuffer` | 运行时读 `compute.impl` |
| 整段 compute pass 套在 WebGPU `pushErrorScope('validation')` 里跑完——**零条错误** | `spike/diag-live-dispatch.cjs` |
| 把整个投影体换成"`atomicStore` 写一个常数"——存活计数**仍然是 0** | 着色器探针 |
| 把剔除全绕过、直接写 cache 与紧凑表——**画面还是空场景**（= 关掉高斯图层那一张） | `spike/diag-coverage.cjs` |
| **原生 WebGPU compute 在同一台设备上完全正常**：自建 module/pipeline/bindGroup、`dispatchWorkgroups`，写 999 读回 999 | `spike/probe-compute-raw.cjs` |
| **升到 playcanvas 2.22.1（上游同版）不改变任何一条**；最简 compute 依旧派发成功、读回 0 | `spike/probe-compute-basic.cjs` |
| 用原生 WebGPU 直接写**引擎那块 `GPUBuffer`**，读回还是 0；引擎 `write()` 写进去的值也读不回来 | `spike/diag-readback.cjs`、`diag-storagebuffer.cjs` |

⇒ 收敛成两条**彼此独立**的嫌疑（都还没定位到行）：

1. **引擎的 WebGPU compute 派发不执行**（记账成功、pipeline 对象存在、驱动不报错，但 workgroup 没跑）。
2. **引擎的 `StorageBuffer` 读回在 WebGPU 下不可信**（`read()` 读不到任何写入，连原生写进去的也读不到）。

第 2 条是重要提醒：**任何用 `StorageBuffer.read()` 做断言的套件，在 WebGPU 上都可能是假读数**
（本项目已经因此把"存活计数=0"这条证据降级过一次）。

## 2. 为什么它不是本项目的活

* 这是引擎实现问题，不是渲染算法问题：同一台设备上原生 WebGPU compute 能跑通 ⇒ 设备/驱动无罪。
* 修它要么改 `node_modules/playcanvas`（升级或打补丁），要么换引擎版本，**都是主线级决策**，
  风险远大于它服务的那个 spike。
* 上游那套算法"值不值得"这个问题，**在修好它之前无法回答** —— 不是上游算法不行。

## 3. 已经准备好的起点（都在 `feat/upstream-projected-spike` 分支上）

| 资产 | 作用 |
| --- | --- |
| `spike/probe-compute-basic.cjs` | 最小 WGSL compute（单 storage buffer、单 workgroup、写常数），从活跃对象取引擎类，无需 import —— **判断"引擎能不能跑 compute"的一刀切** |
| `spike/probe-compute-raw.cjs` | 绕开引擎、原生 WebGPU 对照 —— **判断"设备能不能跑 compute"的一刀切** |
| `spike/diag-live-dispatch.cjs` | 包装真实派发 + 校验作用域，回答"引擎这条路丢在哪一步" |
| `spike/diag-readback.cjs` / `diag-storagebuffer.cjs` | 回答"是写不进去还是读不出来" |
| `spike/diag-coverage.cjs` / `probe-pose.cjs` | 不依赖读回的**画面证据**（覆盖率网格；"空场景"就是关掉图层那一张） |
| `spike/serve.cjs` | 同源静态服务：`/` 指 `dist/`，`/model/` 指真实模型目录 |
| `docs/spike-compute通路-阶段0进展-2026-09-23.md` | 完整取证链、根因分析、以及两条我自己犯过的错（"用代理指标替肉眼"、"差点把构建失败当成修好了"）|
| `spike/upstream-compute/` | 上游 v3.3.0 的相关源码暂存 + `types.ts` 类型桥 + `PROVENANCE.md` 出处 |

**另有一条已修的真问题**（与本缺陷无关，但同一个 spike 里发现的）：
PlayCanvas 2.21.3 的绑定槽位是**按声明顺序**分配的（`BindGroupFormat` 里 `format.slot = slot++`），
而 WGSL 自己写 `@binding(N)`；两边对不上时 `createComputePipeline` **不抛异常、返回一个无效
pipeline**，于是每次派发都是静默空跑。修法与自检代码在 `2d1693a` 里（声明顺序对齐 + 逐槽自检打印）。
**任何"WGSL 自带 `@binding` + 引擎自建布局"的移植都会踩这个坑**，值得记进引擎侧的坑清单。

## 4. 建议的推进顺序（将来开这个项目时）

1. 用 `probe-compute-basic.cjs` 在**干净的 playcanvas 官方示例**里复现（排除本项目所有代码因素），
   拿到最小复现后再决定"打补丁 / 升级 / 上报"。
2. 同一最小复现里测 `StorageBuffer.write()` + `read()`（不涉及任何着色器），把"读回不可信"单独钉死。
3. 只有这两条都通了，"上游 compute 通路值不值得"才重新变成可回答的问题。

## 5. 与本项目当前状态的关系

* 本项目主线**不含任何 compute 通路代码**（已回滚，`master @ b692601` 之后的工作树里没有 `spike/`）。
* 唯一残留的关联是 `src/core/motion-opaque.ts` 删除后**留下的** blit quad-resolve 实现
  （`camera.ts` 里 `resolveMode` 恒 0）—— 见 `docs/运动期不透明-删除记录-2026-09-23.md` §3：
  它是上游运动帧画法的必要配套，若这个待办将来通了，那道 resolve 可以原样复用。
