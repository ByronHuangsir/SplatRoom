import {
    ADDRESS_CLAMP_TO_EDGE,
    FILTER_NEAREST,
    PIXELFORMAT_R8,
    PIXELFORMAT_R16U,
    PIXELFORMAT_R32F,
    PROJECTION_ORTHOGRAPHIC,
    Asset,
    BoundingBox,
    Color,
    Entity,
    GSplatData,
    GSplatInstance,
    GSplatResource,
    Mat4,
    Quat,
    Texture,
    Vec3
} from 'playcanvas';

import { applySplatColorParamsCached, fillSplatColorParams, splatColorParamsScratch } from './color-params';
import { writeGpuCameraUniforms, GpuCameraSource } from './gpu-camera-uniforms';
import { MaterialParamCache } from './material-param-cache';
import { State, SplatState } from './splat-state';
import { releaseStreamCpuStorage } from './stream-storage';
import { TransformPalette } from './transform-palette';
import { ensureUnifiedWorkBuffer, setUnifiedEffect } from './unified-material';
import { CURVE_CHANNELS, CURVE_SAMPLES, curveSetFromDoc, curveSetToDoc, curveSetToTables, emptyCurveSet, identityCurveSamples, toCurveSet, type CurvePoint, type CurveSet } from '../core/color-curves';
import { Serializer } from '../core/serializer';
import { toneRange } from '../core/tone-range';
import { suggestLodLevel, proxyRowToSourceRow } from '../lod/lod';
import { Element, ElementType } from '../scene/element';
import { vertexShader, fragmentShader, gsplatCenter, gsplatModifyVS } from '../shaders/splat-shader';
import { vertexShaderWGSL, fragmentShaderWGSL, gsplatCenterWGSL, gsplatModifyWGSL, gsplatCornerWGSL } from '../shaders/splat-shader-wgsl';
import { Transform } from '../transform/transform';

const vec = new Vec3();
const veca = new Vec3();
const vecb = new Vec3();
const invView = new Mat4();
const invBoxWorld = new Mat4();
const viewToBoxLocal = new Mat4();
// SplatRoom patch: scratch buffers for per-frame main-view sort fallback.
const _fallbackCamPos = new Vec3();
const _fallbackCamDir = new Vec3();
const _fallbackLocalPos = new Vec3();
const _fallbackLocalDir = new Vec3();
const _fallbackInvModel = new Mat4();
// 顺序外推的暂存（派发时写给 worker 的"落地时刻位姿"）
const _predictPos = new Vec3();
const _predictDir = new Vec3();
// M2-3：serialize() 的曲线展平缓冲（每帧复用；serialize 在 scene onUpdate 的单线程循环里跑，不会重入）
const _serializeCurveFlat: number[] = [];
// M2-3：onPreRender 参数块的复用字面量/scratch（缓存内部持有自己的持久副本，这些只是源）
const ZERO4 = [0, 0, 0, 0];
const ONE4 = [1, 1, 1, 1];
const _selClr4 = [0, 0, 0, 0];
const _clr4 = [0, 0, 0, 0];
const _clr4b = [0, 0, 0, 0];

// P0-2（2026-09-20，用户 2000 万点实测 ⑥）：排序派发/相机闸门的节流参数。
//
// 2026-09-21 用户报「快速移动/旋转视角时会出现排序错误 —— 背面的内容跑到前面遮挡住正常画面」
// ⇒ 闸门从"固定 800 ms 一次"改成**"动得够多 + 上一次排序已完成 + 不早于 200 ms"**：
//   • 固定间隔的问题：快速旋转时 800 ms 内相机能转过很大角度，顺序过期得离谱（实测该夹具上
//     4 秒旋转期间只派发 1~2 次，甚至 0 次 ⇒ 顺序基本是冻结的，背面自然盖到前面）。
//   • 新的准入条件把"顺序新鲜度"绑在**相机转了多远**上，而不是挂了多久；同时用完成事件
//     （`sorter.on('updated')` / 引擎 scene 的 `gsplat:sorted`）保证同一时刻只有一次排序在飞，
//     worker 不会被请求淹没（它自己的 1e-3 门限在快速旋转时等于"每帧都排"）。
//   • 代价：快速旋转时排序次数会向 worker 的上限（20M ≈2.5 次/秒）靠拢，每次完成仍有一次
//     ~80 MB 主线程上传 —— 用户明确说"排序错误比卡帧更严重"，所以先保正确性。
//   • 那条恒定地板（100 ms）2026-09-24 改成自适应，见下面 `SORT_MIN_INTERVAL_*` 的实测推导。
const SORT_SETTLE_MS = 200;
// ---- 排序节奏自适应（2026-09-24 第二十二轮）-----------------------------------------------------
//
// 实测一根链条（`_tmp/probe-order-lifetime.cjs`，30°/s 匀速旋转，三条模型）：
//
//   模型            D=派发间隔   L=派发→回包   apply→帧   每份顺序寿命        错位角
//   test-model(2k)     100 ms        0.8 ms      16.7 ms   6 帧 / 100 ms      3.0°
//   test-layered(600k) 117 ms        3.8 ms      55 ms     2–3 帧 / 115 ms    3.5°
//   test-20m(20M)      189 ms      149 ms        50 ms     3–4 帧 / 153 ms    4.6°
//
// 关键结论：**小模型上 D 完全由闸门地板（100 ms）决定，排序本身只要 0.8 ms**。
// 也就是"顺序新鲜度"本来可以再挤 3–5 倍，却白送给了那条为 2000 万点写的恒定地板
// （地板是防止 worker 被淹没的，而单飞 + 引擎 worker 的 1e-3 门限已经在那件事上兜底了）。
//
// 所以地板改成**按实测代价自适应**：一次顺序从派发到上线要花 λ+消费（实测值），
// 地板块就取它的 `SORT_INTERVAL_COST_FACTOR` 倍。小模型自然落在一帧附近、
// 大模型自然退化回原来那条地板 —— 不需要任何按点数写死的阈值，换台机器也成立。
const SORT_MIN_INTERVAL_FLOOR_MS = 16;   // 地板下限：一帧（60 Hz），再密等于每帧都排
const SORT_MIN_INTERVAL_CEIL_MS = 100;   // 地板上限：原来那条恒定地板，大模型不会比从前更密
const SORT_INTERVAL_COST_FACTOR = 1;     // 地板 = (λ + 消费) × 这个倍率

// 相机自上次派发以来转过的角度超过这个值才值得再排一次（度）。
// 2026-09-22 第二十轮：2.5° → **0.75°**。原来那条注释里的"2.5° 是观感阈值"是被实测推翻的：
// 慢转（30°/s）时 2.5° 要 83 ms 才攒够，而闸门地板 200 ms 才是真正的约束；把地板与这个阈值一起降下来，
// 慢转时的派发间隔从 ~200 ms 掉到 ~100 ms（**顺序被替换的整段寿命 D 直接决定错位角的范围**，
// 见 `_sortPredictHorizon` 的"居中"说明）。
const SORT_MOVE_DEG = 0.75;
// 派发后等不到完成事件时，多久之后认为 worker 空闲（异常兜底，避免闸门永久锁死）
const SORT_INFLIGHT_TIMEOUT_MS = 3000;

// ---- 顺序延迟补偿（2026-09-21，用户第三次报"快速旋转时依然排序错位、短暂停留后消失"）----------
//
// 前一轮把死掉的派发路径修活之后，顺序**确实在刷新**了，但用户看到的错位只是变短、没有消失。
// 原因换了一层：闸门保证"顺序在动"，却没保证"顺序对应的位姿是渲染那一刻的位姿"。
// 一次全量排序从 `postMessage` 到落到贴图要 λ 毫秒（20M 实测 150~250 ms：worker 分箱排序 +
// 回到主线程的 ~80 MB 上传），这段延迟里相机又转过了 ω·λ —— 快速旋转（≈300°/s）就是 **45~75°**，
// 正是"背面的内容跑到前面"。停手后错位消失，也是因为停手后补的那一帧用的是静止位姿。
//
// 修法（VR 姿态预测那套）：派发时**不报当下位姿，报"落地时刻"的位姿** —— 沿当前角速度/线速度
// 外推 λ（实测延迟的滑动平均）毫秒。恒速旋转下顺序与落地时的相机对齐，错位角趋近 0；
// 突然换向/急停时速度估计会在 ~60 ms 内衰减，最坏也只是回到"没有补偿"的老样子（不会更差）。
// 停手补帧那条路天然免疫：速度≈0 ⇒ 外推量≈0，用的就是静止位姿。
const SORT_PREDICT_MAX_MS = 600;        // 外推上限（延迟测量异常时不至于把位姿抛到天上去）
const SORT_LATENCY_DEFAULT_MS = 200;    // 首帧还不知道延迟时的初值
const SORT_LATENCY_ALPHA = 0.4;         // 延迟滑动平均权重（排序耗时抖动大，取偏保守）
const SORT_MOTION_WINDOW_MS = 120;      // 速度估计的时间窗：窗口内位姿差 / 时间差
const SORT_MOTION_SAMPLES = 16;         // 位姿环形缓冲长度（120 ms 窗口在 60 fps 下需要 ~8 个）
const SORT_MOTION_BLEND = 0.5;          // 窗口估计之间的混合权重（只做轻度平滑）
const SORT_PREDICT_MIN_DEG = 0.5;       // 外推角小于这个值就不改位姿（静止时保持逐字节一致）
const SORT_PREDICT_MIN_RADIUS = 0.002;  // 外推位移小于模型半径的这个比例也不改（同上）
// 派发间隔的估计权重（第二十轮，见 `_sortPredictHorizon` 的"居中"推导）：
// 顺序从落地到被下一份替换，中间**整段寿命 D** 都用它，而它对齐的只是落地那一刻 ⇒ 平均错位 D/2。
// 把 horizon 往前推 D/2，错位就从 [0, D] 变成 [−D/2, +D/2]（平均 0、峰值减半），**不花任何额外代价**。
const SORT_PREDICT_CENTER_WEIGHT = 0.25;
// "居中"要推 D/2，而 D 是**真实派发间隔**、不是闸门地板：地板只是"最早可以派"的时间，
// 单飞会让真实间隔常常是它的两倍。这里对真实间隔做滑动平均（第二十二轮，实测修正见 `_sortPredictHorizon`）。
const SORT_CADENCE_ALPHA = 0.25;

/**
 * 把曲线表**直接上传**进 R32F 纹理（不经过 `lock()` 的回读路径）。
 *
 * 为什么需要它：`Texture.lock()` 会分配 staging、拷贝、再 `mapAsync` 等 fence；
 * 在 unified 通路（引擎 GPU 排序）的导入路径上这一步会**永久挂住** ——
 * 既不返回也不抛异常，导致整个导入静默卡死（见 `docs/待办-引擎WebGPU-compute.md` §4d）。
 * 曲线表的初始内容本来就是恒等值，根本不需要回读，所以这里走 WebGPU 的
 * `queue.writeTexture` 直传。
 *
 * @returns 是否成功直传（false 表示调用方需要走原来的兜底路径）
 */
function writeCurveTable(device: any, texture: any, table: Float32Array): boolean {
    try {
        const impl = texture?.impl;
        const wgpu = (device as any)?.wgpu;
        const queue = wgpu?.queue;
        const gpuTexture = impl?.gpuTexture ?? impl?.texture ?? null;
        if (!queue?.writeTexture || !gpuTexture) {
            return false;
        }
        const width = CURVE_SAMPLES;
        // ⚠️ `CURVE_CHANNELS` 是**通道名数组**（`['master','red','green','blue']`），不是数量！
        // 之前这里写成 `const height = CURVE_CHANNELS` ⇒ `Number(array)` = **NaN** ⇒
        // `writeTexture` 抛 "Failed to read the 'rowsPerImage' property ... not of type 'unsigned long'"
        // ⇒ 本函数返回 false ⇒ 调用方走 `lock()` 兜底 ⇒ **在 unified 导入路径上永久挂住**
        // （就是 §4d 那个"`?unified=1` 导入卡死"的真正机理：直传一直是坏的，所以每次都在走兜底）。
        const height = CURVE_CHANNELS.length;
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
            return false;
        }
        // ⚠️ 传进来的通常只是**一行**（`identityCurveSamples()` 返回 33 个采样 = 一个通道），
        // 而纹理是 33×4（四个通道各一行）。之前的兜底路径是把这一行 `set` 进 4 个位置，
        // 直传路径必须做同样的事，否则 WebGPU 报
        // "Required size for texture data layout (528) exceeds the linear data size (132)"。
        const rows = height;
        let data = table;
        if (table.length === width && rows > 1) {
            data = new Float32Array(width * rows);
            for (let ch = 0; ch < rows; ch++) {
                data.set(table, ch * width);
            }
        }
        if (data.length < width * rows) {
            return false;
        }
        queue.writeTexture(
            { texture: gpuTexture },
            data,
            { offset: 0, bytesPerRow: Number(width) * 4, rowsPerImage: Number(rows) },
            { width: Number(width), height: Number(rows) }
        );
        return true;
    } catch (e) {
        console.warn('[Splat] uCurve direct upload failed:', e);
        return false;
    }
}

/**
 * 自适应排序地板的**纯函数**版本（`Splat._sortMinIntervalMs` 包一层实例状态调它）。
 *
 * 抽出来的原因：这是"顺序新鲜度"的唯一定义处，而闸门、horizon 的 D 估计、在飞补发
 * 三个调用点都必须拿到同一个值 —— 本仓库吃过"同一条规则在多处各写一遍、只改了被点名的那个"
 * 的亏（见 `docs/bug排查-2026-09-23.md`）。纯函数也让它能被套件直接断言。
 */
function sortMinIntervalMs(latencyMs: number, consumeMs: number, tune: any = {}) {
    if (typeof tune.minIntervalMs === 'number') {
        return tune.minIntervalMs;
    }
    const factor = typeof tune.intervalCostFactor === 'number' ? tune.intervalCostFactor : SORT_INTERVAL_COST_FACTOR;
    const cost = latencyMs + consumeMs;
    const scaled = factor > 0 ? cost * factor : 0;
    return Math.max(SORT_MIN_INTERVAL_FLOOR_MS, Math.min(SORT_MIN_INTERVAL_CEIL_MS, scaled));
}

const boundingPoints =
    [-1, 1].map((x) => {
        return [-1, 1].map((y) => {
            return [-1, 1].map((z) => {
                return [
                    new Vec3(x, y, z), new Vec3(x * 0.75, y, z),
                    new Vec3(x, y, z), new Vec3(x, y * 0.75, z),
                    new Vec3(x, y, z), new Vec3(x, y, z * 0.75)
                ];
            });
        });
    }).flat(3);

class Splat extends Element {
    asset: Asset;
    splatData: GSplatData;
    numSplats = 0;
    numDeleted = 0;
    numLocked = 0;
    numSelected = 0;
    entity: Entity;
    changedCounter = 0;

    // ---- runtime LOD (V3, opt-in) -------------------------------------------
    // Proxy levels decimated from the base data (coarsest last in build order,
    // e.g. [35%, 10%]). Swapping via replaceData to a proxy while the camera is
    // far reduces per-frame sort/vertex cost on very large scans. The feature
    // is inert until setLodAssets() registers levels AND the scene's
    // 'lod.allowProxy' gate reports a non-editing browsing state.
    lodAssets: { asset: Asset; numSplats: number }[] = [];
    lodEnabled = false;
    /** -1 = full-resolution base asset; otherwise index into lodAssets. */
    lodLevel = -1;
    /**
     * 导入时按设备预算抽稀过的信息（`src/core/splat-tier.ts`）。`null` = 原样导入。
     * 保留下来是为了让 UI / 探针能说清"你现在看到的不是全部点"。
     */
    importReduction: { from: number; to: number; tier: string; device: string; reason: string } | null = null;
    _lodBaseAsset: Asset | null = null;
    _lodLastSwitchAt = 0;
    /**
     * 正在进行的 `applyLod`（M3-4）。
     *
     * `applyLod` 内部是 `replaceData` —— 它会**换掉整个 entity**。两条调用路径会并发：
     * 场景每帧的 `updateLodSwitching`（不 await）和 M3-4 新加的"op 执行前强制回全分辨率"
     * （必须 await）。两个 `replaceData` 叠在一起 = 互相销毁对方的 entity，
     * 表现是模型消失或 entity 错乱。所以这里把切换串成一条链：后来的等前一个走完再判。
     */
    private _lodSwitching: Promise<void> = Promise.resolve();
    /**
     * 代理层是"按需构建"的（见 `src/lod/editor-lod.ts`）：场景发现相机远到需要代理层时
     * 只发一次 `lod.needs`，用这个标志去重。`setLodAssets()`/`releaseLodAssets()` 会复位。
     */
    _lodBuildRequested = false;
    // 一次性告警标记：主相机引用缺失（排序兜底无法取相机姿态）只提示一次。
    // 避免每帧刷屏。见 onPreRender() 里的主相机缺失兜底分支。
    _warnedNoMainCam = false;
    // 一次性告警标记：instance 缺失（unified 默认通路每帧命中，只提示一次）。
    _warnedNoInstance = false;
    stateTexture: Texture;
    // encapsulates per-splat state mirror (cpu Uint8Array + gpu Texture).
    // all writes go through state.setBits/clearBits/toggleBits, then flush().
    state: SplatState;
    transformTexture: Texture;
    /** 曲线调色 LUT（33×1 R32F；见 src/core/color-curves.ts） */
    curveTexture: Texture;
    /** 当前曲线采样表（33 点 × 4 通道；`null` = 全恒等，画面零改动） */
    private _curveTables: Float32Array | null = null;
    /** 曲线控制点（面板的真相源；文档保存/回填用） */
    private _curvePoints: CurveSet = emptyCurveSet();
    selectionBoundStorage: BoundingBox;
    localBoundStorage: BoundingBox;

    // pristine copy of the engine's CPU-computed local AABB (see the constructor)
    private cpuBoundStorage = new BoundingBox();
    worldBoundStorage: BoundingBox;

    // O1 (docs/audit/00-总结.md): set while a range-slider drag is in flight so that
    // selection-only state changes skip the GPU bound pass. See updateState().
    private _boundsDeferred = false;
    private _selectionBoundDirty = false;

    _visible = true;
    transformPalette: TransformPalette;

    // per-splat camera last-pose for the main-view sort fallback (module-level
    // scratch caused splats to compare against each OTHER's last pose, so every
    // splat re-dispatched a sort every frame once any camera moved)
    private _sortLastPos = new Vec3();
    private _sortLastDir = new Vec3();
    // P0-2（2026-09-20，用户 2000 万点实测 ⑥）：交互期排序的"最小间隔 + 停手补一帧"状态。
    // 见 onPreRender 里那段的注释：每帧派发全量排序会让 worker 100% 饱和（实测轨道旋转
    // max 帧 462.8 ms、3 秒内 5 帧 >33 ms），而上游 SuperSplat 3.3.0 在运动帧**根本不排序**。
    private _sortLastDispatch = 0;
    // 上一次派发时的相机位姿（局部空间）：准入判定用"相对上次派发动了多远"，不是"这一帧动没动"
    private readonly _sortDispatchPos = new Vec3();
    private readonly _sortDispatchDir = new Vec3(1, 0, 0);
    // 派发时刻（0 = 没有排序在飞）；完成事件到达时清零
    private _sortPendingSince = 0;
    // 在飞期间攒下的最新待办位姿（自己的合并，见 dispatchSort）
    private readonly _sortPendingPos = new Vec3();
    private readonly _sortPendingDir = new Vec3(1, 0, 0);
    private _sortHasPending = false;
    private _sortSettleAt = 0;

    // ---- 顺序延迟补偿的状态（见 SORT_PREDICT_* 那段的说明）----------------------------------
    // 位姿环形缓冲（速度估计的时间窗就是它的跨度）
    private readonly _sortHistT = new Float64Array(SORT_MOTION_SAMPLES);
    private readonly _sortHistDir: Vec3[] = Array.from({ length: SORT_MOTION_SAMPLES }, () => new Vec3(1, 0, 0));
    private readonly _sortHistPos: Vec3[] = Array.from({ length: SORT_MOTION_SAMPLES }, () => new Vec3());
    private _sortHistHead = 0;
    private _sortHistCount = 0;
    /** 连续"窗口内没转动"的帧数（诊断用） */
    private _sortMotionStill = 0;
    /** 旋转矢量速度（轴×角速度，rad/ms）。单向转时是常量；来回蹭会互相抵消 ⇒ 自动不补偿 */
    private readonly _sortRotRate = new Vec3();
    /** 线速度（局部单位/ms） */
    private readonly _sortLinRate = new Vec3();
    /** 一次排序从派发到落地的实测延迟（滑动平均，ms） */
    private _sortLatencyMs = SORT_LATENCY_DEFAULT_MS;
    // 实测派发间隔的滑动平均（顺序延迟补偿里"居中"那一步用的 D，见 `_sortPredictHorizon`）
    private _sortCadenceMs = 0;
    private _sortCadenceSamples = 0;
    private _sortLatencySamples = 0;
    /** 回包 → 被某帧消费（上传并用于渲染）的实测延迟（滑动平均，ms）；外推的第二步 */
    private _sortConsumeMs = 0;
    private _sortConsumeSamples = 0;
    /** 最近一次回包时刻（0 = 没有待消费的结果） */
    private _sortLandedAt = 0;

    selectionAlpha = 1;

    _name = '';
    _tintClr = new Color(1, 1, 1);
    _temperature = 0;
    _saturation = 1;
    _brightness = 0;
    _blackPoint = 0;
    _whitePoint = 1;
    _transparency = 1;
    _highlights = 0;
    _shadows = 0;
    _contrast = 0;
    _colorGradeEnabled = true;
    _showDeleted = false;

    // 粒子化散射进度：0 = 完整模型，1 = 完全散开成粒子（顶点着色器插值）
    _scatterProgress = 0;
    // 散射参数缓存（模型空间包围盒中心与半径），在 bindAsset 后计算
    // ensureScatterParams 计算一次
    _scatterCenter = new Vec3();
    _scatterRadius = 1;
    // 特效模式与参数（波纹开场、飘散散场等）
    _effectMode = 0;
    _effectTime = 0;
    _effectColor = new Vec3(1, 1, 1);

    // HSL per-channel (8 zones: R, O, Y, G, A, B, P, M)
    _hslHue = new Float32Array(8);
    _hslSat = new Float32Array(8);
    _hslLum = new Float32Array(8);

    // M2-3：每帧材质参数缓存（值没变就不调 setParameter；数组走缓存持有的持久副本）。
    // 材质被 replaceData 重建时缓存按对象身份自动失效重写。
    private readonly _matParamCache = new MaterialParamCache();

    measurePoints: Vec3[] = [];
    measureSelection = -1;
    // 测量比例尺：1 个模型单位 = measureScale 个实际单位；null = 未设置（按模型单位显示）
    measureScale: number | null = null;
    measureScaleUnit = 'm';

    orientPoints: Vec3[] = [];
    orientSelection = -1;

    rebuildMaterial: (bands: number) => void;

    constructor(asset: Asset, rotation: Quat) {
        super(ElementType.splat);

        const { device } = asset.resource as GSplatResource;

        // create the entity once. its transform persists across frame swaps so
        // an animated sequence can replace its data without losing the user's
        // transform (see replaceData).
        this.entity = new Entity('splatEntity');

        this.selectionBoundStorage = new BoundingBox();

        // create the transform palette (reused across frame swaps; index 0 is identity)
        this.transformPalette = new TransformPalette(device);

        // rebuilds material chunks/params. reads the *current* gsplat instance and
        // state/transform textures so it remains valid after a replaceData swap
        // (the 'view.bands' listener registered in add() keeps pointing at it).
        this.rebuildMaterial = (bands: number) => {
            const instance = this.entity.gsplat.instance;
            // ⚠️ 2026-09-25：unified 通路（引擎 GPU 排序）下 `instance` 是 **null** ——
            // 那条路的材质是每层的 `GSplatHybridRenderer._material`，由 `scene.ts` 的
            // `ensureUnifiedMaterial()` 钩子负责（见 docs/待办-引擎WebGPU-compute.md §4t）。
            // 这里必须**直接返回**：原先无条件 `const { material } = instance` ⇒ TypeError ⇒
            // 被导入链的 catch 接住 ⇒ 弹错误框等人点确定 ⇒ 在无人操作时**导入永不 settle**
            // （这就是"`?unified=1` 导入卡死"的直接原因，§4d）。
            if (!instance) {
                return;
            }
            const { material } = instance;
            const { glsl, wgsl } = material.shaderChunks;
            glsl.set('gsplatVS', vertexShader);
            glsl.set('gsplatPS', fragmentShader);
            glsl.set('gsplatCenterVS', gsplatCenter);
            glsl.set('gsplatModifyVS', gsplatModifyVS);

            // the WebGPU backend compiles the splat material from WGSL sources, so
            // the GLSL chunks above would be ignored there (the engine's stock WGSL
            // shader would run and our two-attachment splat pass would be invalid)
            if (device.isWebGPU) {
                wgsl.set('gsplatVS', vertexShaderWGSL);
                wgsl.set('gsplatPS', fragmentShaderWGSL);
                wgsl.set('gsplatCenterVS', gsplatCenterWGSL);
                wgsl.set('gsplatModifyVS', gsplatModifyWGSL);
                wgsl.set('gsplatCornerVS', gsplatCornerWGSL);
            }

            material.setDefine('SH_BANDS', `${Math.min(bands, (instance.resource as GSplatResource).shBands)}`);
            material.setParameter('splatState', this.stateTexture);
            material.setParameter('splatTransform', this.transformTexture);
            material.update();

            material.setParameter('saturation', this._saturation);
            material.setParameter('highlights', this._highlights);
            material.setParameter('shadows', this._shadows);
            material.setParameter('contrast', this._contrast);
            material.setParameter('showDeleted', 0);
            material.setParameter('hslHueA', [this._hslHue[0], this._hslHue[1], this._hslHue[2], this._hslHue[3]]);
            material.setParameter('hslHueB', [this._hslHue[4], this._hslHue[5], this._hslHue[6], this._hslHue[7]]);
            material.setParameter('hslSatA', [this._hslSat[0], this._hslSat[1], this._hslSat[2], this._hslSat[3]]);
            material.setParameter('hslSatB', [this._hslSat[4], this._hslSat[5], this._hslSat[6], this._hslSat[7]]);
            material.setParameter('hslLumA', [this._hslLum[0], this._hslLum[1], this._hslLum[2], this._hslLum[3]]);
            material.setParameter('hslLumB', [this._hslLum[4], this._hslLum[5], this._hslLum[6], this._hslLum[7]]);

            // 粒子化散射 uniform（默认 0 = 完整模型）
            this.ensureScatterParams();
            // 曲线 LUT 纹理（内容随曲线就地更新，绑定一次即可）
            material.setParameter('uCurve', this.curveTexture);
            material.setParameter('uScatterProgress', this._scatterProgress);
            material.setParameter('uScatterRadius', this._scatterRadius);
            material.setParameter('uScatterCenter', [this._scatterCenter.x, this._scatterCenter.y, this._scatterCenter.z]);
            material.setParameter('uEffectMode', this._effectMode);
            material.setParameter('uEffectTime', this._effectTime);
            material.setParameter('uEffectColor', [this._effectColor.x, this._effectColor.y, this._effectColor.z]);
            material.setParameter('uEffectFade', 1);
        };

        // bind the initial frame's data, applying the file's load rotation
        this.bindAsset(asset, rotation);
    }

    /** 计算粒子化散射参数：模型空间包围盒中心 + 半径（对角线一半 * 1.2）*/
    private ensureScatterParams() {
        const bound = this.localBound;
        if (!bound || !bound.center) return;
        this._scatterCenter.copy(bound.center);
        this._scatterRadius = Math.max(0.01, bound.halfExtents.length() * 1.2);
    }

    /**
     * 设置曲线（一组控制点：RGB 主 / 红 / 绿 / 蓝）。
     *
     * 传全 `null`（或全恒等）⇒ 关闭：着色器里 `uCurveEnabled = 0` 整段跳过，
     * 画面与"没有曲线功能"逐位一致（这是默认状态，也是本仓库对观感类改动的硬要求）。
     *
     * @param set - 各通道的控制点（`null` = 该通道恒等）
     */
    setCurves(set: Partial<CurveSet> | null) {
        const curves = toCurveSet(set);
        const tables = curveSetToTables(curves);
        this._curvePoints = curves;
        this._curveTables = tables;
        // 33×4 的 R32F 纹理：行 = 通道（0 主 / 1 R / 2 G / 3 B）
        const data = this.curveTexture.lock() as Float32Array;
        if (tables) {
            data.set(tables.subarray(0, CURVE_SAMPLES * 4));
        } else {
            for (let ch = 0; ch < 4; ch++) {
                data.set(identityCurveSamples(), ch * CURVE_SAMPLES);
            }
        }
        this.curveTexture.unlock();
        this.scene.events.fire('splat.curve', this);
    }

    /**
     * 只设置 RGB 主曲线（等价于 `setCurves({ master })`；探针/脚本的快捷入口）。
     *
     * @param points - 控制点；`null` 或不足 2 个 ⇒ 主曲线恒等
     */
    setCurvePoints(points: CurvePoint[] | null) {
        this.setCurves({ ...this._curvePoints, master: points && points.length >= 2 ? points : null });
    }

    /** 当前曲线采样表（长度 33×4；`null` = 全恒等）。导出镜像直接读它。 */
    get curveTables() {
        return this._curveTables;
    }

    /** 当前曲线控制点（各通道 `null` = 恒等）；文档保存与面板回填用 */
    get curves(): CurveSet {
        return toCurveSet(this._curvePoints);
    }

    /**
     * 设置粒子化散射进度（0=模型 1=粒子），并同步到 GPU material。
     * @param progress - 散射进度 0..1
     * @param radiusScale - 散射半径相对包围盒的倍数（预设控制）
     * @param effectMode - 特效模式??=默认散射??=波纹开场，2=飘散散场
     * @param effectTime - 效果进度 0..1（波纹半??/ 飘散进度??
     * @param effectColor - 效果高亮色（波纹/火花色，可选）
     * @param fade - 整体透明??0..1（开场淡??0??，散场淡??1????
     */
    setScatterProgress(progress: number, radiusScale = 1, effectMode = 0, effectTime = 0, effectColor?: [number, number, number], fade = 1) {
        this._scatterProgress = progress;
        // unified 通路（引擎 GPU 排序）也要跟着走：它的特效参数不在 instance 材质上，
        // 由 unified 材质单独持有（见 src/splat/unified-material.ts 的 setUnifiedEffect）。
        this.ensureScatterParams();
        if (effectColor) {
            this._effectColor.set(effectColor[0], effectColor[1], effectColor[2]);
        }
        setUnifiedEffect(this.scene, {
            progress,
            radius: this._scatterRadius * radiusScale,
            center: [this._scatterCenter.x, this._scatterCenter.y, this._scatterCenter.z],
            mode: effectMode,
            time: effectTime,
            color: [this._effectColor.x, this._effectColor.y, this._effectColor.z],
            fade
        });
        const instance = this.entity.gsplat?.instance;
        const material = instance?.material;
        if (!material) return;
        material.setParameter('uScatterProgress', progress);
        material.setParameter('uScatterRadius', this._scatterRadius * radiusScale);
        material.setParameter('uScatterCenter', [this._scatterCenter.x, this._scatterCenter.y, this._scatterCenter.z]);
        material.setParameter('uEffectMode', effectMode);
        material.setParameter('uEffectTime', effectTime);
        if (effectColor) {
            this._effectColor.set(effectColor[0], effectColor[1], effectColor[2]);
        }
        material.setParameter('uEffectColor', [this._effectColor.x, this._effectColor.y, this._effectColor.z]);
        material.setParameter('uEffectFade', fade);
    }

    // bind a gsplat asset onto this element's entity: creates the gsplat
    // component, the per-splat state/transform channels and their gpu textures,
    // and caches the instance bounds. When `rotation` is supplied (initial load)
    // the entity rotation is set; on a frame swap it is omitted so the user's
    // transform is preserved.
    private bindAsset(asset: Asset, rotation?: Quat) {
        const splatResource = asset.resource as GSplatResource;
        const splatData = splatResource.gsplatData as GSplatData;
        const { device } = splatResource;

        this.asset = asset;
        this.splatData = splatData;
        this.numSplats = splatData.numSplats;

        // name and orientation are set on the initial bind only; a frame swap
        // (replaceData, no rotation) keeps the element's name and transform
        if (rotation) {
            this._name = (asset.file as any).filename;
            this.entity.setLocalRotation(rotation);
        }

        // **通路开关**（2026-09-23 起为实验开关，3.23.58 起转默认，M1-3）：
        // 引擎里有两条 splat 通路 —— per-instance + worker 排序（旧主线，顺序有滞后），
        // 以及 unified 世界缓冲 + **引擎自带 GPU 基数排序**（顺序与绘制同帧，没有滞后）。
        // 3.23.58 起默认走后者（仅 WebGPU 设备）；`?unified=0` 或 `__SPLATROOM_UNIFIED__ = false`
        // 回前者（逃生门）。
        //
        // 2026-09-25：判定来源**归一化**到 `__SPLATROOM_UNIFIED__` 一个全局 ——
        // `main.ts` 启动时会把 `?unified=` 映射成它，探针也可以在场景构造前直接设它。
        // 原先这里同时读 `location.search`、而材质钩子读全局，两处时机不同 ⇒
        // "开关到底生效没有"取决于谁先读到（实测踩到过，见 docs/待办-引擎WebGPU-compute.md §4c）。
        const useUnified = (globalThis as any).__SPLATROOM_UNIFIED__ === true;

        this.entity.addComponent('gsplat', {
            asset,
            unified: useUnified
        });

        if (!this.entity.gsplat) {
            console.error('[Splat.bindAsset] gsplat component missing after addComponent');
        }

        // unified 模式下引擎**不给** `instance`（改用 `_placement`），所以"就绪"要按两种模式判。
        // ⚠️ 2026-09-25：实测 unified 模式下 `_placement` 常常是 **null**（引擎的
        // `_onGSplatAssetLoad` 拿不到 resource 就早退，而且不会重试），导入链随后会在别处
        // 静默失败 —— 表现为"没有 splat 元素、导入 promise 永不 settle"。
        // 详见 docs/待办-引擎WebGPU-compute.md §4d（那里记着已经排除过的几种解释）。
        if (!this.entity.gsplat?.instance && !(this.entity.gsplat as any)?._placement) {
            console.warn('[Splat.bindAsset] neither instance nor placement after addComponent;',
                'unified =', useUnified, this.entity.gsplat);
        }

        const instance = this.entity.gsplat.instance;

        // added per-splat state channel
        // ⚠️ 位值的**唯一定义**在 `src/splat/state-bits.ts`：
        // selected = 1、locked = 2、deleted = 4。
        // （这里原先写的是"bit 1 selected / bit 2 deleted / bit 3 locked"，把 deleted 和
        //  locked 写反了 —— 实测按它写出来的判据会去数 locked，排查时被带偏过一次。）
        if (!splatData.getProp('state')) {
            splatData.getElement('vertex').properties.push({
                type: 'uchar',
                name: 'state',
                storage: new Uint8Array(splatData.numSplats),
                byteSize: 1
            });
        }

        // per-splat transform matrix
        //
        // ⚠️ M3-4：原来是**无条件 push**，于是每次 bind 都多一份 `Uint16Array(numSplats)`
        // 和一个同名属性。代理层切换（现在编辑↔浏览往返会频繁触发）就是每次切换泄漏
        // 2 字节 × 点数 —— 20M 模型上**每次 40 MB**，来回切几次就把堆吃掉了。
        // 同一份 splatData 的长度不变、内容语义也不变，复用即可。
        if (!splatData.getProp('transform')) {
            splatData.getElement('vertex').properties.push({
                type: 'ushort',
                name: 'transform',
                storage: new Uint16Array(splatData.numSplats),
                byteSize: 2
            });
        }

        const dims: any = (splatResource as any).textureDimensions;
        const width = Math.max(1, Math.floor(Number(dims?.x) || 0)) || 1;
        const height = Math.max(1, Math.floor(Number(dims?.y) || 0)) || 1;

        // pack spherical harmonic data
        const createTexture = (name: string, format: number) => {
            return new Texture(device, {
                name: name,
                width: width,
                height: height,
                format: format,
                mipmaps: false,
                minFilter: FILTER_NEAREST,
                magFilter: FILTER_NEAREST,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE
            });
        };

        // create the state texture and the SplatState mirror that owns it.
        // splatData.getProp('state') aliases state.data so existing read-only
        // consumers (serialize, status-bar, etc) keep working unchanged.
        this.stateTexture = createTexture('splatState', PIXELFORMAT_R8);
        this.state = new SplatState(splatData.getProp('state') as Uint8Array, this.stateTexture);
        this.transformTexture = createTexture('splatTransform', PIXELFORMAT_R16U);

        // 曲线调色 LUT（33×4，R32F）：行 0 = RGB 主曲线，行 1/2/3 = R/G/B。
        // 默认是恒等曲线 + `uCurveEnabled = 0`，所以不设曲线时着色器整段跳过、
        // 画面与之前逐位一致（见 src/core/color-curves.ts）。
        this.curveTexture = new Texture(device, {
            name: 'uCurve',
            width: CURVE_SAMPLES,
            height: 4,
            format: PIXELFORMAT_R32F,
            mipmaps: false,
            minFilter: FILTER_NEAREST,
            magFilter: FILTER_NEAREST,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE
        });
        {
            // ⚠️ 2026-09-25：`lock()` 会走**回读**（分配 staging + 拷贝 + mapAsync 等 fence），
            // 而 unified 通路的导入路径上这一步**会永久挂住**（实测：`?unified=1` 导入时它
            // 再也不返回，也不抛异常 —— 后面的 TypeError 都来不及抛，
            // 表现就是"导入静默卡死、没有 splat 元素"）。
            //
            // 曲线的初始内容**本来就是恒等表**，完全没有回读的必要，所以这里改成
            // **直接上传**（`device.queue.writeTexture` 那条同步路径，不碰 staging、不等 fence）。
            // 这条改动对两条通路都成立，而且消掉了一次每实例导入的 GPU 回读往返。
            const ident = identityCurveSamples();
            if (!writeCurveTable(device, this.curveTexture, ident)) {
                // 直传不可用（非常规后端）时退回原来那套；它只在这个兜底分支里才可能挂，
                // 而曲线默认恒等 ⇒ 即使这里失败，画面也不受影响（`uCurveEnabled = 0` 整段跳过）。
                try {
                    const data = this.curveTexture.lock() as Float32Array;
                    for (let ch = 0; ch < 4; ch++) {
                        data.set(ident, ch * CURVE_SAMPLES);
                    }
                    this.curveTexture.unlock();
                } catch (e) {
                    console.warn('[Splat.bindAsset] uCurve upload failed; identity curves used instead:', e);
                }
            }
        }

        // ⚠️ 2026-09-25：unified 通路下 `instance` 是 **null** —— 引擎用 `_placement` 代替它
        // （`GSplatComponent.get instance()` 在 unified 下返回 null，资源挂在 `_placement.resource`）。
        // 这里原先直接读 `instance.resource.aabb`，在 unified 下就是一个 TypeError；
        // 而它被导入链的 catch 吞掉 ⇒ 表现为"导入静默失败、没有 splat 元素"。
        // 所以资源统一从组件上取（两种模式都有）。
        const boundResource = (this.entity.gsplat as any)?.resource ?? instance?.resource ?? splatResource;
        // 大模型：释放引擎那些流纹理的 **CPU 侧副本**（无损，见 stream-storage.ts 的说明）。
        // 放在这里是因为 `GSplatResource` 构造时就已经 `lock()`/`unlock()` 上传完毕，
        // 之后没有任何读取路径；2000 万点实测能省 **1850MB** 常驻。
        const freed = releaseStreamCpuStorage(boundResource, splatData.numSplats);
        if (freed > 0) {
            console.log(`[Splat] 释放流纹理的 CPU 副本 ${(freed / 1048576).toFixed(0)}MB（无损）`);
        }
        this.localBoundStorage = boundResource.aabb;
        // keep a pristine copy of the engine's CPU-computed AABB: localBoundStorage is
        // an alias of it, so the GPU bound pass below overwrites the CPU values
        // (with zeros on WebGPU, where its readback returns nothing)
        this.cpuBoundStorage.copy(boundResource.aabb);
        // @ts-ignore
        this.worldBoundStorage = instance?.meshInstance?._aabb ?? this.localBoundStorage;

        // @ts-ignore
        if (instance?.meshInstance) {
            // @ts-ignore
            instance.meshInstance._updateAabb = false;
        }

        // when sort changes, re-render the scene. the instance's sorter is
        // created lazily (and never on WebGPU, which sorts into a storage
        // buffer), so this binding is optional rather than assumed
        // unified 模式下 `instance` 是 null（引擎用 `_placement`），这里必须整体可选链 ——
        // 否则就是一个 TypeError，而导入链的 catch 会把它吞掉（正是"导入静默失败"的来源之一）。
        instance?.sorter?.on('updated', () => {
            this.changedCounter++;
            this.scene.forceRender = true;
        });

        // NOTE: do NOT "prime" instancingCount / numSplats here. The engine's
        // update() sets them only when applyPendingSorted() returns a real count
        // —which requires culler to push cameras into instance.cameras[] first.
        // If the cull path ever skips this instance (e.g. individual splats
        // hidden under groupRenderer, or any code path that prevents the
        // gsplat cameras array from being populated), applyPendingSorted()
        // returns -1 forever and our "prime" would lock instancingCount at the
        // full count with the identity order texture —model renders in raw
        // storage order with NO depth sort —half-transparent gaussians mix
        // randomly —visually identical to "near small / far big" (a.k.a. the
        // PiP order-pollution symptom of pre-v9.1). Letting the engine default
        // (instancingCount=0, numSplats=0) keeps the model blank for the few
        // frames until the first real sort lands, which is the correct trade.
    }

    // wait for the next scene render to complete, with a safety timeout so a
    // stalled render loop (e.g. a backgrounded tab where rAF is paused) can't
    // block frame swapping forever. In a live app postrender fires within a
    // frame, so the timeout never matters.
    private waitForRender(): Promise<void> {
        return new Promise((resolve) => {
            // single finish() removes the listener and clears the timeout, so the
            // common case (postrender fires first) doesn't leave a pending timer.
            const handles: { off?: { off: () => void }, timer?: ReturnType<typeof setTimeout> } = {};
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                handles.off?.off();
                clearTimeout(handles.timer);
                resolve();
            };
            handles.off = this.scene.events.on('postrender', finish);
            // safety: don't block frame swapping forever if the render loop is stalled
            handles.timer = setTimeout(finish, 200);
        });
    }

    // swap in a new frame's gsplat data while preserving this element's identity,
    // transform and visual properties. used by animated sequence playback so each
    // frame doesn't recreate the whole element.
    //
    // The gsplat lives on this.entity (read in many places), so we can't double
    // buffer on a child. Instead we bind the new frame to a *fresh* entity, sort
    // it, and let it render once alongside the still-present old entity before
    // destroying the old one. This overlap avoids a blank/unsorted frame
    // flickering on screen during the swap (the old frame masks the new one's
    // first sort), matching the previous per-frame load behaviour. The user's
    // transform is carried across so it persists.
    //
    // By default the previously-bound asset is unloaded (sequence frames are
    // transient). Pass keepPrevious=true when the caller still owns the old
    // asset —e.g. an undo/redo op swapping between its two snapshots —so the
    // reverse step can bind it again.
    async replaceData(asset: Asset, keepPrevious = false) {
        console.log('[Splat.replaceData] start', this.name, 'asset=', (asset.file as any)?.filename);
        const oldEntity = this.entity;
        const oldAsset = this.asset;
        const oldStateTexture = this.stateTexture;
        const oldTransformTexture = this.transformTexture;

        // carry the current transform onto the new entity
        const position = oldEntity.getLocalPosition().clone();
        const rotation = oldEntity.getLocalRotation().clone();
        const scale = oldEntity.getLocalScale().clone();

        this.entity = new Entity('splatEntity');
        this.entity.setLocalPosition(position);
        this.entity.setLocalRotation(rotation);
        this.entity.setLocalScale(scale);

        // bind the new frame (no rotation: transform already applied above)
        this.bindAsset(asset);
        console.log('[Splat.replaceData] bindAsset done, instance=', !!this.entity.gsplat?.instance);

        // add the new entity to the scene and configure its instance
        this.scene.contentRoot.addChild(this.entity);
        this.entity.gsplat.layers = [this.scene.splatLayer.id];
        this.rebuildMaterial(this.scene.events.invoke('view.bands'));

        // refresh gpu state/counts/bounds, then wait for the new frame to render
        // before removing the old entity, which keeps the previous frame on screen
        // in the meantime. Skip the wait during offline video render
        // (lockedRenderMode): renders are gated on scene.lockedRender there, so
        // blocking on a render would deadlock —and the render loop sorts+captures
        // each frame deterministically anyway.
        await this.updateState(State.deleted);
        console.log('[Splat.replaceData] updateState done, instance=', !!this.entity.gsplat?.instance);
        if (!this.scene.lockedRenderMode) {
            await this.waitForRender();
        }
        console.log('[Splat.replaceData] waitForRender done, instance=', !!this.entity.gsplat?.instance);

        // notify dependents (e.g. the centers overlay, which parents itself under
        // this.entity) to re-bind to the new entity/instance before the old entity
        // is destroyed —otherwise they're torn down with it and never re-attach
        // (no selection.changed fires on a frame swap).
        this.scene.events.fire('splat.replaced', this);

        // tear down the previous frame
        //
        // ⚠️ 必须先**显式销毁 gsplat 组件的 placement**，再 destroy entity（M3-3 实测根因）。
        // 组件的 `onDisable()` 只做 `removeFromLayers()`（把 placement 从 layer 列表里摘掉），
        // **不会**调用 `placement.destroy()` —— 真正释放的是 `destroyInstance()`
        // （`framework/components/gsplat/component.js`：`removeFromLayers` + `placement.destroy`
        // + 置 null）。少了这一步，unified 世界里那份 20M 的 work buffer 分配就一直挂着：
        //
        //   20M 切到 2M 代理层之后，把场景里**唯一**的 splat 隐藏，GPU span 仍有 **46.09 ms**
        //   （只比 50.26 少了 4.2 ms —— 那正好是 2M 代理层自己的成本，见
        //   `_tmp/diag-browse-residue.cjs`）。也就是说切换之后是 20M 与 2M **一起在渲染**，
        //   代理层带来的加速被旧数据整个吃掉：稳态帧时 50 ms，比全分辨率的 44.8 ms 还慢。
        //   静止时切换看不到它（下一帧的 reconcile 会兜住），运动中切换必现 ——
        //   而"浏览时相机一直在动"恰恰是 LOD 唯一有用的场景。
        try {
            const oldComp = oldEntity.gsplat as any;
            if (oldComp && typeof oldComp.destroyInstance === 'function') {
                oldComp.destroyInstance();
            }
        } catch (e) {
            console.warn('[Splat.replaceData] old placement teardown failed:', e);
        }
        oldEntity.destroy();
        oldStateTexture.destroy();
        oldTransformTexture.destroy();
        if (!keepPrevious) {
            oldAsset.registry?.remove(oldAsset);
            oldAsset.unload();
        }

        // unified（引擎 GPU 排序）通路：数据换过之后必须**强制重建一次 work buffer**。
        //
        // 这是 M3-3 实测出来的第二层根因。现象是：20M 切到 2M 代理层之后，帧时不降反升
        // （44.8 → 50 ms），而且**把场景里唯一的 splat 隐藏、相机完全静止**，GPU span
        // 仍然稳在 45.6 ms（`_tmp/diag-browse-residue.cjs`）—— 也就是说这份开销跟"画了什么"
        // 无关。引擎侧的痕迹对得上：`world._framesTillFullUpdate` 每帧都在倒数、
        // `_bufferCopyUploaded = 1`，即 work buffer 仍按**旧的 20M 容量**在做周期性整块上传，
        // 每帧 ~46 ms。静止时切换看不到它（下一帧的常规重建会兜住），**运动中切换必现** ——
        // 而"浏览时相机一直在动"正是 LOD 唯一有用的场景，所以它必须在这里显式修掉。
        //
        // `force = true` 是必要的：这个函数默认"每个 world 每个版本只强制一次"，
        // 而换数据之后版本已变，必须绕过那层幂等才能真正重传。
        try {
            ensureUnifiedWorkBuffer(this.scene as any, true);
        } catch (e) {
            console.warn('[Splat.replaceData] unified work buffer rebuild failed:', e);
        }
        // 标记只是"下一帧需要 full rebuild"，真正重建在引擎 `world.bake()` 里、要几帧才推进完
        // （render-ready version 要等排序推进）。切换之后**主动要几帧**：实测只等
        // `waitForRender()` 那一帧时，稳态会停在没有收缩的旧尺寸 work buffer 上 ——
        // 表现是"切到 2M 反而比 20M 更慢"（50 ms vs 44.8 ms，且把 splat 隐藏后仍有 45.8 ms
        // 的固定上传开销，见 `_tmp/diag-browse-residue.cjs`）。
        if (!this.scene.lockedRenderMode) {
            for (let i = 0; i < 3; i++) {
                this.scene.forceRender = true;
                await new Promise<void>((resolve) => {
                    requestAnimationFrame(() => resolve());
                });
            }
        }

        this.changedCounter++;
        this.scene.forceRender = true;
        console.log('[Splat.replaceData] finished', this.name, 'instance=', !!this.entity.gsplat?.instance);
    }

    destroy() {
        super.destroy();
        this.releaseLodAssets();
        this.entity.destroy();
        this.asset.registry.remove(this.asset);
        this.asset.unload();
    }

    // ---- runtime LOD helpers (V3) ----

    /**
     * Register decimated proxy levels (coarsest FIRST, e.g. [10%, 35%] so
     * index 0 = most aggressive reduction, higher index = closer proxy).
     * Base data is whatever asset this splat currently renders; pass it via
     * `baseAsset` if the caller wants a specific reference (usually the
     * full-resolution loaded asset).
     */
    setLodAssets(assets: { asset: Asset; numSplats: number }[], baseAsset?: Asset) {
        this.releaseLodAssets();
        // store coarsest-first (reverse of the usual fractions order) so index 0
        // is always the most reduced level used at the greatest distance.
        this.lodAssets = assets.slice().reverse();
        this._lodBaseAsset = baseAsset ?? this.asset;
        this.lodLevel = -1;
        this.lodEnabled = this.lodAssets.length > 0;
        this._lodBuildRequested = false;
    }

    /** Unload and forget proxy assets (called on destroy and re-registration). */
    releaseLodAssets() {
        for (const { asset } of this.lodAssets) {
            try {
                asset.registry?.remove(asset);
                asset.unload();
            } catch { /* ignore */ }
        }
        this.lodAssets = [];
        this.lodEnabled = false;
        this.lodLevel = -1;
        this._lodBuildRequested = false;
    }

    /**
     * Swap the rendered data to proxy level `level` (-1 = full resolution).
     * Keeps the previous asset alive so the next switch back is cheap.
     */
    applyLod(level: number): Promise<void> {
        // 串行化：等上一个切换走完再判（并发 replaceData 会互相销毁 entity，见 _lodSwitching 注释）。
        // 调用方既有 `void applyLod(...)` 也有 `await applyLod(...)`，所以这里返回的 promise
        // 必须真的是"这次切换"的那一个。
        // （这里刻意不写成 async：串行靠 `then` 链，函数体里没有 await。）
        const prev = this._lodSwitching;
        const run: Promise<void> = prev.then(() => this._applyLodInner(level));
        this._lodSwitching = run.then((): void => undefined, (): void => undefined);
        return run;
    }

    private async _applyLodInner(level: number) {
        const n = this.lodAssets.length;
        const next = level >= 0 && level < n ? level : -1;
        if (next === this.lodLevel && this.lodLevel !== -1) return; // idempotent (full base is level -1 but may be re-applied safely)
        const target = next === -1 ? (this._lodBaseAsset ?? this.asset) : this.lodAssets[next].asset;
        if (!target || target === this.asset) return;
        // M3-4：切进代理层之前，把全分辨率的 state 搬到代理层（见 syncProxyStateFromBase）。
        // 必须在 `replaceData` **之前**：它内部的 bindAsset 会把 state 列包进 SplatState，
        // 之后的 updateState 才会把它刷上 GPU。
        if (next >= 0) this.syncProxyStateFromBase(next);
        // 2026-09-25：切换失败时必须**留下一致的状态 + 冷却**。
        // `replaceData` 中间要 `await updateState()` / `await waitForRender()`，任何一步抛错
        // （实测：引擎自己的异步包围盒计算落在一个已经被 destroy 的 gsplat 组件上，
        //  抛 `Cannot read properties of null (reading 'readTextureAsync')`）以前会把整个
        // `applyLod` 变成 rejected promise：`lodLevel` 永远停在旧值、`_lodLastSwitchAt` 不更新
        // ⇒ 每帧的 `updateLodSwitching` 都会再发一次切换（`!allow` 那条分支还会绕过冷却）
        // ⇒ **切换风暴**，画面可能整块消失且不会自愈。现在失败只当"这次没切成"。
        let ok = false;
        try {
            await this.replaceData(target, true);
            this.lodLevel = next;
            ok = true;
        } catch (e) {
            // 不往外抛：调用方都是 `void applyLod(...)`，抛出去只会变成未处理的 rejection，
            // 而"这次没切成"本身是安全状态（数据仍绑在切换前的 asset 上，冷却会挡住重试风暴）。
            console.warn('[lod] switch failed (kept previous level):', e);
        } finally {
            // 无论成败都要落冷却，避免每帧重试同一个失败切换
            this._lodLastSwitchAt = performance.now();
        }
        if (ok) {
            this.scene?.events?.fire('splat.lodChanged', this, next);
        }
    }

    /**
     * M3-4：把全分辨率的 `state` 列按行映射搬到代理层。
     *
     * 为什么必须做：`Splat.bindAsset()` 让每份 asset 各有自己的 `state` 列，代理层那份是
     * **构建时的快照**。用户在全分辨率上删了点之后再进浏览态，代理层那份快照里这些点
     * 还是"活着" ⇒ **删掉的点复活**。M3-3 时代这只是理论风险（编辑过就永不用代理层），
     * M3-4 放宽闸门之后它会变成用户可见的回归。
     *
     * 行映射来自 `proxyRowToSourceRow()`（与抽样公式逐字一致），因为代理层现在是纯
     * stride 抽样 —— 这正是 M3-4 把 decimation 通路换掉的原因（合并型抽样拿不到映射）。
     *
     * 只搬 `state`（selected/deleted/locked）。`transform` 不搬：它是变换调色板的下标，
     * 代理层与全分辨率的调色板不是同一份，搬过去会指向错的矩阵。
     */
    private syncProxyStateFromBase(level: number) {
        const baseRes = this._lodBaseAsset?.resource as GSplatResource | undefined;
        const proxyRes = this.lodAssets[level]?.asset?.resource as GSplatResource | undefined;
        if (!baseRes || !proxyRes) return;
        const baseData = baseRes.gsplatData as GSplatData | undefined;
        const proxyData = proxyRes.gsplatData as GSplatData | undefined;
        if (!baseData || !proxyData) return;

        let baseState = baseData.getProp('state') as Uint8Array | undefined;
        let proxyState = proxyData.getProp('state') as Uint8Array | undefined;
        const N = baseData.numSplats;
        const M = proxyData.numSplats;
        if (M <= 0 || N <= 0) return;
        // 两边都还没有 state 列（例如代理层建好但从未绑定过）：补一个再搬，
        // 否则 bindAsset 会各建一份全 0 的 —— 那正是"删除复活"的形态。
        if (!baseState) {
            baseState = new Uint8Array(N);
            baseData.getElement('vertex').properties.push({
                type: 'uchar', name: 'state', storage: baseState, byteSize: 1
            });
        }
        if (!proxyState) {
            proxyState = new Uint8Array(M);
            proxyData.getElement('vertex').properties.push({
                type: 'uchar', name: 'state', storage: proxyState, byteSize: 1
            });
        }
        for (let i = 0; i < M; i++) {
            proxyState[i] = baseState[proxyRowToSourceRow(i, N, M)];
        }
    }

    /**
     * Decide which LOD level the current camera distance calls for (delegates
     * to the pure lod.suggestLodLevel: per-level thresholds, one level at a
     * time, hysteresis against thrash).
     * @param distRatio - camera distance / model radius (>= ~2 when the model
     * fills the view, large when far away).
     */
    suggestLodLevel(distRatio: number): number {
        if (!this.lodEnabled || this.lodAssets.length === 0) return -1;
        return suggestLodLevel(distRatio, this.lodAssets.length, this.lodLevel);
    }

    /** True if a proxy level is currently rendered. */
    get lodActive() {
        return this.lodLevel >= 0;
    }

    async updateState(changedState = State.selected) {
        // uploads dirty range + refreshes counts in one pass.
        this.state.flush();
        this.numSplats = this.state.data.length - this.state.numDeleted;
        this.numLocked = this.state.numLocked;
        this.numSelected = this.state.numSelected;
        this.numDeleted = this.state.numDeleted;

        // handle splats being added or removed
        if (changedState & State.deleted) {
            await this.updateSorting();
        } else if (this._boundsDeferred) {
            // O1 (docs/audit/00-总结.md): a selection-only change cannot move either bound
            // in a way this pass is needed for. `localBound` is reduced from non-deleted rows
            // only (bound-shader skips state bit 4 and never reads bit 1) and the sole reader
            // of `selectionBound` is the transform handle's pivot (splat.getPivot, selection
            // = true). During a range-slider drag the pass therefore buys nothing while
            // costing a whole frame (waitForGpuDrain) plus four synchronous readbacks on every
            // push — 93k splats: 22-32ms, 13M: 25-60ms, and 99.9% of a push on a 2k fixture.
            // Mark it dirty instead; refreshDeferredBounds() recomputes once the drag settles.
            this._selectionBoundDirty = true;
        } else {
            await this.updateLocalBounds();
        }

        this.scene.forceRender = true;
        this.scene.events.fire('splat.stateChanged', this);
    }

    async updatePositions() {
        const data = await this.scene.dataProcessor.calcPositions(this);

        // update the splat centers which are used for render-time sorting
        const state = this.splatData.getProp('state') as Uint8Array;
        // unified 通路下没有 per-instance sorter（中心点由引擎的 world/GPU 排序自己管）
        const sorter = (this.entity.gsplat.instance as any)?.sorter;
        if (sorter) {
            const { centers } = sorter;
            for (let i = 0; i < this.splatData.numSplats; ++i) {
                if (state[i] === State.selected) {
                    centers[i * 3 + 0] = data[i * 4];
                    centers[i * 3 + 1] = data[i * 4 + 1];
                    centers[i * 3 + 2] = data[i * 4 + 2];
                }
            }
        }

        await this.updateSorting();

        this.scene.forceRender = true;
        this.scene.events.fire('splat.positionsChanged', this);
    }

    async updateSorting() {
        const state = this.splatData.getProp('state') as Uint8Array;

        let mapping;

        // create a sorter mapping to remove deleted splats (unless showDeleted is on)
        if (this.numSplats !== state.length && !this._showDeleted) {
            mapping = new Uint32Array(this.numSplats);
            let idx = 0;
            for (let i = 0; i < state.length; ++i) {
                if ((state[i] & State.deleted) === 0) {
                    mapping[idx++] = i;
                }
            }
        }

        // update sorting instance (absent on WebGPU / before the sorter exists / unified 通路上根本没有)
        (this.entity.gsplat.instance as any)?.sorter?.setMapping(mapping);

        // recalculate bounds after sorting changes
        await this.updateLocalBounds();
    }

    get worldTransform() {
        return this.entity.getWorldTransform();
    }

    set name(newName: string) {
        if (newName !== this.name) {
            this._name = newName;
            this.scene.events.fire('splat.name', this);
        }
    }

    get name() {
        return this._name;
    }

    get filename() {
        return (this.asset.file as any).filename;
    }

    calcSplatWorldPosition(splatId: number, result: Vec3) {
        if (splatId >= this.splatData.numSplats) {
            return false;
        }

        // use centers data, which are updated when edits occur
        // unified 通路没有 per-instance sorter ⇒ 退回 CPU 侧的中心点（`calcSplatWorldPosition`
        // 的调用方都在编辑/拾取路径上，那条路本身也需要一个可用值）
        const sorter = (this.entity.gsplat.instance as any)?.sorter;
        if (!sorter) {
            const x = this.splatData.getProp('x') as Float32Array;
            const y = this.splatData.getProp('y') as Float32Array;
            const z = this.splatData.getProp('z') as Float32Array;
            if (!x || !y || !z) {
                return false;
            }
            result.set(x[splatId], y[splatId], z[splatId]);
            return true;
        }
        const { centers } = sorter;

        result.set(
            centers[splatId * 3 + 0],
            centers[splatId * 3 + 1],
            centers[splatId * 3 + 2]
        );

        this.worldTransform.transformPoint(result, result);

        return true;
    }

    async add() {
        // add the entity to the scene
        this.scene.contentRoot.addChild(this.entity);

        // assign splat to the dedicated splat layer (rendered by splat camera with MRT)
        this.entity.gsplat.layers = [this.scene.splatLayer.id];

        this.scene.events.on('view.bands', this.rebuildMaterial, this);
        this.rebuildMaterial(this.scene.events.invoke('view.bands'));

        // 排序完成信号：引擎的 GSplatSorter 收到 worker 回包时会 fire 'updated'
        // （gsplat-sorter.js:28-32），闸门靠它知道"这一次排序已经结束、可以派下一次了"。
        // 这正是 `_sortInFlight` 那个不存在的补丁字段本来该干的事（引擎 2.21.3 里没有它）。
        //
        // ⚠️ 2026-09-25：unified 通路下 `instance` 是 **null**（引擎改用 `_placement`，
        // `GSplatComponent.get instance()` 直接返回 null）⇒ 这里必须可选链。之前写的是
        // `this.entity.gsplat.instance.sorter?.on(...)` ⇒ **抛 TypeError**。这个异常被导入链的
        // catch 接住 → 弹错误框等用户点确定 → 在无人操作的环境里**导入 promise 永不 settle**，
        // 表现就是"`?unified=1` 导入卡死"（§4d 追了好几轮的那个）。
        (this.entity.gsplat.instance as any)?.sorter?.on('updated', this._onSortUpdated, this);

        // we must update state in case the state data was loaded from ply
        await this.updateState();
    }

    remove() {
        this.scene.events.off('view.bands', this.rebuildMaterial, this);
        // unified 通路下没有 instance（见 add() 里的说明），整体可选链
        (this.entity.gsplat.instance as any)?.sorter?.off('updated', this._onSortUpdated, this);

        this.scene.contentRoot.removeChild(this.entity);
        this.scene.boundDirty = true;
    }

    serialize(serializer: Serializer) {
        serializer.packa(this.entity.getWorldTransform().data);
        serializer.pack(this.changedCounter);
        serializer.pack(this.visible);
        serializer.pack(this.tintClr.r, this.tintClr.g, this.tintClr.b);
        serializer.pack(this.temperature, this.saturation, this.brightness, this.blackPoint, this.whitePoint, this.transparency);
        serializer.pack(this.highlights, this.shadows, this.contrast);
        serializer.pack(this.colorGradeEnabled ? 1 : 0);
        // M2-3：packa 直接吃 Float32Array（以前每帧 3 个 Array.from 拷贝）。
        serializer.packa(this._hslHue);
        serializer.packa(this._hslSat);
        serializer.packa(this._hslLum);
        // 曲线：把四个通道的控制点依次展平进 hash（数据面板靠它判断"要不要重算直方图"）。
        // 通道之间用 NaN 分隔，避免 "[[0,1]] + [[0,1]]" 与 "[[0,1],[0,1]]" 撞 hash。
        // M2-3：展平缓冲每帧复用（serialize 不会重入——它在 scene onUpdate 的单线程循环里跑）。
        const curveFlat = _serializeCurveFlat;
        curveFlat.length = 0;
        for (const ch of CURVE_CHANNELS) {
            for (const p of this._curvePoints[ch] ?? []) {
                curveFlat.push(p.x, p.y);
            }
            curveFlat.push(NaN);
        }
        serializer.packa(curveFlat);
    }

    // WebGPU only: upload the camera matrices as material parameters (see the call
    // site in onPreRender and the notes in src/shaders/splat-shader-wgsl.ts). The
    // picture-in-picture preview writes the same parameters for its own camera and restores
    // them afterwards - see writeGpuCameraUniforms.
    private updateGpuCameraUniforms(instance: GSplatInstance) {
        writeGpuCameraUniforms(instance, this.scene.camera as unknown as GpuCameraSource, this._matParamCache);
    }

    /**
     * 给引擎的排序器装一道"相机闸门"（P0-2，2026-09-20，用户 2000 万点实测 ⑥）。
     *
     * 为什么必须装在**引擎**这一侧：`GSplatInstance.update()` 每帧都会调
     * `sorter.setCamera()`（`gsplat-instance.js:123-126`，引擎自己的门限是 1e-6，等于"动一点就发"），
     * 而 `GSplatSortWorker` 收到相机后按自己的 1e-3 门限决定是否真排（`gsplat-sort-worker.js:43-46`）。
     * 旋转时每帧方向变化远大于 1e-3 ⇒ **worker 只要在动就一直在排**：20M 一次全量排序约 0.4 s
     * （实测 `select.rect` 的那套相位表里 `selectRange` 同量级），也就是 ~2.5 次/秒，
     * 而每次排序完成引擎都要做一次 ~80 MB 的主线程上传 ⇒ 实测轨道旋转 max 帧 462~490 ms、
     * 4 秒内 6 帧 >33 ms（同机 idle median 16.6 ms）。
     * 所以只在"我们自己的派发"上做限流是没用的（实测：限流后仍 45 次/秒 postMessage）。
     *
     * 闸门规则（2026-09-21 起，见 `_sortAdmit`）：**不早于 `_sortMinIntervalMs()` + 没有排序在飞 +
     * 自上次派发以来相机转够了角度（或位移够多）**；被挡下的调用记住最新位姿，相机停稳 SORT_SETTLE_MS
     * 后补发一帧 —— 静止画面用的仍是最终位姿的顺序。
     * （那条地板 2026-09-24 起是自适应的：见 `_sortMinIntervalMs` 的推导，小模型上从 100 ms 降到 ~16 ms。）
     * 旧版是"最快每 800 ms 放行一次"（纯时间间隔）：用户实测"快速旋转时背面内容跑到前面"，
     * 因为 800 ms 内相机能转过很大角度；而且实测整段手势有时一次都没派发（4 秒旋转只 1~2 次、甚至 0 次）。
     * 新规则把顺序新鲜度绑在**动了多远**上，并靠完成事件保证 worker 不被淹没。
     */
    private ensureSorterGate(sorter: any) {
        if (!sorter || sorter.__splatRoomGate) {
            return;
        }
        // 不再转发给引擎的 `setCamera`：它在 2.21.3 里只做一件事 —— 把相机 postMessage 给 worker，
        // 而且**不带 `forceUpdate`**。这很要命：worker 收到没有 forceUpdate 的相机后会按自己的
        // 1e-3 门限判断，若认为"没动够"就 `return`（gsplat-sort-worker.js:44）—— **不回包**，
        // 于是完成事件永远不来，我们这道闸门会在 3 s 超时之前一直认为"有排序在飞"，
        // **整段手势期间一次排序都派发不出去**（2026-09-21 第六轮实测：快转 1.5 s、post 0 次）。
        // 这正是 §6.7 那类"闸门把自己锁死"的同一个坑，只是触发条件更隐蔽。
        // 现在两条路都走 `postSort`（同一个 worker 消息 + `forceUpdate: true`），保证每次派发都有回包。
        sorter.setCamera = (pos: any, dir: any) => {
            const now = performance.now();
            if (this._sortAdmit(now, pos, dir)) {
                this._noteSortDispatched(now, pos, dir);
                // postSort 内部会做顺序延迟补偿（把位姿外推到落地时刻）并发 `forceUpdate: true`
                this.postSort(pos, dir);
            } else if (this._sortSettleAt === 0) {
                // 挡下了：安排"停手后补一帧"。补帧在 onPreRender 里做（它拿到的是同一帧的相机位姿）。
                this._sortSettleAt = now + SORT_SETTLE_MS;
            }
        };
        sorter.__splatRoomGate = true;
    }

    /**
     * 让下一帧补一次"停手后的干净排序"（交互期降级 / 运动期限流的收尾）。
     *
     * 为什么需要显式调用，而不是依赖 `_sortSettleAt` 那套启发式：那条路的截止点**只在"被 800 ms 闸门
     * 挡下的帧"里才会被武装**（`_sortSettleAt === 0` 时置位），而闸门放行时又会把它清零 ——
     * 于是"最后一次放行"之后如果没再出现被挡下的帧，停手时就**没有任何补帧**。2026-09-21 实测：
     * 2.5 秒连续旋转 + 停手 900 ms，`worker.postMessage` **0 次**（`verify-motion-quality.cjs` 的
     * "settling issues one final clean sorted frame" 一项抓到的就是它）。
     * 另外要注意：闸门包的是 `sorter.setCamera`，它**不一定会真的给 worker 发消息**
     * （引擎 worker 自己还有 1e-3 门限），所以"闸门放行次数"也不能当作排序已刷新的证据。
     *
     * 本方法只把截止点置成"已过期"（`1`），真正的派发仍走 onPreRender 里那条停手分支
     * （它用的是**当帧**的相机位姿，因此补出来的顺序与静止画面一致）；已经武装过就什么都不做
     * ⇒ 一次手势最多补一帧，不会重复排序。
     */
    forceSettleSort() {
        if (this._sortSettleAt === 0) {
            this._sortSettleAt = 1;
        }
    }

    /** 是否还有"停手补帧"欠着没派发（Scene 用它决定要不要继续出帧，见 scene.ts） */
    get sortSettlePending() {
        return this._sortSettleAt !== 0;
    }

    /**
     * 当前是否处于"运动期不透明"路径 —— 那个功能已删除（见
     * docs/运动期不透明-删除记录-2026-09-23.md），这里保留一个恒 false 的读口，
     * 让旧探针/套件读到"未启用"而不是 `undefined`（静默失效比报错更难查）。
     */
    get motionOpaque() {
        return false;
    }

    /**
     * 是否已经有一次排序在飞（含 3 s 超时兜底）。Scene 用它决定要不要继续出帧：
     * 排序结果是异步回来的，本应用按需渲染 —— 最后一次派发之后若不再出帧，那份结果永远不会被
     * `applyPendingSorted()` 消费，画面就停在旧顺序上（小模型/不降级场景实测如此）。
     */
    get sortInFlight() {
        return this._sortInFlight(performance.now());
    }

    /**
     * 上一次派发之后相机转过的角度（度）。用**自上次派发**的位姿而不是上一帧：闸门的准入条件要回答的是
     * "顺序相对于相机已经过期多少"，而不是"这一帧动没动"。
     */
    private _sortAngleSinceDispatch(localDir: Vec3) {
        const d = this._sortDispatchDir;
        const dot = Math.min(1, Math.max(-1, d.x * localDir.x + d.y * localDir.y + d.z * localDir.z));
        return (Math.acos(dot) * 180) / Math.PI;
    }

    /** 是否已经有一次排序在飞（完成事件见 `_onSortUpdated`） */
    private _sortInFlight(now: number) {
        return this._sortPendingSince !== 0 && now - this._sortPendingSince < SORT_INFLIGHT_TIMEOUT_MS;
    }

    /**
     * 每帧采样一次相机位姿，估计角速度与线速度（供 `_predictSortPose` 外推用）。
     *
     * 速度用**固定时间窗**（SORT_MOTION_WINDOW_MS）内的位姿差来算，而不是"上一帧 → 这一帧"：
     * 外推的跨度 λ 有几百毫秒，用一帧的差分去乘 λ 会把帧抖动直接放大成几十度的角度误差
     * （实测 20M 上一个 6°/帧 的旋转，单帧差分估出来的速度抖 ±30%，外推 370 ms 就是 ±30°）。
     * 窗口取 ~120 ms：拖拽的速度变化远慢于这个尺度，而比一帧稳得多。
     *
     * 角速度存成**旋转矢量**（轴 × 角速度）而不是"轴 + 标量"：来回蹭（方向反转）时两个相反的
     * 旋转矢量会在 EMA 里互相抵消 → 速度估计趋近 0 → 自动退回不补偿。这比"轴也做 EMA"稳：
     * 轴做 EMA 在换向时会出现长度趋 0 的退化向量，归一化就是 NaN。
     */
    private _sampleSortMotion(now: number, pos: Vec3, dir: Vec3) {
        // 记样本（环形，够覆盖一个窗口即可）
        const dirs = this._sortHistDir;
        const poss = this._sortHistPos;
        const times = this._sortHistT;
        dirs[this._sortHistHead].copy(dir);
        poss[this._sortHistHead].copy(pos);
        times[this._sortHistHead] = now;
        this._sortHistHead = (this._sortHistHead + 1) % SORT_MOTION_SAMPLES;
        if (this._sortHistCount < SORT_MOTION_SAMPLES) {
            this._sortHistCount++;
        }

        // 找窗口外最近的样本（要有一个 ≥ 窗口 的时间跨度）：从最新往老扫，
        // 第一个"至少窗口这么老"的样本就是窗口端点。
        // 窗口长度可被 `window.__SPLATROOM_SORT_TUNE__.windowMs` 覆盖（探针扫参用）。
        const tune = (globalThis as any).__SPLATROOM_SORT_TUNE__ ?? {};
        const windowMs = typeof tune.windowMs === 'number' ? tune.windowMs : SORT_MOTION_WINDOW_MS;
        const target = now - windowMs;
        let best = -1;
        for (let age = 0; age < this._sortHistCount; age++) {
            const idx = (this._sortHistHead - 1 - age + SORT_MOTION_SAMPLES * 2) % SORT_MOTION_SAMPLES;
            const t = times[idx];
            if (t <= 0 || t > target) {
                continue;                   // 空槽 / 比窗口更新的样本：继续往前找
            }
            best = idx;
            break;
        }
        if (best < 0) {
            // 样本还不够长（刚开始动）：这一帧没有可信速度，保持上一次估计（衰减交给下面的窗口）
            return;
        }

        const oldDir = dirs[best];
        const oldPos = poss[best];
        const dt = now - times[best];
        if (!(dt > 1)) {
            return;
        }

        const dot = Math.min(1, Math.max(-1, oldDir.x * dir.x + oldDir.y * dir.y + oldDir.z * dir.z));
        const angle = Math.acos(dot);                       // rad
        const ax = oldDir.y * dir.z - oldDir.z * dir.y;
        const ay = oldDir.z * dir.x - oldDir.x * dir.z;
        const az = oldDir.x * dir.y - oldDir.y * dir.x;
        const alen = Math.sqrt(ax * ax + ay * ay + az * az);

        if (alen > 1e-6) {
            const k = angle / dt / alen;                    // 单位轴 × rad/ms
            this._sortRotRate.set(
                this._sortRotRate.x + (ax * k - this._sortRotRate.x) * SORT_MOTION_BLEND,
                this._sortRotRate.y + (ay * k - this._sortRotRate.y) * SORT_MOTION_BLEND,
                this._sortRotRate.z + (az * k - this._sortRotRate.z) * SORT_MOTION_BLEND
            );
            this._sortMotionStill = 0;
        } else {
            // 窗口内基本没转：视为静止（速度清零，别让旧速度继续外推）
            this._sortRotRate.mulScalar(1 - SORT_MOTION_BLEND);
            this._sortLinRate.mulScalar(1 - SORT_MOTION_BLEND);
            this._sortMotionStill++;
            return;
        }

        const lx = (pos.x - oldPos.x) / dt;
        const ly = (pos.y - oldPos.y) / dt;
        const lz = (pos.z - oldPos.z) / dt;
        this._sortLinRate.set(
            this._sortLinRate.x + (lx - this._sortLinRate.x) * SORT_MOTION_BLEND,
            this._sortLinRate.y + (ly - this._sortLinRate.y) * SORT_MOTION_BLEND,
            this._sortLinRate.z + (lz - this._sortLinRate.z) * SORT_MOTION_BLEND
        );
    }

    /**
     * 把位姿外推到"排序落地时刻"（`progress` 毫秒之后），结果写进 `_predictPos/_predictDir`。
     *
     * 方向用 Rodrigues 旋转（轴 = 旋转矢量归一化，角 = |旋转矢量| · progress，保长度）；
     * 位置沿当前线速度直线外推。外推量小于阈值时**原样返回当前位姿**：静止/微动时送出去的
     * 仍然是逐字节一致的位姿，行为与没有补偿时完全相同（回归面最小）。
     *
     * 逃生开关：`window.__SPLATROOM_SORT_PREDICT__ = false` 关掉（探针 A/B 用）。
     */
    private _predictSortPose(pos: Vec3, dir: Vec3, progress: number) {
        _predictPos.copy(pos);
        _predictDir.copy(dir);

        // 探针锚点（`__SPLATROOM_SORT_TUNE__.probeAnchor = true`，默认关闭、零开销）：
        // 把**未外推**的位姿留在全局上，供 `_tmp/probe-order-lifetime.cjs` 量
        // "这份顺序被画出来时相机已经又转了多少" —— 顺序延迟补偿的唯一地面真值。
        if ((globalThis as any).__SPLATROOM_SORT_TUNE__?.probeAnchor === true) {
            const anchor = (globalThis as any).__SPLATROOM_SORT_ANCHOR__ ?? ((globalThis as any).__SPLATROOM_SORT_ANCHOR__ = []);
            anchor.push({ t: performance.now(), pos: pos.clone(), dir: dir.clone() });
            if (anchor.length > 64) {
                anchor.shift();
            }
        }

        if ((globalThis as any).__SPLATROOM_SORT_PREDICT__ === false) {
            return;
        }

        const rx = this._sortRotRate.x;
        const ry = this._sortRotRate.y;
        const rz = this._sortRotRate.z;
        const rlen = Math.sqrt(rx * rx + ry * ry + rz * rz);
        const angle = rlen * progress;                       // rad
        if (angle > (SORT_PREDICT_MIN_DEG * Math.PI) / 180) {
            const nx = rx / rlen;
            const ny = ry / rlen;
            const nz = rz / rlen;
            const c = Math.cos(angle);
            const s = Math.sin(angle);
            const d = nx * dir.x + ny * dir.y + nz * dir.z;
            // Rodrigues: v·c + (n×v)·s + n·(n·v)·(1−c)
            _predictDir.set(
                dir.x * c + (ny * dir.z - nz * dir.y) * s + nx * d * (1 - c),
                dir.y * c + (nz * dir.x - nx * dir.z) * s + ny * d * (1 - c),
                dir.z * c + (nx * dir.y - ny * dir.x) * s + nz * d * (1 - c)
            ).normalize();
        }

        const radius = this.worldBound ? this.worldBound.halfExtents.length() : 1;
        const px = this._sortLinRate.x * progress;
        const py = this._sortLinRate.y * progress;
        const pz = this._sortLinRate.z * progress;
        const minStep = radius * SORT_PREDICT_MIN_RADIUS;
        if (px * px + py * py + pz * pz > minStep * minStep) {
            _predictPos.set(pos.x + px, pos.y + py, pos.z + pz);
        }
    }

    /**
     * 当前该外推多少毫秒 —— **三步**（第二十轮加了第三步）：
     *
     *   第一步 `_sortLatencyMs`：派发 → worker 回包（= worker 排序耗时，20M 实测 ~161 ms）；
     *   第二步 `_sortConsumeMs`：回包 → **某一帧真的把它上传并拿去渲染**（实测 ~24 ms：
     *     按需渲染下总要等下一帧的 `GSplatInstance.update()`）。
     *   第三步 **`D/2`（居中）**：一份顺序从"落地"到"被下一份替换"之间**整段寿命 D** 都在用，
     *     而前两步只把它对齐到落地那一刻 ⇒ 错位角从 0 一路长到 D（缓转 30°/s、D=200 ms 就是 6°，
     *     峰值 11.5°）。把 horizon 再往前推 D/2，错位区间就变成 [−D/2, +D/2]：
     *     **平均错位 0、峰值减半，且不多排一次序、不花任何额外代价。**
     *
     *   D 取"下一次派发大概还要多久"：**实测的派发间隔**（`_sortCadenceMs`，见 `_noteSortDispatched`）、
     *   闸门地板、攒够 `SORT_MOVE_DEG` 所需时间（用当次角速度估）、以及上一次排序的往返 `λ+消费`
     *   （在飞期间不会再派发）四者取大。
     *
     *   ⚠️ 2026-09-24：原来这里的 D **不含实测派发间隔**，只用地板估；而闸门地板只是"最早可以派"的时间，
     *   真正的派发间隔经常是它的两倍（单飞：这一帧派了，下一帧还在飞 ⇒ 派不出去）。
     *   实测小模型：地板 16 ms、真实间隔 33.3 ms ⇒ 居中项把 horizon 多推了 8 ms（≈0.25°），
     *   方向是**过冲**（`disp` 从 0.003 抬到 0.006）。现在改用实测间隔，"居中"才真的居中。
     *
     * 四项都可被 `window.__SPLATROOM_SORT_TUNE__` 覆盖（只给探针/套件调参用，见 sort-tune.cjs）。
     */
    private _sortPredictHorizon() {
        const tune = (globalThis as any).__SPLATROOM_SORT_TUNE__ ?? {};
        const consumeWeight = typeof tune.consumeWeight === 'number' ? tune.consumeWeight : 1;
        const extraMs = typeof tune.extraMs === 'number' ? tune.extraMs : 0;
        const base = this._sortLatencyMs + consumeWeight * this._sortConsumeMs;

        const intervalMs = this._sortMinIntervalMs(tune);
        const observedCadenceMs = typeof tune.cadenceMs === 'number' ? tune.cadenceMs : this._sortCadenceMs;
        const moveDeg = typeof tune.moveDeg === 'number' ? tune.moveDeg : SORT_MOVE_DEG;
        const centerWeight = typeof tune.centerWeight === 'number' ? tune.centerWeight : SORT_PREDICT_CENTER_WEIGHT;

        // 下一次派发大概还要多久（D）：角速度越大、攒够 moveDeg 越快；在飞期间被 λ+消费 挡住
        const rlen = Math.sqrt(
            this._sortRotRate.x * this._sortRotRate.x +
            this._sortRotRate.y * this._sortRotRate.y +
            this._sortRotRate.z * this._sortRotRate.z
        );
        const rateDegPerMs = (rlen * 180) / Math.PI;
        const rotateMs = rateDegPerMs > 1e-6 ? moveDeg / rateDegPerMs : Infinity;
        const dMs = Math.max(intervalMs, observedCadenceMs, Math.min(rotateMs, SORT_PREDICT_MAX_MS), base);

        const total = base + centerWeight * dMs + extraMs;
        return Math.min(SORT_PREDICT_MAX_MS, Math.max(0, total));
    }

    /**
     * 闸门与自家派发**共用**的准入判定（P0-3 v2，2026-09-21）：
     *   ① 不早于 `_sortMinIntervalMs()`（**自适应**地板，2026-09-24 起：小模型一帧、大模型退化回 100 ms）；
     *   ② 同一时刻只有一次排序在飞（靠完成事件，而不是时间猜）；
     *   ③ 自上次派发以来相机**转够了角度**、或**位移够多**（按模型尺寸比例）—— 顺序新鲜度绑在"动得多远"上。
     * 为什么不是固定间隔：用户实测"快速旋转时背面内容跑到前面"，而固定 800 ms 在快转时能转过很大角度；
     * 固定间隔还解释不了"整段手势一次都没派发"（实测 4 秒旋转只派发 1~2 次、有时 0 次）。
     */
    /**
     * 运动期排序准入。运动期"不依赖顺序"的那两条写法（随机透明 / 硬边裁剪）已按用户判定删除
     * （观感伤害太大，见 docs/运动期不透明-删除记录-2026-09-23.md），所以运动期照常派发排序。
     */
    private _sortAdmit(now: number, localPos: Vec3, localDir: Vec3) {
        const tune = (globalThis as any).__SPLATROOM_SORT_TUNE__ ?? {};
        const minIntervalMs = this._sortMinIntervalMs(tune);
        const moveDeg = typeof tune.moveDeg === 'number' ? tune.moveDeg : SORT_MOVE_DEG;
        if (now - this._sortLastDispatch < minIntervalMs) {
            return false;
        }
        if (this._sortInFlight(now)) {
            return false;
        }
        if (this._sortAngleSinceDispatch(localDir) > moveDeg) {
            return true;
        }
        // 纯平移（视角方向不变）也要能刷新顺序：按模型半径的 1% 作为"动够了"的位置阈值
        const radius = this.worldBound ? this.worldBound.halfExtents.length() : 0;
        if (!(radius > 0)) {
            return false;
        }
        const dx = localPos.x - this._sortDispatchPos.x;
        const dy = localPos.y - this._sortDispatchPos.y;
        const dz = localPos.z - this._sortDispatchPos.z;
        return dx * dx + dy * dy + dz * dz > (radius * 0.01) * (radius * 0.01);
    }

    /**
     * 派发间隔地板（**自适应**，第二十二轮）。原来是一条为 2000 万点写的恒定 100 ms，
     * 实测在小模型上它是唯一的约束（排序本身只要 0.8 ms），白送了 3–5 倍的新鲜度。
     *
     * 取"一次顺序从派发到上线实测要花多久"（λ + 消费）作为地板块，
     * 上下夹在 `[SORT_MIN_INTERVAL_FLOOR_MS, SORT_MIN_INTERVAL_CEIL_MS]`：
     * 小模型 → 一帧；大模型 → 自然退化回原来那条地板（20M 实测 λ+消费 ≈ 250 ms，比原来还长，
     * 但那边真正的约束本来就是 worker 吞吐 + 单飞，不是这条地板）。
     *
     * 可被 `__SPLATROOM_SORT_TUNE__.minIntervalMs` 直接覆盖（探针 A/B 用），
     * 或用 `.intervalCostFactor` 调倍率（0 = 永远取地板下限）。
     */
    private _sortMinIntervalMs(tune: any = {}) {
        if (typeof tune.minIntervalMs === 'number') {
            return tune.minIntervalMs;
        }
        return sortMinIntervalMs(this._sortLatencyMs, this._sortConsumeMs, tune);
    }

    /**
     * 记下"顺序以这个位姿为准"（簿记）。**不**设置在飞标记 —— 在飞标记只有真正发出请求时才置位
     * （见 postSort），否则 `dispatchSort` 会把自己刚记的簿记误判成"已有排序在飞"而永远只排队不发送
     * （第一版就是这么写错的，实测 posts 恒为 0）。
     */
    private _noteSortDispatched(now: number, localPos: Vec3, localDir: Vec3) {
        // 真实派发间隔的滑动平均（间隔太长/太短都不采：停手几秒后的"下一次"不是节奏）
        if (this._sortLastDispatch > 0) {
            const gap = now - this._sortLastDispatch;
            if (gap > 0 && gap < SORT_PREDICT_MAX_MS) {
                this._sortCadenceSamples++;
                this._sortCadenceMs = this._sortCadenceSamples === 1 ?
                    gap :
                    this._sortCadenceMs + (gap - this._sortCadenceMs) * SORT_CADENCE_ALPHA;
            }
        }
        this._sortLastDispatch = now;
        this._sortDispatchPos.copy(localPos);
        this._sortDispatchDir.copy(localDir);
        this._sortSettleAt = 0;
    }

    /** 排序结果到达（引擎的 sorter 在收到 worker 回包时 fire 'updated'）⇒ 不再有排序在飞 */
    private _onSortUpdated() {
        const now = performance.now();
        if (this._sortPendingSince !== 0) {
            // 实测延迟 = 派发 → 回包。这是外推第一步的依据。
            const latency = now - this._sortPendingSince;
            if (latency > 0 && latency < SORT_INFLIGHT_TIMEOUT_MS) {
                this._sortLatencySamples++;
                this._sortLatencyMs = this._sortLatencySamples === 1 ?
                    latency :
                    this._sortLatencyMs + (latency - this._sortLatencyMs) * SORT_LATENCY_ALPHA;
            }
        }
        // 第二步的起点：回包时刻。真正"上线"要等下一帧的 update() 把它上传（见 onPreRender）
        this._sortLandedAt = now;
        this._sortPendingSince = 0;
        // 在飞期间攒下的最新位姿在这里补发（这就是 `_sortInFlight` 那个不存在的字段本想做的事）。
        // 仍然尊重最小间隔：否则在"排序很快、相机一直在动"的场景下会变成完成即发的自旋。
        if (this._sortHasPending && performance.now() - this._sortLastDispatch >= this._sortMinIntervalMs()) {
            this._sortHasPending = false;
            this.postSort(this._sortPendingPos, this._sortPendingDir);
        }
    }

    /**
     * 第二步延迟采样：回包 → 下一帧（那一帧的 `GSplatInstance.update()` 才把顺序上传并用于渲染）。
     *
     * 只在**运动中**且等待时间短（< 100 ms）时计入：按需渲染下停手后可能几百毫秒才来一帧，
     * 那是"空闲"不是"延迟"，混进来会把 horizon 拉爆。
     */
    private _sampleSortConsume(now: number, moving: boolean) {
        if (this._sortLandedAt === 0) {
            return;
        }
        const wait = now - this._sortLandedAt;
        this._sortLandedAt = 0;
        if (!moving || !(wait > 0 && wait < 100)) {
            return;
        }
        this._sortConsumeSamples++;
        this._sortConsumeMs = this._sortConsumeSamples === 1 ?
            wait :
            this._sortConsumeMs + (wait - this._sortConsumeMs) * SORT_LATENCY_ALPHA;
    }

    /**
     * 直接给排序 worker 派一次全量排序（绕开引擎 1e-3 的 epsilon 门限）。
     *
     * 引擎的 `GSplatInstance.sort()` 对相机方向用 `equalsApprox(..., 1e-3)`：缓慢旋转时
     * 每帧方向变化约 1e-4，远小于门限 ⇒ 引擎把请求丢掉、worker 一直用旧顺序（画面"翻转/穿插"）。
     * 所以这里自己按 splat 局部坐标的相机位姿直接 `postMessage`，并带 `forceUpdate: true`。
     *
     * ⚠️ **2026-09-21 修掉一个"永久卡死"的老 bug**：这里原来用 `ws._sortInFlight` / `ws._pendingCamera`
     * 做合并，但**这两个字段在本机引擎（playcanvas 2.21.3）里根本不存在**
     * （`grep -r _sortInFlight node_modules/playcanvas` 零命中；交接包 5.3 节记过"没有合并"，
     * 但没意识到它更严重的后果）：第一次派发把 `ws._sortInFlight = true` 之后，**再没有任何代码会清它**
     * ⇒ 此后每一次派发都走进 `_pendingCamera` 分支**只记录、不发送**，也就是**这条派发路径从此彻底死掉**。
     * 实测（`_tmp/admit-diag.cjs`，3 秒快转）：`dispatchSort` 被调用 2 次、`worker.postMessage` **0 次**、
     * 完成事件 0 次 —— 顺序一直冻结在旧位姿上，正是用户报的"快速旋转时背面内容跑到前面"。
     * 现在改成**自己的**在飞标记（`_sortPendingSince`，由完成事件 `_onSortUpdated` 清零，带 3 s 超时兜底）
     * 与**自己的**待办位姿（`_sortPendingPos/_sortPendingDir`）：在飞时只记最新位姿，完成时立刻补发一次。
     */
    private dispatchSort(localPos: Vec3, localDir: Vec3, predict = true) {
        // 记录"顺序以这个位姿为准"的簿记（无论这次是真发还是排队，都会成为最新一次请求）
        this._noteSortDispatched(performance.now(), localPos, localDir);

        if (this._sortInFlight(performance.now())) {
            // 已有一次排序在飞：只记最新位姿，等完成事件到达时补发（真正的合并）
            this._sortPendingPos.copy(localPos);
            this._sortPendingDir.copy(localDir);
            this._sortHasPending = true;
            return;
        }
        this.postSort(localPos, localDir, predict);
    }

    /**
     * 真正把一次排序请求发给 worker（并标上"在飞"时刻）。
     *
     * `predict`：是否做顺序延迟补偿（外推到落地时刻）。**停手补帧必须传 false** ——
     * 那帧是用户静止时看到的"最终画面"，速度估计还没衰减干净（τ=60 ms，停手 200 ms 后仍有 ~3.6%），
     * 外推会把静止帧的顺序故意推偏几度。静止帧要的是逐字节精确。
     */
    private postSort(localPos: Vec3, localDir: Vec3, predict = true) {
        try {
            const ws = this.entity?.gsplat?.instance?.sorter as any;
            if (!ws || !ws.worker) {
                return;
            }
            // 与 `ensureSorterGate` 里那条路一致：送"落地时刻"的位姿（顺序延迟补偿）
            this._predictSortPose(localPos, localDir, predict ? this._sortPredictHorizon() : 0);
            ws.worker.postMessage({
                cameraPosition: { x: _predictPos.x, y: _predictPos.y, z: _predictPos.z },
                cameraDirection: { x: _predictDir.x, y: _predictDir.y, z: _predictDir.z },
                forceUpdate: true
            });
            this._sortPendingSince = performance.now();
        } catch (e) {
            // best-effort：排序失败不该影响渲染
        }
    }

    onPreRender() {
        // SurfaceRefine / replaceData 的并发场景下，新 entity ??gsplat instance
        // 可能还未就绪，跳过本帧并在控制台输出一次性诊断信息。
        // **与 `gsplat.instance` 无关的覆盖层先跑**（2026-09-26）。
        // unified 通路（`?unified=1`）下引擎不给 `instance`（改用 `_placement`），而下面那整段
        // 是按 instance 排序 / 写 per-instance 材质的。原来这里第 3 行就 `return`，
        // 把"选中时画包围盒"和"按 visible 开关实体"一起丢了 —— 用户看到的就是
        // "unified 通路不显示边界"。实测（`_tmp/probe-unified-parity.cjs`）：`drawLine` 调用
        // 主线 9888 次 / unified **0** 次，而**内部选中状态两边完全一致**（670 / 670），
        // 所以那是"画不出来"，不是"没选中"。
        this.onPreRenderOverlay();

        if (!this.entity?.gsplat?.instance) {
            if (!this._warnedNoInstance) {
                this._warnedNoInstance = true;
                console.warn(`[Splat.onPreRender] skipped: entity=${!!this.entity}, gsplat=${!!this.entity?.gsplat}, instance=${!!this.entity?.gsplat?.instance}, name=${this.name}, changedCounter=${this.changedCounter}`);
            }
            return;
        }

        // ---- 主视图排序兜底（SplatRoom patch??---
        // 引擎的排序链路依??culler 每帧把主相机 push ??instance.cameras[]??
        // 然后 GSplatInstance.update() 里 instance.sort(cameras[0]) 触发
        // worker 深度排序。当该链路失效（culler 不填满 cameras —— 或大模型/
        // 特殊 AABB / group-renderer 合并后个体 splat 被隐藏等），sort() 从不
        // 执行 → worker 排序冻结在初始相机方向，相机移动后深度顺序错乱 =
        // "近小远大"（半透明高斯远盖近）。PiP 用独立 CPU/Worker 排序绕开
        // cameras 依赖所以正常；主视图在这里补同样的"每帧强制 sort"??
        //   1. instance.sort() 内部有 equalsApprox 节流（相机位置/方向没变
        //      就不重新提交），所以每帧调用是廉价的，不会给 worker 刷量。
        //   2. 引入 sorter 的 _sortInFlight coalesce 补丁，排序中再触发
        //      会合并为最新相机姿态，不会堆积队列??
        //   3. PiP 激活时本实例的 sorter 会 swap 到 pipSorter（独立管线）。
        //      本兜底用 instance.sort() 仍只作用于当前 sorter —— 或 PiP
        //      swap 只发生在 onPostRender 的短暂窗口内，且 restore ??sorter
        //      恢复为主 sorter，所以这里调用始终安全。
        //   4. 合并渲染（groupRenderer.isActive）时个体 splat ??meshInstance
        //      通常被隐藏，本兜底对它们无害（不渲染）；合并实体自身的排序
        //      由 group-renderer.ts 手动 sort() 保证。
        const inst = this.entity.gsplat.instance;
        // group-renderer 合并激活时，个体 splat 的 layers 被清空（不参与渲染）。
        // 其排序兜底每次 postMessage 是纯浪费（合并实体有自己的排序，由
        // scene.ts onPreRender）。检测到被隐藏直接跳过整个排序兜底。
        const gsplatComp = this.entity.gsplat;
        const hiddenByGroup = !!gsplatComp && gsplatComp.layers.length === 0;
        const mainCamNode = (this.scene.camera as any)?.mainCamera as any;
        if (!mainCamNode) {
            // 主相机引用缺失：排序兜底无法取相机姿态，worker 排序会冻结在
            // 初始相机（表现为"近小远大"）。这是异常状态，一次性告警暴露。
            if (!this._warnedNoMainCam) {
                this._warnedNoMainCam = true;
                console.warn('[Splat.onPreRender] mainCamNode 缺失：主视图排序兜底被跳过，相机移动时深度排序可能冻结（近小远大）。scene.camera.mainCamera 未就绪？');
            }
        }
        if (!hiddenByGroup && mainCamNode && inst.sorter) {
            // P0-2：给引擎的相机派发装闸门（幂等，只会装一次）
            this.ensureSorterGate(inst.sorter);
            // ---- Per-frame main-view sort fallback (bypasses engine epsilon gating) ----
            // Engine GSplatInstance.sort() at gsplat-instance.js L123 uses
            // equalsApprox(...,1e-3) on camera direction. Under slow rotation,
            // each frame's direction change is ~1e-4 per ~16ms —well under
            // 1e-3 —so the engine drops the request and the worker keeps
            // serving stale orders. The user sees a "rotated / flipped /
            // intruded" view because the latest camera pose isn't reflected in
            // the depth-binning worker until the delta accumulates past 1e-3
            // (many frames later).
            //
            // We mirror the engine's math exactly (world cam pos/dir —
            // splat-local via invModelMat) but use a much tighter detection
            // threshold (1e-12) so tiny camera motion is noticed at all. Sorter's
            // _sortInFlight coalesce patch (gsplat-sorter.js L129) absorbs the
            // request spike without queueing unlimited worker tasks.
            //
            // FIX (2026-08-12): removed the 3-frame throttle. The throttle was
            // introduced for performance (order-texture upload cost) but caused
            // visible "近小远大" when the engine culler skips camera population.
            //
            // P0-2 FIX (2026-09-20，用户 2000 万点实测 ⑥)：真正的瓶颈不在"我们自己的派发"，
            // 而在引擎每帧无条件调 sorter.setCamera()（见 ensureSorterGate 的注释）；
            // 这里保留原来的灵敏检测（1e-12）在间隔到点时主动补一次带 forceUpdate 的派发
            // （绕开 worker 自己的 1e-3 门限），并在停手后补最后一帧。
            const camWorld = mainCamNode.getWorldTransform();
            camWorld.getTranslation(_fallbackCamPos);
            camWorld.getZ(_fallbackCamDir);
            const modelWorld = inst.meshInstance.node.getWorldTransform();
            _fallbackInvModel.copy(modelWorld).invert();
            _fallbackInvModel.transformPoint(_fallbackCamPos, _fallbackLocalPos);
            _fallbackInvModel.transformVector(_fallbackCamDir, _fallbackLocalDir);
            const dx = _fallbackLocalPos.x - this._sortLastPos.x;
            const dy = _fallbackLocalPos.y - this._sortLastPos.y;
            const dz = _fallbackLocalPos.z - this._sortLastPos.z;
            const ddx = _fallbackLocalDir.x - this._sortLastDir.x;
            const ddy = _fallbackLocalDir.y - this._sortLastDir.y;
            const ddz = _fallbackLocalDir.z - this._sortLastDir.z;
            const moved = dx * dx + dy * dy + dz * dz > 1e-12 ||
                ddx * ddx + ddy * ddy + ddz * ddz > 1e-12;

            // ---- P0-2（2026-09-20，用户 2000 万点实测 ⑥）：交互期别再"每帧派一次全量排序" ----
            // 原来只要相机动了（epsilon 1e-12，等于"任何移动"）就派一次 worker 全量排序，
            // 20M 上一次排序 0.3~0.5 s，叠加引擎"排序完成要 80 MB 主线程 memcpy"的上传，
            // 实测轨道旋转期间 worker 100% 饱和、max 帧 462.8 ms、3 秒内 5 帧 >33 ms。
            // 上游 SuperSplat 3.3.0 的做法更激进：运动帧完全不排序，静止帧才 GPU 排序。
            // 这里取中间：在 sorter.setCamera 上装闸门（见 ensureSorterGate），把**引擎那条路**
            // 限到自适应地板 `_sortMinIntervalMs()` 一次，**停手后 SORT_SETTLE_MS 再补一帧**，
            // 保证最终画面与静止帧一致。
            const now = performance.now();
            // 顺序延迟补偿的速度估计（每帧采样；不管这一帧派不派发都要采，否则外推用的是陈旧速度）
            this._sampleSortMotion(now, _fallbackLocalPos, _fallbackLocalDir);
            // 第二步延迟采样：这一帧就是"消费"上一份排序结果的那一帧（update() 在本帧更早处跑过）
            this._sampleSortConsume(now, this.scene.cameraMotion.moving);
            if (moved) {
                this._sortLastPos.copy(_fallbackLocalPos);
                this._sortLastDir.copy(_fallbackLocalDir);
                if (this._sortAdmit(now, _fallbackLocalPos, _fallbackLocalDir)) {
                    // 间隔/在飞/位移都允许：这一帧用的就是最新位姿，不需要再补帧
                    this._noteSortDispatched(now, _fallbackLocalPos, _fallbackLocalDir);
                    this.dispatchSort(_fallbackLocalPos, _fallbackLocalDir);
                } else if (this._sortSettleAt === 0) {
                    // 被准入条件挡下了：安排"停手后补一帧干净排序"
                    this._sortSettleAt = now + SORT_SETTLE_MS;
                }
            } else if (this._sortSettleAt !== 0 && now >= this._sortSettleAt) {
                // 相机真的停了（连续 SORT_SETTLE_MS 没有位移）→ 补最后一帧。
                // 注意这里**不能**在"还没到点"时把 deadline 往后推：空闲帧会一直推，
                // 补帧就永远不会发生（第一版就是这么写的）。
                // `predict = false`：静止帧要的是精确顺序，不做延迟补偿（见 postSort 的说明）。
                this._noteSortDispatched(now, _fallbackLocalPos, _fallbackLocalDir);
                this.dispatchSort(_fallbackLocalPos, _fallbackLocalDir, false);
            }
        }

        const events = this.scene.events;
        const selected = this.scene.camera.renderOverlays && events.invoke('selection') === this;
        const cameraMode = events.invoke('camera.mode');
        const cameraOverlay = events.invoke('camera.overlay');

        // WebGPU: the splat material reads its camera matrices from material
        // parameters (see splat-shader-wgsl.ts) because the engine's view uniform
        // buffer is not bound correctly for this material in our custom render-pass
        // pipeline —matrix_view reads as the identity matrix, which collapses every
        // splat to a degenerate point and leaves the viewport empty.
        if (this.scene.graphicsDevice.isWebGPU) {
            this.updateGpuCameraUniforms(this.entity.gsplat.instance);
        }

        // configure rings rendering
        const material = this.entity.gsplat.instance.material;
        // M2-3（P2-1）：这一整段以前每帧 ~40 次 setParameter，其中大量字面量数组
        // （[r,g,b,a] / [0,0,0,0] / [1,1,1,1] …）每帧重新分配。引擎的 setParameter
        // 只是往 material.parameters 上挂值（纯赋值），绘制前引擎每帧都会把已有值
        // 重新推进 scope —— 所以"值没变就不写"语义完全等价，走缓存逐项比较。
        const pc = this._matParamCache;
        pc.setScalar(material, 'outlineMode', events.invoke('view.outlineSelection') ? 1 : 0);
        pc.setScalar(material, 'ringSize', (selected && cameraOverlay && cameraMode === 'rings') ? 0.04 : 0);

        // configure colors
        const selectedClr = events.invoke('selectedClr');
        const unselectedClr = events.invoke('unselectedClr');
        const lockedClr = events.invoke('lockedClr');

        if (!selected) {
            pc.setArray(material, 'selectedClr', ZERO4);
        } else if (events.invoke('view.outlineSelection')) {
            pc.setArray(material, 'selectedClr', ZERO4);
        } else {
            _selClr4[0] = selectedClr.r; _selClr4[1] = selectedClr.g; _selClr4[2] = selectedClr.b; _selClr4[3] = selectedClr.a * this.selectionAlpha;
            pc.setArray(material, 'selectedClr', _selClr4);
        }
        _clr4[0] = unselectedClr.r; _clr4[1] = unselectedClr.g; _clr4[2] = unselectedClr.b; _clr4[3] = unselectedClr.a;
        pc.setArray(material, 'unselectedClr', _clr4);
        _clr4b[0] = lockedClr.r; _clr4b[1] = lockedClr.g; _clr4b[2] = lockedClr.b; _clr4b[3] = lockedClr.a;
        pc.setArray(material, 'lockedClr', _clr4b);

        // 颜色分级参数：**与 unified 通路共用同一份推导**（`src/splat/color-params.ts`）。
        // 为什么要抽出去：`?unified=1` 那条路的参数写在引擎每层的材质上，由 `scene.ts` 的钩子喂；
        // 两边各写一遍"色阶 + 染色 + 色温 + 饱和度 + HSL"必然漂移，这个仓库因此吃过亏。
        // 这里改成调用共享函数，取值与以前逐项一致（`colorGradeEnabled` 为 false 时全部中性）。
        // M2-3：fill 进 per-splat 持久 scratch（零分配）+ 缓存版 apply（没变就不写）。
        applySplatColorParamsCached(pc, material, fillSplatColorParams(this, splatColorParamsScratch(this)));
        pc.setScalar(material, 'showDeleted', this._showDeleted ? 1 : 0);
        pc.setValue(material, 'transformPalette', this.transformPalette.texture);

        // oriented crop-box clipping (SplatRoom)
        const cropBox = events.invoke('cropBox');
        if (cropBox && cropBox.enabled) {
            const cam = this.scene.camera.camera;
            invView.copy(cam.viewMatrix).invert();
            invBoxWorld.copy(cropBox.pivot.getWorldTransform()).invert();
            viewToBoxLocal.mul2(invBoxWorld, invView);
            pc.setScalar(material, 'uCropBoxEnabled', 1);
            pc.setArray(material, 'uViewToBoxLocal', viewToBoxLocal.data);
            pc.setScalar(material, 'uCropBoxPreview', cropBox.preview ? 1 : 0);
            pc.setScalar(material, 'uCropBoxSoftEdge', cropBox.softEdge);
            // shape + geometry uniforms
            pc.setScalar(material, 'uCropBoxShape', cropBox.shape === 'box' ? 0 : cropBox.shape === 'cylinder' ? 1 : 2);
            pc.setScalar(material, 'uCropBoxRadiusX', cropBox.radiusX);
            pc.setScalar(material, 'uCropBoxRadiusY', cropBox.radiusY);
            pc.setScalar(material, 'uCropBoxRadiusZ', cropBox.radiusZ);
            pc.setScalar(material, 'uCropBoxHeight', cropBox.height);
            // 切面（cap plane）：面板宽度（盒 local 单位）决定切面带厚度——
            // 0.03 ≈ 盒的 6%（够让多个被切 splat 截面都进入切面，密度高）。
            // capAlpha 控制切面片元 alpha —— 0.25 是甜点：过小（<0.08）呈半透明
            // 雾状纯色，过大（>0.6）单截面完全覆盖后太实，每个 splat 截面
            // 独立实体 = "实心片状椭圆"；0.25 时多个截面半透明叠加，颜色
            // 混合为区域混合色（合成测试：偏差≈0.02）。
            // 颜色不覆????切面走被切高斯本??+ 后续调色管线（HSL/contrast
            // 等）。capColor 仍传入但 shader 不再读。
            pc.setScalar(material, 'uCropBoxCapWidth', 0.03);
            pc.setScalar(material, 'uCropBoxCapAlpha', 0.25);
            pc.setArray(material, 'uCropBoxCapColor', ONE4);
        } else {
            pc.setScalar(material, 'uCropBoxEnabled', 0);
            pc.setScalar(material, 'uCropBoxPreview', 0);
            pc.setScalar(material, 'uCropBoxSoftEdge', 0.005);
            pc.setScalar(material, 'uCropBoxShape', 0);
            pc.setScalar(material, 'uCropBoxRadiusX', 0.35);
            pc.setScalar(material, 'uCropBoxRadiusY', 0.35);
            pc.setScalar(material, 'uCropBoxRadiusZ', 0.35);
            pc.setScalar(material, 'uCropBoxHeight', 0.8);
            pc.setScalar(material, 'uCropBoxCapWidth', 0);
            pc.setScalar(material, 'uCropBoxCapAlpha', 1);
            pc.setArray(material, 'uCropBoxCapColor', ONE4);
        }
    }

    /**
     * 每帧覆盖层里**与 `gsplat.instance` 无关**的那一半：选中时的包围盒、以及按 `visible`
     * 开关实体。unified 通路没有 per-instance 对象，这些以前被 `onPreRender` 开头那道
     * `if (!instance) return` 一起挡掉了（用户报的"不显示边界"；`visible` 的开关同样丢，
     * 即 unified 通路上"隐藏/显示"不生效）。
     */
    private onPreRenderOverlay() {
        const events = this.scene.events;
        const selected = this.scene.camera.renderOverlays && events.invoke('selection') === this;
        // visible 是 setter 写下的标志，真正作用到实体上一直是这里做的（主通路在
        // onPreRender 末尾、现在挪到这里，两条通路都生效；写的是同一个值，画面不变）。
        this.entity.enabled = this.visible;
        if (this.visible && selected && events.invoke('camera.bound')) {
            const bound = this.localBound;
            const scale = new Mat4().setTRS(bound.center, Quat.IDENTITY, bound.halfExtents);
            scale.mul2(this.entity.getWorldTransform(), scale);

            for (let i = 0; i < boundingPoints.length / 2; i++) {
                const a = boundingPoints[i * 2];
                const b = boundingPoints[i * 2 + 1];
                scale.transformPoint(a, veca);
                scale.transformPoint(b, vecb);

                this.scene.app.drawLine(veca, vecb, Color.WHITE, true, this.scene.worldLayer);
            }
        }
    }

    focalPoint() {
        const data = this.splatData;
        if (!data) {
            return this.worldBound.center;
        }

        const numSplats = data.numSplats;
        const x = data.getProp('x') as Float32Array;
        const y = data.getProp('y') as Float32Array;
        const z = data.getProp('z') as Float32Array;
        const opacity = data.getProp('opacity') as Float32Array;
        const sx = data.getProp('scale_0') as Float32Array;
        const sy = data.getProp('scale_1') as Float32Array;
        const sz = data.getProp('scale_2') as Float32Array;

        // fall back to AABB center if any required channel is missing
        if (!x || !y || !z || !opacity || !sx || !sy || !sz) {
            return this.worldBound.center;
        }

        let sumX = 0, sumY = 0, sumZ = 0;
        let totalWeight = 0;

        // 2026-09-20（用户 2000 万点实测 ⑥）：这里原来对**每个点**跑一次加权求和，
        // 每点两次 Math.exp ⇒ 20M 就是 4000 万次 exp（实测秒级），而"框显所选"、
        // 导入取景、camera.reset 每次都会调它。同一个文件里的 denseRadius() 对 >50 万点
        // 早就改成抽样了，这里照做：抽样只影响重心的小数位，不影响取景观感。
        const stride = numSplats > 500000 ? Math.ceil(numSplats / 200000) : 1;

        for (let i = 0; i < numSplats; i += stride) {
            // opacity is stored in raw (pre-sigmoid) log space, apply sigmoid
            // to get [0,1] range. scale is in log space, exp() gives linear size.
            const op = 1 / (1 + Math.exp(-opacity[i]));
            const w = op / (1 + Math.exp(Math.max(sx[i], sy[i], sz[i])));
            sumX += x[i] * w;
            sumY += y[i] * w;
            sumZ += z[i] * w;
            totalWeight += w;
        }

        const result = new Vec3();
        if (totalWeight > 0) {
            result.set(sumX / totalWeight, sumY / totalWeight, sumZ / totalWeight);
        } else {
            return this.worldBound.center;
        }

        // transform from local space to world space
        this.entity.getWorldTransform().transformPoint(result, result);

        return result;
    }

    denseRadius() {
        // Compute a density-weighted radius that covers the concentrated region.
        // Uses weighted standard deviation of positions, with the same alpha*scale
        // weighting as focalPoint(). Returns 3鑴?the max weighted stddev, which
        // captures ~99% of the concentrated Gaussians.
        const data = this.splatData;
        if (!data) {
            return this.worldBound.halfExtents.length();
        }

        const numSplats = data.numSplats;
        const x = data.getProp('x') as Float32Array;
        const y = data.getProp('y') as Float32Array;
        const z = data.getProp('z') as Float32Array;
        const opacity = data.getProp('opacity') as Float32Array;
        const sx = data.getProp('scale_0') as Float32Array;
        const sy = data.getProp('scale_1') as Float32Array;
        const sz = data.getProp('scale_2') as Float32Array;

        if (!x || !y || !z || !opacity || !sx || !sy || !sz) {
            return this.worldBound.halfExtents.length();
        }

        // First pass: compute weighted mean
        let totalWeight = 0;
        let meanX = 0, meanY = 0, meanZ = 0;
        // Use sampling for huge models (>500k points) to avoid blocking
        const stride = numSplats > 500000 ? Math.ceil(numSplats / 200000) : 1;

        for (let i = 0; i < numSplats; i += stride) {
            const op = 1 / (1 + Math.exp(-opacity[i]));
            const w = op / (1 + Math.exp(Math.max(sx[i], sy[i], sz[i])));
            meanX += x[i] * w;
            meanY += y[i] * w;
            meanZ += z[i] * w;
            totalWeight += w;
        }

        if (totalWeight === 0) {
            return this.worldBound.halfExtents.length();
        }

        meanX /= totalWeight;
        meanY /= totalWeight;
        meanZ /= totalWeight;

        // Second pass: compute weighted variance
        let varX = 0, varY = 0, varZ = 0;
        for (let i = 0; i < numSplats; i += stride) {
            const op = 1 / (1 + Math.exp(-opacity[i]));
            const w = op / (1 + Math.exp(Math.max(sx[i], sy[i], sz[i])));
            const dx = x[i] - meanX;
            const dy = y[i] - meanY;
            const dz = z[i] - meanZ;
            varX += dx * dx * w;
            varY += dy * dy * w;
            varZ += dz * dz * w;
        }

        varX /= totalWeight;
        varY /= totalWeight;
        varZ /= totalWeight;

        // 3鑴?sigma covers ~99% of concentrated Gaussians
        const sigma = 3;
        const radius = sigma * Math.sqrt(Math.max(varX, varY, varZ));

        // scale by world transform (uniform scale approximation)
        const worldScale = this.entity.getWorldTransform().getScale();
        return Math.max(radius * (worldScale.x + worldScale.y + worldScale.z) / 3, 0.001);
    }

    /**
     * 取景半径：给相机"把模型框进画面"用。
     *
     * 为什么不是 `worldBound.halfExtents.length()`（AABB 半对角线）：扫描件里常有一小撮
     * 离得很远的噪声点，AABB 会被它们撑爆。用户 2000 万点实测（2026-09-20）：
     *   AABB 半径 8297，而真正看得见的那一坨只有 153 —— 相机因此停在 8~16 km 外，
     *   屏幕上只剩一个点（用户原话："框显所选应该显示完整模型，现在只显示一小块"）。
     *
     * 这里用**裁剪包围盒**：按轴各取 1%~99% 分位，去掉两端极值，再取半对角线。
     * 为什么不是 `denseRadius()`（不透明度×尺度的加权 3σ）：那个量是"密度重心"的统计半径，
     * 对薄墙 / 稀疏结构会明显偏小（实测会让既有取景语义变化：两套回归套件直接失败），
     * 而裁剪分位数只丢极值、不做加权，对正常模型与 AABB 同量级。
     */
    framingRadius(): number {
        const data = this.splatData;
        const x = data?.getProp('x') as Float32Array;
        const y = data?.getProp('y') as Float32Array;
        const z = data?.getProp('z') as Float32Array;
        if (!data || !x || !y || !z) {
            return this.worldBound.halfExtents.length();
        }

        const numSplats = data.numSplats;
        // 抽样上限 20 万：取分位数只要趋势，13M 上一次全扫要 ~500ms，抽样后 ~10ms
        const stride = Math.max(1, Math.ceil(numSplats / 200000));
        const count = Math.ceil(numSplats / stride);
        const sx = new Float32Array(count);
        const sy = new Float32Array(count);
        const sz = new Float32Array(count);
        let k = 0;
        for (let i = 0; i < numSplats; i += stride) {
            sx[k] = x[i];
            sy[k] = y[i];
            sz[k] = z[i];
            k++;
        }
        sx.sort();
        sy.sort();
        sz.sort();

        // 1% / 99% 分位（两端各丢 1% 的极值）
        const lo = Math.floor(count * 0.01);
        const hi = Math.min(count - 1, Math.ceil(count * 0.99));
        const half = (arr: Float32Array) => Math.max((arr[hi] - arr[lo]) * 0.5, 0);

        // 世界尺度（与 denseRadius 同一套近似：三轴平均缩放）
        const worldScale = this.entity.getWorldTransform().getScale();
        const s = (worldScale.x + worldScale.y + worldScale.z) / 3;
        const trimmed = Math.sqrt(half(sx) ** 2 + half(sy) ** 2 + half(sz) ** 2) * s;

        // 取景半径不该比"实心几何"更小：模型整体只有几十个点时上面的分位数会退化成 0
        const bound = this.worldBound.halfExtents.length();
        const radius = Math.max(trimmed * 1.1, Math.min(bound, 1e-3));
        return Math.max(radius, 1e-6);
    }

    move(position?: Vec3, rotation?: Quat, scale?: Vec3) {
        const entity = this.entity;
        if (position) {
            entity.setLocalPosition(position);
        }
        if (rotation) {
            entity.setLocalRotation(rotation);
        }
        if (scale) {
            entity.setLocalScale(scale);
        }

        this.updateWorldBound();

        this.scene.events.fire('splat.moved', this);
    }

    // calculate both selection and local bounds (async, callers must await)
    async updateLocalBounds(): Promise<void> {
        await this.scene.dataProcessor.calcBound(this, this.selectionBoundStorage, this.localBoundStorage);

        // The bound pass can come back unusable. On WebGPU its readback currently returns
        // nothing (every splat bound comes back as all zeros, silently), and on either
        // backend a pass that matched no row at all used to write the shader's ±1e6
        // sentinel straight through — centre 0, halfExtents -1e6. A degenerate local bound
        // collapses the scene bound, so the camera cannot frame the model and its near/far
        // clips end up equal: the projection matrix goes NaN and the viewport stays black
        // for every model, regardless of size, until the offending edit is undone.
        // Fall back to the AABB the engine computed on the CPU when the resource was
        // created (it holds the same local-space extent).
        // CalcBound no longer publishes that sentinel box, so this is the backstop.
        if (!Splat.isUsableBound(this.localBoundStorage) && Splat.isUsableBound(this.cpuBoundStorage)) {
            this.localBoundStorage.copy(this.cpuBoundStorage);
        }

        this.updateWorldBound();

        // the pass just refreshed both bounds, so nothing is pending any more (O1)
        this._selectionBoundDirty = false;
    }

    /** True while selection-only state changes postpone the GPU bound pass (O1). */
    get boundsDeferred() {
        return this._boundsDeferred;
    }

    set boundsDeferred(value: boolean) {
        this._boundsDeferred = value;
    }

    /** True when a selection change landed while the bound pass was postponed (O1). */
    get selectionBoundDirty() {
        return this._selectionBoundDirty;
    }

    /**
     * Recompute the bounds once after a burst of deferred selection changes — i.e. when a
     * range-slider drag settles. No-op when nothing was postponed, and cheap
     * (`state.flush()` is already a no-op by then) when there was.
     */
    async refreshDeferredBounds(): Promise<void> {
        if (this._selectionBoundDirty) {
            await this.updateLocalBounds();
        }
    }

    // a bound is usable when it has a finite centre, finite non-negative extents and a
    // non-zero size. The sign test matters: "no rows matched" used to arrive as
    // halfExtents = -1e6 (see updateLocalBounds), and a negative extent is never a
    // legitimate local bound.
    private static isUsableBound(bound: BoundingBox | null | undefined): boolean {
        if (!bound) {
            return false;
        }
        const { x, y, z } = bound.center;
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
            return false;
        }
        const h = bound.halfExtents;
        if (!Number.isFinite(h.x) || !Number.isFinite(h.y) || !Number.isFinite(h.z)) {
            return false;
        }
        if (h.x < 0 || h.y < 0 || h.z < 0) {
            return false;
        }
        return (h.x + h.y + h.z) > 1e-8;
    }

    // update world bound from local bound (synchronous)
    private updateWorldBound() {
        this.worldBoundStorage.setFromTransformedAabb(this.localBoundStorage, this.entity.getWorldTransform());
        this.scene.boundDirty = true;
    }

    // get the selection bound
    get selectionBound() {
        return this.selectionBoundStorage;
    }

    // get local space bound
    get localBound() {
        return this.localBoundStorage;
    }

    // get world space bound
    get worldBound() {
        return this.worldBoundStorage;
    }

    set visible(value: boolean) {
        if (value !== this.visible) {
            this._visible = value;
            this.scene?.events.fire('splat.visibility', this);
        }
    }

    get visible() {
        return this._visible;
    }

    set showDeleted(value: boolean) {
        if (value !== this._showDeleted) {
            this._showDeleted = value;
            // update sorter mapping to include/exclude deleted points
            this.updateSorting();
            this.scene.forceRender = true;
            this.scene?.events.fire('splat.showDeleted', this);
        }
    }

    get showDeleted() {
        return this._showDeleted;
    }

    set tintClr(value: Color) {
        if (!this._tintClr.equals(value)) {
            this._tintClr.set(value.r, value.g, value.b);
            this.scene.events.fire('splat.tintClr', this);
        }
    }

    get tintClr() {
        return this._tintClr;
    }

    set temperature(value: number) {
        if (value !== this._temperature) {
            this._temperature = value;
            this.scene.events.fire('splat.temperature', this);
        }
    }

    get temperature() {
        return this._temperature;
    }

    set saturation(value: number) {
        if (value !== this._saturation) {
            this._saturation = value;
            this.scene.events.fire('splat.saturation', this);
        }
    }

    get saturation() {
        return this._saturation;
    }

    set brightness(value: number) {
        if (value !== this._brightness) {
            this._brightness = value;
            this.scene.events.fire('splat.brightness', this);
        }
    }

    get brightness() {
        return this._brightness;
    }

    set blackPoint(value: number) {
        if (value !== this._blackPoint) {
            this._blackPoint = value;
            this.scene.events.fire('splat.blackPoint', this);
        }
    }

    get blackPoint() {
        return this._blackPoint;
    }

    set whitePoint(value: number) {
        if (value !== this._whitePoint) {
            this._whitePoint = value;
            this.scene.events.fire('splat.whitePoint', this);
        }
    }

    get whitePoint() {
        return this._whitePoint;
    }

    set transparency(value: number) {
        if (value !== this._transparency) {
            this._transparency = value;
            this.scene.events.fire('splat.transparency', this);
        }
    }

    get transparency() {
        return this._transparency;
    }

    set highlights(value: number) {
        if (value !== this._highlights) {
            this._highlights = value;
            this.scene.events.fire('splat.highlights', this);
        }
    }

    get highlights() {
        return this._highlights;
    }

    set shadows(value: number) {
        if (value !== this._shadows) {
            this._shadows = value;
            this.scene.events.fire('splat.shadows', this);
        }
    }

    get shadows() {
        return this._shadows;
    }

    set contrast(value: number) {
        if (value !== this._contrast) {
            this._contrast = value;
            this.scene.events.fire('splat.contrast', this);
        }
    }

    get contrast() {
        return this._contrast;
    }

    set hslHue(value: ArrayLike<number>) {
        for (let i = 0; i < 8; i++) this._hslHue[i] = value[i] ?? 0;
        this.scene.events.fire('splat.hslHue', this);
    }

    get hslHue() {
        return this._hslHue;
    }

    set hslSat(value: ArrayLike<number>) {
        for (let i = 0; i < 8; i++) this._hslSat[i] = value[i] ?? 0;
        this.scene.events.fire('splat.hslSat', this);
    }

    get hslSat() {
        return this._hslSat;
    }

    set hslLum(value: ArrayLike<number>) {
        for (let i = 0; i < 8; i++) this._hslLum[i] = value[i] ?? 0;
        this.scene.events.fire('splat.hslLum', this);
    }

    get hslLum() {
        return this._hslLum;
    }

    set colorGradeEnabled(value: boolean) {
        if (value !== this._colorGradeEnabled) {
            this._colorGradeEnabled = value;
            this.scene.events.fire('splat.colorGradeEnabled', this);
        }
    }

    get colorGradeEnabled() {
        return this._colorGradeEnabled;
    }

    // get pivot position/rotation/scale (caller should have awaited operation that changed data)
    getPivot(mode: 'center' | 'boundCenter', selection: boolean, result: Transform) {
        const { entity } = this;
        switch (mode) {
            case 'center':
                result.set(entity.getLocalPosition(), entity.getLocalRotation(), entity.getLocalScale());
                break;
            case 'boundCenter': {
                const bound = selection ? this.selectionBound : this.localBound;
                entity.getLocalTransform().transformPoint(bound.center, vec);
                result.set(vec, entity.getLocalRotation(), entity.getLocalScale());
                break;
            }
        }
    }

    docSerialize() {
        const pack3 = (v: Vec3) => [v.x, v.y, v.z];
        const pack4 = (q: Quat) => [q.x, q.y, q.z, q.w];
        const packC = (c: Color) => [c.r, c.g, c.b, c.a];
        return {
            name: this.name,
            position: pack3(this.entity.getLocalPosition()),
            rotation: pack4(this.entity.getLocalRotation()),
            scale: pack3(this.entity.getLocalScale()),
            visible: this.visible,
            tintClr: packC(this.tintClr),
            temperature: this.temperature,
            saturation: this.saturation,
            brightness: this.brightness,
            blackPoint: this.blackPoint,
            whitePoint: this.whitePoint,
            transparency: this.transparency,
            highlights: this.highlights,
            shadows: this.shadows,
            contrast: this.contrast,
            colorGradeEnabled: this.colorGradeEnabled,
            hslHue: Array.from(this._hslHue),
            hslSat: Array.from(this._hslSat),
            hslLum: Array.from(this._hslLum),
            // 曲线调色：存四个通道的**控制点**（每个通道 3~8 个数字对），比存 33×4 个采样值短、可读
            curves: curveSetToDoc(this._curvePoints)
        };
    }

    docDeserialize(doc: any) {
        const { name, position, rotation, scale, visible, tintClr, temperature, saturation, brightness, blackPoint, whitePoint, transparency, highlights, shadows, contrast, colorGradeEnabled, hslHue, hslSat, hslLum, curves } = doc;

        this.name = name;
        this.move(new Vec3(position), new Quat(rotation), new Vec3(scale));
        this.visible = visible;
        this.tintClr = new Color(tintClr[0], tintClr[1], tintClr[2], tintClr[3]);
        this.temperature = temperature ?? 0;
        this.saturation = saturation ?? 1;
        this.brightness = brightness;
        this.blackPoint = blackPoint;
        this.whitePoint = whitePoint;
        this.transparency = transparency;
        this.highlights = highlights ?? 0;
        this.shadows = shadows ?? 0;
        this.contrast = contrast ?? 0;
        this.colorGradeEnabled = colorGradeEnabled ?? true;
        if (hslHue) this.hslHue = hslHue;
        if (hslSat) this.hslSat = hslSat;
        if (hslLum) this.hslLum = hslLum;
        // 曲线：可选字段（旧 .ssproj 没有 ⇒ 保持恒等），格式 `{ master: [[x,y],…], red: …, green: …, blue: … }`
        if (curves && typeof curves === 'object') {
            this.setCurves(curveSetFromDoc(curves));
        }
    }
}

export { Splat };
