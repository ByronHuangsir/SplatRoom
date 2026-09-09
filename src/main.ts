import { WebPCodec, WorkerQueue } from '@playcanvas/splat-transform';
import { Color, createGraphicsDevice } from 'playcanvas';

import { registerAnimationControllerEvents } from './animation/animation-controller';
import { registerAudioEvents } from './audio/audio-manager';
import { registerCameraPosesEvents } from './camera-poses';
import { CommandQueue } from './command-queue';
import { startCompareApp } from './compare/compare-app';
import { registerDocEvents } from './doc';
import { EditHistory } from './edit-history';
import { registerEditorEvents, registerCropBoxEvents, registerSurfaceRefineEvents } from './editor';
import { registerEffectsEvents } from './effects/effects-manager';
import { Events } from './events';
import { initFileHandler } from './file-handler';
import { GamepadCapture } from './gamepad-capture';
import { GamepadController } from './gamepad-controller';
import { getGpuBackendPref } from './gpu-backend';
import { registerIframeApi } from './iframe-api';
import { registerLodEvents } from './lod/editor-lod';
import { startMergeApp } from './merge/merge-app';
import { MouseBindings } from './mouse-bindings';
import { registerPreferences } from './preferences';
import { registerPublishEvents } from './publish';
import { registerRenderEvents } from './render';
import { Scene } from './scene';
import { getSceneConfig } from './scene-config';
import { registerSelectionEvents } from './selection';
import { registerSequenceEvents } from './sequence';
import { ShortcutManager } from './shortcut-manager';
import { startSplatFactoryApp } from './splatfactory/splatfactory-app';
import { registerTimelineEvents } from './timeline';
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
import { registerTrackManagerEvents } from './track-manager';
import { registerTransformHandlerEvents } from './transform-handler';
import { BoundDimensionsOverlay } from './ui/bound-dimensions-overlay';
import { EditorUI } from './ui/editor';
import { GamepadMenu } from './ui/gamepad-menu';
import { GamepadSettings } from './ui/gamepad-settings';
import { HealPanel } from './ui/heal-panel';
import { i18n } from './ui/localization';
import { registerSelectCursor } from './ui/select-cursor';
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

    // V3 WebGPU support: the main renderer can run on WebGPU with automatic
    // WebGL2 fallback (createGraphicsDevice tries deviceTypes in order).
    // Default stays WebGL2 — several GPU readback/data-processor paths and the
    // PiP preview need per-host WebGPU verification before it can be default.
    // Precedence: URL override (?gpu=) > settings-panel preference > WebGL2.
    const urlArgs = getURLArgs();
    const gpuOverride = (urlArgs as any)?.gpu;
    const gpuBackend = (gpuOverride === 'webgpu' || gpuOverride === 'webgl2') ?
        gpuOverride :
        getGpuBackendPref();

    // create the graphics device
    const graphicsDevice = await createGraphicsDevice(editorUI.canvas, {
        deviceTypes: gpuBackend === 'webgpu' ? ['webgpu', 'webgl2'] : ['webgl2'],
        antialias: false,
        depth: false,
        stencil: false,
        xrCompatible: false,
        powerPreference: 'high-performance'
    });

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
        context: maskContext
    };

    // tool manager
    const toolManager = new ToolManager(events);
    toolManager.register('rectSelection', new RectSelection(events, editorUI.toolsContainer.dom));
    toolManager.register('brushSelection', new BrushSelection(events, editorUI.toolsContainer.dom, mask));
    toolManager.register('floodSelection', new FloodSelection(events, editorUI.toolsContainer.dom, mask, editorUI.canvasContainer));
    toolManager.register('polygonSelection', new PolygonSelection(events, editorUI.toolsContainer.dom, mask));
    toolManager.register('lassoSelection', new LassoSelection(events, editorUI.toolsContainer.dom, mask));
    toolManager.register('sphereSelection', new SphereSelection(events, scene, editorUI.canvasContainer, editorUI.tooltips));
    toolManager.register('sphereBrushSelection', new SphereBrushSelection(events, editorUI.toolsContainer.dom));
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
