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

import { AssetLoader } from './asset-loader';
import { Camera } from './camera';
import { CameraPath3D } from './camera-path-3d';
import { CameraPathControl } from './camera-path-control';
import { CameraPreview } from './camera-preview';
import { CommandQueue } from './command-queue';
import { DataProcessor } from './data-processor';
import { Element, ElementType, ElementTypeList } from './element';
import { Events } from './events';
import { InfiniteGrid as Grid } from './infinite-grid';
import { Outline } from './outline';
import { PCApp } from './pc-app';
import { SceneConfig } from './scene-config';
import { SceneState } from './scene-state';
import { Splat } from './splat';
import { GroupManager } from './splat-group';
import { GroupRenderer } from './group-renderer';
import { SplatOverlay } from './splat-overlay';
import { Underlay } from './underlay';

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

    // eyedropper pick request
    private pickColorRequest: { x: number, y: number } | null = null;

    canvasResize: {width: number; height: number} | null = null;
    targetSize = {
        width: 0,
        height: 0
    };

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

        // Group-mode real-time transform feedback: during a pivot drag on a
        // splat in the active group, update the merged GSPlatData directly so
        // the dragged splat's new position is reflected in the merged entity
        // in real time. All splats keep per-gaussian depth sorting throughout.
        events.on('pivot.moved', () => {
            if (this.groupRenderer.isActive) {
                const splat = events.invoke('selection') as Splat;
                if (splat) {
                    this.groupRenderer.updateSplatTransform(splat);
                }
            }
        });

        events.on('pivot.ended', () => {
            if (this.groupRenderer.isActive) {
                // Full rebuild to ensure the merged entity is consistent
                // (build matrices, offsets, and GPU data all in sync)
                this.groupRenderer.markDirty();
            }
        });
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
            await element.add();
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

        // compare with previously serialized
        if (this.lockedRenderMode) {
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
    }

    private onPreRender() {
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
}

export { SceneConfig, Scene };
