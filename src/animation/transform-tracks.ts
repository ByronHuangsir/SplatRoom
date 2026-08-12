import { Quat, Vec3 } from 'playcanvas';
import { Events } from '../events';
import { Splat } from '../splat';
import { AnimationTrackBase } from './animation-track-base';

/**
 * Position animation track (x, y, z).
 * Captures the splat entity's local position.
 */
class PositionAnimTrack extends AnimationTrackBase {
    constructor(events: Events) {
        super(events, 'position', 'Position');
    }

    captureValue(): number[] {
        const splat = this.events.invoke('selection') as Splat;
        if (!splat?.entity) return [];
        const pos = splat.entity.getLocalPosition();
        return [pos.x, pos.y, pos.z];
    }

    applyValue(value: number[]): void {
        const splat = this.events.invoke('selection') as Splat;
        if (!splat?.entity) return;
        splat.move(
            new Vec3(value[0], value[1], value[2]),
            splat.entity.getLocalRotation(),
            splat.entity.getLocalScale()
        );
    }
}

/**
 * Rotation animation track (euler x, y, z in degrees).
 */
class RotationAnimTrack extends AnimationTrackBase {
    constructor(events: Events) {
        super(events, 'rotation', 'Rotation');
    }

    captureValue(): number[] {
        const splat = this.events.invoke('selection') as Splat;
        if (!splat?.entity) return [];
        const euler = splat.entity.getLocalEulerAngles();
        return [euler.x, euler.y, euler.z];
    }

    applyValue(value: number[]): void {
        const splat = this.events.invoke('selection') as Splat;
        if (!splat?.entity) return;
        const pos = splat.entity.getLocalPosition();
        const scale = splat.entity.getLocalScale();
        splat.entity.setLocalEulerAngles(value[0], value[1], value[2]);
    }
}

/**
 * Scale animation track (sx, sy, sz).
 */
class ScaleAnimTrack extends AnimationTrackBase {
    constructor(events: Events) {
        super(events, 'scale', 'Scale');
    }

    captureValue(): number[] {
        const splat = this.events.invoke('selection') as Splat;
        if (!splat?.entity) return [];
        const scale = splat.entity.getLocalScale();
        return [scale.x, scale.y, scale.z];
    }

    applyValue(value: number[]): void {
        const splat = this.events.invoke('selection') as Splat;
        if (!splat?.entity) return;
        splat.entity.setLocalScale(value[0], value[1], value[2]);
    }
}

export { PositionAnimTrack, RotationAnimTrack, ScaleAnimTrack };
