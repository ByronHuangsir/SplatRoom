import {
    ADDRESS_CLAMP_TO_EDGE,
    PIXELFORMAT_RGBA32F,
    SEMANTIC_POSITION,
    drawQuadWithShader,
    BoundingBox,
    GraphicsDevice,
    RenderTarget,
    ScopeSpace,
    Shader,
    ShaderUtils,
    Texture,
    Vec3,
    BlendState
} from 'playcanvas';

import { waitForGpuDrain, withReadbackTimeout } from './gpu-readback';
import { vertexShader, fragmentShader } from '../shaders/bound-shader';
import { Splat } from '../splat/splat';
import { splatResourceOf } from '../splat/splat-resource';

const v1 = new Vec3();
const v2 = new Vec3();
const v3 = new Vec3();
const v4 = new Vec3();

const resolve = (scope: ScopeSpace, values: any) => {
    for (const key in values) {
        scope.resolve(key).setValue(values[key]);
    }
};

class CalcBound {
    private device: GraphicsDevice;
    private splatParams = new Int32Array(3);
    private shader: Shader = null;
    private selectedMinTexture: Texture = null;
    private selectedMaxTexture: Texture = null;
    private visibleMinTexture: Texture = null;
    private visibleMaxTexture: Texture = null;
    private renderTarget: RenderTarget = null;
    private selectedMinRenderTarget: RenderTarget = null;
    private selectedMaxRenderTarget: RenderTarget = null;
    private visibleMinRenderTarget: RenderTarget = null;
    private visibleMaxRenderTarget: RenderTarget = null;
    private selectedMinData: Float32Array = null;
    private selectedMaxData: Float32Array = null;
    private visibleMinData: Float32Array = null;
    private visibleMaxData: Float32Array = null;

    // set by the last run when a pass matched no row at all (see the ±1e6 note in run())
    private selectedEmpty = false;
    private visibleEmpty = false;
    private warnedVisibleEmpty = false;

    /** True when the last selection-bound pass matched no splat (nothing selected). */
    get selectionEmpty() {
        return this.selectedEmpty;
    }

    /** True when the last pass found no visible splat at all (every splat deleted). */
    get localEmpty() {
        return this.visibleEmpty;
    }

    constructor(device: GraphicsDevice) {
        this.device = device;
    }

    private getResources(width: number) {
        const { device } = this;

        if (!this.shader) {
            this.shader = ShaderUtils.createShader(device, {
                uniqueName: 'calcBoundShader',
                attributes: {
                    vertex_position: SEMANTIC_POSITION
                },
                vertexGLSL: vertexShader,
                fragmentGLSL: fragmentShader
            });
        }

        if (!this.selectedMinTexture || this.selectedMinTexture.width !== width) {
            if (this.selectedMinTexture) {
                this.selectedMinTexture.destroy();
                this.selectedMaxTexture.destroy();
                this.visibleMinTexture.destroy();
                this.visibleMaxTexture.destroy();
                this.renderTarget.destroy();
                this.selectedMinRenderTarget.destroy();
                this.selectedMaxRenderTarget.destroy();
                this.visibleMinRenderTarget.destroy();
                this.visibleMaxRenderTarget.destroy();
            }

            const createTexture = (name: string) => {
                return new Texture(device, {
                    name,
                    width,
                    height: 1,
                    format: PIXELFORMAT_RGBA32F,
                    mipmaps: false,
                    addressU: ADDRESS_CLAMP_TO_EDGE,
                    addressV: ADDRESS_CLAMP_TO_EDGE
                });
            };

            this.selectedMinTexture = createTexture('calcBoundSelectedMin');
            this.selectedMaxTexture = createTexture('calcBoundSelectedMax');
            this.visibleMinTexture = createTexture('calcBoundVisibleMin');
            this.visibleMaxTexture = createTexture('calcBoundVisibleMax');

            this.renderTarget = new RenderTarget({
                colorBuffers: [this.selectedMinTexture, this.selectedMaxTexture, this.visibleMinTexture, this.visibleMaxTexture],
                depth: false
            });

            this.selectedMinRenderTarget = new RenderTarget({
                colorBuffer: this.selectedMinTexture,
                depth: false
            });

            this.selectedMaxRenderTarget = new RenderTarget({
                colorBuffer: this.selectedMaxTexture,
                depth: false
            });

            this.visibleMinRenderTarget = new RenderTarget({
                colorBuffer: this.visibleMinTexture,
                depth: false
            });

            this.visibleMaxRenderTarget = new RenderTarget({
                colorBuffer: this.visibleMaxTexture,
                depth: false
            });

            this.selectedMinData = new Float32Array(width * 4);
            this.selectedMaxData = new Float32Array(width * 4);
            this.visibleMinData = new Float32Array(width * 4);
            this.visibleMaxData = new Float32Array(width * 4);
        }

        return {
            shader: this.shader,
            selectedMinTexture: this.selectedMinTexture,
            selectedMaxTexture: this.selectedMaxTexture,
            visibleMinTexture: this.visibleMinTexture,
            visibleMaxTexture: this.visibleMaxTexture,
            renderTarget: this.renderTarget,
            selectedMinRenderTarget: this.selectedMinRenderTarget,
            selectedMaxRenderTarget: this.selectedMaxRenderTarget,
            visibleMinRenderTarget: this.visibleMinRenderTarget,
            visibleMaxRenderTarget: this.visibleMaxRenderTarget,
            selectedMinData: this.selectedMinData,
            selectedMaxData: this.selectedMaxData,
            visibleMinData: this.visibleMinData,
            visibleMaxData: this.visibleMaxData
        };
    }

    async run(splat: Splat, selectionBound: BoundingBox, localBound: BoundingBox): Promise<void> {
        const device = splat.scene.graphicsDevice;
        const { scope } = device;

        const numSplats = splat.splatData.numSplats;
        // ⚠️ 2026-09-25：unified 通路（引擎 GPU 排序）下 `gsplat.instance` 是 **null**
        // （资源挂在 `gsplat.resource` / `_placement.resource` 上，见 `Splat.bindAsset`）。
        // 这里原先直接读 `instance.resource` ⇒ TypeError ⇒ 被导入链转成错误弹窗 ⇒
        // 无人操作时导入**永不 settle**（§4d 那个"`?unified=1` 导入卡死"的第二处）。
        // 两种模式统一从组件上取资源；真的取不到就**保持 CPU 侧已有的 AABB**
        // （`bindAsset` 已经 `cpuBoundStorage.copy(resource.aabb)`），不要抛异常打断导入。
        const gsplat = splat.entity.gsplat as any;
        const resource = splatResourceOf(gsplat);
        if (!resource || typeof resource.getTexture !== 'function') {
            return;
        }
        const transformA = (resource as any).getTexture('transformA');
        if (!transformA) {
            return;
        }
        const splatTransform = splat.transformTexture;
        const transformPalette = splat.transformPalette.texture;
        const splatState = splat.stateTexture;

        this.splatParams[0] = transformA.width;
        this.splatParams[1] = transformA.height;
        this.splatParams[2] = numSplats;

        // get resources
        const resources = this.getResources(transformA.width);

        resolve(scope, {
            transformA,
            splatTransform,
            transformPalette,
            splatState,
            splat_params: this.splatParams
        });

        device.setBlendState(BlendState.NOBLEND);
        drawQuadWithShader(device, resources.renderTarget, resources.shader);

        // The GPU readback below uses an infinite clientWaitSync poll
        // (texture.read -> readPixelsAsync -> clientWaitAsync). If the GPU
        // queue is still busy — e.g. immediately after a replaceData uploaded a
        // large refined splat — the poll can stall long enough for the driver
        // watchdog to fire (monitor black screen / TDR). Yield one frame so the
        // queue drains, then bound the wait and keep the previous bounds on
        // failure instead of blocking the pipeline forever.
        await waitForGpuDrain();

        // allSettled per read: one stalled readback must not discard the three
        // successful ones. Failed reads keep their previous contents (the
        // shared data buffers) so the reduction below stays valid.
        const reads = await Promise.allSettled([
            withReadbackTimeout(resources.selectedMinTexture.read(0, 0, transformA.width, 1, {
                renderTarget: resources.selectedMinRenderTarget,
                data: resources.selectedMinData,
                immediate: true
            })),
            withReadbackTimeout(resources.selectedMaxTexture.read(0, 0, transformA.width, 1, {
                renderTarget: resources.selectedMaxRenderTarget,
                data: resources.selectedMaxData,
                immediate: true
            })),
            withReadbackTimeout(resources.visibleMinTexture.read(0, 0, transformA.width, 1, {
                renderTarget: resources.visibleMinRenderTarget,
                data: resources.visibleMinData,
                immediate: true
            })),
            withReadbackTimeout(resources.visibleMaxTexture.read(0, 0, transformA.width, 1, {
                renderTarget: resources.visibleMaxRenderTarget,
                data: resources.visibleMaxData,
                immediate: true
            }))
        ]);
        const failures = reads.filter(r => r.status === 'rejected');
        if (failures.length > 0) {
            console.warn(`[CalcBound] ${failures.length} of 4 readbacks failed or timed out, using stale data for those`, failures[0].reason);
        }
        // successful reads wrote into the shared data buffers; failed ones keep
        // their previous contents — either way the reduction below is valid
        const selectedMinData = resources.selectedMinData;
        const selectedMaxData = resources.selectedMaxData;
        const visibleMinData = resources.visibleMinData;
        const visibleMaxData = resources.visibleMaxData;

        // resolve selected bounds
        v1.set(Infinity, Infinity, Infinity);
        v2.set(-Infinity, -Infinity, -Infinity);

        for (let i = 0; i < transformA.width; i++) {
            const a = selectedMinData[i * 4];
            const b = selectedMinData[i * 4 + 1];
            const c = selectedMinData[i * 4 + 2];
            if (isFinite(a)) v1.x = Math.min(v1.x, a);
            if (isFinite(b)) v1.y = Math.min(v1.y, b);
            if (isFinite(c)) v1.z = Math.min(v1.z, c);

            const d = selectedMaxData[i * 4];
            const e = selectedMaxData[i * 4 + 1];
            const f = selectedMaxData[i * 4 + 2];
            if (isFinite(d)) v2.x = Math.max(v2.x, d);
            if (isFinite(e)) v2.y = Math.max(v2.y, e);
            if (isFinite(f)) v2.z = Math.max(v2.z, f);
        }

        // The shader seeds its accumulators with the ±1e6 sentinel (it needs a value that
        // survives the GLSL->WGSL transpile, so true infinity is out) and only *skips*
        // deleted rows. "No row matched" therefore comes back as min = 1e6 / max = -1e6
        // rather than as infinity, and writing that through produced a box with centre 0
        // and halfExtents -1e6. That inflated boundRadius to ~1.7e6, which pushed the
        // camera's near plane to far/16384 ≈ 105 and clipped every model in the viewport
        // until the user undid the delete (docs/audit/01-量级复查-bug.md §13; reachable
        // with Ctrl+A + Delete, or a crop box that removes every splat).
        // A matched row always yields min <= max on every axis, so an inverted axis means
        // "nothing here": keep the previous bound instead of publishing a degenerate one.
        this.selectedEmpty = !(v1.x <= v2.x && v1.y <= v2.y && v1.z <= v2.z);
        if (!this.selectedEmpty) {
            selectionBound.setMinMax(v1, v2);
        }

        // resolve visible bounds
        v3.set(Infinity, Infinity, Infinity);
        v4.set(-Infinity, -Infinity, -Infinity);

        for (let i = 0; i < transformA.width; i++) {
            const a = visibleMinData[i * 4];
            const b = visibleMinData[i * 4 + 1];
            const c = visibleMinData[i * 4 + 2];
            if (isFinite(a)) v3.x = Math.min(v3.x, a);
            if (isFinite(b)) v3.y = Math.min(v3.y, b);
            if (isFinite(c)) v3.z = Math.min(v3.z, c);

            const d = visibleMaxData[i * 4];
            const e = visibleMaxData[i * 4 + 1];
            const f = visibleMaxData[i * 4 + 2];
            if (isFinite(d)) v4.x = Math.max(v4.x, d);
            if (isFinite(e)) v4.y = Math.max(v4.y, e);
            if (isFinite(f)) v4.z = Math.max(v4.z, f);
        }

        this.visibleEmpty = !(v3.x <= v4.x && v3.y <= v4.y && v3.z <= v4.z);
        if (this.visibleEmpty) {
            // Every splat is deleted (or the model is empty). Say so once instead of
            // silently publishing the sentinel box.
            if (!this.warnedVisibleEmpty) {
                this.warnedVisibleEmpty = true;
                console.warn('[CalcBound] no visible splats: keeping the previous local bound');
            }
        } else {
            this.warnedVisibleEmpty = false;
            localBound.setMinMax(v3, v4);
        }
    }
}

export { CalcBound };
