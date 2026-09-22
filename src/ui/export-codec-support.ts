/**
 * 运行时（异步）的编码器支持查询 —— 导出分辨率策略的第二道筛子。
 *
 * 两道筛子分工（第十八轮）：
 *   ① **静态**：`src/core/export-resolution.ts` 的 `CODEC_CEILING` —— 按实测的编解码器维度上限，
 *      把"任何机器都不可能支持"的组合先排除（例：H.264 编不了 8K；8192×8192 连 VP9/AV1 都不行）；
 *   ② **运行时**：这份文件用 `VideoEncoder.isConfigSupported()` 问本机 —— 例：H.265 在规格内、
 *      但这台机器根本没有 H.265 编码器（实测所有分辨率都被拒）。
 *
 * 结果按 `codec:WxH:fps` 缓存（问一次就够；`isConfigSupported` 每次约 1–3 ms，但下拉每次
 * change 都问一遍没必要）。任何异常都当"不支持"处理 —— 宁可让 UI 拦下，也不要让用户点了导出
 * 才在 `configure()` 上炸。
 */

import { codecSupportsSize } from '../core/export-resolution';

/**
 * 各编码器发给 WebCodecs 的 codec 字符串 —— **必须与 `src/app/render.ts` 的 `CODEC_CONFIG` 一致**，
 * 否则"问支持"和"真去编"问的不是同一件事（`verify-export-resolution.mts` 里有一条防漂移断言：
 * 它直接读 `render.ts` 的源码文本，比对这里的字符串）。
 *
 * 注意 H.264 是**分档**的（< 1080 用 Baseline 4.0，其余用 High 5.1），所以按高度取。
 */
export const codecStringFor = (codec: string, height: number): string => {
    switch (codec) {
        case 'h264': return height < 1080 ? 'avc1.420028' : 'avc1.640033';
        case 'h265': return 'hev1.1.6.L120.B0';
        case 'vp9': return 'vp09.00.10.08';
        case 'av1': return 'av01.0.05M.08';
        default: return codec;
    }
};

/** 便于断言/展示的静态表（h264 那条是"高分辨率档"） */
export const CODEC_STRINGS: Record<string, string> = {
    h264: 'avc1.640033',
    h264Low: 'avc1.420028',
    h265: 'hev1.1.6.L120.B0',
    vp9: 'vp09.00.10.08',
    av1: 'av01.0.05M.08'
};

const cache = new Map<string, boolean>();

/** 清缓存（探针/套件改分辨率策略时可以重置） */
export const clearCodecSupportCache = () => cache.clear();

/**
 * 这个编码器在这台机器上、这个尺寸下能不能编。
 *
 * @param codec - 'h264' | 'h265' | 'vp9' | 'av1'
 * @param width - 输出宽
 * @param height - 输出高
 * @param bitrate - 码率（bps）；给 0 时用一个够大的默认值（`isConfigSupported` 几乎不看它）
 * @param frameRate - 帧率
 */
export const isCodecSupportedAt = async (
    codec: string, width: number, height: number, bitrate = 0, frameRate = 30
): Promise<boolean> => {
    // 静态上限先拦一道（省一次问询，也保证结果与纯函数套件一致）
    if (!codecSupportsSize(codec, width, height)) {
        return false;
    }
    const key = `${codec}:${width}x${height}:${frameRate}`;
    const hit = cache.get(key);
    if (hit !== undefined) {
        return hit;
    }

    let supported = false;
    try {
        const enc: any = (globalThis as any).VideoEncoder;
        if (typeof enc?.isConfigSupported === 'function') {
            const r = await enc.isConfigSupported({
                codec: codecStringFor(codec, height),
                width,
                height,
                bitrate: bitrate > 0 ? bitrate : Math.floor(10 * width * height * frameRate * 0.01),
                framerate: frameRate
            });
            supported = !!r?.supported;
        }
    } catch {
        supported = false;
    }
    cache.set(key, supported);
    return supported;
};

/** 一批编码器里，这台机器这个尺寸下可用的那些（保持传入顺序 = 偏好顺序） */
export const supportedCodecsAt = async (
    codecs: readonly string[], width: number, height: number, bitrate = 0, frameRate = 30
): Promise<string[]> => {
    const out: string[] = [];
    for (const c of codecs) {
        // 顺序问（`isConfigSupported` 很快，而且顺序结果便于复现）
        if (await isCodecSupportedAt(c, width, height, bitrate, frameRate)) {
            out.push(c);
        }
    }
    return out;
};
