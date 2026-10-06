import { Events } from '../core/events';

/**
 * 音频轨道管理器（SplatRoom 音频模块）
 *
 * 两条音频轨道（人声/音乐），采用独立 Web Audio API（不依赖 PlayCanvas
 * 音频系统）：
 *   - 导入：文件（mp3/wav/ogg/m4a 等）→ decodeAudioData → 波形峰值
 *   - 录制：getUserMedia + MediaRecorder → blob → decodeAudioData
 *   - 播放：AudioBufferSourceNode + GainNode，按时间线帧调度；
 *     音乐轨道支持淡入/淡出（音量渐变）
 *   - Trim：clip 的 trimStart/trimEnd 控制音频内可见范围
 *     （两头拉动隐藏多余音频）
 *
 * 事件：
 *   audio.clips         — 查询全部 clips
 *   audio.addClip       — 添加 clip { track, name, buffer, peaks }
 *   audio.removeClip    — 移除 clip { id }
 *   audio.setPosition   — 移动 clip 在时间线上的位置 { id, startFrame }
 *   audio.setTrim        — 设置音频内可见范围 { id, trimStart, trimEnd }
 *   audio.setFade        — 设置淡入/淡出时长 { id, which: 'in'|'out', seconds }
 *   audio.toggleRecord   — 开始/停止人声录制
 *   audio.recording      — 查询是否正在录制
 */

export type AudioTrackKind = 'voice' | 'music';

export interface AudioClip {
    id: string;
    track: AudioTrackKind;
    name: string;
    buffer: AudioBuffer;
    /** 降采样波形峰值（0..1），用于时间线显示 */
    peaks: Float32Array;
    /** clip 在时间线上的起始帧 */
    startFrame: number;
    /** 音频内可见起始（秒，相对 buffer 开头） */
    trimStart: number;
    /** 音频内可见结束（秒，相对 buffer 开头） */
    trimEnd: number;
    /** 音乐淡入时长（秒，相对可见起始）；0 = 关闭 */
    fadeIn: number;
    /** 音乐淡出时长（秒，相对可见结束）；0 = 关闭 */
    fadeOut: number;
}

/** 波形显示宽度（像素）对应的采样柱数 */
const WAVE_BUCKETS = 256;

class AudioManager {
    private events: Events;
    private clips: AudioClip[] = [];
    private ctx: AudioContext | null = null;
    private gainNodes = new Map<string, GainNode>();
    private sources = new Map<string, AudioBufferSourceNode>();
    private seq = 0;

    // 录制状态
    private recording = false;
    private mediaRecorder: MediaRecorder | null = null;
    private mediaStream: MediaStream | null = null;
    private recChunks: Blob[] = [];

    constructor(events: Events) {
        this.events = events;
    }

    /** 惰性创建 AudioContext（需用户手势后调用/resume） */
    ensureContext(): AudioContext {
        if (!this.ctx) {
            const AC = window.AudioContext || (window as any).webkitAudioContext;
            this.ctx = new AC();
        }
        if (this.ctx.state === 'suspended') {
            this.ctx.resume().catch(() => { /* best-effort */ });
        }
        return this.ctx;
    }

    /** 停止一切播放（时间线暂停/停止时调用） */
    stopAll() {
        for (const [id, node] of this.sources) {
            try {
                node.stop();
            } catch {
                /* already stopped */
            }
        }
        this.sources.clear();
        this.gainNodes.clear();
    }

    /** 导入音频文件 */
    async importClip(track: AudioTrackKind, file: File): Promise<AudioClip> {
        const arrayBuffer = await file.arrayBuffer();
        const ctx = this.ensureContext();
        const buffer = await ctx.decodeAudioData(arrayBuffer);
        return this.createClip(track, file.name.replace(/\.[^.]+$/, ''), buffer);
    }

    /** 创建 clip（导入/录制共用）；超过时间线长度的部分默认裁剪 */
    private createClip(track: AudioTrackKind, name: string, buffer: AudioBuffer): AudioClip {
        const clip: AudioClip = {
            id: `audio-${++this.seq}`,
            track,
            name,
            buffer,
            peaks: this.computePeaks(buffer),
            startFrame: Math.round(this.events.invoke('timeline.frame') ?? 0),
            trimStart: 0,
            trimEnd: buffer.duration,
            fadeIn: track === 'music' ? 1 : 0,
            fadeOut: track === 'music' ? 1 : 0
        };
        // 超过时间线长度：默认裁剪为时间线剩余长度
        this.trimToTimeline(clip);
        this.clips.push(clip);
        this.events.fire('audio.changed');
        return clip;
    }

    /**
     * 把 clip 的可见范围裁剪到时间线长度（从 startFrame 起不超出最后一帧）。
     * 拖拽过程中临时超出，松开后调用恢复裁剪。
     */
    private trimToTimeline(clip: AudioClip) {
        const frames = (this.events.invoke('timeline.frames') as number) ?? 180;
        const frameRate = (this.events.invoke('timeline.frameRate') as number) ?? 30;
        const maxEndSec = clip.startFrame / frameRate + (frames - clip.startFrame) / frameRate;
        const maxDurSec = Math.max(0, maxEndSec - clip.startFrame);
        const avail = Math.max(0, Math.min(maxDurSec, clip.buffer.duration));
        if (avail > 0 && avail < clip.trimEnd - clip.trimStart) {
            clip.trimEnd = clip.trimStart + avail;
        }
    }

    /** 计算波形峰值（每柱取该区间内最大绝对值） */
    private computePeaks(buffer: AudioBuffer): Float32Array {
        const data = buffer.getChannelData(0);
        const peaks = new Float32Array(WAVE_BUCKETS);
        const per = Math.max(1, Math.floor(data.length / WAVE_BUCKETS));
        for (let i = 0; i < WAVE_BUCKETS; i++) {
            let max = 0;
            const start = i * per;
            const end = Math.min(data.length, start + per);
            for (let j = start; j < end; j++) {
                const a = Math.abs(data[j]);
                if (a > max) max = a;
            }
            peaks[i] = max;
        }
        return peaks;
    }

    // ---- 录制 ----

    /** 切换人声录制（开始/停止） */
    toggleRecord(): Promise<AudioClip | null> {
        if (this.recording) {
            return this.stopRecord();
        }
        return this.startRecord();
    }

    private async startRecord(): Promise<AudioClip | null> {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.ensureContext();
            let mimeType = '';
            if (MediaRecorder.isTypeSupported('audio/webm')) mimeType = 'audio/webm';
            else if (MediaRecorder.isTypeSupported('audio/mp4')) mimeType = 'audio/mp4';
            const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
            this.mediaRecorder = recorder;
            this.mediaStream = stream;
            this.recChunks = [];
            recorder.ondataavailable = (e) => {
                if (e.data.size > 0) this.recChunks.push(e.data);
            };
            recorder.start();
            this.recording = true;
            this.events.fire('audio.recordingChanged', true);
            return null;
        } catch (e) {
            console.error('[AudioManager] 录音启动失败', e);
            return null;
        }
    }

    private async stopRecord(): Promise<AudioClip | null> {
        const recorder = this.mediaRecorder;
        const stream = this.mediaStream;
        this.mediaRecorder = null;
        this.mediaStream = null;
        this.recording = false;
        this.events.fire('audio.recordingChanged', false);
        if (!recorder) return null;

        const blob = await new Promise<Blob>((resolve) => {
            recorder.onstop = () => {
                const type = recorder.mimeType || 'audio/webm';
                resolve(new Blob(this.recChunks, { type }));
            };
            recorder.stop();
        });
        stream?.getTracks().forEach(t => t.stop());
        this.recChunks = [];

        try {
            const arrayBuffer = await blob.arrayBuffer();
            const ctx = this.ensureContext();
            const buffer = await ctx.decodeAudioData(arrayBuffer);
            return this.createClip('voice', '人声录制', buffer);
        } catch (e) {
            console.error('[AudioManager] 录音解码失败', e);
            return null;
        }
    }

    // ---- 播放调度（按时间线帧） ----

    /**
     * 每帧调用：驱动所有 clip 的播放/停止与音量。
     * @param frame - 当前时间线帧（浮点）
     * @param frameRate - 帧率
     */
    updatePlayback(frame: number, frameRate: number) {
        const ctx = this.ctx;
        if (!ctx) return;
        for (const clip of this.clips) {
            const durSec = clip.trimEnd - clip.trimStart;
            const totalFrames = Math.max(1, durSec * frameRate);
            const relFrame = frame - clip.startFrame;
            const playing = relFrame >= 0 && relFrame < totalFrames;

            if (playing) {
                const tInAudio = clip.trimStart + relFrame / frameRate;
                let node = this.sources.get(clip.id);
                if (!node) {
                    node = ctx.createBufferSource();
                    node.buffer = clip.buffer;
                    const gain = ctx.createGain();
                    node.connect(gain).connect(ctx.destination);
                    this.sources.set(clip.id, node);
                    this.gainNodes.set(clip.id, gain);
                    const startOffset = Math.max(0, tInAudio);
                    node.start(0, startOffset);
                    // 只播放可见范围
                    node.onended = () => {
                        if (this.sources.get(clip.id) === node) {
                            this.sources.delete(clip.id);
                            this.gainNodes.delete(clip.id);
                        }
                    };
                }
                // 音量：音乐轨道应用淡入/淡出
                const gain = this.gainNodes.get(clip.id);
                if (gain) {
                    gain.gain.value = this.computeGain(clip, relFrame / frameRate);
                }
            } else {
                const node = this.sources.get(clip.id);
                if (node) {
                    try {
                        node.stop();
                    } catch {
                        /* noop */
                    }
                    this.sources.delete(clip.id);
                    this.gainNodes.delete(clip.id);
                }
            }
        }
    }

    /** 计算某 clip 在"相对 trim 起始"时刻的音量（音乐淡入/淡出） */
    private computeGain(clip: AudioClip, t: number): number {
        if (clip.track !== 'music') return 1;
        const dur = clip.trimEnd - clip.trimStart;
        let g = 1;
        if (clip.fadeIn > 0 && t < clip.fadeIn) {
            g = Math.min(g, Math.max(0, t / clip.fadeIn));
        }
        if (clip.fadeOut > 0 && t > dur - clip.fadeOut) {
            g = Math.min(g, Math.max(0, (dur - t) / clip.fadeOut));
        }
        return g;
    }

    // ---- 修改接口 ----

    removeClip(id: string) {
        const idx = this.clips.findIndex(c => c.id === id);
        if (idx === -1) return;
        const node = this.sources.get(id);
        if (node) {
            try {
                node.stop();
            } catch {
                /* noop */
            }
        }
        this.sources.delete(id);
        this.gainNodes.delete(id);
        this.clips.splice(idx, 1);
        this.events.fire('audio.changed');
    }

    setPosition(id: string, startFrame: number) {
        const clip = this.clips.find(c => c.id === id);
        if (!clip) return;
        clip.startFrame = Math.max(0, Math.round(startFrame));
        this.events.fire('audio.changed');
    }

    /** 拖拽结束：移动后自动裁剪回时间线长度 */
    setPositionClipped(id: string, startFrame: number) {
        this.setPosition(id, startFrame);
        const clip = this.clips.find(c => c.id === id);
        if (clip) {
            // 保留当前可见时长，仅裁剪超出部分
            const dur = clip.trimEnd - clip.trimStart;
            this.trimToTimeline(clip);
            // 若完全未超出，保持原时长（trimToTimeline 只在超长时裁剪）
            if (clip.trimEnd - clip.trimStart < dur - 0.01) {
                // 已裁剪：trimStart 保持，trimEnd 被压回
                this.events.fire('audio.changed');
            }
        }
    }

    setTrim(id: string, trimStart: number, trimEnd: number) {
        const clip = this.clips.find(c => c.id === id);
        if (!clip) return;
        clip.trimStart = Math.max(0, Math.min(trimStart, clip.buffer.duration));
        clip.trimEnd = Math.max(clip.trimStart + 0.01, Math.min(trimEnd, clip.buffer.duration));
        this.events.fire('audio.changed');
    }

    setFade(id: string, which: 'in' | 'out', seconds: number) {
        const clip = this.clips.find(c => c.id === id);
        if (!clip) return;
        const dur = clip.trimEnd - clip.trimStart;
        const v = Math.max(0, Math.min(dur, seconds));
        if (which === 'in') clip.fadeIn = v;
        else clip.fadeOut = v;
        this.events.fire('audio.changed');
    }

    getClips(): AudioClip[] {
        return this.clips.map(c => ({ ...c, buffer: c.buffer }));
    }

    isRecording(): boolean {
        return this.recording;
    }
}

/** 注册音频事件（main() 调用） */
export const registerAudioEvents = (events: Events, getFrameRate: () => number) => {
    let manager: AudioManager | null = null;

    const getManager = (): AudioManager => {
        if (!manager) manager = new AudioManager(events);
        return manager;
    };

    events.function('audio.clips', () => getManager().getClips());
    events.function('audio.recording', () => getManager().isRecording());

    events.on('audio.import', async (track: AudioTrackKind, file: File) => {
        const clip = await getManager().importClip(track, file);
        if (clip) events.fire('audio.changed');
    });

    events.on('audio.toggleRecord', async () => {
        const clip = await getManager().toggleRecord();
        if (clip) events.fire('audio.changed');
    });

    events.on('audio.removeClip', (id: string) => {
        getManager().removeClip(id);
    });

    events.on('audio.setPosition', (id: string, startFrame: number) => {
        getManager().setPosition(id, startFrame);
    });

    events.on('audio.setPositionClipped', (id: string, startFrame: number) => {
        getManager().setPositionClipped(id, startFrame);
    });

    events.on('audio.setTrim', (id: string, trimStart: number, trimEnd: number) => {
        getManager().setTrim(id, trimStart, trimEnd);
    });

    events.on('audio.setFade', (id: string, which: 'in' | 'out', seconds: number) => {
        getManager().setFade(id, which, seconds);
    });

    // 音频只在时间线播放时跟随（timeline.time 由播放循环 fire）。
    // 不用 timeline.frame（点击/拖拽播放头也会 fire，会导致选择预设时
    // 误触发播放）。
    events.on('timeline.time', (time: number) => {
        const fr = getFrameRate();
        getManager().updatePlayback(time, fr);
    });
    events.on('timeline.playing', (playing: boolean) => {
        if (!playing) getManager().stopAll();
    });
};
