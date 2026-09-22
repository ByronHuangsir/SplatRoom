// 纯 node 单测：导出分辨率的上限/预设/码率（src/core/export-resolution.ts）。
//
// 背景：把上限抬到 8K 时一次碰到四个墙（设备 / 编码器 / 码率 / 内存），四个判据都在这里钉死。
// 尤其是**码率**：原来的 `bbpfFactors` 表没有 8K 这一档 ⇒ `factor = undefined` ⇒ `bitrate = NaN`
// ⇒ `VideoEncoder.configure()` 直接失败（不是"画质差"，是根本不出片）。
//
// usage: node --experimental-strip-types docs/verify/verify-export-resolution.mts
import {
    BPPF_BY_QUALITY,
    CODEC_CEILING,
    EQUIRECT_PRESETS,
    MAX_EXPORT_DIMENSION,
    STANDARD_PRESETS,
    bitrateFor,
    bppfFactor,
    clampExportSize,
    codecSupportsSize,
    codecsForSize,
    encodedFrameBytes,
    frameBytes,
    presetById,
    presetOptionsFor
} from '../../src/core/export-resolution.ts';

const checks: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

// ---- 1. 预设表：8K 真的在里面，而且是上限 ----
const eightK = presetById('8k');
const eq8k = presetById('360-8k');
check('standard presets go up to 8K (7680x4320) and that is the largest one',
    !!eightK && eightK.width === 7680 && eightK.height === 4320 &&
    STANDARD_PRESETS.every(p => p.width <= eightK.width && p.height <= eightK.height),
    `标准最大档 = ${eightK?.width}x${eightK?.height}；共 ${STANDARD_PRESETS.length} 档（${STANDARD_PRESETS.map(p => p.v).join(', ')}）`);

check('360 (equirect) presets go up to 8192x4096 — 2:1, and 8192 is the cap',
    !!eq8k && eq8k.width === 8192 && eq8k.height === 4096 &&
    EQUIRECT_PRESETS.every(p => p.width <= eq8k.width && p.height <= eq8k.height) &&
    MAX_EXPORT_DIMENSION === 8192,
    `360 最大档 = ${eq8k?.width}x${eq8k?.height}；MAX_EXPORT_DIMENSION=${MAX_EXPORT_DIMENSION}；` +
    `每档都是 2:1 = ${EQUIRECT_PRESETS.every(p => p.width === p.height * 2)}`);

// ---- 2. 设备能力：放不下的档位从下拉里消失 ----
const opts8192 = presetOptionsFor('standard', 8192);
const opts4096 = presetOptionsFor('standard', 4096);
const optsEq4096 = presetOptionsFor('equirect', 4096);
check('presets that do not fit the device maxTextureSize are filtered out of the dropdown',
    opts8192.some(p => p.v === '8k') && !opts4096.some(p => p.v === '8k') &&
    opts4096.some(p => p.v === '4k') && !optsEq4096.some(p => p.v === '360-8k') &&
    optsEq4096.some(p => p.v === '360-4096'),
    `16384/8192 上限：标准 ${opts8192.length} 档（含 8k）；4096 上限：标准 ${opts4096.length} 档（不含 8k）、` +
    `360 ${optsEq4096.length} 档（不含 360-8k，含 360-4096）`);

check('clampExportSize clamps to the device limit and reports that it clamped',
    (() => {
        const a = clampExportSize(7680, 4320, 4096);
        const b = clampExportSize(7680, 4320, 16384);
        return a.width === 4096 && a.height === 4096 && a.clamped === true &&
            b.width === 7680 && b.height === 4320 && b.clamped === false;
    })(),
    '7680x4320 在 4096 上限的设备上被夹成 4096x4096（clamped=true）；16384 上限上原样通过');

// ---- 3. 编码器维度上限（静态表）----
check('H.264/H.265 cannot do 8K but VP9/AV1 can (matches the measured isConfigSupported matrix)',
    !codecSupportsSize('h264', 7680, 4320) && codecSupportsSize('h264', 3840, 2160) &&
    codecSupportsSize('vp9', 7680, 4320) && codecSupportsSize('av1', 8192, 4096) &&
    !codecSupportsSize('vp9', 8192, 8192) && !codecSupportsSize('av1', 8192, 8192),
    `h264 8K=${codecSupportsSize('h264', 7680, 4320)} 4K=${codecSupportsSize('h264', 3840, 2160)}；` +
    `vp9 8K=${codecSupportsSize('vp9', 7680, 4320)}；av1 360-8K=${codecSupportsSize('av1', 8192, 4096)}；` +
    `8192 见方=${codecSupportsSize('vp9', 8192, 8192)}（实测被拒）`);

check('codecsForSize keeps the preference order and drops what cannot do that size',
    JSON.stringify(codecsForSize(['h264', 'h265', 'vp9', 'av1'], 7680, 4320)) === JSON.stringify(['h265', 'vp9', 'av1']) &&
    JSON.stringify(codecsForSize(['h264', 'h265', 'vp9', 'av1'], 3840, 2160)) === JSON.stringify(['h264', 'h265', 'vp9', 'av1']),
    `8K 下留下 ${codecsForSize(['h264', 'h265', 'vp9', 'av1'], 7680, 4320).join('/')}；` +
    `4K 下全部可用 ${codecsForSize(['h264', 'h265', 'vp9', 'av1'], 3840, 2160).join('/')}`);

check('an unknown codec is reported as unsupported (no silent pass-through)',
    !codecSupportsSize('mpeg4', 1920, 1080) && CODEC_CEILING.mpeg4 === undefined,
    '未知编码器 ⇒ false（宁可让 UI 拦下，也不要让用户拿到一个不存在的编码器）');

// ---- 4. 码率：8K 那档原来是 NaN，现在必须是有限正数 ----
const b1080 = bitrateFor({ width: 1920, height: 1080, frameRate: 30, quality: 'high', preset: '1080' });
const b4k = bitrateFor({ width: 3840, height: 2160, frameRate: 30, quality: 'high', preset: '4k' });
const b8k = bitrateFor({ width: 7680, height: 4320, frameRate: 30, quality: 'high', preset: '8k' });
const b360_8k = bitrateFor({ width: 8192, height: 4096, frameRate: 30, quality: 'high', preset: '360-8k' });
check('the bitrate table now has an 8K entry (before: undefined ⇒ NaN ⇒ configure() fails)',
    BPPF_FACTORS_HAS_8K() && Number.isFinite(b8k) && b8k > 0,
    `1080p=${(b1080 / 1e6).toFixed(1)} Mbps、4K=${(b4k / 1e6).toFixed(1)}、` +
    `8K=${(b8k / 1e6).toFixed(1)}、360-8K=${(b360_8k / 1e6).toFixed(1)} Mbps（都是有限正数）`);

function BPPF_FACTORS_HAS_8K() {
    // 表里没这档的话 bppfFactor 会走"按像素折算"分支：8K 时 2.07M/33.2M ≈ 0.0624，
    // 与表里的 1/8 = 0.125 不同 —— 用这个差异确认"表里确实有 8k 这一档"。
    return Math.abs(bppfFactor(7680, 4320, '8k') - 1 / 8) < 1e-12 &&
        Math.abs(bppfFactor(8192, 4096, '360-8k') - 1 / 8) < 1e-12;
}

check('bitrateFor can never produce NaN/0/Infinity — even for an unknown preset or garbage input',
    (() => {
        const cases = [
            bitrateFor({ width: 7680, height: 4320, frameRate: 30, quality: 'high', preset: 'nope' }),
            bitrateFor({ width: 0, height: 0, frameRate: 30, quality: 'high' }),
            bitrateFor({ width: NaN, height: NaN, frameRate: NaN, quality: 'nope' }),
            bitrateFor({ width: 8192, height: 8192, frameRate: 120, quality: 'ultra' })
        ];
        return cases.every(v => Number.isFinite(v) && v > 0 && Number.isInteger(v));
    })(),
    '未知预设 / 0×0 / 全 NaN / 8192² ×120fps × ultra 四种输入都返回有限正整数' +
    `（未知预设那档按像素折算 ⇒ ${(bitrateFor({ width: 7680, height: 4320, frameRate: 30, quality: 'high', preset: 'nope' }) / 1e6).toFixed(1)} Mbps）`);

check('existing presets keep their historical bitrate (this change must not move 1080p/4K)',
    b1080 === Math.floor(10 * 1920 * 1080 * 30 * BPPF_BY_QUALITY.high * (1 / 3)) &&
    b4k === Math.floor(10 * 3840 * 2160 * 30 * BPPF_BY_QUALITY.high * (1 / 5)),
    `1080p 仍等于老公式 ${b1080} bps；4K 仍等于老公式 ${b4k} bps`);

// ---- 5. 内存口径（给 UI 警告用）----
check('frame byte counts match the measured readback sizes (8K = 126.6 MiB)',
    frameBytes(3840, 2160) === 33177600 && frameBytes(7680, 4320) === 132710400 &&
    frameBytes(8192, 4096) === 134217728 &&
    +(frameBytes(7680, 4320) / 1048576).toFixed(1) === 126.6,
    `4K=${(frameBytes(3840, 2160) / 1048576).toFixed(1)} MiB、8K=${(frameBytes(7680, 4320) / 1048576).toFixed(1)} MiB、` +
    `360-8K=${(frameBytes(8192, 4096) / 1048576).toFixed(1)} MiB（与探针回读的字节数逐字节一致）`);

check('encodedFrameBytes is a conservative upper bound for the PNG sequence (8K ≈ 18.6 MiB measured)',
    (() => {
        const est = encodedFrameBytes(7680, 4320);
        const measured = 19526973;
        return est >= measured && est <= measured * 1.6;
    })(),
    `估计 ${(encodedFrameBytes(7680, 4320) / 1048576).toFixed(1)} MiB/帧 vs 实测 PNG 8K ` +
    `${(19526973 / 1048576).toFixed(2)} MiB/帧（提示磁盘用量用，故意取偏大的上限）`);

const failed = checks.filter(c => !c.pass).length;
console.log(JSON.stringify({ checks, failed }, null, 1));
process.exit(failed === 0 ? 0 : 1);
