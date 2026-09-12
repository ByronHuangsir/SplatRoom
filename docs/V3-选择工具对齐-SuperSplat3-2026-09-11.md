# V3 选择工具对齐 SuperSplat 3（2026-09-11）

对照对象：`playcanvas/supersplat` v3.1.2（MIT，WebGPU）。方法是逐文件读上游 `src/tools/*`、
`src/ui/bottom-toolbar.ts`、`src/ui/select-cursor.ts`、`src/ui/scss/{bottom-toolbar,tool,select-toolbar}.scss`、
`src/tools/tool-manager.ts`、`src/shortcut-manager.ts`、`static/locales/en.json`，与本仓库对应文件逐项比对。

> 上游是 WebGPU + projected-cache 架构，凡依赖该架构的部分（`footprintIntersect`、`SelectRegion` 逐行区间、
> GPU `colorMatch`、`createLayer` 式 duplicate/separate）**不可直接移植**，本批只做语义/交互层对齐。

## 一、工具清单

两边注册的选择工具 id 完全一致：`rectSelection` / `brushSelection` / `sphereBrushSelection` /
`floodSelection` / `polygonSelection` / `lassoSelection` / `sphereSelection` / `boxSelection` /
`eyedropperSelection`（另有 move/rotate/scale/measure/orient）。SplatRoom 额外有 `heal` / `groundwater` / `crop`。
→ **没有缺失的工具**，差异全在交互与 UI。

## 二、本批已落地（提交见 git log）

### 1. 底部工具栏（上游 v3 最显眼的变化）

| 项 | 上游 | 本仓库之前 | 现状 |
|---|---|---|---|
| 选择深度开关 | `#bottom-toolbar-selection-mode`，图标 `selection-depth-on/off.svg`，点击 `selection.toggleUseDepth` | 只有设置面板里的开关行 | **已加**（图标随状态切换、`aria-pressed`/`aria-label`、tooltip 带快捷键）|
| 选择覆盖开关 | `#bottom-toolbar-selection-footprint`，图标 `selection-footprint-centers/rings.svg`，`selection.toggleFootprint` | 同上 | **已加** |
| 工具分组按钮 | `toolGroup()`：短按切当前工具、**长按 400ms** 弹 `MenuPanel` 列出组内工具、按钮显示组内当前工具图标、右下角小三角标记 | 4 个平铺按钮 | **已加**：`polygon`=[polygon, lasso]、`eyedropper`=[eyedropper, flood] |
| 工具顺序 | undo/redo ‖ depth, footprint ‖ picker, brush, polygon, eyedropper ‖ sphereBrush, sphere, box ‖ move/rotate/scale ‖ measure, orient, coord, origin | 平铺且顺序不同 | **已按上游顺序**（`heal` 保留在 box 之后）|
| tooltip 文案 | `tooltip.bottom-toolbar.use-depth/footprint/sphere-brush-selection` | 球刷为硬编码英文 | **已本地化**（9 个语言，667 keys，`lint:locales` 通过）|

### 2. 光标 / 覆盖层

- `select-cursor.ts` 的 `pointerTools` 补上 `'sphereBrushSelection'`（上游有，本地漏）→ 球刷现在也会显示 add/remove/intersect 徽标光标。
- `scss/tool.scss` 补 `#sphere-brush-select-svg > circle`（虚线描边 + 球体渐变），球刷工具不再自己写死填充/描边。

### 3. 工具交互健壮性（上游有、本地缺）

| 修复 | 文件 | 说明 |
|---|---|---|
| `pointercancel` + `hasPointerCapture` 保护 | rect / lasso / brush | 触摸被系统手势取消时不再抛异常、不再把 `dragId` 卡死（卡死后该工具再也无法框选）|
| 矩形坐标 `clamp01` | rect | 拖出画布时不再发出越界归一化坐标 |
| 多边形首击不再丢 | polygon | `pointerup` 时先取 `currentPoint = {offsetX, offsetY}`（键盘切工具后第一次点击没有 pointermove）|
| 笔画忙锁 `mask.busy` | brush / lasso / polygon / flood / sphere-brush | 上一次选择还在消费共享笔画画布时，新笔画被忽略，避免画布被改写导致选择错乱 |
| 笔刷激活时定位光标 | brush | 记录 window 指针位置，激活瞬间把笔刷圆环放在鼠标处（原实现停在上一笔结束处）|
| flood 监听器泄漏 | flood | `pointerup` 用 `capture=true` 添加却按默认移除 → 改为同参数移除 |
| 拾色器支持相交 | eyedropper + editor | 用 `opFromModifiers`（Shift+Ctrl = intersect），`select.colorMatch` 的 op 联合类型补 `'intersect'` |
| 相机指针捕获保护 | controllers | `releasePointerCapture` 前判 `hasPointerCapture`（无捕获时释放会抛 DOMException，无头验证抓到的真实报错）|

### 4. 共享基建

- `tool.focus` + `Tool.getFocus`：上游按 `f` 可框选**工具自身体积**；本仓库补上该钩子，`f` 在球/盒选择工具激活时改为框选该体积（球=球心+半径，盒=中心+半对角线），其余情况行为不变。
- `ToolManager` 构造时广播一次 `tool.coordSpace`，使预先构建的工具栏能显示正确的默认坐标系状态（**默认值仍保留本仓库的 `world`**，上游为 `local`：这是有意的差异，见下）。
- `select.byMask` 改为**每次手势一张独立遮罩纹理**（`finally` 中销毁），取代共享缓存纹理；后者在排队期间可能被后续笔画改写。
- `shortcuts-popup`：补球刷条目、两个选择模式开关条目、`Shift + Ctrl = 与选区相交`提示。

## 三、无头验证（`docs/verify/verify-*.cjs`，Edge + swiftshader 软件 GL）

| 脚本 | 覆盖 | 结果 |
|---|---|---|
| `verify-selection-toolbar.cjs` | 两个模式开关存在/图标切换/`aria-pressed`/标志翻转、分组按钮数量与激活态、**长按弹层列出 2 行**、球刷与矩形按钮激活工具 | **21/21 通过，0 报错** |
| `verify-mask-vs-rect.cjs` | 上下两个区域分别用 rect 与 mask（深度+覆盖模式）选择，验证二者一致 | 上 291 vs 247、下 340 vs 279，**全通过** → 说明拾取行索引**没有纵向翻转**（上游用 `pick[y*pw+x]`、本仓库用 `pick[(ph-1-y)*pw+x]` 是因为两边 picker 的行序不同，本仓库写法正确） |
| `verify-selection-depth.cjs` | 四象限 + 体积 + 球刷路径回归 | 序关系全部保持（footprint ⊃ centers、depth ⊂ centers、mask/depth < mask/footprint、球刷路径 11→52），**0 报错 0 警告** |

该链在本批中抓到的真实问题：无保护的 `releasePointerCapture`（DOMException）。

## 四、有意保留的差异（未跟随上游）

1. **坐标系默认值**：上游 `tool.coordSpace` 默认 `local`，本仓库保持 `world`（改了会影响既有用户的变换手柄手感）。如需一致可直接改 `tool-manager.ts` 的一行。
2. **depth / footprint 开关同时保留在设置面板**：上游只在工具栏。保留两处入口，二者通过事件同步。
3. **`footprint` 快捷键为 `Shift+M`**：上游是 `M`，但本仓库 `M` 已是 centers/rings 视图切换。`N`（depth）与上游一致。
4. **盒选择图标**：上游 `select-box.svg`，本仓库仍用 `show-hide-splats.svg`（上游该图标因 GitHub API 限流未取到，未凭空造图）。
5. **`select.bySphere`/`byBox` 的 footprint 传参位置**：上游塞在 `{ sphere: { transform, footprint } }`，本仓库放在同级 `{ sphere, footprint }`（语义等价，工具侧在调用时读取）。
6. **`select.colorMatch` 仍为 CPU 实现**（上游是 GPU，属架构差异）。
7. **duplicate / separate 仍走 PLY 往返**（上游用 `splat.createLayer` + `AddSplatOp`）：属较大改造，未在本批范围。
8. **上游 `flood-selection` 的 `pointerup` 泄漏**：上游同样存在，本仓库已修（更正确）。

## 五、复现验证

```powershell
npm run build
node docs/verify/gen-test-splat.cjs dist/test-model.ply            # 或加 --asym 供 mask/rect 一致性测试
npx serve dist -C -l 3100
node docs/verify/verify-selection-toolbar.cjs  http://localhost:3100/
node docs/verify/verify-mask-vs-rect.cjs       http://localhost:3100/
node docs/verify/verify-selection-depth.cjs    http://localhost:3100/
# 跑完删除 dist/test-model.ply，否则会被打进安装包
```
