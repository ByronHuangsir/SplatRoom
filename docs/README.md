# docs — 目录说明（开发者索引）

用户使用指南见 **`docs/index.md`**（安装/操作/调色/工具/导出等）。本文件是开发与验证相关的索引。

## 目录结构

| 路径 | 内容 |
|---|---|
| `index.md` | 用户指南（对外文档入口）|
| `V3-开发存档-*.md` | **会话存档/续接文档**（当前最新：`V3-开发存档-2026-09-11.md`，含未解决问题与下一步）|
| `V3-选择深度覆盖-2026-09-09.md` | 选择深度/覆盖/球刷的实现与上游语义对照记录 |
| `V3-选择工具对齐-SuperSplat3-2026-09-11.md` | 选择工具面逐项对齐记录 |
| `V3-WebGPU-现状.md` | **WebGPU 后端为何不可用**（黑屏两个成因、实测证据、启动回退策略、完整移植的清单）|
| `verify/` | **现行无头验证脚本**（Puppeteer + Edge swiftshader 软件 GL）|
| `archive/` | 历史专项记录（合并工具、表面平整）、探索存档 HTML/PDF、PDF 生成脚本与素材 |

## 验证脚本（`docs/verify/`）

| 脚本 | 用途 | 需要 dist+服务 |
|---|---|---|
| `gen-test-splat.cjs [path] [--asym]` | 生成合成高斯 PLY（1200 前墙 + 800 后墙；`--asym` 上下不对称）| 否 |
| `verify-selection-depth.cjs` | 四象限 + 体积 + 球刷路径语义回归（断言序关系）| 是 |
| `verify-mask-vs-rect.cjs` | 遮罩与矩形同区域一致 → 证明拾取无纵向翻转 | 是 |
| `verify-selection-toolbar.cjs` | 工具栏：模式开关/图标/aria、分组长按弹层、工具激活（21 项）| 是 |
| `verify-model-renders.cjs` | 像素级渲染验证 + `splatDiag()` 行为（7 项）| 是 |
| `verify-large-model-backend.cjs <model> <backend> [url]` | 同一模型在指定后端的可见性对照：canvas 采样 / 应用回读 / **合成截图**三路取证（WebGPU 只能靠截图）| 是 |
| `verify-webgpu-fallback.cjs [url] [model]` | WebGPU 偏好被拒绝并回退 WebGL2 + 弹窗说明 + `?gpu=webgpu` 仍可用（7 项）| 是 |
| `verify-overlay-missing-order-texture.cjs` | 复现"选中早于实例就绪"的加载崩溃，断言不崩 + 待命 + 恢复 | 是 |
| `verify-render-diagnostics.mts` | 渲染诊断逻辑单元检查（含 WebGPU 上限分支，7 例）| 否（Node strip-types 直跑）|
| `verify-blackscreen.cjs` / `verify-measure-online*.cjs` / `verify-merge-ui.cjs` | 早期线上/合并工具验证（保留作参考）| 视目标 URL |

### 跑一遍（推荐顺序）

```powershell
npm run build
node docs/verify/gen-test-splat.cjs dist/test-model.ply     # 需要 --asym 时再加
npm run verify:serve                                        # 另开窗口/后台：http://localhost:3100/
npm run verify:diag                                         # 不需要服务
npm run verify:toolbar
npm run verify:selection
npm run verify:render
node docs/verify/verify-webgpu-fallback.cjs http://localhost:3100/ test-model.ply
# 结束时删除 dist/test-model.ply —— 否则会被打进 electron 包
```

需要真机 WebGPU 对照时（Edge 用真实适配器，勿加 swiftshader 参数）：

```powershell
node docs/verify/verify-large-model-backend.cjs test-model.ply webgl2 http://localhost:3100/
node docs/verify/verify-large-model-backend.cjs test-model.ply webgpu http://localhost:3100/
```

> 大模型对照可以给 `dist/` 建硬链接，避免复制几百 MB：`New-Item -ItemType HardLink -Path dist/big-model.ply -Target <某大 PLY>`，验证完删除。

> 端口被占用时 `serve` 会自动换端口，以它输出的 URL 为准。
> Electron 打包版内建静态服务用 5173（`electron-main.js` 的 `findAvailablePort(5173)`），现场报错里的 `127.0.0.1:5173` 即此。

## 源码布局（`src/`）

`src/` 根部只保留入口与对外 API，其余按领域分目录（2026-09-11 整理，根部由 76 个松散文件降到 5 个）：

| 目录 | 内容 |
|---|---|
| `src/`（根部 5 个）| `index.ts`（应用入口）、`main.ts`、`sw.ts`（service worker）、`pc-app.ts`、`iframe-api.ts`（内嵌 API）|
| `core/` | 基础设施：事件、命令队列、编辑历史/操作、选择与 op、序列化、偏好、快捷键、GPU 后端、渲染诊断等 |
| `app/` | 应用层：`editor.ts`、`render.ts`、文档与文件处理（`doc`/`file-handler`/`drop-handler`/`asset-loader`/`recent-files`）、发布 |
| `scene/` | 场景图与拾取：`scene`/`element`/`underlay`/`outline`/`infinite-grid`/`pivot`/`picker`/形状与工具覆盖层/裁切盒 |
| `splat/` | 高斯数据与渲染：`splat`、序列化、状态、overlay、group renderer、变换调色板、球形元数据 |
| `camera/` | 相机与交互：`camera`、控制器、路径控制、PiP 预览、相机位姿、补间、鼠标绑定 |
| `ui/` | PCUI 面板、工具栏、弹窗、scss、svg |
| `tools/` | 选择/变换/修复等工具（含球刷、裁切、平面修复残留）|
| `data-processor/` `shaders/` `workers/` | GPU 判交/直方图/边界、GLSL 着色器、Worker 入口 |
| `merge/` `compare/` `timeline/` `animation/` `audio/` `effects/` `geometry/` `io/` `lod/` `gamepad/` `transform/` `tool-modules/` | 各专项模块 |

移动模块请用 `scripts/move-src-modules.mjs`（自动重算相对 import，含 `scripts/`、`docs/` 里的跨引用），移动后必须
`npm run typecheck && npm run lint`。

## 全新拉取仓库后的构建

```powershell
npm install
npm run patched        # 若 npm 的 allow-scripts 策略拦住了 postinstall，手动补打补丁（见下）
npm run build
npm run dist:win       # 可选：打包便携版
```

- `postinstall`（`scripts/apply-patches.js`）会打两个补丁：`@playcanvas/splat-transform` 的 `MAX_STRIPE_BYTES`
  8MB→128MB（大 SOG 导出必需），以及嵌套 `eslint-plugin-import` 的 ESLint 10 API 兼容（旧解析版本需要）。
  **本机环境的 allow-scripts 策略会拦住它**，所以提供了 `npm run patched` 手动入口；包内文件是否已打补丁可直接
  查 `node_modules/@playcanvas/splat-transform/dist/index.mjs` 里有没有 `MAX_STRIPE_BYTES = 128 * 1024 * 1024`。
- 打包前若报找不到依赖树，需要给 `node_modules/app-builder-lib/out/util/appFileCopier.js` 打 TRAVERSAL 补丁
  （离线/受限环境），打包完请还原。

## 与上游 SuperSplat 的关系

- 上游：`playcanvas/supersplat`（MIT，v3.1.x，**纯 WebGPU**）；本仓库是 WebGL2 分支。
- 选择语义、工具栏、工具交互按上游 v3 对齐，细节与有意保留的差异见 `V3-选择工具对齐-SuperSplat3-2026-09-11.md` 与 `V3-开发存档-2026-09-11.md`。
- 上游依赖 WebGPU compute/projected-cache 的部分（footprint 逐行区间、GPU colorMatch、`createLayer` 式 duplicate/separate）**未移植**，本仓库以 GLSL/CPU 等价实现或暂缓。
- **本仓库的 WebGPU 后端不可用**（自研着色器全是 GLSL，且引擎在 WebGPU 上会改用自带 WGSL splat 材质），启动时会被拒绝并回退 WebGL2，详见 `V3-WebGPU-现状.md`。
