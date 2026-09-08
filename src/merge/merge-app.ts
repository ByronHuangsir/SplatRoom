import { createGraphicsDevice, Application, FILLMODE_FILL_WINDOW, RESOLUTION_AUTO } from 'playcanvas';

import { autoAlign, bestSymbolAlign, bestTransformAlign, kabsch, pcaPrealign, similarityRecognize, umeyamaSimilarity } from './merge-align';
import { buildMergedGSplatData } from './merge-export';
import { MergePanel } from './merge-panel';
import { MergeScene } from './merge-scene';

/**
 * 合并工具（模块 3）入口 — 独立窗口（?mode=merge）。
 *
 * 完全独立的渲染链路：自己的 canvas / WebGL device / Application / 场景树，
 * 与主编辑器视窗渲染和 PiP 画面零共享 —— 合并操作不影响软件主体画面。
 */
export const startMergeApp = async (): Promise<void> => {
    document.body.style.margin = '0';
    document.body.style.overflow = 'hidden';
    document.body.style.background = '#16181c';

    const canvas = document.createElement('canvas');
    canvas.id = 'merge-canvas';
    Object.assign(canvas.style, {
        position: 'fixed',
        inset: '0',
        width: '100%',
        height: '100%',
        display: 'block',
        touchAction: 'none'
    } as CSSStyleDeclaration);
    document.body.appendChild(canvas);

    const device = await createGraphicsDevice(canvas, {
        deviceTypes: ['webgl2'],
        antialias: true,
        preserveDrawingBuffer: true,
        alpha: false
    } as any);

    const app = new Application(canvas, { graphicsDevice: device });
    app.setCanvasFillMode(FILLMODE_FILL_WINDOW);
    app.setCanvasResolution(RESOLUTION_AUTO);

    const scene = new MergeScene(app, canvas);
    // eslint-disable-next-line no-new -- 面板实例自注册到 scene，生命周期与应用一致
    new MergePanel(scene);

    window.addEventListener('resize', () => {
        app.resizeCanvas();
    });

    app.start();

    // 供 headless 验证 / 调试
    (window as any).__mergeApp = { scene, kabsch, autoAlign, pcaPrealign, bestSymbolAlign, bestTransformAlign, buildMergedGSplatData, similarityRecognize, umeyamaSimilarity };
};
