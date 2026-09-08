import { Container, Label } from '@playcanvas/pcui';

import { Events } from '../events';
import { i18n } from './localization';

/**
 * Simple dropdown menu attached to the snapshot button.
 * Shows two options: full snapshot / region snapshot.
 */
class SnapshotMenu extends Container {
    private _snapEvents: Events;
    private _menu: Container;
    private _menuVisible = false;
    private _getAnchorBtn: () => HTMLElement | null;

    constructor(events: Events, getAnchorBtn: () => HTMLElement | null) {
        super({ id: 'snapshot-menu-wrapper' });
        this._snapEvents = events;
        this._getAnchorBtn = getAnchorBtn;

        // Hidden overlay that catches clicks outside the menu
        this.dom.style.position = 'fixed';
        this.dom.style.top = '0';
        this.dom.style.left = '0';
        this.dom.style.width = '100vw';
        this.dom.style.height = '100vh';
        this.dom.style.zIndex = '9998';
        this.dom.style.display = 'none';

        this.dom.addEventListener('click', () => this.hide());

        this._menu = new Container({ id: 'snapshot-dropdown' });
        this._menu.dom.style.position = 'fixed';
        this._menu.dom.style.zIndex = '9999';
        this._menu.dom.style.background = '#2a2a2a';
        this._menu.dom.style.borderRadius = '6px';
        this._menu.dom.style.padding = '4px';
        this._menu.dom.style.boxShadow = '0 4px 12px rgba(0,0,0,0.5)';
        this._menu.dom.style.minWidth = '160px';
        this._menu.dom.style.display = 'none';

        this._menu.dom.addEventListener('click', e => e.stopPropagation());

        const fullBtn = this._makeItem('panel.snapshot.full', () => {
            this.hide();
            events.fire('snapshot.capture', 'full');
        });

        const regionBtn = this._makeItem('panel.snapshot.region', () => {
            this.hide();
            events.fire('snapshot.capture', 'region');
        });

        this._menu.append(fullBtn);
        this._menu.append(regionBtn);

        this.append(this._menu);
        document.body.appendChild(this.dom);
    }

    private _positionMenu() {
        // Re-resolve the anchor button each time the menu opens. The button DOM
        // may not exist at registration time (e.g. if SnapshotMenu is
        // constructed before the right toolbar is mounted), so we must look it
        // up lazily to honour the dynamic layout.
        const anchorBtn = this._getAnchorBtn();
        if (!anchorBtn) {
            // Fallback: bottom-right of viewport
            this._menu.dom.style.right = '80px';
            this._menu.dom.style.bottom = '48px';
            this._menu.dom.style.top = 'auto';
            this._menu.dom.style.left = 'auto';
            return;
        }
        const rect = anchorBtn.getBoundingClientRect();
        const menuWidth = this._menu.dom.offsetWidth || 160;
        // Anchor to the left of the button, vertically centered.
        // If there is not enough space on the left, flip to the right side.
        const vw = window.innerWidth;
        const desiredLeft = rect.left - menuWidth - 8;
        const flipRight = desiredLeft < 8;
        this._menu.dom.style.top = `${rect.top + rect.height / 2 - 22}px`;
        this._menu.dom.style.left = flipRight ?
            `${Math.min(rect.right + 8, vw - menuWidth - 8)}px` :
            `${desiredLeft}px`;
        this._menu.dom.style.right = 'auto';
        this._menu.dom.style.bottom = 'auto';
    }

    private _makeItem(key: string, onClick: () => void): Container {
        const item = new Container({ class: 'snapshot-menu-item' });
        item.dom.style.padding = '6px 12px';
        item.dom.style.cursor = 'pointer';
        item.dom.style.borderRadius = '4px';
        item.dom.style.fontSize = '12px';
        item.dom.style.color = '#ccc';
        item.dom.style.whiteSpace = 'nowrap';
        item.dom.addEventListener('mouseenter', () => {
            item.dom.style.background = '#3a3a3a';
        });
        item.dom.addEventListener('mouseleave', () => {
            item.dom.style.background = 'transparent';
        });

        const label = new Label({ text: i18n.t(key) });
        item.append(label);
        item.dom.addEventListener('click', onClick);
        return item;
    }

    show() {
        this._menuVisible = true;
        this._positionMenu();
        this.dom.style.display = 'block';
        this._menu.dom.style.display = 'block';
    }

    hide() {
        this._menuVisible = false;
        this.dom.style.display = 'none';
    }

    toggle() {
        if (this._menuVisible) {
            this.hide();
        } else {
            this.show();
        }
    }
}

/**
 * Captures the current canvas as a data URL.
 */
const captureCanvas = (canvas: HTMLCanvasElement, rect?: { x: number, y: number, w: number, h: number }): string => {
    if (rect) {
        const offCanvas = document.createElement('canvas');
        offCanvas.width = rect.w;
        offCanvas.height = rect.h;
        const ctx = offCanvas.getContext('2d')!;
        ctx.drawImage(canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
        return offCanvas.toDataURL('image/png');
    }
    return canvas.toDataURL('image/png');
};

/**
 * Downloads a data URL as a file.
 */
const downloadFile = (dataUrl: string, filename: string) => {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
};

/**
 * Generate default filename: basename_kz_YYYYMMDD-HHMMSS.ext
 */
const defaultFilename = (format: string): string => {
    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    return `snapshot_kz_${ts}.${format}`;
};

/**
 * Show save dialog and save the image.
 */
const saveSnapshot = async (dataUrl: string, defaultName: string) => {
    // Try File System Access API first
    if ('showSaveFilePicker' in window) {
        try {
            const ext = defaultName.split('.').pop() || 'png';
            const mimeTypes: Record<string, string> = {
                png: 'image/png',
                jpg: 'image/jpeg',
                jpeg: 'image/jpeg',
                webp: 'image/webp',
                bmp: 'image/bmp'
            };
            const handle = await (window as any).showSaveFilePicker({
                suggestedName: defaultName,
                types: [{
                    description: 'Image',
                    accept: { [mimeTypes[ext] || 'image/png']: [`.${ext}`] }
                }]
            });
            const writable = await handle.createWritable();
            const blob = await (await fetch(dataUrl)).blob();
            await writable.write(blob);
            await writable.close();
            return;
        } catch (e) {
            // User cancelled
        }
    }
    // Fallback: simple download
    downloadFile(dataUrl, defaultName);
};

/**
 * Register snapshot events on the given events bus.
 *
 * @param forceRender - Optional callback to trigger a forced render. When provided,
 * snapshot capture will set forceRender, then capture the canvas synchronously
 * in the next 'postrender' event handler — while the WebGL drawing buffer is
 * still valid (before the browser composites and clears it). Without this,
 * canvas.toDataURL() returns a black image because PlayCanvas uses
 * preserveDrawingBuffer: false by default.
 */
const registerSnapshotEvents = (events: Events, getCanvas: () => HTMLCanvasElement, getBtn?: () => HTMLElement | null, forceRender?: () => void) => {
    const menu = new SnapshotMenu(events, getBtn ?? (() => null));

    events.on('snapshot.showMenu', () => menu.toggle());

    /**
     * Force a render, then execute captureFn synchronously in the postrender
     * handler while the drawing buffer is still valid.
     */
    const renderThenCapture = (captureFn: () => void) => {
        if (forceRender) {
            forceRender();
            const h = events.on('postrender', () => {
                h.off();
                captureFn();
            });
        } else {
            // Fallback: capture immediately (may be black if buffer was cleared)
            captureFn();
        }
    };

    events.on('snapshot.capture', (mode: 'full' | 'region') => {
        const canvas = getCanvas();
        if (!canvas) return;

        if (mode === 'full') {
            renderThenCapture(() => {
                const dataUrl = captureCanvas(canvas);
                saveSnapshot(dataUrl, defaultFilename('png'));
            });
        } else {
            // Region capture: show a simple overlay for drag-selection
            regionCapture(canvas, events, renderThenCapture);
        }
    });
};

/**
 * Interactive region capture: drag to define initial region, then
 * resize and reposition before confirming with Enter or double-click.
 */
const regionCapture = (canvas: HTMLCanvasElement, events: Events, renderThenCapture: (captureFn: () => void) => void) => {
    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100vw';
    overlay.style.height = '100vh';
    overlay.style.zIndex = '10000';
    overlay.style.background = 'rgba(0,0,0,0.25)';
    overlay.style.cursor = 'crosshair';
    overlay.style.touchAction = 'none';

    const sel = document.createElement('div');
    sel.style.position = 'fixed';
    sel.style.border = '2px dashed #fff';
    sel.style.background = 'rgba(255,255,255,0.08)';
    sel.style.display = 'none';
    sel.style.pointerEvents = 'auto';
    sel.style.zIndex = '10001';
    sel.style.cursor = 'move';
    document.body.appendChild(sel);

    // 8 resize handles
    const handles: HTMLDivElement[] = [];
    const handleSize = 8;
    for (let i = 0; i < 8; i++) {
        const h = document.createElement('div');
        h.style.position = 'fixed';
        h.style.width = `${handleSize * 2}px`;
        h.style.height = `${handleSize * 2}px`;
        h.style.background = '#fff';
        h.style.border = '1px solid #333';
        h.style.zIndex = '10002';
        h.style.display = 'none';
        h.style.pointerEvents = 'auto';
        // Corner handles
        if (i < 4) {
            h.style.cursor = ['nw-resize', 'ne-resize', 'sw-resize', 'se-resize'][i];
        } else {
            h.style.cursor = ['n-resize', 's-resize', 'w-resize', 'e-resize'][i - 4];
        }
        document.body.appendChild(h);
        handles.push(h);
    }

    // Confirm button
    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = '✓';
    confirmBtn.style.position = 'fixed';
    confirmBtn.style.zIndex = '10002';
    confirmBtn.style.display = 'none';
    confirmBtn.style.background = '#4a4';
    confirmBtn.style.color = '#fff';
    confirmBtn.style.border = 'none';
    confirmBtn.style.borderRadius = '4px';
    confirmBtn.style.width = '28px';
    confirmBtn.style.height = '28px';
    confirmBtn.style.cursor = 'pointer';
    confirmBtn.style.fontSize = '16px';
    confirmBtn.style.pointerEvents = 'auto';
    document.body.appendChild(confirmBtn);

    let selX = 0, selY = 0, selW = 0, selH = 0;
    let selActive = false;
    let dragMode: 'none' | 'draw' | 'move' | 'resize' = 'none';
    let dragStartX = 0, dragStartY = 0;
    let dragOrigX = 0, dragOrigY = 0, dragOrigW = 0, dragOrigH = 0;
    let resizeHandle = -1;
    let capturePointerId: number | null = null;

    const canvasRect = canvas.getBoundingClientRect();

    const releaseCapture = () => {
        if (capturePointerId !== null) {
            try {
                overlay.releasePointerCapture(capturePointerId);
            } catch (_) { /* ignore */ }
            capturePointerId = null;
        }
    };

    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

    const updateUI = () => {
        sel.style.left = `${selX}px`;
        sel.style.top = `${selY}px`;
        sel.style.width = `${selW}px`;
        sel.style.height = `${selH}px`;

        // Position resize handles at edges and corners
        const positions: [number, number][] = [
            [selX - handleSize, selY - handleSize],              // nw
            [selX + selW - handleSize, selY - handleSize],       // ne
            [selX - handleSize, selY + selH - handleSize],       // sw
            [selX + selW - handleSize, selY + selH - handleSize], // se
            [selX + selW / 2 - handleSize, selY - handleSize],     // n
            [selX + selW / 2 - handleSize, selY + selH - handleSize], // s
            [selX - handleSize, selY + selH / 2 - handleSize],     // w
            [selX + selW - handleSize, selY + selH / 2 - handleSize] // e
        ];
        handles.forEach((h, i) => {
            h.style.left = `${positions[i][0]}px`;
            h.style.top = `${positions[i][1]}px`;
        });
        confirmBtn.style.left = `${selX + selW + 4}px`;
        confirmBtn.style.top = `${selY - 4}px`;
    };

    const showSelection = () => {
        sel.style.display = 'block';
        handles.forEach((h) => {
            h.style.display = 'block';
        });
        confirmBtn.style.display = 'block';
        updateUI();
    };

    const hideSelection = () => {
        sel.style.display = 'none';
        handles.forEach((h) => {
            h.style.display = 'none';
        });
        confirmBtn.style.display = 'none';
    };

    const getHandleIndex = (x: number, y: number): number => {
        for (let i = 0; i < 8; i++) {
            const r = handles[i].getBoundingClientRect();
            if (x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 4 && y <= r.bottom + 4) return i;
        }
        return -1;
    };

    const isInside = (x: number, y: number) => x >= selX && x <= selX + selW && y >= selY && y <= selY + selH;

    const doCapture = () => {
        const scaleX = canvas.width / canvasRect.width;
        const scaleY = canvas.height / canvasRect.height;
        const rect = {
            x: Math.round((selX - canvasRect.left) * scaleX),
            y: Math.round((selY - canvasRect.top) * scaleY),
            w: Math.round(selW * scaleX),
            h: Math.round(selH * scaleY)
        };
        if (rect.w < 4 || rect.h < 4) return;
        cleanup();
        // Force a render and capture while the drawing buffer is still valid
        renderThenCapture(() => {
            const dataUrl = captureCanvas(canvas, rect);
            saveSnapshot(dataUrl, defaultFilename('png'));
        });
    };

    const cleanup = () => {
        releaseCapture();
        overlay.remove();
        sel.remove();
        handles.forEach(h => h.remove());
        confirmBtn.remove();
    };

    // Confirm: double-click on selection or press Enter
    sel.addEventListener('dblclick', () => {
        if (selActive) doCapture();
    });
    window.addEventListener('keydown', (ke) => {
        if (ke.key === 'Enter' && selActive) doCapture();
        if (ke.key === 'Escape') cleanup();
    });

    // Shared pointer-down handler.  Attached to overlay, sel and all handles
    // because sel/handles sit above overlay in z-index and are DOM siblings
    // (events do not bubble between siblings).
    const onPointerDown = (e: PointerEvent) => {
        if (selActive) {
            // Check if clicking a handle
            const hi = getHandleIndex(e.clientX, e.clientY);
            if (hi >= 0) {
                dragMode = 'resize';
                resizeHandle = hi;
            } else if (isInside(e.clientX, e.clientY)) {
                dragMode = 'move';
            } else {
                // Clicked outside — finish and start new
                doCapture();
                selActive = false;
                hideSelection();
                dragMode = 'draw';
            }
        } else {
            dragMode = 'draw';
            selActive = false;
            hideSelection();
        }

        if (dragMode === 'draw' || dragMode === 'move' || dragMode === 'resize') {
            // Seize pointer capture from the WebGL canvas so that pointermove
            // and pointerup events reach our overlay.
            try {
                overlay.setPointerCapture(e.pointerId);
                capturePointerId = e.pointerId;
            } catch (_) {
                // Pointer may already be captured by another element; ignore.
            }
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            dragOrigX = selX;
            dragOrigY = selY;
            dragOrigW = selW;
            dragOrigH = selH;
            e.preventDefault();
            e.stopPropagation();
        }
    };

    overlay.addEventListener('pointerdown', onPointerDown);
    sel.addEventListener('pointerdown', onPointerDown);
    handles.forEach(h => h.addEventListener('pointerdown', onPointerDown));

    overlay.addEventListener('pointermove', (e: PointerEvent) => {
        e.stopPropagation();
        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;

        if (dragMode === 'draw') {
            selX = Math.min(dragStartX, e.clientX);
            selY = Math.min(dragStartY, e.clientY);
            selW = Math.abs(dx);
            selH = Math.abs(dy);
            sel.style.display = 'block';
            updateUI();
        } else if (dragMode === 'move') {
            selX = dragOrigX + dx;
            selY = dragOrigY + dy;
            updateUI();
        } else if (dragMode === 'resize') {
            let nx = dragOrigX, ny = dragOrigY, nw = dragOrigW, nh = dragOrigH;
            switch (resizeHandle) {
                case 0: nx += dx; ny += dy; nw -= dx; nh -= dy; break; // nw
                case 1: ny += dy; nw += dx; nh -= dy; break; // ne
                case 2: nx += dx; nw -= dx; nh += dy; break; // sw
                case 3: nw += dx; nh += dy; break; // se
                case 4: ny += dy; nh -= dy; break; // n
                case 5: nh += dy; break; // s
                case 6: nx += dx; nw -= dx; break; // w
                case 7: nw += dx; break; // e
            }
            if (nw >= 20) {
                selX = nx; selW = nw;
            }
            if (nh >= 20) {
                selY = ny; selH = nh;
            }
            updateUI();
        }
    });

    overlay.addEventListener('pointerup', () => {
        releaseCapture();
        if (dragMode === 'draw') {
            if (selW > 10 && selH > 10) {
                selActive = true;
                showSelection();
            } else {
                hideSelection();
            }
        }
        dragMode = 'none';
        resizeHandle = -1;
    });

    overlay.addEventListener('pointerleave', () => {
        releaseCapture();
        if (dragMode === 'draw' && selW > 10 && selH > 10) {
            selActive = true;
            showSelection();
        }
        dragMode = 'none';
    });

    document.body.appendChild(overlay);
};

export { registerSnapshotEvents };
