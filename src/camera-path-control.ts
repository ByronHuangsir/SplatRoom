import {
    Ray,
    Vec3
} from 'playcanvas';

import { Element, ElementType } from './element';
import { CameraPath3D } from './camera-path-3d';
import { AnimationController } from './animation/animation-controller';
import { TrackId } from './animation/animation-data';

// Temp vectors (module-scope to avoid per-frame allocations)
const _ray = new Ray();
const _ptOnPlane = new Vec3();

// Double-click threshold in milliseconds
const DBL_CLICK_MS = 350;
// Minimum movement before a click becomes a drag (0 = immediate)
const DRAG_THRESHOLD = 0;

/**
 * CameraPathControl adds interactive control points and keyframe markers
 * on the 3D camera path.
 *
 * - Drag cyan diamonds to reshape the path (creates hidden control-point keyframes)
 * - Drag white keyframe boxes to reposition keyframes
 * - Double-click cyan diamond → promote to visible keyframe
 * - Double-click keyframe box → jump camera to that view
 *
 * Uses capture-phase event listeners to intercept pointer events
 * before the camera controller during active operations.
 */
class CameraPathControl extends Element {
    // Reference to the path visualization
    private _path3D: CameraPath3D | null = null;
    private _container: HTMLElement | null = null;
    private _canvas: HTMLCanvasElement | null = null;

    // Toggle: when false, control-point / keyframe-marker interaction
    // is completely disabled — mouse events pass through to the normal
    // camera controller.
    private _interactionEnabled = false;

    // Hover state
    private _hoveredCPIndex = -1;
    private _hoveredKFIndex = -1;
    private _hoveredConeIndex = -1;
    private _hoveredSphereIndex = -1;

    // Drag state
    private _draggingType: 'cp' | 'kf' | 'cone' | 'sphere' | null = null;
    private _draggingIndex = -1;
    private _dragStartPos: Vec3 | null = null;
    private _dragPlaneNormal: Vec3 | null = null;
    private _dragMoved = false;
    private _dragStartScreen: { x: number; y: number } | null = null;
    // Sphere drag: reference FOV and distance from camera to sphere (captured at drag start)
    private _sphereDragRefFov = 60;
    private _sphereDragRefDist = 1;

    // Double-click detection
    private _lastClickTarget: 'cp' | 'kf' | 'cone' | 'sphere' | null = null;
    private _lastClickIndex = -1;
    private _lastClickTime = 0;

    // Bound event handlers (for add/remove listener identity)
    private _boundDown: (e: PointerEvent) => void;
    private _boundMove: (e: PointerEvent) => void;
    private _boundUp: (e: PointerEvent) => void;

    constructor() {
        super(ElementType.debug);
        this._boundDown = this._onPointerDown.bind(this);
        this._boundMove = this._onPointerMove.bind(this);
        this._boundUp = this._onPointerUp.bind(this);
    }

    add() {
        this._path3D = this.scene.cameraPath3D;
        this._canvas = this.scene.canvas;
        this._container = document.getElementById('canvas-container');

        if (this._container) {
            this._container.addEventListener('pointerdown', this._boundDown, true);
            this._container.addEventListener('pointermove', this._boundMove, true);
            this._container.addEventListener('pointerup', this._boundUp, true);
        }
    }

    remove() {
        if (this._container) {
            this._container.removeEventListener('pointerdown', this._boundDown, true);
            this._container.removeEventListener('pointermove', this._boundMove, true);
            this._container.removeEventListener('pointerup', this._boundUp, true);
        }
        this._resetState();
        this._path3D = null;
        this._container = null;
        this._canvas = null;
    }

    // ---- Helpers ----

    private _isActive(): boolean {
        if (!this._interactionEnabled) return false;
        if (!this._path3D) return false;
        const timelineOpen = this.scene.events.invoke('statusBar.panel') === 'timeline';
        // Active if there are any control points OR keyframe markers
        return timelineOpen && (
            this._path3D.controlPoints.length > 0 ||
            this._path3D.kfMarkers.length > 0
        );
    }

    /** Enable or disable control-point and keyframe-marker interaction.
     *  When disabled, all mouse events pass through to the camera controller. */
    setPathControlEnabled(enabled: boolean) {
        if (this._interactionEnabled === enabled) return;
        this._interactionEnabled = enabled;
        // Reset hover / drag state immediately so stale highlights are cleared
        if (!enabled) {
            this._resetState();
        }
    }

    private _getRay(e: PointerEvent): Ray | null {
        if (!this._canvas) return null;
        const rect = this._canvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        if (px < 0 || px > rect.width || py < 0 || py > rect.height) return null;

        this.scene.camera.getRay(px, py, _ray);
        return _ray;
    }

    private _rayToPointDist(pos: Vec3, ray: Ray): number {
        _ptOnPlane.sub2(pos, ray.origin);
        const t = _ptOnPlane.dot(ray.direction);
        if (t <= 0) return pos.distance(ray.origin);
        _ptOnPlane.copy(ray.origin).addScaled(ray.direction, t);
        return pos.distance(_ptOnPlane);
    }

    private _resetState() {
        if (this._hoveredCPIndex >= 0 && this._path3D) {
            this._path3D.updateControlPointColor(this._hoveredCPIndex, 'normal');
        }
        if (this._hoveredKFIndex >= 0 && this._path3D) {
            this._path3D.updateKeyframeMarkerColor(this._hoveredKFIndex, 'normal');
        }
        if (this._hoveredConeIndex >= 0 && this._path3D) {
            this._path3D.updateConeColor(this._hoveredConeIndex, 'normal');
        }
        if (this._hoveredSphereIndex >= 0 && this._path3D) {
            this._path3D.updateSphereColor(this._hoveredSphereIndex, 'normal');
        }
        // Exit solo drag mode to restore all elements
        if (this._path3D) this._path3D.setSoloDrag(null, -1);
        this._hoveredCPIndex = -1;
        this._hoveredKFIndex = -1;
        this._hoveredConeIndex = -1;
        this._hoveredSphereIndex = -1;
        this._draggingType = null;
        this._draggingIndex = -1;
        this._dragStartPos = null;
        this._dragPlaneNormal = null;
        this._dragMoved = false;
        this._dragStartScreen = null;
        if (this._container) this._container.style.cursor = '';
    }

    /** Start dragging a target (CP, KF, cone, or sphere) */
    private _startDrag(type: 'cp' | 'kf' | 'cone' | 'sphere', index: number, e: PointerEvent) {
        e.stopPropagation();
        e.preventDefault();

        let positions: Vec3[];
        if (type === 'cone') {
            positions = this._path3D!.kfConePositions;
        } else if (type === 'sphere') {
            positions = this._path3D!.kfSpherePositions;
        } else {
            positions = type === 'cp' ? this._path3D!.controlPoints : this._path3D!.kfMarkers;
        }
        if (index < 0 || index >= positions.length) return;

        // Solo drag: hide all other control points, keyframes, cones, and spheres
        this._path3D!.setSoloDrag(type, index);

        this._draggingType = type;
        this._draggingIndex = index;
        this._dragMoved = false;
        this._dragStartScreen = { x: e.clientX, y: e.clientY };
        this._dragStartPos = positions[index].clone();

        // Sync timeline on KF / cone / sphere click
        if (type === 'kf' || type === 'cone' || type === 'sphere') {
            const frame = this._path3D!.kfMarkerFrames[index];
            this.scene.events.fire('timeline.frame', frame);

            if (type === 'sphere') {
                // Capture reference FOV and sphere distance for FOV computation
                const controller = this.scene.events.invoke('animation.controller') as AnimationController | undefined;
                const track = controller?.getTrack(TrackId.Camera);
                if (track) {
                    const keyframes = (track as any).keyframes as any[];
                    const kf = keyframes.find((k: any) => k.frame === frame && !k.isControlPoint);
                    if (kf && kf.value.length >= 7) {
                        this._sphereDragRefFov = kf.value[6];
                        const kfPos = this._path3D!.kfMarkers[index];
                        const spherePos = positions[index];
                        this._sphereDragRefDist = Math.max(kfPos.distance(spherePos), 0.001);
                    }
                }
            }
        }

        // Drag plane normal: direction from drag point to camera.
        // This ensures the plane always faces the camera and the ray
        // intersection parameter t is always positive, even for
        // keyframes at extreme positions far from the camera.
        const cameraPos = this.scene.camera.mainCamera.getPosition();
        this._dragPlaneNormal = new Vec3().sub2(cameraPos, this._dragStartPos);
        if (this._dragPlaneNormal.length() < 0.001) {
            // Fallback: camera forward if drag point is at camera position
            const fwd = this.scene.camera.mainCamera.forward;
            this._dragPlaneNormal.set(fwd.x, fwd.y, fwd.z);
        }
        this._dragPlaneNormal.normalize();

        if (type === 'cp') {
            this._path3D!.updateControlPointColor(index, 'drag');
        } else if (type === 'kf') {
            this._path3D!.updateKeyframeMarkerColor(index, 'drag');
        } else if (type === 'cone') {
            this._path3D!.updateConeColor(index, 'drag');
        } else {
            this._path3D!.updateSphereColor(index, 'drag');
        }
        if (this._container) this._container.style.cursor = 'grabbing';
    }

    /** Compute intersection of pointer ray with the drag plane */
    private _intersectDragPlane(e: PointerEvent): Vec3 | null {
        const ray = this._getRay(e);
        if (!ray || !this._dragPlaneNormal || !this._dragStartPos) return null;

        const denom = ray.direction.dot(this._dragPlaneNormal);
        if (Math.abs(denom) < 0.0001) return null;

        _ptOnPlane.sub2(this._dragStartPos, ray.origin);
        const t = _ptOnPlane.dot(this._dragPlaneNormal) / denom;
        if (t <= 0) return null;

        return new Vec3().copy(ray.origin).addScaled(ray.direction, t);
    }

    // ---- Pointer event handlers ----

    private _onPointerMove(e: PointerEvent) {
        if (!this._isActive() || !this._path3D) return;

        // ---- Active drag ----
        if (this._draggingType) {
            const pt = this._intersectDragPlane(e);
            if (!pt) return;

            // Check if moved enough to qualify as a drag
            if (!this._dragMoved && this._dragStartScreen) {
                const dx = e.clientX - this._dragStartScreen.x;
                const dy = e.clientY - this._dragStartScreen.y;
                if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
                this._dragMoved = true;
            }

            e.stopPropagation();
            e.preventDefault();

            if (this._draggingType === 'cp') {
                this._updateControlPointRealtime(this._draggingIndex, pt);
            } else if (this._draggingType === 'cone') {
                this._updateConeRealtime(this._draggingIndex, pt);
            } else if (this._draggingType === 'sphere') {
                this._updateSphereRealtime(this._draggingIndex, pt);
            } else {
                this._updateKeyframeRealtime(this._draggingIndex, pt);
            }
            return;
        }

        // ---- Hover detection (CPs, KFs, cones, and spheres) ----
        const ray = this._getRay(e);
        if (!ray) return;

        // Compute world-size-per-screen-pixel at unit distance.
        // Each control point uses its own camera distance for accurate hit area.
        const canvasH = this.scene.canvas.height;
        const fovRad = (this.scene.camera.fov ?? 60) * Math.PI / 180;
        const worldPerPixel = (2 * Math.tan(fovRad / 2)) / Math.max(canvasH, 1);
        const cameraPos = this.scene.camera.mainCamera.getPosition();

        // Hit radius in screen pixels — generous so the user doesn't need
        // pixel-precise aim. CP diamonds are 8px visually; 16px hit radius
        // gives a comfortable 2x margin around the visual shape.
        const HIT_PX_CP = 16;
        const HIT_PX_KF = 18;
        const HIT_PX_CONE = 16;
        const HIT_PX_SPHERE = 16;

        // Find closest CP (per-point hit radius based on actual camera distance)
        let cpIdx = -1;
        let cpDist = Infinity;
        for (let i = 0; i < this._path3D.controlPoints.length; i++) {
            const pt = this._path3D.controlPoints[i];
            const dist = HIT_PX_CP * worldPerPixel * Math.max(pt.distance(cameraPos), 0.001);
            const d = this._rayToPointDist(pt, ray);
            if (d < dist && d < cpDist) { cpDist = d; cpIdx = i; }
        }

        // Find closest KF
        let kfIdx = -1;
        let kfDist = Infinity;
        for (let i = 0; i < this._path3D.kfMarkers.length; i++) {
            const pt = this._path3D.kfMarkers[i];
            const dist = HIT_PX_KF * worldPerPixel * Math.max(pt.distance(cameraPos), 0.001);
            const d = this._rayToPointDist(pt, ray);
            if (d < dist && d < kfDist) { kfDist = d; kfIdx = i; }
        }

        // Find closest cone
        let coneIdx = -1;
        let coneDist = Infinity;
        for (let i = 0; i < this._path3D.kfConePositions.length; i++) {
            const pt = this._path3D.kfConePositions[i];
            const dist = HIT_PX_CONE * worldPerPixel * Math.max(pt.distance(cameraPos), 0.001);
            const d = this._rayToPointDist(pt, ray);
            if (d < dist && d < coneDist) { coneDist = d; coneIdx = i; }
        }

        // Find closest sphere
        let sphereIdx = -1;
        let sphereDist = Infinity;
        for (let i = 0; i < this._path3D.kfSpherePositions.length; i++) {
            const pt = this._path3D.kfSpherePositions[i];
            const dist = HIT_PX_SPHERE * worldPerPixel * Math.max(pt.distance(cameraPos), 0.001);
            const d = this._rayToPointDist(pt, ray);
            if (d < dist && d < sphereDist) { sphereDist = d; sphereIdx = i; }
        }

        // Hover priority: KF > CP > cone > sphere
        const hasKF = kfIdx >= 0;
        const hasCP = cpIdx >= 0;
        const hasCone = coneIdx >= 0;
        const hasSphere = sphereIdx >= 0;

        let newCP = -1;
        let newKF = -1;
        let newCone = -1;
        let newSphere = -1;

        if (hasKF) { newKF = kfIdx; }
        else if (hasCP) { newCP = cpIdx; }
        else if (hasCone) { newCone = coneIdx; }
        else if (hasSphere) { newSphere = sphereIdx; }

        // Update CP hover
        if (newCP !== this._hoveredCPIndex) {
            if (this._hoveredCPIndex >= 0) this._path3D.updateControlPointColor(this._hoveredCPIndex, 'normal');
            this._hoveredCPIndex = newCP;
            if (newCP >= 0) this._path3D.updateControlPointColor(newCP, 'hover');
        }

        // Update KF hover
        if (newKF !== this._hoveredKFIndex) {
            if (this._hoveredKFIndex >= 0) this._path3D.updateKeyframeMarkerColor(this._hoveredKFIndex, 'normal');
            this._hoveredKFIndex = newKF;
            if (newKF >= 0) this._path3D.updateKeyframeMarkerColor(newKF, 'hover');
        }

        // Update cone hover
        if (newCone !== this._hoveredConeIndex) {
            if (this._hoveredConeIndex >= 0) this._path3D.updateConeColor(this._hoveredConeIndex, 'normal');
            this._hoveredConeIndex = newCone;
            if (newCone >= 0) this._path3D.updateConeColor(newCone, 'hover');
        }

        // Update sphere hover
        if (newSphere !== this._hoveredSphereIndex) {
            if (this._hoveredSphereIndex >= 0) this._path3D.updateSphereColor(this._hoveredSphereIndex, 'normal');
            this._hoveredSphereIndex = newSphere;
            if (newSphere >= 0) this._path3D.updateSphereColor(newSphere, 'hover');
        }

        // Cursor
        if (newCP >= 0 || newKF >= 0 || newCone >= 0 || newSphere >= 0) {
            this._container!.style.cursor = 'grab';
        } else {
            this._container!.style.cursor = '';
        }
    }

    private _onPointerDown(e: PointerEvent) {
        if (!this._isActive() || !this._path3D) return;

        // Priority: KF > CP > cone > sphere
        if (this._hoveredKFIndex >= 0) {
            this._startDrag('kf', this._hoveredKFIndex, e);
        } else if (this._hoveredCPIndex >= 0) {
            this._startDrag('cp', this._hoveredCPIndex, e);
        } else if (this._hoveredConeIndex >= 0) {
            this._startDrag('cone', this._hoveredConeIndex, e);
        } else if (this._hoveredSphereIndex >= 0) {
            this._startDrag('sphere', this._hoveredSphereIndex, e);
        }
    }

    private _onPointerUp(e: PointerEvent) {
        if (!this._draggingType) return;

        e.stopPropagation();
        e.preventDefault();

        const type = this._draggingType;
        const idx = this._draggingIndex;

        if (!this._dragMoved) {
            // Quick click — check for double-click
            const now = performance.now();
            if (this._lastClickTarget === type &&
                this._lastClickIndex === idx &&
                (now - this._lastClickTime) < DBL_CLICK_MS) {
                // Double-click detected
                this._resetState();
                if (type === 'cp') {
                    this._promoteControlPoint(idx);
                } else {
                    this._jumpToKeyframe(idx);
                }
                this._lastClickTarget = null;
                this._lastClickIndex = -1;
                this._lastClickTime = 0;
                return;
            }
            this._lastClickTarget = type;
            this._lastClickIndex = idx;
            this._lastClickTime = now;
        }

        this._resetState();

        // NOTE: Drag changes are already persisted in real-time during
        // _onPointerMove via _updateControlPointRealtime / _updateKeyframeRealtime.
        // No additional track update needed on release.
    }

    // ---- Real-time spline updates during drag ----

    /** Update a control-point keyframe in real-time during drag.
     *  Modifies the track keyframes array and rebuilds the spline every frame. */
    private _updateControlPointRealtime(idx: number, newPos: Vec3) {
        const frame = this._path3D!.controlPointFrames[idx];
        const { events } = this.scene;
        const controller = events.invoke('animation.controller') as AnimationController | undefined;
        const track = controller?.getTrack(TrackId.Camera);
        if (!track) return;

        const keyframes = (track as any).keyframes as any[];
        let kf = keyframes.find((k: any) => k.frame === frame);

        // Do not overwrite user keyframes
        if (kf && !kf.isControlPoint) return;

        if (!kf) {
            // Create new control-point keyframe
            let targetX = 0, targetY = 0, targetZ = 0, fov = 60;
            const val = (track as any).getValueAt?.(frame) as number[] | null;
            if (val && val.length >= 7) {
                targetX = val[3]; targetY = val[4]; targetZ = val[5]; fov = val[6];
            }
            kf = {
                frame,
                value: [newPos.x, newPos.y, newPos.z, targetX, targetY, targetZ, fov],
                easingIn: 'linear',
                easingOut: 'linear',
                easingInTension: 1,
                easingOutTension: 1,
                isControlPoint: true
            };
            keyframes.push(kf);
        } else {
            // Preserve camera look-direction: shift target by the same delta
            // so the camera continues to face the same relative direction.
            const dx = newPos.x - kf.value[0];
            const dy = newPos.y - kf.value[1];
            const dz = newPos.z - kf.value[2];
            kf.value[0] = newPos.x;
            kf.value[1] = newPos.y;
            kf.value[2] = newPos.z;
            kf.value[3] += dx;
            kf.value[4] += dy;
            kf.value[5] += dz;
        }

        (track as any).rebuild?.(true);
        events.fire('track.keyUpdated');
        if (this._path3D) {
            this._path3D.dirty = true;
        }
        this.scene.forceRender = true;
    }

    /** Update a user keyframe position in real-time during drag.
     *  Modifies the track keyframe value and rebuilds the spline every frame. */
    private _updateKeyframeRealtime(idx: number, newPos: Vec3) {
        const frame = this._path3D!.kfMarkerFrames[idx];
        const { events } = this.scene;
        const controller = events.invoke('animation.controller') as AnimationController | undefined;
        const track = controller?.getTrack(TrackId.Camera);
        if (!track) return;

        const keyframes = (track as any).keyframes as any[];
        const kf = keyframes.find((k: any) => k.frame === frame && !k.isControlPoint);
        if (!kf || kf.value.length < 7) return;

        // Preserve camera look-direction: shift target by the same delta
        const dx = newPos.x - kf.value[0];
        const dy = newPos.y - kf.value[1];
        const dz = newPos.z - kf.value[2];
        kf.value[0] = newPos.x;
        kf.value[1] = newPos.y;
        kf.value[2] = newPos.z;
        kf.value[3] += dx;
        kf.value[4] += dy;
        kf.value[5] += dz;

        (track as any).rebuild?.(true);
        events.fire('track.keyUpdated');
        if (this._path3D) {
            this._path3D.dirty = true;
        }
        this.scene.forceRender = true;
    }

    /** Update a keyframe's cone (direction) in real-time during drag.
     *  Cone is placed near the camera (not at the target), so we compute
     *  the new target from the cone position and camera position. */
    private _updateConeRealtime(idx: number, newPos: Vec3) {
        const frame = this._path3D!.kfMarkerFrames[idx];
        const kfPos = this._path3D!.kfMarkers[idx];
        if (!this._path3D || !kfPos) return;

        // Update visual position immediately
        this._path3D.moveConePosition(idx, newPos);

        // Compute new target: target = camPos + normalize(newPos - camPos) * targetDist
        const newDir = new Vec3().sub2(newPos, kfPos);
        const newDirLen = newDir.length();
        if (newDirLen < 0.0001) return;
        newDir.normalize();
        const targetDist = this._path3D.kfTargetDistances[idx] ?? 1;
        const newTarget = new Vec3().copy(kfPos).addScaled(newDir, targetDist);

        const { events } = this.scene;
        const controller = events.invoke('animation.controller') as AnimationController | undefined;
        const track = controller?.getTrack(TrackId.Camera);
        if (!track) return;

        const keyframes = (track as any).keyframes as any[];
        const kf = keyframes.find((k: any) => k.frame === frame && !k.isControlPoint);
        if (!kf || kf.value.length < 7) return;

        // Update target position only — direction changes
        kf.value[3] = newTarget.x;
        kf.value[4] = newTarget.y;
        kf.value[5] = newTarget.z;
        // FOV unchanged!

        (track as any).rebuild?.(true);
        events.fire('track.keyUpdated');
        this._path3D.dirty = true;
        this.scene.forceRender = true;
    }

    /** Update a keyframe's sphere (focal length) in real-time during drag.
     *  Only changes FOV based on distance from camera to sphere.
     *  Camera direction stays unchanged. */
    private _updateSphereRealtime(idx: number, newPos: Vec3) {
        const frame = this._path3D!.kfMarkerFrames[idx];
        const kfPos = this._path3D!.kfMarkers[idx];
        if (!kfPos || !this._path3D) return;

        // Update visual position immediately
        this._path3D.moveSpherePosition(idx, newPos);

        const newDist = new Vec3().sub2(kfPos, newPos).length();
        const safeDist = Math.max(newDist, 0.001);

        // FOV = refFov * (refDist / newDist)
        // Closer sphere = wider FOV, farther sphere = narrower FOV
        let newFov = 60;
        if (this._sphereDragRefDist > 0.001 && safeDist > 0.001) {
            newFov = Math.max(10, Math.min(150, this._sphereDragRefFov * (this._sphereDragRefDist / safeDist)));
        }

        const { events } = this.scene;
        const controller = events.invoke('animation.controller') as AnimationController | undefined;
        const track = controller?.getTrack(TrackId.Camera);
        if (!track) return;

        const keyframes = (track as any).keyframes as any[];
        const kf = keyframes.find((k: any) => k.frame === frame && !k.isControlPoint);
        if (!kf || kf.value.length < 7) return;

        kf.value[6] = newFov;
        // Target (direction) unchanged!

        (track as any).rebuild?.(true);
        events.fire('track.keyUpdated');
        this._path3D.dirty = true;
        this.scene.forceRender = true;
    }

    // ---- Track operations ----

    /**
     * Insert a hidden control-point keyframe (not visible in timeline).
     * This shapes the spline without cluttering the timeline UI.
     */
    private _insertControlPoint(_cpIdx: number, frame: number, newPos: Vec3) {
        const { events } = this.scene;
        const controller = events.invoke('animation.controller') as AnimationController | undefined;
        const track = controller?.getTrack(TrackId.Camera);
        if (!track) return;

        const keyframes = (track as any).keyframes as any[];

        // Do NOT overwrite an existing user keyframe at this frame
        const existingKf = keyframes.find((k: any) => k.frame === frame);
        if (existingKf && !existingKf.isControlPoint) {
            // This frame already has a user keyframe — silently skip
            return;
        }

        // Get target + fov from spline (fallback to nearest keyframe if spline unavailable)
        let targetX = 0, targetY = 0, targetZ = 0, fov = 60;
        const val = (track as any).getValueAt?.(frame) as number[] | null;
        if (val && val.length >= 7) {
            targetX = val[3]; targetY = val[4]; targetZ = val[5]; fov = val[6];
        } else if (existingKf && existingKf.value.length >= 7) {
            targetX = existingKf.value[3]; targetY = existingKf.value[4];
            targetZ = existingKf.value[5]; fov = existingKf.value[6];
        } else {
            const nearest = keyframes.length > 0 ? keyframes.reduce((best: any, k: any) =>
                Math.abs(k.frame - frame) < Math.abs(best.frame - frame) ? k : best
            ) : null;
            if (nearest && nearest.value.length >= 7) {
                targetX = nearest.value[3]; targetY = nearest.value[4];
                targetZ = nearest.value[5]; fov = nearest.value[6];
            }
        }

        const newValue = [
            newPos.x, newPos.y, newPos.z,
            targetX, targetY, targetZ,
            fov
        ];

        const kf: any = {
            frame,
            value: newValue,
            easingIn: 'linear',
            easingOut: 'linear',
            easingInTension: 1,
            easingOutTension: 1,
            isControlPoint: true
        };

        if (existingKf) {
            Object.assign(existingKf, kf);
        } else {
            keyframes.push(kf);
        }

        (track as any).rebuild?.(true);
        events.fire('track.keyUpdated');

        this.scene.forceRender = true;
        if (this._path3D) {
            this._path3D.dirty = true;
        }
    }

    /**
     * Move an existing keyframe to a new position.
     * The keyframe's frame number stays the same; only the camera position changes.
     */
    private _moveKeyframeInTrack(idx: number, newPos: Vec3) {
        const frame = this._path3D!.kfMarkerFrames[idx];
        const { events } = this.scene;
        const controller = events.invoke('animation.controller') as AnimationController | undefined;
        const track = controller?.getTrack(TrackId.Camera);
        if (!track) return;

        const keyframes = (track as any).keyframes as any[];
        const kf = keyframes.find((k: any) => k.frame === frame && !k.isControlPoint);
        if (!kf || kf.value.length < 7) return;

        kf.value[0] = newPos.x;
        kf.value[1] = newPos.y;
        kf.value[2] = newPos.z;

        (track as any).rebuild?.(true);
        events.fire('track.keyUpdated');

        this.scene.forceRender = true;
        if (this._path3D) this._path3D.dirty = true;
    }

    /**
     * Promote a control-point keyframe to a visible user keyframe.
     * Removes the isControlPoint flag so it appears in the timeline.
     */
    private _promoteControlPoint(idx: number) {
        const frame = this._path3D!.controlPointFrames[idx];
        const { events } = this.scene;
        const controller = events.invoke('animation.controller') as AnimationController | undefined;
        const track = controller?.getTrack(TrackId.Camera);
        if (!track) return;

        const keyframes = (track as any).keyframes as any[];
        const kf = keyframes.find((k: any) => k.frame === frame && k.isControlPoint);
        if (kf) {
            kf.isControlPoint = false;
            (track as any).rebuild?.();
            events.fire('track.keyUpdated');
            this.scene.forceRender = true;
            if (this._path3D) this._path3D.dirty = true;
        }
    }

    /**
     * Jump the main camera to a keyframe's position and orientation.
     * Also sets the timeline to that frame.
     */
    private _jumpToKeyframe(idx: number) {
        const frame = this._path3D!.kfMarkerFrames[idx];
        const { events } = this.scene;
        const controller = events.invoke('animation.controller') as AnimationController | undefined;
        const track = controller?.getTrack(TrackId.Camera);
        if (!track) return;

        const val = (track as any).getValueAt?.(frame) as number[] | null;
        if (!val || val.length < 7) return;

        events.fire('camera.setPose', {
            position: new Vec3(val[0], val[1], val[2]),
            target: new Vec3(val[3], val[4], val[5]),
            fov: val[6]
        }, 0.3);

        // Set timeline to this frame so user can adjust
        events.fire('timeline.frame', frame);
    }
}

export { CameraPathControl };
