/**
 * unified（引擎 GPU 排序）通路的 WGSL 着色器。
 *
 * ## 顶点
 *
 * `unifiedVertexShader` 是引擎 `gsplatHybridVS` 的**逐字拷贝**
 * （playcanvas 2.21.3 / build/playcanvas.mjs 的 `gsplatHybrid_default`）。
 * 为什么抄而不是引用：引擎没有把 chunk 源码导出成可直接 import 的常量，
 * 而 hybrid 的顶点逻辑（从 `sortedIndices` / `projCache` 两个 storage buffer 取数据）
 * 与我们 per-instance 那套（顶点属性 + 贴图）完全不同，没有复用可能。
 * 抄一份的好处是我们可以在里面加东西（变换调色板、散射位移等后续阶段）。
 *
 * ⚠️ 升级 playcanvas 时必须重新核对这一份：
 *   node _tmp/extract-engine-chunk.cjs gsplatHybrid_default
 * 会把它从当前引擎包里抽出来做 diff。
 *
 * ## 片元（当前阶段）
 *
 * `unifiedFragmentShader` 现在与引擎默认片元（`gsplat_default3`，DITHER_NONE 分支）
 * **逐位等价**，只多一个 `uProbeGain`（默认 1）用来验证"我们自己的源码真的在跑、
 * 自定义 uniform 真的读得到"。这是地基验证，不是功能：
 * 调色链路（曲线/HSL/对比/高光/阴影/饱和度）在下一步往这里长。
 *
 * 与 per-instance 片元的两处结构性差异（迁调色时必须照顾到）：
 *   1. `gaussianColor` 是 `half4`，且**已经 gamma 处理过**（顶点里 `prepareOutputFromGamma`），
 *      语义是"乘以 alpha 之后的线性颜色" ⇒ 我们的调色作用在 `gaussianColor.xyz / alpha` 上，
 *      最后再乘回 alpha。
 *   2. 这里**没有** `texCoord_flags` / `vViewCenter` 等 varying（那些是 per-instance 顶点写的），
 *      选区位、裁剪盒需要靠引擎的 user varyings 通路补（`app.scene.gsplat.varyings.add`）。
 */

// ===== 引擎 gsplatHybridVS 逐字拷贝（playcanvas 2.21.3）=====
const unifiedVertexShader = /* wgsl */ `
#include "gsplatHelpersVS"
#include "gsplatOutputVS"
#ifdef GSPLAT_USER_VARYINGS
    #include "gsplatUserVaryingsVS"
#endif
attribute vertex_position: vec3f;
uniform viewport_size: vec4f;
uniform clipToViewZ: vec4f;
#ifdef GSPLAT_XR
    uniform view_index: u32;
    uniform matrix_projection: mat4x4f;
#endif
#if defined(SHADOW_PASS) || defined(PICK_PASS) || defined(PREPASS_PASS)
    uniform alphaClip: f32;
#else
    uniform alphaClipForward: f32;
#endif
var<storage, read> sortedIndices: array<u32>;
var<storage, read> projCache: array<u32>;
var<storage, read> numSplatsStorage: array<u32>;
varying gaussianUV: half2;
varying gaussianColor: half4;
#ifndef DITHER_NONE
    varying id: f32;
#endif
#ifdef PREPASS_PASS
    varying vLinearDepth: f32;
#endif
#if defined(GSPLAT_UNIFIED_ID) && defined(PICK_PASS)
    varying @interpolate(flat) vPickId: u32;
#endif
#ifdef GSPLAT_OVERDRAW
    uniform colorRampIntensity: f32;
    var colorRamp: texture_2d<f32>;
    var colorRampSampler: sampler;
#endif

// ===== 我们自己的调色参数（与 per-instance 材质**同名同语义**，由 scene.ts 的 unified 钩子喂）=====
// 为什么放在顶点：per-instance 通路就是在顶点做这一段的（每组 splat 一次），而且必须在
// prepareOutputFromGamma 之前（那是 gamma 解码 + 可选 tonemap，做过就逆不回去）。
// 名字与 per-instance 完全一致，这样两边的取值逻辑可以共用一份（见 src/splat/color-params.ts）。
#ifndef PICK_PASS
    uniform clrOffset: vec3f;
    uniform clrScale: vec4f;
    uniform saturation: f32;
    uniform uCurveEnabled: f32;
    var uCurve: texture_2d<f32>;
    var uCurveSampler: sampler;

    // 曲线查表：行 = 通道（0 主 / 1 R / 2 G / 3 B），**与 per-instance 的 curveLookup 逐字一致**
    // （那里用 textureLoad + 手工线性插值，因为 33 个采样点落在 32 段上；这里照抄，避免两条通路
    // 在曲线边缘上出现系统性偏差）。
    fn srCurveLookup(xIn: f32, ch: i32) -> f32 {
        let t: f32 = clamp(xIn, 0.0, 1.0) * 32.0;
        let i0: i32 = i32(floor(t));
        let i1: i32 = min(i0 + 1, 32);
        let a: f32 = textureLoad(uCurve, vec2i(i0, ch), 0).r;
        let b: f32 = textureLoad(uCurve, vec2i(i1, ch), 0).r;
        return mix(a, b, t - f32(i0));
    }
    fn srApplyCurve(c: vec3f) -> vec3f {
        let m: vec3f = vec3f(srCurveLookup(c.x, 0), srCurveLookup(c.y, 0), srCurveLookup(c.z, 0));
        return vec3f(srCurveLookup(m.x, 1), srCurveLookup(m.y, 2), srCurveLookup(m.z, 3));
    }
    fn srApplySaturation(c: vec3f) -> vec3f {
        let grey: vec3f = vec3f(dot(c, vec3f(0.299, 0.587, 0.114)));
        return grey + (c - grey) * uniform.saturation;
    }
#endif
const discardVec: vec4f = vec4f(0.0, 0.0, 2.0, 1.0);
// 探针烘焙 3（§4s）：**绕过 projCache / viewport_size 直接把实例铺满屏幕**。
// 用来回答"这块材质到底能不能把像素写到可见目标上"——如果铺满屏幕也不上屏，
// 那问题就不在几何数据（projCache / viewport_size）而在更外层（管线或目标）。
const SR_VS_COVER: f32 = __SR_VS_COVER__;
@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    if (SR_VS_COVER > 0.5) {
        let q = vec2f(vertex_position.xy);
        output.position = vec4f(q * 2.0, 0.0, 1.0);
        output.gaussianUV = half2(0.0, 0.0);
        output.gaussianColor = half4(half(1.0), half(1.0), half(1.0), half(1.0));
        #ifndef DITHER_NONE
            output.id = 0.0;
        #endif
        return output;
    }
    let order = pcInstanceIndex * {GSPLAT_INSTANCE_SIZE}u + u32(vertex_position.z);
    let numSplats = numSplatsStorage[0];
    if (order >= numSplats) {
        output.position = discardVec;
        return output;
    }
    let cacheIdx = sortedIndices[order];
    let base = cacheIdx * {CACHE_STRIDE}u;
    #ifdef GSPLAT_XR
        let off = uniform.view_index * 2u;
        let ndc = vec2f(
            bitcast<f32>(projCache[base + off + 0u]),
            bitcast<f32>(projCache[base + off + 1u])
        );
        let w = bitcast<f32>(projCache[base + 4u]);
        let pz = (uniform.matrix_projection[2][2] / uniform.matrix_projection[2][3]) * w + uniform.matrix_projection[3][2];
        let proj = vec4f(ndc * w, clamp(pz, 0.0, abs(w)), w);
        let v1 = unpack2x16float(projCache[base + 5u]);
        let v2 = unpack2x16float(projCache[base + 6u]);
        let rgba = unpack4x8unorm(projCache[base + 7u]);
        let alpha = half(rgba.a);
        var clr: half4 = half4(half(rgba.r), half(rgba.g), half(rgba.b), alpha);
    #else
        let proj = vec4f(
            bitcast<f32>(projCache[base + 0u]),
            bitcast<f32>(projCache[base + 1u]),
            bitcast<f32>(projCache[base + 2u]),
            bitcast<f32>(projCache[base + 3u])
        );
        let v1 = unpack2x16float(projCache[base + 4u]);
        let v2 = unpack2x16float(projCache[base + 5u]);
        let ba = unpack2x16float(projCache[base + 7u]);
        let alpha = half(ba.y);
        #if defined(GSPLAT_UNIFIED_ID) && defined(PICK_PASS)
            let pickId = projCache[base + 6u];
        #endif
        #ifdef PICK_PASS
            var clr: half4 = half4(half(0.0), half(0.0), half(0.0), alpha);
        #else
            let rg = unpack2x16float(projCache[base + 6u]);
            var clr: half4 = half4(half(rg.x), half(rg.y), half(ba.x), alpha);
        #endif
    #endif
    let cornerUV = vec2f(vertex_position.xy);
    #if defined(SHADOW_PASS) || defined(PICK_PASS) || defined(PREPASS_PASS)
        let alphaClipValue = half(uniform.alphaClip);
    #else
        let alphaClipValue = half(uniform.alphaClipForward);
    #endif
    let clip = min(half(1.0), sqrt(max(half(0.0), log(alpha / alphaClipValue))) * half(0.5));
    let cornerClipped = cornerUV * f32(clip);
    let c = vec2f(proj.w) * uniform.viewport_size.zw;
    let pixelOffset = cornerClipped.x * v1 + cornerClipped.y * v2;
    let clipOffset = pixelOffset * c;
    output.position = proj + vec4f(clipOffset, 0.0, 0.0);
    output.gaussianUV = half2(cornerClipped);
    #ifdef GSPLAT_USER_VARYINGS
        #include "gsplatUserCacheReadVS"
    #endif
    #ifdef GSPLAT_XR
        let viewDepth = proj.w;
    #else
        let viewDepth = dot(uniform.clipToViewZ, proj);
    #endif
    #ifdef GSPLAT_OVERDRAW
        let t: f32 = clamp(viewDepth / 20.0, 0.0, 1.0);
        let rampColor: vec3f = textureSampleLevel(colorRamp, colorRampSampler, vec2f(t, 0.5), 0.0).rgb;
        let outAlpha = alpha * half(1.0 / 32.0) * half(uniform.colorRampIntensity);
        output.gaussianColor = half4(half3(rampColor), outAlpha);
    #else
        // ===== 我们自己的调色（**与 per-instance 顶点逐字同一套**，见 splat-shader-wgsl.ts:341-396）=====
        // 顺序必须一致，否则两条通路的画面在对数上就不等价：
        //   clrScale/clrOffset（染色+亮度+黑白场+透明度）→ 曲线 → 饱和度 → prepareOutputFromGamma
        // 注意这条通路**每 splat 一次**（不是每像素），与 per-instance 的代价结构相同。
        // 也正因为在这里做，这段必须在 prepareOutputFromGamma **之前** —— 后者是"gamma 解码 +
        // 可选 tonemap"，一旦解码就不能再逆回去做线性域的调色。
        // ⚠️ clr 是 **half4**、alpha 是 **half**，而我们的调色参数是 f32 —— 必须显式转换。
        // 实测踩过：写成 vec4f(clr.xyz, alpha) 会报
        //   no matching constructor for 'vec4<f32>(vec3<f16>, f16)' ⇒ 编译失败 ⇒ 管线无效 ⇒ 整帧被丢弃。
        var tinted: vec4f = vec4f(vec3f(clr.xyz), f32(alpha));
        tinted = tinted * uniform.clrScale + vec4f(uniform.clrOffset, 0.0);
        #ifndef PICK_PASS
            if (uniform.uCurveEnabled > 0.5) {
                tinted = vec4f(srApplyCurve(tinted.xyz), tinted.w);
            }
            tinted = vec4f(srApplySaturation(tinted.xyz), tinted.w);
        #endif
        let gradedAlpha: half = half(clamp(tinted.w, 0.0, 1.0));
        output.gaussianColor = half4(
            half3(prepareOutputFromGamma(max(tinted.xyz, vec3f(0.0)), viewDepth)),
            gradedAlpha
        );
    #endif
    #ifndef DITHER_NONE
        output.id = f32(cacheIdx);
    #endif
    #ifdef PREPASS_PASS
        output.vLinearDepth = viewDepth;
    #endif
    #if defined(GSPLAT_UNIFIED_ID) && defined(PICK_PASS)
        output.vPickId = pickId;
    #endif
    return output;
}
`;

// ===== 覆盖用的 chunk：gsplatModifyVS（**不是** gsplatModifyPS）=====
//
// 这是本轮（2026-09-25）最关键的发现，写清楚免得以后再撞：
//
// unified 通路的颜色是**在投影 compute 里烘进 projCache 的**，而那个 compute 的
// 用户 chunk 来自**绘制材质**的同名 chunk —— 引擎在
// `GSplatHybridRenderer` 的 projector dispatch 里调
// `_updateMaterial(material)`，而 `_updateMaterial`（playcanvas.mjs:86540-86553）是这么取的：
//
//     const wgslChunks = material?.getShaderChunks?.(SHADERLANGUAGE_WGSL);
//     this._userModifySource = wgslChunks?.get('gsplatModifyVS') ?? null;
//
// 然后把 `_userModifySource` 塞进投影 compute 的 `gsplatModifyVS`，并在里面
// `modifySplatColor(center, &clr)`（每个 splat 一次，把颜色烘进 projCache）。
//
// ⇒ 结论：
//   * 想改 unified 通路的颜色，**必须覆盖 gsplatModifyVS**；
//     覆盖 `gsplatModifyPS` 对这条通路没有任何效果（片元根本不调它）。
//     这就是我之前几次"改了 chunk 画面却零变化"的真正原因。
//   * 顶点着色器只把 projCache 里的颜色解包出来，不参与着色 —— 所以**顶点源不用换**
//     （省掉了一整份 hybrid 顶点的拷贝与维护成本）。
//   * 每 splat 烘一次 ⇒ 能做曲线/HSL/饱和度/对比这类逐 splat 调色；
//     按**像素**才能做的事（裁剪盒软边、选区覆盖、按深度 tonemap）做不了，需要用
//     引擎的 user varyings 通路把状态送进片元（二期）。
//
// 目前这里只放一个**恒等 + 可选增益**的实现（`SR_PROBE_GAIN`）：恒等时画面必须与
// 引擎默认逐像素一致，增益 ≠ 1 时必须整体变化 —— 用它证明这个 chunk 真的被采用了。
// 一期第一步：把**饱和度与对比度**挂到这条通路上（曲线/HSL 见下方说明，属于下一步）。
//
// 对齐基准（硬要求）：**四项参数取中性值时，画面必须与引擎默认逐像素一致**。
// 中性值：saturation = 1、contrast = 0。所以这条链在没有调色时是**恒等**的。
//
// 关于"值域"：引擎的 `getColor()` 返回的是 `vec3(0.5) + rgb * SH_C0`（见
// playcanvas 的 `containerCompactRead`），其中 SH_C0 = 0.2820947917738781，
// 所以**0.5 是"SH 直流分量为 0"的颜色**。我们的调色是在**归一化到 [0,1] 之后**做的
// （与 per-instance 片元一致：那边拿到的已经是 [0,1]），所以这里先减 0.5、
// 做完再乘 SH_C0 加回去。
//
// 为什么放在这里而不是片元：unified 通路的颜色**在投影 compute 里就烘进 projCache 了**，
// 片元只负责把烘好的颜色解包出来（见 `docs/待办-引擎WebGPU-compute.md` §4k）。
// 代价是**每个 splat 算一次**（不是每个像素），所以能做逐 splat 的调色；
// 按像素才能做的（裁剪盒软边、选区覆盖）要另走 user varyings 通路。
const unifiedModifyVS = /* wgsl */ `
uniform uProbeGain: f32;
uniform saturation: f32;
uniform contrast: f32;

const SR_SH_C0: f32 = 0.28209479177387814;

// ===== 探针烘焙（默认关闭，见 docs/待办-引擎WebGPU-compute.md §4o/§4p）=====
// 为什么需要它：投影 compute 的 uniform 布局是引擎写死的二十个字段，
// 自定义 uniform（saturation / contrast / uProbeGain）**没有槽位** ⇒ 永远读到 0。
// 所以"我们的调色到底有没有作用于 unified 画面"这件事，只能靠**把值烘成常量**来验证。
// 烘焙值由构建侧注入（全局 __SPLATROOM_UNIFIED_BAKE__，默认 null = 不烘焙）。
// 注意：本文件是模板字符串，注释里不能出现反引号。
const SR_BAKE: bool = __SR_BAKE_ENABLED__;
const SR_BAKE_SATURATION: f32 = __SR_BAKE_SATURATION__;
const SR_BAKE_RED: f32 = __SR_BAKE_RED__;

fn srApplySaturation(c: vec3f) -> vec3f {
    let grey: vec3f = vec3f(dot(c, vec3f(0.299, 0.587, 0.114)));
    let s: f32 = select(uniform.saturation, SR_BAKE_SATURATION, SR_BAKE);
    return grey + (c - grey) * s;
}

fn srApplyContrast(c: vec3f) -> vec3f {
    return (c - vec3f(0.5)) * (1.0 + uniform.contrast) + vec3f(0.5);
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    // 投影 compute 里 color.rgb = 半精度打包的线性色（未乘 alpha），a 是 alpha。
    // 先还原成 [0,1] 归一化色做调色，再折回引擎的 SH_C0 编码。
    var c: vec3f = ((*color).xyz - vec3f(0.5)) / SR_SH_C0;
    c = srApplyContrast(c);
    c = srApplySaturation(c);
    c = c * SR_SH_C0 + vec3f(0.5);
    // 探针：把 rgb 朝纯红推（不可误认的阳性对照）
    if (SR_BAKE_RED > 0.0) {
        c = mix(c, vec3f(1.0, 0.0, 0.0) * SR_SH_C0 + vec3f(0.5), SR_BAKE_RED);
    }
    *color = vec4f(c * uniform.uProbeGain, (*color).w);
}
`;

/**
 * 探针烘焙：把上面模板里的 `__SR_BAKE_*__` 占位换成具体常量。
 *
 * 为什么要用"占位 + 替换"而不是直接读全局：WGSL 常量必须是编译期字面量，
 * 而探针是在页面里设全局的，源码必须在**构建时**就是合法的 WGSL。
 * 默认（没有设置全局 __SPLATROOM_UNIFIED_BAKE__）走 false / 中性值 ⇒ 与未烘焙逐位一致。
 *
 * 全局 __SPLATROOM_UNIFIED_BAKE__ = { saturation?: number, red?: number }（只给探针用）：
 *   - saturation: 0 ⇒ 直接验证"我们的调色有没有作用于画面"
 *   - red: 1        ⇒ 不可误认的阳性对照（画面应变红）
 */
function bakeUnifiedModifyVS(): string {
    const bake = (globalThis as any).__SPLATROOM_UNIFIED_BAKE__ ?? null;
    const enabled = !!bake;
    const sat = bake && typeof bake.saturation === 'number' ? bake.saturation : 1;
    const red = bake && typeof bake.red === 'number' ? bake.red : 0;
    return unifiedModifyVS
    .replace('__SR_BAKE_ENABLED__', enabled ? 'true' : 'false')
    .replace('__SR_BAKE_SATURATION__', sat.toFixed(6))
    .replace('__SR_BAKE_RED__', red.toFixed(6));
}

/**
 * 片元侧的烘焙（与上面同一个全局）：两个**探针专用**的阳性对照。
 *   - `fragRed: 1`     ⇒ 颜色整体朝纯红推（若片元参与最终画面，画面必须变红）
 *   - `fragOpaque: 1`  ⇒ 完全绕过 discard 与 alpha，无条件写不透明红 —— 用来区分
 *     "绘制没到目标"（画面毫无变化）与"绘制到了、只是被 alpha/discard 吃掉了"（画面变红）
 * 默认全 0 = 与未烘焙逐位一致。
 */
export function bakeUnifiedFragmentShader(): string {
    const bake = (globalThis as any).__SPLATROOM_UNIFIED_BAKE__ ?? null;
    const fragRed = bake && typeof bake.fragRed === 'number' ? bake.fragRed : 0;
    const fragOpaque = bake && typeof bake.fragOpaque === 'number' ? bake.fragOpaque : 0;
    return unifiedFragmentShader
    .replace('__SR_FRAG_RED__', fragRed.toFixed(6))
    .replace('__SR_FRAG_OPAQUE__', fragOpaque.toFixed(6));
}

/**
 * 顶点侧的烘焙（同一个全局）：`__SPLATROOM_UNIFIED_BAKE__ = { vsCover: 1 }` ⇒
 * 每个实例的四边形铺满屏幕（绕过 projCache 与 viewport_size）。**
 * 只在装了"我们这一份顶点源"时才生效 —— 安装侧看到 `vsCover > 0` 会改用这份拷贝。
 */
export function bakeUnifiedVertexShader(): string {
    const bake = (globalThis as any).__SPLATROOM_UNIFIED_BAKE__ ?? null;
    const cover = bake && typeof bake.vsCover === 'number' ? bake.vsCover : 0;
    return unifiedVertexShader.replace('__SR_VS_COVER__', cover.toFixed(6));
}

export { unifiedVertexShader, unifiedModifyVS, bakeUnifiedModifyVS, unifiedFragmentShader };

/**
 * 一个简单的字符串散列（FNV-1a，32 位），用来按**源码内容**生成稳定的缓存名。
 *
 * 为什么不能用长度当缓存键（实测踩过）：烘焙常量是 toFixed(6) 的定长数字，
 * red: 0 → red: 1 这类改动**长度完全不变** ⇒ 缓存键不变 ⇒ 引擎按 uniqueName 命中旧着色器、
 * **根本不重编译**（_tmp/probe-bake-effects.cjs 因此得出过一次假结论）。必须按内容生成键。
 */
export function hashSource(text: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
}

// ===== 自写片元：必须同时写 `output.color` 与 `output.color1` =====
//
// 为什么必须自己写一整份（`docs/待办-引擎WebGPU-compute.md` §4h/§4k）：
// splat pass 的目标是**两个颜色附件的 MRT**（`camera.ts` 的 splatTarget：
// RT0 = 场景色、RT1 = 选区覆盖），而引擎自带那份片元（`gsplat_default3`）在 forward 路径里
// **只写 `output.color`**（`output.color1` 只出现在 `#ifdef PICK_PASS` 里）
// ⇒ RT1 有 writeMask 却没有对应输出 ⇒ WebGPU 校验失败：
//   "Color target has no corresponding fragment stage output ... targets[1]"
// 而 `createRenderPipeline` **不抛异常**（只返回无效管线）⇒ 画面冻死、错误隐身。
//
// 三条硬约束（都踩过）：
//   1. **不能 `#include` 任何引擎 chunk** —— 材质已自动带上 `gsplatPS` / `gsplatModifyPS`，
//      再 include 一次会重复定义 `normExp` / `modifySplatColor` ⇒ 编译失败。
//      所以这一份只依赖 varying 名（引擎按声明生成顶点输出/片元输入结构）与自己的函数。
//   2. **不要在这里再声明 `uProbeGain`** —— 顶点侧的 `gsplatModifyVS` chunk 已经声明过它，
//      同一个 WGSL 模块里重复声明会编译失败（这正是"chunk 与自写片元同模块"的坑）。
//      所以这一份用常量做增益，只作为"我们的片元真的在跑"的证据。
//   3. 颜色语义：`gaussianColor` 是 `half4`，rgb **已经 gamma 处理、且已乘 alpha**
//      （顶点里做的），`w` 是 alpha；本份输出约定 `vec4(rgb * a, a)`（预乘）。
const unifiedFragmentShader = /* wgsl */ `
varying gaussianUV: half2;
varying gaussianColor: half4;

#ifdef PICK_PASS
    uniform alphaClip: f32;
#else
    uniform alphaClipForward: f32;
    // ===== 二期：与 per-instance **同一条**调色链的后半段（片元侧）=====
    // 分工与 per-instance 完全一致（见 splat-shader-wgsl.ts）：
    //   顶点（每 splat 一次，且在 gamma 解码之前）：clrScale/clrOffset → 曲线 → 饱和度
    //   片元（每像素一次，且在 gamma 解码之后）：高光 → 阴影 → 对比 → 逐通道 HSL
    // 这是唯一能让两条通路在**非中性参数**下也对齐的排法：prepareOutputFromGamma 是
    // gamma 解码 + 可选 tonemap，做过就逆不回去，所以线性域的那几步必须在顶点、在它之前。
    // 中性值全部恒等（clrScale=1、clrOffset=0、曲线关、对比=0、高光/阴影=0、HSL=0）。
    uniform highlights: f32;
    uniform shadows: f32;
    uniform contrast: f32;
    // HSL 逐通道（8 个色区打包成 2 个 vec4；A = [R,O,Y,G]，B = [A,B,P,M]）
    uniform hslHueA: vec4f;
    uniform hslHueB: vec4f;
    uniform hslSatA: vec4f;
    uniform hslSatB: vec4f;
    uniform hslLumA: vec4f;
    uniform hslLumB: vec4f;
#endif
#if defined(GSPLAT_UNIFIED_ID) && defined(PICK_PASS)
    varying @interpolate(flat) vPickId: u32;
#endif

// 与引擎 normExp 等价（自己定义，避免与自动带入的 chunk 重名）
fn srNormExp(x: half) -> half {
    let e4: half = half(0.01831563888873418);
    return (exp(x * half(-4.0)) - e4) / (half(1.0) - e4);
}

// ---- 调色（与 per-instance 片元逐字同一套公式，见 splat-shader-wgsl.ts:480-601）----
fn srApplyHighlights(c: vec3f) -> vec3f {
    let lum: f32 = dot(c, vec3f(0.299, 0.587, 0.114));
    let mask: f32 = smoothstep(0.4, 0.8, lum);
    return c + c * mask * uniform.highlights * 0.5;
}

fn srApplyShadows(c: vec3f) -> vec3f {
    let lum: f32 = dot(c, vec3f(0.299, 0.587, 0.114));
    let mask: f32 = 1.0 - smoothstep(0.2, 0.5, lum);
    return c + c * mask * uniform.shadows * 0.5;
}

fn srApplyContrast(c: vec3f) -> vec3f {
    return (c - vec3f(0.5)) * (1.0 + uniform.contrast) + vec3f(0.5);
}

// ---- 逐通道 HSL（Lightroom 风格，8 色区）----
// 色区中心（色相空间 [0,1]）
const SR_ZC_RED: f32     = 0.0;
const SR_ZC_ORANGE: f32  = 30.0 / 360.0;
const SR_ZC_YELLOW: f32  = 60.0 / 360.0;
const SR_ZC_GREEN: f32   = 120.0 / 360.0;
const SR_ZC_AQUA: f32    = 180.0 / 360.0;
const SR_ZC_BLUE: f32    = 225.0 / 360.0;
const SR_ZC_PURPLE: f32  = 270.0 / 360.0;
const SR_ZC_MAGENTA: f32 = 315.0 / 360.0;

fn srHueDistance(h1: f32, h2: f32) -> f32 {
    let d: f32 = abs(h1 - h2);
    return min(d, 1.0 - d);
}

fn srZoneWeight(hue: f32, center: f32) -> f32 {
    let d: f32 = srHueDistance(hue, center);
    return 1.0 - smoothstep(15.0 / 360.0, 45.0 / 360.0, d);
}

fn srRgb2hsl(c: vec3f) -> vec3f {
    let maxC: f32 = max(c.r, max(c.g, c.b));
    let minC: f32 = min(c.r, min(c.g, c.b));
    let l: f32 = (maxC + minC) * 0.5;
    let d: f32 = maxC - minC;
    var h: f32 = 0.0;
    var s: f32 = 0.0;
    if (d > 0.0001) {
        if (maxC == c.r) {
            h = (c.g - c.b) / d % 6.0;
            if (h < 0.0) { h = h + 6.0; }
            h = h / 6.0;
        } else if (maxC == c.g) {
            h = ((c.b - c.r) / d + 2.0) / 6.0;
        } else {
            h = ((c.r - c.g) / d + 4.0) / 6.0;
        }
        s = d / (1.0 - abs(2.0 * l - 1.0) + 0.0001);
    }
    return vec3f(h, s, l);
}

fn srHue2rgb(p: f32, q: f32, tIn: f32) -> f32 {
    var t: f32 = tIn;
    if (t < 0.0) { t = t + 1.0; }
    if (t > 1.0) { t = t - 1.0; }
    if (t < 1.0 / 6.0) { return p + (q - p) * 6.0 * t; }
    if (t < 0.5) { return q; }
    if (t < 2.0 / 3.0) { return p + (q - p) * (2.0 / 3.0 - t) * 6.0; }
    return p;
}

fn srHsl2rgb(h: f32, s: f32, l: f32) -> vec3f {
    if (s < 0.0001) { return vec3f(l); }
    let q: f32 = select(l + s - l * s, l * (1.0 + s), l < 0.5);
    let p: f32 = 2.0 * l - q;
    return vec3f(
        srHue2rgb(p, q, h + 1.0 / 3.0),
        srHue2rgb(p, q, h),
        srHue2rgb(p, q, h - 1.0 / 3.0)
    );
}

fn srApplyPerChannelHSL(cIn: vec3f) -> vec3f {
    // early-out：所有调整都为 0 时直接返回（默认状态，零成本）
    let sum: vec4f = uniform.hslHueA + uniform.hslHueB + uniform.hslSatA + uniform.hslSatB + uniform.hslLumA + uniform.hslLumB;
    if (dot(sum, sum) < 0.0001) { return cIn; }

    let c: vec3f = clamp(cIn, vec3f(0.0), vec3f(1.0));
    let hsl: vec3f = srRgb2hsl(c);
    var h: f32 = hsl.x;
    var s: f32 = hsl.y;
    var l: f32 = hsl.z;

    let w0: f32 = srZoneWeight(h, SR_ZC_RED);
    let w1: f32 = srZoneWeight(h, SR_ZC_ORANGE);
    let w2: f32 = srZoneWeight(h, SR_ZC_YELLOW);
    let w3: f32 = srZoneWeight(h, SR_ZC_GREEN);
    let w4: f32 = srZoneWeight(h, SR_ZC_AQUA);
    let w5: f32 = srZoneWeight(h, SR_ZC_BLUE);
    let w6: f32 = srZoneWeight(h, SR_ZC_PURPLE);
    let w7: f32 = srZoneWeight(h, SR_ZC_MAGENTA);

    let totalW: f32 = w0 + w1 + w2 + w3 + w4 + w5 + w6 + w7;
    let totalHue: f32 =
        w0 * uniform.hslHueA.x + w1 * uniform.hslHueA.y + w2 * uniform.hslHueA.z + w3 * uniform.hslHueA.w +
        w4 * uniform.hslHueB.x + w5 * uniform.hslHueB.y + w6 * uniform.hslHueB.z + w7 * uniform.hslHueB.w;
    let totalSat: f32 =
        w0 * uniform.hslSatA.x + w1 * uniform.hslSatA.y + w2 * uniform.hslSatA.z + w3 * uniform.hslSatA.w +
        w4 * uniform.hslSatB.x + w5 * uniform.hslSatB.y + w6 * uniform.hslSatB.z + w7 * uniform.hslSatB.w;
    let totalLum: f32 =
        w0 * uniform.hslLumA.x + w1 * uniform.hslLumA.y + w2 * uniform.hslLumA.z + w3 * uniform.hslLumA.w +
        w4 * uniform.hslLumB.x + w5 * uniform.hslLumB.y + w6 * uniform.hslLumB.z + w7 * uniform.hslLumB.w;

    if (totalW > 0.0001) {
        h = fract(h + totalHue / totalW * 0.5);
        s = clamp(s + totalSat / totalW, 0.0, 1.0);
        l = clamp(l + totalLum / totalW * 0.5, 0.0, 1.0);
    }

    return srHsl2rgb(h, s, l);
}

// 判定用增益：先设 1.0，确认错误归零；再改成 0.25 确认"我们的片元真的在跑"。
const SR_FRAG_GAIN: f32 = 1.0;

// 探针烘焙（与顶点侧同一个全局，默认关闭）：把颜色朝纯红推，作为"我们的片元
// 到底有没有决定最终颜色"的不可误认阳性对照（见 docs/待办-引擎WebGPU-compute.md §4q）。
const SR_FRAG_RED: f32 = __SR_FRAG_RED__;

// 探针烘焙 2：无条件写不透明红（见 §4s）。用来区分"这次绘制根本没到目标"
// 与"到了、被 discard / alpha 吃掉了"。
const SR_FRAG_OPAQUE: f32 = __SR_FRAG_OPAQUE__;

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    if (SR_FRAG_OPAQUE > 0.5) {
        output.color = vec4f(1.0, 0.0, 0.0, 1.0);
        #ifndef PICK_PASS
            output.color1 = vec4f(0.0, 0.0, 0.0, 0.0);
        #endif
        return output;
    }
    let A: half = dot(gaussianUV, gaussianUV);
    if (A > half(1.0)) {
        discard;
    }
    let alpha: half = srNormExp(A) * gaussianColor.a;

    #ifdef PICK_PASS
        if (alpha < half(uniform.alphaClip)) {
            discard;
        }
        #ifdef GSPLAT_UNIFIED_ID
            let id: u32 = vPickId;
            output.color = vec4f(
                f32((id >> 0u) & 0xFFu) / 255.0,
                f32((id >> 8u) & 0xFFu) / 255.0,
                f32((id >> 16u) & 0xFFu) / 255.0,
                f32((id >> 24u) & 0xFFu) / 255.0
            );
        #else
            output.color = vec4f(0.0, 0.0, 0.0, 0.0);
        #endif
    #else
        if (alpha < half(uniform.alphaClipForward)) {
            discard;
        }
        // 调色（片元侧这一段，与 per-instance 片元**同序同公式**：高光 → 阴影 → 对比 → 逐通道 HSL）。
        // 顶点侧那一段（clrScale/clrOffset → 曲线 → 饱和度）已经在 gamma 解码之前做过，
        // 所以这里拿到的 gaussianColor.xyz 就是"解码后待做这几步"的颜色。
        // ⚠️ 不要除以 alpha（详见下面那段注释）：gaussianColor.xyz 是颜色本身、w 才是 alpha。
        var c: vec3f = vec3f(gaussianColor.xyz);
        c = srApplyHighlights(c);
        c = srApplyShadows(c);
        c = srApplyContrast(c);
        c = srApplyPerChannelHSL(c);
        // 探针烘焙：朝纯红推（阳性对照）
        c = mix(c, vec3f(1.0, 0.0, 0.0), SR_FRAG_RED);
        // RT0：场景色（预乘输出）
        let a: f32 = f32(alpha) * SR_FRAG_GAIN;
        output.color = vec4f(c * a, a);
        // RT1：选区覆盖。一期先写零（选区着色属于二期），但**这一行是这次修复的核心**：
        // 没有它，RT1 就没有对应的片元输出，管线校验直接失败。
        output.color1 = vec4f(0.0, 0.0, 0.0, 0.0);
    #endif
    return output;
}
`;
