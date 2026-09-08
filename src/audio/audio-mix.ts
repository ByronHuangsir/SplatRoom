import type { AudioClip } from './audio-manager';

/**
 * 音频混音（渲染导出用）
 *
 * 把时间线音频 clips 按时间线帧混合成一条 Web Audio AudioBuffer，
 * 供视频渲染逐帧提取样本写入输出音轨（AudioSampleSource）。
 *
 * 混音规则：
 *   - 每个 clip 在时间线上的位置 = startFrame / frameRate（秒）
 *   - clip 内可见范围 = [trimStart, trimEnd]（音频内秒数）
 *   - 时间线帧 t（秒）→ 若落在某个 clip 的可见区间内，取该 clip 在
 *     对应音频时刻的样本，乘以其音量（人声=1；音乐=淡入/淡出曲线）
 *   - 多个 clip 叠加（简单相加，clamp 防削波）
 */

/** 输出采样率 */
const MIX_SAMPLE_RATE = 48000;

/** 提取某个 clip 在音频内时刻 t 的增益（与播放逻辑一致） */
function clipGainAt(clip: AudioClip, tAudio: number): number {
    if (clip.track !== 'music') return 1;
    const dur = clip.trimEnd - clip.trimStart;
    const t = tAudio - clip.trimStart;
    let g = 1;
    if (clip.fadeIn > 0 && t < clip.fadeIn) {
        g = Math.min(g, Math.max(0, t / clip.fadeIn));
    }
    if (clip.fadeOut > 0 && t > dur - clip.fadeOut) {
        g = Math.min(g, Math.max(0, (dur - t) / clip.fadeOut));
    }
    return g;
}

/**
 * 预混音：生成从时间线 0 秒开始、总长 durationSec 的立体声 PCM 数据
 * （Web Audio AudioBuffer，48kHz）。若无任何 clip 返回 null。
 * 结果直接交给 mediabunny AudioBufferSource.add() 写入输出音轨
 * （transform.sampleRate 可再重采样到编码采样率）。
 *
 * @param clips - 音频 clips
 * @param frameRate - 时间线帧率
 * @param durationSec - 导出总时长（秒）
 */
export function buildMixBuffer(
    clips: AudioClip[],
    frameRate: number,
    durationSec: number
): AudioBuffer | null {
    if (!clips || clips.length === 0) return null;

    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const sampleRate = MIX_SAMPLE_RATE;
    const totalFrames = Math.max(1, Math.ceil(durationSec * sampleRate));
    // 双声道立体声
    const outL = new Float32Array(totalFrames);
    const outR = new Float32Array(totalFrames);

    for (const clip of clips) {
        if (clip.buffer.duration <= 0) continue;
        const clipStartSec = clip.startFrame / frameRate;
        // clip 在时间线上的可见起止（秒）
        const clipEndSec = clipStartSec + (clip.trimEnd - clip.trimStart);
        if (clipEndSec <= 0 || clipStartSec > durationSec) continue;

        const srcData = clip.buffer.getChannelData(0);
        const srcRate = clip.buffer.sampleRate;
        const srcLen = srcData.length;

        // 覆盖导出区间
        const startI = Math.max(0, Math.floor(clipStartSec * sampleRate));
        const endI = Math.min(totalFrames, Math.ceil(clipEndSec * sampleRate));
        for (let i = startI; i < endI; i++) {
            const tTimeline = i / sampleRate;
            const tAudio = clip.trimStart + (tTimeline - clipStartSec);
            if (tAudio < clip.trimStart || tAudio >= clip.trimEnd) continue;

            // 线性插值重采样
            const pos = tAudio * srcRate;
            const i0 = Math.floor(pos);
            if (i0 < 0 || i0 >= srcLen) continue;
            const i1 = Math.min(srcLen - 1, i0 + 1);
            const frac = pos - i0;
            const sample = srcData[i0] * (1 - frac) + srcData[i1] * frac;

            const g = clipGainAt(clip, tAudio);
            outL[i] += sample * g;
            outR[i] += sample * g;
        }
    }

    // 简单削波保护
    for (let i = 0; i < totalFrames; i++) {
        outL[i] = Math.max(-1, Math.min(1, outL[i]));
        outR[i] = Math.max(-1, Math.min(1, outR[i]));
    }

    // 打包为立体声 AudioBuffer
    const buffer = ctx.createBuffer(2, totalFrames, sampleRate);
    buffer.copyToChannel(outL, 0);
    buffer.copyToChannel(outR, 1);
    return buffer;
}
