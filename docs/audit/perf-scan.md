# SplatRoom V3 性能热点与资源浪费横向扫描

> **只读审计**（未修改任何源文件、未 build、未跑测试）。版本 3.21.0，PlayCanvas 2.21.3，WebGL2 + WebGPU 双后端，
> 329 个 TS 文件 / 约 6.6 万行。
>
> **方法**：`grep` 级横向排查（同步 GPU 回读、热路径 `new`、大数组的 `Array.from/spread/map/filter/sort`、
> 每帧路径、事件风暴、`localStorage`、`JSON.stringify`、O(n²)），**每个候选点再回溯调用链**确认它是否真在
> 热路径上（每高斯 / 每次手势 / 每次拖动 tick / 每次推杆 / 每帧 / 每次导入）。凡本文写"每次 X"的，都是
> 回溯到入口函数确认过的；凡确认**不是**热路径的，列在第三节，避免下次重复排查。
>
> **量级估算假设**（下文所有 ms 都按这几条推算，可核对）：
> 1. 一个 JIT 优化过的 typed-array 紧凑循环（几次读取 + 分支）≈ **2–5 ns/迭代** ⇒ 每 100 万点 **2–5 ms**，1300 万点 **30–65 ms**；
> 2. "每索引一次闭包调用"的遍历 ≈ **4–8 ns/迭代**（比内联循环贵 1.5–2×）⇒ 1300 万点 **60–110 ms**；
> 3. "每元素新建一个 JS 数组/对象" ≈ **30–80 ns/元素** ⇒ 1300 万点 **0.4–1 s + GC**；
> 4. 一次同步 GPU 回读（`immediate: true`，内部 `clientWaitSync` 轮询）在队列空闲时 ≈ 5–30 ms；
>    `waitForGpuDrain()` 是**让出一个动画帧**（60 fps = 16.7 ms，10 fps = 100 ms）；
> 5. 大数组比较器排序（boxed `Array` + JS 比较器）≈ **n·log₂n 次比较** ⇒ 1300 万元素约 **6–12 s**；
>    typed-array 的默认数值 `sort()` 是同量级但常数小得多，**桶排序/直方图**才是 O(n)。

## 0. 已读的既有结论（本次**不**重复计入清单）

| 出处 | 已知结论 |
| --- | --- |
| `docs/V3-WebGPU-现状.md` 6.47 | 推杆瓶颈＝掩码→索引区间 + 状态位回写 + 上传（三步 O(n) JS）；投影缓存 8 B/点、>2400 万点关闭；13M 手势 2003→774 ms、推杆 840–1016→**556–721 ms**；93 万点推杆 **30–43 ms** |
| 同上 6.33 | `picker.readDepths` 分块→"并集一次读"（150.8→76.1 ms）；spinner 延迟 200 ms；单击仍有 59–135 ms 同步等待 |
| 同上 6.20 | PiP 私有排序：比较器排序 → 4096 桶桶排序（5M 点 2.2 s） |
| 同上 6.34 / 6.36 | 屏幕选择改成 CPU 侧窗口/深度判定，**故意**不用 GPU 深度回读 |
| `compare-analysis.ts:1137-1141` | 格子 ×3×3 循环里的 `getImageData`（最多 82,944 次/刷新）**已修**成整块读一次 |
| `HANDOFF.md` 第 6 节 | 待办第 1 条＝"把窗口判定搬进着色器"，等用户拍板 |

本文新增的是上述未记录的热点，以及**把已知瓶颈拆成可分别动手的几笔账**。

---

## 一、最值得做的 5 个优化

| # | 改什么 | 预期提速 | 风险 | 只对超大模型？ |
| --- | --- | --- | --- | --- |
| **O1** | `calcBound` 只在**真的需要**时跑：推杆/选区变更不算，变换拖动 tick 也不算 | 93 万推杆 30–43 ms → **10–15 ms（2–3×）**；13M 每次省"≥1 帧 + 4 次同步回读"（低帧率时 20–200 ms） | 中低 | **否**，两个尺寸都受益，小模型上占比更大 |
| **O2** | 推杆链路 **4 趟 1300 万全扫合并成 1 趟**，去掉 13 MB 中间掩码 | 13M 推杆 556–721 ms → **200–300 ms** | 中 | 收益 ∝ n，13M 上才是必需 |
| **O3** | `IndexRanges` 与 `SplatState` **去掉"每索引一次闭包"** | 13M 每次推杆省 **80–150 ms**；手势省 30–60 ms | 低 | 否（93 万省 5–10 ms） |
| **O4** | 组模式下拖动 tick **不再全量重写 merged 数据 + 全纹理重传**（降频/增量/松手一次） | 13M 合并组拖动 **每 tick 0.5–1 s 主线程 + ~310 MB 上传 → 每 tick <50 ms** | 中 | **是**（代价 ∝ merged 总点数） |
| **O5** | 组数据列拼接 `O(k²·n)` → **一次预留 + 一次拷贝** | 13M 组重建 ~6 GB memcpy（2–6 s）→ **~0.3 GB（<0.3 s）**，消除 OOM 悬崖 | 低 | **是** |

---

### O1 —— `calcBound` 在"没人要结果"的时候也在跑（最便宜的一刀）

`Splat.updateState()`（`splat/splat.ts:536-553`）的逻辑是"`changedState & State.deleted` ⇒ `updateSorting()`，
**否则** ⇒ `updateLocalBounds()`"，而 `updateLocalBounds()`（`:1067-1068`）直接调
`dataProcessor.calcBound()`。`calc-bound.ts` 的 `run()` 做的是：

1. `:173` 画一个全屏 quad（GPU 归约 pass，遍历全部高斯）；
2. `:182 await waitForGpuDrain()` —— `data-processor/gpu-readback.ts:26`，**让出一个动画帧**（`Promise.race(rAF, 500ms)`）；
3. `:187-208` **4 次 `texture.read(..., immediate: true)`**（WebGL2 = 4 次 `readPixels` + `clientWaitSync` 轮询；
   WebGPU = 4 次强制提交并等待）。

**而它被两条高频路径无条件调用**：

| 路径 | 位置 | 频率 | 备注 |
| --- | --- | --- | --- |
| 选区 op（含**每一次推杆**） | `core/edit-ops.ts:60,235` → `splat.ts:548` → `:1068` | 每个已合并的推杆值一次 | `SelectRangeOp.do()` 走的就是 `State.selected` 分支 |
| **变换拖动 tick** | `splat/splats-transform-handler.ts:158`（`update(transform)` 内）→ `events.invoke('queue', () => this.splat.updateLocalBounds())` | **每个拖动 tick 一次**，且注释自认"fire-and-forget is fine：最终 bound 在 `end()` 里 `updatePositions → updateSorting → updateLocalBounds` 会重算" | 结果**在拖动期间根本没人读** ⇒ 完全是白跑，而且走**共享 CommandQueue 且不合并**，拖动期间每 tick 往队列里排一个"GPU pass + 让帧 + 4 次回读" |

**为什么可以不算**（已核对，不是推测）：

- 归约着色器 `shaders/bound-shader.ts:39-73`：**visible** 界只跳过 `state & 4`（deleted），**selected** 界只在
  `state == 1` 时累加 ⇒ **改 selected 位完全不影响 visible/local 界**；
- `selectionBoundStorage` 全仓只有一个读点 `splat.ts:1302`（`getPivot(..., selection=true)`），
  唯一调用方是 `splat/splats-transform-handler.ts:71`（选中集变换手柄激活时）⇒ 拖动期间也不需要。

**改法**：① `updateState()` 只在 `changedState & State.deleted` 或数据被替换时才 `updateLocalBounds()`；
② `splats-transform-handler.ts:158` 那行直接删（`end()` 已经会算一次；若拖动中确实需要 AABB 用于裁剪，
改成 30 Hz 节流，`group-renderer.ts:222-230` 的 `lastAabbUpdate > 33` 就是现成的写法）；
③ `selectionBoundStorage` 惰性化；④ 最彻底：`selectRange`/`selectRangeFromCache` 本来就有一趟全扫，
在同一趟里顺手累加选中点 AABB，彻底不需要 GPU 回读。

**量级**：93 万点上推杆实测 30–43 ms，其中"让出一帧 16.7 ms + 4 次回读 5–15 ms"≈ **22–32 ms**。
**风险**：中低（唯一读点只有 1 处，回滚容易：只改一个条件 + 删一行）。

---

### O2 —— 一条推杆链路 = 4 趟 1300 万全扫 + 13 MB 掩码

每次 `pumpRange` 迭代（`app/editor.ts:1196-1216`，已有 `rangePumpBusy`/`rangePending` 合并，**中间值会被丢弃**，这点是对的），
对 13,007,105 点做：

| # | 位置 | 干什么 | 量级 |
| --- | --- | --- | --- |
| 1 | `splat/selection-range.ts:462` | `new Uint8Array(numSplats)`（**13.0 MB** 清零）+ 13M 次窗口/深度比较；`contains` 是**闭包调用**（`:498`） | 分配 3–10 ms + 遍历 30–65 ms |
| 2 | `app/editor.ts:1072` `IndexRanges.fromPredicate` | 13M 次**闭包**调用（`preMask[i]!==0` + `mask[i]===255`） | 60–110 ms |
| 3 | `core/edit-ops.ts:229-233` | `clearBits(pre)` + `clearBits(applied)` + `setBits(post)` = **3 趟 ranges 遍历，每索引一次闭包**（`splat-state.ts:52/64/76`） | 3 × 60–110 ms（随选中占比） |
| 4 | `splat/splat-state.ts:115-118` | `flush()`：`gpu.lock()` + `buffer.set(13 MB)` + `unlock()` + `recount()` 全扫 13M | 上传 5–15 ms + 扫描 15–30 ms |
| 5 | 见 O1 | `calcBound`：让出一帧 + 4 次回读 | ≥16.7 ms（帧越慢越久） |

合计正好落在实测的 556–721 ms 区间。

**改法**：把 1+2 合成**一趟**——遍历索引时不写掩码，直接
①判深度/窗口/形状 → ②按 pre/opKind 得到该点最终 selected 位 → ③写 `state.data[i]` →
④把连续命中段 emit 成 ranges（**双缓冲 `Uint32Array`，不用 JS `number[]`**）；
顺手在 ④ 里累加选中 AABB（顺带解决 O1 第 ④ 档）。
`SelectRangeOp` 的"先清 `pre` 与上次 `applied`、再种 `post`"语义要保留，但清/种都改成对
`IndexRanges.data` 的内联遍历（见 O3）。

**量级**：13M 从"4 趟遍历 + 1 次 13 MB 分配"→"1 趟 + 复用缓冲"，预期 **556–721 → 200–300 ms**；
93 万从 30–43 ms → ~12–20 ms。**风险**：中——`preMask`/`applied` 的边界语义有历史 bug
（`edit-ops.ts:200-203` 记着"收窄范围时上一版选中的行会留下"），改动必须过
`docs/verify/verify-selection-range.cjs` / `verify-selection-depth-bar.cjs`（双后端）。

---

### O3 —— 去掉"每索引一次闭包"（改动小、风险最低）

| 位置 | 形态 | 闭包调用数（13M） |
| --- | --- | --- |
| `core/index-ranges.ts:47-64` | `fromPredicate(total, pred: (i)=>boolean)`，内部 `ranges.push()` 到 JS `number[]` | 手势 2×13M（pre + post，`editor.ts:1164-1165`）、推杆 1×13M（`editor.ts:1072`） |
| `splat/splat-state.ts:52 / 64 / 76` | `ranges.forEach((i) => { data[i] \|= mask; ... })` | 每次 op 1–3×13M |
| `core/edit-ops.ts:139` | `sortedPredicate(this.sel)` / `(i)=>this.sel[i]===255` 再被 `fromPredicate` 包一层 | 双层闭包（去浮云/簇过滤路径） |

`fromPredicate` 还有第二个问题：`ranges` 是普通 `number[]`，元素塞了 `0x80000000 | start`
（`index-ranges.ts:9`）⇒ V8 退化成 **PACKED_DOUBLE_ELEMENTS**（8 B/元素）；碎片化选区最多产生 n 个条目
⇒ **最多 100+ MB 的临时数组**，再 `new Uint32Array(ranges)` 拷一遍（`:63`）。

**改法**：`IndexRanges.fromPredicate` 增加"调用方自己产出 ranges"的入口（接受可复用 scratch / 直接写 `Uint32Array`）；
`SplatState.setBits/clearBits/toggleBits` **内联遍历 `ranges.data`**（两种形态：`data[r] & SINGLE_BIT` = 单点，
否则 `[start, count]`），不要 `forEach` 闭包。

**量级**：13M 省 **80–150 ms/次推杆**、手势省 30–60 ms；93 万省 5–10 ms。
**风险**：低（纯内部 API，`IndexRanges` 已暴露 `readonly data`，语义不变）。

---

### O4 —— 组模式拖动 tick 的全量 merged 重写 + 全纹理重传

链路（已核对）：`splat/splat.ts:1063` 每次 `move()` 末尾 `fire('splat.moved')` → `scene/scene.ts:376-380`
→ `groupRenderer.updateSplatTransform(splat)`（`splat/group-renderer.ts:135-234`）：
① 对**被拖的那个模型**的全部点重算 world 变换，写进 `mergedGSplatData`；
② `:215 resource.updateTransformData(this.mergedGSplatData)` —— **把整块 merged 纹理重新上传**
（merged = 组内所有模型，13M 点时单次约 300 MB 级）；③ `scene.boundDirty = true` + `forceRender = true`。

**频率**：每个拖动 tick（gizmo 拖动 / 键盘 / 变换面板 / undo 都会触发 `splat.moved`）。
`scene.ts:370-389` 显示团队已经知道这条路重——`pivot.started` 时会把渲染分辨率**减半**来"保证流畅"。

**改法**：拖动期间不做全量重写；改成
① 只上传**被拖模型那一段**纹理（子区间上传，`updateTransformData` 若能接受 offset/count 最好）；
② 或把 `updateSplatTransform` 节流到 10–15 Hz（`group-renderer.ts:222-230` 已有 `lastAabbUpdate > 33` 的范例）；
③ 松手时 `markDirty()` 已经会做一次完整重建（`scene.ts:384-388`），所以拖动期间的低频版本不会丢正确性。

**量级**：13M 合并组每 tick 约 **0.5–1 s 主线程 + ~310 MB 上传** ⇒ 目前只能靠"降分辨率"掩盖；
改成子区间 + 10 Hz 节流后每 tick <50 ms。93 万点约为 1/14，问题不突出。
**风险**：中（要保证松手后 `markDirty()` 的全量重建把矩阵/偏移/GPU 数据都同步回一致状态——这条路径已经存在）。

---

### O5 —— 列拼接 `O(k²·n)`：13M 下一次组重建要 memcpy ~6 GB

`group-renderer.ts:813-822` 的 `concatArray`：每追加一列就把**已累积的结果**整体拷一遍
（`new Float32Array(prev.length + add.length)` + `set(prev)` + `set(add)`）；k 个成员模型 ⇒ O(k²·n)。
调用点在 `buildMergedGSplatData`（`:279`），入口是**编辑器自己的分组路径** `app/editor.ts:737`
（以及合并工具的导出路径——同一份实现存在两处，修复要覆盖两处）。

**量级**：93 万点 / 2 个模型 ≈ 0.9 GB memcpy ≈ 100–200 ms；**13M 点 ≈ 6 GB ≈ 2–6 s 且 OOM 风险显著**
（峰值同时存在源数据 + 新列 + 旧列）。
**改法**：先算总点数与列数，一次性分配目标 `Float32Array`，逐段 `set(src, offset)`（O(n) 一次拷贝）；
或维护"列池 + 容量预留"。
**风险**：低（纯算法改动，无行为变化）；**只对超大模型有意义**（93 万点也能省 100–200 ms）。

---

## 二、横向清单（20 条）

> 严重度：**严重** = 直接决定"顺不顺滑"的大头；**高** = 单次操作 O(n) 且常数大 / 有 OOM 风险；
> **中** = 明显但可忍；**低** = 长尾/累积。

| # | 严重度 | 位置 | 频率 | 量级 | 建议 |
| --- | --- | --- | --- | --- | --- |
| 1 | **严重** | `core/edit-ops.ts:60,235` → `splat/splat.ts:545-548,1067-1068` → `data-processor/calc-bound.ts:173,182,187-208` | **每次选区 op（含每次推杆）** | 让出一帧（16.7 ms @60 fps；低帧率 100 ms+）+ 4 次 `immediate` 同步回读（5–30 ms） | 见 O1：纯 `State.selected` 变更跳过 `calcBound`，`selectionBound` 惰性化 |
| 2 | **严重** | `splat/splats-transform-handler.ts:158`（`events.invoke('queue', () => this.splat.updateLocalBounds())`） | **每个变换拖动 tick**，共享队列**不合并** | 与 #1 同价（≥1 帧 + 4 次回读）/tick；注释自认结果要到 `end()` 才用 | 见 O1：直接删掉这行，或在 `end()` 保留一次；若必须，改成 30 Hz 节流 |
| 3 | **严重** | `splat/group-renderer.ts:135-234`（`:215 resource.updateTransformData`）← `scene/scene.ts:376-380` ← `splat.ts:1063` | 组模式下每个拖动 tick | 13M：**0.5–1 s 主线程 + ~310 MB 上传/tick**；93 万 ≈ 1/14 | 见 O4：子区间上传 / 10–15 Hz 节流，松手时已有全量重建兜底 |
| 4 | **严重** | `splat/selection-range.ts:462`（13 MB 掩码）+ `app/editor.ts:1072`（`fromPredicate` 闭包） | 每次推杆（pump 已合并中间值） | 13M：分配 3–10 ms + 遍历 30–65 ms + 闭包 60–110 ms | 见 O2：掩码与 ranges 合成一趟、缓冲复用 |
| 5 | **高** | `core/index-ranges.ts:47-64` + `splat/splat-state.ts:52,64,76` + `core/edit-ops.ts:139,229-233` | 每次手势（2 次）、每次推杆（1+3 次） | 13M：闭包 60–110 ms/次；碎片化时 JS `number[]` 最多 13M 条目（**100+ MB**，退化成 double 数组）再拷进 `Uint32Array` | 见 O3：内联遍历 `ranges.data` + 由调用方直接产出 `Uint32Array` |
| 6 | **高** | `splat/splat-state.ts:109-121`（`flush`：`buffer.set(this.data)` 整块 + `recount()`）、`:87-105` | 每次 op / 每次推杆 | 13M：13 MB 上传 5–15 ms + recount 全扫 15–30 ms；连续拖动 ≈ 130 MB/s 上传 + 每秒数次 13M 扫描 | 子区间上传（注释里已自认是待做项）；`recount` 延到松手或改增量计数（`setBits` 已知 ranges 与 mask） |
| 7 | **高** | `app/editor.ts:1155-1161`（环模式 id 拾取：`new Set()` 装 pick 里**未去重**的几十万~百万 id，再 `for (i<numSplats) hit[i] = picked.has(i)`） | 每次环模式框选 | 13M 次 `Set.has`（哈希查表比数组索引贵 3–5×）≈ **80–150 ms** + Set 每项开销 | 别用 Set：pick 是**逐像素顺序**（不升序，不能直接套 `sortedPredicate`）——改成可复用 `Uint8Array(numSplats)` scratch，`for (id of pick) scratch[id] = 1`（只写 \|pick\| 次）再一趟线性遍历产出 ranges；或对 pick 做原生 typed-array 排序（80 万元素约 20–40 ms）后用 `index-ranges.ts:20` 的游标谓词 |
| 8 | **高** | `app/editor.ts:1429-1436`（按颜色选择：`new Uint8Array(numSplats)` + 13M 次循环里 **3 次 `decodeColorChannel` 调用** + 3 次 `Math.abs`） | 每次"选择相似颜色" | 13M × 3 = **3900 万次函数调用** ≈ 200–500 ms + 13 MB 掩码（`decodeColorChannel` 只有一行 `min(1, max(0, 0.5+v*SH_C0))`，开销全在调用本身） | 把表达式内联进循环；掩码改成直接 emit ranges（顺带省掉 #4 里那类中间物） |
| 9 | **高** | `app/editor.ts:1709-1742`（heal 套索：`Set` 装百万 id → `for (i<numSplats) if (selected.has(i)) continue` → 每点 `mat.transformVec4(vec4, vec4)` → `new Uint32Array(selected)`） | 每次 heal 套索 | 13M 次 `Set.has` + 13M 次 `Mat4.transformVec4`（16 次乘加的方法调用 + 逐次写回 `Vec4` 字段）≈ **150–350 ms**；`Uint32Array(selected)` 再拷一遍 | `Uint8Array` 位图代替 `Set`；把矩阵 16 个分量提到循环外手写点积，不要逐点调 `transformVec4` |
| 10 | **高** | `splat/group-renderer.ts:813-822`（`concatArray`，**两处同源实现**，另一处经 `buildMergedGSplatData:279` ← `app/editor.ts:737`） | 每次组重建（拖手/`setGroup`/合并导出） | 93 万/2 模型 ≈ 0.9 GB memcpy ≈ 100–200 ms；**13M ≈ 6 GB ≈ 2–6 s + OOM 风险** | 见 O5：预先算总长一次性分配，逐段 `set(src, offset)` |
| 11 | **高** | `workers/surface-worker-client.ts:577-592`（`bufs.x.slice()` + … + `extra.map(c => ({ name, data: c.data.slice() }))`，`extra` = `f_dc_*` + 45 个 `f_rest_*`，见 `geometry/surface-refiner.ts:244-253`）；且 `surface-refiner.ts:222` 的 `cloneGSplatData` 已经深拷过一遍 | 每次"表面细化"（1 次/模型/次） | 930k ≈ **210 MB memcpy（0.1–0.25 s）**；13M ≈ **2.9 GB 分配+拷贝（数秒 / OOM）**；回退副本在整个操作期间存活 ⇒ 峰值 ~3× 常驻 | 回退路径改成"按需重算"或直接复用 `refineSurface` 已克隆的那份；`extra` 里的大列（`f_rest_*`）走零拷贝视图而不是 `slice()` |
| 12 | **高** | `geometry/surface-analyzer.ts:175`、`:217`、`:294-295`、`:593-597`、`:599`（`const quat = [r0[i],r1[i],r2[i],r3[i]]`、`const cov = [[...],[...],[...]]`、`A.map(row => [...row])`、`order.sort((i,j)=>vals[j]-vals[i])`）；`:661`、`:665`（`Array.from(densities).sort((a,b)=>a-b)`）；同形代码在 `workers/surface-worker.ts:265-279`、`surface-worker-client.ts:291-303` | 每次分析 run（细化 / level-2）；`:114-116,304` 用 `CHUNK=20000` + `setTimeout(0)` 让出 | 930k ≈ **1100 万个短命数组（0.3–1 s + GC）**；13M ≈ **~1.5 亿个数组（10 s+，GC 主导）**；两次 boxed 比较器排序在 13M ≈ **6–12 s / ~200 MB** | 逐点改成标量运算（不要为每个高斯建 tuple）；`quat/cov` 用模块级临时对象；排序改 `Float32Array` 数值排序或直方图取中位数（O(n)） |
| 13 | **高** | 字符串键空间网格：`geometry/region-detect.ts:42-46,572-587,604-623`（`` `${cx+dx},${cy+dy},${cz+dz}` `` 27 键/查询 + 并查集）、`core/heal-inpaint.ts:79-103,192,195-200`（整模型网格 + 百万级 `Set.has`）、`geometry/planar-fix.ts:83-88,114,301-339`（**两次**全模型建网格 + 邻居计数做两遍） | 每次地面/水域检测、每次 heal 落地、每次"熨平" | 930k ≈ 0.2–1.5 s + 50–100 MB garbage；**13M ≈ 20–60 s + GB 级 garbage**（27 次模板字符串 × 每个候选点） | `surface-analyzer.ts:323-325` 已经在用**位打包整数键**——把这套推广过来；`planar-fix` 的 `buildCandidateInfo` 在 `detectProblems`（`:360`）与 `applyFix`（`:411`）里各建一次，应缓存复用 |
| 14 | **中** | `ui/heal-panel.ts:202-206,288` + `core/heal-inpaint.ts:595-604`（`getSelectedIndices`） | **每次 `splat.stateChanged`（＝每次推杆）**，仅当 heal 面板可见；**无 debounce** | 13M 全扫 + 最多 13M 条目的 JS `number[]`（**~100 MB**）≈ 60–150 ms/次，只为给一个标签写数字 | 直接用 `splat.numSelected`（已有缓存；`ui/status-bar.ts:113` 就是这么做的），或抄 `ui/floater-panel.ts:396-401` 的 200 ms debounce |
| 15 | **中** | `splat/splat.ts:950-962`（`focalPoint()`：13M 全扫 + 每点 **2 次 `Math.exp`**） | 导入取景（`camera/camera.ts:937-952` 无 options 分支）、按 F / "聚焦选中"（`app/editor.ts:561`） | 13M × 2 次 `Math.exp` ≈ **0.5–1.5 s 同步阻塞** | 抄同文件 `denseRadius()` `:1004` 的采样写法（`numSplats > 500000` 时 stride 抽 20 万点），或直接用 `denseRadius()` 的结果 |
| 16 | **中** | `compare/compare-scene.ts:1192-1198`（`app.on('update')` → 每 5 帧 `refreshAnalysisOverlays()`）→ `:421-433,441-443` 对**每个可见模型**重跑；`compare/compare-panel.ts:334-338`（灵敏度滑块 `input` 事件**直接**调 refresh，**绕过**那个 12 Hz 泵）；分析内部 `compare-analysis.ts:590,801-882,887-985,1077-1146,1204-1248,1271-1276` | 开"分析模式"时每 5 帧 + 每次滑块 input | 每次刷新：整块 `getImageData`（1920×1080 ≈ 2 M 像素）+ 十几个 `gw*gh`/`cw*ch` 数组 + per-cell 三次排序 + 新 canvas/ImageData ⇒ **80–200 ms/模型/次**，×12 Hz × 最多 4 模型 = 主线程饱和 | 刷新改成"相机/参数停稳后一次"（`ui/data-panel.ts:571-588` 的 200 ms settle 是现成范例）；滑块 input 走同一个防抖入口；中间数组模块级复用 |
| 17 | **中** | `app/render.ts:1549`（每帧 `workTarget.colorBuffer.read(..., immediate: true)`）+ `:1536-1539`（每 2 帧 `sortSplatsAndWaitStrict`，注释自记"14M 点 ~300 ms/帧"）+ 360 全景路径 `:1155-1165`（每帧 6 面 + `equirect.read`） | **每次视频导出的每一帧** | 每帧一次同步回读（1080p = 8.3 MB 拷贝 + GPU 同步等待）；大模型每 2 帧一次 ~300 ms 排序 | 回读改双缓冲/错开一帧（用上一帧结果编码）；排序间隔按模型大小自适应（`SORT_INTERVAL` 现在是常数 2） |
| 18 | **中** | `ui/range-slider.ts:196-210`（pointermove → `setHandle` → `commit` → `render`）+ `:254,264`（`getBoundingClientRect`/`offsetWidth`）+ `:357-398`（9 个 style 写）+ `core/selection-flags.ts:59-66`（**4 次 `localStorage.setItem`**）+ `ui/selection-depth-bar.ts:144-145`（把值回写到 3 个滑块 ⇒ 再 3 次 `commit`+`render`） | **每次 pointermove**（拖动期间） | 每次移动：**4 次同步存储写入 + ~4 次强制布局 + ~36 次 style 写**；单次 <1 ms 但一次拖动几百个事件 ⇒ 累计 10–100 ms 抖动（这是全仓**唯一**在拖动热路径上的 `localStorage` 写入） | 拖动中只更新内存 + 视觉，`localStorage` 与滑块回写延到 `endDrag`（`range-slider.ts:212-227` 已有这个钩子，落地成本极低） |
| 19 | **中** | `tools/lasso-selection.ts:34-35`、`tools/polygon-selection.ts:37`、`tools/heal-tool.ts:45`（`[...points, currentPoint].reduce((prev,c)=>`${prev}${c.x}, ${c.y} `, '')` + `setAttribute('points')`，**点数无上限**）；同族：`splat/splat-pick.ts:43-79`（每次点击把**全部高斯**投影一遍） | 每次 pointermove（前三个）；每次落点（pick） | 套索：**O(k²) 字符串拼接**（k=1000 时每次移动拷 ~6 M 字符、k=3000 时 ~54 M）⇒ 10–60 ms/次且越拖越慢 + SVG 路径整体重解析；`splat-pick` 在 13M 上**每次点击 1–2 s**（orient/measure 放点，最多 3 点） | 套索改成增量 append 子元素/每 N 点才重设 `points`，并给点数上限；`splat-pick` 用包围盒/网格预筛后只投影候选点 |
| 20 | **低–中** | 每帧固定开销合集 + 一处导入浪费：`scene/scene.ts:549`（`new Set([...×4])`）、`splat/splat.ts:667-669`（3×`Array.from`，本来就是 `Float32Array`）、`:806-907`（每 splat 每帧 ~30–38 次 `setParameter` + ~15–25 个数组字面量 ⇒ ~400 次分配/帧）、`camera/camera-path-3d.ts:620`（`rebuildFrustum` 每帧 ~25 个 `Vec3` + **2 次顶点缓冲上传**，未节流）、`scene/tool-overlay.ts:306-317`（每帧比较+重传顶点）、`ui/view-cube.ts:149-167`（每帧 6 个字面量 + 排序 + DocumentFragment，**无脏检查**）、`splat/selection-range.ts:287-294`+`app/editor.ts:1134,1185`（**手势缓存常驻 117 MB**：cache 104 MB + preMask 13 MB，直到下次手势）、`io/load-worker-client.ts:80-91`（`bytes.buffer.slice(...)`） | 每渲染帧 / 每次手势后常驻 / 每次导入 | 每帧合计约 **400+ 次分配 ≈ 每秒数万次**（GC 压力而非单次耗时）；13M 常驻 117 MB；导入时 `readAll()` 返回的是**精确尺寸**视图（`BlobReadStream` 传的 `expectedSize = end-start` = 文件大小 ⇒ `length === buffer.byteLength`、`byteOffset === 0`），**这次 slice 等于把 695 MB 整个文件再拷一遍** ≈ 0.15–0.35 s + 瞬时峰值 +695 MB | ① `scene.ts:549` 改成复用 `Set`/直接遍历；② `splat.ts:667-669` 把 `Float32Array` 直接交给 `packa`；③ `camera-path-3d.ts:620` 与 `view-cube.ts:149` 加脏检查/节流；④ 手势缓存提供"松手 N 秒后释放"或只缓存框内点（`sx >= 0` 且落在手势包围盒内）；⑤ `load-worker-client.ts:87` 加条件——仅当 `byteOffset !== 0 \|\| byteLength !== buffer.byteLength` 才拷贝，否则直接把 `bytes.buffer` transfer 给 worker |

---

## 三、检查过、确认干净（避免下次重复排查）

- **`scene/scene-state.ts` 的每帧 pack/compare**：每元素只 pack 十几个标量，`compare` 是 O(元素数)（个位数）⇒ 便宜。
- **`ui/data-panel.ts:431-501,571-588`**：`prerender` 里**只比较矩阵**，200 ms settle 后才 `tick()`；另有 `pendingToken` + 输入哈希去重 —— 教科书式合并泵。
- **`ui/status-bar.ts:110-122`**：`splat.stateChanged` 里只用**缓存计数**，不做全扫（对比清单 14）。
- **`ui/floater-panel.ts:396-402`**（200 ms）、**`ui/crop-box-panel.ts:559-562`**（150 ms，重新武装 ⇒ 等价于"每次拖动停稳一次"）、**`ui/timeline-panel.ts:239-251`**（16 ms + 宽度无变化则直接返回）、**`ui/camera-panel.ts:51,591`**（50 ms + rAF）：节流都有效。
- **`core/preferences.ts:131-147`**：写入用 `queueMicrotask` 合并到每任务一次；`:189` 只 `JSON.stringify` 一个小值。**全仓没有任何"整个场景/文档的 `JSON.stringify`"在热路径上**（`app/doc.ts:229` 是保存，`app/editor.ts:2206`/`gamepad/gamepad-capture.ts:272` 是小导出 blob）。
- **`localStorage` 其它写入方**（`core/gpu-backend.ts:95`、`core/shortcut-manager.ts:168`、`gamepad/gamepad-config.ts:275`、`camera/mouse-bindings.ts:47`、`ui/localization.ts:116`）都在设置变更/初始化上，不在拖动热路径（唯一的例外是清单 18）。
- **`getImageData`/`toDataURL` 不在循环或逐帧路径上**：`app/editor.ts:1249` 每次手势一次（注释里记录了当年"每候选高斯一次"的修复）；`compare-analysis.ts:1146` 已提到格子循环外；`scene/tool-overlay.ts:122` 是纹理一次性创建；`ui/snapshot-handler.ts:142,144`、`gamepad/gamepad-capture.ts:145` 是按需截图。全仓**没有** `createImageBitmap`。
- **交互处理器确认廉价（不是逐次 pointermove 的 O(n)）**：`rect-selection.ts:89` / `brush-selection.ts:121` / `lasso-selection.ts:85` / `polygon-selection.ts:68` / `flood-selection.ts:52` 的 O(n) 选择都在 **pointerup**；`flood-selection.ts:128-130`、`orient-tool.ts:355-360`、`measure-tool.ts:339-344`、`eyedropper-selection.ts:77-82`、`crop-tool.ts:197-221`、`crop-box-face-handles.ts:535-543`（6 球悬停，仅变化时更新）都只做 O(1) 工作。
- **`tools/brush-selection.ts:24-27` / `sphere-brush.ts:62-65`**：`window.addEventListener('pointermove')` 是**注册工具时一次**（不是每次激活），`{passive:true}`，回调只写一个 `{x,y}`。`brush-selection.ts:90-97` 每次移动 2 次 `setAttribute`，量级很小。
- **笔画工具的重入保护**：`brush-selection.ts:64,118`、`lasso-selection.ts:82,102`、`sphere-brush.ts:129,187`、`flood-selection.ts:143` 在选区未完成时吞掉新笔画。
- **`scene/picker.ts:263-350`**：回读已合并成"并集一次读"；`immediate: true` 是 WebGPU 必需（`:168-174` 有说明）；已知代价（单次 59–135 ms）见 6.33 ⇒ 不重复计。
- **`camera/camera-preview.ts` 的 PiP 路径不是每帧**：`:442` 有节流，`:163-164 _pipInterval()` = `max(6, ceil(n/1e6))` ⇒ 93 万点**每 6 帧**、1300 万点**每 13 帧**；`:439` 主视图拖动期间**完全跳过**；`:569-583` 已经做到"只在 resource 引用变化时传 centers"（避免每帧 ~168 MB 拷贝）。回读 320×180×4 = 230 KB/次，可接受。唯一值得清的是 `_cpuDepthSort`（`:1183-1184`）在 worker 不可用回退时每次 `new Uint32Array(n)` + `new Float64Array(n)` = **12 B/点**（13M ⇒ 156 MB/次），改成模块级复用缓冲即可。
- **`rAF` 轮询都有关闭路径**：`ui/gamepad-settings.ts:419,435-440`（只在面板打开时）、`ui/control-customize-dialog.ts:429-450`（只在捕获绑定时）、`workers/surface-worker-client.ts:252-255` / `geometry/surface-analyzer.ts:114-116`（分块让出）、`compare/compare-panel.ts:367-369`（两帧后一次性快照）。
- **全量 DOM 重建只有两处**：`compare/compare-panel.ts:548`、`ui/timeline-panel.ts:315-316`，都发生在**离散事件**（增删/勾选/关键帧提交，最多 4 个模型），且时间轴拖动刻意改成原地改样式、pointerup 才提交 ⇒ 不算热点。`splat-list.ts`、`control-customize-dialog.ts:171-183`、`compare-stats.ts:631-661` 都是增量更新。
- **采样把若干作业压成与模型大小无关**：`compare-stats.ts:47,162-200`（每属性 ≤2000 值）、`tools/shape-fit.ts:80-148`（stride 到 65536 + 记忆化）、`geometry/region-detect.ts:103-111`（5 万法线子集）、`compare-analysis.ts:241,1049`（8k / GRID²·13 上限）、`splat/floater-removal.ts:204-258`（2000 样本估 NN）、`merge/merge-align.ts` 的求解器（采样封顶 ⇒ 与点数无关）。
- **`io/read/file-systems.ts:19-45`**：`BlobReadStream.pull` 按 4 MB 块读并用 `BufferedReadStream(4 MB)` 包装，没有逐行/逐块重新分配。
- **`workers/load-worker.ts:79-94`**：`readAll()` 的容量来自 `expectedSize = end - start`（`read(start=0, end=size)` 默认值），695 MB 是**一次精确分配**，不走 64 KB 起的倍增。
- **`core/serializer.ts`**：只有 `push`，无字符串/JSON。
- **`merge/merge-scene.ts:1699` 的 `inst.sort()`**：是引擎侧 sorter 记账，**不是** JS 逐高斯循环（已对 PlayCanvas 源码核对）。
- **`ui/camera-info-overlay.ts:150-159`（2 个节点）、`ui/bound-dimensions-overlay.ts:62-110`（3 个 SVG 标签）**：每帧写 DOM 但数量有界，判为观感成本而非热点。

### 有界但值得一提的次级项（未进 20 条）

- `workers/surface-worker-client.ts:577-592` 之外的 **`merge/merge-export.ts:72-87`**：同时持有 7 个全尺寸临时数组 + 逐高斯 5 次方法调用的烘焙循环（13M ⇒ 1–2 s）；`:119-122` 混阶 SH 补零要 2.3 GB 清零 + 4.7 GB 拷贝。合并导出峰值内存 ~12 GB（13M/SH3）——这就是合并工具的 OOM 悬崖。
- **`merge/merge-align.ts:729,736,751`**：`raycastPick` 强制 `stride = 1` 且无早退，`merge-scene.ts:1864` 的 mousemove → `:1877 dragMarkerTo` → `:697 pickScreen` + `:708` 第二次 `raycastPick` ⇒ **每次鼠标移动 1–2 遍全扫（13M 上 0.5–1.8 s）**，大场景拖标记会卡死。`:291` 的网格键是模板字符串、每次查询建 27 个键 ⇒ 单次标记对齐 1.5–9 s。
- **`lod/lod.ts:118-125`**：逐列重算 gather 索引（13M 上 ~2.68 亿次 `Math.floor`）；`:218-222` 每级粗层分配 ~1.07 GB。
- **`gamepad/gamepad-controller.ts:239,334`**：`events.on('update')` **每帧**调 `navigator.getGamepads()`（甚至手柄模式关闭时也调，`:282-287` 未命中时调两次）——唯一一个没被门控的 rAF 轮询。
- **`ui/data-panel.ts:671-692,738-744`**：直方图 pointermove → `requestAnimationFrame(() => clampCursorX(align))` 里读 `offsetWidth/clientWidth`，每次移动一次强制布局。
- **`geometry/water-detect.ts:97,117`**：`decodeColor()` 每个 inlier 返回一个新 `[r,g,b]`，两趟 ⇒ 13M inlier 时约 2600 万次分配；`:126-140` 的 `sh` 镜面分支**是死代码**（`GSplatData.getProp` 只搜 `vertex` 元素，SH 在独立的 `sh` 元素里 ⇒ `getProp('sh')` 恒为 `undefined`，内层 O(numSh) 循环从不执行）。

---

## 四、和既有基线的对账

| 场景 | 实测 / 已知 | 本文的账 | 结论 |
| --- | --- | --- | --- |
| 93 万点一次推杆 | 30–43 ms | O1（让出一帧 + 4 次回读）≈ **22–32 ms**；O2/O3 合计 ≈ 8–15 ms | **小模型上"大头是 GPU 同步等待，不是 CPU 遍历"** ⇒ O1 性价比最高，且**不是**超大模型专属 |
| 1300 万点一次推杆 | 556–721 ms | 4 趟 13M 遍历（约 240–400 ms）+ 13 MB 分配/上传（20–50 ms）+ recount（15–30 ms）+ 让帧与 4 次回读（20–200 ms） | 与 6.47 一致（掩码→ranges + 状态位回写 + 上传），本文把"让帧 + 同步回读"**单独列出来**：这部分与点数无关，纯粹是白等 |
| 1300 万点一次屏幕手势 | 774 ms（已优化） | `tailFractions` 采样 ≤40 万点（约 30 ms）+ `selectRange` 一趟全扫 + **2 次** `fromPredicate`（pre+post，120–220 ms）+ 2 次 `setBits` | 手势的 pre/post 两次 `fromPredicate` 建议合成一趟（顺手产出两组 ranges） |
| 大模型/合并场景相机拖动 | 用户主观"还是有一些不顺滑" | `splat.ts:759-787` + `scene.ts:701-724` **每帧**向排序 worker 强制 `postMessage(forceUpdate)`（排序 worker 合并请求，不排大队，所以这**不阻塞主线程**；代价是"显示的顺序永远落后一个排序"，14M 点一次 ~300 ms 见 `render.ts:1488-1490`） | 若"不顺滑"发生在**转相机**时，首要嫌疑是它 + 组拖动路径（清单 3）；但它是**worker 延迟**问题，不是主线程卡顿，故未进 top-5 |
| 13M 环模式框选 | — | 清单 7：Set + 13M 次 `has()` ≈ 80–150 ms | 6.47 说的"掩码→索引区间"在环模式下还多一层 Set |

## 五、建议的动手顺序（如果只做三步）

1. **O1**（`calcBound` 只在该算的时候算）—— 改动最小、两个模型尺寸都受益、易回滚；
2. **O3**（去掉每索引闭包）—— 纯内部 API、风险低、13M 上立省 80–150 ms/推杆；
3. **O2 + O4**（推杆 4 趟合 1 趟；组拖动 tick 降频/子区间上传）—— 13M 上的决定性两刀。

验证道具沿用仓库现成的：`docs/probes/push-perf.cjs`（一次推杆从触发到落地）、
`docs/probes/merged-probe3.cjs`（13M 场景）、`docs/probes/packaged-range12.cjs`（打包版真实鼠标推杆）、
`docs/verify/verify-selection-range.cjs` / `verify-selection-depth-bar.cjs`（双后端语义不能破）。
