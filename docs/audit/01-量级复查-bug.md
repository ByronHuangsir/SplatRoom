# 第二轮复查：正确性 / bug 类结论的**量级分档**重判（3.21.0，HEAD `26b99f7`）

> **只读复查**：未修改任何源文件、未 build、未跑测试。全部结论以实读代码 + 实读 PLY 头部为准；
> 凡"估算"字样均是由代码常量与循环次数推导，凡"实测"字样均注明来自既有文档（`docs/V3-WebGPU-现状.md` 6.47 等）。
> 第一轮清单见 `00-总结.md` / `selection.md` / `data-and-ops.md` / `perf-scan.md` / `render.md`。

---

## 0. 复查前必须先纠正的两个前提（**本次最重要的发现之一**）

### 0.1 T0 档位写错了：真实夹具是 **2000～3122 点**，不是 10–20 万点

实读 PLY 头部（`Get-Content -TotalCount 20`，只读头部，未解析数据）：

| 文件 | 实测 `element vertex` | 实测大小 | 格式 | 列 |
| --- | --- | --- | --- | --- |
| `dist/test-model.ply` | **2000** | 136 KB | binary_little_endian | 17 列（x/y/z + nx/ny/nz + f_dc_0..2 + opacity + scale_0..2 + rot_0..3） |
| `dist/cluster-test.ply` | **3077** | 0.2 MB | binary_little_endian | 17 列 |
| `dist/floater-test.ply` | **3122** | 0.2 MB | binary_little_endian | 17 列 |
| `dist/floater-scale-test.ply` | **120008** | 7.8 MB | binary_little_endian | 17 列 |
| `_tmp/scan.ply`（T1） | 931720 | 209.7 MB | **binary_little_endian（不是 ASCII）** | 62 列，含 `f_rest_0..47`（**带 SH**） |
| `选择工具\merged-scene.ply`（T2） | 13007105 | 694.7 MB | binary_little_endian | 14 列，**无 SH 列** |

`test-model.ply = 2000 × 17 × 4 B = 136,000 B` 与实测文件大小逐字节吻合，说明 2000 这个数字是可靠的。

**后果**：任务书把 T0 描述成"~10–20 万点"，只有 `floater-scale-test.ply`（12 万）符合；
`test-model / cluster-test / floater-test` 是 **2–3 千点**，比 T0 的上界还小 60 倍。
下面把 T0 拆成 **T0a（2–3 千点）** 与 **T0b（12 万点）**——因为"点数很少才出现的退化分支"
（尾巴采样阈值、单击命中 0 点、密度参考坍缩）全部落在 **T0a**，而 T0b 与 T1 的行为基本同构。

### 0.2 T1/T2 的**列结构**不同，这让 `water-detect` 那条 bug 变成了"格式相关"而不是"量级相关"

- T1 `scan.ply` **有** `f_rest_0..47`（48 个 SH 系数列）→ 列名修对之后，`specular` 分支会**真的开始执行**；
- T2 `merged-scene.ply` **没有** SH 列 → 即使把列名改成 `f_rest_*`，`numSh` 仍然是 0，判据 A **依然恒假**。

所以第 2 条的正确答案不是"改个名就好"，见正文。

### 0.3 分档口径与图例

| 档 | 点数 | 实测依据 |
| --- | --- | --- |
| **T0a** | 2,000–3,122 | `dist/test-model|cluster-test|floater-test.ply` |
| **T0b** | 120,008 | `dist/floater-scale-test.ply` |
| **T1** | 931,720 | `_tmp/scan.ply`；文档实测：推杆 30–43 ms、手势 31–60 ms |
| **T2** | 13,007,105 | `选择工具\merged-scene.ply`；文档实测：导入 ~15 s、手势 774 ms、推杆 556–721 ms |
| **T3** | 30M / 50M | 已知 WebGPU 边界：30M 可渲染（order 114.4 MB < 128 MB）、50M 不可渲染（order 190.7 MB > 128 MB） |

图例：**✗** 结构性不触发 ／ **○** 触发但无感（≤1 帧、或只是观感）／ **●** 触发且可感（单次 >100 ms 或结果可见错误）／ **●●** 触发且严重（秒级冻结、大面积错误结果、或需要手动恢复）

---

## 1. 按量级的总表（13 条）

| # | 结论 | 判据（**只看什么**） | T0a 2–3k | T0b 12万 | T1 93万 | T2 1300万 | T3 30M/50M |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `MultiOp.undo()` 正序撤销（组合撤销不还原原状） | 只看"是否走了 MultiOp 组合路径"，与 N 无关 | ● | ● | ● | ●● | ●● |
| 2 | `water-detect` 读 `getProp('sh')` | 只看**列结构**（有无 SH），与 N 无关 | ✗（无 SH，恒假） | ✗ | ✗（有 SH48，但改列名后仍恒假：列式存储⇒`numSh=1<3`） | ✗（无 SH，改名也没用） | ✗ 逐文件判定 |
| 3 | LOD 代理自带 `state` 快照 + 丢 `transform` 列 | 只看 **N ≥ 900,000 且 `lod.autoEnabled`** | ✗ | ✗（12万 < 90万） | ●（93万 刚好过线，1 级代理） | ●●（2 级代理，删掉的浮云"复活"最刺眼） | ●● |
| 4 | 环模式 `readIds` 返回 `pw×ph` 的 JS 数组 + `Set` | **分辨率（数组/Set）+ N（`has` 循环）双因子** | ○（2k 点 ≈0 ms，但 4K 全屏仍分配 8.29M 元素） | ○ | ● | ●● | ●● |
| 5 | `splat.stateChanged` 上同步跑全套检测（去浮云面板 + heal 面板） | **只看 N**（每次状态变更都跑） | ○ | ○ | ●（0.5 s/次） | ●●（7 s+，且与推杆互相触发） | ●●（16 s+，形同卡死） |
| 6 | load worker 从未启用（解码+莫顿排序全在主线程） | **只看文件大小/点数**（一次导入的固定停顿） | ○ | ○ | ●（210 MB） | ●●（≈15 s 不能动，用户实测） | ●●（数分钟） |
| 7 | 快速填充：102 哨兵已修，但"种子落在背景"与"清屏色被改成不透明"两个入口仍会全选 | 只看**模型是否铺满视口** + 是否手柄截屏过 | ●（2k 点 = 全选也没什么，但语义已错） | ● | ● | ●●（全选 13M，紧接着删除 → 触发第 13 条） | ●● |
| 8 | 环模式滑块：已修成"**完全失效**"（死 UI） | 只看相机模式开关，与 N 无关 | ● | ● | ● | ● | ● |
| 9 | 环模式拾取：`0xffffffff` 哨兵 + 屏幕边缘负 bounds → **静默清空选区** | 看"框内是否一个高斯都没有"（与 N 反向相关）+ 是否 T3 不可渲染 | ●（小模型空框很常见） | ● | ○ | ○ | ●●（不可渲染时每次都清空） |
| 10 | `tailFractions` 的 `counted < 200` 退化：首推滑块无效；顺带 `select.point` 单击命中 0 点 | 只看**框内点数是否 <200**（小框/小模型） | ● | ○ | ○ | ○（大框正常，小框仍会） | ○ |
| 11 | 投影缓存 2400 万上限：**T3 专属**行为变化（每次推杆退回全量重投影） | 只看 **N > 24,000,000** | ✗ | ✗ | ✗ | ✗（13M 只占 54%） | ●●（每次推杆 ~2–3.5 s，看起来"没反应"） |
| 12 | T3 不可渲染（WebGPU 50M）的交互后果：拾取/吸管退化、诊断只在导入后弹一次 | 只看 **N·4 B 是否 > `maxStorageBufferBindingSize`** + 后端 | ✗ | ✗ | ✗ | ✗ | ●● |
| 13 | **新**：全选+删除后 `numSplats = 0` → `localBound = ±1e6` 巨箱 → **整个场景视口被 near 面切空**（WebGL2 无兜底） | 只看"是否把某个模型删空"，与 N 无关；**只看后端** | ●（2 键可复现） | ● | ● | ● | ● |

> 读表要点：**"只看点数"的只有 3、5、6、11**；**"只看分辨率"的是 4 的一半**；
> **"只看开关"的是 3（`lod.autoEnabled`）与 8（相机模式）**；**"只看格式/列"的是 2**；
> **与量级无关但极容易踩的是 1、7、9、13**。

---

## 2. 逐条详述

### 1. `MultiOp.undo()` 正序撤销 —— 在任何量级都是错的

- **位置**：`src/core/edit-ops.ts:588-592`（`undo()` 正序）；调用方 `src/app/editor.ts:1623-1635`（去浮云）、
  `:1489-1531`（分离，`:1516` 组 MultiOp）、`:1790`（愈合）、`core/edit-ops.ts:85-92,130-165,256-280`（三个子算子的 undo 语义）
- **判据**：与点数无关。只看"这次操作是否由 `MultiOp` 组合 + 操作前是否已有选区与掩码相交"。
- **量级相关性**：
  - **是否触发**：四档都触发，且与 N 完全无关（构造上就错）。
  - **严重度随量级**：**随 N 线性放大但不变质**。被"静默丢掉选中位"的行数 = `|操作前选区 ∩ 此次掩码|`，
    T0a 上可能是 0～几个（多半看不见）、T1 上几百～几千、T2 上百万级（用户"选了 A 区→移除浮云→Ctrl+Z"，
    A 区里被判为浮云的那一大片不再属于选区，而这正是他最想复核的点）。**T2/T3 上是"一按就错"**。
  - **只在哪一档出现**：没有专属档位；但 **T0a 上很可能"看起来是对的"**（交集恰好为空或只有几个点），
    所以**小夹具跑验证脚本会漏掉这条**——第一轮的验证建议（"撤销后选区逐位等于操作前"）必须用真实模型跑。
- **证据**（实读）：
  ```ts
  // edit-ops.ts:588-592
  async undo() { for (const op of this.ops) { await op.undo(); } }   // ← 应为逆序
  // edit-ops.ts:63-68  StateOp.undo 是"同一批行上的反向位运算"
  const undoOp = this.op === BitOp.TOGGLE ? BitOp.TOGGLE : this.op === BitOp.SET ? BitOp.CLEAR : BitOp.SET;
  // editor.ts:1623-1635  去浮云 apply = [SelectNoneOp(①CLEAR), SelectOp('add',mask)(②SET), DeleteSelectionOp(③SET deleted)]
  ```
  正序撤销 ⇒ ①的 undo（SET 全量恢复操作前选中集）先跑、②的 undo（CLEAR 掩码行）后跑 → 交集行被清掉。
- **建议**：`undo()` 改逆序（4 行）。**不需要任何量级门槛**。回归用真实 13M 场景（T0a 夹具无法暴露）。
  **状态：未修**（HEAD `26b99f7` 仍是正序）。

### 2. `water-detect` 列名 `sh` —— 不是量级问题，是**格式问题**，且"改名"不是完整修法

- **位置**：`src/geometry/water-detect.ts:76-78`（`sd.getProp('sh')`）、`:126-140`（唯一使用处）、`:149`（合取）
- **判据**：只与**该模型有没有 `f_rest_*` 列**有关。与点数、分辨率、开关全部无关。
- **分档表（按真实文件）**：

  | 档 | 有无 SH | 现状 | 只改名之后 |
  | --- | --- | --- | --- |
  | T0a（三个 17 列夹具） | 无 | 判据 A 恒假 | **仍然恒假**（`numSh = 0`） |
  | T0b（17 列） | 无 | 同上 | **仍然恒假** |
  | T1 `scan.ply` | **有 48 个 `f_rest_*`** | 恒假 | **仍然恒假**（列式存储 ⇒ 单列长度 = N ⇒ `numSh = 1 < 3`）|
  | T2 `merged-scene.ply` | **无** | 恒假 | **仍然恒假**（这就是为什么用户从没报过"水域识别突然变好/变坏"） |
  | T3 | 取决于文件 | — | — |

- **量级相关性**：**触发与量级无关**；**严重度与量级无关**（判据 A 恒假 = 分数里 0.2 权重项恒 0，
  水域识别退化成"幽灵团"）。**唯一与 T1 相关的新事实**：T1 是四档里唯一带 SH 的模型，
  所以"改名"这个建议**在 T1 上会激活第二处 bug**：
  ```ts
  // water-detect.ts:78,126-140
  const numSh = sh ? sh.length / sd.numSplats : 0;     // 把列当成"每高斯交错 numSh 个系数"
  const base = i * numSh;                              // ← 但仓库里的 SH 是**按系数分列**的 Float32Array
  const dc = sh[base + c];                             //    （splat-serialize.ts:247、planar-fix.ts:225 等）
  ```
  按系数分列时 `sh.length === numSplats`，于是 `numSh === 1` → `if (sh && numSh >= 3)` 仍然**恒假**。
  也就是说：**只改列名，判据 A 在 T1 上依然恒假**；要真修必须走 `shBands` + `f_rest_0..N` 的列式读法。
- **建议**：①短期把水域判据里的 `specular` 项去掉、UI 文案改成"仅按颜色/位置判定"（诚实降级）；
  ②要真修：按列读 `f_rest_*` 并重算"非 DC 能量占比"，同时在 `numSh === 0` 时显式记一个
  `details.specularUnavailable` 让面板能说明白。**不需要量级门槛；需要的是"格式门槛"**：
  面板应当在模型没有 SH 时把该权重项灰掉。

### 3. LOD 代理自带 `state` 快照 + 丢 `transform` 列 —— **T0 结构上不可能触发**，T1 刚好过线

- **位置**：`src/lod/lod.ts:21-34`（`vertexColumns` 原样搬运 uchar `state`、只收 Float32Array/uchar ⇒ ushort `transform` 被丢）、
  `src/lod/lod.ts:95-141`（>2M 走行采样 `sampleGsplatData`）、`:218-222`（`planLodFractions`）、
  `src/splat/splat.ts:290-305`（`transform` 列无条件重建为全 0）、`:507-517`（`applyLod`→`replaceData`）、
  `src/lod/editor-lod.ts:24`（`LOD_GENERATE_MIN = 900_000`）、`:31,42-54,107-120`（`autoEnabled` 默认 false，且生成也只在 auto 模式）、
  `src/scene/scene.ts:595-621`（切层；注意 `:609` 有 **1000 ms 冷却**，`:604-607` 在门控关闭时立刻强制回全分辨率
  —— 所以不是第一轮说的"每帧都切"，而是"**每秒最多切一次，且只在浏览态**"）
- **判据**：**只看 `numSplats ≥ 900,000` 且 `lod.autoEnabled === true`**（默认关）。与分辨率无关。
  代理**生效窗口**还要求：无选中、未拖相机、未撤销重做（`editor-lod.ts:57-67`）——即"拉远相机随便看看"那一类操作。
- **分档表**：

  | 档 | 是否生成代理 | 代理级数 | 触发 |
  | --- | --- | --- | --- |
  | T0a 2–3k | ✗（`< 900_000`，`generateForSplat` 第 70 行直接 return） | — | **✗ 永不触发** |
  | T0b 12万 | ✗（同上；`planLodFractions` 也返回 `[]`） | — | **✗ 永不触发** |
  | T1 93.17万 | ✓（刚过线） | `[0.35]` → 1 级（≈32.6万） | ● 开关打开后必然发生：删除过的浮云拉远后重现、代理期间的编辑丢失、splat 级变换回原位 |
  | T2 1300万 | ✓ | `[0.35, 0.10]` → 2 级 | ●● 最刺眼：用户在 13M 场景里主要工作就是"删浮云"，一拉远就被"复活" |
  | T3 30M/50M | ✓ | 2 级（行采样，主线程逐列 gather） | ●● 同上 + 代理本身构建成本大 |

- **量级相关性**：**触发是纯量级门槛（90 万）**，这是本次复查里最干净的一条"只在某一档以上出现"。
  **严重度随量级上升**（代理级数变多 ⇒ 切层更频繁 ⇒ "编辑状态随 LOD 显现/消失"更常见）；
  但**T0 两档完全豁免**，所以任何只用 T0 夹具的验证都证明不了它。
- **只在小模型上出现？** 反了——**只有"小模型"这一侧是安全的**（< 90 万永久豁免），
  这条属于"只在大模型上才有"的一类。
- **建议**：①代理只保留几何列，`state`/`transform` 一律从主数据按"代理行→源行"映射投影
  （`sampleGsplatData` 已有 `step`，存成 `Uint32Array` 或按 step 现算）；
  ②`lod.allowProxy` 再收紧：`state.numDeleted === 0 && 调色板只有恒等项 && 非导出中`。
  **不需要按量级加门槛**（已有 90 万门槛，问题恰恰是这个门槛之上仍然错）。

### 4. 环模式 `readIds` 返回 `pw×ph` 的 JS 数组 + `Set` —— **"分辨率 + 点数"双因子，必须分开算**

- **位置**：`src/scene/picker.ts:150-189`（尤其 `:177-186` 的 `result.push` 与 `:158-165` 的负坐标）、
  `src/app/editor.ts:1161-1167`（`new Set` + O(N) 次 `has`）、`:1152-1172`（`ringPickMask = hit.slice()`）
- **判据（这一段是本条的重点）**：这条 bug 有**两个互相独立的成本**，判据不同：

  | 成本 | 公式 | **只看什么** | T0a 2k | T0b 12万 | T1 93万 | T2 1300万 | T3 30M/50M |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | ① `pick` 数组 + `Set` | `pw×ph` 元素（装箱 JS number） | **只看屏幕分辨率 × 框面积，与点数完全无关** | 1080p 全屏 2.07M 元素(≈16 MB)／**4K 全屏 8.29M 元素(≈66 MB)** + 同规模哈希表 —— 2k 点的模型与 50M 点的模型**分配一模一样大** | 同左 | 同左 | 同左 | 同左 |
  | ② `hit[i] = picked.has(i)` 循环 | N 次哈希查询 | **只看点数** | ~0 ms | ~5–10 ms | ~50–100 ms | **~0.7–1.3 s** | **~1.6–4 s** |
  | ③ `ringPickMask = hit.slice()` | N 字节新分配/手势 | 只看点数 | 可忽略 | 120 KB | 0.9 MB | 13 MB | 30–50 MB |
  | ④ GPU 侧 id pass | 整屏渲染 N 个高斯 | 只看 N（一次全屏 splat 渲染） | ○ | ○ | ● | ● | ●● |

- **量级相关性**：**"只看屏幕分辨率"的是①，"只看点数"的是②③④**。所以：
  - **T0a 上这条 bug 并不是"消失"，而是"只剩内存"**：在 4K 屏上把整屏框一下，`readIds` 照样返回
    8.29M 个 number（≈66 MB）再建 8.29M 条目的 `Set`（数百 MB 瞬时）——**2 千点的模型也能一次性分配几百 MB**，
    只是②的循环因为 N=2000 而瞬间跑完，所以**感觉不到卡**。这正是"点数少 ≠ 成本低"的反例，
    也是任务书要我讲清楚的那一点。
  - **T1 只在 1080p 大框时开始可感**（②100 ms + ①16 MB）；**T2/T3 是秒级 + 数百 MB**，与 6.47 记录的 774 ms 手势叠加。
  - **只在哪一档出现**：真正"只有极大模型 + 极高分辨率同时成立才炸"的组合（最高配 4K + T3）；
    但**①的内存峰值只要求高分辨率**，与模型大小无关。
- **证据**：
  ```ts
  // picker.ts:158-165（无上限、可为负）
  const px = Math.floor(x * rt.width); const py = Math.floor(y * rt.height);
  const pw = Math.max(1, Math.ceil((x + width) * rt.width) - px);
  const ph = Math.max(1, Math.ceil((y + height) * rt.height) - py);
  const texY = this.device.isWebGL2 ? rt.height - py - ph : py;
  // picker.ts:177-186  逐像素 push 进 number[]（无 Uint32Array、无上限、无 stride 守卫）
  // editor.ts:1161-1167
  const picked = new Set<number>(); for (...) picked.add(pick[i]);
  for (let i = 0; i < numSplats; i++) hit[i] = picked.has(i) ? 255 : 0;
  ```
  拾取目标是 `workTarget`（= `targetSize` 全渲染分辨率，`camera.ts:774-781`），所以 `pw×ph` 的上限就是整屏像素。
- **建议**：①`readIds` 增加"就地写入调用方 `Uint8Array` 存在位图"的重载（或返回 `Uint32Array`），
  把 `pick` 折成 `Uint8Array(numSplats)` 存在位图后 `hit[i]` 变成 O(1) 数组读；
  ②给框面积加**显式门槛**（例：`pw*ph > 2M` 时按 stride 抽样或提示"环模式下请框小一点"）——
  **这一条是本次唯一明确建议"按分辨率（而不是按点数）加门槛"的地方**；
  ③过滤 `0xffffffff` 哨兵（见第 9 条）。
  **状态：未修**（HEAD 仍是 `number[]` + `Set`）。
  > 注：`render.md` 第 14 条说 `readIds` 不翻行序"目前只当集合用所以不发作"——**这条在环模式依然成立**
  > （去重成 `Set` 与行序无关），但第 9 条的哨兵过滤一旦补上就要重新审视。

### 5. `splat.stateChanged` 上同步跑全套 O(N) 检测 —— **纯点数相关，T2/T3 会把推杆变成秒级冻结**

- **位置**：`src/ui/floater-panel.ts:267-271`（`selection` + **`splat.stateChanged`** 都触发 `_scheduleDetect`）、
  `:329-332`（滑块 `change`）、`:396-402`（200 ms 防抖）、`:404-472`（**同一 tick 里同步跑 `detectFloaters` + `detectClusters`**）、
  `:477-492`（`_apply` 再全量算一遍 + `Uint8Array(N).reduce()`）；
  `src/ui/heal-panel.ts:197-206,281-304` + `src/core/heal-inpaint.ts:595-604`（**无防抖**的 `getSelectedIndices`）
- **判据**：**只看 N**（每次 `splat.stateChanged` 都要跑一遍全量扫描）。
  "只看是不是开着面板/勾着浮云"是第二层开关：连通簇检测**与勾选无关也照跑**。
- **分档表**：

  | 档 | `detectFloaters` | `detectClusters` | heal 面板 `getSelectedIndices` | 触发/严重度 |
  | --- | --- | --- | --- | --- |
  | T0a 2–3k | <1 ms | <1 ms | <1 ms | ○ 无感 |
  | T0b 12万 | ~60 ms（按 93万 0.5 s 线性外推） | ~50 ms | ~1 ms | ○ 勉强可感 |
  | T1 93万 | **0.5 s（文档实测）** | 0.3–1 s | ~10 ms + 最多 93 万条 JS 数组 | ● 每次停手停 1 s |
  | T2 1300万 | **~7 s（估算）** | **4–10 s（估算）** | **60–150 ms + ~100 MB 瞬时数组（每次推杆）** | ●● 每次推杆/每次滑块停手都是 10 s 级冻结 |
  | T3 30M/50M | ~16 s | 10–25 s | 150–350 ms | ●● 界面形同卡死 |

- **量级相关性**：**触发与严重度都是纯 N 线性**，四档里前两档无感、后两档灾难。
- **本次新增的关键事实（第一轮没点出）**：触发源包含 **`splat.stateChanged`**，
  而 `SelectRangeOp.do()` → `Splat.updateState()` 每次都 `events.fire('splat.stateChanged', this)`（`splat.ts:552`）。
  于是 **"推选区滑块" 与 "去浮云面板重算" 互相触发**：在 T2/T3 上，只要去浮云面板处于启用状态，
  **每一次推杆都会在 200 ms 后追加一次 10 s 级同步冻结**，而且 `_detectTimer` 只防抖、不取消在途计算，
  连续拖动会一次次重排。这与"推杆 556–721 ms"叠加后会让用户认为"软件死了"。
- **建议**：①连通簇**按需算**（展开区块或点一下才算），先砍掉一半成本；
  ②**按 N 加门槛**（这一条强烈建议）：`N > 2,000,000` 时不自动跑，面板显示"点『计算』"并给出预估耗时；
  ③`stateChanged` 监听改成"手势停稳后 300–500 ms 且 N 小于阈值"才跑，或干脆只监听 `selection`（用户主动选）而不监听
  `stateChanged`；④搬进 Worker（`detectFloaters`/`detectClusters` 都是纯函数，只读 x/y/z/opacity/state 列）。

### 6. load worker 从未启用 —— 固定量级的"一次性停顿"，T0 无感、T2 就是那 15 秒

- **位置**：`src/io/load-worker-client.ts:11`（注释说默认开）、`:34-36`（实际要求显式 opt-in）、`:80-91`（额外 `bytes.buffer.slice`）、
  `:144-146`（未启用则走同步 `loadGSplatData`）；`src/workers/lw-probe.ts:102-104,124-125`（假绿探针）；
  `src/workers/load-worker.ts`（死代码）
- **判据**：**只看是否设置了那个全仓无人设置的全局开关**；成本**只看文件大小/点数**（导入一次）。
- **分档表**：

  | 档 | 主线程要干的活 | 触发/严重度 |
  | --- | --- | --- |
  | T0a 2–3k | 17 列 × 2–3k × 4 B ≈ 0.14 MB | ○ 无感 |
  | T0b 12万 | ≈ 8 MB 分配 + 排序 | ○ 无感 |
  | T1 93万 | 62 列 × 93万 ≈ 231 MB 物化 + 莫顿排序 + 行重排 | ● 数秒不能动 |
  | T2 1300万 | 14 列 × 1300万 ≈ **728 MB 分配填充** + 排序 + 行重排 | ●● 与用户实测"导入约 15 s 界面完全不能动"直接对应 |
  | T3 30M/50M | ≈ 1.7–2.9 GB 物化 | ●● 分钟级 + OOM 风险 |

- **量级相关性**：触发只看开关（与 N 无关），**严重度纯 N/字节线性**。T0 上这条完全不可见，
  所以"导入不卡"的小夹具体验**不能**用来判断这条是否修好。
- **只在哪一档出现**：不是"只在某一档"，而是 **T0/T0b 上是"看不出来的 bug"**——这本身就是风险：
  打开开关（把语义反转成 `__SPLATROOM_NO_LOAD_WORKER__ !== true`）后，**只有 T1 以上的文件才能验证**，
  而恰好那条路径的回归证据（`lw-probe`）是假绿的：
  ```ts
  // lw-probe.ts:102-104,124-125
  const wRes = await loadGSplatDataAsync(model, fs, false);
  result.workerResults = (window as any).__LW_WORKER_RESULTS__ || 0;   // ← 只记录，从不校验
  result.ok = result.match.numSplats && Object.values(result.match.cols).every(c => c.same);
  // 开关没开时 loadGSplatDataAsync 直接调 loadGSplatData（同一函数，同一线程）⇒ 两边必然相同 ⇒ ok = true
  ```
- **建议**：先修探针（`if (result.workerResults === 0) throw`），再反转开关，然后在 **T1/T2 真文件**上跑
  （T0 夹具无法证明任何事）。**不需要量级门槛**；但需要"验证必须有量级"的意识。

### 7. 快速填充：102 哨兵已修，但**还有两个入口会全选**（其中一个是手柄截屏留下的清屏色）

- **位置（已修部分，确认正确）**：`src/tools/flood-selection.ts:102-111`（扫掉残留 102，`262031f`）；
  `src/app/editor.ts:1269-1301`（`alpha > 0` 判定与 bbox）
- **位置（残留入口 A：种子落在背景上）**：`flood-selection.ts:76-99`
  ```ts
  const pickedOpacity = data[idx + ALPHA];          // 背景 alpha = 0（清屏色 (0,0,0,0)，camera.ts:785）
  if (Math.abs(data[idx + 3] - pickedOpacity) < threshold * 255) { ...扩散... }
  ```
  → 种子落在**背景**时 `pickedOpacity = 0`，BFS 会把**整片背景**涂成 alpha 255（默认 threshold 0.2 ⇒ 匹配 |a−0|<51）。
  经 `editor.ts:1291` 的 `alpha[my*cw+mx] > 0` 判定，选区 = "所有投影中心落在模型轮廓之外的高斯"，
  且 bbox = **整个画布**（背景连到屏幕四边）⇒ 三个范围滑块的"尾巴"分析也整体失真。
- **位置（残留入口 B：清屏色被改成不透明，未还原）**：`src/gamepad/gamepad-capture.ts:85-86` 设 `clearPass = bgClr`，
  `:112-117` 的 `finally` 只还原了 `scene.camera.camera.clearColor`（**另一个对象**），**没有还原 clearPass**
  （对照 `app/render.ts:557,1017,1344,1633` 四处导出路径都还原成 `nullClr`）。
  默认 `bgClr = {r:0,g:0,b:0,a:1}`（`scene/scene-config.ts:3`）⇒ **一次手柄截屏之后，整个会话内主视图清屏色 alpha = 1**。
  此后快速填充点在任何位置（含模型上）都会匹配 alpha>204 的像素 ⇒ BFS 铺满整屏 ⇒ **选中全部未锁定高斯**。
- **量级相关性**：

  | 档 | 入口 A（点背景，默认透明清屏） | 入口 B（手柄截屏后，不透明清屏） |
  | --- | --- | --- |
  | T0a 2–3k | ● 视口大部分是空的 ⇒ **随手一点必中**，但"全选"只有 2–3k 点，观感是"选区满了" | ●● 同上，仍只是 2–3k 点 |
  | T0b 12万 | ● 同上 | ●● |
  | T1 93万 | ● 模型通常铺满视口，背景点击要先拉远 | ●● 选中 93 万点 |
  | T2 1300万 | ●（同样要先拉远） | ●● 选中 1300 万点 ⇒ 紧接着一个 Delete 就触发**第 13 条** |
  | T3 30M/50M | ● | ●● 且 30M 掩码 + 全量状态上传 |

- **判据**：入口 A 只看"**模型是否铺满视口**"（= 小模型/稀疏模型才容易踩）；
  入口 B 只看"**是否用过手柄截屏**"（与量级、分辨率都无关，且一旦踩到**永久有效**）。
- **量级关系小结**：同一条代码在 T0a 上是"点空白处选区满了"（用户多半会当成工具语义），
  在 T2 上是"选中 1300 万点然后删掉"——**同一 bug 的严重度随量级质变**，这符合任务书里
  "小夹具上无感、T2 上变成一按就错"的那一类。
- **建议**：①`flood-selection` 在 BFS 之前加守卫：种子像素 `pickedOpacity` 落在"背景"（例如 alpha≤1/255 且
  该点没有几何命中）时直接 `return`（不提交选区）；②`gamepad-capture` 的 `finally` 补
  `clearPass.setClearColor(nullClr)`（与 render.ts 四处一致）；③`select.byMask` 在 `empty` 时提前返回
  （`editor.ts:1281` 现在只把框设成 0，仍然提交 —— 套索"点一下"清空选区的老问题也在这里）。
  **不需要量级门槛**；但入口 A 的"背景点击"在小模型上是主要触发路径。

### 8. 环模式滑块：`26b99f7` 修掉了"静默翻转"，但留下了**完全失效的死 UI**

- **位置**：`src/app/editor.ts:1069-1074`（`ringPick ?? ...`）与 `:1171`（`ringPickMask = hit.slice()`）；
  `src/app/editor.ts:1056-1065`（`surfaceWindow` 仍恒返回 `{}`）；`src/ui/selection-depth-bar.ts:147-157`（可见性只看工具）
- **判据**：只看"相机模式是不是环模式"这个开关。与 N、分辨率都无关。
- **现状与严重度**：
  - 修复方向正确：推杆不再用解析穿透掩码覆盖拾取结果（`editor.ts:1070-1072` 的注释就是对第一轮第 1 条的回应）。
  - **新问题**：`ringPost` 的掩码在环模式下**完全等于 `entry.ringPick`**，与三轴滑块的取值无关
    ⇒ **环模式下拖动任何一根范围滑块都没有任何效果**，而 `SelectionDepthBar` 仍然照常显示
    （`selection-depth-bar.ts:149-150` 只按 `TOOLS_WITH_RANGE` 判断可见性，没有订阅 `camera.mode`），
    标题的 `active` 高亮（`:131-137`）**照样会亮**。这是"看起来能用、实际是死 UI"，同类静默失败。
  - 附带成本：`ringPickMask = hit.slice()` 每次手势多分配一份 N 字节（T1 0.9 MB / T2 13 MB / T3 30–50 MB）。
- **量级相关性**：四档一样（都是"滑块无效"）。**唯一随量级变的是**：T2/T3 上用户本来最依赖滑块做"深度收窄"，
  失效的代价更大（13M 场景里"只选表面"后想再按深度裁一刀做不到）。
- **建议**：采纳第一轮 `selection.md` 第 1 条的**最小改法①**：环模式下**隐藏/禁用**三行 range 并给一句 tooltip
  （"环模式：只选可见表面，不使用深度/左右范围"），或走"正确改法"（`pick && window` 取交）。
  **不需要量级门槛**。**状态：修复不完整。**

### 9. 环模式拾取的两个静默失败：`0xffffffff` 哨兵 与 屏幕边缘的负 bounds

- **位置**：`src/scene/picker.ts:18-19`（`idClearColor = (1,1,1,1)` ⇒ 未命中 = `0xffffffff`）、`:150-189`（不夹取 px/py）；
  `src/app/editor.ts:1161-1167`（**不过滤哨兵**）、`:1377-1391`（`select.point` 用 `clickX ± 3` 作为 bounds）
- **判据与分档**：这条**同时踩在 T0a 和 T3 两端**，中间两档几乎不触发 —— 是本轮"只在某档出现"的典型：

  | 档 | 触发路径 | 后果 | 严重度 |
  | --- | --- | --- | --- |
  | T0a 2–3k | ① 框/点在空白处（2–3k 点铺在整屏上，**框住 0 个高斯极常见**）；② `select.point` 在屏幕左/上 3 px 内 | `picked = {0xffffffff}` → `hit` 全 0 → `post` 为空；`set`/`intersect` 模式下**选区被静默清空**（`add`/`remove` 是无操作），无任何提示 | ● |
  | T0b 12万 | 同上（概率略低） | 同上 | ● |
  | T1 93万 | 需要拉远到看不见模型才可能框空 | 同上 | ○ |
  | T2 1300万 | 几乎不可能（模型铺满视口） | — | ○ |
  | T3（WebGPU 50M 不可渲染） | **id pass 根本画不出东西 ⇒ 每次环模式框选都返回 `{0xffffffff}`** | `set` 模式每次框选都清空选区；`.colorMatch`（`editor.ts:1416-1422`）遇到 `0xffffffff` 直接 `continue` ⇒ 吸管**完全无反应**；两者都没有任何提示 | ●● |

- **量级相关性**：
  - **与点数反向相关**（点越少越容易框到空处）；
  - **与"是否可渲染"强相关**（T3 的 WebGPU 边界会让这条从"偶发"变成"必然"）；
  - **与分辨率/指针位置相关**（`select.point` 的 -3 px 越界，任何档位都可能踩，且 T3 上 `rt.height - py - ph` 越界更可能抛错）。
- **证据**：
  ```ts
  // editor.ts:1161-1167 —— pick 里含哨兵时没有任何过滤
  const picked = new Set<number>(); for (let i = 0; i < pick.length; i++) picked.add(pick[i]);
  for (let i = 0; i < numSplats; i++) hit[i] = picked.has(i) ? 255 : 0;
  // editor.ts:1389 —— 未夹取的 bounds（clickX/Y 夹了，±slack 没有）
  { x0: clickX - slack, y0: clickY - slack, x1: clickX + slack, y1: clickY + slack }
  // picker.ts:159-165 —— px/py 可为负，texY 随之越界
  ```
  `post = combine(preMask, false)`（`editor.ts:1024-1029,1077`）⇒ `set`：空；`intersect`：空。`SelectRangeOp.do()`
  会先 `clearBits(pre)` 与 `clearBits(applied)` 再 `setBits(post)`（`edit-ops.ts:227-236`）⇒ 选区确实被清空。
- **建议**：①`readIds` 入口夹取 `px/py/pw/ph` 并**过滤 `0xffffffff`**；②环模式拾取结果为空时**不要提交**（保持原选区）
  并给一句提示；③`select.point` 的 bounds 夹到 `[0, width/height]`。**不需要量级门槛**。

### 10. `tailFractions` 的 `counted < 200` 退化 —— "首推无效"的真正原因，只在**框很小**时出现

- **位置**：`src/splat/selection-range.ts:206`（`stride = max(1, floor(N/400000))`）、`:228-248`（`counted` 累加与
  `if (counted < 200) return empty;`）、`:91-106`（`tailMap` 在 `tails = null` 时退化成纯线性）；
  配合 `editor.ts:1115-1127`（用 `tails` 建 view）
- **判据**：**只看"框内投影命中的点数是否 < 200"**。所以它同时由 N 与框面积决定：
  - N ≤ 40 万时 **stride = 1**（不采样）⇒ `counted` = 框内真实点数；
  - N > 40 万时 stride > 1 ⇒ `counted ≈ 框内真实点数 / stride`。
- **分档表**：

  | 档 | 整屏框 | 中等框（~10% 屏） | 小框（约 100×100 px） | `select.point`（7×7 px） |
  | --- | --- | --- | --- | --- |
  | T0a 2–3k | counted≈N ≈ 2000 ⇒ **有** tails | counted ≈ 200 ⇒ 边界 | counted ≈ 10 ⇒ **无 tails** | counted 常为 **0** ⇒ 无 tails，且 post 常为空 ⇒ `set` 清空选区 |
  | T0b 12万 | 有 | 有 | counted ≈ 1200 ⇒ 有 | counted ≈ 60 ⇒ **无 tails** |
  | T1 93万 | 有（stride 2） | 有 | counted ≈ 465/2 ≈ 230 ⇒ 边界 | ~30 ⇒ **无 tails** |
  | T2 1300万 | 有（stride 32，采样 40.6 万） | 有 | 采样后 ~90 ⇒ **无 tails** | ~10 ⇒ **无 tails** |
  | T3 30M/50M | 有（stride 75/125，采样上限 40 万） | 有 | **无 tails** | **无 tails** |

- **量级相关性**：**"小框"这一侧四档都触发**（不是 T0 专属），但 **T0a 的整屏框恰好也接近阈值**，
  所以 T0a 上"有时有反应、有时没有"的概率最高；T2/T3 的大框不会退化。
- **用户可见后果**：`tails = null` ⇒ 深度/左右/上下按**整个包围盒**线性映射（`rangeDistances`，`:256-268`），
  于是"第一次推杆一个点都删不掉"的老毛病回来了（`selection-range.ts:68-81` 的注释描述的正是这个现象）。
  这与第一轮文档里"第一下推杆恒 ~2%"的验证用例直接冲突 —— **该用例只在整屏框下成立**。
- **建议**：①把阈值从"绝对 200"改成"**相对**"：`counted < 200` 时若 `counted >= 20` 也照常算 tails
  （512 桶下 20 个样本足够定位首次非空桶；桶里只有个位数时按"最少 1 个点"取边界即可）；
  ②或对小框改用"框内点的实际深度范围"而不是采样直方图（小框本来点数就少，直接精确 min/max 更便宜）；
  ③`select.point` 的 7×7 框建议加"命中 0 点时保持原选区"的守卫（与第 9 条同源）。
  **建议按"框内点数"而不是按"N"加门槛**。
- **本次新增**（第一轮未列）：`selection-range.ts:245-247` 这个退化分支与 `select.point` 的小框叠加，
  是"点一下反而把选区清空"的第二条成因（第一条是第 9 条的哨兵）。

### 11. 投影缓存 2400 万上限 —— **T3 专属**，把"推杆"从交互降级成"批处理"

- **位置**：`src/splat/selection-range.ts:284-294`（`CACHE_MAX_SPLATS = 24_000_000`，超限返回 `null`）、
  `src/app/editor.ts:1069-1074`（`entry.cache ? selectRangeFromCache : selectRange`）、`:1139-1140`（手势期建缓存）
- **判据**：**只看 `numSplats > 24,000,000`**。与分辨率、开关无关。
- **分档表**：

  | 档 | 缓存 | 每次推杆的成本 | 触发/严重度 |
  | --- | --- | --- | --- |
  | T0a/T0b | 8 B/点（≤1 MB） | 只比较 | ✗（本来就不需要） |
  | T1 93万 | 7.5 MB | 文档实测 30–43 ms | ✗ |
  | T2 1300万 | 104 MB 常驻（+ 新手势瞬时翻倍） | 文档实测 556–721 ms | ✗（占阈值 54%，**离悬崖只差 1.8 倍**） |
  | T3 30M | **null** | 全量重投影 ≈ **1.8–2.5 s/次**（按 13M 840–1016 ms 线性外推） | ●● |
  | T3 50M | **null** | ≈ **3–4 s/次** | ●● |

- **量级相关性**：**这是纯量级悬崖**（24,000,000 是硬阈值），而且是个**不连续**的行为变化：
  超过阈值后"内存下降（不再有 192 MB 缓存）但延迟暴涨 40–70 倍"。
- **交互后果（第一轮没写清的部分）**：`pumpRange`（`editor.ts:1206-1226`）会丢弃中间值、且
  `await scene.commandQueue.enqueue(() => entry.op.do())`（`:1220`）占着全局命令队列 ⇒
  在 T3 上拖滑块的表现是"**拖动期间毫无反应，松手 2–4 秒后一次跳变**"，
  并且这 2–4 秒里框选、其它编辑、GPU 回读全部排队（**看起来像死机，而不是像慢**）。
  好的一面：**缓存的缺失不影响正确性**（两条路径的窗口/深度判定完全一致，见 `:352-447` 与 `:454-509`），
  唯一差别是 `dist`/`sx` 来自手势时刻——但那与 `entry.view` 同源，自洽。
- **只在哪一档出现**：**T3 专属**。T2（用户的真实场景）**没有**触发，这是本次复查的一个"排雷"结论：
  不要因为 T3 的问题去改 24M 阈值而影响 T2。
- **建议**：①`createRangeCache` 返回 `null` 时**面板给出显式反馈**（禁用三轴或提示"此模型过大，范围重切不可实时"），
  不要让用户以为滑块坏了；②缓存降到 4–6 B/点（`dist` 用 16 位相对量化）可把阈值抬到 ~40M；
  ③**不要为此改 T2 的行为**（这是"按量级加门槛"的正确用法：门槛已经存在，缺的是**超过门槛时的提示**）。

### 12. T3"不可渲染"（WebGPU 50M）的交互后果：诊断只在导入后弹一次，而各工具继续"静默给错结果"

- **位置**：`src/core/render-diagnostics.ts:65-113`（`orderBufferMB = N*4` vs `maxStorageBufferBindingSize` / `maxBufferSize`）、
  `src/app/file-handler.ts:277-303`（**导入后 4 s 弹一次**错误弹窗，之后再不提示）、
  `src/app/editor.ts:1153-1172`（环模式拾取）、`:1416-1422`（吸管）、`src/tools/flood-selection.ts:71-99`（`render.offscreen`）
- **判据**：**只看 `N × 4 B` 是否超过后端 `maxStorageBufferBindingSize`（默认 128 MB）**，且**只看是不是 WebGPU**。
  30M ⇒ 114.4 MB（可通过）；50M ⇒ 190.7 MB（不可渲染）。WebGL2 用 order *纹理*，不受这条限制。
- **分档表**：

  | 档 | WebGPU | WebGL2 |
  | --- | --- | --- |
  | T0a/T0b/T1/T2 | 可渲染，正常 | 正常 |
  | T3 30M | 可渲染（勉强，余量 13.6 MB） | 正常 |
  | T3 50M | **不可渲染**：`instancingCount = 0`，弹窗报"NOT renderable"，视口空白 | 正常（order 走纹理，受 8192 纹理上限约束而非 128 MB 绑定上限） |

- **交互后果（本次新增，按代码推演；像素级表现未实测）**：
  1. **纯 CPU 路径继续工作**：`select.rect` / lasso / polygon / brush / `select.point`（中心模式）都走
     `selectRange` 的 CPU 投影（`selection-range.ts:385-439`），**与可渲染性无关**，所以"框选还能用"——
     这会让用户以为模型只是"显示不出来"，实际工具语义已经分叉。
  2. **GPU 路径静默退化**：① 环模式拾取（`pickPrep`→id pass 画不出东西）⇒ 每次框选清空选区（第 9 条）；
     ② 吸管 `select.colorMatch` 恒 `continue` ⇒ 无反应；③ 快速填充的 `render.offscreen` 返回**全透明**画面
     ⇒ 种子 alpha = 0、整屏匹配 ⇒ 掩码铺满 ⇒ `contains` 恒真 ⇒ **"选中全部朝前的高斯"**（在 50M 上是几千万点，
     随即是掩码 + 全量状态上传 + recount，又是一次秒级~十秒级冻结）。
  3. **提示只有一次**：`reportIfNotRenderable` 只在导入流程里弹一次（`:277-289`），
     之后用户重启后端、重新加载都不会再解释"为什么工具都怪怪的"。
- **建议**：①`renderDiagnostics.ok === false` 时在状态栏/面板常驻一条警示，并在环模式工具上禁用拾取类工具；
  ②环模式拾取结果为空时保持原选区（与第 9 条同一处改动即可覆盖 T0a 与 T3 两端）；
  ③导入时若 `N*4 > 128 MB` 就直接建议切 WebGL2 或提示"建议先做区域裁剪/合并导出"。
  **门槛已经存在（就是 `limits`），缺的是"不可渲染时的工具降级策略"。**

### 13. **新**：全选 + 删除（`numSplats → 0`）把包围盒变成 ±1e6 巨箱，**整个场景的视口被 near 面切空**（WebGL2）

- **位置**：`src/shaders/bound-shader.ts:24-27,41-44,66-80`（**所有**高斯都被跳过时 `visibleMin` 停在 `1e6`、
  `visibleMax` 停在 `-1e6`）、`src/data-processor/calc-bound.ts:246-262`（读数被 `isFinite` 接收 ⇒
  `setMinMax(1e6, -1e6)` ⇒ `center = 0, halfExtents = -1e6`）、
  `src/splat/splat.ts:1067-1098`（`isUsableBound` **只看 `|h|` 之和是否 > 1e-8，不看符号**，
  而且这个兜底只在 `isWebGPU` 分支里）、`src/camera/camera.ts:906-921`（`near = far/16384` 当 `dist < boundRadius`）、
  `:691-695`（`onBoundChanged` 保持"距离×sceneRadius"不变，所以相机**不会飞走**，但 near 会）
- **触发路径**：Ctrl+A（`shortcut-manager.ts:34` → `editor.ts:771-775` → `SelectAllOp`）+ Delete
  （`editor.ts:1468-1479` → `DeleteSelectionOp`）⇒ `updateState(State.deleted)`（`splat.ts:545-548`）
  ⇒ `updateSorting()` ⇒ **`updateLocalBounds()`（`splat.ts:596`）** ⇒ 上面那条链。
  同类可达路径：裁剪框把全部点裁掉（crop 用 deleted 位）、去浮云的掩码覆盖全部点后删除。
- **为什么这是"错"**（可算术验证）：
  - `halfExtents = -1e6`（负号），`scene.bound` 的并集（`scene.ts:493-505`）仍是 ±1e6 量级；
  - `camera.fitClippingPlanes`：`boundRadius ≈ 1.732e6`，`dist`（相机到原点）通常是个位数
    ⇒ `dist < boundRadius` ⇒ `far = dist + 1.732e6`，**`near = far/16384 ≈ 105.7`**；
  - ⇒ **任何距相机 < 105.7 单位的几何全部被近裁剪面切掉**。模型（几单位~几十单位）与**同场景的其它完好模型**
    （`scene.bound` 是全体并集）全部消失；`near` 每帧重算（`camera.ts:893`），所以怎么缩放都救不回来，
    只有 Ctrl+Z 撤销那次删除才能恢复。
- **分档表**：

  | 档 | 触发（Ctrl+A→Delete） | 症状 | 严重度 |
  | --- | --- | --- | --- |
  | T0a 2–3k | 2 个按键，瞬时 | 视口全空（含其它模型） | ● 但**最容易复现**（夹具小、随手就删空） |
  | T0b 12万 | 同上 | 同上 | ● |
  | T1 93万 | 同上（删除本身 ~百 ms） | 同上 | ● |
  | T2 1300万 | 同上（删除本身秒级，且要先熬过"全选"的掩码/上传） | 同上 | ● |
  | T3 30M/50M | 同上 | 同上 | ● |

- **量级相关性**：**触发与量级无关**，四档全触发；**真正决定"炸不炸"的是后端**：
  WebGPU 下 calcBound 的回读"返回全零"（`splat.ts:1070-1082` 的注释），此时 `isUsableBound` 为假 ⇒
  回退到构造期的 CPU AABB ⇒ **WebGPU 反而没事**；**WebGL2（也就是默认后端）没有这个兜底，直接中招**。
- **只在哪一档出现**：不属于任何单档，但它是**"点数为 0"这个退化分支**的唯一实质后果，
  第一轮完全漏掉（`data-and-ops.md` 只写了"`isUsableBound` 的 WebGPU 兜底"这一侧）。
- **建议**：①`isUsableBound` 补上"`halfExtents` 三个分量都必须为正"（一行）；
  ②`calc-bound.ts` 在 `v3 > v4`（无有效点）时**保留上一次的 bound** 并置一个 `emptyBound` 标志，
  而不是写入 `1e6/-1e6`；③`camera.fitClippingPlanes` 加 `near = max(near, far/4096)` 与
  "`far > 0 && near < far`" 的自证伪守卫（顺带把 `render.md` 第 11 条的 `far/16384` 深度精度问题一起收口）。
  **不需要量级门槛**；需要的是"退化输入守卫"。

---

## 3. 已复核但**不单列**的条目（避免凑数）

| 条目 | 复核结论 | 量级关系 |
| --- | --- | --- |
| `SplatsTransformOp.undo()` palette 未命中静默写 0（`edit-ops.ts:346-396`） | 确认存在；触发条件是"do 与 undo 之间选中集变化"，与 N 无关 | 受影响行数随 N 放大，但**性质不随量级变**；与第 1 条同源（MultiOp 组合里最容易踩），建议与第 1 条一起修 |
| `SplatState.flush()` 全量上传 + `recount`（`splat-state.ts:109-121`） | 确认；`dirtyLo/Hi` 只当布尔用 | 纯 O(N)/O(字节)：T0 无感、T1 13–30 ms、T2 每次推杆 13 MB 上传、T3 30–50 MB。属"量级放大器"而非独立 bug |
| 环模式下仍白跑整条解析路径（`editor.ts:1110-1140`） | 确认（`tailFractions` + `selectRange` + 104 MB 缓存建好后被拾取结果覆盖） | 成本 ∝ N：T0 无感、T1 ~30 ms、T2 ~300–400 ms + 104 MB、T3 >1 s + 缓存为 `null` 时白跑 |
| `Splat.destroy()` 不销毁 `stateTexture`/`transformTexture`（`splat.ts:463-469`） | 确认（`replaceData` 里销毁了，常规路径没有） | VRAM ∝ N（T2 ≈39 MB/次）；与量级线性，不改变行为 |
| 对比工具 `estimateCellSize` 尺度错 226×、掩码 52 MB/帧（`compare-analysis.ts:302,436-458,240-254`） | 确认，但**属独立子应用**，不受本次 T0–T3 分档影响 | 只随点数增长内存（52 MB@13M），判据错误与量级无关；不进本次清单 |
| `surface-worker-client` 741 MB 回退副本、导出两遍过滤 + 104 MB 映射表 | 确认；均为**内存/停顿预算**问题，不是"按量级翻转"的语义 bug | T0 完全无感、T2 触顶（741 MB 副本）；属 A2 类优化 |

---

## 4. 结论摘要（按"该先修哪个"排序）

1. **与量级无关、四档全错、改起来只要几行**：第 1 条（`MultiOp.undo` 逆序）、
   第 13 条（`isUsableBound` 符号 + 无有效点时不写 1e6）、第 9 条（拾取哨兵/空结果不提交 + 负 bounds 夹取）、
   第 7 条入口 B（`gamepad-capture` 还原 clearPass）、第 2 条（水域判据诚实降级，别只改名）。
2. **只在大模型上才要命（必须按量级给门槛/提示）**：第 5 条（`stateChanged` 上的 10 s 级同步检测，
   建议 `N > 2M` 不自动算）、第 6 条（load worker，先修假绿探针）、第 11 条（>24M 缓存悬崖，
   **要加的是"超限提示"，不是改 T2 行为**）、第 3 条（LOD 代理，已有 90 万门槛但门槛之上仍错）、第 12 条（T3 不可渲染的工具降级）。
3. **只在某一端出现、第一轮漏掉的**：第 13 条（**全删 ⇒ bound ±1e6 ⇒ 整场景被 near 切空**，WebGL2 专属）、
   第 9 条（**T0a 空框 / T3 不可渲染**两端都会静默清空选区）、第 10 条（`counted < 200` ⇒ 小框首推无效；
   T0a 整屏框也贴着阈值）、第 7 条入口 A（**背景种子**：小模型才容易踩，T2 上后果质变）、
   第 4 条（**`pw×ph` 只看分辨率**：2 千点的模型在 4K 上分配与 50M 模型一样多的内存）、
   第 3 条（**T0 两档永久豁免**，所以小夹具验证必然漏报）。
