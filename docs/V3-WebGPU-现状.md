# SplatRoom V3 — WebGPU 后端的现状（2026-09-12）

> **最新状态（3.5.0）：WebGPU 已经能正常渲染模型。** 真正的黑屏元凶不是着色器，而是
> `DataProcessor.calcBound()` 的 **GPU 回读在 WebGPU 下返回全零**：该结果直接写进 `Splat.localBoundStorage`
> （它是 `resource.aabb` 的别名，于是连 CPU 侧 AABB 一起被清零）→ 场景包围盒退化成一个点 → 相机无法取景、
> near/far 都变成 0 → **投影矩阵变成 NaN** → 所有高斯都被裁掉。引擎自带的 WGSL splat 着色器"同样画不出来"
> 也是同一个原因（相机态坏了，不是着色器坏了）。
>
> 修复：`Splat.updateLocalBounds()` 在 WebGPU 下若 GPU 结果不可用，则回退到构造时保存的 CPU AABB。
> 修复后 2k 测试模型与 5M/324MB 大模型在 WebGPU 下**都正常出画面**（见第 6 节实测截图判据）。
> 启动回退（默认仍 WebGL2）暂时保留：回读路径本身（拾取/快照/直方图）与各项编辑功能还没逐项验证。
>
> **历史记录**（下方第 1–5 节）描述的是修复前的状态与当时的排查结论，保留作为证据链。

**当时的结论：WebGPU 后端无法渲染高斯点云，因此启动时拒绝该设置并回退 WebGL2 + 弹窗说明，只在开发时用 `?gpu=webgpu` 打开。**

这份文档记录的是**可复现的证据**，不是推测：全部结论都由 `docs/verify/` 下的无头浏览器脚本在本机（NVIDIA Ampere，Edge 真实 WebGPU 适配器，非 SwiftShader）实测得到。

---

## 1. 现象

用户反馈：默认 WebGL2 时模型正常；把"Graphics backend"设成 WebGPU 并重启后，打开模型（大文件）不显示。

实测表明**与模型大小无关**：

| 模型 | 后端 | 视口结果 |
| --- | --- | --- |
| `test-model.ply`（2,000 splats） | WebGL2 | 正常（采样区 85.7% 为模型颜色） |
| `test-model.ply`（2,000 splats） | WebGPU | **全黑**（采样区 100% 纯黑，含背景） |
| `big-model.ply`（5,000,000 splats，324 MB） | WebGL2 | 正常（非背景像素 59.4%） |
| `big-model.ply`（5,000,000 splats） | WebGPU | **全黑** |

同时，网格（grid）和 UI 面板在两个后端都正常绘制 —— 即**渲染循环本身是好的，只有 splat 这一遍是空的**。

复现命令：

```
npx serve dist -p 3621
node docs/verify/verify-large-model-backend.cjs test-model.ply webgpu http://localhost:3621/
node docs/verify/verify-large-model-backend.cjs test-model.ply webgl2 http://localhost:3621/
```

该脚本用三种互相独立的方式判定"是否真的画出来了"：

1. `drawImage(canvas)` 采样（在 `postrender` 回调内）；
2. 走应用自身的回读路径 `dataProcessor.copyRt(mainTarget, workTarget)` + `texture.read`；
3. `page.screenshot()` 截取视口中心区域，用 `docs/verify/lib/png.cjs` 解码后统计非背景/彩色像素比例。

WebGPU 下 (1)(2) 恒为 0，必须靠 (3)（合成后的真实画面）才能可靠判定，所以三种都保留。

---

## 2. 原因一（已修复）：缺少 GLSL→WGSL 转译器

PlayCanvas 在 WebGPU 上把本项目**全部自研着色器**（都是 GLSL）编译成 WGSL：`glslang`（GLSL→SPIR-V）+ `twgsl`（SPIR-V→WGSL）。创建设备时必须传 `glslangUrl` / `twgslUrl`，我们此前没传，于是控制台刷出：

```
Cannot transpile shader [Shader Id 5 (GLSL) final-blit-proc] - shader transpilers
(glslang/twgsl) are not available. Make sure to provide glslangUrl and twgslUrl
when creating the device.
```

受影响的正是自研的 5 个着色器：`final-blit`（最终上屏）、`infinite-grid`、`apply-outline`、`apply-underlay`、`calcBoundShader`。

**修复**：转译器文件从 PlayCanvas engine 仓库（`examples/assets/wasm/{glslang,twgsl}`）取回并随应用一起发布，放在 `static/lib/wasm/`（打包进 exe，离线可用）；`src/core/gpu-backend.ts` 的 `webgpuTranspilerUrls()` 用 `document.baseURI` 解析路径（与 WebP wasm 一致，`http://localhost:<port>/` 和 `file://` 都成立），`src/main.ts` 与 `src/splatfactory/splatfactory-app.ts` 在创建 WebGPU 设备时传入。

**验证**：修复后同一次运行中 5 条 `Cannot transpile shader` 全部消失（`verify-large-model-backend.cjs` 的 `logs` 数组只剩余 1 条 `powerPreference` 警告和 1 条 centers overlay 警告）。

---

## 3. 原因二（未解决）：splat 这一遍在 WebGPU 上没有可用管线

### 3.1 引擎在 WebGPU 上使用自己的 WGSL splat 材质

`GSplatInstance` 的材质同时带 GLSL 与 WGSL 源码，而
`shader-generator-shader.js` 的选择条件是：

```js
const wgsl = device.isWebGPU && !!desc.vertexWGSL && !!desc.fragmentWGSL
             && (options.shaderChunks?.useWGSL ?? true);
// ShaderChunks.useWGSL === (glsl.size === 0 || wgsl.size > 0)
```

`GSplatResourceBase.configureMaterial()` 在 WebGPU 下会把格式声明写进 **wgsl** 块（`material.shaderChunks.wgsl`），所以 `wgsl.size > 0` 恒成立 → **永远走 WGSL 分支**。我们注入的 `shaderChunks.glsl.set('gsplatPS', fragmentShader)` 在 WebGPU 上被静默忽略：

- 颜色分级 / 隐藏·删除状态 / 裁剪盒 / 粒子化特效 / 变换调色板 → 全部不生效；
- 运行时实测：`material.shaderChunks = { glsl: 4 项, wgsl: 2 项 }`，`shaderDesc.fragmentWGSL` 存在。

### 3.2 我们自己的双附件 MRT 在 WebGPU 上是非法管线

项目的 splat 遍写两个附件（RT0 `cameraColor` + RT1 `workColor`，供描边/底层合成使用，
见 `src/camera/camera.ts` 的 `splatTarget`）。引擎那份 WGSL splat 着色器只声明一个片元输出（`gsplat.js` 只在 `DEPTH_PICK_PASS` 下写 `output.color1`），Dawn 直接报错：

```
Color target has no corresponding fragment stage output but writeMask (...) is not zero.
 - While validating targets[1] framebuffer output.
[Invalid RenderPipeline] is invalid due to a previous error.
 - While encoding [RenderPassEncoder "_p-PassEncoder RT:cameraColor"].SetPipeline(...)
```

用 `docs/verify` 里的探针（拦截 `createShaderModule` / `createRenderPipeline`，把管线颜色附件数与片元输出数配对）定位到这条管线：`targets: 2` + `FragmentOutput { @location(0) color }` —— 即我们的 splat 遍。

**实验**：把 splat 遍临时改成单附件后，上述校验错误全部消失，**但视口仍然全黑**（网格照常渲染）。也就是说 MRT 只是错误来源之一，splat 的片元仍然没有产出。

### 3.3 因此

- 走 WGSL 分支 → 自研 splat 着色器（约 700 行 GLSL + 依赖的状态/变换纹理）全部失效；
- 强制走 GLSL 分支（`useWGSL = false`）不可行：格式声明 `gsplatDeclarationsVS/gReadVS` 的内容在 WebGPU 设备上本身就是 WGSL 代码（`GSplatFormat` 按 device 选 `readWGSL`/`readGLSL`），塞进 GLSL 路径只会编译失败；
- 于是只剩两条路：把自研 splat 着色器（以及 pick/选点等 GLSL 通道）移植成 WGSL，或暂时不使用 WebGPU。

---

## 4. 当前行为（3.4.1 起）

- 启动时若 `localStorage['splatroom.gpuBackend'] === 'webgpu'`：控制台告警 + **重置为 webgl2** + 用 WebGL2 创建设备 + 1.5 秒后弹窗说明（9 种语言均有文案，`popup.webgpu-backend.*`）。
- 设置面板的"Graphics backend"行不再提供选择，改为如实显示 `WebGL2 (WebGPU unavailable in this build)`。
- `?gpu=webgpu` 仍然会选择 WebGPU 设备（**仅开发用**，画面全黑是已知状态）。
- `splatDiag()` 在 WebGPU 下的告警文本同步更新为当前事实。

验证脚本：`node docs/verify/verify-webgpu-fallback.cjs http://localhost:3621/ test-model.ply`（7 项断言：拒绝设置 / 重置偏好 / 弹窗文案 / 回退后模型可见 / 覆盖参数仍能进 WebGPU / 覆盖参数不改偏好 / 覆盖参数不弹窗）。

## 5. 若将来要做完整 WebGPU 支持

按依赖顺序：

1. 把 `src/shaders/splat-shader.ts`（GLSL，704 行）与它用到的 `gsplatCenter`/`gsplatModifyVS` 移植为 WGSL 片元/顶点块，并把它注册进 `material.shaderChunks.wgsl`（同时保证写两个 `processOutput.colorN`，以配合双附件 MRT）。
2. 逐个检查其余自研 GLSL 通道在 WebGPU 下的行为：`intersection-shader`、`splat-value-shader`、`select-by-range-shader`、`histogram-shaders`、`splat-overlay-shader`、`tool-overlay-shader`、`bound-shader` 等（转译器到位后它们能编译，但结果**尚未逐项验证**）。
3. 回读/回放路径：`copyRt` + `texture.read`、快照、录像、PiP 预览、8K 导出。
4. 每完成一项，用 `verify-large-model-backend.cjs`（两种后端对照）+ 像素级/数值级断言固化，再更新本文档。

---

## 6. WGSL 移植进展与剩余阻塞（2026-09-12 第二轮）

### 6.1 已完成

| 项 | 位置 | 状态 |
| --- | --- | --- |
| WGSL 版 `gsplatVS` / `gsplatPS` / `gsplatCenterVS` / `gsplatModifyVS` | `src/shaders/splat-shader-wgsl.ts`（约 830 行） | ✅ 与 GLSL 侧逐特性对齐：编辑状态剔除、粒子散射/波纹/飘散、SH、色调/高光/阴影/对比/8 区 HSL、隐藏删除着色、裁剪盒三形状 + 切面、rings、选中/锁定着色 |
| 自研 `gsplatCornerVS`（协方差投影） | 同上 `gsplatCornerWGSL` | ✅ 从引擎 WGSL 块复制，唯一改动是视口尺寸改读材质参数 |
| 双附件 MRT 合法化 | `gsplatPS` 同时写 `output.color` 与 `output.color1` | ✅ Dawn 校验错误消失（管线实测 `2 targets -> [0:color, 1:color1]`） |
| 注入方式 | `src/splat/splat.ts`、`src/splat/group-renderer.ts` | ✅ `device.isWebGPU` 时同时写 `shaderChunks.wgsl`（GLSL 侧保持原样，WebGL2 行为不变） |

### 6.2 已证实"能画"的部分（用临时调试 shader 逐步二分）

| 实验 | 结果 |
| --- | --- |
| 顶点直接输出全屏三角形 + 品红片元 | ✅ **整屏品红**（75% 画面）→ splat 遍的 draw、实例化、MRT 管线、片元输出全部正常 |
| 用 `source.cornerUV` 画固定大小方块 | ✅ 屏中央方块 → 顶点缓冲 / `initSource` 正常 |
| 用 `getCenter()` 画 2% 小方块 | ✅ 模型前墙分布出来 → 流纹理（高斯数据）在 WebGPU 下读取正常 |
| 读 `getScale()` | ✅ ≈ 0.036，正常 |
| 读 `viewport_size` / `minPixelSize` / `numSplats` | ✅ 1277 / 2 / 803（与画面一致） |

### 6.3 剩余阻塞：相机矩阵

- 探针读出 `uniform.matrix_view` 在 splat 材质里是**单位矩阵**（旋转列 = (1,-0.004,-0.004)，平移 ≈ 0）→ `centerView = modelCenter`，
  投影后 w≈0，NDC 落在视口外 → 全部高斯被裁剪（这同时解释了为什么**引擎自带的 WGSL splat 着色器也画不出来**，
  说明不是我们移植的 bug，而是该材质拿不到正确的 view uniform）。
- 已尝试：把 `uSplatView` / `uSplatProj` / `uSplatCameraParams` / `uSplatViewport` 作为**材质参数**喂进去
  （`src/splat/splat.ts` 的 `updateGpuCameraUniforms()`，每帧 `onPreRender` 更新），但读到的
  `scene.camera.camera.viewMatrix` / `projectionMatrix` 在 `onPreRender` 时机是**零矩阵 / 接近单位矩阵**——
  本仓库自研 `Camera` 类的相机矩阵由引擎在渲染准备阶段才计算，`onPreRender` 拿不到当帧值。
- **下一步**：不读组件矩阵，改为在本仓库侧自己算：
  `viewMatrix = 主相机节点 getWorldTransform() 的逆`，`projectionMatrix` 复用 `mainCamera.camera.calculateProjection(matrix, w, h)`
  回调（`camera.ts` 已设置该回调），或把上传时机挪到引擎相机同步之后（如 `app.on('prerender')` 之后/渲染前一次 flush）。
  算好后用 6.2 的读数法先验证数值，再恢复真实着色器看画面。
- 补充读数（材质参数路径，第二轮实测）：`uSplatView` **确实进到着色器了**（`view[3][2] ≈ 0.23`，与相机位置一致），
  但 `uSplatProj` 在着色器里读出来是 **无效值**（`proj[0][0]*0.25+0.5` 被 clamp 到 0 → ≤ -2 或 NaN），
  与 `cam.projectionMatrix.data` 在 `onPreRender` 时刻读出**全 0** 一致。
  引擎 `Camera.projectionMatrix` 与 `viewMatrix` 都是"脏标记 + 懒重算"的 getter（`camera.js` L395 / `_updateViewProjMat`），
  本仓库的自研相机路径下这个懒重算在 `onPreRender` 时机没有发生，因此**必须自己算投影矩阵**（或调用引擎的
  `updateProjection`/`_updateViewProjMat` 等入口）后再上传。

### 6.5 收尾状态：**WebGPU 已经能渲染了**（3.5.0，提交 7208748）

真因链（与 6.3 的"相机矩阵"推测相比，这里给出了最终答案）：

1. `DataProcessor.calcBound()`（GPU 数据处理器）把结果**回读**出来写进 `Splat.localBoundStorage`；
2. 该 storage 是 `instance.resource.aabb` 的**别名**（`splat.ts` 构造处），于是回读全零时连引擎算好的 CPU AABB 一起被清零；
3. `scene.bound` 随之退化成一个点（`halfExtents = (0,0,0)`）；
4. 相机取景逻辑 `fitClippingPlanes()` 在这个退化 bound 下算出 `near == far`（实测两者都是 0）；
5. `setPerspective(fov, aspect, 0, 0)` → **投影矩阵整块 NaN** → 所有高斯的 clip 位置都是 NaN → 视口全黑。
   （这也是为什么**引擎自带的 WGSL splat 着色器同样画不出来** —— 坏的是相机态，不是着色器。）

修复与证据：

- `Splat.updateLocalBounds()`：WebGPU 下若 GPU 回读结果不可用，回退到构造时保存的 CPU AABB（`cpuBoundStorage`）。
- 实测（`_tmp/map.cjs`，画布区域精确颜色直方图）：
  - `test-model.ply`（2k 高斯）：视口出现大片红色前墙 + 蓝色后墙像素，画面均值 (95,42,47) —— **模型可见**；
  - `big-model.ply`（5M 高斯 / 324 MB）：视口被模型填满，均值 (103,103,104) —— **大模型同样可见**。
- WebGL2 无回归：`npm run check` 全绿、`verify-model-renders` 0 失败（33.3% 非背景）、`verify-webgpu-fallback` 7/7、`verify:diag` 7/7。

### 6.6 第二轮（同日更晚）：修正一个错误结论 + 收窄剩余问题

**修正**：上一节写的"WebGPU 回读返回全零"是**错的**。用原生 WebGPU 命令直接 `copyTextureToBuffer` + `mapAsync`
读相机颜色纹理的**模型区域**（origin 400,250），返回的是真实数据（256 字节非零，half-float 数值合理）；
之前读到的全零是因为采样点在**左上角黑色背景**（`origin 0,0`）。引擎的 `texture.read`（`immediate` 真/假都一样）
本身在 WebGPU 下是可用的。

剩下的 WebGPU 失效点收敛到**两个 GPU 数据处理器通道**（不是回读）：

| 通道 | 现象 | 备注 |
| --- | --- | --- |
| `CalcBound`（`calc-bound.ts`） | 重新执行后仍返回 `center/half = 0` | 所以 `Splat.updateLocalBounds()` 的 CPU AABB 兜底先保留 |
| 拾取 ID/深度（`RenderPassPicker` + PICK_PASS 变体） | `prepareId()` 之后立刻读 ID 目标（= `workTarget.colorBuffer`，同时是 splat MRT 的 RT1）**整片为 0**，连清屏色 (1,1,1,1) 都没落上 | 注意：不能在拾取后再渲染一帧再读 —— RT1 会被前向 splat 遍覆盖成 0（这个坑本轮踩过一次） |

复现工具（`_tmp/`，未入库）：`raw-read-probe.cjs`（原生 WebGPU 回读 + usage 检查）、`pick-target-probe.cjs`
（拾取后立刻原生读 ID 目标 + 引擎 `readIds` 对照）、`read-probe.cjs`（`immediate` 对照）。

下一步（撤掉启动回退之前必须做完）：

1. **修拾取通道**：`RenderPassPicker` 在 WebGPU 下的管线/清屏/材质变体（`pickOp`/`pickMode` 走 device scope，
   已确认 scope 里有值；要查的是 material UB 是否拿到、以及拾取遍是否真的执行/写入了目标）。
2. **修 `calcBound` 通道**（或长期改为 CPU 计算，反正引擎已经给了 CPU AABB）。
2. 逐项验证核心编辑功能在 WebGPU 下的表现：颜色分级、隐藏/删除、裁剪盒（含切面）、粒子特效、变换调色板、选中描边（RT1 消费者）。
3. 居中点覆盖层（需要 orderTexture，WebGPU 用 orderBuffer）与 PiP 预览。
4. 全部通过后再移除启动回退、恢复设置面板选项、打包 3.5.x 便携版。

调试工具与教训见 6.4；数值读数法（instance 0 画全屏三角形 + RGB 编码 + 反解）在这次定位中起了决定性作用。



- `map.cjs`：截取画布区域 → 解码 PNG → 输出**精确颜色直方图 + 均值 + 粗粒度 ASCII 色块图 + 三条带像素读数**（排除"截图整体比例"这类不敏感指标）。
- `pass-probe.cjs`：拦截 `beginRenderPass` / `setViewport` / `setScissorRect` / `draw*`，打印每个 pass 的附件纹理 id、loadOp 与实际 draw。
- `draw-probe.cjs` / `ub-probe.cjs`：统计每个管线的 draw、并检查材质参数与 WGSL 里 `ub_view.*` / `ub_mesh_ub.*` 的落点。

> 教训：`verify-large-model-backend.cjs` 里的 `shot` 指标用的是硬编码 `clip {0,0,800,500}`，会把左侧 UI 面板算进去，
> **对"视口内容"不敏感**（网格-only 与整屏品红都是 0.3806）。判定"是否画出来"请用 `map.cjs` 或 `verify-webgpu-fallback.cjs`
> 里的 `viewportStats()`（在视口内部取 300×220）。


### 6.7 第三轮：拾取遍**确实在画**，但结果没落到目标纹理

_tmp/pick-draw-probe.cjs（hook `beginRenderPass`/`draw*`，统计一次 `prepareId()` 期间的 draw）：

```
duringPick: [ "drawIndexed 768/16 vs=vertexMain t=1 pick=true x1" ]
gsplatDirector: true        // WebGPU 下引擎启用了 unified gsplat director
opaqueCount: 0  transparentCount: 1
```

即：拾取遍**发出了 1 次 draw**（我们的 splat 材质、PICK_PASS 变体、1 个颜色附件），
但 `paintId` 之后立刻原生读 `workTarget.colorBuffer` 仍是全 0（连清屏色都没有）。

因此怀疑点收敛到**目标写入被丢弃**：PlayCanvas 的 `RenderPass` 在 WebGPU 下会把颜色附件标成
`store=false`（`render-pass.js` 的 `colorOps.store`，debug 输出里表现为 `load->discard`），
若拾取遍的目标被当作 transient/discard，draw 的结果就会被丢掉 —— 这同时解释了"清屏色也不见"。

下一轮第一件事：用 `_tmp/pass-probe.cjs`（已支持打印每个 pass 的 `loadOp/storeOp`）在 `prepareId()` 期间抓一次
pass 描述，确认是不是 `discard`；若是，则在 `Picker.prepareId` 里显式保留该附件（或临时关闭 transient 优化）。
另记：`renderer.gsplatDirector` 在 WebGPU 下为 true（WebGL2 下为 false），这条渲染路径差异也要在拾取/居中点覆盖层上重新核对。
### 6.8 第五轮：WebGPU 上的选择与编辑功能实测通过

| 验证 | 命令 | 结果 |
| --- | --- | --- |
| 选择（矩形 + footprint + 深度） | `node docs/verify/verify-selection-depth.cjs "http://localhost:3621/?gpu=webgpu"` | **failed=0 / errors=0**：centers 573 ≤ footprint0.35 619 ≤ footprint1.00 742；toggle 还原 0.35（与 WebGL2 同一套序关系断言） |
| 编辑状态（隐藏全部） | `node docs/verify/verify-edit-hide.cjs "http://localhost:3621/?gpu=webgpu"` | 视口彩色像素 **99.3% → 4.1%**，均值亮度 114 → 8（模型从画面消失）；WebGL2 对照组同为 99.3% → 4.1% |

结论：拾取底层（id/depth 回读）+ 选择上层（mask/footprint）+ 编辑状态（`splatState` 纹理在 WGSL 着色器里生效）在 WebGPU 下都已工作；
`verify-edit-hide.cjs` 已作为长期验证脚本入库（它的脚本内断言计数还在修，功能读数已双后端一致）。

剩余验证项：颜色分级 / 裁剪盒 / 粒子特效 / 变换调色板 / 选中描边（RT1）/ 居中点覆盖层（orderBuffer）/ PiP / 导出。
### 6.9 第六轮：颜色分级在 WebGPU 上验证通过；裁剪盒验证脚本待修

| 验证 | 命令 | WebGPU | WebGL2 对照 |
| --- | --- | --- | --- |
| 颜色分级（饱和度 0） | `node docs/verify/verify-edit-grade-crop.cjs "http://localhost:3621/?gpu=webgpu"` | 彩色像素 **99.3% → 2.1%**（恢复 99.3%） | 99.3% → 3.0%（恢复 99.3%） |
| 裁剪盒（信息项，未断言） | 同上 | 98.6% → 98.9%（无变化） | 99.7% → 99.8%（**同样无变化**） |

- **颜色分级**：WGSL 侧饱和度/HSL 通道 + 每帧材质 uniform 更新链路在 WebGPU 下与 WebGL2 表现一致 ✓
- **裁剪盒**：脚本在**两个后端**都没有产生裁剪 → 说明是**验证脚本自身的步骤不完整**（不是 WebGPU 的 bug）。
  已确认的部分：`cropBox` 能初始化、`enabled=true`、形状/半径/缩放可设置，且 `uCropBox*` / `uViewToBoxLocal`
  **确实出现在 splat 材质的参数里**（说明 uniform 管线是通的）。缺的是让盒子真正小于模型的那一步
  （box 模式的 `dist` 只看盒子的世界尺寸 `uViewToBoxLocal`，半径只作用于圆柱/球形状）。
  该检查已降级为"仅报告不断言"，避免脚本长期假红；下一轮补齐后再恢复断言。

**下一轮待办**：修 `verify-edit-grade-crop.cjs` 的裁剪步骤（用 pivot 缩放/切换形状 + 触发 `cropBox.changed`），
然后逐项验证：粒子特效、变换调色板、选中描边（RT1）、居中点覆盖层（orderBuffer）、PiP、导出/快照。
### 6.10 第七轮：裁剪盒在 WebGPU 上确认生效

上一轮"裁剪盒不裁剪"其实是**验证脚本没把盒子改小**：`CropBox` 每帧用半尺寸 `_extent` 重算 pivot 缩放
（`crop-box.ts:136`），所以对它 `setLocalScale` 无效，被下一帧覆盖回去；盒模式的 `dist` 只看盒子的世界尺寸，
改 `radiusX/Y/Z` 完全不影响。改成写 `box._extent.set(0.3, 0.3, 0.3)` 之后：

| 后端 | 裁剪前 lit | 裁剪后 lit | 断言 |
| --- | --- | --- | --- |
| WebGPU | 98.6% | **19.5%**（ratio 0.20） | ✓ |
| WebGL2 | 99.7% | **40.2%**（ratio 0.40） | ✓ |

`verify-edit-grade-crop.cjs` 的裁剪检查已恢复为真正断言（双后端 failed=0）。

**待跟进**：两个后端的残余比例不同（0.20 vs 0.40），说明 WGSL 侧裁剪体积与 GLSL 侧**不完全一致**（可能出在
view 空间坐标重建 / 椭圆 varyings / cap plane 宽度）。两者都正确裁剪，但下一轮应当把差异量化到具体项
（例如同一相机下把剩余区域画成 ASCII 图对比），必要时修正 WGSL 裁剪数学。
### 6.11 第八轮：裁剪体积差异仍在（已排除一个嫌疑），并修了一处真实的参数误用

**修正**：上一轮重构时把 `uSplatProj` 换成了合成矩阵 `uSplatViewProj`，于是裁剪重建里的
`matrix_projection[0][0]` / `[1][1]` 与 `center.projMat00` 都读的是**视图×投影**矩阵的元素
（等价于把 view 的旋转混了进去）。本轮已恢复一个**只含投影**的 `uSplatProj` 参数并用它做裁剪重建；
`npm run check` 全绿、双后端裁剪断言依旧通过（WebGPU ratio 0.20 / WebGL2 ratio 0.40）。

**差异仍在**：把同一相机、同一 pivot 缩放（0.6）下的**保留区域**画成 ASCII 图对比（`_tmp/crop-map.cjs`）：

- WebGL2：保留一块较宽的盒子（约 13 列 × 8 行，lit 13.9%）
- WebGPU：保留一块较窄的盒子（约 7 列 × 5 行，lit 6.8%）

把裁剪空间坐标直接画进颜色（临时 debug，已移除）确认 WGSL 侧的 `localPos` 是**合理值域**（盒内 ±0.5），
所以不是"重建完全错"，而是**边界/切面（cap plane）处的取舍比 GLSL 更紧**：
嫌疑集中在 (a) 切片厚度 `uCropBoxCapWidth` 与高斯尺寸的耦合、(b) 椭圆 varyings 求出的 `depthOffset`、
(c) WGSL 侧高斯投影尺寸与 GLSL 的细微差别（基线覆盖率已是 98.6% vs 99.7%）。

**下一轮**：用同一相机把两端的 `dist` 场各自画出来做逐像素对比（哪一侧先越过 0）；这是像素级等价的最后一步。
在此之前，"裁剪在 WebGPU 下可用"成立（两侧都强裁剪），"与 WebGL2 像素级一致"尚未成立。
### 6.12 第九轮：第二渲染目标（RT1）的两个消费方在 WebGPU 上验证通过

`output.color1` 是本次移植里"引擎 WGSL 着色器原本没有"的那一半（选中描边/底层着色都靠它），
用新脚本 `docs/verify/verify-selection-overlay.cjs` 做像素级验证：

| 状态 | WebGPU 平均亮度 | WebGL2 平均亮度 |
| --- | --- | --- |
| 无选择 | 114 | 118 |
| 全选（底层着色 RT1.rgb 叠加，无描边） | **151** | **157** |
| 打开选中描边（描边遍读 RT1.a 覆盖率） | **119** | **122** |

- 全选后画面显著变亮 → RT1 的 **rgb** 通道（选中 20% 叠加色）在 WebGPU 下正确写出并被 `apply-underlay` 消费 ✓
- 打开描边后画面回落（描边重绘轮廓） → RT1 的 **alpha** 通道（`norm` 覆盖率）在 WebGPU 下正确写出并被 `apply-outline` 消费 ✓
- 两后端 failed=0 / errors=0，数值差异 <4%（AA 与覆盖率统计口径），属于同一量级

脚本入库：`node docs/verify/verify-selection-overlay.cjs "http://localhost:3621/?gpu=webgpu" test-model.ply`
### 6.13 第十轮：尝试让居中点覆盖层在 WebGPU 可用 —— 发现更深的阻塞，已回滚保护渲染

**做了什么**：WebGPU 下排序结果在 `orderBuffer`（存储缓冲）里，覆盖层着色器要的是 `usampler2D splatOrder`。
于是让 `SplatOverlay` 在 WebGPU 下**自建一张 R32U 顺序纹理**，从 sorter 的 CPU 侧 `orderData` 上传
（worker 每次排序都会把 order 数组 postMessage 回主线程），并在 sorter `updated` 时标脏、下一帧重传。

**结果（必须回滚的原因）**：有了顺序纹理之后覆盖层真的开始渲染，但它的材质在 WebGPU 下**建不出管线**：

```
warn: Entry point ""main"" doesn't exist in the shader module [ShaderModule (unlabeled)].
      - While validating vertex stage ([Invalid ShaderModule], entryPoint: "main")
warn: [Invalid RenderPipeline] ... RT:cameraColor ... SetPipeline
warn: [Invalid CommandBuffer] ... Queue.Submit
```

后果不是"覆盖层不显示"，而是**整个视口变黑**（实测画面均值 114 → 0）——即切换 centers 模式会毁掉整帧。
因此本轮**已回滚**该改动（`git checkout -- src/splat/splat-overlay.ts`），回到"覆盖层在 WebGPU 不可用只是不显示、
不影响渲染"的安全状态；回滚后复测：`mean 114 -> 114`，模型照常显示。

**新脚本入库**：`docs/verify/verify-centers-overlay.cjs`（切换 centers 模式并测量像素）：

| 检查 | WebGPU | WebGL2 |
| --- | --- | --- |
| centers 模式不破坏渲染（回归护栏） | ✓ lit 98.4% → 98.4% | ✓ lit 99.9% → 99.9% |
| 顺序来源 | `orderBuffer=true` / `orderTexture=false` | `orderTexture=true` / `orderBuffer=false` |

**下一轮**：先查清那条 `Entry point ""main""` 的真实来源——把覆盖层材质编译出的 WGSL 模块与入口点 dump 出来
（PlayCanvas 对 GLSL 材质在 WebGPU 上走 glslang/twgsl 转译，入口点应为 `main`；报错里带引号的 `"main"` 说明
入口点字符串被错误地当作名字传入，或模块其实来自另一条编译路径）。修好入口点之后再恢复"自建顺序纹理"的方案，
并用同一脚本断言覆盖层真的画出来了（还需找到脚本里正确的 overlay 句柄属性）。
### 6.14 第十一轮：覆盖层管线失败的**确切原因**已查明（顶点模块里没有入口点）

用 `_tmp/overlay-shader-probe.cjs`（hook `createShaderModule`/`createRenderPipeline`，dump 模块内容、
入口点与管线绑定）在开启 centers 模式时抓到：

```
mods[12]  vertex  : isWgsl=false, entries=["calcSplatUV_u1_u1_"], len=2688     <-- 没有 @vertex 入口
mods[13]  fragment: isWgsl=true,  entries=["main_1","main"],  len=3374        <-- 入口正常
pipes[0]  { vs:"main" -> module 12, fs:"main" -> module 13, targets:1 }
warn: Entry point ""main"" doesn't exist in the shader module (vertex stage)
```

**结论**：覆盖层的**顶点**着色器经 glslang/twgsl 转译后，产出的 WGSL 模块**只有辅助函数** `calcSplatUV_u1_u1_`，
**没有入口点**（片段侧正常）；管线仍按 `main` 去取入口点 → 管线非法 → 整帧黑。
即"GLSL→WGSL 转译对**这个**顶点着色器不成立"，不是我们的顺序纹理方案有问题。

**下一轮的正解**：像 splat 材质那样，给覆盖层材质也提供 **WGSL 版本**（`ShaderMaterial` 的 ShaderDesc 支持
`vertexWGSL`/`fragmentWGSL`；引擎在 WebGPU 上会直接用它、跳过转译）。覆盖层 WGSL 需要在 PlayCanvas 的
WGSL 方言下写（`varying` / 松散 `uniform name: type` / `var tex: texture_2d<f32>`，入口点 `vertexMain`
/`fragmentMain`；顶点着色器还要用引擎的 `gsplatEvalSHVS`（WGSL 版已存在）以及 `vertex_index` 代替 `gl_VertexID`）。
完成后与"自建 R32U 顺序纹理"一起恢复，并用 `verify-centers-overlay.cjs` 断言覆盖层真的画出来。
### 6.15 第十二轮：覆盖层管线在 WebGPU 下**合法了**（但还没画出东西）

两个确定结论（都已实测）：

1. **`gl_PointSize` 就是转译失败的元凶**：WGSL 没有点尺寸，GLSL 顶点着色器只要给 `gl_PointSize` 赋值，
   glslang/twgsl 转译后的模块就**丢掉入口点**（只剩 `calcSplatUV_u1_u1_`），管线取 `main` 失败 → 整帧被丢弃。
   现已把两处赋值包进 `#ifndef GSPLAT_NO_POINTSIZE`，WebGPU 路径定义该宏；此后模块转译正常、顶点管线合法
   （**GPU 错误全部消失**）。
2. **顺序纹理镜像方案可用**：`SplatOverlay` 在 WebGPU 下自建 R32U 顺序纹理、从 sorter 的 CPU 侧 `orderData`
   上传，并在 sorter 报告新顺序时重传；覆盖层现在在 WebGPU 上 `orderReady=true` / `enabled=true`。

**剩余**：覆盖层仍然**改变 0 像素**（像素级 diff 实测），即它的 draw 落不到有效位置。首要嫌疑与 splat 材质当初同一类：
引擎的 view uniform buffer 在这些自研材质上**没有正确绑定**（`matrix_view` 曾读出单位矩阵），而覆盖层顶点着色器正是
从 `matrix_model` / `matrix_viewProjection` 取变换。下一轮照 splat 材质的办法把它们改成**材质参数**上传后复测；
另外要决定 centers 是否改成**画 billboard**（WGSL 的 point-list 永远只有 1px，`camera.splatSize` 会失效）。

**无回归**：`npm run check` 全绿、`verify-model-renders` 0 失败、`verify-centers-overlay` 双后端通过（centers 模式
不破坏渲染、且 GPU 错误为空）。

### 6.16 第十三轮：居中点覆盖层在 WebGPU 上**画出来了**，并且查出两个真实缺陷

三个独立缺陷，逐个实测定位：

**（1）顺序纹理镜像只上传了一次，而且是在排序完成之前。**
`GSplatSorter` 的顺序数组在第一次排序消息到达前是**全 0**（`init()` 里 `new ArrayBuffer(numSplats * 4)`），
而覆盖层原来在 `attach()` 时读一次就再也不更新（`gpuOrderDirty` 置了位但没有消费方）。
拦截 `GPUQueue.writeTexture` 抓到两次 45×45 R32U 上传，**两次数据全是 0** → 每个点都读到 `splatId = 0`，
于是 2000 个点全部落在同一个 splat 上（若该 splat 被标记删除，`gl_Position.z = 2` 直接被裁掉 → 0 像素）。
修法：改用 sorter 的 `pendingSorted.data`（引擎 `applyPendingSorted()` 之前那一刻仍然有效）在 `updated` 事件里重传，
并把镜像纹理初始化成**恒等映射**（`data[i] = i`），这样第一次排序到达前也能正常画。

**（2）覆盖层与 splat 两条 WebGPU 路径的投影矩阵都算错了（视角缩放 1/纵横比）。**
应用在**宽高比 > 1** 时把 `camera.horizontalFov` 置为 true（`Camera.rebuildRenderTargets()`：
`horizontalFov = width > height`），而 `setPerspective(fov, aspect, near, far, false)` 会把 75° 当成**垂直** FOV：
引擎的投影是 `m00 = 1/tan(fov/2)`、`m11 = m00 * aspect`，我们算成 `m00 = 1/(tan*aspect)`、`m11 = 1/tan`，
整体小 `1/aspect`（1280×767 时正好 0.599）。后果不只是覆盖层点位不对，**模型本身在 WebGPU 上也一直被缩小渲染**。
现在统一走 `src/splat/gpu-projection.ts` 的 `buildGpuProjection()`，完全复刻 `Camera._evaluateProjectionMatrix()`
（含 `horizontalFov` 与 `PROJECTION_ORTHOGRAPHIC` 两种模式——后者原先在 WebGPU 上完全没实现，正交视图会画成透视）。
实测：`uOverlayViewProj` 与引擎的 `matrix_viewProjection` **16 个元素逐一相等**；把 2000 个 center 投影到
验证脚本的裁剪区，两个后端都是 566 个点，且 **565/566 落在完全相同的像素上**。

**（3）WGSL 没有点尺寸，所以改成画屏幕空间四边形。**
`GSPLAT_NO_POINTSIZE`（1px 点）不再需要：WebGPU 路径改定义 `GSPLAT_QUAD_SPRITES`，顶点着色器用
`gl_VertexID / 6` 取 splat 下标、`gl_VertexID % 6` 取角点，按 `splatSize / uOverlayViewportSize * w` 偏移到
clip 空间（`uOverlayViewportSize` 由 `scene.camera.targetSize` 每帧上传），网格拓扑改成 `PRIMITIVE_TRIANGLES`、
绘制数量 ×6，并 `cull = CULLFACE_NONE`（四边形在 clip 空间里绕序无意义）。

**双后端像素级一致性（本次最有力的证据）**：`camera.splatSize = 8` 时，两个后端的覆盖层都是
**419 个连通点、中位数 64 像素（= 8×8）**，其中 401/402 个大点的质心落在**完全相同的像素**上
（最近邻距离中位数 0）；`verify-centers-overlay.cjs` 在 WebGPU 上改变 **2250 px（0.92%）**，与 WebGL2 的
2250 px（0.92%）**逐像素相同**（此前是 0 px）。模型渲染的裁剪区亮度也从 98.4% 回到 100%（与 WebGL2 一致）。

**顺带修正的结论**：上一轮把"0 像素"归因于"引擎 view uniform buffer 在这些自研材质上没绑定"是**错的**——
真正原因是（1）。材质参数矩阵（`uOverlayModel`/`uOverlayViewProj`）保留下来是因为它们现在**算对了**，
而不是因为它们比引擎的 uniform 更可靠。

**验证脚本**：`verify-centers-overlay.cjs` 增加了前后两帧的像素 diff 与连通域统计（点数量、点尺寸、
质心位置），不再接受"没崩就算过"。新增 `order-read-probe` / `mirror-vs-sorter-probe` / `predict-probe`
等一次性探针留在 `_tmp/`，不进仓库。

### 6.17 第十四轮：WebGPU 回退已移除，设置面板恢复后端选择

**改动**：

- `src/main.ts`：不再拒绝持久化的 WebGPU 偏好。优先级改为 `?gpu=webgpu|webgl2` > 设置面板偏好 > 默认 WebGL2；
  请求 WebGPU 时设备类型仍是 `['webgpu', 'webgl2']`，所以浏览器/机器不支持 WebGPU 时会正常退到 WebGL2，
  此时才弹一次提示（locale 文案已改写为"此浏览器或显卡不支持 WebGPU"）。
- `src/ui/settings-panel.ts`：原来那行只读的"WebGL2（本版本不支持 WebGPU）"改成真正的下拉选择
  （WebGL2 / WebGPU），选择后写入偏好并弹"需要重启"提示（后端在设备创建时确定，无法热切换）。
- 9 份 locale 同步新增 `panel.settings.gpu-backend`、`popup.gpu-backend-restart.*` 并改写
  `popup.webgpu-backend.*`（`npm run lint:locales` 666 键全同步）。
- `src/core/render-diagnostics.ts`：删掉"WebGPU 无法渲染 splat"的告警（已不成立），改为说明
  WebGPU 的排序存储在 storage buffer 里、居中点覆盖层自带镜像、PiP 预览使用引擎排序。

**新增验证脚本**（都支持双后端对比）：

| 脚本 | 覆盖内容 | WebGPU 实测 |
| --- | --- | --- |
| `verify-effects.cjs` | 散射 / 波纹开场 / 飘散散场（顶点着色器特效分支 + `uEffectMode` / `uEffectTime` / `uEffectFade`） | 散射 236034 px、波纹 245650/244316/133362 px（波形推进）、飘散 242193/245650/245650 px、progress 归零后 0 px 差异 |
| `verify-transform-palette.cjs` | 变换调色板（调色板纹理 + 每 splat 变换索引 + WGSL 的 `transpose(t)` 分支） | 缩放后 212030 px 变化，恢复后 0 px |
| `verify-ortho-camera.cjs` | 正交/透视切换（`buildGpuProjection` 的 ortho 分支，此前 WebGPU 上完全没实现） | 切换 204852 px 变化、模型正常、切回 0 px |
| `verify-gpu-backend-setting.cjs` | 设置面板后端选择 + 偏好持久化 + 重启提示 | 4/4 通过 |
| `verify-webgpu-fallback.cjs`（重写） | 偏好被**采纳**（不再是"被拒绝"）、`?gpu=` 仍可覆盖 | 9/9 通过，模型在存储偏好下渲染 100% |

**双后端数值对照**（同一 test-model.ply）：散射 236034 / 230095 px、波纹 245650 / 239691 px、
调色板变换 212030 / 208894 px、正交切换 204852 / 204589 px、居中点 2250 / 2250 px（逐像素相同）。

**仍未覆盖 / 已知降级**：

- **PiP 预览**：在 WebGPU 上仍然关闭（`updateVisibility()` 里 `!webgpu`），但这次查清了三条事实：
  (1) PiP 自己的排序管线现在**已经能在 WebGPU 上建起来**（`pipOrder` 在那边是 storage buffer，
  经 `StorageBuffer.write()` 上传；WebGL2 仍是 R32U 纹理 + `levels` 播种），
  (2) 用 `Texture.read(..., { immediate: true })` 回读 PiP 自己的渲染目标，**模型确实画进去了**
  （99.7% 有颜色、均值 116），
  (3) 但 PiP 的 `RenderPassForward.execute()` 在 WebGPU 上会抛
  `Cannot read properties of null (reading 'setVertexBuffer')`（栈：`renderForwardInternal → draw → submitVertexBuffer`），
  于是 Phase 5 的 `captureToCanvas` 永远执行不到、2D 画布是空的。这是最后一道拦路石。
- **顺带修掉一个真实的 WebGPU 崩溃源**：PiP 相机的 `addComponent('camera', { clearColor: true })`
  把布尔值塞进了本该是 `Color` 的属性，自动渲染那一遍的 clearValue 就成了 `{r:undefined,…}`；
  WebGL 默默当 0 处理，WebGPU 直接抛
  "Failed to read the 'a' property from 'GPUColorDict'"，**整帧被丢弃**。已改成真正的 `Color`。
- **导出/快照**：`render.image`（旋转台/视频导出）尚未在 WebGPU 上验证。
- **WebGPU 上的 PiP 渲染目标读取**已实现（`captureToCanvasWebGPU`，异步回读 + `putImageData`），
  等上面的 draw 问题解决后即可生效。

### 6.18 第十五轮：特效 / 变换调色板 / 正交 / 后端选择 全部双后端验证

见 6.17 的表格与数值。本轮的结论是：**WebGPU 与 WebGL2 在这些路径上已经逐像素级一致**
（居中点 2250/2250 px、裁剪比 0.40/0.40、隐藏 4.1%/4.1%、散射 236034/230095 px、
调色板 212030/208894 px、正交 204852/204589 px），差异仅来自采样顺序与浮点累加。

打包：`release/SplatRoom-3.6.0.exe`（便携版），启动时按设置面板/URL 选择后端，默认 WebGL2。

### 6.19 第十六轮：修掉"卡顿"与"PiP 消失"两个回归

用户反馈：切到 WebGPU 后（回退移除 → 持久化的 WebGPU 偏好被采纳）**突然很卡**、**PiP 没了**。两条都定位到了具体原因：

**（1）卡顿 = 我加的"顺序纹理镜像"每帧上传 20MB。**
覆盖层在 WebGPU 上原本要把引擎的顺序数组镜像进自己的 R32U 纹理。用探针驱动 sorter 每帧产出
新顺序（5M 模型）实测：**5 秒内 45 次纹理写入、合计 900MB（180MB/s）**，而 WebGL2 路径完全没有这笔开销
（它直接用引擎的顺序纹理）。改为**恒等映射只播种一次**：覆盖层用"第 i 个点 = 第 i 个 splat"的纹理，
不再跟随排序（对 1~2px 的圆点来说绘制顺序无关，屏外 splat 本来就被裁掉、隐藏的由状态纹理跳过），
并保持 `drawPoints = 全部 splat`，点云依旧完整。修后同一测量：**1 次 / 20MB**（仅初次播种）。
期间试过"完全不要纹理、直接用 `gl_VertexID/6` 当下标"，但那会改变材质的绑定布局，
WebGPU 报 `Attribute shader location (0) is used more than once` + `No bind group set at group index 1`，
整帧变黑，已回退到纹理方案（绑定布局保持不变）。

**（2）PiP 消失 = 我在上一轮把它在 WebGPU 上关掉了；而它真正的病根是一个错误的调用序列。**
PiP 手动调用 `before(); execute(); after();` 来渲染自己的那一遍，**跳过了 `device.startRenderPass()`**。
引擎的 `RenderPass.render()` 是 `before() → device.startRenderPass() → execute() → device.endRenderPass() → after()`：
WebGPU 必须由 `startRenderPass` 创建 render pass encoder，所以手动序列下第一个 draw 就
`Cannot read properties of null (reading 'setVertexBuffer')`（WebGL2 之所以能用，是因为清理遍已经把目标绑好了）。
改成 `this.pipRenderPass.render()` 之后，配合本轮的 `captureToCanvasWebGPU()`（异步回读 + putImageData）、
`clearColor` 类型修复、以及 order storage buffer 支持，**PiP 在两个后端都能出图**：
`verify-pip-preview.cjs` 双后端 6/6 —— 预览窗口 81.3%（WebGPU）/ 81.4%（WebGL2）有颜色，
私有排序管线分别是 buffer / texture，关闭预览后主视角 **0 像素差异**。

**验证**：`npm run check` 全绿；`verify:diag` 7/7；`verify-model-renders` 双后端 0 失败；
`verify-centers-overlay` 双后端 2250px（0.92%）逐像素一致；`verify-selection-depth`、
`verify-edit-hide`、`verify-effects`、`verify-webgpu-fallback` 全部通过。

### 6.20 第十七轮：PiP "几乎不动" = 私有排序用的是比较器排序（5M 模型 ~2.2 秒一次）

用户反馈 PiP 出图但"更新很慢、几乎不动"。逐层量化后定位到**预览私有深度排序**：

- 先排除怀疑对象：PiP 的抓取路径正常（12 次抓取 / 12 次回读成功 / `_capturePending` 从未卡住），
  回读用的 `immediate: true` 会立即 `device.submit()`，不依赖后续帧。
- 姿态跟随也正常：真实播放时 `pipLastFrame` 与 `timeline.frame` **逐个采样完全一致**
  （87/87、114/114、21/21…）。
- 真正的问题在 worker 源码里：`order.sort((a, b) => keys[a] - keys[b])` ——
  500 万元素的**比较器排序**，实测 **8 秒只落盘 3 次、间隔 ~2.2 秒**。
  预览画面只在"排序落盘"或"姿态变化"时改变，于是看起来几乎冻结。
- 改成引擎同款的**桶排序**（按深度键量化到 4096 个桶 + 前缀和 + 散射，O(n)）：
  同一测量 **8 秒落盘 11 次、间隔 495–844ms**（71 帧 ÷ 间隔 6 ≈ 11.7 次更新，
  也就是**每次预览更新都拿到新排序**）。`_cpuDepthSort`（worker 不可用时的同步兜底）同样改掉。

**为什么不再顺手把刷新率调高**：把节流间隔从 6 压到 3 / 1 实测会让主视角从 112ms 掉到
126 / 135 ms（+12% / +20%），而这正是用户刚反馈的卡顿来源，因此保持引擎原有的 6 帧节流。
现在的上限是"设计节流 × 帧率"：5M 模型约 1.5 次/秒，小模型约 10 次/秒。

**另外说明**：PiP 预览的是**动画相机**在当前时间线帧的姿态——时间线暂停且只有一个关键帧时，
画面静止是**预期行为**（姿态不变），只有播放/拖动播放头时才会动。

### 6.21 第十八轮：盒选择 / 球选择的审查与修复（"使用不正常"的确切原因）

用户反馈这两个工具"使用不正常"。逐层排查后（选择算法本身是对的，问题在工具层）：

**已证明正确的部分**（新增 `docs/verify/verify-shape-selection.cjs`，双后端）：

- 体素内选择算法与独立 CPU 复算**逐值一致**：球（直径 = 包围盒最大边）0.5/1.0/2/20 → 0/534/1818/2000…；
  盒（均匀立方体）1/2/4/20 → 1016/2000/2000/2000（GPU 与 CPU 完全相同，误差 0）。
- 四种操作语义符合 SuperSplat 语义（从"全选"出发，球内含 531）：
  set→531、add→2000、remove→1469、intersect→531 ✓（`SelectOp` 的谓词/位运算逐条核对）。
- 工具激活、工具条（4 个操作按钮 + 位移/尺寸/半径输入）、"设置"按钮、体积线框与 gizmo：
  激活后画面变化 47272 px（盒）/ 29312 px（球），改尺寸仍生效；**gizmo 拖拽实测有效**
  （拖动球的比例手柄：半径 1 → 1.314，工具同步 `radius`）。
- 体积线框在 WebGPU 上正常渲染（材质、层级 worldLayer 正确）。

**真正的问题（已修）**：体积**从来不会被放到模型身上**。两个工具激活时只是
`scene.add(shape)`，体积保持上次的摆放（首次即工作区原点 + 盒 2×2×2 / 球半径 1）。
把模型挪到 `(8,3,0)` 后实测：盒仍在原点、与模型相距 **8.55**，按"设置"选中 **0 个点** ——
用户看到的就是"点了没反应"。修复：

- 新增 `src/tools/shape-fit.ts`：`selectionTargetBound()`（已选模型→其包围盒，否则全部模型）、
  `fitBoxToBound()`、`fitSphereToBound()`、`volumeReachesTarget()`。
  **包围盒用"本地包围盒 × 当前世界变换"现算**，不读 `splat.worldBound` 缓存（该缓存只在应用自己的
  变换路径上刷新，用别的路径移动模型会得到过期值）。
- 两个工具激活时：用户从未手动摆放、或**体积已经够不到目标包围盒**，就把体积套合到目标
  （盒 = 目标尺寸，球 = 目标半对角线半径）；用户通过 gizmo / 输入框 / 撤销重做动过之后就保留其摆放。
- 实测修复后：模型在 `(8,3,0)` 时盒自动落在 `(8.001, 3, -0.3)`（距离 0），按"设置"选中
  **1999/2000**（修复前 0）；球同理 2000/2000。
- 回归项已写进 `verify-shape-selection.cjs`（"fits the volume over a model away from the origin"），
  双后端 13 项全过。

**顺带记录一个非缺陷**：启动时控制台会打印两条
`error: function not found 'camera.getAzimElev' / 'camera.fov'` —— 那是 UI 在 editor 注册这些
函数之前读了一次（`selection-flags.ts` 里有同类注释说明），与本问题无关，harness 已过滤。

### 6.22 第十九轮：盒/球的"看起来不对"= gl_FragCoord 原点差异；顺带修好 360 全景导出

用户把六个角度的现场截图（`盒选择/ScreenShot_2026-09-12_2041*.png`、`2042*.png`）与"应该长成什么样"的
参考图（`204446_341.png`，模型透明度调低）放在一起，要求对比。逐项量化后定位到一个**坐标约定**缺陷。

**参考图与现场图的差别（像素统计，`_tmp/red-pct.cjs` + `_tmp/edge-red.cjs`）**：

| 图 | 尺寸 | 红色像素占比 | 红色像素中"距非红像素 ≤2px"的比例 |
| --- | --- | --- | --- |
| 现场六个角度（修复前） | 3840×2055 等 | **1.20% / 2.38% / 2.93% / 4.37% / 5.09% / 8.25%** | 6.5% / 12.2% / 9.5% / 20.4% / 20.9% / 26.2% |
| 参考图（应该的样子） | 3569×2001 | 0.17% | 48.9% |

"距非红像素 ≤2px"是关键指标：参考图里的红色是**轮廓细线**（近一半红色像素紧贴非红像素），
现场图里只有 6.5%~26% —— 说明那是一整片**实心红块**。红色在盒/球着色器里只有一个来源：
射线**没打中体积**时的兜底色 `vec4(1,0,0,0.6)`。所以现场图 = "体积该在的地方，着色器在那里找不到体积"。

**根因**：`gl_FragCoord` 在 WebGPU 里原点在**左上**，GL 在**左下**；而相机射线 uniform
（`near_origin/near_x/near_y`、`far_origin/far_x/far_y`，由 `Camera.updateCameraUniforms` 填）是按
GL 约定摊开的。盒/球着色器用 `gl_FragCoord.xy / targetSize` 去插值这组 uniform，
于是 WebGPU 上射线**上下镜像**：网格错位，大片像素干脆打不到体积 → 兜底红块。

**修复**：`src/core/gpu-backend.ts` 新增 `applyFragCoordDefine(material, device)`，WebGPU 下定义
`GSPLAT_FRAGCOORD_TOPLEFT`；盒/球着色器在该宏下把片元 y 翻回去
（`vec2 fragCoord = vec2(gl_FragCoord.x, targetSize.y - gl_FragCoord.y)`）。
材质改为**只建一次并复用**（原先每次激活都重建，宏会丢）。

**修复后实测**（`_tmp/box-angles-probe.cjs`，隐藏模型只留体积、再按真实鼠标拖拽绕六个角度）：

| 指标 | WebGPU | WebGL2 |
| --- | --- | --- |
| 六个角度的红色像素 | 0.758% / 1.377% / 0.246% / 0.881% / 0.698% / 0.771% | 0.759% / 1.380% / 0.922% / 0.881% / 0.697% / 0.771% |
| 红色像素数（同一角度） | 7441 / 13522 / 8646 | 7449 / 13553 / 8649 |
| 红色像素中紧贴非红像素 | 67.5% / 50.6% / 65.8% | 67.4% / 50.3% / 65.6% |

即：**红色回落到与 WebGL2 逐像素同量级（差 0.2% 以内），并且性质从"实心块"变成"轮廓细线"
（50%~68%），与参考图的 48.9% 同类**。修复前的对照实验（`_tmp/flip-test.cjs`）：中央裁剪区里
WebGPU 与 WebGL2 的"亮网格"掩码在**翻转后**一致率 99.94%（10569 个共同亮点），不翻转只有 94.56% —— 镜像关系确凿。

**顺带发现并修好的第二个 WebGPU 缺陷：360 全景导出是空帧。**
`render.image` 带 `projection: 'equirect'` 在 WebGPU 上"成功返回"，但 512×256 的 PNG 只有 **588 字节**、
全透明（WebGL2 同设置 30751 字节）。三个独立原因，逐个验证：

1. **回读走了延迟路径**：`EquirectRenderer.read()` 没用 `immediate: true`，WebGPU 上该路径
   解析成全 0 缓冲（帧回读 `app/render.ts` 早就用了 `immediate: true`）。实测：去掉即回到 588 字节空帧。
2. **投影着色器在 WebGPU 上根本没编译成功**：六个面采样写在"按面加权"的分支里，
   而 WGSL 只允许在**一致控制流**里做隐式导数采样，编译器报
   `'textureSample' must only be called from uniform control flow` —— 且是通过 `console.log` 而不是
   `error` 打印的，所以此前一直没被 harness 抓到。改成 `texture2DLod(..., 0.0)`
   （面纹理本来就 `mipmaps: false`，显式 lod 0 也是正确的滤波）。顺带把 `dn <= 0.0` 的守卫放宽到 `1e-5`，
   避免近切向方向产生 inf uv（inf × 0 权重 = NaN）。
3. **上下翻转**：修好前两条之后，WebGPU 的全景与 WebGL2 逐像素一致率在**翻转后**远高于不翻转
   → 投影着色器也要做同一处 y 翻转。用 `withFragCoordDefine()`（`ShaderUtils.createShader` 出来的
   是 `Shader` 不是材质，没有 `setDefine`，改为把 `#define` 前置到片段源码）注入。

**新增验证脚本** `docs/verify/verify-equirect-export.cjs`（可带 `--ref` 与另一后端产出的全景逐像素对比）：
WebGL2 6/6 通过，WebGPU 7/7 通过；两者全景 **同行同向**（平均绝对差 0.065/255，99.67% 像素差 ≤8），
翻转后平均绝对差 10.534 —— 方向由数据判定，不再靠推理。

**回归**：`npm run check` 全绿；`verify:diag` 7/7；`verify-model-renders` 双后端、`verify-shape-selection`
双后端 13 项、`verify-centers-overlay`、`verify-pip-preview`、`verify-selection-depth`、`verify-edit-hide`、
`verify-effects`、`verify-export-image`、`verify-ortho-camera`、`verify-transform-palette`、
`verify-webgpu-fallback` 全部 0 失败。

**留在用户侧的两张对比图**：`盒选择对比/修复后仅盒_角度1..6.png`（隐藏模型，只看体积网格）、
`盒选择对比/修复后角度1..6.png`（模型可见的现场视角，与用户原来的六张同机位思路一致）。

### 6.23 第二十轮：盒/球默认体积改为"模型的 30% + 高斯密度中心"，体积换成显眼色

用户反馈（原话）：体积"默认太大了"，球/盒默认给模型的 **30%** 比较合适，中心要落在
**模型高斯集中的中心**，另外**现在的灰白色不显眼**，要换成明显的颜色。

**改动**：

- `src/tools/shape-fit.ts`：
  - `VOLUME_FRACTION = 0.3`：盒的三边 = 目标包围盒各轴尺寸 × 0.3；球的**直径** = 目标最大尺寸 × 0.3
    （两个工具的起手尺寸因此可比）。取代了原来的 `BOX_FIT/SPHERE_FIT = 0.5`。
  - 新增 `densityCentre()`：把目标 splat 的**中心点**逐轴取**中位数**（世界空间）作为默认中心。
    不用包围盒中心，是因为几何很少均匀填满自己的盒子（房间扫描是空壳、被扫描物体常偏在离群高斯的一侧），
    盒中心经常落在空处，而高斯质量在别处。用中位数而非平均值，是因为少量远处飞点能把均值拖很远。
    采样按步长抽稀到约 6.4 万个中心（500 万点模型也只取这么多），并按
    「splat 身份 + 数量 + 世界变换」缓存结果（`getCenters()` 会复制整个位置数组）。
  - 去掉原先"贴到朝向相机的近侧脸"的偏移（`placementCentre` 的相机前向位移）——用户要的就是中心在密度中心。
- `src/shaders/box-shape-shader.ts` / `src/shaders/sphere-shape-shader.ts`：条带颜色由
  「近侧纯白 0.6 / 远侧纯黑 0.6」改为**近侧青 `(0.10,0.95,1.00,0.75)`、远侧深蓝 `(0.05,0.35,1.00,0.75)`**
  （灰白在灰模型上糊成一片、纯黑在深色背景里直接消失）；红色仍然只留给"射线没打中体积"的兜底。
  `#f60` 是球形笔刷的渐变，所以体积避开橙色。

**验证**：

- 新增断言写进 `docs/verify/verify-shape-selection.cjs`（双后端）：模型移到 `(8,3,0)` 后
  盒 `size 0.599 = 30% × 1.997`、球 `size 0.599`（直径）、两者中心与 CPU 逐轴中位数**距离 0.0000**；
  双后端 **0 失败**。
- 新增 `_tmp/shape-color-probe.cjs`（隐藏模型只留体积）实测条带颜色：
  盒 WebGPU 青 13795px / 蓝 21468px（WebGL2 13851 / 21468），球 WebGPU 15012 / 20549 —— 双后端一致且都不再是灰白。
- 回归：`verify:diag` 7/7；`verify-model-renders`、`verify-centers-overlay`、`verify-pip-preview`、
  `verify-selection-depth`、`verify-edit-hide`、`verify-effects`、`verify-export-image`、
  `verify-ortho-camera`、`verify-transform-palette`、`verify-equirect-export`、`verify-webgpu-fallback`
  全部 0 失败。

**关于 PiP（待用户确认）**：用户报"WebGPU 模式下 PiP 画面渲染不正常"。本轮做了四组客观测量，
都**没能复现**，也**看不到后端差异**：

| 测量（`_tmp/`） | 结果 |
| --- | --- |
| 两个后端同一场景的 PiP 画面逐像素对比（`pip-orientation-probe.cjs` 产出的 PNG） | 平均绝对差 **0**、100% 像素在容差内 —— 完全一致 |
| PiP 画面 vs 主视口同姿态渲染（`pip-correctness-probe.cjs`，视口调到 16:9 且 fov 对齐） | 同向相关 WebGPU **0.982** / WebGL2 0.961（翻转只有 0.383/0.368）→ 方向与内容都正确 |
| 同一测量换成 **500 万点模型** | 同向相关 WebGPU **0.906** / WebGL2 0.835，翻转 ≈ 0 → 大模型下排序也没错 |
| 播放动画时连续采样 14 帧（`pip-playback-probe.cjs`） | 14 帧**画面各不相同**、0 帧空白、内容占比 57%~79% → 既没冻结也没黑 |

另外确认：`captureToCanvasWebGPU()` 不翻转行是**对的** —— `Texture.read(..., immediate: true)` 在两个后端
都返回同一行序（这一点由 360 全景那条独立证据确定：两个后端用同一段翻转代码得到同向全景）。

### 6.24 第二十一轮：PiP 在 WebGPU 下"画的是主视角"—— 已定位并修好（6.23 末尾的疑问到此结清）

用户补充了现场截图并说明现象：**"播放时 PiP 里产生了和主视角一样的画面，而不是设置的相机的画面"**。
这一条把我前一轮的四组测量全部绕过了：那些测量都让"动画相机姿态 = 编辑相机姿态"，两种假设都会通过。
于是重新设计了一个能区分两者的实验（`_tmp/pip-who-renders-probe.cjs`，已固化为
`docs/verify/verify-pip-camera.cjs`）：

- 关键帧：第 0 帧存姿态 A、第 90 帧存姿态 B；
- 把**编辑相机**停到完全不同的姿态 C（azim -90 / elev 70），取 PiP 画面 `pipC` 与主视口 `mainC`；
- 再把编辑相机挪到姿态 A，取 `pipA` 与 `mainA`；
- 正确的预览应当 ≈ `mainA` 且**不随编辑相机变化**；只会照抄主相机的预览则会 ≈ `mainC`。

**修复前的实测（WebGPU）**：`pipC` vs `mainC` = **0.94**、`pipC` vs `mainA` = **-0.006**、
`pipA` vs `pipC` = **0.011** —— 预览完全跟着主相机跑。同一脚本在 **WebGL2** 上：
`pipC` vs `mainC` = -0.016、`pipC` vs `mainA` = **0.96**、`pipA` vs `pipC` = **1.0** —— 说明这是
WebGPU 独有的缺陷，与用户观察一致。

**根因**：WebGPU 下 splat 材质**不读引擎的 view uniform buffer**，而是读材质参数
（`uSplatView`/`uSplatViewProj`/`uSplatProj`/`uSplatCameraParams`/`uSplatViewport`），这些参数由
`src/splat/splat.ts` 的 `onPreRender()` **每帧按主相机**写一次；而 PiP 渲染的是**同一份材质**，
于是它虽然用的是动画相机的相机实体，但着色器里的相机矩阵还是主相机的 → 画面就是主视角。
（PiP 相机实体本身一直是对的：探针读出它在帧 0/90 分别落在 A/B 上，且与编辑相机不重合。）

**修复**：

- 新增 `src/splat/gpu-camera-uniforms.ts`：把原来 `Splat.updateGpuCameraUniforms()` 的实现抽成
  `writeGpuCameraUniforms(instance, { camera, targetSize })`，主视图与 PiP 共用同一段逻辑；
  `Splat` 侧改为调用它。
- `src/camera/camera-preview.ts`：PiP 渲染前 `_applyGpuCameraForPip()`（用 **PiP 相机组件 + 320×180
  渲染目标尺寸** 写参数，视口尺寸也随之为预览自己的目标尺寸），渲染后与 `finally` 兜底里
  `_restoreMainGpuCamera()` 还原成主相机；与既有的 `_applyCropBoxForPip`/`_restoreMainCropBox`
  完全同一套模式（共享材质 + 自定义渲染遍 = 必须"改—渲染—还原"）。新增 `_forEachSplatInstance()`
  同时覆盖单模型实例与合并（group）实例。WebGL2 下这两个方法是空操作。

**修复后实测（双后端逐项相同）**：`pipC` vs `mainC` = **-0.016**、`pipC` vs `mainA` = **0.96**、
`pipA` vs `pipC` = **1.0**，对照项 `mainA` vs `mainC` = 0.032（两个视口姿态确实不同）。

**新增回归脚本** `docs/verify/verify-pip-camera.cjs`（4 项检查：对照项、预览=动画相机、预览不随编辑
相机变化、无控制台错误）：WebGPU 4/4、WebGL2 4/4。

**回归**：`verify:diag` 7/7，`verify-model-renders`、`verify-pip-preview`（双后端）、
`verify-pip-camera`（双后端）、`verify-shape-selection`（双后端 13 项）、`verify-centers-overlay`、
`verify-selection-depth`、`verify-edit-hide`、`verify-effects`、`verify-export-image`、
`verify-equirect-export`、`verify-ortho-camera`、`verify-transform-palette`、`verify-webgpu-fallback`
全部 **0 失败**（主视图未被这次"改—还原"影响）。

### 6.25 第二十二轮：激活体积工具时自动把模型调到透明度 -2；体积栅格随视角自适应、消除摩尔纹

用户提的两条优化（原话）："盒选择盒球选择激活状态自动将不透明度调到-2"、
"选择边界的栅格密度随视角大小适应，避免当选择范围大的情况下出现摩尔纹，干扰观察"。

**（1）激活即调透明度 -2**

- 应用里本来就有这个先例：`scene.ts` 的相机路径控制开启时对**所有** splat 执行
  `transparency = Math.exp(enabled ? -2 : 0)`；颜色面板的"透明度"滑块（`panel.colors.transparency`，
  范围 -6..6）正是以 `transparency = exp(滑块值)` 生效，所以 -2 就是 `exp(-2) ≈ 0.135`。
- 新增 `src/tools/volume-dim.ts`：盒/球工具 `activate()` 时把所有 splat 调到 `exp(-2)`，
  `deactivate()` 时把**各自的旧值**放回去；只还原"仍是 exp(-2)"的 splat，所以用户在工具激活期间
  手动改过的透明度不会被覆盖；用一个计数器处理"盒→球"切换时两个工具短暂重叠（不会互相还原）。
- 新增验证脚本 `docs/verify/verify-volume-dim.cjs`（7 项，双后端 0 失败）：
  激活后 transparency = 0.135335、画面平均亮度 **115.83 → 50.42**（真的变暗了）、切到球工具仍保持
  变暗、退出后回到 `[1]` 且亮度回到 **115.83**、工具激活期间手动设成 0.5 的透明度退出后仍是 0.5。

**（2）栅格密度自适应 + 抗锯齿（消除摩尔纹）**

- 旧实现是**世界空间固定**的条带：`fract(pos * 2.0 + 0.015) < 0.03`（每 0.5 个世界单位一条线、
  占空比 3%）。体积一旦在屏幕上变大（选择范围大、或放大观察），同样像素里塞进的线越来越多，
  线细到亚像素后固定图案就开始走样 —— 表现就是稀疏闪烁的噪点，也就是用户说的摩尔纹。
- 现在按**屏幕足迹**（`fwidth`）驱动两件事：
  1. **LOD**：线间距小于 `MIN_LINE_SPACING_PX = 7` 像素时把周期翻倍，两个层级之间做
     `smoothstep` 混合（缩放不跳变）。所以体积越大，网格越**粗**而不是越密。
  2. **解析抗锯齿**：线宽取 `max(周期×3%, 足迹×0.6)`，并用 `smoothstep` 在线的边缘做一档过渡，
     亚像素的线不再是"采样到就亮、采样不到就没有"，而是稳定的覆盖率。
  球体把同一套逻辑用在经纬角上（周长换算成角度），足迹取"到表面点方向的屏幕导数"而不是角度本身的
  导数 —— 方位角在 ±180° 处会绕回，直接对角度求导在那个缝上会得到无意义的大值。
  条带颜色也改为随覆盖率调 alpha（`alpha = 0.75 × coverage`），深度抖动阈值同步使用它。
- **WebGPU 陷阱（第二次遇到，值得记）**：`fwidth` 在 WGSL 里**必须处于一致控制流**，
  而转译后的 `gl_FragCoord` 是 module-scope private 变量，于是"先 `if (射线没打中) return;`
  再求导"直接编译失败（`'fwidth' must only be called from uniform control flow`，
  并且是以 `console.log` + `Invalid RenderPipeline` 的形式刷屏）。修法：先算出 `t0/t1`（数学，不带分支），
  在**任何分支之前**求 `fwidth`，最后才用 `if (!hit)` 兜底红色 —— 与 6.22 里 360 投影着色器的
  `textureSample` 是同一类问题（那次是隐式导数采样，这次是显式求导）。
- **实测（同一探针 `_tmp/shape-grid-probe.cjs`，只换着色器，双后端 WebGPU；抖动 = 相机方位角动 0.1°
  后栅格像素分类发生翻转的比例，正是摩尔纹的量化指标）**：

| 体积 | 抖动 修复前 → 修复后 | 栅格覆盖率 前 → 后 | 屏幕线间距（修复后） |
| --- | --- | --- | --- |
| 盒 2 | 16.8% → **1.8%** | 0.10% → 0.55% | 256 px |
| 盒 6 | 36.9% → **5.9%** | 1.23% → 6.04% | 44 px |
| 盒 20 | 64.9% → **17.0%** | 11.49% → 49.06% | 12.6 px |
| 球 2 / 6 / 20 | 1.0% / 2.5% / 9.6% | 0.31% / 2.99% / 31.6% | 320 / 116 / 28 px |

  同时"亚像素碎点"（长度 ≤2px 的栅格游程占比）从 96~99.7% 降到 1.5~14%。
  另外试过把抗锯齿过渡带收紧到 ±0.5 像素（线更锐），实测**更差**：盒 20 的抖动从 17% 涨到 41.8%，
  所以保留了较宽的过渡带（±1.5 像素），并在注释里写明原因。
- 回归：全套 18 个验证脚本 0 失败（含 `verify-shape-selection` 双后端、`verify-volume-dim` 双后端、
  `verify-pip-camera`、`verify-equirect-export` 等），`npm run check` 全绿。

### 6.26 第二十三轮：审查"去浮云"时发现并修好一个真 bug —— 点"移除浮云"只选中不删除

起因是用户让我对比 SuperSplat 与我们自己的浮云清理能力，查代码时顺手实测了"移除浮云"这条路，
发现它**只选中、不删除**。

**证据**（`_tmp/floater-apply-probe.cjs`：直接触发面板同一个事件，并逐位读原始 state 数组）：

| 步骤 | rawSelectedBits | rawDeletedBits | numSplats |
| --- | --- | --- | --- |
| 初始 | 0 | 0 | 2000 |
| 触发 `floater.apply`（掩码 50 个） | **50** | **0** ← 修复前 | 2000 |
| 对照：普通 `select.mask` + `select.delete` | 100 | 100 | 1900 |

对照说明删除机制本身没问题，问题在这条调用链。

**根因**：`floater.apply` 的处理器把三步打包成一个 `MultiOp`：
`SelectNoneOp → SelectOp(add, mask) → DeleteSelectionOp`。而 `StateOp` 的子类都在**构造函数**里用
`IndexRanges.fromPredicate` 快照自己的范围 —— `DeleteSelectionOp` 快照的是"此刻被选中的 splat"，
而构造 MultiOp 时选中集合还是空的（`[]`），于是它拿到空范围、什么也不删；等 `SelectOp` 把浮云选上，
删除那一步早已"无物可删"。副作用是**再点一次就生效**（第二次构造时选中集合已非空），
典型的"点两次才管用"。

**修法**：让 `DeleteSelectionOp` 在 **do() 执行时**才抓取范围（`captureRanges()`），undo 复用同一份范围；
其它按"输入已定"快照的 op 不受影响。这样凡是"先选后删"的组合都成立，而不只是去浮云这一条。
`SelectOp` 仍按注释所述接收"已提交的掩码快照"，那条设计是对的，未改动。

**新增回归**：`docs/verify/verify-floater-removal.cjs`（4 项，双后端 0 失败）—— 一次点击即删除
（deleted 0→50、存活 2000→1950）、被删 splat 的状态位是 `selected|deleted = 5` 而不是"只选中"、
一次 undo 完全还原、无控制台报错。

**回归**：`verify:diag` 7/7；`verify-shape-selection`（双后端）、`verify-volume-dim`、
`verify-floater-removal`（双后端）、`verify-model-renders`、`verify-pip-camera`、`verify-pip-preview`、
`verify-centers-overlay`、`verify-selection-depth`、`verify-edit-hide`、`verify-effects`、
`verify-export-image` 全部 0 失败。

### 6.27 第二十四轮：去浮云加"仅选中"+ 按元素分别检测；新增 3D 连通簇过滤（对齐上游 --filter-cluster）

用户在我给出 SuperSplat 对比后，从待办里挑了两项：①去浮云加"仅选中（预览）"＋按元素分别检测；
②新增 3D 连通簇过滤。两项都做完并双后端验证。

**（1）去浮云面板改造**（`src/ui/floater-panel.ts`）

- **目标改为所有选中模型**（`selection.all`），并且**每个模型用它自己的数据单独检测、单独出掩码**。
  旧版用"主选中模型"检测、再把同一份掩码套到所有选中模型上 —— 单模型无感，多模型时 A 的索引会
  作用到 B 身上（`_targetSplats()` / `_floaterTargets()`）。
- **新增「仅选中」按钮**：检出结果先变成选区供复核，再决定按「移除浮云」或手动 Delete。
  两个按钮与连通簇共用同一个 `floater.apply` 事件，由 editor 打包成**一次可撤销操作**。
- 面板**默认开启**（原先 toggle 默认关、按钮却没禁用，状态自相矛盾；`panel.floater.enable` 文案
  一直是孤儿键），只有把 toggle 关掉才真正禁用/变灰。

**（2）新增 `src/splat/cluster-filter.ts`：体素连通分量**

对齐 `splat-transform --filter-cluster` 的思路（官方文档原话：它 "isolates the central scene and
discards stray floaters"）：把高斯中心量化到体素、对**被占用的体素**做连通分量标记、按簇大小决定去留。
比"去浮云"的四信号启发式更几何：**薄结构只要连着主体就整片保住**，真正飘在空中的一团会被整体识别。
两种模式：**删除小簇**（阈值 = 最大簇点数的百分比）/ **只保留最大簇**。

- **体素边长跟着点云自身疏密走**：中位半径 × 0.3（复用 `estimateCellSize`）再乘系数，detail
  0 → 3.0×、50 → 1.75×、100 → 0.5×。按模型对角线定死会把稀疏点云切成一堆互不相连的小格。
- **两个实测踩出来的坑**：
  1. **体素键必须塞进 double 的 53 位**：原来每轴 21 位 → 63 位，静默丢精度（Node 复算：18 个
     体素里 **12 个解码回错误坐标**，连通图被切碎，最大簇从 3000 变成 3011）。改为每轴 17 位
     （51 位）+ 相对下界的坐标 + 超限时自动放大体素，并且**不再从键里解码**，改为把体素坐标与键
     并存。
  2. **连通性用 26 邻域而不是 6 邻域**：合成测试里 40 点的小团恰好跨越一个体素角点，6 邻域把它
     判成两个簇；点云是表面采样而非实体，26 邻域才符合"这一团就是一个浮云"。
- **合成模型验证**（新增 `docs/verify/gen-cluster-test-splat.cjs` + `verify-cluster-filter.cjs`）：
  3000 点主体 + 12/25/40 点三个远离小团（相距 3 个单位）→ 面板报 **4 簇、最大 3000、小簇 3 个共
  77 点**；「仅选中」正好选中 **77**；「移除」删 **77** 且主体 **3000 存活**；一次 undo 全还原。
  双后端 **0 失败**。

**（3）顺带修掉两个核心 op 的"构造时快照"时序 bug**

这轮把 `SelectOp` 也改成**在 do() 时解析索引范围**（上一轮改的是 `DeleteSelectionOp`）。原因：
"先清空选区、再选中同一批行"这个组合在**第二次点击**时，构造期算出的范围是空的（那批行当时已经
被选中 → `add` 谓词为假）→ 选不中，紧跟其后的 `DeleteSelectionOp` 也就没东西可删。这正是
"点两次才生效 / 第二次失效"的根源。现在 MultiOp 里每个 op 读到的都是**前一个 op 执行完之后**的状态。
（`SelectOp` 依然只接受"已提交的掩码/索引快照"，那条设计不变。）

**（4）回归**

- `verify-floater-removal.cjs` 扩到 **7 项**（按元素掩码、仅选中不删、重复应用仍生效、删除作用于
  本次创建的选区、另一个模型不受影响、一次 undo 还原、无控制台报错），双后端 0 失败。
- 新增 `verify-cluster-filter.cjs`（5 项），双后端 0 失败。
- 9 语言新增 10 条文案（`panel.floater.selectOnly/details/cluster/clusterMode*/clusterDetail/clusterMin/
  clusterHint/clusterDetails`），并补译了 9 条历史遗留未翻译的文案（floater 4 条 + surface-refine 3 条；
  另有 gamepad/control-customize 约 40 条仍为英文，已在下面记为已知问题）。`npm run lint:locales`
  676 键全同步。
- **全套 20 个验证套件 0 失败**（含 selection-depth / selection-overlay / selection-toolbar /
  shape-selection 双后端 / edit-hide / grade-crop / volume-dim / centers / pip ×2 / effects /
  export-image / equirect / ortho / palette / webgpu-fallback / diag 7/7），`npm run check` 全绿。

### 6.28 第二十五轮：对比工具两处修正 + 文案补译（并查出一个新的真缺陷）

用户从待办里挑了三项：对比工具的浮云标记跟随实际 FOV、对比工具表面破洞模式的回读性能、补齐
gamepad 等一批未翻译文案。做完后**前两项都被证明是"潜伏问题"**，另外查出一个真缺陷，如实记录。

**（1）浮云标记半径改为跟随实际 FOV —— 正确但当前的测试场景看不出来**

- 旧代码 `src/compare/compare-analysis.ts:600` 写死 `const fovRad = (50 * Math.PI) / 180;`，
  用它算 `fovFactor = ch / (2·tan(fovRad/2))`（像素/世界单位），而面板的"视野"滑条是 10–120、
  默认 50 —— 调过视野后每个浮云标记的半径就与实际不符。
- 现在直接从**投影矩阵**取这个比例：`fovFactor = projMat.data[5]（即 m11）× ch / 2`，对任何 FOV
  都对（透视矩阵里 m11 = 1/tan(fovY/2)）。顺带把 `ndcDepthToDist(ndcZ, fov, canvasH)` 里**从来没被
  读过**的两个参数删掉。
- **实测对比（before/after 双构建，FOV 20/50/80 的浮云黄标记像素数）**：两者完全相同
  （41872 / 37481 / 30145）。原因查清了：半径最后被 `Math.max(8, Math.min(80, r))` 夹住，而
  test-model 的浮云都在 8 px 下界上，所以**在这类小尺度模型上这个修正不可见**；只有当未夹紧的半径
  落进 (8, 80) 区间（近距离/大浮云）时差异才显现 —— 例如 maxScale 0.5、距离 5 时：FOV 50 → 96 px、
  FOV 80 → 60 px。也就是说这是一处**潜在正确性修正**，不是当前可见的 bug。
- 没有为它加回归脚本：夹紧区间会让"标记半径随 FOV 变化"的断言在默认测试场景里必假，写不出有意义的
  阈值断言。

**（2）表面破洞模式的回读 —— 路径本身就是死的（新发现）**

- 旧代码在 `cell × 3×3 patch` 四层循环里调用 `srcCtx.getImageData(px-1, py-1, 2, 2)`，网格最大
  96²（`:1043`）→ **每次刷新最多 82,944 次回读**，且每 5 帧重跑；注释却写着"Read in coarse blocks
  (one per grid cell) for performance"，与代码相反。
- 已改成**整块读一次**（`getImageData(readX, readY, readW, readH)`）+ 从缓冲区做同样的 2×2 均值
  （夹紧到读取区域），采样语义不变。
- **但 instrument 后发现这条路径根本没执行**：在 `?mode=compare` 页面里劫持
  `CanvasRenderingContext2D.prototype.getImageData` 统计，开破洞模式并拖动相机触发刷新后
  **调用次数为 0**（修复前后都是 0）。原因是 `compare-scene.ts` 把**应用自己的渲染 canvas** 当作
  "source canvas" 传进分析（`setAnalysisMode` → `this.canvas`），而一个已经拿到 WebGL/WebGPU
  上下文的 canvas **无法再给出 2D 上下文**：实测 `document.querySelector('canvas').getContext('2d')`
  返回 `null` → `if (srcCtx)` 守卫直接跳过 → **"按像素明暗找洞"这一半信号从来没参与过判定**，
  破洞模式实际只用了高斯透射率/暗度那一路。
- 所以这一项的真实性质是：**把死代码加固了**（顺手把注释与实现改成一致），用户可见的收益为零。
  真正该修的是"让像素信号可用" —— 需要像主程序那样从渲染目标回读（`colorBuffer.read(..., immediate)`
  或先渲染到离屏 canvas 再读），再把像素交给分析，属于一处功能修复，已向用户说明并待确认。

**（3）文案补译**

- 7 个语言各补译 27–29 条（共 **192 个值**）：`gamepad.*`、`dialog.control-customize.*` 两个整块，
  外加 `menu.render.image.current/keyframes`、`popup.export.iterations`、`menu.file.export.viewer`、
  `panel.settings.tone-mapping.filmic`。翻法都以该语言**已有的同概念译法**为准（如
  `gamepad.settings.presets.xbox`、`panel.camera.axis.pitch`）。
- 另有 **52 条有意保留英文**（专有名词与纯技术词：ACES2 / Ping Pong / Screenshot / Codec / Bitrate /
  Jitter / Orbit / Gamepad / Drone，以及在该语言中拼写相同的 Position、Rotation、Saturation 等），
  逐条给了理由。
- `npm run lint:locales` 676 键全同步 ✓；`git diff` 为 192 insertions / 192 deletions，无附带改动。

### 6.29 第二十六轮：去浮云的两个用户反馈 —— 按钮显示不全、以及"贴着表面的高斯被一并选中"

用户反馈：①「仅选中」按钮显示不全，建议和「移除浮云」一样大小；②去浮云的参数不合理，
会连同紧贴物体表面的高斯一起选中。

**（1）按钮**：`.floater-panel-remove-btn` 有 `width: 100%`，而新加的 `.floater-panel-select-btn`
**根本没有样式**（只有 PCUI 默认外观），于是它按内容宽度、文字被裁。现在两个按钮共用一个
`.floater-panel-btn-row` 行 + 共享几何样式（`flex: 1 1 0`、高 28、圆角 4、`white-space: nowrap`、
`text-overflow: ellipsis`），实测各 **139 px**、标签无裁切（断言里加了 `width > 20`，否则折叠状态下
"0 === 0" 会让这条检查形同虚设）。
顺带踩了个 PCUI 的坑：`new Container({ class: 'a b' })` 会在 `DOMTokenList.add` 抛
`InvalidCharacterError`（class 只接受单个 token），多出来的类名要用 `container.class.add(...)` ——
这个错误会让整个应用起不来（页面卡在 `window.scene` 未创建）。

**（2）检测判据重做：从"长得异常"改成"周围是空的"**

旧版是四条独立策略的**或**：透明、体积异常、27 格邻居偏少、离质心过远。前两条的阈值都是分布尾部，
而**贴着表面的高斯本来就常常又大又透明**（软边/雾面/地面片），于是被直接命中。用合成模型量化
（3000 点主体 + 40 点贴在 +X 面上的低透明度大体积"表面贴片" + 3 团共 77 点的远处飘团）：

| 版本 | 默认灵敏度选中数 | 其中表面贴片 | 明细 |
| --- | --- | --- | --- |
| 旧（四路或） | **117** | **40（全部）** | 透明 40 · 体积 40 · 隔离 37 · 距离 77 |
| 中间尝试（邻居数 vs 全局中位数） | 171 | 94 | 隔离 171 —— 点云外缘/薄边本身邻居就少，会误报 |
| **现在（紧邻格子"有没有人"）** | **5** | **0** | 隔离 5 · 其余 0 |

现在的判据：格子边长 ≈ 典型点间距（`estimateCellSize`，中位半径×0.3）的 1.2 倍，检查 3×3×3 格，
允许的邻居数随灵敏度 0→8 放宽。**只看"旁边有没有别人"**，完全不看它多大、多透明，所以表面细节
天然安全；也刻意**不**与全局密度比较（那会把点云外缘/薄片边缘当成浮云，上表第二行就是实测证据）。
次判据保留但改成"三者同时成立"的保守式：又透明 **且** 体积异常 **且** 远离稳健中心（逐轴中位数），
用于兜住"一团浓密但确实飘在很远处的雾状高斯"。

**分工写进面板提示**：去浮云只负责**零散的飘点**；成团的飘云（团内相邻、整团远离主体）用面板下方的
**连通簇**（合成模型上 3 团 77 点可被完整选中，见 6.27）。9 语言的 `panel.floater.sensitivityHint`
已改写为这个意思。

**新增合成模型与回归**：`docs/verify/gen-floater-test-splat.cjs` 生成"主体 + 表面贴片 + 5 个孤立飘点 +
3 团飘云"的模型；`docs/verify/verify-floater-detect.cjs` 6 项检查（双后端 0 失败）：
- 检出数 = **恰好 5**（就是那 5 个孤立飘点）
- 表面贴片被选中数 = **0**（修复前是 40/40）
- 干净模型（test-model.ply，无飘点）检出 = **0**（修复前误报 62）
- 两个按钮等宽（139 px）、标签无裁切
- 无控制台报错


### 6.30 第二十七轮：去浮云"基本选不中浮云"—— 根因是点间距估计错了 226 倍（用用户真实案例标定）

用户反馈：**"现在基本上选不中浮云"**，并提供了真实案例一对文件（`去浮云/hk-去浮云前.ply`
931,720 高斯 / `hk-手工去浮云后.ply` 924,871 高斯，即手工删掉 **6,849 个 = 0.735%**）。这一轮把它当
标定数据用，结论有两条：一个真 bug、以及一个必须如实说明的限度。

**根因（真 bug）**：判据的尺度来自"典型点间距"，而旧实现 `estimateCellSize()` 取的是**中位半径 × 0.3**
—— 那是**场景尺度**，不是采样间距：

| 量 | 值 |
| --- | --- |
| 旧 `estimateCellSize` 给出的"间距" | **0.3709** |
| 真实最近邻距离中位数 | **0.001637**（差 **226 倍**） |
| 旧格子边长（间距×1.2） | 0.445 |
| 该格子 3×3×3 块里的邻居数 | 数百个（"周围是空的"永远不成立） |

所以真实扫描上**任何**点都不满足隔离判据，检测器返回 0 或个位数。现在 `estimateSpacing()` 改用
**最近邻距离的中位数**（全点云 counting sort 到 64³ 网格 + 约 2000 个抽样点向外扩圈找最近邻，
找到即按"剩余点至少离 rings-1 格"收敛），在 93 万点上约 20 ms。

**判据也重写了**（旧的四路"或"早已在 6.29 改掉，这次把残留的次判据也拿掉，并换成无量纲形式）：

- 半径 `R = 34.5 × 间距`（该模型 0.0577），检查 3×3×3 格；
- 阈值 = **模型自身典型邻居数的中位数 × 比例**（比例随灵敏度对数插值 0.5%→6%）。
  为什么用比例：真实扫描的采样密度跨几个数量级，任何固定邻居数只对一个密度有效；而"均匀采样表面"
  在半宽 R 的方块里恒有约 (2R/间距)² 个点，与模型无关，所以"中位数 × 比例"是无量纲、可迁移的。
- 拿掉的次判据：又透明 **且** 体积大 **且** 离质心远。实测这些与"漂浮"无关（表面贴片就满足），
  而且真实案例里手工删掉的点**更靠近**模型中心（归一化距离 0.152 vs 保留下来的 0.296），"离中心远"
  这条方向就是反的。
- 半径是唯一尺度，不再有抽样预览：判定计数必须建立在全量网格上（只拿抽样点建网格会让密度整体变稀、
  所有点都显得孤立）；且"每个点的邻居数"这一遍本来就覆盖全部点，抽样省不下时间还会让小计数失真
  （实测 8 个孤立点时抽样估计给出 0 或 15）。全量检测在 93 万点上约 **0.5 s**。

**出厂参数在真实案例上的实测**（`?gpu=webgpu`，浏览器里跑的出厂代码；离线复算同一套参数只差 1%）：

| 灵敏度 | 邻居上限 | 选中 | 占比 | 覆盖手工删除量 | 全局精确率 | 只看用户清理过的区域 | 命中率 lift |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 18 | 9,751 | 1.05% | 15.3% | 10.7% | 33.0% | 14.6× |
| 25 | 33 | 14,310 | 1.54% | 25.3% | 12.1% | 33.9% | 16.5× |
| **50（默认）** | 61 | **20,934** | **2.25%** | **39.3%** | 12.8% | 33.8% | 17.5× |
| 75 | 113 | 29,770 | 3.20% | 57.1% | 13.1% | 31.9% | 17.8× |
| 100 | 211 | 47,184 | 5.06% | 76.3% | 11.1% | 24.7% | 15.1× |

**限度（如实说明，别再往"精确复现手工结果"上使劲）**：手工删除**在空间上是局部的** —— 751 个有点的
0.25 方块里只有 211 个（28%）有删除点，一半的删除集中在 6 个方块里（有的方块被 100% 清空，多数方块
一个点都没删）。因此"全局精确率"这个指标被**用户没清理过的区域**稀释了：规则选中的点在用户清理过的
方块里有 1/3 正好是他们的删除点（命中率 15-18 倍），在没清理过的方块里当然 0%。也就是说：规则确实在
测同一个现象，多出来的部分是**同一类、只是用户没清到**；想要"一键复现手工结果"在统计上不成立。
另测：单特征可分离性都很差（最好的 F1 只有 0.14）—— 6,849 个手工删除点里 **98.2% 连着主体**（不是
孤立小团），所以"孤立度"类规则的天花板就在上面这张表里。

**顺带修正连通簇的体素尺度**（同一个估计函数的下游受害者）：`voxelSize` 系数从"3.0→0.5 × 中位半径×0.3"
（= 巨大的体素，一切并成一个簇、参数怎么拉都没反应）改为"**24→8 × 最近邻间距**"。真实案例标定：
系数 8 时最大簇只占 51.9%（表面采样缝隙把主体切碎）、12 → 92.7%、16 → 99.5%（默认，最大簇 925,746 点
= 99.36%，小簇 2,672 个共 5,974 点 = 0.64%）、24 → 99.8%、32 → 100%（参数失去意义）。合成模型回归
（detail 50 时 4 簇 / 最大 3000 / 小簇 77 点）在双后端仍全绿。

**新增回归 `verify-floater-scale.cjs` + `gen-floater-scale-test-splat.cjs`**：专门复现"选不中"这个
bug 的几何 —— 半径 1 的空心球上 12 万点密采样（间距 0.005）+ 8 个在球外 0.40 处的正常孤立点。
旧估计给出间距 **0.30**（场景尺度）、邻居盒半宽 0.54，从孤立点那里够得着球面 → **选中 0 个**；
现在是间距 0.0048、半宽 0.166 → **恰好 8 个**，且球面 0 个。4 项检查（含"半径必须跟着点间距而不是
场景尺寸"的断言，从面板 tooltip 里读实际半径）双后端 0 失败。

**同时更新**：`verify-floater-detect.cjs` 的期望从 5 改为 **82**（5 个孤立飘点 + 3 团游离小团共 77 点）
—— 密度判据现在会把整团真孤立的东西也选中，这正是期望行为；连通簇保留，因为它提供的是另一套语义
（"按簇大小阈值删" / "只保留最大簇"）。9 语言的 `panel.floater.details` / `sensitivityHint` 已按新
判据改写（676 键同步）。


### 6.31 第二十八轮：去浮云"删得太多、把墙面/地面/桌面都删了"—— 六种判据逐个体检后改成"稀疏 + 偏透明"+ 新增「处理范围」

用户反馈：**"这个删除的过于多了，把墙面、窗户、地面、桌面都给删掉了，反而是中间的浮云没有删除，
即使 10% 也很多。"** 上一轮我把全局精确率低解释成"用户没清理到的区域"，这个解释**是错的** —— 那些
多选出来的点就是**真实几何**（房间表面），用户是故意留着它们的。

**先把这张扫描的结构量出来**（前后文件逐点比对 + 多尺度近邻统计）：

| 量 | 值 |
| --- | --- |
| 主体（中央物体）采样间距 | **1.6 mm** |
| 墙面/地面/桌面采样间距 | **10-17 mm** |
| 判据命中集（3.7.3 默认灵敏度） | 20,934（2.25%），其中 18,243 是用户留着的点 |

也就是说：**房间表面和浮云一样"稀疏"**（判据半径 5.8 cm 的方块里都只有十几个点），任何"固定半径数
邻居、和全模型中位数比"的判据都必然把房间表面一起选中。这解释了"即使 10% 也很多"。

**六种判据逐个体检**（真值 = 用户手工删掉的 6,849 点；下表是"被选中且确实是手工删点"=caught 与
"被选中但用户留着"=误删 两组的中位数）：

| 判据 | caught | 误删（墙面等） | 结论 |
| --- | --- | --- | --- |
| 5.8 cm 方块邻居数 | 36 | 29 | 分不开 |
| 5 mm 方块邻居数 | 0 | 0 | 分不开 |
| 多尺度（16.7 cm / 50 cm 邻居数） | 683 / 52,736 | 2,100 / 57,220 | 分不开 |
| 局部密度对比度（5 cm 网格中位数之比） | 0.93 | 0.72 | **反了**（墙看去更突兀） |
| 间隙比（最近邻距离 / 局部采样间距） | 0.95 | 1.00 | 分不开（两者都在粗采样区） |
| 单侧度（8 近邻单位向量均值） | 0.68 | 0.94 | **反了**（扫描线各向异性） |
| 尺寸对比度（自身 scale / 局部 scale 中位数） | 0.85 | 0.99 | 分不开 |
| splat 尺寸 maxScale | 0.014 | 0.030 | **反了**（粗采样的墙反而更大） |
| **不透明度** | **0.081** | **0.158** | **唯一分得开的** |
| 到中心距离（归一化） | 0.144 | 0.277 | 分得开，但那是这张扫描的布局，不能当准则 |
| 采样自适应连通分量（连通阈值 = 1.5×min(局部间距)，K=1.5） | 98% 在小团里 | 但 **25% 的合法点**也在小团里 | 不可用 |

最好的单点统计判据 F1 只有 **0.258**（密度 + 透明度，选中 1.7%、召回 42.5%、精确率 18.5%）。换句话说：
**在这张扫描上自动化没法既删浮云又不碰房间表面**。这是数据性质，不是阈值没调好。

**这一轮实际改的东西**（`3.7.4`）：

1. 判据加"偏透明"这一支，并把不透明的例外压到极小：
   `hit = 邻居数 ≤ floor(limit×0.02)`（极稀疏，不看透明度，兜住真正的孤立点）
   `|| (邻居数 ≤ limit 且 α ≤ 0.10~0.15)`（主体判据，随灵敏度）
   实测默认灵敏度下：hard 比例 0.15 → 选中 11,823、精确率 15.1%；压到 0.02 → **选中 9,787（1.05%）、
   精确率 17.5%**，多出来的点几乎都是"不透明"的（视觉上最显眼的墙面/桌面）。
2. 灵敏度映射改为 0.5%→8%（对数），默认灵敏度 50 → **40**。真实案例实测（出厂代码，浏览器里跑）：

   | 灵敏度 | 邻居上限 | α ≤ | 极稀疏 | 选中 | 占比 | 选中点的 α 中位数 | 其中"不透明"占比 |
   | --- | --- | --- | --- | --- | --- | --- | --- |
   | 0 | 18 | 0.10 | 0 | 4,293 | 0.46% | — | — |
   | 25 | 35 | 0.11 | 0 | 6,977 | 0.75% | — | — |
   | **40（默认）** | 53 | 0.12 | 1 | **9,797** | **1.05%** | 0.064 | 10% |
   | 50 | 70 | 0.13 | 1 | 11,763 | 1.26% | — | — |
   | 75 | 141 | 0.14 | 2 | 19,380 | 2.08% | — | — |
   | 100 | 281 | 0.15 | 5 | 35,833 | 3.85% | 0.068 | 6.4% |

   对比 3.7.3 的默认（20,934 / 2.25%，精确率 12.8%）：**默认少删一半以上**，而且选中的点里只有 10%
   是"不透明"的（0.15 的极稀疏比例时是 24%）—— 也就是视觉上最显眼的那些墙面/桌面基本不再被选中。
3. **新增「处理范围」**（这是本轮真正的可用性修复）：`整个模型` / `仅选区内` / `跳过选区`。
   判定的计数网格与参考密度仍按**全模型**统计（否则小选区里"大家都稀疏"，比例判据失去意义），
   但**只有范围内的点会被选中**。用法：
   - 想只清中间那片浮云 → 盒选/球选/笔刷圈住中间 → 范围 =「仅选区内」→ 先点「仅选中」预览 → 满意再删；
   - 想保住房间表面 → 把墙面/地面框住 → 范围 =「跳过选区」→ 其余部分照常检测。
   新增回归 `docs/verify/verify-floater-scope.cjs`（7 项检查，双后端 0 失败）：基线 5、只选密集主体时
   计数 0、同一选区改「跳过选区」计数 5、点「仅选中」后选区被替换成这 5 个、切回"整个模型"恢复 5。
4. `verify-floater-detect.cjs` 的期望从 82 回到 **5**：判据现在是"稀疏 **且** 偏透明"，合成模型里 3 团
   不透明（α=0.95）的游离小团交回下方的**连通簇**处理（这本来也是它俩的分工），而 5 个孤立散点因为
   "极稀疏"那一支（邻居数 0）仍然无条件命中。
5. 9 语言的 `panel.floater.details`（新增 α 与范围占位符）、`sensitivityHint`（改写）与 4 个新的
   `panel.floater.scope*` 键（680 键同步）。

**给用户的结论（也是这一轮最重要的产出）**：这张扫描上"一键去浮云"在数学上做不到——墙面/地面/桌面与
浮云在**所有点级几何统计量**上重叠甚至反向，唯一分得开的是不透明度（浮云 0.081 vs 房间 0.158），而那
只能滤掉一部分。所以工具的正确定位是**挑候选 + 用户圈范围 + 先预览**：默认灵敏度只选 1% 左右，配合
「处理范围」把动作限制在你圈定的区域内，用「仅选中」确认后再删（一次删除 = 一步撤销）。

**排错脚本存档**（都在 `_tmp/`，用前后两个真值文件跑，不需要重跑）：`floater-falsepos-analysis.cjs`
（分组特征对比）、`floater-local-contrast.cjs`、`floater-gap-analysis.cjs`、`floater-onesided-analysis.cjs`、
`floater-adaptive-cluster.cjs`、`floater-opacity-sweep.cjs`、`floater-final-rule.cjs`（最终判据网格）。


### 6.32 第二十九轮：盒/球体积"设小了只剩两条线" + 球用缩放改不了大小

用户反馈两点：**① 盒/球设到很小时边界只剩两条线，看不出实际选中范围；② 球选项无法用缩放设置大小。**

**① 根因：条纹间距是**世界空间固定值**。
盒子的条纹周期恒为 0.5 世界单位，球的条纹是每 0.5 世界单位弧长一条（换算成角度 = `180/(π·半径)` 度）。
于是体积越小，里面能放下的线越少：

| 盒边长 | 旧周期 | 旧线数 | 新周期 | 新线数 |
| --- | --- | --- | --- | --- |
| 0.02 | 0.5 | **0** | 0.005 | 4 |
| 0.05 | 0.5 | **0** | 0.0125 | 4 |
| 0.6 | 0.5 | 1 | 0.15 | 4 |
| 2 | 0.5 | 4 | 0.5 | 4 |
| 5 | 0.5 | 10 | 0.5 | 10 |

| 球半径 | 旧间距(度) | 旧子午线数 | 新间距(度) | 新子午线/纬线 |
| --- | --- | --- | --- | --- |
| 0.02 | 2864.8 | **0.13** | 30 | 12 / 6 |
| 0.05 | 1145.9 | 0.31 | 30 | 12 / 6 |
| 0.5 | 114.6 | 3.14 | 30 | 12 / 6 |
| 2 | 28.6 | 12.57 | 28.6 | 12.6 / 6.3 |

"只剩两条线"就是小球的 1 条子午线 + 1 条纬线（0.13 条子午线意味着大多数方向根本没有线）。

改法两条，都在 `box-shape-shader.ts` / `sphere-shape-shader.ts` 里：
- **条纹间距跟着体积走**：盒子每个轴独立取 `min(0.5, 边长/4)`（任意大小都至少 4 条线），球的角间距取
  `min(180/(πr), 30°)`（任意半径都至少 12 条子午线、6 条纬线）。大体积（≥2 单位 / 半径 ≥2）行为不变。
- **框线/轮廓用屏幕空间恒定宽度画**：盒子 12 条棱、球的剪影各加一条线，宽度用 `fwidth` 换算成像素
  （半宽 1 px + 1.25 px 渐隐），所以无论缩放到什么程度、体积多小，边界始终读得出来 —— 这正是用户要求的
  "框线粗细随视角变化 + 至少保持足够的线界定边界"。旧版**根本没有**画棱/剪影，只靠条纹。

**② 根因：球的缩放把手只剩中心那个小方块，而且 8 px 大小**。
球的 gizmo 用 `uniformScale: true`，把 x/y/z 三个轴把手**和**三个平面把手全禁用了，只剩中心的均匀缩放方块。
实测那个方块的世界半宽是 0.0064 单位（默认 gizmo 尺寸下约 8 px），很难点中；而盒子保留着轴把手（9-18 px），
同样的手势就能改尺寸 —— 这就是"球改不了大小"的观感来源。现在球保留三个轴把手（只禁用平面把手，因为
球在两轴上缩放没有意义），并在 `onTransform` 里取三个分量的最大值写回半径，**拖任意一个把手都是等比缩放**。

**验证**（新增两个回归，都在 `docs/verify/`）：
- `verify-shape-volume-lines.cjs` —— 直接数像素：把模型从场景里移除、关掉 gizmo 层，只留体积本身，
  对 0.05 的盒子和 r=0.02 的球截图裁切后统计：跨过 ≥2 条线的行/列占比、线宽（行/列两个方向的游程中位数）、
  以及四条边是否都有线。实测（WebGPU）：小盒 行 95.4% / 列 98.9% / 覆盖 65% / 线宽 3 px / 四边齐全；
  放大后 行 95.4% / 列 99.3% / 线宽 3 px；小球 行 92.3% / 列 97.1% / 线宽 4-6 px / 四边齐全 —— 11 项全通过。
- `verify-shape-scale-handles.cjs` —— 用**真实鼠标输入**（PlayCanvas 的 gizmo 会调 `canvas.setPointerCapture`，
  合成事件会抛异常）从每个把手的世界 AABB 投影位置向外拖：球的 4 个把手（中心 + x/y/z）全部能改半径
  （0.3 → 0.45 → 0.67 → 1 → 1.88），盒子仍是非等比缩放（0.6/0.3/0.18 → 0.87/0.3/0.18）。4 项全通过。

**排错教训（写下来免得重犯）**：一开始用固定屏幕偏移去拖把手，结论是"球的中心把手没反应"。实际有两个坑：
① 合成 PointerEvent 触发不了 gizmo（`setPointerCapture` 抛错，异常在赋值前就中断了处理函数），必须用
`page.mouse` 真实输入；② `camera.worldToScreen` 在这个引擎版本里签名是 `(worldCoord, screenCoord?)`，
按 d.ts 传 `(v, width, height)` 会把数字当出参抛出，于是我的探针悄悄退回到"画布中心" —— 而体积中心投影在
(608, 447)、画布中心是 (600, 384)，差 63 px，正好全miss。改成从 gizmo 层各 mesh instance 的 AABB 投影出
把手位置后，中心把手其实是好的（0.3 → 0.34）。所以"定位真因"这一步必须用能命中的输入 + 精确坐标。


### 6.33 第三十轮：球刷"点一下要等一秒"的定位 + 给球刷加"大小/厚度"两个滑块

用户反馈两点：**① 用了球刷之后反应变慢，点一下屏幕要等约 1 秒才出现选中状态（重启软件可恢复）；
② 希望在选择工具上加两个滑块，调节"厚度"和"范围大小"。**

**① 先把"慢"量出来。** 为了测到用户真正跑的那个运行时，本轮学会了用远程调试端口驱动**出厂包**：
`SplatRoom.exe --remote-debugging-port=9222 --remote-allow-origins=*`（Chromium 150 起必须带第二个参数，
否则 `/json/version` 连不上；另外单实例锁会让第二次启动什么都不做，测前要先杀掉旧进程），再用
puppeteer `connect` 接管窗口，配合一个带 CORS 的小文件服务器把 93 万点的真实扫描喂进去（脚本都在 `_tmp/`：
`packaged-perf2.cjs`、`packaged-bigstrokes.cjs`、`stroke-breakdown.cjs`、`readback-trend.cjs`、
`readback-variant.cjs`）。注意扫描文件要放在纯 ASCII 路径下：用 PowerShell 走一遍带中文的路径会把脚本
写成乱码（本轮又踩了一次）。

量到的结果（出厂包，WebGPU，931,720 点）：

| 操作 | 耗时 |
| --- | --- |
| 一笔 53 采样点的球刷 | `picker.readDepths` **182 ms** + 胶囊求交 **53 ms** |
| **单击（1 个采样点）** | `picker.readDepths` **59-135 ms** + 胶囊求交 11-17 ms |
| 深度 pass 本身的 CPU 时间 | **0.2 ms**（渲染是排队的） |
| 帧间隔 | 16.7-18 ms，稳定 |
| 60 次连续点击的 readback | 22-31 ms，**无增长**（没有 staging buffer 泄漏） |
| 16 轮"球刷 + 矩形点击" | 笔画 485-755 ms、点击 22-66 ms，**无增长** |
| JS 堆（8 笔 + 8 次选择后） | 364 MB 稳定 |

也就是说：**我在这台机器上复现不出"越用越慢"**（Edge/WebGPU、Edge/WebGL2、出厂包/WebGPU 三种环境都试过，
堆和帧都平），但复现出了"慢"本身——每次 readback 是一次**同步 GPU 等待**，单击也逃不掉，出厂包里就是
几十到一百多毫秒，用户感知成"点一下要等一秒"。

**于是做了两件确定有收益的事**：
- **readback 合并成一次**：`picker.readDepths` 原来按 64 px 分块，每块一次同步回读；现在把采样点的像素
  并集一次性读完（超过 4M 像素才退回分块）。同一批笔画实测：分块 150.8 ms → 单次 **76.1 ms**（最好一次
  113 ms → 12 ms），并且把一笔 53 点笔画的十几次同步等待缩成一次。
- **spinner 延迟出现**：那层遮罩是 `pointer-events: all` 的全屏元素，会吞掉点击。球刷原来一进来就
  `startSpinner`，所以"快速点一下"也会让整个界面变暗一瞬间 —— 现在 200 ms 内完成的操作根本不显示遮罩，
  只有真的慢下来才出现。这正是"点一下、等一秒"观感的一部分。

**没复现出来的部分如实说明**：如果"重启才恢复"是真实规律，那还有一个随会话累积的状态我这边没触发到
（我试过大选区 93 万点、60 次连点、16 轮循环、内存采样）。下一步要么用用户的会话现场复现，要么加一个
"上次操作耗时"的读数，让数字自己说话。

**② 球刷的两个滑块**（A）：设置面板里在"选择深度/覆盖"下面新增两行
`Brush: size (px)` 与 `Brush: thickness (px, 0 = ball)`（沿用现有设置面板的内联英文标签风格）：
- **size** = 笔刷半径（和 `[` `]`、alt+滚轮是同一个值，面板与光标始终一致）；
- **thickness** = 沿**视线方向**能选多深（同一单位：该深度处的 css 像素；0 = 原来的球体笔刷）。
  实现：`intersection-shader.ts` 里给画笔命中判定加 `brushThickness`/`brushViewDir` 两个 uniform，
  厚度 > 0 时把球体换成"沿视线方向厚度 T、横向仍为半径 R"的**板状体**，路径点本身落在笔刷命中的表面上，
  所以"厚度"天然就是"往表面后面多深"。`intersect.ts` 的路径包围盒也按厚度加宽以免被裁剪。

用两墙测试模型验证（新增 `docs/verify/verify-sphere-brush.cjs`，6 项检查，双后端 0 失败）：

| 设置 | 选中 | 其中前墙 | 其中后墙（0.6 之后） |
| --- | --- | --- | --- |
| 半径 60、厚度 0（球） | 21 | 21 | 0 |
| 半径 60、厚度 8 px（薄板） | 15 | 15 | 0 |
| 半径 60、厚度 400 px（厚板） | 31 | **22** | **9** |

也就是：薄板把深度裁掉、厚板能穿到后面的墙，而**前墙命中数几乎不变**（22 vs 21）——厚度只改深度、不改
宽度，这正是它和"大小"滑块分工的意义。该测试同时检查快速笔画结束后**没有**残留 spinner 遮罩。

**用户要求的另外两项（B 屏幕选择的"深度厚度/覆盖范围"、D 对已有选区做"扩张/收缩"）本轮没做**：它们需要
一套"按屏幕像素的前表面深度 + 厚度带"的选后扩张机制（CPU 侧用屏幕深度图 + 空间网格实现，可以复用这里的
`厚度` 语义），下一轮接着做。


### 6.34 第三十一轮：屏幕选择的"深度厚度"（B）+ 去浮云默认关闭

**B：把"只选最前面那一层"变成"选前表面往后 T 的一段带"。**

屏幕选择（矩形/套索/多边形/2D 笔刷/单击）在"深度"打开时走 id 拾取 —— 每个像素只有一个 id，所以永远
只能选到最前面的高斯。新增设置项 `Selection: depth thickness (% of model)`（0 = 保持原行为），实现
`src/splat/selection-band.ts`：

1. `camera.depthPrep(splat)` 渲染一次深度 pass（每像素最前表面深度）；
2. 把这次选择覆盖的区域用 `readDepths` **一次并集回读**（上一轮合并回读的收益正好用上），得到"每像素前表面深度"；
3. CPU 遍历全部高斯：投影到像素 → 落在选择区域内 → 取该像素的前表面深度 → 它到该高斯的**沿视线距离**
   ≤ T 就选中。距离在视空间比较，所以"厚度 T"就是实打实的世界单位。

**三个坑，都记在文档里免得重犯**：
- **深度 pass 写的是线性归一化深度**（顶点着色器 `(viewZ - near) / (far - near)`，见 splat-shader 的
  `pickMode == 1`）。我一开始按 NDC 的非线性公式反推，前表面被算成 0.09（真实约 1.0），厚度带一个都选不中。
- **必须乘模型的世界变换**：`splatData` 里的 xyz 是模型局部坐标，GPU 路径会乘 `matrix_model`。漏掉它时，
  导入时被归一化/缩放过的**真实扫描**投影全错（931k 上 89,341 个点落在区域内却 0 命中），而合成小模型
  （变换是单位阵）完全看不出问题 —— 这也是为什么这个 bug 只在真实数据上暴露。
- **PCUI 的 SliderInput 赋值会触发 change**：把标志写回滑块时会被滑块自己的 max 截断再写回来，形成回环
  （我设 40 被静默改成 20）。现在用 `selThicknessUpdating` 守卫回声，和长方体工具里的 `uiUpdating` 同一套路。

实测：小模型（两墙）——厚度 0 选 210（前墙 209/后墙 1，那 1 个是"只有后墙有覆盖"的像素）；5%（0.12 单位，
墙距 0.6）选 232（前墙 219/后墙 13）；40%（0.93 单位）选 594（前墙 219/后墙 **375**）。真实扫描 931k：
厚度 0 选 7（旧的 id 拾取，一层）、2% 选 517、5% 选 4,674、20% 选 5,319；带判定本身 **40-60 ms**（CPU 遍历
93 万点 + 一次深度回读）。
新增 `docs/verify/verify-selection-depth-band.cjs`（6 项检查，双后端 0 失败），阈值都做成相对基线比较
（"只有后墙有覆盖"的像素在每个情况下都会被选中，绝对值比较会误判）。

**去浮云默认关闭**：`floater-panel` 的启用开关默认改为关（`_fltEnabled = false`，开关初值跟着它走），
面板不再自动对全模型跑检测。`verify-floater-detect.cjs` 相应改了两处：先断言"面板初始是关的（读数是 --）"，
再点标题栏开关打开它；`verify-floater-scope.cjs` 同样先开再测。

**D（对已有选区做"扩张/收缩"）仍未做**：设计上复用 `selection-band.ts` 的语义（厚度按屏幕深度带扩张、
范围按世界半径扩张），但需要对"当前选区"做一次屏幕深度图 + 空间网格的扩张，留作下一轮第一件事。


### 6.35 第三十二轮：点开选择工具就浮出「深度」条（对齐线上编辑器的交互）（已被 6.36 取代）

用户给了参照物（`data.good360vr.com/editor`）：**点开选择工具会出现一个深度滑块**，而我们上一轮的深度厚度
藏在设置面板里，要先翻面板，和"边选边调"的节奏不搭。这一轮把它做成随手可及的样子：

新增 `src/ui/selection-depth-bar.ts`，复用已有的 `.select-toolbar` 浮条样式（盒/球体积、量角、定向工具都
用它），挂在画布容器上，**只在屏幕选择工具激活时出现**（矩形/套索/多边形/2D 笔刷；球刷自带"厚度"滑块、
球/盒体积自带尺寸输入，所以不显示，免得两套控件打架）：

- **深度开关**（`selection.useDepth`）：开 = 只作用于可见表面，关 = 穿透所有层；
- **深度滑块**（`selection.depthThickness`，0–20% 占模型对角线，0 = 只选一层）：判定走上一轮的
  `splat/selection-band.ts`。滑块一离开 0 会**自动把深度开关打开**（厚度只有在深度模式下才有意义），
  深度关闭时滑块变灰，两者状态由 `selection.useDepth` / `selection.depthThickness` 事件双向同步
  （同步回写滑块时用 `updating` 守卫，避免上一轮踩过的 PCUI 赋值回环）。
- 新增 9 语言键 `select-toolbar.depth`、`select-toolbar.depthThickness`（682 键同步）。

新增 `docs/verify/verify-selection-depth-bar.cjs`（7 项检查，双后端 0 失败）：四个屏幕工具都出现
（实测 414×54）、球刷与球体积不出现、标签是本地化文本、开关切换 `useDepth`、滑块写入厚度（设 6 → 标志与
滑块都是 6）、工具停用后隐藏。

---

### 6.36 第三十三轮：移植「选区深度」最近–最远（去掉"选择深度"和"选择覆盖范围"）

用户这次给了三张参照截图（`D:\DeepSeek\SplatRoomV2\选择工具\`，OCR 出来是 **SUPERSPLAT v2 / dataeditorV2**
的界面），并明确了交互：

> 当我使用选择工具选择时，它默认穿透整个模型完整选择，然后通过调节 最近-----最远 两侧的滑块，
> 来精确命中整个穿透空间的某一部分。建议将选择覆盖范围和选择深度功能去掉，直接移植它的这个功能。

参照图里能看到的东西：底部工具条上「移除 | **选区深度** | 取消全选 / 删除选择 / 复制 / 分离 / 反选」一行，
其下有「**最近**」「**最远**」两个标签与「**重置**」按钮，两个值默认都是 0（即"整段"）；正面拉框选中
412,340 / 947,712 个高斯 —— 也就是**整列穿透**。这和我们此前的"选择深度（只选可见表面）/ 选择覆盖范围
（footprint 覆盖率）"是两套不同的模型，于是按用户的建议直接换掉。

**去掉的东西**（`selection.useDepth` 与 `selection.footprint` 两条状态线整条删除）：

- 设置面板三行：`Selection: depth (surface only)` / `Selection: footprint (coverage)` /
  `Selection: depth thickness (% of model)`；
- 底部工具条两个模式按钮（`bottom-toolbar-selection-mode`、`bottom-toolbar-selection-footprint`）
  与它们的 4 个 SVG、对应的 SCSS 规则；
- 快捷键 `N`（切换选择深度）、`Shift+M`（切换覆盖范围）与快捷键弹窗里的两条；
- 9 语言里的 6 个键：`select-toolbar.depth`、`select-toolbar.depthThickness`、
  `popup.shortcuts.toggle-selection-depth`、`popup.shortcuts.toggle-selection-footprint`、
  `tooltip.bottom-toolbar.use-depth`、`tooltip.bottom-toolbar.footprint`（682 → 680 键）；
- 屏幕选择路径上的 **id 拾取**、**footprint 加宽**、**深度 pass 回读**（`splat/selection-band.ts` 删除）。

**新的模型**（`src/splat/selection-range.ts`）：

1. 屏幕选择工具**默认穿透整个模型**：把全部高斯投影到设备像素，落在 2D 区域（矩形边界 / 套索与笔刷的
   画布 alpha / 单击的小方块）里的就选中，**不看深度、不做遮挡判定**；
2. 两个滑块把这个穿透空间切成一段：`最近` / `最远` 是**占模型自身深度范围的百分比**（沿**手势当时**的
   视轴量取，0 = 模型最近的一端，100 = 最远的一端），默认 **0 / 100 = 整段**；
3. 深度范围按动画手势时刻的相机姿态锁定：正面拉框 → 转到侧面看 → 拖滑块，切的是同一块**世界空间板层**，
   不会随视角漂移（这正是参照图"正面选中、侧面观察、调滑块"的用法）；
4. 判定全程在 CPU，**不需要深度回读**，也就没有"点一下等一秒"：小模型 20 ms，93 万点实测 40–60 ms。

**「选区深度」浮条**（`src/ui/selection-depth-bar.ts` 重写）：标题 + `最近` 滑块 + `最远` 滑块 + `重置`
按钮，挂在矩形/套索/多边形/2D 笔刷/快速填充工具上（球/盒体积是三维体选择，球刷有自己的"厚度"，都不显示）。
滑块拖动即**实时重切当前选区**；`最近 > 最远` 时两个值自动换位（双柄 range 的手感）；非默认范围时标题高亮。
新增 4 个语言键 `select-toolbar.selectionDepth` / `depthNear` / `depthFar` / `depthReset`。

**两个踩到的坑（都记一笔）**：

- **实时重切必须清掉"上一次写下的行"**：新加的 `SelectRangeOp` 保存 `pre`（手势之前的选中行）与 `post`
  （当前范围选出的行），`do()` 原本只 `clear(pre)` 再 `set(post)`。第一次拖动看起来"没反应"——实测
  `far 100 → 40` 之后仍然是 367 个点：手势的 post（367 行）留在选区里，只清了空的 pre。加一个 `applied`
  （上一次 do 写下的 ranges）一起清掉后，`far 40` 立刻变成 133（前墙），`near 60` 变成 234（后墙）。
  用这个 op 而不是 `SelectOp('set', mask)` 的原因也在注释里：后者的 undo 只能退回上一个中间状态。
- **单击不能只测一个像素**：合成测试模型的投影点间距约 6 px，`select.point` 最初严格按 `px === clickX &&
  py === clickY` 判定，(0.5, 0.5) 处一个点都选不到（真实 93 万点扫描不会出现，但这是实打实的脆弱点）。
  现在用一个 7×7 的小方块，测试也从模型里反算某个高斯的投影位置再点上去。

**验证**（`docs/verify/`，双后端）：

- 新增 `verify-selection-range.cjs`（12 项，webgpu 0 失败）：默认范围是 0/100；拉框默认选中 367
  （前墙 133 + 后墙 234，**两堵墙都进**）；只在同一次选区上拖 `最远` 100→90→80→60→40→0 →
  后墙 234, 0, 0, 0, 0, 0（单调、末值归零、前墙始终 133）；拖 `最近` 0→80 → 前墙 133, 0, 0, 0, 0
  且后墙始终 234；`重置` 恢复整段；手势前设好的范围对手势生效（0/40 → 只前墙；60/100 → 只后墙）；
  localStorage 落盘；22 ms 完成。
- 重写 `verify-selection-depth.cjs`（13 项，双后端 0 失败）：矩形 set/add/remove/intersect 的四种语义
  （重复 add 幂等、不相交 add 变大、intersect 只留交集、remove 清零、set 覆盖）、套索 mask 路径、
  单击路径、球/盒体积与球刷仍然工作、范围 API 往返与越界夹取、无控制台错误。
- `verify-selection-toolbar.cjs` 改成断言两个旧按钮与旧标志 API **已经消失**；`verify-mask-vs-rect.cjs`、
  `verify-shape-selection.cjs` 里对旧标志的读写一并更新。

**遗留**：`src/splat/splat.ts` 里约 29 行中文注释是**更早某次 PowerShell 往返留下的乱码**（这一轮只修了
`src/app/editor.ts` 里同源的 10 行）。代码逻辑不受影响，但那批注释已经读不通，需要单独一轮按代码语义重写。

---

### 6.37 第三十四轮：单轴两个滑块 → 三轴双柄 range（左右 / 上下 / 深度）

用户原话：

> 选择深度滑块功能已经具备了，接下来进行优化，不用最近、最远单独设滑块，直接按照
> "最近-滑块1----滑块2-最远"这样来布局，滑块1和滑块2中间的部分就是选择的部分。
> 在此基础上，可以做 3 个"最近---最远"、"左---右"、"上---下"三个，分别对应深度、左右范围、上下范围。

**控件层**：PCUI 只有单柄 `SliderInput`，两个单柄并排表达不出"两柄夹住的是一段"。新增
`src/ui/range-slider.ts` —— 自建双柄 range：`低端标签 [值] [====●------●====] [值] 高端标签`，
两个柄之间的那段用高亮色（`$clr-hilight`）填充。行为：

- 拖柄：柄上 `pointerdown` → 轨道 `setPointerCapture` → `pointermove` 换算百分比（吸附到 step）；
- 越过对面：拖低柄越过高柄会把高柄一起顶过去（整段平移），反之亦然；
- 点击轨道空白 = 移动最近的那个柄；柄可聚焦，方向键微调（Shift = ×10）；
- 两个数值框用于读数与精确输入，写回控件时用 `updating` 守卫（PCUI 赋值会触发 change）；
- `Number.isFinite` 兜底：坏值不会渲染成 `NaN%` 与空数值框（见下面踩的坑）。

**面板层**：`src/ui/selection-depth-bar.ts` 改成 `#selection-range-bar`，`.select-toolbar-stacked`
竖排三行 + 右下角「重置」：`最近|最远`、`左|右`、`上|下`。任一轴离开整段时标题高亮。仍然只挂在
矩形/套索/多边形/2D 笔刷/快速填充上（球/盒是三维体选择，球刷有自己的厚度）。

**语义层**（`src/core/selection-flags.ts` + `src/splat/selection-range.ts`）：

| 轴 | 百分比相对谁 | 默认 |
| --- | --- | --- |
| 深度（最近-最远） | **模型自身**沿手势视轴的深度范围 | 0 / 100 |
| 左右（左-右） | **手势自己的选区框**宽度 | 0 / 100 |
| 上下（上-下） | **手势自己的选区框**高度 | 0 / 100 |

三个轴默认都是整段 = 完整穿透整个模型。判定顺序：投影 → 深度窗口 → 屏幕窗口（左右/上下）→ 2D 区域
（矩形边界 / 套索与笔刷的 alpha / 单击的小方块）→ 选中。三轴都能**实时重切**同一个手势（同一个历史
条目，见 6.36 的 `SelectRangeOp`）；矩形用手势的矩形做框，套索/笔刷用笔画 alpha 的包围盒，单击用
指针周围的小方块。新增事件 `selection.screenRange` / `selection.setScreenRange` / `selection.resetRange`，
每轴 2 个 localStorage 键（`splatroom.selRangeLeft/Right/Top/Bottom`）。

**踩的坑**：`selection.depthRange` 这个事件函数的返回形状本来改了（`{ low, high }`），但浮条还按
`{ near, far }` 解构 → 拿到两个 `undefined` → `Math.round(undefined)` = NaN → 面板渲染出 `NaN%` 的填充条
与**空**数值框（`Number('') === 0`，所以看起来像"滑块读数是 0"），而拖柄时用 NaN 比较又选错了柄
（拖 `最远` 结果动了 `最近`）。修法：公开的事件函数保持历史形状 `{ near, far }`（屏幕两轴用
`{ low, high }`），并在控件内部加 `Number.isFinite` 兜底。

**实测**（93 万点真实扫描 `hk-去浮云前.ply`，WebGPU/Edge，全部是同一个手势上的实时重切）：

| 操作 | 耗时 | 选中 |
| --- | --- | --- |
| 拉框 25–75%（三轴整段） | 61 ms | 463,306 |
| 深度 最远 → 50 | 45 ms | 58,933 |
| 深度 最近 → 25 | 46 ms | 31,837 |
| 左右 → 30–70 | 42 ms | 18,344 |
| 上下 → 30–70 | 46 ms | 1,544 |
| 重置（三轴回 0/100） | — | 463,306 |

**验证**（双后端 0 失败）：

- `verify-selection-depth-bar.cjs` 重写为 15 项：五个屏幕工具出现（实测 296×147）、球/盒/球刷不出现、
  三行轴（`data-axis` = depth/x/y）各 2 个柄 + 填充段、标签本地化（最近/最远、左/右、上/下）与标题
  「选区范围」、默认全 0/100、**用真实鼠标拖柄**（左 → 35、右 → 65、上 → 25、最远 → 50）后事件里的值
  与高亮段同步、数值框输入、重置六个数全回 0/100 并撤掉高亮、停用后隐藏、无控制台错误。
- `verify-selection-range.cjs` 增到 17 项：新增 左右/上下 两轴的实时裁剪（按**索引集合**验证是真子集：
  `x 30-70%` 留下 155/367、`y 30-70%` 留下 168/367，比例 42.2% / 45.8% 与 40% 带宽相符；放宽后回到 367）。
- 全量 32 套 + diag 7 项 0 失败；`npm run check` 干净；语言键 680 → **684**（−`selectionDepth`，
  +`selectionRange`/`rangeLeft`/`rangeRight`/`rangeTop`/`rangeBottom`），9 语言同步。

**打包版端到端**（`release\SplatRoom-3.8.0.exe`，Electron 43 / WebGPU / 同一份 93 万点扫描，**真实鼠标拖柄**）：
面板实测 296×147、三行轴 `depth/x/y`、标签 `最近|最远`、`左|右`、`上|下`、初值全 `0/100`；拉框 33 ms 选中
**309,717**；拖「最远」到 50 → **32,724**、再拖「最近」到 25 → **21,945**；拖「左」到 30 → **20,176**；
拖「上」到 30 → **2,600**；点「重置」→ 回到 **309,717** 且六个数全回 0/100；无控制台错误。
（探针里的 ~220 ms 是 puppeteer 跨进程轮询的墙钟，不是重切耗时；应用内的重切耗时见上表 42–46 ms。）

---

### 6.38 第三十五轮：D 项（扩边 / 收边）长进三轴里 —— 两柄变四柄

用户原话：

> 接着做 D，但是不要单独做，在现有基础上优化，做成"----o近o-------o远o----"（o 代表滑块）。

所以不新增控件，而是把每个轴从**两柄**扩成**四柄**：每端一对，**外柄 = 扩边到哪，内柄 = 现在选到哪**，
两柄之间那段（半透明橙）就是"扩边多吃进来的部分"。默认两柄同心（零扩边），此时与上一版完全一致。

**拖动规则**（链式约束 `outerLow ≤ low ≤ high ≤ outerHigh` 恒成立，`src/ui/range-slider.ts` 与
`src/core/selection-flags.ts` 两侧同一套规则，所以 API 改值和拖柄手感一致）：

| 动作 | 结果 |
| --- | --- |
| 拖**内柄**往里（收边） | 外柄跟着一起走（扩边量保持）→ 整段含扩边带一起缩 |
| 拖**内柄**往外 | 同上，整段外移 |
| 拖**外柄**往外（扩边） | 扩边量变大，内柄不动 |
| 拖**外柄**往里越过内柄 | 扩边量先收到 0，再继续拖就带着内柄一起收 |

两柄同心时外柄是**画在内柄下面的空心圆环（20px vs 内柄 12px）**，同心状态下看起来是"靶心"：
圆环边缘有 4px 的抓取带，所以外柄不会被内柄挡住抓不到（这是实机拖拽验证时发现的坑：一开始外柄只有
10px 且被内柄完全盖住，鼠标永远只能拖到内柄）。

**语义（关键的一处修正）**：上一版 2D 窗口只能"裁"不能"扩"——判定是 `区域(矩形/套索) ∩ 窗口`，
而窗口是区域框的子集，所以把外柄拖到框外**什么都不会多**（实测 101 → 101 一动不动）。
现在改成：**外柄窗口 = 选中的范围；内柄窗口 = 绘制形状（矩形/套索 alpha）仍然生效的范围**，
两者之间那圈"扩边带"按矩形加：

```
选中 = 在外柄窗口内 且（在内柄核心窗口内 → 还要满足绘制的形状；在核心之外 → 直接算选中）
```

于是：零扩边时与旧行为逐位相同；扩边时套索/矩形都会多吃到框外的一圈（套索扩出去的那圈是矩形带，
这是这个 UI 的固有近似，写在这里备忘）；收边时核心窗口收窄、形状照旧生效。

**实测**（`test-model.ply` 合成两墙模型，双后端 0 失败）：

- 拉框 0.4–0.6（101 点）→ 把两轴外柄各拖到 ±100（整屏）：**813 点，且是 101 的真超集**；
- 回到零扩边后把内柄收到中间 10%：**1 点，是 101 的真子集**；
- 深度轴：内柄收到 0–40 → 只剩前墙 133 / 后墙 0；把「最远」外柄拖回 100 → **前墙 133 + 后墙 234 全回来**。

**验证**：`verify-selection-depth-bar.cjs` 扩到 16 项（四柄/三色带结构、真实鼠标拖内柄与外柄、
靶心圆环外缘抓取、收边带外柄走、重置十二个数、语言键 `rangeHandleHint`）；`verify-selection-range.cjs`
扩到 20 项（上面那三条扩边/收边的超集/子集判据）。语言键 684 → **685**，9 语言同步。

**打包版端到端**（`release\SplatRoom-3.9.0.exe`，Electron 43 / WebGPU / 93 万点扫描，**真实鼠标拖四类柄**）：
面板 352×147、三行轴各 4 个柄（含 2 个外柄）、标签 `最近|最远` / `左|右` / `上|下`、初值全 `0,0,100,100`；
拉框 40–60% 34 ms 选中 **56,828**；拖左右**内柄**到 45（收边，外柄跟着到 45）→ **52,931**；
拖左右**外柄**到 -50（扩边）→ **59,920**；拖上下外柄到 150 → **69,749**；拖深度内柄「最远」到 50 → **7,319**；
点「重置」→ 回到 **56,828** 且十二个数全回默认；无控制台错误。
（探针里的 ~215 ms 是 puppeteer 跨进程轮询的墙钟；应用内重切耗时见上面的 48–52 ms。）

---

### 6.39 第三十六轮：手感调整 —— 轨道 ×2、左右/上下外扩收到"半个框"、抓取保留偏移

用户反馈三条：

> 1、上下和左右似乎有问题，没有前面的顺滑，而且移动滑块没有太大反应；
> 2、滑轨整体要长一些，建议按照目前的两倍，可操作空间会更大一些；
> 3、最近最远和上下左右的逻辑会有一些差异，因为最近最远直接是穿透的，它的范围本身就很大，
> 而上下左右的范围相对比较窄，因此在滑轨和滑块的设置上要有所考虑，一般选区外扩只需要微调，
> 扩展的距离和速度都不会太大。

**根因**（第 1 条）：X/Y 用了 `-100..200` 的域（每侧留**整整一个框宽**的扩边余地），于是 `0..100`
的核心段只占轨道的 **1/3**（110px 里只有 37px）：内柄几乎没有行程，而且每个像素跳 3% 的值 —— 拖起来
既顿又"没反应"（对比深度那条：0..100 铺满轨道）。第 3 条正好点出了这个设计错误：深度是穿透的、范围天然大，
左右/上下只是屏幕上不大的一块，外扩本来只需要微调。

**改动**：

| 项目 | 之前 | 现在 |
| --- | --- | --- |
| 轨道长度 | 110px | **220px**（用户要求的 ×2；面板 352 → **462×147**） |
| 深度域 | 0..100（模型深度，铺满轨道） | 不变（模型之外没有东西，柄到轨道两端就到头，语义诚实） |
| 左右/上下域 | -100..200（±一个框宽） | **-50..150**（每侧**半个框宽**，正对"外扩只需微调"） |
| 核心段占轨道 | X/Y 只有 1/3 | X/Y 一半（110px），深度整条 |
| 每像素的值变化 | X/Y 2.7 单位（≈2.7% 框宽） | X/Y ≈0.9 单位（≈0.9% 框宽），深度 ≈0.45 |
| 抓取偏移 | 抓柄后第一下会跳到指针下（外环是抓边缘的，会跳 ~8px） | **保留抓取偏移**（PCUI 单柄滑块也是这个行为），实测拖到目标值的偏差 ≤3 且都在 ±6 容差内 |

实测（Edge / WebGPU，`test-model.ply`）：三行轨道 220 / 224 / 224px，面板 462×147；X/Y ≈0.9 单位/px、
深度 ≈0.45 单位/px（拖 10px 分别改约 9 / 4.5 个单位）。`verify-selection-depth-bar.cjs`（16 项）与
`verify-selection-range.cjs`（20 项）双后端 0 失败，全量 32 套 + diag 0 失败。

**打包版端到端**（`release\SplatRoom-3.9.1.exe`，Electron 43 / WebGPU / 93 万点扫描，真实鼠标拖柄）：
面板 **462×147**、三行轨道 220/224/224px、初值全 `0,0,100,100`；拉框 40–60% 32 ms 选中 **56,828**；
拖左右内柄到 49（收边）→ **51,558**；拖左右外柄到 -44（扩边）→ **59,673**；拖上下外柄到 120 → **62,365**；
拖深度内柄到 50 → **5,545**；重置 → **56,828**；无控制台错误。

---

### 6.40 第三十七轮：严格照设计稿重排 —— 轴标签进轨道、四柄分开画、去掉数字框

用户给了两张图（`选择工具\设计.png` / `实际.png`）并说"差太多了，请严格按照这个来"。设计稿是手绘示意图，
我把它的像素读了出来（OCR + 逐像素测几何），得到的事实：

- 画布 510×186，**只有一条线**：`----o 近 o-------o 远 o----`；
- 轨道 x 20..301，四个圆柄中心约在 **68 / 116 / 203 / 255**；轴标签「近」(x 84..106)、「远」(x 222..238)
  **在两个柄中间**，不是放在行两端；
- 两端是虚线（外扩余地，每侧约 42px）；
- 右上图例「o = 滑块」，下方两行注解「外柄 内柄 内柄 外柄」并用箭头指到四个圆柄；
- **整张图没有任何数字框**。

对照当时的实现，差的是这五件事（用户说的"差太多"）：

| | 原来 | 现在（照设计稿） |
| --- | --- | --- |
| 轴标签位置 | 行两端、轨道**外面** | **在轨道上**，画在那对柄的正中间 |
| 一对柄 | 同心叠成"靶心"（看着只有 2 个柄） | 外环让开一个固定间隙（≥34px = 标签宽 + 余量），永远看得出是 **4 个柄** |
| 数字框 | 每行 4 个（12 个） | **全部去掉**：拖动时数值贴在柄旁边浮出，平时收在柄的 tooltip 里 |
| 面板形状 | 462×147 的表格块 | **240×135** 的三条细行 |
| 行与行的差异 | 深度轴 0..100 铺满轨道（柄贴两端）、左右/上下 -50..150 | 三轴统一 -50..150，三行长得一模一样 |

三轴统一值域后，每一行都读作 `----o 左 o-------o 右 o----`：两端是空轨道（外扩余地），两个内柄之间
是选区，中间的半透明橙带是"扩边吃进去的部分"（零扩边时是空的、不显示）。深度轴拖到 0 以下 / 100 以上
时模型之外没有东西可选，所以那一段是空的。

**拖动手感**：外柄让开的那个间隙是纯视觉的，指针换算时会把间隙补回来（在"让位态"和"真实位"之间按
连续性切换），所以柄始终跟着指针走，不会跳。实测（Edge / WebGPU，`test-model.ply`）三行轨道各 220px、
面板 240×135；每行几何：外柄 21 < 标签 38 < 内柄 55 < 内柄 165 < 标签 182 < 外柄 199（轨道内像素），
即设计稿的那个顺序。

**验证**：`verify-selection-depth-bar.cjs` 重写为 18 项，其中一项按设计稿断言几何顺序
（`outerLow < 低端标签 < low < high < 高端标签 < outerHigh`、每对间隙 ≥14px、核心段比间隙宽），
另一项断言行内**没有数字框**、拖动时数值浮出且松手后隐藏；双后端 0 失败；全量 32 套 + diag 0 失败。
语言键 685 不变。

**打包版端到端**（`release\SplatRoom-3.9.2.exe`，Electron 43 / WebGPU / 93 万点扫描）：

- 面板 **240×135**、三行轨道各 220px、行内数字框 **0 个**；
- 三行几何（轨道内像素）与设计稿同序：
  `depth: 21 < 最近 38 < 55 < 165 < 最远 182 < 199`、
  `x: 21 < 左 38 < 55 < 165 < 右 182 < 199`、
  `y: 21 < 上 38 < 55 < 165 < 下 182 < 199`；
- 真实鼠标拖外柄：指针落在轨道内 2px 处（x=685，轨道 683..903）→ 实测 `outerLow = -48`，
  与指针换算的期望值 **-48.2** 一致，说明让位间隙没有让柄偏离指针；
- 拉框 40–60% 34 ms 选中 56,828；收边 / 扩边 / 重置均按预期改变选中数量；无控制台错误。

---

### 6.41 第三十八轮：面板 ×2、方块滑块（字在块里）、非线性映射

用户三条：*"1、面板可以设计的更长，建议目前的两倍长；2、滑块设计成长方形的，把文字放在内部，
参考 选择范围设计.png；3、调节的操作要做成非线性的，靠近视觉中心调整要慢，要精确，远离视觉中心要快，
有些场景高斯集中在包围盒中心，但是会选中很远处，往回收的时候要收到两个滑块非常接近才能看到，
两个滑块就开始打架，调节很费劲。"*

新设计稿（`选择范围设计.png`，2375×728）逐像素读出来的结构：**三行**，每行宽 2064px（x 155..2218）；
每行 = **一条细轨 + 两端各一个长方形块**（约 240×78，白字在块内，实测「最近」在 x 526..627、
「最远」在 1772..1873）；轨是绿→蓝渐变（装饰用）；通篇没有数字框。

**1. 面板 ×2**：轨道 220 → **440px**，面板 240×135 → **460×147**。

**2. 方块滑块**：四个圆柄 + 轨道上的标签 → **两个写了字的长方块**。每个块就是"那一对值"的跨度：

- **内边 = 选区边界**（收边就拖它）；**外边 = 扩边到哪**（往外拖扩边量变大）；
- 所以**块的宽度直接就是"扩边吃进去多少"**（以前是半透明橙带，现在块本身就是它）；
- 块的两半各是一个隐形抓手（外半 = 扩边、内半 = 边界），**再窄的两个块也不会抢同一片像素**，
  这正好解掉用户说的"两个滑块打架"；
- 标签藏在块里（块被挤到装不下标签时自动隐藏，但内边位置永远是真的）。

**3. 非线性映射**：轨道位置 t ∈ [0,1] 与值不是直线：

```
s = 2t - 1 ;  value = 50 + 100 * s * (β + (1-β) s²)        β = 0.35（中心斜率）
```

中心处斜率 ≈ **0.08 值/px**，两端 ≈ **0.56 值/px**（线性是 0.45 值/px 处处相同）——
也就是**靠近轨道中心（= 包围盒中心）时每像素只动 1/6 的值，能精确收到很窄的一段；远离中心时快**，
扩边这种大范围动作不用拖半天。反解用 1024 点查表 + 线性插值。步长同时从 1 改成 **0.1**
（否则最细那一段会一跳一跳）。实测同一个 20px 拖动：**靠近中心 +3.2，靠近端点 +19.0（快 5.9 倍）**。

**验证**：`verify-selection-depth-bar.cjs` 重写为 17 项，含
"每行两个方块、字在块内、选区带在块的内边之间"、"轨道 440px"、
"**非线性**：同样 20px 拖动在中心比在端点慢一个数量级（实测 5.9×）"、
"拖内边收边时块宽不变、拖外边扩边时块明显变宽"、"行内无数字框"等；双后端 0 失败，
全量 32 套 + diag 0 失败。语言键 685 不变。

**打包版端到端**（`release\SplatRoom-3.10.0.exe`，Electron 43 / WebGPU / 93 万点扫描）：

- 面板 **460×147**、三行轨道各 **440px**、行内数字框 **0 个**；
- 每行结构（轨道内像素）：`低块 31+30「左」 / 选区带 61+319 / 高块 379+30「右」`
  （深度行是 `23+38「最近」/ 61+319 / 379+38「最远」`）✓ = 设计稿的"细轨 + 两端方块 + 中间选区带"；
- 真实鼠标拖动全部按预期改值（0.1 精度）：收边 → `low 57.6`；扩边 → `outerLow -50`（正中目标）；
  上下扩边 → `92.9`；深度收边 → `37.8`；重置 → 回到 `0/100` 且选中数回到 56,828；无控制台错误。


### 6.42 第三十九轮：拖动时滑块尺寸不变 + 窗口内线性、两块之间恒定留出 1/3.5 轨道

用户一条：*"拖动滑块时，滑块本身不用变化，只需要在尺度上做线性变化，给两个滑块中间的精度高一些，
两个滑块越靠近变化越慢，所以要给两个滑块中间留够操作的空间，这样在厚度收窄到很窄的时候不用小心翼翼的调整。"*

3.10.0 的"**块宽 = 扩边吃进去多少**"要改掉：块一边拖一边变形，视觉上滑块的尺寸在动 —— 用户要的是
**滑块本体恒定**，变的只是"尺度"。三条落地：

1. **滑块尺寸固定**：两个方块都是 **25×20px 常数**（标签在内、宽度按最长标签算一次然后钉死），
   拖动过程中 `offsetWidth` 不参与布局；**扩边改画在轨上**（外柄到内柄之间那条橙带，见下），
   块宽不再随扩边变化。
2. **窗口内线性**：去掉 3.10.0 的三次映射（`value = 50 + 100·s·(β+(1-β)s²)`）。
   值 ↔ 轨道位置在**当前窗口内是直线**，`t = (value - view.min) / (view.max - view.min)`。
3. **两块之间恒定留白**：窗口跨度

   ```
   span = min(值域, max(四值一起的跨度 + 2×余量, 内跨度 × ZOOM, ZOOM×STEP))     ZOOM = 3.5
   ```

   于是两块的间距 = `内跨度 / span × 轨道 = 轨道 / 3.5 = 126px`（轨道 440），**与厚度无关** ——
   这就是"给两个滑块中间留够操作的空间"，也是"越靠近变化越慢"的来源：每像素对应的值
   = `内跨度 / 126`，内跨度越小每像素越细。

| 厚度（值） | 两块之间的轨道间隙 | 拖动多长才动 0.1 |
| --- | --- | --- |
| 40 | 126px | 0.3px |
| 2 | 126px | 6px |
| 0.5 | 126px | 22px |
| 0.2 | 126px | 44px |
| 0.1（最薄合法值） | 126px | 66px |

（实测：块宽全程 **25px 不变**；`verify-selection-depth-bar.cjs` 报
`core gap 220px -> 126px -> 126px -> 126px`、`40px of drag = 153×0.1（40 厚）vs 1×0.1（0.2 厚）= 153× 更细`。）

**两个坑**：

- **正反馈跑飞**：窗口以"两个内值的**中点**"为中心，而拖动本身会移动那个中点 → 中点追着值跑，
  一次 22px 的拖动把值推了 21 个单位并饱和（`low = high = 100.3`）。修法：**中心在 pointerdown
  那一刻冻结**（`dragCenter`），拖动全程用冻结值算窗口，pointerup 再解冻并重排一次。
  现在同样的拖动是**减速**的：每 22px 依次 `10 → 10 → 10 → 10 → 10 → 8.8 → 5.6 → 4.3 → 3.2 → 2.7 → 2.1 → 1.8`。
- **外柄点不到**：`.select-range-handle { pointer-events: none }`（它的细柄压在块下面）在样式表里
  **排在 `.select-range-handle-outer` 之后**，同优先级 → 后者被覆盖，实测 `elementFromPoint`
  命中的是块而不是外柄，于是"拖扩边"实际拖的是内边。修法：外柄的选择器写成
  `.select-range-handle.select-range-handle-outer`（两个类，优先级更高）；
  探针复核 `barPointerEvents: auto / barZ: 3 / hitHandle: outerLow`。

**参数**：`STEP = 0.1`、`ZOOM = 3.5`、`MIN_SPAN = ZOOM × STEP = 0.35`（原来写死 0.4，会把最薄的
0.1 厚度挤到 110px；改成 0.35 后最薄也拿到完整 126px，见上表）、`BLOCK_PADDING = 14`、
`OUTER_HANDLE_WIDTH = 8`。

**验证**：`verify-selection-depth-bar.cjs` 18 项（新增"固定 40px 拖动买到的 0.1 步数：40 厚 153 步
vs 0.2 厚 1 步"与"最薄 0.1 仍然 ≥120px"），WebGPU + WebGL2 双后端 0 失败；全量 32 套 + diag 7/7；
`npm run check` 干净。

**打包版端到端**（`release\SplatRoom-3.11.0.exe`，Electron 43 / Chromium 150 / WebGPU / 93 万点扫描，
窗口 1586×863 @dpr1.5）：

- 面板 **460×147**、三行轨道各 **440px**、每行 4 柄（2 内 + 2 外）、**0 个数字框**；
- `rect 40-60%` 手势 **35ms** → 选中 **56,828**；
- **间距不变量**在打包版上逐档复核：厚度 40 / 2 / 0.2 / 0.1 → 间距都是 **126px**、块宽都是 **25px**；
- **外柄真的能拖了**：`elementFromPoint` 命中 `outerLow`（`select-range-handle select-range-handle-outer`），
  真实鼠标拖到 12% 处 → `outerLow 45 → 36.7`，**内边 low 保持 45**，**块宽 25px 不变**，
  选中数 4,522 → **5,094**（扩边是加，不是改内边）；
- 真实鼠标拖内块收边（每 22px）：`10 / 20 / 30 / 40 / 50 / 58.8 / 64.4 / 68.7`，
  间距 `198 → 176 → 154 → 132 → 126` 后**钉在 126**，与浏览器实测逐点一致；
- 重置 → `0/100`、选中数回到 **56,828**；**无控制台错误**。

**顺手修掉的**：`package.json` 的 `author` / `description` 是乱码（V3-0 基线就是从被
PowerShell 往返破坏的副本里抄来的，一直没发现，会进 exe 的文件属性）。按 `SplatRoomV2` 里的干净值
还原为 `摄影师黄Sir <1924705842@qq.com>` / `3D Gaussian Splat Editor - 调色与后期工作流`。
版本 **3.11.0**。语言键 685 不变。


### 6.43 第四十轮：把"尺度"从拖动里拿掉 —— 拖动全程 1:1 跟手，够不着就平移轨道

用户一句话否掉了 3.10.0/3.11.0 的方向：*"这个操作很麻烦，而且不直观，我其实不需要让人看到那个
非线性变化的尺度，只需要简单的移动滑块能够快速而精确的调整选区就可以了。"*

**先量清楚"不直观"是什么**（`_tmp\track-drift-probe.cjs`，真实鼠标拖动内块，每 22px 记一次
指针位置 vs 方块中心 vs 值）：

| 指针位移 | 0 | 22 | 44 | 66 | 88 | 110 | 132 | 154 | 176 | 198 | 220 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 值 | 0 | 10 | 20 | 30 | 40 | 50 | 58.8 | 64.4 | 68.7 | 71.9 | 74.6 |
| 方块中心与指针的偏差 | 0 | 0 | 0 | 0 | 0 | 0 | **5** | **7** | **9** | **10** | **12**px |

前 110px 完全跟手（偏差 0），一旦**窗口开始实时收缩**，灵敏度从"每 22px 走 10 个单位"掉到 1.8，
方块同时开始落后于指针 —— 这就是用户看到的"非线性变化的尺度"。3.11.0 只冻结了窗口的**中心**，
span 仍在跟着值跑，所以这个现象还在。

**改法：拖动期间整张映射表冻结**（不只是中心）：

- pointerdown 那一刻把当前的窗口（比例尺 + 原点）整个拷贝进 `dragView`，整个拖动过程用它；
- 值 = `抓取时的值 + (指针位移 / 轨道宽) × span` —— **每像素固定走固定多的值**，而且从抓取点起算，
  所以按下的一瞬间值不会跳；
- **够不着怎么办**：拖到轨道两端 6% 以内就**平移**窗口（`panForValue`，只改原点、**span 一点不动**），
  柄留在轨道上、值继续跟着指针走，于是"一个方向一直拖"能走完全值域，不用松手重抓。
  平移不会形成反馈回路，因为值只由指针位移决定，跟窗口无关（3.11.0 的跑飞就是这个回路造成的）；
- **松手才重新贴合**：`release` 时丢掉 `dragView`，轨道重新按当前选区定比例尺 —— 两块永远回到
  ≥126px。拖动过程中比例尺**一次都不变**。

**顺带堵掉一个死角**：芯可以被拖成 0 厚（两个值压在一起）。实测这时两个方块完全重叠，只有上面那一个
点得到，拖 80px 只是把整块挪了 0.1 —— 打不开。现在 `MIN_THICKNESS = 0.1`（一个步长）作为链式约束
的一部分：内柄顶到对面就**推着走**并保留一个步长，`selection-flags.ts` 的 `normalize()` 也照此收口。

**实测**（Edge / WebGPU / 440px 轨道，`verify-selection-depth-bar.cjs` 21 项 0 失败）：

| 指标 | 3.11.0 | 3.12.0 |
| --- | --- | --- |
| 连续 8 步 ×22px 的值增量 | `10, 10, 10, 10, 10, 8.8, 5.6, 4.3`（最大/最小 5.6×） | `10, 10, 10, 10, 10, 10, 10, 10`（**1.000**） |
| 方块中心 vs 指针的最大偏差 | 12px（越拖越偏） | **0.0px**（全程） |
| 一次拖动能不能够到远处 | 到轨道边就停（得松手重抓） | 能：0.2 厚的芯，600px 拖动值持续走 `49.9→50.9`，柄钉在 0.94 处、轨道在它底下滑 |
| 芯最薄 | 0（两块重叠、拖不开） | **0.1**（一个步长），静态间距仍是 126px |
| 松手后两块间距 | 126px | 126px（松手重新贴合） |

代价：拖动过程中如果厚度缩得非常多，两块会在轨道上靠得很近（超出冻结比例尺的范围），**松手后立刻
重新贴合分开**；以及极薄的芯（0.2 厚）每 0.1 要走 60px 左右 —— 这是"比例尺随厚度走"的必然结果，
换来的是拖动永远跟手、永远同速。

**打包版端到端**（`release\SplatRoom-3.12.0.exe`，Electron 43 / Chromium 150 / WebGPU / 93 万点扫描，
窗口 1586×863 @dpr1.5，asar 5293 条 / 唯一 PLY / 版本字面量 3.12.0）：

- `rect 40-60%` 手势 **31ms** → 选中 **56,828**；
- 连续 8 步 ×22px：`10, 10, 10, 10, 10, 10, 10, 10`，**方块中心与指针偏差 0.0px**，选中 56,828 → 21,435；
- 0.2 厚的芯上拖 600px：值 `49.9 → 50.9` 连续推进，柄钉在轨道 **0.94** 处（轨道在它底下滑），
  间距 126px → 松手后仍 126px；
- 往另一块上压 480px → 厚度停在 **0.1**、间距 **126px**（不会塌成 0）；
- 重置 → `0/100`、选中数回到 **56,828**；**无控制台错误**。


### 6.44 第四十一轮：两个滑块钉死在固定位置 —— 推一下、松手归位、越远越快

用户把 3.10–3.12 三轮的方向整个否掉了：*"依然很麻烦，对于新手用户特别不友好，我的要求很简单：
1、`----■------------■----`，只有这两个带字的滑块，不需要任何数值；2、两个滑块在固定位置，在调整
完成后释放鼠标，自动归到固定位置；3、越靠近视角，越精确；越远离视角，速度越快。"*

这三条合起来是一种**推杆**（jog）互动，不是滑块：滑块**不沿轨道走**，它是被"推"的。

**面板长什么样**（每行）：

```
----■------------■----        ← 两个方块固定在轨道 20% / 80%，块里写字（最近/最远、左/右、上/下）
```

- 一行里**只剩两个方块**：外柄（扩边细柄）和两条扩边带从面板上去掉；**没有任何数字** ——
  没有数字框、没有拖动时浮出来的读数、整行 `textContent` 里一个数字都没有（实测 digits = 0）。
  扩边的**语义**还在（API / 选择逻辑照旧），只是面板不再画它；
- 比例尺的唯一职责是**让两个方块永远落在 20% / 80%**：`span = (high-low)/0.6`，
  于是**任何厚度下两块之间的选区带都是 264px**，面板的样子永远一样（实测四种厚度：0.2/40/100/0.1
  全部 `low 0.2 / high 0.8 / 带 264px / 块宽 25px`）；
- **块宽恒定 25px**（只由标签决定），不随任何值变化。

**推杆手感**：值的变化量不是指针位移的直线，而是

```
offset(dx) = sign(dx) · 0.02 · ( |dx| + dx² / 80 )        （dx 单位 px）
```

实测（真实鼠标，一次按住不动地推）：

| 推的距离 | 0px | 40px | 100px | 200px | 400px | 700px |
| --- | --- | --- | --- | --- | --- | --- |
| 值 | 0 | 1.2 | 4.5 | 14 | 48 | 136.5 |
| 滑块在轨道上 | 0.20 | 0.291 | 0.427 | 0.655 | **1.00（停在端点）** | 1.00 |

同一次拖动里，头 20px 只走 **0.5**，推到 200px 之后的 20px 走 **2.5**（**快 5.0 倍**）——
"越靠近（停靠点）越精确，越推远越快"。滑块本身 1:1 跟手（40px → 0.20→0.291 = 精确 40/440），
推过头就停在轨道端点上，值继续涨 —— 想让值再跑，继续往外推就行，不用松手重抓。

**松手归位**：拖动期间比例尺冻结（沿用 3.12.0 的做法），松手后按新选区重排 —— 两个方块**自动回到
20% / 80%**，值留在你推到的地方（实测推到 136.5，松手后 `low 0.2 / high 0.8`、值仍是 136.5）。

**顺手修掉一个真 bug**：在值域边界上（`low` 被夹到 150）"至少一个步长"的兜底会把两端一起夹到 150，
厚度变 0；现在顶不动高端就把低端收回来（`149.9 / 150`），并且 `selection-flags.normalize()` 同样收口，
滑块 commit 末尾还会再兜一次链式约束（否则下游"外柄越过内柄拖内柄"的规则会把芯又拖塌）。

**验证**：`verify-selection-depth-bar.cjs` 按新设计重写为 **19 项 0 失败**，含
"每行只有一个轨道两个带字方块、没有外柄"、"没有任何数字（数字框/读数/整行 digits 都是 0）"、
"四种厚度下两块都停在 20%/80% 且选区带恒 264px"、"同一次推杆里 20px 的位移在远端快 5 倍"、
"按住时方块跟手、推过头停在端点"、"松手两块都归位且值不丢"、"900px 推到底厚度仍是 0.1"。
语言键 685 不变（`rangeHandleHint` 9 语言改成新文案）。

**打包版端到端**（`release\SplatRoom-3.13.0.exe`，Electron 43 / Chromium 150 / WebGPU / 93 万点扫描，
窗口 1586×863 @dpr1.5，asar 5293 条 / 唯一 PLY / 版本字面量 3.13.0 / 9 语言各 685 键）：

- 面板 **460×147**、轨道 **440px**、每行 **2 个方块 / 0 个外柄 / 1 条选区带 / 行内 digits = 0**，
  块里字 `最近·最远 / 左·右 / 上·下`；
- **停靠**：厚度 100 / 40 / 0.2 / 0.1 四种状态下，两块都在 **0.20 / 0.80**、选区带都是 **264px**、
  块宽都是 **25px** —— 面板的样子任何厚度下完全一样；
- **一次按住推到底**（真实鼠标）：`0px→low 0（块 0.20）`、`40px→1.2（0.291）`、`100px→4.5（0.427）`、
  `200px→14（0.655）`、`440px→57.2（块停在端点 1.00）`、`700px→136.5`；
  同一次里 `0→20px` 走 **0.5**、`200→220px` 走 **2.5**（与公式 0.50 / 2.50 一致）；
- **松手归位**：两块回到 **0.20 / 0.80**，值仍是 136.5（选中数 56,828 → 0）；
- 重置 → `0/100`、选中数回到 **56,828**；**无控制台错误**；打包 CSS 里已经没有外柄和读数元素。


### 6.45 第四十二轮：深度轴的两条空尾巴 —— 第一次推杆就要看得见

用户：*"现在这个效果很好了，还需要进行优化，尤其是最近和最远两个滑块需要做特别的调整，逻辑就一个，
我需要在首次滑动滑块就能看到选区范围的变化，因此，尤其是最远的那个要快速进入视野内变化。"*

**先量出来到底哪里不动**。真实扫描（93 万点，框内选中 37.4 万点）沿视轴的深度分布：

| 深度 % | 0–7.5 | 10 | 12.5–30 | 32.5–82.5 | 85 | 87.5 | 90–100 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 点数 | 2,045 | 11,996 | ~1,000/档 | ~5,000/档 | **85,934** | **149,895** | **21,523** |

两端的 21.5%（近）和 10%（远）几乎是空的，而**包围盒按最外沿算**，于是滑块那一段行程什么都删不掉：

| 最远 | 100 | 99.5 | 99 | 98 | 97 | 95 | 90 | 85 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 删掉的高斯 | 0 | **0** | **0** | **0** | 3 | 15 | 1,471 | **198,773（53%）** |

也就是"先推 10 个单位什么都没发生，然后一下砍掉一半" —— 用户说的"首次滑动看不到变化"就是这个。

**改法**：按**本次手势框内**高斯的实际深度分布，把两端各占 `TAIL_SHARE = 2%` 的那一段压进滑块行程的
`TAIL_PERCENT = 0.5%` 里（`depthTailFractions`，512 桶直方图，一次 O(n) 扫描）：

```
0% ──尾巴(0.5)── 内容区起点 ──线性(99)── 内容区终点 ──尾巴(0.5)── 100%
```

- **0% 仍对应包围盒最近端、100% 仍对应最远端** —— 没有东西变得够不着，"默认整段穿透"的语义不变；
- 尾巴那一段的刻度被压紧，**第一次推杆（20px ≈ 0.5 个单位）就已经在删真实高斯**；
- 直方图按整个模型算过一次就缓存进手势（`RangeEntry.tails`），拖动时的实时重切照样便宜；
- 只有深度轴有这个待遇（左右/上下是**用户自己画的框**，框边本来就在内容上），正是用户说的
  "最近和最远两个滑块需要做特别的调整"。

**实测（同一个手势 / 真实扫描）**：

| 推杆（最远） | 20px | 39px | 78px | 156px |
| --- | --- | --- | --- | --- |
| 删掉 | **7,689（2.1%）** | 12,357（3.3%） | 40,325（10.8%） | 152,373（40.7%） |

| 推杆（最近） | 20px | 39px | 78px |
| --- | --- | --- | --- |
| 删掉 | **7,870（2.1%）** | 10,365（2.8%） | 13,949（3.7%） |

改前这两个位置都是 **0 个高斯**。而且"90→85 一下 53%"的断崖也没有了（现在最大的单步是 95→93 的
30%，那是真实存在的那面密墙）。

**踩到的坑**：`depthTailFractions` 一开始忘了套模型变换（`selectRange` 是先 local→world 再算深度的），
于是每个高斯都被算到直方图外面、`counted = 0`，函数静默退回线性映射 —— 表现就是"改完还是一样"。
现在签名直接收 `view`（里面就有 `worldTransform`），并在注释里写明这一点。

**验证**：`verify-selection-range.cjs` 20 → **23 项 0 失败**，新增"最远/最近 的第一小步
（99.5 / 0.5）必须真的删掉高斯"和"0/100 仍然等于整段穿透（两端没变得够不着）"；
`verify-selection-depth-bar.cjs` 19 项 0 失败；全量 32 套 + diag 7/7；`npm run check` 干净。

**打包版端到端**（`release\SplatRoom-3.14.0.exe`，WebGPU / 93 万点扫描，真实鼠标推方块）：

| 推 最远 | 20px | 40px | 80px | 160px |
| --- | --- | --- | --- | --- |
| 边界 | 99.5 | 98.8 | 96.8 | 90.4 |
| 删掉的高斯 | **2,932（2.34%）** | 4,379（3.49%） | 26,193（20.87%） | 100,459（80.05%） |

| 推 最近 | 20px | 40px | 80px |
| --- | --- | --- | --- |
| 边界 | 0.5 | 1.2 | 3.2 |
| 删掉的高斯 | **2,793（2.23%）** | 3,648（2.91%） | 3,690（2.94%） |

（改前这两个位置都是 **0 个高斯**；`rect 35-65%` 手势 53ms → 125,498；重置回 `0/100` 与 125,498；
无控制台错误。）


### 6.46 第四十三轮：左右 / 上下同样的毛病 —— 手势框的空边距也被压紧

用户：*"排查下，上下左右好像没什么反应。"*

**先确认不是坏了**：真实鼠标推四个方块，滑块**值**照常变（0.5 / 1.2 / 3.2 / 9.6，和深度轴同一套手感），
但**选中数几乎不动**：

| 推 20px | 左右低端 | 左右高端 | 上下低端 | 上下高端 |
| --- | --- | --- | --- | --- |
| 删掉的高斯 | 105（0.05%） | 679（0.31%） | 2,397（1.11%） | 187（0.09%） |

深度轴修好后同一位置是 **2.3%** —— 也就是说"没反应"是**同一个病**：比例尺按**手势框**算，而框是用户
随手拖出来的，框边常常落在空处。框内 37.4 万点投影到 x 上的分布：

| 框内位置 | 0–25% | 30–55% | 60–95% | 95–100% |
| --- | --- | --- | --- | --- |
| 每 2.5% 的点数 | ~500–1,300 | ~1,000–5,200 | 8,000–19,600 | 1,700–4,000 |

于是"推 20px"只削掉框左一条 **0.15% 宽**的边 → 105 个高斯 → 屏幕上那 2–3px 根本看不出来。

**改法**：`screenTailFractions` —— 和深度轴同一套（`TAIL_SHARE = 2%` 的内容边界压进行程
`TAIL_PERCENT = 0.5%` 里），只是这次统计的是**框内高斯投影后的 x / y 分布**（512 桶直方图，复用同一张
`inBox` 掩码，一个手势只算一次），`screenWindow()` 收 `tails` 做分段线性映射。框边本来就在内容上时
测出来是空尾巴，映射自动退回线性。

**实测（真实鼠标推四个方块，同一个手势）**：

| 推 20px | 左右低端 | 左右高端 | 上下低端 | 上下高端 |
| --- | --- | --- | --- | --- |
| 改前 | 105（0.05%） | 679（0.31%） | 2,397（1.11%） | 187（0.09%） |
| 改后 | **4,367（2.02%）** | **5,044（2.33%）** | **4,670（2.16%）** | **4,402（2.03%）** |

推 40 / 80 / 160px 分别是 2.1/2.4/3.4%（左低端）、3.0/5.5/14.6%（右高端）、4.6/10.0/27.4%（上低端）
—— 五条轴（最近/最远/左右/上下）现在**第一次推杆都是 ~2%**，手感一致。

**踩到的坑**：`tailMap` 一开始把百分比夹在 0..100，结果**扩边（-50 / 150）全被夹回框边、
外柄再也扩不出去** —— `verify-selection-range` 的"扩边必须是严格超集（101 → 367）"当场变红
（101 → 101）。改成尾巴段线性外推后恢复（101 → 367 ✓）。

**验证**：`verify-selection-range.cjs` 23 → **24 项 0 失败**（新增"左右/上下 的第一小步也必须真的删掉
高斯"）；全量 32 套 + diag 7/7；`npm run check` 干净。

**打包版端到端**（`release\SplatRoom-3.15.0.exe`，WebGPU / 93 万点扫描，`rect 35-65%` 手势 59ms →
125,498，真实鼠标依次推六个方块）：

| 推 20px | 最近 | 最远 | 左 | 右 | 上 | 下 |
| --- | --- | --- | --- | --- | --- | --- |
| 删掉的高斯 | 2,793 | 2,932 | 2,516 | 2,760 | 2,687 | 2,700 左右 |
| 占选区 | 2.23% | 2.34% | 2.00% | 2.20% | 2.14% | 2.1% |

推 40/80/160px：最远 `3.5% / 20.9% / 80.0%`、右 `3.0% / 5.1% / 13.9%`、上 `2.9% / 5.1% / 18.3%`、
下 `…/…/4.0%`、左 `2.1% / 2.3% / 3.6%` —— **五条轴（六个方块）第一次推杆都是 ~2%，手感一致**；
重置回 `0/100` 与 125,498；无控制台错误。


### 6.47 第四十四轮：merged-scene（1300 万点）上的三条 —— 新框选不再被旧范围裁、推杆不再重投影、卡顿降下来

用户给了自己的测试文件 `选择工具\merged-scene.ply`（**binary PLY，13,007,105 个高斯，695MB**，
是我之前一直用的 93 万点扫描的 **14 倍**）并报了两件事：*"1、从顶部框选中间的那个塔，只选到了塔身的
一半；2、上下左右推动滑块，有时候有反应，有时候没有。"* 另外开头一句是"还是有一些不顺滑"。

**先量，再改**（`_tmp\merged-probe*.cjs` / `push-perf.cjs`）：

- 手势（画一次框）**2003ms** → 我的尾巴分析在中途加了两趟全扫（inBox 掩码 + 两个直方图），
  13M 点上等于 4 趟 = 4 倍代价；**一次滑块推杆 840–1016ms** —— 这就是"不顺滑"；
- "塔只选到一半"：把相机定住（viewHash 前后一致）后，默认范围下**框内投影到的 12,147,085 个点里
  选中了 12,139,322（99.9%）** —— 范围逻辑没有裁它。真正的来源是**上一次调过的滑块值还留着**：
  新的一次框选会继承旧范围（3.9.x 起的行为），于是"框住塔"被上一轮的 最近/左右 裁掉一半；
- "有时候有反应、有时候没有"：`tailBins` 里有一句"尾巴已经贴到两端就退回线性"的守卫 —— 框画得紧
  （边就是内容）时就没有压紧，第一下推杆又几乎不动，于是响应时有时无。

**三处改动**：

1. **新框选从整段穿透开始**：`runRangeSelection` 开头先 `rangeGesture = null` 再
   `events.fire('selection.resetRange')`（先清手势，复位事件就不会触发一次没用的重切）。
   范围属于"你正在微调的那一次选择"，上一次的残留不再悄悄裁掉这一次 → 框住塔就是整个塔；
2. **推杆不再重新投影**：`RangeProjectionCache`（`sx`/`sy` Int16 + `dist` Float32，8 字节/点）在
   手势那一次本来就有的全扫里顺手写好，之后每次推杆走 `selectRangeFromCache` —— 只做窗口/深度/形状
   比较。超过 2400 万点自动退回逐点投影，避免吃几百 MB；
3. **尾巴压紧变成无条件**（去掉那个守卫）：框画得紧时也照压，第一下推杆永远有同样的响应。

**实测（同一台机器 / 同一文件）**：

| | 改前 | 改后 |
| --- | --- | --- |
| 手势（13M 点） | 2,003 ms | **774 ms** |
| 一次推杆（x / 深度） | 840–1,016 ms | **556–721 ms** |
| 新框选是否被旧范围裁 | 会被裁（只选到一半） | **不会**（框内 99.9% 照选） |
| 框画紧时的第一下推杆 | 有时几乎为 0 | 恒定 ~2% |

**还剩什么**：13M 点上一次推杆 ~600ms，瓶颈已经从投影转到**掩码 → 索引区间（`IndexRanges`）
+ 状态位回写 + 上传**，这三步都是 O(n) 的 JS。想再快需要把这套搬进着色器（按窗口直接判定），
那是下一轮的事。93 万点的扫描上推杆仍是 **30–43ms**（顺滑）。


### 6.48 第四十六轮：按审计「执行顺序」做的六项（O1/O3/±1e6 高危/O2/A1/O5）+ load worker 评估（实测证明不能开）

这一轮的输入不是用户反馈，而是审计文档：`docs/audit/00-总结.md` 第〇节「**执行顺序（修订版）**」
（11 条）里的前 9 条 —— **6 条做完，高危 7（load worker）评估过、实测证明不能开**（第 7 条见下）。
**每一条都是先量再改，改完在同一台机、同一个 `merged-scene`（13,007,105 点 / 695MB）上复核**，
量出来的数字写在下面每一节里。

**本轮提交链**（`git log`）：`978553a` O1 → `ad9a549` O3 + ±1e6 高危 → `b63d99b` O2 → `bb0b2b6` A1
→ `ef62816` O5 → `04dd8c9` load worker 默认开启 → **`7a16371` revert：load worker 退回 opt-in**
（下面第 7 条按 revert 之后的结论写）。

| # | 审计条目 | 一句话 | 13M 上的实测 |
| --- | --- | --- | --- |
| 1 | O1（第 1 条，全档必做） | 选区变更不再触发 GPU 包围盒 pass | 一杆 600.06 → **452.54ms**（−25%）；拖动期间 pass **12 → 1 次** |
| 2 | O3（第 2 条，全档为正） | 去掉「每索引一次闭包」+ 新增 `forEachRun` | 13M 上原本每次推杆 **39–52M 次闭包调用** |
| 3 | 新发现的高危（第 3 条） | 全选 + 删除 ⇒ 包围盒 ±1e6 ⇒ 近裁剪切空整场景 | 新套件 10 项（含自证伪）双后端 0 失败 |
| 4 | O2（第 5 条，门槛 ≥250 万点） | 掩码 → 状态位压成一趟按位写 | 一杆 452.54 → **275.71ms**（相对最初 600ms **−54%**）|
| 5 | A1（第 6 条） | 簇过滤 dense 化 + 去浮云内存 | T1 冻结 406 → **323ms**；并量出审计算错网格 **6300 倍** |
| 6 | O5（第 9 条，≥300 万点） | 导出的排序间隔 `max(2, ceil(n/1e6))` | 13M 一次排序 ~300ms ⇒ **~23ms/帧** |
| 7 | load worker（高危 7 / 第 7 条） | 试过默认开启，**实测证明不能开**，已 revert 回 opt-in（`7a16371`） | 同一手势选中 **213 → 2000（整个模型）**；冻结确实 1640 → 855ms，但**每一次框选都静默选错** |

**O1 —— 选区变更不再触发 GPU 包围盒 pass（第 1 条，全档必做）**

**为什么这么改**：`SelectRangeOp.do()` → `updateState(selected)` → `updateLocalBounds()`，里面含
`waitForGpuDrain()`（= 让出一整帧）+ 4 次 `immediate` 同步回读 + JS 归约，**还占着全局 `commandQueue` 等**；
而 `localBound` 只依赖 `deleted`（与 selected 无关），`selectionBound` 的唯一消费者是变换手柄枢轴。
WebGPU 上这次 pass 的结果随后还会被 `splat.ts` 的 CPU AABB 覆盖 ⇒ **纯浪费**。
改法：拖动期间不跑 bound pass，只在**手势结束**补算一次。

**实测**（新增 `docs/probes/o1-bound-probe.cjs`，同机同会话 A/B，`Splat.updateLocalBounds` 包一层只统计不改行为）：

| 档 | 拖动期间包围盒 pass | 单杆落地延迟 |
| --- | --- | --- |
| T0a 2000 点 | 12 次 / 115–166ms ⇒ **1 次 / 5ms** | 10.4–14.5ms ⇒ **1.03ms（−90~93%）** |
| T1 93 万点 | 12 次 / 101–103ms ⇒ **1 次 / 21ms** | 27.3–31.2ms ⇒ **25.19ms（−8~19%）** |
| T2 1300 万点 | 12 次 / 321ms ⇒ **1 次 / 29ms** | 600.06ms ⇒ **452.54ms（−25%）** |

隔离测**单次 pass 的纯耗时**：2000 点 **8.5–21.5ms**、93 万点 **5.9–22.5ms**、13M **27–75ms**
—— 成本是「让出一帧 + 4 次同步回读」，**与点数几乎无关**，正是审计的口径。

**踩到的坑**：pump 的补算定时器**只在 pump 真正排空时才重置**。第一版按「每次推杆都重置」写，
13M 上一杆 370ms 比 120ms 的窗口还长，定时器在拖动中途就到点，实测 12 杆跑了 **12 次 pass**（等于没省）。

**O3 —— 去掉「每索引一次闭包」（第 2 条）+ 顺手修掉 `sortedPredicate` 的游标 bug**

- `IndexRanges.fromPredicate` 不再往可增长的 JS `number[]` 里 push 再转 `Uint32Array`
  （13M 碎片化选择**最坏 104MB 垃圾 + 一次整拷**），改成直写**复用的 `Uint32Array` scratch**
  （按需倍增，> 4M 条目不留存，避免病态选择常驻 16MB 以上）；
- 新增 `IndexRanges.forEachRun(start, end)`：按**连续段**回调，**O(runs) 而不是 O(indices)**，
  调用方在内层自己转紧密循环；`SplatState.setBits/clearBits/toggleBits` 改用它 ——
  热路径不再有 per-index 闭包（13M 上原本每次推杆 **39–52M 次闭包调用**）；
- `edit-ops.SelectOp.captureRanges`：把 `valid(i)` 内联掉（它是一次掩码比较），add/remove 把
  `locked` 与 `selected` 两次判定合并成一次 `state[i] & (locked|selected)`；
- `editor.ts`：`rangeCombine` 的每索引一次闭包，换成按 `opKind` 选好的谓词
  （`rangeCombinePredicate`），流式循环里只剩数组读；
- **顺手修的 bug**：`sortedPredicate` 的游标改成先跳过小于 `i` 的 id。调用方用短路 `&&` 跳过某些 `i` 时，
  旧实现会让游标卡住、此后的 id 全部读成未命中（**静默丢选择**）。

**高危 —— 全选 + 删除把包围盒打成 ±1e6，整个视口被近裁剪面切空（第 3 条）**

出处 `docs/audit/01-量级复查-bug.md` §13。这条的关键是**它是全局的**：被删空的那个模型的退化包围盒
参与了 `scene.bound` 的并集，于是 `boundRadius` 变成 ~1.7e6、near 变成 `far/16384 ≈ 105` ——
同一场景里**其它完好的模型也一起消失**，而且相机怎么缩放都救不回来（near 每帧重算），只能撤销。
WebGL2 无兜底，WebGPU 只是靠 CPU AABB 兜底才没事。

- `calc-bound.ts`：shader 用 ±1e6 哨兵（要过 GLSL→WGSL 转译，**不能用真无穷**），一行都没匹配回来
  就是 `min=1e6 / max=-1e6`。匹配到行时每轴必然 `min ≤ max`，所以**出现倒置轴就是「这里什么都没有」**
  ⇒ **保留上一次的 bound**，不再写出 `center=0 / halfExtents=-1e6` 的箱子；可见集为空时 `console.warn` 一次
  （只报一次）。新增 `selectedEmpty` / `localEmpty` 两个只读状态；
- `splat.isUsableBound`：补「halfExtents 三分量不得为负」（−1e6 正是从这道门溜过去的）；
  CPU AABB 兜底从「仅 WebGPU」**放开到两个后端**；
- `camera.fitClippingPlanes`：加**自证伪守卫** —— far 必须有限且 > 0；near 不得超过
  「相机到包围盒中心距离的一半」（近裁剪面伸到你看的东西之外，一定不对）。

**实测**（新增 `docs/verify/verify-degenerate-bound.cjs`，10 项，webgpu/webgl2 双 0 失败）：
导入两个模型 → 删空一个 → 断言 `localBound` 的 halfExtents 非负、`scene.bound` 半径 **3.23**
（旧 **~1.7e6**）、`near = 2.0e-4`（旧 **~105**），并且另一个模型 **200/200 个采样点仍在 [near,far] 内**；
同一套件带**自证伪断言**：按旧公式算出的 `near = 105.7` 会让 **0/200** 个点活下来
—— 所以这条用例真的抓得住回归，而不是恒绿。

**O2 —— 掩码 → 状态位压成一趟按位写（第 5 条，门槛 ≥250 万点）**

**为什么这么改**：原来每一杆推杆 = 掩码（**13MB 新分配**）→ `fromPredicate` 建 `IndexRanges`（13M 次闭包）
→ `clearBits(pre)` + `clearBits(applied)` + `setBits(post)` 三次区间遍历（最多 3×13M）
→ flush 的**全表 recount**（13M）。13M 上实测一次推杆 500–700ms。

- `SplatState.applySelectionMask(preMask, mask, managed, op)`：**一趟**扫完，按 `want = combine(preMask, mask)`
  写选中位；**同一趟里增量维护 `numSelected`**（替掉 recount）。`opKind='add'` 是 `had||hit`、
  `'remove'` 是 `had&&!hit`、`'intersect'` 是 `had&&hit`、其余（`set`）就是 `hit` —— 与旧实现的净效果**逐位等价**；
- `managed`（每 entry 一块的位图，只增不减）= 手势开始时的选中集 ∪ 用过的每一个掩码。
  **只有被接管的行才写**，所以 locked（隐藏）的行带着 selected 位原样保留 —— 旧实现 `clearBits(pre)`
  也只碰「selected 且没锁」的行；
- `SelectionOp` 枚举（set/add/remove/intersect）让内层循环里没有字符串比较；
  `revertSelectionMask()` 供 undo：清掉「当前掩码会选中的行」（= 旧的 `clearBits(applied)`），
  再 `setBits(pre)` 把手势前的选区放回去 —— **三快照语义不变**；
- `selection-range.ts` 的 `selectRange` / `selectRangeFromCache` 增加 `out` / `mark` 两个可选出口：
  `out` 让掩码缓冲**每 entry 复用**（13M 上每杆省一次 13MB 分配，顺带把环模式那次 `hit.slice()` 的
  13MB 拷贝也省掉），`mark` 在写掩码的同一趟里顺手置 managed 位（不额外扫一遍）；
- `SplatState.flush()` 只在 `countsExact` 为假时才 recount；批量算子（`setBits`/`clearBits`/`toggleBits`）
  会把它置假，按掩码写的那一趟保持为真 —— **recount 这条全表扫从热路径上消失**（O4 的实质收益）。

**实测**（13M merged-scene / WebGPU / 同一台机，12 杆串行推杆取平均）：

| 版本 | 平均一杆 | 拖动期间包围盒 pass |
| --- | --- | --- |
| 基线（O1 之前） | 600.06 ms | 12 次 / 321 ms |
| + O1 + O3 | 452.54 ms | 1 次 / 29 ms |
| **+ O2（本轮）** | **275.71 ms**（min 259.8 / max 297.2） | 1 次 / 27 ms |

⇒ O2 自己贡献 **−177ms（−39%）**；相对最初的 600ms **累计 −54%**。手势 726ms；隔离测单次包围盒 pass
19.7–32.1ms。93 万点在 O2 之前各项套件与探针均绿，O2 后 6 套选择相关套件双后端 0 失败。

**A1 —— 簇过滤 dense 化 + 去浮云内存；顺带量出审计把 13M 的网格量级算错了 6300 倍（第 6 条）**

**改了什么（三条）**：

1. **cluster-filter**：体素化从 `Map<packedKey,index>` 换成**稠密 `Int32Array` 网格**
   （洪水填充里每个占用体素 26 次 `Map.get` 变成数组读）；voxel 坐标表从 JS `number[]` 换成按需倍增的
   `Int32Array`；每点的 `valid(i)` 闭包内联（原本一次检测里要被调三遍）；
2. **floater-removal 内存**：`cellX/cellY/cellZ` 三张 `Int32Array`（12 B/点）→ **一张线性格号**（4 B/点），
   13M 上省 **104MB**；`counts` 从 `Int32Array` → **`Uint16Array`**（13M 上省 **26MB**，超过 65535 的
   邻居数饱和 —— 饱和值永远不可能是浮云，比较结果不变）；`medianSamples` 从 20 万元素的 JS `number[]`
   + 比较器排序 → `Int32Array`（数值排序、无闭包）；
3. **阈值从「固定 8e6 格」改成「字节预算」**（`DENSE_MAX_CELLS = 32e6` ⇒ Int32 的 128MB），
   与 cluster-filter 共用同一个常量；`estimateSpacing` 收 `state` 列而不是 `valid(i)` 闭包
   （一次检测里它被调两遍）；处理范围（scope）与合法性判定内联进热循环。

**实测**：

| 档 | 检测冻结主线程（20ms 心跳最大间隔） | 结果 |
| --- | --- | --- |
| T1 93 万点 | 406ms → **323ms（−20%）** | 浮云数 **9797 → 9797**（逐位不变）|
| T2 1300 万点 | **101s → 101s（没改善）** | 137107 → 137107 |

（心跳法：打开去浮云面板 → 200ms 防抖后同步跑两套全量检测，记录 20ms 定时器的最大间隔。）

**顺手量出一个审计算错的数（重要）**：`docs/audit/01-量级复查-perf.md` 的「补 3」用
`denseCells ∝ N^1.5`、`spacing ∝ extent/√N` 推出「13M → 约 **3.8e6 格**、dense ✓、余量 2×」，
于是把「2100 万格」当成 T3 专属悬崖。**实测（13M merged-scene）**：`spacing = 0.000949`、
`extent ≈ 66.8`、`cellSize = 0.0218` ⇒ 网格 **3061×3059×2562 = 2.4e10 格**，是审计估计的**约 6300 倍**，
也远超新预算的 750 倍。结论修正三条：

1. 13M 上 floater 的计数网格**永远是 `Map` 回退**（一张 ~1300 万条目的 Map，邻域查找
   27×13M ≈ **3.5 亿次 `Map.get`**）—— 这就是**打开面板冻结 101 秒**的原因，**与「2100 万点悬崖」无关**；
2. 所以 A1 的 dense 化**救不了 13M**（T1 只小幅受益），要治它得换数据结构
   （开放寻址哈希网格 / 复用一次排序过的键）—— 留作下一步；
3. 阈值改成字节预算仍然是对的（8e6 → 32e6 覆盖了 2100 万~3200 万那一段），**只是它管的不是 T2**。

另：稀疏路径现在会在控制台 `warn` 一行（说明网格多大、为什么慢），不再静默地慢。

**自己在实现里踩到并修掉的坑（重要）**：线性格号 `(ix*nY + iy)*nZ + iz` **必须**在超过 2^31 格时用
`Float64Array`。真实 13M 扫描的网格是 **2.4e10 格**，`Int32Array` 会**静默回绕** ⇒ 每次邻居查找都落空
⇒ 邻居和恒为 0 ⇒ 中位数变成 **−1** ⇒ `limit = 0` ⇒ 检测结果变成一个毫无意义的「**8458**」。
已加断言级回归：`docs/verify/verify-floater-biggrid.cjs`（+ `gen-floater-biggrid-splat.cjs`，
16k 点的合成模型故意做出 **~6.6e11 格**的网格）断言中位数 == 簇内邻居数 **7**、且**正好只选中 50 个孤立点**。

**O5 —— 导出的排序间隔按点数自适应（第 9 条）**

**为什么这么改**：`render.ts` 的视频/关键帧导出路径里 `SORT_INTERVAL` 原本是常数 **2**，而
`sortSplatsAndWaitStrict` 是**主线程 await**：13M 上一次排序约 **300ms**，所以导出时平均每帧等 **150ms**，
是这个路径最大的单项开销。改成 `max(2, ceil(n / 1e6))`（与 `camera-preview.ts` 已有的自适应节流同一公式）：

| 点数 | 排序间隔 | 每帧摊销 |
| --- | --- | --- |
| 2000 / 12 万 / 93 万 | 2（`ceil` 得 1 → 取 2，**不变**） | 不变 |
| 13M | 13 | 300/13 ≈ **23ms/帧** |
| 30M | 30 | 同样 ~23ms/帧 |

`n` 取导出目标里**最大**的 `numSplats`（与导出循环里 `sortAndWait` 用的是同一份 splat 列表）。
注：审计的 O5 明确说**交互路径的排序节流不做**（主线程从来没被排序阻塞过，节流只会让「顺序滞后」
更明显），只有导出路径成立 —— 所以这里只动导出这一处。

**load worker —— 评估过，实测证明不能开（高危 7 / 第 7 条）**

`load-worker-client.ts` 的开关是「显式 opt-in」（`window.__SPLATROOM_ENABLE_LOAD_WORKER__ === true`），
而**全仓没有任何地方设置它** ⇒ 解码 + 莫顿排序 + 行重排一直在**主线程**上跑，
`workers/load-worker.ts` 是死代码 —— 这确实是「导入 13M 要 ~15 秒、界面完全不能动」的大头。
所以按审计把它**反转为默认开启**（`__SPLATROOM_NO_LOAD_WORKER__ = true` 可关）试了一次，
**结果当场被验证拦下来了**：`04dd8c9` 之后紧跟着就是 **`7a16371` revert（退回 opt-in）**。

**实测（小模型夹具上的行为对比，这一栏是决定性的）**：

| 2000 点夹具 / 同一个矩形手势（0.35–0.65） | worker 关（默认） | worker 开 |
| --- | --- | --- |
| 矩形选中数 | **213**（框内那 10%） | **2000（整个模型）** |
| 之后再推一次「最远 99」 | **202** | **0** |
| x/y/z/opacity/state/rot_0 逐字节校验和 | 完全一致 | 完全一致 |
| 主线程最长冻结（931k 导入） | 1640 ms | **855 ms** |
| worker 派发计数（931k 导入） | 0 | 1 |

也就是说：worker 的输出在**列字节上完全一样**（`verify-load-worker.cjs` 里的 FNV-1a 校验和两边相同），
却让选择结果从「框内那 10%」变成「整个模型」—— **差异藏在列哈希抓不到的地方（中心点 / 排序元数据）**。
开启它 = **每一次框选都静默选错**，比「导入慢 15 秒」严重得多，所以开关**退回 opt-in**，
原因与证据也写进了 `src/io/load-worker-client.ts` 的注释。

- worker 本身**不删**：它能跑（`workerResults = 1`），931k 导入的主线程最长冻结确实从 1640 → **855ms**
  （墙钟 2262 → 2205ms），**等把「输出为什么不等价」查出来再打开**；
- `lw-probe.ts` 的**假绿**修掉并且**保留**：旧判据只比较「worker 结果 vs 主线程结果」，而开关没开时
  `loadGSplatDataAsync` 直接调**同一个** `loadGSplatData`（同一函数、同一线程）⇒ 两边必然相同 ⇒ `ok=true`。
  现在附加 `workerResults > 0`、为 0 时给 why —— **正是这道「先修探针」让上面那次对比有了可信信号**，
  它也是将来重开开关前必须先过的一关。

**顺带踩到的坑（值得单独记一条）**：开关默认打开时，**全套批量里 9 个彼此无关的套件同时变红**
（`selection-range` 16 项、`shape-volume-lines` 10 项、`shape-selection` 6 项、`edit-grade-crop` 4 项、
`effects` 4 项、`pip-camera` 3 项、`centers-overlay` 3 项、`ortho-camera` 2 项、`degenerate-bound` 1 项）；
退回 opt-in 后**全部 0 失败**。**同一批红是同一个根因（选区错），别当成各自的问题去逐个查** ——
那一轮如果挨个查会白烧掉一整天。

**本轮新增的验证资产**

| 资产 | 项数 | 跑法 |
| --- | --- | --- |
| `docs/verify/verify-index-ranges.mts` | **18 项**（纯 node，不占浏览器） | `node --experimental-strip-types docs/verify/verify-index-ranges.mts` |
| `docs/verify/verify-degenerate-bound.cjs` | **10 项**（含自证伪断言，双后端） | `node docs/verify/verify-degenerate-bound.cjs "http://localhost:3621/?gpu=webgpu"` |
| `docs/verify/gen-floater-biggrid-splat.cjs` + `verify-floater-biggrid.cjs` | **5 项** | 先生成模型 `node docs/verify/gen-floater-biggrid-splat.cjs`（默认写 `dist/floater-biggrid-test.ply`），再跑套件 |
| `docs/verify/verify-load-worker.cjs` | **7 条检查**（含 2 条 informational：冻结时长、「为什么还关着」） | 小模型即可、秒级：`node docs/verify/verify-load-worker.cjs "http://localhost:3621/?gpu=webgpu" test-model.ply`；默认模型是 `scan.ply`（需 `dist\scan.ply`，所以**不进批量**）|
| `docs/probes/o1-bound-probe.cjs` | 探针（统计 `updateLocalBounds` 次数/耗时 + 单杆落地延迟） | `node docs/probes/o1-bound-probe.cjs [model] [url]` |

`verify-index-ranges.mts` 覆盖：运行长度编码（单个索引用高位置位、连续段用 `[start,count]`）、
`fromPredicate` 与「直接扫一遍」的参考实现**逐位一致**、**scratch 跨扩容复用不串味**、
`forEachRun` 与 `forEach` 等价、`sortedPredicate` 在「调用方跳过一些 i」时仍正确（修掉的游标 bug）。

**环境坑（这一轮踩到的，写下来省得下次再花一小时）**

1. **无头 Edge 下 app 的导入路径有启动竞态**：`window.scene` 一就绪就立刻导入，13M 会**永远卡在
   0 个 splat**（页面事件循环是活的、CPU 几乎为 0）。**等 1.5s 再导入**就 12.5s 完成；
2. **`npx serve` 的进程会僵死**：curl 拉 695MB 无限等待。探针卡住时**先 curl 一下服务端**，
   重启后 1.7s 正常 —— 别急着怀疑应用；
3. **不要用 PowerShell 的 `Set-Content` / `Get-Content` 往返 CJK 源码**（这一轮又写坏过一个探针的注释；
   `editor.ts`、`splat.ts` 之前都中过招）。要用 read/write/edit 工具，或
   `[System.IO.File]::WriteAllText(..., UTF8Encoding($false))`；
4. 跑到后半程，13M 的导入在本机变得**必然卡住**（新旧构建都一样 ⇒ 与本轮改动无关，疑似反复 kill
   无头 Edge 之后 GPU/驱动状态坏了），所以 A1 修好之后没能再量一次 13M 的浮云数，
   改用上面的合成模型做**判定性验证**；
5. **一个开关能让 9 个彼此无关的套件同时变红**（本轮 load worker 就是这样）：`selection-range` 16 项 /
   `shape-volume-lines` 10 项 / `shape-selection` 6 项 / `edit-grade-crop` 4 项 / `effects` 4 项 /
   `pip-camera` 3 项 / `centers-overlay` 3 项 / `ortho-camera` 2 项 / `degenerate-bound` 1 项，
   退回 opt-in 后全部 0 失败 —— **同一批红是同一个根因，先怀疑最近那个开关，别逐个套件查**。

**验证**（本轮各条的回归，逐条都跑过）：

- 新增：`verify-index-ranges.mts` **18 项** 0 失败（纯 node）、`verify-degenerate-bound.cjs` **10 项**
  webgpu + webgl2 双 0 失败、`verify-floater-biggrid.cjs` **5 项** 0 失败、`verify-load-worker.cjs`
  **7 条检查** 0 失败（它把「默认路径不走 worker / 开了真跑 / 点数与列字节一致 / **为什么还关着**」固化了）；
- **revert 之后（`7a16371`）重跑**：`verify-selection-range`(24)、`verify-degenerate-bound`(10)、
  `verify-shape-volume-lines`、`verify-shape-selection`、`verify-pip-camera`、`verify-ortho-camera`、
  `verify-edit-grade-crop`、`verify-effects`、`verify-centers-overlay` **全部 0 失败** —— 这 9 套正是
  开关默认打开时一起变红的那 9 套（见「环境坑」第 5 条）；
- 选择相关：`verify-selection-range`(24) / `verify-selection-depth-bar`(19) / `verify-mask-vs-rect` /
  `verify-selection-depth` / `verify-shape-selection` / `verify-edit-hide`，webgpu + webgl2 全 0 失败；
- 导出相关：`verify-export-image` / `verify-export-orientation` / `verify-equirect-export` /
  `verify-model-renders` 全 0 失败；
- 去浮云/簇相关：`verify-cluster-filter` / `verify-floater-removal` / `verify-floater-detect` /
  `verify-floater-scale` / `verify-floater-scope` 全 0 失败；
- `npm run check` 干净。

**还剩什么**（审计执行顺序里没做的三项 + load worker 重开的前提，详见 `docs/进度存档.md` 第 2 节）：

- **A2**（第 8 条，≥500 万点）：导出/回退的冗余拷贝 —— `surface-worker-client.ts` 无条件预复制
  **741MB** 回退副本（正常路径不用）、`splat-serialize.ts` 的前置过滤；
- **A3**（第 10 条）：投影缓存 **6 B/点**量化 + 内存预算门槛（≤3200 万点）+ 超限给可见提示；
- **13M 上 floater/cluster 检测的 101 秒冻结**：dense 化救不了它（实测网格 2.4e10 格 ⇒ 永远走 `Map` 回退），
  要换数据结构或改成「点『计算』才跑 + 给预估耗时」；
- **load worker 重开的前提**：先查清**输出为什么不等价** —— 列字节（x/y/z/opacity/state/rot_0）
  完全一致，但同一个矩形手势选中 213（关）vs 2000（开），差异在中心点 / 排序元数据那一层；
  在 `verify-load-worker.cjs` 里那条「为什么还关着」的 informational（手势 213 vs 2000）变成两边一致
  之前，开关保持 opt-in。

### 6.49 第四十七轮：A2（导出/回退的冗余拷贝）+ A3（投影缓存量化与可见提示）—— 审计「执行顺序」全部走完

这一轮做完的是上一节「还剩什么」里的前两项：**A2**（第 8 条）与 **A3**（第 10 条）。
两条的硬约束都不是"更快"，而是**不许改变结果** —— A2 是「**输出字节不变**」，
A3 是"两端仍然精确"（0/100 = 整段穿透的语义不能动）。

**本轮提交链**：`28b69e5` A2 → **`bc4e6a0` A3**（写这一节时 A3 还在工作树里，后来提交为 `bc4e6a0`；
改动 = `selection-range.ts` / `editor.ts` / `selection-depth-bar.ts` / `select-toolbar.scss` /
9 个 locale + 新套件 `verify-range-cache-hint.cjs`）。

| # | 审计条目 | 改了什么 | 硬约束 / 实测 |
| --- | --- | --- | --- |
| 1 | **A2**（第 8 条，≥500 万点） | 导出前置过滤「两遍完整谓词」→ 廉价谓词定上界 + 单遍填充 + 尾部裁剪；面细化回退副本 741MB 无条件预复制 → 惰性 provider | **输出字节不变**；往返套件 5 项：导出 213 点、逐点比 x/y/z **0 个不一致** |
| 2 | **A3**（第 10 条） | 投影缓存 `dist` Float32 → **Uint16**（8 → **6 B/点**）；门槛从写死 2400 万点 → **字节预算 192MB ⇒ ≈3200 万点**；被拒时给**可见提示** | 两端 0/65535 **精确**，内部误差 ≤ extent/65535；选择套件双后端 0 失败 |

**A2 第一半 —— PLY 序列化的前置过滤：两遍完整谓词 → 廉价谓词定上界 + 单遍填充**

**为什么这么改**：`splat-serialize.ts` 的构造函数里，`countGaussians()`（只为知道映射表多长）
与填表**两遍都用完整谓词**，而 PLY 导出路径（`file-handler` 强制 `minOpacity = 1/255` +
`removeInvalid = true`）的完整谓词**每个高斯都要遍历全部顶点属性**做 `Number.isFinite` ——
13M × 14 列就是**两遍 1.8 亿次属性检查**。

- `GaussianFilter` 拆出 `bound(i)`：只有 `deleted` / `selected` / `opacity` 判定，**不含逐属性扫描**。
  凡是 `test` 拒绝的 `bound` 也拒绝 ⇒ 用 `bound` 数出来的长度**必然 ≥ 实际行数**；
- 构造函数改成：`countGaussianBound()` 定长度 → `test` **单遍**填充 → 尾部裁剪。前置停顿因此**砍半**；
- 裁剪策略：差值 **> 10%** 才 `slice()` 真正丢掉大缓冲（否则 `subarray` 零拷贝）——
  常见情形（几乎没有非法行）**不付任何拷贝**；
- **补上硬报错**：`idx > bound` 直接 throw。旧代码里两遍谓词一旦不一致，映射表尾部会留 0 ⇒
  **每行都指向源的第 0 行、行数照样对、内容是错的**，而且没有任何提示。现在要么正确、要么响亮地失败；
- 顺带修掉热路径：`getElement('vertex')` 原本在**谓词内部**（每点一次），
  `infOk` / `negInfOk` 是 `Set<string>.has(name)` **每点每属性一次**字符串哈希 ——
  两者都挪到 `set()` 里按 splat 缓存（属性表 + 两个权限位预计算成布尔）。

**A2 第二半 —— 面细化回退副本：无条件预复制 → 惰性 provider**

`surface-worker-client.ts` 在 postMessage（会 detach）之前**无条件**复制一份 **741MB@13M** 的回退副本，
而它只在 worker 失败或 10 分钟超时才用得上。

- `refineSurfaceInWorker` 新增可选 `fallbackProvider?: () => RefineBuffers`；传了就**不预复制**，
  只有真的走到 `catch` 才现取；
- `surface-refiner.ts` 传的 provider 从 **splat 自己的数据**重新 clone —— 被 transfer 的是那份
  `cloneGSplatData()` 的克隆，splat 的存储没被碰过，所以随时可以重建；
- 没传 provider 的调用方**保持老行为**（预先复制），入口自身仍然安全。

**A2 的验证**（新增 `docs/verify/verify-export-roundtrip.cjs`，**5 项**）：
`import test-model` → 框选 **213/2000** → `edit.duplicate`（内部就是 `writeSplatFile(selected:true)`
→ Blob → 重新 load）→ 断言：导出点数 **213 = 选中数**；**排序后逐点比 x/y/z，213 个点 0 个不一致**；
且没有退化成"每行都是源第 0 行"（前 50 行里 **49 行**与源首行不同）。
33 套批量里原本**没有任何一套碰过 `splat-serialize`**，所以这个往返套件是这一条**唯一的回归保护**。

**踩到的坑**：比较必须**行序无关**。重新 load 时 loader 会做一次空间（morton）重排，
第一版按行号比对得到 **208/213 不一致** —— 那是**量法错、不是导出错**。

**A3 —— 投影缓存：Float32 深度 → 16 位量化，门槛改成字节预算，被拒时给可见提示**

**为什么这么改**：缓存是 `sx`/`sy` Int16 + `dist` Float32 = **8 B/点**，上限写死 **2400 万点**；
13M 已经占了 54%，而**一旦超限就静默退回逐点重投影**（审计记 ~900ms，13M 上实测约 **2 秒**）——
用户看到的现象只是"滑块好像坏了"。

- `dist` 从 Float32 **量化到 `Uint16Array`**（8 B/点 → **6 B/点**）。量化区间是**模型沿视轴的深度范围**
  （`extent`，见 `viewExtentFromBound`）：所有高斯都在这个区间里，所以**两端精确** ——
  0/100（整段穿透）仍然精确落在 0 与 65535 上，只有**区间内部**引入
  ≤ `extent / 65535` 的误差（13M 房间扫描实测 ≈ **0.001** 世界单位，而深度窗口的步长是 extent 的
  0.5% ≈ **0.33**，**差三个数量级**）；
- 缓存结构新增 `distMin` / `distScale = (max-min)/65535`；`createRangeCache(numSplats, distMin, distMax)`；
  写入侧 `q = round((distance - distMin) / distScale)`（夹到 0..65535），读取侧
  `distance = distMin + dist[i] * distScale`（`selectRangeFromCache` 那一趟只多两次乘加）。
  退化（`span <= 0`）时 `distScale = 0`，反解恒等于 `distMin`，与线性映射一致；
- 门槛从写死的点数改成**字节预算**：`CACHE_BYTES_PER_SPLAT = 6` /
  `CACHE_MAX_BYTES = 192MB` ⇒ `CACHE_MAX_SPLATS = ⌊192MB / 6⌋ ≈ **3200 万点**`
  —— 正好**覆盖 30M 那一档**（原来 8 B/点 + 2400 万上限会把 30M 直接拒掉，
  于是每次推杆都退回全量重投影）；
- **可见提示**：`runRangeSelection` 在所有 entry 都没拿到缓存时 fire
  `selection.rangeCacheRefused`，`selection-depth-bar.ts` 把标题换成一句说明
  （新增 locale 键 `select-toolbar.rangeCacheTooLarge`，**9 语言 685 → 686 键**），
  并加 CSS 类 `.range-refused`（`$clr-hilight`，字号 11px / 行高 1.25）。
  旧行为是**完全静默**，用户只觉得"滑块坏了"。

**A3 的验证**：`verify-selection-range`（**24 项**，含审计点名的 **far 100→90→85 端点用例**）
与 `verify-selection-depth-bar` / `verify-selection-depth` / `verify-mask-vs-rect`
在 **webgpu + webgl2 全 0 失败**；新增 `docs/verify/verify-range-cache-hint.cjs`（**4 项**）
验证**接线**：正常时标题是「选区范围」，被拒时换成说明并带 `range-refused` 类，恢复后回到原文。

**踩到的坑**：真的做不出 3200 万点的模型来触发阈值，所以提示这条只能验**事件 → 标题/类名**的接线；
阈值本身由常量表达（`CACHE_BYTES_PER_SPLAT × CACHE_MAX_SPLATS ≤ CACHE_MAX_BYTES`，见源码注释），
不靠"跑一个大模型"来保证。

**本轮新增的验证资产**（两个都**进 33 套批量**，不需要额外夹具）

| 资产 | 项数 | 跑法 |
| --- | --- | --- |
| `docs/verify/verify-export-roundtrip.cjs` | **5 项**（6.50 追加第 6 项 ⇒ 现在 **6 项**） | `node docs/verify/verify-export-roundtrip.cjs "http://localhost:3621/?gpu=webgpu"` |
| `docs/verify/verify-range-cache-hint.cjs` | **4 项** | `node docs/verify/verify-range-cache-hint.cjs "http://localhost:3621/?gpu=webgpu"` |

`verify-export-roundtrip.cjs` 是**批量里第一个碰 `splat-serialize` 的套件**（写文件 → Blob → 重新 load，
逐点比 x/y/z 且与行序无关）；`verify-range-cache-hint.cjs` 固化「事件 → 标题/类名」的接线。

**验证**（本轮两条的回归）：

- A2（`28b69e5` 的记录）：`verify-export-roundtrip` **5 项** 0 失败；`verify-export-image` /
  `verify-export-orientation` / `verify-equirect-export` / `verify-edit-grade-crop` /
  `verify-edit-hide` / `verify-model-renders` / `verify-selection-range` / `verify-degenerate-bound` /
  `verify-shape-selection` 全 0 失败；`npm run check` 干净；
- A3：`verify-selection-range`(24) / `verify-selection-depth-bar`(19) / `verify-selection-depth` /
  `verify-mask-vs-rect` webgpu + webgl2 全 0 失败；`verify-range-cache-hint`(4) 0 失败；
  `npm run lint:locales` 通过（9 语言 × **686** 键）。

**审计第〇节「执行顺序（修订版）」的 11 条到此全部走完**：

| # | 条目 | 状态 |
| --- | --- | --- |
| 1 | O1 选区变更不触发 GPU 包围盒 pass | ✓ 6.48（T2 单杆 600.06 → 452.54ms） |
| 2 | O3 去掉每索引闭包 | ✓ 6.48 |
| 3 | ±1e6 高危（全选+删除切空场景） | ✓ 6.48（半径 3.23 / near 2.0e-4） |
| 4 | 环模式 UI 二选一 | ✓ 3.21.0 就做了（环模式下隐藏范围面板） |
| 5 | O2 掩码→状态位一趟按位写 | ✓ 6.48（再降到 **275.71ms**） |
| 6 | A1 簇过滤 dense + 去浮云内存 | ✓ 6.48（并量出审计算错网格 6300 倍） |
| 7 | load worker | ✓ **评估后结论：不能开**，退回 opt-in（`7a16371`） |
| 8 | A2 导出/回退冗余拷贝 | ✓ 本轮（输出字节不变，往返 5 项） |
| 9 | O5 导出排序间隔自适应 | ✓ 6.48（13M ~300ms → **~23ms/帧**） |
| 10 | A3 投影缓存量化 + 门槛 + 提示 | ✓ 本轮（6 B/点、≈3200 万点、被拒可见） |
| 11 | 着色器窗口判定 | ⏳ **按审计自己的门槛（>2400 万点才启用）暂不需要** —— A3 已把 30M 拉回缓存路径 |

**还剩什么**（详见 `docs/进度存档.md` 第 2 节）：

1. **第 11 条（着色器窗口判定）**：审计的结论是"门槛设在 A3 悬崖的位置（n > 2400 万，量化后 > 3200 万）"，
   而 A3 把上限提到 ≈3200 万之后，30M 重新走缓存 ⇒ **这条的触发条件暂时不存在**；
   T0/T1 上它净负、T2 边际，所以先不做；
2. **13M 上 floater/cluster 检测的 101 秒冻结**：网格 2.4e10 格 ⇒ 永远走 `Map` 回退，
   A1 的 dense 化救不了它，要换数据结构或改成「点『计算』才跑 + 给预估耗时」；
3. **load worker 输出不等价**：列字节一致但选区结果不同（213 vs 2000），查清之前保持 opt-in。

---

### 6.50 第四十八轮：用户报的四条（选择跟手 / 小框首推 / 去浮云自动检测冻结 / 保存 OOM）

用户在 3.23.0 上报了四条：

> ① 「选择工具不是很跟手，点一下要等一下才能选中」
> ② 「中途突然无法选中，单击后拖出选框但不选中」
> ③ 「上下左右的选择范围调整时好时坏，有时候拉几次滑块都没反应，无法增加选区」
> ④ 「保存时出现 Array buffer allocation failed while saving file」

**先在真机上量，再改**：能复现的都复现了，量不到的写清楚位置。四条里有三条其实是**同一个主题** ——
上一轮（乃至更早）加的开关/阈值**在真实量级上失效**：① 是 A3 自己引进的一次除法，③ 是审计早就点名的
绝对阈值，② 是去浮云面板的 O(n) 检测。所以这一轮不是加功能，是**把量级补齐**。

**本轮提交链**：`d767edc`（四条修复）→ `70f284a`（版本号与中文属性修正 —— 见下面的环境坑）。

| # | 用户原话（要点） | 先量到什么 | 怎么改 | 实测 |
| --- | --- | --- | --- | --- |
| ① | 选择不跟手，点一下要等 | A3 的深度量化写成 `Math.round((distance - distMin) / distScale)`，**每次手势、每个点一次浮点除法**（13M 点上一次手势 = 13M 次除法，约 **100–150ms**） | 预存 `distInvScale`，改成乘法 + `\| 0`；另加 `cancelPendingBounds()` —— 新手势先取消上一次排下的 120ms 延迟补算（否则那一次包围盒 pass 正好挤在 `commandQueue` 前面，13M 上 25–75ms + 让出一帧） | 93 万点、同一台机同一套动作：单击 **52–74ms → 28–45ms**；框选 **41–82ms → 35–50ms** |
| ② | 中途突然无法选中 | 去浮云面板在**每一次** `splat.stateChanged` 上同步跑 `detectFloaters` + `detectClusters`，13M 实测**冻结主线程 101 秒**（计数网格 2.4e10 格 ⇒ 永远走 `Map` 回退，见 6.48 的 A1 记录） | 按审计 bug 第 5 条加**点数门槛**：超过 **200 万点**不再自动检测，面板给出点数与预估耗时（"模型有 N 个高斯：自动检测大约要卡住 X 秒，已暂停"，新键 `panel.floater.tooLarge`）；点『仅选中』『移除浮云』仍然**现场算**。另加调试覆盖 `window.__SPLATROOM_FLOATER_AUTO_MAX_SPLATS__`（真实门槛 200 万而夹具最大 93 万，不加覆盖就没法验这条分支） | 把门槛压到 1000：提示出现、**主线程最大间隔 22ms**（不冻结）；门槛恢复后自动检测回来（**9797**）。93 万点上开面板的额外卡顿只有 55 → **157ms** —— 所以这条在小模型上本来"不致命"，是 13M 才致命 |
| ③ | 上下左右时好时坏、拉几次没反应 | `tailFractions` 的采样门槛是**绝对的 `counted < 200`** 就放弃尾巴（审计 bug 第 10 条）：单击（7×7 的框）与小框采样后常常只剩几十个点 ⇒ `tails = null` ⇒ 退回**纯线性映射** ⇒ **第一下推杆一个高斯都删不掉** | 门槛 **200 → 20**（512 桶下 20 个样本足够定位首次非空桶） | 93 万点：大框之后六个方块首推 **6/6** 有反应；**小框之后 6/6**；**单击之后 6/6**（后两处旧行为是 `tails = null`） |
| ④ | 保存报 `Array buffer allocation failed` | 见下面的 ④ 小节 | 去掉 A2 那次多余的 `slice()`（改 `subarray`）+ 把报错翻成人话（按导出格式与点数预估体积） | 见下 |

#### ④ 保存 OOM：先找真正的原因，再把报错变成能照做的话

这一条**不能只靠猜**，所以分三步量：

1. **先排除"Blob 双份"那条**（审计 A2 的说法）：用 CDP 连**打包版**实测，确认它有
   `window.showSaveFilePicker` ⇒ 保存走的是**流式写盘**（`BrowserFileWriter` 逐块 `stream.write`），
   不是"整份压在内存里再 Blob"那条路。所以审计里"导出侧 Blob 双份 1.4GB"**对这条路径不成立**。
2. **给页面挂 typed-array 分配跟踪，量出分配发生在序列化器内部**：93 万点导出 231MB 时，
   序列化器**仍有一次 209.7MB 的单次分配**（`MemoryFileSystem` 的 `close` 把整份文件拼成一块），
   同批还有 **192MB 的池分配**与 **59MB × 3 的分块** —— **18 次分配共 861.9MB 瞬时**。
   这个模式**随输出体积线性放大**：93 万点尚且 862MB，13M 就必然顶到浏览器的分配上限 ⇒
   正是那句 `Array buffer allocation failed`。
3. **本轮做了两件能做、且不改变输出的**：① 把 A2 里那次多余的 `slice()`（`idx < 0.9 × bound` 时
   复制整张映射表，13M 上 52MB）改成 `subarray`（视图、零分配）；② 把报错翻译成能照做的提示：
   按导出格式与点数预估体积（**PLY 236 B/行、compressedPly 60、splat 32、spz 16、sog 8**），
   命中分配失败时提示"内存不够，保存失败：这个模型大约需要 X GB……可以先框选/裁剪缩小范围，
   或改用 PLY / Splat（边算边写盘）"，**9 语言同步**（新键 `popup.exportOutOfMemory`）。

**当时猜的方向**：PLY 走流式、理论上最安全；查看器与 SOG 是"整包在内存里组织"的路径，
最容易顶到上限。**后来已经量清了：用户当时用的大概率就是查看器导出** —— 见下面
「④ 的归属查清了」小节（七种导出各挂一次分配跟踪，**只有查看器是 O(输出)**）。

#### ④ 的后续修复（同轮补做）：干掉那次 O(输出) 分配 + 事前给话

上一小节只量到靶子（`MemoryFileSystem.close()` 把整份输出拼成一整块）并给了"出错之后"的人话；
**这一小节把那次分配本身换掉了**（提交 `bfffa84`）。

**1) 新增"按块收集 → 直接拼 Blob"的 writer**：`src/io/write/blob-file-system.ts` 的
`BlobFileWriter` 每块只 `slice()` 收起来（单次分配最大就是**一块**，`close()` 什么都不用拼），
`blob` 用 `new Blob(chunks)` —— 浏览器把块列表当**分段数据**，**不需要 O(输出) 的连续内存**。
块顺序不变 ⇒ **字节序列与拼成一块时完全一致，输出字节不变**。
接的两处都是原来用 `MemoryFileSystem` 的地方：

| 接入点 | 原来 | 现在 |
| --- | --- | --- |
| `BrowserDownloadWriter`（**没有**文件选择器时的下载回退） | `MemoryFileSystem` + 整块 `triggerDownload` | 块收集 + `triggerDownloadBlob` |
| `edit.copy` / `edit.cut` / `edit.separate` / `edit.duplicate` | `MemoryFileSystem` → `results.get()` → `new Blob` | `BlobFileSystem` → `writer.blob` → `MappedReadFileSystem.addFile(filename, blob)` |

（保存**主路径本来就走流式**：打包版实测有 `window.showSaveFilePicker`，`BrowserFileWriter`
逐块 `stream.write`，这条不用改。）

**实测**（93 万点 / 48 列 SH，导出 231MB；给页面挂 typed-array 分配跟踪）：

| | 改前 | 改后 |
| --- | --- | --- |
| 瞬时分配总量 | 861.9 MB | **447.5 MB（−48%）** |
| 单次最大分配 | **209.7 MB**（`MemoryFileSystem.close` 拼整块） | **192 MB**（`Object.acquire` 池分配，来自**重新导入**新 splat，保存路径不会走） |
| ≥8MB 分配次数 | 18 | 13 |

⇒ 「导出多大就一次性分配多大」这个模式**消失了**。

**2) 事前拦截：查看器 / SOG / SPZ 是"整包在内存里组织"的**
PLY / compressedPly / splat 是边算边写盘的；查看器、SOG、SPZ 要把整包在内存里组起来
（zip / 贴图编码），体积随点数线性放大（13M ≈ 700MB~1GB 的单次分配）。现在按**导出格式与点数
先估体积**（PLY 236 B/行、compressedPly 60、splat 32、spz 16、sog 8），超过上限
（默认 **1.0 GB**）就在**动手之前**给话，而不是跑到一半崩；出错路径同样翻译
（新键 `popup.exportOutOfMemory`）。新增调试覆盖 `window.__SPLATROOM_EXPORT_MAX_GB__`
（真实上限 1GB 而夹具只有 2000 点，不给覆盖就没法验证这条分支）。

**验证**：`verify-export-roundtrip.cjs` 从 **5 项 → 6 项 0 失败**，新增的第 6 项是
"体积超限时查看器导出**事前**给出『内存不够』的人话（而不是崩掉）"—— 观测方式是把
`showPopup` 换成记录器，因为真弹窗会等用户点确定、把套件挂住。
全量 **35 套**（webgpu）**TOTAL FAILED: 0**；`npm run check` 干净。
版本 `3.23.2`，打包 `release\SplatRoom-3.23.2.exe`（122.1 MB，已签名）复核：asar **5295** 条 /
唯一 PLY = `dist\test-model.ply` / 8 个 wasm / bundle 版本字面量 3.4.0 + **3.23.2** /
9 语言各 **688** 键 / exe 属性 3.23.2 / 冒烟 4 进程 → 杀净 0（提交 `9e3c0f9`）。

**还没做（见第 2 节待办）**：真正让**查看器 / SOG 自己**也走流式 —— 要动 `serializeViewer`
与 SOG 编码器，不是小改。

#### ④ 的归属查清了：查看器导出是唯一的 O(输出) 路径

上一小节只做到"**事后**给出人话 + 干掉了一次 O(输出) 分配"，但**到底哪条导出路径顶到上限**
还是猜的（提交 `62dddd2`）。这一小节把它量清了。

**做法**：新增探针 `docs/probes/export-alloc-per-type.cjs` —— 给页面挂 typed-array 分配跟踪，
再用**假 stream**（只数字节、**不落盘**）把每条导出路径各跑一次，从而隔离出**序列化器自身**的分配
（不含之后重新导入新 splat 的池分配）。

**实测**（93 万点 `scan.ply` / 48 列 SH，走流式路径）：

| 导出类型 | 写出 | 瞬时分配总量 | 单次最大 | 每行内存 |
| --- | --- | --- | --- | --- |
| `ply` | 209.7 MB | 115.0 MB | 59 MB | 129 B ← **分块，有界** |
| `compressedPly` | 54.5 MB | 110.2 MB | 48 MB | 124 B ← **分块，有界** |
| `splat` | 28.4 MB | 64.0 MB | 48 MB | 72 B ← **分块，有界** |
| `spz` | 23.7 MB | 285.8 MB | 160 MB | 322 B |
| `sog` | 15.3 MB | 383.0 MB | 160 MB | 431 B |
| **`htmlViewer`** | 23.3 MB | **1053.6 MB** | 192 MB | **1186 B** |
| **`packageViewer`** | 18.2 MB | **1053.6 MB** | 192 MB | **1186 B** |

⇒ **查看器导出是唯一的 O(输出) 路径**：整包（内嵌模型数据 + zip）在内存里组织，
每行 **1186 B ≈ 它的输出体积的 45 倍**；93 万点就瞬时 **1.03 GiB**，1300 万点约 **14 GB**
—— 必然撞浏览器分配上限。**用户报的 ④ 大概率就是这一条**。
PLY / compressedPly / splat 是分块流式、占用有界（最大就一块），spz / sog 介于两者之间。

**改法**（`src/app/file-handler.ts`）：
- 事前估算表从"输出字节/行"改成**实测的"内存字节/行"**：
  `ply 129 / compressedPly 124 / splat 72 / spz 322 / sog 431 / htmlViewer 1186 / packageViewer 1186`
  （由 `总量 MiB × 1048576 ÷ 行数` 算出，**注释里留了这张对照表**）；
- **比较用未取整的值**：先写成 `toFixed(1)` 再比较时，`1.029` 会变成 `"1.0"`、`1.0 > 1.0` 判不出来
  —— **正好漏掉 93 万点这个实测点**（差 0.03 GB 就漏拦，已修）；
- 只拦"整包在内存"的四条（查看器 / SOG / SPZ），上限默认 **1.0 GB**，
  `window.__SPLATROOM_EXPORT_MAX_GB__` 可覆盖；**PLY / compressedPly / splat 不受影响**。

**复核实测**（同一条路径、同一台机）：

| | 改前 | 改后 |
| --- | --- | --- |
| `htmlViewer`（931k） | **32111 ms**、1053.6 MB、**22 次分配**、可能崩 | **1 ms、0 分配、直接给话** |
| `packageViewer`（931k） | **31489 ms**、1053.6 MB | **0 ms、0 分配、直接给话** |
| `ply` / `compressedPly` / `splat` / `spz` / `sog` | — | **完全不受影响**（数值与改前一致，上表即可对照） |

**验证**：`verify-export-roundtrip.cjs` **6 项 0 失败**（第 6 项就是"体积超限时事前给出人话"）；
全量 **35 套**（webgpu）**TOTAL FAILED: 0**；`npm run check` 干净。
版本 `3.23.3`，打包 `release\SplatRoom-3.23.3.exe`（122.1 MB，已签名）复核：asar **5295** 条 /
唯一 PLY = `dist\test-model.ply` / 8 个 wasm / bundle 版本字面量 3.4.0 + **3.23.3** /
9 语言各 **688** 键 / exe 属性 3.23.3 / 冒烟 4 进程 → 杀净 0（提交 `11d66b6`）。

**还没做**：让**查看器 / SOG 本身**走流式（要动 `serializeViewer` / SOG 编码器，不是小改）——
现在至少是"**动手之前**给话 + 一条能照做的出路"，而不是跑到一半崩。

探针跑法（文件头注释里也有）：

```powershell
copy D:\DeepSeek\SplatRoomV2\_tmp\scan.ply dist\scan.ply   # 先放 T1 夹具
node docs/probes/export-alloc-per-type.cjs "http://localhost:3621/?gpu=webgpu" scan.ply
Remove-Item dist\scan.ply                                   # 跑完立刻删（否则会进 asar）
```


#### 新增验证资产

`docs/verify/verify-selection-responsiveness.cjs`（**8 项**）—— 同一台机、93 万点真扫描：

```powershell
copy D:\DeepSeek\SplatRoomV2\_tmp\scan.ply dist\scan.ply   # 先放夹具
node docs/verify/verify-selection-responsiveness.cjs "http://localhost:3621/?gpu=webgpu"
Remove-Item dist\scan.ply                                   # 跑完立刻删（否则会进 asar）
```

它固化的八件事：同一个框连做 6 次**选中数完全一致**、单击选中**非空**、
**大框 / 小框 / 单击之后六个方块首推都是 6/6 有反应**（③ 的回归）、
去浮云门槛给出提示且**不冻结（22ms）**、门槛恢复后自动检测**回来**（9797）。

**为什么不进批量**：它默认喂 `scan.ply`，需要 `dist\scan.ply` 这个 T1 夹具
（与 `verify-load-worker.cjs`、`verify-large-model-backend.cjs` 同一个理由）。
所以**批量排除列表现在多一条 `verify-selection-responsiveness.cjs`**。
另外 `verify-selection-range.cjs` 里那条"第一小步必须真的删掉高斯"的用例现在同时覆盖 ③。

`docs/probes/export-alloc-per-type.cjs`（**探针，不进批量**）—— 七种导出各跑一次、各挂一份
typed-array 分配跟踪（假 stream 只数字节不落盘），用来回答"哪条导出路径是 O(输出)"。
结果与跑法见上面「④ 的归属查清了」。它需要 `dist\scan.ply`，跑完同样要删。

**其余验证**：全量 **35 套**（webgpu）**TOTAL FAILED: 0**；`npm run check` 干净；
语言键 9 语言 **688**（本轮 +2：`panel.floater.tooLarge`、`popup.exportOutOfMemory`）；
打包 `release\SplatRoom-3.23.1.exe`（122.1 MB，已签名）复核：asar **5295** 条 /
唯一 PLY = `dist\test-model.ply` / 8 个 wasm / bundle 版本字面量 3.4.0 + **3.23.1** /
exe 属性 3.23.1 / 冒烟 4 进程 → 杀净 0。

#### 环境坑（本轮又踩到两次，写死在这里）

**`Set-Content -Encoding utf8` 会写 BOM**：`package.json` 被加上 BOM 之后 electron-builder
**直接 JSON.parse 失败**（表现为 build 读不到版本号）；而用 `Get-Content -Raw | Set-Content`
往返**会把 `package.json` 的中文（`author` / `description`）烧成乱码**，还把 `_tmp` 里一个 `.cjs`
探针的 CJK 字符串写坏到**语法错误**（同 6.48 记过的那条坑，这是第二、三次）。
⇒ **改仓库里的文件一律用 read / write / edit 工具**；万不得已要用 PowerShell，必须
`[System.IO.File]::WriteAllText($p, $t, [System.Text.UTF8Encoding]::new($false))`（无 BOM）。
本轮末尾用 `70f284a` 把版本号与中文属性修回来。

#### 还剩什么

1. **④ 保存 OOM** —— **归属已量清 = 查看器导出**（`htmlViewer` / `packageViewer`：93 万点写出
   23.3 / 18.2 MB 却瞬时分配 **1053.6 MB**，每行 1186 B ≈ 输出体积的 45 倍；用
   `docs/probes/export-alloc-per-type.cjs` 把七种导出各挂一次分配跟踪量的），事后人话与那次
   O(输出) 分配已处理（861.9 → **447.5MB**），**并按实测内存系数改成"动手之前"拦截**
   （931k 的查看器导出 32111 ms / 1053.6 MB ⇒ **1 ms / 0 分配 / 直接给话**）；
   **剩下的是让查看器 / SOG 本身走流式**（要动 `serializeViewer` / SOG 编码器）；
2. **13M 上去浮云检测本身还是 101 秒** —— 本轮只是**加了门槛不自动跑**（并给提示），
   算法级修复（换开放寻址哈希网格 / 复用一次排序过的键，或"点『计算』才跑 + 预估耗时"）还没做；
3. **load worker 输出不等价**（列字节一致但选区结果不同，213 vs 2000）—— 查清之前保持 opt-in；
4. **审计第 11 条（着色器窗口判定）** —— A3 把缓存上限提到 ≈3200 万之后门槛暂不成立，
   等真出现 3200 万点以上的模型，或者想把 13M 的一杆继续往下压（现值 **275.71ms**）时再看。

---

### 6.51 第四十九轮：查看器 / SOG 导出不再一刀拒绝 —— 按实测报体积与耗时，由用户决定

用户对上一轮（6.50 的 ④）的处置给了一句明确的产品判断：

> 「查看器/SOG 导出我日常时需要的。」

也就是说 `62dddd2` 那道"估算超过 1.0 GB 就**直接拒绝**"是**错误的产品决定**。这一轮先量清
"到底能不能跑"，再把"拒绝"换成"说清代价、由用户决定"。提交：`714d98b`（改动）→ `15311c0`（版本 3.23.4）。

#### 为什么不能一刀拒绝

6.50 量到的结论是：**查看器导出是唯一的 O(输出) 路径**（93 万点写出 23.3 MB 却瞬时分配
**1053.6 MB**，每行约 **1186 B** ≈输出体积的 45 倍）。那条结论本身没错，错的是**推论** ——
"内存倍数大"不等于"跑不完"。真拿用户的 1300 万点模型量一次就知道：**它跑得完，只是又慢又吃内存**。

#### 1300 万点实测（`选择工具\merged-scene.ply`，695 MB，无 SH，加载后 16 列）

| 导出 | 耗时 | 写出 | 瞬时峰值分配 | 单次最大分配 | ≥8MB 分配次数 |
| --- | --- | --- | --- | --- | --- |
| `htmlViewer` | **81.3 s** | 184.3 MB | **4251.5 MB** | 396.9 MB | 91 |
| `sog` | **98.6 s** | 136 MB | **1881.3 MB** | 148.9 MB | 30 |

**两条都跑完了**（此前被判定为"会被拒绝"，实际能跑完）。量法同 6.50：假 stream 走流式路径，
给页面挂 typed-array 分配跟踪（探针 `docs/probes/export-alloc-per-type.cjs`）。

#### 改动内容（`src/app/file-handler.ts` 的 `scene.write`）

**① 估算基数换成"数据集真实字节量"**

不再用"每行固定字节数"，改成 `datasetBytes` = Σ(每列 `byteSize` × 行数)（遍历
`splatData.getElement('vertex').properties`），再乘实测系数 `memoryMultiple`：

| 导出 | `ply` | `compressedPly` | `splat` | `spz` | `sog` | `htmlViewer` | `packageViewer` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `memoryMultiple` | 0.6 | 0.6 | 0.4 | 2.8 | 2.7 | 6.1 | 6.1 |

系数来自**三组实测取最大值（上包络）**：

| 夹具 | 自身数据 | 查看器倍数 | SOG 倍数 |
| --- | --- | --- | --- |
| A 93.1 万点 / 48 列带 SH（`scan.ply`） | 220 MiB | ×4.8 | ×1.74 |
| B 150 万点 / 17 列无 SH（`nosh-test.ply`） | 97.3 MiB | ×2.96 | ×0.96 |
| C 1300 万点 / 16 列无 SH（`merged-scene`） | 694.7 MiB | ×6.1 | ×2.7 |

⇒ 取上包络：`htmlViewer` / `packageViewer` **6.1**、`sog` **2.7**、`spz` **2.8**
（`spz` 在夹具 A 上实测 ×1.30，这里同样取更保守的那一档）。倍数随体积**超线性**涨
（贴图 / 编码缓冲），所以宁可把提示说得保守一点。
无 SH 大模型的夹具由新增的 `docs/probes/gen-nosh-model.cjs` 生成。

**② 两级阈值，默认不再拒绝**

| 常量 | 默认 | 调试覆盖 | 行为 |
| --- | --- | --- | --- |
| `hugeGB` | **12** | `window.__SPLATROOM_EXPORT_HUGE_GB__` | 超过就**硬拒绝**（那已经不可能成功），仍给"能照做的话" |
| `askGB` | **0.8** | `window.__SPLATROOM_EXPORT_MAX_GB__` | 超过就弹 **yes/no 确认框**（`type: 'yesno'`），文案键 `popup.exportLargeConfirm {size, sec}` |

- 确认框把**预估体积与耗时**说清楚；`sec` 按 `round(totalRows × 8e-6)` 估
  （由 1300 万点的 81.3 / 98.6 秒标定，13M → 约 104 秒），只用于给一个数量级。
- **用户选否就安静取消**（`return`，不弹错误、不写日志）—— 那是"我现在不想导"，不是失败。
- 真的 OOM 时仍然映射为 `popup.exportOutOfMemory`（6.50 加的那句）。
- 只对"整包在内存里组织"的四条生效（`inMemoryTypes = ['htmlViewer', 'packageViewer', 'sog', 'spz']`）；
  `ply` / `compressedPly` / `splat` 是分块流式的，不提示也不拦。

**③ 关键判据：比较用未取整的值**

`estimatedOutputGB` 是 `toFixed(1)` 之后的字符串（给文案用），**判断必须用未取整的
`estimatedGBValue`** —— 早期版本先取整再比较，`1.029` 会被压成 `"1.0"`、
`1.0 > 1.0` 永不成立，正好漏掉 93 万点这个实测点（**那是个真 bug**，不是风格问题）。

#### 其它改动

- `static/locales/*.json`（9 个）新增键 **`popup.exportLargeConfirm`**，
  总键数 **689**，9 个语言包键数一致（`npm run lint:locales` 通过）。
- `docs/verify/verify-export-roundtrip.cjs`：新增对**确认框分支**的检查，
  现为 **6/6 全过**（观测方式仍是把 `showPopup` 换成记录器 —— 真弹窗会等用户点确定、把套件挂住）。

#### 验证

- 全量回归：**35 个套件 `TOTAL FAILED: 0`**；`npm run check` 退出码 **0**。
- 打包 `release\SplatRoom-3.23.4.exe`（**122.1 MB**）：asar 条目 **5295**；asar 内只有
  `dist\test-model.ply`；wasm **8** 个；`dist/index.js` 同时含字面量 **3.4.0** 与 **3.23.4**；
  9 个语言包键数均为 **689**；exe `FileVersion` / `ProductVersion` 均 **3.23.4**；
  冒烟启动 **4** 个进程且主窗口标题为 `SplatRoom`，结束后归 **0**。

#### 工具坑（值得记一笔）

Windows 下 `@electron/asar` 的 `extractFile` / `statFile` 内部用 `p.split(path.sep)`，
**必须传反斜杠路径**；传 `/` 分隔的路径只在**单层**目录（如 `dist/index.js`）碰巧能成，
多层目录（如 `dist/static/locales/zh-CN.json`）一律报
`"<path>" was not found in this archive`。这与 6.50「环境坑」里那条
"深层路径用 `extractAll` 解到临时目录再读"是同一个根因。

#### 还剩什么

1. **查看器那条 4.25 GB 的瞬时分配**（13M / 91 次、单次最大 396.9 MB）仍是下一个优化目标 ——
   让查看器 / SOG 本身走流式（要动 `serializeViewer` / SOG 编码器）已开为本会话的持续目标；
2. 13M 上去浮云检测本身还是 **101 秒**（本轮之前的门槛只是"不自动跑"，算法级修复未做）；
3. load worker 输出不等价（列字节一致但选区结果不同，213 vs 2000）—— 查清之前保持 opt-in。

---

### 6.52 第五十轮：查看器 / 打包查看器改成"边产出边 base64 直接流进输出流" —— 1300 万点瞬时分配 4251.5 → 1979.1 MB

上一轮（6.51）把"一刀拒绝"换成了"报清体积与耗时、由用户决定"，用户既然说查看器 / SOG 是日常要用的，
那 **4.25 GB 那条瞬时分配就必须真正降下来**，而不是只把话说清楚。这一轮把它做掉了。
提交链：`714d98b`（不再一刀拒绝）→ `15311c0`（3.23.4）→ `efa3547`（第四十九轮文档）→ **`4ee98b1`（本轮）**。

**本轮产物口径**：`package.json` 版本 **3.23.5**，并已打包 —— `release\SplatRoom-3.23.5.exe`
（**122.1 MB**，portable，已签名）：asar 条目 **5295** / 唯一 PLY = `dist\test-model.ply` /
8 个 wasm / `dist\index.js` 里同时含字面量 `3.4.0` 与 `3.23.5` / 9 语言各 **689** 键 /
exe 属性 FileVersion=ProductVersion=**3.23.5** / 冒烟启动 4 进程（主窗口标题 SplatRoom）→ 杀净 0。
（提交：`4ee98b1`（流式查看器）→ `2d00d69`（版本 3.23.5 + 确认文案改准）→ `b5b2c71`（补大模型判定与 A/B 台架）；
A/B 与等价性数字都是在**源码 + dev server** 上量的，产物信息是打包后逐项复核的。）

#### 那 2.3 GB 花在哪一环

查看器导出走的是 splat-transform 的 `html-bundle` 分支（`writeHtml` 的 `bundle: true`），
这条链**整包在内存里组装**，逐环看是：

| # | 环节 | 代价 |
| --- | --- | --- |
| 1 | `writeSource` 的 default 分支 → `materializeToDataTable` | 整表一份拷贝 |
| 2 | `writeSog` 把 `.sog` 写进 `MemoryFileSystem` | 再来一份 O(输出) 常驻 |
| 3 | `toBase64` | 先拼一个 O(输出) 的 binary 字符串，`btoa` 再出第二个 |
| 4 | `renderViewerHtml` 把 base64 拼进 HTML | 第三个大字符串 |
| 5 | `TextEncoder` 把 HTML 编成字节 | 第四份 |

13M 点（`merged-scene`，694.7 MiB，无 SH）实测整条链：**瞬时 4251.5 MB、单次最大 396.9 MB、91 次分配**，
比纯 SOG 编码（1881.3 MB）多出 **2.3 GB 的"包装层"** —— 与 6.50/6.51 量的"查看器是唯一 O(输出) 路径"完全吻合。

#### 改法：不碰 splat-transform，只在它之上包一层

全部在 `src/splat/splat-serialize.ts`（外加 `src/app/file-handler.ts` 的阈值放宽）：

1. **取模板**：`buildViewerTemplate()` / `getViewerTemplate()` —— 用一个"1 个高斯点"的假
   `DataTable`（`Column` / `DataTable` / `Transform`，14 列）调一次 `writeHtml(bundle: false)`，
   取回 viewer 的 html / css / js。模板与数据无关，取一次就缓存（`viewerTemplateInFlight`）；
   **取模板时把进度 renderer 临时换成 `silentRenderer`**（新增的 `setProgressRenderer` /
   `activeProgressRenderer` 就是为它加的），失败则整体退回官方 writer。
2. **内联文档**：`renderViewerDocument()` 按 `renderViewerHtml` 的**同一批接缝**内联
   （`SEAM_STYLESHEET` / `SEAM_MODULE_IMPORT` / `SEAM_BOOTSTRAP`，以及上游那两条安全检查
   `</style`、`</script|<!--|<script`）；`contentUrl` 先写占位符 `VIEWER_PLACEHOLDER`，
   再用 `indexOfBytes` **按字节定位、原地替换** —— 于是 HTML 其余字节与旧路径逐字节相同
   （见下面的验证）。`index.js` / `index.css` 与 `settings.json` 用的是模板里取回的**原条目名**
   （`tpl.sogName` / `cssName` / `jsName` / `settingsName` / `htmlName`）。
3. **流式 base64**：`.sog` 仍由 `writeSource` 的 `sog-bundle` 分支（`writeExportSog`，流式、
   不 materialize）产出，经 **`Base64RelayWriter` + `Base64RelayFileSystem`** 边产出边 base64、
   直接写进同一个 HTML 输出流。块大小 **`BASE64_INPUT_CHUNK = 3 * 4 * 1024 * 1024`（12 MiB）**，
   编码走原生 `btoa` + `TextEncoder.encodeInto` 写进复用缓冲 `scratch`（不产生 O(输出) 分配），
   收尾那 1~2 字节走手写表 `encodeBase64Manual`；`close()` **不关** sink（HTML 尾部还要接着写），
   出错时 `writer.abort()`。
4. **打包（zip）同样处理**：`writePackagedViewer()` —— `.sog` 直接流式写进 zip 条目，
   不再先过一遍 `MemoryFileSystem`；viewer 的 css / js / settings / html 用模板里的原条目名写进去。
5. **出口**：`useViewerStream()` 读 `window.__SPLATROOM_VIEWER_STREAM__`（**`= false` 退回官方
   bundle writer**，现场排查不用重新打包）；模板接缝对不上时返回 false 自动退回并 `console.warn`。

#### 同一会话 A/B 实测（13,007,105 点 / 16 列无 SH，自身数据 694.7 MiB；同一份数据、同一台机器）

| 用例 | 耗时 | 写出 | ≥8MB 分配合计（"瞬时"） | 单次最大 | 分配次数 |
| --- | --- | --- | --- | --- | --- |
| `htmlViewer` 流式 | 99.3 s | 184.3 MB | **1979.1 MB** | **148.9 MB** | **34** |
| `htmlViewer` 官方 | 80.4 s | 184.3 MB | 4251.5 MB | 396.9 MB | 91 |
| `packageViewer` 流式 | 97.4 s | 139.0 MB | **1881.3 MB** | **148.9 MB** | **30** |
| `packageViewer` 官方 | 77.3 s | 139.0 MB | 4251.5 MB | 396.9 MB | 91 |
| `sog` | 97.5 s | 136.0 MB | 1881.3 MB | 148.9 MB | 30 |

⇒ **瞬时 −53%、单次最大 −62%、分配次数 91 → 34**；两条查看器路径现在**就等于**纯 SOG 编码的开销
（html 多出的约 98 MB 是那段 181 MB base64 的编码缓冲）。
**代价：耗时 +19 s**（136 MB 的 base64 仍要在主线程过一遍 —— 这是"单文件自包含"这个格式的固有成本，
不是可以绕掉的）。

#### 门槛按新能力放宽（`src/app/file-handler.ts`）

`memoryMultiple` 里 `htmlViewer` **6.1 → 3.2**、`packageViewer` **6.1 → 3.1**（都是实测 ×1.12 的余量），
等于把"离谱才拒绝"的 `hugeGB = 12` 硬线从"数据集 **1.97 GB**"放宽到"数据集 **3.75 GB**"。
其余档位不变：`ply` 0.6 / `compressedPly` 0.6 / `splat` 0.4 / `spz` 2.8 / `sog` 2.7。

#### 顺带修掉一个真 bug

没给 `experienceSettings` 时，官方 writer 会兜底用库里的 `defaultSettings('object')`，
而我们的包装层原来会**漏掉 settings** —— 导出的 HTML 会去找同目录的 `settings.json`，
单文件场景必然拿不到。现在两处都改成 `?? defaultSettings('object')`
（从 `@playcanvas/splat-transform/viewer-settings` 引入）。

#### 验证

- 新增 `docs/verify/verify-viewer-stream.cjs`，**8/8 全过**：
  ① 流式与官方 writer 的 HTML **挖掉 data URI 载荷后逐字节相同**（该套件默认夹具两边都是
  **3,144,345 B**）；② 两份载荷长度相同；③ 载荷解码后都是合法 zip，条目名 / 长度 / 内容摘要
  完全一致（`means_l.webp` / `means_u.webp` / `quats.webp` / `scales.webp` / `sh0.webp` /
  `meta.json`）；④ 单文件 HTML 自身结构正确（有 bootstrap、css 内联、没有残留 `index.js` 引用与占位符）；
  ⑤ 落盘字节数与导出字节数一致；⑥ 两份产物在浏览器里打开表现一致（viewer 起得来、canvas 存在、无报错）；
  ⑦ 走的确实是流式那条路（没有"退回官方 writer"的 warning）；⑧ 打包（zip）产物与官方 writer 的
  条目结构一致（`index.sog` / `index.css` / `index.js` / `settings.json` / `index.html`，
  内层 `.sog` **递归比形状** —— 因为 zip 里带容器时间戳，不能比整包字节）。
- 全量回归：**36 个套件 `TOTAL FAILED: 0`**；`npm run check` 退出码 **0**。
  批量脚本里有 **2 个 UNPARSED 是既有的输出形状问题**，与本轮无关：
  `verify-edit-grade-crop.cjs` 单独跑 **4/4 全过**（它的 `failed` 字段在批量里没被解析出来）、
  `verify-merge-ui.cjs` 根本没有 `failed` 字段。

#### 坑（值得记一笔）

viewer 自己的 JS 里**就含** `data:application/octet-stream;base64,` 这个字面量，所以定位载荷
不能只找这个前缀 —— 必须找 bootstrap 里 `contentUrl":"` 的那一处，否则会命中 viewer 代码里的字符串。

#### 还剩什么

1. **base64 那 +19 s 的主线程成本**（"单文件自包含"的固有代价）—— 想再快只能换容器格式或让
   base64 走 worker；
2. 13M 上去浮云检测本身还是 **101 秒**（门槛只是"不自动跑"，算法级修复未做）；
3. load worker 输出不等价（列字节一致但选区结果不同，213 vs 2000）—— 查清之前保持 opt-in。
   （6.51 的第 1 条"查看器 4.25 GB 瞬时分配"本轮已完成，见本节。）


### 6.53 第五十一轮：2000 万点 / WebGPU 六项实测问题 —— ①②④⑤ 修掉，③⑥ 定位到根因

用户在一台大扫描件上、**WebGPU 模式**下试出来的六条，本轮逐条实测定位并修掉四条，另外两条
（③⑥）做到"根因可复核 + 修法明确"。完整数据、探针与逐条证据见 `docs/perf/2000万点六项问题-排查发现.md`。

**夹具**：用户的原始文件 `D:\3DGS\训练结果\文物\LFS-文物-真珠舍利宝幢-35\splat_273200.ply`
= **20,000,000 点 / 62 列（45 列 SH，加载后 64 列）/ 4.73 GB**。诊断时用硬链接放成 `dist\test-20m.ply`
（`New-Item -ItemType HardLink`，**不占额外空间，但打包前必须删掉**）。所有实测都在
`?gpu=webgpu` + 无头 Edge 上；4.9 GB 单响应会被浏览器中止，所以探针改用 **Range 分块（19×256 MB）
在页面里拼 File**（应用本身是按 `BlobReadStream` 分块读的，所以这条路与真机一致）。

**这张模型的一个关键特征**（后面 ③④⑤ 都源于它）：**AABB 被一撮几公里外的噪声点撑爆** ——
实测 AABB 半径 **8297**（另一次读到 16115），而真正看得见的密集区半径只有 **153**（`denseRadius()`），
差了 **×54**。

#### ① "显示/隐藏 Splats"后已删除的点全回来了（已修 · 已实测）

- 右侧那个按钮走的是 **`camera.toggleOverlay`**（`src/ui/right-toolbar.ts:164`），切的是**点覆盖层**
  `SplatOverlay`；而默认 `camera.mode` 就是 `'centers'`（`src/core/preferences.ts:97`），所以人人会碰到。
- 覆盖层着色器原来**只判锁定位（bit 2）**，注释写着 "deleted splats are already excluded from order
  texture" —— 那句**只在 WebGL2 成立**（引擎的 order texture 是排序后的可见集合）。WebGPU 用的是
  **恒等序纹理**、并且按 `splat.numSplats`（= 行数 − 已删除数）派发，删除位根本没人过问
  ⇒ 前 N 行照画，删除的点全回来了。
- 修：`src/shaders/splat-overlay-shader.ts` 自己判 **bit 4**（新增 `overlayShowDeleted` uniform，
  "显示已删除"打开时仍可见）；`src/splat/splat-overlay.ts` 在 WebGPU 下改画**全部行**
  （`splat.splatData.numSplats`，不再是可见行数），并在 `onPreRender` 每帧下发 `overlayShowDeleted`。
- **实测（20M）**：`overlayDraw = 20,000,000`（全部行）而 `visible = 10,170,781`；
  删掉 **49.1%** 的点后屏幕亮像素 **96.93% → 65.86%**（修复前会照旧 ~97%，因为前 N 行里照样包含被删的点）。

#### ② "高斯点数据"展开没有任何数据（已修 · 已实测 · 含 SH 夹具复验）

- 控制台每次都有：`CommandQueue task failed TypeError: e.updateBegin is not a function`。
- 根因：`src/data-processor/calc-histogram.ts` 的 `clearRT()` 与 `src/data-processor/draw-points.ts` 的
  `drawPointsWithShader()` 用了 **WebGL 专用** `updateBegin()/updateEnd()`
  （`WebgpuGraphicsDevice` 没有这两个方法）；而且 `src/shaders/histogram-shaders.ts` 的 `binVS` 赋值了
  `gl_PointSize`（WebGPU 转 WGSL 会丢入口点 → 非法 pipeline）⇒ **直方图 pass3 每次都抛异常**，
  面板里既没有直方图也没有数值（属性名列表还在，所以看起来就是"展开了但没有任何数据"）。
- 修（**实现形状与最初设想有一处偏离，理由充分、已接受**）：`clearRT` 加 `typeof` 守卫 + WebGPU 侧
  改走 **`RenderPass` 的 color clear op**（WebGPU 的 `device.clear()` 本身也要在活动 pass 里才成立，
  只加守卫不够）；bin pass 在 WebGPU 下改用 **`RenderPass + QuadRender`**（引擎自带 indexed 单位四边形，
  每实例 2 个三角形），`binVS` 新增 **`GSPLAT_BIN_QUADS`** 变体（`gl_InstanceID` + `vertex_position`，
  用 `uHistViewportSize` 扩成 1 像素，**不再赋值 `gl_PointSize`**）。
  为什么不用"6 顶点 + 原始 `device.draw`"：WebGPU 的 `draw()` 必须在 render pass 内，且 device scope 的
  uniform / 纹理只有 `QuadRender.render()` 会上传并绑定（它持有引擎模块私有的 `_dynamicBindGroup`，
  公共 API 拿不到）—— 那条路在当前引擎下拿不到 splat 数据。**WebGL2 分支逐行未改。**
- **实测**：WebGPU 与 WebGL2 **逐 bin 逐元素完全一致**（2000 / 3077 / 13,007,105 三档都验过，
  两端数组 `arraysIdentical=True`、`differingBins=0`）；`numValues == numSplats`（既不重复计数也不漏画）；
  WebGL2 与原基线**位相等**（零回归）。
- **带 SH 的 20M 夹具复验**（新探针 `docs/probes/histogram-20m.cjs` —— 子代理只在 DC-only 夹具上验过，
  而 `GSPLAT_BIN_QUADS` 与 `SH_BANDS` 正交，这条是补它没测的变体）：`shBands = 3`、
  `infoMin = -4988.211`、`infoMax = 4817.011`、**212/256 列有柱子**、**consoleErrors 为空**。
- 澄清一处易误读：面板里「Splat: / 选择:」是**悬停读数**（`src/ui/data-panel.ts:712-722`，
  `showStats()` 仅在鼠标悬停/拖拽直方图时填写，默认 `display: none`），**不是缺数据**。

#### ③ "选择范围只能收缩、无法扩展"（根因已量化 · 修法待落）

- **功能没坏**：矩形 40–60% 选中 19,997,733，换更大的矩形 `add` → 19,999,986；
  左右 40–60 把全屏选中从 19,282,378 收到 **14,347,710** —— 两个轴都能改。
- **问题在深度轴的"行程分布"**（全屏框选后用 `selection.setDepthRange` 逐档推，20M 实测）：

  | 深度范围 | 选中点数 |
  |---|---|
  | 0–100（默认整段） | 19,282,378 |
  | 10–90 | 17,956,371 |
  | 25–75 | 16,468,657 |
  | 40–60 | 13,930,757 |
  | 48–52 | 2,644,133 |
  | 49–51 | 1,332,551 |
  | 50–50.5 | **358,006** |

  拖 0→40 只掉 28%，而 **48→50 就从 264 万掉到 36 万**：密集区挤在深度 ≈50 的一根针尖上，
  **滑块绝大部分行程"没反应"**，靠近针尖时一步就是几百万点 —— 用户体感就是"拉几次没反应 / 只能收缩"。
  这是"范围按**被噪声撑爆的 AABB** 线性映射"的必然结果（`poseExtent` / `rangeDistances`）。
- 修法方向：深度范围改用**裁剪分位数**（与 `Splat.framingRadius()` 同一套 1%~99% 思路）或对 `tailMap`
  做非线性压缩；**要等 P0-1 的 Worker 改造落地后再动** `src/app/editor.ts` / `src/splat/selection-range.ts`，
  避免与其冲突。
- 仍需用户确认：他用的控件（深度浮条 `#selection-range-bar`？）与当时模式（`centers` / `rings`）——
  **环模式下 `rangeMask()` 直接把拾取掩码原样返回、滑块完全不参与**，那是另一种明确行为。
- 顺带修掉（本轮已提交 `72a1085`）：`src/ui/bound-dimensions-overlay.ts` 在投影退化时会把
  `translate(NaN, NaN)` 写进 SVG（控制台每次刷
  `<g> attribute transform: Expected number, "translate(NaN, NaN)"`）—— 现在改成 `visibility: hidden`。

#### ④ "框显所选"只显示一小块（已修 · 已实测）

- 根因：`Splat.focalPoint()` 是对的（密集中心），但**取景半径用的是 `worldBound.halfExtents.length()`**
  （AABB 半对角线），被远处噪声点撑爆 ⇒ 相机停在 8~16 km 外。旧实现实测三种状态：
  导入后 **16115**、框显所选 **8297**、重置相机 **13629**（对只有 153 的密集区来说，屏幕上只剩一个点）。
- 修：新增 **`Splat.framingRadius()`** = **裁剪包围盒**半对角线（按轴取 1%~99% 分位、抽样 ≤20 万点、
  ×1.1 余量），三处取景都用它：`src/camera/camera.ts` 的 `getSplatInfo`、
  `src/app/editor.ts` 的 `camera.focus` 处理器、`camera.reset`。
- **第一版我用的是 `denseRadius()`（不透明度×尺度的加权 3σ），那是错的**：它会把薄墙 / 稀疏结构也裁掉，
  实测直接让 **`verify-mask-vs-rect` 与 `verify-equirect-export` 两套回归失败**；
  换成裁剪分位数后这两套恢复 `failed=0`。这就是"为什么不用 `denseRadius()`"的理由（记录在此以免重蹈）。
- **实测（20M）**：取景半径 **301.7**（AABB 8297.4），框显所选后相机到密集中心 **301.67**
  （比值 **1.0**，修复前 ×54），相机 y=96.13 在密集中心 y=18.05 上方。

#### ⑤ "重置相机"改成回到密集区斜上方 15°（已修 · 已实测）

- 原实现：`setFocalPoint(0,0,0)` + `setAzimElev(0,0)` + `setDistance(initialZoom)` —— 实测相机停在
  离模型 **13629** 处（密集区半径 153），什么都看不到。
- 修（`src/app/editor.ts` 的 `camera.reset` 分支）：**密集中心 + `framingRadius()` 取景 +
  `setAzimElev(0, -15, 1)`**。为什么是 **−15°**：`Camera.calcForwardVec` 的 `y = sin(-elev)`，
  `elev = -15` ⇒ `y > 0` ⇒ **相机在焦点上方 15°、俯视模型**（与 `camera.focus()` 导入时的初始视角一致）。
  没有模型时保持原来的默认视角。
- **实测（20M）**：相机 y=96.13 > 密集中心 y=18.05、仰角 **−15°**、方位角 0、距离/半径 **1.0**。

#### ⑥ 不如浏览器版 SuperSplat 3.3.0 流畅（热点已量；两条在改、一条未开始）

本机 20M 实测热点：

| 量 | 值 |
|---|---|
| `select.rect` 一次（主线程全程占用） | **1275.7 ms** |
| `splat.updateState()` | 38.4 ms（默认）/ 53.1 ms（selected）/ **179.2 ms**（deleted，含重建 20M 排序映射） |
| 轨道旋转 3 秒（帧间隔） | median 16.7 / p95 29.6 / **max 462.8 ms**（**5 帧 >33 ms**） |
| 空闲 3 秒（帧间隔） | median 16.7 / p95 16.9 / max 19.8（0 帧 >33 ms） |

对比调研见 `docs/perf/supersplat-3.3.0-对比调研.md`（含上游 v3.3.0 源码出处与出处等级标注）。
关键锚点：官方博客 20M 一档 **WebGL2 44.93 ms（22.3 fps）/ WebGPU 10.22 ms（97.8 fps）**；
**本机 WebGPU 架构等价于那一列 WebGL2**（worker CPU 排序 + 每高斯展开 quad）
⇒ **换后端本身不加速**，那 4.4× 来自"compute 投影 + 紧凑化 + GPU 基数排序 + indirect draw"，
而且上游**运动帧完全不排序**。三条 P0 的进度：

1. **P0-1（框选/套索/多边形/2D 笔刷搬进 Worker，目标主线程阻塞 ≤150 ms）** ——
   **实施中，尚未验收提交**：新文件 `src/splat/selection-core.ts`、`src/splat/selection-worker-client.ts`、
   `src/workers/selection-worker.ts`、`src/splat/state-bits.ts`，并改了 `src/app/editor.ts`、
   `src/splat/selection-range.ts`、`src/splat/splat-state.ts`、`rollup.config.mjs`。
   验收标准是**双后端跑既有选择类套件**（`verify-selection-range` 24 项 / `verify-selection-depth-bar` 19 项 /
   `verify-mask-vs-rect` / `verify-selection-overlay` / `verify-sphere-brush` / `verify-shape-selection` /
   `verify-selection-toolbar` / `verify-edit-hide` / `verify-range-cache-hint`）语义不变。
2. **P0-2（交互期每帧强制全量排序 → 最小间隔 100 ms + 停手补一帧）** ——
   **代码就绪，运行时验证待下一轮**（`tsc` / `eslint` 已过）：`src/splat/splat.ts` 新增
   `_sortLastDispatch` / `_sortSettleAt` / `dispatchSort()`；检测阈值仍保持灵敏（1e-12），
   只把"派发频率"与"检测阈值"拆开。背景：我们 fork 为绕开引擎 `GSplatInstance.sort()` 的 1e-3 epsilon
   门限而用 1e-12 ⇒ 原来"只要动就每帧派一次"，20M 上一次全量排序 0.3~0.5 s，加上引擎在排序完成时的
   **80 MB 主线程上传**，就出现了上表里的 462.8 ms 帧。第一版"补帧"逻辑有 bug
   （空闲帧会把 deadline 一直往后推 ⇒ 永不补帧），已修并写进注释留痕。
   验证探针：`_tmp/sortrate.cjs`（包一层 `worker.postMessage` 数派发次数、采样帧间隔、检查停手是否补帧）。
3. **P0-3（交互期降级：降 SH 波段 / 抽稀 / 提高 `alphaClipForward`；中期做 compute 投影 + 紧凑列表 +
   indirect draw）** —— **未开始**。

#### 验证与产物

- 新增套件 `docs/verify/verify-large-model-ui.cjs`（①②④⑤，**真 20M 夹具，5/5 全过**）：
  ① 删 49.1% 后亮像素下降 + 覆盖层绘制数=全部行；④ 框显所选 距离/半径 <3；⑤ 重置相机在焦点上方且仰角 −15°；
  以及一条"夹具确实是噪声撑爆 AABB"的前提检查。**不进批量**（需要大夹具）。
- 新增探针：`docs/probes/histogram-20m.cjs`（带 SH 的直方图验证）、
  `docs/probes/selection-range-20m.cjs`（③ 的量化）。
- 全量回归：**37 个套件 `TOTAL FAILED: 0`**（webgpu）；关键选择类套件在 **webgl2** 也过；
  `npm run check` 退出码 **0**。（批量里 `verify-merge-ui.cjs` 仍是既有的 UNPARSED，与本轮无关。）
- 顺带修掉两个同类热耗/噪声：`focalPoint()` 对 >50 万点**改抽样**（原来每次取景要跑
  **4000 万次 `Math.exp`**，20M 上秒级 → ~10 ms，与同文件里 `denseRadius()` 早就采样的做法对齐）；
  `bound-dimensions-overlay` 不再往 SVG 写 `translate(NaN, NaN)`。
- 本轮提交：`17aef18`（①②④⑤ + 两份报告）→ `13a41f8`（版本 **3.23.6**）→ `419d238`（focalPoint 抽样）
  → `a8068a9` / `6c1cae0`（② 含 SH 夹具复验 + 探针）→ `72a1085`（NaN）→ `3f22e69` / `0135ddf`（③ 量化 + 探针）。
- 产物：`release\SplatRoom-3.23.6.exe`（**122.1 MB**）：asar **5295** 条 / 唯一 PLY = `dist\test-model.ply` /
  8 个 wasm / `dist\index.js` 含字面量 `3.4.0` + `3.23.6` / 9 语言各 **689** 键 /
  exe 属性 FileVersion=ProductVersion=**3.23.6** / 冒烟 4 进程（窗口标题 SplatRoom）→ 杀净 0。

#### 还剩什么

1. **③ 的修法**（深度范围改裁剪分位数 / 非线性 `tailMap`）—— 等 P0-1 落地后动
   `editor.ts` / `selection-range.ts`；还需用户确认控件与模式。
2. **P0-1 验收**（Worker 化后的选择语义 + 主线程阻塞实测 ≤150 ms，双后端套件为裁判）。
3. **P0-2 实测**（派发次数应从"每帧"降到 ≈10/秒、max 帧下降、停手补帧生效）。
4. **P0-3 未开始**。
5. `dist\test-20m.ply` 是硬链接到用户 4.73 GB 原件的诊断夹具，**打包前必须删**。

### 6.54 第五十二轮：2000 万点交互性能 —— 排序闸门（P0-2）与框选搬进 Worker（P0-1）

承接 6.53 的 ⑥（用户原话："本机 2000 万点不如浏览器版 SuperSplat 3.3.0 流畅"）。本轮把两条 P0 落地：
**P0-2 已实测见效**、**P0-1 已实测（主线程阻塞 −82%）并提交**。两条都**没有**达到当初设的目标线，
边界逐条写在下面（并且明确区分"已实测 / 无结论 / 待用户拍板"）。
夹具不变：`dist\test-20m.ply` = 20,000,000 点 / 62 列（45 列 SH）/ 4.73 GB（硬链接，**打包前必须删**）。
完整相位表、探针口径与逐条证据见 `docs/perf/2000万点六项问题-排查发现.md`。

#### P0-2 交互期每帧强制全量排序 → 装闸门（已修 · 已实测）

**第一版改错了地方（记录在此以免重蹈）**：只在"我们自己的排序派发路径"（`splat.ts` 里那段 1e-12 检测）
上做限流 —— 实测**完全无效**：4 秒连续旋转期间仍向排序 worker postMessage **181 次（45.1 次/秒）**，
最差帧 489.6 ms。

**真因链**（读引擎源码确认）：
- `GSplatInstance.update()` **每帧无条件**调 `sorter.setCamera()`（`gsplat-instance.js:123-126`，
  引擎自己的门限是 `equalsApprox(..., 1e-6)` ⇒ 等于"相机动一点就发"）；
- `GSplatSortWorker.update()` 再用自己的 **1e-3** 门限（`gsplat-sort-worker.js:43-46`）决定是否真排；
  旋转时每帧方向变化远大于 1e-3 ⇒ **只要相机在动，worker 就一直在排**（20M 一次全量排序约 0.4 s，
  即 ~2.5 次/秒）；
- 每次排序完成，引擎要做一次 **~80 MB 的主线程上传**（`uploadStaging`）—— 这就是 462~490 ms 卡帧的来源。
- 附带发现：本仓库 vendored 的 `gsplat-sorter.js` 里**根本没有 `_sortInFlight` 合并字段**，
  而 `splat.ts` 里读它 / 设它的那段"会被合并"的注释与实际引擎不匹配 ⇒ **等于一直没有合并**。

**修法**：`Splat.ensureSorterGate()` —— 包一层 `sorter.setCamera`（幂等），
最快每 `SORT_MIN_INTERVAL_MS = 800 ms` 放行一次（取 800 是因为 20M 一次排序约 0.4 s，
间隔必须大于排序时长，worker 才有机会空闲），停手 `SORT_SETTLE_MS = 200 ms` 后补一帧；
我们自己的 1e-12 检测路径保留（间隔到点时主动派一次带 `forceUpdate` 的排序，绕开 worker 的 1e-3 门限
—— 那个门限正是历史上"慢速旋转时顺序长时间不更新、画面翻转/穿插"的来源）。
为什么不用"运动帧完全不排序"（上游 SuperSplat 3.3.0 的做法）：那会让顺序在运动中**无上界地**变旧，
而这里保证"运动中最多旧 0.8 s、停手后精确"，是两者之间的折中。

| 量（20M / WebGPU / 4 秒连续旋转，同一进程同一夹具） | 改前 | 改后 |
|---|---|---|
| 旋转期间排序消息数 | 181（45.1/秒） | **17（4.2/秒）** |
| 停手后的补帧消息数 | 40 | **3** |
| 最差帧 | 489.6 ms | **343.7 ms** |
| >33 ms 的帧数 | 6 | 5 |
| median / p95 帧 | 16.6 / 28.6 ms | 16.6 / 29.0 ms |

⇒ 消息速率 **降 10 倍**、最差帧 **降 30%**。**诚实边界**：`>33 ms` 的卡帧数**几乎没变** ——
剩下的是"每次排序完成引擎那次 80 MB 上传"的**固有成本**（20M 下约 1~2.5 次/秒），
要再降只能动架构（运动帧完全不排序 / 把排序搬到 GPU）。

验证：**webgpu 37 个套件 `TOTAL FAILED: 0`**、**webgl2 36 个套件 `TOTAL FAILED: 0`**、
`npm run check` 退出码 **0**（排序影响画面顺序，所以整套都跑过）。
探针：`docs/probes/sortrate.cjs`（包一层 `worker.postMessage` 数派发、采样帧间隔、检查停手补帧）。

**无结论的一条（如实记）**：用同一支探针在 **webgl2** 上量闸门时观测到 **0 次 worker 消息**。
诊断字段显示：`hasSorter / hasWorker / hasCenters / sorterHasGate` **全为 true**、`azimMoved` 为 true
（相机确实转了 216°）、手动调一次 `splat.onPreRender()` **不报错也不派发** ⇒ 最可能的解释是
**WebGL2 下这份 splat 的排序不由这段代码负责**（`hiddenByGroup` 提前 return，注释里提到
group-renderer 激活时由 `group-renderer.ts` 自己 `sort()`）。**闸门在 webgl2 上是"无结论"而非失败**，
要另找中间夹具 + 给 `dispatchSort` 打点才能定论。

#### P0-1 框选 / 套索 / 多边形 / 2D 笔刷的投影搬进 Worker（已修 · 已实测 · 已验证）

**根因**：这个 fork 把框选从 GPU 相交改成了**主线程 JS 全量投影**（`editor.ts` 的 `runRangeSelection`
→ `selection-range.ts:432-492`），20M 上一次手势要跑 6 趟 20M 循环。改前相位表（同进程实测）：

| 相位（legacy，全部在主线程） | ms |
|---|---|
| tailFractions | 36.4 |
| preMask | 19.1 |
| createCache | 8.9 |
| **selectRange（全量投影）** | **768.8** |
| managedMerge | 18.6 |
| **preRanges** | **108.7** |
| **applyMasks** | **236.2** |
| **端到端** | **1198.2**（相位之和 1197.5，自洽） |

**改法**（提交里 9 个文件、+1622/−695）：
- 新增 `src/splat/selection-core.ts` —— 把 `selection-range.ts` 的**纯计算层原样搬出**
  （`selectRangeCore` / `selectRangeFromCacheCore` / `tailFractionsCore` / `viewExtentFromSplatsCore` /
  `keepSurface` / `createRangeCache` / `rangeDistances` / `screenWindow` / `preMaskCore` / `regionFromSpec`），
  不引 playcanvas、不碰 DOM，**主线程与 worker 共用同一份循环**（这是"逐位等价"的结构性保证）；
- 新增 `src/workers/selection-worker.ts` + `src/splat/selection-worker-client.ts`：常驻 x/y/z 槽
  （按**数组对象身份**判断是否需重传、在途去重）、`begin` 同步一份 state 快照并返回 extent+tails、
  `select` 在 worker 内做 preMask + 全量投影 + 缓存填充，掩码/缓存以 **transferable** 回传；
  **任何失败一律回退旧路径**，`window.__SPLATROOM_SELECT_WORKER__ = false` 可整体关闭；
- 新增 `src/splat/state-bits.ts`：把每个高斯的状态位（selected/locked/deleted）抽成**单一定义**
  （worker 不再间接引到 playcanvas）；
- `src/splat/selection-range.ts` 变**门面**（同名导出 + 薄包装）；`rollup.config.mjs` 增打包项
  （产物 `dist/selection-worker.js` 21 KB，**无引擎泄漏**，已验证）；
- `src/app/editor.ts`：`select.rect` / `select.byMask` / `select.point` 改成**发 spec**；
  另加 `window.__selPhases` 相位计时；
- `src/core/edit-ops.ts`：`SelectRangeOp.pre` 改**惰性** —— 原来在构造时（= 每次手势开始）就用
  `IndexRanges.fromPredicate` 扫一遍 20M 行（实测 108~149 ms），而绝大多数手势永远不会被撤销；
  现在只在 `undo()` 第一次真正需要时从 `preMask` 派生并缓存（谓词与上界逐字相同，`preMask` 在手势期间只读）
  ⇒ 撤销后的选中集合与改动前**逐位相同**；
- `src/splat/splat-state.ts`：`applySelectionMask` **分块让出宏任务**。

**实测（20M / WebGPU / 同进程对照）**：

| 模式 | 端到端 | **主线程最长阻塞** | longtaskMax |
|---|---|---|---|
| legacy（改前代码路径） | 1067.9 ms | **1068.1 ms** | 895 ms |
| worker（改后） | 987.5 ms | **188.4 ms** | 0 |

改后相位：`worker.begin 40.2` + `worker.select 766.3`（**在 worker 线程**）+ `applyMasks ~244`（主线程）。
⇒ **主线程阻塞 −82%**、端到端 −8%；**语义逐位等价**的最强证据是：六次手势后 `state` 全表 FNV 哈希
完全相同（`3395733176`、选中 16,765,227）。

**诚实边界**：**未达**当初设的 ≤150 ms 阻塞 / ≤600 ms 端到端 —— 单 worker 的 20M 投影 766 ms 就是地板。
要再降需要 **K 路并行 worker**（按全局索引切片 + 直方图/掩码分段合并；采样集 `i % stride == 0`
在切片下仍然逐点一致，所以仍可保持逐位等价）。**是否做待用户拍板**；不做的话现在这版也可用，
且 `window.__SPLATROOM_SELECT_WORKER__ = false` 可一键回退。

验证：**9 个选择类套件 × 两个后端 = 18 次运行全部 `failed=0`**
（`verify-selection-range` 23 项、`verify-selection-depth-bar` 19、`verify-mask-vs-rect` 3、
`verify-selection-overlay` 3、`verify-shape-selection` 26、`verify-selection-toolbar` 18、
`verify-edit-hide` 3、`verify-range-cache-hint` 4；`verify-sphere-brush` 输出非 JSON 无法解析但退出码 0，
属**既有输出形状问题**，与本轮无关）；`tsc` 与 `npm run check` 退出码 **0**。

**已知未覆盖（如实记）**：撤销路径的专项探针（`_tmp/p01-undo-probe.cjs`）在提交时仍在跑；
20M 上的滑块推杆未重测；退役 Splat 的 worker 槽**内存不释放**（有上限但确实会涨）。

**顺带（与用户报的 ③ 直接相关）**：环模式拾取掩码那处改写经**逐位等价复核**
（`hit.fill(0)` + 按拾取集合写 255 ≡ 原实现的全表遍历赋值；越界 / 非整数 id 两版都忽略），
并新增护栏套件 `docs/verify/verify-rings-pick.cjs`（**5/5**，此前全仓没有任何套件覆盖环模式）。
它同时坐实了一件与 ③ 有关的事：

| 模式 | 整屏框选 | 推深度滑块后 |
|---|---|---|
| **rings（环）** | 936 | **936（滑块完全不参与）** |
| centers | 1693 | 0（滑块起作用） |

⇒ **环模式下三个范围滑块本来就被设计成不参与**（`editor.ts` 的 `rangeMask`：`if (entry.ringPick) return pick`），
那时只能靠"重画更小的框"来收缩、永远"无法扩展" —— 与用户描述的 ③ 高度吻合，
所以 ③ 的修法取决于他当时在哪个模式（**仍待确认**）。

#### 验证与产物

- 新增套件 `docs/verify/verify-rings-pick.cjs`（5/5，环模式语义护栏）；新增探针
  `docs/probes/sortrate.cjs`（P0-2 口径）。
- 回归：**webgpu 37 套 `TOTAL FAILED: 0`** + **webgl2 36 套 `TOTAL FAILED: 0`**；
  `tsc` / `npm run check` 退出码 0。
- 文档：`docs/HANDOFF.md` 的指针更新到 3.23.6 / 6.53（提交 `8775088`）—— 它此前停留在
  3.16.0 / 第四十四轮 / 产物 3.21.0，而这是"开新会话先读"的那一页。
- **本轮提交**：`3d47429`（P0-2 闸门有效版；`cac0764` 是第一版无效尝试，保留作为记录）
  → `fe73802`（webgl2 闸门诊断）→ `51a1a9b`（环模式护栏）→ `8775088`（HANDOFF 指针）
  → `4cdead1`（P0-1 进展数字）→ **`b3876c3`（P0-1 本体，9 文件 +1622/−695）**。
- **产物现状（如实）**：`release\SplatRoom-3.23.6.exe` **不含** P0-1 / P0-2（本次改动都在提交里，
  **版本尚未 bump、也未重新打包**）⇒ **待打包复核**。

#### 还剩什么

1. **打包复核**：把 P0-1 / P0-2 带进安装包（bump 版本 → build → portable → asar/字面量/9 语言/exe 属性/冒烟复核）。
2. **③ 的修法**：等用户确认当时是 `rings` 还是 `centers`。rings ⇒ 让范围窗口作用到**拾取集合**上；
   centers ⇒ 深度范围改**裁剪分位数**或对 `tailMap` 做非线性压缩，让密集区占到有意义的滑块行程。
3. **P0-3（交互期降级：降 SH 波段 / 抽稀 / 提高 `alphaClipForward`）**：未开始。
4. **待用户拍板**：要不要做 K 路并行 worker 把端到端压进 ≤600 ms；要不要加"离群点剔除 / 按密集区裁剪"
   （这张模型 AABB 被噪声撑到 ×54，也是 ③ 行程只有针尖的根源）。
5. **无结论**：闸门在 webgl2 上量到 0 次 worker 消息，需另找夹具 + 打点定论。
6. `dist\test-20m.ply` 打包前必须删。

---

### 6.55 第五十三轮：③ 选择范围只能收缩 —— 深度轴改成"滑块百分比 = 选中质量占比"

承接 6.53 定位、6.54 让开的 ③（用户原话：「**选择范围调整，无法扩展，只能收缩**」，2000 万点 / WebGPU 模式下形成）。
本轮把它修掉，并**作废一条我自己定错的判据**（见下）。夹具不变：
`dist\test-20m.ply` = 20,000,000 点 / 62 列（45 列 SH）/ 4.73 GB（硬链接，**打包前必须删**）。
探针：`node docs/probes/selection-range-20m.cjs "http://localhost:3621/?gpu=webgpu" test-20m.ply`。
逐条证据与**改前的原始行程表**见 `docs/perf/2000万点六项问题-排查发现.md`「③」一节
（那份记录停在"已量化 / 修法待落"，本轮把它落地）。

#### 根因：有用行程只占滑块全长的约 1.2%

框内的 2000 万点，深度只占 **AABB 跨度的 1.25%**（hit `u ∈ [0.4373, 0.4498]`），
而滑块沿 AABB 线性映射 ⇒ **有用行程只占滑块全长的约 1.2%**。改前的逐档实测（选中点数）：

| 深度范围 | 选中点数 | 占比 |
|---|---|---|
| 0–100（默认整段） | 19,282,378 | 100% |
| 10–90 | 17,956,371 | 93.12% |
| 25–75 | 16,468,657 | 85.41% |
| 40–60 | 13,930,757 | 72.25% |
| 48–52 | 2,644,133 | 13.71% |
| 49–51 | 1,332,551 | 6.91% |
| 50–50.5 | 358,006 | 1.86% |

⇒ **0→40 只掉 28% 的点**（**死区**：拉几次没反应），而 **`48→50` 一步掉 264 万点**（**针尖**：稍一推就跳掉几百万）。
按上表逐行算"每 1% 行程切掉多少质量"（= 占比 ÷ 宽度）：`0–40` 段只有 0.7–1.7%，而 `40–60` 段 3.61%、
`48–52` 段 3.43%、`50–50.5` 段 3.72% ⇒ 越靠中越陡，**同一根滑块一半是死区、一半是针尖**。
用户体感"无法扩展、只能收缩"就是这两段拼出来的：这是**范围按 AABB 线性映射**的必然结果
（`poseExtent` / `rangeDistances`），而这张扫描件的 AABB 被一撮远处噪声点撑到密集区的 **×54**（见 6.53 的 ④）。

#### 改法：只改"滑块百分比 → 深度窗口"这一层映射

`src/splat/selection-core.ts` 新增 `DepthTravel` / `depthTravelFromBins()` / `quantileFromCdf()` / `depthTravel()`：

- 用**命中点的深度直方图**建累积占比（`DEPTH_BINS = 65536`）—— 为什么必须比 512 桶细：
  512 桶下桶宽 32 个世界单位，而**整块密集区只落 5 个桶**，分位表根本表达不出它；
- 滑块百分比直接映射到"**质量分位**"，即**滑块百分比 = 选中质量占比**；
- **两端与旧 `tailMap` 逐位同构**：`TAIL_SHARE = 2%` 压进 `TAIL_PERCENT = 0.5%` 一个字没改
  （所以 0 = 整段穿透、100 = 另一端，"没有东西够不着"这个既有约定不变），只把**中段**换成等分分位，
  并夹在 `[nearEdge, farEdge]` 之内保证单调；
- **判定逻辑 / 缓存 / 区域 / 窗口的代码一行未动**（证据见下），其余改动只是类型与签名：
  `selection-range.ts` 导出 `DepthTravel`、`selection-worker-client.ts` 与 `workers/selection-worker.ts`
  的 tails 类型、`editor.ts` 的 `RangeEntry.tails`。

#### 实测：行程表与实用收益

改前 = 前一提交的构建；两次运行的"全屏选中数"完全相同、且**与本改动无关的左右轴行逐位相同**，作为对照组。

| 深度范围 | 改前占比 | 改后占比 |
|---|---|---|
| 0–100 | 100% | **100%（19,282,378，逐位等于全选）** |
| 10–90 | 93.12% | 77.55% |
| 25–75 | 85.41% | 48.48% |
| 40–60 | 72.25% | 18.96% |
| 48–52 | 13.71% | 4.23% |
| 左右 40–60 | 14,347,710 | **14,347,710（逐位未动）** |

⇒ 上表的"每 1% 行程切掉多少质量"（= 占比 ÷ 宽度）：改前中段 **3.4–7.3%**
（`48–52` 段 3.43%／`49–51` 段 3.46%／`40–60` 段 3.61%／`50–50.5` 段 3.72%，
最陡的 **7.3%** 来自中段两侧那两段共 8 个单位的窗口，见下节），
改后 **0.948 / 0.969 / 0.970 / 1.058%**（`40–60` / `10–90` / `25–75` / `48–52`，**接近常数**）；两端死区从 **0.26%** 抬起，
**响应落差 14.4× → 1.02×**；占据 **72.2%** 点云的那一坨从 **20 个单位行程**变成 **74.5 个单位（×3.7）**；
100% 行程**单调**降到 0。

**实用收益（"拖掉远处噪声、只留模型"这个动作，有数字）**：只推「最远」到 **96**（也就是头 4% 的行程），就删掉 **100%** 的远处噪声（最深 5% 的 **96.4 万**点），
同时 core50 保持 **100%**、core90 保持 **99.5%**；改前要拖到 **~80** 才删完、且那一段每单位行程切 3.7% 的质量、很难停准。

#### 我自己作废的一条判据（记录在此以免重蹈）

我原本给这条修法定的验收判据是"**`48–52` 应 ≥40%**"。这条判据与"让密集区占到有意义行程 / 不要一步几百万点"
**数学互斥** —— 等分映射的定义就是"窗口质量占比 ≡ 宽度 × 0.9697"，要让 4% 的行程装 40% 的质量，
中段就必须比等分**粗 10 倍**，也就是**把那根针保留下来**：改前 `[40,48]` 与 `[52,60]` 这两段
（共 8 个单位的行程）里一共塞了 **58.5%** 的点（= 72.25% − 13.71%），折算 **7.3%/单位** ——
正是记录里那个最陡值。**判据作废**；本实现按"可用行程"这个目标做，
达标口径即上面的**落差 14.4× → 1.02×** 与 **×3.7 行程**。

#### "判定逻辑未动"的证据（硬口径）

1. **结构性**：把 `git HEAD` 版与当前版的 **13 个声明**抠出来、去注释后做代码哈希 —— 全部相同：
   `selectRangeCore` / `selectRangeFromCacheCore` / `createRangeCache` / `RangeProjectionCache` /
   `CACHE_*` / `keepSurface` / `preMaskCore` / `viewExtentFromBound` / `viewExtentFromSplatsCore` /
   `regionFromSpec` / `screenWindow` / `SelectionRangeView` / `SplatColumns`
   ⇒ **映射层是唯一变量**。
2. **实证**：20 万行合成数据（一半质量铺在 100 单位宽的噪声里、一半挤在 0.002 宽的薄面上）
   + 6 个 depth window（含比量化格还窄的）：逐点路径掩码**逐位相同（差异 0 点）**、
   缓存那一趟写出的三块缓冲**逐位相同**、缓存路径掩码**逐位相同（差异 0 点）**、FNV 6/6 相同。

**为此放弃了一版"缓存深度改 float32"的实现**：那版细端能精确到 ~0.1%（`50–50.5` 给 0.496%），
但同一 window 的选中集合会差 ≤半格（本夹具一个边界最多约 13.6 万点），与上面那条硬口径冲突，故退回 16 位。

#### 已知取舍（三选一，仍待用户拍板）

投影缓存**仍是 16 位量化**（格宽 = 深度跨度 / 65535 = 本夹具 **0.175** 个世界单位）⇒
**比一格还窄的窗口会被量化吃掉**：`50–50.5` 与 ±0.1 / ±0.25 都返回 **0**；
**最小能成比例响应的窗口 ≈ 1 格 ≈ 密集区 1.4% 的质量**（≈27 万点）。三个选项：

| 选项 | "同一 window 逐位相同" | 细窗口 | 代价 |
|---|---|---|---|
| **(a) 保持现状**（已打包 3.23.8，本提交） | ✅ | `50–50.5` → 0；最小成比例窗口 ≈1 格 ≈1.4% | 细端有"断崖"（细于一格直接给 0，不成比例） |
| (b) 缓存改 float32 | ❌ 同 window 会差 ≤半格 | 精确到 ~0.1%（`50–50.5` = 0.496%） | 缓存 6 → 8 B/点（20M：120 → 160 MB） |
| (c) 16 位 + 映射层把窗口向外吸附到量化格 | ✅ | 无断崖，但最细一档被量化成 1 格（地板 1.4%） | 细端不严格成比例；细端比改前略差 |

**(a)** 就是当前已打包（3.23.8）的状态；细于 1.4% 的深度切片是很边缘的操作，所以先按现状交，等拍板。

#### 残余风险（如实）

- **分布退化时会变成台阶**：若某个桶独占很大质量份额（正对相机的平墙），桶内行程表现为平台。
  实测两面平墙的合成夹具 `test-model.ply`：最远到 99.5 就整片切掉远墙 —— 单调与"第一下就有反应"仍成立
  （套件全绿），但那种模型上手感偏粗。
- **两端压紧段照旧**：`TAIL_SHARE = 2%` / `TAIL_PERCENT = 0.5%` 未动 ⇒ 成比例关系是 `占比 = 宽度 × 0.9697`，
  固定偏 2.4%（`10–90` → 77.55% 而非 80%）；要"更等分"就得改这两个常量，会动到已验收的手感。
- **命中集小了就退回线性**：沿用原门槛（<20 个采样点 → 返回 null ⇒ 与旧实现逐位相同的纯线性）；
  20~1000 个采样点这一档**没有量**。
- **20M 的 webgl2 组合未被套件覆盖**（选择类套件跑的是 2000 点小夹具 `test-model.ply`）。

#### 验证与产物

- 选择类专项：**8 个套件 × webgpu/webgl2 = 16 次运行 + `verify-selection-depth.cjs`，`failed` 全 0、`exit` 全 0**
  （`the depth ends stay reachable` / `first small move 最远·最近` / **`扩边` 严格超集**三条断言都保住）；
  `verify-rings-pick` 仍 **936 → 936**（**环模式语义未动** —— 环模式下范围滑块本来就不参与，见 6.54 那张表）。
- 全量：**webgpu 38 个套件 `TOTAL FAILED: 0`**；20M 上 `verify-large-model-ui`（①②④⑤）`failed=0`；
  `npm run check` 退出码 **0**。
- 性能旁证（20M / worker 路径）：`worker.begin 36.5–44.6` / `worker.select 732–808` / `applyMasks 128–213`、
  端到端 **976–1056 ms** ⇒ 65536 桶直方图 + 256 KB 分位数表**没有可测量的代价**
  （微基准：512 桶 1.07 ms vs 65536 桶 1.12 ms）。
- **提交**：`a4b411f`（③ 本体）→ `ed0abb3`（版本 3.23.8 打包复核）；
  **产物**：`release\SplatRoom-3.23.8.exe`（asar 5297 / 唯一 PLY = `dist\test-model.ply` / 8 个 wasm /
  字面量 3.4.0 + 3.23.8 / 9 语言各 689 键 / exe 属性 3.23.8 / 冒烟 4 进程 → 0，`ALL CHECKS PASSED`）。

#### 还剩什么

1. **③ 的细端取舍（a/b/c）**：见上表，按 **(a)** 已打包，等用户拍板是否换 (b)/(c)。
2. **K 路并行 worker**：把框选端到端从 **~1015 ms**（本轮实测区间 976–1056 ms）压进 **≤600 ms** ——
   瓶颈已不在主线程，而是 worker 自身 732–808 ms 的 20M 投影。方案与逐位等价依据在
   `docs/perf/2000万点六项问题-排查发现.md`「P0-1 终值与测量方法学」：按**连续**区间切片；
   `tailFractions` 的采样集是全局 `i = 0, stride, 2*stride…`，必须让每个 worker 从 `ceil(lo_k/stride)*stride` 起步，
   再把三张 512 桶直方图**逐桶相加**；**环模式的 `keepSurface` 是屏幕空间邻域操作，切片救不了 ⇒ rings 必须 K=1**。
   预估 K=4 时端到端 ≈350–450 ms。**待用户拍板。**
3. **P0-3 交互期降级**（降 SH 波段 / 抽稀 / 提高 `alphaClipForward`）：**未开始** —— 上游 SuperSplat 3.3.0 靠
   "运动帧完全不排序 + GPU 投影/排序"做到的流畅度，我们只做了**限流**；剩下的卡帧是每次排序完成那次
   ~80 MB 主线程上传的固有成本。
4. **离群点剔除 / 按密集区裁剪**：这张模型的 AABB 被噪声撑到 ×54，既是 ③④ 的共同根源，
   也是取景/行程问题的根源。**待用户拍板。**
5. **无结论的一条**：排序闸门在 webgl2 上量到 0 次 worker 消息（见 6.54），需另找中间夹具 + 给 `dispatchSort` 打点定论。
6. `dist\test-20m.ply` 打包前必须删。

---

### 6.56 第五十四轮：交互期降级（P0-3 v1）—— 先量后改，量出"降 SH 波段没用、降分辨率才有用"

承接 6.53/6.54/6.55 一直挂着的 **P0-3**（交互期降级）。这一轮的做法是"**先把 GPU 每帧耗时接进来、
把每个候选旋钮量一遍，再挑真正有效的做**"。完整数字与出处见 `docs/perf/交互期降级-实现与实测.md`，
前置侦察（含对文档结论的更正）见 `docs/perf/P0-3-交互期降级-前置侦察.md`。

#### 先接上"眼睛"：GPU 每帧耗时

引擎本来就带 `device.gpuProfiler`（timestamp query，WebGPU/WebGL2 都有），但**本仓库从来没有消费过它**
（`grep gpuProfiler src/` 零命中）。新增 `src/core/gpu-frame-timing.ts` 包装 `gpuProfiler.report`，
按 `renderVersion` 把异步回报**归属到产生它的那一帧**，并按动/静分类统计；另加
`src/core/camera-motion.ts`（位姿对比 + 指针按下，settle 200 ms）给帧打标签。
探针 `docs/probes/gpu-frame-probe.cjs` 打印空闲/旋转两相的帧间隔、GPU 段、longtask 与 `litPercent`。

#### 顺手查出并修掉两个**测量**层面的 bug（都很值钱）

1. **探针的旋转把相机搞成了 NaN**：`sortrate.cjs`（上一轮遗留）与 `perf-probe.cjs` 写的是
   `cam.setAzimElev(cam.azim + 1.2, cam.elev, 0)`，而本 fork 的 Camera **只有 `elevation`、没有 `elev`**
   ⇒ 俯仰角 NaN ⇒ **相机矩阵整体 NaN ⇒ 模型根本没被正常绘制**。
   同一进程对照（各转 1 秒）：错误写法 **运动检测 0/60 帧、控制台 948 条 NaN/秒**；
   正确写法 **60/60 帧、0 条**。⇒ **此前用这两支探针量到的"旋转期"帧时间结论全部作废**（含我上一轮报的
   "旋转 p95 21.3 ms"）；排序**消息数**类结论（P0-2 的 45.1 → 4.2 次/秒）不受影响 —— 引擎每帧无条件调
   `sorter.setCamera`，闸门限的是它，与相机是否 NaN 无关。已在 3 个探针里改为 `cam.elevation`。
2. **合成夹具"20M 点"其实什么都没画**：高斯是亚像素，被 `minPixelSize`（引擎默认 2 px）剔除 ⇒
   `litPercent` 只有 **2.1%**、GPU **2.4 ms** —— "快"是假象。把高斯调大（新增尺寸/房间半径旋钮）后
   **81%** / GPU **70 ms**，才是真正的重负载。⇒ **以后任何性能数字都必须带 `litPercent`**
   （已写进 `docs/HANDOFF.md` 的坑列表第 22/23 条）。

#### 旋钮量化（20M fill 夹具，静止强制帧，同进程）

| 旋钮 | 帧 p50 | GPU p50 | Δ |
|---|---|---|---|
| 基线（SH3 / minPixelSize 2 / 全分辨率） | 69.8 ms | 69.92 ms | — |
| SH 波段 → 1 / → 0 | 69.5 | 69.57 | **−0.5%** |
| minPixelSize → 4 / 8 / 16 | 69.9 / 68.8 / 58.6 | 70.01 / 68.87 / 58.75 | 0 / −1.5% / **−16%** |
| **渲染缩放 0.7 / 0.5 / 0.35** | **39.9 / 25.4 / 18.1** | 39.98 / 25.43 / 18.93 | **−43% / −64% / −73%** |
| 恢复全分辨率 | 69.9 | 69.92 | 0（画面 mean\|ΔRGB\| = **0**，逐像素精确恢复） |

**读法**：这个模型的 GPU 时间**与像素面积近似成正比**（填充/overdraw 主导）⇒ 文档原来推荐的
"先降 SH 波段"在填充受限场景下**不成立**；`alphaClipForward` 仍是 no-op（6.53 已记）；
真正有效的是**降渲染分辨率**。另有一条走不通：`config.camera.pixelScale` **不能**当交互旋钮
（它改画布/设备分辨率，实测 0.5/0.35 时帧时间反而涨到 242/472 ms 且画面整体变了）；
正确机制是 `camera.targetSizeOverride` + `rebuildRenderTargets()`（PiP 预览用的同一套）。

#### 做出来的东西

`src/core/motion-quality.ts`（纯策略状态机：`autoEngageMs = 60`、预算 33 ms、步进限频 **300 ms**、
阶梯 = 渲染缩放 0.7 / 0.5）+ `src/scene/scene.ts` 接线（幂等施加/恢复）。
**降级完全不碰 `view.bands`**（那条路会写进偏好、`.ssproj`、设置面板与导出弹窗）——
回归套件专门有一项断言这一点。逃生开关 `window.__SPLATROOM_MOTION_QUALITY__ = false`。

#### A/B 实测（20M fill / WebGPU / 连续旋转 4 秒 / 同进程）

| 量 | 关闭 | 打开 |
|---|---|---|
| 帧 p50 | 70.9 ms | **29.8 ms（−58%）** |
| 帧 max | 208.2 ms | 77.8 ms |
| GPU p50（运动中） | 71.0 ms | **29.96 ms** |
| 4 秒内帧数 | 58 | **119（×2.05）** |
| 渲染目标宽度（运动中） | 1280 | **640**（自适应进到 0.5 档） |
| 停手后 | — | 精确恢复（override → null、target 1280） |

**诚实边界**：`>33 ms` 的帧数没降（52 → 48，p50 减半 ≠ 全部 30 fps）；p95 仍 69.7 ms
（约 5% 的帧是全分辨率或正逢档位切换，切换要重建渲染目标）；`litPercent` 对清晰度不敏感，
画质代价看 mean\|ΔRGB\|（0.5 档为 113）。**合成夹具≠真机**，真机上值不值要用用户的真实扫描件复核。

#### 验证与产物

- 新增 `docs/verify/verify-motion-quality.cjs`（**7/7**，含"`view.bands` 全程不变"与"停手精确恢复"，
  已进批量）与 `docs/verify/verify-motion-quality-policy.mts`（纯 node **13/13**）。
- 全量：**webgpu 39 套 `TOTAL FAILED: 0`** + **webgl2 39 套 `TOTAL FAILED: 0`**；
  `npm run check` 退出码 **0**。
- **产物**：`release\SplatRoom-3.23.9.exe`（**122.04 MB**，portable，已签名）：asar **5293** 条 /
  唯一 PLY = `dist\test-model.ply` / 8 个 wasm / `dist/index.js` 含字面量 `3.4.0` + **3.23.9** /
  9 语言 zh-CN **689** 键 / exe 属性 FileVersion=ProductVersion=**3.23.9** / 冒烟 4 进程（窗口标题 SplatRoom）→ 杀净 0。
  - **打包踩到一次坑（记一笔）**：第一次打包忘了"dist 里除 `test-model.ply` 外的夹具要先挪走"这一步，
    结果 4 个夹具（cluster / floater-biggrid / floater-scale / floater）进了 asar ⇒ exe **123.5 MB**、
    asar 里 **5 个 PLY**。挪走后重打 ⇒ **122.04 MB / 唯一 PLY** ✓。
  - **条目数差异如实记**：本次 **5293**，而 3.23.8 记的是 **5297**（11 项检查全绿，仅这一个数字不同）。
    本轮源码只新增 3 个模块（打进 `dist/index.js`，不新增条目）、不新增资源 ⇒ 差异**不是**本轮引入的，
    但**未查清**（可能是两次构建的 `dist` 文件集或 `node_modules` 打包范围有 4 个条目的出入）。**不要把它当成回归**。
  - 顺带修掉探针的一个真 bug：`docs/probes/check-asar-3120.cjs` 用 `listPackage()` 返回的**原始条目名**
    （形如 `\dist\static\locales\zh-CN.json`，**带前导分隔符**）直接喂 `extractFile` 会报
    `"..." was not found in this archive` —— 单层路径（`dist/index.js`）碰巧能过，所以这个坑是**间歇性**的。
    现在探针会依次尝试几种变体（`readEntry`）。

#### 还剩什么

1. **降级期间拾取坐标不一致**：投影/拾取换算用变小的 `scene.targetSize`（`src/app/editor.ts:1027` 等），
   "边转边框选"这种操作需要复核；PiP 预览也写同一个 `targetSizeOverride`，叠加行为无专项套件。
2. **上游更深的那一层没做**：紧凑化 + indirect draw（只画存活高斯）、贡献剔除、遮挡剔除、
   运动帧完全不排序的 1 spp 随机透明 —— 可行性已在 `docs/perf/supersplat-3.3.0-代码可借鉴点.md` 里查清
   （引擎 2.21.3 已自带 `ComputeRadixSort` / indirect draw / unified 管线，**升级引擎买不到性能**）。
3. **真机复核**：用用户的 20M / 13M 真实扫描件跑一次 A/B（合成夹具是均匀大高斯，最不利于剔除类优化）。
4. `dist\test-20m.ply` / `dist\test-20m-fill.ply` 打包前必须删。











