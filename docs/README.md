# docs — 目录说明（开发者索引）

用户使用指南见 **`docs/index.md`**（安装/操作/调色/工具/导出等）。本文件是开发与验证相关的索引。

## 目录结构

| 路径 | 内容 |
|---|---|
| `index.md` | 用户指南（对外文档入口）|
| `V3-开发存档-*.md` | **会话存档/续接文档**（当前最新：`V3-开发存档-2026-09-11.md`，含未解决问题与下一步）|
| `V3-选择深度覆盖-2026-09-09.md` | 选择深度/覆盖/球刷的实现与上游语义对照记录 |
| `V3-选择工具对齐-SuperSplat3-2026-09-11.md` | 选择工具面逐项对齐记录 |
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
# 结束时删除 dist/test-model.ply —— 否则会被打进 electron 包
```

> 端口被占用时 `serve` 会自动换端口，以它输出的 URL 为准。
> Electron 打包版内建静态服务用 5173（`electron-main.js` 的 `findAvailablePort(5173)`），现场报错里的 `127.0.0.1:5173` 即此。

## 与上游 SuperSplat 的关系

- 上游：`playcanvas/supersplat`（MIT，v3.1.x，**纯 WebGPU**）；本仓库是 WebGL2 分支。
- 选择语义、工具栏、工具交互按上游 v3 对齐，细节与有意保留的差异见 `V3-选择工具对齐-SuperSplat3-2026-09-11.md` 与 `V3-开发存档-2026-09-11.md`。
- 上游依赖 WebGPU compute/projected-cache 的部分（footprint 逐行区间、GPU colorMatch、`createLayer` 式 duplicate/separate）**未移植**，本仓库以 GLSL/CPU 等价实现或暂缓。
