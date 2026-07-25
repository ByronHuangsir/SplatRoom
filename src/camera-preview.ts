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
    FILTER_NEAREST,
    ADDRESS_CLAMP_TO_EDGE,
    ASPECT_MANUAL,
    Vec3
} from 'playcanvas';

import { Element, ElementType } from './element';
import { AnimationController } from './animation/animation-controller';
import { TrackId } from './animation/animation-data';

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

    // Drag snap config
    private readonly SNAP_THRESHOLD = 40; // px from edge to trigger snap
    private readonly SNAP_TRANSITION = 'left 0.2s ease-out, top 0.2s ease-out, right 0.2s ease-out, bottom 0.2s ease-out';

    // Dimensions
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
        this.cameraComponent.farClip = 1000;
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
        this.pipClearPass?.destroy();
        this.pipRenderPass?.destroy();
        this.cameraEntity?.destroy();
        this.container?.remove();
        this.container = null;
    }

    onPreRender() {
        if (!this.enabled || !this.hasTrack) return;

        // Update PiP camera position from spline BEFORE cullComposition runs
        // in app.render(). This ensures mesh instances are culled against the
        // current frame's camera pose, eliminating the 1-frame culling delay.
        this.updateCameraPose();

        // Force camera matrices to be computed so that cullComposition
        // (which calls camera.frameUpdate) picks up the correct transform.
        const cam = this.cameraComponent.camera;
        cam.projectionMatrix;
        cam.viewMatrix;
    }

    onPostRender() {
        // Render PiP AFTER cullComposition (which runs in app.render()).
        // At this point mesh instances are correctly culled for the PiP
        // camera's current pose, avoiding the 1-frame delay that caused
        // the PiP to show stale/main-camera-affected content.
        if (!this.enabled || !this.hasTrack) return;

        this.pipRenderPass.frameUpdate();
        this.pipClearPass.render();
        this.pipRenderPass.render();
        this.captureToCanvas();
    }

    // ---- Private ----

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

        const pos = new Vec3(val[0], val[1], val[2]);
        const rawTgt = new Vec3(val[3], val[4], val[5]);
        const fov = val[6];

        // Compute forward direction to dynamically choose up vector and avoid gimbal lock
        const forward = new Vec3().sub2(rawTgt, pos);
        const forwardLen = forward.length();
        if (forwardLen < 0.0001) return;
        forward.mulScalar(1 / forwardLen);

        // When looking nearly straight up/down (forward ≈ Y axis), lookAt's default
        // up vector (Y) causes gimbal lock → sudden 180° flip. Use Z as up instead.
        const up = Math.abs(forward.y) > 0.99 ? new Vec3(0, 0, 1) : new Vec3(0, 1, 0);

        // Directly set camera pose from spline values — no smoothing needed
        // because the spline interpolation already guarantees smooth motion.
        this.cameraEntity.setLocalPosition(pos.x, pos.y, pos.z);
        this.cameraEntity.lookAt(rawTgt.x, rawTgt.y, rawTgt.z, up.x, up.y, up.z);
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
            width: 328px;
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
