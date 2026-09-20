import type { GraphicsDevice } from 'playcanvas';

// Per-frame GPU time, measured with the engine's timestamp queries, kept as a small rolling window
// split by "camera moving / idle".
//
// Why this exists: the whole question of whether this app is GPU-bound or sort/upload-bound on a
// 20M-point model cannot be answered from frame gaps alone (a 16.7 ms rAF gap says nothing about
// where the time went). The engine already has the machinery — `device.gpuProfiler` collects
// timestamp queries around every named render pass and reports the frame span — but nothing in this
// codebase ever consumed it (`grep gpuProfiler src/` found no consumer before this file).
//
// How the report arrives (engine 2.21.3, verified against the source, not assumed):
//   - `WebgpuGpuProfiler.request()` resolves its query set asynchronously and then calls
//     `this.report(renderVersion, timings, frameTime)`
//     (node_modules/playcanvas/build/playcanvas/src/platform/graphics/webgpu/webgpu-gpu-profiler.js:24-32);
//     the WebGL2 profiler does the same from its poll (…/webgl/webgl-gpu-profiler.js:96).
//   - The frame span lands in `gpuProfiler._frameTime`, but the report callback carries the
//     `renderVersion` the timings belong to, which the `_frameTime` field does NOT once it is
//     overwritten. So the report is wrapped (same trick as SuperSplat 3.3.0,
//     ss330/src/scene.ts:286-295) to attribute each span to the frame that produced it.
//   - Attribution matters because the span is what the interaction-time quality drop steers by: a
//     moving frame's span adjusts the degradation level, an idle frame's span decides whether
//     degradation is worth engaging at all (`autoEngageMs` upstream, scene.ts:136, :688).
//
// Cost: enabling the profiler makes the engine resolve a timestamp query set and map a staging
// buffer every frame, so it is NOT free and stays off by default. Consumers turn it on only while
// they need it (measurement probes, or the adaptive quality controller while interacting).

type GpuFrameSample = {
    version: number;
    gpuMs: number;
    moving: boolean;
};

type GpuSpanStats = {
    count: number;
    p50: number | null;
    p95: number | null;
    max: number | null;
};

const _spanStats = (values: number[]): GpuSpanStats => {
    if (values.length === 0) {
        return { count: 0, p50: null, p95: null, max: null };
    }
    const sorted = values.slice().sort((a, b) => a - b);
    const pick = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    return {
        count: sorted.length,
        p50: Math.round(pick(0.5) * 100) / 100,
        p95: Math.round(pick(0.95) * 100) / 100,
        max: Math.round(sorted[sorted.length - 1] * 100) / 100
    };
};

class GpuFrameTiming {
    /** the adapter/driver exposes timestamp queries (the engine checks this too) */
    readonly supported: boolean;

    /** samples kept; ~2 s at 60 fps */
    window = 120;

    /**
     * GPU span (ms) of the most recent frame tagged idle / moving, or null when none has arrived.
     * Kept as plain fields (not derived from `stats()`) so a per-frame consumer does not allocate
     * and sort the whole window 60 times a second.
     */
    lastSettledGpuMs: number | null = null;
    lastMovingGpuMs: number | null = null;

    /**
     * Peak GPU span over the recent settled frames (see `settledPeakWindow`).
     *
     * Why a peak and not the last sample: this app renders on demand, so an idle scene produces
     * almost no frames — and the few it does produce can be no-op frames that time at ~0.08 ms even
     * while the scene itself costs 70 ms to draw. Taking the last settled sample therefore disarms
     * the adaptive policy the moment the user stops moving (measured: the A/B run reported
     * `lastSettledGpuMs = 0.075` and never engaged). The peak over a short window answers the real
     * question — "can a settled frame of this scene be expensive?" — and it decays as genuinely fast
     * frames replace it.
     */
    settledSpanPeak: number | null = null;

    /** how many recent settled samples the peak is taken over */
    settledPeakWindow = 30;

    /**
     * A measurement consumer (probe, regression suite, A/B run) wants the profiler on regardless of
     * the adaptive policy's own decision, so that "policy off" can still be measured. Set by the
     * caller; `setEnabled(false)` is then ignored.
     */
    forceEnabled = false;

    private readonly _device: GraphicsDevice;
    private _enabled = false;
    private readonly _samples: GpuFrameSample[] = [];
    private readonly _modes = new Map<number, boolean>();
    private readonly _settledRecent: number[] = [];
    private _reports = 0;
    private _nullReports = 0;

    constructor(device: GraphicsDevice) {
        this._device = device;
        this.supported = !!(device as any).supportsTimestampQuery;

        const profiler = (device as any).gpuProfiler;
        if (profiler && !profiler.__splatRoomTiming) {
            const originalReport = profiler.report.bind(profiler);
            profiler.report = (renderVersion: number, timings: number[] | null, frameTime?: number) => {
                originalReport(renderVersion, timings, frameTime);
                this._onReport(renderVersion, timings, frameTime);
            };
            profiler.__splatRoomTiming = true;
        }
    }

    get enabled() {
        return this._enabled;
    }

    /**
     * Turn the engine's GPU profiler on/off. Takes effect on the next frame (the engine applies it
     * in `frameStart()`), and is a no-op when the adapter has no timestamp queries.
     */
    setEnabled(value: boolean) {
        const next = (value || this.forceEnabled) && this.supported;
        if (next === this._enabled) {
            return;
        }
        this._enabled = next;
        const profiler = (this._device as any).gpuProfiler;
        if (profiler) {
            profiler.enabled = next;
        }
        if (!next) {
            this._modes.clear();
        }
    }

    /**
     * Label the frame being rendered right now. Called once per rendered frame by Scene; the label
     * is matched to the async report by render version.
     *
     * Note the map is deliberately NOT pruned here. Reports resolve one to two frames later than the
     * frame they measure, so pruning "anything older than the frame being rendered" would delete a
     * label before its report arrives — every frame would then be attributed to `false`. That bug was
     * in the first version of this file and showed up as "all frames idle" in a rotating measurement.
     * Labels are dropped when their report lands instead (see _onReport).
     */
    noteFrame(moving: boolean) {
        if (!this._enabled) {
            return;
        }
        const version = (this._device as any).renderVersion as number;
        if (typeof version !== 'number') {
            return;
        }
        this._modes.set(version, moving);
        // safety valve: if reports stop arriving (profiler switched off mid-flight, context loss)
        // the map would otherwise hold one entry per frame forever
        if (this._modes.size > 64) {
            const oldest = Math.min(...this._modes.keys());
            this._modes.delete(oldest);
        }
    }

    private _onReport(renderVersion: number, timings: number[] | null, frameTime?: number) {
        if (!this._enabled) {
            return;
        }
        // read the label BEFORE pruning, then drop this frame's label and any older one: reports
        // resolve in order, so a still-pending older version means its report was discarded
        const mode = this._modes.has(renderVersion) ?
            this._modes.get(renderVersion) :
            this._lastModeBefore(renderVersion);
        for (const key of this._modes.keys()) {
            if (key <= renderVersion) {
                this._modes.delete(key);
            }
        }
        if (!timings || timings.length === 0) {
            this._nullReports++;
            return;
        }
        const gpuMs = typeof frameTime === 'number' ? frameTime : timings.reduce((sum, t) => sum + t, 0);
        this._reports++;
        const moving = !!mode;
        if (moving) {
            this.lastMovingGpuMs = gpuMs;
        } else {
            this.lastSettledGpuMs = gpuMs;
            this._settledRecent.push(gpuMs);
            if (this._settledRecent.length > this.settledPeakWindow) {
                this._settledRecent.shift();
            }
            this.settledSpanPeak = this._settledRecent.length ? Math.max(...this._settledRecent) : null;
        }
        this._samples.push({
            version: renderVersion,
            gpuMs,
            moving
        });
        if (this._samples.length > this.window) {
            this._samples.splice(0, this._samples.length - this.window);
        }
    }

    /** Fallback label for a report whose frame label was already evicted by the safety valve. */
    private _lastModeBefore(version: number) {
        let best = -1;
        let mode = false;
        for (const [key, value] of this._modes) {
            if (key < version && key > best) {
                best = key;
                mode = value;
            }
        }
        return mode;
    }

    /** Rolling stats, split by motion state. */
    stats() {
        const moving = this._samples.filter(s => s.moving).map(s => s.gpuMs);
        const idle = this._samples.filter(s => !s.moving).map(s => s.gpuMs);
        const last = this._samples.length ? this._samples[this._samples.length - 1] : null;
        return {
            supported: this.supported,
            enabled: this._enabled,
            reports: this._reports,
            nullReports: this._nullReports,
            samples: this._samples.length,
            lastGpuMs: last ? Math.round(last.gpuMs * 100) / 100 : null,
            lastWasMoving: last ? last.moving : null,
            idle: _spanStats(idle),
            moving: _spanStats(moving),
            // every kept sample, for probes that want the raw series
            series: this._samples.map(s => [s.version, Math.round(s.gpuMs * 100) / 100, s.moving ? 1 : 0])
        };
    }

    reset() {
        this._samples.length = 0;
        this._modes.clear();
        this._settledRecent.length = 0;
        this.settledSpanPeak = null;
        this.lastSettledGpuMs = null;
        this.lastMovingGpuMs = null;
        this._reports = 0;
        this._nullReports = 0;
    }
}

export { GpuFrameTiming };
export type { GpuFrameSample, GpuSpanStats };
