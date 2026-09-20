import { Vec3 } from 'playcanvas';

// "Is the user moving the camera right now?" — one place that answers it, because two consumers
// need it: the GPU frame timing labels each frame moving/idle, and the interaction-time quality
// drop (see motion-quality.ts) only engages while moving.
//
// Why a pose comparison and not just the existing `camera.userDragging` flag: that flag is synced
// per frame from the pointer controller (src/camera/controllers.ts), so it covers dragging, inertia
// and the wheel, but it deliberately does NOT cover auto-rotate, timeline/camera-path tweens or a
// scripted `camera.setPose` — all of which move the camera just as much. Comparing the pose catches
// every cause; the flag additionally catches "pointer is down but nothing moved yet".
//
// The settle window matters as much as the motion test: a single frame without movement is not
// "stopped" (a slow drag has hiccup frames), so `moving` stays true until the pose has been still
// for `settleMs`. That deadline is what the quality restore and the forced sort-at-rest hang off.
//
// Upstream note: SuperSplat 3.3.0 solves the same problem with `Scene.movingRender` driven from its
// pointer/keyboard input plus a `pendingResolve` flag for the one clean settled frame
// (ss330/src/scene.ts:105-110, :552-553). This tracker is the equivalent signal for this codebase.

type Vec3Like = { x: number; y: number; z: number };

// squared distance / squared direction delta above which a frame counts as movement. The sorter
// fallback in src/splat/splat.ts uses the same 1e-12 for "anything moved at all"; keeping it
// identical means the two mechanisms agree frame for frame.
const MOVE_EPSILON = 1e-12;

class CameraMotion {
    /** how long the pose must hold still before the camera counts as stopped (ms) */
    settleMs = 200;

    /**
     * Clock, injectable so a headless test can drive time. Reads `performance.now()` by default.
     *
     * `moving` must NOT be derived from the timestamp of the last fed frame: this app renders on
     * demand, so after the camera stops no further frame arrives, and a stored "now" would freeze the
     * state at "still moving" — leaving the viewport at degraded resolution until the next unrelated
     * frame. Reading the clock at call time is what lets the settle deadline actually pass.
     */
    now: () => number = () => performance.now();

    private readonly _lastPos = new Vec3();
    private readonly _lastDir = new Vec3();
    private _hasLast = false;
    private _lastMoveAt = 0;
    private _movedThisFrame = false;
    private _dragging = false;
    private _now = 0;

    /**
     * Feed one frame.
     *
     * @param pos - camera world position this frame.
     * @param dir - camera forward direction this frame.
     * @param dragging - `camera.userDragging` (pointer/inertia/wheel), if known.
     * @param now - `performance.now()` for this frame.
     * @returns whether the pose changed on this frame.
     */
    update(pos: Vec3Like, dir: Vec3Like, dragging: boolean, now: number): boolean {
        this._now = now;
        this._dragging = dragging;

        let moved = false;
        if (this._hasLast) {
            const dx = pos.x - this._lastPos.x;
            const dy = pos.y - this._lastPos.y;
            const dz = pos.z - this._lastPos.z;
            const ddx = dir.x - this._lastDir.x;
            const ddy = dir.y - this._lastDir.y;
            const ddz = dir.z - this._lastDir.z;
            moved = dx * dx + dy * dy + dz * dz > MOVE_EPSILON ||
                ddx * ddx + ddy * ddy + ddz * ddz > MOVE_EPSILON;
        }

        this._lastPos.set(pos.x, pos.y, pos.z);
        this._lastDir.set(dir.x, dir.y, dir.z);
        this._hasLast = true;

        if (moved) {
            this._lastMoveAt = now;
        }
        this._movedThisFrame = moved;
        return moved;
    }

    /** pose changed on the frame just fed */
    get movedThisFrame() {
        return this._movedThisFrame;
    }

    /** timestamp of the last frame whose pose changed */
    get lastMoveAt() {
        return this._lastMoveAt;
    }

    /**
     * True while the camera should be treated as in motion: the pointer is held down, or the pose
     * changed within the last `settleMs`.
     *
     * Note this does not consult `movedThisFrame` as a latch. This app renders on demand, so if
     * nothing requests a frame the tracker is simply not fed — a latched "moved on the last fed frame"
     * would then read as "still moving" forever. The timestamp is the only state that ages correctly
     * without new frames.
     */
    get moving() {
        if (this._dragging) {
            return true;
        }
        const now = this.now();
        return this._lastMoveAt !== 0 && now - this._lastMoveAt < this.settleMs;
    }

    /** True when the pose has been still for the whole settle window and the pointer is up. */
    get settled() {
        return !this.moving;
    }

    reset() {
        this._hasLast = false;
        this._lastMoveAt = 0;
        this._movedThisFrame = false;
        this._dragging = false;
    }
}

export { CameraMotion };
export type { Vec3Like };
