# SplatRoom V3 性能热点与资源浪费横向扫描

> **只读审计**（未修改任何源文件、未 build、未跑测试）。版本 3.21.0，PlayCanvas 2.21.3，WebGL2 + WebGPU 双后端。
> 方法：`grep` 级横向排查 329 个 TS 文件（约 6.6 万行），对每个候选点再回溯调用链确认它是否真的在热路径上
> （每高斯 / 每次手势 / 每次推杆 / 每帧 / 每次导入）。
>
> **量级估算的假设**（下文所有 ms 都按这三条推算，可核对）：
> 1. 一个 JIT 优化过的 typed-array 紧凑循环（几次读取 + 分支）≈ **2–5 ns/迭代** → 每 100 万点 ≈ **2–5 ms**，1300 万点 ≈ **30–65 ms**；
> 2. 一次"每索引一个闭包调用"的遍历 ≈ **4–8 ns/迭代**（比内联循环贵 1.5–2×）→ 1300 万点 ≈ **60–110 ms**；
> 3. 一次同步 GPU 回读（`immediate: true`，走 `clientWaitSync` 轮询）在 GPU 队列空闲时 ≈ 5–30 ms，
>    队列忙时更久；`waitForGpuDrain()` 是**让出一个动画帧**（60 fps = 16.7 ms，10 fps = 100 ms）。

## 0. 已读的既有结论（本次**不**重复计入清单）

| 出处 | 已知结论 |
| --- | --- |
| `docs/V3-WebGPU-现状.md` 6.47 | 推杆瓶颈＝掩码→索引区间 + 状态位回写 + 上传（三步 O(n) JS）；投影缓存 8 B/点、>2400 万点关闭；13M 手势 2003→774 ms、推杆 840–1016→556–721 ms；93 万点推杆 30–43 ms |
| 同上 6.33 | `picker.readDepths` 从按 64 px 分块改成"一次性读并集"（150.8→76.1 ms）；spinner 延迟 200 ms 出现；单击仍是 59–135 ms 同步等待 |
| 同上 6.20 | PiP 私有排序从比较器排序换成 4096 桶桶排序（5M 点 2.2 s → 桶排序） |
| 同上 6.34 / 6.36 | 屏幕选择改成 CPU 侧窗口/深度判定，**故意**不要 GPU 深度回读（避免"点一下等一秒"） |
| `compare-analysis.ts:1137-1141` | 格子 ×3×3 循环里的 `getImageData`（最多 82,944 次/刷新）**已修**成整块读一次 |
| `HANDOFF.md` 第 6 节 | 待办第 1 条＝"把窗口判定搬进着色器"，等用户拍板 |

本次新增的是**上面没提过的**热点，以及把已知瓶颈拆成可分别动手的几笔账。

---

## 一、最值得做的 5 个优化

| # | 改什么 | 预期提速 | 风险 | 只对超大模型？ |
| --- | --- | --- | --- | --- |
| **O1** | 选区变更**不再跑 GPU 包围盒 pass**（含让出一帧 + 4 次同步回读） | 93 万点推杆 30–43 ms → **10–15 ms（2–3×）**；13M 每次省"≥1 帧 + 4 次回读"（低帧率时 20–200 ms） | 中低 | **否**，两个尺寸都受益，小模型上占比更大 |
| **O2** | 一条推杆链路里 **4 趟 1300 万全扫合并成 1 趟**，并去掉中间掩码 | 13M 推杆 556–721 ms → **200–300 ms** | 中 | 收益 ∝ n，13M 上才是必需 |
| **O3** | `IndexRanges` 与 `SplatState` **去掉"每索引一次闭包"** | 13M 每次推杆省 **80–150 ms**；手势省 30–60 ms | 低 | 否（93 万省 5–10 ms） |
| **O4** | 拖动中**不 recount、不全量上传**（降频到松手） | 13M 每次推杆省 **20–40 ms**，上传量降两个数量级 | 低–中 | 13M 明显；93 万只 1–3 ms |
| **O5** | 每帧强制 worker 排序改成**按排序耗时自适应节流** | 大模型/合并场景相机拖动 **~3 fps → ~10–30 fps** | 中 | **是**（排序耗时 ∝ n） |

---

### O1 —— 选区变更不该触发 GPU 包围盒 pass（本次最"便宜"的大头）

**现状链**：`edit-ops.ts:60`（`StateOp.do()`）→ `splat.ts:536 updateState()` → `splat.ts:545`
"`changedState & State.deleted`？否则 `updateLocalBounds()`" → `splat.ts:1068 calcBound()`
→ `calc-bound.ts:173` 画一个全屏 quad（遍历全部高斯的归约 pass）
→ `calc-bound.ts:182 waitForGpuDrain()`（`gpu-readback.ts:26`，**Promise.race(rAF, 500 ms)**）
→ `calc-bound.ts:187-208` **4 次 `texture.read(..., immediate: true)`**（WebGL2 = 4 次 `readPixels` +
`clientWaitSync` 轮询；WebGPU = 4 次强制提交并等待）。

于是**每一次选区变化**——包括**每一次推杆**（`edit-ops.ts:235` 走的就是 `State.selected` 分支）——
都要白等一个动画帧 + 4 次同步 GPU 回读。

**为什么这是纯浪费**（已核对，不是猜的）：

- 归约着色器（`shaders/bound-shader.ts:39-73`）里：**visible** 界只跳过 `state & 4`（deleted），
  **selected** 界只在 `state == 1` 时累加 ⇒ **改 selected 位完全不影响 visible 界**；
- `selectionBoundStorage` 全仓只有一个读点：`splat.ts:1302` `getPivot(..., selection=true)`，
  而它的唯一调用方是 `splat/splats-transform-handler.ts:71`（选中集变换手柄激活时）。
  也就是说：**选区变化后没人马上要这个值**。

**改法**（两档，建议都做）：

1. `Splat.updateState()` 只在 `changedState & (State.deleted)` 或数据被替换时才调 `updateLocalBounds()`；
   纯 `State.selected` 变更只 `flush()` + 发事件；
2. `selectionBoundStorage` 改**惰性**：置一个 `selectionBoundDirty`，在 `getPivot(selection=true)` 里
   若脏则同步取一次（或在变换手柄被 push 时预取一次）——一次性代价，不是每次推杆；
3. 更好的一档：`selectRange` / `selectRangeFromCache` 本来就有一趟 13M 全扫，
   **在同一趟里顺手累加选中点的 AABB**（代价几乎为 0），彻底不需要 GPU 回读。

**量级**：93 万点上推杆实测 30–43 ms，其中"让出一帧 16.7 ms + 4 次回读 5–15 ms"就是 **~22–32 ms**。
**风险**：中低。要注意 `selectionBound` 变脏后的所有读点（目前只有 1 个）；
`localBound` 语义不变（still 由 deleted 位决定）。**回滚容易**：只改 `updateState` 的一个条件。

---

### O2 —— 一条推杆链路 = 4 趟 1300 万全扫 + 13 MB 掩码 + 13 MB 上传

**现状**（每次 `pumpRange` 迭代，13,007,105 点，单模型）：

| # | 位置 | 干什么 | 量级 |
| --- | --- | --- | --- |
| 1 | `selection-range.ts:462` | `new Uint8Array(numSplats)`（**13.0 MB** 清零）+ 13M 次窗口/深度比较，`contains` 还是闭包调用（`:498`） | 分配 3–10 ms + 遍历 30–65 ms |
| 2 | `editor.ts:1072` `IndexRanges.fromPredicate` | 13M 次**闭包**调用（`preMask[i]!==0` + `mask[i]===255`） | 60–110 ms |
| 3 | `edit-ops.ts:229-233` | `clearBits(pre)` + `clearBits(applied)` + `setBits(post)` = **3 趟 ranges 遍历，每索引一次闭包**（`splat-state.ts:52/64/76`） | 3 × 60–110 ms（取决于选中占比） |
| 4 | `splat-state.ts:115-118` | `flush()`：`gpu.lock()` + `buffer.set(13 MB)` + `unlock()` + `recount()` 全扫 13M | 上传 5–15 ms + 扫描 15–30 ms |
| 5 | 同 O1 | `calcBound`：让出一帧 + 4 次回读 | ≥16.7 ms（帧越慢越久） |

合计正好落在实测的 556–721 ms 区间。

**改法**：把 1+2 合成**一趟**：遍历索引时不写掩码，直接
①判深度/窗口/形状 → ②按 pre/opKind 决定该点的最终 selected 位 → ③写 `state.data[i]` →
④把连续命中段 emit 成 ranges（双缓冲 `Uint32Array`，不用 JS `number[]`）；
顺手在 ④ 里累加选中 AABB（顺带解决 O1 的第 3 档）。
`SelectRangeOp` 的语义（先清 `pre` 与上一次 `applied`、再种 `post`）可以保留，
但**清/种都改成对 `IndexRanges.data` 的内联遍历**（见 O3），或干脆改成"写一遍最终位图"。

**量级**：13M 每条推杆从 4 趟遍历 + 1 次 13 MB 分配 → **1 趟遍历 + 1 次复用缓冲**，
预期 556–721 ms → **200–300 ms**；93 万点从 30–43 ms → ~12–20 ms。
**风险**：中——`preMask`/`applied` 的语义边界（收窄范围时必须清掉上一版）有历史 bug 记录
（`edit-ops.ts:200-203`），改的时候要保住那两条测试语义（`verify-selection-range.cjs`）。

---

### O3 —— 去掉"每索引一次闭包"（改动小、风险最低、收益立竿见影）

三处同源问题，都是"闭包调用次数 = 高斯个数"：

| 位置 | 形态 | 每次操作的闭包调用数（13M） |
| --- | --- | --- |
| `core/index-ranges.ts:47-64` | `fromPredicate(total, pred: (i)=>boolean)`，内部 `ranges.push()` 到 JS `number[]` | 手势 2×13M（pre + post，`editor.ts:1164-1165`）、推杆 1×13M（`editor.ts:1072`） |
| `splat/splat-state.ts:52 / 64 / 76` | `ranges.forEach((i) => { data[i] \|= mask; ... })` | 每次 op 1–3×13M |
| `core/edit-ops.ts:139` | `sortedPredicate(this.sel)` / `(i)=>this.sel[i]===255` 再包一层 `fromPredicate` 闭包 | 双层闭包（去浮云/簇过滤路径） |

`fromPredicate` 还有第二个问题：`ranges` 是普通 `number[]`，元素里塞了 `0x80000000 | start`
（`index-ranges.ts:9`）⇒ V8 会退化成 **PACKED_DOUBLE_ELEMENTS**（8 B/元素）；碎片化选区最多产生
n 个条目 → **最多 100+ MB 的临时数组**，再 `new Uint32Array(ranges)` 拷一遍（`:63`）。

**改法**：`IndexRanges.fromPredicate` 加一个"调用方自己产出 ranges"的入口（或接受一个可复用的
scratch 数组 + 首选 `Uint32Array` 输出）；`SplatState.setBits/clearBits/toggleBits` 内联遍历
`ranges.data`（两种形态：`data[r] & SINGLE_BIT` = 单点，否则 `[start,count]`），不要 `forEach` 闭包。

**量级**：13M 上省 **80–150 ms/次推杆**、手势省 30–60 ms；93 万点省 5–10 ms。
**风险**：低（纯内部 API，`IndexRanges` 已经暴露 `readonly data`，语义不变）。

---

### O4 —— `recount()` 与全量状态上传按拖拽节奏降频

`splat-state.ts:87-105 recount()`：每次 flush 都从头扫 `data.length` 个字节数 selected/locked/deleted；
`splat-state.ts:115-118 flush()`：`buffer.set(this.data)` **整块**上传（13M 点 ≈ 13 MB，注释里已自认
"sub-rect upload is a worthwhile future optimisation"）。

**改法（按风险从低到高）**：
1. 拖动中只做位写入 + 上传，`recount()` 延到 `pointerup`/手势结束（计数只喂状态栏、数据面板、heal 面板）；
2. 计数改**增量**：`setBits/clearBits` 已经知道 ranges 与 mask，可以直接 ±count（toggle 要先读原值，
   也在同一趟遍历里顺手读到）；
3. 上传走子区间（若引擎的 `texture.lock()/unlock()` 支持 sub-rect，否则先做 1+2）。

**量级**：13M 每次推杆省 20–40 ms；连续拖动 10 Hz 时上传量从 **13 MB/次 × 10 = 130 MB/s + 13M 扫描 × 10**
降到几十 MB/s。93 万上只省 1–3 ms。**风险**：低（第 1 档）/ 中（第 2 档的 toggle 语义）。

---

### O5 —— 每帧强制 worker 排序改成"按排序耗时自适应节流"

**现状**：两处**逐帧**强制派发排序（绕过引擎 1e-3 的 epsilon，用 1e-12）：

- `splat/splat.ts:759-787`（主视图，非合并路径）
- `scene/scene.ts:701-724`（合并组 / group-renderer 激活时，`mergedInst.sorter`）

只要相机动了（位移或方向 > 1e-12），就 `postMessage({ ..., forceUpdate: true })`。
仓库自己的注释给出了代价：**`render.ts:1488-1498` 写着"14M 点一次排序 ~300 ms"**，
所以合并场景里相机一拖就是"每帧派发一次 300 ms 的排序"（`_sortInFlight` coalesce 保证不排队，
但管线被排序占满 ⇒ **~3 fps** 的手感）。同时每帧还新建 `_pendingCamera` 对象字面量。

**改法**：把 epsilon 从常数改成**自适应阈值**——记录上一次排序的实际耗时，
在"耗时 × k（k≈1，即下一帧不可能用得上新结果）"的时间窗内不再派发；
停手后**必须**补一次最终姿态（现有的 `_pendingCamera` 正好就是这个语义，只要保证收尾触发）。

**量级**：13M / 合并组相机拖动 fps **~3 → ~10–30**（排序从"每帧"变"每秒 3–10 次"）；
93 万点一次排序约 20 ms，节流收益不大 ⇒ **建议只对大模型开启**（可按 `numSplats` 阈值切）。
**风险**：中——当初去掉帧节流正是为了修"近小远大 / 排序冻结"（`splat.ts:739-745` 有记录），
所以**"最后一次姿态一定要被排到"这条保证不能丢**，否则回归。

---

## 二、横向清单（17 条）

> 严重度：**严重** = 直接决定"顺不顺滑"的大头；**高** = 单次操作里 O(n) 且常数大；**中** = 明显但可忍；
> **低** = 长尾/累积。频率栏写的是真实触发点（已回溯调用链）。

| # | 严重度 | 位置 | 频率 | 量级 | 建议 |
| --- | --- | --- | --- | --- | --- |
| 1 | **严重** | `splat/splat-state.ts:52,64,76`（`ranges.forEach` 闭包）+ `core/edit-ops.ts:229-233`（clear pre + clear applied + set post） | 每次推杆 / 每次选区 op | 13M 点：每趟 60–110 ms，一轮 3 趟 = **180–330 ms** | 内联遍历 `ranges.data`；`SelectRangeOp.do()` 三步合成一趟（见 O2/O3） |
| 2 | **严重** | `core/edit-ops.ts:60` → `splat/splat.ts:548,1068` → `data-processor/calc-bound.ts:182,187-208` | 每次选区 op（**含每次推杆**） | 让出一帧（16.7 ms @60 fps，低帧率 100 ms+）+ 4 次 `immediate` 同步回读（5–30 ms） | 见 O1：选区变更跳过 `calcBound`，`selectionBound` 惰性化/CPU 顺带算 |
| 3 | **严重** | `splat/selection-range.ts:462`（13 MB 掩码）+ `app/editor.ts:1072`（`fromPredicate` 闭包） | 每次推杆 | 13M：分配 3–10 ms + 遍历 30–65 ms + 闭包 60–110 ms | 见 O2：掩码与 ranges 合成一趟，缓冲复用 |
| 4 | **高** | `core/index-ranges.ts:47-64` | 每次手势（pre+post 共 2 次）、每次推杆（1 次） | 13M：闭包 60–110 ms/次；碎片化时 JS `number[]` 最多 13M 条目（**100+ MB**，且因 `0x80000000` 位退化成 double 数组）→ 再 `new Uint32Array(ranges)` 拷一遍 | 提供"调用方产出 `Uint32Array`"入口 + 可复用 scratch；避免 JS `number[]` 中转 |
| 5 | **高** | `splat/splat-state.ts:109-121`（`flush`：`buffer.set(this.data)` 整块 + `recount`） | 每次 op / 每次推杆 | 13M：13 MB 上传 5–15 ms + recount 13M 扫 15–30 ms | 子区间上传；recount 延后或增量（见 O4） |
| 6 | **高** | `app/editor.ts:1155-1161`（环模式 id 拾取：`new Set()` 装 pick 里**未去重**的几十万~百万 id，然后 `for (i<numSplats) hit[i] = picked.has(i)`） | 每次环模式框选 | 13M 次 `Set.has`（哈希查表，比数组索引贵 3–5×）≈ **80–150 ms** + Set 的每项装箱开销 | 别用 Set：`pick` 是逐像素顺序的 id 缓冲（不是升序，不能直接套 `sortedPredicate`），改成"可复用 `Uint8Array(numSplats)` scratch + `for (id of pick) scratch[id] = 1`（只写 \|pick\| 次）"，再一趟线性遍历生成 ranges；或者直接把 pick 排序（原生 typed-array sort，80 万元素约 20–40 ms）后用 `index-ranges.ts:20` 的游标谓词 |
| 7 | **高** | `app/editor.ts:1429-1436`（按颜色选择：`new Uint8Array(numSplats)` + 13M 次循环里 **3 次 `decodeColorChannel` 调用** + 3 次 `Math.abs`） | 每点一次"选择相似颜色" | 13M × 3 = **3900 万次函数调用** ≈ 200–500 ms，外加 13 MB 掩码 | 把 `0.5 + v*SH_C0` 与 clamp 内联成 3 条表达式（函数体只有一行，调用开销占大头）；掩码改成直接 emit ranges |
| 8 | **高** | `app/editor.ts:1709-1742`（heal 套索：`Set` 装百万 id → `for (i<numSplats) if (selected.has(i)) continue` → 每点 `mat.transformVec4(vec4, vec4)` 调用 → `new Uint32Array(selected)`） | 每次 heal 套索 | 13M 次 `Set.has` + 13M 次 `Mat4.transformVec4`（含 16 次乘加的方法调用，且每次都写回 `Vec4` 字段）≈ **150–350 ms**；`Uint32Array(selected)` 再拷一遍 | 用 `Uint8Array` 位图代替 `Set`（`selected.has(i)` → `bit[i] !== 0`）；把矩阵 16 个分量提到循环外、手写 4 个点积，不要每点调 `transformVec4` |
| 9 | **中** | `ui/heal-panel.ts:202-206,288` + `core/heal-inpaint.ts:595-604`（`getSelectedIndices`） | **每次 `splat.stateChanged`，即每次推杆**（`splat.ts:552` 发事件），**且仅当 heal 面板可见**；无 debounce | 13M 全扫 + 最多 13M 条目的 JS `number[]`（**~100 MB**）≈ 60–150 ms/次，只为了给标签写一个"选中数" | 用 `splat.numSelected`（已有缓存，`status-bar.ts:113` 就是这么做的），或至少加 200 ms debounce（`floater-panel.ts:396-401` 已有这个模式，直接抄） |
| 10 | **中** | `splat/splat.ts:950-962`（`focalPoint()`：13M 全扫，每点 2 次 `Math.exp`） | 导入取景（`camera.ts:937-952 focus()` 无参数分支）、按 F / "聚焦选中"（`app/editor.ts:561`） | 13M × 2 次 `Math.exp` ≈ **0.5–1.5 s 同步阻塞**（对比：`denseRadius()` `:1004` 已经用 stride 采样到 20 万点，说明这个模式在本仓库是被认可的） | 用同一个 stride 采样（`numSplats > 500000` 时抽 20 万点），或复用已在内存里的 `denseRadius()` |
| 11 | **中** | `splat/selection-range.ts:287-294`（`createRangeCache`：`sx` Int16 + `sy` Int16 + `dist` Float32 = 8 B/点）+ `app/editor.ts:1134,1185`（`rangeGesture` 持有 `preMask` 13 MB） | 每次屏幕手势后**常驻**，直到下一次手势 | 13M：缓存 **104 MB** + `preMask` **13 MB** ≈ **117 MB** 常驻；93 万约 8 MB | 手势结束后按需降级（只保留 `dist` Float16 / 只缓存框内点 `sx>=0` 且落在手势包围盒里的点）；至少提供"手势结束 N 秒后释放缓存"的开关 |
| 12 | **低–中** | `camera/camera-preview.ts:660`（`captureToCanvas`）→ `:1337`（WebGL2 `gl.readPixels` 同步）/ `:1367`（WebGPU `read(..., immediate: true)`）；另 `:1183-1184` `_cpuDepthSort` 每次 `new Uint32Array(n)` + `new Float64Array(n)`；`:496-501` 每轮 `Array.from(_pipSort.keys())` + `currentKeys.includes` | **不是每帧**：`:442` 有节流，`:163-164 _pipInterval()` = `max(6, ceil(n/1e6))` ⇒ 93 万点**每 6 帧**、1300 万点**每 13 帧**；且 `:439` 主视图拖动期间**完全跳过**。CPU 排序仅 worker 不可用时走 | 回读 320×180×4 = 230 KB（带宽小，代价是**每 6–13 帧一次同步 GPU 等待**）；`_cpuDepthSort` 回退时 13M 上是 **52 MB + 104 MB = 156 MB 分配/次** | 回读已经是节流的（这点比预期好）；`_cpuDepthSort` 的双数组改成模块级复用缓冲（回退路径一进来就是几百 ms + 156 MB 抖动） |
| 13 | **中** | `compare/compare-scene.ts:1192-1198`（`app.on('update')` → 每 5 帧 `refreshAnalysisOverlays()`）→ `:421-433,441-443` 对**每个可见模型**重跑 `analysisOverlay.refresh()`；内含 `compare-analysis.ts:590`（`new Float32Array(cw*ch).fill(Infinity)`）、`:844,918-919,942,1126-1127,1200,1278-1284,1429,1467` 十几次 `gw*gh`/`cw*ch` 分配 + `:1146` 整块 `getImageData` | 对比工具开"分析模式"时，**每 5 个渲染帧**（4 模型 = 每 5 帧 4 次全量分析） | 每次刷新 ≈ 十几次数组分配（cw×ch 若 960×540 则 2 MB/个）+ 一次整画布 `getImageData` + O(cw·ch) 计算 ⇒ 单次 30–120 ms，**摊到每帧 6–24 ms** | 改成"相机停稳后刷新一次"（`data-panel.ts:571-588` 的 200 ms settle 模式很适合照抄），或把间隔从 5 帧放到相机位移阈值触发；中间数组改成模块级复用 |
| 14 | **中** | `app/render.ts:1549`（每帧 `workTarget.colorBuffer.read(..., immediate: true)`）+ `:1536-1539`（每 2 帧 `sortSplatsAndWaitStrict`）+ `:1553-1559` 每帧 `new VideoFrame(new Uint8Array(data.buffer, ...))`；360 全景路径 `:1155-1165` 是每帧 6 个面 + `equirect.read` | 每次视频导出（**每输出帧**） | 每帧一次同步回读（1080p = 8.3 MB 拷贝 + GPU 同步等待）；大模型每 2 帧一次 ~300 ms 排序 | 回读改双缓冲 + 错开一帧取（用上一帧的结果编码），排序间隔按 `SORT_INTERVAL` 自适应模型大小；`data` 已复用（这点是好的），但 `VideoFrame` 每帧新建无法避免，可考虑 `VideoFrame` 池 |
| 15 | **中** | `tools/lasso-selection.ts:34-35`（`[...points, currentPoint].reduce((prev,c)=>`${prev}${c.x}, ${c.y} `, '')` + `setAttribute`）、`tools/polygon-selection.ts:37`、`tools/heal-tool.ts:45` | **每次 pointermove**（拖动期间） | **O(n²) 字符串拼接**：n=1000 点时每次移动拷 ~6 M 字符、n=3000 点 ~54 M 字符 ⇒ 10–60 ms/次，且点数**无上限**（越拖越慢）；`setAttribute('points')` 还要让浏览器重解析整条路径 | 增量更新：把点作为 `<polyline>` 的子元素 append（或每 N 点才重设一次 `points`）；或只 `setAttribute` 末尾追加的片段；给点数设上限（如 2000 点后降采样） |
| 16 | **低–中** | `core/selection-flags.ts:59-66`（`store()` 4 次 `localStorage.setItem`）← `ui/range-slider.ts:196-210`（pointermove → `setHandle` → `commit` → onChange） | **每次 pointermove**（值变了才写，`selection-flags.ts:215` 有 `same()` 守卫） | 每移动一次最多 4 次**同步**存储写入；Chromium 下约 20–100 µs/次 ⇒ 单次 <1 ms，但一次拖动几百个事件 = 累计 10–100 ms + 磁盘快照 | 拖动中只内存更新，`pointerup`/手势结束再落盘（`range-slider.ts` 已经有明确的 `endDrag` 钩子，落地成本极低） |
| 17 | **低–中** | `io/load-worker-client.ts:80-91`（`readFileBytes`：`bytes.buffer.slice(byteOffset, byteOffset + byteLength)`） | 每次导入（拖动/打开文件） | `readAll()` 返回的是 `buffer.subarray(0, length)`，而 `BlobReadStream` 传的 `expectedSize = end - start` 正好等于文件大小 ⇒ `length === buffer.byteLength`、`byteOffset === 0` ⇒ **这次 slice 是把整个文件再拷一遍**：695 MB ≈ 0.15–0.35 s memcpy + **瞬时峰值 +695 MB**（源/副本同时在世） | 加条件：仅当 `byteOffset !== 0 \|\| byteLength !== buffer.byteLength` 时才拷贝，否则直接把 `bytes.buffer` transfer 给 worker |

### 另外两处"低"，但顺手可清

- **每帧小分配合集**（累计约 300+ 次分配/秒，GC 压力而非单次耗时）：
  `scene/scene.ts:549` `new Set([...added, ...removed, ...moved, ...changed])`（4 个数组 + 1 个 Set/帧）、
  `splat/splat.ts:667-669` `serializer.packa(Array.from(this._hslHue/Sat/Lum))`（3 次 `Array.from`/帧/模型，
  而 `_hslHue` 本来就是 `Float32Array`，`packa` 直接收 typed array 即可）、
  `camera/camera-preview.ts:522,543-546` 每帧 `new Vec3()` + 每 entry `new Vec3()` + `new Mat4()`、
  `compare/compare-scene.ts:1203-1207` 每帧 `forward.clone()` + `pos = target.add(forward.mulScalar())`。
- **`app/editor.ts:1249-1270`**（`select.byMask`）：每次套索/多边形/2D 笔刷落地时
  `getImageData(0, 0, canvas.width, canvas.height)` —— 画布是 **CSS 像素**尺寸（`lasso-selection.ts:60-62`
  用 `parent.clientWidth`），1080p 窗口 ≈ 2.07 M 像素 / 8.3 MB，再逐像素 `i % cw`（一次整数除法/像素）
  ≈ 5–15 ms。建议：直接用 `cw` 而不是 `i % cw` 推 `px`（外层 `for (py)` / 内层 `for (px)`），
  并把 `contains` 闭包在 rect 情形下特化（现在是**每高斯**一次闭包调用，见清单 3）。

---

## 三、检查过、确认干净（避免下次重复排查）

- **`scene/scene-state.ts` 的每帧 pack/compare**：每个元素只 pack 十几个标量，`compare` 是 O(元素数)，
  元素数是个位数 ⇒ 便宜。唯一的浪费是 `scene.ts:549` 的 5 次分配（见上）。
- **`ui/data-panel.ts:571-588`**：`prerender` 里**只比较矩阵**，并 200 ms settle 后才 `tick()` —— 正确模式。
- **`ui/status-bar.ts:110-122`**：`splat.stateChanged` 里只用**缓存计数**（`numSelected` 等），不做全扫 —— 正确模式（对比清单 9）。
- **`ui/floater-panel.ts:396-401`**：`_scheduleDetect()` 有 200 ms debounce ⇒ 推杆不会触发浮云重检测。
- **`tools/brush-selection.ts:24-27` / `sphere-brush.ts:62-65`**：`window.addEventListener('pointermove')`
  是**每次注册工具时一次**（不是每次激活），且 `{passive:true}`，回调只写一个 `{x,y}` —— 干净。
- **`tools/rect-selection.ts:89` / `brush-selection.ts:121` / `lasso-selection.ts:85` /
  `polygon-selection.ts:68` / `flood-selection.ts:52`**：O(n) 的 `select.rect` / `select.byMask`
  都在 **pointerup** 调用，**不是**每次 pointermove ⇒ 手势过程中的卡顿不来自这里。
- **`io/read/file-systems.ts:19-45`**：`BlobReadStream.pull` 按 4 MB 块读并 `BufferedReadStream` 包装，
  没有逐行/逐块重新分配。
- **`workers/load-worker.ts:79-94`**：`readAll()` 的容量来自 `expectedSize = end - start`（`read(start=0, end=size)` 默认值），
  695 MB 是**一次精确分配**，不走 64 KB 起的倍增（只有调用方显式传 `undefined` 才会）。
- **`core/serializer.ts`**：只做 `push`，无字符串/JSON。
- **`scene/picker.ts:263-350`**：回读已经合并成"并集一次读"，`immediate: true` 是 WebGPU 必需（`:168-174` 有说明），
  已知代价（单次 59–135 ms）也已在 6.33 记录 ⇒ 不重复计。
- **`splat/picker.ts` 之外**：全仓**没有** `createImageBitmap`；`toDataURL` 只在快照/对比导出用
  （`ui/snapshot-handler.ts:142-144`、`compare/compare-panel.ts:415,433`），不在逐帧路径上。
- **`core/gpu-backend.ts:95`、`core/shortcut-manager.ts:168`、`gamepad/gamepad-config.ts:275`、
  `camera/mouse-bindings.ts:47`、`ui/localization.ts:116`、`core/preferences.ts:139`**：这些 `localStorage.setItem`
  都在"设置变更/初始化"上，不在拖动热路径（唯一在热路径的是清单 16）。
- **`app/render.ts:334-372`（`render.offscreen`）**：每次调用一次回读，调用方只有洪水填充选择
  （`tools/flood-selection.ts:71`）⇒ 每次点击一次，不是每帧。

---

## 四、和既有基线的对账

| 场景 | 实测 | 本报告的账 | 结论 |
| --- | --- | --- | --- |
| 93 万点一次推杆 | 30–43 ms | O1（让出一帧 + 4 回读）≈ 22–32 ms；O2/O3/O4 合计 ≈ 8–15 ms | **93 万点上"大头是 GPU 同步等待，不是 CPU 遍历"** ⇒ O1 是性价比最高的一刀，且**不是**超大模型专属 |
| 1300 万点一次推杆 | 556–721 ms | 4 趟 13M 遍历（约 240–400 ms）+ 13 MB 分配/上传（约 20–50 ms）+ recount（15–30 ms）+ 让出帧与 4 次回读（20–200 ms） | 与 6.47 的结论一致（掩码→ranges + 状态位回写 + 上传），本报告把其中"让出帧 + 同步回读"单独列出来——**这部分和模型大小无关，纯粹是白等** |
| 1300 万点一次屏幕手势 | 774 ms（改后） | `tailFractions` 采样 ≤40 万点（约 30 ms）+ `selectRange` 一趟全扫 + **2 次** `fromPredicate`（pre+post，约 120–220 ms）+ 2 次 `setBits` | 手势的 2 次 `fromPredicate` 建议合成一趟（顺手产出 pre 与 post 两组 ranges） |
| 大模型相机拖动 | （用户主观"还是有一些不顺滑"） | O5 每帧一次 ~300 ms 排序派发 | 如果"不顺滑"发生在**旋转/平移相机**时而不是推滑块时，那 O5 是首要嫌疑 |

---

## 五、建议的动手顺序（如果只做三步）

1. **O1**（选区变更跳过 `calcBound`）—— 改动最小、两个模型尺寸都受益、易回滚；
2. **O3**（去掉每索引闭包）—— 纯内部 API、风险低、13M 上立省 80–150 ms/推杆；
3. **O2**（4 趟合 1 趟 + 缓冲复用）—— 13M 上的决定性一刀，配合 O4（recount 延后）一起做。

验证方式沿用仓库现有道具即可：`docs/probes/push-perf.cjs`（一次推杆触发到落地）、
`docs/probes/merged-probe3.cjs`（13M 场景）、`docs/verify/verify-selection-range.cjs` /
`verify-selection-depth-bar.cjs`（双后端语义不能破）。
