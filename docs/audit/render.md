# 渲染 / 着色器 / 相机 / 拾取 链路 —— 只读审计（3.21.0）

审计范围：`src/shaders/**`、`src/splat/{splat,splat-state,splat-overlay,group-renderer,splat-serialize,gpu-camera-uniforms,gpu-projection}.ts`、
`src/scene/{picker,camera}.ts`、`src/camera/camera.ts`、`src/app/render.ts`、`electron-main.js`、`src/index.ts`。
为核实“后端不一致 / 引擎 API 是否存在”，另外读了 `node_modules/playcanvas/build/playcanvas.dbg.mjs`（2.21.3，未压缩）与 `scripts/apply-patches.js`。

**未修改任何文件、未 build、未跑测试。** 每条都附实际读到的代码原文；凡是“读代码得出、没有运行时验证”的推断，都在正文里写明。

已读过 `docs/HANDOFF.md`、`docs/进度存档.md`、`docs/V3-WebGPU-现状.md` 的相关节，
凡文档已明确记录为“已知/已结案”的（回读朝向分后端、pick/深度回读必须 `immediate: true`、128MB 绑定上限、8192 纹理上限、
13M 点推杆 ~600ms 的三步 O(n)）**一律不重复立项**，只在有代码残留时作为“已有结论的残留位置”提及。

## 结论速览

| # | 严重度 | 一句话 | 位置 |
| --- | --- | --- | --- |
| 1 | 高 | 每帧排序兜底在第一次派发后**永久失效**（依赖引擎里不存在的 `_sortInFlight`/`_pendingCamera`，worker 也不读 `forceUpdate`） | `splat.ts:771-786`、`scene.ts:708-722` |
| 2 | 高 | `render.offscreen` 回读仍无条件翻 Y：WebGPU 下泛洪（去浮云）选择的种子与结果整体上下镜像 | `render.ts:355-363` |
| 3 | 高 | WebGPU 的裁剪空间 z 约定自相矛盾（两套矩阵、两种假设）：app 自建矩阵是 GL 约定却被当成 [0,1]；用引擎矩阵的辅助着色器又二次 `*0.5+0.5` | `gpu-projection.ts:14-26`、`splat-shader-wgsl.ts:768-771`、`infinite-grid-shader.ts:88-91` 等 6 处 |
| 4 | 中 | `Splat.destroy()` 不销毁 `stateTexture`/`transformTexture`（列表删除模型即泄漏 ≈39MB/千万点） | `splat.ts:463-469` |
| 5 | 中 | `SplatState.flush()` 每次全量上传 + O(n) `recount()`，`dirtyLo/Hi` 只当布尔用 | `splat-state.ts:109-121` |
| 6 | 中 | 环模式把拾取结果装进 `Set` 再对 1300 万点做 `has()`（约 200–400ms，可降到 <10ms） | `editor.ts:1155-1161` |
| 7 | 中 | `focalPoint()` 没有采样上限，1300 万点一次聚焦阻塞主线程 ≈0.5–1.5s（`denseRadius()` 有 stride，它没有） | `splat.ts:930-975` |
| 8 | 中 | 导出每帧同步回读，WebGL2 上每次至少 16ms 轮询下限；渲染/回读/编码三线完全串行 | `render.ts:848/1179/1549` |
| 9 | 中 | 关键帧 360 每个关键帧重建整套 `EquirectRenderer`（4K 下 ≈145MB/帧的驱动级分配释放） | `render.ts:1126-1130,1167-1170` |
| 10 | 中 | `waitForSort` 没有 `clearTimeout`：每次成功排序都留下定时器并打**假的**“排序超时”警告 | `render.ts:247-263` |
| 11 | 中 | 相机在包围球内时 `near = far/16384`，深度缓冲精度几乎耗尽 | `camera.ts:916` |
| 12 | 中 | `Picker.MAX_UNION_READ_PX` 允许一次 32MB 的阻塞回读（注释写 8MB，实为 4.2M×8B） | `picker.ts:261,302-307` |
| 13 | 低 | 渲染资源销毁路径漏 destroy（`SplatOverlay` 的材质/网格、`Camera` 的 4 个 RT + 3 张纹理） | `splat-overlay.ts:133-136`、`camera.ts:666-686` |
| 14 | 低 | `readIds()` 在 WebGL2 下不翻行序（目前只当集合用所以不发作，属定时炸弹） | `picker.ts:150-189` |

优化机会单列在文末（含预期量级与风险）。

---

## 1. [高] 每帧排序兜底在第一次派发之后永久失效：依赖了 PlayCanvas 2.21.3 里不存在的 `_sortInFlight` / `_pendingCamera`

- 位置：`src/splat/splat.ts:722-788`（`onPreRender` 的排序兜底）与 `src/scene/scene.ts:683-726`（合并实体的同一套兜底）

- 问题：这段代码的意图是“每帧用更紧的 epsilon 强制重排”，实现方式是直接操纵引擎 sorter 的私有字段做自制的 in-flight 合并：

```ts
// src/splat/splat.ts:771-786
try {
    const ws = inst.sorter as any;
    if (ws._sortInFlight) {
        ws._pendingCamera = {
            pos: { x: _fallbackLocalPos.x, y: _fallbackLocalPos.y, z: _fallbackLocalPos.z },
            dir: { x: _fallbackLocalDir.x, y: _fallbackLocalDir.y, z: _fallbackLocalDir.z }
        };
    } else {
        ws._sortInFlight = true;
        ws.worker.postMessage({
            cameraPosition: { x: _fallbackLocalPos.x, ... },
            cameraDirection: { x: _fallbackLocalDir.x, ... },
            forceUpdate: true
        });
    }
} catch (e) { /* best-effort */ }
```

但 2.21.3 的 `GSplatSorter` **没有** `_sortInFlight`，也**没有** `_pendingCamera`，而且谁都不会把这个字段重置回 false：

```js
// node_modules/playcanvas/build/playcanvas.dbg.mjs:64800-64822
var GSplatSorter = class extends EventHandler {
  constructor(device, scene) {
    super();
    __publicField(this, "worker");
    __publicField(this, "target");
    __publicField(this, "orderData");
    __publicField(this, "centers");
    __publicField(this, "scene");
    __publicField(this, "uploadStream");
    __publicField(this, "pendingSorted", null);   // ← 真正的“结果待应用”字段
```
```js
// 64920-64925：引擎自己的派发口，没有 forceUpdate
  setCamera(pos, dir4) {
    this.worker.postMessage({
      cameraPosition: { x: pos.x, y: pos.y, z: pos.z },
      cameraDirection: { x: dir4.x, y: dir4.y, z: dir4.z }
    });
  }
```

核查方式（可复现）：`grep -r "sortInFlight\|pendingCamera" node_modules/playcanvas/build` → **0 命中**；
`scripts/apply-patches.js` 只打两个补丁（`@playcanvas/splat-transform` 的 `MAX_STRIPE_BYTES`、eslint 插件兼容），**没有** patch 引擎；
所以运行期也不会有这两个字段。

后果有两条，都在同一段代码里：

1. `ws._sortInFlight = true` 执行一次后永远是 `true`（`catch(e){}` 也吞掉了任何异常），
   于是**第一次派发之后，这个兜底再也不会 postMessage**，只反复写一个没人读的 `_pendingCamera`。
   文件里“per-frame main-view sort fallback / The sorter's `_sortInFlight` coalesce already prevents worker queue flooding”
   的注释与 `docs` 里“兜底已生效”的结论都建立在这个字段存在的前提上。
2. 即使那唯一一次派发，`forceUpdate: true` 也是**无效字段**：worker 的消息处理器只认
   `order / centers / chunks / mapping / cameraPosition / cameraDirection`，`forceUpdate` 只由 `centers`/`mapping` 内部置位：

```js
// playcanvas.dbg.mjs:64709-64716、64789-64796
  myself.addEventListener("message", (message) => {
    const msgData = message.data ?? message;
    if (msgData.order) { order = new Uint32Array(msgData.order); }
    if (msgData.centers) { centers = new Float32Array(msgData.centers); forceUpdate = true; ... }
    if (msgData.mapping) { mapping = msgData.mapping ? new Uint32Array(msgData.mapping) : null; forceUpdate = true; }
    if (msgData.cameraPosition) cameraPosition4 = msgData.cameraPosition;
    if (msgData.cameraDirection) cameraDirection3 = msgData.cameraDirection;
    update();
  });
```
```js
// 64602-64605：真正的门限是这里，1e-3，且 app 无法绕过
    const epsilon = 1e-3;
    if (!forceUpdate && Math.abs(px - lastCameraPosition.x) < epsilon && ... ) { return; }
```

- 影响：模型加载后只要相机动过一帧，**所有后续帧都不再有任何“强制重排”**；排序回落到引擎自身的
  `equalsApprox(1e-3)` + worker `1e-3` 门限这条路径（正是这段兜底当初要绕开的东西）。
  用户症状类别就是文档里反复出现的“转动时深度排序陈旧 / 半透明穿插 / 近小远大”。
  另外要说明：文档里用来“验证兜底生效”的探针（`scripts/dev-history/**`，读 `sorter._sortInFlight` /
  `_pendingCamera`）读的其实是 app 自己写下并锁死的字段，所以它们**必然**显示 `true`，没有区分力。

- 建议：用引擎真实 API，把“多紧的门限、多快的节流”变成 app 自己的策略，例如
  `inst.sorter.setCamera(localPos, localDir)` 前用一个自维护的 `(pos,dir)` 差分 + `performance.now()` 时间门限
  （如位移 > 相机到模型距离的 0.1% 或距上次派发 > 33ms 才派发），而不是依赖不存在的字段。
  预期收益：恢复“转动时及时重排”这一真实行为（本质上是修复一个功能失效，不是提速）。
  风险：**不要顺手改成每帧无条件派发** —— 每次排序结果都要把整块 order 上传 GPU
  （13M 点 = 52MB/次，见 `applyPendingSorted()` → `uploadStream.upload(data2, this.target)`，`playcanvas.dbg.mjs:64889-64896`），
  60fps 下就是 3GB/s 的总线流量，必须保留节流。

---

## 2. [高] `render.offscreen` 的回读仍是无条件 Y 翻转：WebGPU 下泛洪选择整体上下镜像

- 位置：`src/app/render.ts:355-363`（消费方 `src/tools/flood-selection.ts:71-99`）

- 问题：3.17.0 把四条导出路径收敛到按后端判断的 `flipReadbackIfNeeded()`（`render.ts:21-33`，只在 `isWebGL2` 时翻），
  但第五条回读路径 —— 泛洪选择用的 `render.offscreen` —— 没改，仍是老代码无条件翻一次：

```ts
// render.ts:355-363
await workTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workTarget, data, immediate: true });

// flip y positions to have 0,0 at the top
let line = new Uint8Array(width * 4);
for (let y = 0; y < height / 2; y++) {
    line = data.slice(y * width * 4, (y + 1) * width * 4);
    data.copyWithin(y * width * 4, (height - y - 1) * width * 4, (height - y) * width * 4);
    data.set(line, (height - y - 1) * width * 4);
}
```
```ts
// 同文件、同用途的 helper（其余 4 处调用点：465 / 803 / 1182 / 1551）
const flipReadbackIfNeeded = (data: Uint8Array, width: number, height: number, device: { isWebGL2: boolean }) => {
    if (!device.isWebGL2) {
        return;
    }
    ...
```

消费方按“第 0 行 = 屏幕顶部”使用这份数据，种子点用的是自上而下的画布坐标：

```ts
// tools/flood-selection.ts:71-78
const data = await (events.invoke('render.offscreen', width, height) as Promise<Uint8Array>);
let current: Pt = { ...point };
const start = (current.y * width + current.x) * PIXEL;
```

- 影响：WebGPU 后端下（设置面板选 webgpu 或 `--gpu=webgpu`）用泛洪/去浮云时，数据相对视口纵向镜像 →
  种子像素取到镜像行、连通域也在镜像后的掩码里扩散，**选中的是上下镜像的区域**。
  默认后端是 WebGL2（`src/core/gpu-backend.ts:11` 的注释与 `getBackendPref() ?? 'webgl2'`），所以默认路径测不出来。
  （`render.ts:16-20` 的注释说“WebGPU 是打包版默认后端”，与代码不一致 —— 这也解释了这条残留为什么一直没被撞到。）

- 建议：直接换成 `flipReadbackIfNeeded(data, width, height, scene.app.graphicsDevice)`，顺带消掉每行 `data.slice()` 的分配
  （1080p 下 540 次小数组分配）。
  预期收益：修掉 WebGPU 下的错误选择区域；风险极低。
  注意：`docs/verify/verify-export-orientation.cjs:165-171` 的静态守卫目前的断言（`calls >= 4 && bareLoops === 1`）
  恰好是被**这段残留循环**满足的（helper 自己的循环写成 `Math.floor(height / 2)`，匹配不上那条正则），
  所以修完这条守卫会变红 —— 需要同时把正则与断言改对（`bareLoops === 0`）。

---

## 3. [高] WebGPU 上裁剪空间 z 约定自相矛盾：app 自建矩阵是 GL 约定却按 [0,1] 用；用引擎矩阵的着色器又二次换算

- 位置：`src/splat/gpu-projection.ts:14-26`、`src/shaders/splat-shader-wgsl.ts:768-771`、
  `src/shaders/infinite-grid-shader.ts:88-91`（同样写法的还有 `box-shape-shader.ts:48-51`、`sphere-shape-shader.ts:32`、
  `tool-overlay-shader.ts:96`、`merge-grid-shader.ts:88`、`debug-shader.ts:33`）

- 问题：这条链路上有两套矩阵、两种 z 约定，而它们被互相矛盾的假设消费。

(a) app 自己造的投影矩阵是 **GL 约定**（NDC z ∈ [-1,1]）：

```ts
// src/splat/gpu-projection.ts:14-26
const buildGpuProjection = (out: Mat4, cam: Camera) => {
    const { nearClip, farClip, aspectRatio } = cam;
    if (cam.projection === PROJECTION_ORTHOGRAPHIC) { ... out.setOrtho(-x, x, -y, y, nearClip, farClip); }
    else { out.setPerspective(cam.fov, aspectRatio, nearClip, farClip, cam.horizontalFov); }
    return out;
};
```
（`Mat4.setPerspective → setFrustum`：`r[10] = -2/(far-near)`、`r[14] = -(far+near)/(far-near)`，`playcanvas.dbg.mjs:6585-6626` 即 GL 约定。）

它被作为材质参数喂给 WebGPU 的 WGSL 着色器（`splat.ts:800-802` → `gpu-camera-uniforms.ts:52-56` 的
`uSplatView`/`uSplatViewProj`/`uSplatProj`），而 WGSL 里按 **WebGPU 约定（z ∈ [0,1]）** 处理：

```wgsl
// src/shaders/splat-shader-wgsl.ts:768-771
var centerProj: vec4f = uniform.uSplatViewProj * applyPaletteTransform(uniform.matrix_model) * vec4f(modelCenter, 1.0);
// ensure gaussians are not clipped by the camera near and far planes
centerProj.z = clamp(centerProj.z, 0.0, abs(centerProj.w));
```
GL 约定的 z 有一半是负的（`z_gl < 0` ⟺ 视深 < ≈2·near），这一 clamp 把它们**全部压成 0**（WebGPU 的最近深度）。
GLSL 分支（`splat-shader.ts:732-736`）则按 GL 约定 clamp 到 `[-|w|, |w|]`，等于没 clamp —— 两个后端从此分叉。
（这条 clamp 正是缺了下面 (b) 那次换算的补丁：没有它，近处高斯的 z 为负会被 WebGPU 直接裁掉、整片消失。）

(b) 引擎在 WebGPU 上**已经**替所有走引擎 uniform 的着色器做了 -1..1 → 0..1 的换算：

```js
// playcanvas.dbg.mjs:39963-39979  （Camera.applyShaderProjectionTransform）
  static applyShaderProjectionTransform(projection, out, flipY, applyWebGpuDepthRange) {
    ...
    if (flipY) { out.mul2(_Camera._flipYProjectionMatrix, projection); return out; }
    out.mul2(_Camera._webGpuDepthRangeMatrix, projection);   // z' = 0.5z + 0.5w
    return out;
  }
```
```js
// playcanvas.dbg.mjs:47548-47549、47577、47591-47592
      const webgpu = this.device.isWebGPU;
      projMat = Camera.applyShaderProjectionTransform(projMat, _tempProjMat0, flipY, webgpu);
      ...
      this.projId.setValue(projMat.data);
      ...
      viewProjMat.mul2(projMat, viewMat);
      this.viewProjId.setValue(viewProjMat.data);
```

而 app 的辅助着色器仍然按 GL 公式把 clip z 换算成深度（`gl_FragDepth` 在 GL 与 WebGPU 都是 [0,1]，
所以这个公式在 WebGL2 上是对的、在 WebGPU 上就多做了一次 0.5z+0.5）：

```glsl
// src/shaders/infinite-grid-shader.ts:88-91
float calcDepth(vec3 p) {
    vec4 v = matrix_viewProjection * vec4(p, 1.0);
    return (v.z / v.w) * 0.5 + 0.5;
}
```

- 影响：
  1. 走 (a) 的高斯/中心点覆盖层的裁剪 z 与引擎画的几何不同约定（近处被压成深度 0，即“永远赢得 depth test”）；
     实际可见程度受 near 很小所限（`camera.ts:916` 让 near ≈ far/16384，`z_gl<0` 对应视深 < ≈2·near），
     所以现在主要表现为“约定错误被 clamp 掩盖”，而不是大面积穿帮。
  2. 走 (b) 的辅助几何（无限网格、盒体/球体裁剪体、工具覆盖层、合并网格、debug 线框）在 WebGPU 上写出的深度被
     **系统性压缩到 [0.5, 1]**（真实深度 0.6 会写成 0.8），于是它们与模型之间的遮挡关系在两个后端不一致 ——
     网格/裁剪体裁剪体原本靠 `writeDepth(blue noise)` 做的“点阵式遮挡”在 WebGPU 上位置不对。
  （本条的“像素级表现”我**没有**运行时验证；上面的约定不一致是直接读 app 源码 + 引擎源码得出的。）

- 建议：统一到一个约定，最省事的方向是**让 app 自建矩阵也走引擎同一条换算**：
  `Camera.applyShaderProjectionTransform(projMat, out, false, device.isWebGPU)`（或直接在 app 侧对 z 行做 `0.5z+0.5w`），
  然后**删掉** `splat-shader-wgsl.ts:771` 的 clamp（它本来就是为这个不一致打的补丁）；
  同时把 `calcDepth` 改成按后端分支（WebGPU：`v.z/v.w`；WebGL2：`v.z/v.w*0.5+0.5`），
  可以沿用现成的 `withFragCoordDefine`/`setDefine` 机制加一个 `GSPLAT_CLIP_Z_01` 之类的 define。
  预期收益：两后端几何/深度一致，消除一类“只在 WebGPU 上偏一点”的怪现象。
  风险：中 —— 需双后端逐像素回归（`docs/verify/verify-export-orientation.cjs`、`verify-selection-depth.cjs` 可扩展），
  且 `applyShaderProjectionTransform` 是引擎公开静态方法（`Camera` 上有文档注释），不属私有 API。

---

## 4. [中] `Splat.destroy()` 不销毁状态纹理 / 变换纹理：从列表删除模型即泄漏

- 位置：`src/splat/splat.ts:463-469`（对照 `replaceData` 里确实销毁了：`:450-452`）

- 问题：两张纹理在 `bindAsset()` 里创建（`splat.ts:327-329`），`replaceData()` 会销毁旧的，
  但常规销毁路径不销毁：

```ts
// splat.ts:463-469
destroy() {
    super.destroy();
    this.releaseLodAssets();
    this.entity.destroy();
    this.asset.registry.remove(this.asset);
    this.asset.unload();
}
```
```ts
// splat.ts:327-329（创建）
this.stateTexture = createTexture('splatState', PIXELFORMAT_R8);
this.state = new SplatState(splatData.getProp('state') as Uint8Array, this.stateTexture);
this.transformTexture = createTexture('splatTransform', PIXELFORMAT_R16U);
```
`stateTexture` 只被材质参数引用（`material.setParameter('splatState', this.stateTexture)`，`splat.ts:185-186`），
PlayCanvas 的 `Material.destroy()` 不会销毁传给它的纹理，所以随 `entity.destroy()` 一起消失的只有引用。

- 影响：可达路径是 splat 列表的删除按钮（`src/ui/splat-list.ts:406` 的 `splat.destroy()`，有确认框），
  以及 `src/core/edit-ops.ts:624`、`src/scene/scene.ts:431`。
  量级：纹理按 `textureDimensions`（宽×高）分配，1300 万点 ≈ 4096×3175 → R8 约 13MB + R16U 约 26MB ≈ **39MB VRAM/次**，
  反复“加载→删除”会累积（另外 `transformPalette` 的纹理是否随元素销毁也需要一并确认，见 `src/splat/transform-palette.ts`）。

- 建议：在 `destroy()` 里补 `this.stateTexture?.destroy(); this.transformTexture?.destroy();`
  （或把纹理所有权明确交给 `SplatState`，由它提供 `destroy()`），并确认 `transformPalette` 的释放。
  预期收益：删除模型后 VRAM 真正回落；风险：低 —— 唯一要注意的是别与 `replaceData()` 里已有的销毁重复调用。

---

## 5. [中] `SplatState.flush()` 每次全量上传 + 全量 recount，`dirtyLo/Hi` 只被当布尔用

- 位置：`src/splat/splat-state.ts:38-46`（记录区间）、`:87-105`（recount）、`:109-121`（flush）

- 问题：区间信息被记下来却只当“有没有脏”的开关用，上传是整张纹理，计数是从头扫全表：

```ts
// splat-state.ts:109-121
flush(): void {
    if (this.dirtyLo < 0) return;
    // full upload. sub-rect upload is a worthwhile future optimisation
    // (would drop a 4M-byte upload to a few KB for small selections) but
    // requires engine-side support; current path keeps the same behaviour
    // as the prior `updateState` lock/set/unlock pair.
    const buffer = this.gpu.lock() as Uint8Array;
    buffer.set(this.data);
    this.gpu.unlock();
    this.recount();          // ← O(numSplats)，与 dirty 区间无关
    this.dirtyLo = -1;
    this.dirtyHi = -1;
}
```
```ts
// splat-state.ts:87-101
private recount() {
    const { data } = this;
    let numSelected = 0; ...
    for (let i = 0; i < data.length; ++i) { ... }
```

- 影响：`HANDOFF.md` 第 6.1 节把 13M 点推杆剩下的 ~600ms 归因为“`IndexRanges` + 状态位回写 + 上传三步 O(n)”。
  这里其中**两步**其实可以按 dirty 区间做：计数只需把 `[dirtyLo, dirtyHi)` 的旧值减掉、新值加上（区间由
  `setBits/clearBits/toggleBits` 精确维护），上传理论上只需覆盖脏区间所在的行带。
  量级（估算）：13M 点上一次 `recount()` 约 10–30ms（严格依赖式单次扫描），一次 `flush()` 全量上传 13MB；
  按区间做之后计数接近 0、上传降到几 KB–几 MB 量级。

- 建议：① `recount()` 改增量（在 `dirtyLo/Hi` 上做差量更新，注意 `deleted` 优先于 `locked` 优先于 `selected` 的现有判定顺序）；
  ② 上传先做“行带子矩形” —— 引擎的 `Texture.lock/unlock` 没有子矩形接口，需要自建一张按行带更新的 R8 纹理
  （或走 WebGL `texSubImage2D`/WebGPU `writeTexture` 的私有路径），这一步风险更高，建议只对超大模型开启。
  预期收益：推杆/笔刷这类小块改动从“几十 ms 的 JS + 全量上传”降到接近 0；风险：低（计数）→ 中（子矩形上传）。

---

## 6. [中] 环模式把拾取结果装进 `Set`，再对 1300 万个索引做 `has()` 查询

- 位置：`src/app/editor.ts:1147-1165`

- 问题：`pickRect` 返回的是去重前的 id 数组（可能几百 MB 级别的矩形），代码把它塞进 `Set`，然后逐点查询：

```ts
const picked = new Set<number>();
for (let i = 0; i < pick.length; i++) {
    picked.add(pick[i]);
}
for (let i = 0; i < numSplats; i++) {
    hit[i] = picked.has(i) ? 255 : 0;
}
```

- 影响：`picked` 的规模远小于 `numSplats`，但那个 1300 万次的 `Set.has` 是纯哈希查找：实测级别约 200–400ms
  （同一处附近还有 `preMask` 的 13M 扫描和 `IndexRanges.fromPredicate` 的两次 13M 扫描，属文档已记的 774ms 手势耗时）。

- 建议：先建一个 `Uint8Array(numSplats)`（13MB，可复用）把 `picked` 写进去，再顺序读；
  或直接复用已有的 `hit` 数组：`hit.fill(0); for (id of pick) hit[id] = 255;`。
  预期收益：这一步 200–400ms → <10ms（约 20–40×），风险极低（注意过滤掉未命中像素的哨兵值 `0xFFFFFFFF`）。

---

## 7. [中] `focalPoint()` 没有采样上限：1300 万点一次“聚焦”阻塞主线程

- 位置：`src/splat/splat.ts:930-975`（对照 `denseRadius()` 在 `:1004` 有 stride 采样）

- 问题：同样的加权统计，`denseRadius()` 对超过 50 万点做了采样，`focalPoint()` 没有，逐点算 4 次 `Math.exp`：

```ts
// splat.ts:953-962
for (let i = 0; i < numSplats; i++) {
    const op = 1 / (1 + Math.exp(-opacity[i]));
    const w = op / (1 + Math.exp(Math.max(sx[i], sy[i], sz[i])));
    sumX += x[i] * w; sumY += y[i] * w; sumZ += z[i] * w;
    totalWeight += w;
}
```
```ts
// splat.ts:1004（denseRadius 的对应处理）
const stride = numSplats > 500000 ? Math.ceil(numSplats / 200000) : 1;
```
调用点：`src/app/editor.ts:561`（`camera.focus` 事件处理，用户点“聚焦/框住模型”），以及 `src/splat/splat-group.ts:52`（对组内每个 splat 各来一遍）。

- 影响（估算）：1300 万点 × 4 次 `Math.exp` ≈ **0.5–1.5s** 的完全主线程阻塞（UI 冻结），且组模式下乘上成员数。

- 建议：照 `denseRadius()` 的做法加 stride（例如 >50 万点按比例采样到 ~20 万点），或把两项统计合并成一次扫描并缓存
  （模型未编辑时复用）。预期收益：聚焦从秒级降到毫秒级；风险：低（采样会让焦点位置有极小偏移，用户不可感知）。

---

## 8. [中] 导出管线每帧同步回读，WebGL2 上每帧至少 16ms 的轮询下限，渲染/回读/编码三线串行

- 位置：`src/app/render.ts:848`（视频）、`:1179`（关键帧）、`:1549`（旋转台），回读后立即 `encodeFrame`

- 问题：每帧都是 `await read → await encode → 下一帧`，没有任何 in-flight 重叠；而引擎的回读实现在 WebGL2 上
  用 16ms 粒度的定时器轮询 fence：

```js
// playcanvas.dbg.mjs（2.21.3）clientWaitAsync / readPixelsAsync 路径
    clientWaitAsync(flags, interval_ms) {
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      this.submit();
      return new Promise((resolve2, reject) => {
        function test() {
          const res = gl.clientWaitSync(sync, flags, 0);
          if (res === gl.TIMEOUT_EXPIRED) { setTimeout(test, interval_ms); }   // interval_ms = 16
          ...
```
```js
      const buf = gl.createBuffer();                               // 每次回读新建 PBO
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, pixels.byteLength, gl.STREAM_READ);
      gl.readPixels(x3, y2, w, h2, format, pixelType, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      await this.clientWaitAsync(0, 16);
```
（`immediate: true` 在这条路径上只多做一次 `gl.flush()`，不改变等待方式。）

- 影响（估算，机制来自引擎源码、量级为推算）：每帧一个 ≥16ms 的等待下限，30fps 导出 300 帧 ≈ 至少 4.8s 的纯等待；
  三线串行意味着 GPU 在编码时闲着、CPU 在回读时闲着。文档只在 `src/data-processor/gpu-readback.ts:4-6` 记了
  “16ms 轮询”是为了 TDR 风险，没记它对导出吞吐的影响。

- 建议：把“渲染第 N+1 帧”与“回读/编码第 N 帧”解耦（2–3 帧 in-flight，自持每帧 `data` 缓冲并池化复用，
  现在是每帧新建 `new Uint8Array(w*h*4)`）。预期收益 20–40% 端到端（未实测）；
  风险：中 —— 需要管好 `VideoFrame` 生命周期与 GPU 命令缓冲深度（TDR）。

---

## 9. [中] 关键帧 360 导出：每个关键帧重建一整套 `EquirectRenderer`

- 位置：`src/app/render.ts:1126-1130`（新建）、`:1167-1170`（销毁）；构造内容见 `src/scene/equirect-renderer.ts:47-87`

- 问题：`renderSingleFrame()` 在**每次调用**内部 `new EquirectRenderer(...)`，而它是被关键帧循环逐帧调用的：

```ts
const renderSingleFrame = async (): Promise<Uint8Array> => {
    if (is360) {
        savedFov = scene.camera.fov;
        savedOrtho = scene.camera.ortho;
        equirect = new EquirectRenderer(scene.graphicsDevice, faceSize, width, height);
        scene.camera.ortho = false;
        ...
```
```ts
// equirect-renderer.ts:47-56
for (let i = 0; i < 6; ++i) {
    this.faceTargets.push(new RenderTarget({
        colorBuffer: createTexture(`equirectFace${i}`, faceSize, faceSize, FILTER_LINEAR),
        depth: false, autoResolve: false
    }));
}
```

- 影响（按尺寸估算）：4K 输出、`faceSize = min(height, maxTextureSize) = 2160` 时，每个关键帧分配再释放
  约 `6×2160²×4B ≈ 112MB` 的面纹理 + `3840×2160×4B ≈ 33MB` 的等距圆柱纹理 ≈ **145MB/关键帧**；
  100 个关键帧就是 100 轮驱动侧分配/释放 —— 表现为导出期间显存抖动、偶发卡顿。正确性不受影响。

- 建议：把 `EquirectRenderer` 提到关键帧循环外创建一次（整轮导出尺寸不变），循环内只做 6 次面渲染 + 投影 + 回读，
  循环结束销毁一次。预期收益：消除 145MB/帧的分配抖动；风险：低（注意 360 模式切换时 FOV/ortho 的保存恢复仍要在循环内处理）。

---

## 10. [中] `waitForSort` 缺 `clearTimeout`：每次成功排序都留下定时器并打印假的“超时”警告

- 位置：`src/app/render.ts:247-263`（调用点 `:226`、`:242`；360 视频每帧 6 次，见 `:898`）

- 问题：成功路径 resolve 之后那个 `setTimeout` 从未被取消，它照样会在 1s（严格版 2s）后执行并打警告：

```ts
const waitForSort = (instance: any, scene: Scene, timeoutMs: number) => {
    return new Promise<void>((resolve) => {
        const sorter = instance.sorter;
        if (!sorter) { resolve(); return; }
        const onUpdated = () => resolve();
        sorter.once('updated', onUpdated);
        instance.sort(scene.camera.mainCamera);
        setTimeout(() => {
            sorter.off('updated', onUpdated);
            console.warn(`[render] sortAndWait timeout (${timeoutMs}ms) on "..." — using last available order`);
            resolve();
        }, timeoutMs);
    });
};
```

- 影响：每次导出、每个 splat、每帧都留下一个 1–2s 的悬挂定时器（300 帧 360 导出 = 约 1800 个定时器 + 1800 条 console.warn），
  真正超时的诊断信号被自己的假警告淹没；导出时排查“排序异常”会被这条日志带偏。

- 建议：`const timer = setTimeout(...)`，在 `onUpdated` 里 `clearTimeout(timer)`。风险极低。

---

## 11. [中] 相机在包围球内时 `near = far/16384`：深度缓冲精度几乎耗尽

- 位置：`src/camera/camera.ts:906-922`

- 问题：

```ts
fitClippingPlanes(cameraPosition: Vec3, forwardVec: Vec3) {
    const bound = this.scene.bound;
    const boundRadius = bound.halfExtents.length();
    vec.sub2(bound.center, cameraPosition);
    const dist = vec.dot(forwardVec);
    if (dist > 0) {
        this.far = dist + boundRadius;
        // if camera is placed inside the sphere bound calculate near based far
        this.near = Math.max(1e-6, dist < boundRadius ? this.far / (1024 * 16) : dist - boundRadius);
    }
    ...
```

- 影响（按 24 位深度估算）：`near/far = 1/16384` 时，深度分辨率随距离恶化到 `≈ z²/(2·near·2²⁴)`，
  在 `z = far/2` 处约 `1.2e-4 × far` —— 一个 20m 场景里就是毫米级以上的误差，网格/裁剪体/工具覆盖层与模型之间
  容易出现深度闪烁（z-fighting）。而这正是“在房间扫描里飞/围着模型转”的常态路径（`dist < boundRadius` 很常见）。

- 建议：给 near 一个与 far 成比例的下限（例如 `far/1024` 或 `far/4096`，并把绝对下限从 `1e-6` 抬到 `1e-3` 量级），
  或改成按“离相机最近的高斯/几何采样距离”动态定 near。
  预期收益：深度精度提升 4–16×，减少深度闪烁；风险：中 —— near 抬太高会切掉贴近相机的高斯，
  需要双后端在“贴近墙面飞行”的场景里实测确认。

---

## 12. [中] `Picker.MAX_UNION_READ_PX` 允许单次 32MB 的阻塞回读（注释写 8MB）

- 位置：`src/scene/picker.ts:249-314`

- 问题：合并读的上限按“像素数”给，注释里的字节换算少算了 4 倍（深度目标是 RGBA16F = 8B/px）：

```ts
static MAX_UNION_READ_PX = 4 << 20;      // 4M pixels: an 8 MB RGBA16F-ish copy at most
...
if (unionWidth * unionHeight <= Picker.MAX_UNION_READ_PX) {
    const texY = flip ? rt.height - maxY - 1 : minY;
    const pixels = await rt.colorBuffer.read(minX, texY, unionWidth, unionHeight, { renderTarget: rt, immediate: true });
```

- 影响：4.19M 像素 × 8B = **约 33.5MB** 的一次同步回读（`immediate: true`，会阻塞到 GPU 完成 + map），
  比注释里说的 8MB 大 4 倍；笔刷一笔的读回开销因此可能被放大到几十毫秒。

- 建议：把上限按字节表达（例如 `8 << 20` 字节 ≈ 1M 像素），或对超出屏幕占比的大位移笔刷先降采样
  （先用 1/4 分辨率的深度 pass，必要时再精读）。预期收益：笔刷卡顿上限降 3–4×；风险：低-中（需回顾分块路径的退化表现）。

---

## 13. [低] 渲染资源销毁路径漏 destroy（单例，但同样是泄漏）

- 位置：`src/splat/splat-overlay.ts:133-136`、`src/camera/camera.ts:666-686`（另见 `:730-781` 的创建）

- 问题：

```ts
// splat-overlay.ts:133-136 —— material / mesh / meshInstance / vertexBuffer 都不销毁
destroy() {
    this.detach();
    this.entity.destroy();
}
```
```ts
// camera.ts:666-686 —— 销毁了 5 个 render pass 与 picker，
// 但 mainTarget/splatTarget/colorTarget/workTarget 与 cameraColor/workColor/cameraDepth 三张纹理从未 destroy
remove() {
    ...
    this.clearPass?.destroy(); this.mainPass?.destroy(); this.splatPass?.destroy();
    this.gizmoPass?.destroy(); this.finalPass?.destroy();
    ...
    this.picker.destroy();   // Picker.destroy() 只 destroy renderPass（picker.ts:369-371）
```

- 影响：两者都是“一路活到进程结束”的对象，实际泄漏量有限；但 `camera.ts` 的 resize 路径
  （`:815-823` 只 `resize()` 不重建）一旦改成重建纹理，就会变成每次缩放都泄漏 RGBA16F 主色 + depth + work
  三张大纹理（4K ≈ 66MB + 33MB + 33MB）。属于“埋着的雷”。

- 建议：`SplatOverlay.destroy()` 补 `mesh.destroy()/material.destroy()`（`meshInstance` 随实体销毁）；
  给 `Camera` 加一个显式的 `destroyRenderTargets()`，并在 `remove()` 里调用（注意 `colorBuffer` 被
  `mainTarget`/`splatTarget`/`colorTarget` 共享，只能销毁一次）。风险：低。

---

## 14. [低] `readIds()` 在 WebGL2 下不翻行序：目前靠“只当集合用”侥幸不发作

- 位置：`src/scene/picker.ts:150-189`（对照同文件 `readDepths()` 的 `:303-311`、`:336-345`）

- 问题：`readDepths()` 明确处理了每行在两种后端下的映射（`const row = flip ? maxY - pixelsY[i] : pixelsY[i] - minY;`），
  而 `readIds()` 只翻了读取起点、没翻行序：

```ts
// picker.ts:164-186
const texY = this.device.isWebGL2 ? rt.height - py - ph : py;
const pixels = await colorBuffer.read(px, texY, pw, ph, { renderTarget: rt, immediate: true });
const result: number[] = [];
for (let i = 0; i < pw * ph; i++) {
    result.push((pixels[i*4] | (pixels[i*4+1] << 8) | (pixels[i*4+2] << 16) | (pixels[i*4+3] << 24)) >>> 0);
}
```
GL 的 `readPixels` 从 `texY` 向上返回，所以 WebGL2 下 `result` 的第 0 行对应屏幕**最下面**那一行。

- 影响：当前调用方只把结果当**集合**用（`editor.ts:1155-1158` 的 `new Set(pick)`），顺序无关，所以不发作 ——
  但 `HANDOFF.md` 待办第 7 条（“屏幕工具想找回只选可见表面”）一旦要做逐像素回填，这里就会上下镜像。
  另外 `readId()` 在未命中时返回的是清屏色 `0xFFFFFFFF`（`picker.ts:18-19`）而不是 0，调用方必须过滤（当前在 `Set` 语义下无害）。

- 建议：与 `readDepths()` 同构地按行翻转，或在函数注释里明确写“返回值不保证行序、未命中为 0xFFFFFFFF”，
  并把哨兵值提成常量。风险：低。

---

# 优化机会（含预期量级与风险）

> 按“值不值得做”排序。第 O1 条在 `HANDOFF.md` 第 6.1 节已立项（“把窗口判定搬进着色器”），
> 这里补上可落地的设计、量级与风险，不当作新发现。

## O1. 把“选区窗口判定”搬进状态着色器：13M 点推杆 ~600ms → 与 93 万点同量级

- 现状：推杆一次要跑三步 O(n) 的 JS（`IndexRanges` 掩码→区间、`SplatState` 位回写 + `recount()`、整张 R8 纹理上传），
  文档实测剩下的 ~600ms 全在这里（93 万点上是 30–43ms，所以这一步几乎是纯 O(n) 的 JS/带宽成本）。
- 建议：在 overlay/状态着色器里按（深度窗口 + 屏幕窗口 + 形状）直接判定命中，写进一张临时的 R8 掩码纹理；
  CPU 端只做最终落库（把掩码读回或只对区间做最终 `apply`）。
- 预期量级：13M 点上把 600ms 压到 30–50ms（≈12–20×，即回到 93 万点的同级手感）；GPU 侧成本是**一遍全量 splat 顶点+片元**。
- 风险：中高 —— ① 需要双份 WGSL/GLSL（本仓库已经有两套 splat 着色器，维护面再 +1）；
  ② undo/重做与统计（`numSelected` 等）目前依赖 CPU 侧权威状态，必须定义清楚“GPU 判定 → CPU 落库”的一致性；
  ③ 只应对超大模型开启（例如 >500 万点），小模型继续走现有 JS 路径，避免为它引入常态化风险。

## O2. 排序派发改成“自维护阈值 + 时间节流”，并按需上传 order

- 与第 1 条同一个改动面：修好兜底后**不要**变成每帧无条件派发。引擎每次排序结果都会整块上传 order
  （13M 点 = 52MB/次；`playcanvas.dbg.mjs:64889-64896`），60fps 下就是 3GB/s。
- 建议：用“相机在模型局部空间的位移/朝向变化 + 距上次派发的时间”双阈值（例如位移 > 模型半径的 0.1% 或间隔 > 33ms），
  并在超大数据上把排序频率封顶（如 10–15Hz）。
- 预期量级：把“每次转动都全量重排”的固定成本压掉一个量级，同时保住排序及时性；风险：中（阈值需按模型尺度标定，需实测）。

## O3. WebGPU 中心点覆盖层的恒等 order 纹理：4B/点常驻显存

- 现状：`splat-overlay.ts:152-183` 在 WebGPU 上自建一张 `R32U`、`textureDimensions` 尺寸的恒等映射纹理，
  只为让覆盖层着色器能按 `splatOrder` 索引（内容恒定、每次重建还要 CPU 侧填一遍）。
- 影响：3000 万点 ≈ **120MB** 常驻显存，且 `ensureGpuOrderTexture()` 在尺寸变化时整张重建 + 全量填充。
- 建议：① 覆盖层在 WebGPU 上直接按 `gl_VertexID` 当索引（本来恒等映射就等于“不做映射”），删掉这张纹理；
  或 ② 保留纹理但改成按需分块（只在绘制范围内填一段）。
- 预期量级：省下 4B/点的显存与一次全量 CPU 填充；风险：低-中（需要改覆盖层着色器的 WebGPU 分支与 draw count 语义）。

---

## 附：本次审计明确核查但**不成立**的怀疑点（避免后续重复排查）

1. **`pickOp` / `pickMode` 只用 `device.scope.resolve(...)` 设置，不用材质参数 —— 不成立（两个后端都能拿到）。**
   引擎在绑定时优先从 scope 取 uniform 值（WebGL：`playcanvas.dbg.mjs:27593-27607`；
   WebGPU：uniform buffer 的 `update()` 也是逐个取 `uniforms[i].scopeId.value`，`:20836-20843`），
   而材质参数是在每次绘制前由 `Material.setParameters()` 写进 scope（`:43902-43914`）——
   只要没有同名材质参数覆盖（`grep` 确认 `pickOp/pickMode` 只在 `picker.ts` 出现），scope 值就生效。
2. **`Mat4.mul2` 在 `this === lhs/rhs` 时会算错（`splat-overlay.ts:334-335` 的 `this.viewProjMat.mul2(this.viewProjMat, cam.viewMatrix)`）—— 不成立。**
   `mul2` 先把 lhs 的 16 个分量读进局部量，再按 4 个一组读 rhs、写 this，`this === rhs` 时每组也在写之前读完（`:6265-6319`）。
3. **`splat-overlay-shader.ts:138` 少写 `+ 0.5` 会导致状态字节错位 —— 不成立。**
   对 R8Unorm，`float(b)/255*255` 在 fp32 下截断后等于 `b`（逐一验证 1..255 无例外），
   加上 `+0.5` 只是更保险的写法。
4. **`position-shader.ts:38` 的 `vec4 * mat3x4` 行向量约定错了 —— 不成立。**
   `mat3x4` 的列是 4 维，`v * M` 的第 i 个分量是 `dot(v, M[i])`，与从调色板取出的 3 个 texel 列一致，
   和 `splat-shader.ts` 里 `model * transpose(t)` 的列向量写法等价。
5. **导出链路漏 `immediate: true` / 四条导出路径翻两次 / 格式与 `bytesPerRow` 对齐问题 —— 不成立**
   （导出审计逐处核对：`render.ts:355/462/848/1179/1549`、`equirect-renderer.ts:108-112`、`gamepad-capture.ts:93`
   全部带 `immediate: true`；`flipReadbackIfNeeded` 的 4 个调用点每帧只翻一次且 stride 正确；
   RGBA8 work buffer 直读、WebGPU 侧 256 字节对齐由引擎 `roundUp` 处理）。
6. **`EquirectRenderer.destroy()` 不销毁 `this.shader` 是泄漏 —— 不成立**（`ShaderUtils.createShader` 走
   `ProgramLibrary` 按 `uniqueName` 缓存，销毁反而会让后续创建拿到已销毁实例）。
