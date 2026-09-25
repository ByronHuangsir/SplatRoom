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
const discardVec: vec4f = vec4f(0.0, 0.0, 2.0, 1.0);
@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
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
        output.gaussianColor = half4(
            half3(prepareOutputFromGamma(max(vec3f(clr.xyz), vec3f(0.0)), viewDepth)),
            alpha
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
const unifiedModifyVS = /* wgsl */ `
const SR_PROBE_GAIN_DEFAULT: f32 = 1.0;
uniform uProbeGain: f32;

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    // color 的 rgb 是**线性、未乘 alpha**的颜色；a 是 alpha（引擎随后自己乘）
    *color = vec4f((*color).xyz * (uniform.uProbeGain + 0.0 * SR_PROBE_GAIN_DEFAULT), (*color).w);
}
`;

export { unifiedModifyVS };

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
#endif
#if defined(GSPLAT_UNIFIED_ID) && defined(PICK_PASS)
    varying @interpolate(flat) vPickId: u32;
#endif

// 与引擎 normExp 等价（自己定义，避免与自动带入的 chunk 重名）
fn srNormExp(x: half) -> half {
    let e4: half = half(0.01831563888873418);
    return (exp(x * half(-4.0)) - e4) / (half(1.0) - e4);
}

// 判定用增益：先设 1.0，确认错误归零；再改成 0.25 确认"我们的片元真的在跑"。
const SR_FRAG_GAIN: f32 = 1.0;

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
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
        // RT0：场景色（rgb 已含一次 alpha，这里再乘 alpha 得到预乘输出）
        let a: f32 = f32(alpha) * SR_FRAG_GAIN;
        output.color = vec4f(vec3f(gaussianColor.xyz) * a, a);
        // RT1：选区覆盖。一期先写零（选区着色属于二期），但**这一行是这次修复的核心**：
        // 没有它，RT1 就没有对应的片元输出，管线校验直接失败。
        output.color1 = vec4f(0.0, 0.0, 0.0, 0.0);
    #endif
    return output;
}
`;

export { unifiedFragmentShader };
