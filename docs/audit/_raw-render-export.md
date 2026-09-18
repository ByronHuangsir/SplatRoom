# 离屏渲染导出链路 只读审计（原始记录）

审计范围：`src/app/render.ts`（全文 1649 行，逐段读完）+ 被调用方 `src/scene/equirect-renderer.ts`、
`src/core/png-writer.ts`、`src/utils/simple-render-pass.ts`、`src/data-processor/gpu-readback.ts`、
`src/camera/camera.ts`（`startOffscreenMode` / RT 构建 / `copyRt` 相关）、`src/scene/picker.ts`（对照约定）、
`src/gamepad/gamepad-capture.ts`（同类回读路径），以及 `node_modules/playcanvas`（2.21.3）里回读实现的实际代码。
未修改任何文件、未 build、未跑测试。所有结论都附读了源码原文；未验证的运行期推测已明确标注。

只为“文档（`docs/HANDOFF.md` / `docs/进度存档.md` / `docs/V3-WebGPU-现状.md`）没记过、或记了但代码里仍有残留”的问题立项。

---

## [严重度 高] `render.offscreen` 的回读仍是无条件 y 翻转，WebGPU 下泛洪选择掩码整体上下镜像

- 位置: `src/app/render.ts:355-363`（消费方 `src/tools/flood-selection.ts:71-99`）
- 问题: 3.17.0 把四条导出路径收敛到 `flipReadbackIfNeeded()`（只在 WebGL2 翻），但第五条回读路径
  `render.offscreen`（泛洪选择用的离屏快照）**没有改**，仍是老代码：无条件翻一次。仓库自己的约定
  （`picker.ts:165 / 241 / 298`、`flipReadbackIfNeeded` 的 `isWebGL2` 判断）是“WebGL2 回读自下而上、WebGPU 自上而下”，
  因此 WebGPU 上这里就是**翻了两次**。同一段代码还犯了个附带错误：`line` 每行用 `data.slice()` 重新分配，
  等于每次回读做 `height/2` 次小数组分配（1080p 下 540 次），而 helper 里的正确写法是 `line.set(data.subarray(...))`（零分配）。
- 证据: ```ts
            await workTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workTarget, data, immediate: true });

            // flip y positions to have 0,0 at the top
            let line = new Uint8Array(width * 4);
            for (let y = 0; y < height / 2; y++) {
                line = data.slice(y * width * 4, (y + 1) * width * 4);
                data.copyWithin(y * width * 4, (height - y - 1) * width * 4, (height - y) * width * 4);
                data.set(line, (height - y - 1) * width * 4);
            }
  ```
  对照同一文件里给导出用的 helper（只翻 WebGL2）：
  ```ts
  const flipReadbackIfNeeded = (data: Uint8Array, width: number, height: number, device: { isWebGL2: boolean }) => {
      if (!device.isWebGL2) {
          return;
      }
      const line = new Uint8Array(width * 4);
      for (let y = 0; y < Math.floor(height / 2); y++) {
          const top = y * width * 4;
          const bottom = (height - 1 - y) * width * 4;
          line.set(data.subarray(top, top + width * 4));
          data.copyWithin(top, bottom, bottom + width * 4);
          data.set(line, bottom);
      }
  };
  ```
  消费方按“第 0 行 = 屏幕顶部”使用这份数据：
  ```ts
              const data = await (events.invoke('render.offscreen', width, height) as Promise<Uint8Array>);
              let current: Pt = { ...point };

              const start = (current.y * width + current.x) * PIXEL;
  ```
  （`point.y = Math.floor(e.offsetY)`，见 `flood-selection.ts:136-139`，即自上而下的屏幕坐标。）
- 影响: WebGPU 用户（设置面板里选 webgpu / `--gpu=webgpu`，见 `src/main.ts:204-206`、`electron-main.js:264-276`）
  用泛洪选择时，回读数据相对视口纵向镜像 → 种子像素取到镜像位置、连通域也在镜像后的掩码里扩散，
  最终选中的是“点上面选下面”的镜像区域。WebGL2（默认后端）不受影响，所以默认路径测不出来。
  顺带修正一个前提：`render.ts:16-20` 的注释写“WebGPU（打包版默认后端）”，但 `src/core/gpu-backend.ts:11`
  与 `src/main.ts:206`（`getGpuBackendPref() ?? 'webgl2'`）都表明打包版默认是 **WebGL2**，WebGPU 需要用户在设置里显式选
  —— 这正是这条残留一直没被用户大规模撞上的原因，但也说明它只在 WebGPU 下发作、且必然发作。
- 建议: 直接改用 `flipReadbackIfNeeded(data, width, height, scene.app.graphicsDevice)`（顺带消掉每行 `slice` 分配）。
  风险极低；但注意第 3 条：守卫脚本目前的计数恰好依赖这个循环存在。预期收益：修掉 WebGPU 下的错误选择区域。

---

## [严重度 中] `waitForSort` 没有 `clearTimeout`：每次成功排序都会留下一个定时器，并打印一条**假的**“排序超时”警告

- 位置: `src/app/render.ts:247-263`（调用点 `226` / `242`，360 视频每帧 6 次：`898`）
- 问题: 排序成功后 promise 已 resolve，但那个 `setTimeout` **从未被清除**。它 1s（严格版 2s）后照样执行：
  `sorter.off(...)` + `console.warn('sortAndWait timeout ...')`。于是“超时”这条诊断信号完全失效——
  正常快速排序也会打警告；而真超时的路径与正常路径打的是同一条日志。
- 证据: ```ts
  const waitForSort = (instance: any, scene: Scene, timeoutMs: number) => {
      return new Promise<void>((resolve) => {
          const sorter = instance.sorter;
          if (!sorter) {
              resolve();
              return;
          }
          const onUpdated = () => resolve();
          sorter.once('updated', onUpdated);
          instance.sort(scene.camera.mainCamera);
          setTimeout(() => {
              sorter.off('updated', onUpdated);
              console.warn(`[render] sortAndWait timeout (${timeoutMs}ms) on "${instance.entity?.name ?? 'instance'}" — using last available order`);
              resolve();
          }, timeoutMs);
      });
  };
  ```
  全文没有 `clearTimeout`（`grep clearTimeout src/app/render.ts` 无匹配，只有 `render.ts:816` 的 `setTimeout(resolve, 1)`）。
- 影响: 每次导出、每个实例、每帧都留下一个 1–2s 的悬挂定时器：360 视频导出（6 面 × N 帧）会产生
  `6N` 个待触发定时器，全过程持续打**误导性**警告，把真正的排序超时淹没；同时给导出期间的定时器队列和无用回调
  叠加固定开销（例如 300 帧 360 导出 = 1800 个定时器 + 1800 条 console.warn）。调试导出卡顿/排序异常时会被这条日志带偏。
- 建议: `const timer = setTimeout(...)`，在 `onUpdated` 里 `clearTimeout(timer)`；或者干脆只让超时分支打日志。
  风险极低。（`docs` 里没有关于这个 timeout 的任何记录，`grep sortAndWait docs` 无匹配。）

---

## [严重度 中] 朝向守卫脚本的正则漏掉 helper 自己的循环、却被残留的 `render.offscreen` 循环“恰好”满足：真正修好它反而会让守卫变红

- 位置: `docs/verify/verify-export-orientation.cjs:165,170-171`（被检文件 `:26` = `src/app/render.ts`）
- 问题: 静态守卫用一条正则数“还剩几个裸翻转循环”，断言 `calls >= 4 && bareLoops === 1`，detail 里还写着
  “1 = the helper's own loop”。实际数出来的那 1 个**不是** helper 的循环，而是 `render.offscreen` 里的残留循环；
  helper 的循环因为写成 `Math.floor(height / 2)`（后面紧跟 `)` 再接 `; y++) {`）**匹配不上**这条正则
  （`[^)]*\)` 吃掉 `Math.floor(` 的右括号后，`\s*\{` 无法跨过 `;`）。
  结果：守卫现在“绿”是因为 bug 还在；把 `render.offscreen` 改成走 helper（第 1 条建议）后 `bareLoops` 会变成 0，
  守卫立刻变红。
- 证据: ```js
          const calls = (src.match(/flipReadbackIfNeeded\(/g) || []).length;   // call sites only (the definition has  = ()
          // the pixel-flip signature: a half-height row loop that swaps width * 4 rows
          const bareLoops = (src.match(/for \(let y = 0; y < (?:Math\.floor\()?height \/ 2[^)]*\)\s*\{[^}]{0,400}?width \* 4/gs) || []).length;
          const gatesOnWebGL2 = /flipReadbackIfNeeded[\s\S]{0,400}?isWebGL2/.test(src);

          checks.push({
              name: 'every export readback goes through the backend-aware flip helper',
              pass: calls >= 4 && bareLoops === 1,
              detail: `${calls} call sites of flipReadbackIfNeeded, ${bareLoops} vertical-flip loop left in render.ts (1 = the helper's own loop)`
          });
  ```
  把这条正则原样作用在 `src/app/render.ts` 上（.NET 正则 + Singleline，等价于 JS 的 `/s`）实测：
  ```text
  matches: 1
    at index 14650: for (let y = 0; y < height / 2; y++) { |                 line = data.slice(y * wi
  call sites of flipReadbackIfNeeded\( : 4
  ```
  命中的是 `render.offscreen`（`line = data.slice(...)` 是它独有的写法），helper 那处（`line.set(data.subarray(...))`、
  `Math.floor(height / 2)`）没有被计入。
- 影响: 这条守卫给出的是**假保证**：它既放过了真正的残留（第 1 条的 WebGPU 泛洪选择镜像），又会在有人正确修复后报失败，
  从而把“正确的修复”挡在 CI 外；它也只扫 `render.ts`（`:26`），完全看不到 `gamepad-capture.ts`（第 4 条）。
- 建议: 把正则改成能同时匹配两种写法（例如只匹配 `height / 2` 与 `width * 4` 同现、且不在 helper 里的循环），
  断言改成 `bareLoops === 0`，并把扫描文件扩成 `render.ts` + `gamepad-capture.ts`。
  预期收益：守卫重新具备区分力；风险：需要同步改断言，改完会立刻暴露第 1、4 条。

---

## [严重度 中] 手柄截屏（`gamepad-capture`）同样是无条件翻转，WebGPU 下截出来的 PNG 上下颠倒，且不在任何守卫覆盖范围内

- 位置: `src/gamepad/gamepad-capture.ts:93-103`
- 问题: 与第 1 条同源的残留。回读用 `immediate: true`，但翻转仍是老代码（注释明写“WebGL origin is bottom-left”），
  没有按后端判断；该文件不在 `verify-export-orientation.cjs` 的扫描范围内（它只读 `src/app/render.ts`）。
- 证据: ```ts
              const { mainTarget, workTarget } = scene.camera;
              scene.dataProcessor.copyRt(mainTarget, workTarget);
              const data = new Uint8Array(width * height * 4);
              await workTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workTarget, data, immediate: true });

              // Flip vertically (WebGL origin is bottom-left)
              const line = new Uint8Array(width * 4);
              for (let y = 0; y < height / 2; y++) {
                  const top = y * width * 4;
                  const bottom = (height - y - 1) * width * 4;
                  line.set(data.subarray(top, top + width * 4));
                  data.copyWithin(top, bottom, bottom + width * 4);
                  data.set(line, bottom);
              }
  ```
  （对照：同一个文件 `:76-78` 反而**正确**地对 `maxTextureSize` 做了收敛，说明这条路径的其它约束是被想过的。）
- 影响: WebGPU 后端下手柄截屏 PNG 整张上下颠倒（`gamepad.capture` 由 `gamepad-controller.ts:483` 触发，功能是活的）。
  注意 `window.gamepadApi` 在本仓库里没有任何定义（`grep gamepadApi` 在 `src`/`electron-main.js`/preload 均无匹配），
  所以这条路径最终会走 `:291` 的浏览器下载兜底保存 —— 但**翻转是错的跟保存方式无关**。
- 建议: 同样改用共享的 `flipReadbackIfNeeded()`（或把该文件纳入守卫扫描）。风险极低。

---

## [严重度 中] 每帧一次同步回读：WebGL2 上每次回读至少有 16ms 的轮询下限，且“回读→上传→编码”完全串行、没有流水线

- 位置: `src/app/render.ts:848`（视频）、`:1549`（旋转台）、`:1179`（关键帧）、`:355/:462`（单帧/快照）
- 问题: 导出的每一帧都是 `await` 一次 `Texture.read`，读回完成才编码，编码完才处理下一帧——GPU 渲染、CPU 回读、
  编码器三条流水线严格串行。而 PlayCanvas 2.21.3 的回读实现里，`immediate` **不改变**这条路径：它只是多一次
  `gl.flush()`，真正的等待走 `readPixelsAsync → clientWaitAsync(0, 16)`，后者用 `setTimeout(test, 16)` 轮询
  `clientWaitSync`。也就是说每帧至少要吃一次 16ms 的定时器粒度（首次 `clientWaitSync(sync, 0, 0)` 在
  `readPixels` 刚入队后立刻执行，按代码只可能返回 `TIMEOUT_EXPIRED`——这一句是代码推断，未做运行时测量）。
  另外每次回读都新建/删除一个 GL PBO（WebGL2）或新建 staging buffer + `mapAsync`（WebGPU），没有复用。
- 证据: ```ts
                  const captureFrame = async (frameTime: number) => {
                      const { mainTarget, workTarget } = scene.camera;

                      scene.dataProcessor.copyRt(mainTarget, workTarget);

                      // read the rendered frame
                      await workTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workTarget, data, immediate: true });

                      await encodeFrame(frameTime);
                  };
  ```
  引擎侧（`node_modules/playcanvas/build/playcanvas.dbg.js`，2.21.3）：
  ```js
      clientWaitAsync(flags, interval_ms) {
        const gl = this.gl;
        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        this.submit();
        return new Promise((resolve2, reject) => {
          function test() {
            const res = gl.clientWaitSync(sync, flags, 0);
            if (res === gl.TIMEOUT_EXPIRED) {
              setTimeout(test, interval_ms);
            } else { ... }
  ```
  ```js
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, pixels.byteLength, gl.STREAM_READ);
        gl.readPixels(x3, y2, w, h2, format, pixelType, 0);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        await this.clientWaitAsync(0, 16);
  ```
  ```js
        if (options2.immediate) {
          this.gl.flush();
        }
  ```
- 影响: 每帧固定 ≥16ms 的等待下限（30fps、10 秒导出 = 300 帧 → 至少 ~4.8s 的纯等待；60fps 导出在 WebGL2 上
  天然被压到 ≤62fps 的天花板），旋转台/关键帧/视频三条路径都吃这份成本。文档只把“16ms 轮询”这个**机制**
  记在 `src/data-processor/gpu-readback.ts:4-6` 里（为的是 TDR 风险），没记它对导出吞吐的影响，也没有任何
  流水线/复用缓冲的设计。
- 建议: 把“渲染下一帧”与“回读/编码上一帧”解耦：维护 2–3 帧 in-flight（自有的每帧 `data` 缓冲 + 自己的读回队列），
  让 CPU 在 GPU 渲染 N+1 时编码 N；读回缓冲改成池化复用（现在是每帧新建）。预期收益量级 **20–40% 端到端**
  （按 16ms/帧 与实测帧耗时估算，未实测），代价是实现复杂度和 `VideoFrame` 生命周期管理，风险中等。
  更激进但高风险的做法（不建议本轮做）：让导出末段直接渲染到一个与输出同尺寸的 canvas 并用 `new VideoFrame(canvas)`
  绕开 CPU 回读——会与 PlayCanvas 的 RT 流程和主视口 canvas 尺寸打架。

---

## [严重度 中] 旋转台导出缺背压、缺编码器回收恢复：与 `render.video` 的两处保护不一致

- 位置: `src/app/render.ts:1553-1568`（对照 `:813-838`）
- 问题: `render.video` 的 `encodeFrame` 里有 `while (encoder.encodeQueueSize > 5)` 的排队等待、以及
  `encoder.state === 'closed' && encoderError?.message?.includes('reclaimed')` 时重建编码器的恢复分支；
  旋转台这份拷贝两者都没有，`encoderError` 只在 `encode()` **之后**检查。
- 证据: ```ts
                      const videoFrame = new VideoFrame(
                          new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
                          {
                              format: 'RGBA',
                              codedWidth: width,
                              codedHeight: height,
                              timestamp: Math.round(frameIndex * 1e6 / frameRate)
                          }
                      );

                      encoder!.encode(videoFrame, { keyFrame: !firstFrameEncoded });
                      firstFrameEncoded = true;
                      videoFrame.close();

                      // Check for encoder errors
                      if (encoderError) throw encoderError;
  ```
  对照 `render.video`：
  ```ts
                      // wait for encoder queue to drain if necessary (backpressure handling)
                      while (encoder.encodeQueueSize > 5) {
                          await new Promise<void>((resolve) => {
                              setTimeout(resolve, 1);
                          });
                      }
  ```
- 影响: 旋转台是“总时长固定”的导出（`totalFrames = Math.round(360/speed * frameRate)`，`:1414-1415`，
  15°/s、30fps 即 720 帧），4K 下不设背压会让 `VideoEncoder` 待编码队列无限增长（内存/编码器 stall），
  而这是可稳定复现的路径；同时缺 `reclaimed` 恢复意味着打包版被系统回收编码器时旋转台会直接失败，
  而 `render.video` 能自愈——同一份代码（`createEncoder` 在 `:1450` 与 `:624` 几乎逐字相同）行为不一致。
- 建议: 把 `render.video` 的背压循环与 `reclaimed` 重建分支原样搬到旋转台的 `encodeFrame`。
  风险低（纯收敛行为）。预期收益：4K/720 帧导出的内存曲线稳定，避免中途失败。

---

## [严重度 中] 关键帧 360 导出：每个关键帧都新建并销毁一整套 `EquirectRenderer`（7 张纹理 + 7 个 RT）

- 位置: `src/app/render.ts:1126-1130`（新建）、`:1167-1170`（销毁）；`src/scene/equirect-renderer.ts:47-87`
- 问题: `renderSingleFrame()` 在**每次调用**内部 `new EquirectRenderer(...)`，而它是在关键帧循环里被逐帧调用的
  （`:1294`），于是每个关键帧都要重新创建 6 张面纹理 + 6 个 RT + 1 张 equirect 纹理 + 1 个 RT，读完再全部销毁。
- 证据: ```ts
              const renderSingleFrame = async (): Promise<Uint8Array> => {
                  if (is360) {
                      savedFov = scene.camera.fov;
                      savedOrtho = scene.camera.ortho;
                      equirect = new EquirectRenderer(scene.graphicsDevice, faceSize, width, height);
                      scene.camera.ortho = false;
  ```
  ```ts
                      if (equirect) {
                          equirect.destroy();
                          equirect = null;
                      }
  ```
  构造/销毁内容（`equirect-renderer.ts`）：
  ```ts
          this.faceTargets = [];
          for (let i = 0; i < 6; ++i) {
              this.faceTargets.push(new RenderTarget({
                  colorBuffer: createTexture(`equirectFace${i}`, faceSize, faceSize, FILTER_LINEAR),
                  depth: false,
                  autoResolve: false
              }));
          }

          this.equirectTarget = new RenderTarget({
              colorBuffer: createTexture('equirectColor', width, height, FILTER_NEAREST),
  ```
- 影响: 每个关键帧分配+释放约 `6·faceSize²·4 + width·height·4` 字节的 GPU 纹理（4K 输出、`faceSize=2160` 时约 112MB + 33MB ≈ **145MB/关键帧**），
  100 个关键帧就是 100 轮驱动侧分配/释放；表现为导出期间驱动内存抖动、偶发卡顿，且没有复用可言。
  正确性不受影响（正常路径 `finally` 里也 `destroy()`，见 `:1334-1338`）。
- 建议: 把 `EquirectRenderer` 提到关键帧循环外创建一次（尺寸与 `faceSize/width/height` 在整轮导出中不变），
  循环内只做 6 次面渲染 + `project()` + `read()`，循环外 `destroy()` 一次。风险低。

---

## [严重度 低] 导出分辨率没有按 `device.maxTextureSize` 收敛（透视路径），而 UI 允许 8K 预设与最高 16000 的自定义值

- 位置: `src/app/render.ts:390`（图片）、`:653`（视频）、`:1109`（关键帧）、`:1473`（旋转台）；UI `src/ui/image-settings-dialog.ts:98-105`
- 问题: 360 模式只把 **面尺寸** 收敛到 `device.maxTextureSize`（`:387` / `:650` / `:1102`），
  非 360 模式则把用户给的 `width/height` 原样交给 `startOffscreenMode()`；`equirectTarget`（`:403` 等）
  也是 `width×height` 原样。全仓库只有 `gamepad-capture.ts:76-78` 对尺寸做了 `maxTextureSize` 收敛。
  而引擎的 `Texture` 构造函数不做任何收敛。
- 证据: ```ts
              // in 360 mode the offscreen target is a square cube face; the
              // equirect target holds the output-sized frame
              const faceSize = Math.min(height, scene.graphicsDevice.maxTextureSize);

              // start rendering to offscreen buffer only
              scene.camera.startOffscreenMode(is360 ? faceSize : width, is360 ? faceSize : height);
  ```
  UI 侧：
  ```ts
              const resolutionValue = new VectorInput({
                  class: 'vector-input',
                  dimensions: 2,
                  min: 4,
                  max: 16000,
  ```
  ```ts
                  { v: '4K', t: '4K' },
                  { v: '8K', t: '8K' },
  ```
  引擎侧不收敛：`node_modules/playcanvas/build/playcanvas.dbg.js:11906-11907`
  ```js
        this._width = Math.floor(options2.width ?? 4);
        this._height = Math.floor(options2.height ?? 4);
  ```
- 影响: 在 `maxTextureSize = 4096` 的机器上选 8K（`video-settings-dialog.ts:379` 的 `'8k': 7680`、
  图片对话框同款预设）就会去创建超限的离屏 RT（RGBA16F 主目标 + RGBA8 work + depth + 输出尺寸的等距圆柱目标）；
  自定义分辨率上限 16000 在 8192 上限的机器上同样越界。**具体后端表现（WebGL2 `texStorage` 失败导致 FBO 不完整 /
  WebGPU `createTexture` 校验错误）我没有运行验证**，此处只断言“没有做收敛”这个代码事实与可触发路径。
- 建议: 在 `render.image/video/keyframes/turntable` 入口把 `width/height` 夹到 `device.maxTextureSize`
  （或按比例缩放并提示用户），与 `gamepad-capture` / 360 面尺寸保持同一套约束。风险低。

---

## 已核实**不成立**的怀疑点（明确排除，避免后续重复排查）

1. **“某处回读漏了 `immediate: true`” —— 不成立。** 导出链路里每一处回读都带 `immediate: true`：
   `render.ts:355`、`:462`、`:848`、`:1179`、`:1549`，等距圆柱 `equirect-renderer.ts:108-112`，
   手柄截屏 `gamepad-capture.ts:93`，拾取 `picker.ts:244/304/338`，PiP `camera-preview.ts:1367-1370`。
   另外 `equirect.read()` 与帧回读走的是同一套参数，没有遗漏。
2. **“四条导出路径里有翻两次 / 行 stride 算错” —— 不成立。** `flipReadbackIfNeeded` 的 4 个调用点
   （`render.ts:465`、`:803`、`:1182`、`:1551`）每帧只调用一次，且都发生在 `copyRt` + `read` 之后、
   编码之前；行 stride 全是 `width * 4`、交换 `height/2` 对，与 `height-1-y` 配对正确。
   唯一的重复翻转在第 1、4 条（`render.offscreen`、`gamepad-capture`），它们是另一批代码。
3. **“`EquirectRenderer.destroy()` 没销毁 `this.shader` 是资源泄漏” —— 不成立。** `ShaderUtils.createShader`
   按 `uniqueName` 走 `ProgramLibrary` 缓存复用（`playcanvas.dbg.js:35959-35986`：`getCachedShader` 命中就直接返回），
   所以这里从头到尾只有**一个**共享 Shader 实例；而且 `Shader.destroy()` 并不会把这个缓存项摘掉
   （`playcanvas.dbg.js:21698-21702` 只做 `device.onDestroyShader` + `impl.destroy`），
   如果按“对称”加上 `shader.destroy()` 反而会让后续 `createShader` 拿到已销毁的实例。现状是安全的。
4. **“RGBA16F 主目标与 RGBA8 回读缓冲格式不匹配” —— 不成立。** 导出读的是 `workTarget`
   （`camera.ts:745` 的 `workBuffer` 是 `PIXELFORMAT_RGBA8`），`copyRt` 用 `texelFetch` 逐纹素拷贝；
   引擎在 `needsRgbaReadback` 判定里对 RGBA8 走直读、不做额外分配与逐像素 JS 转换
   （`getPixelFormatChannelsForRgbaReadback` 只对 R8/RG8 返回非 0，`playcanvas.dbg.js:27401-27410`），
   所以既没有每帧的额外全景缓冲，也没有每帧的 JS 像素循环。WebGPU 侧 `bytesPerRow` 256 对齐由引擎处理
   （`roundUp(bytesPerRow, 256)` + 逐行去 padding，`playcanvas.dbg.js:20344-20376`），staging buffer 在读完后 `destroy`
   （`:24609`），无泄漏。
5. **“Pick / 深度回读”相关结论**（`immediate` 必要性、`isWebGL2` 行序、128MB 绑定上限、8192 纹理上限）
   文档已记，未重复立项。
