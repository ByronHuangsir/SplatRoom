import {
    EVENT_POSTRENDER_LAYER,
    EVENT_PRERENDER_LAYER,
    LAYERID_DEPTH,
    SORTMODE_CUSTOM,
    ASPECT_MANUAL,
    BoundingBox,
    CameraComponent,
    Color,
    Entity,
    Layer,
    GraphicsDevice,
    MeshInstance,
    Mat4,
    Vec3
} from 'playcanvas';

import { Element, ElementType, ElementTypeList } from './element';
import { InfiniteGrid as Grid } from './infinite-grid';
import { Outline } from './outline';
import { SceneConfig } from './scene-config';
import { SceneState } from './scene-state';
import { Underlay } from './underlay';
import { AssetLoader } from '../app/asset-loader';
import { Camera } from '../camera/camera';
import { CameraPath3D } from '../camera/camera-path-3d';
import { CameraPathControl } from '../camera/camera-path-control';
import { CameraPreview } from '../camera/camera-preview';
import { CameraMotion } from '../core/camera-motion';
import { CommandQueue } from '../core/command-queue';
import { readDeviceFacts } from '../core/device-facts';
import { Events } from '../core/events';
import { GpuFrameTiming } from '../core/gpu-frame-timing';
import { MotionQuality } from '../core/motion-quality';
import { deviceClass, runtimePolicy, splatTier, type DeviceFacts, type RuntimePolicy } from '../core/splat-tier';
import { DataProcessor } from '../data-processor/index';
import { PCApp } from '../pc-app';
import { GroupRenderer } from '../splat/group-renderer';
import { Splat } from '../splat/splat';
import { GroupManager } from '../splat/splat-group';
import { SplatOverlay } from '../splat/splat-overlay';
import { i18n } from '../ui/localization';

// sort meshInstances by the aabb corner furthest from the camera
const corner = new Vec3();

// SplatRoom patch: scratch buffers for per-frame group-entity sort fallback.
// Mirrors engine's transform math with tightened epsilon to bypass the
// equalsApprox(1e-3) gating that drops slow rotation frames.
const _groupSortCamPos = new Vec3();
const _groupSortCamDir = new Vec3();
const _groupSortLocalPos = new Vec3();
const _groupSortLocalDir = new Vec3();
const _groupSortInvModel = new Mat4();
const _groupSortLastPos = new Vec3();
const _groupSortLastDir = new Vec3();
const specialSort = (instances: MeshInstance[], numInstances: number, cameraPos: Vec3, cameraDir: Vec3) => {
    const distances = new Map<MeshInstance, number>();

    for (let i = 0; i < numInstances; i++) {
        const instance = instances[i];
        const { aabb } = instance;
        const { center, halfExtents } = aabb;

        // loop over all 8 aabb corners and find the furthest distance along the camera view direction
        let maxDist = -Infinity;
        for (let cx = -1; cx <= 1; cx += 2) {
            for (let cy = -1; cy <= 1; cy += 2) {
                for (let cz = -1; cz <= 1; cz += 2) {
                    corner.set(
                        center.x + cx * halfExtents.x,
                        center.y + cy * halfExtents.y,
                        center.z + cz * halfExtents.z
                    );
                    // project camera-to-corner vector onto camera direction
                    const dist = (corner.x - cameraPos.x) * cameraDir.x +
                                    (corner.y - cameraPos.y) * cameraDir.y +
                                    (corner.z - cameraPos.z) * cameraDir.z;
                    if (dist > maxDist) {
                        maxDist = dist;
                    }
                }
            }
        }

        // store in map for reuse during sort
        distances.set(instance, maxDist);
    }

    // sort instances back-to-front by calculated distance (furthest first)
    instances.sort((a, b) => distances.get(b) - distances.get(a));
};

class Scene {
    events: Events;
    config: SceneConfig;
    canvas: HTMLCanvasElement;
    app: PCApp;
    worldLayer: Layer;
    splatLayer: Layer;
    overlayLayer: Layer;
    gizmoLayer: Layer;
    pathLayer: Layer;
    sceneState = [new SceneState(), new SceneState()];
    elements: Element[] = [];
    boundStorage = new BoundingBox();
    boundDirty = true;
    forceRender = false;
    forceRenderFrames = 0;

    lockedRenderMode = false;
    lockedRender = false;

    // 粒子特效激活标志：粒子是持续动画，需要每帧渲染（按需渲染架构下
    // 粒子实体不参与 state diff，必须显式强制渲染）。
    effectsActive = false;

    // eyedropper pick request
    private pickColorRequest: { x: number, y: number } | null = null;

    canvasResize: {width: number; height: number} | null = null;
    targetSize = {
        width: 0,
        height: 0
    };

    // 一次性告警标记：渲染循环异常 / 合并排序兜底相机缺失只提示一次，避免每帧刷屏。
    _warnedRenderError = false;
    _warnedGroupNoMainCam = false;

    // 相机是否正在动（指针按下 / 位姿变化 / 未超过 settle 窗口）。两个消费者：
    // GPU 每帧计时给帧打"动/静"标签，交互期降级只在 moving 时启用。见 src/core/camera-motion.ts。
    readonly cameraMotion = new CameraMotion();
    // GPU 每帧耗时（引擎 timestamp query 的异步回报，按 renderVersion 归属到帧）。
    // 默认关闭（开启会让引擎每帧 resolve 一次 timestamp + map staging buffer）；
    // 探针与自适应质量控制器按需打开。见 src/core/gpu-frame-timing.ts。
    readonly gpuFrameTiming: GpuFrameTiming;
    // 交互期降级策略（运动时降渲染分辨率，停手恢复）。见 src/core/motion-quality.ts。
    readonly motionQuality = new MotionQuality();

    /** 设备事实缓存（分级用；适配器不会中途变化） */
    private _deviceFacts: DeviceFacts | null = null;
    /** 上一次应用的分级键（`tier|device`），避免每帧重算策略 */
    private _tierPolicyKey = '';
    // 当前实际生效的渲染分辨率缩放（1 = 全分辨率），用于幂等地施加/恢复 targetSizeOverride
    private _appliedRenderScale = 1;
    // 上一帧相机是否在动，用于检测"运动 → 停手"这一次跳变（停手时要补一帧干净排序）
    private _wasMoving = false;
    // 停手补帧的武装时刻（0 = 没有欠着的补帧）；用于在补帧落地前持续出帧，并给它一个上限
    private _settleSortArmedAt = 0;
    // "手势静默后再要一帧"的一次性定时器句柄（见 onPreRenderInner 里的说明）
    private _settleFrameTimer: any = 0;

    dataProcessor: DataProcessor;
    assetLoader: AssetLoader;
    groupManager: GroupManager;
    groupRenderer: GroupRenderer;
    camera: Camera;
    cameraPath3D: CameraPath3D;
    cameraPathControl: CameraPathControl;
    cameraPreview: CameraPreview;
    splatOverlay: SplatOverlay;
    grid: Grid;
    outline: Outline;
    underlay: Underlay;

    // shared queue for serialising async splat work. exposed so subsystems that
    // need to order their async work alongside edit-history operations can do so
    // without going through edit-history directly.
    commandQueue: CommandQueue;

    contentRoot: Entity;
    cameraRoot: Entity;

    // Virtual animation camera — independent from the viewport orbit camera.
    // Driven directly by the spline via setLocalPosition + lookAt (no azim/elev
    // round-trip). Used as the data source for animation playback, PiP preview,
    // and video/image export.
    animCameraRoot: Entity;
    animCameraEntity: Entity;

    constructor(
        events: Events,
        config: SceneConfig,
        canvas: HTMLCanvasElement,
        graphicsDevice: GraphicsDevice,
        commandQueue: CommandQueue
    ) {
        this.events = events;
        this.config = config;
        this.canvas = canvas;
        this.commandQueue = commandQueue;
        this.gpuFrameTiming = new GpuFrameTiming(graphicsDevice);

        // configure the playcanvas application. we render to an offscreen buffer so require
        // only the simplest of backbuffers.
        this.app = new PCApp(canvas, { graphicsDevice });

        // only render the scene when instructed
        this.app.autoRender = false;
        // @ts-ignore
        this.app._allowResize = false;
        this.app.scene.clusteredLightingEnabled = false;

        // hack: disable lightmapper first bake until we expose option for this
        // @ts-ignore
        this.app.off('prerender', this.app._firstBake, this.app);

        // @ts-ignore
        this.app.loader.getHandler('texture').imgParser.crossOrigin = 'anonymous';

        // this is required to get full res AR mode backbuffer
        this.app.graphicsDevice.maxPixelRatio = window.devicePixelRatio;

        // configure application canvas
        const observer = new ResizeObserver((entries: ResizeObserverEntry[]) => {
            if (entries.length > 0) {
                const entry = entries[0];
                if (entry) {
                    let newW = 0, newH = 0;
                    if (entry.devicePixelContentBoxSize) {
                        // on non-safari browsers, we are given the pixel-perfect canvas size
                        newW = entry.devicePixelContentBoxSize[0].inlineSize;
                        newH = entry.devicePixelContentBoxSize[0].blockSize;
                    } else if (entry.contentBoxSize.length > 0) {
                        // on safari browsers we must calculate pixel size from CSS size ourselves
                        // and hope the browser performs the same calculation.
                        const pixelRatio = window.devicePixelRatio;
                        newW = Math.ceil(entry.contentBoxSize[0].inlineSize * pixelRatio);
                        newH = Math.ceil(entry.contentBoxSize[0].blockSize * pixelRatio);
                    }
                    if (newW > 0 && newH > 0 && (this.canvas.width !== newW || this.canvas.height !== newH)) {
                        this.canvasResize = {
                            width: newW,
                            height: newH
                        };
                    }
                }
                this.forceRender = true;
            }
        });

        observer.observe(window.document.getElementById('canvas-container'));

        // configure depth layers to handle dynamic refraction
        const depthLayer = this.app.scene.layers.getLayerById(LAYERID_DEPTH);
        this.app.scene.layers.remove(depthLayer);
        this.app.scene.layers.insertOpaque(depthLayer, 2);

        // register application callbacks
        this.app.on('update', (deltaTime: number) => this.onUpdate(deltaTime));
        this.app.on('prerender', () => this.onPreRender());
        this.app.on('postrender', () => this.onPostRender());

        // eyedropper: accept pick request from UI
        this.events.on('pickColor.request', (x: number, y: number) => {
            const dpr = this.canvas.width / this.canvas.clientWidth;
            this.pickColorRequest = {
                x: Math.floor(x * dpr),
                y: Math.floor((this.canvas.clientHeight - y) * dpr)
            };
            this.forceRender = true;
        });

        // force render on device restored
        this.app.graphicsDevice.on('devicerestored', () => {
            this.forceRender = true;
        });

        // A lost WebGL context means the GPU driver crashed (TDR) and the
        // renderer is gone — the app cannot self-recover. Tell the user instead
        // of leaving a permanently black view.
        this.app.graphicsDevice.on('contextlost', () => {
            console.error('[GPU] WebGL context lost — graphics driver crashed');
            try {
                // popups are event *functions* (Events.function), so firing the
                // event reaches no handler and shows nothing
                this.events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('doc.gpu-crashed'),
                    message: i18n.t('doc.gpu-crashed-message')
                });
            } catch { /* popup may be unavailable during teardown */ }
        });

        // fire pre and post render events on the camera
        this.app.scene.on(EVENT_PRERENDER_LAYER, (camera: CameraComponent, layer: Layer, transparent: boolean) => {
            camera.fire('preRenderLayer', layer, transparent);
        });

        this.app.scene.on(EVENT_POSTRENDER_LAYER, (camera: CameraComponent, layer: Layer, transparent: boolean) => {
            camera.fire('postRenderLayer', layer, transparent);
        });

        // get the world layer
        this.worldLayer = this.app.scene.layers.getLayerByName('World');

        // splat layer - dedicated layer for splat rendering with MRT
        this.splatLayer = new Layer({
            name: 'Splat',
            opaqueSortMode: SORTMODE_CUSTOM,
            transparentSortMode: SORTMODE_CUSTOM
        });
        this.splatLayer.customCalculateSortValues = specialSort;

        // tool overlay layer - drawn after the splats (e.g. ghost passes of the
        // measure/orient tool overlays, which show through occluding gaussians)
        this.overlayLayer = new Layer({ name: 'ToolOverlay' });

        // gizmo layer
        this.gizmoLayer = new Layer({ name: 'Gizmo' });

        // camera path layer - separate from worldLayer so PiP camera
        // (which only renders worldLayer + splatLayer) never shows the path
        this.pathLayer = new Layer({ name: 'CameraPath' });

        const layers = this.app.scene.layers;
        layers.push(this.splatLayer);
        layers.push(this.overlayLayer);
        layers.push(this.gizmoLayer);
        layers.push(this.pathLayer);

        this.dataProcessor = new DataProcessor(this.app.graphicsDevice);
        this.assetLoader = new AssetLoader(this.app, events);

        // create root entities
        this.contentRoot = new Entity('contentRoot');
        this.app.root.addChild(this.contentRoot);

        this.cameraRoot = new Entity('cameraRoot');
        this.app.root.addChild(this.cameraRoot);

        // Virtual animation camera — a completely separate Entity that the spline
        // drives directly using setLocalPosition + lookAt, bypassing the orbit
        // state machine entirely. This follows Blender's "virtual camera" pattern
        // where the animation camera and the viewport camera are independent.
        // The anim camera does NOT render — it is a pure data container whose
        // transform is consumed by PiP, video/image export, and optionally the
        // viewport in Camera View Mode.
        this.animCameraRoot = new Entity('animCameraRoot');
        this.app.root.addChild(this.animCameraRoot);

        this.animCameraEntity = new Entity('animCamera');
        this.animCameraEntity.addComponent('camera', {
            enabled: true,
            nearClip: 0.01,
            farClip: 5000,
            fov: 60
        });
        (this.animCameraEntity.camera as CameraComponent).aspectRatioMode = ASPECT_MANUAL;
        this.animCameraEntity.camera.layers = [];
        this.animCameraEntity.camera.framePasses = [];
        this.animCameraRoot.addChild(this.animCameraEntity);

        // create elements
        this.camera = new Camera();
        this.add(this.camera);

        this.cameraPath3D = new CameraPath3D();
        this.add(this.cameraPath3D);

        this.cameraPathControl = new CameraPathControl();
        this.add(this.cameraPathControl);

        events.function('camera.setPathControlEnabled', (enabled: boolean) => {
            this.cameraPathControl.setPathControlEnabled(enabled);
            const splats = this.getElementsByType(ElementType.splat) as Splat[];
            for (const s of splats) {
                s.transparency = Math.exp(enabled ? -2 : 0);
            }
        });

        this.cameraPreview = new CameraPreview();
        this.add(this.cameraPreview);

        this.splatOverlay = new SplatOverlay();
        this.add(this.splatOverlay);

        this.grid = new Grid();
        this.add(this.grid);

        this.outline = new Outline();
        this.add(this.outline);
        this.underlay = new Underlay();
        this.add(this.underlay);

        this.groupManager = new GroupManager(events);
        this.groupRenderer = new GroupRenderer(this, events);

        // Group-mode real-time transform feedback: whenever a splat in the
        // active group moves (drag gizmo / keyboard / transform panel / undo),
        // update the merged GSPlatData directly so the change is reflected in
        // the merged entity in real time — the dragged model stays INSIDE the
        // unified render, preserving its position relative to the other group
        // members (the whole point of aligning two models). To keep the drag
        // smooth, the render resolution is temporarily halved during the drag
        // (pivot.started → pivot.ended): quality loss is fine while moving,
        // since the goal is judging relative placement.
        events.on('pivot.started', () => {
            if (this.groupRenderer.isActive) {
                this.beginDragLowRes();
            }
        });

        events.on('splat.moved', (splat: Splat) => {
            if (this.groupRenderer.isActive && splat) {
                this.groupRenderer.updateSplatTransform(splat);
            }
        });

        events.on('pivot.ended', () => {
            this.endDragLowRes();
            if (this.groupRenderer.isActive) {
                // Full rebuild to ensure the merged entity is consistent
                // (build matrices, offsets, and GPU data all in sync)
                this.groupRenderer.markDirty();
            }
        });

        // 粒子特效激活/清空时切换持续渲染模式
        events.on('effects.activeChanged', (active: boolean) => {
            this.effectsActive = active;
            this.forceRender = true;
        });
    }

    // ---- 拖拽临时降分辨率（组内移动时 GPU 减负，保证统一渲染下流畅） ----

    private dragLowRes = false;
    private dragOriginalRes = { w: 0, h: 0 };

    private beginDragLowRes(): void {
        const device = this.app.graphicsDevice;
        this.dragOriginalRes = { w: device.width, h: device.height };
        const w = Math.max(1, Math.round(this.dragOriginalRes.w / 2));
        const h = Math.max(1, Math.round(this.dragOriginalRes.h / 2));
        if (this.dragOriginalRes.w !== w || this.dragOriginalRes.h !== h) {
            device.setResolution(w, h);
            this.dragLowRes = true;
        }
    }

    private endDragLowRes(): void {
        if (!this.dragLowRes) return;
        this.dragLowRes = false;
        try {
            this.app.graphicsDevice.setResolution(this.dragOriginalRes.w, this.dragOriginalRes.h);
        } catch (_) { /* best-effort */ }
    }

    start() {
        // start the app
        this.app.start();
    }

    clear() {
        const splats = this.getElementsByType(ElementType.splat);
        splats.forEach((splat) => {
            this.remove(splat);
            (splat as Splat).destroy();
        });
    }

    // add a scene element
    async add(element: Element) {
        if (!element.scene) {
            // add the new element
            element.scene = this;
            try {
                await element.add();
            } catch (error) {
                // failed initialization leaves the element half-registered:
                // unset scene so it can be retried or cleaned up instead of
                // lingering as a phantom "in-scene" element
                element.scene = null;
                throw error;
            }

            // remove() may have run while element.add() was awaiting (e.g. the
            // user deleted the splat mid-load or the scene was cleared). It sets
            // element.scene = null and fires elementRemoved, so this element must
            // NOT be pushed — otherwise it becomes an orphan: listed in
            // this.elements but absent from the scene graph, never removable.
            if (element.scene !== this) {
                return;
            }

            this.elements.push(element);

            // notify all elements of scene addition
            this.forEachElement(e => e !== element && e.onAdded(element));

            // notify listeners
            this.events.fire('scene.elementAdded', element);
        }
    }

    // remove an element from the scene
    remove(element: Element) {
        if (element.scene === this) {
            // remove from list. guard the index: if add() hasn't completed its
            // await yet the element isn't registered, and splice(-1) would
            // evict an unrelated element
            const index = this.elements.indexOf(element);
            if (index !== -1) {
                this.elements.splice(index, 1);
            }

            // notify listeners
            this.events.fire('scene.elementRemoved', element);

            // notify all elements of scene removal
            this.forEachElement(e => e.onRemoved(element));

            element.remove();
            element.scene = null;
        }
    }

    // get the scene bound
    get bound() {
        if (this.boundDirty) {
            let valid = false;
            this.forEachElement((e) => {
                const bound = e.worldBound;
                if (bound) {
                    if (!valid) {
                        valid = true;
                        this.boundStorage.copy(bound);
                    } else {
                        this.boundStorage.add(bound);
                    }
                }
            });

            this.boundDirty = false;
            this.events.fire('scene.boundChanged', this.boundStorage);
        }

        return this.boundStorage;
    }

    getElementsByType(elementType: ElementType) {
        return this.elements.filter(e => e.type === elementType);
    }

    get graphicsDevice() {
        return this.app.graphicsDevice;
    }

    private forEachElement(action: (e: Element) => void) {
        this.elements.forEach(action);
    }

    private onUpdate(deltaTime: number) {
        // Fire global update FIRST so the animation timeline advances and
        // animCameraEntity receives the current frame's position/rotation
        // BEFORE Camera.onUpdate reads it in Camera View Mode.
        // Previously, Camera.onUpdate ran first and always read the
        // PREVIOUS frame's animCameraEntity state, causing a 1-frame
        // render lag that produced visible glitches with narrow FOVs (10°).
        this.events.fire('update', deltaTime);

        // allow elements to update
        this.forEachElement(e => e.onUpdate(deltaTime));

        // fire a 'serialize' event which listers will use to store their state. we'll use
        // this to decide if the view has changed and so requires rendering.
        const i = this.app.frame % 2;
        const state = this.sceneState[i];
        state.reset();
        this.forEachElement(e => state.pack(e));

        // diff with previous state
        const result = state.compare(this.sceneState[1 - i]);

        // generate the set of all element types that changed
        const all = new Set([...result.added, ...result.removed, ...result.moved, ...result.changed]);

        // 粒子特效激活时强制每帧渲染（持续动画，不参与 state diff，
        // 否则按需渲染架构下粒子永远不更新）。
        if (this.effectsActive) {
            this.app.renderNextFrame = true;
            this.forceRender = false;
            this.forceRenderFrames = 0;
        } else if (this.lockedRenderMode) {
            this.app.renderNextFrame = this.lockedRender;
            this.lockedRender = false;
        } else if (!this.app.renderNextFrame) {
            this.app.renderNextFrame = this.forceRender || all.size > 0;
        }

        // multi-frame force render for operations that need several frames
        // to complete (e.g. group rebuild where GSplat pipeline needs
        // warm-up frames for texture uploads and sorting).
        if (this.forceRenderFrames > 0) {
            this.app.renderNextFrame = true;
            this.forceRenderFrames--;
        }
        this.forceRender = false;

        // raise per-type update events
        ElementTypeList.forEach((type) => {
            if (all.has(type)) {
                this.events.fire(`updated:${type}`);
            }
        });

        // allow elements to postupdate
        this.forEachElement(e => e.onPostUpdate());

        // V3: distance-adaptive runtime LOD switching (browsing only — gated
        // by events 'lod.allowProxy' registered by the editor).
        this.updateLodSwitching();
    }

    /**
     * V3 runtime LOD: for each splat with proxy levels, compare the camera
     * distance to the model radius and swap to the appropriate level via
     * Splat.applyLod. Only runs while the editor's 'lod.allowProxy' gate
     * reports a non-editing browsing state; forced back to full resolution
     * otherwise. Switch cooldown lives on the splat.
     */
    private updateLodSwitching() {
        const allow = this.events.invoke('lod.allowProxy') !== false;
        const cam = (this.camera as any)?.mainCamera;
        if (!cam) return;
        const camPos = cam.getPosition();
        const splats = this.getElementsByType(ElementType.splat) as Splat[];
        for (let i = 0; i < splats.length; i++) {
            const s = splats[i];
            if (!s.lodEnabled || s.lodAssets.length === 0) continue;
            if (!allow) {
                // editing context: never leave a proxy level active
                if (s.lodLevel !== -1) void s.applyLod(-1);
                continue;
            }
            if (performance.now() - s._lodLastSwitchAt < 1000) continue;
            const wb = s.worldBound;
            if (!wb) continue;
            const radius = wb.halfExtents.length();
            if (!(radius > 1e-6)) continue;
            const dx = wb.center.x - camPos.x;
            const dy = wb.center.y - camPos.y;
            const dz = wb.center.z - camPos.z;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const target = s.suggestLodLevel(dist / radius);
            if (target !== s.lodLevel) void s.applyLod(target);
        }
    }

    private onPreRender() {
        try {
            this.onPreRenderInner();
        } catch (e) {
            // 渲染循环全局防崩溃：onPreRender 内的任何异常都不允许向上抛给
            // PlayCanvas 渲染循环（否则整个 app.render() 中断，画面冻结黑屏）。
            // 记录告警并清理关键状态，让下一帧恢复。
            this.reportRenderError('prerender', e);
            this.canvasResize = null;
        }
    }

    // 交互期降级的"施加/恢复"：幂等地把渲染分辨率缩放设成给定量。
    // 用 camera.targetSizeOverride（PiP 预览用的同一机制，camera.ts 的 setTargetSizeOverride）
    // 而不是 config.camera.pixelScale —— 后者会改画布/设备分辨率并触发 resize 反馈（实测
    // 0.5/0.35 时帧时间反而涨到 242/472 ms 且画面整体变化），不能当交互旋钮用。
    // 缩放为 1 时置回 null，恢复是逐像素精确的（实测 mean|ΔRGB| = 0）。
    private applyRenderScale(scale: number) {
        if (Math.abs(scale - this._appliedRenderScale) < 1e-3) {
            return;
        }
        this._appliedRenderScale = scale;

        const cam = this.camera;
        if (scale >= 1) {
            cam.targetSizeOverride = null;
        } else {
            cam.targetSizeOverride = {
                width: Math.max(1, Math.round(this.targetSize.width * scale)),
                height: Math.max(1, Math.round(this.targetSize.height * scale))
            };
        }
        cam.rebuildRenderTargets();
    }

    // 场景里的高斯点总数（没有 timestamp query 时，降级只能按模型规模判断，见 MotionQuality）
    private splatCount() {
        let total = 0;
        const elements = this.getElementsByType(ElementType.splat) as Splat[];
        for (let i = 0; i < elements.length; i++) {
            total += elements[i].numSplats ?? 0;
        }
        return total;
    }

    /**
     * 分级策略接线（2026-09-22）：模型规模档位或设备档位一变，就按 `runtimePolicy()` 重设
     * 交互期降级的阶梯与门槛。设备事实只读一次（适配器不会中途变），档位用"键"比较避免每帧重算。
     */
    private applyTierPolicy() {
        const info = this.tierPolicy();
        const key = `${info.tier}|${info.device}`;
        if (key === this._tierPolicyKey) {
            return;
        }
        this._tierPolicyKey = key;
        this.motionQuality.applyPolicy(info.policy);
        this.events.fire('tier.policyChanged', info);
    }

    /**
     * 当前分级（模型规模档位 × 设备档位）与对应策略。
     * 既能给 UI 显示，也能给探针/套件断言（`scene.events.invoke('tier.policy')`）。
     *
     * @returns 点数、模型档位、设备档位与完整运行时策略
     */
    tierPolicy(): { numSplats: number; tier: string; device: string; policy: RuntimePolicy } {
        // 设备事实缓存：只有"强制档位"这个开关变化时才重读（真机上适配器不会变）
        const forced = (globalThis as any).__SPLATROOM_DEVICE_CLASS__ ?? null;
        if (!this._deviceFacts || this._deviceFacts.forcedClass !== forced) {
            this._deviceFacts = readDeviceFacts(this.app.graphicsDevice);
        }
        const numSplats = this.splatCount();
        return {
            numSplats,
            tier: splatTier(numSplats),
            device: deviceClass(this._deviceFacts),
            policy: runtimePolicy(numSplats, this._deviceFacts)
        };
    }

    private onPreRenderInner() {
        // P2 主渲染前校验：PiP 的 sorter/orderTexture swap 只在 onPostRender 的
        // try/finally 窗口内存在，正常时主渲染永远看不到 PiP 状态。若上一帧
        // finally 未执行（异常逃逸/竞态），这里会在主渲染前发现残留并强制恢复，
        // 防止主视角用 PiP 相机排序结果渲染（"PiP 入侵主视角"）。
        if (this.cameraPreview?.pipSwapActive) {
            console.error('[Scene.onPreRender] 检测到 PiP sorter swap 残留（上一帧未恢复），强制恢复主管线，防止 PiP 入侵主视角！');
            this.cameraPreview.forceRestorePipState();
        }

        // IMPORTANT: do NOT set canvas.width/height directly. The browser
        // automatically resizes the WebGL framebuffer on canvas.width writes,
        // but PlayCanvas's `graphicsDevice.width/height` and render-target
        // caches are NOT updated to match. The next splat/material draw then
        // uses a stale viewport, producing "near small / far big" / FOV
        // distortion / blank regions in the rendered output. Resizing the
        // bottom time-line panel triggers a ResizeObserver on the contentRoot
        // → canvasResize set → next prerender fires this branch → the canvas
        // gets resized → graphicsDevice diverges from canvas. Always go
        // through PlayCanvas's `graphicsDevice.setResolution()` which updates
        // BOTH the canvas and the device atomically and fires 'resizecanvas'
        // so every subsystem (splat layer, group renderer, targetSize,
        // projection matrices) re-syncs.
        if (this.canvasResize) {
            this.app.graphicsDevice.setResolution(this.canvasResize.width, this.canvasResize.height);
            this.canvasResize = null;
        }

        // sync group renderer (may create/destroy merged entity)
        this.groupRenderer.sync();

        // 合并渲染兜底：与 src/splat.ts onPreRender 的主视图排序兜底一致。
        // 引擎排序链路依赖 culler 每帧把主相机 push 进 instance.cameras[]，
        // 但大模型/特定场景下 cameras 可能不填充 → update() 的 sort() 分支
        // 不执行 → worker 排序冻结在初始相机 → 相机移动后"近小远大"。
        // 这里每帧用主相机强制排序合并实体（instance.sort 内部有 equalsApprox
        // 节流 + sorter 有 _sortInFlight coalesce 补丁，相机不动时廉价）。
        if (this.groupRenderer.isActive) {
            const mergedInst = (this.groupRenderer as any).mergedEntity?.gsplat?.instance;
            const mainCamNode = (this.camera as any)?.mainCamera as any;
            if (!mainCamNode) {
                // 主相机引用缺失：合并实体排序兜底无法取相机姿态 → worker 排序
                // 冻结在初始相机（"近小远大"）。异常状态，一次性告警暴露。
                if (!this._warnedGroupNoMainCam) {
                    this._warnedGroupNoMainCam = true;
                    console.warn('[Scene.onPreRender] mainCamNode 缺失：合并实体排序兜底被跳过，相机移动时深度排序可能冻结（近小远大）。camera.mainCamera 未就绪？');
                }
            }
            if (mergedInst?.sorter && mainCamNode) {
                // Per-frame sort with tightened epsilon (same rationale as
                // splat.ts onPreRender). Engine's 1e-3 epsilon drops slow
                // rotation frames; we mirror the math with 1e-6 epsilon so
                // every frame dispatches a fresh sort request.
                const camWorld = mainCamNode.getWorldTransform();
                camWorld.getTranslation(_groupSortCamPos);
                camWorld.getZ(_groupSortCamDir);
                const modelWorld = mergedInst.meshInstance.node.getWorldTransform();
                _groupSortInvModel.copy(modelWorld).invert();
                _groupSortInvModel.transformPoint(_groupSortCamPos, _groupSortLocalPos);
                _groupSortInvModel.transformVector(_groupSortCamDir, _groupSortLocalDir);
                const dx = _groupSortLocalPos.x - _groupSortLastPos.x;
                const dy = _groupSortLocalPos.y - _groupSortLastPos.y;
                const dz = _groupSortLocalPos.z - _groupSortLastPos.z;
                const ddx = _groupSortLocalDir.x - _groupSortLastDir.x;
                const ddy = _groupSortLocalDir.y - _groupSortLastDir.y;
                const ddz = _groupSortLocalDir.z - _groupSortLastDir.z;
                if (dx * dx + dy * dy + dz * dz > 1e-12 ||
                    ddx * ddx + ddy * ddy + ddz * ddz > 1e-12) {
                    _groupSortLastPos.copy(_groupSortLocalPos);
                    _groupSortLastDir.copy(_groupSortLocalDir);
                    // Direct worker dispatch (same rationale as splat.ts:
                    // engine sorter.setCamera doesn't accept forceUpdate, and
                    // worker epsilon 1e-3 short-circuits our 1e-6 detections).
                    try {
                        const ws = mergedInst.sorter;
                        if (ws._sortInFlight) {
                            ws._pendingCamera = {
                                pos: { x: _groupSortLocalPos.x, y: _groupSortLocalPos.y, z: _groupSortLocalPos.z },
                                dir: { x: _groupSortLocalDir.x, y: _groupSortLocalDir.y, z: _groupSortLocalDir.z }
                            };
                        } else {
                            ws._sortInFlight = true;
                            ws.worker.postMessage({
                                cameraPosition: { x: _groupSortLocalPos.x, y: _groupSortLocalPos.y, z: _groupSortLocalPos.z },
                                cameraDirection: { x: _groupSortLocalDir.x, y: _groupSortLocalDir.y, z: _groupSortLocalDir.z },
                                forceUpdate: true
                            });
                        }
                    } catch (e) { /* best-effort */ }
                }
            }
        }

        // update render target size
        this.targetSize.width = Math.ceil(this.app.graphicsDevice.width / this.config.camera.pixelScale);
        this.targetSize.height = Math.ceil(this.app.graphicsDevice.height / this.config.camera.pixelScale);

        // 相机运动状态（本帧位姿对比 + 指针按下），必须在元素渲染之前更新：
        // 交互期降级（motion-quality）与 GPU 计时的帧标签都读它。
        this.cameraMotion.update(
            this.camera.position,
            this.camera.forward,
            !!this.camera.userDragging,
            performance.now()
        );

        // ---- "停手"这一帧必须真的到来（2026-09-21 第六轮）------------------------------------
        // 本应用按需渲染，而"相机停了"只能由**下一帧**观察到（cameraMotion.moving 是时间戳判定）。
        // 用户松手后不再有指针事件 ⇒ 没有自然帧 ⇒ `_wasMoving && !moving` 那段永远不执行：
        // 既不补"停手后的干净排序"，也没有帧去消费已完成排序的结果。
        // 大模型上这条被"降级期间一直出帧到恢复"掩盖了，不降级（小模型/快机器）时才暴露：
        // 实测 2000 点夹具在 2.2 s 快转结束后 1.2 s 内 `worker.postMessage` = **0** 次。
        // 这里给手势挂一个一次性定时器：落在静默点之后要一帧；若那一帧发现还在动，就再挂一次
        // （程序化旋转期间 ≈4 fps 的兜底帧，代价可忽略；真拖拽本来每帧都有指针事件）。
        if (this.cameraMotion.moving) {
            if (this._settleFrameTimer === 0) {
                this._settleFrameTimer = setTimeout(() => {
                    this._settleFrameTimer = 0;
                    this.forceRender = true;
                }, 260);
            }
        } else if (this._settleFrameTimer !== 0) {
            clearTimeout(this._settleFrameTimer);
            this._settleFrameTimer = 0;
        }

        // 交互期降级：需要 GPU 每帧耗时来判断"值不值得降"，所以策略开着时就把 profiler 打开。
        // 实测代价可忽略（20M 上开/关的帧 p50 都是 ~69.6ms）；排障可整体关掉：
        //   window.__SPLATROOM_MOTION_QUALITY__ = false
        const qualityEnabled = (globalThis as any).__SPLATROOM_MOTION_QUALITY__ !== false;
        this.motionQuality.enabled = qualityEnabled;
        if (qualityEnabled && !this.gpuFrameTiming.enabled) {
            this.gpuFrameTiming.setEnabled(true);
        } else if (!qualityEnabled && this.gpuFrameTiming.enabled) {
            this.gpuFrameTiming.setEnabled(false);
        }

        this.gpuFrameTiming.noteFrame(this.cameraMotion.moving);

        // 分级策略：模型规模/设备档位变了才重设阶梯与门槛（见 src/core/splat-tier.ts）
        this.applyTierPolicy();

        const qualityChanged = this.motionQuality.update(
            this.cameraMotion.moving,
            this.splatCount(),
            this.gpuFrameTiming.supported,
            // 用"最近若干静止帧的峰值"而不是最后一帧：本应用按需渲染，空闲时可能只出几帧空转帧
            // （实测 0.075 ms），拿最后一帧当依据会在用户一停手就解除武装
            this.gpuFrameTiming.settledSpanPeak,
            this.gpuFrameTiming.lastMovingGpuMs,
            performance.now()
        );
        if (qualityChanged) {
            this.applyRenderScale(this.motionQuality.renderScale);
        }

        // 停手后的收尾：给每个 splat 补一帧"干净排序"，让静止画面用的是最终位姿的顺序。
        // 为什么要显式做：`_sortSettleAt` 那套启发式只在"被闸门挡下的帧"里才会武装，
        // 实测存在"整段手势结束却没有补帧"的情况（`verify-motion-quality.cjs` 抓到的就是它）。
        if (this._wasMoving && !this.cameraMotion.moving) {
            const splats = this.getElementsByType(ElementType.splat) as Splat[];
            for (let i = 0; i < splats.length; i++) {
                if (splats[i].visible) {
                    splats[i].forceSettleSort();
                }
            }
            this._settleSortArmedAt = performance.now();
        }
        this._wasMoving = this.cameraMotion.moving;

        // 补帧欠着的时候必须继续出帧：本应用按需渲染，而"停手"那一刻正好是它想停的时候，
        // 不强制的话那一帧永远不会到来（实测：武装了 deadline 却 0 次派发）。
        // 加一个上限，避免 sorter 异常时无限出帧。
        let settleSortPending = false;
        if (this._settleSortArmedAt !== 0) {
            const splats = this.getElementsByType(ElementType.splat) as Splat[];
            for (let i = 0; i < splats.length; i++) {
                if (splats[i].visible && splats[i].sortSettlePending) {
                    settleSortPending = true;
                    break;
                }
            }
            if (!settleSortPending || performance.now() - this._settleSortArmedAt > 1500) {
                this._settleSortArmedAt = 0;
                settleSortPending = false;
            }
        }

        // 降级期间保持渲染，直到"恢复全分辨率"那一帧真正发生：本应用是按需渲染的，
        // 相机停手后不再有自然帧，若就此停住，画面会一直停在低分辨率（实测：不加这一条时
        // verify-motion-quality 的"停手恢复"一项失败，override 一直挂在 896x537）。
        // 恢复施加完（engaged=false 且缩放回到 1）就不再强制渲染，不会白烧电。
        //
        // 2026-09-21 第六轮补上"排序在飞也要出帧"：排序结果是**异步**回来的，本应用按需渲染，
        // 若最后一次派发之后不再出帧，那份排序永远不会被 applyPendingSorted 消费
        // （小模型上实测：停手后 0 次派发、顺序停在旧值）。在飞标记有 3 s 超时兜底，不会无限出帧。
        let sortInFlight = false;
        {
            const splats = this.getElementsByType(ElementType.splat) as Splat[];
            for (let i = 0; i < splats.length; i++) {
                if (splats[i].visible && splats[i].sortInFlight) {
                    sortInFlight = true;
                    break;
                }
            }
        }
        if (settleSortPending || sortInFlight || this.motionQuality.engaged || this._appliedRenderScale !== 1) {
            this.forceRender = true;
        }

        this.forEachElement(e => e.onPreRender());

        this.events.fire('prerender', this.camera.displayTransform);

        // debug - display scene bound
        if (this.config.debug.showBound) {
            // when a group is active, show unified group bound instead of per-splat
            if (this.groupRenderer.isActive) {
                const gb = this.groupRenderer.worldBound;
                if (gb) {
                    this.app.drawWireAlignedBox(
                        gb.getMin(), gb.getMax(),
                        Color.YELLOW
                    );
                }
            } else {
                // draw element bounds
                this.forEachElement((e: Element) => {
                    if (e.type === ElementType.splat) {
                        const splat = e as Splat;

                        const local = splat.localBound;
                        this.app.drawWireAlignedBox(
                            local.getMin(),
                            local.getMax(),
                            Color.RED,
                            true,
                            undefined,
                            splat.entity.getWorldTransform());

                        const world = splat.worldBound;
                        this.app.drawWireAlignedBox(
                            world.getMin(),
                            world.getMax(),
                            Color.GREEN);
                    }
                });
            }

            // draw scene bound
            this.app.drawWireAlignedBox(this.bound.getMin(), this.bound.getMax(), Color.BLUE);
        }
    }

    private onPostRender() {
        try {
            this.onPostRenderInner();
        } catch (e) {
            // 渲染循环全局防崩溃：同 onPreRender，异常不向上抛，避免渲染中断。
            this.reportRenderError('postrender', e);
        }
    }

    private onPostRenderInner() {
        this.forEachElement(e => e.onPostRender());

        // handle eyedropper pick request
        if (this.pickColorRequest) {
            const device = this.app.graphicsDevice;
            const gl = (device as any).gl as WebGL2RenderingContext;
            const pixels = new Uint8Array(4);
            gl.readPixels(
                this.pickColorRequest.x,
                this.pickColorRequest.y,
                1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels
            );
            this.events.fire('pickColor.result', {
                r: pixels[0] / 255,
                g: pixels[1] / 255,
                b: pixels[2] / 255
            });
            this.pickColorRequest = null;
        }

        this.events.fire('postrender');
    }

    // 渲染循环异常告警：节流输出（同一阶段 5 秒内最多打印一次），避免
    // 异常持续发生时每帧刷屏拖垮控制台。
    private _lastRenderErrorTime: Record<string, number> = {};
    private reportRenderError(phase: 'prerender' | 'postrender', e: unknown) {
        const now = Date.now();
        const last = this._lastRenderErrorTime[phase] ?? 0;
        if (now - last < 5000) {
            return;
        }
        this._lastRenderErrorTime[phase] = now;
        const detail = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
        console.error(`[Scene.on${phase === 'prerender' ? 'Pre' : 'Post'}Render] 渲染循环异常（已捕获防止崩溃，5s 内不再重复）:\n${detail}`);
    }
}

export { SceneConfig, Scene };
