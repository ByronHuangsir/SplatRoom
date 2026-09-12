// gamepad-capture.ts - 手柄截屏 (PNG) + 视频录制 (WebM)。
// 移植自 3DGS-Gamepad v3，toast 文案接入 i18n。

import { Events } from '../events';
import { Scene } from '../scene/scene';
import { i18n } from '../ui/localization';

const timestamp = () => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// 轨迹采样单帧（"frames" 模式，每输出帧一条；对齐 v1.3.0 轨迹模板）
interface TrajectoryFrame {
    position: [number, number, number];
    target: [number, number, number];
    up: [number, number, number];
    fov: number;
}

declare global {
    interface Window {
        gamepadApi?: {
            saveFile: (payload: {
                data: ArrayBuffer;
                type: string;
                suggestedName: string;
            }) => Promise<boolean>;
        };
    }
}

class GamepadCapture {
    private scene: Scene;
    private canvas: HTMLCanvasElement;
    private events: Events;
    private recording = false;
    private mediaRecorder: MediaRecorder | null = null;
    private stream: MediaStream | null = null;
    private chunks: Blob[] = [];
    // 轨迹录制状态（录制视频时同步采样相机轨迹，30fps，随视频同名导出）
    private trajectoryFrames: TrajectoryFrame[] = [];
    private trajectoryLastSample = 0;
    private readonly TRAJECTORY_FPS = 30;
    private recIndicator: HTMLElement | null = null;
    private toastEl: HTMLElement | null = null;
    private toastTimer: number | null = null;

    constructor(scene: Scene, canvas: HTMLCanvasElement, events: Events) {
        this.scene = scene;
        this.canvas = canvas;
        this.events = events;

        events.on('gamepad.capture', () => {
            this.capture();
        });
        events.on('gamepad.recordToggle', () => {
            this.toggleRecording();
        });
        events.on('gamepad.originSet', () => {
            this.showToast(i18n.t('gamepad.toast.origin-set'));
        });
        events.on('update', () => {
            if (this.recording) {
                this.scene.forceRender = true;
                this.sampleTrajectory();
            }
        });
        this.buildIndicator();
    }

    // --- Screenshot ---
    private async capture() {
        const scene = this.scene;
        const maxTex = scene.graphicsDevice.maxTextureSize;
        const width = Math.min(this.canvas.width, maxTex);
        const height = Math.min(this.canvas.height, maxTex);
        if (width < 2 || height < 2) return;

        try {
            scene.camera.startOffscreenMode(width, height);
            scene.camera.renderOverlays = false;
            scene.gizmoLayer.enabled = false;
            const bgClr = this.events.invoke('bgClr');
            if (bgClr) scene.camera.clearPass.setClearColor(bgClr);
            scene.forceRender = true;
            await this.postRender();

            const { mainTarget, workTarget } = scene.camera;
            scene.dataProcessor.copyRt(mainTarget, workTarget);
            const data = new Uint8Array(width * height * 4);
            await workTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workTarget, data });

            // Flip vertically (WebGL origin is bottom-left)
            const line = new Uint8Array(width * 4);
            for (let y = 0; y < height / 2; y++) {
                const top = y * width * 4;
                const bottom = (height - y - 1) * width * 4;
                line.set(data.subarray(top, top + width * 4));
                data.copyWithin(top, bottom, bottom + width * 4);
                data.set(line, bottom);
            }

            const blob = await this.encodePng(data, width, height);
            const name = `3DGS-${timestamp()}.png`;
            if (!(await this.saveWithDialog(blob, name))) {
                this.download(blob, name);
            }
        } catch (e) {
            console.warn('截屏失败', e);
        } finally {
            scene.camera.endOffscreenMode();
            scene.camera.renderOverlays = true;
            scene.gizmoLayer.enabled = true;
            scene.camera.camera.clearColor.set(0, 0, 0, 0);
        }
    }

    private postRender(): Promise<void> {
        return new Promise((resolve) => {
            const handle = this.scene.events.on('postrender', () => {
                handle.off(); resolve();
            });
        });
    }

    private async encodePng(data: Uint8Array, width: number, height: number): Promise<Blob> {
        // 拷贝为独立 Uint8ClampedArray（避免 SharedArrayBuffer 泛型类型问题）
        const imageData = new ImageData(new Uint8ClampedArray(data), width, height);
        if (typeof OffscreenCanvas !== 'undefined') {
            const canvas = new OffscreenCanvas(width, height);
            const context = canvas.getContext('2d');
            if (!context) throw new Error('failed to create 2d context');
            context.putImageData(imageData, 0, 0);
            return await canvas.convertToBlob({ type: 'image/png' });
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('failed to create 2d context');
        context.putImageData(imageData, 0, 0);
        return new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(b => (b ? resolve(b) : reject(new Error('failed to encode png'))), 'image/png');
        });
    }

    // --- Video recording ---
    private toggleRecording() {
        if (this.recording) {
            this.stopRecording();
        } else {
            this.startRecording();
        }
    }

    private startRecording() {
        if (this.recording) return;
        let stream: MediaStream;
        try {
            stream = this.canvas.captureStream(30);
        } catch (e) {
            console.warn('captureStream unavailable', e);
            this.showToast(i18n.t('gamepad.toast.rec-unsupported'));
            return;
        }
        let mimeType = '';
        if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) mimeType = 'video/webm;codecs=vp9';
        else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) mimeType = 'video/webm;codecs=vp8';
        else if (MediaRecorder.isTypeSupported('video/webm')) mimeType = 'video/webm';
        let recorder: MediaRecorder;
        try {
            recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        } catch (e) {
            recorder = new MediaRecorder(stream);
        }
        this.stream = stream;
        this.mediaRecorder = recorder;
        this.chunks = [];
        recorder.ondataavailable = (e: BlobEvent) => {
            if (e.data && e.data.size > 0) this.chunks.push(e.data);
        };
        recorder.onstop = () => this.onRecordingStopped();
        recorder.start(250);
        this.recording = true;
        this.trajectoryFrames = [];
        this.trajectoryLastSample = 0;
        this.setRecIndicator(true);
        this.showToast(i18n.t('gamepad.toast.rec-start'));
    }

    private stopRecording() {
        if (!this.recording || !this.mediaRecorder) return;
        if (this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.stop();
        } else {
            this.recording = false; this.setRecIndicator(false);
        }
    }

    private async onRecordingStopped() {
        this.recording = false;
        this.setRecIndicator(false);
        const recorder = this.mediaRecorder;
        const stream = this.stream;
        this.mediaRecorder = null;
        this.stream = null;
        if (stream) {
            stream.getTracks().forEach(t => t.stop());
        }
        const type = recorder?.mimeType || 'video/webm';
        const blob = new Blob(this.chunks, { type });
        this.chunks = [];
        // 视频与轨迹共用时间戳前缀，文件名一一对应
        const baseName = `3DGS-${timestamp()}`;
        if (!(await this.saveWithDialog(blob, `${baseName}.webm`))) {
            this.download(blob, `${baseName}.webm`);
        }
        await this.saveTrajectory(baseName);
    }

    // --- Trajectory recording（v1.3.0：视频录制同时采样相机轨迹） ---

    /** 每输出帧（30fps）采样一次相机姿态，匹配 captureStream 帧率。 */
    private sampleTrajectory() {
        const now = performance.now();
        const interval = 1000 / this.TRAJECTORY_FPS;
        if (now - this.trajectoryLastSample < interval) return;
        this.trajectoryLastSample = now;

        const cam = this.scene.camera;
        const pos = cam.position;
        const target = cam.focalPoint;
        const up = cam.worldTransform.getY();

        // 轨迹规格使用垂直 FOV；PlayCanvas 横屏时暴露水平 FOV，需转换
        let fov = cam.fov;
        const camComponent = cam.camera;
        if (camComponent.horizontalFov) {
            const { width, height } = cam.targetSize;
            if (width > 0 && height > 0) {
                const hRad = fov * Math.PI / 180;
                fov = 2 * Math.atan(Math.tan(hRad / 2) * (height / width)) * 180 / Math.PI;
            }
        }

        this.trajectoryFrames.push({
            position: [pos.x, pos.y, pos.z],
            target: [target.x, target.y, target.z],
            up: [up.x, up.y, up.z],
            fov
        });
    }

    /** 将采样轨迹序列化为 "frames" 模式 JSON 并随视频导出（同前缀）。 */
    private async saveTrajectory(baseName: string) {
        if (this.trajectoryFrames.length === 0) {
            this.trajectoryFrames = [];
            return;
        }
        const json = {
            _meta: {
                formatVersion: 1,
                mode: 'one-sample-per-output-frame',
                outputFps: this.TRAJECTORY_FPS,
                coordinateSystem: 'right-handed, Y-up, camera forward is local -Z'
            },
            frames: this.trajectoryFrames
        };
        this.trajectoryFrames = [];
        const text = JSON.stringify(json, null, 2);
        const blob = new Blob([text], { type: 'application/json' });
        const name = `${baseName}.trajectory.json`;
        if (!(await this.saveWithDialog(blob, name))) {
            this.download(blob, name);
        }
    }

    // --- Save / download ---
    private async saveWithDialog(blob: Blob, suggestedName: string): Promise<boolean> {
        const api = window.gamepadApi;
        if (!api?.saveFile) return false;
        try {
            return await api.saveFile({ data: await blob.arrayBuffer(), type: blob.type || 'application/octet-stream', suggestedName });
        } catch (e) {
            console.warn('native save failed', e); return false;
        }
    }

    private download(blob: Blob, filename: string) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    // --- Feedback UI ---
    private buildIndicator() {
        this.recIndicator = document.createElement('div');
        this.recIndicator.className = 'gps-rec-indicator';
        this.recIndicator.innerHTML = '<span class="dot"></span><span></span>';
        this.recIndicator.querySelector('span:last-child')!.textContent = i18n.t('gamepad.toast.recording');
        this.recIndicator.style.display = 'none';
        document.body.appendChild(this.recIndicator);
    }

    private setRecIndicator(on: boolean) {
        if (!this.recIndicator) return;
        this.recIndicator.style.display = on ? 'flex' : 'none';
    }

    private showToast(message: string) {
        if (!this.toastEl) {
            this.toastEl = document.createElement('div');
            this.toastEl.className = 'gps-toast';
            document.body.appendChild(this.toastEl);
        }
        this.toastEl.textContent = message;
        this.toastEl.classList.add('on');
        if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
        this.toastTimer = window.setTimeout(() => this.toastEl?.classList.remove('on'), 1800);
    }
}

export { GamepadCapture };
