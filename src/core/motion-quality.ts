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

    private _level = 0;
    private _engaged = false;
    private _autoEngaged = false;
    private _lastStepAt = 0;

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
            return previousEngaged !== this._engaged || previousLevel !== this._level;
        }

        this._engaged = true;
        const maxLevel = this.levels.length - 1;

        if (movingGpuMs !== null && now - this._lastStepAt >= this.stepMs) {
            this._lastStepAt = now;
            const ratio = movingGpuMs / this.budgetMs;
            if (ratio > 1.05) {
                // too slow even degraded: one step coarser
                this._level = Math.min(maxLevel, this._level + 1);
            } else if (ratio < 0.9) {
                // comfortably inside budget: one step finer (a slow reaction is intentional — the
                // reports lag the frame they measure, so stepping every report overshoots)
                this._level = Math.max(0, this._level - 1);
            }
        }

        return previousEngaged !== this._engaged || previousLevel !== this._level;
    }

    reset() {
        this._level = 0;
        this._engaged = false;
        this._autoEngaged = false;
        this._lastStepAt = 0;
    }
}

export { MotionQuality };
export type { QualityLevel };
