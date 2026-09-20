# 浏览器版 SuperSplat 3.3.0 vs 本机 Electron 版 SplatRoom：2000 万高斯流畅度差异调研

> 目标：解释「SuperSplat 3.3.0 浏览器里操作 2000 万高斯很流畅，本机 Electron 版 SplatRoom（SuperSplat fork）反而不流畅」，
> 并给出**可执行、可复核**的差异清单。
>
> 夹具：`D:\3DGS\训练结果\文物\LFS-文物-真珠舍利宝幢-35\splat_273200.ply` = 20,000,000 点 / 62 列（45 列 SH = SH3）/ 4.73 GB，
> 实测环境：本机 SplatRoom 3.23.5（PlayCanvas **2.21.3** / Electron 43 / WebGPU 模式）。

## 0. 证据等级说明（先读这一节）

| 标记 | 含义 |
| --- | --- |
| 【查证-上游源码】 | 直接从 GitHub **tag `v3.3.0`** 拉取的源文件，行号可复核。文件已缓存到 `D:\DeepSeek\SplatRoomV2\_tmp\ss330\`（只读副本，未改动仓库）。 |
| 【查证-本机源码】 | `D:\DeepSeek\SplatRoomV2\SplatRoomV3-0\src\**` 的实际行号（工作树版本 3.23.5）。 |
| 【查证-引擎源码】 | `SplatRoomV3-0\node_modules\playcanvas\build\playcanvas.mjs`（2.21.3，未压缩 bundle）的实际行号。 |
| 【查证-官方文档】 | playcanvas 官方文档/Release。 |
| 【推算】 | 由上述查证事实 + 仓库内已实测数字做的算术外推，**未实机测量** 20M 这一档。 |

**本轮没有做**：没有运行 20M 端到端导入、没有跑任何探针脚本、没有修改仓库文件、没有 git 操作。
所以第 4 节的量测方案是**待执行**的，第 3 节里的耗时数字凡标【推算】者都需要用第 4 节的探针落地校准。

本机仓库**没有**改动：唯一新增文件是本报告 + `_tmp\ss330\` 下的上游源码缓存。

---

## 1. SuperSplat 3.3.0 的关键性能实现（全部有源码出处）

### 1.0 结论先行：v3.3.0 已经**不用引擎自带的 gsplat 渲染通路**了

v3.3.0 的依赖是 **`playcanvas@2.22.1`**、`@playcanvas/splat-transform@3.4.2`
（`package.json` @ tag v3.3.0，见 <https://github.com/playcanvas/supersplat/releases/tag/v3.3.0>；v3.3.0 发布于 2026-09-14）。

它在 `src/` 下**自带了一整套 GPU-driven 高斯渲染器**（这是 fork 与本机差异的根源）：

| 上游文件（v3.3.0） | 作用 |
| --- | --- |
| `src/projected-splat-renderer.ts`（60.7 KB） | 自研`ProjectedSplatRenderer`：compute 投影 + 紧凑化 + GPU 基数排序 + indirect draw |
| `src/shaders/projected-splat-projector-shader.ts`（22.5 KB） | projector compute：投影、尺寸剔除、contrib 剔除、遮挡剔除、原子追加 |
| `src/shaders/projected-splat-indirect-args-shader.ts` | 把存活计数变成 indirect draw / indirect sort 参数 |
| `src/shaders/projected-splat-depth-reduce-shader.ts` | 深度缓冲 → 分块 max-depth 图（供遮挡剔除） |
| `src/shaders/projected-splat-shader.ts` | 只读「紧凑列表」的顶点/片元着色器 |
| `src/editor-splat-resource.ts`（16.9 KB） | 自研 `GSplatResource` 子类（静态数据不可变） |
| `src/gaussian-instances.ts`（17.5 KB） | 每高斯**编辑实例层**（source/ flags / palette 三个 StorageBuffer，位压缩 + 脏区间上传） |

### 1.1 渲染管线：GPU 投影 + 紧凑化 + indirect draw（不是"每帧画全部 2000 万"）

【查证-上游源码】`projected-splat-renderer.ts`

- `:59` `const INSTANCE_SIZE = 128;`、`:60` `WORKGROUP_SIZE = 256`
- `:174-182` 三个 GPU 缓冲承担全流程：
  - `sortKeys: StorageBuffer`（排序键）
  - `compactEntries: StorageBuffer`（"紧凑槽 → 原始 entry 索引"，**gaussian id 不因紧凑化改变**，所以拾取/rings/dither 仍然有效）
  - `splatCounter: StorageBuffer`（两个 u32：survivor 计数 + 供 centers overlay 用的 size-culled 尾巴）
- `:896` `this.splatCounter.clear();` 每帧清零（记录在共享 command encoder 上，顺序在 dispatch 之前）
- `:898-994` **每个 placement 一个 compute dispatch**：把 `transformA/transformB/splatColor/splatSH_*` 等纹理、`instanceSource/instanceFlags/instancePalette`、相机矩阵一次性灌进 uniform，然后 `device.computeDispatch([compute], ...)`。注意 `:990` 的 dispatch 规模是 `ceil(entryCapacity / 256)` —— **投影的循环体在 GPU 上，CPU 只发命令**。
- `:996-1014` `projectedSplatIndirectArgs` compute 把存活计数转成 indirect 参数；`:1015` `this.meshInstance.setIndirect(null, drawSlot, 1);`
- `:1016` `this.material.setParameter('splatCount', this.splatCounter);`

对比：**每帧 CPU→GPU 的载荷只有几十个 uniform**，没有 per-splat 数据上传，没有 order 数组回传。

### 1.2 排序：**GPU 基数排序**（静止帧）／**交互时完全不排序**（运动帧）

【查证-上游源码】`projected-splat-renderer.ts`

- `:242` `this.sorter = new ComputeRadixSort(this.device, { indirect: true } as any);`（引擎的 GPU 计算基数排序）
- `:63-65` 排序键语义：`sortKeys stores (~depth) >> 12`，`SORT_KEY_BITS = 20` —— 即 20 位键（深度取反，量化为 20 位）
- `:1031` `const sortBits = roundUp(SORT_KEY_BITS, this.sorter.radixBits);`（注释解释：非整数倍会挂死 OneSweep 的 lookback → D3D12 TDR，所以向上取整）
- `:1035-1038` `const sortedIndices = this.sorter.sortIndirect(this.sortKeys, this.capacity, sortBits, sortSlotBase, this.splatCounter, this.compactEntries, true, true);`
  → **排序的元素数量由 `splatCounter`（存活数）在 GPU 上决定**，是 indirect dispatch；排序结果本身就是给顶点着色器读的 buffer。
- `:1018-1022` **关键分支**：
  ```
  if (this.stochastic) {
      // no sort: the draw is opaque and depth tested, so it reads the
      // compact list in the projector's append order.
      this.material.setParameter('sortedIndices', this.compactEntries);
  } else { ... GPU radix sort ... }
  ```
- `:401-405` `setStochastic` 注释原文：*"Switch between the default sorted premultiplied-alpha renderer and the 1 spp stochastic-transparency renderer (opaque, depth-tested, **no per-frame sort**)"*

也就是说：**用户交互（旋转/缩放）时它根本不排序**，靠 1 spp 随机透明 + 深度测试直接画紧凑列表；松手静止后才做一次 GPU 排序的"干净帧"。

引擎侧的对应实现（本机 node_modules 里就有，可直接对照）：
`playcanvas.mjs:38879-38893` `ComputeRadixSort`（OneSweep + multipass 4-bit 两条实现，:37736 / :37874 / :38564）。

### 1.3 运动自适应降级：根据实测 GPU 帧时间自动剔除高斯

这是「2000 万还很流畅」的**直接原因**。

【查证-上游源码】`projected-splat-renderer.ts`

- `:67-77` 运动帧贡献剔除的常量与实测记录：
  ```
  const MOTION_CONTRIBUTION_STEP = 0.05;
  const MOTION_CONTRIBUTION_MAX = 1;
  const MOTION_STEP_MS = 50;
  ```
  注释原文（**可直接引用做量级**）：*"a 3 px splat below alpha 0.14 … A ceiling of 8 culled 88% of the Bowes aerial survivors and doubled the error against the sorted frame; **1 costs ~2 RMS for −26% gpu**"*
- `:209` `motionBudgetMs = 12;`；`:558-580` `reportStochasticFrame(gpuMs)`：每 50 ms 用实测 GPU span 与 12 ms 预算的比值按比例调整 `motionContribution`（超预算 → 提高剔除门槛，有富余 → 向 0 放松）。
- `:968` `compute.setParameter('minContribution', this.stochastic ? this.motionContribution : 0);`
- `:79-84` 遮挡剔除的分块：`const OCCLUSION_BLOCK = 8;`，注释记录实测 *"4 px blocks culled 26% of survivors, 8 px 41%"*。
- `:625-646` `reduceDepth()`：随机帧结束后把深度缓冲降采样成 per-block max-depth；`:887` 下一帧 `occlusion = this.stochastic && this.occlusionCull && this.prevValid && !this.scene.editedRender && (...)`。
- `:1131-1158` `stats` 暴露 `submissionCpuMs / gpuFrameMs / motionContribution / occlusionActive` 等（这就是它自己的量测口）。

【查证-上游源码】`scene.ts`：谁决定当前帧是"运动帧"

- `:105-133` `movingRender` / `overdrawRender` / `editedRender` 的语义注释；`:110` `movingRender = false;`
- `:533` `const interacting = this.forceInteracting || all.size > 0;`
- `:537-553` `view.stochastic` 三态：`'movement'`（只在交互时随机化）/`'enabled'`/`'auto'`（按上一次 sorted 帧的 GPU span 与 `autoEngageMs` 比较），`:552` `this.movingRender = !this.lockedRenderMode && !this.overdrawRender && (stochastic === 'enabled' || (adaptive && interacting));`
- `:564-565` `this.app.graphicsDevice.gpuProfiler.enabled = (profiling || this.autoSampling || this.movingRender) && !this.lockedRenderMode;`（用引擎 timestamp query 实测）
- `:575-583` 运动结束后欠一帧"干净 sorted 帧"（`pendingResolve`）
- `:670-689` `onGpuReport(...)`：运动帧的 GPU span 喂给 `reportStochasticFrame`，sorted 帧的 span 决定 `autoEngaged`

### 1.4 每帧 CPU 开销：几乎为 0（无 per-splat CPU 工作）

- 投影：GPU compute（`:993`）
- 排序：GPU radix（`:1035`）
- draw 参数：GPU（`:1003-1014`）
- 每高斯状态：`gaussian-instances.ts` 的三个 StorageBuffer，**只有编辑时才写脏区间**（见 1.9）
- 每帧 CPU 只做：读事件（`viewBands`、颜色、rings、selection）、填几十个 uniform、发 dispatch。

### 1.5 数据加载 / 压缩 / LOD

【查证-官方文档】<https://developer.playcanvas.com/user-manual/supersplat/streaming/>
（标题 *Streaming & Performance*，原文要点）：

- < 100 万高斯 → 单个 `.sog`；**≥ 100 万高斯 → 用 splat-transform 生成 LOD 链（每级减半）+ 打包成 Streamed SOG**（`lod-meta.json` + 每级 `.sog` chunk）。
- 直接上传 PLY 时会给一个 **Auto generate LODs** 勾选框，≥100 万高斯自动勾上。
- 运行时强制 **Gaussian budget**：桌面 **2M（Performance Mode 开）/ 4M（关）**，移动/XR 1M/2M；随相机移动在 LOD 间升降级以守住预算。
- Streamed SOG 渐进加载："shows the scene as soon as the lowest level of detail is ready"。

【查证-官方文档/Release】v3.3.0 release notes 三条：overdraw heat-map、Safari 下 brush 点选修复、
**"Fix the stochastic motion cull: cap the contribution ceiling at 1 and add a depth-based occlusion cull"**
（<https://github.com/playcanvas/supersplat/releases/tag/v3.3.0>）—— 说明 1.3 的运动剔除正是 3.3.0 周期在打磨的东西。

相关背景链接：
- PlayCanvas 博客 *New in SuperSplat: WebGPU and Streaming Bring Huge Performance Wins* — <https://blog.playcanvas.com/new-in-supersplat-webgpu-and-streaming-bring-huge-performance-wins/>
- engine PR *GSplat: GPU-driven sorting and frustum culling pipeline on WebGPU* — <https://github.com/playcanvas/engine/pull/8453>

⚠️ 本机没有网络复现过浏览器端行为；上述"浏览器里 20M 流畅"的具体形态（是 editor 导入 4.73 GB PLY，还是先把模型转成 Streamed SOG 再打开）**未核实**，
这一点会显著影响"该抄哪一条"（见第 3 节 P0-3 的两种改法）。

### 1.6 官方实测数据：**20M 在 M4 Max 上是 10.22 ms/帧（97.8 fps）**

【查证-官方源码（图表数据）】这条是本报告最有价值的量化锚点。上面那篇 PlayCanvas 博客（2026-06-03）里的性能图是个 React 组件，
**原始数字就在组件源码里**：`playcanvas/blog` → `src/components/GSplatPerfChart/index.jsx`（我本人拉取核对，非转述）。
纵轴单位是**毫秒/帧**（组件内 `toFps = ms => 1000/ms`）：

| 点数 | WebGL2 (ms) | **WebGPU (ms)** | WebGPU 加速比 |
| --- | --- | --- | --- |
| 1M | 7.29 | 7.21 | 1.0× |
| 4M | 8.80 | 6.85 | 1.3× |
| 10M | 20.80 | 8.06 | 2.6× |
| 15M | 34.66 | 9.44 | 3.7× |
| **20M** | **44.93（22.3 fps）** | **10.22（97.8 fps）** | **4.4×** |
| 30M | 64.08 | 11.77 | 5.4× |
| 35M | 75.41（13.3 fps） | 13.20（75.8 fps） | 5.7× |

（桌面设备 Apple M4 Max；移动端另有 1M–4M 数据，WebGPU 12.88–23.60 ms。）

**这条数据对本机问题的意义（关键推论）**：

1. 官方那套新 WebGPU 渲染器在 **20M 上是 10.22 ms/帧**，而**它自己的 WebGL2 路径是 44.93 ms/帧**。
2. 本机的 WebGPU 模式**在架构上等价于官方那一列 WebGL2 路径**——都是 worker CPU 排序 + 每高斯展开成 quad 的光栅化，没有 compute 投影/紧凑化/GPU 排序（见 2.1）。
   所以【推算】本机 WebGPU 在 20M 上的帧时间**应该落在 45 ms 量级或更差**（本机还额外背着 45 列 SH3、4.73 GB 数据规模、以及自定义 WGSL 里的粒子/裁剪盒额外 ALU；**双附件 MRT 不计入差异，上游也有**），
   而不是官方 WebGPU 那一列的 10 ms。**用户体感的"明显卡顿"与 22 fps 这一列完全吻合，而不是"WebGPU 应该很流畅"那一列。**
3. 这同时说明：**"WebGPU 后端"本身不带来加速**，带来 4.4× 的是"把投影/剔除/排序搬到 compute"这套架构。本机切到 WebGPU 只换了后端 API，没换架构。

### 1.7 第二轮上游调研补充（`_tmp\ss-research-notes.md`，1732 行）

> 由并行的上游调研子代理产出（同一 tag v3.3.0，带 `path:line`）。以下是影响结论的部分；**凡与 1.0–1.6 冲突处，以 1.0–1.6 我本人核对过的为准**。

- **v3.0.0 release notes 是官方性能数字的另一处出处**：WebGPU 重写，"The CPU sort worker and WebGL2 path are gone"；
  4.4M 场景**空闲 JS 堆 1,557 MB → 105 MB**；orient 工具点击 **8.5 s → <25 ms**（2.4M 高斯）。→ 与 P1-2/P2-6 的内存方向一致。
- **编辑器里没有任何 `Worker`**（全仓库 `new Worker` 零命中）——解码/上传/排序全在 GPU 或主线程流式做。
- **加载是惰性的**：编辑器消费 `@playcanvas/splat-transform` 的 `ChunkSource`，**4.7 GB PLY 从不整体 materialize**，
  按 4 MB blob 分块顺序扫一遍（`editor-splat-resource.ts`、`file-systems.ts`）；Morton 重排用 `PermutedChunkSource` + **反向置换 scatter** 以保持顺序 I/O。
  → 本机 `load-worker.ts` 虽然把解码搬进了 worker，但仍然**一次性 materialize 全部列缓冲并 transfer**（20M/SH3 时 CPU 侧数 GB）。
- **导入期大模型阈值**：`LOD_MAX_SPLATS = 20_000_000`（`loader.ts:34-45`，严格 `<`），多 LOD 文件默认选"不超过 20M 的最细一级"，全超则取最粗。
- **`view.bands` 不是 uniform 分支而是 shader 变体**（`getVariant`）：切波段 = 换 pipeline ⇒ **必须预热两套 material**（印证 P1-5 的风险提示）。
- **SH 量化**：系数按 11/10/11 bit 对**该行自身 f32 最大值**量化，最大值位存进系数 word 0；SH 纹理**只为文件实际拥有的波段分配**。
- **没有 depth prepass**：splat pass 是 `depthWrite=false + depthTest=true` 的一次绘制；额外的深度 pass 只是 `reduceDepth`（8×8 块取 max，`OCCLUSION_BLOCK=8`）喂**下一帧**的遮挡剔除。→ 回答了你问题清单里"是否 two-pass depth"：**不是**。
- **`auto` 模式的阈值是 `autoEngageMs = 60`**（`scene.ts:134`），可用控制台调小。
- **7 个选择工具全部只在 `pointerup` 触发**（与本机 2.5 的 `rect-selection.ts:77-105` 一致）；brush 的深度回读按 **64 px 分块**合并，避免每采样一次回读。
- **文档里的 2M/4M "Gaussian budget" 属于 Viewer，不属于编辑器** —— 编辑器唯一的阈值是导入期的 `LOD_MAX_SPLATS = 20M`。
  → 这修正了本报告附录 C 第 1 条的疑虑：**不要用 2M/4M 去解释"编辑器里 20M 流畅"**。

### 1.8 选择：GPU compute 产掩码，**没有** CPU 遍历全部高斯

【查证-上游源码】`editor.ts`（v3.3.0）

- `:423-428` `selectionMethod()` 三选一：`useDepth` → `'pick'`（逐像素 id pick，最前层胜出）；否则 `footprint > 0` → `'footprint'`；否则 `'centers'`。
- `:578-608` `select.rect`：三条路**都是 GPU**
  - `'centers'` → `:584` `runSelectIntersect(...)` → `dataProcessor.intersect`（GPU pass + 读回掩码）
  - `'footprint'` → `:588` `runFootprintSelect(splat, op, rectRegion(...), footprint)` → `:438` `scene.projectedSplatRenderer.footprintIntersect(splat, region, footprint)`
    → **对投影后的紧凑列表做椭圆-区域相交**，即 O(存活数) 而不是 O(全部 2000 万)
  - `'pick'` → `:590-596` `camera.pickPrep` + `camera.pickRect(...)`
- `:635-711` `select.byMask`（lasso / polygon / 2D brush）：把画布 alpha 转成 **per-row x-interval 表**（`:467-503` `packRegion` / `rectRegion`），同样走 footprint/intersect/pick 三条 GPU 路；`:505-558` `maskRegion` 只在**掩码画布**上扫一遍（画布尺寸，与点数无关）。
- `:406-417` `runSelectIntersect` / `:435-443` `runFootprintSelect`：GPU pass + 读回都在 `commandQueue` 里排队，保证与 undo/redo 的顺序。
- 读回尺寸小 4 倍：`data-processor/histogram-config.ts:18-20` `maskByteSize = Math.max(4, Math.ceil(count / 4) * 4)` —— **每个 u32 装 4 个高斯的掩码位**，20M → 5 MB 读回。

### 1.9 每高斯编辑状态的存储：**位压缩 StorageBuffer + 脏区间上传**

【查证-上游源码】`gaussian-instances.ts`

- `:48-51`（`splat.ts`）：*"the live edited data: one instance per rendered gaussian, referencing a row of the immutable static resource. all per-gaussian writes go through instances.setBits/clearBits/toggleBits/setTransformIndex, then flush()"* —— 静态高斯数据**不可变**，编辑只改"实例层"。
- `:73-77` `instanceSource`（u32/实例）、`instanceFlags`（**`flagWords`：1 位/实例**）、`instancePalette`
- `:111-112` `new StorageBuffer(device, Math.max(4, numRows * 4), usage)` / `new StorageBuffer(device, Math.max(4, this.flagWords.length * 4), usage)`
  → 20M 实例的 flags = 20M/32 words × 4 B = **2.5 MB**（对比本机 20 MB）
- `:24-25` `class DirtySpan`（"a dirty span of instances awaiting upload. -1 lo means clean"）
- `:412-436` `flush()`：`if (this.flagSpan.dirty) { ... this.instanceFlags.write(firstWord * 4, this.flagWords, firstWord, lastWord - firstWord); }`
  → **只上传脏区间**（GPU buffer sub-write），不是整块上传
- `:394-408` `recount()` 只在 `countsDirty` 时跑，平时计数增量维护（`setBits` 等 mutator 维护）

---

## 2. 本机仓库（SplatRoom 3.23.5）对应实现

### 2.1 渲染通路：**仍然是引擎的 legacy `GSplatInstance` + CPU worker 排序**（两个后端都是）

【查证-本机源码】`src/core/render-diagnostics.ts:51-92`
诊断代码断言 `entity.gsplat.instance`、`instance.sorter`、`instance.orderTexture`、`instancingCount`、`pendingSorted.count` 都存在，
并在 `:65` 明确写下 *"the WebGPU backend keeps the sort order in a storage buffer of one u32 per splat"* → WebGPU 用的是 `GSplatInstance.orderBuffer`。

【查证-本机源码】全仓库 grep `gsplatPlacements|scene\.gsplat|GSPLAT_RENDERER|placements` → **No matches found**。
即本机**从未触碰**引擎里那套"新" gsplat 通路（`GSplatManager` / `GSplatPlacement` / `GSplatHybridRenderer`）。

【查证-引擎源码】`playcanvas.mjs`
- `:41242-41343` `GSplatSorter`（worker 排序）；`:41306-41313` `applyPendingSorted()` → `uploadStream.upload(...)`
- `:41253-41269` worker 回调：`this.worker.postMessage({ order: oldOrder }, [oldOrder]);` + `pendingSorted = { count, data: new Uint32Array(newOrder) }`
- `:11983-12059` WebGPU 上传实现 `uploadStaging`：`new Uint8Array(mappedRange).set(new Uint8Array(data2.buffer, ...))` + `copyBufferToBuffer`
- `:41003-41240` `SortWorker`：**CPU 分桶基数排序**（`numBins = 32` 预分桶 + `bucketCount = 2**compareBits+1`，`compareBits = clamp(10,20,log2(n/4))`），全量 O(n) 多趟
- `:40583-40585` `instanceSize = 128`；`:40548-40581` 每个实例 128 个 splat 的 mesh（4 顶点 + 6 索引/ splat）→ **每个高斯 6 次顶点着色**
- `:35222-35230` 引擎默认 `GSPLAT_RENDERER_AUTO` 在 WebGPU 上解析为 `GSPLAT_RENDERER_RASTER_GPU_SORT`
- `:87233-87235` `GSplatHybridRenderer.usesGpuSort → true`；`:88323-88325` `_createRenderer` 选择 hybrid/quad
- `:38879-38893` `ComputeRadixSort`

> ⚠️ 引擎里那套 GPU-sort 通路（`GSplatHybridRenderer`）挂在 `GSplatManager` 上，而 `GSplatManager` 只对 `layer.gsplatPlacements`（`:30868` `addGSplatPlacement`，`:88534` `hasNormalPlacements`）生效——也就是新的 placement/streaming API。
> 本机没有用这套 API，所以引擎默认值对本机不生效。**这是"本机 WebGPU 模式依然 CPU 排序"的机制原因。**

### 2.2 排序：**每帧**强制派发全量 worker 排序

【查证-本机源码】`src/splat/splat.ts:695-803`（`Splat.onPreRender`）

- `:761-767` 每帧算相机在 splat 局部空间的 pos/dir
- `:774-775` 触发阈值：`dx*dx+... > 1e-12 || ddx*ddx+... > 1e-12`（注释 `:754-760` 说明：**刻意去掉了 3 帧节流**，"Throttle-free ensures every perceptible camera movement gets a fresh sort"）
- `:787-800` 绕过引擎 `sorter.setCamera`，直接 `ws.worker.postMessage({cameraPosition, cameraDirection, forceUpdate: true})`，靠 `ws._sortInFlight` / `ws._pendingCamera` 合并最多 1 个 pending
- `:738-746` 注释解释动机：引擎 `GSplatInstance.sort()` 的 `equalsApprox(...,1e-3)` 在慢速旋转下丢帧 → 顺序陈旧（"近小远大"）

【查证-本机源码】`src/scene/scene.ts:701-724`：合并实体（group）在 `onPreRender` 里做同一件事（epsilon `1e-12` + `forceUpdate: true`）。

【查证-本机源码】`src/app/render.ts:1487-1507`（导出/转台路径）：注释里记录了**实测数字**——
*"turntable runs every frame for 14M-point models where a single sort takes ~300 ms"*，并已改成 `SORT_INTERVAL = Math.max(2, Math.ceil(exportSplatCount / 1e6))`。
→ **交互路径没有这个自适应间隔，只有导出路径有。**

【查证-本机源码】`src/camera/camera-preview.ts:151-165` `_pipInterval()` 已有现成范式：`Math.max(PIP_FRAME_INTERVAL, Math.min(40, Math.ceil(maxN / 1000000)))`。

### 2.3 每帧 CPU 侧：基本没有 O(n)，但有固定的分配/参数churn

- `src/scene/scene.ts:526-586` `onUpdate`：`:533` 每帧 fire 'update'、`:536` 元素 onUpdate、`:540-549` 每帧 `state.pack` 全部元素 + `state.compare` + `:549` `new Set([...added, ...removed, ...moved, ...changed])`（每帧 4 个数组 + 1 个 Set）
- `src/splat/splat.ts:674-685` `serialize()`：每帧 `Array.from(this._hslHue/_hslSat/_hslLum)`（3 个 8 元素数组）
- `src/splat/splat.ts:815-817` + `src/splat/gpu-camera-uniforms.ts:52-56`：WebGPU 每帧 5 次 `material.setParameter`（每次传 `mat4.data` 数组）
- `src/splat/splat.ts:820-922`：每帧 ~40 次 `material.setParameter`，其中大量**新建数组**（`[selectedClr.r, selectedClr.g, selectedClr.b, selectedClr.a*alpha]`、`[offset,offset,offset]`、`[1,1,1,1]` …）
- `src/scene/scene.ts:595-621` `updateLodSwitching()`：每帧遍历 splats（小规模），但 `src/scene/scene.ts:604-607` 明确在编辑态把代理 LOD **强制关掉**（`if (!allow) { if (s.lodLevel !== -1) void s.applyLod(-1); }`）

结论：**"每帧都发生的 O(n) 主线程工作"在本机基本不存在**（这点对本机有利）。
每帧真正的成本在 GPU：`GSplatInstance` 的 legacy quad 通路画**全部 2000 万高斯**、
每个高斯 6 次顶点着色、SH3 求值，且没有任何 per-splat 可见性剔除/紧凑化（**MRT 双附件不算差异项，上游也有**，见 2.4 的更正）。

### 2.4 每帧的 GPU 通路

【查证-本机源码】`src/camera/camera.ts`
- `:757-765` splat pass 用 **MRT：RT0 = RGBA16F 颜色 + RT1 = RGBA8 overlay**（`:744-746` 纹理创建）
- `:797-799` `splatPass` 只挂 splatLayer；`:814` `framePasses = [clearPass, mainPass, splatPass, gizmoPass, finalPass]`
- `:749-754` mainTarget 与 splatTarget 共享 colorBuffer/depthBuffer

⚠️ **更正（第二轮调研后）**：双附件 MRT **不是本机独有的劣势** —— SuperSplat 3.3.0 同样是 2 个 MRT 附件，
第二个附件专门承载"选中 80/20 拆分"给 Underlay pass 用（`projected-splat-renderer.ts:252` `fragmentOutputTypes: ['vec4','vec4']`、`:308-317`）。
所以**不要把 MRT 当成本机的性能差异项**（对本机与上游是同等成本）。

【查证-本机源码】`src/shaders/splat-shader-wgsl.ts`（WebGPU 用的自定义 WGSL 顶点/片元）
- `:37-39` 注释：mirror `vertexShader`，读 per-splat 编辑状态 → 施加粒子效果 → 引擎的 center/corner 投影 → 打包 varying
- `:218-224` `initCorner(&source, &center, &corner)` + `center.proj + vec4f(corner.offset.xyz, 0.0)`（每个顶点重新展开）
- `:321` `// evaluate spherical harmonics`（WebGPU 路径也在顶点阶段算 SH）
→ 相比上游通路（compute 里**每个高斯只投影一次**，结果压进 8 B 的屏幕空间缓存），本机是**每个高斯 6 次**，每次都要重读未压缩的 per-splat 数据。

**本机 vs 上游真正的 GPU 侧差异（按重要性）**：

| 维度 | 本机 | SuperSplat 3.3.0 |
| --- | --- | --- |
| 每高斯投影次数 | **6 次**（每顶点一次，读 `transformA/transformB/splatColor/SH` 纹理） | **1 次**（compute 投影），结果压进 **8 B/高斯**：cacheA `RGBA32U`（中心 NDC + 深度 + RGB 10/10/10 + 2 bit 共享指数 + 长半轴）+ cacheB `R32U`（短半轴 + 不透明度 + 选中位 + 锁定位） |
| 可见性剔除 | **无**（按 `instancingCount = ceil(存活数/128)` 画全量，无 per-splat 剔除） | 4 层：视锥 AABB、尺寸、贡献（运动帧自适应）、上一帧深度遮挡；且 **SH/调色在全部剔除之后才跑** |
| 紧凑化 | 无 | `atomicAdd` 追加存活者到 `compactEntries`，indirect draw 只画存活者 |
| 运动帧 | 照常全量画 + 每帧派发排序 | 免排序的 1 spp 随机透明 + 自适应贡献剔除 |
| SH 波段 | `Math.min(viewBands, shBands)`，默认 3（`scene-config.ts:28`） | 同样 `Math.min(...)`，但只为文件实际拥有的波段分配纹理，系数按 11/10/11 bit 量化；**波段是 shader 变体**（换 pipeline，非 uniform 分支） |
| 源数据驻留 | CPU 侧一次性 materialize 全部列（20M/SH3 数 GB）后上传 | 惰性 `ChunkSource` 分块，**4.7 GB 从不整体 materialize** |
| 深度结构 | 单次绘制 + 深度测试（无 prepass） | 同样无 prepass：`depthWrite=false + depthTest=true` 一次绘制，外加一个 8×8 块 max-depth 的 `reduceDepth` compute 喂**下一帧**的遮挡剔除 |

### 2.5 选择：rect/lasso/polygon/2D-brush 走**主线程 JS 全量投影**（fork 自有改动，非上游行为）

【查证-本机源码】`src/app/editor.ts`
- `:1356-1369` `events.function('select.rect', ...)` → **`runRangeSelection(...)`**
- `:942-951` 注释原文：*"There is no id pick, no footprint widening and no depth-pass readback any more: the whole test is splat/selection-range.ts, **one projection loop per gesture**."*
- `:1094-1236` `runRangeSelection`：
  - `:1127` `tailFractions(...)`（子采样直方图，与点数弱相关）
  - `:1143-1148` `const preMask = new Uint8Array(numSplats);` + 20M 次循环
  - `:1153-1155` `createRangeCache(numSplats, ...)` + `hit` + `managed`（各 20M 字节）
  - `:1156` `selectRange(splat, region, view, cache, hit, managed)` ← **主线程全量投影**
  - `:1168-1193` 环模式：`camera.pickPrep` + `await camera.pickRect(...)`，再 `new Set<number>()` + 20M 循环（`:1177-1192`）
  - `:1195-1197` 又一个 20M 循环（managed）
  - `:1198` `IndexRanges.fromPredicate(numSplats, i => preMask[i] !== 0)`（闭包 + `number[]`）
  - `:1220-1226` `deferBounds` / `editHistory.add` / `armBoundSettle`
- `:813-828` `select.bySphere` / `select.byBox` → `runSelectIntersect` → `dataProcessor.intersect`（**这两条仍是 GPU**）

【查证-本机源码】`src/splat/selection-range.ts`
- `:393-500` `selectRange`：`:432-492` 单层 `for (let i = 0; i < numSplats; i++)`，每点做 local→world（12 乘加）、视轴点积、clip→NDC→像素（除法 ×2）、窗口/形状比较；`:464-472` 顺手写 `cache.sx/sy/dist`（`sx.fill(-1)` 也要 20M 次）
- `:283-301` `RangeProjectionCache`：`Int16Array sx + Int16Array sy + Uint16Array dist` = **6 B/点**
- `:309-311` `CACHE_BYTES_PER_SPLAT = 6`、`CACHE_MAX_BYTES = 192MB` → 上限 **3200 万点**（20M 夹具**在**预算内 ⇒ 每次手势都会分配 120 MB 缓存）
- `:507-529` `selectRangeFromCache`：滑块推杆用的"只比较不投影"版本（仍是 20M 次主线程循环）

【查证-本机源码】`src/tools/rect-selection.ts:77-105`：框选只在 **pointerup** 触发（pointermove `:54-65` 只更新 SVG 矩形）
→ **拖拽过程不卡，松手瞬间卡**（这与"框选有明显卡顿"的体感一致：一次性 1.5–2 s 冻结）。

### 2.6 每高斯状态：1 字节/点 + **整块上传** + 全表 recount

【查证-本机源码】`src/splat/splat-state.ts`
- `:29` `readonly data: Uint8Array;`（**1 B/点**，20M → 20 MB），`:30` `private readonly gpu: Texture;`
- `:65-111` `setBits/clearBits/toggleBits`：`ranges.forEachRun((start,end) => { for (let i=start;i<end;i++) data[i] |= mask; })`
- `:127-196` `applySelectionMask` / `writeSelectionMask`：`:148-192` 单层 `for (let i = 0; i < n; i++)` 全表（`managed[i]===0` 就 continue，但仍是 20M 次访存）
- `:201-220` `recount()`：全表 20M 次
- `:224-241` `flush()`：`const buffer = this.gpu.lock(); buffer.set(this.data); this.gpu.unlock();` —— **整块 20 MB 上传**（`:226-229` 注释自认"sub-rect upload is a worthwhile future optimisation … requires engine-side support"），`countsExact` 为假时再跑一次全表 `recount()`

对比上游（1.9）：flags 是 **1 位/实例（20M → 2.5 MB）** + `instanceFlags.write(脏区间)`。

### 2.7 其它相关实现

- 【查证-本机源码】`src/data-processor/calc-bound.ts:190-226`：`await waitForGpuDrain()` + **4 次 `immediate: true` 同步读回**（`selectedMin/Max`、`visibleMin/Max`）。`src/data-processor/gpu-readback.ts:26-33`：`waitForGpuDrain` = `Promise.race([rAF, 500ms])` → **每次包围盒重算至少让出一整帧**。
  → 已被 `splat.ts:552-561` 的 `_boundsDeferred` + `editor.ts:1244-1343` 的 120 ms settle 合并（O1 优化**已落地**），只剩手势结束/删除/transform 时付费（`splats-transform-handler.ts:165-172` 已节流到 30 Hz）。
- 【查证-本机源码】`src/data-processor/intersect.ts:303-322`：GPU 相交 pass → `await waitForGpuDrain()` → `immediate: true` 同步读回（20M → 20 MB；仓库实测 picker 8.3 MB ≈ 76 ms ⇒【推算】20 MB ≈ 180 ms + 一帧）。
- 【查证-本机源码】`src/splat/splat-overlay.ts`（centers overlay）
  - `:65-73` WebGPU 下 `GSPLAT_QUAD_SPRITES` → **每个中心 6 个顶点**（`:187` `count * (this.quadSprites ? 6 : 1)`）→ 20M 时 **1.2 亿顶点**
  - `:150-183` `gpuOrderTexture`：需要一张 **4 B/点 = 80 MB** 的 identity 顺序纹理（注释记录实测 *"mirroring the real sorted order cost a ~20 MB upload per sort (measured: 180 MB/s while orbiting a 5M splat model)"*）
  - `:293` `onUpdate()`；`:302-350` `onPreRender()`
  - `:355-360` `get enabled()` 只在 `camera.mode === 'centers'` 时启用（默认模式不是 centers，所以平时不付这个钱）
- 【查证-本机源码】`src/io/load-worker-client.ts` + `src/workers/load-worker.ts`：**load worker 已接进导入路径**（`src/app/asset-loader.ts:73` `await loadGSplatDataAsync(filename, fileSystem, skipReorder || animationFrame, ...)`），解码 + morton 重排在 worker 里。
  → 但【查证-本机源码】导入后没有 SOG/LOD/streaming 路径可走：`src/lod/*` 只服务已有 LOD 的文件，且编辑态会强制退出代理级（`scene.ts:604-607`）。
- 【查证-本机源码】`src/scene/scene-config.ts:28` `shBands: 3` → **默认 SH3**（20M × 45 系数），`splat.ts:189` `material.setDefine('SH_BANDS', Math.min(bands, resource.shBands))`；没有任何"大模型自动降波段"逻辑。
- 【查证-本机源码】`src/splat/splat.ts:945-990` `focalPoint()`：**未采样**的全量 20M 循环（`exp` ×2/点），`:992-1062` `denseRadius()` 有两个采样循环。`camera.ts:951-972` 的 `focus()` 会调 `focalPoint()` → **一次 focus 就是 20M 次 `Math.exp`**（【推算】200–500 ms）。

---

## 3. 差异清单（按"对 2000 万点交互流畅度的贡献"排序）

格式：`[优先级] 现象 → 本机实现（文件:行号）→ SuperSplat 做法（出处）→ 具体改法 → 预期收益量级 → 验证方法`

### P0（决定"能不能用"，先做这三条）

**P0-1｜框选/套索/多边形/2D 笔刷：松手瞬间主线程冻结 1.5–2 s**
→ 本机：`src/app/editor.ts:1356-1369`（`select.rect` → `runRangeSelection`）+ `src/app/editor.ts:1094-1236`（preMask / cache / selectRange / managed / fromPredicate 共 ~6 趟 20M 主线程循环）+ `src/splat/selection-range.ts:432-492`（每点 12 乘加 + 2 次除法 + 6 B 缓存写入）；`:942-951` 注释自述"one projection loop per gesture"
→ SuperSplat：`editor.ts:578-608` 三条路全在 GPU（`runSelectIntersect` / `runFootprintSelect` → `projectedSplatRenderer.footprintIntersect` 对**紧凑列表**求交 / `camera.pickRect`），掩码读回还 4:1 位压缩（`data-processor/histogram-config.ts:18-20`）
→ 改法（二选一，推荐 B）：
  **A.** 把 `selectRange` 的投影搬到已有 GPU 通路：复用 `src/data-processor/intersect.ts` 的框架，写一个"投影+窗口/深度测试"的片元着色器，输出 R8 掩码（4:1 打包读回）；保留 CPU 版作为 WebGL2 回退。
  **B.（更省事，先落地）** 把手势那一次全量投影**挪出主线程**：`selection-range.ts` 的循环是纯数组计算，可整段放进 Web Worker（数据用 `SharedArrayBuffer` 或 transfer 一次 `x/y/z` 的副本），主线程只等结果；同时把 `preMask`/`managed` 合并成一趟、`IndexRanges.fromPredicate` 换成"直接产 `Uint32Array` 区间"（`selection-range.ts:1198` 的闭包 + `number[]` 是纯开销）。
  另：`createRangeCache` 的 `sx.fill(-1)`（`:318`）在 20M 上是 40 MB 的白写，可改成用 NaN 哨兵或延迟填充。
→ 预期收益：【推算】20M 单次手势 1.6–2.2 s（按仓库 13M 实测 840–1016 ms 线性外推）→ A 方案到 60–150 ms（GPU pass + 5 MB 读回），B 方案到 150–400 ms（worker + 主线程只剩掩码写入/上传）；**并且拖拽期间的帧率完全不再受影响**。
→ 验证方法：用 `docs/probes/push-perf.cjs` 的形态量 `select.rect` 端到端；改造前后对比 `performance.now()` 在 `runRangeSelection` 前后的差。阈值：**20M 上一次框选（含 settled bound 补算）≤ 300 ms 才算达标**；`selectRange` 单趟 ≤ 80 ms。

**P0-2｜旋转/缩放的深度顺序滞后 ~0.5 s + worker 100% 饱和 + 每 ~0.5 s 主线程 80 MB memcpy**
→ 本机：`src/splat/splat.ts:774-802`（epsilon `1e-12`、`forceUpdate: true`，**每帧**派发全量排序）、`:754-760`（注释自述刻意取消节流）、`src/scene/scene.ts:701-724`（合并实体同款）；引擎侧 `playcanvas.mjs:41003-41240`（worker 分桶基数排序，全量多趟）、`:41253-41269`（回传 order）、`:41306-41313` + `:11983-12059`（**`uploadStaging` 在主线程做 80 MB `Uint8Array.set` + 80 MB `copyBufferToBuffer`**）；`src/app/render.ts:1487-1507` 已记录 13M 单次排序 ≈300 ms
→ SuperSplat：`projected-splat-renderer.ts:1018-1039` —— **交互帧完全不排序**（`:401-405` 注释 "no per-frame sort"），静止帧用 GPU `ComputeRadixSort`（`:163`/`:242`/`:1035`）对**存活紧凑列表**做 indirect 排序；CPU 每帧只灌 uniform（`:915-993`）。
→ 改法：三步，按风险递增
  1. **交互态直接停发 CPU 排序**：把 `splat.ts:774` 的阈值从 `1e-12` 改成"相机角度变化 > 0.25° 或距离变化 > 0.5%" **并且** 按 `max(6, ceil(n/1e6))` 帧节流（沿用 `camera-preview.ts:151-165` 的既有公式、`render.ts:1506` 的既有写法）；松手后再补一次强制排序（等同上游的 `pendingResolve` 干净帧，`scene.ts:575-583`）。
  2. 排序结果**延迟一帧使用**：不要在排序回调里同步上传；把 `applyPendingSorted` 的时机挪到帧末（或至少确认 `_sortInFlight` 期间不派发）。
  3. **中期正解**：走 GPU 排序。要么迁移到引擎的 `GSplatManager`/placement 通路（工作量大，且会与 fork 的自定义 shader/MRT 冲突），要么**自研一个精简版**：把 `sortKeys`（`(~depth)>>12`，20 位）+ `ComputeRadixSort`（引擎已导出，见 `playcanvas.mjs:38879`、`:115959` 的导出列表）+ indirect draw 接到现有 `splatOrder` StorageBuffer 上，替换 `GSplatSorter`。
→ 预期收益：第 1 步立刻把 worker 从"永远在排序"降到 ~15% 占用，并把主线程每 ~0.5 s 的 8–16 ms【推算】stall 降到 0；顺序刷新率不会变差（20M 下本来就 ~2 Hz），交互帧的"跳序/抖动"感显著减轻。第 3 步才能把顺序延迟从 ~460 ms 降到 <1 帧。
→ 验证方法：探针里挂 `scene.events.on('gsplat:sorted', t => ...)`（引擎在 `playcanvas.mjs:41257` 会 fire）记录 `sortTime` 与间隔；用 `performance.now()` 包 `UploadStream.upload`（可临时 monkey-patch `instance.sorter.uploadStream.impl.upload`）。阈值：**交互帧的 `sortTime` 间隔 ≥ 250 ms 且主线程单帧 > 30 ms 的帧占比 < 1%**。

**P0-3｜交互时没有任何降级：20M 全量绘制（每高斯 6 次顶点着色 + SH3 + 零 per-splat 剔除）**
（官方实测锚点：同样的 20M，官方新 WebGPU 渲染器 **10.22 ms/帧**，官方旧 WebGL2 路径 **44.93 ms/帧**；本机架构等价于后者 ⇒ 目标是把 45 ms 量级打到 10–15 ms 量级）
→ 本机：`src/camera/camera.ts:757-765`（MRT 双附件）、`:797-814`（splatPass 全量）、`playcanvas.mjs:40583-40585`（`instanceSize = 128`）+ `:40548-40581`（每高斯 4 顶点/6 索引 ⇒ **6 次 VS/高斯**）、`src/shaders/splat-shader-wgsl.ts:218-224`/`:321`（每顶点重算 corner + SH）、`src/scene/scene-config.ts:28`（默认 SH3）、`src/scene/scene.ts:604-607`（编辑态强制禁用代理 LOD）
→ SuperSplat：
  - 运动帧：`projected-splat-renderer.ts:67-77` 贡献剔除（**实测 −26% GPU**）、`:79-84` 遮挡剔除（**实测 −26%~−41% survivors**）、`:968`/`:987-988` 传入 projector；`:209` `motionBudgetMs = 12` 自适应
  - 静止帧：GPU 投影 + 紧凑化 + indirect draw（`:896`/`:998-1015`）⇒ 只画存活高斯，且**每个高斯只投影一次**
  - 文档级兜底：运行时 Gaussian budget 桌面 2M/4M（<https://developer.playcanvas.com/user-manual/supersplat/streaming/>）
→ 改法：
  1. **最便宜**：加"运动降级"开关 —— 相机运动期间把 `view.bands` 降到 1 或 0（`splat.ts:189` 已有 `material.setDefine('SH_BANDS', ...)` 通路，切 band 会重编译 material，需要预热两套 material 或接受一次编译停顿），并把 `minPixelSize`/`alphaClipForward` 提高（引擎 `GSplatInstance.configureMaterial` 已设 `alphaClipForward = 1/255`，可提到 1/32）。同一思路可加"运动时降到 N 个点"的抽稀（可用 `sorter.setMapping` 传稀疏 mapping，`playcanvas.mjs:41315-41336` 已有该接口）。
  2. **正解**：实现自己的 compute projector + compact list（照 `projected-splat-projector-shader.ts` 的尺寸剔除/贡献剔除部分，不必照抄遮挡剔除），把现有 WGSL 顶点着色器改成"读 `sortedIndices[instanceSplatId]` 的紧凑槽"——注意本机 `splat-overlay.ts:148-151` 的注释已经证明团队理解"WebGPU 没有 order texture，用 storage buffer 索引"这件事。
→ 预期收益：【推算】旋转/缩放帧的 GPU 时间下降 30–60%（贡献剔除 −26% + 遮挡 −26~41%），且顶点着色减少 6×（若做紧凑化 + per-splat 投影）；配合 SH 降波段再降一大截。
→ 验证方法：用 `docs/probes/perf-probe.cjs` 的"旋转 N 秒测 rAF 间隔"形态，记录 p50/p95/最大帧；同时读 `scene.app.graphicsDevice.gpuProfiler`（若可用）或 `render-diagnostics` 的统计。阈值：**20M 旋转时 p95 帧 ≤ 33 ms（30 fps）**，改前预估 p95 ≈ 100–200 ms。

### P1（显著，但单条不足以解释"不流畅"）

**P1-1｜每次选择变更 = 20 MB 整块上传 + 全表 recount**
→ 本机：`src/splat/splat-state.ts:29`（1 B/点）、`:224-241`（`buffer.set(this.data)` 全量 + `recount()` 全量）、`:201-220`
→ SuperSplat：`gaussian-instances.ts:73-77`（flags = **1 位/实例**）、`:412-436`（`instanceFlags.write(firstWord*4, ...)` **只写脏区间**）、`:394-408`（countsDirty 才 recount）
→ 改法：① 状态位改成位压缩（20M → 2.5 MB，32× 小）；② `flush()` 改成分块/脏区间上传（引擎 `Texture.lock/unlock` 每次是全量，可用 `device.setTexture`/子矩形上传或改用 StorageBuffer + `write(offset,...)`，参考 `gaussian-instances.ts:423`）；③ `recount()` 改增量（`selection-range.ts` 那趟已经在维护 `numSelected`，扩展成三桶）。
→ 预期收益：【推算】每次推杆/选择变更的主线程 + 上传成本降 60–80%（13M 上 §O2/O4 的实测口径是 506→200 ms 量级的一部分；20M 上每次变更省 ~25–40 ms + 20 MB 带宽）。
→ 验证方法：探针里直接量 `splat.state.flush()`（monkey-patch 计时）与 `splat.state.data.length`；阈值：**单次 flush ≤ 5 ms 且上传字节 ≤ 4 MB**。

**P1-2｜一次手势的瞬时内存 300–400 MB（GC 抖动源）**
→ 本机：`src/app/editor.ts:1143-1155`（preMask/hit/managed 各 20 MB + cache 120 MB）、`:1177-1192`（ringPick 复用 hit）、`:1198`（`IndexRanges.fromPredicate` 的闭包 + `number[]`，最坏 ~160 MB）、`src/splat/selection-range.ts:309-311`（6 B/点预算 = 20M 时 120 MB）
→ SuperSplat：掩码在 GPU 侧生成、读回 4:1 打包（`histogram-config.ts:18-20`），`GaussianInstances` 用三个紧凑 buffer，**不产生 O(n) 的 JS 数组**
→ 改法：先把 `IndexRanges.fromPredicate` 换成"直接产 `Uint32Array` 区间"（仓库审计 §O3 已论证这是零风险改动），再把 `preMask` 用 `Uint8Array` 位图代替（或直接从 `SplatState.data` 读 `selected & ~locked`），`managed` 可并入 `hit` 的高位。
→ 预期收益：【推算】单次手势峰值驻留从 ~340 MB 降到 ~160 MB（仅 cache），GC 停顿（每次手势一次 major GC，10–40 ms）消失。
→ 验证方法：探针里 `performance.measureUserAgentSpecificMemory()`（或 `performance.memory.usedJSHeapSize` 前后差），阈值：**单次手势 delta ≤ 180 MB**。

**P1-3｜包围盒重算 = 让一整帧 + 4 次同步读回**
→ 本机：`src/data-processor/calc-bound.ts:190-226`、`src/data-processor/gpu-readback.ts:26-33`；已在 `splat.ts:552-561` / `editor.ts:1244-1343` 做 defer 合并
→ SuperSplat：不重算包围盒（`:886-888` 只在遮挡剔除里判断 `editedRender`），选择结果不触发 GPU 回读；掩码回读是**唯一**的回读点，且异步排队（`editor.ts:406-417`）
→ 改法：把 `calc-bound` 的 4 次 `immediate: true` 改成"上一帧结果"（异步 read + 双缓冲），失败时沿用旧值；把 settle 时的 `waitForGpuDrain`（整帧让步）去掉，改成在 `onPostRender` 里发起、下一帧收结果。
→ 预期收益：【推算】settle 时的 1 帧 + 5–25 ms 变成 0 帧感知；小模型档收益更明显（仓库审计：2k 点上一次推杆 99.9% 是这一步）。
→ 验证方法：`docs/probes/o1-bound-probe.cjs` 已有口径；阈值：**`refreshDeferredBounds()` 墙钟时间 ≤ 5 ms（不含 GPU 等待）且不产生额外 rAF 丢失**。

**P1-4｜centers overlay 在 WebGPU 上爆炸（6 顶点/高斯 + 80 MB identity 顺序纹理）**
→ 本机：`src/splat/splat-overlay.ts:65-73`、`:187`、`:150-183`
→ SuperSplat：centers 是"紧凑列表的第二次 indirect draw"（`projected-splat-renderer.ts:168-172` 注释：*"a second draw of the same quad mesh over the compact list - survivors plus the size-culled tail"*），且 `:1000`/`:1010`（`getArgsCompute` 里 `drawSlot + 1` = `centersDrawSlot`，两个 slot 连号）用同一套 indirect 参数
→ 改法：短期加"20M 以上自动禁用 centers overlay 或降到 1/64 抽稀"的守卫（`splat-overlay.ts:355-360` 的 `enabled` getter 是天然开关）；中期改成对 `splatOrder` StorageBuffer 做 indirect draw，删掉 80 MB 的 identity 纹理。
→ 预期收益：20M 下开 centers 从不(draw 1.2 亿顶点)变成可用；仅禁用即可避免这一档的最坏情况。
→ 验证方法：`docs/probes/perf-probe.cjs` 已有"centers mode on/off"三段口径；阈值：**20M + centers on 的 p95 帧 ≤ 2× splats 模式的 p95**。

**P1-5｜默认 SH3 + 无自动降波段**
→ 本机：`src/scene/scene-config.ts:28`、`src/splat/splat.ts:189`
→ SuperSplat：`projected-splat-renderer.ts:902` `const bands = Math.min(viewBands, resource.shBands);`（同样用 viewBands），但投影/剔除在低 band 变体下更便宜 + 运动帧本来就不画干净图
→ 改法：n ≥ 800 万时默认 `view.bands = 1`（并在设置面板提示"大模型默认降波段，可手动提高"）；`rebuildMaterial` 走 `view.setBands` 已有通路（`editor.ts:2292`/`:2311`）。
→ 预期收益：【推算】顶点着色里 SH 求值占大头（每高斯 15 系数 × 3 通道），降到 band1 约省 60% 的 SH ALU + 少读 3 张纹理。
→ 验证方法：perf-probe 里切 `view.setBands`，对比 p50/p95 帧；阈值：**band3→band1 的 p95 改善 ≥ 20%**（否则说明瓶颈不在 VS）。

### P2（清理项，单条收益 < 5%，但合起来影响帧稳定性）

- **P2-1｜每帧数十次 `setParameter` 且大量新建数组**
  → 本机：`src/splat/splat.ts:820-922`（~40 次）、`src/splat/gpu-camera-uniforms.ts:52-56`（5 次）、`src/splat/splat-overlay.ts:315-347`（改动前为 309-341）
  → SuperSplat：`projected-splat-renderer.ts:915-993` 也是每帧灌 uniform，但用 `setParameter(name, StorageBuffer/texture)` 为主，颜色类用 `subarray` 复用（`:954-956`）
  → 改法：把每帧不变的参数（`transformPalette`、crop-box 关掉时的默认值 `[0,0,0]`/`[1,1,1,1]` 等）移出每帧路径，只在变更时写一次；复用 scratch 数组。
  → 预期收益：每帧省 ~20–50 µs + 一批小对象分配（GC 压力）。
  → 验证方法：DevTools Performance 里看 `setParameter` 的 self time；阈值：**onPreRender 自耗时 ≤ 300 µs/元素**。
- **P2-2｜每帧 state diff 的 4 数组 + 1 Set**
  → 本机：`src/scene/scene.ts:540-549`；上游同样有（`ss330\scene.ts:520-523`）→ **这是继承来的，非 fork 引入**，优先级低。
  → 改法：`ElementTypeList.forEach` 前先判断 `result.*.length`，全空时跳过 `new Set`。
  → 预期收益：每帧 ~5–15 µs。
  → 验证方法：Performance 面板看 GC minor 频率。
- **P2-3｜`Splat.serialize()` 每帧 3 次 `Array.from`**
  → 本机：`src/splat/splat.ts:682-684`；改法：改 `serializer.packa` 接受 `Float32Array`/数组直接遍历。
  → 预期收益：每帧 ~3 µs/元素（可忽略，但属零风险清理）。
- **P2-4｜`focalPoint()` / `denseRadius()` 全量 `Math.exp`**
  → 本机：`src/splat/splat.ts:945-990`（**无采样**）、`:992-1062`（有采样）；触发点 `src/camera/camera.ts:955-972`
  → 改法：`focalPoint` 也加 stride 采样（与 `denseRadius` 一致，n > 500k 时 stride = ceil(n/200000)）。
  → 预期收益：【推算】20M 一次 focus 从 ~300 ms 降到 ~15 ms。
  → 验证方法：探针里 `performance.now()` 包 `splat.focalPoint()`；阈值：**≤ 30 ms**。
- **P2-5｜环模式（rings）的 GPU id pick 全屏 pass + JS Set**
  → 本机：`src/app/editor.ts:1169-1193`（`pickPrep` + `pickRect` + `new Set(pick)` + 20M 循环）
  → SuperSplat：`editor.ts:590-605` 同样 `pickPrep`+`pickRect`，但 footprint 分支 `:603` 用 `new Uint32Array(new Set(pick)).sort()`
  → 改法：把 `new Set` + 20M 循环改成对 `pick` 排序后直接构造区间（`IndexRanges` 支持区间），并在 n ≥ 800 万时对 pick 区域做面积守卫（仓库审计已提"按框面积 > 1M 像素时抽样"）。
  → 预期收益：【推算】20M 环模式每次手势省 ~60–120 ms。
- **P2-6b｜画中画（PiP）：一次性 80 MB identity order + 一份完整 centers 副本 + 第二个 Worker**
  → 本机：`src/camera/camera-preview.ts:783-839`（`_ensurePipSort`：`new Uint32Array(numSplats)` identity 种子 80 MB、`new StorageBuffer(numSplats*4)` 80 MB、`resource.centers.slice()` = 20M×3×4 = **240 MB** 拷贝、另建一个排序 Worker），触发点 `:442`/`:471`（每 `_pipInterval()` 帧、需要相机轨道才启用）
  → SuperSplat：PiP 渲染同样走 `ProjectedSplatRenderer`，没有第二份 centers/order
  → 改法：20M 时把 PiP 的 identity 种子改成"不写种子、用 shader 侧的 identity 判断"（`splat-overlay.ts:148-151` 已有同样的"identity 不需要真数据"论证），并禁止 PiP 建第二个 Worker（复用主 sorter 的 centers，只换 order target）。
  → 预期收益：【推算】20M 下开 PiP 少 320 MB 常驻 + 一个空闲但常驻的 Worker。
  → 验证方法：探针里开 PiP 后量 `performance.memory`；阈值：**PiP 开启后的增量 ≤ 90 MB**。
- **P2-6｜导入仍是一次性长耗时（4.73 GB / 20M）**
  → 本机：`src/app/asset-loader.ts:73` 已 worker 化（好），但 morton 重排 + materialize 在 20M 上仍是几十秒级，且**没有 SOG/LOD/流式**通路（`src/lod/*` 只读已有 LOD 文件，编辑态还会强制退出代理级 `scene.ts:604-607`）。
  → SuperSplat：splat-transform 生成 LOD 链 + Streamed SOG，运行时 Gaussian budget 2M/4M。
  → 改法：给导入加"生成 LOD / 转 SOG"选项（依赖 `@playcanvas/splat-transform` 已在本机依赖里，v3.4.0），并把 `scene.ts:604-607` 的"编辑态禁用代理"改成"编辑态用最高级、浏览态用代理"。
  → 预期收益：浏览态可跑满 60 fps；不解决"编辑 20M"本身。
  → 验证方法：`docs/verify/verify-viewer-stream.cjs` / `verify-large-model-backend.cjs` 已存在，可扩展。

### 3.x 分类汇总（按你要求的三个类别）

| 类别 | 条目 |
| --- | --- |
| **每帧都发生的 O(n) 工作（最致命）** | 无主线程 O(n)。真正的每帧 O(n) 全在 GPU 上：P0-3（全量 20M 高斯 × 6 顶点 + SH3，零 per-splat 剔除/紧凑化；MRT 不算差异项）；以及 P0-2 的"每帧派发全量 worker 排序"（O(n) 在 worker）与"每完成一次排序就 80 MB 主线程 memcpy" |
| **只在交互中发生的 O(n) 工作** | P0-1（框选/套索 6 趟 20M 主线程循环）；P1-1（每次变更 20 MB 上传 + 全表 recount）；P1-2（瞬时 300–400 MB）；P1-3（settle 时的 bound 回读）；P2-5（环模式 pick）；P2-4（focus 的全量 exp） |
| **一次性成本（加载 / 首次 bound / SH 上传）** | P2-6（20M PLY 解码 + morton 重排，worker 内，几十秒）；首次 `SplatState.flush()` 的 20 MB 上传 + recount；首次 bound pass（4 次同步回读）；material 按 SH band 变体的编译停顿（切 band 时会重编）；P2-6b（PiP 的 320 MB 一次性分配 + 第二个 Worker） |

---

## 4. 量测方案（可直接执行，含判定阈值）

仓库已有探针风格：`docs/probes/*.cjs`（puppeteer-core + 无头 Edge，`http://localhost:3621/?gpu=webgpu`，服务由 `npx serve dist -p 3621` 提供）。
下面的建议**全部复用**该风格，只新增一个探针文件即可（不要装新依赖，`_tmp` 下的探针已经指向 `C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core`）。

### 4.0 准备

```powershell
cd D:\DeepSeek\SplatRoomV2\SplatRoomV3-0
npx serve dist -p 3621            # 已有 dist（本报告未重新构建）
# 20M 夹具不要走 fetch（4.73 GB），用 Electron/文件选择器直接打开；或先把它放到 dist 下再改探针的导入参数
```
⚠️ 4.73 GB 的 PLY **不要**用 `docs/probes/perf-probe.cjs:63` 那种 `fetch(...).arrayBuffer()` 导入（会先占 4.7 GB 内存再交给 worker）。

### 4.1 每帧 CPU 时间 / 帧间隔（判定"旋转是否流畅"）

探针骨架（复用 `_tmp\perf-probe.cjs:10-40` 的 `measure()`）：

```js
// 1) 帧间隔：不改任何代码，用 rAF 间隔统计
const frames = await page.evaluate(() => new Promise(res => {
    const t = [], end = performance.now() + 6000;
    // 模拟持续旋转：直接驱动 tween，或派发 pointer 事件
    const tick = () => { t.push(performance.now()); scene.forceRender = true; scene.app.renderNextFrame = true;
        performance.now() < end ? requestAnimationFrame(tick) : res(t); };
    requestAnimationFrame(tick);
}));
```
**判定阈值**
- 静止：p95 帧 ≤ 20 ms（按需渲染下应接近 0 帧率，测的是被强制的帧）
- **旋转中：p95 帧 ≤ 33 ms（30 fps），max ≤ 100 ms** ← 这是"流畅"的门槛
- 旋转中主线程长任务：`PerformanceObserver({entryTypes:['longtask']})` 捕获的 >50 ms 任务 **≤ 1 个/秒**

### 4.2 GPU 时间（判定瓶颈在 GPU 还是 CPU）

【查证-上游源码】SuperSplat 就是用引擎的 timestamp query 做的（`ss330\scene.ts:564-565` `graphicsDevice.gpuProfiler.enabled`，`:670-689` `onGpuReport`）。
本机引擎同源，可直接用：

```js
await page.evaluate(() => { window.scene.app.graphicsDevice.gpuProfiler.enabled = true; });
// 引擎把每帧 span 写到 scene 的 'gpu:report' 或 gpuProfiler 结果；本机 scene.ts 没有消费它，
// 所以探针里自己挂 app.graphicsDevice.on('gpu:report', ...) 或轮询 gpuProfiler 结果
```
若 GPU profiler 不可用（Electron 里 timestamp query 支持不确定，需实测），退而用：
- `renderer.info`（draw calls / instances）确认"每帧画的是 20M（instancingCount = 156250）而不是存活子集"
- `performance.measureUserAgentSpecificMemory()` 前后差确认没有 O(n) 的 CPU 数组

**判定阈值**：**gpuFrameMs / cpuFrameMs > 3** ⇒ 瓶颈在 GPU（走 P0-3）；反之在 CPU（走 P0-1/P0-2/P1-1）。

### 4.3 排序耗时与顺序延迟（P0-2 的口径）

引擎在排序完成时会 `scene.fire('gsplat:sorted', sortTime)`（【查证-引擎源码】`playcanvas.mjs:41256-41258`）。所以：

```js
const sortStats = await page.evaluate(() => new Promise(res => {
    const rec = []; const t0 = performance.now();
    scene.events.on('gsplat:sorted', (ms) => rec.push({ t: performance.now() - t0, ms }));
    setTimeout(() => res(rec), 6000);
}));
```
**判定阈值**
- `ms`（单次 worker 排序）在 20M 上 **≥ 400 ms 即确认 P0-2**（仓库已实测 13M ≈300 ms，`render.ts:1487-1490`）
- 排序**完成间隔** ≤ 250 ms 说明 worker 能跟上；20M 下实测会落在 ~450–550 ms ⇒ 顺序滞后 = 间隔（这就是"旋转时抖动/跳序"的量）
- 主线程 stall：monkey-patch 上传
  ```js
  const inst = splat.entity.gsplat.instance;
  const impl = inst.sorter.uploadStream.impl;
  const orig = impl.upload.bind(impl);
  impl.upload = (...a) => { const t = performance.now(); orig(...a); window.__up = (window.__up||0) + (performance.now()-t); };
  ```
  阈值：**单次 upload ≤ 5 ms；6 秒内累计 ≤ 40 ms**

### 4.4 pointermove / 选择处理耗时（P0-1 的口径）

分两段量，因为 rect 只在 pointerup 触发（`src/tools/rect-selection.ts:77-105`）：

```js
// (a) pointermove 处理耗时：拖动 2 秒，量事件处理到下一帧的延迟
// (b) 松手那一下：直接量 select.rect 的端到端
const sel = await page.evaluate(async () => {
    const t0 = performance.now();
    await scene.events.invoke('select.rect', 'set', { start: {x:0.3,y:0.3}, end: {x:0.6,y:0.6} });
    return performance.now() - t0;
});
```
再细拆：
```js
// 拆 runRangeSelection 的各段：临时在控制台里包一层
// preMask / tailFractions / selectRange / fromPredicate / edit.add
const t = await page.evaluate(() => {
    const t0 = performance.now(); scene.events.invoke('select.rect','set',{start:{x:.3,y:.3},end:{x:.6,y:.6}});
    return performance.now() - t0;   // 注意 invoke 返回 Promise，用 await 版
});
```
**判定阈值**
- pointermove：**p99 处理耗时 ≤ 4 ms**（当前应已达标，用来确认"拖动本身不卡"）
- **`select.rect` 端到端（含 settle）≤ 300 ms** ← P0-1 的达标线；改前【推算】1.6–2.2 s
- 拆解上限：`selectRange` 单趟 ≤ 80 ms；`preMask`+`managed` ≤ 20 ms；`IndexRanges.fromPredicate` ≤ 20 ms；`edit.add`（含 flush）≤ 40 ms
- `splat.state.flush()` 单独：**≤ 5 ms 且上传字节 ≤ 4 MB**（P1-1）

### 4.5 内存 spike（P1-2）

```js
const before = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
// 做一次框选
const after  = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
```
**判定阈值**：单次手势 heap delta **≤ 180 MB**（改前【推算】~340 MB + 一次 major GC）。

### 4.6 已有的现成探针（优先复用，避免重复造）

| 探针 | 用途 |
| --- | --- |
| `docs/probes/perf-probe.cjs` | 帧间隔三段（model only / centers on / centers off）+ 读 `orderBuffer.byteSize` ← **本报告 4.1 的骨架** |
| `docs/probes/push-perf.cjs` | 一次推杆端到端 ← **4.4 的骨架** |
| `docs/probes/o1-bound-probe.cjs` | bound pass 的等待/回读成本 ← **P1-3** |
| `docs/probes/merged-probe3.cjs` | 13M 场景 |
| `docs/probes/pickpass-probe.cjs` | pick pass 开销 ← **P2-5** |
| `docs/verify/verify-selection-range.cjs`(24 项) / `verify-selection-depth-bar.cjs`(19 项) | P0-1/P1-1 的**语义回归**双后端（改 O2/O3 必须跑） |
| `docs/verify/verify-large-model-backend.cjs` | 大模型后端诊断 ← **P2-6** |
| `docs/verify/verify-viewer-stream.cjs` | 流式/LOD ← **P2-6** |
| `docs/probes/adaptive-probe.cjs` | 自适应节流范式（`camera-preview.ts:151-165`） |

---

## 5. 一句话总结 + 最值得先做的 3 条

**根因**：本机仍然跑在引擎的 **legacy `GSplatInstance` + CPU worker 全量排序**通路上（WebGPU 也一样），
交互时既没有 GPU 排序也没有任何剔除/降级，而且 fork 还把**框选从 GPU 相交改成了主线程 JS 全量投影**；
SuperSplat 3.3.0 则是自研 `ProjectedSplatRenderer`：**compute 投影 + 紧凑化 + GPU 基数排序 + indirect draw**，
并且**交互帧完全不排序**，靠"按实测 GPU 帧时间自适应的贡献剔除 + 遮挡剔除"（实测 −26% GPU / −26%~−41% survivors）保住帧率。

1. **P0-1**：把 `select.rect` / lasso / polygon / 2D-brush 从 `runRangeSelection` 的主线程 20M 全量投影（`editor.ts:1356`、`selection-range.ts:432`）改回/改造成 GPU pass（或至少搬进 worker），把松手时 1.6–2 s 的冻结打到 300 ms 以内。
2. **P0-2**：交互帧停止每帧强制全量 worker 排序（`splat.ts:774-802` 的 epsilon 1e-12 + `forceUpdate`），改成"按点数自适应的排序间隔 + 松手补一帧干净排序"，消除 worker 饱和与每次排序完成时主线程 80 MB memcpy 的 stall。
3. **P0-3**：给交互加"运动降级"（相机运动期间降 SH 波段 / 提高 `alphaClipForward` / 抽稀；中期做 compute 投影 + 紧凑列表 + indirect draw），因为本机每帧都在画满 20M 高斯 × 6 顶点 + SH3 且零 per-splat 剔除。

**量化目标（可直接写进验收）**：官方在 Apple M4 Max 上，20M 用新 WebGPU 渲染器是 **10.22 ms/帧（97.8 fps）**，
同一套模型用官方旧 WebGL2 路径（≈本机当前架构）是 **44.93 ms/帧（22.3 fps）**。
所以本机 20M 的验收线建议定为 **p95 帧 ≤ 16.7 ms（60 fps）**、底线 **≤ 33 ms（30 fps）**——
后者恰好是"别落在 22 fps 那一列"的分界。

---

## 附录 A：上游源码缓存（本报告的证据副本，只读，未改动仓库）

`D:\DeepSeek\SplatRoomV2\_tmp\ss330\`：
`projected-splat-renderer.ts`、`splat.ts`、`editor.ts`、`scene.ts`、`editor-splat-resource.ts`、`splat-state.ts`、
`gaussian-instances.ts`、`histogram-config.ts`、`rect-selection.ts`、
`shader-projected-splat-{projector,shader,indirect-args,depth-reduce,chunk}-shader.ts`
（全部取自 `playcanvas/supersplat` tag `v3.3.0`）

## 附录 B：出处链接

- SuperSplat v3.3.0 release：<https://github.com/playcanvas/supersplat/releases/tag/v3.3.0>（2026-09-14；含 "stochastic motion cull … depth-based occlusion cull"）
- SuperSplat 仓库：<https://github.com/playcanvas/supersplat>
- 官方文档 *Streaming & Performance*（Gaussian budget 2M/4M —— ⚠️ 属 **Viewer**，非编辑器）：<https://developer.playcanvas.com/user-manual/supersplat/streaming/>
- PlayCanvas 博客 *New in SuperSplat: WebGPU and Streaming Bring Huge Performance Wins*：<https://blog.playcanvas.com/new-in-supersplat-webgpu-and-streaming-bring-huge-performance-wins/>
  → **1.6 节那张性能表的原始数字出处**：`playcanvas/blog` 的 `src/components/GSplatPerfChart/index.jsx`
  （博客正文里是 `<GSplatPerfChart device="desktop" />` 组件，数字不在 markdown 里，需读该组件源码）
- PlayCanvas 博客 *New in SuperSplat: Walk Mode, Streamed LOD and Easy Upload*：<https://github.com/playcanvas/blog/blob/main/blog/2026-03-11-new-in-supersplat-walk-mode-streamed-lod-and-easy-upload.md>
- engine PR *GSplat: GPU-driven sorting and frustum culling pipeline on WebGPU*：<https://github.com/playcanvas/engine/pull/8453>
- splat-transform PR *Add a gaussian count floor to LOD chunk splitting (`--lod-chunk-min`)*：<https://github.com/playcanvas/splat-transform/pull/313>
- 第三方报道 *SuperSplat Ships Compute-Based WebGPU Rendering and Automatic Streamed LOD*：<https://radiancefields.com/supersplat-ships-compute-based-webgpu-rendering-and-automatic-streamed-lod>
- 第三方报道 *SuperSplat 3 Moves Editing to WebGPU*：<https://digitalproduction.com/2026/09/18/supersplat-3-moves-editing-to-webgpu/>

## 附录 C：未核实 / 需要你确认的点

1. **"浏览器版很流畅"的具体形态部分解决**：第二轮调研查证到文档里那套 **2M/4M "Gaussian budget" 属于 Viewer，不属于编辑器**；
   编辑器唯一的阈值是导入期的 `LOD_MAX_SPLATS = 20_000_000`（`loader.ts:34-45`）。
   所以如果用户是在 **editor** 里直接导入 4.73 GB PLY 得到"流畅"，那**不能用 2M/4M 解释**，
   只能由 1.1–1.3 的 GPU-driven 架构 + 运动帧免排序来解释 —— 结论不变，P0-3 优先级不必提前。
   仍待你确认的是：他用的**到底是 editor 还是 viewer**（若两者都试过且都流畅，则更坐实架构解释）。
2. 本机的 WebGPU 是否真的拿到了 timestamp-query 支持（决定 4.2 是否可用）——需要实跑确认。
3. 本机 `dist` 与当前 `src` 是否同版本（本报告行号以工作树 3.23.5 为准；探针跑的是 `dist`）。
4. 20M 档的所有耗时都是【推算】（由仓库 13M 实测 840–1016 ms / 556–621 ms / sort ~300 ms 线性外推），**必须用第 4 节的探针落地校准**。
   唯一的**官方实测锚点**是 1.6 节那张表（我本人从 `playcanvas/blog` 的图表组件源码核对，非转述）。
5. **工作树在本次调研期间被另一个会话改动过**（不是我改的，我全程只读）：`src/splat/splat-overlay.ts`（15170 → 16016 B）与
   `src/shaders/splat-overlay-shader.ts`（10093 → 10934 B），时间戳 2026-09-20 11:47，`git status` 显示这两个文件为 ` M`。
   改动内容是"centers overlay 在 WebGPU 下自己判删除位（bit 4）+ 按 `splatData.numSplats` 画满所有行"。
   本报告里 `splat-overlay.ts` 的行号**已按改动后的工作树校正**（旧的 296-344 / 309-341 / 349-354 现在是 302-350 / 315-347 / 355-360；244 行之前未受影响）。
   顺带一提：这次改动正好印证了 3.x 的分类判断 —— **WebGPU 走恒等 order 映射时"必须画满所有行"**，
   所以在 centers 模式下 20M 就是 20M × 6 顶点，P1-4 的守卫更有必要。
6. **本机引擎版本落后上游一档**：本机 `node_modules/playcanvas` = **2.21.3**，SuperSplat 3.3.0 钉的是 **2.22.1**。
   引擎文档提到 LOD 的 "distance mode 自 2.23 起成为默认，2.22 默认 error mode" —— 即上游钉的版本也还没拿到更省内存的 LOD 默认值。
   → 引擎侧的行号引用请一律以本机 2.21.3 为准（本报告全部如此标注），不要当成 2.22.1 的行为。

## 附录 D：第二份证据源

`D:\DeepSeek\SplatRoomV2\_tmp\ss-research-notes.md`（1732 行 / 102 KB，由并行子代理在同一 tag `v3.3.0` 上产出，含逐条 `path:line` 与原文引用、
以及每个小节的置信度表）。本报告 1.6 / 1.7 / 2.4 的补充与更正来自它 + 我本人的核对。
两份文档在"架构结论"上完全一致（GPU 投影 + 紧凑化 + GPU 排序 + 间接绘制 + 运动帧免排序），
差异仅在于它把引擎侧行号标为 Medium 置信度（因为它下载 2.22.1 源码包时被截断，只能退回本机 2.21.3 副本）。
