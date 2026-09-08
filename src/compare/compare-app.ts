import {
    Application,
    createGraphicsDevice,
    FILLMODE_FILL_WINDOW,
    RESOLUTION_AUTO
} from 'playcanvas';

import { ComparePanel } from './compare-panel';
import { CompareScene } from './compare-scene';

/**
 * Comparison tool — "external plugin" entry point.
 *
 * When SplatRoom is opened with `?mode=compare` (see src/main.ts) this boots a
 * separate* PlayCanvas application instance (its own canvas + WebGL2 device)
 * so the comparison workspace never touches the editor's single-camera render
 * pipeline. The editor itself only fires `compare.open`; the heavy lifting
 * (import, align, layout, sync, stats, diff) lives in `src/compare/` and is
 * wired up phase by phase.
 *
 * P1 scope: import 2–4 models + per-model viewport rendering (own Layer +
 * Camera each) + layout skeleton (2/3/4 horizontal, 2/3/4 vertical, 2x2 grid)
 * driven by a single shared orbit camera.
 */
export const startCompareApp = async () => {
    // make the canvas fill the viewport
    document.body.style.margin = '0';
    document.body.style.overflow = 'hidden';

    // load html-to-image (UMD) for full-page snapshots (DOM panel + canvas).
    // NOTE: absolute path — the page may be served at `/?mode=compare`, and a
    // relative `./lib/...` would resolve to `/lib/...` (404).  The static copy
    // lives under /static/lib/... (mirroring webp.wasm etc.).
    await new Promise<void>((resolve) => {
        const s = document.createElement('script');
        s.src = '/static/lib/html-to-image/html-to-image.js';
        s.onload = () => {
            console.log('[CompareApp] html-to-image loaded');
            resolve();
        };
        s.onerror = (e) => {
            console.warn('[CompareApp] html-to-image failed to load, snapshot will fall back to manual compose', e);
            resolve();
        };
        document.head.appendChild(s);
    });

    const canvas = document.createElement('canvas');
    canvas.id = 'compare-canvas';
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
        // enable readback of the WebGL framebuffer so the analysis overlay
        // can do image-based edge detection (Sobel).  Without this, the
        // back-buffer is cleared on present and drawImage(src) returns black.
        preserveDrawingBuffer: true,
        alpha: true   // keep alpha so transparent regions don't read as black
    } as any);

    const app = new Application(canvas, { graphicsDevice: device });

    app.setCanvasFillMode(FILLMODE_FILL_WINDOW);
    app.setCanvasResolution(RESOLUTION_AUTO);

    // comparison workspace
    const scene = new CompareScene(app, canvas);
    // eslint-disable-next-line no-new -- 面板实例自注册到 scene，生命周期与应用一致
    new ComparePanel(scene);

    window.addEventListener('resize', () => {
        app.resizeCanvas();
        scene.onResize();
    });

    app.start();
};
