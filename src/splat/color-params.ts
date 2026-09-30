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
 *
 * M2-3：本函数保留给一次性调用方；每帧调用方请用
 * `fillSplatColorParams(splat, splatColorParamsScratch(splat))`（零分配）。
 */
export const splatColorParams = (splat: any): SplatColorParams => {
    return fillSplatColorParams(splat, createSplatColorParams());
};

/** 建一份新的参数对象（全部中性值）。 */
export const createSplatColorParams = (): SplatColorParams => ({
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
});

/**
 * splat 的**持久**参数 scratch（每帧复用，零分配）。
 *
 * 为什么必须 per-splat 而不是全局一份：数组会经 `applySplatColorParams` 交给
 * `material.setParameter`，引擎存的是**引用**；两个 splat 共用一份 scratch 时
 * 后写的那个会改到先写那个材质的 uniform。
 */
export const splatColorParamsScratch = (splat: any): SplatColorParams => {
    let out = splat._colorParamsOut as SplatColorParams | undefined;
    if (!out) {
        out = createSplatColorParams();
        splat._colorParamsOut = out;
    }
    return out;
};

/** 把当前参数填进 `out`（原位写，不分配）。 */
export const fillSplatColorParams = (splat: any, out: SplatColorParams): SplatColorParams => {
    if (!splat?._colorGradeEnabled) {
        out.clrOffset[0] = 0; out.clrOffset[1] = 0; out.clrOffset[2] = 0;
        out.clrScale[0] = 1; out.clrScale[1] = 1; out.clrScale[2] = 1; out.clrScale[3] = 1;
        out.saturation = 1;
        out.highlights = 0;
        out.shadows = 0;
        out.contrast = 0;
        for (let i = 0; i < 4; i++) {
            out.hslHueA[i] = 0; out.hslHueB[i] = 0;
            out.hslSatA[i] = 0; out.hslSatB[i] = 0;
            out.hslLumA[i] = 0; out.hslLumB[i] = 0;
        }
        out.uCurveEnabled = 0;
        return out;
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

    out.clrOffset[0] = offset; out.clrOffset[1] = offset; out.clrOffset[2] = offset;
    out.clrScale[0] = scale * splat.tintClr.r * (1 + splat.temperature);
    out.clrScale[1] = scale * splat.tintClr.g;
    out.clrScale[2] = scale * splat.tintClr.b * (1 - splat.temperature);
    out.clrScale[3] = splat.transparency;
    out.saturation = splat.saturation;
    out.highlights = splat.highlights;
    out.shadows = splat.shadows;
    out.contrast = splat.contrast;
    for (let i = 0; i < 4; i++) {
        out.hslHueA[i] = splat._hslHue[i]; out.hslHueB[i] = splat._hslHue[i + 4];
        out.hslSatA[i] = splat._hslSat[i]; out.hslSatB[i] = splat._hslSat[i + 4];
        out.hslLumA[i] = splat._hslLum[i]; out.hslLumB[i] = splat._hslLum[i + 4];
    }
    out.uCurveEnabled = splat._curveTables ? 1 : 0;
    return out;
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

/**
 * 缓存版 apply（M2-3）：逐项走 MaterialParamCache，值没变就不调 setParameter。
 * 与 `applySplatColorParams` 的写入集合逐项一致。
 */
export const applySplatColorParamsCached = (cache: { setScalar: (m: any, n: string, v: number) => void, setArray: (m: any, n: string, v: ArrayLike<number>) => void }, material: any, p: SplatColorParams) => {
    cache.setArray(material, 'clrOffset', p.clrOffset);
    cache.setArray(material, 'clrScale', p.clrScale);
    cache.setScalar(material, 'saturation', p.saturation);
    cache.setScalar(material, 'highlights', p.highlights);
    cache.setScalar(material, 'shadows', p.shadows);
    cache.setScalar(material, 'contrast', p.contrast);
    cache.setArray(material, 'hslHueA', p.hslHueA);
    cache.setArray(material, 'hslHueB', p.hslHueB);
    cache.setArray(material, 'hslSatA', p.hslSatA);
    cache.setArray(material, 'hslSatB', p.hslSatB);
    cache.setArray(material, 'hslLumA', p.hslLumA);
    cache.setArray(material, 'hslLumB', p.hslLumB);
    cache.setScalar(material, 'uCurveEnabled', p.uCurveEnabled);
};
