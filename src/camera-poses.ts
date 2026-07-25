import { Vec3 } from 'playcanvas';

import { CubicSpline } from './anim/spline';
import { AnimTrack } from './anim-track';
import { Events } from './events';

const DEG_TO_RAD = Math.PI / 180;

type Pose = {
    name: string,
    frame: number,
    position: Vec3,
    target: Vec3,
    fov?: number
};

/**
 * Convert camera position+target to azim/elev/distance.
 * Matches the reverse of Camera.calcForwardVec and Camera.setPose.
 */
function posTargetToAzimElev(pos: Vec3, target: Vec3): { azim: number; elev: number; dist: number } {
    const dx = target.x - pos.x;
    const dy = target.y - pos.y;
    const dz = target.z - pos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 1e-10) return { azim: 0, elev: 0, dist: 0 };
    // Match Camera.setPose: azim = atan2(-dx/l, -dz/l), elev = asin(dy/l)
    const azim = Math.atan2(-dx, -dz) * 180 / Math.PI;
    const elev = Math.asin(dy / dist) * 180 / Math.PI;
    return { azim, elev, dist };
}

/**
 * Convert azim/elev/distance + position back to a target point.
 * Matches Camera.calcForwardVec.
 */
function azimElevToTarget(pos: Vec3, azimDeg: number, elevDeg: number, dist: number): Vec3 {
    const ex = elevDeg * DEG_TO_RAD;
    const ey = azimDeg * DEG_TO_RAD;
    const s1 = Math.sin(-ex);
    const c1 = Math.cos(-ex);
    const s2 = Math.sin(-ey);
    const c2 = Math.cos(-ey);
    // forward = (-c1*s2, s1, c1*c2)  — matches Camera.calcForwardVec
    const fx = -c1 * s2;
    const fy = s1;
    const fz = c1 * c2;
    return new Vec3(pos.x + fx * dist, pos.y + fy * dist, pos.z + fz * dist);
}

/**
 * Camera animation track that manages camera keyframes and interpolation.
 * Implements AnimTrack interface so it can be used with the timeline system.
 *
 * Fully self-contained: subscribes to timeline events internally for
 * evaluation and spline rebuilding.
 */
class CameraAnimTrack implements AnimTrack {
    private poses: Pose[] = [];
    private events: Events;
    private onTimelineChange: ((frame: number) => void) | null = null;

    constructor(events: Events) {
        this.events = events;

        // Evaluate on timeline playback and scrub
        events.on('timeline.time', (time: number) => {
            this.evaluate(time);
        });

        events.on('timeline.frame', (frame: number) => {
            this.evaluate(frame);
        });

        // Rebuild spline when timeline parameters change
        events.on('timeline.frames', () => {
            this.rebuildSpline();
        });

        events.on('timeline.smoothness', () => {
            this.rebuildSpline();
        });

        events.on('timeline.loop', () => {
            this.rebuildSpline();
        });

        // Clear track when scene is cleared
        events.on('scene.clear', () => {
            this.clear();
        });
    }

    get keys(): readonly number[] {
        return this.poses.map(p => p.frame);
    }

    get userKeys(): readonly number[] {
        return this.keys;  // no control points for pose tracks
    }

    addKey(frame: number): boolean {
        const pose = this.events.invoke('camera.getPose');
        if (!pose) return false;

        const existingIndex = this.poses.findIndex(p => p.frame === frame);

        const newPose: Pose = {
            name: `camera_${this.poses.length}`,
            frame,
            position: new Vec3(pose.position.x, pose.position.y, pose.position.z),
            target: new Vec3(pose.target.x, pose.target.y, pose.target.z),
            fov: pose.fov
        };

        if (existingIndex === -1) {
            this.poses.push(newPose);
            this.rebuildSpline();
            this.events.fire('track.keyAdded', frame);
        } else {
            this.poses[existingIndex] = newPose;
            this.rebuildSpline();
            this.events.fire('track.keyUpdated', frame);
        }
        return true;
    }

    removeKey(frame: number): boolean {
        const index = this.poses.findIndex(p => p.frame === frame);
        if (index === -1) return false;
        this.poses.splice(index, 1);
        this.rebuildSpline();
        this.events.fire('track.keyRemoved', frame);
        return true;
    }

    moveKey(fromFrame: number, toFrame: number): boolean {
        if (fromFrame === toFrame) return false;

        const index = this.poses.findIndex(p => p.frame === fromFrame);
        if (index === -1) return false;

        // Remove any existing pose at the target frame
        const toIndex = this.poses.findIndex(p => p.frame === toFrame);
        if (toIndex !== -1) {
            this.poses.splice(toIndex, 1);
        }

        // Update the frame (re-find index since splice may have shifted it)
        const movedIndex = this.poses.findIndex(p => p.frame === fromFrame);
        this.poses[movedIndex].frame = toFrame;
        this.rebuildSpline();
        this.events.fire('track.keyMoved', fromFrame, toFrame);
        return true;
    }

    copyKey(fromFrame: number, toFrame: number): boolean {
        if (fromFrame === toFrame) return false;

        const source = this.poses.find(p => p.frame === fromFrame);
        if (!source) return false;

        // Remove any existing pose at the target frame
        const toIndex = this.poses.findIndex(p => p.frame === toFrame);
        if (toIndex !== -1) {
            this.poses.splice(toIndex, 1);
        }

        this.poses.push({
            name: `camera_${this.poses.length}`,
            frame: toFrame,
            position: source.position.clone(),
            target: source.target.clone(),
            fov: source.fov
        });

        this.rebuildSpline();
        this.events.fire('track.keyAdded', toFrame);
        return true;
    }

    setEasing(_frame: number, _easingIn: string, _easingOut: string): boolean {
        // Legacy camera poses track does not support per-keyframe easing
        return false;
    }

    setTension(_frame: number, _inTension: number, _outTension: number): boolean {
        // Legacy camera poses track does not support per-keyframe tension
        return false;
    }

    evaluate(frame: number): void {
        this.onTimelineChange?.(frame);
    }

    clear(): void {
        this.poses.length = 0;
        this.onTimelineChange = null;
        this.events.fire('track.keysCleared');
    }

    snapshot(): Pose[] {
        return this.poses.map(p => ({
            name: p.name,
            frame: p.frame,
            position: p.position.clone(),
            target: p.target.clone(),
            fov: p.fov
        }));
    }

    restore(snapshot: unknown): void {
        this.poses = (snapshot as Pose[]).map(p => ({
            name: p.name,
            frame: p.frame,
            position: p.position.clone(),
            target: p.target.clone(),
            fov: p.fov
        }));
        this.rebuildSpline();
        this.events.fire('track.keysLoaded');
    }

    /**
     * Add a pose directly (used for deserialization and legacy import).
     */
    addPose(pose: Pose): void {
        if (pose.frame === undefined) {
            return;
        }

        pose.fov ??= this.events.invoke('camera.fov') ?? 60;

        const idx = this.poses.findIndex(p => p.frame === pose.frame);
        if (idx !== -1) {
            this.poses[idx] = pose;
            this.rebuildSpline();
            this.events.fire('track.keyUpdated', pose.frame);
        } else {
            this.poses.push(pose);
            this.rebuildSpline();
            this.events.fire('track.keyAdded', pose.frame);
        }
    }

    /**
     * Get all poses (used for serialization and legacy consumers).
     */
    getPoses(): readonly Pose[] {
        return this.poses;
    }

    /**
     * Load poses from serialized data.
     */
    loadPoses(posesData: Pose[]): void {
        this.poses.length = 0;
        posesData.forEach((pose) => {
            this.poses.push(pose);
        });
        this.rebuildSpline();
        this.events.fire('track.keysLoaded');
    }

    private rebuildSpline(): void {
        const duration = this.events.invoke('timeline.frames');
        const smoothness = this.events.invoke('timeline.smoothness');
        const loop = this.events.invoke('timeline.loop');

        const orderedPoses = this.poses.slice()
        .filter(a => a.frame < duration)
        .sort((a, b) => a.frame - b.frame);

        const times = orderedPoses.map(p => p.frame);

        // Convert each keyframe from [position + target + fov] to
        // [position + azim + elev + distance + fov] so that the camera
        // orientation is interpolated directly on its own spline channels.
        // This avoids the jerky direction changes that result from
        // independently interpolating position and target as raw xyz.
        const convertedPoints: number[] = [];
        for (let i = 0; i < orderedPoses.length; ++i) {
            const p = orderedPoses[i];
            const ae = posTargetToAzimElev(p.position, p.target);
            convertedPoints.push(
                p.position.x, p.position.y, p.position.z,
                ae.azim, ae.elev, ae.dist,
                p.fov
            );
        }

        // Unwrap azimuth angles so the spline interpolates the shortest
        // path (e.g. 350°→10° is -10° rotation, not -340° through 180°).
        for (let i = 1; i < orderedPoses.length; i++) {
            const prev = convertedPoints[(i - 1) * 7 + 3];
            const curr = convertedPoints[i * 7 + 3];
            let diff = curr - prev;
            while (diff > 180) diff -= 360;
            while (diff < -180) diff += 360;
            convertedPoints[i * 7 + 3] = prev + diff;
        }

        if (orderedPoses.length > 1) {
            const spline = loop ?
                CubicSpline.fromPointsLooping(duration, times, convertedPoints, smoothness) :
                CubicSpline.fromPoints(times, convertedPoints, smoothness);

            // Arc-length table is built from channels 0-2 (position xyz)
            // — correct because uniform speed should be spatial, not
            // affected by orientation or fov changes.
            spline.buildArcLengthTable(100);

            const result: number[] = [];
            const pose = { position: new Vec3(), target: new Vec3(), fov: 0 };

            this.onTimelineChange = (frame: number) => {
                // Per-segment arc-length: uniform speed within each keyframe interval
                const { times: stimes } = spline;
                const n = stimes.length;
                let seg = 0;
                while (seg < n - 2 && frame >= stimes[seg + 1]) seg++;
                const segStart = stimes[seg];
                const segEnd = stimes[seg + 1];
                const segRange = segEnd - segStart;
                if (segRange > 1e-6) {
                    const localF = (frame - segStart) / segRange;
                    spline.evaluateBySegmentArcLength(seg, Math.max(0, Math.min(1, localF)), result);
                } else {
                    spline.evaluate(frame, result);
                }
                // Reconstruct position + target from the spline output
                pose.position.set(result[0], result[1], result[2]);
                pose.target.copy(azimElevToTarget(
                    pose.position,
                    result[3],  // azim (smoothly interpolated)
                    Math.max(-89.9, Math.min(89.9, result[4])),  // elev (clamped)
                    Math.max(0.001, result[5])                    // distance
                ));
                pose.fov = result[6];
                this.events.fire('camera.setPose', pose, 0);
            };
        } else if (orderedPoses.length === 1) {
            // a single key can't form a spline; hold its pose at every frame
            const p = orderedPoses[0];
            const pose = { position: p.position.clone(), target: p.target.clone(), fov: p.fov };

            this.onTimelineChange = () => {
                this.events.fire('camera.setPose', pose, 0);
            };
        } else {
            this.onTimelineChange = null;
        }

        // re-evaluate at the current frame so the camera updates immediately
        this.evaluate(this.events.invoke('timeline.frame'));
    }
}

/**
 * Register the camera animation track and expose it via events.
 * The track is fully self-contained (subscribes to timeline events internally),
 * so this function only needs to create it, expose it, and handle serialization.
 */
const registerCameraPosesEvents = (events: Events) => {
    const track = new CameraAnimTrack(events);

    // Expose the camera animation track
    events.function('camera.animTrack', () => {
        return track;
    });

    // Legacy support: expose poses
    events.function('camera.poses', () => {
        return track.getPoses();
    });

    // Legacy support: add pose directly
    events.on('camera.addPose', (pose: Pose) => {
        track.addPose(pose);
    });

    // Serialization

    events.function('docSerialize.poseSets', (): any[] => {
        const pack3 = (v: Vec3) => [v.x, v.y, v.z];
        const poses = track.getPoses();

        if (poses.length === 0) {
            return [];
        }

        return [{
            name: 'set0',
            poses: poses.map((pose) => {
                return {
                    name: pose.name,
                    frame: pose.frame,
                    position: pack3(pose.position),
                    target: pack3(pose.target),
                    fov: pose.fov
                };
            })
        }];
    });

    events.function('docDeserialize.poseSets', (poseSets: any[], documentCameraFov?: number) => {
        if (!poseSets || poseSets.length === 0) {
            return;
        }

        const fps = events.invoke('timeline.frameRate');

        const defaultFov = documentCameraFov ?? events.invoke('camera.fov') ?? 60;

        const loadedPoses: Pose[] = poseSets[0].poses.map((docPose: any, index: number) => {
            return {
                name: docPose.name,
                frame: docPose.frame ?? (index * fps),
                position: new Vec3(docPose.position),
                target: new Vec3(docPose.target),
                fov: docPose.fov ?? defaultFov
            };
        });

        track.loadPoses(loadedPoses);
    });
};

export { registerCameraPosesEvents, CameraAnimTrack, Pose };
