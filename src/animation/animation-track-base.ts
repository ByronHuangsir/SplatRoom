import { CubicSpline } from '../anim/spline';
import { AnimTrack } from '../anim-track';
import { Events } from '../events';
import { Keyframe, TrackData, EasingType, TRACK_DIMS } from './animation-data';

/**
 * Base class for all animation tracks.
 * Manages keyframes, builds CubicSplines for interpolation, and
 * evaluates values at any frame.
 *
 * Subclasses implement `captureValue()` to snapshot their target's
 * current state and `applyValue()` to apply interpolated values.
 */
abstract class AnimationTrackBase implements AnimTrack {
    protected events: Events;
    protected trackId: string;
    protected keyframes: Keyframe[] = [];
    protected spline: CubicSpline | null = null;
    protected onEvaluate: ((frame: number) => void) | null = null;

    /** Track label for UI display */
    readonly label: string;
    /** Number of dimensions */
    readonly dim: number;

    constructor(events: Events, trackId: string, label: string) {
        this.events = events;
        this.trackId = trackId;
        this.label = label;
        this.dim = TRACK_DIMS[trackId] || 1;

        // Subscribe to timeline parameter changes for spline rebuild
        events.on('timeline.frames', () => this.rebuild());
        events.on('timeline.smoothness', () => this.rebuild());
        events.on('timeline.loop', () => this.rebuild());

        // Evaluate on playback and scrub
        events.on('timeline.time', (time: number) => this.evaluate(time));
        events.on('timeline.frame', (frame: number) => this.evaluate(frame));

        // Clear on scene reset
        events.on('scene.clear', () => this.clear());
    }

    get keys(): readonly number[] {
        return this.keyframes.map(k => k.frame);
    }

    /** User-visible keyframes (excludes control points) */
    get userKeys(): readonly number[] {
        return this.keyframes.filter(k => !k.isControlPoint).map(k => k.frame);
    }

    /**
     * Get full keyframe data at a frame (for UI queries like tension).
     */
    getKeyframeData(frame: number): Keyframe | null {
        return this.keyframes.find(k => k.frame === frame) ?? null;
    }

    /**
     * Capture the current state from the target as a value array.
     * Subclasses override this.
     */
    abstract captureValue(): number[];

    /**
     * Apply a value array to the target.
     * Subclasses override this.
     */
    abstract applyValue(value: number[]): void;

    addKey(frame: number): boolean {
        const value = this.captureValue();
        if (!value || value.length === 0) return false;

        const existingIndex = this.keyframes.findIndex(k => k.frame === frame);
        const kf: Keyframe = {
            frame,
            value,
            easingIn: 'linear',
            easingOut: 'linear',
            easingInTension: 1,
            easingOutTension: 1
        };

        if (existingIndex === -1) {
            this.keyframes.push(kf);
            this.rebuild();
            this.events.fire('track.keyAdded', frame, this.trackId);
        } else {
            this.keyframes[existingIndex] = kf;
            this.rebuild();
            this.events.fire('track.keyUpdated', frame, this.trackId);
        }
        return true;
    }

    removeKey(frame: number): boolean {
        const index = this.keyframes.findIndex(k => k.frame === frame);
        if (index === -1) return false;
        this.keyframes.splice(index, 1);
        this.rebuild();
        this.events.fire('track.keyRemoved', frame, this.trackId);
        return true;
    }

    moveKey(fromFrame: number, toFrame: number): boolean {
        if (fromFrame === toFrame) return false;
        const index = this.keyframes.findIndex(k => k.frame === fromFrame);
        if (index === -1) return false;

        // Remove existing at target
        const toIndex = this.keyframes.findIndex(k => k.frame === toFrame);
        if (toIndex !== -1) {
            this.keyframes.splice(toIndex, 1);
        }

        // Re-find after possible splice
        const movedIndex = this.keyframes.findIndex(k => k.frame === fromFrame);
        this.keyframes[movedIndex].frame = toFrame;
        this.rebuild();
        this.events.fire('track.keyMoved', fromFrame, toFrame, this.trackId);
        return true;
    }

    copyKey(fromFrame: number, toFrame: number): boolean {
        if (fromFrame === toFrame) return false;
        const source = this.keyframes.find(k => k.frame === fromFrame);
        if (!source) return false;

        const toIndex = this.keyframes.findIndex(k => k.frame === toFrame);
        if (toIndex !== -1) {
            this.keyframes.splice(toIndex, 1);
        }

        this.keyframes.push({
            frame: toFrame,
            value: [...source.value],
            easingIn: source.easingIn,
            easingOut: source.easingOut,
            easingInTension: source.easingInTension ?? 1,
            easingOutTension: source.easingOutTension ?? 1
        });

        this.rebuild();
        this.events.fire('track.keyAdded', toFrame, this.trackId);
        return true;
    }

    /**
     * Set easing for a keyframe.
     */
    setEasing(frame: number, easingIn: EasingType, easingOut: EasingType): boolean {
        const kf = this.keyframes.find(k => k.frame === frame);
        if (!kf) return false;
        kf.easingIn = easingIn;
        kf.easingOut = easingOut;
        // Rebuild spline to apply easing curve
        this.rebuild();
        return true;
    }

    /**
     * Set easing tensions for a keyframe.
     * Tension=0 makes it linear; tension=1 is full easing; tension>1 overshoots.
     */
    setTension(frame: number, inTension: number, outTension: number): boolean {
        const kf = this.keyframes.find(k => k.frame === frame);
        if (!kf) return false;
        kf.easingInTension = inTension;
        kf.easingOutTension = outTension;
        this.rebuild();
        this.events.fire('track.keyUpdated', frame, this.trackId);
        return true;
    }

    /**
     * Get value at a specific frame (for preview queries).
     */
    getValueAt(frame: number): number[] | null {
        if (this.keyframes.length === 0) return null;

        // Single keyframe: return its value for any frame (no interpolation possible)
        if (this.keyframes.length === 1) {
            return [...this.keyframes[0].value];
        }

        if (!this.spline) return null;
        const result: number[] = [];

        // Use per-segment arc-length reparameterization for uniform speed
        // within each keyframe interval — speed is constant per segment, but may
        // change at keyframe boundaries.
        const { times } = this.spline;
        const n = times.length;
        let seg = 0;
        while (seg < n - 2 && frame >= times[seg + 1]) seg++;
        const segStart = times[seg];
        const segEnd = times[seg + 1];
        const segRange = segEnd - segStart;
        if (segRange > 1e-6) {
            const localF = (frame - segStart) / segRange;
            this.spline.evaluateBySegmentArcLength(seg, Math.max(0, Math.min(1, localF)), result);
        } else {
            this.spline.evaluate(frame, result);
        }
        return result;
    }

    evaluate(frame: number): void {
        this.onEvaluate?.(frame);
    }

    clear(): void {
        this.keyframes.length = 0;
        this.spline = null;
        this.onEvaluate = null;
        this.events.fire('track.keysCleared', this.trackId);
    }

    snapshot(): unknown {
        return this.keyframes.map(k => ({
            frame: k.frame,
            value: [...k.value],
            easingIn: k.easingIn,
            easingOut: k.easingOut,
            easingInTension: k.easingInTension,
            easingOutTension: k.easingOutTension
        }));
    }

    restore(snapshot: unknown): void {
        this.keyframes = (snapshot as any[]).map(k => ({
            frame: k.frame,
            value: [...k.value],
            easingIn: k.easingIn || 'linear',
            easingOut: k.easingOut || 'linear',
            easingInTension: k.easingInTension ?? 1,
            easingOutTension: k.easingOutTension ?? 1
        }));
        this.rebuild();
        this.events.fire('track.keysLoaded', this.trackId);
    }

    /**
     * Load keyframes from serialized data.
     */
    loadKeys(keysData: Keyframe[]): void {
        this.keyframes = keysData.map(k => ({
            frame: k.frame,
            value: [...k.value],
            easingIn: k.easingIn || 'linear',
            easingOut: k.easingOut || 'linear',
            easingInTension: k.easingInTension ?? 1,
            easingOutTension: k.easingOutTension ?? 1
        }));
        this.rebuild();
        this.events.fire('track.keysLoaded', this.trackId);
    }

    /**
     * Get serializable track data.
     */
    serialize(): TrackData {
        return {
            keys: this.keyframes.map(k => ({
                frame: k.frame,
                value: [...k.value],
                easingIn: k.easingIn,
                easingOut: k.easingOut,
                easingInTension: k.easingInTension,
                easingOutTension: k.easingOutTension
            })),
            dim: this.dim
        };
    }

    /**
     * Check if any keyframe has non-linear easing.
     */
    protected hasEasingData(): boolean {
        return this.keyframes.some(k => k.easingIn !== 'linear' || k.easingOut !== 'linear');
    }

    /**
     * Rebuild the internal CubicSpline from keyframes.
     */
    protected rebuild(skipEvaluate?: boolean): void {
        const duration = this.events.invoke('timeline.frames');
        const smoothness = this.events.invoke('timeline.smoothness');
        const loop = this.events.invoke('timeline.loop');

        let orderedKfs = this.keyframes
            .filter(k => k.frame < duration)
            .sort((a, b) => a.frame - b.frame);

        // Fallback: if duration filtering leaves < 2 keyframes but we have >= 2
        // total keyframes, use all keyframes. This prevents spline destruction
        // when a single-frame PLY (frameCount=1) temporarily sets timeline
        // duration to 1, filtering out camera animation keyframes.
        const usedFallback = orderedKfs.length < 2 && this.keyframes.length >= 2;
        if (usedFallback) {
            orderedKfs = this.keyframes.slice().sort((a, b) => a.frame - b.frame);
        }

        if (orderedKfs.length > 1) {
            const times = orderedKfs.map(k => k.frame);
            const points: number[] = [];
            for (const k of orderedKfs) {
                points.push(...k.value);
            }

            // Build per-keyframe tangent scales from easing data × global smoothness
            const useEasing = this.hasEasingData() && smoothness > 0;
            let spline: CubicSpline;

            if (useEasing) {
                const inScales: number[] = [];
                const outScales: number[] = [];
                for (let i = 0; i < orderedKfs.length; i++) {
                    const kf = orderedKfs[i];
                    // easingIn controls incoming tangent:
                    //   'ease-in' or 'ease' → smooth entry, scaled by tension
                    const inSmooth = (kf.easingIn === 'ease' || kf.easingIn === 'ease-in') ? 1 : 0;
                    const inTension = (kf.easingInTension !== undefined ? kf.easingInTension : 1);
                    // easingOut controls outgoing tangent:
                    //   'ease-out' or 'ease' → smooth exit, scaled by tension
                    const outSmooth = (kf.easingOut === 'ease' || kf.easingOut === 'ease-out') ? 1 : 0;
                    const outTension = (kf.easingOutTension !== undefined ? kf.easingOutTension : 1);
                    inScales.push(smoothness * inSmooth * inTension);
                    outScales.push(smoothness * outSmooth * outTension);
                }
                spline = CubicSpline.fromPointsWithEasing(times, points, inScales, outScales);
            } else {
                spline = loop
                    ? CubicSpline.fromPointsLooping(duration, times, points, smoothness)
                    : CubicSpline.fromPoints(times, points, smoothness);
            }

            // Build arc-length table for uniform-speed playback
            spline.buildArcLengthTable(100);

            const result: number[] = [];
            this.spline = spline;
            this.onEvaluate = (frame: number) => {
                // Per-segment arc-length: find the segment and map frame → local arc fraction
                const { times } = spline;
                const n = times.length;
                let seg = 0;
                while (seg < n - 2 && frame >= times[seg + 1]) seg++;
                const segStart = times[seg];
                const segEnd = times[seg + 1];
                const segRange = segEnd - segStart;
                if (segRange > 1e-6) {
                    const localF = (frame - segStart) / segRange;
                    spline.evaluateBySegmentArcLength(seg, Math.max(0, Math.min(1, localF)), result);
                } else {
                    spline.evaluate(frame, result);
                }
                this.applyValue(result);
            };
        } else if (orderedKfs.length === 1) {
            this.spline = null;
            const val = [...orderedKfs[0].value];
            this.onEvaluate = () => {
                this.applyValue(val);
            };
        } else {
            this.spline = null;
            this.onEvaluate = null;
        }

        // Re-evaluate at current frame (skip when editing keyframes
        // to avoid jumping the main camera — e.g. control point drag)
        if (!skipEvaluate) {
            this.evaluate(this.events.invoke('timeline.frame'));
        }
    }
}

export { AnimationTrackBase };
