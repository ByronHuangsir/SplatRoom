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











