# SplatRoom 开发历程存档

> 一份从「基于 PlayCanvas SuperSplat v2.31.10 二次开发」到当前版本（v2.1.8 + V3 分支）的完整可读记录。
> 作者：摄影师黄Sir <1924705842@qq.com>
> 存档日期：2026-08-14（2026-10-06 补记第七节）
> 工作目录：`C:\Users\Byon Huang\WorkBuddy\SplatRoom`（2026-08-04 由旧工作空间迁移而来）

---

## 一、项目概览

SplatRoom 是一款面向 3D 高斯喷溅（3DGS）的桌面级编辑/查看工具，二次开发自 PlayCanvas 官方 SuperSplat v2.31.10。核心定位是**摄影测量/航测场景下的实景模型修整与影像化产出**，而非通用 3DGS 编辑。

技术栈：PlayCanvas 引擎（gsplat 渲染管线，legacy 模式 `unified:false`）+ TypeScript + Rollup + Electron（单文件便携 exe）。

**版本号两条线：**
- 主程序线：`2.31.x`（早期功能迭代）→ `v1.0.0`（更名 SplatRoom）→ `2.0.x` → `2.1.x`（渲染管线治理期）
- 参照/未来线：`SplatRoom V3`（含 L2 距离 LOD 能力，独立工作空间）

---

## 二、关键节点（按时间）

### 阶段 0 · 起点：调色系统重建（2026-07-20）
基于 SuperSplat 源码，第一步是彻底重写调色面板，并打通 Electron 打包。

- **调色面板 UI 重写**：从单一面板改为多标签页（基础 / HSL / 曲线）。曲线编辑器为自研 Canvas 2D 交互（Catmull-Rom 样条，支持拖拽/增删控制点、直方图背景）。
- **单色 bug 系列修复（贯穿全天，共 5+ 轮）**：这是开局最大的坑。根因是 fragment shader 调色函数里 `uniform vec3 hslChannels[8]` 数组 uniform 在 WebGL 未初始化时默认 0，而 `anyAdjust` 误判触发 HSL 导致饱和度归零；叠加顶点/片元着色器双重处理、GLSL const 数组语法、`texture2D` 在顶点着色器不被 ANGLE 支持等问题。最终方案：所有调色逻辑移到**片段着色器** + 0 基中性值 + `hslEnabled` 显式开关。
- **调色前后对比**：按住对比按钮显示原始画面（bypass）。
- **Electron 打包 Windows 可执行文件**：`electron-main.js` 重写为内置 HTTP 静态服务器（解决 `file://` 下 ES Module CORS 白屏），`electron-builder` portable 单文件 exe。期间解决 Electron/winCodeSign 镜像下载超时（npmmirror 镜像）。
- **版本演化**：`SuperSplat-2.31.1` → `2.31.2`（清理打包缓存，黑白/残留 HSL 问题）→ `2.31.3`（色调改为绿-洋红滑块 + 色温标签修正）→ `2.31.4`（WebP 分条编码 v2，修复 62M 高斯 SOG 导出失败）→ `2.31.5`（右键上下文菜单：复制/剪切/粘贴/选择/变换/测量）。

### 阶段 1 · 运镜与画中画（2026-07-21 ~ 07-22）
为摄影测量「自动环绕拍摄」需求构建完整运镜系统。

- **3D 摄像机路径可视化 + 穿越运镜**：控制点系统（拖拽、屏幕空间固定大小、视轴锥/焦距球）、路径 spline 实时更新、相机速度模式（匀速/变速）、俯仰角约束。
- **PiP 画中画预览窗**（v2.31.7+）：独立小窗实时预览，伴随多轮深度排序修复（双线、黑屏、路径泄露、模型错位）。
- **时间线**：仅保留 camera + color 两条轨道（移除了变换轨道 / autoSmooth）。
- **旋转台视频导出**（v2.31.8）：`setPoseOverride` 直接设 pos/rot，首帧 `keyFrame:true`；环绕/环视两种模式；视频首帧非关键帧、环视模式无画面等修复。
- **打包 `v2.31.8`**（2026-07-22）。

### 阶段 2 · 调色完善 + 工具扩展 + 更名（2026-07-24 ~ 07-25）
- **调色面板分类重构**：HSL 逐通道（Lightroom 风格方案 C）、非破坏性删除预览（showDeleted）、吸管工具优化、饱和度归入颜色分类。
- **去浮云面板（Floater Removal）**：实时预览 + 启用开关，用于清理航测中的悬浮噪点。
- **修补工具（Heal/Inpaint）**：撤销后无法选中 + 效果不佳修复。
- **多模型拼接 Group/Link**（2026-07-24）：`group-renderer.ts` 跨 splat 合并 DataTable → 单一 Entity 渲染；Ctrl+Click 多选链锁；Group 专注变换、Merge 合并为新模型；Group 后调色失效、移动流畅度、深度排序混乱等修复（含 GlobalSplatManager 全局排序方案 A，后因 ArrayBuffer 溢出回滚）。
- **软件更名 SplatRoom v1.0.0**（2026-07-25）：帮助菜单优化、图标更换、开源发布素材准备。

### 阶段 3 · 修整三件套：平面 / 表面 / 对比（2026-08-02 ~ 08-04）
- **平面修整 Planar Fix**（2026-08-02，后暂停）：基准面贴平 + 压平突起高斯；从早期「平面范式」重写为「盒（box）范式」线框交互（厚度控制轴、填充面、网格线）。存档：`平面修整功能存档.md`。
- **表面平整 L1 / L2**（2026-08-03 ~ 08-04）：边缘高斯半径调低 + 游离散点清除（L2）；L1 四项修复（排除自身统计、阈值可调、压缩压向 localAvg、邻域 PCA 真实法线）+ 性能优化（仅离群点做 PCA，100k 点 Phase2 2717ms→75ms）。**L1 真分裂 v1→v4（覆盖守恒、仅在表面分裂、三类切断）于 2026-08-04 19:20 整体回退**（用户指令「回到 11:35 之前」）。
- **对比工具**（2026-08-02 起，开发中）：`?mode=compare` → 高斯训练对比（飞羽实验室）；PCA+ICP 对齐、左右分屏、共享相机、24 属性直方图；**破洞检测**历经亮度法（错误）→ 深度间隙+累积 Alpha（正确）→ 等高线梯度热力图 → 三信号评分（TSPE-GS 透射率 + 累积不透明度 + 像素亮度，`max()` 融合）。
- **物体表面实体化**：效果差，全删。
- **正交视角模型消失修复**（2026-08-04）：正交投影 + 精确轴向（azim∈{0,90,180,270} 且 elev=0）时 gsplatCorner 协方差退化出 NaN → 应用层兜底 + 上游 normalize 兜底。
- **工作空间迁移**（2026-08-04）：项目整体迁至 `C:\Users\Byon Huang\WorkBuddy\SplatRoom`。
- **打包 `v2.0.0`**（2026-08-03）。

### 阶段 4 · 裁切盒 + 视频增强 + 工具菜单（2026-08-09）
- **裁切盒（Crop Box）**：box / cylinder / sphere 三种形态，shader 内切面 cap plane（导出得平整切面），双半径椭球、等比/单轴拖拽语义、球体 R3（Y）半径。
- **旋转台视频增强**：环绕/环视子菜单拆分、旋转中心改用用户「聚焦」、视野不符 + 跳帧修复、导出应用裁切。
- **时间线音频轨道**：人声/背景音添加与录音，autoplay 修复。
- **自定义操控面板**：浮动可拖拽、分栏布局、关闭响应修复。
- **打包 `2.1.0` / `2.1.1`**（2026-08-09）。

### 阶段 5 · 合并工具 + V3 分支（2026-08-10 ~ 08-11）
- **高斯合并工具**（`?mode=merge`，独立模块）：加载/对齐/导出三模式；标记对齐历经「投影基不一致 → 世界坐标 → splatIndex 绑定 → 射线-高斯最近交点 + entity-local 存储 → 手算 OpenGL 投影矩阵」多轮（标记点漂移/坍塌/打不上点）；导出改为「存储为」对话框、拖拽 flip、导出 PLY 打不开修复。
- **测量工具升级**：比例尺 + 多边形测距测面积。
- **格式工厂（邵青）模块**：批量 PLY/SOG 转换，修复 WebP worker 缺失（卡 45%）、文件夹 + 输出目录设置。
- **SplatRoom → SplatRoom V3 完整副本**（2026-08-11 23:40）：独立工作空间，承载 10M+ 性能优化路线。
- **V3 Phase 1：纹理访问隔离适配层**（2026-08-11）：统一封装 splatColor/transformA/transformB/splatSH_* 纹理访问，冒烟测试 PASS。
- **打包 `2.1.4` / `2.1.5` / `2.1.6` / `2.1.7`**（2026-08-10 ~ 08-11）。
- **探索历程图文 PDF 存档**（2026-08-11 13:49）：见第五节资料。

### 阶段 6 · 渲染管线根本修复 + 开源（2026-08-12）
这是项目最重要的技术收口。

- **「近小远大」预存 bug 根因定位**：跨版本比对 2.0.1 / 2.1.6 / 2.1.7 / V3 / 当前，确认是**基线代码预存 bug**（所有版本都有）。根因：PlayCanvas culler 在特定场景不填充 `instance.cameras[]` → `GSplatInstance.update()` 的 `if(cameras.length>0)` 永不进入 → `sort()` 冻结 → 深度排序不更新。叠加 worker `gsplat-sort-worker.js` 的 `epsilon=1e-3` 过大（慢旋转每帧变化 ~1e-4 被视为未动）。
- **应用层修复（2.1.8）**：`splat.ts` + `scene.ts` 排序回落去掉帧节流（每帧派发）、`sorter.on('updated')` 置 `forceRender=true`、移除节流帧的 `return`。
- **引擎级修复（V3）**：① AABB 空盒——从 splatData 位置采样计算有效包围盒并赋值 `meshInstance.aabb` + `_aabb.setFromTransformedAabb()`；② epsilon `1e-3→1e-5`（同时 patch `playcanvas.mjs`）。
- **L1→L4 性能优化（legacy 管线，非 unified）**：L2 距离 LOD 着色器抽稀（uv 哈希分布式丢弃，stride 1..8）；L3 排序频率降低（PiP 限流 + 主视图按需节流）；L4 首帧粗占位（`instancingCount` 预置，首帧即显示）。
- **64M 高斯 OOM 防护**：`asset-loader.ts` try/catch 中文提示 + `loader.ts` `LOD_MAX_SPLATS` 20M→10M。
- **unified 管线调查结论（阻断性）**：引擎 gsplat 默认 `_unified=true`，但 unified 下 `set/get material` 为 no-op、无 SH 纹理（颜色烘焙 RGB）、无 CPU sorter——SplatRoom 所有自定义材质/选择/裁剪/描边/调色全失效。**结论：翻 unified 不可行，4 个入口强制 `unified:false` 是正确的。10M+ 性能必须在 legacy 线下做。**
- **打包 `2.1.8`**：`release/SplatRoom-2.1.8.exe`（158MB），备份 `release-backups/SplatRoom-2.1.8-20260812-122956.exe`。
- **GitHub 上传**（2026-08-12 23:25~23:55）：原 `.git` 损坏，`git init` 重建；排除大文件（5M.ply 325MB、1M.ply 65MB 等，GitHub 拒 >50MB）；用 PAT 推送 `https://github.com/ByronHuangsir/SplatRoom`（529 文件），推送后清除 token。

---

## 三、支线尝试（已暂停 / 已回退 / 已放弃）

这些是为主线服务的探索，多数因效果或架构原因未合入主线，留作未来参考：

| 支线 | 状态 | 结论 |
|------|------|------|
| HSL / 曲线 / 对比 标签页（早期全套） | 部分移除 | 顶点着色器承载调色导致单色，最终仅保留片段着色器调色 + 简化面板 |
| 物体表面实体化 | **已移除** | 效果差，全删 |
| 平面修整 Planar Fix | **暂停** | 盒范式落地但需求暂缓，存档保留 |
| 表面平整 L1 真分裂 v1→v4 | **整体回退**（2026-08-04 19:20） | 用户指令回退到 11:35 前；L2 UI 保留，正交 NaN 兜底保留 |
| PiP 独立排序管线 v1→v9 | 多轮迭代后稳定于 v9.1 | 共享可变状态污染主排序，最终独立 PiP 排序管线 + 同步 CPU 深度排序 |
| 渲染管线三路独立重构 | **回滚** | 空白画面多轮，切回 PiP 模式 |
| GlobalSplatManager 全局排序（方案 A） | **回滚** | ArrayBuffer 内存溢出（21:40 修复后仍回滚） |
| 物体识别：方案 A 区域生长+图割 / 方案 B SAM 2D→3D | **放弃 / 实验台** | 改为 seg-lab 物体识别实验台（多物体场景、PLY 解析修复） |
| seg-lab 拆分渲染（unified gsplat v=11） | 探索 | 揭示 GPU splat 管线不响应 opacity/scale 改动（v=10 才解决背景隐藏） |
| unified 管线迁移（V3 Phase 2） | **不可行（阻断）** | 见阶段 6；自定义材质/SH/排序全失效 |

---

## 四、关键技术约束与经验（沉淀）

1. **unified 管线不可用于 SplatRoom**：4 个入口（splat.ts / group-renderer.ts / merge-model.ts / compare-scene.ts）必须 `unified:false`，否则 SSCG 调色、选择、裁剪盒、描边、正交 NaN 兜底全部失效，且丢失视图相关 SH 颜色、无 CPU sorter。
2. **WebGL uniform 中性值陷阱**：数组 uniform 未初始化默认 0，调色函数必须以 0 为中性值，否则回退单色。验证开关优先用 `#define` 或硬编码，而非 `setParameter`（unified:false 实例下 `setParameter` 偶发不进编译后 shader）。
3. **GSplatData.calcAabb 不可信**：引擎对手动构造的 GSplatData 返回夸张 AABB（±3 → halfExtents 70），`fitCamera` 会把相机推到 dist=183。必须手动从 px/py/pz 循环算 AABB。
4. **PlayCanvas 投影正确做法**：绝不用 `pc.Mat4.transformPoint` 也不读 `camera._camera.{view,projection}Matrix`（不同 build 行为不同、缓存与 GPU 不一致）。用 gluLookAt 手算 view + 标准 OpenGL 透视 projection。
5. **构建验证教训**：rollup 语法错误输出是 `SyntaxError`/`Unexpected token`，**不含 `error:`**——`npm run build | grep "error:"` 会漏掉静默失败，导致 dist 陈旧/损坏、运行时诡异。必须用 `npx tsc --noEmit` 或看完整输出。
6. **electron-builder safe-delete 假失败**：收尾 trash 删中间文件 `splatroom-*-x64.nsis.7z` 时本沙箱 genie-safe-delete 垫片报 `操作失败 ... Some operations were aborted`，退出码 1，**不影响产物**（日志里 `building target=portable file=...exe` 已打印即完整写出）。
7. **产物校验**：无 `xxd` 时用 python 读首 2 字节应为 `MZ`，再在前 ~2MB 搜 7z 签名 `37 7A BC AF 27 1C`。两者都在即有效。
8. **无头复现渲染 bug 工作流**：puppeteer-core + Edge + SwiftShader（`--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`）；`npx serve dist -l 3000`；截图文件大小比像素探针可靠；200k 高斯单帧 ~5s，`page.screenshot()` 须带 timeout + `.catch`。
9. **SOG WebP 纹理补丁**：`MAX_STRIPE_BYTES` 8MB→**128MB**（`@playcanvas/splat-transform/dist/index.mjs` L1730），但 `npm install` 会丢失，需手动重打。
10. **Git 大文件**：GitHub 拒 >50MB（GH001），需 git-lfs 或排除；git push 在本环境需 `dangerouslyDisableSandbox`（沙箱网络重置）。**推送 GitHub 另有两个必踩点**：① **PAT 必须带 `workflow` scope** —— 仓库含 `.github/workflows/`，缺权限时 GitHub 在**推送末尾**才拒绝（`refusing to allow a Personal Access Token to create or update workflow`），此时大数据量已传完，极易误判为网络故障；② 用 `-c credential.helper=<内联helper>` 之前**必须先 `-c credential.helper=` 清空 helper 列表** —— 否则全局 `credential.helper=manager` 会被一并调用，而 git 在认证成功后会对*所有*已配置 helper 调 `store`，把 token 持久化写进 Windows 凭据管理器。详见第七节。

---

## 五、期间形成的资料（可查阅 / 可分享）

**报告与文档**
- PDF 图文报告：`outputs/SplatRoom_v2.1.8_渲染管线改造报告.pdf`（8 章节：概述 / Unified 管线 / L2 / L4 近小远大 / Load-Worker / 代码补丁 / 版本对照 / 经验）
- HTML 报告：`outputs/SplatRoom渲染管线改造报告.html`
- 平面修整功能存档：`平面修整功能存档.md`（2026-08-02）
- 表面平整专项记录文档（2026-08-04 19:30，随整体回退留档）

**线上资料库 / 网盘**
- 公开分享链接（HTML 报告）：`https://workbuddy.link/p/TveWWr86WxuSAGohdlHK2S`
- 网盘（PDF）：`https://www.workbuddy.cn/space/d/6miAFppdfgVghMkMIkPZZc`
- GitHub 仓库：`https://github.com/ByronHuangsir/SplatRoom` —— 2026-08-12 首传 v2.1.8 快照（`main` 分支，529 文件）；2026-10-06 补推完整历史（`master` 分支，353 提交），详见第七节

**历史版本备份库**
- `release/`（各版本 exe/zip）+ `release-backups/`（带时间戳备份，如 `SplatRoom-2.1.8-20260812-122956.exe`）

**可复用测试脚本**
- `scripts/gen-test-ply.py`：生成 INRIA 3DGS 格式测试模型
- `scripts/repro-ortho.js`：无头复现正交 NaN 渲染 bug
- `scripts/probe-l2.mjs`：L2 距离 LOD 探针
- 表面平整系列：`gen-bump-ply.py` / `gen-flat-ply.py` / `gen-cut-ply.py` / `repro-surface-split.js` / `repro-surface-flat.js`
- `scripts/static-server.js`（seg-lab，PORT 3200）

---

## 六、版本发布速查

| 版本 | 日期 | 重点 |
|------|------|------|
| SuperSplat 2.31.1~2.31.5 | 07-20~07-21 | 调色重建、Electron 打包、右键菜单 |
| v2.31.7 / v2.31.8 | 07-21~07-22 | 运镜/路径、PiP、旋转台视频导出 |
| SplatRoom v1.0.0 | 07-25 | 更名、图标、帮助 |
| v2.0.0 / v2.0.1 / v2.0.2 | 08-03~08-05 | 平面修整、表面平整、手柄模式 |
| v2.1.0 / v2.1.1 | 08-09 | 裁切盒、时间线音频、自定义操控 |
| v2.1.4 / v2.1.5 | 08-10 | 格式工厂、合并工具雏形 |
| v2.1.6 / v2.1.7 | 08-11 | 合并工具完善、V3 副本 |
| v2.1.8 | 08-12 | 「近小远大」根本修复 + 引擎级 AABB/epsilon 修复 + GitHub 上传 |
| SplatRoom V3 | 08-11 起 | L2 距离 LOD、legacy 线 10M+ 性能优化 |
| 3.23.84 / 3.23.85 | 10-06 | 当前 V3 线（顶端提交 `5f4c2cb`）；完整 353 提交历史补推 GitHub 的 `master` 分支 |

---

## 七、补记 · GitHub 完整历史推送（2026-10-06）

第二节阶段 6 记录的 2026-08-12 首次上传，是在原 `.git` 已损坏的情况下 `git init` 重建后推的一份 **v2.1.8 单提交快照**（`main` 分支，529 文件）——**353 个提交的历史当时全部丢失**。本次把从本地交接包 `.bundle` 恢复出来的完整历史补推上去。

**执行摘要**

| 项目 | 值 |
|------|-----|
| 本地仓库 | `SplatRoomV3-0`，分支 `master`，353 提交 / 811 文件，顶端 `5f4c2cb`（3.23.85） |
| 推送目标 | `https://github.com/ByronHuangsir/SplatRoom.git` |
| 远程配置 | 新增远程名 `github`；原 `origin` **未改动**，仍指向交接包 `SplatRoomV3-0-完整Git历史.bundle` |
| 分支策略 | **推成新分支 `master`，`main` 保持不动** |
| 结果 | `master` → `5f4c2cb9ddbd21f7ebfb3f7a4831f686234cd5f6`；`main` 仍为 `b7c7d4fd...` 未改动 |
| 传输量 | 4867 对象 / 21.65 MiB / 10.4s |

**为什么必须新建分支而不能直接推 `main`**：`git merge-base master <远端 main>` 返回空 —— 两条历史**完全无关**（远端那份是 `git init` 重建的），无法快进，只能新建分支或强推。选择新建分支以保旧快照可回溯。

**踩坑（两条都值得记住）**

1. **PAT 必须带 `workflow` scope**。历史里含 `.github/workflows/ci.yml`，缺该权限时 GitHub 会拒绝推送，且报错发生在**推送末尾**：`refusing to allow a Personal Access Token to create or update workflow ... without 'workflow' scope`。此时 20+ MB 已经传完，极易误判成网络问题。
2. **`credential.helper` 必须显式清空再挂内联 helper**。全局配置里有 `credential.helper=manager`，若只用 `-c credential.helper=<内联>` 追加而不先 `-c credential.helper=` 重置，GCM 会被一并调用；而 git 在认证成功后会对**所有**已配置 helper 调 `store`，导致 token 被写进 Windows 凭据管理器持久化。本次已发现该残留并 `cmdkey /delete:"git:https://github.com"` 清除，复验通过。

**凭据卫生**：推送用的 PAT 未写入 `.git/config`、`~/.gitconfig`、远程 URL 或 `.git-credentials`（均已扫描确认）；推送后已建议吊销该 token。

**遗留待办**：仓库默认分支仍是 `main`，即访客打开仓库首页看到的**还是旧的 v2.1.8 快照**（README 版本徽章仍写着 1.0.0）。如需以当前代码为门面，需手动到 *Settings → Branches* 把默认分支切换为 `master`。

---

*本存档综合自项目工作记忆（2026-07-20 ~ 2026-08-12 各日日志）与代码/打包记录，供未来回溯与接手参考。*
