/**
 * 导出分辨率的上限与预设 —— 三条导出路径（图像 / 视频 / 旋转台）共用一份。
 *
 * 为什么要有这个模块（第十八轮）：8K 这件事一次性会碰到四个墙，散在三份 UI 里各写一遍必然漂移：
 *   ① **设备**：`maxTextureSize` / `limits.maxTextureDimension2D`（本机 16384，够；集显常见 8192 或 4096）；
 *   ② **编码器**：实测（`docs/probes/export-8k.cjs`，WebCodecs `isConfigSupported`）
 *      H.264 到 4096×2048 可以、**8K 直接 rejected**；H.265 本机没有编码器；VP9 / AV1 到 8K 都可以、
 *      8192×8192 不行。⇒ 8K 只能走 VP9/AV1，UI 必须自己切，不能等编码器报错；
 *   ③ **码率**：原来的 `bbpfFactors` 表**没有 8K 这一档** ⇒ `factor` 是 `undefined` ⇒
 *      `bitrate = NaN` ⇒ 编码器配置直接失败。这里是"补一档"还是"算出来"，选了后者：
 *      表里有的用表（保持既有数字不变），表里没有的按像素数折算，**永远不会是 NaN**；
 *   ④ **内存/耗时**：8K RGBA 一帧 126.6 MiB（回读），8K PNG 一帧 ~18.6 MiB / ~1.6 s（本机实测）。
 *
 * 纯函数、无 DOM 依赖 ⇒ 可以在 node 里单测（`docs/verify/verify-export-resolution.mts`）。
 */

export type ExportProjection = 'standard' | 'equirect';

export type ResolutionPreset = {
    /** 下拉里的值（沿用历史 id，别改：`.ssproj` / 套件里有引用） */
    v: string;
    /** 下拉里显示的尺寸文本 */
    t: string;
    width: number;
    height: number;
};

/**
 * 上限 = 8K。
 * 标准 8K 是 7680×4320；360 等距柱状是 2:1，8K 那档取 **8192×4096**（宽度才是 8192）。
 */
export const MAX_EXPORT_DIMENSION = 8192;

/** 标准投影的预设（含 8K） */
export const STANDARD_PRESETS: readonly ResolutionPreset[] = [
    { v: '540', t: '960x540', width: 960, height: 540 },
    { v: '720', t: '1280x720', width: 1280, height: 720 },
    { v: '1080', t: '1920x1080', width: 1920, height: 1080 },
    { v: '1440', t: '2560x1440', width: 2560, height: 1440 },
    { v: '4k', t: '3840x2160', width: 3840, height: 2160 },
    { v: '8k', t: '7680x4320', width: 7680, height: 4320 }
];

/** 360° 等距柱状（2:1）的预设（含 8K） */
export const EQUIRECT_PRESETS: readonly ResolutionPreset[] = [
    { v: '360-1k', t: '1024x512', width: 1024, height: 512 },
    { v: '360-2k', t: '2048x1024', width: 2048, height: 1024 },
    { v: '360-4k', t: '3840x1920', width: 3840, height: 1920 },
    { v: '360-4096', t: '4096x2048', width: 4096, height: 2048 },
    { v: '360-8k', t: '8192x4096', width: 8192, height: 4096 }
];

/** 某个投影下的全部预设 */
export const resolutionPresets = (projection: ExportProjection): readonly ResolutionPreset[] => {
    return projection === 'equirect' ? EQUIRECT_PRESETS : STANDARD_PRESETS;
};

/** 按 id 取预设（两个投影都查一遍，取不到返回 undefined） */
export const presetById = (v: string): ResolutionPreset | undefined => {
    return STANDARD_PRESETS.find(p => p.v === v) ?? EQUIRECT_PRESETS.find(p => p.v === v);
};

/**
 * 设备放得下的预设列表（下拉用）。`maxTextureSize` 一般取 `graphicsDevice.maxTextureSize`
 * （WebGPU 后端它也已经是 `limits.maxTextureDimension2D`）。
 *
 * 放不下的**直接不出现在下拉里**：这比"让用户选完再弹窗报错"友好，也不会写出一个
 * 渲染目标都建不出来的配置。默认 16384 是"不知道设备信息时的乐观值"。
 */
export const presetOptionsFor = (projection: ExportProjection, maxTextureSize = 16384): ResolutionPreset[] => {
    const limit = Number.isFinite(maxTextureSize) && maxTextureSize > 0 ? maxTextureSize : 16384;
    return resolutionPresets(projection).filter(p => p.width <= limit && p.height <= limit);
};

/** 把任意尺寸夹到设备上限内（自定义输入 / 别的代码直接调 render.* 时的兜底） */
export const clampExportSize = (
    width: number, height: number, maxTextureSize = 16384
): { width: number, height: number, clamped: boolean } => {
    const limit = Number.isFinite(maxTextureSize) && maxTextureSize > 0 ? maxTextureSize : 16384;
    const w = Math.max(4, Math.min(Math.round(width), limit));
    const h = Math.max(4, Math.min(Math.round(height), limit));
    return { width: w, height: h, clamped: w !== Math.round(width) || h !== Math.round(height) };
};

/** 一帧的 RGB**A** 字节数（回读缓冲就是这么多；8K = 126.6 MiB） */
export const frameBytes = (width: number, height: number): number => width * height * 4;

/** 一帧 PNG/JPG 落在内存里的字节数（保守上限估计：0.6 B/px ⇒ 8K ≈ 19.9 MiB，实测 18.6 MiB） */
export const encodedFrameBytes = (width: number, height: number, bytesPerPixel = 0.6): number => {
    return Math.ceil(width * height * bytesPerPixel);
};

/**
 * 编码器的**静态维度上限**（不依赖运行时的保守表）。
 *
 * 实测依据（`docs/probes/export-8k.cjs`，Edge 141 / WebCodecs）：
 *   • H.264（avc1.640034）4096×2048 ✓、7680×4320 ✗ ⇒ 上限按 level 5.2 的 4096×2304；
 *   • VP9 / AV1 7680×4320 ✓、8192×4096 ✓、**8192×8192 ✗** ⇒ 上限取 8192×4320（不是 8192 见方！）；
 *   • H.265 上限按 8192×4320 写，但**本机没有 H.265 编码器** ⇒ 由运行时的
 *     `isConfigSupported` 再筛一道（静态表只保证"不可能支持的别填进去"）。
 */
export const CODEC_CEILING: Record<string, { width: number, height: number }> = {
    h264: { width: 4096, height: 2304 },
    h265: { width: 8192, height: 4320 },
    vp9: { width: 8192, height: 4320 },
    av1: { width: 8192, height: 4320 }
};

/** 这个编码器在静态上能不能编这个尺寸 */
export const codecSupportsSize = (codec: string, width: number, height: number): boolean => {
    const c = CODEC_CEILING[codec];
    if (!c) {
        return false;
    }
    return width <= c.width && height <= c.height;
};

/** 一个尺寸下"静态可行"的编码器列表（顺序即偏好） */
export const codecsForSize = (codecs: readonly string[], width: number, height: number): string[] => {
    return codecs.filter(c => codecSupportsSize(c, width, height));
};

/** 码率折算系数：表里有的用表（保持历史数字不变），没有的按像素数折算 —— 永不 NaN */
const BPPF_FACTORS: Record<string, number> = {
    '540': 1,
    '720': 1 / 2,
    '1080': 1 / 3,
    '1440': 1 / 4,
    '4k': 1 / 5,
    '8k': 1 / 8,
    '360-1k': 1,
    '360-2k': 1 / 3,
    '360-4k': 1 / 5,
    '360-4096': 1 / 5,
    '360-8k': 1 / 8
};

/** 每像素每帧的位数（历史表，别改：改了会改掉所有既有档位的码率） */
export const BPPF_BY_QUALITY: Record<string, number> = {
    low: 0.001,
    medium: 0.01,
    high: 0.1,
    ultra: 1
};

/**
 * 码率折算系数。`preset` 命中表就用表；否则按像素数相对 1080p 折算
 * （`2.07M / (w×h)`，夹到 `[1/16, 1]`）—— 关键是**任何输入都返回有限正数**。
 */
export const bppfFactor = (width: number, height: number, preset?: string): number => {
    const w = Number.isFinite(width) && width > 0 ? width : 1920;
    const h = Number.isFinite(height) && height > 0 ? height : 1080;
    const known = preset !== undefined ? BPPF_FACTORS[preset] : undefined;
    if (typeof known === 'number' && Number.isFinite(known)) {
        return known;
    }
    const reference = 1920 * 1080;
    const value = reference / (w * h);
    return Math.min(1, Math.max(1 / 16, value));
};

/**
 * 码率（bps）。公式与历史实现一致：`10 × w × h × fps × bppf`，
 * 其中 `bppf = BPPF_BY_QUALITY[quality] × bppfFactor(...)`。
 *
 * 返回**一定是有限正整数**（这就是修掉 8K 那档 `NaN` 的地方：8K + high 实测 124.4 Mbps，
 * 改前是 `NaN` ⇒ `VideoEncoder.configure()` 直接失败）。
 */
export const bitrateFor = (options: {
    width: number, height: number, frameRate: number, quality: string, preset?: string
}): number => {
    const { width, height, frameRate, quality, preset } = options;
    const q = BPPF_BY_QUALITY[quality] ?? BPPF_BY_QUALITY.high;
    const bppf = q * bppfFactor(width, height, preset);
    const bitrate = Math.floor(10 * width * height * frameRate * bppf);
    return Number.isFinite(bitrate) && bitrate > 0 ? bitrate : 1_000_000;
};
