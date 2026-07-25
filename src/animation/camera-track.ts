import { Vec3 } from 'playcanvas';
import { Events } from '../events';
import { AnimationTrackBase } from './animation-track-base';

const _pos = new Vec3();
const _target = new Vec3();

/**
 * Camera animation track.
 * Captures: camera position (xyz) + target (xyz) + fov = 7 dimensions.
 * This track replaces the old CameraAnimTrack for non-legacy camera animation.
 */
class CameraAnimTrack extends AnimationTrackBase {
    constructor(events: Events) {
        super(events, 'camera', 'Camera');
    }

    captureValue(): number[] {
        const pose = this.events.invoke('camera.getPose');
        if (!pose) return [];
        return [
            pose.position.x, pose.position.y, pose.position.z,
            pose.target.x, pose.target.y, pose.target.z,
            pose.fov ?? 60
        ];
    }

    applyValue(value: number[]): void {
        // NOTE: We no longer auto-move the main camera during playback/scrub.
        // The PiP window independently renders the animation camera view.
        // Main camera only moves when user explicitly double-clicks a keyframe.
        // This event is kept for potential future use but currently does nothing.
        _pos.set(value[0], value[1], value[2]);
        _target.set(value[3], value[4], value[5]);
        // Intentionally do NOT fire 'camera.setPose' here.
    }
}

export { CameraAnimTrack };
