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

// ===== 二期：**per-splat 状态（选中 / 锁定 / 删除）进这条通路** =====
// 为什么能这么做：状态贴图是 R8、行主序（Splat.stateTexture，与 per-instance 材质共用同一张），
// 而那正是**按源行号**索引的 —— 所以这里必须拿到行号。见下面 srRow。
//
// ⚠️⚠️ 2026-10-02 血泪教训（**这条以前写错了，写错过整整一个版本**）：
//    cacheIdx = sortedIndices[order] **不是行号，是排序槽位**！
//    投影器用 localDst = atomicAdd(&wgCount, 1u) 每帧重新分配写槽（playcanvas.mjs:85832），
//    再按槽位落盘 sortKeys[dst] / projCache[dst * CACHE_STRIDE]；sortedIndices 装的就是
//    这个槽位（gpuSorter.sortIndirect(projector.sortKeys, ...) 只排键、不带 id）。
//    ⇒ 拿槽位查按行号索引的状态贴图 = **每帧给每个高斯贴一个随机状态**。
//    实测症状（4M 真实扫描件、相机静止、框选左半边）：新增的高亮黄像素铺满全屏、质心 x=0.59
//    （在选区右边）、只有 27.5% 落在选区内；逐帧像素翻转 50%。用户的描述是
//    "选中的地方不亮、别的地方闪" —— 同一个 bug。逐 splat 拾取（片元把 srSplatIndex 编成颜色）
//    也一起拾错。
//    修法：引擎补丁 3（scripts/apply-patches.js）让投影器把 projected.splatId（**真源行号**）
//    写进缓存备用字 word 8（CACHE_STRIDE 8 -> 9），这里读 projCache[base + 8u] 当行号。
//    改了这里就必须有补丁 3，缺了会读到垃圾（选中全乱）。
//
// ⚠️ 命名：不要复用引擎/我们 chunk 里已有的名字（splatState / selectedClr / lockedClr /
// showDeleted / saturation / uProbeGain …）—— 同一个 WGSL 模块里重复声明会编译失败
// （踩过：uProbeGain），所以这一套统一用 sr 前缀。
// ⚠️ 本文件是模板字符串，注释里**不能出现反引号**（踩过三次，scripts/audit-code.mjs 有静态护栏）。
var srStateTex: texture_2d<f32>;
uniform srStateW: f32;
uniform srSelectedClr: vec4f;
uniform srLockedClr: vec4f;
uniform srShowDeleted: f32;
// 状态字节原样带到片元（删除但仍在显示时的淡红染色要用 bit2）
varying @interpolate(flat) srState: u32;
// 该 splat 的**源行号**（= projCache[base + 8u]，补丁 3 写入）—— 拾取要用它当 id，见下面 srPickMode。
varying @interpolate(flat) srSplatIndex: u32;
// ===== 环模式：「Splat 模式 = 环」时把每个高斯画成**它自己的边界环** =====
// 用户口径（2026-10-02）：「环模式是需要显示高斯球的边界」——所以内部整块丢弃、只留贴边一圈。
// 带宽在这里换算成"归一化半径"（A 空间）带给片元：屏幕上至少 ~1.2px，否则细小高斯的环会退化成
// 亚像素、随相机抖动而闪烁。归一化半径 1.0 = 该高斯的绘制外沿（四边形内接椭圆）。
uniform srRingSize: f32;
varying @interpolate(flat) srRingUV: f32;
// ===== 二期：裁剪盒（per-pixel）=====
// 主线是在片元里用 vScreenOffset/vViewCenter + 高斯椭圆**重建视空间位置**再判盒内外的；
// unified 这条路没有那些 varying，所以这里由顶点把「clip → 盒局部」的合成矩阵乘一次
// （srClipToBoxLocal 由 app 每帧给 = inverse(盒世界) × inverse(视图) × inverse(投影)），
// 片元插值就得到每个像素的盒局部坐标。
// 代价（写清楚）：插值出来的是**高斯中心那条轨迹**上的位置，不是真实表面点 ⇒ 软边是近似；
// 硬切（判内外）则与主线同式、结果一致。
#ifndef PICK_PASS
    uniform srClipToBoxLocal: mat4x4f;
    varying srBoxLocal: vec3f;
    /** splat **中心**的盒局部坐标（flat）—— 软边只在"中心本来就贴近边界"的高斯上生效 */
    varying @interpolate(flat) srBoxLocalCentre: vec3f;
    // ===== 二期：粒子特效（散射 / 波纹入场 / 爆散收场）=====
    // 主线在顶点里改世界坐标再投影；这里改的是**投影位置**（世界位移 → clip 位移），
    // 所以需要两个矩阵：srClipToWorld（把 clip 还原成世界中心）与 srViewProj（把位移投回 clip）。
    uniform srClipToWorld: mat4x4f;
    uniform srViewProj: mat4x4f;
    uniform srScatterProgress: f32;
    uniform srScatterRadius: f32;
    uniform srScatterCenter: vec3f;
    uniform srEffectMode: f32;
    uniform srEffectTime: f32;
    uniform srEffectColor: vec3f;
    uniform srEffectFade: f32;
#endif
// ===== 拾取模式（0 = 正常出图，1 = id 拾取）=====
// 为什么需要它：unified 通路的绘制材质是引擎那个（我们挂钩覆盖），**没有** per-instance 的
// pickMode uniform；而 app 的 picker（prepareId）要靠"渲染一遍、把每个 splat 的 id 写成颜色
// 再读回"来回答"这个像素上是哪个 splat"。id 的编码必须与 picker.readIds 的解码一致：
//   id = r | g<<8 | b<<16 | a<<24   （低字节在 r）
// 于是这里按同样的顺序写字节；行号本身来自 cacheIdx（就是数据行号）。
uniform srPickMode: f32;

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

    // ===== 二期：per-splat 状态（选中 / 锁定 / 删除）=====
    // 语义**逐字对齐 per-instance 顶点**（splat-shader-wgsl.ts:174-182 与 :398-403）：
    //   删除位 4：showDeleted 关着 ⇒ 挪出裁剪体（整点丢弃）；开着 ⇒ 交给片元染淡红；
    //   锁定位 2：整色 × lockedClr；选中位 1：往 selectedClr 混（用它的 alpha 当权重）。
    // 位置也一致：这两条染色在**调色链之前**（顶点侧），淡红在片元侧调色链之后。
    let srStateWidth: u32 = u32(max(uniform.srStateW, 1.0));
    // **真源行号**（补丁 3 由投影器写入 word 8）。绝对不要用 cacheIdx：那是每帧重分配的排序槽位，
    // 拿它查状态贴图会得到"随机状态"（详见文件头那段血泪教训）。
    let srRow: u32 = projCache[base + 8u];
    let srStateValue: u32 = u32(
        textureLoad(
            srStateTex,
            vec2i(i32(srRow % srStateWidth), i32(srRow / srStateWidth)),
            0
        ).r * 255.0 + 0.5
    ) & 7u;
    output.srState = srStateValue;
    output.srSplatIndex = srRow;
    // 删除点：隐藏时整点丢弃。**拾取模式也一样**（与 per-instance 的 PICK_PASS 分支同义：
    // "删掉且不显示"的点不该被拾取到），所以这一条不再放在 PICK_PASS 守卫里。
    if ((srStateValue & 4u) != 0u && uniform.srShowDeleted < 0.5) {
        output.position = discardVec;
        return output;
    }
    #ifndef PICK_PASS
        // 拾取/深度模式下**不染色**：id 是被当数据读的，染一下就把 id 改坏了。
        if (uniform.srPickMode < 0.5) {
            if ((srStateValue & 2u) != 0u) {
                clr = half4(vec4f(clr) * uniform.srLockedClr);
            } else if ((srStateValue & 1u) != 0u) {
                let srClr: vec4f = vec4f(clr);
                // ⚠️ 必须显式走一趟 vec4f：half4(vec3f, f32) **没有**对应的构造函数，
                // 直接写 half4(mix(...), srClr.w) 会编译失败 ⇒ 管线无效 ⇒ 整帧零图元（画面全黑、
                // 且 createRenderPipeline 不抛异常）。这个坑本仓库踩过一次，这次是探针
                // docs/probes/probe-wgsl-error.cjs 一眼指出来的。
                clr = half4(vec4f(
                    mix(srClr.xyz, uniform.srSelectedClr.xyz, uniform.srSelectedClr.a),
                    srClr.w
                ));
            }
        }
    #endif

    // ===== 二期：粒子特效（散射 / 波纹入场 / 爆散收场）=====
    // 主线在顶点里改的是 **modelCenter**（世界坐标），然后再投影 —— 那个位置在 unified 的顶点里
    // 拿不到，所以这里把"世界位移"换算成 **clip 位移** 加到投影位置上：
    //   worldCentre = srClipToWorld × proj（透视除法）
    //   clipDelta   = srViewProj × vec4(delta, 0)     ← 位移是方向量，w 记 0
    // 种子用 splat 行号（cacheIdx）—— 主线用的是纹理坐标派生的种子，两者都是"每高斯一个伪随机数"，
    // 具体取值不同（粒子本来就是随机的），分布一致。
    // ⚠️ 特效在**裁剪盒之前**应用：下面算盒局部坐标时用的 proj 仍是原位置（特效与裁剪同时用属于边角情形）。
    var srEffProj: vec4f = proj;
    #ifndef PICK_PASS
        if (uniform.srEffectFade < 0.999 || uniform.srScatterProgress > 1e-4 || uniform.srEffectMode > 0.5) {
            let srSeed: f32 = fract(f32(cacheIdx) * 0.61803398875);
            let srR1: f32 = fract(sin(srSeed * 12.9898) * 43758.5453);
            let srR2: f32 = fract(sin(srSeed * 78.233) * 12543.123);
            let srR3: f32 = fract(sin(srSeed * 33.912) * 7951.192);
            let srScatterDir: vec3f = normalize(vec3f(srR1 - 0.5, srR2 - 0.5, srR3 - 0.5));
            let srScatterPos: vec3f = uniform.srScatterCenter + srScatterDir * (uniform.srScatterRadius * (0.3 + srR3 * 0.7));

            let srWc4: vec4f = uniform.srClipToWorld * proj;
            let srWorldCentre: vec3f = select(vec3f(0.0), srWc4.xyz / srWc4.w, abs(srWc4.w) > 1e-6);
            var srEffCentre: vec3f = srWorldCentre;

            if (uniform.srEffectMode > 1.5) {
                // 2 = 爆散收场：先炸开再受重力下落
                let srDelay: f32 = srR3 * 0.15;
                let srBurstT: f32 = clamp((uniform.srEffectTime - srDelay) / max(0.2, 1.0 - srDelay), 0.0, 1.0);
                let srBurstPos: vec3f = mix(srWorldCentre, srScatterPos, srBurstT);
                let srHdir: vec2f = normalize(vec2f(srR1 - 0.5, srR2 - 0.5));
                let srFall: f32 = srBurstT * srBurstT;
                srEffCentre = srBurstPos + vec3f(
                    srHdir.x * uniform.srScatterRadius * 0.15 * srBurstT,
                    -uniform.srScatterRadius * 1.6 * srFall,
                    srHdir.y * uniform.srScatterRadius * 0.15 * srBurstT
                );
            } else if (uniform.srEffectMode > 0.5) {
                // 1 = 波纹入场：波前把粒子收拢回模型
                let srWaveRadius: f32 = uniform.srEffectTime * uniform.srScatterRadius * 1.6;
                let srWaveWidth: f32 = uniform.srScatterRadius * 0.12;
                let srD: f32 = length(srWorldCentre - uniform.srScatterCenter);
                if (srD >= srWaveRadius && srD < srWaveRadius + srWaveWidth) {
                    let srBandT: f32 = (srD - srWaveRadius) / max(srWaveWidth, 1e-5);
                    srEffCentre = mix(srWorldCentre, srScatterPos, srBandT);
                } else if (srD >= srWaveRadius + srWaveWidth) {
                    srEffCentre = srScatterPos;
                }
            } else {
                // 0 = 纯散射：0 是模型、1 是粒子
                srEffCentre = mix(srWorldCentre, srScatterPos, uniform.srScatterProgress);
            }

            let srDelta: vec3f = srEffCentre - srWorldCentre;
            if (dot(srDelta, srDelta) > 1e-12) {
                srEffProj = proj + (uniform.srViewProj * vec4f(srDelta, 0.0));
            }

            // 特效的颜色/透明度（与主线顶点里那段逐字同式，见 splat-shader-wgsl.ts:362-387）
            if (uniform.srEffectMode > 1.5) {
                // 2 = 爆散收场：暖色火花，亮度与透明度随爆散衰减
                let srDelay2: f32 = srR3 * 0.15;
                let srBurstT2: f32 = clamp((uniform.srEffectTime - srDelay2) / max(0.2, 1.0 - srDelay2), 0.0, 1.0);
                let srLife: f32 = 1.0 - srBurstT2;
                var srC2: vec4f = vec4f(clr);
                srC2 = vec4f(mix(srC2.xyz, uniform.srEffectColor, 0.5 * srBurstT2), srC2.w);
                srC2 = vec4f(srC2.xyz * (1.0 + 0.8 * srLife * srBurstT2), srC2.w);
                srC2 = vec4f(srC2.xyz, srC2.w * (0.2 + 0.8 * srLife * srLife));
                clr = half4(srC2);
            } else if (uniform.srEffectMode > 0.5) {
                // 1 = 波纹入场：波前发光、还没扫到的粒子变淡
                let srWaveRadius2: f32 = uniform.srEffectTime * uniform.srScatterRadius * 1.6;
                let srWaveWidth2: f32 = uniform.srScatterRadius * 0.12;
                let srD2: f32 = length(srWorldCentre - uniform.srScatterCenter);
                var srC3: vec4f = vec4f(clr);
                if (srD2 >= srWaveRadius2 && srD2 < srWaveRadius2 + srWaveWidth2) {
                    let srBandT2: f32 = (srD2 - srWaveRadius2) / max(srWaveWidth2, 1e-5);
                    let srGlow: f32 = 1.0 - srBandT2;
                    srC3 = vec4f(mix(srC3.xyz, uniform.srEffectColor, 0.25 * srGlow), srC3.w);
                    srC3 = vec4f(srC3.xyz * (1.0 + 0.6 * srGlow), srC3.w);
                    srC3 = vec4f(srC3.xyz, mix(srC3.w, 1.0, srGlow));
                } else if (srD2 >= srWaveRadius2 + srWaveWidth2) {
                    srC3 = vec4f(srC3.xyz, srC3.w * 0.12);
                }
                clr = half4(srC3);
            }
            // 整体淡入/淡出走**片元**那条（与主线同一处：alpha = alpha * uniform.uEffectFade）。
            // ⚠️ 不能在顶点里改 clr.w：顶点最后是用**另一个** alpha 变量组装 gaussianColor 的
            // （let alpha = half(ba.y)，见下面那段的说明），改 clr.w 不会生效 —— 实测 fade=0 时
            // 画面纹丝不动。
        }
    #endif
    let cornerUV = vec2f(vertex_position.xy);
    #if defined(SHADOW_PASS) || defined(PICK_PASS) || defined(PREPASS_PASS)
        let alphaClipValue = half(uniform.alphaClip);
    #else
        let alphaClipValue = half(uniform.alphaClipForward);
    #endif
    let clip = min(half(1.0), sqrt(max(half(0.0), log(alpha / alphaClipValue))) * half(0.5));
    var cornerClipped = cornerUV * f32(clip);
    // ===== 中心点模式（「显示/隐藏 Splat」开关 + Splat 模式 = 中心）=====
    // 由来（2026-10-02 实测）：unified 通路没有 per-instance 实例（entity.gsplat.instance 为 null，
    // onPreRender 里直接 "skipped: instance=false"），于是主线那条独立的中心点覆盖层
    // （splat-overlay.ts，要 instance.sorter / resource 的几张数据纹理）在这里**挂不上**：
    // 实测 attachedSplat=true 但 orderReady=false、drawPoints=0、entity.enabled=false
    // ⇒ 点那个按钮画面变化 ≤0.15%，等于死开关。
    // 就地实现：把每个高斯压成**固定像素大小**的圆点（片元再涂成平坦颜色，见 srCentersSize 分支），
    // 拾取期不压（拾取要真实覆盖范围）。
    if (uniform.srCentersSize > 0.0 && uniform.srPickMode < 0.5) {
        let srAxis: f32 = max(max(length(v1), length(v2)), 1e-4);
        cornerClipped = cornerUV * clamp(uniform.srCentersSize * 0.5 / srAxis, 0.0, 1.0);
    }
    // 环模式：环宽 = max(设定带宽, 1.2px ÷ 该高斯的屏幕半径)，转成归一化半径交给片元。
    // srRingSize<=0（非环模式）时给 0，片元那边整段不生效。
    let srRingAxisPx: f32 = max(max(length(v1), length(v2)), 1e-3);
    output.srRingUV = select(
        0.0,
        clamp(max(uniform.srRingSize, 1.2 / srRingAxisPx), 0.0, 0.9),
        uniform.srRingSize > 0.0
    );
    // 特效改的是投影位置（见上面 srEffProj 的说明），四边形的缩放按它的 w 来
    let c = vec2f(srEffProj.w) * uniform.viewport_size.zw;
    let pixelOffset = cornerClipped.x * v1 + cornerClipped.y * v2;
    let clipOffset = pixelOffset * c;
    output.position = srEffProj + vec4f(clipOffset, 0.0, 0.0);
    // 裁剪盒：把**这一个角**的 clip 位置换算到盒局部，片元在其上插值 ⇒ 逐像素的盒局部坐标
    // （≈ 主线那种"每个片元判内外"的语义）。
    // ⚠️ 必须用**角的**位置、不能用 splat 中心的：用中心的话四个角同值 ⇒ 退化成"按 splat 硬切"，
    // 实测那样会把模型边界的一层壳整片丢掉（亮点占比掉 4.3%，而主线只掉 0.06%）。
    #ifndef PICK_PASS
        let srCornerClip: vec4f = proj + vec4f(clipOffset, 0.0, 0.0);
        let srBoxCorner: vec4f = uniform.srClipToBoxLocal * srCornerClip;
        output.srBoxLocal = select(
            vec3f(0.0),
            srBoxCorner.xyz / srBoxCorner.w,
            abs(srBoxCorner.w) > 1e-6
        );
        // 中心那份（flat）：给片元的**软边判定**用。为什么需要它见片元里那段注释。
        let srBoxCentre: vec4f = uniform.srClipToBoxLocal * proj;
        output.srBoxLocalCentre = select(
            vec3f(0.0),
            srBoxCentre.xyz / srBoxCentre.w,
            abs(srBoxCentre.w) > 1e-6
        );
    #endif
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
// ===== M2-3（2026-09-30）：烘焙结果记忆化 =====
// ensureUnifiedMaterial 每帧都调这三个 bake 函数。以前它们无条件做整串 .replace()
// —— 每次都在堆上重建一份几 KB~几十 KB 的着色器源码，只为下一秒被拿去 hash/比较。
// 烘焙键（全局 __SPLATROOM_UNIFIED_BAKE__ 的各字段）在帧与帧之间几乎从不变动，
// 所以按"键值组合"记忆化：键没变 ⇒ 直接返回上一次那一份字符串（引用相等，
// 下游的 wantName 缓存还能靠引用比较再省掉 hashSource）。
const bakeMemo = {
    modify: { key: '', out: '' },
    frag: { key: '', out: '' },
    vs: { key: '', out: '' }
};

function bakeUnifiedModifyVS(): string {
    const bake = (globalThis as any).__SPLATROOM_UNIFIED_BAKE__ ?? null;
    const enabled = !!bake;
    const sat = bake && typeof bake.saturation === 'number' ? bake.saturation : 1;
    const red = bake && typeof bake.red === 'number' ? bake.red : 0;
    const key = `${enabled}|${sat}|${red}`;
    if (bakeMemo.modify.key !== key) {
        bakeMemo.modify.key = key;
        bakeMemo.modify.out = unifiedModifyVS
        .replace('__SR_BAKE_ENABLED__', enabled ? 'true' : 'false')
        .replace('__SR_BAKE_SATURATION__', sat.toFixed(6))
        .replace('__SR_BAKE_RED__', red.toFixed(6));
    }
    return bakeMemo.modify.out;
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
    const cropProbe = bake && typeof bake.cropBoxProbe === 'number' ? bake.cropBoxProbe : 0;
    const key = `${fragRed}|${fragOpaque}|${cropProbe}`;
    if (bakeMemo.frag.key !== key) {
        bakeMemo.frag.key = key;
        bakeMemo.frag.out = unifiedFragmentShader
        .replace('__SR_FRAG_RED__', fragRed.toFixed(6))
        .replace('__SR_FRAG_OPAQUE__', fragOpaque.toFixed(6))
        .replace('__SR_CROP_PROBE__', cropProbe.toFixed(6));
    }
    return bakeMemo.frag.out;
}

/**
 * 顶点侧的烘焙（同一个全局）：`__SPLATROOM_UNIFIED_BAKE__ = { vsCover: 1 }` ⇒
 * 每个实例的四边形铺满屏幕（绕过 projCache 与 viewport_size）。**
 * 只在装了"我们这一份顶点源"时才生效 —— 安装侧看到 `vsCover > 0` 会改用这份拷贝。
 */
export function bakeUnifiedVertexShader(): string {
    const bake = (globalThis as any).__SPLATROOM_UNIFIED_BAKE__ ?? null;
    const cover = bake && typeof bake.vsCover === 'number' ? bake.vsCover : 0;
    const key = `${cover}`;
    if (bakeMemo.vs.key !== key) {
        bakeMemo.vs.key = key;
        bakeMemo.vs.out = unifiedVertexShader.replace('__SR_VS_COVER__', cover.toFixed(6));
    }
    return bakeMemo.vs.out;
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
// 环模式：由顶点算好的环宽（归一化半径）。见 unifiedVertexShader 里 srRingUV 的说明。
varying @interpolate(flat) srRingUV: f32;

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
// 二期：per-splat 状态（顶点侧 srState 的原样透传；见顶点里那段说明）。
// 片元侧只需要删除位：showDeleted 打开时"已删除"的高斯要淡红 + 降透明度，
// 与 per-instance 片元（splat-shader-wgsl.ts:703-706）同款。
varying @interpolate(flat) srState: u32;
// 拾取用：该 splat 的行号（= cacheIdx），与 picker.readIds 的解码配套。
varying @interpolate(flat) srSplatIndex: u32;
// ===== 二期：裁剪盒（逐字对齐 per-instance 片元，见 splat-shader-wgsl.ts:613-679）=====
// 唯一的差别是盒局部坐标的来源：那边在片元里重建视空间位置，这边由顶点算好、片元插值
// （见顶点里那段说明）。dist 的判定与淡出公式完全一致。
#ifndef PICK_PASS
    varying srBoxLocal: vec3f;
    varying @interpolate(flat) srBoxLocalCentre: vec3f;
    uniform srCropEnabled: f32;
    /**
     * 盒局部坐标取"中心 ↔ 四角"的混合比例（1 = 纯角点、0 = 纯中心）。
     * 为什么要有这个旋钮：角点会把高斯的足迹向盒外"张开"，实测在**默认盒子（= 模型包围盒）**
     * 下会让外侧一层壳被判到盒外（亮点占比 −5%，而主线只有 −0.06%）。取值由 app 每帧喂，
     * 探针可以用全局 __SPLATROOM_CROP_MIX__ 覆盖来标定。
     */
    uniform srCropMix: f32;
    uniform srCropPreview: f32;
    uniform srCropSoftEdge: f32;
    uniform srCropShape: f32;
    uniform srCropRadiusX: f32;
    uniform srCropRadiusY: f32;
    uniform srCropRadiusZ: f32;
    uniform srCropHeight: f32;
    uniform srCropCapWidth: f32;
    uniform srCropCapAlpha: f32;
    /** 粒子特效的整体淡入/淡出（0..1；与 per-instance 的 uEffectFade 同义，在片元里乘 alpha） */
    uniform srEffectFade: f32;
#endif
uniform srPickMode: f32;
// 「轮廓选区」开关（0/1）。见 src/splat/unified-material.ts 的 outlineMode 说明：
// RT1（选区覆盖）的两个消费者语义互斥 —— 描边（outline.ts）要"选中点的高斯 alpha"，
// 衬底（underlay.ts）要"选中点被扣下的那 20% 颜色"。所以片元必须知道当前是哪一种。
uniform srOutlineMode: f32;
// ===== 环模式 / 中心点模式（「Splat 模式」与「显示/隐藏 Splat」两个开关的 **unified 实现**）=====
// 为什么必须在这里做（2026-10-02 实测）：unified 通路**没有 per-instance 实例**
// （entity.gsplat.instance 为 null），于是主线那两套实现全都挂不上：
//   · 环：splat.ts:1873-1880 把 ringSize 设在 per-instance 材质上 ⇒ 那个材质在 unified 里根本不存在；
//   · 中心点：splat-overlay.ts 的中心点覆盖层要 instance.sorter / resource 的几张数据纹理
//     ⇒ 实测 attachedSplat=true 但 orderReady=false、drawPoints=0、entity.enabled=false。
// 结果这四个组合（mode × overlay）在 unified 下画面差 ≤0.34%（等于死开关），而主线是 21~29%。
// 语义与主线逐字对齐：ringSize>0 时内圈压到 0.05、外圈固定 0.6（splat-shader-wgsl.ts:715-722）。
// ⚠️ 本文件是模板字符串：注释里**绝不能出现反引号**（本轮又踩了一次，npm run check 的 audit 能拦住）。
uniform srRingSize: f32;
uniform srCentersSize: f32;

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

// ===== 仪器（2026-09-27，给"裁剪盒默认盒子多啃一层壳"那件事用）=====
// 直接看**片元实际拿到的盒局部坐标**，而不是在 CPU 侧推：
//   cropBoxProbe = 1 ⇒ 输出"该像素是否被判到盒外"（max|local| > 0.5 涂白）
//   cropBoxProbe = 2 ⇒ 输出 max|local| 的灰度（0.5 对应 0.5 灰 ⇒ 亮于中灰就是盒外）
//   cropBoxProbe = 3 ⇒ 同上，但用的是 flat 的**中心**坐标
// 默认 0 = 整段不生效、与未烘焙逐位一致。
const SR_CROP_PROBE: f32 = __SR_CROP_PROBE__;

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
    let srCentres: bool = uniform.srCentersSize > 0.0;
    var alpha: half = srNormExp(A) * gaussianColor.a;
    if (srCentres) {
        // 中心点模式：平坦颜色（覆盖层那种"点"的观感）。主线的覆盖层对再淡的高斯也会画一个点，
        // 所以下面 alphaClip 的丢弃在中心点模式下要让路。
        alpha = max(gaussianColor.a, half(0.85));
    }

    #ifdef PICK_PASS
        if (alpha < half(uniform.alphaClip)) {
            discard;
        }
        // **我们的逐 splat 拾取**（srPickMode = 1）：写高斯**行号**，编码与 picker.readIds 的解码一致。
        // 为什么不直接用引擎那份 vPickId：引擎的 pcId 流装的是 **placementId（按元素/组件）**
        // —— 见引擎里 scope.resolve("uId").setValue(splatInfo.placementId) 那一行 —— 而 app 的 picker
        // 要的是"这个像素上是**哪个高斯**"。实测：走引擎那条分支时读回来全是 0。
        if (uniform.srPickMode > 0.5) {
            let srBits: vec4u = (vec4u(srSplatIndex) >> vec4u(0u, 8u, 16u, 24u)) & vec4u(255u);
            output.color = vec4f(srBits) / 255.0;
        } else {
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
        }
    #else
        if (!srCentres && alpha < half(uniform.alphaClipForward)) {
            discard;
        }
        // ===== 拾取模式：把行号写成颜色（id = r | g<<8 | b<<16 | a<<24，与 picker.readIds 一致）=====
        // 注意这里在 alphaClip 之后：太透明的高斯不该被拾取到（与主线 pick pass 的语义一致）。
        // immediate: true 的那次回读会把这一遍绘制立即提交，所以材质参数不会被下一帧的钩子冲掉。
        if (uniform.srPickMode > 0.5) {
            let srBits: vec4u = (vec4u(srSplatIndex) >> vec4u(0u, 8u, 16u, 24u)) & vec4u(255u);
            output.color = vec4f(srBits) / 255.0;
            output.color1 = vec4f(0.0, 0.0, 0.0, 0.0);
            return output;
        }
        // ===== 仪器：把盒局部坐标直接画出来（默认关闭）=====
        #ifndef PICK_PASS
            if (SR_CROP_PROBE > 0.5) {
                // ⚠️ WGSL **没有三元运算符**，必须用 select(f, t, cond)（写成 cond ? a : b 会
                // invalid character found ⇒ 管线无效 ⇒ 整帧不画，实测画面只剩背景）
                let probeLocal: vec3f = select(srBoxLocal, srBoxLocalCentre, SR_CROP_PROBE > 2.5);
                let maxAbs: f32 = max(max(abs(probeLocal.x), abs(probeLocal.y)), abs(probeLocal.z));
                if (SR_CROP_PROBE > 1.5) {
                    // 灰度：0.5 = 正好在盒边界上
                    output.color = vec4f(vec3f(maxAbs), 1.0);
                } else {
                    // 白 = 判到盒外
                    let outside: f32 = select(0.0, 1.0, maxAbs > 0.5);
                    output.color = vec4f(vec3f(outside), 1.0);
                }
                output.color1 = vec4f(0.0, 0.0, 0.0, 0.0);
                return output;
            }
        #endif
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
        var a: f32 = f32(alpha) * SR_FRAG_GAIN;
        // 粒子特效的整体淡入/淡出（与主线同一处、同一式）
        #ifndef PICK_PASS
            a = a * clamp(uniform.srEffectFade, 0.0, 1.0);
        #endif
        // ===== 二期：裁剪盒（与 per-instance 片元同式；见文件里那段说明）=====
        #ifndef PICK_PASS
            if (uniform.srCropEnabled > 0.5) {
                // 混合中心与四角（见 srCropMix 的说明）：纯角点会让足迹向盒外张开
                let lp: vec3f = mix(srBoxLocalCentre, srBoxLocal, clamp(uniform.srCropMix, 0.0, 1.0));
                // 到裁剪形状边界的距离（>0 在里、<0 在外）：盒 / 圆柱（局部 Y 轴、可椭圆截面）/ 椭球共用
                var dist: f32;
                if (uniform.srCropShape > 1.5) {
                    let rx: f32 = max(uniform.srCropRadiusX, 1e-4);
                    let ry: f32 = max(uniform.srCropRadiusY, 1e-4);
                    let rz: f32 = max(uniform.srCropRadiusZ, 1e-4);
                    let q: vec3f = vec3f(lp.x / rx, lp.y / ry, lp.z / rz);
                    let s: f32 = length(q);
                    dist = (1.0 - s) * min(min(rx, ry), rz);
                } else if (uniform.srCropShape > 0.5) {
                    let rx: f32 = max(uniform.srCropRadiusX, 1e-4);
                    let rz: f32 = max(uniform.srCropRadiusZ, 1e-4);
                    let q: vec2f = vec2f(lp.x / rx, lp.z / rz);
                    let s: f32 = length(q);
                    dist = min((1.0 - s) * min(rx, rz), uniform.srCropHeight * 0.5 - abs(lp.y));
                } else {
                    let ad: vec3f = abs(lp);
                    dist = 0.5 - max(max(ad.x, ad.y), ad.z);
                }

                // 中心到边界的距离（同一条公式，用 flat 的中心局部坐标）
                let lpc: vec3f = srBoxLocalCentre;
                var distCentre: f32;
                if (uniform.srCropShape > 1.5) {
                    let rx: f32 = max(uniform.srCropRadiusX, 1e-4);
                    let ry: f32 = max(uniform.srCropRadiusY, 1e-4);
                    let rz: f32 = max(uniform.srCropRadiusZ, 1e-4);
                    distCentre = (1.0 - length(vec3f(lpc.x / rx, lpc.y / ry, lpc.z / rz))) * min(min(rx, ry), rz);
                } else if (uniform.srCropShape > 0.5) {
                    let rx: f32 = max(uniform.srCropRadiusX, 1e-4);
                    let rz: f32 = max(uniform.srCropRadiusZ, 1e-4);
                    let s: f32 = length(vec2f(lpc.x / rx, lpc.z / rz));
                    distCentre = min((1.0 - s) * min(rx, rz), uniform.srCropHeight * 0.5 - abs(lpc.y));
                } else {
                    let adc: vec3f = abs(lpc);
                    distCentre = 0.5 - max(max(adc.x, adc.y), adc.z);
                }
                let softEdge: f32 = max(uniform.srCropSoftEdge, 0.0005);

                if (dist < 0.0) {
                    if (uniform.srCropPreview > 0.5) {
                        // 盒外淡显强度。原来是 0.035 —— 实测肉眼基本不可见（典型模型色亮度 ~100 ⇒
                        // 淡显后只有 3.5 级，落在"看着就是黑的"区间），于是用户打开预览也仍然
                        // "不知道盒子裁到哪里"（2026-10-02 现场反馈）。0.25 让盒外作为**清晰可见的
                        // 参照**保留下来，同时与盒内的全亮度形成明确边界。
                        a = a * 0.25;
                    } else {
                        // 切面环带：刚出形状的那一圈保留本来的颜色（不重绘），更外面直接丢
                        let capW: f32 = max(uniform.srCropCapWidth, 0.0);
                        if (capW > 0.0 && dist > -capW) {
                            a = a * smoothstep(-capW, 0.0, dist) * uniform.srCropCapAlpha;
                        } else {
                            discard;
                        }
                    }
                } else if (distCentre > softEdge) {
                    // **软边只在中心本来就贴近边界的高斯上生效**。
                    // 不这么做的话：外侧高斯的"角"插值出来的局部坐标会落到边界附近（dist≈0），
                    // 于是它朝外那半边被 smoothstep 压到接近 0 —— 实测默认盒子（= 模型包围盒、
                    // 本该一点不切）下亮点占比掉了 5.1%，而主线只掉 0.06%，而且预览模式也救不回来
                    // （淡出不是丢弃）。主线那边不会有这个问题，因为它的片元位置是**重建出来的表面点**，
                    // 不会像四边形角点那样向盒子外"张开"。
                } else {
                    a = a * smoothstep(0.0, softEdge, dist);
                }
            }
        #endif
        // 二期：**删除但仍在显示**的高斯（showDeleted 打开）—— 与 per-instance 片元同款：
        // 淡红混合 + 透明度降到 40%，让"已删掉、只是还在显示"一眼可辨。
        // 关闭 showDeleted 时这种高斯在顶点就被挪出裁剪体了，根本到不了这里。
        if ((srState & 4u) != 0u) {
            c = mix(c, vec3f(1.0, 0.25, 0.25), 0.6);
            a = a * 0.4;
        }
        // ===== 环模式：**只画每个高斯球的边界** =====
        // 用户口径（2026-10-02）：「环模式是需要显示高斯球的边界」。所以内部**整块丢弃**、
        // 只留贴边的一圈；不是"内部压暗 + 外圈提亮"（那样在密集点云里仍然是一团雾，看不到边界）。
        // 边界定义：归一化平方半径 A ∈ [1-带宽, 1] 的那一圈 —— A=1 就是该高斯的绘制外沿。
        // 环给固定不透明度：高斯在 A→1 处本身 alpha→0，不覆盖的话细小高斯的环根本看不见。
        if (uniform.srRingSize > 0.0) {
            if (A < half(1.0) - half(srRingUV)) {
                discard;
            }
            a = 0.75;
        }
        output.color = vec4f(c * a, a);
        // ===== RT1：选区覆盖（描边 / 衬底后处理的输入）=====
        // 语义与主线片元**逐字对齐**（splat-shader.ts:695-708、splat-shader-wgsl.ts:723-737）：
        //   轮廓开 ⇒ RT0 保持原色、RT1 = 选中点的高斯 alpha（描边后处理据此膨胀出轮廓）；
        //   轮廓关 ⇒ 选中点 RT0 降到 80%，被扣下的 20% 写进 RT1，由衬底加法合成回去。
        // 为什么这一段以前是恒写 0（"一期先写零，选区着色属于二期"）会致命：
        // 调用方在轮廓开着时**故意**把 srSelectedClr 传中性 0（scene.ts:950-951），
        // 于是 RT1 空 ⇒ 描边无源、染色又被清零 ⇒ 框选后画面零反馈（用户报障的根因）。
        // ⚠️ WGSL 没有三元运算符：必须用 select(f, t, cond)。
        let srSelectedBit: bool = (srState & 1u) != 0u;
        if (uniform.srOutlineMode > 0.5) {
            output.color1 = vec4f(0.0, 0.0, 0.0, select(0.0, f32(srNormExp(A)), srSelectedBit));
        } else if (srSelectedBit) {
            output.color = vec4f(c * a * 0.8, a);
            output.color1 = vec4f(c * a * 0.2, a);
        } else {
            output.color1 = vec4f(0.0, 0.0, 0.0, 0.0);
        }
    #endif
    return output;
}
`;
