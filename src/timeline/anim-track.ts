/**
 * Interface for animation tracks that can be attached to animatable targets.
 * Each track owns its keyframes and handles capture, interpolation, and evaluation.
 */
interface AnimTrack {
    /** Array of frame numbers where keyframes exist */
    readonly keys: readonly number[];
    /** Array of frame numbers for user-visible keyframes (excludes control points) */
    readonly userKeys: readonly number[];

    /**
     * Add a keyframe at the specified frame, capturing current state.
     * If a key already exists at this frame, it will be updated.
     * @returns true if the track was modified, false if the operation was a no-op.
     */
    addKey(frame: number): boolean;

    /**
     * Remove the keyframe at the specified frame.
     * @returns true if the track was modified, false if the operation was a no-op.
     */
    removeKey(frame: number): boolean;

    /**
     * Move a keyframe from one frame to another.
     * @returns true if the track was modified, false if the operation was a no-op.
     */
    moveKey(fromFrame: number, toFrame: number): boolean;

    /**
     * Copy a keyframe from one frame to another.
     * The original keyframe remains in place.
     * @returns true if the track was modified, false if the operation was a no-op.
     */
    copyKey(fromFrame: number, toFrame: number): boolean;

    /**
     * Set easing type for a keyframe.
     * @returns true if the keyframe was found and updated.
     */
    setEasing(frame: number, easingIn: string, easingOut: string): boolean;

    /**
     * Set easing tensions for a keyframe.
     * Tension=0 makes it linear; 1=full easing; >1 overshoots.
     * @returns true if the keyframe was found and updated.
     */
    setTension(frame: number, inTension: number, outTension: number): boolean;

    /**
     * Clear all keyframes.
     */
    clear(): void;

    /**
     * Get full keyframe data at the specified frame (for UI queries).
     * Returns null if no keyframe exists at that frame.
     */
    getKeyframeData?(frame: number): any;

    /**
     * Return a deep copy of the track's internal state (for undo snapshots).
     */
    snapshot(): unknown;

    /**
     * Replace the track's internal state with a previously captured snapshot
     * and fire appropriate change events.
     */
    restore(snapshot: unknown): void;
}

export { AnimTrack };
