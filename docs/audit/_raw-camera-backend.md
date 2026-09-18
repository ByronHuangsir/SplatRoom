# 相机 / GPU 后端链路 只读审计（原始记录）

审计方式：只读。未修改任何文件、未 build、未运行测试/harness。以下每条结论都由 `read`/`grep` 逐段核对代码得出，证据均为实际读到的原文；未能静态证实的一律标注"未实机验证"。

## 关于任务书里的文件清单（重要）

- **`src/scene/camera.ts` 在本仓库不存在**。`src/scene/` 下只有 `scene.ts / scene-config.ts / scene-state.ts / picker.ts / equirect-renderer.ts / box-shape.ts / sphere-shape.ts / crop-box.ts / element.ts / infinite-grid.ts / outline.ts / pivot.ts / tool-overlay.ts / underlay.ts`。`src/camera/camera.ts` 是 1220 行（任务书写的 718 行也不符）。PlayCanvas 引擎的 `scene/camera.ts` 也没有源码，只有编译产物 `node_modules/playcanvas/build/playcanvas/src/scene/camera.js`（654 行）——本审计在需要判断引擎语义时直接读了这个 `camera.js` 与相关框架文件。**一切"检查 camera_params 的 1/far, far, near, isOrtho"结论是基于 `src/splat/gpu-camera-uniforms.ts` + `src/shaders/splat-shader*.ts` + 引擎 `camera.js` 得出的。**

---

## [高] WebGPU 下合并（group）实体的相机 uniform 在主视图路径上从来没有人上传

- 位置: src/splat/group-renderer.ts:508、src/splat/splat.ts:800、src/camera/camera-preview.ts:1077（对照 src/splat/gpu-camera-uniforms.ts:52）
- 问题: 全仓库只有 `gpu-camera-uniforms.ts` 写 `uSplatView/uSplatViewProj/uSplatProj/uSplatCameraParams/uSplatViewport`（grep 确认无第二处），而调用方只有两个：`Splat.onPreRender()`（只写**自己那个** instance）和 `CameraPreview._forEachSplatInstance()`（PiP 渲染前后）。合并实体的 instance 是**另一个独立 instance、另一份材质**，主视图（group 模式且未渲染 PiP 时）它的相机参数从未被写过。
- 证据:
```ts
// src/splat/group-renderer.ts:508-512  合并实体自己 addComponent → 自己的 instance
this.mergedEntity = new Entity(`mergedGroup_${this.group.id}`);
this.mergedEntity.addComponent('gsplat', {
    asset: this.mergedAsset,
    unified: false
});
```
```ts
// src/splat/splat.ts:800-802  只有"我自己的" instance
if (this.scene.graphicsDevice.isWebGPU) {
    this.updateGpuCameraUniforms(this.entity.gsplat.instance);
}
```
```ts
// src/camera/camera-preview.ts:1077-1085  作者明确把"合并实例"当成另一个消费者
private _forEachSplatInstance(fn: (instance: any) => void) {
    const splats = this.scene.getElementsByType(ElementType.splat) as Splat[];
    for (const splat of splats) {
        fn((splat.entity as any)?.gsplat?.instance);
    }
    if (this.scene.groupRenderer.isActive) {
        fn((this.scene.groupRenderer as any).mergedEntity?.gsplat?.instance);
    }
}
```
```js
// node_modules/playcanvas/build/playcanvas/src/scene/gsplat/gsplat-instance.js:44-58  材质是每 instance 新建的
this._material = new ShaderMaterial({ uniqueName: "SplatMaterial", ... });
...
this.meshInstance = new MeshInstance(resource.mesh, this._material);
```
```ts
// src/shaders/splat-shader-wgsl.ts:757  WGSL 顶点直接用材质参数里的相机矩阵
let modelView: mat4x4f = uniform.uSplatView * applyPaletteTransform(uniform.matrix_model);
```
- 影响: 合并/分组模式把各 splat 从 layer 里摘掉（group-renderer.ts:534-549）只渲染 mergedEntity，而 WebGPU 上 splat 材质不读引擎 view uniform buffer（doc/代码注释均确认），读的是材质参数。该 instance 的参数没有人写 → 顶点着色器拿到未设置（默认零）矩阵，几何塌缩。同一份代码在 WebGL2 上走引擎矩阵，所以只有 WebGPU + 合并模式命中。当前"看起来正常"的唯一可能是 PiP 曾渲染过一帧（`_restoreMainGpuCamera()` 顺带把主相机参数写给了所有 instance，含合并实例）。**未实机验证**（只读审计，无法跑 group + WebGPU）；但"合并实例是独立材质消费者"这一点由上面四段代码互证。
- 建议: 在 `scene.onPreRenderInner()` 里（`groupRenderer.sync()` 之后）或 `group-renderer.rebuild()` 末尾，对合并 instance 调一次 `writeGpuCameraUniforms(instance, scene.camera)`；更彻底的是把"每帧给所有 splat instance 写参数"收敛成 scene 里的一处循环（顺带解决第 6 条的重复计算）。收益：消除"合并模式在 WebGPU 上黑屏/塌缩"这一类问题；风险低（只多一次每帧参数上传）。

## [中] `viewTop()` / `viewBottom()` 的俯仰符号相反（"俯视"按钮给出的是仰视）

- 位置: src/camera/camera.ts:497-502
- 问题: 本工程的 elev 约定是 **elev < 0 = 相机在焦点之上（俯视）**，而 `viewTop()` 传 +89、`viewBottom()` 传 −89，两者互换。UI 文案、视图立方体、快捷键三处独立证据都指向同一结论。
- 证据:
```ts
// src/camera/camera.ts:497-502
viewTop() {
    this.animateToView(this.azim, 89);
}
viewBottom() {
    this.animateToView(this.azim, -89);
}
```
```ts
// src/camera/camera.ts:61-68  前向/位置：y = sin(-elev)
const s1 = Math.sin(-ex);
const c1 = Math.cos(-ex);
...
result.set(-c1 * s2, s1, c1 * c2);
```
```ts
// src/camera/camera.ts:852-856  相机位置 = 焦点 + forward * 距离
cameraPosition.copy(forwardVec);
cameraPosition.mulScalar(distance.distance * this.sceneRadius / this.fovFactor);
cameraPosition.add(this.focalPointTween.value);
```
```ts
// src/app/editor.ts:594,597  视图立方体的 +Y 面（"Y"）＝ 相机到 +Y 上方 ⇒ elev = -90
case 'py': scene.camera.setAzimElev(0, -90); break;
case 'ny': scene.camera.setAzimElev(0, 90); break;
```
```ts
// src/camera/camera.ts:971-975  作者自己的注释：elev=-15 = 相机略高于焦点、向下看
// elev=-15 puts the camera slightly above the focal point looking
// down, which is the standard natural 3D viewing angle.
this.setAzimElev(0, -15, speed);
```
```json
// static/locales/zh-CN.json:499-500（"Top/俯视" 绑到 viewTop）
"context.view.top": "俯视",
"context.view.bottom": "仰视",
```
（另外 src/core/shortcut-manager.ts:83-84 把 Numpad7→viewTop、Numpad0→viewBottom，与 Blender 的 Numpad7=顶视图一致。）
- 影响: 右键菜单/快捷键/手柄的"俯视"实际得到仰视，反之亦然；`elev=+89` 时 `calcForwardVec` 给出 (0,−1,0)，相机跑到焦点下方。顺带发现同一族的不一致：视图立方体的 `camera.align('px')` 用 `azim=90`（editor.ts:593），而 `viewRight()` 用 `azim=-90`（camera.ts:494），±X 两个入口互相矛盾（俯/仰已有独立证据，左/右只能判定"两者必有一错"）。
- 建议: 交换 89/−89（并核对 viewLeft/viewRight 与 `camera.align` 的 ±X 约定）。收益：3 个入口（右键菜单、Numpad、手柄）一次性正确；风险极低。注意 `docs/probes/merged-probe3.cjs:55` 依赖 `camera.viewTop`，改后会真的变成顶视（该 probe 本意就是顶视）。

## [中] "屏幕像素→世界单位"换算用了设备像素高度，且把 fov 当垂直 fov（路径控制命中区与路径标记尺寸）

- 位置: src/camera/camera-path-control.ts:297-299（同一公式复制在 src/camera/camera-path-3d.ts:765-769）
- 问题: 输入侧全是 CSS 像素（`_getRay` 用 `e.clientX - rect.left`；引擎 `CameraComponent.screenToWorld` 用 `device.clientRect`＝`canvas.getBoundingClientRect()`），但换算世界尺度时除的是 `canvas.height`（**设备像素**），并且横屏视口下 `camera.fov` 是**水平** fov 而被当成垂直 fov 用。
- 证据:
```ts
// src/camera/camera-path-control.ts:297-299
const canvasH = this.scene.canvas.height;
const fovRad = (this.scene.camera.fov ?? 60) * Math.PI / 180;
const worldPerPixel = (2 * Math.tan(fovRad / 2)) / Math.max(canvasH, 1);
```
```ts
// src/camera/camera-path-control.ts:305-315  命中半径完全按这个换算
const HIT_PX_CP = 16;
...
const dist = HIT_PX_CP * worldPerPixel * Math.max(pt.distance(cameraPos), 0.001);
```
```ts
// src/camera/camera.ts:825-826  fov 在横屏时是水平 fov
this.camera.horizontalFov = width > height;
this.camera.aspectRatio = width / height;
```
```js
// node_modules/playcanvas/build/playcanvas/src/core/math/mat4.js:16-23  fovIsHorizontal 时垂直半高 = x/aspect
if (fovIsHorizontal) {
    halfSize.x = znear * Math.tan(fov * Math.PI / 360);
    halfSize.y = halfSize.x / aspect;
}
```
```ts
// 对照：正确写法（CSS 像素 + 投影矩阵自带的 horizontalFov 处理）
// src/camera/camera.ts:1012-1015
worldSizePerPixel(depth: number) {
    const pixelScale = (2 / this.camera.projectionMatrix.data[5]) / Math.max(1, this.scene.canvas.clientHeight);
    return this.ortho ? pixelScale : pixelScale * depth;
}
```
- 影响: 误差因子 ≈ `aspect / devicePixelRatio`。16:9 + DPR1 ≈ 1.78×（命中区比注释里写的 16 CSS px 大一截、CP 菱形/关键帧方块也画得比 8/12px 大 1.78 倍）；16:9 + DPR2 ≈ 0.89×（HIDPI 上命中区偏小，用户觉得"点不中"）；21:9 ≈ 2.33×。因为两个错误同源，视觉尺寸与命中区彼此自洽，所以长期没被当成 bug。
- 建议: 两处都改为复用 `scene.camera.worldSizePerPixel(1)`（或同款 `2 / proj.data[5] / clientHeight`）。收益：命中手感在任意分辨率/宽高比下一致，且与全库其它工具（measure/orient/tool-overlay）统一；风险极低。

## [中] 工具窗口的后端选择绕过 `?gpu=` 与持久化偏好，且失败被静默吞掉

- 位置: src/compare/compare-app.ts:60-61、src/merge/merge-app.ts:31-32、src/splatfactory/splatfactory-app.ts:280-297
- 问题: `src/core/gpu-backend.ts:8-11` 声明优先级为"URL override → 持久化偏好 → 默认 WebGL2，并在启动时被遵守"，但 compare/merge 两个窗口把 `deviceTypes` 硬编码成 `['webgl2']`，splatfactory 反向硬编码"有 navigator.gpu 就 WebGPU"（先试 webgpu，失败用空 catch 静默回退，`?gpu=webgl2` 无效）。URL 里其实已经带上了 gpu 参数（工具窗口是从当前 href 复制打开的）。
- 证据:
```ts
// src/compare/compare-app.ts:60-61（merge-app.ts:31-32 完全相同）
const device = await createGraphicsDevice(canvas, {
    deviceTypes: ['webgl2'],
```
```ts
// src/splatfactory/splatfactory-app.ts:280-297
if (navigator.gpu) {
    try {
        return await createGraphicsDevice(c, {
            deviceTypes: ['webgpu'],
            ...
        } as any);
    } catch { /* fall through to WebGL2 */ }
}
```
```ts
// src/tool-modules/compare-module.ts:12-14  子窗口 URL 保留 ?gpu=
const u = new URL(window.location.href);
u.searchParams.set('mode', 'compare');
window.open(u.toString(), '_blank')?.focus();
```
```ts
// src/core/gpu-backend.ts:8-11（声明与实现不符的部分）
 * Precedence at device creation:
 *   1. URL override (?gpu=webgpu / ?gpu=webgl2) — used by the verification harnesses
 *   2. persisted preference (set from the settings panel)
 *   3. default WebGL2
```
- 影响: 同一台机器上主窗口按 `--gpu=webgpu` 跑 WebGPU，而"对比/合并"窗口静默跑 WebGL2、splatfactory 可能在 `?gpu=webgl2` 下仍跑 WebGPU：跨窗口后端不一致会让"合并/sog 导出表现不同"的排查变成猜谜。**主窗口不是静默的**——`src/main.ts:240-250` 会在 1.5s 后弹 popup，i18n key 也确实存在（static/locales/*.json:190-191），并有 `docs/verify/verify-webgpu-fallback.cjs` 覆盖（所以"回退后 UI 静默"这一怀疑对主窗口**已核实不成立**）。真正静默的只有 splatfactory 的 `catch {}`。
- 建议: 抽一个 `resolveBackend(urlArgs, pref)` 给 4 个入口共用；compare/merge 改成 `gpuBackend === 'webgpu' ? ['webgpu','webgl2'] : ['webgl2']`，splatfactory 的 catch 至少 `console.warn`。收益：后端行为可预测、日志可查；风险低（compare/merge 的 splat 渲染路径在 WebGPU 上另有大量 PiP/overlay 专用代码，若不想冒险可只加"读取并用 console 说明忽略了 ?gpu="）。

## [中] WebGPU 上 pick/depth pass 不刷新相机 uniform，`intersectMany` 的"快照相机"对深度 pass 无效

- 位置: src/camera/camera.ts:1042-1060、1083-1086（配合 src/scene/picker.ts:216、src/splat/splat.ts:800）
- 问题: `withSnapshotCamera()` 把主相机实体临时换成手势时刻的姿态（position/rotation/orthoHeight/near/far），然后在**这个窗口内**渲染 depth pass。WebGL2 下 picker 用引擎按实体派生的 view/proj → 快照生效；WebGPU 下 splat 材质的顶点着色器只用 `uSplatView/uSplatViewProj` 材质参数，而这两个参数只在 `Splat.onPreRender()`（主帧）里写 → 拾取时用的是**上一次主帧的实时相机**，不是快照相机。
- 证据:
```ts
// src/camera/camera.ts:1049-1054  快照换相机后立刻渲染 depth pass（由 fn 执行 prepareDepth）
this.mainCamera.setPosition(cameraPos);
this.mainCamera.setRotation(cameraRot);
this.camera.orthoHeight = orthoHeight;
this.near = near;
this.far = far;
fn();
```
```ts
// src/camera/camera.ts:1083-1086
withSnapshotCamera(() => {
    this.picker.prepareDepth(splat);
});
const depths = await this.picker.readDepths(points);
```
```ts
// src/scene/picker.ts:216  picker 用实体相机渲染（WebGL2 由此拿到快照；WebGPU 无此通道）
this.renderPass.update(camera.camera, app.scene, [splatLayer], emptyMap, false);
```
```ts
// src/splat/gpu-camera-uniforms.ts:44-49（为什么必须靠材质参数）
// The camera component's own projection matrix is not usable here: ...
buildGpuProjection(projMat, cam as any);
```
- 影响: 排队命令在相机移动后才执行时（正是 camera.ts:1017-1022 注释描述的"the call may run from the command queue well after the gesture and the camera can move in between"），射线来自快照、深度值来自新相机 → 反算出的世界坐标/距离偏移。受影响的是所有走 `intersectMany` 的手势：球刷（`select.bySphereBrush`，editor.ts:884）、散点/深度类选择。相机没动时结果正确，所以是"偶发错位"。**未实机验证**（只读，无法构造该时序）。
- 建议: 在 `withSnapshotCamera` 的 `fn()` 前（或 `prepareDepth/prepareId` 内）对 splat 实例补一次 `writeGpuCameraUniforms(instance, {camera: 快照相机})`，仅在 WebGPU 分支执行。收益：修复"排队拾取在相机移动后落点漂移"；风险低（拾取时多几次参数上传），注意需同时还原主相机参数以免污染下一帧（现成的 `_restoreMainGpuCamera` 模式可抄）。

## [低] 每帧/每实例重复计算与重复分配相机矩阵（`gpu-camera-uniforms` 没有"算一次用多处"）

- 位置: src/splat/gpu-camera-uniforms.ts:15-16、49-56；调用点 src/splat/splat.ts:676-678、src/camera/camera-preview.ts:1066/1073；另 src/camera/camera.ts:97、261-264、609-642
- 问题: `writeGpuCameraUniforms` 每次调用都重算 `buildGpuProjection` + `viewProj.mul2` 并新建两个数组；而它是**按 instance 调用**的，N 个 splat（或 PiP 前后各一遍）就重算 N 次同一份相机矩阵。同类每帧分配还有几处：`calcYawPitchQuat` 每帧 `new Quat()`、`get focalPoint()` 每次返回新 `Vec3`（fly/walk 每帧调用）、`updateCameraUniforms` 每帧 6 次 `device.scope.resolve(name)` + 6 个小数组。
- 证据:
```ts
// src/splat/gpu-camera-uniforms.ts:15-16, 49-56
const projMat = new Mat4();
const viewProjMat = new Mat4();
...
buildGpuProjection(projMat, cam as any);
viewProjMat.mul2(projMat, cam.viewMatrix);
material.setParameter('uSplatCameraParams', [1 / far, far, near, isOrtho ? 1 : 0]);
material.setParameter('uSplatViewport', [width, height, 1 / width, 1 / height]);
```
```ts
// src/splat/splat.ts:676-678  每个 Splat element 每帧调一次
private updateGpuCameraUniforms(instance: GSplatInstance) {
    writeGpuCameraUniforms(instance, this.scene.camera as unknown as GpuCameraSource);
}
```
```ts
// src/camera/camera.ts:97-102  每帧一次 new Quat()
const q = new Quat();
q.x = cy * sp;
```
```ts
// src/camera/camera.ts:261-264  每次访问都新建 Vec3
get focalPoint() {
    const v = this.focalPointTween.value;
    return new Vec3(v.x, v.y, v.z);
}
```
```ts
// src/camera/camera.ts:614-616  onPreRender 每帧 6 次 scope.resolve + 数组
const set = (name: string, vec: Vec3) => {
    device.scope.resolve(name).setValue([vec.x, vec.y, vec.z]);
};
```
- 影响: CPU 端微秒级，相对 16.6ms/帧可忽略（诚实说明：这条**不是**性能瓶颈，`getFrustumCorners` 也**不**分配——它返回引擎模块级 `_frustumPoints`，见 camera.js:603-637）。真正值得改的是"同一份相机矩阵被 N 个材质实例重复推导+上传"这一结构，以及它使"谁负责给哪个 instance 写参数"变得容易漏（第 1、5 条就是漏写/漏刷新）。注意 `app.update()` 每个 rAF 都会跑（app-base.js:105-111），只有 `render()` 受 `renderNextFrame` 门控，所以 `onUpdate` 里的分配是"每帧"而不是"每渲染帧"。
- 建议: 用相机版本号（或上一帧的 mat4 快照比较）缓存一次 `projMat/viewProjMat` 与两个 uniform 数组，N 个 instance 复用；`calcYawPitchQuat` 写入模块级 Quat；`updateCameraUniforms` 复用模块级 Vec3。收益：CPU 少许，主要收益是可读性/正确性；风险低。

## [低] `PointerController.destroy()` 漏注销 2 个事件监听，且 `off` 用了"清空整个事件"的写法（潜在）

- 位置: src/camera/controllers.ts:578-592（注册）对 623-636（注销）
- 问题: `camera.setAutoRotateSpeed`、`camera.inertia` 两个监听没有 off；`events.function('camera.getAutoRotateMode'/'camera.getAutoRotateSpeed')` 也没有对应清理（`Events.function` 根本没有删除 API）；`events.off('camera.setAutoRotateMode')` 不传回调＝删掉该事件的**所有**监听（引擎 event-handler.js:52-59 确认）。
- 证据:
```ts
// src/camera/controllers.ts:578-592（注册）
events.on('camera.setAutoRotateSpeed', (speed: number) => { autoRotateSpeed = speed; });
events.function('camera.getAutoRotateSpeed', () => autoRotateSpeed);
events.on('camera.inertia', (enabled: boolean) => { ... });
```
```ts
// src/camera/controllers.ts:623-636（注销：上面这些都不在里面）
this.destroy = () => {
    destroy?.();
    window.removeEventListener('keydown', keydown, { capture: true });
    window.removeEventListener('keyup', keyup, { capture: true });
    ...
    events.off('camera.setAutoRotateMode');   // 无回调 ⇒ 清空该事件全部 handler
};
```
```ts
// src/core/events.ts:9-14  重复注册同名 function 会直接抛错，且没有删除接口
function(name: string, fn: FunctionCallback) {
    if (this.functions.has(name)) {
        throw new Error(`error: function ${name} already exists`);
    }
    this.functions.set(name, fn);
}
```
- 影响: 当前生命周期下**不会真的发生**：`new Camera()` 只在 scene.ts:327 出现一次，且没有任何路径调用 `element.destroy()`/`camera.remove()`（grep 确认）。所以这是潜在问题：一旦将来做"重开文档/重建 Scene/Camera 实例"，新 `PointerController` 构造时 `events.function('camera.getAutoRotateMode', …)` 会**抛异常**导致相机初始化失败（比静默泄漏更糟）。
- 建议: 把两个 `on` 也注销，并给 `Events` 加一个可撤销的 `function` 注册（或改用带 owner 的一段式注册）；`off` 尽量带回调/scope。风险低。事件监听本身的成对性（`wrap()` 链式 `destroy`、keydown/keyup capture）**已核实正确**。

## [低] `orthoHeight` 用 `(fov / 90)` 线性近似替代 `2·d·tan(fov/2)`，正交/透视切换时画面尺度不守恒且随 fov 漂移

- 位置: src/camera/camera.ts:902
- 问题: 正交高度按 `距离·(fov/90)/sin(fov/2)`（横屏再乘 h/w）算，而透视在焦点平面上的垂直半高是 `d·tan(fov/2)`（横屏为 `/aspect`）。两者之比 = `(4x/π)/(sin x·tan x)`（x = fov/2，弧度），随 fov 单调变化、恒 > 1。
- 证据:
```ts
// src/camera/camera.ts:902
camera.orthoHeight = this.distanceTween.value.distance * this.sceneRadius / this.fovFactor * (this.fov / 90) * (camera.horizontalFov ? targetSize.height / targetSize.width : 1);
```
```ts
// src/camera/camera.ts:978-986  透视侧的换算基准
get fovFactor() {
    const fov = Math.max(this.fov, 1e-4);
    return Math.sin(fov * math.DEG_TO_RAD * 0.5);
}
```
- 影响: 同一距离下切到正交，可见范围变大（内容变小）：fov=90 → 1.41×；fov=75（默认 `scene-config.ts:17`）→ 1.78×；fov=60 → 2.31×；fov=30 → 4.8×。即"正交显示多大"显著依赖 fov，且与透视不等价。实际触发面被缩小了：唯一的正交入口 `editor.ts:602` 之后紧接着 `focus()` 重新套距，所以用户感知主要是"立方体正交视角下包围盒边缘略微裁切"（按 `focus()` 传 `radius = bound.halfExtents.length()` 计算，16:9/fov75 时正交半高 ≈ 0.47·R，可见高度 0.94·R < 2·halfExtents）。`verify-ortho-camera.cjs` 只校验"切换后模型仍可见"，不校验与透视的等价比，所以没被这条覆盖。
- 建议: 改成 `orthoHeight = d·tan(fov/2)`（横屏 `/aspect`），使正交与透视在焦点平面严格等尺度；若担心"模型变小"的既有观感，可保留一个显式命名系数而不是拿 fov 当系数。收益：正交/透视切换和图元尺寸（gizmo、tool-overlay 已按 `camera.ortho` 分支）行为可解释；风险：会改变现有正交视角的取景，需目视确认一次。

---

## 已核实不成立 / 无需报告的怀疑点（都读了代码）

1. **`screenToWorld`/`getRay` 的坐标单位不匹配 —— 不成立。** 引擎 `CameraComponent.screenToWorld`（component.js:337-341）用的是 `device.clientRect`，而 `clientRect` 来自 `canvas.getBoundingClientRect()`（graphics-device.js:451-459），即 **CSS 像素**；引擎 `Camera#screenToWorld`（camera.js:521-549）的 `1 - (y - …)/…` 也确认 y 向下。所以各处传 CSS 像素都是对的：`controllers.ts:40-41`（`event.offsetX/offsetY`）、`camera.ts:1069`（`x*clientWidth, y*clientHeight`）、`splat-pick.ts:33-38`（`clientWidth/Height` + `offsetX/offsetY`）、`controllers.ts:377`（`offsetX/target.clientWidth` 归一化）。
2. **picker 的 y 翻转 —— 不成立（两后端各按自己的纹理原点处理）。** `picker.ts:165,241,298-303,336` 只在 `isWebGL2` 时按 `rt.height - …` 翻行，WebGPU 直读；上游规范化坐标一律"y 向下"，与 `getRay`/`screenToWorld`、`worldToScreen`（camera.ts:533-535 已 `1 - …`）一致。
3. **主窗口 WebGPU 能力检测失败后静默 —— 不成立。** `main.ts:240-250` 会 `showPopup` 提示（`i18n.t('popup.webgpu-backend.*')` 在 9 个 locale 文件里都存在，如 zh-CN.json:190-191），且 `deviceTypes: ['webgpu','webgl2']` 的自动回退由 `docs/verify/verify-webgpu-fallback.cjs` 覆盖。真正静默的只有 splatfactory（见第 4 条）。
4. **`worldSizePerPixel` 的 `clientHeight` / `proj.data[5]` / DPR —— 不成立。** `camera.ts:1012-1015` 用 `2/data[5]`（＝深度 1 处视锥垂直高度，引擎 `setFrustum` 里 `r[5] = znear/halfSize.y`，`mat4.js:234-257` 与 `_getPerspectiveHalfSize:16-23` 已含 horizontalFov 处理）除以 `clientHeight`（CSS 像素）→ 得到"每 CSS 像素的世界尺寸"，与 `app/editor.ts:858-867` 里"厚度单位＝CSS 像素"的注释相符；正交下 data[5]=1/orthoHeight，`return this.ortho ? pixelScale : pixelScale * depth` 也正确。
5. **等距圆柱 2:1 路径的宽高比 / face fov —— 不成立。** 360 导出把主目标设成正方形面（`render.ts:390` `startOffscreenMode(is360 ? faceSize : width, is360 ? faceSize : height)`）→ `rebuildRenderTargets` 设 `aspectRatio = 1`、`horizontalFov = false`（camera.ts:825-826），6 个面用 `poseOverride` 的 `faceFov`；equirect 目标按输出宽高（`equirect-renderer.ts:73-77`），6 张面图 copy 到 faceTargets（`render.ts:444`）。相机 uniform 也随之更新（每个面 `setPoseOverride` → `onUpdate(0)` → 下一帧 `Splat.onPreRender` 重写参数，`render.ts:441-444`），`uSplatViewport` 用的正是 `targetSize`＝faceSize²（gpu-camera-uniforms.ts:42/56）。没有发现拉伸或 aspect 混用。
6. **正交相机的 near/far 约定与 `camera_params` 顺序 —— 不成立（一致）。** `gpu-camera-uniforms.ts:55` 写 `[1/far, far, near, isOrtho ? 1 : 0]`，与 GLSL 侧 `splat-shader.ts:712` 的 `// 1 / far, far, near, isOrtho`、WGSL 侧 `splat-shader-wgsl.ts:752` 注释和用法（`.x`=1/far，`.y`=far，`.z`=near，`.w`==1 ⇒ ortho，见 wgsl:248/309/764/861）完全对应；`buildGpuProjection`（gpu-projection.ts:14-26）逐字镜像引擎 `_evaluateProjectionMatrix`（camera.js:550-564，`setOrtho(-y*aspect, y*aspect, -y, y, nearClip, farClip)`），含 `horizontalFov` 透传。`camera.ts:619` 的 `getFrustumCorners(-100)`（负 near）也**不会**让正交射线方向错：正交下 `worldNear` 只是沿视线平移到相机后方 100 单位，`normalize(worldFar - worldNear)` 仍是 −Z 方向、与平面求交同一直线（infinite-grid-shader.ts:100-110），用到的 points[0/2/3/7] 与 far 面（默认 farClip）语义正确。只是 `near = -100` 这层意图没有注释、语义上 `near_origin` 在相机后方，建议补注释。
7. **`splatSize * devicePixelRatio` 的重复乘 —— 不成立。** `splat-overlay.ts:309` 乘 DPR，是因为 `gl_PointSize`（WebGL2）与 WebGPU 的 quad 展开（`splat-overlay-shader.ts:216`：`(corner*2-1) * splatSize / uOverlayViewportSize * w`，`uOverlayViewportSize`＝`targetSize`）两者都是**渲染目标像素**；两者换算出的 CSS 尺寸都等于 `splatSize`，且与 `pixelScale`（默认 1，scene-config.ts:15）自洽。
8. **canvas 尺寸与 render buffer 尺寸不一致 / DPR 重复乘 —— 不成立。** 尺寸链只有两处：启动时 `editor.ts:795-797` 用 `offsetWidth*devicePixelRatio` 一次性初始化，之后全部走 `ResizeObserver` 的 `devicePixelContentBoxSize`（scene.ts:187-212）→ `graphicsDevice.setResolution()`（scene.ts:658-661，注释还专门解释了为什么不能直接写 canvas.width/height）→ `targetSize = ceil(device.width / pixelScale)`（scene.ts:729-730）→ `camera.rebuildRenderTargets()` 用 `targetSize`（camera.ts:708-828）。全链路同一单位，没有二次乘 DPR。另：0 尺寸窗口有保护（camera.ts:715-717 早退，保留旧 target），只有在"正交模式 + 窗口被最小化成 0×0"时 `camera.ts:902` 的 `height/width` 会产生 NaN —— 正交在此时无渲染需求，未列为条目。
9. **`getRay()` 返回的 Ray 复用模块级 Vec3（camera.ts:41-48、997/1001 `ray.set(vec, vecb)`）** 是个别名陷阱（第二次调用会悄悄改写上一次拿到的 Ray 的 origin/direction）；已核实当前所有调用点在用完之后才可能再次调用（`splat-pick.ts:38` 之后循环内不再调相机、`camera-path-control.ts:125-133` 每次只持有一条、`intersectMany` 立刻 `clone()`），所以**当前无实际故障**，仅记为注意项。
10. **性能方面没有找到"大头"。** 相机链路的每帧成本都是 µs 级：`app.update()` 每 rAF 一次（app-base.js:105-111）但 `onPreRender`（= `updateCameraUniforms`/`rebuildRenderTargets`）只在真正渲染的帧执行；`getFrustumCorners` 返回引擎模块级数组不分配（camera.js:588-638）；矩阵求逆只在 `intersectMany` 快照、group 排序兜底（scene.ts:692）等非渲染热点里出现。`TweenValue`/`sceneState` 的 per-frame 分配属于 scene 层，不在本次范围。

## 与既有文档不重复的部分

`docs/HANDOFF.md`、`docs/进度存档.md`、`docs/V3-WebGPU-现状.md` 已记录的以下结论**没有被当作新发现**：回读朝向分后端、pick/深度回读必须 `immediate: true`、WebGPU 128MB 绑定上限、8192 纹理上限、PiP 材质参数"改—渲染—还原"模式（`_forEachSplatInstance` 的存在本身也是文档里写过的）。本报告的 8 条里，第 1、5 条是文档**没有**覆盖的主视图/拾取路径缺口（文档只讨论了 PiP 场景）；第 2、3、8 条与后端无关；第 4、6、7 条是工程一致性/潜在问题。
