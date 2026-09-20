# SuperSplat 3.3.0 代码可借鉴点（本机实测 + 上游源码核对）

> 目的：回答"SuperSplat 3.3.0 为什么快、有没有能搬到本 fork 的东西"。
> 上一份 `docs/perf/supersplat-3.3.0-对比调研.md` 是在原机器上凭 `_tmp\ss330\` 缓存写的（那份缓存没随交接包过来）。
> **本文件的所有出处都来自本轮重新拉取的真源码**，行号可 `git -C _tmp\ss330 show v3.3.0:<file>` 复核。

## 0. 本轮拿到的两份源码（都在仓库外）

| 源 | 路径 | 版本 |
| --- | --- | --- |
| SuperSplat 编辑器 | `C:\Users\admin\Desktop\3DGS\DeepSeek\SplatRoomV3\_tmp\ss330` | tag **v3.3.0**（`f345ae5`，`git describe` = `v3.3.0`），295 文件 / 6.3 MB |
| PlayCanvas 引擎 | `C:\Users\admin\Desktop\3DGS\DeepSeek\SplatRoomV3\_tmp\pc2221\package` | **2.22.1**（SuperSplat v3.3.0 钉的版本） |
| 本 fork 的引擎 | `SplatRoomV3-0\node_modules\playcanvas` | **2.21.3** |

**许可证**：两边都是 **MIT**（`ss330\package.json` `"license": "MIT"`、本仓库同为 MIT），搬代码没有许可证障碍（本仓库本来就是 SuperSplat 的 fork，保留出处注释即可）。

## 1. 三十秒版（三条最要紧的）

1. **SuperSplat 3.3.0 根本没用引擎的 unified 渲染器。** 它自己写了一个完整的 GPU-driven 渲染器 `ProjectedSplatRenderer`（`ss330\src\projected-splat-renderer.ts`，1198 行；外加 `src\shaders\projected-splat-*.ts` 约 40 KB WGSL），直接建在设备级 API（`Shader`/`Compute`/`StorageBuffer`/`BindGroupFormat`）之上；整套渲染管线里**没有任何** `unified` / `GSplatManager` / `GSplatRenderer` 的引用（`grep` 全 `src\` 只命中 `gsplat` 资产类型与自家 shader chunk `#include "gsplatUncompressedVS"`，见 `ss330\src\editor-splat-resource.ts:87`）。
2. **它要的机器，我们**已经**装好了**：本 fork 的引擎 2.21.3 里
   - `ComputeRadixSort` **已导出**（实现 `node_modules\playcanvas\build\playcanvas\src\scene\graphics\radix-sort\compute-radix-sort-{base,multipass,onesweep}.js`）——SuperSplat 就是 `new ComputeRadixSort(device, { indirect: true })`（`projected-splat-renderer.ts:242`）；
   - WebGPU 设备**已有 indirect draw 缓冲**（`.../platform/graphics/webgpu/webgpu-graphics-device.js` 里 `indirectDrawBuffer`）；
   - 引擎里**整套 unified 管线都在**（`.../scene/gsplat-unified/` **64 个文件**：`gsplat-projector.js`、`gsplat-interval-compaction.js`、`gsplat-frustum-culler.js`、`gsplat-unified-sorter.js`、`gsplat-quad-renderer.js`、`gsplat-hybrid-renderer.js`、`gsplat-manager.js`…）——只因为本 fork 强制 **`unified: false`**（`src/splat/splat.ts:290-293`）而**一行都没跑到**。
3. **升级引擎买不到性能**：2.21.3 → 2.22.1 的 `scene\gsplat` 目录**文件数相同（各 28 个）**，`scene\gsplat-unified` 只**多了 `gsplat-lod-table.js`（+1 文件）**。SuperSplat 的快不是"引擎新"，是**它自己写的那套渲染器**。

### 1.1 关键可行性核对：它用到的引擎 API，我们 2.21.3 **全都有**（本轮逐个 grep 过）

| SuperSplat 用到的 API | 我们 2.21.3 里 |
| --- | --- |
| `Compute` / `StorageBuffer`（含 `.clear()` / `.read()` / `.write()`） | ✅ `platform\graphics\compute.js:1`、`platform\graphics\storage-buffer.js:4,16,31,34,37` |
| `BindGroupFormat` / `BindStorageBufferFormat` / `BindStorageTextureFormat` | ✅ `platform\graphics\bind-group-format.js:45`、`index.js:39` |
| `device.getIndirectDrawSlot()` / `device.indirectDrawBuffer` / `MeshInstance.setIndirect()` | ✅ `platform\graphics\graphics-device.js:398,401`、`scene\mesh-instance.js:427` |
| `ComputeRadixSort`（含 `sortIndirect()` / `prepareIndirect()` / `{indirect:true}`） | ✅ `scene\graphics\radix-sort\compute-radix-sort-base.js:3,40,43`；`platform\graphics\compute.js:12` |
| `Camera.applyShaderProjectionTransform()` | ✅ `scene\camera.js:52` |
| `device.supportsTimestampQuery` + `gpuProfiler.report` 异步回报 | ✅ `platform\graphics\webgpu\webgpu-gpu-profiler.js:10`；`platform\graphics\gpu-profiler.js:48` |

⇒ **路线 B 不需要升级引擎**。另有一条**架构旁证**：引擎自己的 unified 实现（`...\scene\gsplat-unified\gsplat-hybrid-renderer.js`、`gsplat-projector.js`、`gsplat-interval-compaction.js`）与 SuperSplat 这套**架构几乎一致**，但只在 `unified: true` 下可达（引擎组件里每处渲染入口都 `if (this.unified)` 分派）——这是"自己写"与"打开引擎现成实现"的岔路口，见第 6 节。

### 1.2 一条硬约束：SuperSplat 这套是 **WebGPU-only**

它强制 `deviceTypes: ['webgpu']`（`ss330\src\main.ts:129`），所有自定义着色器都是 WGSL（`SHADERLANGUAGE_WGSL`），**全仓没有任何 WebGL2 回退**。而本 fork 明确支持双后端（验证套件就是两边各跑一遍）⇒ 路线 B 要么**只在 WebGPU 下启用**（WebGL2 保留现有路径），要么得写一套平行 GLSL 实现。这是选择路线 B 时必须先回答的问题。

## 2. 它的"快"具体由哪几件事构成（全部带出处）

| # | 机制 | 出处 | 关键参数 / 上游实测数字 |
| --- | --- | --- | --- |
| 1 | **运动帧完全不排序**，改走 1 spp **stochastic**（抖动+深度测试）渲染；站定后才补一帧干净的排序混合帧 | `projected-splat-renderer.ts:876` `this.setStochastic(this.scene.movingRender && !forPick)`；`ss330\src\scene.ts:105-110`（`movingRender` / `pendingResolve` 语义）、`:552-553` | 注释原文：*"fast stochastic while interacting, clean sorted & blended when the scene settles"*（`:874-875`）。**做法**（`shaders\projected-splat-shader.ts:276-306`，注释自引 *StochasticSplats, Listing 1*）：*"keep this fragment with raw probability alpha, write it opaque; **the depth test resolves visibility, so no sorting**"* —— 覆盖率阈值按分层抖动采样（一个 splat 的 alpha=a 时覆盖其 quad 的 4a±1 格）；alpha 通道用 2 标记"这是随机采样像素"，另有 resolve 通道把它们还原成平滑图像（`ss330\src\camera.ts:357` 的 `quadResolve`） |
| 2 | **只有"真的慢"才启用降级**：`auto` 模式看**上一帧普通（排序）帧的 GPU span**，超过阈值才启用 | `scene.ts:136` `autoEngageMs = 60`、`:688` `this.autoEngaged = gpuTime > this.autoEngageMs` | 阈值 **60 ms**；注释说明`scene.autoEngageMs = 5` 可在控制台调小以便在小场景上验证开关 |
| 3 | **自适应贡献剔除**：按 alpha 质量（像素面积）剔除，朝 **12 ms GPU 预算**做阻尼比例步进 | `projected-splat-renderer.ts:562-579`（`reportStochasticFrame`）、`:209` `motionBudgetMs = 12`、`:75-77` 三个常量 | 步长 `MOTION_CONTRIBUTION_STEP = 0.05`、上限 `MAX = 1`、限频 `MOTION_STEP_MS = 50`；阻尼因子夹在 `[0.85, 1.2]`。**实测：上限 8 会把 Bowes 航拍 88% 的 survivor 砍掉、误差相对排序帧翻倍；上限 1 只花 ~2 RMS 换 −26% GPU** |
| 4 | **遮挡剔除**：用**上一帧 stochastic 的深度缓冲**折成 **8 px 块的最大深度图**，块内最远深度之外的 splat 视为上帧不可见 | `projected-splat-renderer.ts:79-84`（`OCCLUSION_BLOCK = 8` 与实测）、`:582-606`（depth-reduce compute）、`:625-638`（`reduceDepth`）；判据在 `shaders\projected-splat-projector-shader.ts:348-390` | **实测：4 px 块砍 26% survivor、8 px 砍 41%**；概率口径 `(1-T)^N`；只有真正的 disocclusion 会晚一帧；footprint 比两块还宽的跳过测试 |
| 5 | **紧凑化 + indirect draw**：survivor 用原子追加进密集列表，排序与绘制都只覆盖可见数 | `shaders\projected-splat-projector-shader.ts:484-495`（`atomicAdd(&splatCounter[0],1)`）；indirect 参数在 `shaders\projected-splat-indirect-args-shader.ts` | 注释：*"Only surviving threads contend, which is **0.1-10% of the dispatch** in practice"*（`:485`） |
| 6 | **贡献剔除排在 SH 与调色之前**：被剔的 splat 只花"尺寸剔除级"的代价 | `projector-shader.ts:413-420` | 判据 `gradedAlpha * 2π * sqrt(det) < minContribution`（就是引擎的 `minContribution` 规则） |
| 7 | **排序键**：线性归一化视深、取反（从远到近），**20 位**基数排序 | `projector-shader.ts:487-494`；`projected-splat-renderer.ts:63-65`（`SORT_KEY_BITS = 20`，`(~depth) >> 12`） | 注释：再高的位"sorting more than this cannot change the ordering" |
| 8 | **尺寸剔除**（我们已有的那条）：`2*sqrt(2*λ1) < minPixelSize` | `projector-shader.ts:312` | 与我们引擎/自家 WGSL 的 `minPixelSize` 同规则 |
| 9 | **环/拾取豁免**：会画 ring 的 splat 不受贡献与遮挡剔除影响 | `projector-shader.ts:344-347`、`:417-419`；`projected-splat-renderer.ts:858-863`、`:910-913` | 保证"环模式/拾取"语义不被降级破坏 |
| 10 | **GPU 计时消费方式**（可直接照搬的接线） | `scene.ts:283`（`supportsTimestampQuery`）、`:290-295`（**monkey-patch `gpuProfiler.report`** 拿到每帧 span 与 `renderVersion`）、`:649-650`（按 `renderVersion` 记录该帧是哪种模式） | 报告是异步回来的，所以要按 `renderVersion` 归属；`moving` 帧的 span 喂给贡献剔除、**非 moving** 帧的 span 才用于"是否启用降级" |

## 3. 它的每帧管线（命令级，供实现时对照）

由 `Scene.onPreRender` 驱动（`ss330\src\scene.ts:607` `this.projectedSplatRenderer.render()`），`render()` 只做 **CPU 记账 + 录命令**：

| # | 步骤 | 在哪跑 | 出处 |
| --- | --- | --- | --- |
| 1 | layout 重建（仅脏时）：cacheA(RGBA32U)/cacheB(R32U) 存储纹理、`sortKeys`、`compactEntries` | CPU | `renderer.ts:740-807` |
| 2 | `splatCounter.clear()`（8 B = 2×u32：存活数 / 被剔尾数） | GPU | `renderer.ts:896,243` |
| 3 | **投影 + 剔除 + 紧凑化**（每 placement 一次 dispatch，`@workgroup_size(256)`） | **GPU compute** | `renderer.ts:990-993`；`projector:206,467-495` |
| 4 | **indirect 参数**（1 workgroup×1 线程算 draw/dispatch 参数） | **GPU compute** | `renderer.ts:998-1014`；`indirect-args-shader.ts:44-72` |
| 5 | **基数排序**（**仅非随机帧**；间接 dispatch） | **GPU compute** | `renderer.ts:1031-1038` |
| 6 | `meshInstance.setIndirect(null, drawSlot, 1)` | CPU 绑定 | `renderer.ts:1015` |
| 7 | **splat 绘制**（前向混合；随机帧=不透明+深度测试） | GPU 栅格 | `camera.ts:574-576`；MRT `camera.ts:537-544` |
| 8 | **depth reduce**（上一帧深度 → 每 8×8 块最大深度） | **GPU compute** | `camera.ts:343-345` 挂在 `camera.ts:593` 的 `framePasses` 里 |
| 9 | centers overlay 绘制（间接槽 `drawSlot+1`） | GPU 栅格 | `renderer.ts:1106` |
| 10 | **final blit / resolve**（随机帧 quad resolve、overdraw 热图、上采样） | GPU 片元 | `camera.ts:346-361`；`blit-shader.ts:42-73` |

**它不用引擎的 gsplat 组件**：自建 `Entity` + `MeshInstance.setIndirect` + `ShaderMaterial`（`renderer.ts:245-291`；`grep addComponent` 只出现 `'render'`/`'camera'`）⇒ **"本 fork 强制 `unified:false`" 对它毫无影响**，它压根没走引擎那条路。

**剔除顺序**（都在 projector 里，按 shader 内顺序）：拾取状态（selected/locked 位）→ 相机背面 → 退化（`clip.w==0` / `det<=0`）→ **尺寸**（`minPixelSize`）→ **屏幕外**（屏幕空间椭圆 vs viewport，`projector:336-342`）→ **遮挡** → **贡献**。前四条 + 屏幕外**都不需要 compute**，可直接搬进我们自己的着色器。

**排序细节的两个小坑（若我们用 `ComputeRadixSort`）**：位数必须对齐到 `sorter.radixBits`（`renderer.ts:1031` `roundUp(SORT_KEY_BITS=20, radixBits)`），否则「hangs OneSweep's lookback loop → D3D12 device-removed TDR」（`renderer.ts:1024-1030`）；另可用 `skipLastPassKeyWrite` + `destructiveKeys` 省带宽（`renderer.ts:1035-1037`）。

**没有的东西（别去找）**：运行时的屏幕占用 LOD / 流式（`lod*` 全在导入期，`io/read/loader.ts:34-45`）；CPU/worker 排序（全仓无排序 worker）；多级深度金字塔（只有一级 8 px 块）。

## 4. 我们这边"缺什么、有什么"（本轮实测）

| 能力 | 本 fork 现状 | 依据 |
| --- | --- | --- |
| GPU 计时消费 | **完全没有消费者**（`grep gpuProfiler\|gpu:report` 全 `src/` 零命中） | 本轮实测 |
| GPU 计时**可用性** | **可用**：`device.supportsTimestampQuery` 存在；`GpuProfiler` 有 `enabled`/`_frameTime`/`request()`/`report(renderVersion, timings, frameTime)`；WebGPU 子类在 `request()` 里 `.then(...)` 异步调 `report` | `.../platform/graphics/gpu-profiler.js:15-73`、`.../webgpu/webgpu-gpu-profiler.js:16-32`、`.../webgl/webgl-gpu-profiler.js:96` |
| "正在交互"信号 | 有 `camera.userDragging`（`src/camera/camera.ts:136`，`src/camera/controllers.ts:496-501` 逐帧同步），但**漏**自动旋转/时间轴 tween/`setPose`；**没有** `forceInteracting`/`movingRender`/`pendingResolve` 任何等价物 | 本轮实测 |
| 排序列节流 | 有闸门（`SORT_MIN_INTERVAL_MS = 800`、`SORT_SETTLE_MS = 200`），但"停手补帧"信号不可靠（只在被闸门挡下过时才置位） | `docs/perf/P0-3-交互期降级-前置侦察.md` 第 4 节 |
| 尺寸剔除 `minPixelSize` | **可用**（两条后端）；引擎默认 2 | 同上第 3 节 |
| SH 波段 | 通路完整（`view.bands` → `material.setDefine('SH_BANDS', min(bands, resource.shBands))`），但切换会 `clearVariants` + 重建 bindGroup | 同上第 1 节 |
| GPU 基数排序 / indirect draw / 紧凑化 | 引擎**都有**，我们**都没用** | 本文件第 1 节 |

## 5. 两条可借鉴路线（代价差一个数量级）

### 路线 A —— 只搬"策略层"（小改动，几百行以内）

把 SuperSplat 的**决策逻辑**照搬，但**不换渲染器**：

1. 自建 `moving` 信号：`camera.userDragging` **或** 相机位姿本帧有变化（比阈值）**或** 自动旋转/tween 在跑；持续 `SETTLE_MS`（建议 150–250 ms）无变化即"停手"。
2. `pendingResolve`：停手时**强制补一帧干净排序**（绕开 800 ms 闸门），补完再恢复正常节流。
3. 接线 GPU profiler（照搬 `scene.ts:283-295` 的写法）：`enabled = 交互中 || 需要采样`；`report` 回调里按 `renderVersion` 归属模式；**只有"非 moving 帧"的 span > 60 ms** 才把降级打开（照搬 `autoEngageMs = 60`）。
4. 降级旋钮（我们的）：SH 波段 3→1/0（**预热门两套变体**）＋ 抬 `minPixelSize`（引擎默认 2 → 4~6）；**运动期间少排/不排**（现在是 800 ms 节流，可做得更狠）。
5. 自适应：把"抬多少"朝 **12 ms GPU 预算**调，照搬阻尼比例步进（`factor` 夹 `[0.85,1.2]`、**限频 50 ms**），并**沿用它的实测边界**：不要贪（上限 1 ≈ −26% GPU / ~2 RMS 是可接受区；上限 8 会砍掉 88% survivor 且误差翻倍）。
6. 风险面已在 `P0-3-交互期降级-前置侦察.md` 第 5/5.1 节列全（`preferences.suspend`、导出弹窗 maxSHBands、设置面板抖动、**`lod.allowProxy` 在拖拽时被禁用与本机制相反**）。
7. **顺手能搬、且上游真在用的两个"便宜旋钮"**（都还在路线 A 范围内）：
   - **运动期降分辨率**：`ss330\src\scene.ts:600-603` 用 `config.camera.pixelScale` 直接**把渲染目标缩小**，再由 final blit 放大（注释原文 "the final blit upscales"）——这是最"无脑"也最有效的填充削减，我们目前没有这个开关；
   - **屏幕外剔除**：`projector:336-342` 用屏幕空间椭圆与 viewport 求交，纯片元/顶点级判断，不需要 compute。

**预期收益**：诚实说，**主要是"卡帧变少/更稳"**（我们当前 20M 合成夹具旋转 p95 21.3 ms 已经接近满帧）；能不能拿到"大幅提升"取决于真实扫描件上到底是 **GPU 瓶颈**还是**排序/上传瓶颈** —— 这正好是第 5 节要先用 GPU 计时量清楚的第一件事。

### 路线 B —— 搬"架构"（大改动，就是本仓库文档里写的 P0-3 正解）

按 SuperSplat 的做法自己写一个 GPU-driven 渲染器：

- compute projector：尺寸剔除 → 贡献剔除 → 遮挡剔除 → 紧凑化（原子追加）→ 写排序键（20 位）；
- 排序：引擎 `ComputeRadixSort`（`indirect: true`），**不用写**；
- indirect draw：引擎 WebGPU 设备已支持；
- 运动期：1 spp stochastic + 站定 resolve（这是"运动时不排序也不出现排序错乱"的关键，需要自家片元着色器配合）。

**上游规模参考**：`projected-splat-renderer.ts` 1198 行 + `src\shaders\projected-splat-*.ts` 约 40 KB WGSL。**可评估"能不能用引擎现成的 unified 管线代替自研"**：unified 管线 64 个文件都在我们引擎里（`unified: true` 即可启用），但它是否允许我们保住**自家顶点/片元着色器、自定义 MRT、每高斯状态位与选择掩码、overlay/pick 语义**，是决定这条路线的唯一关键问题（见第 6 节）。

## 6. 建议：先量清瓶颈，再选路线

1. **第一步（很小）**：把 GPU 计时接进来（第 4 节第 3 条），在**真实扫描件**上量一次"普通排序帧的 GPU span"与"CPU 帧时间"。
   - 若 GPU span 已经 > 60 ms ⇒ 走**路线 B**（上游实测：贡献剔除 −26%、遮挡剔除 −41% 的量级才有意义）。
   - 若 GPU span 不大、卡顿来自**排序/上传**（我们 P0-2 量到的"每次排序完成 80 MB 主线程上传"）⇒ **路线 A 就能治**（运动期不排序 + 站定补一帧）。
2. **第二步**：路线 A 落地并按第 4 节的护栏验证（`verify-*` 双后端 + `perf-probe.cjs` 前后对照）。
3. **第三步（可选）**：把路线 B 拆成"先只做**紧凑化 + indirect draw**（不改着色器语义）"的增量，用 `ComputeRadixSort` 替掉 worker 排序，再逐步加剔除。

## 7. 待确认（已派子代理深挖，结论回来补进本文件）

- **引擎 unified 管线（`unified: true`）能否容纳自定义顶点/片元着色器与 MRT** —— 这是"自己写（照 SuperSplat）"与"打开引擎现成 unified 实现"之间的唯一分叉点。**待引擎差异子代理回报。**
- 2.21.3 → 2.22.1 的**破坏性改动**清单（只有在想顺带升级引擎时才需要）。
