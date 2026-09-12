# SplatRoom V3 — WebGPU 后端的现状（2026-09-12）

> **进度更新（同日晚，3.4.1 之后，未发布）**：WGSL 移植已完成并接线，黑屏的**真正原因已定位到相机矩阵**，
> 详见文末「第 6 节：WGSL 移植进展与剩余阻塞」。结论先行：**渲染管线本身已经通了**（splat 遍的 MRT 管线合法、
> draw 正常发出、片元能上屏——用"全屏三角形 + 品红片元"实测确认），剩下的问题是我们自研 camera 类的
> **视图/投影矩阵没有传到 splat 材质**（引擎的 view uniform buffer 在 WebGPU 下对该材质读出的是单位矩阵）。

**结论：WebGPU 后端目前无法渲染高斯点云。已改为"启动时拒绝该设置并回退 WebGL2 + 弹窗说明"，只在开发时用 `?gpu=webgpu` 打开。**

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

### 6.4 复现用的调试工具（`_tmp/`，未入库）

- `map.cjs`：截取画布区域 → 解码 PNG → 输出**精确颜色直方图 + 均值 + 粗粒度 ASCII 色块图 + 三条带像素读数**（排除"截图整体比例"这类不敏感指标）。
- `pass-probe.cjs`：拦截 `beginRenderPass` / `setViewport` / `setScissorRect` / `draw*`，打印每个 pass 的附件纹理 id、loadOp 与实际 draw。
- `draw-probe.cjs` / `ub-probe.cjs`：统计每个管线的 draw、并检查材质参数与 WGSL 里 `ub_view.*` / `ub_mesh_ub.*` 的落点。

> 教训：`verify-large-model-backend.cjs` 里的 `shot` 指标用的是硬编码 `clip {0,0,800,500}`，会把左侧 UI 面板算进去，
> **对"视口内容"不敏感**（网格-only 与整屏品红都是 0.3806）。判定"是否画出来"请用 `map.cjs` 或 `verify-webgpu-fallback.cjs`
> 里的 `viewportStats()`（在视口内部取 300×220）。

