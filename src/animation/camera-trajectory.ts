import { Color, Vec3 } from 'playcanvas';
import { Events } from '../events';
import { AnimationController } from './animation-controller';
import { TrackId } from './animation-data';

const _color = new Color();

/**
 * Camera trajectory and speed visualizer.
 * Renders the camera path as colored line segments in 3D space,
 * with keyframe markers and speed-dependent coloring.
 *
 * Red = fast, Green = slow.
 */
class CameraTrajectory {
    private events: Events;
    private _visible = false;
    private _segments: { a: Vec3; b: Vec3; color: string }[] = [];
    private _keyframePoints: { pos: Vec3; frame: number; inTan: Vec3; outTan: Vec3; inTension: number; outTension: number; inHandlePos: Vec3; outHandlePos: Vec3 }[] = [];

    /** Callback to provide segments and points (with tangent handles) for rendering */
    trajectoryProvider: ((
        segments: { a: Vec3; b: Vec3; color: string }[],
        points: { pos: Vec3; frame: number; inTan: Vec3; outTan: Vec3; inTension: number; outTension: number; inHandlePos: Vec3; outHandlePos: Vec3 }[]
    ) => void) | null = null;

    constructor(events: Events) {
        this.events = events;

        events.on('timeline.frames', () => this.update());
        events.on('timeline.smoothness', () => this.update());
        events.on('timeline.loop', () => this.update());
        events.on('track.keyAdded', () => this.update());
        events.on('track.keyRemoved', () => this.update());
        events.on('track.keyMoved', () => this.update());
        events.on('track.keysLoaded', () => this.update());
        events.on('track.keysCleared', () => this.update());

        events.on('statusBar.panelChanged', (panel: string | null) => {
            this._visible = panel === 'timeline';
            if (this._visible) {
                this.update();
            } else if (this.trajectoryProvider) {
                this.trajectoryProvider([], []);
            }
        });

        events.on('scene.clear', () => {
            this._segments = [];
            this._keyframePoints = [];
            if (this.trajectoryProvider) {
                this.trajectoryProvider([], []);
            }
        });
    }

    get visible(): boolean {
        return this._visible;
    }

    /**
     * Rebuild trajectory segments and keyframe points from the camera track spline.
     */
    update(): void {
        if (!this._visible) return;

        const controller = this.events.invoke('animation.controller') as AnimationController;
        const track = controller?.getTrack(TrackId.Camera);
        if (!track) return;

        const keys = track.keys;
        const totalFrames = this.events.invoke('timeline.frames') as number;

        // Gather keyframe positions and frames
        const sortedKeys = [...keys].filter(f => f < totalFrames).sort((a, b) => a - b);
        const kfPositions: Vec3[] = [];
        const kfFrames: number[] = [];

        for (const f of sortedKeys) {
            const val = (track as any).getValueAt?.(f) as number[] | null;
            if (val) {
                kfPositions.push(new Vec3(val[0], val[1], val[2]));
                kfFrames.push(f);
            }
        }

        // Not enough keyframes — just show them as dots
        if (kfPositions.length < 2) {
            this._segments = [];
            this._keyframePoints = kfPositions.map((pos, i) => ({
                pos, frame: kfFrames[i],
                inTan: new Vec3(), outTan: new Vec3(),
                inTension: 1, outTension: 1,
                inHandlePos: pos.clone(), outHandlePos: pos.clone()
            }));
            if (this.trajectoryProvider) {
                this.trajectoryProvider(this._segments, this._keyframePoints);
            }
            return;
        }

        this._buildLinearPath(kfPositions, kfFrames, track, totalFrames);
    }

    /**
     * Build path using the linear spline sampling.
     */
    private _buildLinearPath(
        kfPositions: Vec3[],
        kfFrames: number[],
        track: any,
        totalFrames: number
    ): void {
        const sampleRate = Math.max(1, Math.floor(totalFrames / 200));
        const samples: Vec3[] = [];

        for (let f = 0; f < totalFrames; f += sampleRate) {
            const val = (track as any).getValueAt?.(f) as number[] | null;
            if (val) {
                samples.push(new Vec3(val[0], val[1], val[2]));
            }
        }

        // Ensure last frame is included
        const lastVal = (track as any).getValueAt?.(totalFrames - 1) as number[] | null;
        if (lastVal && samples.length > 0) {
            const lastSample = samples[samples.length - 1];
            const lastPos = new Vec3(lastVal[0], lastVal[1], lastVal[2]);
            if (lastPos.distance(lastSample) > 0.001) {
                samples.push(lastPos);
            }
        }

        // Build keyframe points with direction-aligned tangents
        this._keyframePoints = [];
        for (let i = 0; i < kfPositions.length; i++) {
            const pos = kfPositions[i];
            const frame = kfFrames[i];
            const inTan = new Vec3();
            const outTan = new Vec3();

            if (i > 0) {
                const prev = kfPositions[i - 1];
                inTan.set(pos.x - prev.x, pos.y - prev.y, pos.z - prev.z);
                const len = inTan.length();
                if (len > 0.001) inTan.mulScalar(1 / len);
            }
            if (i < kfPositions.length - 1) {
                const next = kfPositions[i + 1];
                outTan.set(next.x - pos.x, next.y - pos.y, next.z - pos.z);
                const len = outTan.length();
                if (len > 0.001) outTan.mulScalar(1 / len);
            }

            if (inTan.length() < 0.001 && outTan.length() > 0.001) {
                inTan.copy(outTan).mulScalar(-1);
            }
            if (outTan.length() < 0.001 && inTan.length() > 0.001) {
                outTan.copy(inTan).mulScalar(-1);
            }

            const kfData = (track as any).getKeyframeData?.(frame);
            this._keyframePoints.push({
                pos: pos.clone(),
                frame,
                inTan: inTan.clone(),
                outTan: outTan.clone(),
                inTension: kfData?.easingInTension ?? 1,
                outTension: kfData?.easingOutTension ?? 1,
                inHandlePos: pos.clone(),
                outHandlePos: pos.clone()
            });
        }

        this._buildSpeedSegments(samples, sampleRate);
        this._flushProvider();
    }

    /**
     * Build colored segments from sample points with speed-based coloring.
     */
    private _buildSpeedSegments(samples: Vec3[], sampleRate: number): void {
        this._segments = [];

        if (samples.length < 2) return;

        let maxSpeed = 0;
        const speeds: number[] = [];

        for (let i = 1; i < samples.length; i++) {
            const dist = samples[i].distance(samples[i - 1]);
            const speed = dist / sampleRate;
            speeds.push(speed);
            if (speed > maxSpeed) maxSpeed = speed;
        }

        for (let i = 1; i < samples.length; i++) {
            const speed = speeds[i - 1];
            const t = maxSpeed > 0 ? Math.min(1, speed / maxSpeed) : 0;
            const r = t;
            const g = 1 - t;
            _color.set(r, g, 0, 1);

            this._segments.push({
                a: samples[i - 1].clone(),
                b: samples[i].clone(),
                color: _color.toString(false)
            });
        }
    }

    /**
     * Send updated data to the renderer callback.
     */
    private _flushProvider(): void {
        if (this.trajectoryProvider) {
            this.trajectoryProvider(this._segments, this._keyframePoints);
        }
    }
}

export { CameraTrajectory };
