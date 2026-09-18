# 选择 / 选区 链路 —— 只读审计（3.21.0，HEAD `f6aec70`）

> **范围**：`select.rect` / `select.byMask` / `select.point` → `runRangeSelection` → `selectRange` /
> `selectRangeFromCache` / `tailFractions` / `RangeProjectionCache` → `SelectRangeOp` → `SplatState`
> → 实时重切（`rangePumpBusy` 循环）→ 三轴四柄面板（`selection-flags` / `range-slider` / `selection-depth-bar`）。
> **只读**：未修改任何既有文件、未 build、未跑测试。本文件是本次唯一新增产物（`docs/audit/_docs-notes.md`
> 是并行采集的"既有文档结论"摘录，用于排除已知项）。
> **已知项不再重复**：`tailMap` 不能夹取、`TAIL_SHARE/TAIL_PERCENT` 尾巴压紧、`MIN_THICKNESS`、
> 最新一次框选复位范围、环模式只用拾取结果不取交/不回退 —— 这些已修且已写进文档（见 `_docs-notes.md` §A）。
>
> **三条最值钱的结论先放在这里**：
> 1. 环模式（rings）下**推任意一根范围滑块，会把 GPU 拾取到的"可见表面集"整体换成解析穿透掩码**
>    —— 用户要的"只选表面"被静默翻转成"整段穿透"。
> 2. **每次推杆都重跑一次 `CalcBound`**：一次 GPU 全量 pass + `waitForGpuDrain()`（= 一次 rAF，
>    实测帧间隔 16.7–18ms）+ 4 次 `immediate:true` 回读，而且是在**持有全局 CommandQueue 时**等。
>    93 万点上"推杆稳态 30–43ms"里，光这一项的下限就 ≈17ms。
> 3. 一次推杆里有 **4 趟 13M 的 JS 全扫**（`selectRangeFromCache` 掩码 → `fromPredicate` → `flush` 的
>    `recount` → 掩码再次分配），加上 GPU pass 与回读。文档点名的 "IndexRanges + 状态位回写 + 上传
>    ≈600ms" 可以再压到 ~1 趟 + 一次上传。

---

## 高

### 1. 环模式下推任何一根范围滑块，会把"GPU 拾取到的表面集"换成"整段穿透"掩码

- **严重度**：高（语义静默翻转，选区规模可能暴涨几个数量级）
- **位置**：`src/app/editor.ts:1147-1163`（环模式分支）、`src/app/editor.ts:1065-1073`（`rangePost`）、
  `src/app/editor.ts:1059-1061`（`surfaceWindow` 空壳）、`src/app/editor.ts:1209`（推杆 `setPost`）
- **问题**：环模式手势把 `hit` 整体替换成拾取结果（去重 id），这是对的。但 `rangeGesture` 同样被记住
  （`editor.ts:1185`），于是**下一次推杆**走的是 `rangePost` → `selectRangeFromCache`（解析路径，
  **没有** surface 过滤，因为 `surfaceWindow()` 永远返回 `{}`）→ `entry.op.setPost(...)` → `do()`。
  结果：推杆把"看得见的表面"重新定义为"沿视轴的整段穿透带"。
- **证据**：
  ```ts
  // editor.ts:1056-1061
  // 环模式下"只选表面"现在走 **GPU id 拾取**（V2 的做法，见 runRangeSelection 里的注释），
  // 1% 薄壳那套近似被否掉了……这个函数保留为空壳，等下次和 keepSurface 一起删掉。
  const surfaceWindow = (entry: RangeEntry) => {
      return {};
  };
  // editor.ts:1065-1073
  const rangePost = (gesture, entry) => {
      const view = rangeView(gesture, entry);          // surfaceEpsilon 恒为 undefined
      const mask = entry.cache
          ? selectRangeFromCache(entry.splat, gesture.region, view, entry.cache)
          : selectRange(entry.splat, gesture.region, view);
      ...
  };
  // editor.ts:1208-1211
  for (const entry of gesture.entries) {
      entry.op.setPost(rangePost(gesture, entry));     // ← 拾取结果在此被覆盖
      await scene.commandQueue.enqueue(() => entry.op.do());
  }
  ```
  可触发路径：环模式是显示开关（`ui/right-toolbar.ts:176`），范围浮条挂在
  `['rectSelection','lassoSelection','polygonSelection','brushSelection','floodSelection']`
  （`ui/selection-depth-bar.ts:30`），与相机模式无关 → 环模式下浮条照常显示、照常生效。
- **影响**：环模式下框选（例如 13M 场景里拾取到几万个可见表面 id）之后，用户随手推一下"最远"，
  选区会变成整段穿透的结果（可以是上千万点）。用户会认为"环模式的表面选择没生效/选区乱跳"。
  同时该 `hit` 的解析结果在环模式下本来就被丢弃（见第 6 条），属于"算了不用、用了又不对"。
- **建议**：
  - 最小改法（1 行）：`SelectionDepthBar` 在 `camera.mode === 'rings'` 时隐藏/禁用三行 range
    （`selection-depth-bar.ts:148-154` 的 `visible` 再加一个条件，并订阅 `camera.mode`）。
  - 正确改法：给 `RangeEntry` 加 `ringPick: Uint8Array | null`（就是被覆盖前的 `hit`）与
    `picked: boolean` 标志；`rangePost` 里当 `ringPick` 非空时，用**同一个缓存**做
    "窗口/深度/形状"判定，再与 `ringPick` 取交（`pick && window`），这样三轴四柄在环模式下仍能
    "只裁拾取到的表面"，语义与中心模式一致且不丢表面过滤。
  - **预期收益**：消除一类静默错误选区；正确改法还能让环模式支持深度收窄。
  - **风险**：取交后用户可能觉得"框住了却没选到"（V2 曾经因为"取交"被用户否过，见 `_docs-notes.md` A2-2）
    → 折中：环模式用 `pick` 做**唯一来源**，range 只做"收窄"且默认整段（等价于本次手势），
    或直接采纳上面的"最小改法"。

### 2. `select.byMask` 用 `alpha > 0`，而快速填充（flood）把"未访问"写成 102 → 快速填充实际选中整个视口

- **严重度**：高（工具功能性错误，且没有任何报错）
- **位置**：`src/app/editor.ts:1275-1282`（区域判定）、`src/app/editor.ts:1259-1270`（alpha 提取 +
  包围盒）、`src/tools/flood-selection.ts:83`（`d.fill(102)` 哨兵）
- **问题**：flood 的 BFS 用 **alpha=102** 表示"尚未访问"：
  ```ts
  // flood-selection.ts:81-99
  const d = imageData.data;
  d.fill(102);                                  // 注意：4 个通道全部填成 102，含 alpha
  while (testPixels.length > 0) {
      if (Math.abs(data[idx + 3] - pickedOpacity) < threshold * 255) {
          d[idx + RED] = 255; d[idx + BLUE] = 0; d[idx + ALPHA] = 255;
          if (current.x > 0 && d[idx - PIXEL + ALPHA] === 102) testPixels.push(...);   // 只从"匹配"像素扩散
          ...
      } else {
          d[idx + ALPHA] = 0;
      }
  }
  ```
  只有"被 BFS 弹出过"的像素才会变成 255 或 0；**扩散只发生在匹配像素上**，所以非匹配区的外围
  （除了一圈 1 像素厚的 0 前沿）**全部保持 alpha=102**。而 `select.byMask` 的判定是：
  ```ts
  // editor.ts:1275-1282
  contains: (px, py) => {
      ...
      return alpha[my * cw + mx] > 0;      // 102 > 0 → 判为"在选区内"
  }
  ```
  于是"选区"= 泛洪区域 ∪ **所有没被访问到的像素**；顺带 102 像素也算"非空"，导致包围盒
  （`editor.ts:1259-1270`）恒为**整个画布** → 外窗 = 整个视口。
- **回归证据**（同一处代码的上一次实现用红通道严格比较，是对的）：
  ```
  git log -S "alpha[my * cw + mx]"  →  4ce908d
  -  if (mask.data[(my * mask.width + mx) * 4] === 255) {        // 旧：红通道 === 255
  +  return alpha[my * cw + mx] > 0;                             // 新：alpha > 0
  ```
  旧写法对套索/笔刷（`#f60` → R=255）与 flood（命中 R=255、未访问 R=102）**都是对的**；
  改成 alpha 后套索更宽容（抗锯齿边算进去，这是好事），但 flood 的 102 哨兵被判成"内部"。
- **影响**：快速填充工具在 `set` 模式下变成"选中视口内全部未锁定高斯"（≈ 全选），
  `add` 变成"全加"、`remove`/`intersect` 语义同样错；只有 flood 自己画出来的 255 那圈是"对的"。
- **建议**（任一，建议 A）：
  - A（1 行、零风险）：`flood-selection.ts` 在 `putImageData` 之前把残留哨兵清成"外部"：
    ```ts
    for (let i = 3; i < d.length; i += 4) { if (d[i] === 102) d[i] = 0; }
    ```
  - B：`select.byMask` 的 `contains` 改成 `alpha[...] === 255 || (alpha[...] > 0 && alpha[...] !== 102)`
    —— 不推荐，等于把 flood 的实现细节泄漏到通用路径。
  - C（更彻底）：flood 改用红通道做哨兵（`d[i*4]`），alpha 只表达"内/外"，并在拒绝分支把红也清 0。
  - **预期收益**：修复 5 个使用 `select.byMask` 的工具里最严重的一个语义错误。
  - **风险**：A 之后，flood 若点击在空白处（`pickedOpacity` 越界 → NaN）会选成空集而不是全选
    —— 那时应顺手补一个"种子像素越界/无几何则直接返回"的守卫。

### 3. 每次推杆都重跑 `CalcBound`：GPU 全量 pass + 一次 rAF 等待 + 4 次 `immediate` 回读，且全程占着全局 CommandQueue

- **严重度**：高（性能；直接解释了"推杆 30–43ms"的下限，并在大模型上放大）
- **位置**：`src/core/edit-ops.ts:227-236`（`SelectRangeOp.do`）、`src/splat/splat.ts:536-553`
  （`updateState`）、`src/splat/splat.ts:1067-1068`、`src/data-processor/calc-bound.ts:182-208`、
  `src/data-processor/gpu-readback.ts:26-33`
- **问题**：`SelectRangeOp.do()` 末尾 `await this.splat.updateState(State.selected)`；`updateState` 在
  `changedState` 不含 `deleted` 时**无条件** `await this.updateLocalBounds()`：
  ```ts
  // splat.ts:536-553
  async updateState(changedState = State.selected) {
      this.state.flush();                       // 全量上传 + recount（见第 8 条）
      ...
      if (changedState & State.deleted) { await this.updateSorting(); }
      else { await this.updateLocalBounds(); }  // ← 只是选中位变了，也要跑
  }
  // calc-bound.ts:182-208
  await waitForGpuDrain();                      // requestAnimationFrame → 至少一整帧
  const reads = await Promise.allSettled([ ... 4 × texture.read(..., { immediate: true }) ]);
  ```
  而 `updateLocalBounds` 的结果里，**只有 `selectionBound` 与选中位有关**；`localBound` 在
  bound-shader 里是"跳过 deleted 的全部高斯"（`shaders/bound-shader.ts:42,66-68`），
  **与 selected 位无关**，所以这次 pass 对 localBound/worldBound 是纯重算。`selectionBound`
  的唯一消费者是 `Splat.getPivot(mode:'boundCenter', selection:true)`（`splat.ts:1302`，即变换手柄的
  枢轴参考）——拖动过程中根本不需要它每帧都是新的。
- **影响（量化）**：
  - 每次推杆的下限 = **一帧**（文档实测帧间隔稳定 16.7–18ms）→ "93 万点推杆稳态 30–43ms"里
    约一半是**等**，不是算；13M 上还要加一次 13M 高斯的 GPU 归约 pass + 4 次同步回读 + JS 归约。
  - `waitForGpuDrain` 期间**持有 `scene.commandQueue`**（推杆是
    `await scene.commandQueue.enqueue(() => entry.op.do())`，`editor.ts:1210`），
    所以这一帧的等待会把**紧接着的新框选手势、其它编辑、GPU 回读任务全部排队堵住**
    → 表现为"推杆时整个编辑器卡一下"。
  - 多 splat（多图层）时是**串行**的，每个图层各等一帧。
- **建议**：
  - 主方案：把 bounds 计算从关键路径上摘下来 —— `updateState` 只做 `flush()`，把
    `updateLocalBounds()` 标成 `boundsDirty`，由渲染循环/`CommandQueue` 尾部**每帧最多合并一次**
    （fire-and-forget，带"in flight 就跳过"的守卫）。这样枢轴仍然新鲜，但推杆不再等 GPU。
  - 保守方案（改动最小、可回退）：`SelectRangeOp.do()` 走
    `updateState(State.selected, { bounds: false })`，只在手势结束时补一次完整
    `updateState`（在 `range-slider.ts` 的 `endDrag` 里发一个 `selection.rangeSettled`，
    或在推杆循环静默 150ms 后由一个定时器补算）。
  - **预期收益**（估算，未实测）：每次推杆直接省掉 ≥1 帧 + 一次 GPU pass + 4 次回读；
    93 万点预计 30–43ms → **15–22ms**；13M 上每次推杆省 **100–300ms** 量级，并且
    "推杆卡住其它编辑"的现象消失。
  - **风险**：`getPivot('boundCenter', selection:true)` 与 `worldBound` 在拖动期间会短暂过期；
    必须在手势结束时（以及任何 `edit.add` 之后）保证补算一次，否则变换手柄的枢轴会落在旧位置。

### 4. 一次推杆 4 趟 13M 全扫：掩码 → 索引区间 → 状态位 → 计数（文档点名的 ~600ms 主成分）

- **严重度**：高（性能；这是文档 `6.47:1988-1990` 已经点名但未做的那一项，下面给出可落地的分解）
- **位置**：`src/app/editor.ts:1065-1073`、`src/splat/selection-range.ts:454-509`、
  `src/core/index-ranges.ts:47-64`、`src/core/edit-ops.ts:227-236`、`src/splat/splat-state.ts:87-105`、
  `src/app/editor.ts:1126-1131` 与 `1164-1165`
- **问题**：同一份事实被算了 3–5 次，而且每次都新建大数组：
  ```ts
  // ① 推杆路径：一趟掩码 + 一趟 fromPredicate（闭包调用 13M 次）
  editor.ts:1067-1072
    const mask = selectRangeFromCache(...)                    // selection-range.ts:462 new Uint8Array(numSplats) = 13MB
    return IndexRanges.fromPredicate(n, i => combine(preMask[i] !== 0, mask[i] === 255));
  // ② 手势路径：preMask 一趟、pre 一趟、post 一趟（pre 与 preMask 是同一个谓词，白算一趟）
  editor.ts:1126-1131  preMask 循环
  editor.ts:1164       const pre  = IndexRanges.fromPredicate(n, i => preMask[i] !== 0);
  editor.ts:1165       const post = IndexRanges.fromPredicate(n, i => combine(preMask[i] !== 0, hit[i] === 255));
  // ③ 应用：三次区间遍历 + 区域数组转换
  edit-ops.ts:229-233  clearBits(pre) / clearBits(applied) / setBits(post)
  splat-state.ts:52-56 ranges.forEach(i => { data[i] |= mask; ... })   // 再各来一趟
  // ④ 上传后 recount 又一趟全量
  splat-state.ts:92-101 for (let i = 0; i < data.length; ++i) { ... }
  ```
  另外 `IndexRanges.fromPredicate` 先往 **JS `number[]`** 里 push，再 `new Uint32Array(ranges)`：
  选区在索引上分散时（例如隔一个选一个）这个数组能到 n/2 个元素 → 数十 MB 的临时数组 + 倍增扩容 + 拷贝。
- **影响**：13M 上每次推杆 ≈ 4 趟全扫（掩码 / fromPredicate / clearBits+setBits 的区间遍历 /
  recount）+ 13MB 掩码分配 + 13MB 上传 + GPU pass（第 3 条）。按 20–40ns/点的闭包遍历估算，
  这正好落在文档实测的 **556–721ms** 区间。93 万点上对应 30–43ms 里的 ~15–20ms。
  每推杆 13MB 的掩码分配在连续拖动下是 ~数百 MB/s 的 GC 压力。
- **建议**（把"掩码 → 区间 → 状态位"压成**一趟**）：
  1. 让 `SelectRangeOp` 直接持 **`Uint8Array` 掩码**（pre / post / applied），
     并在构造/更新时**同时**记录 `[lo, hi]` 脏区间（一趟即可得到）。
  2. `do()` 改成"在 `[lo, hi]` 上做一次按位更新"：`state.data[i] = (state.data[i] & ~sel) | (post[i] ? sel : 0)`，
     用 `SplatState.applyMask(mask, lo, hi)` 承载，`markDirty(lo, hi)` 顺带完成；
     `IndexRanges` 只保留给其它 op（去浮云 / 簇过滤 / 删除），不动它的公共契约。
  3. `recount` 在同一次遍历里**增量**维护 `numSelected`（进入/离开选中态的差值），
     `flush()` 时不再重算整张表。
  4. `mask` 用**每个 entry 一份的复用缓冲**（`entry.scratch`），不要每推杆 `new Uint8Array(n)`。
  5. 顺手合并 `pre`/`preMask`（`editor.ts:1164`）：填 `preMask` 时直接生成区间。
  6. 上传仍是 13MB 全量（见第 8 条），但已经只剩 **1 趟 JS 全扫 + 1 次上传**。
- **预期收益**（估算，未实测）：13M 上每次推杆 **~600ms → ~150–250ms**；93 万点
  **30–43ms → ~15–20ms**。与第 3 条叠加后，"推杆基本跟手"在 13M 上才有可能。
- **风险**：`SelectRangeOp` 的"pre/post/applied 三快照"语义是修过的坑（`_docs-notes.md` A1-7），
  换表示时必须逐位保持"清掉上一次 applied 再写 post"的行为；建议用 `docs/verify/verify-selection-range.cjs`
  （24 项）+ `verify-selection-depth-bar.cjs`（19 项）双后端回归。
  局部化在 `SelectRangeOp` + `SplatState` 内部、不动 `IndexRanges`，风险可控。

### 5. 环模式拾取：`pw × ph` 的 JS 数组 + `Set` + O(numSplats) 次 `Set.has`

- **严重度**：高（大框会瞬时分配数百 MB 并卡住数秒，最坏 OOM）
- **位置**：`src/app/editor.ts:1149-1161`、`src/scene/picker.ts:177-188`
- **问题**：
  ```ts
  // picker.ts:177-188
  const result: number[] = [];
  for (let i = 0; i < pw * ph; i++) { result.push(...); }      // 框内每个像素一个元素
  // editor.ts:1155-1161
  const picked = new Set<number>();
  for (let i = 0; i < pick.length; i++) picked.add(pick[i]);   // 去重
  for (let i = 0; i < numSplats; i++) hit[i] = picked.has(i) ? 255 : 0;   // 13M 次哈希查询
  ```
  `pw × ph` **没有上限**：环模式下把整屏框一遍，1080p 是 2.07M、4K 是 8.29M 个元素。
  （拾取目标是**全渲染分辨率**的纹理：`camera.ts:745,774-778` 的 `workTarget` 就是
  `scene.targetSize` 大小，所以 `pw × ph` 上限就是整屏像素数。）
- **影响**：
  - `pick` 是装箱的 JS `number[]`（2M ≈ 16MB、8M ≈ 65MB+），`Set` 里最多 2M/8M 个条目
    （哈希表 ≈ 数十~数百 MB）——每次框选都重建一次。
  - `hit` 那趟循环是 13M 次 `Set.has`（约 50–100ns/次）→ **0.7–1.3s**，纯粹为了把集合变成掩码。
  - 加上 GPU 端 8M 像素 × 4B 的回读（33MB）与 `immediate` 同步等待。
- **建议**：
  - 让 `readIds` 支持"就地写入调用方提供的 `Uint8Array`/`Uint32Array` 存在位图"
    （或返回 `Uint32Array` 而不是 `number[]`），先把 `pick` 折进 `Uint8Array(numSplats)` 存在位图
    （O(pixels)），再把 `hit[i]` 直接从存在位图取（O(n) 次**数组读**而不是哈希查询）；
    更进一步：把"存在位图 → hit 掩码"和后面的 `fromPredicate` 合并成一趟（第 4 条）。
  - 顺手做面积守卫：框面积超过阈值（例如 4M 像素）时按 `stride` 抽样读取，或提示"环模式下请框小一点"。
  - **预期收益**：环模式大框从"秒级 + 数百 MB"降到"几十 ms + 一个 13MB 位图"。
  - **风险**：`readIds` 是公共 API（`camera.pickRect` 还有人用，`editor.ts:1408`），
    改签名要保留兼容重载。

---

## 中

### 6. 环模式下仍然白跑整条解析路径（尾巴分析 + 全量投影 + 104MB 投影缓存），结果立刻被丢弃

- **严重度**：中（性能；13M 上每次框选白花 ~300–400ms 与 ~104MB）
- **位置**：`src/app/editor.ts:1110-1135`（解析路径）对比 `src/app/editor.ts:1147-1163`（拾取分支）
- **问题**：`tailFractions`（≤40 万点采样）、`new Uint8Array(numSplats)` 的 `preMask`、
  `createRangeCache(numSplats)`（13M → 26+26+52 = **104MB**）、`selectRange(...)`（全量投影 +
  写缓存 + 建掩码）都在 `if (events.invoke('camera.mode') === 'rings')` **之前**执行；
  随后 `hit` 被拾取结果整体覆盖：
  ```ts
  const cache = createRangeCache(numSplats);        // 13M → 104MB
  const hit = selectRange(splat, region, view, cache);   // 13M 全量投影 + 一趟掩码
  if (events.invoke('camera.mode') === 'rings') {
      ...
      for (let i = 0; i < numSplats; i++) hit[i] = picked.has(i) ? 255 : 0;   // hit 全废
  }
  ```
  只有 `cache`（后续推杆要用，见第 1 条的建议）是唯一还有价值的产物。
- **影响**：13M 上每次环模式框选多花 ≈ 40 万点采样扫 + 13M 全量投影（文档：投影是手势的主要成本之一）
  + 104MB 常驻，全部丢弃。
- **建议**：把环模式分支提前到解析路径之前；解析路径只保留
  "填缓存 + `preMask`"（给第 1 条的正确改法留接口），跳过 `tailFractions` 与
  `selectRange` 的窗口判定（缓存可以只填 `sx/sy/dist`，那本来就是投影的开销，无法省；
  但**窗口/形状/尾巴**那部分可以整段跳过，省掉一趟掩码 + 直方图）。
  若采纳第 1 条的"最小改法"（环模式隐藏 range），则环模式下可以连缓存都不建 → 省 104MB。
- **预期收益**：每次环模式框选省 ~30–100ms（13M）与最多 104MB 常驻。
- **风险**：低（纯提前返回/条件化）。

### 7. 套索"空手势"（在视口点一下就松手）以 `set` 提交 → 清空整个选区 + 多一条无效撤销

- **严重度**：中（丢用户数据感很强，且会污染历史）
- **位置**：`src/tools/lasso-selection.ts:107`（`pointerdown` 必定 `update(e)` 推第一个点）、
  `src/tools/lasso-selection.ts:131-144`（`pointerup` 无条件 `commitSelection`）、
  `src/app/editor.ts:1271`（`empty` 判定）、`src/app/editor.ts:1287-1292`（`empty` 时传退化框）
- **问题**：
  ```ts
  // lasso-selection.ts:95-111 + 131-144
  pointerdown → update(e) → points.push(第一个点)   // 单点
  pointerup   → await commitSelection(e)            // 无 dragMoved 判断，照常提交
  // 单点路径 fill() 画不出任何像素 → alpha 全 0
  // editor.ts:1271
  const empty = bx1 < bx0 || by1 < by0;             // true
  // editor.ts:1287 仍把退化框交给 runRangeSelection
  empty ? { x0: 0, y0: 0, x1: 0, y1: 0 } : {...}
  // editor.ts:1165 → post = combine(preMask, false) → 'set' 模式 post 为空
  ```
  `empty` 只被用来"把框设成 0"，没有用来"提前返回"。
- **影响**：套索工具下误点一下空白处 = 选区被清空（并写入一条什么都没干的撤销步）；
  若同时按着 Shift/Ctrl，语义还会变成无意义的 add/remove。
- **建议**：`commitSelection` 里 `if (empty) return;`（在 `select.byMask` 里做更稳：
  `if (empty) { return; }` 紧跟在 `const empty = ...` 之后），或让套索要求
  `points.length > 2 && 有点间距` 才提交（多边形已经是这个规矩：`polygon-selection.ts:119,128`
  要求 `points.length > 2`）。
- **预期收益**：消除一类"选区莫名消失"。
- **风险**：极低；注意别把"用户确实想用空选区清空"的路径一起堵了（那应该走"选择→无"按钮）。

### 8. `flush()` 全量上传 + `recount()` 全量重算：dirtyLo/Hi 已经算了却没用

- **严重度**：中（性能；文档点名的"状态位回写 + 上传"里可以直接砍掉的 O(n)）
- **位置**：`src/splat/splat-state.ts:109-121`、`src/splat/splat-state.ts:87-105`
- **问题**：
  ```ts
  flush(): void {
      if (this.dirtyLo < 0) return;
      // full upload. sub-rect upload is a worthwhile future optimisation ...
      const buffer = this.gpu.lock() as Uint8Array;
      buffer.set(this.data);        // 13M 模型 = 13MB 的整块拷贝 + 整张纹理上传
      this.gpu.unlock();
      this.recount();               // 又一趟 13M
      ...
  }
  ```
  `setBits/clearBits` 已经维护了 `[dirtyLo, dirtyHi)`，但上传与计数都按整表来。
- **影响**：每次推杆 = 13MB memcpy + GPU 上传 + 13M 计数遍历（估算 30–60ms/次，13M）。
  小选区（几百点）也传 13MB。
- **建议**：
  1. `recount` 改成**增量**：由 `setBits/clearBits` 的区间回调同时结算
     "进入/离开选中位"的数量（与第 4 条第 3 点同一趟）；非增量路径保留 `recount` 兜底。
  2. 上传至少按 `[dirtyLo, dirtyHi)` **按行**做子矩形上传（纹理宽 2048 的 R8，
     行对齐到 2048 的倍数 → 一次 `sub-rect` 上传），或在"脏区间占比 > 50%"时才走全量。
  3. **预期收益**：13M 上每次推杆省 ~30–60ms 与 13MB 传输；小选区省得更多（KB 级）。
  4. **风险**：子矩形上传需要引擎侧支持（源码注释已写明），先做增量计数是零风险的。

### 9. 投影缓存上限 2400 万：超过即"每次推杆退回全量重投影"（~900ms 级悬崖）

- **严重度**：中（性能悬崖 + 内存峰值）
- **位置**：`src/splat/selection-range.ts:284-294`、`src/app/editor.ts:1067-1069`、`src/app/editor.ts:1134`
- **问题**：`createRangeCache` 在 `numSplats > CACHE_MAX_SPLATS (24M)` 时返回 `null`，
  于是 `rangePost` 走 `selectRange(...)`（无缓存）→ **每次推杆重新投影全部高斯**，
  也就是源码注释里的 "840–1016ms/次"。用户的 13,007,105 点已在阈值的 54%。
  另外缓存是 8B/点常驻在 `RangeEntry`（13M = 104MB；24M = 192MB），新手势开始时
  `rangeGesture = null`（`editor.ts:1089`）后旧缓存变垃圾、新缓存立刻分配 → 瞬时翻倍。
- **影响**：30M 级模型上"推杆"退化成"每推一下等 1 秒"；13M 上 104MB 常驻 + 峰值 ~200MB。
- **建议**：
  - 把缓存降到 4B/点也可行：`sx/sy` 已用 `Int16`（4B），真正的开销是 `dist` 的 `Float32`；
    可以只存"沿视轴距离的 16 位量化值（相对 `extent` 归一化）"（1e-4 相对精度足够做百分比判定），
    总量 6B/点甚至 4B/点（`sx`/`sy` 也可按框内局部坐标量化）。
  - 或对超阈值模型走"**降采样缓存 + 全量兜底**"：缓存只覆盖框内 stride 采样点，
    推杆时对区间内未采样点做一次投影（把 900ms 降到 ~100ms 量级）。
  - 至少应在 `createRangeCache` 返回 `null` 时**给出可见反馈**（面板上禁用三轴或提示
    "此模型过大，范围重切不可实时"），而不是静默变成 1 秒一次。
  - **收益**：13M 上内存减半；30M 级模型从"1 秒/次"到可交互。**风险**：量化精度影响 0/100 两端的
    判定，必须用 `verify-selection-range` 的边界用例（`far 100→90→85` 那组）回归。

### 10. `keepSurface` / `selection-band` / `SURFACE_SHELL` / `RINGS_SURFACE_PCT` / `selectDepthBand` 全是死代码（并解答文档 §F1）

- **严重度**：中（维护性 + 潜在性能陷阱；同时是文档里挂着的"待核"项）
- **位置**：`src/splat/selection-range.ts:65,441-444,504-506,520-547`、`src/app/editor.ts:19,35,38,1056-1061`、
  `src/splat/selection-band.ts:62`
- **问题（已核实为不可达）**：
  - `surfaceEpsilon` 的唯一写入点是 `surfaceWindow()`，它**永远返回 `{}`**（`editor.ts:1059-1061`），
    `SURFACE_SHELL`（`editor.ts:35`）与 `RINGS_SURFACE_PCT`（`editor.ts:38`）**零引用** →
    `selectRange` / `selectRangeFromCache` 里的 `if (view.surfaceEpsilon !== undefined)` 恒假
    → `keepSurface` 不可达。
  - `selectDepthBand` 在 `editor.ts:19` 被 import，但**全文无调用**；`selection-band.ts` 只剩定义。
  - 也就是说：源码注释（`selection-range.ts:63`、`editor.ts:1056-1058`）仍然写着
    "环模式下只选表面见 keepSurface / 等下次和 keepSurface 一起删掉"，但实际链路是 GPU 拾取。
- **影响**：注释与实现相反，是下一次改动的直接陷阱。而且 `keepSurface` 一旦被重新接线就是性能雷：
  ```ts
  // selection-range.ts:528
  const nearest = new Float32Array(width * height).fill(Infinity);   // 3840×2160 → 33MB/次
  ```
  外加两趟 O(n)（建最近深度图 + 过滤），且在 `selectRangeFromCache` 里用的是**当前 view**的
  `width/height` 去索引**手势时**填的缓存（一旦支持窗口缩放/分辨率切换，`cys[i]*width + cxs[i]`
  就可能越界 —— 现在因为两者同源所以恰好安全）。
- **建议**：按 `editor.ts:1056-1058` 的原计划删除：`surfaceWindow`、`surfaceEpsilon` 分支、
  `keepSurface`、`SURFACE_SHELL`、`RINGS_SURFACE_PCT`、`selectDepthBand` 的 import，
  以及"留作参考或删掉"的 `selection-band.ts`；注释改成"环模式只选表面 = GPU id 拾取
  （editor.ts:1147）"。`docs/进度存档.md:55` 与 `docs/V3-WebGPU-现状.md:6.36:1328` 的
  矛盾也随之消解（结论：**确已不可达**）。
- **预期收益**：消掉一次"照着注释去改就踩空"的风险；若将来恢复"只选表面"，必须同时给出
  "每像素深度图用 `Uint16`/降采样"的方案，否则 33MB/次。
- **风险**：删除是不可逆的信息损失（但那两套方案已被用户否掉，见 `_docs-notes.md` A2-7）。

### 11. 面板：任一轴变化都重写三行 + 每行 `render()` 触发 3 次强制布局；链式约束有两套实现

- **严重度**：中（UI 性能 + 双份真相的维护风险）
- **位置**：`src/ui/selection-depth-bar.ts:107-145`、`src/ui/range-slider.ts:196-210,319-355,357-398`
- **问题（性能）**：
  ```ts
  // selection-depth-bar.ts:119-128  任一次事件都把三行全写一遍
  depth.value = {...}; horizontal.value = screen.x; vertical.value = screen.y;
  // 每个 value setter → commit() → render()
  // range-slider.ts:258-266  render() 内部读布局
  private trackWidth() { const rect = this.trackRect(); ... }         // getBoundingClientRect
  private blockWidth() { const w = Math.max(this.labels.low.dom.offsetWidth, ...); }  // offsetWidth ×2
  // range-slider.ts:386-397  然后写一堆 style.left/width
  ```
  每次 `pointermove`：`setHandle → commit → render`（读布局+写样式）→ `onChange` → 事件 →
  `sync()` → 三行 `value` setter → 各一次 `commit → render`（**共 4 次 render、约 9–12 次布局读**，
  全部是"写样式 → 读布局"交替的强制重排）。
- **问题（双份真相）**：`selection-flags.ts:77-106` 的 `normalize()` 与
  `range-slider.ts:319-355` 的 `commit()` 各自实现了一遍
  `outerLow ≤ low ≤ high ≤ outerHigh` + `MIN_THICKNESS` 修复。目前两边的边界行为恰好一致
  （我逐条对过 `low=150`、厚度 0.1、外柄越界三种情形），但任何一边单独改动都会让
  "拖柄的手感"与"API 改值的语义"分叉（文档明确承诺两者一致：`HANDOFF.md:170-172`）。
- **建议**：
  1. `sync()` 按事件来源只刷新**被改的那一轴**（`selection.depthRange` → 只写 depth 行；
     `selection.screenRange` → 写 x/y 两行），或用 `RangeSlider.setValueQuiet(raw)` 在
     `_value` 与传入值逐位相同时**直接 return**（现在 `commit()` 无条件 `render()`）。
  2. `render()` 里把 `getBoundingClientRect()` / `offsetWidth` 的结果缓存在 `pointerdown`
     （轨道宽度在拖动期间本来就冻结）→ 每次 `pointermove` 零布局读。
  3. 链式约束**只留一套**：`selection-flags.ts` 目前只导出
     `registerSelectionFlags / getDepthSelection / getScreenSelection / getDepthRange / getScreenRange / LIMITS`，
     `normalize()` 是模块私有的 → 把它（连同 `round1`、`MIN_THICKNESS` 语义）导出为纯函数，
     `range-slider.commit()` 与 `setHandle()` 改为调用它，拖动时也走同一条路径。
  - **预期收益**：拖动时的布局开销与主线程抖动明显下降（三行面板 + 每次推杆本来就重）；
    手感/语义分叉风险消除。**风险**：缓存轨道宽度需要处理"面板布局变化/窗口 resize"，
  用 `pointerdown` 时冻结即可（与现在的 `dragView` 冻结是同一时机）。

### 12. 轨道端点之后"值继续变、滑块不动"：面板与实际选区脱钩（无任何反馈）

- **严重度**：中（手感/状态不同步；用户会以为"推到头就不动了"，但选区其实还在变）
- **位置**：`src/ui/range-slider.ts:206-209,273-277,372-379`、`src/core/selection-flags.ts:33-37`
- **问题**：窗口由**芯的厚度**决定，与值域无关：
  ```ts
  // range-slider.ts:273-277
  const inner = Math.max(this._value.high - this._value.low, MIN_THICKNESS);
  const span = inner / (HOME_HIGH - HOME_LOW);         // = inner / 0.6
  this.view = { min: this._value.low - span * 0.2, max: this._value.low + span * 0.8 };
  ```
  而值域是 `[-50, 150]`（`selection-flags.ts:33-37`）。默认 `0/100` 时窗口是
  `[-33.3, 133.3]`：`[-50,-33.3]` 与 `[133.3,150]` 这 **33.3 个单位（值域的 1/6）** 里，
  `fractionOf()` 被 `clamp(,,0,1)` 压到端点 → 滑块**钉在轨道两端不动**；而拖动的值来自
  `dragGrabValue + nudge(dx)`（非线性，推满一屏可走 ~57 个单位），所以**值在继续跑**。
  芯越薄越严重（`inner=0.1` 时 `span=0.167`，窗口只有 `low±0.13`，其余行程全是"视觉冻结"）。
- **影响**：推到轨道端点后选区继续变化但面板纹丝不动 —— 用户无法判断"到底有没有生效"、
  "还能不能继续扩"；这与本面板"没有数字、块的位置就是唯一读数"的设计前提直接冲突。
- **建议**（按 D-5 不引入数字）：
  - 让"钉住"同时**限住值**：`pointermove` 里当 `dragFraction` 被 clamp 时，把
    `setHandle` 的输入也 clamp 到窗口在该端的值（或按超出比例衰减 nudge），
    这样"滑块不动"就真的"值不动"，行为可解释；代价是扩到框外 -50/150 的手感需要重新标定。
  - 或反之：让 `view` 至少覆盖值域在滑块可达的那一段（`span` 取 `max(inner/0.6, (limitMax-limitMin)/2)`），
    让两端也有位移反馈 —— 但会压缩中间段的精度（与 A1-16 的结论冲突）。
  - 至少给"已到端点"一个视觉状态（`.at-limit` 类：方块变空心/轨道端高亮），成本 ~5 行 CSS+JS。
  - **风险**：任何改法都会动到已经反复调过的手感（3.9.0–3.16.0 多轮），建议先只加
    "at-limit"视觉提示，把限值方案留给用户拍板。

---

## 低

### 13. 环模式点选把可能为负的矩形交给 `pickRect`（越界回读）

- **严重度**：低（只在环模式 + 画面边缘 3px 内触发；但可能直接抛错 → 那次选择静默变成空集）
- **位置**：`src/app/editor.ts:1367-1380`（`select.point` 的 bounds 未夹取）、
  `src/scene/picker.ts:158-165`
- **问题**：
  ```ts
  // editor.ts:1371-1380
  const slack = 3;
  await runRangeSelection( ..., { x0: clickX - slack, y0: clickY - slack, x1: clickX + slack, y1: clickY + slack });
  // editor.ts:1149-1154（环模式）
  const pick = await scene.camera.pickRect(bounds.x0 / pose.width, bounds.y0 / pose.height, ...);
  // picker.ts:159-165
  const px = Math.floor(x * rt.width);              // x < 0 → px = -1 / -2
  const texY = this.device.isWebGL2 ? rt.height - py - ph : py;   // py < 0 → texY 也可能越界
  const pixels = await colorBuffer.read(px, texY, pw, ph, {...});
  ```
  `clickX/clickY` 被夹在 `[0, width-1]`，但 `bounds` 没有 → 在画面左/上边缘 3px 内，
  `px`/`py` 为负；`select.rect` 的 bounds 因为工具侧已经 `clamp01`（`tools/rect-selection.ts:84,91-92`）
  不会越界，`select.byMask` 的 bounds 由 bbox 反算也非负 —— 只有 `select.point` 会越界。
- **影响**：WebGL2 下是 `INVALID_VALUE`（结果未定义/被静默忽略）；WebGPU 下负原点的
  `copyTextureToBuffer` 可能抛错 → `pickRect` 拒绝 → `pick` 为空 → 拾取分支把 `hit` 全写 0 →
  `set` 模式下**选区被清空**（且无任何提示）。
- **建议**：在 `select.point` 里对 bounds 做 `Math.max(0, Math.min(width, ...))` 夹取
  （与 `clickX` 一致的夹取范围），或在 `readIds` 入口统一
  `px = max(0, ...)` / `py = max(0, ...)` / `pw = min(rt.width - px, ...)`。
- **预期收益**：消除一个 3px 边缘的"点了没反应/选区被清"。
- **风险**：极低。

### 14. `tailFractions` 与 `selectRange` 对同一批高斯各投影一次（同一手势两趟）

- **严重度**：低（性能，13M 上 ~30ms/手势）
- **位置**：`src/app/editor.ts:1110`（`tailFractions`）与 `src/app/editor.ts:1135`（`selectRange`）、
  `src/splat/selection-range.ts:153-249`
- **问题**：`tailFractions` 用 `stride = max(1, floor(n / 400000))` 采样（13M → 每 32 个取 1），
  在采样点上做**与 `selectRange` 完全相同**的 local→world→VP 投影 + 像素取整 + `contains`，
  只为填三个 512 桶直方图。同一份投影在几毫秒后又对全量点算了一遍。
- **影响**：13M 上每次手势多花一趟 40 万点投影 + 13M 次 `px/py/pz` 随机访问（文档：尾巴分析
  从 1.5s 优化到 ~30ms —— 也就是这 30ms 目前是"纯重复"）。
- **建议**：把三轴直方图**并进填缓存的那一趟**（`selectRange(..., cache)` 的循环里
  `if (i % stride === 0) { 直方图累加 }`），然后把"建掩码"整个换成
  **先算尾巴 → 再用缓存建掩码**（即第一次掩码就直接走 `selectRangeFromCache` 的路径）。
  代价是手势变成"一趟投影+直方图"加"一趟缓存比较"（后者本来推杆就要跑），
  净省一整趟 40 万点投影与一趟全量投影（因为掩码也从缓存来）。
  - **预期收益**：13M 手势 ~774ms 里省下 ~30ms 采样扫，并让"手势"与"推杆"共用同一条掩码路径
    （也顺势让第 1 条的改法更自然）。
  - **风险**：`tailFractions` 的 `counted < 200 → 线性` 退化判定依赖"框内采样点数"，
    改成 `i % stride` 后采样相位是固定的（当前 `i += stride` 也是固定的，语义不变）；
    需要重跑 `verify-selection-range` 的"第一下推杆恒 ~2%"用例。

---

## 附：核对过但**未发现**问题的点（避免重复劳动）

| 项 | 结论 | 依据 |
| --- | --- | --- |
| 归一化 vs 像素坐标 | **一致**。工具侧一律"CSS 像素 → `/clientWidth` 归一化"，`editor` 侧一律 `× scene.targetSize`（=`graphicsDevice / camera.pixelScale`，渲染分辨率）；`scene.targetSize` 每帧在 `onPreRender` 刷新，与相机投影矩阵同源 | `tools/rect-selection.ts:84-100`、`editor.ts:1230-1234,1368-1370`、`scene.ts:729-730`、`camera.ts:1199-1204` |
| Y 轴上下颠倒 / 后端翻转 | **一致**。CPU 投影用 `sy = (1 - (ndcY*0.5+0.5))*height`（左上原点）；区域坐标来自 `offsetY`（左上）；`picker.readIds` 对 WebGL2 显式做 `texY = rt.height - py - ph`（因为纹理原点在左下），WebGPU 直接用 `py` → 两边输入同约定、行序同向。环模式只把结果收进 `Set`，连行序都不敏感 | `selection-range.ts:414-415`、`picker.ts:158-175` |
| 环模式 `pickRect` 的坐标 | 传的是 `bounds / targetSize`（归一化、左上原点），与 `readIds` 的入参约定一致 | `editor.ts:1149-1154`、`picker.ts:149-165` |
| `pickOp` 与 add/remove/intersect 的组合语义 | **正确**。着色器 `pickOp 0/1/2 = add/remove/set`（add 跳过已选、remove 只拾已选、set 只跳 locked/deleted），配合 `rangeCombine` 的 `set/add/remove/intersect` 与 `preMask`（排除 locked）逐条吻合；`intersect` 走 `remove` 渲染避免未选高斯遮挡 | `picker.ts:113-119`、`splat-shader.ts:52,77-105`、`editor.ts:1020-1025,1164-1165` |
| 推杆与新手势的竞态 | **推演后认为安全**。`runRangeSelection` 开头 `rangeGesture = null` 再 `resetRange`，而 `resetRange` 触发的 `selection.depthRange` 事件在 `rangeGesture === null` 时被 `requestRange` 丢弃；`pumpRange` 每轮重新读 `rangeGesture`，`rangePending` 只是"再跑一轮"的标志位；历史写入与 `op.do()` 共用同一个 `CommandQueue`（严格 FIFO）。未发现能破坏 `pre/post/applied` 三快照的时序 | `editor.ts:1089-1090,1193-1224`、`command-queue.ts:8-16` |
| `tailMap` 在 0/100 与 ±50/150 的行为 | **正确**。`t=0 → 0`、`t=1 → 1`（0/100 精确落在框边），中间段线性、两端段线性外推不夹取 | `selection-range.ts:91-106` |
| `screenWindow` 的 上/下、左/右 轴序 | **一致**：`top → minY`、`bottom → maxY`，`tailFractions` 的 `by` 也用左上原点 sy → "上"柄对应画面上方 | `selection-range.ts:301-318,226-234`、`selection-flags.ts:279-293` |
| `Int16` 缓存越界 | 不越界。`sx/sy` 被 `Math.min(width-1, Math.max(0, ...))` 夹取，`-1` 是"未写入"哨兵且判断顺序在读取 `sy/dist` 之前；`targetSize` 需 >32767 宽才会溢出（不可能） | `selection-range.ts:414-415,481-493`、`picker.ts` 同款夹取 |
| `IndexRanges.forEach` 的越界 | 不越界。`emit` 不会产生 `count === 0`；尾部缺 `count` 时 `end = NaN` 使内层循环不执行 | `index-ranges.ts:7-13,47-64,72-86` |
| `keepSurface` 的索引越界 | 当前不可达；**假如**接线，因为调用时用的 `width/height` 与填缓存时同源，暂时也不越界（但分辨率变化后会） | `selection-range.ts:504-506,528-534` |
| flood 外的 4 个 `select.byMask` 使用者 | 套索/多边形/2D 笔刷的画布都是"实心 alpha 255/0"，`> 0` 判定正确（抗锯齿边算入是利好） | `lasso-selection.ts:68-79`、`polygon-selection.ts:51-62`、`brush-selection.ts:44-50` |
| `selection-flags` 与 `selection-depth-bar` 的注册顺序 | **安全**。`registerSelectionFlags` 在 `main.ts:114`，`new SelectionDepthBar` 在 `main.ts:345` | `main.ts:114,345` |
| 深度百分比基准（`worldBound`）的后端差异 | **存在但影响很小**：`calcBound` 的 localBound = "跳过 deleted 的全部高斯"（含 locked/hidden），WebGPU 下回读全零后回退到构造期的 CPU AABB（含 deleted）→ 删除过高斯后两后端的 0/100 端点会略有差别。属 C-2 已知兜底的副作用，未单列 | `bound-shader.ts:42,66-68`、`splat.ts:1078-1082` |
| `select.colorMatch` 的 `pickId === 0xffffffff` 校验 | 正确（`readIds` 用 `>>> 0` 保证无符号） | `picker.ts:179-185`、`editor.ts:1410` |
| 环模式下 `picked` 含 `0xffffffff` 哨兵 | 无害（`numSplats` 之内不会命中该值） | `editor.ts:1155-1161` |
