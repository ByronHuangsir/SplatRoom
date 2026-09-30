import {
    BLENDEQUATION_ADD,
    BLENDMODE_ONE,
    BLENDMODE_ZERO,
    BLENDMODE_ONE_MINUS_SRC_ALPHA,
    BlendState,
    Color,
    GraphicsDevice,
    RenderPassPicker,
    RenderTarget,
    Texture
} from 'playcanvas';

import { ElementType } from './element';
import { Scene } from './scene';
import { cpuPickNearest, cpuPickRect } from '../splat/cpu-pick';
import { workerPickDepths, workerPickNearest, workerPickRect, type WorkerPickCommon } from '../splat/selection-worker-client';
import { Splat } from '../splat/splat';

const idClearColor = new Color(1, 1, 1, 1);
const depthClearColor = new Color(0, 0, 0, 1);

// Shared buffer for half-to-float conversion
const float32 = new Float32Array(1);
const uint32 = new Uint32Array(float32.buffer);

// Convert 16-bit half-float to 32-bit float using bit manipulation
const half2Float = (h: number): number => {
    const sign = (h & 0x8000) << 16;           // Move sign to bit 31
    const exponent = (h & 0x7C00) >> 10;       // Extract 5-bit exponent
    const mantissa = h & 0x03FF;               // Extract 10-bit mantissa

    if (exponent === 0) {
        if (mantissa === 0) {
            // Zero
            uint32[0] = sign;
        } else {
            // Denormalized: convert to normalized float32
            let e = -1;
            let m = mantissa;
            do {
                e++;
                m <<= 1;
            } while ((m & 0x0400) === 0);
            uint32[0] = sign | ((127 - 15 - e) << 23) | ((m & 0x03FF) << 13);
        }
    } else if (exponent === 31) {
        // Infinity or NaN
        uint32[0] = sign | 0x7F800000 | (mantissa << 13);
    } else {
        // Normalized: adjust exponent bias from 15 to 127
        uint32[0] = sign | ((exponent + 127 - 15) << 23) | (mantissa << 13);
    }

    return float32[0];
};

class Picker {
    private device: GraphicsDevice;
    private scene: Scene;

    // Render targets (provided by camera)
    private depthRenderTarget: RenderTarget | null = null;
    private idRenderTarget: RenderTarget | null = null;

    /**
     * unified（引擎 GPU 排序）通路专用的 id 目标。
     *
     * 为什么不能直接用上面那个：引擎在这条通路上的绘制管线是**两个颜色附件**
     * （cameraColor + workColor，见 camera.ts 的 splatTarget），而 camera 交给我们的
     * id 目标是**单附件**的（就是 work 贴图本身）。附件数不匹配 ⇒ 引擎那一遍绘制记不进去
     * ⇒ 读回来的是 work 贴图里的**残留数据**（实测：38160 个像素里 0 个合法 id，
     * 值恒为 workColor 的残留）。所以这里按同样的附件结构单独建一个 MRT，读第 0 个附件。
     */
    private unifiedPickTarget: RenderTarget | null = null;

    /** unified 通路上"这次要拾取哪个元素"（prepareId 记下，readIds 用） */
    private cpuPickSplat: Splat | null = null;
    /** 最近一次 CPU 拾取的耗时（ms）—— 探针/性能记录用 */
    lastCpuPickMs = 0;

    // Render pass (shared for depth and ID picking)
    private renderPass: RenderPassPicker;

    // Blend state for depth accumulation
    private depthBlendState: BlendState;

    constructor(scene: Scene) {
        this.scene = scene;
        this.device = scene.graphicsDevice;

        // Create shared render pass for picking
        this.renderPass = new RenderPassPicker(this.device, this.scene.app.renderer);

        // Blend state for depth accumulation:
        // RGB: additive depth accumulation (ONE, ONE_MINUS_SRC_ALPHA)
        // Alpha: multiplicative transmittance (ZERO, ONE_MINUS_SRC_ALPHA) -> T = T * (1 - alpha)
        this.depthBlendState = new BlendState(
            true,
            BLENDEQUATION_ADD, BLENDMODE_ONE, BLENDMODE_ONE_MINUS_SRC_ALPHA,           // RGB blend
            BLENDEQUATION_ADD, BLENDMODE_ZERO, BLENDMODE_ONE_MINUS_SRC_ALPHA           // Alpha blend (transmittance)
        );
    }

    // Set render targets from camera
    setRenderTargets(depthRT: RenderTarget, idRT: RenderTarget) {
        this.depthRenderTarget = depthRT;
        this.idRenderTarget = idRT;
    }

    /**
     * 拾取用的目标：主线就是 camera 给的那一个。
     *
     * 这里**曾经**给 unified（引擎 GPU 排序）建过一个"与引擎同构的两附件 MRT"、并用
     * `gsplatDirector` 里那个相机驱动引擎的拾取 pass —— 但那条路**结构上走不通**，证据（探针
     * 54~64，见 docs/进度存档.md）：引擎拾取那一遍用的是**它自己的拾取材质**（绘制瞬间读到
     * `matIsOurs = false`），写的是来自 `pcId` 流的 `vPickId`；而 `GSplatResource` 的流列表是写死的
     * （没有 pcId），引擎自带的 id 又是 `placementId`（按元素、不是按高斯）⇒ 读回来恒为 0。
     * unified 因此改走 `src/splat/cpu-pick.ts` 的 CPU 实现，这里不再需要那条分支。
     */
    private get pickTarget(): RenderTarget | null {
        return this.idRenderTarget;
    }

    // The color buffer of the last ID pass (front-most splat index per pixel,
    // RGBA8-encoded).
    get idTexture(): Texture | null {
        const rt = this.pickTarget;
        return rt ? rt.colorBuffer : null;
    }

    // Prepare for ID picking by rendering the specified splat
    prepareId(splat: Splat, mode: 'add' | 'remove' | 'set' | 'intersect') {
        // unified（引擎 GPU 排序）通路：**不走**这里的 GPU id pass。
        // 引擎在这条路上的拾取那一遍用的是它自己的材质（`matIsOurs = false`），写的是来自
        // `pcId` 流的 `vPickId`，而资源格式里根本没有 pcId 流、引擎自带的 id 又是 placementId
        // —— 实测读回来恒为 0（探针 54~64，见 docs/进度存档.md）。所以这条路改走 CPU 实现：
        // 这里只记下"要拾取哪个元素"，真正的计算在 readIds 里（见 cpu-pick.ts）。
        if ((globalThis as any).__SPLATROOM_UNIFIED__ === true) {
            this.cpuPickSplat = splat;
            return;
        }

        const target = this.pickTarget;
        if (!target) {
            return;
        }

        const { splatLayer } = this.scene;

        // Hide non-selected elements
        const splats = this.scene.getElementsByType(ElementType.splat) as Splat[];
        splats.forEach((s) => {
            s.entity.enabled = s === splat;
        });

        try {
            // 'intersect' picks against the currently-selected set (same render as
            // 'remove') so unselected splats can't occlude selected ones and skew it.
            const pickOp = mode === 'intersect' ? 'remove' : mode;

            // Set picker uniforms
            this.device.scope.resolve('pickOp').setValue(['add', 'remove', 'set'].indexOf(pickOp));
            this.device.scope.resolve('pickMode').setValue(0);

            // Render ID picking pass
            const emptyMap = new Map();
            this.renderPass.blendState = BlendState.NOBLEND;
            this.renderPass.init(target);
            this.renderPass.setClearColor(idClearColor);
            this.renderPass.update(this.scene.camera.camera, this.scene.app.scene, [splatLayer], emptyMap, false);
            this.renderPass.render();
        } finally {
            // Re-enable all splats — even if the render pass throws, otherwise a
            // failed pick leaves every splat disabled and the viewport blank
            splats.forEach((s) => {
                s.entity.enabled = true;
            });
        }
    }

    // Read single splat ID at normalized screen position (after prepareId)
    async readId(x: number, y: number): Promise<number> {
        if ((globalThis as any).__SPLATROOM_UNIFIED__ === true) {
            const { width, height } = this.scene.targetSize;
            const ids = await this.readIds(x, y, 1 / Math.max(width, 1), 1 / Math.max(height, 1));
            return ids.length ? ids[0] : -1;
        }
        const rt = this.pickTarget;
        if (!rt) {
            return -1;
        }
        // For single pixel read, use a minimal normalized size
        const ids = await this.readIds(x, y, 1 / rt.width, 1 / rt.height);
        return ids[0];
    }

    /**
     * unified 通路的拾取：CPU 版"每像素最前表面"（实现与理由见 `src/splat/cpu-pick.ts`）。
     * 坐标口径与 GPU 那条路完全一致：入参是归一化 (0-1)、y 向下，返回行主序 id（背景 = 0xFFFFFFFF）。
     *
     * O(n) 循环优先在 **selection worker** 里跑（与框选共用常驻 x/y/z 槽位，20M 点上把这 ~1s
     * 从主线程拿走）；worker 不可用 / 超预算 / 出错时**原样退回主线程实现**——两边跑的是
     * 同一份 `cpu-pick.ts`，结果逐位相同。
     */
    private async readIdsCpu(x: number, y: number, width: number, height: number): Promise<number[]> {
        const splat = this.cpuPickSplat;
        const data = splat?.splatData as any;
        if (!data) {
            return [];
        }
        const { width: tw, height: th } = this.scene.targetSize;
        if (!(tw > 0 && th > 0)) {
            return [];
        }
        const px = Math.max(0, Math.floor(x * tw));
        const py = Math.max(0, Math.floor(y * th));
        const pw = Math.max(1, Math.min(tw - px, Math.ceil((x + width) * tw) - px));
        const ph = Math.max(1, Math.min(th - py, Math.ceil((y + height) * th) - py));

        const camera = this.scene.camera;
        const state = data.getProp('state') as Uint8Array | null;
        const common: WorkerPickCommon = {
            showDeleted: !!splat.showDeleted,
            projection: camera.camera.projectionMatrix.data,
            view: camera.camera.viewMatrix.data,
            worldTransform: splat.entity.getWorldTransform().data,
            width: tw,
            height: th
        };

        const t0 = performance.now();
        let ids: Uint32Array | null = null;
        if (pw <= 2 && ph <= 2) {
            // 单像素（`readId`）：走"半径内最近的候选里取最前"那条 —— 只按中心点写像素的话，
            // 点画面正中经常落在两个中心之间 ⇒ 返回背景（见 cpu-pick.ts 的说明）。
            if (state) {
                const r = await workerPickNearest(splat, common, state, px + 0.5, py + 0.5, 6);
                if (r) {
                    ids = new Uint32Array([r.id >= 0 ? r.id : 0xFFFFFFFF]);
                }
            }
        } else if (state) {
            const r = await workerPickRect(splat, common, state, px, py, pw, ph);
            if (r) {
                ids = r.ids;
            }
        }
        if (!ids) {
            // 回退：worker 不可用/失败 —— 与原主线程实现完全一致
            const fallback = {
                numSplats: data.numSplats as number,
                x: data.getProp('x') as Float32Array,
                y: data.getProp('y') as Float32Array,
                z: data.getProp('z') as Float32Array,
                state,
                showDeleted: !!splat.showDeleted,
                projection: camera.camera.projectionMatrix.data,
                view: camera.camera.viewMatrix.data,
                worldTransform: splat.entity.getWorldTransform().data,
                width: tw,
                height: th
            };
            if (pw <= 2 && ph <= 2) {
                const pick = cpuPickNearest({ ...fallback, px: px + 0.5, py: py + 0.5, radius: 6 });
                ids = new Uint32Array([pick.id >= 0 ? pick.id : 0xFFFFFFFF]);
            } else {
                ids = cpuPickRect({ ...fallback, px0: px, py0: py, pw, ph }).ids;
            }
        }
        this.lastCpuPickMs = performance.now() - t0;
        return Array.from(ids);
    }

    /**
     * unified 通路的深度 pass：CPU 版"每像素前表面归一化深度"。
     *
     * 语义与 GPU 那条对齐（`decodeDepth`：R = Σ depth·α、A = 透射率，结果 = R / (1 - A)；
     * 归一化是 `(linear - near) / (far - near)`，见 `uSplatCameraParams`）。做法与读 id 一样：
     * 只算**这些点并集包围盒**那一小块（GPU 那条也是并集读取），然后按点取样。
     *
     * O(n) 循环同样优先在 selection worker 里跑（opacity 列惰性同步一次）；失败退回主线程原实现。
     */
    private async readDepthsCpu(points: { x: number, y: number }[]): Promise<(number | null)[]> {
        const splat = this.cpuPickSplat;
        const data = splat?.splatData as any;
        const { width: tw, height: th } = this.scene.targetSize;
        const result: (number | null)[] = new Array(points.length).fill(null);
        if (!data || !(tw > 0 && th > 0) || points.length === 0) {
            return result;
        }

        // 归一化 -> 像素（y 向下，与 GPU 那条一致），并求并集包围盒
        const pxs = new Int32Array(points.length);
        const pys = new Int32Array(points.length);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const valid: number[] = [];
        for (let i = 0; i < points.length; i++) {
            const { x, y } = points[i];
            if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
                continue;
            }
            const px = Math.min(Math.floor(x * tw), tw - 1);
            const py = Math.min(Math.floor(y * th), th - 1);
            pxs[i] = px;
            pys[i] = py;
            valid.push(i);
            minX = Math.min(minX, px);
            maxX = Math.max(maxX, px);
            minY = Math.min(minY, py);
            maxY = Math.max(maxY, py);
        }
        if (valid.length === 0) {
            return result;
        }

        const px0 = minX;
        const py0 = minY;
        const pw = Math.max(1, maxX - minX + 1);
        const ph = Math.max(1, maxY - minY + 1);
        const camera = this.scene.camera;
        const state = data.getProp('state') as Uint8Array | null;
        const t0 = performance.now();

        if (state) {
            const depths = await workerPickDepths(splat, {
                showDeleted: !!splat.showDeleted,
                projection: camera.camera.projectionMatrix.data,
                view: camera.camera.viewMatrix.data,
                worldTransform: splat.entity.getWorldTransform().data,
                near: (camera as any).near,
                far: (camera as any).far,
                width: tw,
                height: th
            }, state, pxs, pys, Int32Array.from(valid), px0, py0, pw, ph);
            if (depths) {
                this.lastCpuPickMs = performance.now() - t0;
                for (let k = 0; k < valid.length; k++) {
                    const v = depths[k];
                    result[valid[k]] = Number.isFinite(v) ? v : null;
                }
                return result;
            }
        }

        // 回退：worker 不可用/失败 —— 与原主线程实现完全一致
        const out = cpuPickRect({
            numSplats: data.numSplats as number,
            x: data.getProp('x') as Float32Array,
            y: data.getProp('y') as Float32Array,
            z: data.getProp('z') as Float32Array,
            state,
            showDeleted: !!splat.showDeleted,
            projection: camera.camera.projectionMatrix.data,
            view: camera.camera.viewMatrix.data,
            worldTransform: splat.entity.getWorldTransform().data,
            // 深度通道：需要 alpha 与裁剪面
            opacity: data.getProp('opacity') as Float32Array,
            activated: !!data.activated,
            near: (camera as any).near,
            far: (camera as any).far,
            width: tw,
            height: th,
            px0,
            py0,
            pw,
            ph
        });
        this.lastCpuPickMs = performance.now() - t0;
        // 中心点覆盖为空时退回"半径内最近的候选"（否则任意采样点经常全落空 —— 实测三个采样点
        // 都是 null，球刷/深度带会以为这一片没有表面）。
        const nearestParams = {
            numSplats: data.numSplats as number,
            x: data.getProp('x') as Float32Array,
            y: data.getProp('y') as Float32Array,
            z: data.getProp('z') as Float32Array,
            state,
            showDeleted: !!splat.showDeleted,
            projection: camera.camera.projectionMatrix.data,
            view: camera.camera.viewMatrix.data,
            worldTransform: splat.entity.getWorldTransform().data,
            near: (camera as any).near,
            far: (camera as any).far,
            width: tw,
            height: th
        };
        for (const i of valid) {
            const v = out.normalizedDepth[(pys[i] - py0) * pw + (pxs[i] - px0)];
            if (Number.isFinite(v)) {
                result[i] = v;
                continue;
            }
            const nearest = cpuPickNearest({ ...nearestParams, px: pxs[i] + 0.5, py: pys[i] + 0.5, radius: 6 });
            result[i] = Number.isFinite(nearest.depth) ? nearest.depth : null;
        }
        return result;
    }

    // Read rectangle of splat IDs using normalized coordinates (0-1 range) (after prepareId)
    async readIds(x: number, y: number, width: number, height: number): Promise<number[]> {
        // unified 通路：CPU 版逐像素最前表面（见 prepareId 里的说明）
        if ((globalThis as any).__SPLATROOM_UNIFIED__ === true) {
            return this.readIdsCpu(x, y, width, height);
        }

        const rt = this.pickTarget;
        if (!rt) {
            return [];
        }

        const colorBuffer = rt.colorBuffer;

        // Convert normalized coordinates to render target pixels
        const px = Math.floor(x * rt.width);
        const py = Math.floor(y * rt.height);
        const pw = Math.max(1, Math.ceil((x + width) * rt.width) - px);
        const ph = Math.max(1, Math.ceil((y + height) * rt.height) - py);

        // Flip Y for texture read on WebGL (texture origin is bottom-left)
        const texY = this.device.isWebGL2 ? rt.height - py - ph : py;

        // Read pixels using texture.read() API.
        // `immediate: true` matters on the WebGPU backend: the copy is recorded into the
        // current command encoder, which PlayCanvas only submits at a frame boundary, so a
        // deferred map can resolve before the pick pass has actually been submitted and
        // return an empty buffer (picking came back as all zeros on WebGPU).
        const pixels = await colorBuffer.read(px, texY, pw, ph, {
            renderTarget: rt,
            immediate: true
        });

        const result: number[] = [];
        for (let i = 0; i < pw * ph; i++) {
            // Use >>> 0 to convert signed 32-bit to unsigned (so 0xffffffff instead of -1)
            result.push(
                (pixels[i * 4] |
                (pixels[i * 4 + 1] << 8) |
                (pixels[i * 4 + 2] << 16) |
                (pixels[i * 4 + 3] << 24)) >>> 0
            );
        }

        return result;
    }

    // Prepare for depth picking by rendering the specified splat
    prepareDepth(splat: Splat) {
        // unified 通路：与 id 拾取同样走 CPU（引擎那条路给不出逐高斯结果，见 cpu-pick.ts 文件头）。
        // 这里只记下元素，真正的计算在 readDepths 里。
        if ((globalThis as any).__SPLATROOM_UNIFIED__ === true) {
            this.cpuPickSplat = splat;
            return;
        }
        if (!this.depthRenderTarget) {
            return;
        }

        const { scene } = this;
        const { app, camera, splatLayer } = scene;
        const emptyMap = new Map();

        // Hide non-selected elements
        const splats = scene.getElementsByType(ElementType.splat) as Splat[];
        splats.forEach((s) => {
            s.entity.enabled = s === splat;
        });

        try {
            // Set depth estimation mode uniform
            this.device.scope.resolve('pickOp').setValue(2); // 'set' mode - don't skip any visible splats
            this.device.scope.resolve('pickMode').setValue(1);

            // Render scene with depth pass
            this.renderPass.blendState = this.depthBlendState;
            this.renderPass.init(this.depthRenderTarget);
            this.renderPass.setClearColor(depthClearColor);
            this.renderPass.update(camera.camera, app.scene, [splatLayer], emptyMap, false);
            this.renderPass.render();
        } finally {
            // Re-enable all splats — even if the render pass throws, otherwise a
            // failed depth pick leaves every splat disabled and the viewport blank
            splats.forEach((s) => {
                s.entity.enabled = true;
            });
        }
    }

    // Read normalized depth (0-1) at normalized screen position (0-1 range) (after prepareDepth)
    async readDepth(x: number, y: number): Promise<number | null> {
        if (!this.depthRenderTarget) {
            return null;
        }

        const rt = this.depthRenderTarget;
        const colorBuffer = rt.colorBuffer;

        // Convert normalized coordinates to render target pixels
        const px = Math.floor(x * rt.width);
        const py = Math.floor(y * rt.height);

        // Flip Y for texture read on WebGL (texture origin is bottom-left)
        const texY = this.device.isWebGL2 ? rt.height - py - 1 : py;

        // Read the pixel using Texture.read() which handles RGBA16F format
        const pixels = await colorBuffer.read(px, texY, 1, 1, { renderTarget: rt, immediate: true });

        return this.decodeDepth(pixels, 0);
    }

    // Read normalized depth at many scattered screen positions (0-1 range, y
    // down) after a single prepareDepth.
    //
    // Every read is a SYNCHRONOUS GPU stall (the copy has to be submitted and mapped inline on WebGPU,
    // see readIds), which is by far the dominant cost of a brush stroke: measured in the packaged app on
    // a 931k-splat scan, one stroke's depth readbacks took 113-180 ms while the depth pass itself was
    // ~0.2 ms of CPU time, and a single-sample stroke still cost 135 ms for its one read.
    //
    // Tiles were introduced to read a few small regions instead of the whole screen bound, but with the
    // stall dominating that trades one big wait for many: measured 150.8 ms (tiled) against 76.1 ms
    // (one read of the union bound) on the same strokes. So the samples are read in ONE call whenever the
    // union of their pixels is not absurdly large, and only fall back to tiles above that.
    static MAX_UNION_READ_PX = 4 << 20;      // 4M pixels: an 8 MB RGBA16F-ish copy at most

    async readDepths(points: { x: number, y: number }[]): Promise<(number | null)[]> {
        // unified 通路：CPU 版深度 pass（与 id 拾取同一趟循环，见 cpu-pick.ts）
        if ((globalThis as any).__SPLATROOM_UNIFIED__ === true) {
            return this.readDepthsCpu(points);
        }

        if (!this.depthRenderTarget) {
            return new Array(points.length).fill(null);
        }

        const rt = this.depthRenderTarget;
        const pixelsX = new Int32Array(points.length);
        const pixelsY = new Int32Array(points.length);
        const result: (number | null)[] = new Array(points.length).fill(null);
        const valid: number[] = [];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

        for (let i = 0; i < points.length; ++i) {
            const { x, y } = points[i];
            if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1 || rt.width < 1 || rt.height < 1) {
                continue;
            }

            const px = Math.min(Math.floor(x * rt.width), rt.width - 1);
            const py = Math.min(Math.floor(y * rt.height), rt.height - 1);
            pixelsX[i] = px;
            pixelsY[i] = py;
            valid.push(i);
            minX = Math.min(minX, px);
            maxX = Math.max(maxX, px);
            minY = Math.min(minY, py);
            maxY = Math.max(maxY, py);
        }

        if (valid.length === 0) {
            return result;
        }

        // Flip Y for texture reads on WebGL (texture origin is bottom-left):
        // read the flipped band and index its rows from the bottom
        const flip = this.device.isWebGL2;
        const unionWidth = maxX - minX + 1;
        const unionHeight = maxY - minY + 1;

        if (unionWidth * unionHeight <= Picker.MAX_UNION_READ_PX) {
            const texY = flip ? rt.height - maxY - 1 : minY;
            const pixels = await rt.colorBuffer.read(minX, texY, unionWidth, unionHeight, {
                renderTarget: rt,
                immediate: true
            });
            for (let k = 0; k < valid.length; ++k) {
                const i = valid[k];
                const row = flip ? maxY - pixelsY[i] : pixelsY[i] - minY;
                result[i] = this.decodeDepth(pixels, (row * unionWidth + pixelsX[i] - minX) * 4);
            }
            return result;
        }

        // very wide stroke: group the samples into tiles so the copy stays small
        const tiles = new Map<string, { indices: number[], minX: number, minY: number, maxX: number, maxY: number }>();
        const tileSize = 64;
        for (const i of valid) {
            const key = `${Math.floor(pixelsX[i] / tileSize)},${Math.floor(pixelsY[i] / tileSize)}`;
            const tile = tiles.get(key);
            if (tile) {
                tile.indices.push(i);
                tile.minX = Math.min(tile.minX, pixelsX[i]);
                tile.minY = Math.min(tile.minY, pixelsY[i]);
                tile.maxX = Math.max(tile.maxX, pixelsX[i]);
                tile.maxY = Math.max(tile.maxY, pixelsY[i]);
            } else {
                tiles.set(key, { indices: [i], minX: pixelsX[i], minY: pixelsY[i], maxX: pixelsX[i], maxY: pixelsY[i] });
            }
        }

        for (const tile of tiles.values()) {
            const width = tile.maxX - tile.minX + 1;
            const height = tile.maxY - tile.minY + 1;
            const texY = flip ? rt.height - tile.maxY - 1 : tile.minY;

            const pixels = await rt.colorBuffer.read(tile.minX, texY, width, height, {
                renderTarget: rt,
                immediate: true
            });

            for (const index of tile.indices) {
                const row = flip ? tile.maxY - pixelsY[index] : pixelsY[index] - tile.minY;
                result[index] = this.decodeDepth(pixels, (row * width + pixelsX[index] - tile.minX) * 4);
            }
        }

        return result;
    }

    // Decode a depth-pass pixel (RGBA16F): R channel is accumulated depth *
    // alpha, A channel is the transmittance (1 - alpha).
    private decodeDepth(pixels: any, offset: number): number | null {
        const r = half2Float(pixels[offset]);
        const transmittance = half2Float(pixels[offset + 3]);
        const alpha = 1 - transmittance;

        // transmittance close to 1 means nothing visible
        if (alpha < 1e-6) {
            return null;
        }

        // normalized depth (0-1 range)
        return r / alpha;
    }

    // Clean up resources
    destroy() {
        this.renderPass?.destroy();
    }
}

export { Picker };
