// 浏览态帧预算控制器（M3-3）。
//
// 要解决的问题，先用实测数字说清楚（20M 填充夹具，RTX 3070 Ti，30°/s 匀速旋转，
// 视口 900×600，探针 `_tmp/probe-browse-baseline.cjs`）：
//
//   点数    rAF p50   GPU p50   lit%
//   20M     44.5ms    44.5     55.73      ← 基线，22.5 fps
//   7M      18.0ms    15.8     55.62      ← LOD 代理层，55.7 fps
//   2M      17.9ms     4.6     55.69      ← LOD 代理层，53.4 fps
//
// 两条结论决定了这个模块的设计：
//   1. **点数才是杠杆**：20M→7M 让 GPU 从 44.5 掉到 15.8 ms，而 lit% 一动不动（55.6 vs 55.7），
//      也就是说画面覆盖完全没变、成本降了 2.8×。对比之下 `minContribution` 那档杠杆是以
//      丢 lit 换时间（mc 1000 时 80%→49%），属于"画质换帧率"；LOD 减点数在这个夹具上是
//      "白拿"（点密到抽掉 65% 屏幕仍然铺满）。
//   2. **信号必须取 rAF 帧时，不能取 GPU span**：2M 时 GPU 只剩 4.6 ms 而 rAF 仍 17.9 ms ——
//      少掉的那部分既不在 GPU 也不在点数上（提交/合成/浏览器节奏）。拿 GPU span 当反馈，
//      控制器会以为"富余得离谱"而一路放松回 20M，然后又被卡回 22 fps。验收口径是
//      "用户看到 60 fps"，所以反馈信号就是用户看到的那个：rAF 帧间隔。
//
// 控制器只输出一个**粗化档位** `coarseness`（0 = 全分辨率，k = 比全分辨率粗 k 档），
// 由调用方（Scene.updateLodSwitching）翻译成具体的代理层下标。这样它不认识 Asset、
// 不认识 Splat，可以在 Node 里单测（见 `docs/verify/verify-browse-budget.mjs`）。

/** 60 fps 的帧预算（ms）。 */
export const BROWSE_TARGET_MS = 16.7;

/** 两次档位变化的最小间隔（ms）。切换代理层实测 41–220 ms，不能更快。 */
const STEP_MS = 600;

/** 超过预算这么多倍才粗化一档（死区，避免在预算线附近来回跳）。 */
const OVER_RATIO = 1.08;

/** 富余到这么多倍才细化一档（放松比收紧慢，与 motion-quality 同一纪律）。 */
const UNDER_RATIO = 0.75;

/** 帧时 EMA 系数：新样本权重 0.25（约 4 帧的时间常数）。 */
const EMA_ALPHA = 0.25;

/** 采信的帧时区间（ms）：低于 0.5 是空转帧，高于 500 是一次卡顿/切层，都不该驱动档位。 */
const SAMPLE_MIN_MS = 0.5;
const SAMPLE_MAX_MS = 500;

class BrowseBudget {
    /** 总开关（`window.__SPLATROOM_BROWSE_BUDGET__ = false` 可关）。 */
    enabled = true;

    /** 运动/浏览帧被引导到的帧时（ms）。 */
    targetMs = BROWSE_TARGET_MS;

    /**
     * 测试钩子：非 null 时 `note()` 用它代替实测帧时，让 Node/浏览器套件能确定性地
     * 把控制器推过预算（与 `MotionQuality.forceMovingGpuMs` 同一约定）。
     */
    forceFrameMs: number | null = null;

    private _active = false;
    private _coarseness = 0;
    private _ema = 0;
    private _lastStepAt = 0;
    /** 上一次浏览收敛到的档位（暖启动用；0 = 没有记忆）。 */
    private _memory = 0;

    /** 当前粗化档位：0 = 全分辨率，k = 粗 k 档。 */
    get coarseness() {
        return this._coarseness;
    }

    /** 平滑后的帧时（ms）；0 = 还没有样本。 */
    get frameMs() {
        return this._ema;
    }

    get active() {
        return this._active;
    }

    /**
     * 把粗化档位翻译成代理层下标（代理层是 coarsest-first：`lodAssets[0]` 最粗）。
     *
     * @param levelCount - 该 splat 的代理层数（0 = 没有代理层）。
     * @returns -1（全分辨率）… levelCount-1（最粗的代理层）。
     */
    levelFor(levelCount: number): number {
        if (!this._active || !this.enabled) return -1;
        const n = Math.max(0, levelCount | 0);
        if (n === 0) return -1;
        const c = Math.min(this._coarseness, n);
        return c <= 0 ? -1 : Math.max(0, n - c);
    }

    /**
     * 进入/退出浏览态。进入时按上次的收敛档位暖启动（否则每次进入都要重新爬一遍坡，
     * 前几秒就是用户看到的卡顿）；退出时档位归零 —— 编辑态永远全分辨率。
     */
    setActive(active: boolean) {
        const next = !!active;
        if (next === this._active) return;
        this._active = next;
        this._ema = 0;
        this._lastStepAt = 0;
        if (next) {
            this._coarseness = this._memory;
        } else {
            this._memory = this._coarseness;
            this._coarseness = 0;
        }
    }

    /**
     * 喂一帧。
     *
     * @param frameMs - 本帧的 rAF 帧间隔（ms）；null / 越界值会被忽略。
     * @param levelCount - 当前可用的代理层数（决定档位上限）。
     * @param now - `performance.now()`。
     * @returns true 表示档位在本帧发生了变化。
     */
    note(frameMs: number | null, levelCount: number, now: number): boolean {
        if (!this.enabled || !this._active) {
            return false;
        }

        const raw = this.forceFrameMs ?? frameMs;
        if (raw !== null && Number.isFinite(raw) && raw >= SAMPLE_MIN_MS && raw <= SAMPLE_MAX_MS) {
            this._ema = this._ema === 0 ? raw : this._ema + (raw - this._ema) * EMA_ALPHA;
        }
        if (this._ema === 0) return false;
        if (now - this._lastStepAt < STEP_MS) return false;
        this._lastStepAt = now;

        const n = Math.max(0, levelCount | 0);
        const ratio = this._ema / this.targetMs;
        const prev = this._coarseness;
        if (ratio > OVER_RATIO) {
            this._coarseness = Math.min(n, this._coarseness + 1);
        } else if (ratio < UNDER_RATIO) {
            this._coarseness = Math.max(0, this._coarseness - 1);
        }
        if (this._coarseness !== prev) {
            this._memory = this._coarseness;
            return true;
        }
        return false;
    }

    reset() {
        this._coarseness = 0;
        this._ema = 0;
        this._lastStepAt = 0;
        this._memory = 0;
    }
}

export { BrowseBudget };
