// 纯 node 单测：模型分级 + 设备分级 + 导入预算策略（src/core/splat-tier.ts）。
// 不碰浏览器/引擎 —— 分级是纯函数，可以逐条钉死；浏览器侧的行为由
// `docs/probes/huge-model-open.cjs` 与 `docs/verify/verify-import-budget.cjs` 覆盖。
//
// usage: node --experimental-strip-types docs/verify/verify-splat-tier.mts
import {
    DEVICE_SPLAT_CAP,
    describeBudget,
    deviceClass,
    hardSplatLimit,
    importBudget,
    runtimePolicy,
    splatTier
} from '../../src/core/splat-tier.ts';

const checks: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

const M = 1_000_000;

// 本机的三档设备样本（真实读数来自探针 splatDiag()）：
//   5090：maxStorageBufferBindingSize 2 GiB / maxTextureDimension2D 16384
//   主流独显（8 GB）：1 GiB / 16384，deviceMemory 报 8
//   集显（Iris Xe，共享显存）：128 MB / 16384，deviceMemory 报 8
const MIB_ = 1024 * 1024;
const GIB_ = 1024 * 1024 * 1024;
const GPU_5090 = {
    maxStorageBufferBindingSize: 2 * GIB_,
    maxBufferSize: 2 * GIB_,
    maxTextureDimension2D: 16384,
    deviceMemoryGb: 8,
    hardwareConcurrency: 20,
    renderer: 'NVIDIA GeForce RTX 5090',
    isWebGPU: true
};
const GPU_MAINSTREAM = {
    maxStorageBufferBindingSize: GIB_,
    maxBufferSize: 2 * GIB_,
    maxTextureDimension2D: 16384,
    deviceMemoryGb: 8,
    hardwareConcurrency: 12,
    renderer: 'NVIDIA GeForce RTX 4060 Laptop GPU',
    isWebGPU: true
};
const GPU_IGPU = {
    maxStorageBufferBindingSize: 128 * MIB_,
    maxBufferSize: 256 * MIB_,
    maxTextureDimension2D: 16384,
    deviceMemoryGb: 8,
    hardwareConcurrency: 8,
    renderer: 'Intel(R) Iris(R) Xe Graphics',
    isWebGPU: true
};

// ---- 1. 模型分级边界（用户定义：<500 万 / 500 万~5000 万 / >5000 万）----
check('model tiers split at 5M and 50M exactly as requested',
    splatTier(3_355_656) === 'A' && splatTier(4_999_999) === 'A' &&
    splatTier(5_000_000) === 'B' && splatTier(20_000_000) === 'B' &&
    splatTier(50_000_000) === 'B' && splatTier(50_000_001) === 'C' &&
    splatTier(134_652_397) === 'C',
    '3.36M→A, 5M→B, 20M→B, 50M→B, 50M+1→C, 134.65M→C');

check('degenerate counts fall back to the smallest tier instead of throwing',
    splatTier(0) === 'A' && splatTier(-5) === 'A' && splatTier(NaN) === 'A',
    `0→${splatTier(0)} -5→${splatTier(-5)} NaN→${splatTier(NaN)}`);

// ---- 2. 设备分级 ----
check('an integrated GPU is always classed low, however generous its limits look',
    deviceClass(GPU_IGPU) === 'low' &&
    deviceClass({ ...GPU_IGPU, maxStorageBufferBindingSize: 2 * 1024 * M, maxBufferSize: 2 * 1024 * M }) === 'low',
    `Iris Xe → ${deviceClass(GPU_IGPU)}；即使把 limits 抬到 2 GB 仍是 ${deviceClass({ ...GPU_IGPU, maxStorageBufferBindingSize: 2 * 1024 * M })}（共享显存才是本质）`);

check('a discrete GPU with a big binding limit and enough memory is classed high',
    deviceClass(GPU_5090) === 'high' && deviceClass(GPU_MAINSTREAM) === 'high',
    `5090 → ${deviceClass(GPU_5090)}；4060 → ${deviceClass(GPU_MAINSTREAM)}`);

check('a 128 MB storage-buffer binding limit (the WebGPU default) forces low',
    deviceClass({ ...GPU_5090, renderer: 'unknown gpu', maxStorageBufferBindingSize: 128 * M }) === 'low',
    'binding=128 MB ⇒ 排序缓冲最多 3350 万点，且说明适配器没放开限制 ⇒ 低档');

check('unknown facts degrade to mid (never silently to high)',
    deviceClass({}) === 'mid',
    `deviceClass({}) = ${deviceClass({})}`);

// ---- 3. 硬上限 ----
check('the hard limit is min(binding/4, buffer/4, textureDim^2)',
    hardSplatLimit(GPU_5090) === Math.min(2 * 1024 * M / 4, 2 * 1024 * M / 4, 16384 * 16384) &&
    hardSplatLimit({ maxTextureDimension2D: 8192 }) === 8192 * 8192 &&
    hardSplatLimit({ maxStorageBufferBindingSize: 128 * M }) === 32 * M,
    `5090 → ${hardSplatLimit(GPU_5090).toLocaleString()}；纹理 8192 → ${hardSplatLimit({ maxTextureDimension2D: 8192 }).toLocaleString()}；binding 128 MB → ${hardSplatLimit({ maxStorageBufferBindingSize: 128 * M }).toLocaleString()}`);

check('no limits at all means no hard limit (Infinity, not 0)',
    hardSplatLimit({}) === Number.POSITIVE_INFINITY,
    `hardSplatLimit({}) = ${hardSplatLimit({})}`);

// ---- 4. 导入预算 ----
const b5090 = importBudget(134_652_397, GPU_5090);
check('the 134.65M model is reduced to the 5090 comfort cap (60M), not to the hard limit',
    b5090.reduced && b5090.tier === 'C' && b5090.device === 'high' && b5090.budget === DEVICE_SPLAT_CAP.high,
    `${b5090.numSplats.toLocaleString()} → ${b5090.budget.toLocaleString()}（${b5090.reason}, hard=${b5090.hardLimit.toLocaleString()}）`);

const bIris = importBudget(134_652_397, GPU_IGPU);
check('the same model on an iGPU is reduced to 6M (shared memory is the real limit)',
    bIris.reduced && bIris.device === 'low' && bIris.budget === DEVICE_SPLAT_CAP.low,
    `${bIris.numSplats.toLocaleString()} → ${bIris.budget.toLocaleString()}（${describeBudget(bIris)}）`);

check('A/B tier models are NEVER reduced by the comfort cap (only by a real adapter limit)',
    !importBudget(3_355_656, GPU_IGPU).reduced &&
    !importBudget(6_559_584, GPU_IGPU).reduced &&
    !importBudget(20_000_000, GPU_IGPU).reduced &&
    !importBudget(20_000_000, GPU_5090).reduced,
    `用户 output 里的真实扫描件（3.36M / 6.56M / 20M）在集显上也原样导入：` +
    `${['3.36M', '6.56M', '20M'].join(' / ')} 全部 reduced=false`);

check('a real adapter limit does reduce an A/B model (it would not render at all)',
    importBudget(20_000_000, { maxStorageBufferBindingSize: 32 * MIB_ }).reduced &&
    importBudget(20_000_000, { maxStorageBufferBindingSize: 32 * MIB_ }).reason === 'over-hard-limit',
    `binding 32 MB ⇒ 硬上限 ${hardSplatLimit({ maxStorageBufferBindingSize: 32 * MIB_ }).toLocaleString()} ⇒ 2000 万点被抽稀（原因标 over-hard-limit）`);

check('the reduction reason distinguishes device cap from adapter limit',
    b5090.reason === 'over-device-cap' && bIris.reason === 'over-device-cap' &&
    importBudget(134_652_397, { maxStorageBufferBindingSize: 16 * MIB_ }).reason === 'over-hard-limit',
    `5090=${b5090.reason}（舒适上限更紧）Iris=${bIris.reason}（舒适上限更紧）` +
    `binding16MB=${importBudget(134_652_397, { maxStorageBufferBindingSize: 16 * MIB_ }).reason}` +
    `（硬上限 ${hardSplatLimit({ maxStorageBufferBindingSize: 16 * MIB_ }).toLocaleString()} < 舒适 600 万 ⇒ 硬上限更紧）`);

// ---- 5. 运行时策略 ----
const pA = runtimePolicy(3_355_656, GPU_5090);
check('tier A keeps today\'s shipped behaviour exactly on a fast/mid GPU (no LOD, one ladder step, engage 60)',
    !pA.lodAuto && pA.lodFractions.length === 0 && pA.motionLevels.length === 1 &&
    pA.motionLevels[0].renderScale === 0.7 && pA.engageGpuMs === 60 && pA.budgetMs === 33 &&
    pA.minSplatsWithoutTiming === 2_000_000,
    `A/高：lodAuto=${pA.lodAuto} levels=${JSON.stringify(pA.motionLevels)} engage=${pA.engageGpuMs} budget=${pA.budgetMs}`);

const pAWeak = runtimePolicy(3_355_656, GPU_IGPU);
check('tier A on a weak GPU still gets one fallback step (a 3M model can be fill-bound on an iGPU)',
    !pAWeak.lodAuto && pAWeak.motionLevels.length === 2 && pAWeak.motionLevels[1].renderScale === 0.5 &&
    pAWeak.engageGpuMs === 45,
    `A/低：levels=${JSON.stringify(pAWeak.motionLevels.map(l => l.renderScale))} engage=${pAWeak.engageGpuMs}`);

check('a forced device class overrides the heuristics (probe/suite hook)',
    deviceClass({ ...GPU_5090, forcedClass: 'low' }) === 'low' &&
    deviceClass({ ...GPU_IGPU, forcedClass: 'high' }) === 'high' &&
    deviceClass({ ...GPU_IGPU, forcedClass: null }) === 'low',
    `5090+forced(low)=${deviceClass({ ...GPU_5090, forcedClass: 'low' })}；Iris+forced(high)=${deviceClass({ ...GPU_IGPU, forcedClass: 'high' })}；forced=null 时按启发式 ${deviceClass({ ...GPU_IGPU, forcedClass: null })}`);

const pB = runtimePolicy(20_000_000, GPU_5090);
const pBWeak = runtimePolicy(20_000_000, GPU_IGPU);
check('tier B enables distance-driven LOD and keeps the same ladder on a fast GPU',
    pB.lodAuto && pB.lodFractions.length > 0 && pB.motionLevels.length === 2 && pB.engageGpuMs === 60,
    `B/高：lodAuto=${pB.lodAuto} fractions=${JSON.stringify(pB.lodFractions)} levels=${pB.motionLevels.length} engage=${pB.engageGpuMs}`);

check('tier B on a weak GPU gets a deeper ladder and an earlier engage threshold',
    pBWeak.lodAuto && pBWeak.motionLevels.length === 3 &&
    pBWeak.motionLevels[2].renderScale <= 0.35 && pBWeak.engageGpuMs < pB.engageGpuMs,
    `B/低：levels=${JSON.stringify(pBWeak.motionLevels.map(l => l.renderScale))} engage=${pBWeak.engageGpuMs}（高配 ${pB.engageGpuMs}）`);

const pC = runtimePolicy(134_652_397, GPU_5090);
const pCWeak = runtimePolicy(134_652_397, GPU_IGPU);
check('tier C always enables LOD, both GPU classes',
    pC.lodAuto && pC.lodFractions.length === 2 && pCWeak.lodAuto && pCWeak.lodFractions.length === 2,
    `C/高 fractions=${JSON.stringify(pC.lodFractions)}；C/低 fractions=${JSON.stringify(pCWeak.lodFractions)}`);

check('policy tiers are monotone: engage threshold never rises and the ladder never shrinks with tier',
    pA.engageGpuMs >= pB.engageGpuMs && pB.engageGpuMs >= pC.engageGpuMs &&
    pA.motionLevels.length <= pB.motionLevels.length &&
    pB.motionLevels.length <= runtimePolicy(134_652_397, GPU_IGPU).motionLevels.length,
    `engage: A=${pA.engageGpuMs} B=${pB.engageGpuMs} C=${pC.engageGpuMs}；` +
    `ladder 长度: A=${pA.motionLevels.length} B=${pB.motionLevels.length} C(低)=${pCWeak.motionLevels.length}`);

// ---- 6. 人话描述（UI 文案来源）----
check('describeBudget names the model size, the tier, the device class and the target',
    describeBudget(b5090).includes('6000 万') && describeBudget(bIris).includes('600 万') &&
    describeBudget(importBudget(20_000_000, GPU_5090)).includes('原样导入'),
    `${describeBudget(b5090)} ｜ ${describeBudget(importBudget(20_000_000, GPU_5090))}`);

const failed = checks.filter(c => !c.pass).length;
console.log(JSON.stringify({ checks, failed }, null, 1));
process.exit(failed === 0 ? 0 : 1);
