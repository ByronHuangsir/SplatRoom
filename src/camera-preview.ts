import {
    Color,
    Entity,
    CameraComponent,
    RenderTarget,
    RenderPass,
    RenderPassForward,
    Texture,
    PIXELFORMAT_RGBA8,
    PIXELFORMAT_DEPTH,
    PIXELFORMAT_R32U,
    FILTER_NEAREST,
    ADDRESS_CLAMP_TO_EDGE,
    ASPECT_MANUAL,
    Vec3,
    Mat4
} from 'playcanvas';

import { AnimationController } from './animation/animation-controller';
import { TrackId } from './animation/animation-data';
import { Element, ElementType } from './element';
import { Splat } from './splat';

/**
 * CameraPreview renders a picture-in-picture view showing what the
 * camera-animation camera "sees" at the current frame. It creates a
 * second PlayCanvas camera with its own render passes targeting a
 * small (320x180) RenderTarget, then copies the rendered result to
 * a 2D HTML canvas overlay.
 */
class CameraPreview extends Element {
    // PlayCanvas entities
    cameraEntity: Entity;
    cameraComponent: CameraComponent;
    renderTarget: RenderTarget;
    colorBuffer: Texture;
    depthBuffer: Texture;

    // Render passes for manual PiP rendering
    pipClearPass: RenderPass;
    pipRenderPass: RenderPassForward;

    // PiP DOM
    container: HTMLDivElement | null = null;
    canvas2d: HTMLCanvasElement | null = null;
    ctx2d: CanvasRenderingContext2D | null = null;
    header: HTMLDivElement | null = null;

    // State
    enabled = false;
    hasTrack = false;
    lastFrame = -1;
    dragging = false;
    dragOffsetX = 0;
    dragOffsetY = 0;

    // PiP-private depth-sort pipelines (one independent sorter + order buffer
    // per GSplatInstance) so the PiP preview gets its OWN stable depth sort that
    // never shares mutable state with the main view.
    //
    // ARCHITECTURE (v10 — "Worker-based depth sort, zero main-thread blocking"):
    //   • Each GSplatInstance gets a SECOND GSplatSorter + SECOND R32U orderTexture
    //     (pipOrder). Created ONCE, reused forever (cached in _pipSort Map).
    //   • pipOrder is initially seeded with IDENTITY permutation (first-frame fallback).
    //
    //   KEY CHANGE vs v8: the ENGINE's pipSorter.sort() is async (Web Worker),
    //   so rendering right after sort() shows the stale identity seed — that was
    //   v8's "PiP always looks wrong" bug. v9 fixed correctness by sorting on the
    //   main thread synchronously (same-frame result) but cost 50-150ms of rAF
    //   jank per PiP frame. v10 keeps the SAME correct depth-sort math but moves
    //   it into ONE shared Web Worker:
    //     1. Read resource.centers (Float32Array of LOCAL-space splat XYZ positions)
    //     2. Compute dot(center, camDirLocal) for each splat → depth key
    //        (camDirLocal = camera +Z/backward axis, transformed into the splat's
    //         LOCAL space via invert(meshInstance.node.getWorldTransform) — exactly
    //         like engine GSplatInstance.sort + gsplat-sort-worker)
    //     3. postMessage to the Worker → async quick-sort back-to-front
    //     4. On a later PiP update frame, create NEW pipOrder Texture with
    //        levels:[sortedPermutation] (engine-managed upload, proven since v3.3)
    //        and swap the material parameter
    //     5. Render PiP with the current pipOrder
    //   • One PiP frame of sort latency is irrelevant at ~5fps.
    //   • cameras[] is CLEARED before render (no async sort via update())
    //   • pipSorter exists as placeholder only (never triggers work)
    //   • Main view: ZERO shared mutable state (same isolation as v6/v7/v8)
    //   • Worker failure → automatic fallback to sync _cpuDepthSort
    //
    // PERFORMANCE (v10):
    //   • Resolution: 320×180 (original size)
    //   • PiP update rate: ~5fps (PIP_FRAME_INTERVAL=6 at 30fps base)
    //   • Worker sort cost: ~50-150ms per PiP frame (1-3M splats) — OFF main thread
    //   • Main thread cost: structured-clone copy of centers (~12-36MB, few ms)
    //     + GL texture build (~1ms) — no rAF jank
    //   • First frame: identity seed (before first sort completes); all subsequent: correct

    private _pipSort = new Map<any, any>();
    private _mergedKey = {};

    // ---- v10.2: sorter swap 状态标记（P2 防"PiP 入侵主视角"加固）----
    // PiP 渲染必须在 onPostRender 内把全局共享的 instance.sorter/orderTexture
    // swap 到 PiP 专属管线，渲染完再恢复。若恢复逻辑漏执行（异常路径、时序
    // 竞态），主视角会持续用 PiP 相机的排序结果渲染 → 视觉上就是"PiP 入侵
    // 主视角 / 近小远大"。此标记在 swap 入口置 true、外层 finally 置 false；
    // scene.onPreRender 在主渲染前检查该标记，发现残留立即告警并强制恢复。
    private _pipSwapActive = false;

    /** 当前是否处于 PiP sorter swap 窗口（true = 共享 sorter/orderTexture 被 PiP 占用）。 */
    get pipSwapActive() {
        return this._pipSwapActive;
    }

    // ---- v10: Worker-based depth sort (main thread never blocks) ----
    // The v9 synchronous CPU sort (~50-150ms per PiP frame) blocked the rAF
    // thread → main-view jank. v10 moves the pure-math sort into ONE shared Web
    // Worker. Each PiP update frame:
    //   1. apply any finished result for an entry (pendingOrders) — GL-safe
    //      moment inside onPostRender
    //   2. request a fresh sort for the entry (skip if one is in flight)
    // Results arrive asynchronously; the PiP runs at ~5fps so one frame of
    // latency is irrelevant. Falls back to the sync _cpuDepthSort when the
    // Worker is unavailable (worker error / WebGPU).
    private _sortWorker: Worker | null = null;
    private _sortReqSeq = 0;                              // global request id counter
    private _workerKeySeq = 0;                            // unique key per PiP entry
    private _inflightReq = new Map<any, number>();        // entry key → in-flight request id
    private _pendingOrders = new Map<any, { order: Uint32Array; reqId: number }>(); // key → finished result
    private _workerFailed = false;

    // Frame-rate throttle: run the entire PiP pipeline only every N frames.
    // v9/v10-history: was 10 → 20 because the synchronous CPU sort blocked the
    // rAF thread. v10 moved the sort into a Worker (main thread only pays a few
    // ms for the centers copy + texture build), so the throttle is now about
    // WORKER SORT THROUGHPUT, not main-thread cost. Base interval 6 (~5fps
    // @30fps); _pipInterval() widens it automatically for huge models (the
    // centers structured-clone copy is ~12MB per million splats, and a 14M-splat
    // sort takes 200-500ms — requesting faster than that just piles up work).
    private static readonly PIP_FRAME_INTERVAL = 6;
    private _pipUpdateCounter = 0;

    /**
     * Effective PiP update interval, widened for large models:
     *   interval = clamp(ceil(maxNumSplats / 1M), 6, 40)
     *   1M   → 6   (~5fps)    5M → 6   (~5fps)
     *   14M  → 14  (~2.1fps)  40M+ → 40 (~0.75fps)
     * The in-flight request guard additionally skips requests the worker can't
     * serve in time, so this is a soft ceiling.
     */
    private _pipInterval(): number {
        let maxN = 0;
        const consider = (instance: any) => {
            const dims = instance?.resource?.streams?.textureDimensions;
            if (dims) maxN = Math.max(maxN, dims.x * dims.y);
        };
        for (const splat of this.scene.getElementsByType(ElementType.splat) as Splat[]) {
            consider((splat.entity as any)?.gsplat?.instance);
        }
        if (this.scene.groupRenderer.isActive) {
            consider((this.scene.groupRenderer as any).mergedEntity?.gsplat?.instance);
        }
        if (maxN <= 0) return CameraPreview.PIP_FRAME_INTERVAL;
        return Math.max(CameraPreview.PIP_FRAME_INTERVAL, Math.min(40, Math.ceil(maxN / 1000000)));
    }

    // Drag snap config
    private readonly SNAP_THRESHOLD = 40; // px from edge to trigger snap
    private readonly SNAP_TRANSITION = 'left 0.2s ease-out, top 0.2s ease-out, right 0.2s ease-out, bottom 0.2s ease-out';

    // Dimensions — original size (v8: restored from v7's 160×90)
    readonly WIDTH = 320;
    readonly HEIGHT = 180;

    // Track data listener cleanup
    private _unlisten: Array<() => void> = [];

    constructor() {
        super(ElementType.debug);
    }

    add() {
        const scene = this.scene;
        const device = scene.graphicsDevice;
        const { events } = scene;

        // ---- Create render target textures ----
        this.colorBuffer = new Texture(device, {
            name: 'pipColor',
            width: this.WIDTH,
            height: this.HEIGHT,
            format: PIXELFORMAT_RGBA8,
            mipmaps: false,
            minFilter: FILTER_NEAREST,
            magFilter: FILTER_NEAREST,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE
        });

        this.depthBuffer = new Texture(device, {
            name: 'pipDepth',
            width: this.WIDTH,
            height: this.HEIGHT,
            format: PIXELFORMAT_DEPTH,
            mipmaps: false,
            minFilter: FILTER_NEAREST,
            magFilter: FILTER_NEAREST,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE
        });

        this.renderTarget = new RenderTarget({
            name: 'pipRT',
            colorBuffer: this.colorBuffer,
            depthBuffer: this.depthBuffer,
            flipY: false,
            autoResolve: true
        });

        // ---- Create second camera entity ----
        // Camera component is ENABLED for matrix updates, but framePasses is
        // set to [] to prevent PlayCanvas's standard pipeline from auto-rendering
        // it during app.render(). We render manually via pipRenderPass in
        // onPreRender(). This avoids GL state conflicts with the main camera.
        this.cameraEntity = new Entity('pipCamera');
        this.cameraEntity.addComponent('camera', {
            enabled: true,
            clearColor: true,
            clearDepth: true
        });
        this.cameraComponent = this.cameraEntity.camera as CameraComponent;

        // Set camera properties
        this.cameraComponent.aspectRatioMode = ASPECT_MANUAL;
        this.cameraComponent.aspectRatio = this.WIDTH / this.HEIGHT;
        this.cameraComponent.horizontalFov = this.WIDTH > this.HEIGHT;
        this.cameraComponent.nearClip = 0.01;
        this.cameraComponent.farClip = 5000;
        this.cameraComponent.fov = 60;
        this.cameraComponent.renderTarget = this.renderTarget;

        // Configure layers: same as main camera, minus overlay/gizmo
        const layerIds = [scene.worldLayer.id, scene.splatLayer.id];
        this.cameraComponent.layers = layerIds;
        // layersSet is automatically maintained by the Camera.layers setter
        // (Camera.ts line 317: this._layersSet = new Set(this._layers))

        // Prevent PlayCanvas from auto-rendering this camera during app.render().
        // Setting framePasses to an empty array makes the standard pipeline skip
        // this camera entirely. We render manually via pipRenderPass in onPreRender().
        // This avoids GL state conflicts with the main camera's framePasses.
        this.cameraComponent.framePasses = [];

        // Add to app root (independent world-space position, NOT relative to
        // main camera). The PiP camera renders from the animation path coordinates
        // which are world-space positions.
        scene.app.root.addChild(this.cameraEntity);

        // ---- Set up manual render passes for PiP ----
        // SplatRoom uses custom framePasses on the main camera (camera.ts:651),
        // which bypasses PlayCanvas's standard camera-list rendering.
        // The PiP camera must be rendered manually via its own RenderPassForward.
        const composition = scene.app.scene.layers;
        const renderer = scene.app.renderer;

        this.pipClearPass = new RenderPass(device);
        this.pipClearPass.init(this.renderTarget);
        this.pipClearPass.setClearColor(new Color(0.14, 0.14, 0.16, 1));
        this.pipClearPass.setClearDepth(1);

        this.pipRenderPass = new RenderPassForward(device, composition, scene.app.scene, renderer);
        this.pipRenderPass.init(this.renderTarget);
        this.pipRenderPass.addLayer(this.cameraComponent, scene.worldLayer, false, false);
        this.pipRenderPass.addLayer(this.cameraComponent, scene.worldLayer, true, false);
        this.pipRenderPass.addLayer(this.cameraComponent, scene.splatLayer, false, false);
        this.pipRenderPass.addLayer(this.cameraComponent, scene.splatLayer, true, false);

        // ---- Create PiP DOM ----
        this.createDom();

        // ---- Listen for events ----
        const checkTrack = () => {
            const controller = events.invoke('animation.controller') as AnimationController | undefined;
            const track = controller?.getTrack(TrackId.Camera);
            this.hasTrack = !!(track && track.keys && track.keys.length > 0);

            // SYMPTOM B ROOT CAUSE FIX: lastFrame defaults to -1 and is only
            // updated by the 'timeline.frame' event (fired on scrub). Adding
            // a keyframe does NOT fire that event, so without this guard the
            // PiP camera is never positioned and the preview renders an
            // empty (clear-color) frame. Seed lastFrame to the first key's
            // frame so updateCameraPose() runs on the very next render.
            //
            // NOTE: CameraAnimTrack.keys is a number[] (see camera-poses.ts
            // `get keys() { return this.poses.map(p => p.frame); }`), so the
            // value at index 0 is the frame number itself — DO NOT append
            // `.frame` to it (that yields undefined and breaks pose lookup).
            if (this.hasTrack && this.lastFrame < 0) {
                this.lastFrame = track.keys[0];
                scene.forceRender = true;
            }

            this.updateVisibility();
        };

        const onFrame = (frame: number) => {
            this.lastFrame = frame;
            if (this.enabled && this.hasTrack) {
                scene.forceRender = true;
            }
        };

        const onPanelChange = () => {
            this.updateVisibility();
            if (this.enabled && this.hasTrack) {
                scene.forceRender = true;
            }
        };

        // Initial check
        checkTrack();

        events.on('track.keyAdded', checkTrack);
        events.on('track.keyRemoved', checkTrack);
        events.on('track.keysCleared', checkTrack);
        events.on('track.keysLoaded', checkTrack);
        events.on('timeline.frame', onFrame);
        events.on('statusBar.panelChanged', onPanelChange);

        this._unlisten.push(
            () => events.off('track.keyAdded', checkTrack),
            () => events.off('track.keyRemoved', checkTrack),
            () => events.off('track.keysCleared', checkTrack),
            () => events.off('track.keysLoaded', checkTrack),
            () => events.off('timeline.frame', onFrame),
            () => events.off('statusBar.panelChanged', onPanelChange)
        );
    }

    remove() {
        this._unlisten.forEach(fn => fn());
        this._unlisten.length = 0;
        // Dispose PiP-private sort pipelines (workers + order textures).
        for (const entry of this._pipSort.values()) this._releasePipSort(entry);
        this._pipSort.clear();
        // Terminate the shared depth-sort worker (v10).
        this._terminateSortWorker();
        this.pipClearPass?.destroy();
        this.pipRenderPass?.destroy();
        this.cameraEntity?.destroy();
        this.container?.remove();
        this.container = null;
    }

    onPreRender() {
        if (!this.enabled || !this.hasTrack) return;

        // Skip PiP entirely during keyframe/video export. render.ts drives the
        // frame loop via scene.lockedRenderMode (explicit frame control); the PiP
        // preview must not mutate splat order/visibility during that pass.
        if (this.scene.lockedRenderMode) return;

        // While the user drags / scrolls / coasts in the main view, disable the
        // PiP camera component so the per-frame culler skips it entirely (its
        // pose is animation-driven and does not change during main-view
        // interaction). Re-enabled on the first frame after interaction ends.
        if (this.scene.camera.userDragging) {
            if (this.cameraComponent.enabled) this.cameraComponent.enabled = false;
            return;
        }
        if (!this.cameraComponent.enabled) this.cameraComponent.enabled = true;

        // Update PiP camera position from spline BEFORE cullComposition runs
        // in app.render(). This ensures mesh instances are culled against the
        // current frame's camera pose, eliminating the 1-frame culling delay.
        this.updateCameraPose();

        // Force camera matrices to be computed so that cullComposition
        // (which calls camera.frameUpdate) picks up the correct transform.
        const cam = this.cameraComponent.camera;
        void cam.projectionMatrix;
        void cam.viewMatrix;

        // The PiP camera pose is updated here (before the main cull). The PiP
        // render in onPostRender uses an independent PiP-private sorter + order
        // buffer (see onPostRender / _ensurePipSort). No shared mutable state.
    }

    onPostRender() {
        // Render PiP AFTER the main render (main camera already drew to the
        // backbuffer). The PiP reuses the same GSplatInstance meshes but renders
        // through its OWN independent R32U orderTexture (cached in _pipSort),
        // so the two views share ZERO mutable sort state.
        //
        // PIPELINE (v10 — Worker-based depth sort, zero main-thread blocking):
        //   ★ FRAME-RATE THROTTLE: skip entirely on most frames ★
        //   Only run every PIP_FRAME_INTERVAL frames (6 = ~5fps at 30fps base).
        //
        //   On PiP update frames:
        //     1. Ensure pipelines exist (one-time creation, cached).
        //     2. Swap instance.sorter/orderTexture → PiP pipeline.
        //     3. PiP cull (populates cameras[] for visibility culling).
        //     4. WORKER-BASED DEPTH SORT (v10):
        //        - Compute depth key per splat relative to PiP camera (local space)
        //        - postMessage the sort to a shared Web Worker (async, ~50-150ms)
        //        - Apply any FINISHED result (new pipOrder Texture, swapped in)
        //        - Request a fresh sort (skip if one is already in flight)
        //        - Fallback to sync _cpuDepthSort when the Worker is unavailable
        //     5. CLEAR cameras[] (prevent async Worker sort via update())
        //     6. Render PiP (reads the current pipOrder)
        //     7. Restore instances to MAIN pipeline.
        //     8. Defensive clear cameras[] (main-view protection).
        //
        //   v9 sorted synchronously on the main thread (50-150ms per PiP frame →
        //   rAF jank). v10 moves that math into a Worker: the main thread only
        //   pays a few ms for the centers structured-clone copy + texture build.
        //     5. CLEAR cameras[] (prevent async Worker sort via update())
        //     6. Render PiP (reads correctly-sorted pipOrder)
        //     7. Restore instances to MAIN pipeline.
        //     8. Defensive clear cameras[] (main-view protection).
        if (!this.enabled || !this.hasTrack) return;

        // Skip PiP entirely during keyframe/video export. render.ts sets
        // scene.lockedRenderMode and controls frames explicitly; the PiP preview
        // must not touch splat order textures or cameras during export.
        if (this.scene.lockedRenderMode) return;

        // Skip PiP while the user is dragging / coasting in the main view:
        // the PiP previews the ANIMATION camera, whose pose does not change
        // during a main-view drag — its content is static, so re-rendering it
        // (a full splat pass + depth sort) only wastes GPU/worker time and
        // directly hurts main-view drag smoothness with the timeline open.
        if (this.scene.camera.userDragging) return;

        // ---- Frame-rate throttle: skip PiP on most frames ----
        if (++this._pipUpdateCounter % this._pipInterval() !== 0) return;

        const splats = this.scene.getElementsByType(ElementType.splat) as Splat[];

        // =====================================================================
        // CRITICAL (SplatRoom "近小远大" fix): the ENTIRE PiP pipeline must be
        // wrapped in try/finally so the main view's sorter/orderTexture are
        // restored under EVERY code path.
        //
        // Phase 1 swaps the SHARED GSplatInstance state to the PiP pipeline:
        //   instance.sorter          → entry.pipSorter
        //   material 'splatOrder'    → entry.pipOrder
        // If any later phase throws (cull, worker postMessage, _applyPipOrder,
        // pipRenderPass.execute, captureToCanvas), and the restore runs only in
        // a finally that wraps JUST the render phase, the main view is left
        // permanently pointing at the PiP's sorter/orderTexture → main view
        // renders with PiP-camera-sorted splats → visually identical to the
        // "near small / far big" regression (half-transparent gaussians mixed
        // in the wrong order). The swap and ALL phases must share one finally.
        // =====================================================================
        this._pipSwapActive = true;   // P2: 标记 swap 窗口开启（finally 中关闭）
        try {
            // ---- Phase 1: ensure PiP pipelines exist (one-time per instance) ----
            const currentKeys: any[] = [];
            const setup = (key: any, instance: any) => {
                if (!instance) return;
                let entry = this._pipSort.get(key);
                if (!entry || entry.instance !== instance) {
                    if (entry) this._releasePipSort(entry);
                    const made = this._ensurePipSort(instance);
                    if (made) {
                        this._pipSort.set(key, made);
                        entry = made;
                    } else {
                        this._pipSort.delete(key);
                        return;
                    }
                }
                currentKeys.push(key);
                entry.mainSorter = instance.sorter;
                entry.mainOrder = instance.orderTexture;
                instance.sorter = entry.pipSorter;
                instance.material.setParameter('splatOrder', entry.pipOrder);
                instance.material.setParameter('splatTextureSize', entry.pipOrder.width);
            };
            for (const splat of splats) {
                setup(splat, (splat.entity as any)?.gsplat?.instance);
            }
            if (this.scene.groupRenderer.isActive) {
                setup(this._mergedKey, (this.scene.groupRenderer as any).mergedEntity?.gsplat?.instance);
            }
            // Prune stale entries
            for (const key of Array.from(this._pipSort.keys())) {
                if (!currentKeys.includes(key)) {
                    this._releasePipSort(this._pipSort.get(key));
                    this._pipSort.delete(key);
                }
            }

            // ---- Phase 2: PiP cull (visibility culling only) ----
            this.pipRenderPass.frameUpdate();
            try {
                (this.scene.app.renderer as any)?.culler?.executeMeshInstanceCull?.();
            } catch (e) { /* best-effort */ }

            // ---- Phase 3: WORKER-BASED DEPTH SORT (v10 — zero main-thread blocking) ----
            // For each PiP instance: compute the camera direction in the splat's
            // LOCAL space (exactly like engine GSplatInstance.sort), then
            //   a. apply a finished worker result for this entry (GL-safe moment),
            //   b. request a fresh sort from the shared Worker (skip if one is in
            //      flight). If the Worker is unavailable, fall back to the sync
            //      _cpuDepthSort (v9 behaviour).
            //
            // Cost: worker sort ~50-150ms for 1-3M splats — but OFF the main thread.
            // The structured-clone copy of centers (~12-36MB) costs a few ms per PiP
            // frame; the GL texture build happens here in onPostRender.
            const cameraNode = this.cameraEntity;
            const cameraWorldMat = cameraNode.getWorldTransform();
            const camDirWorld = new Vec3();
            cameraWorldMat.getZ(camDirWorld);   // world-space +Z (backward) of the camera

            for (const entry of this._pipSort.values()) {
                const inst = entry.instance;
                const resource = inst.resource;
                if (!resource?.centers || !resource?.streams) continue;

                const dims = resource.streams.textureDimensions;
                const numSplats = dims.x * dims.y;
                if (!numSplats) continue;

                // Transform the camera direction into the SPLAT's LOCAL space, exactly
                // like GSplatInstance.sort():
                //   invModelMat = invert(meshInstance.node.getWorldTransform())
                //   invModelMat.transformVector(cameraDirection)
                // resource.centers are in the splat's LOCAL space, so the depth key
                // MUST be computed in that same space (world-space keys are only
                // correct for identity-transform splats, never for merged entities).
                const node = inst.meshInstance?.node;
                const modelMat = node?.getWorldTransform();
                const camDirLocal = new Vec3().copy(camDirWorld);
                if (modelMat) {
                    const invModelMat = new Mat4().copy(modelMat).invert();
                    invModelMat.transformVector(camDirLocal, camDirLocal);
                }

                const key = entry;

                // (a) Apply a finished worker result (if any) — safe GL moment.
                const pending = this._pendingOrders.get(key);
                if (pending) {
                    this._pendingOrders.delete(key);
                    this._applyPipOrder(entry, pending.order, dims);
                }

                // (b) Request a fresh sort, or fall back to sync sort.
                const worker = this._ensureSortWorker();
                if (worker && !this._workerFailed) {
                    if (!this._inflightReq.has(key)) {
                        const reqId = ++this._sortReqSeq;
                        this._inflightReq.set(key, reqId);
                        try {
                        // v10.1: send centers only when the resource reference
                        // changed (edit/rebuild); otherwise just the camera
                        // direction — the Worker caches centers per key. Avoids
                        // a ~168MB copy per PiP frame on 14M-splat scenes.
                            if (!entry._workerKey) {
                                entry._workerKey = `pip${++this._workerKeySeq}`;
                            }
                            const msg: any = {
                                id: reqId,
                                key: entry._workerKey,
                                numSplats,
                                dx: camDirLocal.x,
                                dy: camDirLocal.y,
                                dz: camDirLocal.z
                            };
                            if (entry._lastCenters !== resource.centers) {
                                msg.centers = resource.centers;
                                entry._lastCenters = resource.centers;
                            }
                            worker.postMessage(msg);
                        } catch (e) {
                            this._inflightReq.delete(key);
                            this._workerFailed = true;
                        }
                    }
                } else {
                // Fallback: synchronous sort (v9 behaviour)
                    const sortedOrder = this._cpuDepthSort(numSplats, resource.centers, camDirLocal);
                    if (sortedOrder) {
                        this._applyPipOrder(entry, sortedOrder, dims);
                    }
                }
            }

            // ---- Phase 4: CLEAR cameras[] (prevent async Worker sort via update()) ----
            // GSplatInstance.update() would call sorter.sort(cameras[0]) if cameras
            // is populated. We already have our CPU-sorted order — don't let the
            // async Worker overwrite it.
            for (const splat of splats) {
                const instance = (splat.entity as any)?.gsplat?.instance;
                if (instance?.cameras) instance.cameras.length = 0;
            }
            if (this.scene.groupRenderer.isActive) {
                const mergedInst = (this.scene.groupRenderer as any).mergedEntity?.gsplat?.instance;
                if (mergedInst?.cameras) mergedInst.cameras.length = 0;
            }

            // ---- Phase 5: render PiP (reads CPU-sorted pipOrder) ----
            // SUPPRESS CROP-BOX CLIPPING for the PiP render. The PiP renders the
            // SAME shared splat material as the main view, but from a DIFFERENT
            // camera (the animation-path camera). src/splat.ts re-applies the crop
            // box uniforms every frame using the MAIN camera's view matrix — so the
            // uViewToBoxLocal baked into the material is wrong for the PiP camera.
            // Left as-is, the PiP would clip/keep splats using the main view's box
            // transform → "abnormal" PiP after enabling the crop box.
            //
            // PRESENTATION ONLY: we re-apply the crop box for the PiP render using
            // the PIP camera's view matrix, so the PiP preview shows the cropped
            // result (matching what the main view / export shows). The PiP sort
            // pipeline (pipSorter / pipOrder) is left completely untouched — only
            // the shared material's crop uniforms change, and they are restored to
            // the main-view state right after the render (and defensively in the
            // finally below).
            //
            // DEFENSIVE: The crop apply, the render, and the full shared-state
            // restore (Phase 6/7) are all wrapped in try/finally. If anything in
            // the PiP render body throws — e.g. CPU sort failure, WebGL error,
            // captureToCanvas exception on a specific model — the `finally` block
            // UNCONDITIONALLY restores splatOrder + crop-box state on the shared
            // material. This guarantees the main view cannot be left pointing at
            // the PiP's order texture or with crop-box mis-applied, which would
            // otherwise blank the model in BOTH views on the next frame (the
            // "time-line expand + add keyframe → both views go blank" regression).
            let cropModified = false;
            try {
                this._applyCropBoxForPip();
                cropModified = true;

                this.pipClearPass.render();
                this.pipRenderPass.before();
                this.pipRenderPass.execute();
                this.pipRenderPass.after();
                this.captureToCanvas();

                // Normal-path restore. The finally also covers the exception path,
                // but doing it here avoids a redundant restore on the happy path.
                this._restoreMainCropBox();
                cropModified = false;
            } finally {
            // ---- UNCONDITIONAL shared-state restoration (Phase 6 + 7) ----
            // Restore every instance to its MAIN pipeline (undoes Phase 1's
            // swap of instance.sorter / material 'splatOrder'). If the PiP
            // render threw before this, the material would otherwise keep the
            // PiP's pipOrder / pipSorter and the main view would render with
            // PiP-camera-sorted splats (or, if pipOrder is empty/invalid for
            // the main camera, blank out the model entirely).
                for (const entry of this._pipSort.values()) {
                    const inst = entry.instance;
                    inst.sorter = entry.mainSorter;
                    inst.material.setParameter('splatOrder', entry.mainOrder);
                    inst.material.setParameter('splatTextureSize', entry.mainOrder.width);
                }
                // If an exception aborted the render after apply but before the
                // happy-path restore, the crop-box uniforms on the shared material
                // are still set for the PiP camera (uViewToBoxLocal wrong for the
                // main view). Restore defensively.
                if (cropModified) {
                    this._restoreMainCropBox();
                }
                // Defensive clear cameras[] (main-view protection from async Worker sort).
                for (const splat of splats) {
                    const instance = (splat.entity as any)?.gsplat?.instance;
                    if (instance?.cameras) instance.cameras.length = 0;
                }
                if (this.scene.groupRenderer.isActive) {
                    const mergedInst = (this.scene.groupRenderer as any).mergedEntity?.gsplat?.instance;
                    if (mergedInst?.cameras) mergedInst.cameras.length = 0;
                }
            }
        // =====================================================================
        // OUTER finally — the real "near small / far big" guard.
        // The inner try/finally above only covers Phase 5 (render). If any of
        // Phase 1-4 throws (frameUpdate, culler, worker postMessage, sort
        // fallback), the swap performed in Phase 1 is NOT undone and the main
        // view is permanently left on the PiP's sorter/orderTexture. This
        // outer finally restores the main pipeline under EVERY code path.
        // Idempotent: on the happy path the inner finally already restored,
        // so the `sorter === pipSorter` check simply skips.
        // =====================================================================
        } finally {
            this._restorePipState();
            // P2: swap 窗口结束（无论成功/异常都恢复主管线后关闭标记）。
            this._pipSwapActive = false;
        }
    }

    /**
     * 强制恢复所有实例到主管线（P2 防御）：把 instance.sorter / material
     * 'splatOrder' 从 PiP 管线换回主管线，并关闭 swap 标记。幂等——主管线
     * 状态下调用是 no-op。由 scene.onPreRender 在主渲染前检测到 swap 残留时
     * 调用，防止 PiP 排序结果"入侵"主视角。
     */
    forceRestorePipState() {
        this._restorePipState();
        this._pipSwapActive = false;
    }

    /** 恢复 _pipSort 中所有实例到主管线（幂等）。 */
    private _restorePipState() {
        for (const entry of this._pipSort.values()) {
            const inst = entry.instance;
            if (!inst) continue;
            const isPipSorter = inst.sorter === entry.pipSorter;
            const isPipOrder = inst.material.getParameter('splatOrder') === entry.pipOrder;
            if (isPipSorter || isPipOrder) {
                inst.sorter = entry.mainSorter;
                inst.material.setParameter('splatOrder', entry.mainOrder);
                inst.material.setParameter('splatTextureSize', entry.mainOrder.width);
            }
        }
    }

    // ---- Private ----

    /**
     * Build (lazily, ONCE) a PiP-private depth-sort pipeline for a GSplatInstance:
     * an independent GSplatSorter (placeholder) + its own R32U order texture (pipOrder).
     *
     * SEEDING (v3.3 — engine-managed upload via `levels`): pass the identity
     * permutation as the Texture constructor's `levels` parameter. The constructor
     * immediately calls this.upload() (engine-managed GL state → no PBO / delayed-
     * upload overwrite problems), uploading our seed. This is the ONLY reliable
     * way to seed the buffer — manual gl.texImage2D and streams.createTexture both
     * fail inside the render loop (PBO state / _glCreated overwrite).
     *
     * identity seed = order[i] = i = raw storage order. Used ONLY as first-frame
     * fallback before the v10 Worker sort's first result arrives.
     *
     * The pipSorter is a PLACEHOLDER in v9/v10 — we never call sort() on it.
     * It exists only because instance.sorter must be non-null (update() uses
     * optional chaining `this.sorter?.applyPendingSorted()`, but other code may
     * assume sorter exists). The actual sorting is done by the shared v10 sort
     * Worker (or the _cpuDepthSort fallback).
     *
     * Returns null when the instance cannot support an independent pipeline
     * (WebGPU, compressed splats, resources without centers/streams).
     */
    private _ensurePipSort(instance: any): { pipSorter: any; pipOrder: any; instance: any } | null {
        const resource = instance.resource;
        if (!instance.sorter || !resource || !instance.orderTexture ||
            !resource.hasCenters || !resource.streams) {
            return null;
        }
        const device = this.scene.graphicsDevice;
        if (device.isWebGPU) return null;

        const dims = resource.streams.textureDimensions;
        const numSplats = dims.x * dims.y;
        if (!numSplats) return null;

        // Identity seed: order[i] = i (raw storage order — all visible).
        const identitySeed = new Uint32Array(numSplats);
        for (let i = 0; i < numSplats; i++) identitySeed[i] = i;

        // Create PiP order texture WITH identity seed via engine-managed upload.
        // `levels: [identitySeed]` makes the constructor upload immediately using
        // the engine's own GL state management (correct PBO handling, no overwrite).
        const pipOrder = new Texture(device, {
            name: 'splatOrderPip',
            width: dims.x,
            height: dims.y,
            format: PIXELFORMAT_R32U,
            mipmaps: false,
            minFilter: FILTER_NEAREST,
            magFilter: FILTER_NEAREST,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE,
            levels: [identitySeed]
        });

        // Independent sorter (its own Web Worker). init() hands centers/chunks to
        // the worker async. We hand COPIES so main/worker don't share state. We
        // never call pipSorter.sort(), so the worker stays idle and pipOrder is
        // never overwritten.
        const PipSorterClass = instance.sorter.constructor;
        const scene = this.scene.app.scene;
        const pipSorter = new PipSorterClass(device, scene);
        pipSorter.init(
            pipOrder,
            numSplats,
            resource.centers.slice(),
            resource.chunks ? resource.chunks.slice() : null
        );

        return { pipSorter, pipOrder, instance };
    }

    private _releasePipSort(entry: any) {
        try {
            entry?.pipSorter?.destroy?.();
        } catch (e) { /* ignore */ }
        try {
            entry?.pipOrder?.destroy?.();
        } catch (e) { /* ignore */ }
        // v10.1: release the Worker's cached centers for this entry so a huge
        // model's ~168MB copy is freed when the entry is pruned.
        if (this._sortWorker && entry?._workerKey) {
            try {
                this._sortWorker.postMessage({ release: entry._workerKey });
            } catch (e) { /* ignore */ }
        }
    }

    // ---- v10: shared depth-sort Web Worker ----

    /** Lazily create the shared sort Worker (pure math, no DOM access). */
    private _ensureSortWorker(): Worker | null {
        if (this._sortWorker) return this._sortWorker;
        if (this._workerFailed) return null;
        try {
            const src = [
                // v10.1: cache centers per entry key. Huge models (14M+ splats)
                // would otherwise pay a ~168MB structured-clone copy on EVERY
                // PiP frame; instead the main thread only re-sends centers when
                // the resource reference changes (edit/rebuild), and afterwards
                // just posts the camera direction.
                'const sortCache = new Map();',
                'self.onmessage = (e) => {',
                '  const { id, numSplats, key, centers, dx, dy, dz } = e.data;',
                '  if (e.data.release) { sortCache.delete(e.data.release); return; }',
                '  if (centers) {',
                '    sortCache.set(key, { numSplats, centers: new Float32Array(centers) });',
                '  }',
                '  const ent = sortCache.get(key);',
                '  if (!ent) return;',
                '  const order = new Uint32Array(ent.numSplats);',
                '  const keys = new Float64Array(ent.numSplats);',
                '  const c = ent.centers;',
                '  for (let i = 0; i < ent.numSplats; i++) {',
                '    const b = i * 3;',
                '    order[i] = i;',
                '    keys[i] = c[b] * dx + c[b + 1] * dy + c[b + 2] * dz;',
                '  }',
                '  order.sort((a, b) => keys[a] - keys[b]);',
                '  self.postMessage({ id, order: order.buffer }, [order.buffer]);',
                '};'
            ].join('\n');
            const blob = new Blob([src], { type: 'application/javascript' });
            const worker = new Worker(URL.createObjectURL(blob));
            worker.onmessage = ev => this._onSortResult(ev.data);
            worker.onerror = () => {
                // fall back to the synchronous path for the rest of the session
                this._workerFailed = true;
                this._terminateSortWorker();
            };
            this._sortWorker = worker;
            return worker;
        } catch (e) {
            this._workerFailed = true;
            return null;
        }
    }

    /** Worker result handler: stash the finished order for its entry. */
    private _onSortResult(data: { id: number; order: ArrayBuffer }): void {
        // find the entry whose in-flight request id matches
        let key: any = null;
        for (const [k, id] of this._inflightReq) {
            if (id === data.id) {
                key = k; break;
            }
        }
        if (key === null) return; // stale result (entry pruned / re-requested)
        this._inflightReq.delete(key);
        this._pendingOrders.set(key, { order: new Uint32Array(data.order), reqId: data.id });
    }

    /** Terminate the shared Worker and clear sort state (on destroy / failure). */
    private _terminateSortWorker(): void {
        try {
            this._sortWorker?.terminate();
        } catch (e) { /* ignore */ }
        this._sortWorker = null;
        this._inflightReq.clear();
        this._pendingOrders.clear();
    }

    /**
     * Build a NEW pipOrder texture from a back-to-front permutation and swap it
     * into the instance material. Engine-managed upload via `levels` (proven
     * reliable); the old texture is destroyed to avoid GPU memory leaks.
     */
    private _applyPipOrder(entry: any, order: Uint32Array, dims: any): void {
        const device = this.scene.graphicsDevice;
        try {
            const newPipOrder = new Texture(device, {
                name: 'splatOrderPip',
                width: dims.x,
                height: dims.y,
                format: PIXELFORMAT_R32U,
                mipmaps: false,
                minFilter: FILTER_NEAREST,
                magFilter: FILTER_NEAREST,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE,
                levels: [order]
            });
            try {
                entry.pipOrder.destroy();
            } catch (e) { /* ignore */ }
            entry.pipOrder = newPipOrder;
            entry.instance.material.setParameter('splatOrder', newPipOrder);
            entry.instance.material.setParameter('splatTextureSize', newPipOrder.width);
        } catch (e) { /* best-effort */ }
    }

    /**
     * Apply crop-box clipping to the shared splat material(s) using the PIP
     * camera's view matrix, so the PiP preview shows the cropped result
     * (matching the main view / export).
     *
     * WHY THE VIEW MATRIX MATTERS: the PiP camera and the main camera share
     * the SAME GSplatInstance material. src/splat.ts re-applies the crop-box
     * uniforms every frame using the MAIN camera's view matrix (uViewToBoxLocal
     * = invBoxWorld * invView). If we rendered the PiP with that matrix, it
     * would clip/keep splats as seen from the main view → "abnormal" PiP once
     * the crop box is active. So here we re-derive uViewToBoxLocal from the
     * PIP camera (updated in Phase 2 frameUpdate) — the crop geometry params
     * (shape / radii / height / softEdge) stay identical to the main view.
     *
     * PRESENTATION ONLY: the PiP sort pipeline (pipSorter / pipOrder) is not
     * touched — this only changes which fragments the shader discards, exactly
     * like the main view's crop. Call _restoreMainCropBox() afterwards (or the
     * finally guard) so nothing leaks back into the next main-view frame.
     */
    private _applyCropBoxForPip() {
        const cropBox = this.scene.events.invoke('cropBox') as any;
        if (!cropBox || !cropBox.enabled) return;   // no crop → main state already disables it
        const cam = this.cameraComponent;
        if (!cam) return;

        const invView = new Mat4().copy(cam.viewMatrix).invert();
        const invBoxWorld = new Mat4().copy(cropBox.pivot.getWorldTransform()).invert();
        const viewToBoxLocal = new Mat4().mul2(invBoxWorld, invView);
        const shape = cropBox.shape === 'box' ? 0 : cropBox.shape === 'cylinder' ? 1 : 2;

        const apply = (instance: any) => {
            if (!instance?.material) return;
            const mat = instance.material;
            mat.setParameter('uCropBoxEnabled', 1);
            mat.setParameter('uViewToBoxLocal', viewToBoxLocal.data);
            mat.setParameter('uCropBoxPreview', cropBox.preview ? 1 : 0);
            mat.setParameter('uCropBoxSoftEdge', cropBox.softEdge);
            mat.setParameter('uCropBoxShape', shape);
            mat.setParameter('uCropBoxRadiusX', cropBox.radiusX);
            mat.setParameter('uCropBoxRadiusY', cropBox.radiusY);
            mat.setParameter('uCropBoxRadiusZ', cropBox.radiusZ);
            mat.setParameter('uCropBoxHeight', cropBox.height);
            // mirror the cap-plane uniforms from splat.ts (0.03 width for section
            // density + 0.25 alpha for multi-section color blending — fixes the
            // "solid elliptical flake" look; native color preserved)
            mat.setParameter('uCropBoxCapWidth', 0.03);
            mat.setParameter('uCropBoxCapAlpha', 0.25);
            mat.setParameter('uCropBoxCapColor', [1, 1, 1, 1]);
        };

        const splats = this.scene.getElementsByType(ElementType.splat) as Splat[];
        for (const splat of splats) {
            apply((splat.entity as any)?.gsplat?.instance);
        }
        if (this.scene.groupRenderer.isActive) {
            apply((this.scene.groupRenderer as any).mergedEntity?.gsplat?.instance);
        }
    }

    /**
     * Restore the crop-box uniforms on the shared splat material(s) to the
     * exact MAIN-view state (mirroring src/splat.ts), after a PiP render that
     * temporarily applied the crop box with the PiP camera's view matrix.
     */
    private _restoreMainCropBox() {
        const cropBox = this.scene.events.invoke('cropBox') as any;
        const splats = this.scene.getElementsByType(ElementType.splat) as Splat[];

        const apply = (instance: any) => {
            if (!instance?.material) return;
            const mat = instance.material;
            // restore main-view state (mirror src/splat.ts ~548-556)
            if (cropBox && cropBox.enabled) {
                const cam = this.scene.camera.camera;
                const invView = new Mat4().copy(cam.viewMatrix).invert();
                const invBoxWorld = new Mat4().copy(cropBox.pivot.getWorldTransform()).invert();
                const viewToBoxLocal = new Mat4().mul2(invBoxWorld, invView);
                mat.setParameter('uCropBoxEnabled', 1);
                mat.setParameter('uViewToBoxLocal', viewToBoxLocal.data);
                mat.setParameter('uCropBoxPreview', cropBox.preview ? 1 : 0);
                mat.setParameter('uCropBoxSoftEdge', cropBox.softEdge);
                // shape + geometry uniforms (mirror splat.ts)
                mat.setParameter('uCropBoxShape', cropBox.shape === 'box' ? 0 : cropBox.shape === 'cylinder' ? 1 : 2);
                mat.setParameter('uCropBoxRadiusX', cropBox.radiusX);
                mat.setParameter('uCropBoxRadiusY', cropBox.radiusY);
                mat.setParameter('uCropBoxRadiusZ', cropBox.radiusZ);
                mat.setParameter('uCropBoxHeight', cropBox.height);
                // mirror the cap-plane uniforms from splat.ts (0.03 width + 0.25 alpha)
                mat.setParameter('uCropBoxCapWidth', 0.03);
                mat.setParameter('uCropBoxCapAlpha', 0.25);
                mat.setParameter('uCropBoxCapColor', [1, 1, 1, 1]);
            } else {
                mat.setParameter('uCropBoxEnabled', 0);
                mat.setParameter('uCropBoxPreview', 0);
                mat.setParameter('uCropBoxSoftEdge', 0.005);
                mat.setParameter('uCropBoxShape', 0);
                mat.setParameter('uCropBoxRadiusX', 0.35);
                mat.setParameter('uCropBoxRadiusY', 0.35);
                mat.setParameter('uCropBoxRadiusZ', 0.35);
                mat.setParameter('uCropBoxHeight', 0.8);
                mat.setParameter('uCropBoxCapWidth', 0);
                mat.setParameter('uCropBoxCapAlpha', 1);
                mat.setParameter('uCropBoxCapColor', [1, 1, 1, 1]);
            }
        };

        for (const splat of splats) {
            apply((splat.entity as any)?.gsplat?.instance);
        }
        if (this.scene.groupRenderer.isActive) {
            apply((this.scene.groupRenderer as any).mergedEntity?.gsplat?.instance);
        }
    }

    /**
     * Synchronous CPU depth sort for PiP Gaussian splatting.
     *
     * Computes a back-to-front permutation of all splats relative to the given
     * camera direction (already transformed into the splat's LOCAL space by the
     * caller). v10 uses this ONLY as a fallback when the shared sort Worker is
     * unavailable (worker error / WebGPU) — the main path sorts in the Worker.
     * The math here is the exact reference implementation the Worker mirrors.
     *
     * Algorithm (matches engine gsplat-sort-worker.js exactly):
     *   1. For each splat, compute depth key = dot(center, camDir)
     *      where center is in LOCAL space and camDir is the camera's local +Z
     *      (backward) axis. The dot product is shift-invariant, so subtracting
     *      the camera position is unnecessary for ORDERING.
     *   2. Sort permutation by ascending depth key.
     *      → lowest key (most negative) = farthest in front = drawn first
     *      → highest key (near 0, in front of camera) = nearest = drawn last
     *      This is the correct back-to-front (painter's) order consumed by the
     *      splat shader.
     *
     * Quality: This mirrors the engine's dot-product depth sort (not full
     * screen-space projected depth), which is exactly correct for ordering. For
     * a 320×180 preview window the result is visually identical to the main view.
     *
     * Performance: ~50-150ms for 1-3M splats (V8 quick-sort on typed arrays).
     * Synchronous — blocks the main thread (why the Worker is the default path).
     *
     * @param numSplats - Total number of gaussians
     * @param centers - Float32Array of shape [numSplats * 3] (LOCAL-space xyz positions)
     * @param camDir - Camera direction in the splat's LOCAL space (Vec3, the local +Z
     * backward axis). The permutation is ordered back-to-front along it.
     * @returns Uint32Array permutation for back-to-front rendering, or null on error
     */
    private _cpuDepthSort(
        numSplats: number,
        centers: Float32Array,
        camDir: Vec3
    ): Uint32Array | null {
        if (!numSplats || !centers || centers.length < numSplats * 3) return null;

        // Allocate working arrays
        const order = new Uint32Array(numSplats);
        const keys = new Float64Array(numSplats); // Float64 for sort stability

        // Pre-extract direction components (hot loop optimization)
        const dx = camDir.x, dy = camDir.y, dz = camDir.z;

        // Compute depth key for each splat: dot(center, camDir) in local space.
        // Ascending sort → back-to-front (far drawn first, near drawn last).
        for (let i = 0; i < numSplats; i++) {
            const base = i * 3;
            order[i] = i;
            keys[i] = centers[base] * dx +
                      centers[base + 1] * dy +
                      centers[base + 2] * dz;
        }

        // V8 optimizes TypedArray.sort well; for 1-3M elements this takes ~50-150ms
        try {
            order.sort((a, b) => keys[a] - keys[b]);
        } catch (e) {
            return null;
        }

        return order;
    }

    private updateVisibility() {
        const timelineOpen = this.scene.events.invoke('statusBar.panel') === 'timeline';
        this.enabled = timelineOpen && this.hasTrack;

        if (this.container) {
            this.container.style.display = this.enabled ? 'block' : 'none';
        }

        // Toggle camera entity and component. Both stay enabled for matrix
        // updates (lookAt, setLocalPosition, projection/view matrices).
        // Auto-rendering is prevented by framePasses = [] set in add().
        if (this.cameraEntity) {
            this.cameraEntity.enabled = this.enabled;
            if (this.enabled && !this.cameraComponent.enabled) {
                this.cameraComponent.enabled = true;
            }
        }
    }

    private updateCameraPose() {
        const { events } = this.scene;
        const controller = events.invoke('animation.controller') as AnimationController | undefined;
        const track = controller?.getTrack(TrackId.Camera);
        if (!track) return;

        const val = (track as any).getValueAt?.(this.lastFrame) as number[] | null;
        if (!val || val.length < 7) return;

        // The new animation system (camera-track.ts) stores keyframe values as
        // [position.xyz, target.xyz, fov] — 7 dimensions. We read val[3..5]
        // directly as the look-at target, NOT as azim/elev/dist.
        const pos = new Vec3(val[0], val[1], val[2]);
        const target = new Vec3(val[3], val[4], val[5]);
        const fov = val[6];

        // Compute forward direction to dynamically choose up vector and avoid gimbal lock
        const forward = new Vec3().sub2(target, pos);
        const forwardLen = forward.length();
        if (forwardLen < 0.0001) return;
        forward.mulScalar(1 / forwardLen);

        // When looking nearly straight up/down (forward ≈ Y axis), lookAt's default
        // up vector (Y) causes gimbal lock → sudden 180° flip. Use Z as up instead.
        const up = Math.abs(forward.y) > 0.99 ? new Vec3(0, 0, 1) : new Vec3(0, 1, 0);

        this.cameraEntity.setLocalPosition(pos.x, pos.y, pos.z);
        this.cameraEntity.lookAt(target.x, target.y, target.z, up.x, up.y, up.z);
        this.cameraComponent.fov = fov;
    }

    private captureToCanvas() {
        if (!this.ctx2d || !this.canvas2d) return;

        const device = this.scene.graphicsDevice;
        const w = this.WIDTH;
        const h = this.HEIGHT;

        // Access WebGL context
        const gl = (device as any).gl as WebGL2RenderingContext | WebGLRenderingContext;
        if (!gl) {
            this._drawFallback('no GL');
            return;
        }

        try {
            // Get the GL texture handle from the color buffer
            const impl = (this.colorBuffer as any).impl ?? (this.colorBuffer as any)._impl;
            const glTex = impl?._glTexture ?? impl?.glTexture ?? (this.colorBuffer as any)._glTexture;
            if (!glTex) {
                this._drawFallback('no tex');
                return;
            }

            // Create a temporary framebuffer and attach the color texture
            const fb = gl.createFramebuffer();
            if (!fb) {
                this._drawFallback('no fb');
                return;
            }

            const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
            gl.framebufferTexture2D(
                gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                gl.TEXTURE_2D, glTex, 0
            );

            const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
            if (status !== gl.FRAMEBUFFER_COMPLETE) {
                gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
                gl.deleteFramebuffer(fb);
                this._drawFallback('fb incomplete');
                return;
            }

            const pixels = new Uint8Array(w * h * 4);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

            gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
            gl.deleteFramebuffer(fb);

            // Flip Y (WebGL origin is bottom-left) and draw to 2D canvas
            const imageData = this.ctx2d.createImageData(w, h);
            const rowBytes = w * 4;
            for (let y = 0; y < h; y++) {
                const srcStart = y * rowBytes;
                const dstStart = (h - 1 - y) * rowBytes;
                imageData.data.set(pixels.subarray(srcStart, srcStart + rowBytes), dstStart);
            }
            this.ctx2d.putImageData(imageData, 0, 0);
        } catch (err: any) {
            this._drawFallback(err?.message ?? 'error');
        }
    }

    /** Draw a diagnostic pattern on the 2D canvas when capture fails */
    private _drawFallback(reason: string) {
        if (!this.ctx2d || !this.canvas2d) return;
        const ctx = this.ctx2d;
        const w = this.WIDTH, h = this.HEIGHT;
        // Dark background
        ctx.fillStyle = '#0d0d12';
        ctx.fillRect(0, 0, w, h);
        // Center text
        ctx.fillStyle = '#555';
        ctx.font = '11px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(reason, w / 2, h / 2);
    }

    private createDom() {
        // Append PiP directly to document.body so it floats above the entire app
        // with position:fixed — independent of canvas-container layout.

        // Container — fixed position for true floating behavior
        const container = document.createElement('div');
        container.className = 'camera-pip';
        container.style.cssText = `
            position: fixed;
            bottom: 16px;
            right: 16px;
            width: ${this.WIDTH + 8}px;
            background: rgba(24, 24, 28, 0.95);
            border: 1px solid #3a3a3f;
            border-radius: 6px;
            overflow: hidden;
            z-index: 9999;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.6);
            display: none;
            transition: ${this.SNAP_TRANSITION};
        `;

        // Header
        const header = document.createElement('div');
        header.className = 'camera-pip-header';
        header.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 3px 8px;
            background: #2a2a30;
            cursor: grab;
            user-select: none;
            font-size: 10px;
            color: #999;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        `;
        header.innerHTML = '<span>Camera Preview</span>';

        // Close button
        const closeBtn = document.createElement('span');
        closeBtn.textContent = '✕';
        closeBtn.style.cssText = `
            cursor: pointer;
            color: #888;
            font-size: 12px;
            padding: 0 4px;
            line-height: 1;
            pointer-events: auto;
        `;
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // Hide via settings (toggle camera poses off)
            this.scene.events.fire('camera.showPoses', false);
            this.updateVisibility();
        });
        header.appendChild(closeBtn);

        // 2D canvas for displaying the captured frame
        const canvas2d = document.createElement('canvas');
        canvas2d.className = 'camera-pip-canvas';
        canvas2d.width = this.WIDTH;
        canvas2d.height = this.HEIGHT;
        canvas2d.style.cssText = `
            display: block;
            width: ${this.WIDTH}px;
            height: ${this.HEIGHT}px;
            margin: 4px auto 6px;
            background: #111;
            border-radius: 2px;
            pointer-events: none;
        `;

        container.appendChild(header);
        container.appendChild(canvas2d);
        document.body.appendChild(container);

        this.container = container;
        this.header = header;
        this.canvas2d = canvas2d;
        this.ctx2d = canvas2d.getContext('2d');

        // ---- Dragging support (container-level) ----
        // Now drag from anywhere on the entire PiP, not just the header.
        container.addEventListener('pointerdown', (e) => {
            // Only start drag on left button and not on the close button
            if (e.button !== 0) return;
            if ((e.target as HTMLElement).closest('.camera-pip-header span:last-child')) return;

            e.preventDefault();
            e.stopPropagation();
            this.dragging = true;
            const rect = container.getBoundingClientRect();
            this.dragOffsetX = e.clientX - rect.left;
            this.dragOffsetY = e.clientY - rect.top;

            // Disable snap transition during drag for instant response
            container.style.transition = 'none';

            // Visual drag feedback
            container.style.borderColor = '#6a6a7f';
            container.style.boxShadow = '0 8px 32px rgba(0, 0, 0, 0.75)';
            (header as HTMLElement).style.cursor = 'grabbing';

            container.setPointerCapture(e.pointerId);
        });

        container.addEventListener('pointermove', (e) => {
            if (!this.dragging) return;
            e.preventDefault();
            e.stopPropagation();

            const newLeft = e.clientX - this.dragOffsetX;
            const newTop = e.clientY - this.dragOffsetY;
            const rect = container.getBoundingClientRect();
            const w = rect.width;
            const h = rect.height;

            // Boundary clamping — keep PiP within viewport
            const maxLeft = window.innerWidth - w;
            const maxTop = window.innerHeight - h;
            const clampedLeft = Math.max(0, Math.min(newLeft, maxLeft));
            const clampedTop = Math.max(0, Math.min(newTop, maxTop));

            // Use left/top positioning during drag
            container.style.right = 'auto';
            container.style.bottom = 'auto';
            container.style.left = `${clampedLeft}px`;
            container.style.top = `${clampedTop}px`;
        });

        container.addEventListener('pointerup', (e) => {
            if (!this.dragging) return;
            this.dragging = false;
            e.preventDefault();
            e.stopPropagation();

            // Restore visual state
            container.style.borderColor = '#3a3a3f';
            container.style.boxShadow = '0 4px 16px rgba(0, 0, 0, 0.6)';
            (header as HTMLElement).style.cursor = 'grab';

            // Re-enable snap transition and snap to nearest edge
            container.style.transition = this.SNAP_TRANSITION;
            this._snapToEdge(container);
        });

        // Also handle pointerup outside the container (edge case)
        container.addEventListener('pointerleave', () => {
            if (this.dragging) {
                // Don't snap on leave — just stop dragging, keep current position
                this.dragging = false;
                container.style.borderColor = '#3a3a3f';
                container.style.boxShadow = '0 4px 16px rgba(0, 0, 0, 0.6)';
                (header as HTMLElement).style.cursor = 'grab';
                container.style.transition = this.SNAP_TRANSITION;
                this._snapToEdge(container);
            }
        });
    }

    /**
     * Snap the PiP container to the nearest viewport edge if within threshold.
     */
    private _snapToEdge(container: HTMLDivElement) {
        const rect = container.getBoundingClientRect();
        const w = rect.width;
        const h = rect.height;

        const distLeft = rect.left;
        const distRight = window.innerWidth - rect.right;
        const distTop = rect.top;
        const distBottom = window.innerHeight - rect.bottom;

        const minDist = Math.min(distLeft, distRight, distTop, distBottom);

        if (minDist > this.SNAP_THRESHOLD) return;

        // Snap to nearest edge
        if (minDist === distLeft) {
            container.style.right = 'auto';
            container.style.bottom = 'auto';
            container.style.left = '0px';
            container.style.top = `${rect.top}px`;
        } else if (minDist === distRight) {
            container.style.left = 'auto';
            container.style.bottom = 'auto';
            container.style.right = '0px';
            container.style.top = `${rect.top}px`;
        } else if (minDist === distTop) {
            container.style.right = 'auto';
            container.style.bottom = 'auto';
            container.style.left = `${rect.left}px`;
            container.style.top = '0px';
        } else {
            container.style.right = 'auto';
            container.style.left = `${rect.left}px`;
            container.style.top = 'auto';
            container.style.bottom = '0px';
        }
    }
}

export { CameraPreview };
