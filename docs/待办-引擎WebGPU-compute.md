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

### 4g. 第七轮：把错误从"继承来的"追到了"某次提交开始"

**手段换了才拿到东西**：用 `pushErrorScope` 包住翻转那段**不可行**（引擎每帧自己成对 push/pop，
把我的作用域吃掉，两次 pop 都返回 `No error scopes to pop`）。改成在**提交点**成对包围
（`queue.submit` 前后各一次 scope，自成一对、不与引擎的交错）之后，终于抓到东西了：

| 观测（就地翻转成 unified） | 值 |
| --- | --- |
| hook installed | YES（**自检通过**，数字才可信） |
| shader modules | 12 → 25 |
| createRenderPipeline | 6 → 8 |
| createComputePipeline | 0 → 9 |
| WGSL 编译错误 | **0** |
| 管线创建异常 | **0** |
| **submit 校验错误** | **190 条** |

190 条的内容**全部一样**：

```
[Invalid CommandBuffer] is invalid due to a previous error.
 - While calling [Queue "Default Queue"].Submit([[CommandBuffer], [Invalid CommandBuffer]])
```

**关键信息是标签**：第一次跑，最早的坏提交是 **#480**；第二次跑是 **#300**。
⇒ 不是"某一次固定操作"引发的，而是**从某一帧开始，这个设备/队列进入了持续报错状态**
（每帧提交都被判无效），起点与当次跑的帧数/时序有关。

**仍然没抓到的那一句**：真正的**首个**校验错误（"previous error"里的那个 previous）。
它不在提交点上，也不在 `createShaderModule` / `createRenderPipeline` 上。
剩下的嫌疑（按可能性）：

1. **`popErrorScope` 是异步的、而引擎每帧成对 push/pop** —— 我的钩子虽然自成一对，
   但引擎自己的 pop 可能把**我的** scope 结果吃掉（反之亦然）。要用更硬的证据：
   把 `popErrorScope` 的返回**在引擎调用处**记录（而不是我自己再 push 一对），
   或者干脆给 `device` 挂 `onuncapturederror`（`GPUDevice` 有这个事件，
   `addEventListener('uncapturederror', …)` 能拿到**所有未被作用域捕获**的错误）。
   **这是下一步最该试的一条**，而且比现在的做法更直接。
2. 某个 compute pass 的 `dispatchWorkgroups` 参数非法（indirect buffer / 绑定组）。
3. 某个 render pass 的 attachment 与管线不匹配（例如统一通路用的是间接绘制 + storage buffer，
   而某个中间 pass 仍按 per-instance 的 attachment 配置）。

**为什么这一轮值得**：错误终于有了**计数与位置**（190 条、从某次提交起），
并且确认了"编译与管线创建都没问题" —— 病因在**每次绘制/提交的校验**里，
而不是在着色器或管线对象上。这比上一轮"只知道有个 previous error"进了一步。

**下一步（明确）**：给 `device` 挂 `uncapturederror` 监听，把每条未被捕获的错误的
`error.message` 原文记下来 —— 它应当直接给出"哪条命令、缺什么"。

### 4h. ✅ 第八轮：**找到根因了** —— 片元输出少了一个颜色附件

`uncapturederror` 一挂上就出来了。**382 条未捕获错误，去重后只有两类**：

```
[GPUValidationError] Color target has no corresponding fragment stage output
  but writeMask (ColorWriteMask::(Red|Green|Blue|Alpha)) is not zero.
 - While validating targets[1] framebuffer output.
 - While validating fragment state.
 - While calling [Device].CreateRenderPipeline([RenderPipelineDescriptor]).
```

以及它的下游后果：

```
[GPUValidationError] [Invalid RenderPipeline (unlabeled)] is invalid due to a previous error.
 - While encoding [RenderPassEncoder "_p-PassEncoder RT:cameraColor"].SetPipeline(...)
```

**根因**：我们给 splat 材质写了**两个颜色附件**（RT0 = 场景色，RT1 = 选区覆盖，
供轮廓/底衬 pass 用；见 `src/shaders/splat-shader.ts` 里 "RT0 = scene colour,
RT1 = selection overlay" 那段注释）。而 **unified 通路引擎自己那份片元着色器只有 `output.color`
一个输出**，渲染目标却按两个附件建 ⇒ **targets[1] 有 writeMask 却没有对应的片元输出**
⇒ `CreateRenderPipeline` 校验失败。

**为什么它一直隐身**（三件事叠在一起，值得记进坑清单）：

1. `createRenderPipeline` **不抛异常**（与 2.21.3 的 `createComputePipeline` 一样的行为），
   所以我的 `try/catch` 计数恒为 0 —— **"0 异常"不等于"管线有效"**；
2. WGSL 编译 **0 错误**（问题不在着色器语法，在管线与渲染目标的匹配）；
3. 那条 `[Invalid RenderPipeline]` 只是**下游症状**，浏览器不给原文，我盯着它查了好几轮。

**这一条与之前那个 spike 的坑是同一个家族**：2.21.3 的 `createComputePipeline` 在绑定槽位
对不上时也是"不抛异常、返回无效对象、之后静默空跑"。**判据要换成"挂 `uncapturederror` 数错误"，
而不是"看有没有抛异常"。**

**下一步（具体）**：在 unified 通路的材质里补上第二路输出。引擎的片元结构里
`output.color` 已是 RT0；需要把 `output.color1` 也写出来（per-instance 那份就是这么做的：
`src/shaders/splat-shader.ts` 里 `output.color1` / `pcFragColor1`）。具体做法：
* 在 `src/shaders/unified-shaders.ts` 的 chunk 里**声明第二路输出**（`@location(1)` 或引擎的
  `FragmentOutput.color1`，取决于引擎生成的 `FragmentOutput` 结构里有没有这个成员）；
* 引擎侧的多输出是靠 `fragmentOutputTypes` / `GSPLAT_*` define 决定的，需要确认在 unified 材质上
  怎么让它声明 `color1`（per-instance 的 `ShaderMaterial` 是我们自己建的，unified 那个是引擎建的）；
* 若引擎的 `FragmentOutput` 结构里确实没有 `color1`，那就反过来：**让渲染目标只用 1 个附件**
  （`camera.targetSizeOverride` / 关掉我们那路选区覆盖的 RT1），这取决于轮廓/底衬 pass 是否真需要它。

**这一轮为什么值**：从"只知道有个 previous error"到"**知道是 targets[1] 没有片元输出**"，
中间是靠**换判据**（`uncapturederror` 数错误）而不是靠继续猜。工具留在
`_tmp/probe-pipeline-error.cjs`（钩子含自检 + 提交点包围 + uncapturederror）。

### 4i. 第九轮：第一次修复尝试**没有生效**，以及为什么（下一步的具体方向）

按 §4h 的推断动了手：在 `src/splat/unified-material.ts` 里，当检测到材质的
`shaderDesc.fragmentOutputTypes` 不足两个时，用 `['vec4','vec4']` 重设一次 `shaderDesc`
（思路：`FragmentOutput` 是按 `fragmentOutputTypes` 生成的，补成两个就应当声明 `color1`）。

**结果：没生效。** 未捕获错误 382 → **380**，两类错误**都还在**：

```
[GPUValidationError] Color target has no corresponding fragment stage output ... targets[1]   ← 仍在
[GPUValidationError] [Invalid RenderPipeline] is invalid due to a previous error.              ← 仍在
```

**目前最可能的解释**：这个材质是**引擎建的**，不是 `ShaderMaterial`（我们的代码只对自己的
per-instance 材质调 `shaderDesc`）。对引擎那个材质设置 `shaderDesc` **未必被引擎当回事** ——
这与之前那轮"换 `shaderDesc` 零变化"是**同一个结论的另一种表现**（当时是在死画面上量的，
但"引擎不采用 shaderDesc"这条本身可能就是真的）。

**下一步的三条具体路（按代价从低到高）**：

1. **在材质创建时就修**，而不是每帧补：引擎在 `GSplatLayerData.createManager` 里
   `director.eventHandler.fire('material:created', manager.material, camera, layer)`
   （`playcanvas.mjs:88528`），而 `eventHandler` 就是 **`GSplatComponentSystem`** 自己
   （`:91319` 传入的是 `this`）。所以可以监听到那一刻，在**第一次编译之前**把它设好，
   而不是等它已经被编译成无效管线之后再补。
2. **把 RT 从两个附件减到一个**：`camera.ts` 的 `splatTarget` 用了
   `colorBuffers: [colorBuffer, workBuffer]`。如果那条选区覆盖（RT1）在 unified 通路下
   本来也不生效（我们的选区着色跑在 per-instance 材质里），那就让 unified 走单附件目标 ——
   这可能比让引擎材质声明 `color1` 简单得多，而且不依赖引擎内部行为。
3. 去引擎源码里确认那个材质到底怎么声明片元输出、`fragmentOutputTypes` 从哪里来
   （`GSplatHybridRenderer` 建 `_material` 时没传 `fragmentOutputTypes`，
   所以默认 `['vec4']`；要么它其实靠 `GSPLAT_*` define 走另一条分支，要么这条路
   在 2.21.3 里对 MRT 就是不好的）。

**判据**：改完之后必须看到
**"Color target has no corresponding fragment stage output" 条数归零**，
再去量"转相机 30° 画面活没活"。**不要**再用"画面好像变了"来判断 —— 那正是前面几轮栽的坑。

### 4j. ✅ 第十轮：按用户要求读引擎源码，把这条链**完整读通**了（并且发现我一直在补错对象）

**一、`fragmentOutputTypes` 从哪来**

`ShaderDefinitionUtils.createDefinition`（`playcanvas.mjs:10660-10693`）是唯一的生成处：
它按 `options.fragmentOutputTypes` **逐个附件**生成
`#define COLOR_ATTACHMENT_i`（GLSL）与 `alias pcOutType_i`（WGSL）；片元结构
`struct FragmentOutput { color0 → color, color1 → color1, … }` 也由它按这个列表生成
（结构生成在 `:9342`，成员名 `color` / `color${i}`）。

`fragmentOutputTypes` 的来源有三条，**都指向"材质自己"**：

| 来源 | 位置 | 说明 |
| --- | --- | --- |
| `ShaderMaterial.shaderDesc.fragmentOutputTypes` | `:34401` → `createShaderDefinition` | 我们的 per-instance 材质走这条（我们建的时候就传了两个） |
| 工作缓冲的流描述 | `:40265-40279`、`:41635-41662` | 引擎**从 `format` 的流**算出 `getGlslShaderType(stream.format).returnType` 再传下去 —— 这是引擎里 MRT 能正常工作的样板 |
| 默认 | `:10662` | 不给就是 `["vec4"]` ⇒ **只声明一路输出** |

**二、unified 那个材质的片元输出到底怎么声明（关键）**

* 引擎**自己的片元着色器**（WGSL `gsplatChunksWGSL.gsplatPS` = `gsplat_default3`）
  在 forward 路径里**只写 `output.color`**。全文里 `output.color1` 只出现一次，
  而且在 `#ifdef PICK_PASS` 里（`:90816` 附近的 `output.color1 = getPickDepth();`）。
  ⇒ **引擎这份片元在任何情况下都不可能满足"两个附件都要有输出"**。
* 它建材质时（`GSplatHybridRenderer` 构造，`:87179-87186`）只传
  `vertexWGSL` / `fragmentWGSL` / `attributes`，**没有传 `fragmentOutputTypes`**
  ⇒ 落到默认 `["vec4"]` ⇒ 只声明 `output.color`。
* 而我们的 splat pass 用的是 **2 附件 MRT**（`camera.ts:776-784` 的 `splatTarget`：
  `[colorBuffer, workBuffer]`，`:816` 的 `splatPass` 把 splat 层画进去）
  ⇒ **RT1 有 writeMask、片元却没有第二个输出** ⇒ 正是那条校验错误。
* 我们的 per-instance 材质之所以能在同一个 MRT 上工作：**它是我们自己建的 `ShaderMaterial`**，
  声明了两路输出（GLSL `pcFragColor0`/`pcFragColor1`、WGSL `output.color`/`output.color1`）。

**三、⚠️ 我一直在补错对象（这是"修复没生效"的真正原因）**

引擎解析"绘制用哪个材质"的地方是（`:88268-88281`）：

```js
_writeGsplatParams(p) {
    const gsplat = this.scene.gsplat;
    …
    p.material = gsplat.material;     // ← 场景级的 ShaderMaterial
    p.varyings = gsplat.varyings;
}
```

而 `scene.gsplat` 是 **`GSplatParams`**（`:36629` 起），它的 `material` 是一个
**场景级 `ShaderMaterial`**（`get material() { return this._material; }`，
`_material = new ShaderMaterial()` 在构造里，并预设了 `alphaClip` / `minPixelSize` 等参数）。

⇒ **`p.material` 就是 `scene.gsplat.material`，不是 `GSplatHybridRenderer._material`。**
我前面几轮补的是那个 renderer 的 `_material`（`_updateMaterial(material)` 读的是 `p.material`，
也就是场景级那个）。**这就是为什么"补 `fragmentOutputTypes`"完全没反应** —— 我改的对象
根本没参与编译。

**四、这条链现在给出的**两条可行路**（这才是有依据的结论）

* **路 A（推荐，改动小）**：把 **`scene.gsplat.material`** 换成我们自己的
  `ShaderMaterial`，并在 `shaderDesc` 里给 `fragmentOutputTypes: ['vec4','vec4']`，
  片元同时写 `output.color` 与 `output.color1`（RT1 的内容按现约定：选区覆盖，
  不选时写 `vec4(0)`）。这条路同时解决三件事：输出路数、以及**我们终于能真正控制
  unified 通路的着色**（不必再跟引擎那份片元较劲）。
  ⚠️ 注意 `GSplatParams.material` **只有 getter 没有 setter** ⇒ 需要直接改
  `scene.gsplat._material`（引擎内部字段，属于打补丁，要写清楚）。
* **路 B（更干净但更侵入）**：让 unified 模式下的 splat pass 用**单附件**目标
  （不再用 `splatTarget` 的 RT1）。代价是改渲染 pass 的组织，而且要知道 RT1 在该模式下
  是否真的没人读。

**验收判据（不变）**：`Color target has no corresponding fragment stage output` 归零，
再用"转相机 30°"量画面活没活。

### 4k. 第十一轮：试了路 A —— 拿到两个**决定性**的引擎事实，并且发现补丁为什么不可能生效

**事实一：引擎的 `ShaderMaterial` **按 `uniqueName` 缓存着色器**（这是关键）**

`ShaderUtils.createShader`（`playcanvas.mjs:20616-20638`）：

```js
let shader = programLibrary.getCachedShader(options2.uniqueName);
if (!shader) { … 真正建着色器 … programLibrary.setCachedShader(options2.uniqueName, shader); }
```

而 `ShaderMaterial` 的默认名字是 `ShaderMaterial-${desc.uniqueName}`。
⇒ **只要 `uniqueName` 不变，改 `shaderDesc` 也不会重新编译** —— 缓存直接命中旧着色器。
这解释了之前"改 `shaderDesc` 一点反应都没有"的**第二个原因**（第一个是补错对象）。

**事实二：`shaderDesc` 的 setter 只认固定几个字段**

`ShaderMaterial.shaderDesc` 的 setter（`:34425-34448`）**只取**：
`uniqueName` / `attributes` / `fragmentOutputTypes` / `vertexGLSL` / `fragmentGLSL` /
`vertexWGSL` / `fragmentWGSL`（外加 `vertexCode`/`fragmentCode`/`shaderLanguage` 的兼容写法）。
⇒ 引擎那种"用 chunk 名当源码"的写法（`vertexChunk` / `fragmentChunk`，见 `:20622-20623`）
**不能通过 `shaderDesc` 表达**；想用 chunk 名必须走 `ShaderUtils.createShader` 那条路。

**这一轮实测的三件事**

| 观测 | 值 | 含义 |
| --- | --- | --- |
| 场景级材质（`scene.gsplat._material`）是什么 | 一个 `ShaderMaterial`（原型上有 `shaderDesc` / `getShaderVariant`），但 **`shaderDesc` 为 null、本地 chunk 为空、`meshInstances` 为 0** | 它只是个**参数/模板**对象，不自己画 |
| `applySceneLevelMaterial()` 是否改到它 | **没有** —— 我写了 `if (!material.shaderDesc) return false` 的守卫，而它恰好没有 `shaderDesc` | **我自己把路 A 变成了空操作** |
| 错误数 | 189~190（与改动前一致） | 目标错误**仍在** |

**结论：`scene.gsplat.material` 不是绘制用的材质**，它只是 compute 侧 `_updateMaterial(material)`
读取 chunk/defines 的**模板来源**。真正画的仍是 `GSplatHybridRenderer._material`（引擎建的那块）。

**所以这条链的完整结论是**：

1. 绘制用的是 **`GSplatHybridRenderer._material`**（引擎建，`uniqueName` 固定
   `"UnifiedSplatHybridMaterial"`，`fragmentOutputTypes` 默认 `['vec4']`）。
2. 引擎自己的片元（`gsplatPS`）**只写 `output.color`**，因此**它不可能满足 2 附件 MRT**。
3. 想让它满足，必须**给它一份会写两个输出的片元**，并且：
   * 片元**不能 `#include`** 引擎已自动带入的 chunk（会重复定义 `normExp` / `modifySplatColor`），
     要么用已展开的源码、要么只定义自己的函数；
   * **必须换一个新的 `uniqueName`**，否则 `getCachedShader` 会命中旧着色器（事实一）。
4. 而"我们 per-instance 的着色"要真正跑在这条路上，还得让 `_material` 拿到我们的着色 ——
   这条路与 2/3 是同一份工作。

**下一步（明确且收敛）**：给 `GSplatHybridRenderer._material` 换一套
**自写片元（写 `output.color` + `output.color1`）+ 新 `uniqueName` + `fragmentOutputTypes: ['vec4','vec4']`**。
验收：目标错误归零 → 转相机 30° 画面活 → 再谈着色链路。
这是**一份确定的工作**（不是再猜），估计需要一个专门的窗口来落，因为它同时是
"让 unified 通路可用"和"把我们的材质搬过去"的第一步。

**备选（可能更省）**：路 B —— 让 unified 模式下 splat pass 用**单附件**目标，
这样就完全不需要第二个输出。代价是要知道 RT1 在 unified 下是否真的没人读
（我们 per-instance 材质往 RT1 写选区覆盖，轮廓/底衬 pass 读它）。

### 4l. ⚠️ 第十二轮：**我的探针没打开材质钩子的开关** —— 前面几轮的"修复无效"全部是无效读数

按用户的要求动手实现（自写片元写两个输出 + 新 `uniqueName` + `fragmentOutputTypes: ['vec4','vec4']`），
改完测了两轮，错误数**一点没动**（189~190、两类错误都在）。按惯例该继续查产品代码 ——
但这次先查了**量具**，结果又是量具：

**我的探针 `_tmp/probe-pipeline-error.cjs` 只翻转了组件字段 `comp.unified = true`，
从来没有设 `window.__SPLATROOM_UNIFIED__`。** 而我们的材质钩子
（`scene.ts` 的 `_unifiedMaterialEnabled`）**只认那个全局**（判定来源归一化之后就是这样）。
⇒ 钩子在第一行 `if (!this._unifiedMaterialEnabled) return;` 就早退了
⇒ **修复代码一次都没跑**。三条证据：

1. 新加的 `__SPLATROOM_UNIFIED_HOOK_STATE__` 一直是 `null`（钩子没进函数体）；
2. `__SPLATROOM_UNIFIED_INSTALL_STATE__` 也是 `null`（没走到安装那一步）；
3. 但 `scene.ts` 与构建产物里这两个钩子都在。

**所以结论要改**：§4i 里写的"补 `fragmentOutputTypes` 没生效"、§4k 里写的
"路 A 是空操作"——**这两条的测量都是在"修复没运行"的状态下做的，都不能作为
"这个修法不行"的证据**。（§4k 里"场景级材质 `shaderDesc` 为 null、我那个守卫会 early-return"
这条**代码事实**仍然成立；但"错误数没降"不能归因于它。）

**探针修好之后（真的设了全局）**，状态立刻可见了：

| 观测 | 值 |
| --- | --- |
| `__SPLATROOM_UNIFIED_HOOK_STATE__` | `{reached: true, collected: 1}` ⇒ 钩子跑到了、收集到 1 块材质 |
| `__SPLATROOM_UNIFIED_INSTALL_STATE__` | `{hasVertexSource: false, vertexLen: 0, currentName: null, wantName: "SplatRoomUnifiedMaterial-1700-292"}` |
| shader modules | 12 → **27**（比之前多 2 个，说明确实多编译了东西） |
| `createRenderPipeline` | 6 → 9 |
| 目标错误 | **仍在**（4 条 `Color target … targets[1]` + 2 条 inherited） |

⇒ **下一个明确的阻塞**：安装被我自己的守卫挡住了 —— `hasVertexSource: false`。
我用的顶点源是 `material.shader?.definition?.vshader`（"引擎已展开的 hybrid 顶点"），
**但那块材质在编译之前 `shader` 为空** ⇒ 永远拿不到 ⇒ `if (vs && …)` 永不成立。
（顺带说明：这块材质**看起来确实就是绘制材质** —— 装它的过程让 `createRenderPipeline`
从 6 涨到 9，说明我们改的东西进了编译。）

**下一步（明确）**：换一个**不依赖已编译 shader** 的顶点源取法。三条候选：
1. 用 `ShaderChunks.get(device, SHADERLANGUAGE_WGSL).get('gsplatHybridVS')` 拿原始 chunk，
   交给材质自己展开（`shaderDesc` 的 `vertexCode` 支持含 `#include` 的源）；
2. 引擎的 `shaderDesc` setter 不支持 `vertexChunk`，所以走 `ShaderUtils.createShader` 那条路；
3. 干脆先不换顶点 —— 只把 `fragmentOutputTypes` 设成两路并发起编译（片元仍是引擎那份），
   先看**错误是否减少**（这只验证"输出路数"这一环，不动顶点）。

### 4m. ✅ 第 3 条最小验证做完了：**光声明两路输出不够，片元必须真的写第二个输出**

按 §4l 的第 3 条做了最小实验（`__SPLATROOM_UNIFIED_OUT_TYPES_ONLY__`）：只把
`fragmentOutputTypes` 设成 `['vec4','vec4']`、**不动顶点、不动片元**（片元仍是引擎那份）。

**这次能确认改动真的生效了**（上一轮的教训：先看记录再看数字）：

```
outTypes-only 记录: {"uniqueName":"SplatRoomUnifiedMaterial-outtypes",
                     "hadVertexCode":true, "hadFragmentCode":true}
```

⇒ `hadVertexCode: true` 说明**这块材质的 `shaderDesc` 是有源码的**（与"场景级材质没有 shaderDesc"
是两回事），改动确实写进去了。而 `shader modules 12 → 27`、`createRenderPipeline 6 → 9`
也说明它进了编译。

**错误数：没动**（190 条 submit 校验错误；未捕获错误仍是 4 条 `Color target … targets[1]`
+ 2 条 inherited）。

**结论（这就是我们要的答案）**：WebGPU 那条校验**不认"声明了几路输出"**，
它认的是**片元真的写了那个附件**。所以：

* `fragmentOutputTypes` 设成两路是**必要但不充分**的；
* **必须**换成自写片元（真的写 `output.color1`）—— 也就是 §4l 里已经写好的那份
  `unifiedFragmentShader`；
* 唯一还挡着的就是**顶点源的取法**（`material.shader.definition.vshader` 在编译前取不到）。
  换掉这一个取法，自写片元就能装上，然后再看错误数是否归零。

**所以下一步只剩一件事**：把顶点源改成"不依赖已编译 shader"的取法。
最省的做法是拿原始 chunk 交给材质自己展开：

```ts
const raw = ShaderChunks.get(device, SHADERLANGUAGE_WGSL)?.get?.('gsplatHybridVS') ?? null;
// 然后 shaderDesc.vertexCode = raw（它含 #include，材质编译时会展开）
```

### 4n. ✅✅ 第十三轮：**通了。** unified 通路的画面活了

> ⚠️ **2026-09-25 晚更正（见 §4q/§4r/§4s）：这一节的结论是错的。**
> "转相机画面会变"这个判据**根本不是 splat 造成的** —— 把 splat 实体整个关掉、把 unified
> 渲染器的 `meshInstance.visible` 设成 false，那种变化**一模一样**（mad 逐位相同）。
> 后来用 GPU 层的仪器查到：unified 那次绘制用的是**全 0 的间接参数**（`indexCount = 0`、
> `instanceCount = 0`），也就是**一个图元都没有** ⇒ 这条通路的画面**从来没活过**，
> §4n 的 6.79% 是场景里别的东西（世界层的房间/网格）跟着相机转。
> 190 → 1 的错误下降仍然是真的（那条修复修的是"材质/管线合法"这一层），
> 但"修好了 ⇒ 画面活了"这一步是**误判**。

按 §4m 的结论换掉了顶点源的取法（`material.shader.definition.vshader` → 引擎全局 chunk 注册表里的
**原始** `gsplatHybridVS`，含 `#include`，交给材质自己展开）。两个独立判据同时通过：

| 判据 | 修之前 | 修之后 |
| --- | --- | --- |
| submit 校验错误 | **190** | **1** |
| 未捕获 `GPUValidationError` | 382（含 4×`Color target … targets[1]`） | **4**（2× targets[1] + 2× inherited，都只剩最早那几帧） |
| **转相机 30° 的画面变化**（阳性对照） | mad 0.116 / **0.48%**（画面是死的） | mad **2.983** / **6.79%** ⇒ **画面活了** |

安装记录也证明东西真的装上了：

```
安装状态: {hasVertexSource:true, vertexLen:4198, sourceKind:"raw-chunk", wantName:"SplatRoomUnifiedMaterial-1700-292"}
已装记录: {uniqueName:"SplatRoomUnifiedMaterial-1700-292", vsLen:4198, fsLen:1700, outTypes:2, sourceKind:"raw-chunk"}
```

**这一轮到底做对了什么（三件事缺一不可）**：

1. **顶点源不能依赖已编译的 shader** —— 那块材质在编译前 `shader` 为空，
   `material.shader.definition.vshader` 永远取不到 ⇒ 安装被自己的守卫挡住。
   改用全局 chunk 注册表里的原始 `gsplatHybridVS`（`ShaderChunks.get(device,'wgsl')`）就通了。
2. **`uniqueName` 必须随源码变化** —— 引擎按 `uniqueName` 缓存着色器
   （`ShaderUtils.createShader` → `getCachedShader`），名字不变永远命中旧的。
3. **片元必须真的写 `output.color1`** —— 只声明 `fragmentOutputTypes: ['vec4','vec4']` 不够
   （§4m 的最小实验已经证明了这一点）。

**结论：一期（让 unified 通路可用）的核心障碍已清除。** 剩下的 4 条错误都在"材质还没装上"的最早几帧，
属于**上车前的瞬态**，不是持续故障（190 → 1 就是证据）。下一步可以把那几帧也覆盖掉
（例如在导入完成前就先装好），或者直接进入一期的下一步：**把我们的着色挂到这条路上**。

**为什么"转相机"这个判据值得一直留着**：整个问题的核心症状就是"画面不跟着相机动"，
而这个判据与着色实现完全无关、一眼可读 —— 前面几轮正是因为没用它，才在"零变化"上绕了那么久。

### 4o. 一期挂色的第一次尝试：**自定义 uniform 送不进投影 compute**

把饱和度与对比度接上了（`unifiedModifyVS` 里 `srApplySaturation` / `srApplyContrast`，
中性值 saturation=1、contrast=0 ⇒ 恒等），`scene.ts` 的钩子也从 splat 元素读这两个参数喂进去。
验收探针 `_tmp/probe-unified-grading.cjs` 的结果：

| 判据 | 结果 |
| --- | --- |
| 安装记录 | `{uniqueName:"SplatRoomUnifiedMaterial-1700-774", vsLen:4198, fsLen:1700, outTypes:2, sourceKind:"raw-chunk"}` ✓ |
| ① 转回原机位差异 | mad **0**（机位确实回来了，测量可信）|
| ② 阳性对照（转 30°） | mad **2.746** / 6.79%（**画面是活的**）|
| ③ `saturation = 0` 与中性值之差 | mad **0**、逐像素完全相同 ⇒ **调色没生效** |

**根因（读引擎源码确认）**：投影 compute 的 uniform 布局是引擎**写死**的二十个字段 ——
`GSplatProjector._createUniformBufferFormats()`（`playcanvas.mjs:86378-86402`）：
`splatTextureSize / numBins / isOrtho / viewProj / viewMatrix / cameraPosition / minPixelSize /
cameraDirection / focal / viewportWidth / viewportHeight / nearClip / farClip / alphaClip /
minContribution / minDist / invRange / foveationStrength / foveationCenter`。

虽然 `GSplatProjector.dispatch()` **会**把材质上的参数逐个转发给 compute
（`:86599-86606`，`compute.setParameter(name, srcParams[name].data)`），
但 `UniformBufferFormat` 里**没有** `saturation` / `contrast` / `uProbeGain` 的槽位
⇒ 这些 uniform 永远读到默认值（0）。**所以 `saturation` 恒为 0**，
而"设成 0 与不设一样"正好对上这一点。

**⇒ 一期挂色的关键结论：`gsplatModifyVS` 这条 compute 钩子里，值不能靠自定义 uniform 送进来。**
可行的分配通道只有三种：

1. **烘焙成常量**：钩子在渲染前每帧检查参数，**变了就把值作为常量写进 WGSL 源码**并换
   `uniqueName` 重新编译。代价是拖动滑块时每次变化都要重编译一次着色器（滑块的更新频率下可能太重）。
2. **借用引擎已有的 uniform 槽位**：例如 `foveationStrength` / `foveationCenter`
   （我们不用注视点渲染）。代价是语义混淆、且升级引擎时可能被改；需要写清楚并加断言。
3. **走引擎自己的 user varyings 通路**（`app.scene.gsplat.varyings.add(...)`）：
   引擎会为自定义每-splat 属性生成 compute 写 + 顶点读的 chunk，
   **但它写进的是 projCache、不是 uniform** —— 那是**每 splat** 的值，不是全局参数，
   所以适合"选区状态/删除状态"（二期），不适合"饱和度"这种全局滑块。

**下一步建议**：一期先用**第 1 条（烘焙常量）**打通"我们的调色确实能作用于 unified 画面"这个
证明；等证明成立、再决定滑块的真实通道（很可能最终是第 2 条 + 明确断言，或把全局参数
挪到**片元**那一侧做——片元的 uniform 走引擎常规通道，不受这二十个字段限制）。

**顺带一个仍然没解释清的点（记账，不要忘）**：中性值下画面 `meanRGB = [32.71, 31.92, 31.62]`
（三通道接近但不相等），而 `saturation` 恒为 0 时**本应完全灰**。这表明
`gsplatModifyVS` 里的 `modifySplatColor` **可能并没有真正影响最终颜色**
（或者影响的部分不是我们以为的那一路）。**这一点必须在继续之前查清** ——
否则又会变成"改了没反应，却不知道是通道错还是值错"。

### 4p. ✅ 那笔账查清了：**`gsplatModifyVS` 的 `modifySplatColor` 不影响最终颜色**

用"烘焙常量"绕开 uniform 这条路（`__SPLATROOM_UNIFIED_BAKE__`，默认关闭，
探针 `_tmp/probe-bake-effects.cjs`）：

| 组 | 烘焙 | install uniqueName |
| --- | --- | --- |
| 中性 | 无 | `SplatRoomUnifiedMaterial-1700-1nvnvq9` |
| 灰 | `saturation: 0` | `…-1700-19gwpal` |
| 红 | `red: 1` | `…-1700-zmi4pn` |

**三组的 install uniqueName 互不相同**（说明三次都真的重编译了），
而三张画面 **逐像素完全相同**：`meanRGB` 都是 `[32.71, 31.92, 31.62]`，
`saturation=0` 与中性之差 `mad = 0`，**纯红阳性对照与中性之差也是 `mad = 0`**。

⇒ **结论确定：`gsplatModifyVS` 里的 `modifySplatColor` 不会影响最终画面。**
不是值的问题、不是缓存的问题（这两个都已排除），是**这条颜色通道在这个引擎版本/这条通路里不生效**。

**排查过程中又踩到一个坑（值得记）**：第一版我用**源码长度**当缓存键
（`wantName` 里放 `bakedModifyVS.length`），而烘焙值是 `toFixed(6)` 的**定长**字符串 ——
`red: 0 → red: 1` 长度完全不变 ⇒ 缓存键不变 ⇒ 引擎按 uniqueName 命中旧着色器、**根本没收新源码**，
于是那一轮测出"红色阳性对照没生效"其实是**测试自身的缺陷**。
现在改成按**内容**散列（`hashSource`，FNV-1a）。**教训：能变的量必须进缓存键，且要能区分内容。**

**这一步对一期的意义（重要，影响后面的路线）**：

* 一期**不能**靠 `gsplatModifyVS` 做调色 —— 这条通道已排除；
* 好消息是：**片元那一侧在我们手里**（自写片元已经装上、画面是活的、而且它同时写两路输出）。
  引擎的常规 uniform 通道（`material.setParameter`）对片元是有效的
  （`alphaClipForward` 等就是这样工作的），所以**全局调色参数应当走片元**；
* 而"每 splat 的状态"（选区/删除/裁剪）需要 `GSplatVaryings` 把值送进片元 —— 那是二期的活。

⇒ **下一步（明确）**：把饱和度/对比度（以及后续曲线/HSL）做进**我们那份自写片元**，
用引擎常规的 `material.setParameter` 传参 —— 它是这条通路上唯一被验证过"能改变画面"的着色位置。











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

> ✅ **2026-09-26 凌晨：这个坑**修好了**，`?unified=1`（以及打包版的 `--unified=1`）现在能正常导入。**
> 真正的机理由两条叠在一起（都不是"引擎的错"，全在我们自己的代码里）：
>
> 1. **曲线 LUT 的直传一直是坏的**：`writeCurveTable()` 里写的是
>    `const height = CURVE_CHANNELS`，而 `CURVE_CHANNELS` 是**通道名数组**
>    （`['master','red','green','blue']`）⇒ `Number(array)` = **NaN** ⇒ `queue.writeTexture`
>    抛 "Failed to read the 'rowsPerImage' property ... not of type 'unsigned long'"
>    ⇒ 函数返回 false ⇒ 调用方走 `curveTexture.lock()` 兜底 ⇒ **`lock()` 在 unified 导入路径上
>    永久挂住**（这才是"导入静默卡死"的直接原因）。
>    顺带还发现第二层：即使 NaN 修掉，直传的数据只有**一行 33 个采样**（纹理是 33×4），
>    会报 "Required size ... (528) exceeds the linear data size (132)" —— 现在会把单行扩成 4 行。
> 2. **导入链上有一串 `instance` 假设**在 unified 下抛 TypeError（`add()` 里的
>    `gsplat.instance.sorter`、`rebuildMaterial()` 里的 `instance.material`、
>    `calcBound`/`calcPositions` 里的 `instance.resource`、数据面板里的同一处），
>    而这些异常**被导入链的 catch 接住 → 弹一个错误框等用户点确定** ⇒ 在无人操作的环境里
>    promise 永不 settle（还会误报 "loaded but cannot be displayed"）。
>    现在统一从 `src/splat/splat-resource.ts` 的 `splatResourceOf()` 取资源，
>    `renderDiagnostics` 也按 unified 的判据（没有 instance/sorter，看 `_placement` + 活动 splat 数）。
>
> 验收：开发版 `?gpu=webgpu&unified=1` 导入 `test-model.ply` → 状态 `done`、0 弹窗、0 未捕获异常、
> `renderCounter = numSplats = 1809`；打包版 `SplatRoom-3.23.44.exe --gpu=webgpu --unified=1`
> → 导入 103 ms、`renderCounter = numSplats = 1925`、0 条 error 级日志。
> 探针：`docs/probes/probe-unified-import-hang.cjs`、`docs/probes/probe-packaged-unified-e2e.cjs`。

以下是当时（未修好之前）的排查记录，保留作参考：

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

---

### 4q. 我的判据错了：那条"画面活了"的阳性对照**不是 splat 造成的**（2026-09-25 晚）

起因：用户反馈"即使在小模型上、缓慢旋转也能看到排序错位"。既然主线只剩 2 帧物理下限，
本轮要做的是把 §4n 那条 unified 通路真正接通。第一步是**重新验证 §4n 的判据**，
因为这一路已经有三次"用没校验过的仪器得出假结论"（§4l、§4m、§4p）。

**仪器 1 —— GPU 层"每一次绘制用哪份着色器"**（`_tmp/probe-who-draws.cjs` / `probe-who-draws2.cjs`）：
拦 `createShaderModule`（给模块打标记）、`createRenderPipeline`（管线记住片元模块）、
`beginRenderPass`（记颜色附件数）、`setPipeline` / `draw*`（记这一帧到底画了什么）。
+ 阳性对照仪器：`GPUAdapter.requestDevice` 上挂 `uncapturederror`。

读到的**地面真值**（unified 帧，每帧 5 个 pass）：

| pass | 颜色附件 | 绘制 |
| --- | --- | --- |
| 1 | `cameraColor` + `workColor`（= 我们的 `splatTarget`） | 0（clear） |
| 2 | `cameraColor`（mainPass） | CPU 通路 2 次 / unified 1 次 |
| 3 | `cameraColor` + `workColor` | **CPU：我们的 per-instance 材质；unified：我们那份自写片元** |
| 4 | `cameraColor`（gizmo） | 1 |
| 5 | 未知纹理 | 1 |

也就是说：**我们的片元确实被编译、确实被用在那次 splat 绘制上**（`createShaderModule` 记录里
含 `SR_FRAG_GAIN` 标记的模块只有一份，`fragRed = 1.000000`；`createRenderPipeline` 里对应
`targets: 2` 的管线也只有它一份）。

**但这一帧的像素与"把这次绘制去掉"逐位相同**（mad 0 / 0.00%），而且：

* 把渲染器的 `meshInstance.visible = false`：**绘制次数不变**（3 帧 3 次）⇒ 这个"隐藏"根本不是有效仪器；
* 把 splat 实体 `enabled = false`：CPU 通路的画面也不变 ⇒ 同上，这个开关也没接上；
* **`fragOpaque = 1`（片元无条件写不透明红，绕过 discard 与 alpha）也不上屏**，0 条 WebGPU 错误；
* 连 `vsCover = 1`（顶点里**绕过 `projCache` / `viewport_size`**，让每个实例的四边形铺满屏幕）
  也不上屏，仍然 0 条错误。

**仪器 2 —— 读 GPU 眼里的间接绘制参数**（`_tmp/probe-unified-indirect2.cjs`）：
在 `GPUCommandEncoder.prototype.finish` 里补一条 `copyBufferToBuffer`，把那一帧的
`drawIndexedIndirect` 参数在**同一帧、同一条 command buffer 内**抄到 staging buffer 再 map：

```
indexCount = 0   instanceCount = 0   firstIndex = 0   baseVertex = 0   firstInstance = 0
raw = [0,0,0,0,0,0,0,0]
```

**⇒ 根因：那条通路的绘制参数就是全 0 ⇒ 零图元**。零图元的 draw **不可能**报校验错，
所以"着色器全都对、材质状态与 CPU 通路逐项相同（blendType 4 / depthTest true / cull 0 /
写掩码全开 / 目标就是 `cameraColor`）、却没有一个像素"这件事完全自洽。

**顺带确认的两件事**：

* 排序/压缩的 compute **有派发**（unified 每 2 帧：20 个 compute pass、14 次 `dispatchWorkgroups`、
  6 次 `dispatchIndirect`；CPU 通路为 0）⇒ 不是"compute 没跑"，而是**跑完写出来的参数是 0**
  （cull / scatter / writeIndirectArgs 那一段的计数为 0 最可疑）；
* world 现场是**有数据**的：`totalActiveSplats = 2000`、`totalIntervals = 1`、
  `indirectDrawSlot = 0`、`lastCompactedNumIntervals = 1`、`sortParametersSet = false`（值得下一轮盯）。

**这一轮的教训（与 §4l/§4m/§4p 同一条）**：阳性对照必须**独立于被测对象**。
"转相机画面会变"看着与着色无关，实际上它会被**场景里任何东西**满足 —— 所以它只在
"被测对象是画面里唯一会动的东西"时才成立。真正与着色无关、又只认被测对象的两条判据是：
**GPU 层的绘制归属**（谁画了、画了几次）与**间接参数的值**。

### 4r. 现在的结论：unified 通路**画面从来没活过**，一期要重开

* §4n 的"画面活了"作废（见 4q）；§4j 里"unified 画面是死的"其实是**对的**，
  只是当时把原因归给了 `[Invalid RenderPipeline]`。
* §4h/§4k/§4l/§4m 那些**机制**结论仍然成立且有用（片元必须写 `output.color1`、
  `uniqueName` 必须随源码变化、顶点源要从全局 chunk 注册表拿）。
  它们修好的是"**管线合法**"这一层 —— **是必要条件，不是充分条件**。
* **一期（把默认渲染切到引擎 GPU 排序）的真实剩余工作**：让 cull/scatter/writeArgs 产出非零参数。
  这是一个**引擎集成问题**（我们的自建渲染循环 + 自定义 RenderPass 与引擎那道
  "每相机/每图层"的流程怎样对上），不是着色器问题。
* 建议的下一轮起点（都很小、可单测）：
  1. 在 `writeIndirectArgs` 的 compute 之后抄一份它的输入/输出计数（`countBuffer` /
     `numSplatsBuffer` / `sortElementCountBuffer`）—— 看是 cull 归零还是 scatter 归零；
  2. 对照 `scene.gsplat` 的 `minPixelSize` / `minContribution` / `radialSorting` 与
     `sortParametersSet = false`：排序参数没被"设过"是否意味着视图参数是默认值（可能把一切都剔掉）；
  3. 用**官方 gsplat 示例页**跑同一份模型做对照（那里 unified 是活的），
     逐项 diff 我们缺了哪次调用 —— 这也是 §「为什么它不是本项目的活」里建议的干净环境做法。

**起点 1/2 已经做完，而且把问题钉到了一个具体位置**（下面每一条都是**经过有效性检查**的读数）：

| 环节 | 手段 | 读数 | 判读 |
| --- | --- | --- | --- |
| world 状态 | 读 `world.currentState` | `totalActiveSplats=2000`、`totalIntervals=1`、`splats=[{activeSplats:2000, intervals:[], intervalOffsets:[0], boundsBaseIndex:0}]` | 数据齐 |
| 区间表内容 | **JS 层截住 `intervalsBuffer.write()`** 的入参 | `[0, 2000, 0, 0]` = `{workBufferBase:0, splatCount:2000, boundsIndex:0}` | **正确** |
| 上传时机 | 截 `uploadIntervals` 入参 | `skipped: true`（`worldState.version === _uploadedVersion` 恒成立）⇒ 只传过一次 | 无害（那一次内容就是上面那份） |
| cull 输入 | JS 层截 `boundsBuffer.write` / `transformsBuffer.write` + 读 `frustumPlanes` | bound = `{center:(-0.0005, 0, -0.30), radius:1.1563, transformIndex:0}`；transforms = 单位阵（y 翻转）；6 个平面的有符号距离全为正（最小 0.549） | 按 cull 的 WGSL（`dist <= -radius` 才判不可见）**应当 visible = true** |
| 派发 | 数 compute pass / `dispatchWorkgroups` / 提交 | 每 2 帧 20 个 compute pass、14 次 dispatch（cull 是 1 个 workgroup）、**这些 compute 与渲染在同一个 command buffer 里，且该 buffer 确实被 `queue.submit`** | 派发与提交都发生了 |
| 校验错误 | `uncapturederror`（稳态重置后） | 0 条 | 没有报错可循 |
| 链尾输出 | 读带 `COPY_SRC` 的 `numSplatsBuffer` / `sortElementCountBuffer`（每帧由 `writeIndirectArgs` 写） | 恒为 0 | 见 §4t：这是**结果**，不是原因 |
| **偷换 writeArgs 的输出** | 把 `numSplatsBuf` 参数换成我自己可读的 buffer，再渲染 2 帧 | **收到 2000** | `IntervalWriteIndirectArgs` **执行正常、值也对** |
| **裸 compute 读引擎自己的 buffer** | 裸管线把 `intervalsBuffer` / `countBuffer` 抄进我可读的 buffer | `intervals={splatCount:2000}`、**`countBuffer=[0,2000]`** | cull 与前缀和**都跑通了**（2000 个可见 splat 就在 `countBuffer[1]`） |
| 投影器 | 读 `renderCounter` | **0** | 2048 个线程里没有一个判定为有效 splat ⇒ 它把 `numSplatsBuf[0]` 覆盖成 0 |
| work buffer 上传 | 拦 `queue.writeTexture` / `copyBufferToTexture` | unified 期间 48×48 的数据贴图**一次上传都没有** | 投影器的输入是空的 |

⇒ **结论见 §4t**：JS 层输入全对、compute 全部正常执行、设备与缓冲都没问题；
第一个 0 出现在**最前面**——引擎的 work buffer 首传被跳过，投影器因此没有任何输入数据。

**⚠️ 本轮四次"读数无效"的教训（都会制造出"全 0"的假象，必须记下来）**：

1. `copyBufferToBuffer` 的**拷贝长度不能超过目标 buffer 大小**（16B 的 buffer 抄 32B ⇒ 拷贝被拒 ⇒ staging 保持新建时的 0）；
2. 源 buffer **必须有 `COPY_SRC`**：`intervalsBuffer`（STORAGE|COPY_DST）与 `countBuffer`（只有 STORAGE）都读不回来
   —— 想读它们只能用 §4t 的"裸 compute 抄一份"；
3. `writeBuffer(buf, off, view, dataOffset, size)` 的 `size` **按元素个数**算（实测：`size=4` + `Uint32Array([11,22,33,44])` ⇒ 四个全落盘），引擎传 `numIntervals * 4` 是对的；
4. **"某个计数是 0"必须先确认不是仪器问题**，而且**不要停在第一个 0 上**：
   本轮真正的原因在最前面，中间所有环节其实都是好的。

读数前先自证仪器可用（大小、usage、长度），否则"全 0"极可能是仪器假象 —— 这一条与
§4l/§4m/§4p/§4q 的教训是同一件事。

### 4s. 本轮为探针加的钩子（都在 `?unified=1` 之内，默认全关）

为了让上面这些问题以后能一次问清，本轮往这条通路里加了三个**只给探针用**的烘焙开关
（`globalThis.__SPLATROOM_UNIFIED_BAKE__`，默认 `null` ⇒ 与未烘焙逐位一致）：

| 开关 | 作用 | 能回答的问题 |
| --- | --- | --- |
| `{ fragRed: 1 }` | 片元把颜色朝纯红推 | 我们的片元参与最终画面吗 |
| `{ fragOpaque: 1 }` | 片元无条件写不透明红（绕过 discard/alpha） | 绘制到目标了吗，还是被 alpha 吃掉了 |
| `{ vsCover: 1 }` | 顶点绕过 `projCache`/`viewport_size`，实例铺满屏幕 | 是几何退化还是更外层的问题 |

配套代码：`src/shaders/unified-shaders.ts` 的 `bakeUnifiedFragmentShader` / `bakeUnifiedVertexShader`，
`src/splat/unified-material.ts` 在 `vsCover > 0` 时改用**我们那一份**顶点源。
这些常量都进了 `uniqueName` 的内容散列（`hashSource`），所以换值一定会重编译 ——
这正是 §4p 那次假结论的病根。

### 4t. ✅✅ **根因找到了，而且修好了**：unified 通路的 work buffer 首传被永久跳过（2026-09-25 深夜）

**一句话**：引擎只在"这个 world 从没排过序"时（`!worldState.sortedBefore`）才把 splat 数据传进
work buffer；我们是**导入完成后再把 `comp.unified` 翻成 true**，那一刻它早就 `sortedBefore = true`，
于是首传被永久跳过 ⇒ 三张数据贴图全空 ⇒ 投影器把每个 splat 都判无效（`renderCounter = 0`）
⇒ `ProjectorWriteIndirectArgs` 把计数写成 0 ⇒ 间接绘制 `instanceCount = 0` ⇒ **一个图元都没有**。
整条链上**没有任何一步报错**，这就是这个 bug 藏了这么久的原因。

**引擎侧的代码（playcanvas.mjs）**：

```js
markSorted(version, count, camera, updateBounds, result) {        // :84995
    const worldState = this._worldStates.get(version);
    if (worldState && !worldState.sortedBefore) {                 // ← 只有"从没排过序"才首传
        worldState.sortedBefore = true;
        this.rebuildWorkBuffer(worldState, count, false, camera, updateBounds);
    }
}
bake(version, camera, updateBounds, result) {                     // :85018  之后每帧走这里
    const sortedState = this._worldStates.get(version);
    if (sortedState?.sortedBefore) {
        if (this._workBufferRebuildRequired) this.rebuildWorkBuffer(sortedState, count, true, ...);
        else result.sortNeeded = this.applyWorkBufferUpdates(sortedState, camera);   // 增量，通常传 0 块
    }
}
```

**怎么钉到这一步的（每一步都是有效读数）**：

| # | 手段 | 读数 |
| --- | --- | --- |
| 1 | 拦 `GPUQueue.writeTexture` / `copyBufferToTexture` | unified 期间 48×48 的三张数据贴图**一次上传都没有**（只有一张 2×1） |
| 2 | 裸 compute 把 `countBuffer` 抄进可读 buffer | `[0, 2000]` ⇒ cull 与前缀和都跑通了 |
| 3 | 偷换 `IntervalWriteIndirectArgs` 的 `numSplatsBuf` 参数 | 我的 buffer 收到 **2000** ⇒ 它也正常 |
| 4 | 读 `renderCounter`（投影器自己的原子计数器） | **0** ⇒ 投影器一个有效 splat 都没算出 |
| 5 | 读 `world.bufferCopyUploaded / bufferCopyTotal` 与 worldState | 首传那条路没走（`sortedBefore` 已经是 true） |

**修复（入库，一行级）**：`src/splat/unified-material.ts` 新增 `ensureUnifiedWorkBuffer(scene)`，
在渲染前的钩子里对每个 GPU-排序 world 做一次 `world.invalidate({ workBuffer: true })`
（幂等：每个 world 每个版本只强制一次），下一帧 `bake()` 就走 `forceFullRebuild` 那条路。

**验收（`_tmp/probe-unified-verified.cjs`，跑的是仓库代码，探针**没有**手动 invalidate）**：

| 判据 | 修前 | 修后 |
| --- | --- | --- |
| `renderCounter`（投影器算出的有效 splat） | 0 | **1809** |
| `numSplatsBuffer` / `sortElementCountBuffer`（= 绘制 instanceCount） | 0 | **1809** |
| 画面亮度 `litPct`（luma > 60 的像素占比） | 3.84% | **42.79%** |
| 画面均值 RGB | `[32.7, 31.9, 31.6]`（纯背景） | `[124.4, 113.2, 114.5]` |
| **转相机 30° 的画面变化**（与着色无关的阳性对照） | 9.39%（那是世界层的房间，不是 splat） | **25.89%** |

**意义**：这是这条通路第一次**真的画出 splat**（此前 §4n 那次"活了"是误判，见 §4q）。
顺序与绘制同帧 ⇒ 理论上没有那 2 帧的排序滞后 —— 一期的**技术障碍到这里才算清掉**，
后面的工作是"把我们的着色/几何/状态接到这条路上"（二期）。

**同一个探针在大模型上也验过**（`test-layered.ply`，32 MB）：`renderCounter = numSplats =
sortElementCount = 549230`、画面 `litPct` 43.2%、转 30° 变化 5.1%（该模型铺满视野，转动本身
改变的比例就小）。⇒ 不是小模型才通的偶然。

**已知的二期差距（不是 bug，是还没接）**：unified 通路的画面均值偏灰偏亮
（`test-layered`：unified `[125,125,125]` vs per-instance `[50,69,120]`）——
因为我们的调色/色彩管线在 per-instance 材质里，而这条路上目前只有"与引擎默认逐位等价"的片元。
把调色（曲线/HSL/饱和度/对比）搬过来是一期之后的第一步。

**顺带记一条工程教训**：这个 bug 之所以难找，是因为**失败模式完全静默** ——
数据没传进贴图 → 投影器判无效 → 计数为 0 → 间接绘制画 0 个图元 → WebGPU 认为一切正常。
排查这类问题的正确姿势是**从"链尾"往"链头"逐级读中间量**，而不是盯着最终画面猜。

