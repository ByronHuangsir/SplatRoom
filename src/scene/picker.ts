import {
    ADDRESS_CLAMP_TO_EDGE,
    BLENDEQUATION_ADD,
    BLENDMODE_ONE,
    BLENDMODE_ZERO,
    BLENDMODE_ONE_MINUS_SRC_ALPHA,
    BlendState,
    CameraComponent,
    Color,
    FILTER_NEAREST,
    GraphicsDevice,
    PIXELFORMAT_DEPTH,
    PIXELFORMAT_RGBA8,
    RenderPassPicker,
    RenderTarget,
    Texture
} from 'playcanvas';

import { ElementType } from './element';
import { Scene } from './scene';
import { Splat } from '../splat/splat';
import { setUnifiedPickMode } from '../splat/unified-material';

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

    /** unified 通路：按引擎的附件结构建一个两附件的 id 目标（见字段上的说明）。 */
    private ensureUnifiedPickTarget(): RenderTarget | null {
        const src = this.idRenderTarget;
        if (!src) {
            return null;
        }
        const { width, height } = src;
        if (this.unifiedPickTarget && this.unifiedPickTarget.width === width && this.unifiedPickTarget.height === height) {
            return this.unifiedPickTarget;
        }
        this.unifiedPickTarget?.destroy();

        const make = (name: string, format: number) => new Texture(this.device, {
            name,
            width,
            height,
            format,
            mipmaps: false,
            minFilter: FILTER_NEAREST,
            magFilter: FILTER_NEAREST,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE
        });

        this.unifiedPickTarget = new RenderTarget({
            colorBuffers: [
                make('splatPickId', PIXELFORMAT_RGBA8),     // RT0：id（readIds 读这一个）
                make('splatPickWork', PIXELFORMAT_RGBA8)    // RT1：引擎的第二个附件（内容不使用）
            ],
            depthBuffer: make('splatPickDepth', PIXELFORMAT_DEPTH),
            flipY: false,
            autoResolve: false
        });
        return this.unifiedPickTarget;
    }

    /** 拾取用的目标：unified 走专用 MRT，主线沿用 camera 给的那一个。 */
    private get pickTarget(): RenderTarget | null {
        if ((globalThis as any).__SPLATROOM_UNIFIED__ === true) {
            return this.ensureUnifiedPickTarget() ?? this.idRenderTarget;
        }
        return this.idRenderTarget;
    }

    /**
     * unified 通路上**引擎认识的那个 camera**。
     *
     * 为什么不能直接用 `scene.camera.camera`：引擎的 `gsplatDirector.camerasMap` 是**按 Camera 对象**
     * 索引的，而里面的 key 并不是 app 这个 camera（实测 `sameAsAppCamera: false`）——
     * `director.prepareForPicking(camera, ...)` 用它查不到 cameraData 就直接返回 null ⇒
     * 引擎那条拾取网格实例根本拿不到 ⇒ 拾取那一遍既不画也不清屏（读回来的是 work 贴图残留）。
     * 这里按"哪个 camera 的 layersMap 里有我们这个 splat layer 且带 gsplatManager"来找，
     * 不猜对象身份。
     */
    private unifiedPickCamera(): any | null {
        const director = (this.scene.app.renderer as any)?.gsplatDirector;
        if (!director?.camerasMap) {
            return null;
        }
        let found: any = null;
        director.camerasMap.forEach((cameraData: any, camera: any) => {
            if (found) {
                return;
            }
            const layerData = cameraData?.layersMap?.get(this.scene.splatLayer);
            if (layerData?.gsplatManager) {
                found = camera;
            }
        });
        return found;
    }

    // The color buffer of the last ID pass (front-most splat index per pixel,
    // RGBA8-encoded).
    get idTexture(): Texture | null {
        const rt = this.pickTarget;
        return rt ? rt.colorBuffer : null;
    }

    // Prepare for ID picking by rendering the specified splat
    prepareId(splat: Splat, mode: 'add' | 'remove' | 'set' | 'intersect') {
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

            // unified 通路（引擎 GPU 排序）没有 per-instance 材质，上面那两个 uniform 到不了
            // 它的着色器（材质是引擎那个、由我们挂钩覆盖），所以要走我们自己的开关：
            // `srPickMode = 1` 让片元把 splat 行号当 id 写成颜色。**必须在 render 之前设、
            // 在回读之后清**（回读用 immediate:true，会把这一遍绘制立即提交）。
            const unified = (globalThis as any).__SPLATROOM_UNIFIED__ === true;
            if (unified) {
                setUnifiedPickMode(this.scene, 1);
            }

            // Render ID picking pass
            const emptyMap = new Map();
            this.renderPass.blendState = BlendState.NOBLEND;
            this.renderPass.init(target);
            this.renderPass.setClearColor(idClearColor);
            // 引擎的 RenderPassPicker 期望"相机组件"（内部读 `camera.camera`）并据此向
            // gsplatDirector 要拾取网格实例；unified 通路上必须给它**引擎认识的那个 camera**
            // （见 unifiedPickCamera 的说明），否则那一遍什么都不画。
            // 这里传一个只带 `camera` 的等价物 —— 引擎在 before()/execute() 里用到的就只有
            // `camera.camera`（还有 scene.layers / renderTarget），不需要整个组件。
            const engineCamera = unified ? this.unifiedPickCamera() : null;
            const pickCamera = (engineCamera ? { camera: engineCamera } : this.scene.camera.camera) as unknown as CameraComponent;
            this.renderPass.update(pickCamera, this.scene.app.scene, [splatLayer], emptyMap, false);
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
        const rt = this.pickTarget;
        if (!rt) {
            return -1;
        }
        // For single pixel read, use a minimal normalized size
        const ids = await this.readIds(x, y, 1 / rt.width, 1 / rt.height);
        return ids[0];
    }

    // Read rectangle of splat IDs using normalized coordinates (0-1 range) (after prepareId)
    async readIds(x: number, y: number, width: number, height: number): Promise<number[]> {
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

        // 回读完成（immediate:true 已经把这一遍绘制提交掉了）⇒ 收回拾取模式。
        // 不收的话，视口下一帧就会把 id 当颜色画出来。
        if ((globalThis as any).__SPLATROOM_UNIFIED__ === true) {
            setUnifiedPickMode(this.scene, 0);
        }

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
