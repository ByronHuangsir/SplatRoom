import { AnimTrack } from './anim-track';
import { AnimTrackEditOp } from './edit-ops';
import { Events } from './events';
import { AnimationController } from './animation/animation-controller';

/**
 * Manages the active animation track and provides undo-wrapped
 * key operations. Routes to the AnimationController for track
 * resolution. All mutations are undoable.
 */
const registerTrackManagerEvents = (events: Events) => {
    // Get the currently active animation track from the controller.
    const getActiveTrack = (): AnimTrack | null => {
        const controller = events.invoke('animation.controller') as AnimationController;
        return controller?.activeTrack ?? null;
    };

    // Get active track with explicit ID
    const getTrackById = (trackId: string): AnimTrack | null => {
        const controller = events.invoke('animation.controller') as AnimationController;
        return controller?.getTrack(trackId) ?? null;
    };

    // Helper: execute an edit on a track wrapped in undo.
    const trackEdit = (name: string, track: AnimTrack, editFn: (track: AnimTrack) => boolean) => {
        if (!track) return;
        const before = track.snapshot();
        if (!editFn(track)) return;
        const after = track.snapshot();
        events.fire('edit.add', new AnimTrackEditOp(name, track, before, after), true);
    };

    // Get keys from active track
    events.function('track.keys', () => {
        const track = getActiveTrack();
        return track ? track.keys : [];
    });

    // Get keys from a specific track
    events.function('track.keysFor', (trackId: string) => {
        const track = getTrackById(trackId);
        return track ? track.keys : [];
    });

    // Get keyframe data at a specific frame (for easing info)
    events.function('track.keyframeAt', (frame: number, trackId?: string) => {
        const id = trackId ?? (events.invoke('track.activeId') as string) ?? 'camera';
        const track = getTrackById(id) as any;
        if (!track?.keyframes) return null;
        return track.keyframes.find((k: any) => k.frame === frame) ?? null;
    });

    // Get current easing for the active track at the current frame
    events.function('track.easingAt', (frame?: number) => {
        const f = frame ?? events.invoke('timeline.frame');
        const activeId = (events.invoke('track.activeId') as string) ?? 'camera';
        const track = getTrackById(activeId) as any;
        if (!track?.keyframes) return null;
        const kf = track.keyframes.find((k: any) => k.frame === f);
        return kf ? { easingIn: kf.easingIn, easingOut: kf.easingOut, easingInTension: kf.easingInTension ?? 1, easingOutTension: kf.easingOutTension ?? 1 } : null;
    });

    // Add key to active track (or specified track)
    events.on('track.addKey', (data?: { trackId?: string; frame?: number } | number) => {
        const frame = typeof data === 'number' ? data :
            (data && typeof data === 'object' ? data.frame : undefined);
        const trackId = (data && typeof data === 'object' ? data.trackId : undefined);

        const keyFrame = frame ?? events.invoke('timeline.frame');
        const track = trackId ? getTrackById(trackId) : getActiveTrack();
        if (!track) return;
        trackEdit('addKey', track, t => t.addKey(keyFrame));
    });

    // Add key to specific track ID directly
    events.on('track.addKeyTo', (trackId: string, frame?: number) => {
        const keyFrame = frame ?? events.invoke('timeline.frame');
        const track = getTrackById(trackId);
        if (!track) return;
        trackEdit('addKey', track, t => t.addKey(keyFrame));
    });

    // Remove key from active track
    events.on('track.removeKey', (frame?: number) => {
        const keyFrame = frame ?? events.invoke('timeline.frame');
        const track = getActiveTrack();
        if (!track) return;
        trackEdit('removeKey', track, t => t.removeKey(keyFrame));
    });

    // Move key in active track
    events.on('track.moveKey', (fromFrame: number, toFrame: number) => {
        const track = getActiveTrack();
        if (!track) return;
        trackEdit('moveKey', track, t => t.moveKey(fromFrame, toFrame));
    });

    // Copy key in active track
    events.on('track.copyKey', (fromFrame: number, toFrame: number) => {
        const track = getActiveTrack();
        if (!track) return;
        trackEdit('copyKey', track, t => t.copyKey(fromFrame, toFrame));
    });

    // Set easing for a keyframe in active track
    events.on('track.setEasing', (frame: number, easingIn: string, easingOut: string) => {
        const activeId = (events.invoke('track.activeId') as string) ?? 'camera';
        const track = getTrackById(activeId);
        if (!track) return;
        trackEdit('setEasing', track, t => t.setEasing(frame, easingIn as any, easingOut as any));
    });

    // Set easing tension for a keyframe in active track
    events.on('track.setTension', (frame: number, inTension: number, outTension: number) => {
        const activeId = (events.invoke('track.activeId') as string) ?? 'camera';
        const track = getTrackById(activeId);
        if (!track) return;
        trackEdit('setTension', track, t => t.setTension(frame, inTension, outTension));
    });
};

export { registerTrackManagerEvents };
