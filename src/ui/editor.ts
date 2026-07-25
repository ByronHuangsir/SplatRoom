import { Container, Label } from '@playcanvas/pcui';
import { Mat4 } from 'playcanvas';

import { CameraTrajectory } from '../animation/camera-trajectory';
import { DataPanel } from './data-panel';
import { Events } from '../events';
import { AboutPopup } from './about-popup';
import { BottomToolbar } from './bottom-toolbar';
import { CameraInfoOverlay } from './camera-info-overlay';
import { ColorPanel } from './color-panel';
import { ContextMenu } from './context-menu';
import { ExportPopup } from './export-popup';
import { ImageSettingsDialog } from './image-settings-dialog';
import { i18n } from './localization';
import { Menu } from './menu';
import { ModeToggle } from './mode-toggle';
import logo from './playcanvas-logo.png';
import { Popup, ShowOptions } from './popup';
import { PreviewWindow } from './preview-window';
import { Progress } from './progress';
import { PublishSettingsDialog } from './publish-settings-dialog';
import { RightToolbar } from './right-toolbar';
import { ScenePanel } from './scene-panel';
import { SettingsPanel } from './settings-panel';
import { ShortcutsPopup } from './shortcuts-popup';
import { Spinner } from './spinner';
import { StatusBar } from './status-bar';
import { TimelinePanel } from './timeline-panel';
import { Tooltips } from './tooltips';
import { VideoSettingsDialog } from './video-settings-dialog';
import { TurntableVideoDialog } from './turntable-video-dialog';
import { ViewCube } from './view-cube';
import { version } from '../../package.json';

// ts compiler and vscode find this type, but eslint does not
type FilePickerAcceptType = unknown;

class EditorUI {
    appContainer: Container;
    topContainer: Container;
    canvasContainer: Container;
    toolsContainer: Container;
    canvas: HTMLCanvasElement;
    popup: Popup;
    tooltips: Tooltips;

    constructor(events: Events) {
        // favicon
        const link = document.createElement('link');
        link.rel = 'icon';
        link.href = logo;
        document.head.appendChild(link);

        // app
        const appContainer = new Container({
            id: 'app-container'
        });

        // editor
        const editorContainer = new Container({
            id: 'editor-container'
        });

        // tooltips container
        const tooltipsContainer = new Container({
            id: 'tooltips-container'
        });

        // top container
        const topContainer = new Container({
            id: 'top-container'
        });

        // canvas
        const canvas = document.createElement('canvas');
        canvas.id = 'canvas';

        // app label
        const appLabel = new Label({
            id: 'app-label',
            text: `SPLATROOM v${version}`
        });

        // canvas container
        const canvasContainer = new Container({
            id: 'canvas-container'
        });

        // tools container
        const toolsContainer = new Container({
            id: 'tools-container'
        });

        // tooltips
        const tooltips = new Tooltips();
        tooltipsContainer.append(tooltips);

        // bottom toolbar
        const previewWindow = new PreviewWindow();
        previewWindow.sourceCanvas = canvas;
        const scenePanel = new ScenePanel(events, tooltips, previewWindow);
        const settingsPanel = new SettingsPanel(events, tooltips);
        const colorPanel = new ColorPanel(events, tooltips);
        const bottomToolbar = new BottomToolbar(events, tooltips);
        const rightToolbar = new RightToolbar(events, tooltips);
        const modeToggle = new ModeToggle(events, tooltips);
        const menu = new Menu(events);
        const cameraInfoOverlay = new CameraInfoOverlay(events, tooltips);

        canvasContainer.dom.appendChild(canvas);
        canvasContainer.append(appLabel);
        canvasContainer.append(cameraInfoOverlay);
        canvasContainer.append(toolsContainer);
        canvasContainer.append(scenePanel);
        canvasContainer.append(settingsPanel);
        canvasContainer.append(colorPanel);
        canvasContainer.append(bottomToolbar);
        canvasContainer.append(rightToolbar);
        canvasContainer.append(modeToggle);
        canvasContainer.append(menu);

        // view axes container
        const viewCube = new ViewCube(events);
        canvasContainer.append(viewCube);
        events.on('prerender', (cameraMatrix: Mat4) => {
            viewCube.update(cameraMatrix);
        });

        // Trajectory overlay canvas (renders camera path on top of 3D view)
        const trajectoryCanvas = document.createElement('canvas');
        trajectoryCanvas.id = 'trajectory-canvas';
        trajectoryCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:45;display:none;';
        canvasContainer.dom.appendChild(trajectoryCanvas);
        const trajectoryCtx = trajectoryCanvas.getContext('2d')!;

        // Create camera trajectory handler
        const cameraTrajectory = new CameraTrajectory(events);
        let trajectoryData: { segments: any[]; points: { pos: any; frame: number; inTan: any; outTan: any; inTension: number; outTension: number; inHandlePos: any; outHandlePos: any }[] } = { segments: [], points: [] };
        // Cache screen-projected keyframe positions for hit testing
        let trajectoryScreenPoints: { x: number; y: number; frame: number; inHandle?: { x: number; y: number }; outHandle?: { x: number; y: number } }[] = [];

        cameraTrajectory.trajectoryProvider = (segments, points) => {
            trajectoryData = { segments, points };
        };

        // Timeline visibility: manage trajectory overlay
        events.on('statusBar.panelChanged', (_panel: string | null) => {
            // PreviewWindow and CameraTrajectory overlay — disabled,
            // replaced by CameraPath3D (3D path) and CameraPreview (PiP).
            trajectoryCanvas.style.display = 'none';
        });

        // Render trajectory on each frame
        let lastTrajectoryW = 0;
        let lastTrajectoryH = 0;

        events.on('prerender', (cameraMatrix: Mat4) => {
            if (trajectoryCanvas.style.display === 'none') return;

            const cw = canvasContainer.dom.clientWidth;
            const ch = canvasContainer.dom.clientHeight;

            // Only resize canvas when container actually changes size
            // (canvas.width/height assignment triggers expensive GPU clear)
            if (cw !== lastTrajectoryW || ch !== lastTrajectoryH) {
                trajectoryCanvas.width = cw;
                trajectoryCanvas.height = ch;
                lastTrajectoryW = cw;
                lastTrajectoryH = ch;
            }
            trajectoryCtx.clearRect(0, 0, cw, ch);

            if (trajectoryData.segments.length === 0 && trajectoryData.points.length === 0) {
                trajectoryScreenPoints = [];
                return;
            }

            // Build view-projection matrix from camera matrix
            const invCam = new Mat4();
            invCam.copy(cameraMatrix).invert();

            const project = (x: number, y: number, z: number): [number, number] | null => {
                // Transform world point to screen
                const fx = 400;
                const fy = 400;
                const cx = cw / 2;
                const cy = ch / 2;
                // Apply inverse camera
                const px = invCam.data[0] * x + invCam.data[1] * y + invCam.data[2] * z + invCam.data[3];
                const py = invCam.data[4] * x + invCam.data[5] * y + invCam.data[6] * z + invCam.data[7];
                const pz = invCam.data[8] * x + invCam.data[9] * y + invCam.data[10] * z + invCam.data[11];
                if (pz <= 0.01) return null;
                const sx = (px / pz) * fx + cx;
                const sy = -(py / pz) * fy + cy;
                return [sx, sy];
            };

            // Draw segments (straight lines)
            trajectoryCtx.lineWidth = 2;
            for (const seg of trajectoryData.segments) {
                const a = project(seg.a.x, seg.a.y, seg.a.z);
                const b = project(seg.b.x, seg.b.y, seg.b.z);
                if (!a || !b) continue;
                trajectoryCtx.strokeStyle = seg.color;
                trajectoryCtx.beginPath();
                trajectoryCtx.moveTo(a[0], a[1]);
                trajectoryCtx.lineTo(b[0], b[1]);
                trajectoryCtx.stroke();
            }

            // Single pass: project all keyframe points, compute handles, and draw
            trajectoryScreenPoints = [];
            const mousePos = trajectoryMousePos;
            let hoveredIndex = -1;
            let hoveredHandle: { index: number; type: 'in' | 'out' } | null = null;

            for (let i = 0; i < trajectoryData.points.length; i++) {
                const pt = trajectoryData.points[i];
                const s = project(pt.pos.x, pt.pos.y, pt.pos.z);
                if (!s) continue;
                const sx = s[0], sy = s[1];

                // Use pre-computed world-space handle positions from camera-trajectory
                const inEnd = pt.inHandlePos ? project(pt.inHandlePos.x, pt.inHandlePos.y, pt.inHandlePos.z) : null;
                const outEnd = pt.outHandlePos ? project(pt.outHandlePos.x, pt.outHandlePos.y, pt.outHandlePos.z) : null;

                // Cache screen positions for hit testing
                trajectoryScreenPoints.push({
                    x: sx, y: sy, frame: pt.frame,
                    inHandle: inEnd && pt.inTan.length() > 0.001 ? { x: inEnd[0], y: inEnd[1] } : undefined,
                    outHandle: outEnd && pt.outTan.length() > 0.001 ? { x: outEnd[0], y: outEnd[1] } : undefined
                });

                // Check keyframe hover
                if (mousePos && Math.hypot(sx - mousePos.x, sy - mousePos.y) < 12) {
                    hoveredIndex = i;
                }

                // Draw
                const isHovered = hoveredIndex === i;

                // Incoming tangent handle (blue)
                if (inEnd && pt.inTan.length() > 0.001) {
                    const isHandleHovered = hoveredHandle && hoveredHandle.index === i && hoveredHandle.type === 'in';
                    trajectoryCtx.strokeStyle = '#3498db';
                    trajectoryCtx.lineWidth = (isHovered || isHandleHovered) ? 2 : 1;
                    trajectoryCtx.setLineDash([3, 3]);
                    trajectoryCtx.beginPath();
                    trajectoryCtx.moveTo(sx, sy);
                    trajectoryCtx.lineTo(inEnd[0], inEnd[1]);
                    trajectoryCtx.stroke();
                    trajectoryCtx.setLineDash([]);
                    const handleR = isHandleHovered ? 6 : 4;
                    trajectoryCtx.fillStyle = isHandleHovered ? '#85c1e9' : '#3498db';
                    trajectoryCtx.beginPath();
                    trajectoryCtx.arc(inEnd[0], inEnd[1], handleR, 0, Math.PI * 2);
                    trajectoryCtx.fill();
                    if (isHandleHovered) {
                        trajectoryCtx.strokeStyle = '#fff';
                        trajectoryCtx.lineWidth = 1;
                        trajectoryCtx.stroke();
                    }
                }

                // Outgoing tangent handle (red)
                if (outEnd && pt.outTan.length() > 0.001) {
                    const isHandleHovered = hoveredHandle && hoveredHandle.index === i && hoveredHandle.type === 'out';
                    trajectoryCtx.strokeStyle = '#e74c3c';
                    trajectoryCtx.lineWidth = (isHovered || isHandleHovered) ? 2 : 1;
                    trajectoryCtx.setLineDash([3, 3]);
                    trajectoryCtx.beginPath();
                    trajectoryCtx.moveTo(sx, sy);
                    trajectoryCtx.lineTo(outEnd[0], outEnd[1]);
                    trajectoryCtx.stroke();
                    trajectoryCtx.setLineDash([]);
                    const handleR = isHandleHovered ? 6 : 4;
                    trajectoryCtx.fillStyle = isHandleHovered ? '#f1948a' : '#e74c3c';
                    trajectoryCtx.beginPath();
                    trajectoryCtx.arc(outEnd[0], outEnd[1], handleR, 0, Math.PI * 2);
                    trajectoryCtx.fill();
                    if (isHandleHovered) {
                        trajectoryCtx.strokeStyle = '#fff';
                        trajectoryCtx.lineWidth = 1;
                        trajectoryCtx.stroke();
                    }
                }

                // Keyframe glow on hover
                if (isHovered) {
                    trajectoryCtx.fillStyle = 'rgba(255,170,0,0.3)';
                    trajectoryCtx.beginPath();
                    trajectoryCtx.arc(sx, sy, 10, 0, Math.PI * 2);
                    trajectoryCtx.fill();
                }

                trajectoryCtx.fillStyle = isHovered ? '#ffaa00' : '#ff6600';
                trajectoryCtx.beginPath();
                trajectoryCtx.arc(sx, sy, isHovered ? 7 : 5, 0, Math.PI * 2);
                trajectoryCtx.fill();
                trajectoryCtx.strokeStyle = '#fff';
                trajectoryCtx.lineWidth = 1;
                trajectoryCtx.stroke();

                // Frame number label
                trajectoryCtx.fillStyle = '#fff';
                trajectoryCtx.font = '10px sans-serif';
                trajectoryCtx.fillText(String(pt.frame), sx + 10, sy - 10);
            }
        });

        // PreviewWindow update — disabled, CameraPreview (PiP) handles its own rendering
        // events.on('prerender', () => { previewWindow.updateFrame(); });

        // ---- Trajectory interaction (keyframe clicks) ----
        let trajectoryMousePos: { x: number; y: number } | null = null;

        const getNearKeyframe = (mx: number, my: number): { x: number; y: number; frame: number } | null => {
            for (const sp of trajectoryScreenPoints) {
                if (Math.hypot(sp.x - mx, sp.y - my) < 12) return sp;
            }
            return null;
        };

        // Track mouse position on the 3D canvas for trajectory hover effects
        canvas.addEventListener('pointermove', (e: PointerEvent) => {
            if (trajectoryCanvas.style.display === 'none') return;
            const rect = canvas.getBoundingClientRect();
            trajectoryMousePos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        });

        canvas.addEventListener('pointerleave', () => {
            trajectoryMousePos = null;
        });

        canvas.addEventListener('pointerdown', (e: PointerEvent) => {
            if (trajectoryCanvas.style.display === 'none') return;
            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;

            if (trajectoryScreenPoints.length === 0) return;

            // Check keyframe click
            const kf = getNearKeyframe(mx, my);
            if (kf) {
                events.fire('timeline.setFrame', kf.frame);
            }
        });

        // main container
        const mainContainer = new Container({
            id: 'main-container'
        });

        const timelinePanel = new TimelinePanel(events, tooltips);
        const dataPanel = new DataPanel(events, tooltips);
        const statusBar = new StatusBar(events, tooltips);

        timelinePanel.hidden = true;

        mainContainer.append(canvasContainer);
        mainContainer.append(timelinePanel);
        mainContainer.append(dataPanel);
        mainContainer.append(statusBar);

        // Wire up status bar panel toggles
        let currentPanel = '';
        events.on('statusBar.panelChanged', (panel: string | null) => {
            currentPanel = panel || '';
            timelinePanel.hidden = panel !== 'timeline';
            dataPanel.hidden = panel !== 'splatData';
        });
        events.function('statusBar.panel', () => currentPanel);

        editorContainer.append(mainContainer);

        // message popup
        const popup = new Popup(tooltips);

        // shortcuts popup
        const shortcutsPopup = new ShortcutsPopup(events);

        // export popup
        const exportPopup = new ExportPopup(events);

        // publish settings
        const publishSettingsDialog = new PublishSettingsDialog(events);

        // image settings
        const imageSettingsDialog = new ImageSettingsDialog(events);

        // video settings
        const videoSettingsDialog = new VideoSettingsDialog(events);

        // turntable video settings
        const turntableVideoDialog = new TurntableVideoDialog(events);

        // about popup
        const aboutPopup = new AboutPopup();

        topContainer.append(popup);
        topContainer.append(exportPopup);
        topContainer.append(publishSettingsDialog);
        topContainer.append(imageSettingsDialog);
        topContainer.append(videoSettingsDialog);
        topContainer.append(turntableVideoDialog);
        topContainer.append(shortcutsPopup);
        topContainer.append(aboutPopup);

        appContainer.append(editorContainer);
        appContainer.append(topContainer);
        appContainer.append(tooltipsContainer);

        this.appContainer = appContainer;
        this.topContainer = topContainer;
        this.canvasContainer = canvasContainer;
        this.toolsContainer = toolsContainer;
        this.canvas = canvas;
        this.popup = popup;
        this.tooltips = tooltips;

        document.body.appendChild(appContainer.dom);
        document.body.setAttribute('tabIndex', '-1');

        // right-click context menu on the canvas
        new ContextMenu(events, canvasContainer);

        events.on('show.shortcuts', () => {
            shortcutsPopup.hidden = false;
        });

        events.function('show.exportPopup', (exportType, splatNames: [string], showFilenameEdit: boolean) => {
            return exportPopup.show(exportType, splatNames, showFilenameEdit);
        });

        events.function('show.publishSettingsDialog', async () => {
            // show popup if user isn't logged in
            const userStatus = await events.invoke('publish.userStatus');
            if (!userStatus) {
                await events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('popup.error'),
                    message: i18n.t('popup.publish.please-log-in')
                });
                return false;
            }

            // get user publish settings
            const publishSettings = await publishSettingsDialog.show(userStatus);

            // do publish
            if (publishSettings) {
                await events.invoke('scene.publish', publishSettings);
            }
        });

        events.function('show.turntableVideoDialog', async () => {
            const settings = await turntableVideoDialog.show();

            if (settings) {
                try {
                    let fileExtension: string;
                    let filePickerTypes: FilePickerAcceptType[];

                    const codecNames: Record<string, string> = {
                        'h264': 'H.264',
                        'h265': 'H.265',
                        'vp9': 'VP9',
                        'av1': 'AV1'
                    };
                    const codecName = codecNames[settings.codec] || settings.codec.toUpperCase();

                    if (settings.format === 'webm') {
                        fileExtension = '.webm';
                        filePickerTypes = [{
                            description: `WebM Video (${codecName})`,
                            accept: { 'video/webm': ['.webm'] }
                        }];
                    } else if (settings.format === 'mov') {
                        fileExtension = '.mov';
                        filePickerTypes = [{
                            description: `MOV Video (${codecName})`,
                            accept: { 'video/quicktime': ['.mov'] }
                        }];
                    } else if (settings.format === 'mkv') {
                        fileExtension = '.mkv';
                        filePickerTypes = [{
                            description: `MKV Video (${codecName})`,
                            accept: { 'video/x-matroska': ['.mkv'] }
                        }];
                    } else {
                        fileExtension = '.mp4';
                        filePickerTypes = [{
                            description: `MP4 Video (${codecName})`,
                            accept: { 'video/mp4': ['.mp4'] }
                        }];
                    }

                    const suggested = `${events.invoke('render.baseFilename')}_turntable${fileExtension}`;

                    let writable;
                    let fileHandle: FileSystemFileHandle | undefined;

                    if (window.showSaveFilePicker) {
                        fileHandle = await window.showSaveFilePicker({
                            id: 'SplatRoomTurntableVideoExport',
                            types: filePickerTypes,
                            suggestedName: suggested
                        });

                        writable = await fileHandle.createWritable();
                    }

                    const result = await events.invoke('render.turntableVideo', settings, writable);

                    if (result === false && fileHandle?.remove) {
                        await fileHandle.remove();
                    }
                } catch (error) {
                    if (error instanceof DOMException && error.name === 'AbortError') {
                        return;
                    }

                    await events.invoke('showPopup', {
                        type: 'error',
                        header: i18n.t('panel.render.failed'),
                        message: `'${(error as any).message ?? error}'`
                    });
                }
            }
        });

        events.function('show.imageSettingsDialog', async () => {
            const imageSettings = await imageSettingsDialog.show();

            if (imageSettings) {
                try {
                    let writable;
                    let fileHandle: FileSystemFileHandle | undefined;

                    const imageFileTypes: Record<string, { description: string, accept: Record<`${string}/${string}`, `.${string}`[]>, extension: string }> = {
                        png: { description: 'PNG Image', accept: { 'image/png': ['.png'] }, extension: '.png' },
                        jpeg: { description: 'JPEG Image', accept: { 'image/jpeg': ['.jpg', '.jpeg'] }, extension: '.jpg' },
                        webp: { description: 'WebP Image', accept: { 'image/webp': ['.webp'] }, extension: '.webp' }
                    };
                    const imageFileType = imageFileTypes[imageSettings.format];

                    if (window.showSaveFilePicker) {
                        fileHandle = await window.showSaveFilePicker({
                            id: 'SplatRoomImageFileExport',
                            types: [{
                                description: imageFileType.description,
                                accept: imageFileType.accept
                            }],
                            suggestedName: `${events.invoke('render.baseFilename')}${imageFileType.extension}`
                        });

                        writable = await fileHandle.createWritable();
                    }

                    const result = await events.invoke('render.image', imageSettings, writable);

                    // if the render failed, remove the empty file left on disk
                    if (result === false && fileHandle?.remove) {
                        await fileHandle.remove();
                    }
                } catch (error) {
                    if (error instanceof DOMException && error.name === 'AbortError') {
                        // user cancelled save dialog
                        return;
                    }

                    await events.invoke('showPopup', {
                        type: 'error',
                        header: i18n.t('panel.render.failed'),
                        message: `'${error.message ?? error}'`
                    });
                }
            }
        });

        events.function('show.videoSettingsDialog', async () => {
            const videoSettings = await videoSettingsDialog.show();

            if (videoSettings) {

                try {
                    // Determine file extension and mime type based on format
                    let fileExtension: string;
                    let filePickerTypes: FilePickerAcceptType[];

                    // Codec name mapping for display
                    const codecNames: Record<string, string> = {
                        'h264': 'H.264',
                        'h265': 'H.265',
                        'vp9': 'VP9',
                        'av1': 'AV1'
                    };
                    const codecName = codecNames[videoSettings.codec] || videoSettings.codec.toUpperCase();

                    if (videoSettings.format === 'webm') {
                        fileExtension = '.webm';
                        filePickerTypes = [{
                            description: `WebM Video (${codecName})`,
                            accept: { 'video/webm': ['.webm'] }
                        }];
                    } else if (videoSettings.format === 'mov') {
                        fileExtension = '.mov';
                        filePickerTypes = [{
                            description: `MOV Video (${codecName})`,
                            accept: { 'video/quicktime': ['.mov'] }
                        }];
                    } else if (videoSettings.format === 'mkv') {
                        fileExtension = '.mkv';
                        filePickerTypes = [{
                            description: `MKV Video (${codecName})`,
                            accept: { 'video/x-matroska': ['.mkv'] }
                        }];
                    } else {
                        fileExtension = '.mp4';
                        filePickerTypes = [{
                            description: `MP4 Video (${codecName})`,
                            accept: { 'video/mp4': ['.mp4'] }
                        }];
                    }

                    const suggested = `${events.invoke('render.baseFilename')}${fileExtension}`;

                    let writable;
                    let fileHandle: FileSystemFileHandle | undefined;

                    if (window.showSaveFilePicker) {
                        fileHandle = await window.showSaveFilePicker({
                            id: 'SplatRoomVideoFileExport',
                            types: filePickerTypes,
                            suggestedName: suggested
                        });

                        writable = await fileHandle.createWritable();
                    }

                    const result = await events.invoke('render.video', videoSettings, writable);

                    // if the render was cancelled, remove the empty file left on disk
                    if (result === false && fileHandle?.remove) {
                        await fileHandle.remove();
                    }
                } catch (error) {
                    if (error instanceof DOMException && error.name === 'AbortError') {
                        // user cancelled save dialog
                        return;
                    }

                    await events.invoke('showPopup', {
                        type: 'error',
                        header: i18n.t('panel.render.failed'),
                        message: `'${error.message ?? error}'`
                    });
                }
            }
        });

        events.on('show.about', () => {
            aboutPopup.hidden = false;
        });

        events.function('showPopup', (options: ShowOptions) => {
            return this.popup.show(options);
        });

        // spinner with reference counting to handle nested operations
        const spinner = new Spinner();
        topContainer.append(spinner);

        let spinnerCount = 0;

        events.on('startSpinner', () => {
            spinnerCount++;
            if (spinnerCount === 1) {
                spinner.hidden = false;
            }
        });

        events.on('stopSpinner', () => {
            spinnerCount = Math.max(0, spinnerCount - 1);
            if (spinnerCount === 0) {
                spinner.hidden = true;
            }
        });

        // progress

        const progress = new Progress();

        topContainer.append(progress);

        events.on('progressStart', (header: string, cancellable?: boolean) => {
            progress.hidden = false;
            progress.setHeader(header);
            progress.setText('');
            progress.setProgress(0);
            progress.showCancelButton(!!cancellable);
            progress.onCancel = cancellable ? () => events.fire('progressCancel') : null;
        });

        events.on('progressUpdate', (options: { text?: string, progress?: number }) => {
            if (options.text !== undefined) {
                progress.setText(options.text);
            }
            if (options.progress !== undefined) {
                progress.setProgress(options.progress);
            }
        });

        events.on('progressEnd', () => {
            progress.hidden = true;
            progress.showCancelButton(false);
            progress.onCancel = null;
        });

        // initialize canvas to correct size before creating graphics device etc
        const pixelRatio = window.devicePixelRatio;
        canvas.width = Math.ceil(canvasContainer.dom.offsetWidth * pixelRatio);
        canvas.height = Math.ceil(canvasContainer.dom.offsetHeight * pixelRatio);

        ['contextmenu', 'gesturestart', 'gesturechange', 'gestureend'].forEach((event) => {
            document.addEventListener(event, (e) => {
                e.preventDefault();
            }, true);
        });

        // whenever the canvas container is clicked, set keyboard focus on the body
        canvasContainer.dom.addEventListener('pointerdown', (event: PointerEvent) => {
            // set focus on the body if user is busy pressing on the canvas or a child of the tools
            // element
            if (event.target === canvas || toolsContainer.dom.contains(event.target as Node)) {
                document.body.focus();
            }
        }, true);

    }
}

export { EditorUI };
