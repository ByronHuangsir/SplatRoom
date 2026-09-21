# SplatRoom V3 —— 新会话交接说明（HANDOFF）

> 这份文档是给**一个全新会话 / 另一台电脑**（换 API KEY、或换了机器，没有任何对话记忆）看的：
> 读完它 + `docs/进度存档.md` + `docs/V3-WebGPU-现状.md`（最新 **6.55**）就能无缝接着做。
> 最后更新：**3.23.8（第五十三轮，2026-09-20）**。
> ⚠️ **工程已从原机器拷到另一台能联网的电脑上继续** ⇒ 先看 **第 1.0 节「换机器：从零跑起来」**，
> 那里列了新机器上必须重建/改路径的东西。

---

## 0. 三十秒版

| 项 | 值 |
| --- | --- |
| 代码库 | `D:\DeepSeek\SplatRoomV2\SplatRoomV3-0`（git 仓库，分支 `master`，**179 个提交**，工作树干净；本文档就落在最新那一笔提交里）—— 这是**原机器**的路径 |
| 当前版本 | **3.23.8** |
| 产物 | `release\SplatRoom-3.23.8.exe`（**122.1 MB**，portable，已签名，FileVersion=ProductVersion=**3.23.8**，构建时间 2026-09-20 15:50） |
| 打包复核（实测） | asar **5297** 条 / 唯一 PLY = `dist\test-model.ply` / **8** 个 wasm / `dist/index.js` 同时含字面量 `3.4.0` 与 `3.23.8` / 9 语言各 **689** 键 / 冒烟启动 4 进程（主窗口标题 SplatRoom）→ 杀净 0 |
| 最新提交 | 本文档所在的那一笔（交接包终稿：提交数/6.55 更正 + 第 1.0.0 节交接包清单）→ `1a3232f`（交接记录：本文件重写 + 存档第五十三轮 + 现状 6.55）→ `ed0abb3`（3.23.8 打包复核）→ `a4b411f`（③ 深度行程映射） |
| 技术栈 | PlayCanvas 2.21.3 / PCUI 6.1.4 / @playcanvas/splat-transform ^3.4.0 / i18next 26.3.6 / TypeScript 6.0.3 / Rollup 4.62.2 / Electron 43.4.0 / electron-builder 26.15.3 / Node ≥ 20.19（本机实测 v24.9.0 + npm 11.17.0 可用） |
| 一直在改的东西 | 「选区范围」面板（最近/最远、左/右、上/下，六个方块）+ 环模式选取语义；最近四轮转向**导出内存**、**2000 万点交互性能**与**选择范围手感** |
| 最近四轮做了什么 | ①**查看器 / 打包查看器 / SOG 导出流式化**（1300 万点瞬时分配 **4251.5 → 1979.1 MB**，输出逐字节不变）②**用户 2000 万点 / WebGPU 六项问题**：①②④⑤ 修掉、③⑥ 定位到根因 ③**P0-2 排序闸门 + P0-1 框选搬进 Worker**（排序消息 **45.1 → 4.2 次/秒**；主线程最长阻塞 **320–340 → 30–34 ms，−90.2%**）④**③ 深度轴改成"滑块百分比 = 选中质量占比"**（密集区行程 20 → **74.5** 个单位） |
| 下一步建议 | ①做 **P0-3**（交互期降级：降 SH 波段 / 抽稀 / `alphaClipForward`）②定 ③ 的细端取舍（a/b/c，见第 6 节第 3 条）③要不要做 **K 路并行 worker**（把框选端到端 ~1015 ms 压进 ≤600 ms）④**离群点剔除 / 按密集区裁剪**（这张模型 AABB 被噪声撑到 ×54，是 ③④ 的共同根源）。详见 `docs/进度存档.md` 第 0 节 |

**比这一页更细的三份材料**：

- `docs/perf/2000万点六项问题-排查发现.md`：2000 万点六项问题的逐条根因 + 实测数字 + 测量方法学 + 待办
- `docs/perf/supersplat-3.3.0-对比调研.md`：浏览器版 SuperSplat 3.3.0 的性能实现对比（上游源码出处、P0/P1/P2 差异清单、量测口径与阈值）
- `docs/V3-WebGPU-现状.md`：每一轮一节的"为什么这么改 + 实测数字"（最新 **6.55**，即第五十三轮 ③ 深度行程映射）

**用户是谁**：一个 3D 高斯泼溅（splat）摄影师 / 开发者，用中文沟通。他自己有测试模型（1300 万点与 2000 万点的真实扫描件），
会反复推敲界面手感，要求"严格照设计稿"并给出可量化的验证。**他是唯一的验收人**。

---

## 1. 环境（必须照抄的路径与命令）

```
仓库            D:\DeepSeek\SplatRoomV2\SplatRoomV3-0        （git 仓库，master）
用户的测试场景   D:\DeepSeek\SplatRoomV2\选择工具\merged-scene.ply   （13,007,105 点 / 694.7 MiB / 16 列无 SH）
用户的 2000 万点 D:\3DGS\训练结果\文物\LFS-文物-真珠舍利宝幢-35\splat_273200.ply
                                                    （20,000,000 点 / 62 列（45 列 SH）/ 4.73 GB）
我的验证扫描     D:\DeepSeek\SplatRoomV2\_tmp\scan.ply              （93 万点，ASCII PLY）
旧版参考         D:\DeepSeek\SplatRoomV2\SplatRoomV2-5\             （上游版本，2.5.34 基线）
设计稿           D:\DeepSeek\SplatRoomV2\选择工具\设计.png / 选择范围设计.png
puppeteer-core  C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core
Edge            C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe
静态服务         npx serve dist -p 3621        （所有验证脚本默认打 http://localhost:3621/?gpu=webgpu）
```

**验证脚本的公共约定**：`node docs/verify/xxx.cjs "<url>" [model]`，默认
`http://localhost:3621/?gpu=webgpu`、模型 `test-model.ply`；结果打印一个 JSON，里面 `checks[]` 每项
有 `{name, pass, detail}`，末尾 `"failed": N`。**判断成败看 `failed`。**

### 1.0 换机器：从零跑起来（另一台联网电脑，必读）

#### 1.0.0 交接包里有什么（2026-09-20 交付，目录 `D:\DeepSeek\SplatRoomV2\交接包_20260920\`）

| 文件 | 大小 / SHA256 | 内容 |
| --- | --- | --- |
| `SplatRoom-3.23.8.exe` | 122.11 MB / `FDBC14C5…CD32` | portable 可执行文件，FileVersion=ProductVersion=3.23.8，双击即用（不需 node、不需联网） |
| `SplatRoomV3-0-源码与文档.zip` | 17.28 MB / `4655756C…96BF9` | 工作树快照 **706 个文件**（`src/` `static/` `scripts/` `docs/` 全套件与探针、`package.json`+`package-lock.json`、5 个小 `.ply` 夹具、36 个复现脚本）；不含 `.git`、`node_modules/`、构建产物、两个大模型夹具 |
| `SplatRoomV3-0-完整Git历史.bundle` | 16.01 MB / `F25EE896…1CBBC` | **179 个提交**的完整历史，`git bundle verify` = `records a complete history` |
| `完整工作记录-截至3.23.8.md` | 62.5 KB | 本文件的副本，不用解压就能读 |

交付前实测（都在原机器上跑过，不是"应该没问题"）：zip 逐条目 SHA256 与仓库同名文件比对 **706/706 字节一致**（缺失 0、不符 0）；zip 与 `git ls-files` 的差集 41 项**全部**落在 `.gitignore` 覆盖的夹具与复现脚本上；bundle 克隆到临时目录得到 **提交个数与逐个 SHA 都同源仓库一致**；exe 属性与启动冒烟通过。

**还原 git 历史（二选一，都实测过）**：

```powershell
# 方案 A：从 bundle 克隆（推荐），再把 zip 里被 git 忽略的补充件拷进去
git clone .\SplatRoomV3-0-完整Git历史.bundle SplatRoomV3-0
Expand-Archive .\SplatRoomV3-0-源码与文档.zip -DestinationPath .\_stage
Copy-Item .\_stage\SplatRoomV3-0\dist\*                      .\SplatRoomV3-0\dist\ -Force
Copy-Item .\_stage\SplatRoomV3-0\scripts\dev-history\local\* .\SplatRoomV3-0\scripts\dev-history\local\ -Force

# 方案 B：就地解压 zip，再把历史接上（注意不能直接 fetch master:master，git 会拒绝）
Expand-Archive .\SplatRoomV3-0-源码与文档.zip -DestinationPath .
cd .\SplatRoomV3-0
git init -q
git fetch ..\SplatRoomV3-0-完整Git历史.bundle "refs/heads/master:refs/heads/from-bundle"
git reset --hard from-bundle        # 工作树文件不动，只补上历史
git update-ref -d refs/heads/from-bundle
```

1. **拷工程**：整个 `SplatRoomV3-0\` 目录（`docs\` 里有全部套件/探针/文档，是资产，必须带；
   git 仓库本身也是资产 —— 提交历史、提交信息里的实测数字都在里面；没有 git 也能用交接包里的 `.bundle` 还原，见第 1.0.0 节）。
   **可以不带**：`node_modules\`（第 3 步重建）、`release\` 里除最新那个 exe 之外的旧产物
   （实测 **62 个 exe / 合计 7.4 GB**，每个约 122 MB，纯历史包袱；`release\win-unpacked\` 留着有用，见第 3 步）。
   **`dist\*.ply` 里除 `test-model.ply` 之外的一律不要带**：
   原机器上 `dist\test-20m.ply`（4.73 GB）与 `dist\merged-scene.ply`（695 MB）是**硬链接**到用户原始文件
   （不占额外空间），拷到新机器会变成**真实副本**。新机器上要么重建硬链接（`New-Item -ItemType HardLink`），
   要么直接用原文件路径 —— 探针都接受 `"… , <模型名>"` 的第二个参数。
2. **Node**：`package.json` 要求 `>=20.19.0`；本机实测 **v24.9.0 / npm 11.17.0** 可用。
3. **`npm ci`（必须联网）**：`package-lock.json` 是**已提交**的（lockfileVersion 3；里面那个
   `"version": "3.3.4"` 是历史遗留的根版本字段，**无害**，别去改它）⇒ 依赖可以精确复现；
   本仓库 2026-09-20 在本机真跑过一次 `npm ci`（事故恢复），装完即可 build。
   它会跑 `postinstall` = `scripts/apply-patches.js`（两个补丁：
   splat-transform 的 `MAX_STRIPE_BYTES`、`eslint-plugin-import` 的 ESLint 10 API 兼容；
   第一个现在是 **no-op**，见第 7 节第 14 条）。
   ⚠️ **`npm ci` 之后 `node_modules\electron\dist` 可能是空的** ⇒ 打包会报
   `The specified electronDist does not exist: …\node_modules\electron\dist`。两条修法：
   - 联网：`node node_modules/electron/install.js`；
   - 不联网：从带过来的 `release\win-unpacked\` 拷进 `node_modules\electron\dist\`
     （把 `SplatRoom.exe` 改名成 `electron.exe`，再补一个只含 `43.4.0` 的 `version` 文件；
     原机器就是这么救回来的 —— **74 个文件 / version=43.4.0 / electron.exe**）。
4. **起静态服务**：`npx serve dist -p 3621`。它**会僵死**（探针永远 0 个 splat 时先 curl 一下服务端，重启即可）。
5. **两个硬编码路径必须改**（新机器上大概率不同）：`docs/verify/*.cjs` 与 `docs/probes/*.cjs` 顶部写着
   `const puppeteer = require('C:/Users/Byon Huang/…/puppeteer-core');` 与
   `const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';`
   —— 实测 **74 个脚本**硬编码了前者、**71 个**硬编码了后者（共 82 个脚本），**没有环境变量开关**，
   统一替换这两行即可（Edge 要能用 WebGPU：`--enable-unsafe-webgpu --ignore-gpu-blocklist`）。
6. **自检三步**：`npm run check`（typecheck + eslint + 语言键 + audit，退出码 0）→
   `node docs/verify/verify-selection-range.cjs "http://localhost:3621/?gpu=webgpu"`（小夹具，`failed: 0`）
   → **全量批量**（第 2.1 节，期望 `TOTAL FAILED: 0`：webgpu **38 套** / webgl2 **36 套**）。
7. **大夹具**：新机器上没有那两份真实扫描时，用 `docs/verify/gen-*.cjs` 造合成夹具
   （`test-model.ply` 等，都是 2000 点）；**并把"20M / 13M 上的结论"标注成"原机器实测"**，
   不要在没有夹具的机器上声称复现过。

### 1.1 打包（每次交付都要走完，顺序不能变）

```powershell
cd D:\DeepSeek\SplatRoomV2\SplatRoomV3-0
# 1) dist 里只能留 test-model.ply（其它 .ply 会进 asar：曾经把 210MB 模型打进去 → exe 309MB；
#    硬链接的大夹具会让 electron-builder 直接报 file size can not be larger than 4.2GB）
Get-ChildItem dist\*.ply | Where-Object { $_.Name -ne 'test-model.ply' } | ForEach-Object { Move-Item $_.FullName "D:\DeepSeek\SplatRoomV2\_tmp\ply-backup\$($_.Name)" -Force }
# 2) 依赖收集补丁（见下面「注意」——这条在 electron-builder 26.15.3 上其实是 no-op）
# 3) 单实例锁：先杀干净，再打包
Get-Process -Name SplatRoom -ErrorAction SilentlyContinue | Stop-Process -Force
npm run build
npx electron-builder --win portable --config.npmRebuild=false
# 4) 还原补丁：node -e "const fs=require('fs');const p='node_modules/app-builder-lib/out/util/appFileCopier.js';if(fs.existsSync(p+'.bak')){fs.copyFileSync(p+'.bak',p);fs.unlinkSync(p+'.bak');}"
# 5) 冒烟：4 个进程 → 杀干净后 0
Start-Process release\SplatRoom-3.23.8.exe; Start-Sleep 22; (Get-Process SplatRoom -ErrorAction SilentlyContinue | Measure-Object).Count
Get-Process SplatRoom -ErrorAction SilentlyContinue | Stop-Process -Force
```

**注意（2026-09-20 实测修正）**：第 2 步流传下来的那条命令找的是
`const pmApproaches = [await packager.getPackageManager(), node_module_collector_1.PM.TRAVERSAL];`，
而 electron-builder **26.15.3** 的 `appFileCopier.js` 里**已经没有 `pmApproaches` 这个符号**
（`Select-String` 搜不到），真实行是 `const TRAVERSAL = [await packager.getPackageManager(), node_module_collector_1.PM.TRAVERSAL];`。
⇒ 现在这条补丁是 **no-op**，而 3.23.7 / 3.23.8 两次打包在**未打补丁**的状态下**都成功了**。
**只有新机器上 `npx electron-builder` 真的卡在依赖收集时**才需要动它，改法是把上面那行的
`[await packager.getPackageManager(), ` 删掉（记得 `.bak` 备份、之后还原）。

### 1.2 打包后必查（期望值都是本轮实测）

`asar` **5297** 条 / 唯一 PLY = `dist\test-model.ply` / **8** 个 wasm / `dist/index.js` 含 `3.4.0` + 当前版本 /
9 语言各 **689** 键 / exe 属性 FileVersion=ProductVersion=当前版本 / 冒烟 4 进程 → 0。一条命令：

```powershell
node docs/probes/check-asar-3120.cjs        # 改一下里面的路径即可
# 版本字面量 / 键数（本轮用的就是这条）
node -e "const s=require('fs').readFileSync('dist/index.js','utf8');console.log(s.includes('3.23.8'),s.includes('3.4.0'))"
```

**坑**：`asar.extractFile(src,'dist/static/locales/zh-CN.json')` 这类深路径在 Windows 上会报 "not found"
（条目名带**反斜杠**）⇒ 用 `listPackage()` 里的原始条目名，或 `extractAll` 到临时目录再读（踩过两次）。

---

## 2. 怎么跑验证

### 2.1 全量（**webgpu 38 套**；`verify:diag` 另有 7 项）

```powershell
npx serve dist -p 3621      # 后台起静态服务（另开一个窗口/后台任务）
npm run check               # typecheck + eslint + 语言键 + audit，退出码 0 才算过
npm run verify:diag         # 7 项渲染诊断，期望 "all 7 checks passed"
$url = "http://localhost:3621/?gpu=webgpu"
$suites = Get-ChildItem docs\verify\verify-*.cjs -Name | Where-Object { $_ -notlike "verify-measure-online*" -and $_ -ne "verify-blackscreen.cjs" -and $_ -ne "verify-large-model-backend.cjs" -and $_ -ne "verify-webgpu-fallback.cjs" -and $_ -ne "verify-load-worker.cjs" -and $_ -ne "verify-selection-responsiveness.cjs" -and $_ -ne "verify-large-model-ui.cjs" }
foreach ($s in $suites) {
  $r = node "docs\verify\$s" $url 2>&1 | Out-String
  if ($r -match '"failed":\s*(\d+)') { "{0,-44} failed={1}" -f $s, [int]$Matches[1] } else { "{0,-44} UNPARSED" -f $s }
}
```

`docs/verify/` 里现在有 **47 个 `verify-*.cjs`**，上面这段跑 **38 个**（排除的 9 个：`verify-measure-online*` 3 个、
`verify-blackscreen.cjs`、`verify-large-model-backend.cjs`、`verify-webgpu-fallback.cjs`、`verify-load-worker.cjs`、
`verify-selection-responsiveness.cjs`、`verify-large-model-ui.cjs`）。
**双后端**：webgl2 侧跑同一段（换成 `?gpu=webgl2`）是 **36 套**（少的那两套只支持 WebGPU）。

**UNPARSED 是既有输出形状问题、不是失败**：`verify-merge-ui.cjs`（根本没有 `failed` 字段，看 `pageerrors: []`）、
`verify-sphere-brush.cjs`（单独跑 **6/6**，退出码 0）、`verify-edit-grade-crop.cjs`（单独跑 **4/4**，`failed` 字段在批量里没被解析出来）。

### 2.2 需要大夹具 / 特殊跑法的套件（都不进批量）

| 套件 | 怎么跑 | 说明 |
| --- | --- | --- |
| `verify-large-model-ui.cjs` | 先备好 `dist\test-20m.ply`（硬链接），`node docs/verify/verify-large-model-ui.cjs "http://localhost:3621/?gpu=webgpu" test-20m.ply` | **真正验 ①②④⑤ 的那一套**（5/5）：亮像素、覆盖层绘制数、取景半径、重置相机仰角。跑完**立刻删** `test-20m.ply` |
| `verify-viewer-large.cjs` | `node docs/verify/verify-viewer-large.cjs "http://localhost:3621/?gpu=webgpu"` | 大模型上"三种导出真能跑完"的判定（7 项）；夹具按 `merged-scene.ply` → `scan.ply` → `nosh-test.ply` 找第一个，**都没有就跳过**（`skipped: true, failed: 0`），不假装通过 |
| `verify-large-model-backend.cjs` | `node docs/verify/verify-large-model-backend.cjs big-model.ply webgpu http://localhost:3621/` | 先把 `_tmp\scan.ply` 拷成 `dist\big-model.ply`，跑完**立刻删** |
| `verify-webgpu-fallback.cjs` | **不要传 url 参数**：`node docs/verify/verify-webgpu-fallback.cjs` | 它自己拼 `?gpu=…`；传了 url 会变成 `…?gpu=webgpu?gpu=…` → **假红** |
| `verify-load-worker.cjs` / `verify-selection-responsiveness.cjs` | 要 `dist\scan.ply`（拷进去 → 跑 → 立刻删）；或喂小模型 `… test-model.ply` | 前者固化"load worker 现在为什么还关着"，后者固化第四十八轮的响应性回归 |
| `verify-floater-biggrid.cjs` | 先 `node docs/verify/gen-floater-biggrid-splat.cjs` 生成 `dist/floater-biggrid-test.ply` | 跑完连同 `dist\*.ply` 一起清掉 |
| `verify-render-diagnostics.mts` / `verify-index-ranges.mts` | `npm run verify:diag` / `node --experimental-strip-types docs/verify/verify-index-ranges.mts` | 批量脚本只收 `verify-*.cjs`，这两个 `.mts` 永远不进批量（后者 18 项、纯 node、秒级） |
| `verify-measure-online*.cjs` / `verify-blackscreen.cjs` | 默认打**线上部署地址** | 不属于批量，只在需要时手动跑 |

### 2.3 双后端与"必须两边都绿"的套件

关键套件（`verify-selection-depth-bar.cjs`、`verify-selection-range.cjs`、`verify-mask-vs-rect.cjs`、
`verify-selection-overlay.cjs`、`verify-shape-selection.cjs`、`verify-selection-toolbar.cjs`、
`verify-edit-hide.cjs`、`verify-range-cache-hint.cjs`、`verify-selection-depth.cjs`）都要再跑一遍
`"http://localhost:3621/?gpu=webgl2"`。**最近一轮的实际成绩：8 个选择类套件 × 两后端 = 16 次运行 `failed` 全 0**（另加 `verify-selection-depth`）。

---

## 3. 项目结构（改动集中在这些文件）

```
src/ui/range-slider.ts               一行（一个轴）：轨道 + 两个方块 + 推杆手感   ← 3.9~3.16 的主战场
src/ui/selection-depth-bar.ts        三行面板（最近/最远、左/右、上/下）+ 标题 + 重置；只喂值、不管手感
src/ui/scss/select-toolbar.scss      面板样式（方块、轨道、选中带、面板尺寸）
src/ui/bound-dimensions-overlay.ts   包围盒尺寸浮层（第五十一轮修过 translate(NaN, NaN)）
src/core/selection-flags.ts          三轴的四值状态 + localStorage + MIN_THICKNESS + normalize/merge 链式约束
src/splat/selection-core.ts          ★纯计算层（不引 playcanvas、不碰 DOM）—— 主线程与 worker 共用同一份循环
src/splat/selection-range.ts         选区几何门面：深度范围、屏幕窗口、尾巴分析、投影缓存、selectRange 掩码
src/splat/selection-worker-client.ts 常驻 worker 客户端（槽位身份判重传 / 在途去重 / 失败回退旧路径）
src/workers/selection-worker.ts      worker 侧：preMask + 全量投影 + 缓存填充，掩码以 transferable 回传
src/splat/state-bits.ts              状态位（selected/locked/deleted）的单一定义
src/splat/splat-state.ts             applySelectionMask 分块让出宏任务
src/splat/splat.ts                   framingRadius() / focalPoint() 抽样 / ensureSorterGate() / dispatchSort()
src/splat/splat-serialize.ts         查看器与 SOG 导出的流式化（模板接缝 / Base64RelayWriter / useViewerStream）
src/splat/splat-overlay.ts           点覆盖层（WebGPU 下改画全部行 + 每帧下发 overlayShowDeleted）
src/shaders/splat-overlay-shader.ts  覆盖层着色器（自己判 bit 4）
src/camera/camera.ts                 取景（focus/reset 用 framingRadius）
src/app/editor.ts                    手势（rect/lasso/polygon/brush/flood）→ 选区；范围实时重切（pump）；投影缓存接线
src/app/file-handler.ts              导出闸门（datasetBytes × memoryMultiple、askGB 0.8 / hugeGB 12）
src/core/edit-ops.ts                 SelectRangeOp.pre 惰性化（撤销时才派生）
src/data-processor/calc-histogram.ts + draw-points.ts + src/shaders/histogram-shaders.ts
                                     直方图 WebGPU 化（RenderPass/QuadRender + GSPLAT_BIN_QUADS）
rollup.config.mjs                    selection-worker 打包项（产物 dist/selection-worker.js 21 KB，无引擎泄漏）
docs/verify/*.cjs                    验证套件（47 个 verify-*.cjs，其中 38 个进批量）
docs/probes/*.cjs                    探针（测量方法写在文件头注释里，见第 9 节）
docs/perf/*.md                       2000 万点六项问题的排查发现 + 与 SuperSplat 3.3.0 的性能对比调研
docs/V3-WebGPU-现状.md               每一轮一节（最新 6.55 = 第五十三轮），"为什么这么改 + 实测数字"
docs/进度存档.md                     交接页：当前产物 / 这一轮做了什么 / 待办 / 常用命令
static/locales/*.json                9 语言，689 个扁平键（改文案要 9 个一起改，跑 npm run lint:locales）
```

---

## 4. 全部工作记录（第四十四轮 → 第五十三轮）

### 4.1 设计稿控件的 11 轮（3.9.0 → 3.16.0，第四十四轮之前的上下文）

用户从"选择工具的选区范围面板"开始，连续 11 轮打磨**同一个控件**。下面每轮都写了"用户原话 → 我怎么改
→ 关键实测"，**包括被否掉的方向**（避免重走）。

| 版本 | 用户原话（要点） | 改法 | 关键实测 |
| --- | --- | --- | --- |
| 3.9.0 | 要"扩边 / 收边" | 每轴两柄变四柄（内柄=边界、外柄=扩边） | — |
| 3.9.1 | 上下左右不顺滑、轨道×2、外扩只要微调 | 轨道 220→440；拖动保留抓取偏移 | — |
| 3.9.2 | 给设计稿 `----o 近 o-------o 远 o----`："差太多了，严格照这个来" | 轴标签进轨道、四柄分开画、**去掉所有数字框** | 行内 0 个数字框 |
| 3.10.0 | 面板×2、滑块改长方形字放里面、**调节要非线性** | 方块滑块（字在块里）+ 三次映射 `value=50+100·s·(β+(1-β)s²)`，β=0.35 | 同 20px 拖动：中心 +3.2、端点 +19.0（5.9×） |
| 3.11.0 | **"拖动滑块时滑块本身不用变化……给两个滑块中间留够操作的空间"** | 方块恒 25px、窗口内线性、两块之间恒定 126px（=轨道/3.5） | 厚度 40/2/0.5/0.2/0.1 → 间距都是 126px |
| 3.12.0 | **"我不需要让人看到那个非线性变化的尺度，只需要简单移动滑块"** | 拖动期间整张映射表冻结（1:1 跟手）+ 到边平移换 reach + `MIN_THICKNESS=0.1` | 8 步×22px 增量 `10,10,10,10,10,8.8,5.6,4.3` → `10×8`（max/min **1.000**）；偏差 12px → **0.0px** |
| 3.13.0 | **`----■------------■----` 只要两个带字的滑块、不要任何数值；两个滑块固定位置、松手自动归位** | **推杆（jog）**：两块钉在 20%/80%、拖动是相对推杆、松手归位、行内 0 数字化 | 同一次推杆：0→20px 走 0.5、200→220px 走 2.5（**5.0×**） |
| 3.14.0 | **"我需要在首次滑动滑块就能看到选区范围的变化，尤其是最远的那个"** | 深度轴**压紧两端空尾巴**（`TAIL_SHARE=2%` 压进 `TAIL_PERCENT=0.5%`） | 最远 100→98 删 **0** 个高斯 → 20px 推杆删 **2.3%** |
| 3.15.0 | **"排查下，上下左右好像没什么反应"** | 同一套压紧用到**手势框的空边距**（`screenTailFractions` → 合并进 `tailFractions`） | 六条轴推 20px 全删 **2.0–2.3%**（改前 0.05–1.1%） |
| 3.16.0 | **merged-scene：①框住塔只选到一半 ②上下左右有时有反应有时没有 ③"还是有一些不顺滑"** | ①新框选**复位范围** ②投影缓存 ③尾巴压紧去掉退化守卫 + 两处分析合并成一次采样扫描 | 13M：手势 2003→**774ms**、推杆 840–1016→**556–721ms**；框内 99.9% 照选 |

### 4.2 第四十四轮 → 第五十三轮（一句话一节，细节见 `docs/进度存档.md` 与 `docs/V3-WebGPU-现状.md`）

| 轮次 / 版本 | 做了什么 |
| --- | --- |
| 44 / 3.16.0 | merged-scene（1300 万点）上的三条（上表最后一行）；之后 3.17.0–3.20.0 是交付版迭代 |
| 45 / 3.21.0 | **环模式选取完全回到 V2 的逻辑**（`pickPrep` + `pickRect` → 去重即选中集）；导出朝向修复被用户确认 |
| 46 / 3.22.0 | 按审计「执行顺序」做的六项 + **load worker 评估（实测证明不能开：列字节一致但选区结果不同，213 vs 2000）** |
| 47 / 3.23.0 | **A2**（导出前置过滤砍半停顿、面细化回退副本 741MB 改惰性，输出字节不变）+ **A3**（投影缓存 6 B/点、门槛 ≈3200 万点、被拒时可见提示）⇒ 审计 11 条全部走完 |
| 48 / 3.23.3 | 用户报的四条：选择跟手（单击 52–74 → **28–45ms**）、小框首推（门槛 200 → **20**，六个方块 6/6）、去浮云自动检测冻结（>200 万点不自动跑，实测不冻结 22ms）、保存 OOM（**归属量清 = 查看器导出**，能修的那次分配修掉：瞬时 861.9 → **447.5MB**） |
| 49 / 3.23.4 | **查看器 / SOG 导出不再一刀拒绝** —— 改成 `datasetBytes × memoryMultiple` 估算 + 超 0.8 GB 弹确认框报体积与耗时、12 GB 才硬拒绝 |
| 50 / 3.23.5 | **查看器 / 打包查看器流式化**（详见第 5.1 节）：1300 万点瞬时分配 **4251.5 → 1979.1 MB**、输出逐字节不变、`verify-viewer-stream` 8/8；门槛 6.1 → **3.2 / 3.1** |
| 51 / 3.23.6 | **用户 2000 万点 / WebGPU 六项问题**：①②④⑤ 修掉并实测，③⑥ 定位到根因（详见第 5.2 节）；新增 `verify-large-model-ui.cjs` |
| 52 / 3.23.6→3.23.7 | **⑥ 的两条 P0**：P0-2 排序闸门（消息 45.1 → **4.2 次/秒**）+ P0-1 框选搬进 Worker（主线程阻塞 **320–340 → 30–34 ms**）；环模式护栏 `verify-rings-pick.cjs` 5/5；**打包 3.23.7**（asar 5295 → **5297**，含新增的 `selection-worker.js` 及其 map）（详见第 5.3 节） |
| 53 / 3.23.8 | **③ 选择范围只能收缩**：深度轴改成"滑块百分比 = 选中质量占比"（密集区行程 **20 → 74.5** 个单位、落差 **14.4× → 1.02×**）（详见第 5.4 节）；打包 3.23.8 |

### 4.3 现在的最终形态（别改错方向）

- **面板**：三个轴，每轴一条 440px 轨道 + **两个带字方块**（最近/最远、左/右、上/下），
  方块**永远停在轨道 20% / 80%**，中间 264px 是选区带；**行内没有任何数字**（没有数字框、没有读数）。
- **手感**：按住方块推 → 值按下式变，**松手方块自动归位**（值留着）：
  `offset(dx) = sign(dx)·0.02·(|dx| + dx²/80)`（dx 单位 px）→ 近处能抠 0.1，推远很快。
- **映射**：0..100 经 `tailMap` 映射到"内容区"，两端各占 2% 的稀疏段压进行程 0.5%；
  **0/100 仍然对应两端**（没有东西够不着）；扩边（-50/150）走线性外推。
  **第五十三轮起，深度轴的"中段"不再是 AABB 线性，而是"命中点深度分位"**（见第 5.4 节）：
  滑块百分比 = 选中质量占比。
- **一次新框选 = 从整段穿透开始**；范围随后由滑块微调，只属于这一次选择。
- **性能**：投影结果按手势缓存（`RangeProjectionCache`，8 字节/点，>2400 万点自动关 → A3 提到 6 B/点 / ≈3200 万点），
  推杆只比较窗口/深度/形状；**框选的全量投影在 Worker 里**（第五十二轮，`window.__SPLATROOM_SELECT_WORKER__ = false` 可回退）。

### 4.4 被否掉的方向（不要再提）

- ❌ 自适应窗口在**拖动过程中实时缩放**（"非线性变化的尺度"）—— 用户明确说"麻烦、不直观"。
- ❌ 滑块沿轨道走（哪怕 1:1 跟手）—— 用户要的是**钉死位置 + 推杆**。
- ❌ 任何数字显示（数字框、拖动时浮出读数）—— 设计稿里就没有。
- ❌ 外柄（扩边细柄）画在面板上 —— 面板只要两个方块（语义保留在 API / 选择逻辑里）。
- ⚠️ 范围"跨手势保留"（3.9.x 的老行为）已被 3.16.0 改成"新框选复位"，理由是它让用户"框塔只选到一半"。
- ❌ **"48–52 的窗口应该选中 ≥40%"这条判据已作废**（第五十三轮）：它与"让密集区占到有意义的滑块行程、
  不要一步几百万点"数学互斥（等分映射的定义就是"窗口质量占比 ≡ 宽度×0.9697"），见第 5.4 节。
- ❌ 取景半径**不要用** `denseRadius()`（不透明度×尺度的加权 3σ）：它会把薄墙/稀疏结构也裁掉，
  实测直接让 `verify-mask-vs-rect` / `verify-equirect-export` 两套回归失效 ⇒ 用**裁剪包围盒**。

---

## 5. 三项主要工作的完整记录（带全部实测数字）

### 5.1 查看器 / 打包查看器 / SOG 导出流式化（3.23.5，第五十轮，提交 `4ee98b1`）

**用户报的问题**：大模型上保存时报 `Array buffer allocation failed while saving file`（他的 ④）。

**钱花在哪一环**：查看器导出走 splat-transform 的 `html-bundle`（`writeHtml` 的 `bundle: true`），
这条链**整包在内存里组装**，逐环是：

| # | 环节 | 代价 |
| --- | --- | --- |
| 1 | `writeSource` 的 default 分支 → `materializeToDataTable` | 整表一份拷贝 |
| 2 | `writeSog` 把 `.sog` 写进 `MemoryFileSystem` | 再来一份 O(输出) 常驻 |
| 3 | `toBase64` | 先拼一个 O(输出) 的 binary 字符串，`btoa` 再出第二个 |
| 4 | `renderViewerHtml` 把 base64 拼进 HTML | 第三个大字符串 |
| 5 | `TextEncoder` 把 HTML 编成字节 | 第四份 |

**改法（不碰 splat-transform，只在它之上包一层，全在 `src/splat/splat-serialize.ts` + `src/app/file-handler.ts` 阈值）**：
①用"1 个高斯点"的假 `DataTable` 调一次 `writeHtml(bundle:false)` 取 viewer 模板（取模板时临时换 `silentRenderer`），
缓存为 `viewerTemplateInFlight`；②`renderViewerDocument()` 按同一批接缝（`SEAM_STYLESHEET` / `SEAM_MODULE_IMPORT` /
`SEAM_BOOTSTRAP` + 上游那两条安全检查）内联，`contentUrl` 先写占位符再 `indexOfBytes` **按字节原地替换**；
③`.sog` 仍走流式 `writeExportSog`，经 **`Base64RelayWriter` + `Base64RelayFileSystem`** 边产出边 base64
直接写进同一个 HTML 输出流（块 `BASE64_INPUT_CHUNK = 12 MiB`，`btoa` + `TextEncoder.encodeInto` 写进复用
`scratch`，收尾 1~2 字节走手写表；`close()` **不关** sink）；④打包（zip）同样流式（`writePackagedViewer`）；
⑤出口 `useViewerStream()` 读 `window.__SPLATROOM_VIEWER_STREAM__`（**`= false` 退回官方 writer**，现场排查不用重新打包）。
顺带修掉一个真 bug：没给 `experienceSettings` 时漏了 `?? defaultSettings('object')`，单文件 HTML 会去找同目录 `settings.json`。

**同一会话 A/B（13,007,105 点 / 16 列无 SH，自身 694.7 MiB，同一台机器）**

| 用例 | 耗时 | 写出 | ≥8MB 分配合计（"瞬时"） | 单次最大 | 分配次数 |
| --- | --- | --- | --- | --- | --- |
| `htmlViewer` 流式 | 99.3 s | 184.3 MB | **1979.1 MB** | **148.9 MB** | **34** |
| `htmlViewer` 官方 | 80.4 s | 184.3 MB | 4251.5 MB | 396.9 MB | 91 |
| `packageViewer` 流式 | 97.4 s | 139.0 MB | **1881.3 MB** | **148.9 MB** | **30** |
| `packageViewer` 官方 | 77.3 s | 139.0 MB | 4251.5 MB | 396.9 MB | 91 |
| `sog` | 97.5 s | 136.0 MB | 1881.3 MB | 148.9 MB | 30 |

⇒ **瞬时 −53%、单次最大 −62%、分配次数 91 → 34**；两条查看器路径现在**就等于**纯 SOG 编码的开销
（html 多出的约 98 MB 是那段 181 MB base64 的编码缓冲）。**代价：耗时 +19 s**（136 MB 的 base64 仍要在主线程过一遍
—— 这是"单文件自包含"格式的固有成本）。

**门槛按新能力放宽**：`memoryMultiple` 里 `htmlViewer` **6.1 → 3.2**、`packageViewer` **6.1 → 3.1**（实测 ×1.12 余量），
`hugeGB = 12` 的硬线从"数据集 1.97 GB"放宽到"数据集 **3.75 GB**"；其余档位不变
（`ply` 0.6 / `compressedPly` 0.6 / `splat` 0.4 / `spz` 2.8 / `sog` 2.7）；超 `askGB = 0.8` 弹确认框报体积与耗时。

**验证**：新增 `docs/verify/verify-viewer-stream.cjs` **8/8**（流式与官方 writer 的 HTML 挖掉 data URI 载荷后**逐字节相同**、
载荷解码后是同一个 zip、落盘字节一致、浏览器表现一致、走的是流式那条路、zip 条目结构一致）；全量 **36 套 `TOTAL FAILED: 0`**；`npm run check` 退出码 0。

**坑**：viewer 自己的 JS 里**就含** `data:application/octet-stream;base64,` 这个字面量 ⇒ 定位载荷必须找
bootstrap 里 `contentUrl":"` 那一处，否则会命中 viewer 代码里的字符串。

### 5.2 用户报的 2000 万点 / WebGPU 六项问题（3.23.6，第五十一轮，提交 `17aef18` + `13a41f8`）

**夹具**：`D:\3DGS\训练结果\文物\LFS-文物-真珠舍利宝幢-35\splat_273200.ply`
= **20,000,000 点 / 62 列（45 列 SH，加载后 64 列）/ 4.73 GB**，诊断时硬链接成 `dist\test-20m.ply`。
4.9 GB 单响应会被浏览器中止 ⇒ 探针改用 **Range 分块（19×256 MB）在页面里拼 File**（应用本身按 `BlobReadStream` 分块读，与真机一致）。

**实测基线（20M / WebGPU / 无头 Edge）**

| 量 | 值 |
| --- | --- |
| 导入耗时 | ~90 秒 |
| 每帧（空闲） | median 16.7 ms、p95 16.9 ms、>33ms **0 帧** |
| 每帧（轨道旋转） | median 16.7 ms、p95 29.6 ms、**max 462.8 ms**、>33ms **5 帧** |
| `select.rect`（小矩形） | **1275.7 ms** |
| `splat.updateState()` | 38.4 ms（默认）、53.1 ms（selected）、**179.2 ms（deleted，含重建排序映射）** |
| 模型 AABB | 中心 (-1665,-409,-1173)，半对角线 **16115** |
| 密集中心 `focalPoint()` | (-0.34, 18.05, 1.33) —— 与 AABB 中心相距 ~2000 |
| 密集半径 `denseRadius()` | **153.2**（AABB 的 1/105） |

⇒ 这张扫描件**有一小撮离得很远的噪声点**，把 AABB 撑到 18 km，而用户真正要看的文物密集区只有 153。

| # | 用户报的问题 | 状态 | 关键数字 |
| --- | --- | --- | --- |
| ① | "显示/隐藏 Splats"后已删除的点全回来了 | **已修 · 已实测** | 覆盖层绘制数 **20,000,000 = 全部行**（可见行 10,170,781）；删掉 **49.1%** 的点后亮像素 **96.93% → 65.86%**（修前会照旧 ~97%）；打包后复验 96.94% → 65.93% |
| ② | "高斯点数据"展开没有任何数据 | **已修 · 已实测（含 SH 夹具复验）** | WebGPU 与 WebGL2 直方图**逐 bin 逐元素一致**（2000 / 3077 / 13,007,105 三档）；带 SH 的 20M 上 `shBands=3`、`infoMin=-4988.211`、`infoMax=4817.011`、**212/256 列有柱**、**0 error** |
| ③ | 选择范围只能收缩、无法扩展 | **第五十三轮已修**（见 5.4） | 根因：框内深度只占 AABB 跨度 **1.25%** ⇒ 有用行程 ≈1.2% |
| ④ | "框显所选"只显示一小块 | **已修 · 已实测** | 取景半径 **301.7**（AABB 半对角线 8297.4），框显所选后相机到密集中心 **301.67（比值 1.0，修前 ×54）** |
| ⑤ | "重置相机"要回到密集区斜上方 15° | **已修 · 已实测** | 相机 y=**96.13** > 密集中心 y=18.05、仰角 **−15°**、方位角 0、距离/半径 1.0 |
| ⑥ | 不如浏览器版 SuperSplat 3.3.0 流畅 | **P0-1 / P0-2 已落地**（见 5.3）；**P0-3 未开始** | 热门热点已全部量化，见 5.3 |

**①②④⑤ 的根因与修法（一句话版）**

- **①**：右侧工具栏那个按钮走 `camera.toggleOverlay`（`src/ui/right-toolbar.ts:164`），切的是**点覆盖层**；
  覆盖层着色器只判锁定位（bit 2），注释假设"删除点已被序纹理排除"——**只对 WebGL2 成立**
  （引擎的 order texture 是排序后的可见集合）。WebGPU 用**恒等序纹理**且按 `splat.numSplats`（= 行数 − 已删除数）派发 ⇒ 前 N 行照画。
  修：着色器自己判 bit 4（`overlayShowDeleted` 可放开），WebGPU 下改画**全部行**（`splat.splatData.numSplats`），每帧下发 `overlayShowDeleted`。
- **②**：控制台每次都有 `CommandQueue task failed TypeError: e.updateBegin is not a function`。
  根因：`src/data-processor/calc-histogram.ts:241-257` 的 `clearRT()` 与 `src/data-processor/draw-points.ts:32-70` 的
  `drawPointsWithShader()` 用了 **WebGL 专用** `updateBegin()/updateEnd()`（`WebgpuGraphicsDevice` 没有），
  且 `src/shaders/histogram-shaders.ts:101` 的 bin 顶点着色器赋值 `gl_PointSize`（WebGPU 转 WGSL 会丢入口点 → 非法 pipeline）
  ⇒ pass3（bin 累加）每次都抛异常，面板里"计数/选中数"与直方图全空（属性名列表还在，所以看起来是"展开了但没有任何数据"）。
  修：`clearRT` 走 `typeof` 守卫 + WebGPU 用 `RenderPass` 的 clear；bin pass 在 WebGPU 下改用 `RenderPass + QuadRender`
  + 新增 binVS 的 `GSPLAT_BIN_QUADS` 变体（不再赋值 `gl_PointSize`）。**WebGL2 分支逐行未改。**
  澄清：面板「Splat: / 选择:」是**悬停读数**（`src/ui/data-panel.ts:712-722`，默认 `display:none`），不是缺数据。
- **④**：`Splat.focalPoint()` 是对的（密集中心），但**半径用的是 `worldBound.halfExtents.length()` = AABB 半对角线**
  （本夹具 8297~16115），被远处噪声点撑爆 ⇒ 相机落在 8~16 km 外（实测：导入后 16115、框显所选 8297、重置相机 13629）。
  修：新增 `Splat.framingRadius()` = **裁剪包围盒**半对角线（按轴取 1%~99% 分位、抽样 ≤20 万点、×1.1 余量），
  `camera.focus` / `editor.ts` 的 `camera.focus` 处理器 / `camera.reset` 三处都用它。
  **第一版用 `denseRadius()` 是错的**（见 4.4 最后一条）。
- **⑤**：原实现 `setFocalPoint(0,0,0)` + `setAzimElev(0,0)` + `setDistance(initialZoom)` ⇒ 相机停在离模型 13629 处。
  修：密集中心 + `framingRadius()` + `setAzimElev(0, -15, 1)`（`calcForwardVec` 的 `y = sin(-elev) > 0` ⇒ 相机在焦点上方 15°、俯视）；
  没有模型时保持原默认视角。
- 顺带修掉：`src/ui/bound-dimensions-overlay.ts` 投影退化时把 `translate(NaN, NaN)` 写进 SVG（控制台每次刷新刷屏）—— 改成 `visibility: hidden`（提交 `72a1085`）。

**验证**：**37 套回归 `TOTAL FAILED: 0`**；新增 `docs/verify/verify-large-model-ui.cjs`（真 20M 夹具，①②④⑤）**5/5**；
`verify-mask-vs-rect` / `verify-equirect-export` 在改用裁剪包围盒后恢复 `failed=0`；`npm run check` 退出码 0。
**打包后复验（3.23.7）**：同一套件 **5/5**（亮像素 96.94% → 65.93%、覆盖层绘制数 20,000,000 = 全部行 / 可见行 10,193,925、
取景半径 301.668 / 相机到密集中心 301.67、重置相机仰角 −15° 且在密集中心上方）⇒ **性能改动没有回退这些行为**（产物级证据）。

### 5.3 ⑥ 的两条 P0：排序闸门（P0-2）与框选搬进 Worker（P0-1）（3.23.6→3.23.7，第五十二轮）

**上游对比的结论先摆着**：SuperSplat 3.3.0（playcanvas 2.22.1）已自带 **GPU 投影 + 紧凑化 + GPU 基数排序 + indirect draw**，
官方博客 20M 一档 **WebGL2 44.93 ms / 22.3 fps vs WebGPU 10.22 ms / 97.8 fps** —— 本机 WebGPU 架构
**等价于那一列 WebGL2**（worker CPU 排序 + 每高斯展开 quad），所以"换 WebGPU 后端"本身不加速，
加速来自把投影/剔除/排序搬进 compute。详见 `docs/perf/supersplat-3.3.0-对比调研.md`。

#### P0-2 交互期每帧强制全量排序 → 装闸门

**第一版改错了地方（记下来以免重蹈）**：只在"我们自己的排序派发路径"（`splat.ts` 的 1e-12 检测）上做限流
—— **实测完全无效**（4 秒旋转期间仍 postMessage **181 次 = 45.1 次/秒**，最差帧 489.6 ms）。
**真因链**（读引擎源码确认）：`GSplatInstance.update()` 每帧无条件调 `sorter.setCamera()`
（`gsplat-instance.js:123-126`，门限 1e-6 ⇒ "动一点就发"）→ worker 按自己的 **1e-3** 门限
（`gsplat-sort-worker.js:43-46`）决定是否真排，旋转时每帧变化远大于 1e-3 ⇒ **只要相机在动，worker 就一直在排**
（20M 一次约 0.4 s）→ 每次排序完成引擎要做一次 **~80 MB 主线程上传**（`uploadStaging`）= 卡帧来源。
附带发现：vendored 的 `gsplat-sorter.js` 里**没有** `_sortInFlight` 合并字段，`splat.ts` 里读它/设它的
"会被合并"注释与实际引擎不匹配 ⇒ **等于一直没有合并**。

**修法**：`Splat.ensureSorterGate()`（幂等）包一层 `sorter.setCamera` —— 最快每 `SORT_MIN_INTERVAL_MS = 800 ms`
放行一次（800 是因为 20M 一次排序约 0.4 s，间隔必须大于排序时长），停手 `SORT_SETTLE_MS = 200 ms` 后补一帧；
我们自己的 1e-12 检测路径保留（间隔到点时主动派一次带 `forceUpdate` 的排序，绕开 worker 的 1e-3 门限）。

| 量（20M / WebGPU / 4 秒连续旋转，同进程同夹具） | 改前 | 改后 |
| --- | --- | --- |
| 旋转期间排序消息数 | 181（45.1/秒） | **17（4.2/秒）** |
| 停手后的补帧消息数 | 40 | **3** |
| 最差帧 | 489.6 ms | **343.7 ms** |
| >33 ms 的帧数 | 6 | 5 |
| median / p95 帧 | 16.6 / 28.6 ms | 16.6 / 29.0 ms |

⇒ 消息速率降 10 倍、最差帧降 30%；**诚实边界**：`>33 ms` 的卡帧数**几乎没变** —— 剩下的是"每次排序完成
引擎那次 80 MB 上传"的固有成本（20M 下 1~2.5 次/秒），要再降只能动架构。
**无结论的一条**：同一支探针在 **webgl2** 上量到 **0 次 worker 消息**（`hasSorter/hasWorker/hasCenters/sorterHasGate`
全 true、相机确实转了 216°、手动调 `splat.onPreRender()` 不报错也不派发）⇒ 最可能是 **WebGL2 下这份 splat 的排序
不由这段代码负责**（`hiddenByGroup` 提前 return → `group-renderer.ts` 自己 `sort()`）。**闸门在 webgl2 上是"无结论"而非失败。**

#### P0-1 框选 / 套索 / 多边形 / 2D 笔刷的投影搬进 Worker

**根因**：这个 fork 把框选从 GPU 相交改成了**主线程 JS 全量投影**（`editor.ts` 的 `runRangeSelection`
→ `selection-range.ts:432-492`），20M 上一次手势要跑 6 趟 20M 循环。改前相位表（同进程实测）：

| 相位（legacy，全部在主线程） | ms |
| --- | --- |
| tailFractions | 36.4 |
| preMask | 19.1 |
| createCache | 8.9 |
| **selectRange（全量投影）** | **768.8** |
| managedMerge | 18.6 |
| **preRanges** | **108.7** |
| **applyMasks** | **236.2** |
| **端到端** | **1198.2**（相位之和 1197.5，自洽） |

**改法（9 文件 +1622/−695）**：新增 `src/splat/selection-core.ts`（把纯计算层**原样搬出**，
不引 playcanvas、不碰 DOM ⇒ **主线程与 worker 共用同一份循环**，这是"逐位等价"的结构性保证）+
`src/workers/selection-worker.ts` + `src/splat/selection-worker-client.ts`（常驻 x/y/z 槽按**数组对象身份**判重传、
在途去重、`begin` 同步 state 快照、`select` 在 worker 内做投影、掩码以 **transferable** 回传、**任何失败回退旧路径**、
`window.__SPLATROOM_SELECT_WORKER__ = false` 可整体关闭）+ `src/splat/state-bits.ts`（状态位单一定义）+
`selection-range.ts` 变**门面** + `rollup.config.mjs` 增打包项（产物 21 KB、无引擎泄漏）+
`editor.ts` 的 `select.rect` / `select.byMask` / `select.point` 改成**发 spec**（另加 `window.__selPhases` 相位计时）+
`edit-ops.ts` 的 `SelectRangeOp.pre` 改**惰性**（只在 `undo()` 第一次需要时从 `preMask` 派生并缓存）+
`splat-state.ts` 的 `applySelectionMask` **分块让出宏任务**。

**实测 A（第一版对照，同进程）**

| 模式 | 端到端 | **主线程最长阻塞** | longtaskMax |
| --- | --- | --- | --- |
| legacy（改前代码路径） | 1067.9 ms | **1068.1 ms** | 895 ms |
| worker（改后） | 987.5 ms | **188.4 ms** | 0 |

**实测 B（收尾后的权威值，绑两个冻结构建：BEFORE `dist/index.js` SHA 前缀 `62E02F21`、AFTER `6AAA9133`）**

| 指标（4 次框选，20M / webgpu） | BEFORE | AFTER |
| --- | --- | --- |
| **主线程最长阻塞**（心跳 gap ∩ 窗口，主口径） | **319.7 / 325.5 / 339.7 / 331.7 ms** | **32.1 / 30.6 / 33.9 / 32.2 ms（−90.2%）** ✅ 达标（线 ≤150 ms，余量 4.4×） |
| longtask（浏览器自报） | 309 / 313 / 326 / 325 | **0 / 0 / 0 / 0** |
| rAF 最大帧间隔 | 322.2 / 315.7 / 337.5 / 333.7 | 29.3 / 25.3 / 30.9 / 24.4 |
| 端到端 | 1081.3 / 1090.1 / 1148.4 / 1129.8 ms | 1044.4 / 1006.7 / 1024.7 / 983.9 ms（−8.8%）❌ **仍 >600** |
| `preRanges` 相位 | 121.9 / 140.3 / 147.0 / 147.9 ms | 消失（惰性 `pre`） |
| `state.applySelectionMask` 墙钟 | 177.4 ms（**同步一口**） | 177–198 ms（**拆成 ~8 ms 一块**，单次占用 8.1–10.6 ms） |
| `worker.select`（worker 线程，不占主线程） | 735.8 / 740.3 / 773.0 / 770.0 | 808.6 / 764.3 / 773.3 / 750.0 |
| state 全表 FNV | `3395733176`（选中 16,765,227） | `3395733176`（**逐位相同**） |

⇒ **端到端的瓶颈已完全不在主线程**：worker 自身的 750–810 ms 全量投影（20M 的投影 + 掩码 + 120 MB 投影缓存分配填充）
就是地板；单 worker 无解，要用 **K 路并行**（见第 6 节）。

**撤销路径（补测，如实）**：惰性 `pre` 把 `IndexRanges.fromPredicate` 从"每次手势"挪到"撤销那一刻"，
AFTER 实测 undo 主线程阻塞 **219.7 / 211.7 ms（worker）、247.4 / 214.0 ms（legacy）**；
**没有拿到干净的改前 undo 值，不声称持平**。但**语义逐位可逆**（`_tmp/p01-undo-20m.json`）：

| 步骤 | hash | e2e | 主线程阻塞 |
| --- | --- | --- | --- |
| cleared | 2279260613 | — | — |
| A set | 3395733176 | 1105.7 ms | 32.5 ms |
| B add | 2641638330 | 902.4 ms | 29.7 ms |
| **undo B** | 3395733176 ✔ | 436.7 ms | **235.7 ms** |
| **undo A** | 2279260613 ✔ | 418.0 ms | **219.6 ms** |
| redo A | 3395733176 ✔ | 209.2 ms | 27.1 ms |
| redo B | 2641638330 ✔ | 142.4 ms | 26.8 ms |

**环模式语义（顺带坐实，直接关联 ③）**：新增护栏套件 `docs/verify/verify-rings-pick.cjs`（**5/5**，
此前全仓无任何套件覆盖环模式）：**rings 整屏框选 936 / centers 1693**；
**rings 下推深度滑块 936 → 936（滑块完全不参与）**，centers 下 1693 → 0（起作用）。
⇒ 环模式下三个范围滑块**本来就被设计成不参与**（`editor.ts` 的 `rangeMask`：`if (entry.ringPick) return pick`），
那时只能靠重画更小的框来"收缩"、永远"无法扩展"。

**测量方法学（三条必须记住）**

1. **心跳 gap 的归属口径**：按 tick 的**结束时间**归属会漏掉"阻塞压在窗口最后一句"的情况。探针内置**同步阻塞阳性对照**：
   真值 400 ms 时 end 口径读出 **16.5 ms**、120 ms 时读出 **17.3 ms**；而真实数据上 BEFORE 框选按 end 口径读出
   **18.0 / 17.7 / 17.4 / 17.7 ms** —— 正是上一版报告里那个"17.5 ms"的来源（真值 320–340 ms）。
   ⇒ **主口径必须是"gap 与窗口取交集"**，三种独立量法（心跳取交集 / longtask / rAF）在 BEFORE 一致给 309–340 ms、AFTER 一致给 0–34 ms。
2. **分块让出不能用 `scheduler.yield()`**（Chromium 的"推荐"写法）：A/B 实测它把续体排成**比定时器更高优先级**的任务链
   —— 让出了却谁也没插进来，主线程仍阻塞 262.3 / 193.8 ms、rAF 仍 147.1 / 101.9 ms；换 **`MessageChannel`** 后
   35.8 / 30.7 ms（`setTimeout(0)` 32.5 / 32.6 ms 也可）。代码默认 `MessageChannel`，注释里留了这段实测。
3. **硬链接做 dist 快照不安全**：rollup **就地改写**输出文件（同 inode），快照会跟着变成"改后"内容
   （`.ply` 夹具是只读资产，硬链接安全）。冻结构建要用 `git worktree add --detach <hash>` + 重新 build。

**一次事故与它的验证（必须记）**：收尾时用 `Remove-Item -Recurse` 清理 worktree，**顺着 junction 掏空了主仓库
`node_modules`**；`npm ci` 恢复后**用实验证明无影响** —— 重建 `ff80cd3` 得到与恢复前**字节相同**的 `dist/index.js`
（都是 `6AAA9133…`）；遗留一处小警告：postinstall 报 `Patch 1: unexpected MAX_STRIPE_BYTES value, skipping`
（`patches/splat-transform-index.mjs` 是旧版副本、装上去的 `index.mjs` 里已无该符号 ⇒ **该补丁是 no-op**），
导出侧补测 `verify-export-roundtrip` / `verify-viewer-stream`（含逐字节对拍）/ `verify-export-orientation`
在恢复后的依赖上**全部 `failed=0`**。

**验证**：**webgpu 37 套 + webgl2 36 套 `TOTAL FAILED: 0`**；**9 个选择类套件 × 两后端 = 18 次运行全部 `failed=0`**；
`tsc` / `npm run check` 退出码 0；**打包（3.23.7）后 `verify-large-model-ui` 5/5**（见 5.2 末段）。
**已知未覆盖**：20M 上的滑块推杆未重测；退役 Splat 的 worker 槽**内存不释放**（有上限但确实会涨）。

### 5.4 ③ 选择范围只能收缩、无法扩展 —— 深度轴改成"滑块百分比 = 选中质量占比"（3.23.8，第五十三轮，提交 `a4b411f`）

**根因（比"针尖"说法更精确）**：框内 2000 万点的深度只占 AABB 跨度的 **1.25%**
（hit u ∈ [0.4373, 0.4498]），而滑块沿 AABB 线性映射 ⇒ **有用行程只占滑块全长的约 1.2%**：
0→40 只掉 28% 的点，48→50 一步掉 **264 万**点 —— 用户体感就是"拉几次没反应 / 只能收缩"。

**改法（只改"滑块百分比 → 深度窗口"这一层映射，判定逻辑一个字没动）**：
`src/splat/selection-core.ts` 新增 `DepthTravel` / `depthTravelFromBins()` / `quantileFromCdf()` / `depthTravel()`，
用**命中点的深度直方图**（`DEPTH_BINS = 65536`，原来 512 桶下桶宽 32 世界单位、整块密集区只落 **5** 个桶）
建累积占比，滑块百分比直接映射到"质量分位"；**两端与 `tailMap` 逐位同构**
（`TAIL_SHARE=2%` 压进 `TAIL_PERCENT=0.5%` 一个字没改），只把中段换成等分分位，并夹在 `[nearEdge, farEdge]` 保单调。
其余：`selection-range.ts` 导出类型、`selection-worker-client.ts` / `workers/selection-worker.ts` 的 tails 类型、
`editor.ts` 的 `RangeEntry.tails` 随签名调整。

**实测（改前 = 前一提交的构建；两次运行的"全屏选中数"完全相同、与本改动无关的左右轴行逐位相同，作为对照）**

| 深度范围 | 改前占比 | 改后占比 |
| --- | --- | --- |
| 0–100 | 100% | **100%（19,282,378，逐位等于全选）** |
| 10–90 | 93.12% | 77.55% |
| 25–75 | 85.41% | 48.48% |
| 40–60 | 72.25% | 18.96% |
| 48–52 | 13.71% | 4.23% |
| 左右 40–60 | 14,347,710 | **14,347,710（逐位未动）** |

⇒ 中段每单位行程切的质量从 3.4–7.3% 变成 **0.97–0.99%**，两端死区从 0.26% 抬起，**落差 14.4× → 1.02×**；
占据 **72.2%** 点云的那一坨从 **20 个单位行程**变成 **74.5 个单位（×3.7）**；100% 行程单调降到 0。
**拖掉远处噪声更方便（有数字）**：最远拖到 **96**（头 4% 行程）就删掉 **100%** 的远处噪声（最深 5% 的 96.4 万点），
同时 core50 保持 **100%**、core90 保持 **99.5%**；改前要拖到 ~80 才删完、且那一段每单位行程切 3.7% 的质量、很难停准。

**"判定逻辑未动"的硬口径**：①HEAD 版与当前版的 **13 个声明**（`selectRangeCore` / `selectRangeFromCacheCore` /
`createRangeCache` / `RangeProjectionCache` / `CACHE_*` / `keepSurface` / `preMaskCore` / `regionFromSpec` /
`screenWindow` / `viewExtentFrom*` / 入参结构）**去注释后代码哈希全部相同**；②20 万行合成数据
（一半质量铺在 100 单位噪声、一半挤在 0.002 薄面）+ 6 个窗口（含比量化格还窄的）：
逐点路径差异 **0 点**、缓存三块缓冲**逐位相同**、缓存路径差异 **0 点**、FNV 6/6 相同。
⇒ 为此**放弃了"缓存深度改 float32"那一版**（那版细端精确到 0.1%、`50–50.5` = 0.496%，但同 window 会差 ≤半格、
一个边界最多 13.6 万点，与硬口径冲突）。

**已知取舍（三选一，待用户拍板）**：投影缓存仍是 **16 位量化**（格宽 = 深度跨度 / 65535 = 本夹具 **0.175** 世界单位），
**比一格还窄的窗口会被吃掉**（`50–50.5`、±0.1、±0.25 都返回 0；最小能成比例响应的窗口 ≈1 格 ≈ 密集区 **1.4%** 的质量）。
（a）保持现状（本提交；细端有断崖）／（b）缓存改 float32（细端 0.496%，但放弃"逐位相同"，20M 缓存 120 → 160 MB）／
（c）16 位 + 映射层向外吸附到量化格（无断崖，细端地板是 1 格）。

**验证**：8 个选择类套件 × webgpu/webgl2 = **16 次运行 + `verify-selection-depth.cjs`，`failed` 全 0、`exit` 全 0**
（`the depth ends stay reachable` / `first small move 最远·最近` / `扩边严格超集` 都保住；`verify-rings-pick` 仍 936→936）；
webgpu **全量 38 套 `TOTAL FAILED: 0`**；20M 上 `verify-large-model-ui`（①②④⑤）`failed=0`；`npm run check` 退出码 0。
**性能旁证**（20M worker 路径）：`worker.begin 36.5–44.6 / worker.select 732–808 / applyMasks 128–213`、e2e **976–1056 ms**
⇒ 65536 桶直方图 + 256 KB 分位数表**没有可测量的代价**（微基准 512 桶 1.07 ms vs 65536 桶 1.12 ms）。

**残余风险（如实）**：极端集中/离散的深度分布会退化成台阶（平墙类合成模型上 99.5 就整片切掉远墙，但单调且"第一下就有反应"成立）；
两端 2% 压紧段照旧带来固定 **2.4%** 偏移（`10–90` → 77.55% 而非 80%）；命中集 **<20 采样点**时退回线性（20~1000 点未量）；
**20M 的 webgl2 组合未被套件覆盖**（套件跑的是 2000 点小夹具）。

---

## 6. 还没做 / 等用户拍板

1. **P0-3 交互期降级**（降 SH 波段 / 抽稀 / 提高 `alphaClipForward`）：**未开始** —— 上游 SuperSplat 3.3.0 靠
   "运动帧完全不排序 + GPU 投影/排序"做到的流畅度，我们只做了**限流**；剩下的卡帧是每次排序完成那次 ~80 MB
   主线程上传的固有成本。
2. **K 路并行 worker**：把 P0-1 的端到端从 ~1015 ms 压进 ≤600 ms。方案与逐位等价依据在
   `docs/perf/2000万点六项问题-排查发现.md`「P0-1 终值与测量方法学」（要点：按**连续**区间切片；
   `tailFractions` 的采样集是全局 `i = 0, stride, 2*stride…`，必须让每个 worker 从 `ceil(lo_k/stride)*stride` 起步，
   并把三张 512 桶直方图**逐桶相加**；**环模式的 `keepSurface` 是屏幕空间邻域操作，切片救不了 ⇒ rings 必须 K=1**）。
   预估 K=4 时端到端 ≈350–450 ms。**待用户拍板。**
3. **③ 的细端取舍（a/b/c）**：见 5.4 末段。**待用户拍板。**
4. **离群点剔除 / 按密集区裁剪**：这张模型 AABB 被噪声撑到 ×54，是 ③④ 的共同根源。**待用户拍板。**
5. **13M 上去浮云检测的算法级修复**：现在只加了"超过 200 万点不自动跑 + 面板给点数与预估耗时"（实测不冻结，22 ms），
   **检测本身还是 101 秒** —— 计数网格 3061×3059×2562 = 2.4e10 格，永远走 `Map` 回退（邻域查找 27×13M ≈ 3.5 亿次 `Map.get`）。
   要治得换数据结构，或改成"点『计算』才跑 + 给预估耗时"。
6. **load worker 输出不等价**（列字节一致但选区结果不同：开 2000 / 关 213）⇒ 保持 opt-in，**查清前不要打开**；
   worker 本身不删（931k 导入主线程最长冻结确实 1640 → 855 ms）。
7. **审计第 11 条（着色器窗口判定）**：审计给的门槛是 `n > 2400 万`（A3 之后 `> 3200 万`）才启用，
   而 A3 已把上限提到 ≈3200 万 ⇒ 触发条件暂时不存在。真出现 3200 万点以上的模型再看。
8. **闸门在 webgl2 上"无结论"**：量到 0 次 worker 消息 ⇒ 需要另找中间夹具 + 给 `dispatchSort` 打点定论。
9. **撤销时主线程阻塞 220–236 ms**（惰性 `pre` 的代价）：撤销是低频操作，暂时接受；
   要压它就把 `setBits(pre)` 也走分块（或写成 `setBitsFromMask(preMask, State.selected)` 的一趟分块写）。
10. **长期挂着的小尾巴**：球刷 / 球体盒体**要不要接三轴范围**（现在故意不接）；`src/splat/splat.ts` 里约 29 行
    中文注释是乱码（`scripts/dev-history/snippets/timeline-panel_15-28.ts` 另有 4 行）；"点一下等一秒"在 Edge 与打包版
    都测不出；屏幕工具**没有"只选可见表面"选项**；洞模式的像素信号（死胡同）、平面修复面板 / level-2 refine 的死代码、
    我们的 `H`/`Shift+H` 是否等同上游 lock 语义（没核对过）；对比工具的浮云检测器（`src/compare/compare-analysis.ts`）
    仍是旧的四信号实现、未与 `src/splat/floater-removal.ts` 统一；三轴百分比基准不一样（刻意的：深度是"模型沿视轴"，
    左右/上下是"手势框"，面板上没有数字所以用户看不到差异）。

---

## 7. 已知边界与坑（必读）

**方法与口径**

1. **心跳 gap 必须"与窗口取交集"**，否则会出假绿（阳性对照实测：真值 400 ms 读成 16.5 ms）—— 见 5.3 方法学第 1 条。
2. **分块让出不能 `scheduler.yield()`**（会把续体排成比定时器更高优先级）⇒ 用 `MessageChannel` 或 `setTimeout(0)`。
3. **硬链接做 dist 快照不安全**（rollup 就地改写同一 inode）；冻结构建用 `git worktree add --detach` + 重新 build。
4. **合成 PointerEvent 到不了 PlayCanvas gizmo** ⇒ 验证脚本必须用 `page.mouse`。
5. **PCUI 细节**：`new Container({class:'a b'})` 会抛（要 `class.add`）；`SliderInput.value = x` 会触发 `change`；
   BooleanInput 的开关 DOM 是 `.pcui-boolean-input-toggle`（pointerdown + click）。
6. **无头 Edge 的启动竞态**：13M 导入要等 `window.scene` 就绪后 **1.5 s** 再导，否则永远 0 个 splat（页面活着、CPU 几乎 0）；
   探针卡住时**先 curl 服务端** —— `npx serve` 会僵死，重启就好。
7. **CJK / BOM 编码坑**：`Set-Content -Encoding utf8` 会写 **BOM**（`package.json` 带 BOM 后 electron-builder 直接
   `JSON.parse` 失败，同一次往返还把 `author`/`description` 中文烧成乱码）；PowerShell 的 `Get-Content`/`Set-Content`
   往返会把源码注释烧成乱码（`editor.ts`、`splat.ts`、一个探针都中过招）
   ⇒ **仓库里的文件一律用 read / write / edit 工具**，必须用 PowerShell 时用
   `[System.IO.File]::WriteAllText($p, $t, [System.Text.UTF8Encoding]::new($false))` 且写**绝对路径**
   （`[System.IO.File]` 用的是进程当前目录）。
8. **多行中文提交信息必须 `git commit -F <file>`**（PowerShell 的 `-m` 会在引号/括号上炸，踩过 3 次）；
   `git add -A` 会把手下的 WIP 一起扫进提交（踩过，靠 `git reset --soft HEAD~1` + 选择性 add 救回）。
9. **不要对手下的 `node_modules` 做 `Remove-Item -Recurse`**：曾经顺着 junction 掏空整个目录（见 5.3 事故）。

**产品/工具边界**

10. **20M + WebGL2 这个组合从未被套件覆盖**：套件跑的是 2000 点小夹具，无头 WebGL2 加载 4.73 GB 会失败
    ⇒ 所有"20M 单后端"结论都只对 **WebGPU** 成立（③ 的 20M 数据、P0-1 的 20M 数据都是 WebGPU）。
11. **打包前 `dist` 里只能留 `test-model.ply`**：其它 `.ply` 会进 asar（曾把 210 MB 模型打进去 → exe 309 MB；
    4.73 GB 的硬链接会让 electron-builder 报 `file size can not be larger than 4.2GB`）；**`dist\test-20m.ply` 必须删**。
12. **单实例锁**：打包前先 `Stop-Process -Name SplatRoom`。
13. **`@electron/asar` 的深路径需要反斜杠**（Windows 下条目名是 `\dist\...`），否则 "not found"（踩过两次）。
14. **`patches/splat-transform-index.mjs` 现在是 no-op**（postinstall 报 `Patch 1: unexpected MAX_STRIPE_BYTES value, skipping`）；
    导出侧三套套件已复验无影响，别为这个 warning 改依赖。
15. **electron-builder 的依赖收集补丁字符串已过时**（`pmApproaches` 在 26.15.3 里不存在，实测搜不到）⇒ 现在那条命令是 no-op，
    3.23.7 / 3.23.8 两次打包在未打补丁下都成功；真要改的是 `const TRAVERSAL = [await packager.getPackageManager(), node_module_collector_1.PM.TRAVERSAL];`。
16. **`npm ci` 之后 `node_modules\electron\dist` 可能是空的**（打包报 `The specified electronDist does not exist`）—— 见 1.0 第 3 步。
17. **两个"改前/改后"目标线没达到，别在汇报里含糊**：P0-1 端到端 ~1015 ms **未达** ≤600 ms；撤销时阻塞 220–236 ms 是新增代价。
18. **UNPARSED ≠ 失败**：`verify-merge-ui.cjs`（无 `failed` 字段）、`verify-sphere-brush.cjs`（单独 6/6）、
    `verify-edit-grade-crop.cjs`（单独 4/4）是既有输出形状问题。
19. **`verify-webgpu-fallback.cjs` 不能传 url 参数**，否则变成 `?gpu=webgpu?gpu=…` → 假红。
20. **环模式下三个范围滑块本来就不参与**（`rangeMask`: `if (entry.ringPick) return pick`）—— 这是设计语义不是 bug；
    用户报"无法扩展"时要先确认他当时是 `centers` 还是 `rings`。
21. ~~**`docs/V3-WebGPU-现状.md` 里没有第五十三轮那一节**（最新仍是 6.54）~~ —— **已补**：
    `1a3232f` 写入 **6.55**（第五十三轮 ③ 深度行程映射）。③ 的完整叙述另见提交 `a4b411f` 的长信息与本文第 5.4 节。
22. **测量旋转时不要写 `cam.elev`**（2026-09-21 新增，代价很大）：本 fork 的 Camera 只有 **`elevation`**
    （`src/camera/camera.ts:271/275`），写成 `cam.elev` 会传 `undefined` ⇒ 俯仰角 NaN ⇒ **相机矩阵整体 NaN**，
    模型根本没被正常绘制。实测对照（各转 1 秒）：`cam.elev` 下运动检测 **0/60 帧**、控制台 **948 条 NaN/秒**；
    `cam.elevation` 下 **60/60 帧、0 条**。凡是用错的写法量到的"旋转期"帧时间结论都要重测
    （排序**消息数**类结论不受影响：引擎每帧无条件调 `sorter.setCamera`，与相机是否 NaN 无关）。
    已修：`docs/probes/sortrate.cjs`、`docs/probes/perf-probe.cjs`、`docs/probes/gpu-frame-probe.cjs`。
23. **性能测量必须带可见性检查**（同上）：着色器会剔除投影尺寸小于 `minPixelSize`（引擎默认 **2 px**）的高斯，
    所以"点很多但高斯是亚像素"的夹具会**几乎什么都不画**却显示很快的帧时间。实测：亚像素 20M 夹具
    `litPercent` **2.1%** / GPU **2.4 ms**；把高斯调大后 **81%** / GPU **70 ms**。
    `docs/probes/gpu-frame-probe.cjs` 会打印 `litPercent`（口径同 `verify-large-model-ui.cjs`：`max(r,g,b) > 60`），
    **没有它就不要汇报性能数字**。
24. **合成旋转不会请求渲染**（2026-09-21 新增，第三次踩到同类坑）：`cam.setAzimElev(...)` 是**程序化**改相机，
    背后没有指针输入 ⇒ **不会把场景标记为脏** ⇒ 本应用（按需渲染）几乎不出帧。实测：一次 1 秒合成拖动之后
    1.5 秒内 `Splat.onPreRender` 被调用 **0 次**（同一次里 `worker.postMessage` 也是 0），
    于是"停手补帧"之类的**逐帧逻辑根本没有帧可跑**，而探针会把 0 次派发误读成功能坏了。
    ⇒ **所有合成旋转/拖动的探针都必须自己 `scene.forceRender = true`**
    （`gpu-frame-probe.cjs` / `perf-probe.cjs` / A/B 脚本一直如此；`verify-motion-quality.cjs` 漏了、已修）。
    推论：**"程序里转动相机"和"用户真的在拖"不是等价场景** —— 前者要显式请求帧。
25. **`_sortInFlight` / `_pendingCamera` 在引擎里不存在，而且会把排序派发路径"锁死"**（2026-09-21 新增，
    用户报"快速旋转时背面内容跑到前面"的根因）：`Splat.dispatchSort()` 原来用这两个字段做合并，
    但 `grep -r _sortInFlight node_modules/playcanvas` **零命中**。第一次派发把 `ws._sortInFlight = true`
    之后**没有任何代码会清它** ⇒ 之后每次派发都只写进 `_pendingCamera`、**永远不再发 worker 消息**。
    实测（3 秒快转）：`dispatchSort` 调用 **2** 次 / `worker.postMessage` **0** 次 / 完成事件 **0** 次。
    现在改用自家在飞标记（`_sortPendingSince` + `sorter.on('updated')` 清零 + 3 s 超时）与自家待办位姿。
    **教训**：凡是从"引擎某个 patch 字段"推出来的行为，先 `grep` 确认字段真的存在。
26. **范围滑块"只能收缩、不能扩展"曾是结构性的**（2026-09-21 已修）：面板每轴两个方块原来**同时**带动
    core 与 outer 两个窗口（margin 恒为 0），而"选中框外的东西"只能由 core 与 outer 之间的**带**产生
    （`selection-core.ts`：外窗之外直接丢；带内不看形状；core 内由形状判定）⇒ 带永远为空 ⇒ 向框外扩展
    在结构上不可能（实测：屏幕轴向外推 −40/140 → 8506 不变；向内推 40/60 → 174）。
    现在按拖动方向分语义：**背离抓取点 = 只扩 outer**（框外那圈按矩形选中），**朝抓取点 = 收 core + outer**
    （原手感不变）。护栏 `docs/verify/verify-range-expand.cjs`（8 项、真鼠标拖动）：向外 115 → **128**，
    首个向内 20 px 128 → **126**。
27. **排序是"快照"，20M 上快照本身要 ~0.15~0.4 s**（同上，用户报"快速旋转依然错位、短暂停留就消失"）：
    派发频率已经能到 **54–172 ms** 一次，但单次 worker 排序 + 完成时那次 ~80 MB 主线程上传**改不了**
    ⇒ 快速旋转时顺序必然落后。**第六轮**已按"落地时刻外推"补偿（`SORT_PREDICT_*`，见本文 5.x /
    `docs/perf/交互期降级-实现与实测.md` §6.9）：正常拖拽 125°/s 的顺序误差 **0.123 → 0.035（−71.5%）**，
    猛甩 375°/s **0.284 → 0.156（−45.1%）**；猛甩下的残留要靠"运动期不依赖顺序的渲染"或 GPU 排序才能解决。
28. **`sorter.centers` 在主线程是 detached 的**（2026-09-21 新增，代价：一整轮错误结论）：
    `GSplatSorter.init()` 把 centers 的 buffer **transfer** 给了 worker ⇒ 主线程那份 `length === 0`，
    拿它算深度全 NaN。任何"顺序对不对"的度量都必须走 `splat.splatData` 的 x/y/z + 排序表里的**值**
    （值就是 splatData 的原始下标）。踩坑表现：停手（顺序确定正确）也读到 0.19~0.33 的"错误率"。
29. **闸门类逻辑绝不能建立在"对方一定会回包"之上**（2026-09-21 新增，第二次踩同一个坑）：
    引擎的 `sorter.setCamera` **不带 `forceUpdate`**，worker 按自己的 1e-3 门限判定"没动够"就
    `return`（`gsplat-sort-worker.js:44`）—— **不回包**。我们把"有排序在飞"标在这些请求上 ⇒
    完成事件永不到来 ⇒ **3 s 超时之前一次都派发不出去**（实测小夹具快转 1.5 s：post 0 次）。
    现在两条派发路都走自家 `postSort`（同一个 worker 消息 + `forceUpdate: true`）。修完 20M 上实测 λ
    从 372 ms 回到 **155 ms**。**规则**：凡是要等回调/事件的状态机，都要确认"发送方保证会回"。
30. **按需渲染的应用里"停手"这件事需要有人要一帧**（2026-09-21 新增）：`cameraMotion.moving` 是时间戳
    判定，"停了"只能由**下一帧**观察到；用户松手后没有指针事件、没有自然帧 ⇒ `_wasMoving && !moving`
    那段永远不执行（不补停手排序、也没帧消费排序结果）。大模型上被"降级期间出帧到恢复"掩盖，
    **小模型/不降级时暴露**（实测 2000 点：快转结束后 1.2 s 内 post **0** 次）。
    现在：手势期间挂一次性定时器（静默点后要一帧）+ `sortInFlight` 也强制出帧。
31. **同一个 `disp` 换个采样时刻能差 4 倍**（2026-09-21 新增，第八轮）：`timer`（每 200 ms 随机相位，
    = 用户大部分时间看到的**典型帧**）0.120~0.199、`consume`（新顺序上线那一刻，= 每个排序周期里的
    **最优点**）0.046、`reply`（worker 回包）0.032 —— 都是"同一个配置、同一段旋转"。
    **跨文档比较 `disp` 必须同口径**；历史头条数字（0.156/0.284/0.035/0.123）都是 `timer` 口径。
    第七轮我一度把 `consume` 当成"屏幕真相"，那是不准确的（它只是周期起点）。
32. **外推 horizon 要含"回包 → 上线那一帧"的第二段**（2026-09-21 新增）：按需渲染下，worker 回包后要等
    下一帧 `GSplatInstance.update()` 才上传并用于渲染（20M 实测 10~35 ms）。只按 λ（派发→回包）外推会
    **系统性偏早一个帧长**（375°/s 就是 4~13°）。折进 horizon 后实测换向 600 ms 内的错位
    0.296 → **0.174**（375°/s）、0.121 → **0.073**（125°/s），P95 同步下降；**再长的速度窗没有好处**
    （窗 200/300 ms 换向反而涨到 0.259/0.265）。详见 `交互期降级-实现与实测.md` §6.12。
33. **"上传 order 有一帧滞后"会造出成堆的假结论**（2026-09-21 新增，第十轮）：
    `uploadStream.upload` 把 copy 记进当前/下一帧的 command encoder ⇒ **上传一次然后抓图，抓到的可能是
    上一次的内容**。本轮被它坑了三次：(a) "乱序 vs 正确"读成 0.03（其实没换过顺序）；(b) 阈值扫描
    出现 0/111/0/111 的交替（每个变体落后一档）；(c) `ws.orderData.byteLength` 在被 transfer 的时刻是 0，
    用它算 splat 数会得到**空数组上传**。规矩：**上传两次（中间各渲染几帧）+ 连续抓两张确认收敛
    （两张必须相同）+ 一个 all-zeros 顺序对照（证明 order 真的被着色器读）**。
34. **20M fill 合成夹具对"顺序错误"几乎不敏感**（2026-09-21 新增）：它 overdraw 极大、颜色相近 ⇒
    同一姿势下乱序与正确顺序的画面平均色差只有 **4.68/255**；而"两层平板"夹具（
    `docs/probes/gen-layered-splat.cjs`）是 **36.37**。⇒ 凡是要验证"顺序错位"的改动，
    **必须用有深度结构的夹具**，否则会得出"顺序无所谓"的错误结论。
35. **像素级顺序判据在套件宿主里要显式控制基准**（2026-09-21 新增）：套件第一版把"alpha 基准"量在了
    **不透明路径**上（`settled` 那一刻若还欠着补帧/在飞，不透明路径仍生效）⇒ alpha 基准读到 0.05。
    现在 `verify-motion-opaque.cjs` 用 `scene.motionOpaque.enabled` **显式开关两条基准**，并断言
    "基准确实是 alpha 混合（`material.transparent === true`）"。另外 WebGL2 的 order 是 R32U 纹理，
    套件里 `uploadStream.upload(array, texture)` 写不进去（对照恒 0.00）⇒ 像素判据只在 WebGPU 上断言，
    WebGL2 明确记"未测"。
36. **运动期不透明路径是"观感取舍"，默认开着**（2026-09-21 新增）：运动帧不透明 + 深度写 ⇒ 失去半透明
    与软边（20M fill 上覆盖率 71.2% → 64.4%、同姿势与停手画面平均色差 ~13/255），换来
    **顺序无关**（乱序画面差 36.37 → 0）+ 运动期不再排序（P50 32 → **18 ms**、P95 46.1 → **28.9 ms**、
    order 数据 1526 → **76 MB**）。逃生开关 `window.__SPLATROOM_MOTION_OPAQUE__ = false`，
    alpha 下限 `window.__SPLATROOM_MOTION_ALPHA_CLIP__`（默认 0.5）。详见 §6.13。

---

## 8. 和用户配合的方式（很重要）

- **用中文回复**，结论先行，**给实测数字**（他每次都问"具体是多少"）。不要只说"优化了"，
  要说"20px 推杆从删 0 个高斯变成删 2.3%"、"主线程阻塞 320–340 → 30–34 ms"。
- 他的**设计稿是硬要求**（`选择工具\设计.png`、`选择范围设计.png`）：说"严格照这个来"时，
  要逐像素读图（可以用 `docs/probes` 里的图像/几何探针，或 `png.cjs` 解码 + OCR）。
- 他**不回答选择题**（几次问"接下来做哪个"都石沉大海），他直接给新指令。所以：
  **能自己量清楚的就先量再改**，把"我量到了 X、所以改了 Y、你可以试 Z"讲清楚。
- 如果确实要问，请用**纯文本编号问题**（自动弹出的选项卡片在他的界面上不渲染）。
- **他会顶回错误判据**：第五十三轮我给的那条验收线（"48–52 应 ≥40%"）与目标数学互斥，他手下的子代理用算术顶回，
  我接受并作废 —— **遇到"判据与目标互斥"要当场承认并改口径，不要为了凑数字改实现**。
- 每轮收尾的固定动作：**验证（双后端 + 全量批量 + diag + check）→ bump 版本 → 打包 portable exe →
  asar/字面量/9 语言/exe 属性/冒烟复核 → 更新 `docs/V3-WebGPU-现状.md` 新增一节 + `docs/进度存档.md` →
  提交（功能 + 文档/打包两个提交）→ 用中文汇报（含实测表 + 提交号 + 产物路径）**。
- 他自己会用打包版试手感。**交付后给一句"下一步我能做什么/建议做什么"**。

---

## 9. 探针索引（`docs/probes/`，都是 `node xxx.cjs [model] [url]`）

| 探针 | 干什么 |
| --- | --- |
| `track-drift-probe.cjs` | 拖动时"方块中心 vs 指针"的偏差（判断跟手不跟手） |
| `thin-drag-probe.cjs` | 不同厚度下推 22px 各走多少值（判断快慢手感） |
| `jog-probe.cjs` | 3.13.0 推杆：停靠位置、推进曲线、松手归位、行内 digit 数 |
| `xy-probe.cjs` | 左右/上下的推杆响应 + 框内投影分布直方图 |
| `depth-sweep.cjs` / `depth-hist.cjs` | 深度轴逐单位收边删掉多少高斯 / 选中集沿视轴的深度分布 |
| `merged-probe3.cjs` | **用户 13M 场景**的决定性探针：相机稳定性 + 按索引比较"框内投影集 vs 实际选中集" |
| `push-perf.cjs` | 一次推杆从触发到落地的耗时（顺滑与否） |
| `o1-bound-probe.cjs` | bound pass 次数/耗时 + 单杆落地延迟（O1 用） |
| `export-alloc-per-type.cjs` | **给页面挂 typed-array 分配跟踪 + 假 stream**，七种导出各跑一次 ⇒ 回答"哪条导出路径是 O(输出)"（结论：只有查看器，每行 1186 B） |
| `viewer-ab-13m.cjs` | **大模型上的 A/B 台架**：html / zip 各跑"流式 vs 官方 writer" + SOG，量分配合计/单次最大/耗时（`file-handler.ts` 的 `memoryMultiple` 就是它标定的）；导入偶发挂住时页内自动重试 3 次 |
| `histogram-20m.cjs` | 20M 夹具上的直方图专项：`infoMin/infoMax`、有柱的列数、consoleErrors（口径：`node docs/probes/histogram-20m.cjs "http://localhost:3621/?gpu=webgpu" test-20m.ply`） |
| `selection-range-20m.cjs` | **③ 的台架**：逐档深度范围/左右轴在 20M 上的选中数（改前改后对照） |
| `sortrate.cjs` | **P0-2 的口径**：包一层 `worker.postMessage` 数派发、采样帧间隔、检查停手补帧（`… test-20m.ply 4` 表示转 4 秒） |
| `sort-lag.cjs` | **顺序延迟补偿的口径（第六轮）**：`disp` = "生效排序表里的次序"与"按当前相机算出的真实深度次序"的归一化平均秩差（0 = 正确，0.333 = 随机）。`SORT_LAG_DEG_PER_FRAME=6`（猛甩 375°/s，默认）/ `2`（正常拖拽 125°/s）；`SORT_LAG_MODE=baseline\|predict\|both`。**必须先看 `settledDisp` ≈ 0**，否则说明度量本身坏了（例：读 `sorter.centers` 会得到恒 0.19~0.33） |
| `shape-ghost.cjs` | **降级期"选区虚影"的像素级口径（第六轮）**：同一相机位姿下全分辨率 vs 降级各抓一张画布像素，按 16×16 瓦片比较，并与"无形状"对照相减（`boxOverControlWorst`） |
| `sort-cost.cjs` | **"GPU 排序能省多少"的上限口径（第七轮）**：拆开量 worker 排序 / λ / 排队 / 80 MB 上传 / ≥1 MiB 分配 / 含上传帧 vs 不含，并跑一个"零上传反事实"相位（`litPercent` 保证仍在画同一批高斯）。结论见 `交互期降级-实现与实测.md` §6.11 |
| `sort-tune.cjs` | **顺序补偿参数扫描（第八轮）**：三口径 disp（`timer` = 典型帧 / `consume` = 新顺序上线那一刻 / `reply` = 回包），扫速度窗 × 第二步权重 × 额外常数，并单独量"换向 600 ms 内"。参数用 `window.__SPLATROOM_SORT_TUNE__` 运行时注入。用法：`node docs/probes/sort-tune.cjs "<url>" test-20m-fill.ply 6 core 9000 "旧版,双步"`（第 4 参 = 每帧角度，第 5 参 = 配置集 core/all，第 6 参 = 恒速段 ms，第 7 参 = 标签过滤）。结论见 §6.12 |
| `gen-layered-splat.cjs` | **"两层平板"夹具**（第十轮）：前后景深度差大、颜色区分 ⇒ 唯一能测出"顺序错位"的夹具（20M fill 只有 4.68/255，它 36~48）。`--points --size --gap --half --out`。用法：`node docs/probes/gen-layered-splat.cjs --out=../_tmp/synth-layered.ply --points=600000` |
| `motion-opaque.cjs` | **运动期"不依赖顺序"渲染的决定性口径（第十轮）**：同一位姿下比较正确顺序 vs 乱序（Fisher-Yates）vs all-zeros 对照，alpha 混合与不透明路径各一遍；附帧代价 / 运动期派发次数 / order 字节数。规矩：上传两次 + 两次抓图收敛校验（见 HANDOFF 坑 33） |
| `gpu-frame-probe.cjs` | GPU 每帧耗时 + `litPercent` 可见性（没有它就不知道"快"是不是因为没画东西） |
| `sortgate-sim.cjs` | 排序闸门判据的**状态机仿真**（不依赖浏览器） |
| `ring-slider.cjs` / `ring-hide-bar.cjs` / `mode-selection.cjs` | 环模式下的滑块参与度 / 隐藏条 / 模式切换 |
| `depthpass-probe.cjs` / `pickpass-probe.cjs` | 深度 pass / 拾取 pass 的专项 |
| `export-flip.cjs` / `gen-nosh-model.cjs` | 导出朝向核对 / 造"无 SH"夹具 |
| `packaged-range8/11/12.cjs` | **打包版端到端**：CDP 连 `SplatRoom.exe`（`--remote-debugging-port=9222 --remote-allow-origins=*`），用真实鼠标推六个方块，数选中数变化 |
| `check-asar-3120.cjs` | asar 条目数 / 唯一 PLY / 版本字面量 / 打包 CSS 复核 |
| `adaptive-probe.cjs` / `hit-probe.cjs` / `layer-probe.cjs` / `row-geometry2.cjs` | 面板几何 / 命中层级 / 行内布局（历史轮次用） |

一次性探针脚本都放在 `D:\DeepSeek\SplatRoomV2\_tmp`（**不在仓库里**，新机器上不存在）。
