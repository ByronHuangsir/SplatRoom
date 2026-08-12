/**
 * Unified keyframe data model for the multi-track animation system.
 * Each track stores an ordered list of keyframes with frame numbers and
 * multi-dimensional values. Easing controls are stored per-keyframe.
 */
interface Keyframe {
    /** Timeline frame number */
    frame: number;
    /** Multi-dimensional value (e.g. [x,y,z] for position) */
    value: number[];
    /** Easing function on entry to this keyframe */
    easingIn: EasingType;
    /** Easing function on exit from this keyframe */
    easingOut: EasingType;
    /** Ease-in tension (0=linear, 1=full easing, >1=overshoot) */
    easingInTension: number;
    /** Ease-out tension (0=linear, 1=full easing, >1=overshoot) */
    easingOutTension: number;
    /** Whether this keyframe is a hidden control point (not shown in timeline) */
    isControlPoint?: boolean;
}

type EasingType = 'linear' | 'ease' | 'ease-in' | 'ease-out';

interface TrackData {
    /** Ordered array of keyframes */
    keys: Keyframe[];
    /** Number of dimensions for this track type */
    dim: number;
}

/** All animation data stored for a project */
interface AnimationData {
    tracks: Record<string, TrackData>;
}

/** Well-known track identifiers */
const enum TrackId {
    Camera = 'camera'
}

/** Dimension counts for each track type */
const TRACK_DIMS: Record<string, number> = {
    [TrackId.Camera]: 7     // pos.xyz + target.xyz + fov
};

const EMPTY_KEYFRAMES: readonly Keyframe[] = Object.freeze([]);

export { Keyframe, EasingType, TrackData, AnimationData, TrackId, TRACK_DIMS, EMPTY_KEYFRAMES };
