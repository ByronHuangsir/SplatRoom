import { Color } from 'playcanvas';

import { curveSetFromDoc, curveSetToDoc, type CurveSetDoc } from '../core/color-curves';
import { Splat } from '../splat/splat';

/**
 * Color Grade Sidecar File (.sscg) — non-destructive color grading.
 *
 * The sidecar lives alongside the original PLY file and stores all color
 * adjustment parameters. The original PLY data is never modified; the grade
 * is applied in the shader at render time and baked into exported files.
 *
 * File naming: "scene.ply" → "scene.ply.sscg"
 *
 * 版本历史：v3 之前没有 HSL；**v5（2026-09-22，第十七轮）加了曲线调色 `curves`**。
 * 旧版本文件里没有的字段一律"不动"（见 `deserializeGrade` 的 `undefined` 语义），
 * 所以 v4 及更早的侧车照旧能读。
 */

const SSCG_VERSION = 5;

/** Complete color grade data stored in sidecar */
export interface ColorGradeData {
    version: number;
    sourceFile: string;
    tintClr: [number, number, number];
    temperature: number;
    saturation: number;
    brightness: number;
    blackPoint: number;
    whitePoint: number;
    transparency: number;
    highlights: number;
    shadows: number;
    contrast: number;
    colorGradeEnabled?: boolean;
    hslHue?: number[];
    hslSat?: number[];
    hslLum?: number[];
    /**
     * 曲线调色（v5 起）。四个通道，各是 `[[x, y], …]` 或 `null`（= 该通道恒等）；
     * `undefined`（旧文件）= 不碰曲线，`null` = 清空全部曲线。与 `.ssproj` 同一份语义。
     */
    curves?: CurveSetDoc;
}

/** Create default (neutral) color grade data */
const createDefaultGradeData = (sourceFile: string): ColorGradeData => ({
    version: SSCG_VERSION,
    sourceFile,
    tintClr: [1, 1, 1],
    temperature: 0,
    saturation: 1,
    brightness: 0,
    blackPoint: 0,
    whitePoint: 1,
    transparency: 1,
    highlights: 0,
    shadows: 0,
    contrast: 0,
    colorGradeEnabled: true,
    hslHue: [0, 0, 0, 0, 0, 0, 0, 0],
    hslSat: [0, 0, 0, 0, 0, 0, 0, 0],
    hslLum: [0, 0, 0, 0, 0, 0, 0, 0],
    curves: null
});

/**
 * Serialize the current splat's color grade settings to a ColorGradeData object.
 */
const serializeGrade = (splat: Splat): ColorGradeData => {
    return {
        version: SSCG_VERSION,
        sourceFile: splat.filename ?? '',
        tintClr: [splat.tintClr.r, splat.tintClr.g, splat.tintClr.b],
        temperature: splat.temperature,
        saturation: splat.saturation,
        brightness: splat.brightness,
        blackPoint: splat.blackPoint,
        whitePoint: splat.whitePoint,
        transparency: splat.transparency,
        highlights: splat.highlights,
        shadows: splat.shadows,
        contrast: splat.contrast,
        colorGradeEnabled: splat.colorGradeEnabled,
        hslHue: Array.from(splat.hslHue),
        hslSat: Array.from(splat.hslSat),
        hslLum: Array.from(splat.hslLum),
        // 曲线：与 `.ssproj` 用同一对转换器（`src/core/color-curves.ts`），
        // 存控制点而不是 33×4 个采样值。少这一行的代价是"存了调色再读回来曲线没了"。
        curves: curveSetToDoc(splat.curves)
    };
};

/**
 * Apply color grade data to a splat (non-destructive — only sets parameters).
 */
const deserializeGrade = (splat: Splat, data: ColorGradeData): void => {
    if (data.tintClr) {
        splat.tintClr = new Color(data.tintClr[0], data.tintClr[1], data.tintClr[2]);
    }
    if (data.temperature !== undefined) splat.temperature = data.temperature;
    if (data.saturation !== undefined) splat.saturation = data.saturation;
    if (data.brightness !== undefined) splat.brightness = data.brightness;
    if (data.blackPoint !== undefined) splat.blackPoint = data.blackPoint;
    if (data.whitePoint !== undefined) splat.whitePoint = data.whitePoint;
    if (data.transparency !== undefined) splat.transparency = data.transparency;
    if (data.highlights !== undefined) splat.highlights = data.highlights;
    if (data.shadows !== undefined) splat.shadows = data.shadows;
    if (data.contrast !== undefined) splat.contrast = data.contrast;
    if (data.colorGradeEnabled !== undefined) splat.colorGradeEnabled = data.colorGradeEnabled;
    // HSL arrays (backward compatible: v3 files don't have these, default to zeros)
    if (data.hslHue) splat.hslHue = data.hslHue;
    if (data.hslSat) splat.hslSat = data.hslSat;
    if (data.hslLum) splat.hslLum = data.hslLum;
    // 曲线：`undefined`（v4 及更早的侧车）= 整段不碰；`null` = 清空；
    // `{…}` = 四个通道按存的值设（通道是 `null` ⇒ 该通道恒等）。
    if (data.curves !== undefined) {
        splat.setCurves(data.curves === null ? null : curveSetFromDoc(data.curves));
    }
};

/**
 * Generate the sidecar filename for a given splat file.
 * "scene.ply" → "scene.ply.sscg"
 */
const sidecarFilename = (sourceFilename: string): string => {
    return `${sourceFilename}.sscg`;
};

/**
 * Check if a filename looks like a sidecar file.
 */
const isSidecarFile = (filename: string): boolean => {
    return filename.endsWith('.sscg');
};

/**
 * Extract the original filename from a sidecar filename.
 * "scene.ply.sscg" → "scene.ply"
 */
const sourceFilenameFromSidecar = (sidecarFilename: string): string => {
    return sidecarFilename.replace(/\.sscg$/, '');
};

export {
    SSCG_VERSION,
    createDefaultGradeData,
    serializeGrade,
    deserializeGrade,
    sidecarFilename,
    isSidecarFile,
    sourceFilenameFromSidecar
};
