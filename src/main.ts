import { WebPCodec, WorkerQueue } from '@playcanvas/splat-transform';
import { Color, createGraphicsDevice } from 'playcanvas';

import { registerAnimationControllerEvents } from './animation/animation-controller';
import { registerDocEvents } from './app/doc';
import { registerEditorEvents, registerCropBoxEvents, registerSurfaceRefineEvents } from './app/editor';
import { initFileHandler } from './app/file-handler';
import { registerPublishEvents } from './app/publish';
import { registerRenderEvents } from './app/render';
import { registerAudioEvents } from './audio/audio-manager';
import { registerCameraPosesEvents } from './camera/camera-poses';
import { MouseBindings } from './camera/mouse-bindings';
import { startCompareApp } from './compare/compare-app';
import { CommandQueue } from './core/command-queue';
import { EditHistory } from './core/edit-history';
import { Events } from './core/events';
import { getGpuBackendPref, webgpuTranspilerUrls } from './core/gpu-backend';
import { registerPreferences } from './core/preferences';
import { registerSelectionEvents } from './core/selection';
import { registerSelectionFlags } from './core/selection-flags';
import { ShortcutManager } from './core/shortcut-manager';
import { registerEffectsEvents } from './effects/effects-manager';
import { GamepadCapture } from './gamepad/gamepad-capture';
import { GamepadController } from './gamepad/gamepad-controller';
import { registerIframeApi } from './iframe-api';
import { registerLodEvents } from './lod/editor-lod';
import { startMergeApp } from './merge/merge-app';
import { Scene } from './scene/scene';
import { getSceneConfig } from './scene/scene-config';
import { startSplatFactoryApp } from './splatfactory/splatfactory-app';
import { registerSequenceEvents } from './timeline/sequence';
import { registerTimelineEvents } from './timeline/timeline';
import { registerTrackManagerEvents } from './timeline/track-manager';
import { registerToolModules } from './tool-modules';
import { BoxSelection } from './tools/box-selection';
import { BrushSelection } from './tools/brush-selection';
import { CropTool } from './tools/crop-tool';
import { EyedropperSelection } from './tools/eyedropper-selection';
import { FloodSelection } from './tools/flood-selection';
import { GroundWaterTool } from './tools/ground-water-tool';
import { HealTool } from './tools/heal-tool';
import { LassoSelection } from './tools/lasso-selection';
import { MeasureTool } from './tools/measure-tool';
import { MoveTool } from './tools/move-tool';
import { OrientTool } from './tools/orient-tool';
import { PolygonSelection } from './tools/polygon-selection';
import { RectSelection } from './tools/rect-selection';
import { RotateTool } from './tools/rotate-tool';
import { ScaleTool } from './tools/scale-tool';
import { SphereBrushSelection } from './tools/sphere-brush';
import { SphereSelection } from './tools/sphere-selection';
import { ToolManager } from './tools/tool-manager';
import { registerTransformHandlerEvents } from './transform/transform-handler';
import { BoundDimensionsOverlay } from './ui/bound-dimensions-overlay';
import { EditorUI } from './ui/editor';
import { GamepadMenu } from './ui/gamepad-menu';
import { GamepadSettings } from './ui/gamepad-settings';
import { HealPanel } from './ui/heal-panel';
import { i18n } from './ui/localization';
import { registerSelectCursor } from './ui/select-cursor';
import { SelectionDepthBar } from './ui/selection-depth-bar';
import { registerSnapshotEvents } from './ui/snapshot-handler';

declare global {
    interface LaunchParams {
        readonly files: FileSystemFileHandle[];
    }

    interface Window {
        launchQueue: {
            setConsumer: (callback: (launchParams: LaunchParams) => void) => void;
        };
        scene: Scene;
        /** Native Electron file-system bridge (electron-preload.js). */
        splatroomFS?: {
            pickDirectory: () => Promise<string | null>;
            writeFile: (dirPath: string, filename: string, data: Uint8Array) => Promise<string>;
        };
    }
}

const getURLArgs = () => {
    // extract settings from command line in non-prod builds only
    const config = {};

    const apply = (key: string, value: string) => {
        let obj: any = config;
        key.split('.').forEach((k, i, a) => {
            if (i === a.length - 1) {
                obj[k] = value;
            } else {
                if (!obj.hasOwnProperty(k)) {
                    obj[k] = {};
                }
                obj = obj[k];
            }
        });
    };

    const params = new URLSearchParams(window.location.search.slice(1));
    params.forEach((value: string, key: string) => {
        apply(key, value);
    });

    return config;
};

const main = async () => {
    // root events object
    const events = new Events();

    // selection depth range (选区深度: 最近 / 最远) flags: registered up front because
    // the depth bar reads them while it is being constructed
    registerSelectionFlags(events);

    // tool modules (src/tool-modules) — register module events (compare.open, …)
    registerToolModules(events);

    // plugin: the comparison tool runs as its own window when ?mode=compare
    if (new URLSearchParams(window.location.search).get('mode') === 'compare') {
        await startCompareApp();
        return;
    }

    // plugin: the format factory runs as its own window when ?mode=splatfactory
    if (new URLSearchParams(window.location.search).get('mode') === 'splatfactory') {
        await startSplatFactoryApp();
        return;
    }

    // plugin: the merge tool runs as its own window when ?mode=merge
    if (new URLSearchParams(window.location.search).get('mode') === 'merge') {
        await startMergeApp();
        return;
    }

    // url
    const url = new URL(window.location.href);

    // shared command queue for all async splat work (GPU readbacks + history mutations).
    // every consumer that needs ordering relative to other commands enqueues here.
    const commandQueue = new CommandQueue();

    // edit history (uses the shared queue internally)
    const editHistory = new EditHistory(events, commandQueue);

    // expose the queue as an event for any module that needs to serialise async work
    // alongside history mutations.
    events.function('queue', (fn: () => Promise<void> | void) => commandQueue.enqueue(fn));

    // init localization
    await i18n.init();

    // Configure WebP WASM for SOG format (used for both reading and writing)
    WebPCodec.wasmUrl = new URL('static/lib/webp/webp.wasm', document.baseURI).toString();

    // Run SOG writing inline rather than in worker threads. We don't ship
    // splat-transform's worker.mjs, so leaving the pool enabled makes it try to
    // spawn a worker that 404s; under SOG's parallel task load it then hangs
    // instead of falling back, producing an empty export.
    WorkerQueue.maxWorkers = 0;

    // register events that only need the events object (before UI is created)
    registerTimelineEvents(events);
    registerAnimationControllerEvents(events);
    registerCameraPosesEvents(events);
    registerTrackManagerEvents(events);
    registerTransformHandlerEvents(events);
    registerPublishEvents(events);
    registerIframeApi(events);

    // scene late-binding for crop-box (registered before UI construction)
    let scene: Scene | null = null;
    const getScene = () => scene;
    registerCropBoxEvents(events, getScene);
    registerSurfaceRefineEvents(events, editHistory, getScene);
    registerLodEvents(events, editHistory, getScene);

    // 分级策略查询（模型规模 × 设备档位；见 src/core/splat-tier.ts）。
    // 给 UI 显示与探针/套件断言用；策略变化时 scene 会 fire('tier.policyChanged', …)。
    events.function('tier.policy', () => getScene()?.tierPolicy() ?? null);
    registerSnapshotEvents(events, () => editorUI.canvas, () => document.getElementById('right-toolbar-snapshot'),
        () => {
            const s = getScene(); if (s) s.forceRender = true;
        });

    // initialize shortcuts
    const shortcutManager = new ShortcutManager(events);
    events.function('shortcutManager', () => shortcutManager);

    // customizable mouse-button → camera-action mapping
    // eslint-disable-next-line no-new -- 实例化即注册事件绑定，生命周期与 app 一致
    new MouseBindings(events);

    // editor ui
    const editorUI = new EditorUI(events);

    // Graphics backend: WebGL2 or WebGPU. Both render splats (the WebGPU path uses WGSL
    // twins of the custom splat/overlay shaders — see src/shaders/splat-shader-wgsl.ts),
    // so the stored preference is honoured. Precedence:
    //   1. URL override (?gpu=webgpu / ?gpu=webgl2) — used by the verification harnesses
    //   2. persisted preference (settings panel)
    //   3. default WebGPU (since 3.23.58 — unified 通路转默认的前提；不支持时回落 WebGL2)
    // The device is created with ['webgpu', 'webgl2'] when WebGPU is requested, so a
    // browser without WebGPU still starts on WebGL2 instead of failing.
    const urlArgs = getURLArgs();
    const gpuOverride = (urlArgs as any)?.gpu;

    // unified（引擎 GPU 同帧排序）通路开关：**在这里就把 URL 参数归一化到全局**。
    //
    // 为什么必须归一化：这个开关原先被两处各自读一次 —— `splat.ts` 的 bindAsset 直接读
    // `location.search`，`scene.ts` 的材质钩子读 `__SPLATROOM_UNIFIED__`。
    // 两处判定来源不同、时机也不同（Scene 在页面加载早期就构造完），结果是
    // "URL 开关到底生效了没有"取决于谁先读到 —— 实测就是这么踩到的
    // （钩子一次都不跑、句柄永远拿不到；见 docs/待办-引擎WebGPU-compute.md §4c）。
    // 归一化之后下游只认这一个全局，探针也可以在场景构造**之前**直接设。
    //
    // 3.23.58 起**默认开启**（M1-3：旋转排序错序的结构性根治，功能面六轮迁移已齐）：
    //   `?unified=1` → 强制开（对照实验用，含 WebGL2 上的老行为）；
    //   `?unified=0` → 强制关（逃生门，回主线 per-instance + worker CPU 排序）；
    //   无参数      → 开，但**仅当设备真是 WebGPU 时生效**（设备创建后那段会把它关掉）。
    const unifiedParam = (urlArgs as any)?.unified;
    const unifiedForced: boolean | undefined =
        unifiedParam === '1' ? true : unifiedParam === '0' ? false : undefined;
    if (unifiedForced !== false) {
        (globalThis as any).__SPLATROOM_UNIFIED__ = true;
    }

    const gpuBackend = (gpuOverride === 'webgpu' || gpuOverride === 'webgl2') ?
        gpuOverride :
        (getGpuBackendPref() ?? 'webgpu');

    // create the graphics device
    const graphicsDevice = await createGraphicsDevice(editorUI.canvas, {
        deviceTypes: gpuBackend === 'webgpu' ? ['webgpu', 'webgl2'] : ['webgl2'],
        antialias: false,
        depth: false,
        stencil: false,
        xrCompatible: false,
        powerPreference: 'high-performance',
        // WebGPU needs the GLSL→WGSL transpilers: every custom pass in this
        // project is GLSL, and without them each one fails to compile. Ignored by
        // the WebGL2 device.
        ...(gpuBackend === 'webgpu' ? webgpuTranspilerUrls() : {})
    });

    // unified 只在 WebGPU 设备上成立（引擎 GPU 排序走 compute shader）。
    // 默认开启时设备若不是 WebGPU —— 机器不支持 WebGPU、或用户在设置里选了 WebGL2 ——
    // 就静默回落主线（行为与旧版一致）；只有 `?unified=1` 显式强开才保留 WebGL2 上的老行为。
    if (!graphicsDevice.isWebGPU && unifiedForced !== true) {
        (globalThis as any).__SPLATROOM_UNIFIED__ = false;
    }

    // 非默认状态必须**一眼能看出来**：转默认之后，"开着 unified"不再值得标记（那是正常路径），
    // 要标记的是两种对照/逃生状态 —— 显式 `?unified=1` 强开（蓝）、`?unified=0` 逃生（琥珀）。
    // 光看画面分不出自己在哪条路上，而"以为开了其实没开"会让排查完全跑偏（实测吃过这个亏）。
    const badgeSpec = unifiedForced === true ?
        { text: 'unified 通路（引擎 GPU 排序）', bg: 'rgba(30,120,220,0.85)' } :
        unifiedForced === false ?
            { text: '主线通路（CPU 排序 · ?unified=0）', bg: 'rgba(200,130,30,0.9)' } :
            null;
    if (badgeSpec) {
        const badge = document.createElement('div');
        badge.id = 'splatroom-unified-badge';
        badge.textContent = badgeSpec.text;
        badge.style.cssText = [
            'position:fixed', 'left:8px', 'bottom:8px', 'z-index:99999',
            'padding:4px 8px', 'border-radius:4px',
            `background:${badgeSpec.bg}`, 'color:#fff',
            'font:12px/1.4 system-ui,sans-serif', 'pointer-events:none',
            'user-select:none'
        ].join(';');
        const attach = () => document.body && document.body.appendChild(badge);
        if (document.body) {
            attach();
        } else {
            document.addEventListener('DOMContentLoaded', attach, { once: true });
        }
    }

    const overrides = [
        urlArgs
    ];

    // resolve scene config
    const sceneConfig = getSceneConfig(overrides);

    // construct the manager
    scene = new Scene(
        events,
        sceneConfig,
        editorUI.canvas,
        graphicsDevice,
        commandQueue
    );

    // 广播实际生效的后端（状态栏的 WebGL2 排序滞后提示等按它显隐）。
    // 注意要发"实际设备"而不是"请求值"：请求 webgpu 但机器不支持时会回落 webgl2。
    events.fire('backend.ready', graphicsDevice.isWebGPU ? 'webgpu' : 'webgl2');

    // tell the user when the request fell back to WebGL2 (a browser or machine without
    // WebGPU support), once the UI can show a popup (deferred so startup stays responsive)
    if (gpuBackend === 'webgpu' && !graphicsDevice.isWebGPU) {
        // note: popups are registered as an event *function* (Events.function),
        // so they must be invoked, not fired
        setTimeout(() => {
            events.invoke('showPopup', {
                type: 'info',
                header: i18n.t('popup.webgpu-backend.header'),
                message: i18n.t('popup.webgpu-backend.message')
            });
        }, 1500);
    }

    // colors
    const bgClr = new Color();
    const selectedClr = new Color();
    const unselectedClr = new Color();
    const lockedClr = new Color();

    const setClr = (target: Color, value: Color, event: string) => {
        if (!target.equals(value)) {
            target.copy(value);
            events.fire(event, target);
        }
    };

    const setBgClr = (clr: Color) => {
        setClr(bgClr, clr, 'bgClr');
    };
    const setSelectedClr = (clr: Color) => {
        setClr(selectedClr, clr, 'selectedClr');
    };
    const setUnselectedClr = (clr: Color) => {
        setClr(unselectedClr, clr, 'unselectedClr');
    };
    const setLockedClr = (clr: Color) => {
        setClr(lockedClr, clr, 'lockedClr');
    };

    events.on('setBgClr', (clr: Color) => {
        setBgClr(clr);
    });
    events.on('setSelectedClr', (clr: Color) => {
        setSelectedClr(clr);
    });
    events.on('setUnselectedClr', (clr: Color) => {
        setUnselectedClr(clr);
    });
    events.on('setLockedClr', (clr: Color) => {
        setLockedClr(clr);
    });

    events.function('bgClr', () => {
        return bgClr;
    });
    events.function('selectedClr', () => {
        return selectedClr;
    });
    events.function('unselectedClr', () => {
        return unselectedClr;
    });
    events.function('lockedClr', () => {
        return lockedClr;
    });

    events.on('bgClr', (clr: Color) => {
        const cnv = (v: number) => `${Math.max(0, Math.min(255, (v * 255))).toFixed(0)}`;
        document.body.style.backgroundColor = `rgba(${cnv(clr.r)},${cnv(clr.g)},${cnv(clr.b)},1)`;
    });
    events.on('selectedClr', (clr: Color) => {
        scene.forceRender = true;
    });
    events.on('unselectedClr', (clr: Color) => {
        scene.forceRender = true;
    });
    events.on('lockedClr', (clr: Color) => {
        scene.forceRender = true;
    });

    // initialize colors from application config
    const toColor = (value: { r: number, g: number, b: number, a: number }) => {
        return new Color(value.r, value.g, value.b, value.a);
    };
    setBgClr(toColor(sceneConfig.bgClr));
    setSelectedClr(toColor(sceneConfig.selectedClr));
    setUnselectedClr(toColor(sceneConfig.unselectedClr));
    setLockedClr(toColor(sceneConfig.lockedClr));

    // create the mask selection canvas
    const maskCanvas = document.createElement('canvas');
    const maskContext = maskCanvas.getContext('2d');
    maskCanvas.setAttribute('id', 'mask-canvas');
    maskContext.globalCompositeOperation = 'copy';

    const mask = {
        canvas: maskCanvas,
        context: maskContext,
        // set while a tool's async selection is still consuming the shared
        // stroke canvas, so a second stroke can't start and repaint it mid-flight
        busy: false
    };

    // tool manager
    const toolManager = new ToolManager(events);
    toolManager.register('rectSelection', new RectSelection(events, editorUI.toolsContainer.dom));
    // eslint-disable-next-line no-new -- the depth bar wires its own events and lives as long as the app
    new SelectionDepthBar(events, editorUI.canvasContainer.dom);
    toolManager.register('brushSelection', new BrushSelection(events, editorUI.toolsContainer.dom, mask));
    toolManager.register('floodSelection', new FloodSelection(events, editorUI.toolsContainer.dom, mask, editorUI.canvasContainer));
    toolManager.register('polygonSelection', new PolygonSelection(events, editorUI.toolsContainer.dom, mask));
    toolManager.register('lassoSelection', new LassoSelection(events, editorUI.toolsContainer.dom, mask));
    toolManager.register('sphereSelection', new SphereSelection(events, scene, editorUI.canvasContainer, editorUI.tooltips));
    toolManager.register('sphereBrushSelection', new SphereBrushSelection(events, editorUI.toolsContainer.dom, mask));
    toolManager.register('boxSelection', new BoxSelection(events, scene, editorUI.canvasContainer, editorUI.tooltips));
    toolManager.register('eyedropperSelection', new EyedropperSelection(events, editorUI.toolsContainer.dom, editorUI.canvasContainer));
    toolManager.register('heal', new HealTool(events, editorUI.toolsContainer.dom, mask));
    toolManager.register('groundwater', new GroundWaterTool(events, scene));
    toolManager.register('move', new MoveTool(events, scene));
    toolManager.register('rotate', new RotateTool(events, scene));
    toolManager.register('scale', new ScaleTool(events, scene));
    toolManager.register('measure', new MeasureTool(events, scene, editorUI.canvasContainer));
    toolManager.register('orient', new OrientTool(events, scene, editorUI.toolsContainer.dom, editorUI.canvasContainer));
    toolManager.register('crop', new CropTool(events, scene, editorUI.canvasContainer));

    const boundDimensionsOverlay = new BoundDimensionsOverlay(events, scene, editorUI.canvasContainer);

    editorUI.toolsContainer.dom.appendChild(maskCanvas);

    // create heal panel (floating, shown when heal tool is activated)
    const healPanel = new HealPanel(events);
    editorUI.canvasContainer.append(healPanel);

    // register effects events (timeline-driven scatter effect track)
    registerEffectsEvents(events, () => scene);

    // show the active selection op (add/remove/intersect) at the cursor
    registerSelectCursor(events, editorUI.toolsContainer.dom);

    window.scene = scene;

    // register events that need scene or other dependencies
    registerEditorEvents(events, editHistory, scene);
    registerSelectionEvents(events, scene);
    registerSequenceEvents(events, scene);
    registerDocEvents(scene, events);
    registerRenderEvents(scene, events);
    registerAudioEvents(events, () => events.invoke('timeline.frameRate') as number ?? 30);
    initFileHandler(scene, events, editorUI.appContainer.dom);

    // apply stored user preferences and start capturing changes to them.
    // registered after the boot-time initialization events above so they are
    // never captured as user changes.
    registerPreferences(events, sceneConfig, urlArgs);

    // === Gamepad system（3DGS-Gamepad 合并版） ===
    // 核心控制器：双模式 / 速度档位 / 出生点 / 锁高 / 可重绑键位。
    // 通过 scene 的 'update' 事件驱动（scene.ts 每帧 fire）。
    const gamepadController = new GamepadController(scene.camera, events);
    void gamepadController;

    // 手柄截屏 + 视频录制
    const gamepadCapture = new GamepadCapture(scene, editorUI.canvas, events);
    void gamepadCapture;

    // 底部控制菜单 + 全屏设置面板（挂载到 body）
    const gamepadMenu = new GamepadMenu(events);
    document.body.appendChild(gamepadMenu.dom);
    const gamepadSettings = new GamepadSettings(events);
    document.body.appendChild(gamepadSettings.dom);

    // load async models
    scene.start();

    // handle load params
    const loadList = url.searchParams.getAll('load');
    const filenameList = url.searchParams.getAll('filename');
    for (const [i, value] of loadList.entries()) {
        const decoded = decodeURIComponent(value);
        const filename = i < filenameList.length ?
            decodeURIComponent(filenameList[i]) :
            decoded.split('/').pop();

        await events.invoke('import', [{
            filename,
            url: decoded
        }]);
    }


    // handle OS-based file association in PWA mode
    if ('launchQueue' in window) {
        window.launchQueue.setConsumer(async (launchParams: LaunchParams) => {
            for (const file of launchParams.files) {
                await events.invoke('import', [{
                    filename: file.name,
                    contents: await file.getFile()
                }]);
            }
        });
    }
};

export { main };
