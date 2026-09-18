# 数据与算子链路审计 —— 编辑算子 / 撤销重做 / 去浮云 / 序列化 / 对比工具 / LOD

- 审计对象：`D:\DeepSeek\SplatRoomV2\SplatRoomV3-0`（3.21.0，HEAD 工作树）
- 审计方式：**只读**。未修改任何源文件、未 build、未跑测试。全部结论以实读代码的 `文件:行号` 为准。
- 基准模型：用户测试场景 `选择工具\merged-scene.ply`，**13,007,105 高斯 / 695 MB / binary PLY / 14 列 float32（无 SH）** ⇒ 单列 52.0 MB，全列一份 ≈ 728 MB。
- 已排除的"已知事实"（不在本文重复为"新发现"）：
  - `docs/HANDOFF.md` §6 第 3 条「对比工具浮云检测器仍是旧四信号实现、未与共享检测器统一」——本文只**量化其后果**；
  - §6 第 1 条「13M 点推杆 ~600 ms、瓶颈在 `IndexRanges` + 状态回写 + 上传，建议搬进着色器」；
  - `docs/V3-WebGPU-现状.md` §6.26–6.31 的去浮云判据演进（226× 尺度错、稀疏+偏透明、`estimateSpacing` 20 ms / 93 万点 0.5 s 等基准）；
  - §6.28 的对比工具 FOV 修正、破洞模式回读性能、像素信号不可用；
  - `docs/代码审查-2026-09-11.md` 的规模/`as any`/死代码类结论。
- 本文中含"估算"字样的耗时/内存均为**由代码常量与循环次数推导**，非实测（本轮不允许运行）；标注为"文档实测"的数字来自上列既有文档。

---

## 0. 结论速览

| # | 严重度 | 位置 | 一句话 |
| --- | --- | --- | --- |
| 1 | 高 | `core/edit-ops.ts:588-592` + `app/editor.ts:1613-1627` | `MultiOp.undo()` 正序执行子算子，组合撤销不还原原状（去浮云路径可复现：撤销后原本已选中的浮云点变成未选中） |
| 2 | 高 | `splat/splat.ts:507-517`、`lod/lod.ts:21-34`、`scene/scene.ts:595-621` | LOD 代理切换用代理自己的 `state`/`transform` 列替换编辑状态：删除的浮云拉远相机后重新出现，代理期间的编辑拉近后丢失 |
| 3 | 高 | `ui/floater-panel.ts:396-472` | 一次 200 ms 防抖内**同步**跑 `detectFloaters` + `detectClusters` 两套全量检测，13M 点上主线程冻结（估算 5–15 s/次，且滑块每次拖动都触发） |
| 4 | 高 | `geometry/water-detect.ts:76-78,126-140,149` | 读了不存在的属性 `sh` ⇒ 镜面反射项恒 0 ⇒ 水域判据 A 永远不成立，水域识别静默退化成"幽灵团" |
| 5 | 高 | `io/load-worker-client.ts:11,34-36,144-146` | 导入用的 load worker **从未被启用**（开关没人设、注释里的反向开关名不存在）⇒ 解码 + 莫顿排序 + 行重排全在主线程，`src/workers/load-worker.ts` 是死代码 |
| 6 | 高 | `compare/compare-analysis.ts:302-303,436-458` | 对比工具浮云"隔离"判据的尺度 = 场景尺度 × 3.05 ⇒ 判据恒不成立，标记实际退化为三条**已在共享检测器里被实测证伪**的信号 |
| 7 | 高 | `compare/compare-analysis.ts:1045-1050,1062-1068,1293-1310` | 破洞模式逐格插入排序、单格元素数无上限 ⇒ 最坏 O(k²)（4K 单视口 k≈12 万 ⇒ 约 3.6e9 次移位，估算 12–40 s 冻结） |
| 8 | 中 | `workers/surface-worker-client.ts:571-592,629-647` | 每次表面细化**无条件**先整份 `slice()` 一份 ~741 MB 回退副本（正常路径不用）；worker 超时 10 分钟后既不 `terminate()` 也不回收 `pending`，还再主线程重算一遍 |
| 9 | 中 | `splat/splat-serialize.ts:196-226,558-576,414-438` | 导出前置扫描跑两遍完整谓词 + 104 MB 常驻映射表；每点热路径 2 次短命数组分配、3 次 `Map.get`、14 次动态字典查表 |
| 10 | 中 | `app/file-handler.ts:508-558,630-693` + `splat/splat-serialize.ts:558-576` | 导出/导入无任何并发守卫或代际标记：crop 标记靠"先 slice 整份 state 再还原"、按数组下标复用旧快照、模块级单例 logger |
| 11 | 中 | `splat/floater-removal.ts:302-346` + `splat/cluster-filter.ts:114-133,148-182` | 13M 点一次检测分配 ~380 MB 临时 typed array、重复 3 遍全量扫描；连通簇缺 dense 快路径，体素洪泛每个体素 26 次 `Map.get` |
| 12 | 中 | `geometry/planar-fix.ts:111-124,272-350,403-578` | 平面修复全在主线程同步跑：字符串 key 空间哈希（每候选 2×27 次字符串拼接）+ 全列一次性重分配，点「熨平地面」整窗无响应（spinner 画不出来） |
| 13 | 中 | `core/edit-ops.ts:346-396` | `SplatsTransformOp.undo()` 用 `inverseMap.get()` 未命中时静默写 0（=恒等矩阵）⇒ 该点变换无声丢失；do/undo 各再全量扫一遍 13M |
| 14 | 中 | `compare/compare-analysis.ts:240-254,713-752` + `compare/compare-stats.ts:59-75,618-629` | 对比工具每次刷新分配 52 MB 掩码（只用其中 8000 槽）+ 逐点 `createRadialGradient`；建模型时 4 次 `getCenters()` = 4×149 MB 拷贝只为各取 2000 个数 |
| 15 | 中 | `tools/ground-water-tool.ts:39,102-118` + `geometry/region-detect.ts:100,319,370` | 地面/水域面板的容差被算成**整条包围盒对角线**（应为 1%），是默认值的 100 倍 ⇒ "地面"选区波及近乎整个模型 |

---

## 1.【高】`MultiOp.undo()` 正序执行：组合撤销无法还原原状

**位置**：`src/core/edit-ops.ts:574-603`（尤其 `588-592`）、调用方 `src/app/editor.ts:1613-1627`（去浮云 / 连通簇）、`src/app/editor.ts:1506-1509`（分离）、`src/app/editor.ts:1780-1790`（愈合）

**问题**：`MultiOp.undo()` 按**正序**（`for (const op of this.ops)`）撤销子算子。撤销必须逆序执行，否则"后一个算子依赖前一个算子留下的状态"的组合会残留中间态。去浮云的 apply 路径正是这种组合：

```ts
// editor.ts:1613-1627
events.on('floater.apply', (data: { targets: { splat: Splat, mask: Uint8Array }[], remove: boolean, count: number }) => {
    const ops: EditOp[] = [];
    for (const { splat, mask } of data.targets) {
        ops.push(
            new SelectNoneOp(splat),        // ① 先清空整个选区
            new SelectOp(splat, 'add', mask) // ② 再把浮云选上
        );
        if (data.remove) {
            ops.push(new DeleteSelectionOp(splat)); // ③ 删除"当前选中"
        }
    }
```

```ts
// edit-ops.ts:582-592
async do() {
    for (const op of this.ops) { await op.do(); }
}
async undo() {
    for (const op of this.ops) { await op.undo(); }   // ← 应为逆序
}
```

`StateOp.undo()`（`edit-ops.ts:63-68`）是"同一批行上的反向位运算"：`SelectNoneOp`（`op=CLEAR`）的 undo 是 **SET**，`SelectOp`（`op=SET`）的 undo 是 **CLEAR**。

**影响（可推演到具体行为）**：撤销一次「移除浮云」时按当前顺序执行：
1. `SelectNoneOp.undo` → SET：把**操作前**选中的行全部恢复选中（含同时落在浮云掩码里的行）；
2. `SelectOp.undo` → CLEAR：把浮云行（=`valid && hit`，由于第①步刚清空过选区，等于全部有效浮云行）清掉；
3. `DeleteSelectionOp.undo` → CLEAR deleted：把浮云恢复。

净结果：**操作前已选中、且属于浮云掩码的那些高斯，撤销后变成未选中** —— 用户选了 A 区，点「移除浮云」，Ctrl+Z 之后 A 区里被判为浮云的部分不再属于选区（这些恰好是他最关心、最想复核的那些点）。若改成逆序（③②①），第②步先清浮云、第①步最后把操作前选区整体恢复，结果**逐位等于操作前**，即"逆序"同时修好这个不一致。同类风险也存在于 `separate`（`editor.ts:1506`）与 `heal`（`editor.ts:1780`）的组合里。

**建议改法**：`undo()` 改为逆序。

```ts
async undo() {
    for (let i = this.ops.length - 1; i >= 0; --i) { await this.ops[i].undo(); }
}
```

预期收益：撤销语义正确（去浮云/连通簇/分离/愈合四条路径一起修好）。风险：低——逆序只会让"依赖前序状态"的组合变正确；对互相独立的组合（如 `[SplatsTransformOp, PlacePivotOp]`）结果不变。**不改变任何前向行为**，只改撤销结果；建议补一条"撤销后选区逐位等于操作前"的回归断言（`verify-floater-removal.cjs` 扩一项即可）。

---

## 2.【高】LOD 代理切换把编辑状态（删除/隐藏/选中/变换）一起换掉了

**位置**：`src/splat/splat.ts:507-517`（`applyLod`）、`256-263`（`bindAsset` 换 `splatData`）、`290-329`（重建 state/transform 通道）、`404-461`（`replaceData`）、`src/lod/lod.ts:21-34`（`vertexColumns`）、`95-141`（`sampleGsplatData`）、`src/scene/scene.ts:595-621`（每帧切层）、`src/lod/editor-lod.ts:57-67`（门控）

**问题**：代理层级的数据是从**构建那一刻**的源数据派生的独立 `GSplatData`，其中 `state` 列（uchar）被**按行原样搬运**，`transform` 列（ushort，调色板索引）被**丢弃**：

```ts
// lod.ts:21-34
const vertexColumns = (data: GSplatData) => {
    ...
    } else if (p?.type === 'uchar' && s instanceof Uint8Array) {
        // state column is carried verbatim (decimate keeps rows as-is)
        cols.push({ name: p.name, storage: s });
    }
```

```ts
// splat.ts:256-263 / 290-329
this.asset = asset;
this.splatData = splatData;          // ← 整个数据表被换掉
...
if (!splatData.getProp('state')) {   // 代理自带 state 快照 → 不新建
    ...
}
splatData.getElement('vertex').properties.push({   // transform 列无条件新建（全 0）
    type: 'ushort', name: 'transform', storage: new Uint16Array(splatData.numSplats), byteSize: 2
});
this.state = new SplatState(splatData.getProp('state') as Uint8Array, this.stateTexture);
```

switch 是**每帧**发生的，门控只排除"有选中/正在拖相机/正在撤销/正在离线渲染"：

```ts
// scene.ts:595-621
const allow = this.events.invoke('lod.allowProxy') !== false;
...
const target = s.suggestLodLevel(dist / radius);
if (target !== s.lodLevel) void s.applyLod(target);
```
```ts
// editor-lod.ts:57-67
if (!autoEnabled) return false;
if (scene.lockedRenderMode) return false;
if (scene.camera?.userDragging) return false;
if (editHistory.isUndoingRedoing()) return false;
const selection = events.invoke('selection.splats') as unknown[] | undefined;
if (selection && selection.length > 0) return false;
return true;
```

**影响**（三条独立后果，均由代码直接推出）：
1. **已删除的高斯会"复活"**：代理里的 `state` 是构建时的快照（LOD 在导入后 400 ms 自动生成，`editor-lod.ts:107-120`），之后用户删掉的浮云不在快照里 ⇒ 只要场景为空选区地拉远相机，代理一挂上，**删掉的浮云重新出现在画面上**（`updateSorting` 按代理的 state 重建 index mapping，`splat.ts:576-597`）。用户视角是"我的删除丢了"。
2. **代理激活期间的编辑会丢失**：编辑写进的是代理的 state 数组（长度也小得多）；拉近回原图时 `replaceData` 再把 `this.state` 指回原数组，中间那次编辑既不在原数组里、也随代理被销毁。
3. **splat 级变换失效**：`transform` 列被丢弃、`new Uint16Array()` 全 0 = 恒等矩阵，而 `transformPalette`（`splat.ts:159`）里的矩阵还在 ⇒ 通过 gizmo 移动过的高斯在代理激活期间回到原位。同一机制也适用于 `replaceData` 的其它调用者（`SurfaceRefineOp` 的 undo/redo、序列帧播放）：**任何 `replaceData` 之后，per-splat 变换列都被重置为恒等**。

**可达性（如实说明）**：切层要求 `lod.autoEnabled = true`（默认 **关**，`editor-lod.ts:31`），所以这是"开了 LOD 实验开关才会踩"的路径；`attachLodFromFile` 只注册资产、不切层。一旦开关打开，上面三条都是必然会发生的。

**建议改法**（按代价从低到高）：
- **最小改动**：`applyLod` 前后对 `state.data` 与 `transform` 列做"每次切层都按代理行→原始行映射重算"，即代理只保留几何列（x/y/z/scale/rot/opacity/f_dc/f_rest），**state 与 transform 一律从主数据按映射投影**（`sampleGsplatData` 已有 `step`，把"目标行 i → 源行 `floor(i*step)`"存成 `Uint32Array` 即可，13M 点的映射 52 MB，或按 `step` 现算省掉）。这样代理永远不持有状态快照，编辑在任何 LOD 下都一致。
- **同时收紧门控**：`lod.allowProxy` 里加上 `state.numDeleted === 0 && 调色板只有恒等项 && 导出中` 三个条件——有删除/变换/导出时禁止挂代理（一行判断，无需改数据结构）。
- 预期收益：消除"编辑状态随 LOD 显现/消失"这一类不可解释现象；风险：中（要处理代理行数 ≠ 源行数时的映射边界）；精度不变（几何列本来就是抽样/decimate 的近似）。

---

## 3.【高】去浮云面板：一次防抖里同步跑两套全量检测，13M 点上主线程冻结

**位置**：`src/ui/floater-panel.ts:396-402`（防抖）、`404-472`（`_runDetect`）、`363-391`（`_floaterTargets` / `_clusterTargets`）、`477-509`（`_apply` / `_applyClusters`）

**问题**：`_runDetect()` 在**主线程同步**依次跑 `detectFloaters`（每个目标模型）**和** `detectClusters`（每个目标模型），二者都无 worker、无 yield、无取消：

```ts
// floater-panel.ts:396-402
private _scheduleDetect() {
    if (!this._fltEnabled) return;
    if (this._detectTimer) clearTimeout(this._detectTimer);
    this._resultLabel.text = '...';
    this._clusterResultLabel.text = '...';
    this._detectTimer = setTimeout(() => this._runDetect(), 200);
}
```
```ts
// floater-panel.ts:423-456（节选）
for (const splat of splats) {
    const result = detectFloaters(splat, this._sensitivity, { scope: this._scopeValue });
    ...
}
...
for (const splat of splats) {                     // ← 同一 tick 里再跑一遍连通簇
    const result = detectClusters(splat, { detail: this._clusterDetail, ... });
```

而 `_apply()` / `_applyClusters()` 在点击时**又各跑一次**同规模的检测（见第 11 条与第 8 条的量级）：

```ts
// floater-panel.ts:477-488
private _apply(remove: boolean) {
    ...
    const targets = this._floaterTargets();       // ← 再算一遍全量
    const count = targets.reduce((sum, t) => sum + (t.mask as Uint8Array).reduce((n, v) => n + (v ? 1 : 0), 0), 0);
    if (!targets.length || count === 0) { this._resultLabel.text = '0'; return; }
    this._fltEvents.fire('floater.apply', { targets, remove, count });
```

**影响（估算）**：
- `detectFloaters`：文档实测 93 万点 **0.5 s**（`docs/V3-WebGPU-现状.md:1008`）⇒ 按点数线性外推 13M ≈ **7 s**（内部 3 遍全量扫描 + 每点 27 格计数，见第 11 条）。
- `detectClusters`：体素化 13M 次 `Map.get/set` + 洪泛中每个占用体素 26 次 `Map.get`（`cluster-filter.ts:119-133,152-182`）。若占用体素 ≈ 300 万，则 ≈ **7800 万次 Map 查询**，估算 **4–10 s**（第 11 条给出替代量级）。
- 于是**灵敏度滑块每停 200 ms 就有一次 10 s 级同步冻结**；面板打开/开关切换同样触发；`_apply` 再叠加一次检测 + 一次 `Uint8Array(13M).reduce()`（约 0.1–0.2 s）。
- 更糟的是连通簇的检测**与浮云勾选状态无关**：即使用户从不碰连通簇，只要面板启用，每次都要付这份代价。

**建议改法**（三步，彼此独立）：
1. **按需计算连通簇**：只在用户展开/操作连通簇区块时算，或把 `_clusterResultLabel` 变成"点一下才算"；一次性砍掉约一半成本。
2. **搬进 Worker**：`detectFloaters` / `detectClusters` 都是纯函数、只读 `x/y/z/opacity/state` 列。最省事的做法是给 worker 传 `ArrayBuffer` 的 **copy**（13M × 14 列会太大——改传 `x/y/z/opacity/state` 5 列 ≈ 13M × 17 B ≈ 221 MB，或直接对 4 列建 `Float32Array` 的 `transfer` 副本并让 worker 回传结果掩码）；也可用 `SharedArrayBuffer`（Electron 下需开 COOP/COEP）。主线程只做 `SelectOp`。
3. **回调改为可取消**：滑块拖动用 `AbortController`/代际号，只保留最后一次结果（现有 `_detectTimer` 只防抖、不取消在途计算）。

预期收益：滑块交互从"每 200 ms 冻结数秒"变成"占位符 + 后台计算"；风险：中（worker 里必须重建同样的 `Float32Array` 视图，且要注意 `estimateSpacing` 的 `isValid` 闭包不能跨线程传递，需改为传 `state` 列）；精度不变（同一份判据、同一份数据）。

---

## 4.【高】水域判据 A 读了不存在的属性 `sh`，镜面反射项恒为 0

**位置**：`src/geometry/water-detect.ts:76-78`（取属性）、`126-140`（唯一使用处）、`149`（合取条件）

**问题**：`sd.getProp('sh')` 拿不到任何东西——全仓库的球谐列名是 `f_rest_${i}`（`splat-serialize.ts:247`、`planar-fix.ts:225`、`surface-refiner.ts:368`、`merge-export.ts:120`、`group-renderer.ts:425`、`heal-inpaint.ts:188`，`grep 'sh'` 全仓只有 `water-detect.ts:76` 这一处）；PlayCanvas 的 `getProp` 对未知名字返回 `undefined` 而不抛错。于是 `numSh = 0`：

```ts
// water-detect.ts:76-78
const sh = sd.getProp('sh') as Float32Array;
const state = sd.getProp('state') as Uint8Array;
const numSh = sh ? sh.length / sd.numSplats : 0;
```
```ts
// water-detect.ts:126-140
let specular = 0;
if (sh && numSh >= 3) {          // ← 永不进入，specular 恒 0
    const base = i * numSh;
    ...
    specular = total > 1e-9 ? ac / total : 0;
}
```
```ts
// water-detect.ts:149
const onPlaneWater = sat <= satMax && blueBias >= blueMin && specular >= specMin;  // specMin 默认 0.02
```

**影响**：判据 A（"平面内低饱和 + 偏蓝 + 有镜面反射"）**恒为 false**，水域识别只剩判据 B（幽灵团），即"远离平面且颜色接近平面主色"的漂浮团——不是水面。调用方是右键菜单 `semantic.flatten`/水域选择与 `GroundWaterPanel` 的预览（`semantic-select.ts:92-99` → `detectWater`）。分数里 0.2 权重项恒 0、UI 上的"水域/地面"计数与高亮都建立在这个退化判据上。这是**确定性功能失效**，与阈值调参无关。

**建议改法**：按仓库既有写法取 SH：用 `shBands` + `f_rest_0..N`（注意 SH 列是**按系数分列**、每列一条 `Float32Array`，不是"每高斯交错 `numSh` 个"，`base = i * numSh` 这个索引假设本身也是错的，需一并改）；或在水域判据里暂时移除 `specular` 项并把 UI 文案改成"仅按颜色/位置判定"。风险：低（判据 A 今天等价于不存在，修好只会新增命中，需要用户回测）；精度：修好后判据更严格，水域选区会变小。

---

## 5.【高】导入用的 load worker 从未被启用（开关没人设置）

**位置**：`src/io/load-worker-client.ts:11`（注释）、`34-36`（开关）、`138-146`（早退）；唯一正式调用方 `src/app/asset-loader.ts:73`；主线程实现的重复块 `src/io/read/loader.ts:188-195` 对 `src/workers/load-worker.ts:194-199`

**问题**：模块头注释描述的是"默认开 + 可用 `__SPLATROOM_NO_LOAD_WORKER__` 关"，实际代码要求**显式 opt-in**，而这个显式开关在全仓库（`src/`、`scripts/`、`static/`、`electron-main.js`、`electron-preload.js`）**没有任何地方被设置**：

```ts
// load-worker-client.ts:11
 * safe to enable by default — set `window.__SPLATROOM_NO_LOAD_WORKER__ = true`
```
```ts
// load-worker-client.ts:34-36
// Feature flag — enabled only by setting window.__SPLATROOM_ENABLE_LOAD_WORKER__ = true.
const USE_LOAD_WORKER =
    (typeof window !== 'undefined') && (window as any).__SPLATROOM_ENABLE_LOAD_WORKER__ === true;
```
```ts
// load-worker-client.ts:144-146
if (!USE_LOAD_WORKER) {
    return loadGSplatData(filename, fileSystem, skipReorder, pickLod);
}
```

`grep __SPLATROOM_ENABLE_LOAD_WORKER__` 只命中该文件自身 3 行；注释里提到的 `__SPLATROOM_NO_LOAD_WORKER__` **根本不存在**于代码里。

**影响**：13M 模型的 `materializeToDataTable`（14 列 × 13M × 4 B ≈ 728 MB 分配与填充）+ `sortMortonOrder` + `permuteRowsInPlace` **全部在主线程**跑。这解释了用户"导入约 15 s 里界面完全不能动"的体感（现有文档没有把这段归因）；同时 `src/workers/load-worker.ts`（241 行）与 rollup 的 `loadWorker` 入口是**死代码**。另有一处连带风险：附加的验证脚本 `src/workers/lw-probe.ts:102-104,124-125` 在 worker 从未运行时也会报 `ok = true`（它不设开关、也不断言 `__LW_WORKER_RESULTS__ > 0`），也就是说"worker 与主线程逐字节一致"这一结论**从未被真正验证过**——打开开关前必须先修这个假绿探针，否则等于关着灯改路。

**建议改法**：把开关语义反转（保留逃生口），并先在探针上补断言：

```ts
const USE_LOAD_WORKER =
    (typeof window !== 'undefined') && (window as any).__SPLATROOM_NO_LOAD_WORKER__ !== true;
```

预期收益：导入的解码/排序/重排移出主线程，13M 点导入期间界面可交互（具体秒数需实测，本文不给数字）；风险：中（worker 回传靠 `ctorName` 重建 typed array，若将来开 minify 需回归；`lw-probe.ts` 必须先修成"worker 真的跑了才 pass"）；不改变输出格式与数值（探针设计上就是逐字节等同）。

---

## 6.【高】对比工具：浮云"隔离"判据的尺度是场景尺度的 3 倍，判据恒不成立

**位置**：`src/compare/compare-analysis.ts:302-303`、`326`、`436-458`（私有 `estimateCellSize`）

> 已知背景：该检测器是旧四信号实现、未与 `src/splat/floater-removal.ts` 统一（`docs/HANDOFF.md` §6 第 3 条）。本节**不重复该事实**，只量化其后果。

**问题**：四信号"或"里唯一在几何上正确的只有信号 1（"周围是空的"），它依赖 `estimateCellSize(centers) = 中位到质心距离 × 0.3`，即**场景尺度**（≈ 模型自身半径），再被 `× (5 − sens × 0.03)` 放大：

```ts
// compare-analysis.ts:302-303
const spacing = estimateCellSize(centers);
const cellSize = spacing * (5 - sens * 0.03);  // sens 0→5×, 65→3×, 100→2×
```
```ts
// compare-analysis.ts:436-458
dists[i] = Math.sqrt(dx * dx + dy * dy + dz * dz);
...
dists.sort();
return dists[Math.floor(sample / 2)] * 0.3 || 1;   // ← 场景尺度，不是最近邻间距
```
```ts
// compare-analysis.ts:324-326
const lowFrac = Math.max(0.01, 0.14 - sens * 0.0013);   // sens 65 → 0.0555
const minNeighbors = Math.max(1, Math.round(denseAvg * lowFrac));
```

面板默认灵敏度是 65（`compare-panel.ts:329`）⇒ 乘数 3.05 ⇒ 判据窗口半宽 = `1.5 × 3.05 × 中位质心距 ≈ 4.6 × 中位质心距`，**大于模型自身半径**：3×3×3 格窗口覆盖整个采样点云 ⇒ 每个点的邻居数 ≈ 全部有效采样数（`N = min(numSplats, 8000)`，`compare-analysis.ts:241`）≈ 8000，而阈值 ≈ `0.0555 × denseAvg` ≤ 444 ⇒ `8000 ≫ 444`，只有点云最外缘可能命中。

**影响**：隔离判据与共享检测器当年被修掉的 bug 同机制（`docs/V3-WebGPU-现状.md:983-995`：`estimateCellSize` 0.3709 vs 真值 0.001637，差 226×；该文档记"真实扫描上任何点都不满足隔离判据，检测器返回 0 或个位数"）；对比工具的格边还要再乘 3.05，**误差量级以 226× 为下界**（代码推导，非实测）。隔离失效后只剩三条，而这三条在既有文档里全部被实测为错或反向：
- 不透明度（`compare-analysis.ts:258-266`，sens 65 → `α < 0.30`）：真值实测"手工删除点 α 中位 0.081 / 用户留着的房间表面 0.158"（`:1076`），两者都在阈值内 ⇒ 退化成"几乎全选"；
- 体积（`:270-295`）：实测"maxScale caught 0.014 / 误删的墙 0.030"——**方向反了**（`:1075`）；
- 离质心距离（`:346-374`）：实测手工删除点反而**更靠近**中心（0.152 vs 0.296，`:1004`）。
因此对比工具的浮云黄标记在真实扫描上更可能高亮"贴表面的软边/雾面/远处地面片"，而不是飘点——与共享检测器在同样数据上的行为相反。

**建议改法**：`compare-analysis.ts:302` 改用已导出的 `estimateSpacing(xs, ys, zs, numSplats)`（`floater-removal.ts:131`），并去掉 `× (5 − sens × 0.03)` 这层额外放大（共享检测器整体只有 `RADIUS_FACTOR = 34.5` 与 `1.2` 两个尺度，`floater-removal.ts:103,330-331`）；`denseAvg` 也应改为全量网格统计（共享检测器明确写过"抽样建网格会让密度整体变稀、所有点都显得孤立"，`floater-removal.ts:74-77`）。风险/行为变更：**会大幅改变标记集合（这正是目的）**；注意两处灵敏度语义不同（对比默认 65，共享检测器标定默认 ~40），不能 1:1 照搬，需要重新映射并重跑对比工具的验证。若暂时不想改可见行为，最低限度是把三条已证伪的信号替换为共享检测器的"稀疏**且**偏透明"（`floater-removal.ts:413-429`）。

---

## 7.【高】对比工具破洞模式：逐格插入排序，单格元素数无上限 ⇒ 最坏 O(k²)

**位置**：`src/compare/compare-analysis.ts:1045-1050`（网格与采样上限）、`1062-1068`（每格三个 JS 数组）、`1286-1310`（插入排序）

**问题**：每格的深度/α/尺度三条链用**普通 JS number 数组**收集（`push`），随后对每格做插入排序；单格元素数没有任何上限，而 `sample = min(n, GRID² × 13)`：

```ts
// compare-analysis.ts:1045-1050
const GRID = Math.max(32, Math.min(96, Math.round(cw / 24)));
const sample = Math.min(n, GRID * GRID * 13);
const step = Math.max(1, Math.floor(n / sample));
```
```ts
// compare-analysis.ts:1297-1310
for (let i = 1; i < len; i++) {
    const d = depths[i], a = alphas[i];
    let j = i - 1;
    while (j >= 0 && depths[j] < d) {      // ← 逐元素移位，O(len²)
        depths[j + 1] = depths[j];
        ...
```

相机拉远、整个模型只占屏幕少数格子时，这 k 个元素全部落进同一个桶，插入排序退化为 O(k²)。

**影响（估算，按"移位次数 ≈ k²/4、1e8–3e8 次/秒"）**：

| 视口 `cw` | `GRID` | 单桶上限 k | 最坏移位 ≈ k²/4 | 估算耗时 |
| --- | --- | --- | --- | --- |
| 824（1920 二分屏） | 34 | 15,028 | 5.6e7 | 0.2–0.6 s |
| 1648（1920 单视口） | 69 | 61,893 | 9.6e8 | 3–10 s |
| 3568（4K 单视口） | 96 | **119,808** | **3.6e9** | 12–40 s |

且这里写的是 JS number 数组（装箱 double + `push` 扩容），比 typed array 更慢。此路径**与像素信号可用性无关**（分箱在 `:1077-1119`，早于 `:1129` 的像素读取），所以 §6.28 记录的"像素信号拿不到 2D context"并不能豁免它。`:1070` 的注释"temporaries (reused, zero per-iteration allocation)"与实现不符：每次调用固定新建 `3 × gw·gh` 个空数组（96² 时 27,648 个）。

**建议改法**：把比较排序换成**计数/分桶排序**：①按 `GRID` 预建 `Int32Array` 计数 + 前缀和，把 `(depth, α, sEff)` 写进 3 条全局 typed array（顺带消掉 27,648 个 JS 数组）；②排序键是"每像素最前表面"，可把深度量化到 16 位整数后计数排序，或先按 8³ 子格粗分再各格排序，最坏复杂度降到 O(k)；③给单桶元素数加硬上限（超限并入相邻格或按深度抽样）。预期收益：4K 单视口从估算的十秒级降到亚秒级；风险：低（排序键仍是 `viewZ` 降序，渲染语义可保持逐位一致）；精度不变。

---

## 8.【中】表面细化：每次无条件预复制 ~741 MB 回退副本；worker 超时后既不回收也不终止

**位置**：`src/workers/surface-worker-client.ts:571-592`（回退副本）、`594-627`（transfer）、`629-647`（超时与回退）

**问题（两个独立缺陷，同一函数）**：

```ts
// surface-worker-client.ts:577-592
// The transferred buffers are DETACHED on the main thread the moment
// postMessage runs (their typed arrays become length 0). Keep a pristine
// copy so the fallback path can still compute if the worker fails —
const fallbackBufs: RefineBuffers = {
    x: bufs.x.slice(), y: bufs.y.slice(), z: bufs.z.slice(),
    s0: bufs.s0.slice(), s1: bufs.s1.slice(), s2: bufs.s2.slice(),
    r0: bufs.r0.slice(), r1: bufs.r1.slice(), r2: bufs.r2.slice(), r3: bufs.r3.slice(),
    op: bufs.op.slice(), state: bufs.state.slice(),
    extra: bufs.extra.map(c => ({ name: c.name, data: c.data.slice() })),
    N: bufs.N
};
```
```ts
// surface-worker-client.ts:634-647
const outcome = await Promise.race([
    result,
    new Promise<RefineOutcome>((_, reject) => {
        setTimeout(() => reject(new Error('surface-worker timeout')), 10 * 60 * 1000);
    })
]);
...
} catch (e) {
    console.warn('[surface-refine] worker failed, using main-thread fallback:', ...);
    return refineSurfaceMainThread(fallbackBufs, options, onProgress);
```

**影响（估算）**：13M 模型 14 列 × 52.03 MB ≈ 728 MB + `state` 12.4 MB ⇒ **741 MB 主线程峰值，正常路径一行都用不到**（用户测试模型恰是 14 个 float 列、无 SH，与 `merged-scene.ply` 头部一致）。叠加 `cloneGSplatData` 的另一份 741 MB 与 worker 侧 `analyzeAll` 的 12×N Float32Array（≈624 MB），两线程合计估算 **3.5–4 GB**——这是"表面细化在 13M 上失败/卡死"最可疑的内存来源。第二处缺陷：超时分支**只 reject**，既不清 `pending`（只有 `:624` 的 transfer 失败分支与结果消息里删），也不 `worker.terminate()`；worker 若"假死仍在跑"，随后主线程又从 741 MB 副本重算一遍 ⇒ CPU 与内存双份占用；且 `editor.ts:112` 的 `progressStart(..., false)` 意味着**没有取消按钮**——10 分钟里用户只能等。

**建议改法**：①把回退改成**惰性 provider**：`refineSurfaceInWorker(bufs, options, onProgress, () => /* 从活的 splatData 现场克隆 */ )`，只在 `catch` 里调用（`refineSurface` 内本来就有活数据可克隆），正常路径省下 741 MB；②超时分支补 `pending.delete(id)` + `worker.terminate(); worker = null;`；③给 `progressStart` 传 `true` 并接受 `AbortSignal`（`ui/editor.ts:776`、`render.ts:568` 是现成范例）；④超时值按 `N` 缩放而不是固定 10 分钟。预期收益：主线程峰值 −741 MB；假死时可恢复。风险：低—中（provider 不能闭包引用已被 transfer 的数组）；不改变算法与输出。

---

## 9.【中】13M 导出的热路径：前置两遍全量过滤 + 104 MB 映射表 + 每点分配

**位置**：`src/splat/splat-serialize.ts:196-226`（过滤谓词 + `countGaussians`）、`555-576`（第二遍建映射）、`258-280`（`SplatTransformCache.getTransform`）、`414-438`（`SingleSplat.read` 的成员拷贝与解构）

**问题**：导出是"先数一遍、再填一遍"，两遍都用完整谓词；而 `file-handler.ts` 对 ply 导出强制 `minOpacity = 1/255` + `removeInvalid = true`，于是每点都要遍历**全部顶点属性**做 `Number.isFinite`，且谓词内部每点重新取一次 element：

```ts
// splat-serialize.ts:196-210
if (removeInvalid) {
    const { splatData } = splat;
    // check if any property of the gaussian is NaN/Infinity
    const element = splatData.getElement('vertex');      // ← 每点一次，应在谓词外
    for (let k = 0; k < element.properties.length; ++k) {
        const prop = element.properties[k];
        const { storage, name } = prop;
        if (storage && !Number.isFinite(storage[i])) { ... return false; }
    }
}
```
```ts
// splat-serialize.ts:559-574
const filter = new GaussianFilter(settings);
const total = countGaussians(splats, filter);   // 第 1 遍（只为知道长度）
const splatOf = new Uint32Array(total);
const localOf = new Uint32Array(total);
let idx = 0;
for (let s = 0; s < splats.length; ++s) {
    filter.set(splats[s]);
    const n = splats[s].splatData.numSplats;
    for (let i = 0; i < n; ++i) { if (filter.test(i)) { ...idx++; } }   // 第 2 遍
}
```
```ts
// splat-serialize.ts:414-425（每点都跑）
members.forEach((name) => { data[name] = srcProps[name]?.[i] ?? 0; });   // 14 次动态键读写
const mat = transformCache.getMat(i);                                     // Map.get #1
if (hasPosition) { [data.x, data.y, data.z] = [v.x, v.y, v.z]; }          // 每点分配 3 元数组
```

**影响（算术推导，非实测）**：13M 点
- 完整过滤判定 **2 × 13M = 2600 万次**，每次 14 次属性读取（≈3.6 亿次属性访问）——全部发生在**写出第一个字节之前**，且无进度反馈；
- `splatOf` + `localOf` = 2 × 13M × 4 B = **104 MB 常驻**到导出结束；
- 每点：14 次字典查表（≈1.8 亿次）、`getMat/getRot/getScale` 各一次 `Map.get`（≈3900 万次）、2 次短命数组（≈2600 万次分配）、3 次 `Math.exp` + `Math.log`（其中 `Math.log(scale.*)` 对同一 palette 索引是常量，却每点重算）。

**建议改法**：①第一遍换成**廉价谓词**（只看 `state` 的 deleted/selected 位）用来分配上界，第二遍用完整谓词填充，末尾 `subarray(0, idx)` 并同步 `meta.numGaussians = idx`（贵的逐属性扫描 2 遍 → 1 遍，前置停顿大致砍半）；②补一句 `idx !== total` 断言——当前若两遍不一致，尾部条目保持 0，会**静默写出"第 0 个 splat 的第 0 个高斯"而不是报错**；③`element`/属性表提到谓词外；④`SingleSplat.read` 用预分配槽位表替代 `data[name]` 动态键、去掉解构数组字面量、把 `getTransform(i)` 一次取全（消掉 3 次 Map 查找）、把 `Math.log(scale)` 预算进缓存。风险：低；**不改变输出字节**（若要求严格逐字节一致，就只做前 3 项 + 第 ④ 项里除"log 加法化"以外的部分，log 加法化会引入 1 ulp 差异）。

---

## 10.【中】导出/导入没有任何并发守卫或代际标记（crop 还原、旧下标、单例 logger）

**位置**：`src/app/file-handler.ts:508-558`（crop 标记/还原）、`630-693`（`scene.export` 与 `scene.write`）、`src/splat/splat-serialize.ts:815,868,885,966`（模块级 logger）

**问题（三处共享状态，均无守卫）**：

```ts
// file-handler.ts:529-548 —— 为了还原而整份 slice + 一个最多 13M 项的 JS 数组
const orig = state.slice();
const changed: number[] = [];
for (let i = 0; i < n; i++) {
    if ((state[i] & State.deleted) !== 0) continue;
    ...
    if (!cropBox.isPointInsideWorld(...)) { state[i] |= State.deleted; changed.push(i); }
}
if (changed.length > 0) restoreFns.push(() => { for (const idx of changed) state[idx] = orig[idx]; });
```
```ts
// file-handler.ts:633-637 用"当时"的列表生成名字给弹窗选 splatIdx …
const splats = getSplats();
const options = await events.invoke('show.exportPopup', exportType, splats.map(s => s.name), ...) as SceneExportOptions;
// … 然后 file-handler.ts:687 用同一个数字索引去取"现在"的列表
const splats = splatIdx === 'all' ? getSplats() : [getSplats()[splatIdx]];
```

1. **crop 标记/还原写在同一份 `state` 数组上**，绕过 `SplatState`（`splat-state.ts:16-18` 自称 sole writer）且不 `markDirty`。两次导出重叠时，先结束的那个会把后一个刚打上的 crop 标记**按自己的 `orig` 还原掉** ⇒ 后一个导出静默写出未裁剪数据。顺带：注释（`:554-556`）假设"视口会把删除的点渲成红色"，但绕过 `markDirty` 后 `stateTexture` 收不到这次改动，该假设不成立。
2. **按数组下标复用旧快照**：`showExportPopup` 期间若有非用户事件改变可见 splat 集合（异步加载完成、`attachLodFromFile` 返回、序列播放、undo 队列），`getSplats()[splatIdx]` 可能取到**另一个** splat，或 `undefined`（随后 `s.splatData` 直接 TypeError）。
3. **模块级单例 logger renderer**：每个导出函数开头无条件 `setRenderer(...)`，`catch` 里再 `unwindAll(true)` ⇒ 两次导出重叠时进度条互相覆盖、`unwindAll` 会收掉对方的顶层 scope。
4. **临时开销**：`orig` = 13.0 MB 必然拷贝；`changed` 最坏 13M × 8 B ≈ **104 MB**（SMI 数组）+ 增长翻倍瞬时开销，全部发生在"点完导出、进度出现之前"的同步窗口。

**可达性（如实说明）**：`#spinner-container` 与 `#progress-container` 是全屏遮罩（`pointer-events: all`），鼠标路径下**很难**发起并发导出，导出也没有快捷键；因此当前主要是"非用户事件"命中第 2 条，以及将来任何脚本/自动化触发路径命中第 1、3 条。代码里没有任何一层防护（无 `exporting` 布尔、无代际号、无 `AbortSignal`、无"导出期间冻结编辑"）。

**建议改法**：①`scene.write` 首行 `if (exporting) return;`（`finally` 复位）；②导出选项带 **splat 稳定标识**（引用/名字），按标识在当前列表里查，找不到即报错退出；③crop 还原改成 `state[idx] &= ~State.deleted`（同一裁剪判定重扫或记 `IndexRanges`，1.6 MB 级），顺带删掉 `orig`/`changed` 两样临时物；④每个导出自建 renderer 或给 renderer 加 token，`unwindAll` 只在"本次真的开过 scope"时调。风险：低；行为变化 = 并发导出从"静默出错"变成"第二次被拒绝"。预期收益：去掉 13 MB + 最坏 104 MB 的瞬时分配，并消除一类"导出文件内容不对但没有任何报错"的可能。

---

## 11.【中】去浮云 + 连通簇的检测算法：3 遍全量扫描、~380 MB 临时数组、体素化走 Map

**位置**：`src/splat/floater-removal.ts:131-258`（`estimateSpacing`）、`302-346`（spacing/包围盒/格子）、`349-405`（计数与中位数）、`src/splat/cluster-filter.ts:85-98`（自己的包围盒）、`107`（`estimateSpacing`）、`114-133`（体素化走 `Map<number,number>`）、`148-182`（26 邻域洪泛）

**问题**：
1. **同一份数据被扫 3 遍以上**：`detectFloaters` 先调 `estimateSpacing`（其内部第一遍求包围盒 + 第二遍 counting sort），返回后 `detectFloaters` 自己**再求一遍包围盒**（`:313-324`），第三遍才做逐点邻居计数（`:372-405`）。`estimateSpacing` 内部的 `start/cellOf/pointOf/items` 四张全量表在返回时全部被丢弃。
2. **13M 点的临时 typed array ≈ 380 MB**：`cellX/cellY/cellZ/counts` 各 `Int32Array(numSplats)` = 4 × 52 MB，加 `mask` 13 MB，加 `estimateSpacing` 的 3 × 52 MB。每一次防抖 tick、每一个目标模型都来一遍（第 3 条）。
3. **连通簇缺 dense 快路径**：`floater-removal` 已经在 `:345-347` 实现了"格子数 ≤ 8e6 用 `Int32Array`、否则才用 `Map`"的分支，而 `cluster-filter` 只有 `Map<number,number>`（`:117`），且洪泛里**每个占用体素做 26 次 `Map.get`**（`:163-177`）：

```ts
// cluster-filter.ts:173-177
const nv = keyToIndex.get(packKey(nx, ny, nz));
if (nv !== undefined && label[nv] === -1) { label[nv] = id; stack[sp++] = nv; }
```

**影响（估算）**：
- `detectFloaters`：文档实测 93 万点 **0.5 s**（含 `estimateSpacing` 20 ms）；13M 点线性外推 ≈ **7 s**，其中计数阶段 13M × 27 格查找 ≈ 3.5 亿次读取是主体。
- `detectClusters`：13M 次 `Map.get` + 13M 次 `Map.set`（体素化）+ 洪泛的 26 × 体素数 次 `Map.get`。按占用体素 300 万估 ⇒ **约 7800 万次 Map 查询**，估算 **4–10 s**；`voxelCoords` 还是普通 number 数组（3 个体素数 × 8 B，6M 体素时 ≈144 MB）。
- 内存侧：一次检测峰值 ≈ **380 MB 临时分配**，而用户场景本身已驻留 728 MB 列数据 + GPU 副本。

**建议改法**（按收益排序）：
1. `detectFloaters`：用**一个** `Int32Array` 存线性格号（`(ix*gridNY + iy)*gridNZ + iz`）替掉 `cellX/cellY/cellZ`，**省 104 MB**；`counts` 改 `Uint16Array` 并饱和（阈值远小于 65535），**再省 26 MB**（中位数可从计数直方图取，避免为了取中位数而保留全量）；`estimateSpacing` 改成接收调用方已算好的包围盒（或在 `detectFloaters` 里内联），**去掉 1 遍全量扫描**。
2. `cluster-filter`：照抄 `floater-removal:345-347` 的 dense/sparse 分支——格子数可控时用 `Int32Array`（线性索引直查，无哈希），洪泛的 26 次邻域查询随之变成 26 次数组读取；`voxelCoords` 改 `Int32Array`；索引表（`keys`/`voxelCoords`）在 dense 模式下可完全不要。
3. 两者都搬进 Worker（同第 3 条）。

预期收益（估算）：13M 点 `detectFloaters` 的计数阶段从"27 次三重循环 + 3 张表"降到"1 张表 + 3 次循环展开"，配合少一遍扫描，**时间约 −30~50%、峰值内存 −50%**；`cluster-filter` 的 Map→dense 是**数量级**差异（Map 查询 ~50 ns/次 vs 数组 ~1 ns/次），估算从 4–10 s 降到亚秒~2 s。风险：低—中（`Uint16` 饱和必须保证饱和值不会压低"典型密度"中位数，需断言 `reference < 65535`；dense 模式的格子数上限判据要按 13M 模型复核，避免退回 Map）。精度：判据与阈值完全不变，`voxelSize` 与簇划分也不变（同一套 `packKey` 语义）。

---

## 12.【中】平面修复（熨平地面）全在主线程同步跑：字符串 key 空间哈希 + 每候选 2×27 次查询

**位置**：`src/geometry/planar-fix.ts:105-127`（`countWithin` 内层拼字符串 key）、`272-350`（检测主循环）、`403-578`（`applyFix` 全列重分配）；调用方 `src/geometry/semantic-select.ts:104-122`、`src/app/editor.ts:1837-1851`

**问题**：右键「熨平地面」→ `semanticSelect(..., flattenGround: true)` → `applyFix` 全程同步在主线程，且邻居查询用**字符串 key**：

```ts
// planar-fix.ts:111-124
for (let dx = -range; dx <= range; dx++) {
    for (let dy = -range; dy <= range; dy++) {
        for (let dz = -range; dz <= range; dz++) {
            const arr = this.grid.get(`${cx + dx},${cy + dy},${cz + dz}`);   // ← 每次拼一个字符串
            ...
            for (const idx of arr) { ... if (ddx*ddx + ddy*ddy + ddz*ddz <= r2) count++; }
```

`thickness`（`semantic-select.ts:105-114`）= `6 × tol`，而 `tol` 默认是包围盒对角线的 1% ⇒ 板厚 6% 对角线；每个候选点调 `countWithin` **两次**（邻居数判据 + 补漏判据），每次内层是 `27 × (格子内点数)` 次距离计算 + 27 次字符串分配。最后 `applyFix` 一次性 `new Float32Array(outCount) × 15`（≈741 MB 级）。

**影响**：用户模型上候选集可达数百万 ⇒ 字符串分配 ≈ 13M（建格）+ 2×27×候选数（数亿次），叠加全列重分配；而 `editor.ts:1837-1851` 是先 `fire('startSpinner')` 再**同步**调用 ⇒ spinner 画不出来，整窗无响应（估算；与 `docs/archive/表面平整专项记录-2026-08-04.md` 记的"Phase2 卡死"是同一类现象，但那里的具体阈值/上限已回退或归档，不复述）。

**建议改法**：①搬进 Worker（该文件是纯计算，只依赖 `x/y/z/state` 与颜色列）；②把字符串 key 换成整数 key——`surface-analyzer.ts:323-325` 已有 32 位打包实现可复用（估计邻居层 3–8×，估算值）；③`countWithin` 结果缓存复用（省一半 pass）；④内层展开为标量、去掉每点 `Vec3`/`projectToBasis` 对象；⑤分块 `yield` + 进度；⑥补漏格点数加上限。风险：中（⑤会把结果变为异步，调用方 `editor.ts` 需要 await 化）；精度不变。

---

## 13.【中】`SplatsTransformOp.undo()` 静默把未命中的调色板索引写成 0（=恒等矩阵）

**位置**：`src/core/edit-ops.ts:346-396`（do/undo 的逐点循环）、`src/splat/splats-transform-handler.ts:105-136`（`start()` 里的 palette 分配）

**问题**：`do`/`undo` 用 `Map.get()` 的结果直接写 `Uint16Array`，未命中即 `undefined` ⇒ 写入 0（恒等矩阵），且**没有任何检查**：

```ts
// edit-ops.ts:352-356（do）
for (let i = 0; i < state.length; ++i) {
    if (state[i] === State.selected) {
        indices[i] = paletteMap.get(indices[i]);     // 未命中 → undefined → 0
    }
}
```
```ts
// edit-ops.ts:379-389（undo）
const inverseMap = new Map<number, number>();
paletteMap.forEach((newIdx, oldIdx) => { inverseMap.set(newIdx, oldIdx); });
for (let i = 0; i < state.length; ++i) {
    if (state[i] === State.selected) {               // ← 用"撤销那一刻"的选中集
        indices[i] = inverseMap.get(indices[i]);     // 未命中 → 0
    }
}
```

**影响**：循环条件用的是**执行时刻**的 `state[i] === State.selected`，而 `paletteMap` 是 **do 那一刻**构建的。只要在 do 与 undo 之间选中集发生变化（例：`MultiOp` 里先改选区、或用户对同一批高斯做了两次变换后只撤销其中一次），未命中的行就会被写成 0 = **该高斯的变换被无声清掉**，而它看起来只是"位置弹回去了"，极难归因。此外 `state[i] === State.selected` 的严格相等会漏掉 `selected|locked`（=3）的行（隐藏的高斯被排除在变换外，两处一致，属既有语义）；性能上 do/undo 各扫一遍 13M（`edit-ops.ts:352,385`）+ 一次全量 `updatePositions()` GPU 回读。

**建议改法**：①未命中时保留原值并 `console.warn`（或抛错），不要写 0：
```ts
const next = paletteMap.get(indices[i]);
if (next === undefined) { console.warn('[transform] palette miss', i, indices[i]); continue; }
indices[i] = next;
```
②把"要改哪些行"从 `SelectOp`/`SelectRangeOp` 已经算好的 `IndexRanges` 传进来（`IndexRanges.forEach` 只遍历选中行），把 O(13M) 降为 O(选中数)——用户场景里边框选通常只占百分之几，这条能省掉绝大多数扫描。风险：低；不改变正常路径的数值。

---

## 14.【中】对比工具的每次刷新分配与直方图提取：49.6 MB/帧 + 4×148.9 MB 拷贝

**位置**：`src/compare/compare-analysis.ts:240-254`（掩码尺寸）、`262/274/290/308/329/352/367`（只写采样下标）、`608-668`（消费端同样只读采样下标）、`713-752`（逐点渐变）、`src/compare/compare-stats.ts:59-75`（x/y/z/distance 各调一次 `getCenters()`）、`618-629`（构造时 `recomputeAll`）

**问题**：

```ts
// compare-analysis.ts:240-254
const numSplats = centers.length / 3;
const N = Math.min(numSplats, 8000);        // max sampled points
const mask = new Float32Array(numSplats);   // ← 13M × 4 B，只用其中 ≤8000 个槽
...
const step = Math.max(1, Math.floor(numSplats / N));
```
```ts
// compare-analysis.ts:608-611（消费端同样只用采样下标）
for (let i = 0; i < sample; i++) {
    const idx = Math.min(n - 1, i * step);
    const sp = projectPoint(centers[idx * 3], centers[idx * 3 + 1], centers[idx * 3 + 2], ...)
```
```ts
// compare-stats.ts:59-75 —— 四个属性各自调一次 gd.getCenters()
{ key: 'x', extract: (gd, n) => sampleFrom3(gd.getCenters(), 0, n) },
{ key: 'y', extract: (gd, n) => sampleFrom3(gd.getCenters(), 1, n) },
{ key: 'z', extract: (gd, n) => sampleFrom3(gd.getCenters(), 2, n) },
{ key: 'distance', extract: (gd, n) => sampleFromCentersMag(gd, n) },
```

而 PlayCanvas 的 `GSplatData.getCenters()` **每次调用都新建**（`node_modules/playcanvas/build/playcanvas.mjs:40835-40846`：`const result = new Float32Array(this.numSplats * 3); for (...) {...}`）。

**影响（算术推导）**：
- `mask`：13,007,105 × 4 B = **52.0 MB（49.6 MiB）**，每次刷新、每个模型；相机刷新按 ~12 Hz（`compare-scene.ts:1196` 每 5 帧）估 ⇒ **约 1.2 GB/s 的零填充垃圾**。过配 1626×（13M/8000）。注意这条路径**不是 CPU 重而是内存重**：所有策略循环都 ≤ 8000 次，唯一与 `numSplats` 成正比的就是这次分配 + `estimateCellSize` 的 2000 点采样——也就是"又快又错"。
- `getCenters()`：13M × 3 × 4 B = **156.1 MB（148.9 MiB）/次**，`recomputeAll` 因 x/y/z/distance 四项各调一次 ⇒ **约 624 MB 瞬时垃圾 + 4×3900 万次元素拷贝**，全部发生 `addModel()` 的同步路径里，而真正用到的只有 4×2000 个 float（32 KB）。对比之下 `compare-analysis.ts:514-523` 对同一问题做对了（按 `gd` 身份缓存）。
- 绘制：第一趟每个命中点 `createRadialGradient` + `arc/fill`，第二趟对同一批点再建 2 个渐变、填 2 次（`:713-752`）⇒ 每命中点 **3 个渐变对象**；按命中 2–5%（文档实测区间）估约 480–1200 个渐变/帧。

**建议改法**：①`mask` 改 `Float32Array(N)`（按采样序号索引）或提到模块级复用，**行为完全不变，49.6 MB → 32 KB**；同样把 `depthBuf`（`:590`，二分屏约 3.6 MB）提为模块级复用；`:709` 的 `createImageData` 移到 floaters 分支之后（该分支根本不用）。②`compare-stats` 的 x/y/z 改成跨步读 `getProp('x'|'y'|'z')`（与 `sampleFrom1` 一致，采样结果逐位相同），**完全不产生 148.9 MB 中间数组**；`distance` 只算一次。③黄色柔光层改成**预渲染一张 sprite canvas**（渐变画一次到 2R×2R 离屏，之后 `drawImage`），视觉等价，渐变对象从数百个降到 1 个。风险：低；精度：①完全不变，②采样点集合与数值一致，③是绘制方式改变（需目视确认边缘柔化一致）。

---

## 15.【中】地面/水域面板的容差被算成整条包围盒对角线（应为 1%），"地面"选区波及全模型

**位置**：`src/tools/ground-water-tool.ts:39`（传参）、`102-118`（本地 `autoTol`）；`src/geometry/region-detect.ts:100`（默认容差）、`319`（`layerTol`）、`370`（`inlierTol`）；对照 `src/geometry/semantic-select.ts:138-156`（正确的 `autoTol`）

**问题**：`ground-water-tool.ts` 自己的 `autoTol` 返回**未乘 0.01 的整条对角线**，但注释声称"与 semantic-select 的 autoTol 一致"（后者返回 `diag * 0.01`）；随后又除以 `params.tolFactor` 的默认值 0.01，两次抵消：

```ts
// ground-water-tool.ts:102-118
/** 包围盒对角线（与 semantic-select 的 autoTol 一致）。 */
function autoTol(splat: Splat): number {
    ...
    return Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2);   // 无 × 0.01
}
```
```ts
// ground-water-tool.ts:23-26 + 39
const params = { tolFactor: 0.01, ghostColorTol: 0.18 };
...
detect: { distanceTol: autoTol(splat) * params.tolFactor / 0.01 },   // = diag × 0.01 / 0.01 = diag
```
```ts
// semantic-select.ts:154-155（正确实现）
const diag = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2);
return Math.max(diag * 0.01, 1e-3);
```
```ts
// region-detect.ts:100 / 319 / 370
const tol = distanceTol ?? Math.max(diag * 0.01, 1e-3);
const layerTol = Math.max(tol * 0.5, (tHigh - tLow) * 0.35);
const inlierTol = Math.max(layerTol, (tHigh - tLow) * 0.5);
```

**影响**：传入 `distanceTol = diag` ⇒ `layerTol = max(diag/2, …)`、`inlierTol ≈ diag/2` ⇒ **厚达半个包围盒对角线的"平面"板内的高斯全部算地面内点**，即"地面"大致等于整个模型（或一大块斜切板）。这是确定性行为错误而非调参问题：面板上任何 `tolFactor ≥ 0.01` 的取值都在同一条失效带上（只有用户把滑块拉到最小才会偶然接近正确量级）。水域检测又以 `ground.inliers` 为输入（`semantic-select.ts:92-99`），错误的内点集继续污染下游；`flattenGround` 也用同一个 `tol`（`semantic-select.ts:105`）决定板厚。

**建议改法**：①`ground-water-tool.ts:102-118` 的 `autoTol` 改为与 `semantic-select` 一致的 `Math.max(diag * 0.01, 1e-3)`，并把 `:39` 的 `/ 0.01` 去掉（让 `tolFactor` 成为相对 1% 的倍率）；②在 `detectDominantPlane` 里给 `tol` 加上限（如 `Math.min(tol, diag * 0.05)`）作为兜底，避免任何调用方再传进全模型尺度的容差。风险：低，但**行为会变（地面选区显著变小）**，需要用户回测；精度：这是修正，不是近似。

---

## 附：优化机会汇总（收益量级 / 风险 / 是否改变行为）

| 优化 | 预期收益（估算，除注明外均非实测） | 风险 | 是否改变行为/精度 |
| --- | --- | --- | --- |
| load worker 打开开关（第 5 条） | 导入的解码+莫顿排序+行重排移出主线程；13M 导入期间 UI 可交互 | 中（先修 `lw-probe.ts` 假绿） | 不变（逐字节等同） |
| `cluster-filter` Map → dense 数组（第 11 条） | 7800 万次 Map 查询 → 数组读取，估算 4–10 s → 亚秒~2 s | 低—中（dense 上限判据需按 13M 复核） | 不变（同 `packKey` 语义） |
| `detectFloaters` 单格号数组 + 复用包围盒（第 11 条） | 峰值内存 ≈ −50%（−130 MB），时间 ≈ −30~50% | 低（`Uint16` 饱和需断言） | 不变 |
| 去浮云/连通簇搬 Worker + 连通簇按需算（第 3 条） | 滑块交互不再冻结；连通簇成本可完全省掉 | 中（`isValid` 闭包需改为传 state 列） | 不变 |
| 破洞模式计数排序替插入排序（第 7 条） | 4K 单视口 12–40 s → 亚秒级 | 低 | 渲染语义不变 |
| `MultiOp.undo` 逆序（第 1 条） | 撤销语义正确（四条组合路径） | 低 | 只改撤销结果 |
| 去浮云面板复用 `result.count`、按需检测（第 3/9 条） | 免掉一次全量检测 + 一次 `Uint8Array(13M).reduce()` | 低 | 不变 |
| LOD 代理只带几何列（第 2 条） | 消除"编辑随 LOD 显现/消失"，无需改几何管线 | 中（映射边界） | 代理几何仍是近似；状态恢复为精确 |
| `compare` 掩码/`getCenters` 复用（第 14 条） | 52 MB × 12 Hz → 32 KB；建模型瞬时垃圾 624 MB → ~0 | 低 | 不变 |
| `compare` 检测器换 `estimateSpacing`（第 6 条） | 判据从"恒不成立"变为有效 | 中（灵敏度需重新映射） | **有意改变**（标记集合大幅变化） |
| `planar-fix` 整数 key + Worker（第 12 条） | 邻居层 3–8×，主线程不再冻死 | 中（异步化改动调用方） | 不变 |
| 导出前置单遍 + 槽位表（第 9 条） | 前置停顿大致砍半；13M 导出热路径 CPU 数倍级改善 | 低 | 不变（log 加法化除外，1 ulp） |
| `surface-worker` 惰性回退（第 8 条） | 主线程峰值 −741 MB | 低—中 | 不变 |

## 附：已核查并判定为"干净"的点（覆盖说明）

- `IndexRanges` 的 31 位单点标记 / `INDEX_MASK`：13M 量级无溢出；`sortedPredicate` 要求严格递增，调用方 `editor.ts:1742` 用 `new Uint32Array(selected).sort()`（typed array 是数值排序）——**正确**；但该谓词遇到**重复值**会静默截断后续匹配（只前进不回头），属于"将来若有人传未去重数组"的隐患，当前调用方用 `Set` 去重，故不计为缺陷。
- `SplatState.flush()` 的整份 13 MB 上传是**已知**的（源码注释自认），不计为新发现；`setBits/clearBits/toggleBits` 的 lo/hi 脏区跟踪与"全量上传"组合无正确性问题。
- `scene.clear()` → `splat.destroy()` 之后 `history.clear()` 再 `AddSplatOp.destroy()` 的双重 `destroy()`：PlayCanvas `Asset.unload()` 有 `if (!this.loaded && this._resources.length === 0) return;` 守卫，**不会二次释放**，无缺陷。
- 历史截断（`_add` 的 `pop().destroy()` 与 `removeForShape`/`removeForSplat`）与 `isUndoingRedoing()` 的配合逻辑自洽；`SplatsTransformOp.destroy()` 不 `free()` 调色板槽位是**有意且正确**的（那些槽位仍被高斯引用，free 会造成复用后视觉错乱）。
- `splat-serialize.ts` 的 PLY 头部计数（`meta.numGaussians = total`、`lodCounts`、`numChunks`）与库内使用的 `N` 同源，**不存在"行数写错变量"**；`loader.ts:189` 用 `Uint32Array`（上限 4.29e9），13M 无 32 位索引溢出；库内 `permuteRowsInPlace` 按字节缓存复用，峰值仅 1 列 52 MB。
- `lod-worker.ts` 的 transfer 语义正确（主线程先深拷贝再 transfer，失败回退），`applyLod` 有越界守卫（`splat.ts:509`）；`lod.ts` 的层级顺序（细在前 + `slice().reverse()`）与 `suggestLodLevel` 的 `T(i)` 假设一致，**当前无选层错位**。
- `cluster-filter` 的洪泛用显式 `Int32Array` 栈、入栈即打标，栈不溢出；簇阈值 `sizes[c] < threshold` 无 off-by-one；`packKey` < 2^51 在 double 内精确（与 `docs/V3-WebGPU-现状.md:849-855` 的记录一致）。
- `compare` 的分析路径无异步竞态（全同步，`compare-scene.ts:411-438`、`:1192-1199`），不需要代际号；文件导入有 `importing` + 按钮禁用双闸门。
- 水/地以外的 `plane-fit.ts` 退化处理干净（共线→PCA、零协方差→法线兜底、无除零/NaN 传播）；`surface-worker-client` 的 transfer 方向正确，未发现 use-after-neuter。
- 导入 blob 读取有背压且分片正确（`file-systems.ts:31-44,62-73,90-99`）；导出进度不会超 100%。

## 附：本轮未做的验证（诚实边界）

- 所有耗时/内存数字除注明"文档实测"者外，均由代码常量与循环次数**推导**，未做 profile（本轮不允许运行代码/构建/测试）。
- 未验证：LOD 实验开关打开后的实际观感（第 2 条的最终呈现）、导出并发竞态的实际触发（第 10 条的可达性已如实降级说明）、`surface-worker` 在 13M 上的实际峰值内存（第 8 条为估算）。
- 建议的确认手段：`_tmp/` 下写探针在用户 13M 模型上量 ①去浮云面板一次防抖的实际冻结时长 ②导出前置两遍的耗时 ③表面细化的 `performance.memory` 峰值；第 1 条可直接扩 `docs/verify/verify-floater-removal.cjs`（"撤销后选区逐位等于操作前"）。
