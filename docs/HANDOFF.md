# SplatRoom V3 —— 新会话交接说明（HANDOFF）

> 这份文档是给**一个全新会话**（换 API KEY 后，没有本次对话记忆）看的：读完它 + `docs/进度存档.md`
> + `docs/V3-WebGPU-现状.md` 第 6.36–6.47 节，就能无缝接着做。
> 最后更新：3.16.0（第四十四轮）。

---

## 0. 三十秒版

| 项 | 值 |
| --- | --- |
| 代码库 | `D:\DeepSeek\SplatRoomV2\SplatRoomV3-0` |
| 当前版本 | **3.16.0** |
| 产物 | `release\SplatRoom-3.16.0.exe`（122 MB，portable，已签名） |
| 最新提交 | `53a9cc8`（功能）、`c1fd81c`（上一轮存档）；工作树干净 |
| 技术栈 | PlayCanvas 2.21.3 / PCUI 6.1.4 / TS 6.0.3 / Rollup / Electron 43.4.0 / electron-builder 26.15.3 / i18next（9 语言，**685 个扁平键**） |
| 一直在改的东西 | 「选区范围」面板（最近/最远、左/右、上/下 三个轴，六个方块）—— 3.9.0 起连续 11 轮都在磨它 |
| 最近一轮做了什么 | 用户的 13M 点场景上：新框选不再被旧范围裁、推杆不再重新投影（手势 2003→774ms、推杆 840-1016→556-721ms）、尾巴压紧变成无条件 |
| 下一步建议 | 把窗口判定搬进着色器（13M 点上一次推杆还有 ~600ms 天花板）；详见第 6 节 |

**用户是谁**：一个 3D 高斯泼溅（splat）摄影师/开发者，用中文沟通。他自己有测试模型，会反复推敲界面
手感，要求"严格照设计稿"并给出可量化的验证。**他是唯一的验收人**。

---

## 1. 环境（必须照抄的路径与命令）

```
仓库            D:\DeepSeek\SplatRoomV2\SplatRoomV3-0        （git 仓库，master）
用户的测试场景   D:\DeepSeek\SplatRoomV2\选择工具\merged-scene.ply   （13,007,105 点 / 695MB / binary PLY）
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

### 1.1 打包（每次交付都要走完，顺序不能变）

```powershell
cd D:\DeepSeek\SplatRoomV2\SplatRoomV3-0
# 1) dist 里只能留 test-model.ply（其它 .ply 会进 asar：曾经把 210MB 模型打进去 → exe 309MB）
Get-ChildItem dist\*.ply | Where-Object { $_.Name -ne 'test-model.ply' } | ForEach-Object { Move-Item $_.FullName "D:\DeepSeek\SplatRoomV2\_tmp\ply-backup\$($_.Name)" -Force }
# 2) electron-builder 在本机会卡在依赖收集，临时把 pmApproaches 改成 TRAVERSAL（改前 .bak）
node -e "const fs=require('fs');const p='node_modules/app-builder-lib/out/util/appFileCopier.js';let s=fs.readFileSync(p,'utf8');const b='const pmApproaches = [await packager.getPackageManager(), node_module_collector_1.PM.TRAVERSAL];';const a='const pmApproaches = [node_module_collector_1.PM.TRAVERSAL];';if(s.includes(b)){if(!fs.existsSync(p+'.bak'))fs.copyFileSync(p,p+'.bak');fs.writeFileSync(p,s.replace(b,a),'utf8');console.log('patched');}"
# 3) 单实例锁：先杀干净，再打包
Get-Process -Name SplatRoom -ErrorAction SilentlyContinue | Stop-Process -Force
npm run build
npx electron-builder --win portable --config.npmRebuild=false
# 4) 还原补丁
node -e "const fs=require('fs');const p='node_modules/app-builder-lib/out/util/appFileCopier.js';if(fs.existsSync(p+'.bak')){fs.copyFileSync(p+'.bak',p);fs.unlinkSync(p+'.bak');console.log('restored');}"
# 5) 冒烟：4 个进程 → 杀干净后 0
Start-Process release\SplatRoom-3.16.0.exe; Start-Sleep 22; (Get-Process SplatRoom -ErrorAction SilentlyContinue | Measure-Object).Count
Get-Process SplatRoom -ErrorAction SilentlyContinue | Stop-Process -Force
```

**打包后必查**：asar 5293 条、唯一 PLY = `dist\test-model.ply`、8 个 wasm、版本字面量对、
9 语言各 685 键、exe 属性中文正常 —— 一条命令：`node docs/probes/check-asar-3120.cjs`（改一下路径即可）。

---

## 2. 怎么跑验证

### 2.1 全量（32 套 + diag）

```powershell
npx serve dist -p 3621      # 后台起静态服务（另开一个窗口/后台任务）
npm run check               # typecheck + eslint + 语言键 + audit，退出码 0 才算过
npm run verify:diag         # 7 项渲染诊断，期望 "all 7 checks passed"
# 32 套批量（下面这段就是我在用的）
$url = "http://localhost:3621/?gpu=webgpu"
$suites = Get-ChildItem docs\verify\verify-*.cjs -Name | Where-Object { $_ -notlike "verify-measure-online*" -and $_ -ne "verify-blackscreen.cjs" -and $_ -ne "verify-large-model-backend.cjs" -and $_ -ne "verify-webgpu-fallback.cjs" }
foreach ($s in $suites) {
  $r = node "docs\verify\$s" $url 2>&1 | Out-String
  if ($r -match '"failed":\s*(\d+)') { "{0,-44} failed={1}" -f $s, [int]$Matches[1] } else { "{0,-44} UNPARSED" -f $s }
}
```

### 2.2 四个"特例"套件（必须用各自的方式跑）

| 套件 | 怎么跑 | 说明 |
| --- | --- | --- |
| `verify-large-model-backend.cjs` | `node docs/verify/verify-large-model-backend.cjs big-model.ply webgpu http://localhost:3621/` | 先把 `_tmp\scan.ply` 拷成 `dist\big-model.ply`，跑完**立刻删**（否则打包会带上） |
| `verify-webgpu-fallback.cjs` | **不要传 url 参数**：`node docs/verify/verify-webgpu-fallback.cjs` | 它自己拼 `?gpu=…`；传了 url 会变成 `…?gpu=webgpu?gpu=…` → 假红 |
| `verify-merge-ui.cjs` | `node docs/verify/verify-merge-ui.cjs` | 纯诊断（打印一份报告 + `pageerrors`），没有 `failed` 字段 —— 批量脚本会显示 UNPARSED，看 `pageerrors: []` 即可 |
| `verify-blackscreen.cjs` / `verify-measure-online*.cjs` | 默认打线上部署地址，不属于批量 | 只在需要时手动跑 |

### 2.3 双后端

关键套件（`verify-selection-depth-bar.cjs`、`verify-selection-range.cjs`）都要再跑一遍
`"http://localhost:3621/?gpu=webgl2"`，两边都得 `failed: 0`。

---

## 3. 项目结构（改动集中在这些文件）

```
src/ui/range-slider.ts          一行（一个轴）：轨道 + 两个方块 + 推杆手感  ← 这 11 轮的主战场
src/ui/selection-depth-bar.ts   三行面板（最近/最远、左/右、上/下）+ 标题 + 重置；只喂值、不管手感
src/ui/scss/select-toolbar.scss 面板样式（方块、轨道、选中带、面板尺寸）
src/core/selection-flags.ts     三轴的四值状态 + localStorage + MIN_THICKNESS + normalize/merge 链式约束
src/splat/selection-range.ts    选区几何：深度范围、屏幕窗口、尾巴分析、投影缓存、selectRange 掩码
src/app/editor.ts               手势（rect/lasso/polygon/brush/flood）→ 选区；范围实时重切（pump）；投影缓存接线
docs/verify/*.cjs               验证套件（36 个，其中 32 个进批量）
docs/probes/*.cjs               我这轮用的探针（测量方法都写在文件头注释里，见第 8 节）
docs/V3-WebGPU-现状.md          每一轮一节（最新 6.47），"为什么这么改 + 实测数字"
docs/进度存档.md                交接页：当前产物 / 这一轮做了什么 / 待办 / 常用命令
static/locales/*.json           9 语言，685 个扁平键（改文案要 9 个一起改，跑 npm run lint:locales）
```

---

## 4. 这一轮迭代的完整上下文（3.9.0 → 3.16.0）

用户从"选择工具的选区范围面板"开始，连续 11 轮打磨**同一个控件**。下面每轮都写了"用户原话 → 我怎么改
→ 关键实测"，**包括被否掉的方向**（避免重走）。

| 版本 | 用户原话（要点） | 改法 | 关键实测 |
| --- | --- | --- | --- |
| 3.9.0 | 要"扩边 / 收边" | 每轴两柄变四柄（内柄=边界、外柄=扩边） | — |
| 3.9.1 | 上下左右不顺滑、轨道×2、外扩只要微调 | 轨道 220→440；拖动保留抓取偏移 | — |
| 3.9.2 | 给设计稿 `----o 近 o-------o 远 o----`："差太多了，严格照这个来" | 轴标签进轨道、四柄分开画、**去掉所有数字框** | 行内 0 个数字框 |
| 3.10.0 | 面板×2、滑块改长方形字放里面、**调节要非线性**（靠中心慢而准、远离快） | 方块滑块（字在块里）+ 三次映射 `value=50+100·s·(β+(1-β)s²)`，β=0.35 | 同 20px 拖动：中心 +3.2、端点 +19.0（5.9×） |
| 3.11.0 | **"拖动滑块时滑块本身不用变化，只需要在尺度上做线性变化……给两个滑块中间留够操作的空间"** | 方块恒 25px、窗口内线性、两块之间恒定 126px（=轨道/3.5） | 厚度 40/2/0.5/0.2/0.1 → 间距都是 126px、每 0.1 需 0.3/6/22/44/66px |
| 3.12.0 | **"这个操作很麻烦，而且不直观，我不需要让人看到那个非线性变化的尺度，只需要简单移动滑块"** | 拖动期间整张映射表冻结（1:1 跟手）+ 到边平移换 reach + `MIN_THICKNESS=0.1` | 8 步×22px 增量 `10,10,10,10,10,8.8,5.6,4.3` → `10×8`（max/min **1.000**）；偏差 12px → **0.0px** |
| 3.13.0 | **`----■------------■----` 只要两个带字的滑块、不要任何数值；两个滑块固定位置、松手自动归位；越近越精确越远越快** | **推杆（jog）**：两块钉在轨道 20%/80%、拖动是相对推杆、松手归位、行内 0 数字化 | 同一次推杆：0→20px 走 0.5、200→220px 走 2.5（**5.0×**）；块宽恒 25px、选区带恒 264px |
| 3.14.0 | **"我需要在首次滑动滑块就能看到选区范围的变化，尤其是最远的那个"** | 深度轴**压紧两端空尾巴**（`TAIL_SHARE=2%` 压进 `TAIL_PERCENT=0.5%`） | 最远 100→98 删 **0** 个高斯 → 20px 推杆删 **2.3%** |
| 3.15.0 | **"排查下，上下左右好像没什么反应"** | 同一套压紧用到**手势框的空边距**（`screenTailFractions` → 后来合并进 `tailFractions`） | 六条轴推 20px 全删 **2.0–2.3%**（改前 0.05–1.1%） |
| 3.16.0 | **merged-scene.ply：①框住塔只选到一半 ②上下左右有时有反应有时没有 ③"还是有一些不顺滑"** | ①新框选**复位范围** ②投影缓存 ③尾巴压紧去掉退化守卫 + 两个分析合并成一次采样扫描 | 13M 点：手势 2003→**774ms**、推杆 840–1016→**556–721ms**；框内 99.9% 照选 |

### 4.1 现在的最终形态（别改错方向）

- **面板**：三个轴，每轴一条 440px 轨道 + **两个带字方块**（最近/最远、左/右、上/下），
  方块**永远停在轨道 20% / 80%**，中间 264px 是选区带；**行内没有任何数字**（没有数字框、没有读数）。
- **手感**：按住方块推 → 值按下式变，**松手方块自动归位**（值留着）：
  `offset(dx) = sign(dx)·0.02·(|dx| + dx²/80)`（dx 单位 px）→ 近处能抠 0.1，推远很快。
- **映射**：0..100 经 `tailMap` 映射到"内容区"，两端各占 2% 的稀疏段压进行程 0.5%；
  **0/100 仍然对应两端**（没有东西够不着，"默认整段穿透"语义不变）；扩边（-50/150）走线性外推。
- **一次新框选 = 从整段穿透开始**；范围随后由滑块微调，只属于这一次选择。
- **性能**：投影结果按手势缓存（`RangeProjectionCache`，8 字节/点，>2400 万点自动关），
  推杆只比较窗口/深度/形状。

### 4.2 被否掉的方向（不要再提）

- ❌ 自适应窗口在**拖动过程中实时缩放**（"非线性变化的尺度"）—— 用户明确说"麻烦、不直观"。
- ❌ 滑块沿轨道走（哪怕 1:1 跟手）—— 用户要的是**钉死位置 + 推杆**。
- ❌ 任何数字显示（数字框、拖动时浮出读数）—— 设计稿里就没有。
- ❌ 外柄（扩边细柄）画在面板上 —— 面板只要两个方块（语义保留在 API / 选择逻辑里）。
- ⚠️ 范围"跨手势保留"（3.9.x 的老行为）已被 3.16.0 改成"新框选复位"，理由是它让用户"框塔只选到一半"。

---

## 5. 关键机制与踩过的坑

1. **尾巴压紧**（`tailFractions` + `tailMap`）：按手势内高斯的**实际分布**（一次 ≤40 万点采样扫描，
   512 桶）找出两端各占 `TAIL_SHARE=2%` 的边界，压进行程的 `TAIL_PERCENT=0.5%`。
   深度轴沿视轴统计，左右/上下按投影后的屏幕坐标统计。
2. **`tailMap` 绝不能夹取 0..100** —— 夹了扩边（-50/150）就扩不出去（当时 `verify-selection-range`
   的"扩边必须严格超集 101→367"当场变红）。
3. **轴统计必须套模型变换**（`selectRange` 是先 local→world 再算深度/投影的）。忘了套 → 每个高斯都
   落到直方图外 → `counted=0` → **静默退回线性映射**，表现是"改完一点变化都没有"（查了很久）。
4. **`RangeProjectionCache`**：投影在手势那一次的全扫里顺手写好（`selectRange(..., cache)`），
   之后 `selectRangeFromCache` 只做比较。**缓存失效**靠"任何别的编辑都会清掉 `rangeGesture`"这条现有规则。
5. **`MIN_THICKNESS = 0.1`**：芯不许压到 0 厚（两块完全重叠后只有上面那个点得到、也拖不开）。
   在 `range-slider.commit()` 和 `selection-flags.normalize()` 两处都要兜；边界上（low 被夹到 150）
   要先试"顶高端"，顶不动再"收低端"。
6. **CSS 优先级坑**：`.select-range-handle { pointer-events: none }` 排在 `.select-range-handle-outer`
   之后、同优先级 → 外柄点不到（`elementFromPoint` 命中的是方块）。修法是让外柄选择器带两个类。
7. **PowerShell 会把 CJK 源码写坏**（`Get-Content`/`Set-Content` 往返）—— 改中文文件请用编辑工具，
   或者 `[System.IO.File]::WriteAllText($p, $t, [System.Text.UTF8Encoding]::new($false))`；
   另外 `[System.IO.File]` 用的是**进程当前目录**，相对路径会落到别处，必须写绝对路径。
8. **asar 深路径**：`asar.extractFile(src,'dist/static/locales/zh-CN.json')` 会报 "not found"
   （Windows 下条目带反斜杠）→ 用 `listPackage()` 里的原始条目名，或 `extractAll` 到临时目录再读。
9. **打包前 dist 只能留 `test-model.ply`**：曾经把 210MB 的验证模型打进去，exe 从 122MB 变成 309MB。
10. **PlayCanvas gizmo / 真实鼠标**：合成 PointerEvent 到不了 gizmo，验证脚本必须用 `page.mouse`。
11. **PCUI 细节**：`new Container({class:'a b'})` 会抛（要 `class.add`）；`SliderInput.value = x` 会触发
    `change`；BooleanInput 的开关 DOM 是 `.pcui-boolean-input-toggle`（pointerdown+click）。
12. **`npm run check` 含语言键校验**：文案改动要 9 个 locale 同步（现在 685 键），否则 lint:locales 红。

---

## 6. 待办（按我建议的顺序）

1. **【最优先】把窗口判定搬进着色器**：13M 点上一次推杆还有 ~600ms，瓶颈已经不在投影，而在
   `IndexRanges`（掩码→索引区间）+ 状态位回写 + 上传，三步都是 O(n) 的 JS。用户明确说
   "还是有一些不顺滑"，我问过"要不要下一轮直接做着色器那版"，**等他拍板**。
   设计思路：overlay/状态着色器里直接按（深度窗口 + 屏幕窗口）判定，CPU 只做最终落库；
   93 万点上目前是 30–43ms（顺滑），所以也可以先只对超大模型启用。
2. **球刷 / 球体盒体要不要也接这三轴范围？**（长期挂着，用户没答）现在**故意不接**：球刷有自己的
   大小/厚度滑块，整段穿透会顺手选中整间屋子后面的东西。球体/盒体本身是三维体，尺寸由 gizmo 改。
3. **对比工具的浮云检测器**（`src/compare/compare-analysis.ts`）仍是旧的四信号实现、自带一份
   `estimateCellSize`，没跟 `src/splat/floater-removal.ts` 的共享检测器统一（分享过两次，等用户决定）。
4. **`src/splat/splat.ts` 里约 29 行中文注释是乱码**（更早的 PowerShell 往返留下的；`editor.ts` 同源的
   10 行已在 3.7.9 修好）。代码没问题，但注释读不通，需要按语义重写；另有 4 行在
   `scripts/dev-history/snippets/timeline-panel_15-28.ts`（低优先）。
5. **"点一下等一秒"**：Edge（WebGPU/WebGL2）与打包版都测不出，已在 3.7.6–3.8.0 把回读批量化、
   spinner 延迟化。若再出现，建议在应用内加"上一次操作耗时"读数来定位。
6. **小尾巴**：洞模式的像素信号（死胡同）、平面修复面板 / level-2 refine 的死代码、我们的 `H`/`Shift+H`
   是否等同上游 lock 语义（没核对过）。
7. **屏幕工具没有"只选可见表面"选项**（去掉 id 拾取之后）—— 现在只有厚度近似。想找回来要单独设计。
8. **三轴百分比基准不一样**（刻意的）：深度是"模型沿视轴的深度范围"，左右/上下是"手势框"的范围。
   面板上没有数字，所以用户看不到这个差异；如果哪天他觉得混，可以统一成手势框。

---

## 7. 和用户配合的方式（很重要）

- **用中文回复**，结论先行，**给实测数字**（他每次都问"具体是多少"）。不要只说"优化了"，
  要说"20px 推杆从删 0 个高斯变成删 2.3%"。
- 他的**设计稿是硬要求**（`选择工具\设计.png`、`选择范围设计.png`）：说"严格照这个来"时，
  要逐像素读图（可以用 `docs/probes` 里的图像/几何探针，或 `png.cjs` 解码 + OCR）。
- 他**不回答选择题**（我几次问"接下来做哪个"都石沉大海），他直接给新指令。所以：
  **能自己量清楚的就先量再改**，把"我量到了 X、所以改了 Y、你可以试 Z"讲清楚。
- 如果确实要问，请用**纯文本编号问题**（自动弹出的选项卡片在他的界面上不渲染）。
- 每轮收尾的固定动作：**验证（双后端 + 全量 32 套 + diag + check）→ 打包 portable exe →
  asar/冒烟复核 → 更新 `docs/V3-WebGPU-现状.md` 新增一节 + `docs/进度存档.md` → 提交（功能 + 存档两个提交）
  → 用中文汇报（含实测表 + 提交号 + 产物路径）**。
- 他自己会用打包版试手感。**交付后给一句"下一步我能做什么/建议做什么"**。

---

## 8. 探针索引（`docs/probes/`，都是 `node xxx.cjs [model] [url]`）

| 探针 | 干什么 |
| --- | --- |
| `track-drift-probe.cjs` | 拖动时"方块中心 vs 指针"的偏差（判断跟手不跟手） |
| `thin-drag-probe.cjs` | 不同厚度下推 22px 各走多少值（判断快慢手感） |
| `jog-probe.cjs` | 3.13.0 推杆：停靠位置、推进曲线、松手归位、行内 digit 数 |
| `xy-probe.cjs` | 左右/上下的推杆响应 + 框内投影分布直方图 |
| `depth-sweep.cjs` | 深度轴逐单位收边删掉多少高斯（找"空尾巴 / 断崖"） |
| `depth-hist.cjs` | 选中集沿视轴的深度分布（40 桶 ASCII 直方图） |
| `merged-probe3.cjs` | **用户 13M 场景**的决定性探针：相机稳定性 + 按索引比较"框内投影集 vs 实际选中集" |
| `push-perf.cjs` | 一次推杆从触发到落地的耗时（"顺滑"与否） |
| `adaptive-probe.cjs` / `hit-probe.cjs` / `layer-probe.cjs` / `row-geometry2.cjs` | 面板几何 / 命中层级 / 行内布局（历史轮次用） |
| `packaged-range8/11/12.cjs` | **打包版端到端**：CDP 连 `SplatRoom.exe`，用真实鼠标推六个方块，数选中数变化 |
| `check-asar-3120.cjs` | asar 条目数 / 唯一 PLY / 版本字面量 / 打包 CSS 复核 |

打包版探针的用法：`node docs/probes/packaged-range12.cjs`（默认打
`release\win-unpacked\SplatRoom.exe`，模型走 `http://127.0.0.1:3999/scan.ply`，用 `_tmp\scan.ply`）。
