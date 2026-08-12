/**
 * Preview window for timeline animation.
 * Displays a small live preview of the current 3D view with fullscreen toggle.
 * Now positioned as a sidebar panel below the camera panel.
 */
class PreviewWindow {
    private _container: HTMLElement;
    private _canvas: HTMLCanvasElement;
    private _fullscreenBtn: HTMLElement;
    private _isFullscreen = false;
    private _titleBar: HTMLElement;
    private _contentWrap: HTMLElement;

    /** Main 3D canvas to copy frames from */
    sourceCanvas: HTMLCanvasElement | null = null;

    /** Whether the preview is visible */
    visible: boolean;

    constructor() {
        // Container — styled as a sidebar panel, not absolute
        this._container = document.createElement('div');
        this._container.id = 'preview-window';
        this._container.style.cssText = `
            overflow: hidden;
            background: #1a1a1a;
            display: none;
            flex-shrink: 0;
            border-top: 1px solid #333;
        `;

        // Title bar
        this._titleBar = document.createElement('div');
        this._titleBar.style.cssText = `
            height: 24px;
            background: #252530;
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0 8px;
            font-size: 11px;
            color: #999;
            pointer-events: auto;
        `;
        this._titleBar.innerHTML = '<span>预览</span>';

        // Fullscreen button
        this._fullscreenBtn = document.createElement('button');
        this._fullscreenBtn.textContent = '⤢';
        this._fullscreenBtn.style.cssText = `
            background: none;
            border: none;
            color: #aaa;
            cursor: pointer;
            font-size: 13px;
            padding: 0 4px;
            line-height: 20px;
        `;
        this._fullscreenBtn.title = '全屏预览';
        this._fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());
        this._titleBar.appendChild(this._fullscreenBtn);

        this._container.appendChild(this._titleBar);

        // Content wrap
        this._contentWrap = document.createElement('div');
        this._contentWrap.style.cssText = `
            width: 100%;
            padding: 4px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: #111;
        `;
        this._container.appendChild(this._contentWrap);

        // Canvas — 16:9 aspect ratio panel
        this._canvas = document.createElement('canvas');
        this._canvas.style.cssText = `
            width: 100%;
            aspect-ratio: 16/9;
            object-fit: contain;
            border-radius: 2px;
            background: #000;
        `;
        this._canvas.width = 320;
        this._canvas.height = 180;
        this._contentWrap.appendChild(this._canvas);

        this.visible = false;
    }

    get dom(): HTMLElement {
        return this._container;
    }

    show(): void {
        this.visible = true;
        this._container.style.display = 'block';
    }

    hide(): void {
        this.visible = false;
        this._container.style.display = 'none';
        if (this._isFullscreen) {
            this.exitFullscreen();
        }
    }

    toggleFullscreen(): void {
        if (this._isFullscreen) {
            this.exitFullscreen();
        } else {
            this.enterFullscreen();
        }
    }

    enterFullscreen(): void {
        this._isFullscreen = true;
        this._container.style.position = 'fixed';
        this._container.style.top = '0';
        this._container.style.left = '0';
        this._container.style.width = '100vw';
        this._container.style.height = '100vh';
        this._container.style.zIndex = '1000';
        this._container.style.background = '#000';
        this._container.style.border = 'none';
        this._fullscreenBtn.textContent = '⤣';
        this._fullscreenBtn.title = '退出全屏';
    }

    exitFullscreen(): void {
        this._isFullscreen = false;
        this._container.style.position = '';
        this._container.style.top = '';
        this._container.style.left = '';
        this._container.style.width = '';
        this._container.style.height = '';
        this._container.style.zIndex = '';
        this._container.style.background = '#1a1a1a';
        this._fullscreenBtn.textContent = '⤢';
        this._fullscreenBtn.title = '全屏预览';
    }

    /** Copy the current frame from the main canvas */
    updateFrame(): void {
        if (!this.visible || !this.sourceCanvas) return;

        const ctx = this._canvas.getContext('2d');
        if (!ctx) return;

        const targetW = this._isFullscreen
            ? this._container.clientWidth
            : this._canvas.clientWidth || 320;
        const targetH = this._isFullscreen
            ? this._container.clientHeight
            : this._canvas.clientHeight || 180;

        if (this._canvas.width !== targetW || this._canvas.height !== targetH) {
            this._canvas.width = targetW;
            this._canvas.height = targetH;
        }

        try {
            ctx.drawImage(this.sourceCanvas, 0, 0, targetW, targetH);
        } catch (_e) {
            // Canvas may be tainted or not ready
        }
    }
}

export { PreviewWindow };
