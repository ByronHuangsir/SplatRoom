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