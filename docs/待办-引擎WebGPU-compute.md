# 独立待办：引擎侧 WebGPU compute 不落地 + `StorageBuffer` 读回不可信

> ## ⚠️ 2026-09-24 重要更正：标题那条结论**下得太宽了**
>
> 新证据（`_tmp/probe-compute-dispatch-count.cjs`、`_tmp/probe-unified-toggle2.cjs`）表明：
> **PlayCanvas 2.21.3 自己的 WebGPU compute 通路在这台机器上跑得完全正常。**
>
> | 通路 | 每帧 `device.computeDispatch` 次数（60 帧旋转，test-layered） |
> | --- | --- |
> | per-instance（默认，`unified: false`） | **0** |
> | unified（就地 `comp.unified = true`） | **11** |
>
> 而且 unified 那条路**画出了正确几何**（meanLuma 25.95 / lit 51.24%，切回来逐字节可逆，
> 全程零 pageerror / 零控制台错误），`currentRenderer` 仍是 2（GPU 排序），
> `_placement` 建起来了、`instance` 让位。
>
> 关键点：**unified 通路的绘制没有任何 CPU 兜底** —— `GSplatHybridRenderer.setCpuSortedRendering()`
> 会把 `meshInstance` 直接关掉（`setIndirect(null, -1); visible = false`），顺序与 indirect 参数
> 全部来自 GPU 上的投影 compute + 基数排序。所以"画面正确 + 每帧 11 次派发"就是
> "引擎自己的 compute 真的在执行、结果真的被用上"的直接证据（不依赖 `StorageBuffer.read()` 那种
> 已经证明不可信的读回）。
>
> **所以当年 spike 里"一个像素都画不出来"的原因，是那份从上游移植过来的投影器本身**
> （`2d1693a` 修好绑定槽位后存活计数仍是 0 —— 那句话当时就写着"necessary but not sufficient"），
> **不是"引擎 compute 不落地"。** 第 2 条（`StorageBuffer.read()` 读回不可信）仍然独立成立，
> 那条提醒继续有效：用 `StorageBuffer.read()` 做断言的套件在 WebGPU 上可能是假读数。
>
> **对本项目的影响（重要）**：`docs/排序错序-结构性解法-引擎GPU排序通路-2026-09-23.md` §2 那条
> "unified 世界缓冲 + 引擎自带 GPU 基数排序 + indirect draw"的路，**在本机是可用的**，
> 而且不需要我们自己写 compute —— 引擎的投影器与排序都已经在跑，要做的只是把**我们的材质**
> 挂上去（`workBufferModifier` / `GSplatVaryings` / `director.on('material:created')`）。
> 这条路的可行性判断从"要先修引擎缺陷"变成"纯材质迁移工作量"。
>
> 另注：unified 画面的**亮度/覆盖与 per-instance 差很多**（meanLuma 73.4→25.9，lit 100%→51%），
> 那是两条通路的**着色/颜色空间不同**（材质不同），不是几何差异 —— 迁材质时必须逐项对齐，
> 并由用户肉眼验收。

> 立项人：用户（2026-09-23），原话：**"留一个钩子，引擎侧的 WebGPU compute + 读回，未来可以单列一个项目。"**
> 这不是本项目（SplatRoom）的一条功能线，而是一个**引擎缺陷**：修好它之前，任何"用 GPU compute
> 做投影/排序/压缩"的方案在 PlayCanvas 2.21.x / 2.22.x + 我们的 WebGPU 路径上都跑不起来。
> **（上面那段更正就是针对这一句：这个前提被 2026-09-24 的实测推翻了。）**

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

> **2026-09-24 补充**：第 1、3 条的**前提变了**。引擎自己的 compute（投影 + 基数排序 + indirect）
> 已经实测在跑（§顶部更正），所以"上游 compute 通路值不值得"不用再等这个待办 ——
> 它变成了"把我们的材质迁到引擎现成那条路"的工程量问题。这个待办现在只剩**第 2 条**
> （`StorageBuffer.read()` 读回不可信）是真缺陷，以及**当年那份移植投影器为什么存活计数是 0**
> 这个纯考古问题（对我们没有产品价值，除非将来真要自己写 compute）。

## 4b. 下一步（材质迁移）的落地路径 —— 2026-09-24 新增

前提已经打通（unified 通路在本机可用）。要把我们的材质挂上去，引擎留的口子刚好够：

| 我们要的东西 | 引擎给的口子 | 备注 |
| --- | --- | --- |
| 材质本体（曲线/HSL/对比/高光/阴影/选区染色） | `director.on('material:created', (material, camera, layer) => …)`（`:88528`）—— 拿得到每层的材质，可 `shaderChunks` + `setParameter` | 与我们现在 `rebuildMaterial` 做的事同一类 |
| 每 splat 的颜色修改（曲线/HSL/特效色） | `workBufferModifier.code` → `gsplatModifyVS` 的 `modifySplatColor(center, color)`，**在投影 compute 里每个 splat 跑一次**（`:85816`/`:85824`） | WGSL 一份；GLSL 那份也在，但 unified 只在 WebGPU 上跑 |
| 每 splat 的几何修改（变换调色板/散射位移/特效缩放） | 同上的 `modifySplatCenter(ptr)` / `modifySplatRotationScale(original, modified, rot, scale)`（`:85972`/`:85979`） | `originalCenter` 可用，正好是散射/波纹需要的 |
| 把 per-splat 数据（状态位 / 变换索引 / 特效种子）传给片元 | `app.scene.gsplat.varyings.add([...])` → 生成 `gsplatVaryings*` / `gsplatUserCacheWriteCS` / `gsplatUserCacheReadVS` 全套 chunk（`:34838`） | 这是引擎**专门**为"每 splat 自定义属性"设计的官方通路 |
| 更省的一条：状态位/变换索引做成**资源流** | `GSplatFormat` 的 extraStreams + `placement.workBufferModifier` | 需要在资源侧加流，改造更深，二期再评估 |

**必须逐项对齐/重做的功能清单**（不能只"画得像"）：
曲线调色、per-channel HSL、对比/高光/阴影、饱和度、选区染色（selectedClr/lockedClr）、
删除状态（showDeleted）、裁剪盒（含软边）、变换调色板、散射/波纹/飘散三种特效、
拾取通道（PICK_PASS）、合并渲染（group-renderer 那条）与 PiP 预览。

**已知的两条硬边界**：
1. **unified 只在 WebGPU 可用**（`_resolveRenderer`: AUTO 在 WebGL2 上落回 CPU_SORT）。
   WebGL2 必须保留现在这条 per-instance + worker 通路 ⇒ 两条通路要**并存**，材质改动不能只改一边。
2. unified 的画面与 per-instance **本来就不一样**（实测 meanLuma 73.4→25.9、lit 100%→51%），
   迁完之后**逐像素对齐**是验收标准，而我**看不了图** ⇒ 必须由用户肉眼验收关键画面（历史教训：
   "看不了图的改动不该动默认值"）。

**建议分三期**（每期都要有"逐像素可比"的验收物）：
* 一期（可行性）：`?unified=1` 下把**颜色**对齐到与 per-instance 逐像素一致（曲线+HSL+对比+饱和度），
  不动几何/状态。产出：同机位 A/B 图 + 平均绝对差。
* 二期：状态类（选区染色/删除/裁剪盒）＋ varyings 通路。
* 三期：几何类（变换调色板/三种特效）＋ 拾取通道 ＋ 合并渲染，最后才谈"把默认切过去"。

### 4c. 一期做到哪一步（2026-09-25 实测记录）

> **代码位置**：一期的骨架（材质替换 + 自写片元 + Scene 钩子）**没有留在工作树里**，
> 收在 `git stash` 里（`stash@{0}`，说明写着为什么收起来）：
> `git stash show -p stash@{0}` 看内容，`git stash pop` 取回来。
> 收起来的理由：它**没验证通过**（uniform 读不到，见下），而且它的开关一旦打开会让
> **导入卡死**（下面最后一条）—— 一个"打开就把应用搞坏"的未完成代码不该留在主线。
> 走这条路时先 `git stash pop`，再按下面的"下一步实验"接着做。

**已经打通（都是实测）**：

| 事实 | 证据 |
| --- | --- |
| 能找到那条通路的材质 | 探针句柄 `__SPLATROOM_UNIFIED_MATERIAL__` 拿得到；debug 计数 `seenManagers=1, seenRenderers=1, seenGpuSort=1, seenMaterials=1, picked=1` |
| 能换掉它的 shader | 早期一版片元写坏时，引擎连续报 `[Invalid RenderPipeline]`（说明我们的源码**确实**进了管线）；修好后报错消失 |
| 开关必须"读取时判定" | `_unifiedMaterialEnabled` 一开始写成字段初始化，Scene 构造早于探针设 flag ⇒ 钩子一次都不跑。改成 getter 立刻生效。**这是本仓库的第二类同类坑**：构造期读到的全局变量，永远不是探针后来设的那个 |
| 片元**不能** #include 引擎 chunk | 引擎给 ShaderMaterial 会自动带上 `gsplatPS` / `gsplatModifyPS`；再 include 一次 ⇒ `normExp` / `modifySplatColor` 重复定义 ⇒ 编译失败、每帧 invalid pipeline。自写片元只依赖 varying 名 + 自己的函数 |
| 引擎的 Lint 面向 TS 源码 | WGSL 模板串里的**制表符**会触发 `no-tabs`（引擎源码是 tab 缩进，抄过来必须换成空格）|

**卡在哪（下一步的唯一阻塞）** —— 2026-09-25 走了三条路，全部失败，但每一步都留下了可复用的结论：

> ### ⚠️⚠️ 2026-09-25 第五轮：**上面这张表的三条结论全部作废**
>
> 起因是我终于去做了本该**最先**做的那件事：**先证明探针看得见 unified 通路的新帧**。
> 用的是与着色完全无关的阳性对照 —— **转相机 30°**，构图必须变。
>
> 新探针 `_tmp/probe-frame-visibility.cjs` 的结果：
>
> | 通路 | 转 30° 后的整屏变化 |
> | --- | --- |
> | per-instance | mad **14.97**，30.8% 像素变化 ✓ 探针能看见新帧 |
> | unified | mad **0.116**，**0.48%** 像素变化 ✗ **探针看不到新帧** |
>
> 也就是说：**在 unified 通路下，相机转了 30° 画面几乎不动** —— 这不是"着色改动没生效"，
> 而是**那条路的画面本身没有跟着相机更新**。用一个与着色无关的观测量做阳性对照，
> 一眼就分开了"我的改动没生效"与"这条路的画面是死的"。
>
> 为什么画面是死的：**`[Invalid RenderPipeline]`**（WebGPU 校验错误，两条通路都有，
> 但 unified 下画面因此停住）。一条渲染管线的校验错误会让那次 draw 被跳过，
> 帧缓冲保留上一帧内容 ⇒ 表现为"画面冻结/停在旧帧"，只有 UI 之类少数像素在变
> （正好对上那 0.48%）。
>
> **所以那三条着色覆盖路（`shaderDesc` / `gsplatModifyPS` / `gsplatModifyVS`）的"逐像素零变化"
> 完全不能说明"引擎不采用我们的源码" —— 它们是在一条根本没在正常渲染的通路上量的。**
> 我拿一个坏掉的量具下了三次结论，这是这一轮最该记住的教训。
>
> **正确的下一步顺序**：
> 1. 先修 unified 通路的 `Invalid RenderPipeline`（拿到它的 WGSL 编译/校验报错原文，
>    `device.createShaderModule` + `getCompilationInfo` 或者 `pushErrorScope('validation')`）；
> 2. 再用"转相机"确认那条路的画面是活的（mad 应当与 per-instance 同量级）；
> 3. **只有到这一步之后**，才重新做着色覆盖实验 —— 否则量出来的还是坏量具的读数。
>
> 顺带：`?unified=1`（URL 开关）那条路当初是能正常渲染的（meanLuma 25.95 / lit 51%），
> 而 `comp.unified = true` 的**就地翻转**这条路画面是死的。两者不是同一件事 ——
> 一期探针一直在用后者，这也是"零变化"的来源之一。

### 4f. 第六轮：把 WebGPU 报错的源头接上了（有新事实，也有新墙）

**新事实一：可用的 WebGPU 拦截钩子（踩了两个坑才装对）**
`_tmp/probe-pipeline-error.cjs` 现在能在页面脚本之前拦到设备，抓
`createShaderModule` / `createRenderPipeline` / `createComputePipeline` / 校验作用域。
两个坑都值得记：

1. 第一版把 `requestDevice` 挂在 `GPU.prototype` 上 —— **`navigator.gpu.requestDevice` 不在原型上**。
   实测（`_tmp/diag-gpu-hook.cjs`）：`gpuProtoHasRequest: false`、`adapterProtoHasRequest: true`。
   真正要拦的是 **`GPUAdapter.prototype.requestDevice`**。
2. 钩子必须**自检有没有装上**（`__WG__.installed`）。前两版偷懒没自检，于是"0 个错误"
   被我误读成"没有错误" —— 其实是"根本没在测"。**这和"零变化"那件事是同一类错误**：
   读数之前先证明量具在工作。

**新事实二：unified 通路的着色器与管线创建其实都没报错**

| 观测（就地翻转成 unified 之后） | 值 |
| --- | --- |
| shader module 创建次数 | 12 → **25**（翻转后又建了 13 个，说明这条路确实在建自己的着色器） |
| `createRenderPipeline` | 6 → 8 |
| `createComputePipeline` | 0 → 9 |
| **WGSL 编译错误** | **0** |
| **管线创建抛出的异常** | **0** |

⇒ `[Invalid RenderPipeline]` 的 "invalid due to a previous error" **不是** shader 编译失败、
也不是 `createRenderPipeline` 失败；它是**继承自更早的一次未捕获校验错误**
（UN捕获的 error scope 错误会被丢弃，只留下"前面出过错"这个标记）。

**新墙一：我自己的 error scope 包围失败了**
想在翻转那段外面套 `pushErrorScope('validation')` 抓原文，结果两次 `popErrorScope()`
都返回 `OperationError: No error scopes to pop` —— 引擎在每一帧里自己成对 push/pop，
把我的作用域**吃掉了**。所以"用自己的 scope 包围"这条路在当前架构下不成立。
下一步要换手段：要么拦 `popErrorScope` 时把引擎自己的结果也记下来（注意别破坏它的配对），
要么用 **device lost 之外的另一条路**：`createRenderPipelineAsync` 的 catch、
或者直接对 `device.queue.submit` 的 command buffer 做校验包围（提交点更靠近真正的错误）。

**新墙二：两条进入方式现在都不能用**（这决定了下一步做什么）

| 进入方式 | 状态 |
| --- | --- |
| `?unified=1`（URL）/ 导入前设全局 | **导入直接卡死**（§4d/4e），拿不到模型 |
| 正常导入后就地翻转 `comp.unified = true` | 能建出画面，但**画面是死的**（转 30° 只变 0.48%） |

⇒ **一期（材质迁移）现在被"没有一条可用的 unified 通路"卡住**，而不是被材质机制卡住。
两条路的优先级建议：**先把"就地翻转"那条修活**（它已经有画面，离可用更近），
`?unified=1` 的导入卡死是另一件事、可以更晚。

**验证工具**（都不入库，`_tmp/`）：
`probe-pipeline-error.cjs`（WebGPU 拦截，含自检）、`diag-gpu-hook.cjs`（钩子可行性诊断）、
`probe-frame-visibility.cjs`（转相机阳性对照）、`png-grid.cjs`（读不了图时把 PNG 打成亮度网格）。

| 试过的路 | 做法 | 结果 | 留下的结论 |
| --- | --- | --- | --- |
| ① 换 `material.shaderDesc` | 用我们自写的 vertex+fragment 整套换掉源码 | 画面逐像素零变化（**见上面的更正：在死画面上量的**） | 待重测 |
| ② 覆盖 `gsplatModifyPS` | 材质级 chunk 覆盖 | 画面零变化（**同上，作废**） | 待重测 |
| ③ 覆盖 `gsplatModifyVS` | 走投影 compute 的钩子 | 画面零变化（**同上，作废**） | 待重测 |

**仍然成立的机制事实**（这些是从引擎源码读出来的，不依赖上面的测量）：
unified 通路的颜色**在投影 compute 里烘进 `projCache`**，而那个 compute 的用户 chunk 取自
**绘制材质**的同名 chunk —— `_updateMaterial`（`playcanvas.mjs:86540-86553`）读的是
`gsplatModifyVS`，**不是** `gsplatModifyPS`。所以真要改那条路的颜色，入口是 `gsplatModifyVS`。

**探针有效性检查 —— 已做，结论是"看不见"**（所以上面那三条路的读数全部作废）：

用**与着色完全无关**的阳性对照（转相机 30°，构图必须变）量两条通路：
per-instance mad **14.97** / 30.8% 像素变化（探针看得见）；
unified mad **0.116** / **0.48%**（探针看不见）。
⇒ 不是"探针截到缓存帧"这么简单，而是**unified 那条路的画面本身没跟着相机更新**
（`[Invalid RenderPipeline]` 让 draw 被跳过、帧缓冲停在旧内容）。

**所以下一步的顺序是**：
1. 修 unified 通路的 `Invalid RenderPipeline`（拿到 WGSL 编译/校验报错的原文）；
2. 用"转相机"确认那条路的画面是活的（mad 应与 per-instance 同量级）；
3. **然后**才重新做着色覆盖实验。

**另一条并行思路**：绕开"改引擎材质"，直接用自己的 `ShaderMaterial` 替换 `renderer._material`
整个对象（引擎每帧的 `copyMaterialSettings` 会从组件材质拷设置，而组件的 `get/set material`
在 unified 下被引擎硬断开了，所以要挂到 renderer 上并自己管生命周期）。代价更高但最彻底。

**为什么这一段值得单独开项目 / 建议先在干净环境里做**：
本轮在一个完整的应用里做这种引擎级实验，每一轮都是 **build(20s) + 导入 + 截图** 约 3 分钟，
而失败原因可能出在最外层（探针）。更高效的做法是拿 **playcanvas 官方 gsplat 示例**
（或一个最小页面）做成独立的复现工程，几秒钟一轮地试，跑通后再搬回本项目。

**另外发现一个独立 bug（与材质无关，但挡路）**：`?unified=1` 这条 URL 开关会让**导入本身失败** ——
`addComponent('gsplat', { unified: true })` 那条路在建组件时就断了（elements 只有 8 个、没有 splat 元素、
`findComponents('gsplat')` = 0），实测两次都卡在导入里不返回。已定位到"**flag 在导入前为 true 就卡**"，
与材质钩子无关（用短路开关 `__SPLATROOM_UNIFIED_MATERIAL_DISABLED__` 把整个钩子体短路掉，照样卡）。
所以一期探针走的是"**先正常导入、再就地翻转 `comp.unified`**"那条已验证可用的路。
这个 bug 值得单独查 —— 它挡住了"用 URL 开关做 A/B"这个最顺手的手段。

### 4d. 那个"导入失败"的 bug 已定位到行（2026-09-25 第三轮）

**现象**（最小复现 `_tmp/verify-unified-url-import.cjs`，A/B 同模型）：

| 加载方式 | `import()` 结果 | elements | splat 元素 | gsplat 组件 |
| --- | --- | --- | --- | --- |
| `?gpu=webgpu` | **resolved**，1024 ms | 9 | 1 | 1 |
| `?gpu=webgpu&unified=1` | **永远 pending**（30 s 无果） | 8 | 0 | 0 |

**定位过程**（临时插桩 `[SRDBG]`，已全部撤除）：导入链一路走到
`B:loadGSplatDataAsync → E:createGSplatAsset → F:new-Splat → J:before-bindAsset-call →
G:addComponent → G2:addComponent-returned → I:textureDimensions → K1/K2/K3`，
**之后不再有任何日志**。也就是说卡在 `curveTexture.lock()` 附近，而它**既不返回也不抛异常**。

紧跟其后的那一段里有一处**确定的缺陷**（已修，见下）：unified 模式下
`GSplatComponent.get instance()` 返回 **null**（引擎改用 `_placement`），而代码直接读
`instance.resource.aabb` ⇒ 一个 TypeError。它被导入链的 catch 吞掉，
所以表现正是"导入静默失败、没有 splat 元素"。

**已修（本轮入库）**：
1. 资源统一从组件上取：`(comp as any).resource ?? instance?.resource ?? splatResource`
   —— 两种模式都有，不再假设 `instance` 存在；
2. `instance.meshInstance` 相关三行全部加守卫；
3. `curveTexture.lock()` 包 try/catch（拿不到就退回恒等曲线，曲线默认恒等，画面无差）。

**仍然卡住**：修完上面三条，`?unified=1` 的导入**依旧 pending**。所以 `lock()` 不是抛异常而是
**真的挂住** —— 说明此时 WebGPU 队列已经被堵死，`lock()` 在等一个永远不来的回读。
下一步要查的是"unified 模式下导入时是什么把队列堵住的"：
嫌疑最大的是在**没有 `instance` 的情况下仍然上传了 per-instance 的贴图/属性**
（`splatState` / `splatTransform` / 顶点属性那些 `setParameter` 都还是按 per-instance 假定的），
以及 `updateState()` / `updateMaterial` 在 placement 模式下被调用。

**结论**：这个 bug 的真实性质不是"URL 开关坏了"，而是
**unified 模式下的 `bindAsset` 整段都还是按 per-instance 写的**（instance / 贴图 / 属性 / 状态上传），
所以"用 URL 开关做 A/B"在修完这一整段之前都不可靠 —— 一期探针继续走
"先正常导入、再就地翻转 `comp.unified`"那条已验证可用的路。

### 4e. 继续追的结果（2026-09-25 第四轮）：又排掉两层，仍然没通

**这一轮修好的（都已入库并验证）**：

| 修的东西 | 说明 |
| --- | --- |
| `curveTexture.lock()` → 直传 | `lock()` 走 staging + `mapAsync` 回读；改成 `device.queue.writeTexture` 直传（曲线初始表本来就是恒等值，不需要回读）。**实测这一步原本确实在挂**：改完后从"卡在 curve 之前"推进到"卡在 curve 之后" |
| `writeTexture` 的字段类型 | 直传第一版报 `Failed to read the 'rowsPerImage' property ... not of type 'unsigned long'` ⇒ 全部 `Number()` 转换 |
| `instance.resource.aabb` → 组件上的资源 | unified 下 `instance` 为 null；改成 `(comp).resource ?? instance?.resource ?? splatResource`（两模式都有） |
| `instance.meshInstance.*` 三处 + `instance.sorter?.on` | 全部加守卫；**这两个是 TypeError，而导入链的 catch 会把它们吞掉** —— 所以症状才是"静默失败"而不是报错 |
| 我自己的一个笔误 | 上一版写成 `compResource` 而声明是 `compResource`，那本身就会抛 `is not defined` |

**排掉的两层**（每一层都靠临时插桩定位，插桩已全部撤除）：

1. 第 1 层：`curveTexture.lock()` —— 见上，已修。
2. 第 2 层：`instance.sorter?.on(...)` —— `instance` 为 null ⇒ TypeError。已修。

**现在的位置**：`bindAsset` 已经能**完整跑完**（`DBG-after-sorter-bind` 打到了），
但 `?unified=1` 导入的 **`import()` 仍然永不 settle**，且**没有 splat 元素**（elements 8、组件 1、
`_placement` 非空）。也就是说：**卡点已经不在 `bindAsset` 里了**，而在它**返回之后**、
元素真正被登记/画出来的那一段。

**下一步该看的地方**（还没查）：
* `Splat` 元素是在哪里、以什么条件被加进 `scene.elements` 的（`elements` 恒为 8 = `Splat` 对象建出来了但没被登记，或者登记前又被丢掉）；
* `GSplatComponent` 在 unified 下 `instance` 为 null ⇒ 元素里**所有依赖 `instance` 的初始化**
  （材质重建、状态上传 `updateState()`、`updateGpuCameraUniforms`、sorter 相关）在 unified 下
  要么空转要么抛错 —— 需要像本轮这样逐个过一遍，而不是逐个撞。

**给这个 bug 的定性（写给未来的自己）**：
它不是"开关坏了"，而是**unified 通路从来没有被当作一等公民支持过** ——
`bindAsset` 及之后的一整条 per-instance 假定（instance / 贴图 / 属性 / 状态 / 材质 / sorter）
在 unified 下全部要另走一套。这是一整块工作，不是一次修补。
所以：**一期探针继续用"先正常导入、再就地翻转 `comp.unified`"那条已验证可用的路**，
把精力留在材质迁移本身；"让 `?unified=1` 直接可用"应该单独立项（它同时也是"将来把默认切到
unified"的必做前置）。

**开关判定来源已归一化（本轮入库）**：`main.ts` 启动时把 `?unified=1` 映射成
`__SPLATROOM_UNIFIED__`，`splat.ts` 与 `scene.ts` 都只读这一个全局
（原先两处各自读、时机不同，"开关到底生效没有"取决于谁先读到 —— 这也是本轮踩到的坑之一）。

## 5. 与本项目当前状态的关系

## 5. 与本项目当前状态的关系

* 本项目主线**不含任何 compute 通路代码**（已回滚，`master @ b692601` 之后的工作树里没有 `spike/`）。
* 唯一残留的关联是 `src/core/motion-opaque.ts` 删除后**留下的** blit quad-resolve 实现
  （`camera.ts` 里 `resolveMode` 恒 0）—— 见 `docs/运动期不透明-删除记录-2026-09-23.md` §3：
  它是上游运动帧画法的必要配套，若这个待办将来通了，那道 resolve 可以原样复用。
