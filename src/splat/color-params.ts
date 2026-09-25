/**
 * splat 的颜色分级参数 —— **两条渲染通路共用的一份推导**。
 *
 * ## 为什么必须共用
 *
 * 仓库里有两条 splat 通路（见 `docs/排序错序-结构性解法-引擎GPU排序通路-2026-09-23.md`）：
 *   per-instance（主线）：参数写在组件材质上，顶点+片元分两段做调色；
 *   unified（引擎 GPU 排序，`?unified=1`）：参数写在每层的 `GSplatHybridRenderer._material` 上，
 *     由 `scene.ts` 的 unified 钩子喂进去。
 *
 * 这两条路的**取值逻辑必须逐字一致**，否则同一个滑块在两条通路上会给出不同画面。
 * 本仓库吃过"同一条规则在多处各写一遍、只改了被点名的那个"的亏
 * （见 `docs/bug排查-2026-09-23.md`），所以这里把推导抽成一份纯函数：
 *   色阶（黑场/白场/亮度）+ 染色 + 色温 + 透明度 → `clrScale` / `clrOffset`，
 *   以及饱和度 / 高光 / 阴影 / 对比 / 逐通道 HSL / 曲线开关。
 *
 * 调用方：
 *   `Splat.onPreRender()` —— 写进 per-instance 材质（主线，原有的那一段）；
 *   `scene.ts` 的 `ensureUnifiedMaterialHook()` —— 写进 unified 材质。
 *
 * 顺序约定（两条通路必须一致，改动时请一起改）：
 *   顶点（每 splat，gamma 解码**之前**）：clrScale/clrOffset → 曲线 → 饱和度
 *   片元（每像素，gamma 解码**之后**）：高光 → 阴影 → 对比 → 逐通道 HSL
 */
import { toneRange } from '../core/tone-range';

export type SplatColorParams = {
    clrOffset: [number, number, number];
    clrScale: [number, number, number, number];
    saturation: number;
    highlights: number;
    shadows: number;
    contrast: number;
    hslHueA: number[];
    hslHueB: number[];
    hslSatA: number[];
    hslSatB: number[];
    hslLumA: number[];
    hslLumB: number[];
    /** 曲线是否启用（0/1；没有曲线表时为 0 ⇒ 着色器整段跳过） */
    uCurveEnabled: number;
};

/**
 * 从一个 splat 元素推出它当前的颜色分级参数。
 *
 * ⚠️ 中性值（`colorGradeEnabled` 为 false）时必须**逐项回到恒等**：
 * `clrScale = [1,1,1,1]`、`clrOffset = 0`、`saturation = 1`、其余 0、曲线关。
 */
export const splatColorParams = (splat: any): SplatColorParams => {
    if (!splat?._colorGradeEnabled) {
        return {
            clrOffset: [0, 0, 0],
            clrScale: [1, 1, 1, 1],
            saturation: 1,
            highlights: 0,
            shadows: 0,
            contrast: 0,
            hslHueA: [0, 0, 0, 0],
            hslHueB: [0, 0, 0, 0],
            hslSatA: [0, 0, 0, 0],
            hslSatB: [0, 0, 0, 0],
            hslLumA: [0, 0, 0, 0],
            hslLumB: [0, 0, 0, 0],
            uCurveEnabled: 0
        };
    }

    // 黑场/白场 → 有序区间 + 最小间距（**唯一实现**，与导出/直方图/范围选择共用）。
    // 这里以前单独写过一份：`denom = max(0.001, whitePoint - blackPoint)`、
    // `offset = -blackPoint + brightness`。两处都错：
    //   • 两值相等时（UI 把黑场滑块拉到底正好落在那个边界上）denom 掉到 0.001 ⇒ scale = 1000；
    //   • offset 没乘 scale ⇒ 范围 ≠ 1 时"拉黑场"会把中间调整体抬亮（实测 0.29 → 0.99）。
    // 两件事合起来就是用户报的"黑场拉到底变成过曝"。
    const tone = toneRange(splat.blackPoint, splat.whitePoint);
    const offset = tone.offsetBase + splat.brightness;
    const scale = tone.scale;

    return {
        clrOffset: [offset, offset, offset],
        clrScale: [
            scale * splat.tintClr.r * (1 + splat.temperature),
            scale * splat.tintClr.g,
            scale * splat.tintClr.b * (1 - splat.temperature),
            splat.transparency
        ],
        saturation: splat.saturation,
        highlights: splat.highlights,
        shadows: splat.shadows,
        contrast: splat.contrast,
        hslHueA: [splat._hslHue[0], splat._hslHue[1], splat._hslHue[2], splat._hslHue[3]],
        hslHueB: [splat._hslHue[4], splat._hslHue[5], splat._hslHue[6], splat._hslHue[7]],
        hslSatA: [splat._hslSat[0], splat._hslSat[1], splat._hslSat[2], splat._hslSat[3]],
        hslSatB: [splat._hslSat[4], splat._hslSat[5], splat._hslSat[6], splat._hslSat[7]],
        hslLumA: [splat._hslLum[0], splat._hslLum[1], splat._hslLum[2], splat._hslLum[3]],
        hslLumB: [splat._hslLum[4], splat._hslLum[5], splat._hslLum[6], splat._hslLum[7]],
        uCurveEnabled: splat._curveTables ? 1 : 0
    };
};

/** 把一份参数写进任意材质（per-instance 与 unified 共用同一套 uniform 名） */
export const applySplatColorParams = (material: any, p: SplatColorParams) => {
    material.setParameter('clrOffset', p.clrOffset);
    material.setParameter('clrScale', p.clrScale);
    material.setParameter('saturation', p.saturation);
    material.setParameter('highlights', p.highlights);
    material.setParameter('shadows', p.shadows);
    material.setParameter('contrast', p.contrast);
    material.setParameter('hslHueA', p.hslHueA);
    material.setParameter('hslHueB', p.hslHueB);
    material.setParameter('hslSatA', p.hslSatA);
    material.setParameter('hslSatB', p.hslSatB);
    material.setParameter('hslLumA', p.hslLumA);
    material.setParameter('hslLumB', p.hslLumB);
    material.setParameter('uCurveEnabled', p.uCurveEnabled);
};
