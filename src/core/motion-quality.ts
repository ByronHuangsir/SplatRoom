// Interaction-time quality: drop rendering quality while the camera is moving, restore it when the
// camera settles.
//
// The problem this solves: on a heavy model every moving frame pays full price (all gaussians, full
// SH band count, no size-cull slack), so dragging feels worse than the final still image. Measured on
// this machine with a deliberately fill-heavy 20M fixture (docs/probes/gpu-frame-probe.cjs, 81% of the
// viewport lit): frame p50 **70.1 ms**, and the engine's GPU span p50 **70.15 ms** — i.e. the whole
// frame is GPU time, so quality is the only lever that moves it. On the shipped sub-pixel fixture the
// same probe reports 2.1% lit and 2.4 ms GPU, which is why the fixture's visibility check matters.
//
// Upstream design this follows (SuperSplat 3.3.0, MIT — see
// docs/perf/supersplat-3.3.0-代码可借鉴点.md): while the camera moves it renders a cheaper image and
// once the scene settles it renders one clean frame. Two of its rules are copied deliberately,
// because they are what keeps the mechanism invisible on fast machines and stable when it does engage:
//   - `autoEngageMs = 60` (ss330/src/scene.ts:136, :688): degradation only engages if a *settled*
//     frame's GPU span exceeded 60 ms. A fast scene therefore never degrades at all.
//   - `motionBudgetMs = 12` plus a rate-limited, damped step (ss330/src/projected-splat-renderer.ts:
//     204-209, :562-579): the degradation level is steered toward a 12 ms GPU budget instead of being
//     pinned to a constant, and steps at most once per 50 ms so it cannot hunt.
//
// Deliberately NOT here: nothing in this module touches `view.bands`, preferences or the document.
// The degradation is a transient material-level cap (see Splat#setMotionQuality), so it cannot leak
// into a saved .ssproj, the settings slider or the export dialog (all of which read `view.bands` —
// see docs/perf/P0-3-交互期降级-前置侦察.md §1/§5.1).

import type { RuntimePolicy } from './splat-tier';

type QualityLevel = {
    /**
     * Render-target scale for the viewport while moving (1 = full resolution). The frame is blitted
     * back up to the canvas, so this trades sharpness for fill rate.
     */
    renderScale: number;
    /**
     * Optional `minPixelSize` (screen-space size cull) to raise while moving; 0 keeps the engine
     * default (2). Left at 0 in the default ladder on purpose — see the measurement note below.
     */
    pixelSize: number;
};

/**
 * 贡献剔除（v2，M2-1）的基线：unified 通路下引擎 `scene.gsplat.minContribution` 的默认值。
 * 静止帧**永远停在这个值上** —— v2 不改变静止画面（与今天的 unified 基线逐项一致）。
 */
export const MIN_CONTRIBUTION_BASE = 3;

class MotionQuality {
    /** master switch (kept for probes/tests and a future user-facing setting) */
    enabled = true;

    /**
     * Engage degradation only when a settled frame's GPU span exceeds this (ms). Same role as
     * SuperSplat's `autoEngageMs`; below it, degradation would trade quality for time nobody needs.
     */
    engageGpuMs = 60;

    /**
     * GPU span (ms) that moving frames are steered toward — 33 ms ≈ 30 fps, the point where dragging
     * stops feeling like a slideshow. Upstream steers toward 12 ms; that is unreachable on a
     * fill-bound 20M model (the coarsest measured step still costs 18 ms), and aiming below what the
     * hardware can do would pin the controller at its coarsest level forever.
     */
    budgetMs = 33;

    /**
     * Minimum interval between two level changes (ms). Deliberately far slower than upstream's 50 ms:
     * our lever reallocates the render targets, so changing it is not free — the first version of
     * this file reused upstream's 50 ms, which would have re-allocated up to 20×/s mid-drag.
     */
    stepMs = 300;

    /**
     * Without timestamp-query support the GPU span cannot be measured, so engagement falls back to
     * "the model is big enough that this is worth doing". Below this point a fast machine would pay
     * a quality drop for no reason.
     */
    minSplatsWithoutTiming = 2000000;

    // ---- 贡献剔除（v2，M2-1）：unified 通路专属的第二个降级杠杆 ----
    //
    // 机制：引擎 hybrid 管线的 projector compute 里就有这条剔除（`compute-gsplat-common.wgsl`：
    // `opacity * 2π * sqrt(det) < minContribution` 即剔），剔掉的点不进排序键也不进绘制 ——
    // 在"每帧 projector+排序的 per-splat 计算主导"的 unified 大模型上，这是实测最大的杠杆
    // （20M 填充夹具 @ RTX 3070 Ti，旋转中 GPU p50：78.3ms → 18.9ms，mc 3→1000，lit 80%→49%）。
    // 杠杆本身是**一个 uniform**，无 realloc 代价，步进频率可以远快于分辨率阶梯。
    //
    // 与上游 SuperSplat 3.3.0 的两点刻意不同（`projected-splat-renderer.ts:67-77`）：
    //   1. **量纲**：判据是 α·π·radius²（像素单位），本仓库的模型/夹具里存活高斯的贡献普遍
    //      在 10²–10⁴ 量级，上游 0–1 的加法步进（+0.05/50ms）在本仓库要几分钟才爬到有效区
    //      （实测：加法步进 5 秒只到 88，毫无效果）。因此改为**几何步进**：超预算 ×2、
    //      富余 ÷1.4，从基线 3 到 ~1000 只要 ~9 步（450 ms）。
    //   2. **基线**：我们的静止值是引擎默认 **3**（上游静止帧用 0）—— 静止画面保持今天的
    //      unified 基线不变，运动期只往上抬，停手精确回落。上限按分级策略给（applyPolicy），
    //      语义是"运动期最多愿意丢多少画面"（画质硬边界，不是性能目标 —— 预算导向的控制器
    //      会在到达上限之前就停在预算内）。
    //
    // 剂量响应（20M 填充夹具，旋转中，直接设引擎参数测得，_tmp/probe-mc-direct-dose.cjs）：
    //   mc    rAF p50   GPU p50   lit
    //   3      78.1     78.3     79.9%
    //   1000   18.9     18.9     48.5%
    //   3000   16.7      5.8     29.7%
    //   10000  16.7      4.0      0.2%（画面基本消失 —— 上限必须远离这里）

    /** 总开关（排障/回归用：`window.__SPLATROOM_MOTION_CONTRIBUTION__ = false`） */
    contributionEnabled = true;

    /** 静止值 = 引擎默认。运动结束后精确回到这里（见 MIN_CONTRIBUTION_BASE）。 */
    contributionBase = MIN_CONTRIBUTION_BASE;

    /** 运动期上限（applyPolicy 按分级覆盖；等于 base 即关闭该杠杆）。 */
    contributionCeiling = MIN_CONTRIBUTION_BASE;

    /** 超预算时每步的乘数（几何步进，见上面的量纲说明）。 */
    contributionUpFactor = 2;

    /** 富余时每步的除数（放松比收紧慢半档，避免在预算线附近震荡）。 */
    contributionDownFactor = 1.4;

    /** 两次贡献步进的最小间隔（ms）。无 realloc 代价，可比分辨率阶梯快得多（上游同值 50）。 */
    contributionStepMs = 50;

    /**
     * 测试钩子（与 forceEngaged 同一约定）：非 null 时 update() 用它代替实测的 moving GPU span，
     * 让浏览器套件能在小模型上确定性地把控制器推过预算。
     */
    forceMovingGpuMs: number | null = null;

    /**
     * Degradation ladder, cheapest step first. Values come from measuring the GPU-bound 20M fill
     * fixture on this machine (docs/probes/gpu-frame-probe.cjs; frame p50 at full resolution was
     * 69.6 ms with the GPU span at 69.9 ms, i.e. fill-bound):
     *
     *   render scale 0.7 -> 39.9 ms   (mean pixel delta 36 vs full res)
     *   render scale 0.5 -> 25.4 ms   (mean pixel delta 113)
     *   render scale 0.35 -> 18.1 ms  (mean pixel delta 151)
     *   restore 1.0 -> 69.9 ms, pixel delta 0 (exact restore)
     *
     * The other candidate levers were measured and rejected:
     *   - SH bands 3 -> 1 -> 0: **-0.5%** GPU on a fill-bound scene (useless here)
     *   - `minPixelSize` 4 / 8 / 16: 0% / -1.5% / -16%, i.e. it only bites at a threshold that culls
     *     everything under 4x4 px, which visibly changes the image. Hence pixelSize stays 0.
     *   - `alphaClipForward`: a no-op in this fork (the engine's `clipCorner` never runs — the fork
     *     replaces that vertex entry point), see docs/perf/P0-3-交互期降级-前置侦察.md §2.
     */
    levels: QualityLevel[] = [
        { renderScale: 0.7, pixelSize: 0 },
        { renderScale: 0.5, pixelSize: 0 }
    ];

    /** force engagement on/off regardless of the measurement (probes and regression suites) */
    forceEngaged: boolean | null = null;

    /**
     * 按分级策略（`src/core/splat-tier.ts`）重设阶梯与门槛。
     *
     * 为什么需要：`levels` / `engageGpuMs` 原来是一组**与模型规模、机器快慢都无关**的常数
     * （0.7 / 0.5 是在 RTX 5090 上按 2000 万点填充受限夹具量出来的）。
     * 小模型不该被降级、1.3 亿点或集显上这一档远远不够 —— 分级策略把这三档分开。
     *
     * @param policy - 运行时策略（阶梯、启用门槛、目标预算、无计时兜底）
     */
    applyPolicy(policy: RuntimePolicy) {
        this.levels = policy.motionLevels.map(l => ({ renderScale: l.renderScale, pixelSize: l.pixelSize }));
        this.engageGpuMs = policy.engageGpuMs;
        this.budgetMs = policy.budgetMs;
        this.minSplatsWithoutTiming = policy.minSplatsWithoutTiming;
        this.contributionCeiling = policy.motionContributionCeiling;
        const maxLevel = this.levels.length - 1;
        if (this._level > maxLevel) {
            this._level = Math.max(0, maxLevel);
        }
        if (this._contribution > this.contributionCeiling) {
            this._contribution = this.contributionCeiling;
        }
    }

    private _level = 0;
    private _engaged = false;
    private _autoEngaged = false;
    private _lastStepAt = 0;
    // 贡献剔除的当前值（engaged 之外不消费，见 minContribution getter）
    private _contribution = MIN_CONTRIBUTION_BASE;
    private _lastContributionStepAt = 0;
    // 上一次手势收敛到的工作点（0 = 没有记忆）。再次拖拽直接从它暖启动，
    // 否则每次手势的前 ~500 ms 都要付几何爬坡的慢帧（实测 p95 被起步期拖到 75 ms）。
    private _contributionMemory = 0;

    /** currently applied level index */
    get level() {
        return this._level;
    }

    /** true while the degraded quality is applied */
    get engaged() {
        return this._engaged;
    }

    /** whether a settled frame was measured slow enough to make degradation worthwhile */
    get autoEngaged() {
        return this._autoEngaged;
    }

    /** render-target scale to apply (1 = full resolution) */
    get renderScale() {
        return this._engaged ? this.levels[this._level].renderScale : 1;
    }

    /** `minPixelSize` to apply (0 = leave the engine default alone) */
    get pixelSize() {
        return this._engaged ? this.levels[this._level].pixelSize : 0;
    }

    /**
     * 当前应施加到引擎 `scene.gsplat.minContribution` 的值（只对 unified 通路有意义）。
     * 未 engaged / 总开关关闭时 = 基线（引擎默认），静止画面零变化。
     */
    get minContribution() {
        return this._engaged && this.contributionEnabled ? this._contribution : this.contributionBase;
    }

    /** 贡献值是否已经顶到上限（分辨率阶梯只在此时才往下走 —— 便宜的杠杆先用尽） */
    get contributionAtCeiling() {
        return this._contribution >= this.contributionCeiling - 1e-6;
    }

    /**
     * Feed one frame.
     *
     * @param moving - camera is in motion this frame (see CameraMotion).
     * @param numSplats - total gaussians in the scene, for the no-timing fallback.
     * @param gpuSupported - adapter exposes timestamp queries.
     * @param settledGpuMs - GPU span of the most recent *settled* frame (null when unknown).
     * @param movingGpuMs - GPU span of the most recent *moving* frame (null when unknown).
     * @param now - `performance.now()`.
     * @returns true when the applied quality changed on this frame.
     */
    update(
        moving: boolean,
        numSplats: number,
        gpuSupported: boolean,
        settledGpuMs: number | null,
        movingGpuMs: number | null,
        now: number
    ): boolean {
        if (this.forceEngaged !== null) {
            this._autoEngaged = this.forceEngaged;
        } else if (gpuSupported) {
            // remember the last verdict: a settled frame is the only fair sample of what the user
            // would look at, and it is also the frame that pays for sorting
            if (settledGpuMs !== null) {
                this._autoEngaged = settledGpuMs > this.engageGpuMs;
            }
        } else {
            this._autoEngaged = numSplats >= this.minSplatsWithoutTiming;
        }

        const engaged = this.enabled && this._autoEngaged && moving;
        const previousLevel = this._level;
        const previousEngaged = this._engaged;

        if (!engaged) {
            this._level = 0;
            this._engaged = false;
            // 停手前控制器停在哪就记住哪：下一次拖拽从这个工作点暖启动（见 _contributionMemory）
            if (this._contribution > this.contributionBase) {
                this._contributionMemory = this._contribution;
            }
            // 贡献值回到基线：静止帧的画面与"从未降级"逐项一致（applyMinContribution 幂等）
            this._contribution = this.contributionBase;
            return previousEngaged !== this._engaged || previousLevel !== this._level;
        }

        this._engaged = true;
        const maxLevel = this.levels.length - 1;
        const measuredMovingGpuMs = this.forceMovingGpuMs ?? movingGpuMs;
        let changed = previousEngaged !== this._engaged;

        // 暖启动：本次拖拽的起点 = 上次收敛的工作点（首次手势没有记忆，从基线几何爬坡）。
        // 同时把步进时钟重置：暖启动帧不再立刻 ×2 —— 让预算控制器先用这个工作点量一帧，
        // 再决定抬还是松（否则每次再拖拽都会先冲过工作点再回落）。
        if (!previousEngaged && this._contributionMemory > this.contributionBase) {
            const warm = Math.min(this.contributionCeiling, this._contributionMemory);
            if (warm > this.contributionBase) {
                this._contribution = warm;
                this._lastContributionStepAt = now;
                changed = true;
            }
        }

        // ---- 杠杆 ①：贡献剔除（便宜、无 realloc，50 ms 步进，几何步进见头部注释）----
        // 超预算 → ×2 朝上限抬；富余 → ÷1.4 朝基线放松。放松比收紧慢，
        // 报告滞后于它测量的帧，两侧同速会在预算线附近震荡。
        if (this.contributionEnabled && this.contributionCeiling > this.contributionBase &&
            measuredMovingGpuMs !== null && now - this._lastContributionStepAt >= this.contributionStepMs) {
            this._lastContributionStepAt = now;
            const ratio = measuredMovingGpuMs / this.budgetMs;
            const prev = this._contribution;
            if (ratio > 1.05) {
                this._contribution = Math.min(this.contributionCeiling, this._contribution * this.contributionUpFactor);
            } else if (ratio < 0.9) {
                this._contribution = Math.max(this.contributionBase, this._contribution / this.contributionDownFactor);
            }
            if (this._contribution !== prev) {
                changed = true;
            }
        }

        // ---- 杠杆 ②：分辨率阶梯（贵、要 realloc，300 ms 步进）----
        // 只在杠杆 ① 顶到上限（或被关掉）还超预算时才往下走 —— 同一个预算信号，便宜的先动。
        if (measuredMovingGpuMs !== null && now - this._lastStepAt >= this.stepMs) {
            this._lastStepAt = now;
            const ratio = measuredMovingGpuMs / this.budgetMs;
            if (ratio > 1.05 && (!this.contributionEnabled || this.contributionCeiling <= this.contributionBase || this.contributionAtCeiling)) {
                // too slow even degraded: one step coarser
                this._level = Math.min(maxLevel, this._level + 1);
            } else if (ratio < 0.9) {
                // comfortably inside budget: one step finer (a slow reaction is intentional — the
                // reports lag the frame they measure, so stepping every report overshoots)
                this._level = Math.max(0, this._level - 1);
            }
        }

        return changed || previousLevel !== this._level;
    }

    reset() {
        this._level = 0;
        this._engaged = false;
        this._autoEngaged = false;
        this._lastStepAt = 0;
        this._contribution = this.contributionBase;
        this._lastContributionStepAt = 0;
        this._contributionMemory = 0;
    }
}

export { MotionQuality };
export type { QualityLevel };
