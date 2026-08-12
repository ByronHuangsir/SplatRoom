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
        // Fire animCamera.update so the scene's virtual animation camera
        // entity uses direct setLocalPosition + lookAt transform.
        // This bypasses the viewport camera's orbit state machine entirely,
        // eliminating the lossy azim/elev round-trip that causes perspective
        // glitches, direction reversal, and NaN when position approaches
        // target during spline interpolation.
        _pos.set(value[0], value[1], value[2]);
        _target.set(value[3], value[4], value[5]);

        // Guard against corrupt data: skip non-finite or degenerate poses
        if (![_pos.x, _pos.y, _pos.z, _target.x, _target.y, _target.z, value[6]].every(Number.isFinite)) {
            return;
        }
        const dx = _target.x - _pos.x;
        const dy = _target.y - _pos.y;
        const dz = _target.z - _pos.z;
        if (dx * dx + dy * dy + dz * dz < 1e-12) {
            return;
        }

        this.events.fire('animCamera.update', {
            position: _pos.clone(),
            target: _target.clone(),
            fov: value[6]
        });
    }
}

export { CameraAnimTrack };
