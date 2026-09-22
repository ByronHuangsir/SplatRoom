import { WebPCodec } from '@playcanvas/splat-transform';
import { AudioBufferSource, BufferTarget, EncodedPacket, EncodedVideoPacketSource, getEncodableAudioCodecs, MkvOutputFormat, MovOutputFormat, Mp4OutputFormat, Output, StreamTarget, WebMOutputFormat } from 'mediabunny';
import { Color, path, Quat, Vec3 } from 'playcanvas';

import { buildMixBuffer } from '../audio/audio-mix';
import { Events } from '../core/events';
import { encodePng } from '../core/png-writer';
import { ElementType } from '../scene/element';
import { EquirectRenderer } from '../scene/equirect-renderer';
import { Scene } from '../scene/scene';
import { injectSphericalMetadata } from '../splat/spherical-metadata';
import { Splat } from '../splat/splat';
import { i18n } from '../ui/localization';

/**
 * 渲染回读的像素行序：**WebGL2 的 framebuffer 回读是自下而上**（要先翻），而 **WebGPU 的
 * copyTextureToBuffer 本身就是自上而下**（再翻就整张上下颠倒）。以前这里四份导出代码都无条件翻了一次，
 * 于是 WebGPU（打包版默认后端）导出的图片 / 视频 / 关键帧 / 快照全是上下颠倒的 —— 用户 3.16.0 报的
 * "渲染里面的几个都是反的"。picker.ts 早就是按 backend 判断的，这里改成同一套约定。
 */
const flipReadbackIfNeeded = (data: Uint8Array, width: number, height: number, device: { isWebGL2: boolean }) => {
    if (!device.isWebGL2) {
        return;
    }
    const line = new Uint8Array(width * 4);
    for (let y = 0; y < Math.floor(height / 2); y++) {
        const top = y * width * 4;
        const bottom = (height - 1 - y) * width * 4;
        line.set(data.subarray(top, top + width * 4));
        data.copyWithin(top, bottom, bottom + width * 4);
        data.set(line, bottom);
    }
};


const nullClr = new Color(0, 0, 0, 0);

/**
 * 若时间线存在音频 clips，向输出添加音频轨（混音写入）。
 * 在 output.start() 之前调用；返回清理函数（输出结束后关闭音源）。
 *
 * @param output - mediabunny Output 实例
 * @param events - 事件总线（读取 audio.clips / timeline.frameRate）
 * @param durationSec - 导出总时长（秒）
 * @returns { close, done }：close 关闭音源；done 为音频写入完成 promise（finalize 前应 await）
 */
// 音频轨控制句柄：start() 在 output.start() 之后调用以写入混音样本；
// done 在 start 完成后 resolve（getter 保证读取到的是最新 promise）。
interface OutputAudioTrackHandle {
    start: () => Promise<void>;
    close: () => void;
    readonly done: Promise<void>;
}

async function addOutputAudioTrack(output: Output<any, any>, events: Events, durationSec: number): Promise<OutputAudioTrackHandle | null> {
    const clips = (events.invoke('audio.clips') as any[]) ?? [];
    if (!clips || clips.length === 0) return null;

    const frameRate = (events.invoke('timeline.frameRate') as number) ?? 30;
    // clips 从事件总线拿到的是浅拷贝（buffer 引用同一 AudioBuffer）
    const mix = buildMixBuffer(clips as any, frameRate, durationSec);
    if (!mix) {
        console.warn('[render] 音频混音生成失败（buildMixBuffer 返回 null）');
        return null;
    }

    // 动态选择可用的音频编码器：mp4/mov 优先 aac，webm/mkv 优先 opus。
    // 部分 Electron/浏览器不提供 AAC 编码器 → 硬编码会写入失败无声。
    // 候选顺序按容器偏好 + 兜底 pcm-s16（几乎总是可用）。
    const container = (output.format as any).constructor?.name ?? '';
    const preferOpus = /webm|mkv/i.test(container);
    const candidates: ('aac' | 'opus' | 'mp3' | 'vorbis' | 'flac' | 'pcm-s16')[] = preferOpus ?
        ['opus', 'aac', 'mp3', 'vorbis', 'pcm-s16'] :
        ['aac', 'opus', 'mp3', 'vorbis', 'pcm-s16'];

    let codec: 'aac' | 'opus' | 'mp3' | 'vorbis' | 'flac' | 'pcm-s16' | null = null;
    try {
        const encodable = await getEncodableAudioCodecs();
        // 若检测失败（返回空数组），仍尝试首选（add 时会抛错暴露）
        codec = candidates.find(c => encodable.includes(c)) ?? null;
        console.log(`[render] 可用音频编码器: ${encodable.join(',') || '无'}; 选用: ${codec ?? '无'}`);
    } catch (err) {
        console.warn('[render] 音频编码器检测失败', err);
        codec = candidates[0];
    }

    if (!codec) {
        console.warn('[render] 无可用音频编码器，导出不含音轨');
        return null;
    }

    const audioSource = new AudioBufferSource({
        codec,
        bitrate: 128_000,
        transform: {
            sampleRate: 48000,
            numberOfChannels: 2
        }
    });
    output.addAudioTrack(audioSource);

    // 音频样本必须在 output.start() 之后写入：mediabunny 的 _ensureValidAdd()
    // 在 output 状态为 pending 时抛 "Output has not started."，若在 start 前
    // 调用 audioSource.add() 会被下面的 catch 吞掉，导出的视频无声。
    // 因此这里只连接轨道，样本写入推迟到 start()（由调用方在 start 后调用）。
    let donePromise: Promise<void> = Promise.resolve();
    let started = false;
    const start = () => {
        if (started) return donePromise;
        started = true;
        donePromise = audioSource.add(mix)
        .then(() => {
            audioSource.close();
        })
        .catch((err) => {
            console.warn('[render] 音频轨写入失败', err);
        });
        return donePromise;
    };

    return {
        start,
        close: () => {
            try {
                audioSource.close();
            } catch {
                /* noop */
            }
        },
        get done() {
            return donePromise;
        }
    };
}

// Lookup maps for video output format and codec configuration
const FORMAT_CONFIG: Record<string, { create: (streaming: boolean) => Mp4OutputFormat | MovOutputFormat | MkvOutputFormat | WebMOutputFormat; extension: string }> = {
    mp4: { create: streaming => new Mp4OutputFormat({ fastStart: streaming ? false : 'in-memory' }), extension: 'mp4' },
    webm: { create: () => new WebMOutputFormat(), extension: 'webm' },
    mov: { create: streaming => new MovOutputFormat({ fastStart: streaming ? false : 'in-memory' }), extension: 'mov' },
    mkv: { create: () => new MkvOutputFormat(), extension: 'mkv' }
};

const CODEC_CONFIG: Record<string, { type: 'avc' | 'hevc' | 'vp9' | 'av1'; codec: (height: number) => string }> = {
    h264: { type: 'avc', codec: h => (h < 1080 ? 'avc1.420028' : 'avc1.640033') }, // H.264 Constrained Baseline/High profile
    h265: { type: 'hevc', codec: () => 'hev1.1.6.L120.B0' },                       // H.265 Main profile, Level 4.0
    vp9: { type: 'vp9', codec: () => 'vp09.00.10.08' },                            // VP9 Profile 0, Level 1.0
    av1: { type: 'av1', codec: () => 'av01.0.05M.08' }                             // AV1 Main Profile, Level 3.1
};

type ImageSettings = {
    width: number;
    height: number;
    transparentBg: boolean;
    showDebug: boolean;
    format: 'png' | 'jpeg' | 'webp';
    quality?: number;           // 0..1, jpeg only
    projection?: 'standard' | 'equirect';
    levelHorizon?: boolean;
};

type VideoSettings = {
    startFrame: number;
    endFrame: number;
    frameRate: number;
    width: number;
    height: number;
    bitrate: number;
    transparentBg: boolean;
    showDebug: boolean;
    format: 'mp4' | 'webm' | 'mov' | 'mkv';
    codec: 'h264' | 'h265' | 'vp9' | 'av1';
    projection?: 'standard' | 'equirect';
    levelHorizon?: boolean;
};

const removeExtension = (filename: string) => {
    return filename.substring(0, filename.length - path.getExtension(filename).length);
};

const isInvalidFilenameChar = (char: string) => {
    return /[<>:"/\\|?*]/.test(char) || char.charCodeAt(0) < 32;
};

const sanitizeFilename = (filename: string) => {
    const sanitized = Array.from(filename, char => (isInvalidFilenameChar(char) ? '_' : char)).join('').trim();
    return sanitized.length > 0 ? sanitized : 'splatroom';
};

// extract a plain filename from url-style names (e.g. splats imported via ?load=)
const getImportedFilename = (filename: string) => {
    const trimmed = filename.split(/[?#]/)[0];

    if (trimmed.includes('://') || trimmed.startsWith('blob:')) {
        try {
            return path.getBasename(new URL(trimmed).pathname);
        } catch {
            // fall through to the raw filename below
        }
    }

    return path.getBasename(trimmed);
};

// sort splats and wait for the sort to complete (or a timeout fallback).
// NOTE: the original comment promised a "1s timeout" but none existed —
// `sorter.once('updated')` could wait forever when an instance's sorter
// never fires 'updated' (e.g. the group-merged entity's sorter is driven by
// the onPreRender force-dispatch, which only runs inside app.render() — the
// export loop awaits sortAndWait BEFORE rendering, so it can deadlock).
// With the timeout the export can never hang: the frame falls back to the
// last available order and continues.
const sortSplatsAndWait = (scene: Scene, splats: Splat[]) => {
    const instances: any[] = [];
    for (const splat of splats) {
        const inst = splat.entity.gsplat?.instance;
        if (inst) instances.push(inst);
    }
    // The merged group entity renders as ONE unified instance on the splatLayer;
    // it must be re-sorted per export frame too, or it renders with a stale
    // (last main-view) ordering → flicker / wrong transparency in exports.
    if (scene.groupRenderer?.isActive) {
        const mergedInst = (scene.groupRenderer as any).mergedEntity?.gsplat?.instance;
        if (mergedInst) instances.push(mergedInst);
    }
    return Promise.all(instances.map(instance => waitForSort(instance, scene, 1000)));
};

// Strict variant: longer timeout (no visible jump during normal turntable
// exports, which can take ~300 ms per frame on huge models), but still
// bounded so a deadlocked sorter can never hang the whole export.
const sortSplatsAndWaitStrict = (scene: Scene, splats: Splat[]) => {
    const instances: any[] = [];
    for (const splat of splats) {
        const inst = splat.entity.gsplat?.instance;
        if (inst) instances.push(inst);
    }
    if (scene.groupRenderer?.isActive) {
        const mergedInst = (scene.groupRenderer as any).mergedEntity?.gsplat?.instance;
        if (mergedInst) instances.push(mergedInst);
    }
    return Promise.all(instances.map(instance => waitForSort(instance, scene, 2000)));
};

// Trigger a sort on one instance and wait for 'updated', with a bounded
// timeout fallback so a non-responding sorter can never deadlock the export.
const waitForSort = (instance: any, scene: Scene, timeoutMs: number) => {
    return new Promise<void>((resolve) => {
        const sorter = instance.sorter;
        if (!sorter) {
            resolve();
            return;
        }
        const onUpdated = () => resolve();
        sorter.once('updated', onUpdated);
        instance.sort(scene.camera.mainCamera);
        setTimeout(() => {
            sorter.off('updated', onUpdated);
            console.warn(`[render] sortAndWait timeout (${timeoutMs}ms) on "${instance.entity?.name ?? 'instance'}" — using last available order`);
            resolve();
        }, timeoutMs);
    });
};

const downloadFile = (data: ArrayBuffer | Uint8Array<ArrayBuffer>, filename: string, type = 'application/octet-stream') => {
    const blob = new Blob([data], { type });
    const url = window.URL.createObjectURL(blob);
    const el = document.createElement('a');
    el.download = filename;
    el.href = url;
    el.click();
    window.URL.revokeObjectURL(url);
};

// Pick an output folder for multi-file exports. Prefers the native Electron
// main-process dialog (exposed as window.splatroomFS), which is not subject to
// the transient user-activation requirement that makes the web File System
// Access picker fail after await chains. Falls back to showDirectoryPicker in
// plain browsers. Returns a path string or a FileSystemDirectoryHandle.
const pickOutputDir = async (): Promise<FileSystemDirectoryHandle | string | undefined> => {
    const fsApi = window.splatroomFS;
    if (fsApi?.pickDirectory) {
        try {
            const dirPath = await fsApi.pickDirectory();
            if (typeof dirPath === 'string' && dirPath.length > 0) {
                return dirPath;
            }
        } catch (e) {
            // fall through to File System Access
        }
    }
    if (typeof window !== 'undefined' && 'showDirectoryPicker' in window) {
        try {
            const dir = await (window as any).showDirectoryPicker({
                id: 'SplatRoomKeyframeExport',
                mode: 'readwrite'
            });
            return dir as FileSystemDirectoryHandle;
        } catch (e) {
            return undefined;
        }
    }
    return undefined;
};

const registerRenderEvents = (scene: Scene, events: Events) => {
    let webpCodec: WebPCodec;

    // default base filename for rendered output: the project document name if
    // set, otherwise the first visible splat's name
    const baseFilename = () => {
        const docName = events.invoke('doc.name');
        const splats = (scene.getElementsByType(ElementType.splat) as Splat[]).filter(splat => splat.visible);
        const source = docName || (splats[0]?.name ?? 'splatroom');
        return sanitizeFilename(removeExtension(getImportedFilename(source)));
    };

    events.function('render.baseFilename', baseFilename);

    // wait for postrender to fire
    const postRender = () => {
        return new Promise<boolean>((resolve, reject) => {
            const handle = scene.events.on('postrender', () => {
                handle.off();
                try {
                    resolve(true);
                } catch (error) {
                    reject(error);
                }
            });
        });
    };

    events.function('render.offscreen', async (width: number, height: number): Promise<Uint8Array> => {
        try {
            // start rendering to offscreen buffer only
            scene.camera.startOffscreenMode(width, height);
            scene.camera.renderOverlays = false;
            scene.gizmoLayer.enabled = false;

            // render the next frame
            scene.forceRender = true;

            // for render to finish
            await postRender();

            // cpu-side buffer to read pixels into
            const data = new Uint8Array(width * height * 4);

            const { mainTarget, workTarget } = scene.camera;

            scene.dataProcessor.copyRt(mainTarget, workTarget);

            // read the rendered frame
            await workTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workTarget, data, immediate: true });

            // flip y positions to have 0,0 at the top
            let line = new Uint8Array(width * 4);
            for (let y = 0; y < height / 2; y++) {
                line = data.slice(y * width * 4, (y + 1) * width * 4);
                data.copyWithin(y * width * 4, (height - y - 1) * width * 4, (height - y) * width * 4);
                data.set(line, (height - y - 1) * width * 4);
            }

            return data;
        } finally {
            scene.camera.endOffscreenMode();
            scene.camera.renderOverlays = true;
            scene.gizmoLayer.enabled = true;
            scene.camera.camera.clearColor.set(0, 0, 0, 0);
        }
    });

    events.function('render.image', async (imageSettings: ImageSettings, fileStream?: FileSystemWritableFileStream) => {
        events.fire('startSpinner');

        let equirect: EquirectRenderer | null = null;
        let savedFov = 0;
        let savedOrtho = false;

        try {
            const { width, height, transparentBg, showDebug, format, quality, projection, levelHorizon } = imageSettings;
            const is360 = projection === 'equirect';

            // in 360 mode the offscreen target is a square cube face; the
            // equirect target holds the output-sized frame
            const faceSize = Math.min(height, scene.graphicsDevice.maxTextureSize);

            // start rendering to offscreen buffer only
            scene.camera.startOffscreenMode(is360 ? faceSize : width, is360 ? faceSize : height);
            scene.camera.renderOverlays = is360 ? false : showDebug;
            scene.gizmoLayer.enabled = false;
            if (!transparentBg) {
                scene.camera.clearPass.setClearColor(events.invoke('bgClr'));
            }

            // cpu-side buffer to read pixels into
            const data = new Uint8Array(width * height * 4);

            if (is360) {
                savedFov = scene.camera.fov;
                savedOrtho = scene.camera.ortho;
                equirect = new EquirectRenderer(scene.graphicsDevice, faceSize, width, height);
                scene.camera.ortho = false;

                // snapshot the current camera pose. splatroom cameras never
                // roll, so with level horizon the capture frame is the
                // camera yaw, otherwise yaw and pitch
                const camPos = new Vec3().copy(scene.camera.position);
                const qCapture = new Quat();
                // Compute azimuth from the main camera's actual rotation instead
                // of scene.camera.azim (which may be stale when poseOverride is active).
                if (levelHorizon ?? true) {
                    const camRot = scene.camera.mainCamera.getRotation();
                    const fwd = new Vec3();
                    camRot.transformVector(Vec3.FORWARD, fwd);
                    qCapture.setFromEulerAngles(0, Math.atan2(-fwd.x, -fwd.z) * (180 / Math.PI), 0);
                } else {
                    qCapture.copy(scene.camera.mainCamera.getRotation());
                }

                // all faces share direction-independent clipping planes so
                // near-plane culling cannot differ across a face boundary
                const boundRadius = scene.bound.halfExtents.length();
                const dist = new Vec3().sub2(scene.bound.center, camPos).length();
                const far = dist + boundRadius;
                const near = Math.max(1e-6, dist < boundRadius ? far / (1024 * 16) : dist - boundRadius);

                const splats = (scene.getElementsByType(ElementType.splat) as Splat[]).filter(splat => splat.visible);
                const qWorld = new Quat();

                for (let face = 0; face < 6; face++) {
                    qWorld.mul2(qCapture, EquirectRenderer.faceRotations[face]);
                    scene.camera.setPoseOverride({ position: camPos, rotation: qWorld, fov: EquirectRenderer.faceFov, near, far });

                    // faces view different directions, so each render must
                    // wait for its own sort
                    await sortSplatsAndWait(scene, splats);

                    // render a frame and wait for it to finish
                    scene.forceRender = true;
                    await postRender();

                    scene.dataProcessor.copyRt(scene.camera.mainTarget, equirect.faceTargets[face]);
                }

                // project the faces to the equirect target and read back
                equirect.project();
                await equirect.read(data);
            } else {
                // render the next frame
                scene.forceRender = true;

                // for render to finish
                await postRender();

                const { mainTarget, workTarget } = scene.camera;

                scene.dataProcessor.copyRt(mainTarget, workTarget);

                // read the rendered frame
                await workTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workTarget, data, immediate: true });
            }

            flipReadbackIfNeeded(data, width, height, scene.app.graphicsDevice);
            let bytes: Uint8Array<ArrayBuffer>;
            let extension: string;
            let mimeType: string;

            if (format === 'png') {
                bytes = await encodePng(data, width, height);
                extension = 'png';
                mimeType = 'image/png';
            } else if (format === 'jpeg') {
                // jpeg has no alpha channel and canvas encoding flattens
                // transparent pixels toward black, so force full opacity
                for (let i = 3; i < data.length; i += 4) {
                    data[i] = 255;
                }

                const imageData = new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width, height);
                let blob: Blob;
                if (typeof OffscreenCanvas !== 'undefined') {
                    const canvas = new OffscreenCanvas(width, height);
                    const context = canvas.getContext('2d');
                    if (!context) {
                        throw new Error('failed to create 2d context');
                    }
                    context.putImageData(imageData, 0, 0);
                    blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: quality ?? 0.9 });
                } else {
                    // fallback for browsers without OffscreenCanvas
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const context = canvas.getContext('2d');
                    if (!context) {
                        throw new Error('failed to create 2d context');
                    }
                    context.putImageData(imageData, 0, 0);
                    blob = await new Promise<Blob>((resolve, reject) => {
                        canvas.toBlob(b => (b ? resolve(b) : reject(new Error('failed to encode jpeg'))), 'image/jpeg', quality ?? 0.9);
                    });
                }
                bytes = new Uint8Array(await blob.arrayBuffer());
                extension = 'jpg';
                mimeType = 'image/jpeg';
            } else {
                // construct the webp codec
                if (!webpCodec) {
                    webpCodec = await WebPCodec.create();
                }

                bytes = webpCodec.encodeLosslessRGBA(data, width, height);
                extension = 'webp';
                mimeType = 'image/webp';
            }

            if (fileStream) {
                await fileStream.write(bytes);
                await fileStream.close();
            } else {
                downloadFile(bytes, `${baseFilename()}.${extension}`, mimeType);
            }

            return true;
        } catch (error) {
            // close the stream even on failure so the caller can remove the
            // empty file
            if (fileStream) {
                try {
                    await fileStream.close();
                } catch {
                    // stream already closed or errored
                }
            }

            await events.invoke('showPopup', {
                type: 'error',
                header: i18n.t('panel.render.failed'),
                message: `'${error.message ?? error}'`
            });

            return false;
        } finally {
            if (equirect) {
                scene.camera.setPoseOverride(null);
                scene.camera.fov = savedFov;
                scene.camera.ortho = savedOrtho;
                equirect.destroy();
                equirect = null;
            }

            scene.camera.endOffscreenMode();
            scene.camera.renderOverlays = true;
            scene.gizmoLayer.enabled = true;
            scene.camera.clearPass.setClearColor(nullClr);

            events.fire('stopSpinner');
        }
    });

    events.function('render.video', (videoSettings: VideoSettings, fileStream: FileSystemWritableFileStream) => {
        const renderImpl = async () => {
            events.fire('progressStart', i18n.t('panel.render.render-video'), true);

            let cancelled = false;
            const cancelHandler = events.on('progressCancel', () => {
                cancelled = true;
            });

            let encoder: VideoEncoder | null = null;
            let equirect: EquirectRenderer | null = null;
            let savedFov = 0;
            let savedOrtho = false;

            try {
                const { startFrame, endFrame, frameRate, width, height, bitrate, transparentBg, showDebug, format, codec: codecChoice, projection, levelHorizon } = videoSettings;

                const is360 = projection === 'equirect';

                // 360 mp4/mov exports have spherical metadata patched into the
                // finished buffer, so they render to memory with moov written
                // last (fastStart false) instead of streaming to disk
                const taggable = is360 && (format === 'mp4' || format === 'mov');

                const target = (fileStream && !taggable) ? new StreamTarget(fileStream) : new BufferTarget();

                // Configure output format and codec from lookup maps (default to mp4/h264)
                const formatConfig = FORMAT_CONFIG[format] ?? FORMAT_CONFIG.mp4;
                const outputFormat = formatConfig.create(taggable || !!fileStream);
                const fileExtension = formatConfig.extension;

                const codecConfig = CODEC_CONFIG[codecChoice] ?? CODEC_CONFIG.h264;
                const codecType = codecConfig.type;
                const codec = codecConfig.codec(height);

                const output = new Output({
                    format: outputFormat,
                    target
                });

                const videoSource = new EncodedVideoPacketSource(codecType);
                output.addVideoTrack(videoSource, {
                    rotation: 0,
                    frameRate
                });

                // 若有音频 clips，添加音频轨（混音）
                const audioFrameRate = events.invoke('timeline.frameRate') as number ?? 30;
                const audioExportDur = (endFrame - startFrame) / audioFrameRate;
                const closeAudio = await addOutputAudioTrack(output, events, audioExportDur);

                await output.start();

                // audioSource.add() must run after output.start() — writing
                // samples to a pending output is rejected and would yield a
                // silent audio track
                closeAudio?.start();

                let encoderError: Error | null = null;

                // helper to create and configure a VideoEncoder instance
                const createEncoder = () => {
                    encoderError = null;
                    const enc = new VideoEncoder({
                        output: async (chunk, meta) => {
                            const encodedPacket = EncodedPacket.fromEncodedChunk(chunk);
                            await videoSource.add(encodedPacket, meta);
                        },
                        error: (error) => {
                            encoderError = error;
                        }
                    });
                    enc.configure({ codec, width, height, bitrate });
                    return enc;
                };

                // fail fast on unsupported configurations (e.g. encoder
                // dimension limits) instead of erroring mid-render
                const support = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate });
                if (!support.supported) {
                    throw new Error(`Unsupported video configuration (${codecChoice} @ ${width}x${height})`);
                }

                encoder = createEncoder();

                // in 360 mode the offscreen target is a square cube face; the
                // equirect target holds the output-sized frame
                const faceSize = Math.min(height, scene.graphicsDevice.maxTextureSize);

                // start rendering to offscreen buffer only
                scene.camera.startOffscreenMode(is360 ? faceSize : width, is360 ? faceSize : height);
                scene.camera.renderOverlays = is360 ? false : showDebug;
                scene.gizmoLayer.enabled = false;
                if (!transparentBg) {
                    scene.camera.clearPass.setClearColor(events.invoke('bgClr'));
                }
                scene.lockedRenderMode = true;

                if (is360) {
                    savedFov = scene.camera.fov;
                    savedOrtho = scene.camera.ortho;
                    equirect = new EquirectRenderer(scene.graphicsDevice, faceSize, width, height);
                    scene.camera.ortho = false;
                }

                // cpu-side buffer to read pixels into
                const data = new Uint8Array(width * height * 4);
                const line = new Uint8Array(width * 4);

                // remember last camera position so we can skip sorting if the camera didn't move
                const last_pos = new Vec3(0, 0, 0);
                const last_forward = new Vec3(1, 0, 0);

                // track whether the first frame has been encoded — the first
                // frame MUST be a keyframe (I-frame) or the decoder cannot
                // decode subsequent P-frames, producing a corrupted/missing
                // first frame in the output video.
                let firstFrameEncoded = false;

                // helper to sort splats and wait for completion
                const sortAndWait = (splats: Splat[]) => sortSplatsAndWait(scene, splats);

                // prepare the frame for rendering, returns the newly loaded splat if any
                const prepareFrame = async (frameTime: number, skipSort = false): Promise<Splat | null> => {
                    // Fire timeline.time for animation interpolation (color track, etc.)
                    events.fire('timeline.time', frameTime);

                    // Apply camera animation keyframes to the main camera.
                    const controller = events.invoke('animation.controller') as any;
                    const cameraTrack = controller?.getTrack?.('camera');
                    const hasCamKeys = cameraTrack && cameraTrack.keys.length > 0;

                    if (hasCamKeys) {
                        const val = cameraTrack.getValueAt?.(frameTime) as number[] | null;
                        if (val && val.length >= 7) {
                            const pos = new Vec3(val[0], val[1], val[2]);
                            const rawTgt = new Vec3(val[3], val[4], val[5]);

                            // For 360 mode: set poseOverride so that capture360
                            // reads the correct camera position and orientation.
                            // The azimuth is now computed directly from the main
                            // camera's rotation, so setPose (orbit tween) is no
                            // longer needed.
                            if (is360) {
                                const animEntity = scene.animCameraEntity;
                                if (animEntity) {
                                    const apos = animEntity.getLocalPosition();
                                    const arot = animEntity.getLocalRotation();
                                    const afov = animEntity.camera.fov;
                                    // Compute near/far from scene bounds
                                    const fwd2 = new Vec3();
                                    arot.transformVector(Vec3.FORWARD, fwd2);
                                    const boundR2 = scene.bound.halfExtents.length();
                                    const cdist2 = new Vec3().sub2(scene.bound.center, apos).dot(fwd2);
                                    const near2 = cdist2 > 0 ?
                                        Math.max(1e-6, cdist2 < boundR2 ? (cdist2 + boundR2) / (1024 * 16) : cdist2 - boundR2) :
                                        1e-6;
                                    const far2 = cdist2 > 0 ? cdist2 + boundR2 : boundR2 * 2;
                                    scene.camera.setPoseOverride({
                                        position: apos.clone(),
                                        rotation: arot.clone(),
                                        fov: afov,
                                        near: near2,
                                        far: far2
                                    });
                                }
                            }

                            // For non-360 mode: use poseOverride to bypass the
                            // orbit camera tween system entirely. Read from the
                            // virtual animation camera entity which the spline
                            // already drove via timeline.time → animCamera.update.
                            // This ensures the camera position/rotation exactly
                            // matches the spline without any orbit conversion
                            // roundtrip or controller interference.
                            if (!is360) {
                                const animEntity = scene.animCameraEntity;
                                if (animEntity) {
                                    const apos = animEntity.getLocalPosition();
                                    const arot = animEntity.getLocalRotation();
                                    const afov = animEntity.camera.fov;

                                    // Compute near/far clipping planes from scene bounds
                                    const fwd = new Vec3();
                                    arot.transformVector(Vec3.FORWARD, fwd);
                                    const bound = scene.bound;
                                    const boundRadius = bound.halfExtents.length();
                                    const centerDist = new Vec3().sub2(bound.center, apos).dot(fwd);
                                    const near = centerDist > 0 ?
                                        Math.max(1e-6, centerDist < boundRadius ? (centerDist + boundRadius) / (1024 * 16) : centerDist - boundRadius) :
                                        1e-6;
                                    const far = centerDist > 0 ? centerDist + boundRadius : boundRadius * 2;

                                    scene.camera.setPoseOverride({
                                        position: apos.clone(),
                                        rotation: arot.clone(),
                                        fov: afov,
                                        near,
                                        far
                                    });
                                }
                            }
                        }
                    } else if (scene.camera.poseOverride) {
                        // No camera keyframes — clear poseOverride so orbit camera controls
                        scene.camera.setPoseOverride(null);
                    }

                    // Wait for PLY sequence to load the frame if present
                    const newSplat = await events.invoke('plysequence.setFrameAsync', Math.floor(frameTime)) as Splat | null;

                    // manually update the camera so position and rotation are correct
                    scene.camera.onUpdate(0);

                    // 360 capture re-sorts per cube face, so skip sorting here
                    if (skipSort) {
                        return newSplat;
                    }

                    // If a new PLY was loaded, sort and wait for completion
                    if (newSplat) {
                        await sortAndWait([newSplat]);
                    } else {
                        // No new PLY - sort existing splats if camera moved
                        const pos = scene.camera.position;
                        const forward = scene.camera.forward;
                        if (!last_pos.equals(pos) || !last_forward.equals(forward)) {
                            last_pos.copy(pos);
                            last_forward.copy(forward);

                            const splats = (scene.getElementsByType(ElementType.splat) as Splat[]).filter(splat => splat.visible);
                            await sortAndWait(splats);
                        }
                    }

                    return newSplat;
                };

                // flip, wrap and submit the pixels currently in the data buffer
                const encodeFrame = async (frameTime: number) => {
                    flipReadbackIfNeeded(data, width, height, scene.app.graphicsDevice);
                    // construct the video frame
                    const videoFrame = new VideoFrame(data, {
                        format: 'RGBA',
                        codedWidth: width,
                        codedHeight: height,
                        timestamp: Math.floor(1e6 * frameTime),
                        duration: Math.floor(1e6 / frameRate)
                    });

                    // wait for encoder queue to drain if necessary (backpressure handling)
                    while (encoder.encodeQueueSize > 5) {
                        await new Promise<void>((resolve) => {
                            setTimeout(resolve, 1);
                        });
                    }

                    // if the codec was reclaimed (e.g. browser backgrounded the tab),
                    // recreate the encoder and continue.
                    // Also force a keyframe for the very first encoded frame so
                    // the decoder can bootstrap the GOP.
                    let forceKeyFrame = !firstFrameEncoded;
                    if (encoder.state === 'closed' && encoderError?.message?.includes('reclaimed')) {
                        encoder = createEncoder();
                        forceKeyFrame = true;
                    }

                    // check for non-recoverable encoder errors
                    if (encoderError) {
                        videoFrame.close();
                        throw encoderError;
                    }

                    encoder.encode(videoFrame, { keyFrame: forceKeyFrame });
                    firstFrameEncoded = true;
                    videoFrame.close();
                };

                // capture the current video frame
                const captureFrame = async (frameTime: number) => {
                    const { mainTarget, workTarget } = scene.camera;

                    scene.dataProcessor.copyRt(mainTarget, workTarget);

                    // read the rendered frame
                    await workTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workTarget, data, immediate: true });

                    await encodeFrame(frameTime);
                };

                const animFrameRate = events.invoke('timeline.frameRate');
                const duration = (endFrame - startFrame) / animFrameRate;
                const totalFrames = Math.floor(duration * frameRate) + 1;

                // work objects for 360 capture
                const camPos = new Vec3();
                const vec = new Vec3();
                const qCapture = new Quat();
                const qWorld = new Quat();

                // capture a 360 frame: render the six cube faces from the
                // animated camera position, re-sorting splats per face
                // direction, then project to equirect and encode
                const capture360 = async (frameTime: number) => {
                    // snapshot the animated camera pose. splatroom cameras
                    // never roll, so with level horizon the capture frame is
                    // the camera yaw, otherwise yaw and pitch
                    camPos.copy(scene.camera.position);
                    if (levelHorizon ?? true) {
                        const camRot = scene.camera.mainCamera.getRotation();
                        const fwd = new Vec3();
                        camRot.transformVector(Vec3.FORWARD, fwd);
                        qCapture.setFromEulerAngles(0, Math.atan2(-fwd.x, -fwd.z) * (180 / Math.PI), 0);
                    } else {
                        qCapture.copy(scene.camera.mainCamera.getRotation());
                    }

                    // all faces share direction-independent clipping planes so
                    // near-plane culling cannot differ across a face boundary
                    const boundRadius = scene.bound.halfExtents.length();
                    const dist = vec.sub2(scene.bound.center, camPos).length();
                    const far = dist + boundRadius;
                    const near = Math.max(1e-6, dist < boundRadius ? far / (1024 * 16) : dist - boundRadius);

                    const splats = (scene.getElementsByType(ElementType.splat) as Splat[]).filter(splat => splat.visible);

                    for (let face = 0; face < 6; face++) {
                        // check for cancellation
                        if (cancelled) return;

                        qWorld.mul2(qCapture, EquirectRenderer.faceRotations[face]);
                        scene.camera.setPoseOverride({ position: camPos, rotation: qWorld, fov: EquirectRenderer.faceFov, near, far });

                        // faces view different directions, so each render must
                        // wait for its own sort
                        await sortAndWait(splats);

                        // render a frame
                        scene.lockedRender = true;

                        // wait for render to finish
                        await postRender();

                        scene.dataProcessor.copyRt(scene.camera.mainTarget, equirect.faceTargets[face]);

                        const frameIndex = Math.round(frameTime * frameRate);
                        events.fire('progressUpdate', {
                            text: i18n.t('panel.render.rendering', { ellipsis: true }),
                            progress: 100 * (frameIndex + (face + 1) / 6) / totalFrames
                        });
                    }

                    // project the faces to the equirect target and encode
                    equirect.project();
                    await equirect.read(data);
                    await encodeFrame(frameTime);
                };

                for (let frameTime = 0; frameTime <= duration; frameTime += 1.0 / frameRate) {
                    // check for cancellation
                    if (cancelled) break;

                    if (is360) {
                        // restore animated-pose evaluation before the timeline
                        // advances (fov feeds the tween-to-position mapping)
                        scene.camera.setPoseOverride(null);
                        scene.camera.fov = savedFov;

                        // prepare the frame (loads PLY if needed, updates camera)
                        await prepareFrame(startFrame + frameTime * animFrameRate, true);

                        await capture360(frameTime);
                    } else {
                        // prepare the frame (loads PLY if needed, updates camera, sorts)
                        await prepareFrame(startFrame + frameTime * animFrameRate);

                        // render a frame
                        scene.lockedRender = true;

                        // wait for render to finish
                        await postRender();

                        // wait for capture
                        await captureFrame(frameTime);

                        events.fire('progressUpdate', {
                            text: i18n.t('panel.render.rendering', { ellipsis: true }),
                            progress: 100 * frameTime / duration
                        });
                    }
                }

                // Flush and finalize output
                await encoder.flush();
                if (closeAudio) await closeAudio.done;
                await output.finalize();

                const filename = () => `${baseFilename()}.${fileExtension}`;

                if (taggable) {
                    // patch spherical metadata into the finished buffer so
                    // players auto-detect the equirectangular projection
                    if (!cancelled) {
                        let buffer = (target as BufferTarget).buffer;
                        try {
                            buffer = injectSphericalMetadata(buffer);
                        } catch (error) {
                            console.warn(`failed to inject spherical metadata: ${error.message ?? error}`);
                        }

                        if (fileStream) {
                            await fileStream.write(buffer);
                        } else {
                            downloadFile(buffer, filename());
                        }
                    }

                    // close the stream even when cancelled so the caller can
                    // remove the empty file
                    if (fileStream) {
                        await fileStream.close();
                    }
                } else if (!cancelled && !fileStream) {
                    // Download (skip if cancelled -- the caller will delete the file)
                    downloadFile((target as BufferTarget).buffer, filename());
                }

                return !cancelled;
            } catch (error) {
                await events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('panel.render.failed'),
                    message: `'${(error as any).message ?? error}'`
                });
                return false;
            } finally {
                if (encoder && encoder.state !== 'closed') {
                    encoder.close();
                }
                cancelHandler.off();

                // Always clear poseOverride (set for non-360 camera keyframe export)
                scene.camera.setPoseOverride(null);

                if (equirect) {
                    scene.camera.fov = savedFov;
                    scene.camera.ortho = savedOrtho;
                    equirect.destroy();
                    equirect = null;
                }

                scene.camera.endOffscreenMode();
                scene.camera.renderOverlays = true;
                scene.gizmoLayer.enabled = true;
                scene.camera.clearPass.setClearColor(nullClr);
                scene.lockedRenderMode = false;
                scene.forceRender = true;       // camera likely moved, finish with normal render

                events.fire('progressEnd');
            }
        };

        // Acquire a Web Lock during encoding to signal the browser that this tab is
        // actively working, which helps prevent aggressive background throttling and
        // codec reclamation. Shared lock name with turntable render so the two video
        // exports serialize instead of fighting over camera/offscreen state.
        if (navigator.locks) {
            return navigator.locks.request('splatroom-video-render', renderImpl);
        }
        return renderImpl();
    });

    // ----------------------------------------------------------------
    // Keyframe image render — render each camera keyframe as an image
    // ----------------------------------------------------------------
    events.function('render.keyframes', async (imageSettings: ImageSettings, baseDir?: FileSystemDirectoryHandle | string) => {
        events.fire('startSpinner');

        let equirect: EquirectRenderer | null = null;
        let savedFov = 0;
        let savedOrtho = false;
        let cancelled = false;
        const cancelHandler = events.on('progressCancel', () => {
            cancelled = true;
        });

        try {
            // Get camera keyframes from the animation controller
            const controller = events.invoke('animation.controller') as any;
            const cameraTrack = controller?.getTrack?.('camera');
            if (!cameraTrack || !cameraTrack.keys || cameraTrack.keys.length === 0) {
                await events.invoke('showPopup', {
                    type: 'warning',
                    header: i18n.t('panel.render.failed'),
                    message: 'No camera keyframes found in the timeline.'
                });
                return false;
            }

            const keyframeFrames: number[] = cameraTrack.keys.slice().sort((a: number, b: number) => a - b);
            const totalFrames = keyframeFrames.length;

            // Without a target directory every keyframe is downloaded with its
            // own save dialog (N dialogs for N keyframes). If the caller did
            // not provide a directory, ask once how to proceed: pick a folder
            // (native Electron dialog via splatroomFS, or File System Access
            // picker as fallback), or explicitly accept the per-file fallback.
            // This prevents the user from being surprised by N save dialogs.
            let saveDir: FileSystemDirectoryHandle | string | undefined = baseDir;
            if (!saveDir && totalFrames > 1) {
                while (true) {
                    const proceed = await events.invoke('showPopup', {
                        type: 'okcancel',
                        header: i18n.t('menu.render.image.keyframes'),
                        message: i18n.t('menu.render.image.keyframes-no-dir', { count: String(totalFrames) }),
                        buttons: [
                            { label: i18n.t('menu.render.image.keyframes-pick-dir'), action: 'pick-dir' },
                            { label: i18n.t('menu.render.image.keyframes-per-file'), action: 'per-file' }
                        ]
                    });

                    if (proceed.action === 'pick-dir') {
                        saveDir = await pickOutputDir();
                        if (saveDir) break;
                        // cancelled or unavailable — loop back to the dialog
                        continue;
                    }

                    if (proceed.action !== 'per-file') {
                        cancelHandler.off();
                        events.fire('progressEnd');
                        return false;
                    }
                    break;
                }
            }

            const { width, height, transparentBg, showDebug, format, quality, projection, levelHorizon } = imageSettings;
            const is360 = projection === 'equirect';
            const faceSize = Math.min(height, scene.graphicsDevice.maxTextureSize);

            // Save original camera state
            const savedPose = events.invoke('camera.getPose');
            const savedTimelineFrame = events.invoke('timeline.frame') as number ?? 0;

            // Start offscreen rendering
            scene.camera.startOffscreenMode(is360 ? faceSize : width, is360 ? faceSize : height);
            scene.camera.renderOverlays = is360 ? false : showDebug;
            scene.gizmoLayer.enabled = false;
            if (!transparentBg) {
                scene.camera.clearPass.setClearColor(events.invoke('bgClr'));
            }

            // Use lockedRenderMode for explicit frame control during keyframe
            // rendering. This prevents PiP's onPreRender/onPostRender from
            // interfering with sort state and ensures each frame is rendered
            // only when we explicitly request it via scene.lockedRender = true.
            scene.lockedRenderMode = true;

            const data = new Uint8Array(width * height * 4);
            const baseFilename = events.invoke('render.baseFilename') as string;

            // Helper: render a single frame and return pixel data
            const renderSingleFrame = async (): Promise<Uint8Array> => {
                if (is360) {
                    savedFov = scene.camera.fov;
                    savedOrtho = scene.camera.ortho;
                    equirect = new EquirectRenderer(scene.graphicsDevice, faceSize, width, height);
                    scene.camera.ortho = false;

                    const camPos = new Vec3().copy(scene.camera.position);
                    const qCapture = new Quat();
                    if (levelHorizon ?? true) {
                        // Extract azimuth from the main camera's actual rotation.
                        // scene.camera.azim reads from the orbit tween which is
                        // stale when poseOverride is active (keyframe rendering).
                        const camRot = scene.camera.mainCamera.getRotation();
                        const fwd = new Vec3();
                        camRot.transformVector(Vec3.FORWARD, fwd);
                        qCapture.setFromEulerAngles(0, Math.atan2(-fwd.x, -fwd.z) * (180 / Math.PI), 0);
                    } else {
                        qCapture.copy(scene.camera.mainCamera.getRotation());
                    }

                    const boundRadius = scene.bound.halfExtents.length();
                    const dist = new Vec3().sub2(scene.bound.center, camPos).length();
                    const far = dist + boundRadius;
                    const near = Math.max(1e-6, dist < boundRadius ? far / (1024 * 16) : dist - boundRadius);

                    const splats = (scene.getElementsByType(ElementType.splat) as Splat[]).filter(splat => splat.visible);
                    const qWorld = new Quat();

                    for (let face = 0; face < 6; face++) {
                        qWorld.mul2(qCapture, EquirectRenderer.faceRotations[face]);
                        scene.camera.setPoseOverride({ position: camPos, rotation: qWorld, fov: EquirectRenderer.faceFov, near, far });
                        await sortSplatsAndWait(scene, splats);
                        scene.lockedRender = true;
                        await postRender();
                        scene.dataProcessor.copyRt(scene.camera.mainTarget, equirect.faceTargets[face]);
                    }

                    equirect.project();
                    await equirect.read(data);

                    if (equirect) {
                        equirect.destroy();
                        equirect = null;
                    }
                    scene.camera.fov = savedFov;
                    scene.camera.ortho = savedOrtho;
                } else {
                    scene.lockedRender = true;
                    await postRender();

                    const { mainTarget, workTarget } = scene.camera;
                    scene.dataProcessor.copyRt(mainTarget, workTarget);
                    await workTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workTarget, data, immediate: true });
                }

                flipReadbackIfNeeded(data, width, height, scene.app.graphicsDevice);
                return new Uint8Array(data);
            };

            // Helper: encode pixel data to the requested format
            const encodeImage = async (pixels: Uint8Array): Promise<{ bytes: Uint8Array<ArrayBuffer>; extension: string }> => {
                if (format === 'png') {
                    return { bytes: await encodePng(pixels, width, height), extension: 'png' };
                } else if (format === 'jpeg') {
                    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
                    const clamped = new Uint8ClampedArray(pixels.buffer as ArrayBuffer, pixels.byteOffset, pixels.length);
                    const imageData = new ImageData(clamped, width, height);
                    if (typeof OffscreenCanvas !== 'undefined') {
                        const canvas = new OffscreenCanvas(width, height);
                        const context = canvas.getContext('2d')!;
                        context.putImageData(imageData, 0, 0);
                        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: quality ?? 0.9 });
                        return { bytes: new Uint8Array(await blob.arrayBuffer() as ArrayBuffer), extension: 'jpg' };
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const context = canvas.getContext('2d')!;
                    context.putImageData(imageData, 0, 0);
                    const blob = await new Promise<Blob>((resolve, reject) => {
                        canvas.toBlob(b => (b ? resolve(b) : reject(new Error('failed to encode jpeg'))), 'image/jpeg', quality ?? 0.9);
                    });
                    return { bytes: new Uint8Array(await blob.arrayBuffer() as ArrayBuffer), extension: 'jpg' };

                }
                // webp
                if (!webpCodec) {
                    webpCodec = await WebPCodec.create();
                }
                return { bytes: webpCodec.encodeLosslessRGBA(pixels, width, height), extension: 'webp' };

            };

            // Save a single image
            const saveImage = async (pixels: Uint8Array, index: number, frame: number) => {
                const { bytes, extension } = await encodeImage(pixels);
                const fname = `${sanitizeFilename(baseFilename)}_kf${String(index).padStart(2, '0')}_f${frame}.${extension}`;

                if (typeof saveDir === 'string') {
                    // Native path from the main-process folder dialog: write
                    // through IPC (no File System Access permission needed).
                    const fsApi = window.splatroomFS;
                    if (fsApi?.writeFile) {
                        await fsApi.writeFile(saveDir, fname, bytes);
                        return;
                    }
                    downloadFile(bytes, fname, `image/${extension === 'jpg' ? 'jpeg' : extension}`);
                } else if (saveDir) {
                    // File System Access API: write to directory
                    const fileHandle = await saveDir.getFileHandle(fname, { create: true });
                    const writable = await fileHandle.createWritable();
                    await writable.write(bytes);
                    await writable.close();
                } else {
                    // Fallback: download each file
                    downloadFile(bytes, fname, `image/${extension === 'jpg' ? 'jpeg' : extension}`);
                }
            };

            // Process frames with progress
            events.fire('progressStart', i18n.t('menu.render.image.keyframes'), true);

            for (let i = 0; i < totalFrames; i++) {
                if (cancelled) break;

                const frame = keyframeFrames[i];
                events.fire('progressSet', (i / totalFrames) * 100);

                // Drive the virtual animation camera entity to the keyframe pose.
                // timeline.time causes camera-track evaluation, which fires
                // animCamera.update and updates scene.animCameraEntity.
                events.fire('timeline.time', frame);

                const animEntity = scene.animCameraEntity;
                if (!animEntity) continue;

                const apos = animEntity.getLocalPosition();
                const arot = animEntity.getLocalRotation();
                const afov = animEntity.camera.fov;

                // Compute near/far clipping planes from scene bounds
                const fwd = new Vec3();
                arot.transformVector(Vec3.FORWARD, fwd);
                const bound = scene.bound;
                const boundRadius = bound.halfExtents.length();
                const centerDist = new Vec3().sub2(bound.center, apos).dot(fwd);
                const near = centerDist > 0 ?
                    Math.max(1e-6, centerDist < boundRadius ? (centerDist + boundRadius) / (1024 * 16) : centerDist - boundRadius) :
                    1e-6;
                const far = centerDist > 0 ? centerDist + boundRadius : boundRadius * 2;

                // Bypass the orbit camera tween system and set the render camera
                // directly to the animation camera's pose for this keyframe.
                // setPoseOverride already calls onUpdate(0) internally.
                scene.camera.setPoseOverride({
                    position: apos.clone(),
                    rotation: arot.clone(),
                    fov: afov,
                    near,
                    far
                });

                // Sort splats for this camera angle and wait for completion
                const splats = (scene.getElementsByType(ElementType.splat) as Splat[]).filter(splat => splat.visible);
                await sortSplatsAndWait(scene, splats);

                // Render and save
                const pixels = await renderSingleFrame();
                await saveImage(pixels, i, frame);
            }

            // Restore camera state
            events.fire('timeline.time', savedTimelineFrame);
            scene.camera.setPoseOverride(null);
            if (savedPose) {
                // speed = 0 to restore instantly and avoid orbit tween flicker
                events.fire('camera.setPose', {
                    position: savedPose.position,
                    target: savedPose.target,
                    fov: savedPose.fov ?? 60
                }, 0);
                scene.camera.onUpdate(0);
            }

            cancelHandler.off();
            events.fire('progressEnd');

            if (saveDir === undefined && totalFrames > 0) {
                await events.invoke('showPopup', {
                    type: 'info',
                    header: i18n.t('menu.render.image.keyframes'),
                    message: `Rendered ${totalFrames} keyframe images.`
                });
            }

            return true;
        } catch (error) {
            await events.invoke('showPopup', {
                type: 'error',
                header: i18n.t('panel.render.failed'),
                message: `'${(error as any).message ?? error}'`
            });
            return false;
        } finally {
            // Restore normal rendering mode first
            scene.lockedRenderMode = false;

            if (equirect) {
                scene.camera.fov = savedFov;
                scene.camera.ortho = savedOrtho;
                equirect.destroy();
            }

            scene.camera.setPoseOverride(null);
            scene.camera.endOffscreenMode();
            scene.camera.renderOverlays = true;
            scene.gizmoLayer.enabled = true;
            scene.camera.clearPass.setClearColor(nullClr);

            // Always release the cancel listener and hide progress, including on
            // error/cancel — otherwise the listener leaks and the progress bar
            // stays visible after a failed keyframe export.
            cancelHandler.off();
            events.fire('progressEnd');
            events.fire('stopSpinner');
        }
    });

    // ----------------------------------------------------------------
    // Turntable video render — 360° seamless rotating turntable export.
    // mode 'orbit' = camera orbits around the focal point (环绕);
    // mode 'look'  = camera stays put and looks around (环视).
    // ----------------------------------------------------------------
    // 旋转台导出。
    //
    // `format === 'png'` 是**帧序列**（不是视频）：逐帧写 PNG（RGBA，带 alpha）到目录，
    // 配合外部 ffmpeg 合成透明 MOV（本机 Chromium 对所有 codec 都拒绝 `alpha: 'keep'`，
    // 详见 docs/旋转台透明背景视频-探索结论-2026-09-22.md）。此时：
    //   • 不建 muxer/编码器、不混音；
    //   • **不铺背景色**（清屏色保持透明）⇒ 输出帧的背景是 alpha=0；
    //   • `baseDir` 是目标目录（原生路径字符串或 FileSystemDirectoryHandle）。
    events.function('render.turntableVideo', (
        settings: { frameRate: number; width: number; height: number; bitrate: number; format: string; codec: string; mode?: 'orbit' | 'look' },
        fileStream: FileSystemWritableFileStream,
        baseDir?: FileSystemDirectoryHandle | string
    ) => {
        const renderImpl = async () => {
            events.fire('progressStart', i18n.t('menu.render.turntable'), true);

            let cancelled = false;
            const cancelHandler = events.on('progressCancel', () => {
                cancelled = true;
            });

            let encoder: VideoEncoder | null = null;
            let savedFocalPoint: Vec3 | null = null;
            let savedAutoRotateMode: string | null = null;
            let savedControlMode: string | null = null;

            // Pause the live auto-rotation (if the user had the turntable
            // running in the preview viewport) so it does NOT also advance
            // azim while the export loop pushes its own — otherwise the live
            // controller and the export loop fight each other every frame
            // and the rendered view flickers / no longer matches what the user
            // saw. We restore the previous mode when the export ends.
            const previousAutoRotate = (events.invoke('camera.getAutoRotateMode') as string) || 'off';
            events.fire('camera.setAutoRotateMode', 'off');
            savedAutoRotateMode = previousAutoRotate;

            try {
                const { frameRate, width, height, bitrate, format, codec: codecChoice, mode = 'orbit' } = settings;

                // Get current camera state
                const pose = events.invoke('camera.getPose') as any;
                const startAzim = scene.camera.azim;
                const startElev = scene.camera.elevation;
                const speed = events.invoke('camera.getAutoRotateSpeed') as number || 15;

                // Preserve the user's focal point (set via the "focus" tool,
                // e.g. focus X/Y/Z in the left panel) so the turntable orbits
                // around THAT point. The previous behaviour forced focal
                // point to the scene bounding-box centre, which ignored the
                // user's intent and produced a rotation around the wrong axis.
                // `lookCameraPos` may carry a stale value from a previous
                // 'look' (fly) mode — clear it so the orbit calc starts clean.
                savedFocalPoint = scene.camera.focalPoint.clone();
                scene.camera.lookCameraPos = null;
                scene.camera.onUpdate(0);

                // 'look' (环视): the camera stays where it is and only turns
                // its heading. Switching to fly control mode makes
                // camera.adjustHeading() rotate around the camera position
                // instead of the focal point. Restore controlMode at the end.
                if (mode === 'look') {
                    savedControlMode = scene.camera.controlMode;
                    scene.camera.controlMode = 'fly';
                }

                // Calculate total frames for a seamless 360° rotation
                const durationSec = 360 / speed;
                const totalFrames = Math.round(durationSec * frameRate);

                // 帧序列（PNG）：不建 muxer / 编码器 / 音轨
                const isSequence = format === 'png';
                const target = fileStream ? new StreamTarget(fileStream) : new BufferTarget();

                const formatConfig = FORMAT_CONFIG[format] ?? FORMAT_CONFIG.mp4;
                const outputFormat = isSequence ? null : formatConfig.create(!!fileStream);
                const fileExtension = isSequence ? 'png' : formatConfig.extension;

                const codecConfig = CODEC_CONFIG[codecChoice] ?? CODEC_CONFIG.h264;
                const codecType = codecConfig.type;
                const codec = codecConfig.codec(height);

                const output = isSequence ? null : new Output({
                    format: outputFormat!,
                    target
                });

                const videoSource = isSequence ? null : new EncodedVideoPacketSource(codecType);
                if (output && videoSource) {
                    output.addVideoTrack(videoSource, {
                        rotation: 0,
                        frameRate
                    });
                }

                // 若有音频 clips，添加音频轨（混音）；旋转台按总时长混音。
                // 帧序列没有容器可混音 ⇒ 跳过。
                const closeAudio = isSequence ? null : await addOutputAudioTrack(output!, events, durationSec);

                if (output) {
                    await output.start();
                }

                // audioSource.add() must run after output.start() — writing
                // samples to a pending output is rejected and would yield a
                // silent audio track
                closeAudio?.start();

                let encoderError: Error | null = null;

                const createEncoder = () => {
                    encoderError = null;
                    const enc = new VideoEncoder({
                        output: async (chunk, meta) => {
                            const encodedPacket = EncodedPacket.fromEncodedChunk(chunk);
                            await videoSource!.add(encodedPacket, meta);
                        },
                        error: (error) => {
                            encoderError = error;
                        }
                    });
                    enc.configure({ codec, width, height, bitrate });
                    return enc;
                };

                if (!isSequence) {
                    const support = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate });
                    if (!support.supported) {
                        throw new Error(`Unsupported video configuration (${codecChoice} @ ${width}x${height})`);
                    }

                    encoder = createEncoder();
                }

                // Start offscreen rendering
                scene.camera.startOffscreenMode(width, height);
                scene.camera.renderOverlays = false;
                scene.gizmoLayer.enabled = false;
                if (!isSequence) {
                    // 视频：铺背景色（帧序列相反 —— 保持清屏透明，输出带 alpha 的帧）
                    scene.camera.clearPass.setClearColor(events.invoke('bgClr'));
                }
                scene.lockedRenderMode = true;

                // CPU-side buffer
                const data = new Uint8Array(width * height * 4);
                const line = new Uint8Array(width * 4);

                // Remember last camera position for sort optimization
                const last_pos = new Vec3(0, 0, 0);
                const last_forward = new Vec3(1, 0, 0);

                // Strict sort: do NOT time-out (turntable runs every frame for
                // 14M-point models where a single sort takes ~300 ms — a
                // 1 s time-out falls back to the previous frame's order and
                // produces visible jumps in the output video).
                const sortAndWait = (splats: Splat[]) => sortSplatsAndWaitStrict(scene, splats);

                // The turntable rotates at a constant speed, so consecutive
                // frames differ by a fraction of a degree — their depth order
                // is essentially identical. Sorting every frame is the dominant
                // export cost on large models (~300ms/frame at 14M points), so
                // re-sort only every SORT_INTERVAL frames; skipped frames reuse
                // the previous order with no visible difference.
                //
                // O5 (docs/audit/00-总结.md): the interval is now a function of the model size,
                // using the same formula as camera-preview.ts's adaptive throttle. A constant 2
                // meant a 13M export waited ~150ms per frame on the strict sort; sorting every
                // 13th frame brings that to ~23ms. Small models keep the constant 2 — they sort in
                // a few ms anyway, so a tighter interval only buys quality insurance.
                const exportSplatCount = (scene.getElementsByType(ElementType.splat) as Splat[]).reduce((n, splat) => Math.max(n, splat.splatData?.numSplats ?? 0), 0);
                const SORT_INTERVAL = Math.max(2, Math.ceil(exportSplatCount / 1e6));
                let sortSkipCounter = 0;

                // Track first frame for keyframe forcing (same reason as main render)
                let firstFrameEncoded = false;

                // Encode a single frame
                const encodeFrame = async (frameIndex: number) => {
                    // Drive timeline-driven effects (粒子特效 intro/outro 轨道)
                    // per exported frame: map the export frame to a timeline
                    // frame via the timeline's own frame rate so effect clips
                    // progress correctly during the turntable render.
                    const timelineFps = (events.invoke('timeline.frameRate') as number) ?? 30;
                    events.fire('timeline.time', frameIndex / frameRate * timelineFps);

                    if (mode === 'look') {
                        // 环视: camera position stays fixed, only the heading
                        // turns. adjustHeading in fly mode rotates around the
                        // camera position (not the focal point).
                        scene.camera.adjustHeading(360 / totalFrames);
                    } else {
                        // 环绕: distribute 360° evenly across all frames,
                        // orbiting around the user's focal point
                        const azim = startAzim + frameIndex * 360 / totalFrames;
                        scene.camera.setAzimElev(azim, startElev, 0);
                    }

                    // Update camera matrices
                    scene.camera.onUpdate(0);

                    // Sort splats if camera moved (throttled: every Nth frame —
                    // constant-speed turntable means depth order barely changes)
                    const pos = scene.camera.position;
                    const forward = scene.camera.forward;
                    if (!last_pos.equals(pos) || !last_forward.equals(forward)) {
                        last_pos.copy(pos);
                        last_forward.copy(forward);
                        if (sortSkipCounter++ % SORT_INTERVAL === 0) {
                            const splats = (scene.getElementsByType(ElementType.splat) as Splat[]).filter(splat => splat.visible);
                            await sortAndWait(splats);
                        }
                    }

                    // Render
                    scene.lockedRender = true;
                    await postRender();

                    // Read pixels
                    const { workTarget } = scene.camera;
                    scene.dataProcessor.copyRt(scene.camera.mainTarget, workTarget);
                    await workTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workTarget, data, immediate: true });

                    flipReadbackIfNeeded(data, width, height, scene.app.graphicsDevice);

                    if (isSequence) {
                        // 帧序列：直接编 PNG（RGBA，保留 alpha）并写到目录。
                        // 三条落盘通路与 render.keyframes 完全一致：
                        //   ① Electron 原生目录对话框给的路径 → splatroomFS.writeFile（不经 File System Access 权限）
                        //   ② File System Access 的目录句柄
                        //   ③ 兜底：逐个下载
                        const bytes = await encodePng(data, width, height);
                        const base = sanitizeFilename(events.invoke('render.baseFilename') as string);
                        const fname = `${base}_turntable_${mode}_${String(frameIndex).padStart(4, '0')}.png`;
                        if (typeof baseDir === 'string') {
                            const fsApi = window.splatroomFS;
                            if (fsApi?.writeFile) {
                                await fsApi.writeFile(baseDir, fname, bytes);
                            } else {
                                downloadFile(bytes, fname, 'image/png');
                            }
                        } else if (baseDir) {
                            const fileHandle = await (baseDir as FileSystemDirectoryHandle).getFileHandle(fname, { create: true });
                            const writable = await fileHandle.createWritable();
                            await writable.write(bytes);
                            await writable.close();
                        } else {
                            downloadFile(bytes, fname, 'image/png');
                        }
                        // 进度
                        events.fire('progressUpdate', {
                            text: i18n.t('panel.render.rendering', { ellipsis: true }),
                            progress: 100 * (frameIndex + 1) / totalFrames
                        });
                        return;
                    }

                    // Create VideoFrame and encode
                    const videoFrame = new VideoFrame(
                        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
                        {
                            format: 'RGBA',
                            codedWidth: width,
                            codedHeight: height,
                            timestamp: Math.round(frameIndex * 1e6 / frameRate)
                        }
                    );

                    encoder!.encode(videoFrame, { keyFrame: !firstFrameEncoded });
                    firstFrameEncoded = true;
                    videoFrame.close();

                    // Check for encoder errors
                    if (encoderError) throw encoderError;

                    // Progress
                    events.fire('progressUpdate', {
                        text: i18n.t('panel.render.rendering', { ellipsis: true }),
                        progress: 100 * (frameIndex + 1) / totalFrames
                    });
                };

                // Render all frames
                for (let i = 0; i < totalFrames; i++) {
                    if (cancelled) break;
                    await encodeFrame(i);
                }

                // Finalize（帧序列没有编码器/容器/音轨要收尾）
                if (encoder) {
                    await encoder.flush();
                }
                if (closeAudio) await closeAudio.done;
                if (output) await output.finalize();

                scene.camera.setAzimElev(startAzim, startElev, 0);
                scene.camera.setFocalPoint(savedFocalPoint, 0);
                scene.camera.onUpdate(0);

                const filename = () => {
                    const base = events.invoke('render.baseFilename') as string;
                    return `${sanitizeFilename(base)}_turntable_${mode}.${fileExtension}`;
                };

                if (!fileStream && !cancelled && !isSequence) {
                    downloadFile((target as BufferTarget).buffer, filename());
                }

                return !cancelled;
            } catch (error) {
                await events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('panel.render.failed'),
                    message: `'${(error as any).message ?? error}'`
                });
                return false;
            } finally {
                if (encoder && encoder.state !== 'closed') {
                    encoder.close();
                }
                cancelHandler.off();

                // Restore focal point saved before turntable export
                if (savedFocalPoint) {
                    scene.camera.setFocalPoint(savedFocalPoint, 0);
                    scene.camera.onUpdate(0);
                }
                // Resume the preview auto-rotation the user had before the
                // export (so the viewport continues spinning afterwards).
                if (savedAutoRotateMode) {
                    events.fire('camera.setAutoRotateMode', savedAutoRotateMode);
                }
                // Restore the control mode for 'look' (环视) exports
                if (savedControlMode) {
                    scene.camera.controlMode = savedControlMode as 'orbit' | 'fly';
                }

                scene.camera.endOffscreenMode();
                scene.camera.renderOverlays = true;
                scene.gizmoLayer.enabled = true;
                scene.camera.clearPass.setClearColor(nullClr);
                scene.lockedRenderMode = false;
                scene.forceRender = true;

                events.fire('progressEnd');
            }
        };

        if (navigator.locks) {
            return navigator.locks.request('splatroom-video-render', renderImpl);
        }
        return renderImpl();
    });
};

export { ImageSettings, VideoSettings, registerRenderEvents };
export type { TurntableVideoSettings } from '../ui/turntable-video-dialog';
