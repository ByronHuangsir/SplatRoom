// 按模型规模分级（用户提的三档）+ 按设备能力分级 ⇒ 一套"该给多少预算"的策略。
//
// 为什么需要它：今天所有策略都是**一条固定的线**，与模型规模、与机器快慢都无关 ——
//   • 导入：不管 300 万还是 1.3 亿点，一律把每一列都物化成 Float32Array
//     （1.3 亿 × 56 B = 7.02 GiB，实测导入 >10 分钟仍未完成、渲染进程常驻约 10.7 GB）。
//   • 交互期降级（`src/core/motion-quality.ts`）：`levels` 只有 0.7 / 0.5 两档，
//     是把 2000 万点的填充受限夹具在 RTX 5090 上量出来的；1.3 亿点或集显上远远不够。
//   • 运行时 LOD（`src/lod/editor-lod.ts`）：默认**关闭**，只有用户在设置里手动打开才会生成代理层。
//   • 排序/预测、SH 波段、`minPixelSize` 同样没有规模维度。
//
// 本模块只做**纯决策**（不碰 DOM / 引擎 / 存储），所以可以纯 node 单测：
// 输入"多少高斯 + 这台设备的能力上限"，输出"导入预算 + 运行时策略"。
//
// 三档（用户 2026-09-22 提出）：
//   A  < 500 万      —— 兼顾显示效果：不动 LOD、不抽稀、SH 全开、降级策略保持现状；
//   B  500 万 ~ 5000 万 —— 平衡：保留全部数据，但允许按距离用 LOD 代理层压住渲染成本；
//   C  > 5000 万     —— 优先可用：导入即按设备预算抽稀，LOD + 更陡的降级阶梯。
//
// 兜底原则：**只做"不这样就打不开"的削减**。预算之内的模型一个点都不动，
// 免得为了性能悄悄改掉用户看到的画面（这条是踩过坑的：观感类改变必须默认保守）。

/** A 档上界：500 万高斯 */
export const TIER_A_MAX = 5_000_000;
/** B 档上界：5000 万高斯；超过即 C 档 */
export const TIER_B_MAX = 50_000_000;

export type SplatTier = 'A' | 'B' | 'C';

/** 模型分级：只看数量。 */
export const splatTier = (numSplats: number): SplatTier => {
    if (!Number.isFinite(numSplats) || numSplats <= 0) return 'A';
    if (numSplats > TIER_B_MAX) return 'C';
    return numSplats >= TIER_A_MAX ? 'B' : 'A';
};

export type DeviceClass = 'high' | 'mid' | 'low';

/**
 * 设备事实（都来自浏览器/适配器，取不到就留空 —— 决策必须能在信息不全时退化）。
 * `max*` 三项来自 `graphicsDevice.limits`（WebGPU 与 WebGL2 都有）；
 * `deviceMemoryGb` 是 `navigator.deviceMemory`（Chrome 上限报 8，"≥8" 就是这个值）；
 * `renderer` 是 WebGL2 的 unmasked renderer 或 WebGPU 的 adapter 描述串。
 */
export type DeviceFacts = {
    maxStorageBufferBindingSize?: number | null;
    maxBufferSize?: number | null;
    maxTextureDimension2D?: number | null;
    deviceMemoryGb?: number | null;
    hardwareConcurrency?: number | null;
    renderer?: string | null;
    isWebGPU?: boolean | null;
    /**
     * 强制档位（只给探针/套件/排障用：`window.__SPLATROOM_DEVICE_CLASS__ = 'low'`）。
     * 真机上"低配电脑"没法复现，用它可以在一台机器上验证三档策略。
     */
    forcedClass?: DeviceClass | null;
};

const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

/** 集显 / 共享显存的特征串（这些设备的"显存"其实是内存，必须按低档处理）。 */
const INTEGRATED_RE = /intel|uhd|iris|hd graphics|radeon\(tm\) graphics|radeon graphics|vega \d|apple m\d|mali|adreno|powervr|llvmpipe|swiftshader|basic render/i;

/** 独显特征串（用于在 limits 不可靠时兜底判"高档"）。 */
const DISCRETE_RE = /geforce|rtx|gtx|quadro|radeon rx|arc a\d|arc b\d|nvidia/i;

/**
 * 设备分级（高 / 中 / 低）。判据顺序很重要：
 * 先看"是不是集显"（共享显存，无论 limits 报多少都要按低档算），
 * 再看存储缓冲绑定上限（它直接决定 WebGPU 上能渲染多少点，默认 128 MB ⇒ 约 3350 万点），
 * 最后才看内存 / 核数这些弱信号。
 */
export const deviceClass = (facts: DeviceFacts = {}): DeviceClass => {
    if (facts.forcedClass === 'low' || facts.forcedClass === 'mid' || facts.forcedClass === 'high') {
        return facts.forcedClass;
    }
    const renderer = (facts.renderer ?? '').toLowerCase();
    const binding = typeof facts.maxStorageBufferBindingSize === 'number' ? facts.maxStorageBufferBindingSize : null;
    const memory = typeof facts.deviceMemoryGb === 'number' ? facts.deviceMemoryGb : null;
    const cores = typeof facts.hardwareConcurrency === 'number' ? facts.hardwareConcurrency : null;

    if (renderer && INTEGRATED_RE.test(renderer)) return 'low';
    if (binding !== null && binding <= 256 * MIB) return 'low';
    if (memory !== null && memory <= 4) return 'low';
    if (cores !== null && cores <= 4) return 'low';

    const discrete = DISCRETE_RE.test(renderer);
    // 独显一般报 1 GiB 以上的绑定上限（实测 5090 = 2 GiB、笔记本 4060 = 1 GiB）；
    // 门槛取 0.75 GiB，免得刚好报 1 GiB（= 1.0737e9 B）的设备掉进中档。
    const bigBinding = binding === null ? discrete : binding >= 0.75 * GIB;
    const enoughMemory = memory === null || memory >= 8;
    if (bigBinding && enoughMemory) return 'high';
    return 'mid';
};

/**
 * 这台设备的**硬上限**（超过就真的渲染不出来，不是"慢"）：
 *   • WebGPU 的排序结果是一个 u32/点的存储缓冲 ⇒ `maxStorageBufferBindingSize / 4`；
 *   • 单缓冲上限同样约束它 ⇒ `maxBufferSize / 4`；
 *   • 引擎把三路流打包进 `ceil(sqrt(N))²` 的纹理 ⇒ `maxTextureDimension2D²`。
 * 取三者最小；信息不全时返回 `Infinity`（不设限，交给"舒适上限"）。
 */
export const hardSplatLimit = (facts: DeviceFacts = {}): number => {
    const caps: number[] = [];
    const binding = facts.maxStorageBufferBindingSize;
    const buffer = facts.maxBufferSize;
    const tex = facts.maxTextureDimension2D;
    if (typeof binding === 'number' && binding > 0) caps.push(Math.floor(binding / 4));
    if (typeof buffer === 'number' && buffer > 0) caps.push(Math.floor(buffer / 4));
    if (typeof tex === 'number' && tex > 0) caps.push(tex * tex);
    return caps.length ? Math.min(...caps) : Number.POSITIVE_INFINITY;
};

/**
 * 每档设备的**舒适上限**（能流畅交互，而不只是"能画出来"）。
 * 依据（本项目实测）：
 *   • 每点 GPU 约 39 B（三路流 32 B + order 4 B + state 1 B + transform 2 B），
 *     CPU 侧还有列 56 B + 纹理镜像 32 B + centers 12 B；
 *   • 2000 万点 / 4.72 GB（SH3）在 RTX 5090 上可用（帧 p50 70 ms 的填充受限场景，
 *     开降级后 30 ms），这是"高"档的锚点；
 *   • 集显/共享显存设备上显存与内存抢同一块物理内存 ⇒ 按约 1/4 给（600 万点 ≈ 234 MB 显存 + 1.1 GB 列）。
 */
export const DEVICE_SPLAT_CAP: Record<DeviceClass, number> = {
    low: 6_000_000,
    mid: 20_000_000,
    high: 60_000_000
};

export type ImportBudget = {
    numSplats: number;
    tier: SplatTier;
    device: DeviceClass;
    /** 允许物化的最大行数 */
    budget: number;
    /** 是否必须抽稀（`numSplats > budget`） */
    reduced: boolean;
    /** 硬上限（适配器限制），用于解释原因 */
    hardLimit: number;
    reason: 'within-budget' | 'over-hard-limit' | 'over-device-cap' | 'forced-budget';
};

/**
 * 导入预算：这个模型在这台设备上应该物化多少行。
 *
 * **只做"不这样就打不开"的削减**，两条规则：
 *   1. 适配器硬上限（`hardSplatLimit`）永远生效 —— 超了是渲染不出来，不是慢；
 *   2. 舒适上限（`DEVICE_SPLAT_CAP`）**只对 C 档（> 5000 万点）生效**。
 *      A/B 档的模型今天本来就能打开（用户自己的 2000 万点扫描件就是 B 档），
 *      为了"更快"把它们悄悄抽稀会直接改掉用户看到的画质 —— 那该由运行时策略
 *      （LOD / 交互期降级）去省，不该动数据。C 档相反：不抽稀就是打不开。
 */
export const importBudget = (numSplats: number, facts: DeviceFacts = {}): ImportBudget => {
    const tier = splatTier(numSplats);
    const device = deviceClass(facts);
    const hardLimit = hardSplatLimit(facts);
    const comfortable = DEVICE_SPLAT_CAP[device];
    const hardIsTighter = hardLimit <= comfortable;
    const budget = Math.max(1, Math.floor(tier === 'C' ? Math.min(hardLimit, comfortable) : hardLimit));
    const reduced = Number.isFinite(numSplats) && numSplats > budget;
    return {
        numSplats,
        tier,
        device,
        budget,
        reduced,
        hardLimit,
        // 抽稀的原因：A/B 档只可能被硬上限挡住；C 档看两者谁更紧
        reason: !reduced ? 'within-budget' :
            (tier !== 'C' || hardIsTighter) ? 'over-hard-limit' : 'over-device-cap'
    };
};

export type RuntimePolicy = {
    /** 是否自动生成 + 启用按距离切换的 LOD 代理层 */
    lodAuto: boolean;
    /** LOD 代理层占原模型的比例（空数组 = 不做 LOD） */
    lodFractions: number[];
    /** 交互期降级阶梯（由浅到深；`renderScale = 1` 表示不降级） */
    motionLevels: { renderScale: number; pixelSize: number }[];
    /** 静止帧 GPU 耗时超过它才启用降级（ms） */
    engageGpuMs: number;
    /** 运动帧被引导到的 GPU 预算（ms） */
    budgetMs: number;
    /** 没有 timestamp query 时，凭多少点就启用降级 */
    minSplatsWithoutTiming: number;
    /**
     * 运动期贡献剔除的上限（`scene.gsplat.minContribution`，unified 通路；基线 3 = 引擎默认）。
     * 等于 3 即关闭该杠杆。语义是**运动期画质硬边界**（不是性能目标 —— 预算导向的控制器
     * 会在上限之内停在预算上）。定标依据 20M 填充夹具的剂量响应（motion-quality.ts 头注）：
     * mc 1000 时 lit 80%→49%（结构完整、细节变稀），3000 时 →30%，10000 画面消失。
     * A 档 + 高配保持 3（今天的运动行为原样）；A/low 800；B 1500；C（可用优先）4000。
     */
    motionContributionCeiling: number;
};

/**
 * 运行时策略。**A 档与高配机器保持今天的默认行为**（这是发版验证过的形态），
 * 其余档位逐级加码：B 档开 LOD、C 档加一档更狠的分辨率阶梯并把"启用降级"的门槛提前。
 * 设备档位只影响"多快启用 / 能降到多低"，不影响画质上限。
 */
export const runtimePolicy = (numSplats: number, facts: DeviceFacts = {}): RuntimePolicy => {
    const tier = splatTier(numSplats);
    const device = deviceClass(facts);

    if (tier === 'A') {
        // 小模型：**高配/中配上的行为与今天完全一致**（不掉画质、不做 LOD、按实测帧时间决定是否降级）。
        // 只有低配（集显/共享显存）多给一档退路 —— 那些机器上即使 300 万点也可能填充受限。
        return {
            lodAuto: false,
            lodFractions: [],
            motionLevels: device === 'low' ?
                [{ renderScale: 0.7, pixelSize: 0 }, { renderScale: 0.5, pixelSize: 0 }] :
                [{ renderScale: 0.7, pixelSize: 0 }],
            engageGpuMs: device === 'low' ? 45 : 60,
            budgetMs: 33,
            minSplatsWithoutTiming: 2_000_000,
            // A 档高配/中配：贡献剔除关闭（今天的运动行为原样）；低配给一档
            motionContributionCeiling: device === 'low' ? 800 : 3
        };
    }

    if (tier === 'B') {
        return {
            lodAuto: true,
            // 900 万以上给一层，2500 万以上给两层（与 lod.planLodFractions 同源）
            lodFractions: numSplats > 25_000_000 ? [0.35, 0.10] : [0.35],
            motionLevels: device === 'high' ?
                [{ renderScale: 0.7, pixelSize: 0 }, { renderScale: 0.5, pixelSize: 0 }] :
                [{ renderScale: 0.7, pixelSize: 0 }, { renderScale: 0.5, pixelSize: 0 }, { renderScale: 0.35, pixelSize: 0 }],
            engageGpuMs: device === 'high' ? 60 : 45,
            budgetMs: 33,
            minSplatsWithoutTiming: 2_000_000,
            motionContributionCeiling: 1500
        };
    }

    // C 档：> 5000 万，导入已按预算抽稀，运行时继续按"优先可用"配置
    return {
        lodAuto: true,
        lodFractions: [0.35, 0.10],
        motionLevels: device === 'high' ?
            [{ renderScale: 0.7, pixelSize: 0 }, { renderScale: 0.5, pixelSize: 0 }] :
            [{ renderScale: 0.7, pixelSize: 0 }, { renderScale: 0.5, pixelSize: 0 }, { renderScale: 0.35, pixelSize: 0 }],
        engageGpuMs: device === 'high' ? 45 : 33,
        budgetMs: 33,
        minSplatsWithoutTiming: 1_000_000,
        motionContributionCeiling: 4000
    };
};

/** 人话描述（给 UI / 日志用）。 */
export const describeBudget = (b: ImportBudget): string => {
    const m = (n: number) => (n >= 10_000 ? `${Math.round(n / 10_000)} 万` : `${n}`);
    if (!b.reduced) {
        return `模型 ${m(b.numSplats)} 点（${b.tier} 档）在本机（${b.device}）预算内，原样导入`;
    }
    const cap = Number.isFinite(b.hardLimit) ? Math.min(b.hardLimit, DEVICE_SPLAT_CAP[b.device]) : DEVICE_SPLAT_CAP[b.device];
    const why = b.reason === 'over-hard-limit' ?
        `超出适配器硬上限（约 ${m(b.hardLimit)} 点）` :
        `超出本机舒适上限（${b.device} 档约 ${m(cap)} 点）`;
    return `模型 ${m(b.numSplats)} 点（${b.tier} 档）${why}，导入时抽稀到 ${m(b.budget)} 点`;
};
