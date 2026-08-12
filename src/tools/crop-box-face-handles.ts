import {
    CULLFACE_NONE,
    Color,
    Entity,
    Mat4,
    PROJECTION_PERSPECTIVE,
    Quat,
    StandardMaterial,
    Vec3
} from 'playcanvas';

import { CropBox } from '../crop-box';
import { Events } from '../events';
import { Scene } from '../scene';

// face index → local-space position, axis index, sign
// the 6 faces of the unit cube [-0.5, 0.5]^3
interface FaceInfo {
    localPos: Vec3;     // face center in unit-cube local space
    axis: number;       // 0=X, 1=Y, 2=Z
    sign: number;       // +1 or -1
    color: Color;       // handle base color (refined axis palette)
}

// refined axis palette: desaturated, professional tones. + and - faces share
// the same hue so the wireframe geometry (not color) communicates which face
// is which; hover/drag states provide the active feedback.
const FACE_INFOS: FaceInfo[] = [
    { localPos: new Vec3(0.5, 0, 0), axis: 0, sign: 1, color: new Color(0.90, 0.35, 0.40) },    // X+ warm red
    { localPos: new Vec3(-0.5, 0, 0), axis: 0, sign: -1, color: new Color(0.90, 0.35, 0.40) },  // X-
    { localPos: new Vec3(0, 0.5, 0), axis: 1, sign: 1, color: new Color(0.30, 0.80, 0.55) },    // Y+ mint
    { localPos: new Vec3(0, -0.5, 0), axis: 1, sign: -1, color: new Color(0.30, 0.80, 0.55) },  // Y-
    { localPos: new Vec3(0, 0, 0.5), axis: 2, sign: 1, color: new Color(0.40, 0.60, 0.95) },    // Z+ sky blue
    { localPos: new Vec3(0, 0, -0.5), axis: 2, sign: -1, color: new Color(0.40, 0.60, 0.95) }   // Z-
];

// scratch vectors (avoid per-frame allocation)
const _rayOrigin = new Vec3();
const _rayDir = new Vec3();
const _sphereCenter = new Vec3();
const _planePoint = new Vec3();
const _planeNormal = new Vec3();
const _worldFacePos = new Vec3();
const _localAxis = new Vec3();
const _tmpVec = new Vec3();
const _tmpVec2 = new Vec3();
const _invMat = new Mat4();
const _worldMat = new Mat4();
const _startCenter = new Vec3();
const _startExtent = new Vec3();
// reference-plane intersection (for dragging). the reference plane is
// parallel to the camera near plane and passes through the original hit
// point on the face. this lets screen-space pointer moves translate into
// meaningful 3D deltas, which we then project onto the face normal.
const _dragRefPlaneNormal = new Vec3();
const _dragStartHitPoint = new Vec3();
const _dragCurrentHitPoint = new Vec3();

// capsule handle constants and scratch
const UP_Y = new Vec3(0, 1, 0);
const AXIS_X = new Vec3(1, 0, 0);
const _faceNormal = new Vec3();
const _handleQuat = new Quat();
const _rotAxis = new Vec3();
const _capsuleAxis = new Vec3();
const _samplePoint = new Vec3();
const _handleWorldMat = new Mat4();

// CropBoxFaceHandles: 6 draggable capsule handles on the crop box faces.
//
// Each handle is an elongated capsule centered on one face of the oriented
// crop box, with its long axis perpendicular to that face. This makes the
// handle protrude outward and stay visible/grabbable even when partially
// occluded by splats. Dragging a handle along its face normal moves that
// face in/out, adjusting the box's extent and center on that axis while
// keeping the opposite face fixed. This mirrors the box-region editing UX
// in RealityCapture / Metashape.
//
// The handles are rendered as capsule entities in the world layer (NOT
// the gizmo layer, since the gizmo layer has clearDepthBuffer=true which would
// hide them on the first frame). They are direct children of contentRoot so
// their scale is independent of the crop box's non-unit scale.
class CropBoxFaceHandles {
    private scene: Scene;
    private events: Events;
    private getCropBox: () => CropBox | null;

    // 6 sphere entities, parented under scene.contentRoot
    private handles: Entity[] = [];
    private materials: StandardMaterial[] = [];
    private baseColors: Color[] = [];
    private handleRadius = 0.05;

    // interaction state
    private active = false;
    private dragging = false;
    private dragFaceIndex = -1;
    private hoveredIndex = -1;

    // coordinate space: 'local' = follow box rotation, 'world' = always axis-aligned
    private coordSpace: 'local' | 'world' = 'local';

    constructor(scene: Scene, events: Events, getCropBox: () => CropBox | null) {
        this.scene = scene;
        this.events = events;
        this.getCropBox = getCropBox;

        for (let i = 0; i < 6; i++) {
            const info = FACE_INFOS[i];
            const entity = new Entity(`cropFaceHandle_${i}`);

            // unlit emissive material so the sphere reads as a solid color
            // regardless of scene lighting. depth-test on so the handles
            // don't punch through the splats; depth-write on so they
            // occlude each other correctly. blend is disabled (opaque) so
            // the handle edges stay crisp and readable against the splats.
            const material = new StandardMaterial();
            material.diffuse = new Color(0, 0, 0);
            material.emissive = info.color.clone();
            material.specular = new Color(0, 0, 0);
            material.useLighting = false;
            material.cull = CULLFACE_NONE;
            material.depthTest = true;
            material.depthWrite = true;
            material.update();

            entity.addComponent('render', {
                type: 'capsule',
                material,
                layers: [scene.worldLayer.id]
            });

            this.materials.push(material);
            this.baseColors.push(info.color.clone());
            this.handles.push(entity);
        }

        this.updateAppearance();
    }

    // update emissive color of all handles based on hover/drag state.
    // called when the hover or drag state changes (not every frame) to
    // avoid per-frame material.update() cost.
    //  - default: 70% of base color
    //  - hovered: 120% of base color (brighter, draws the eye)
    //  - dragging: white-tinted 150% (strongest feedback)
    private updateAppearance() {
        for (let i = 0; i < 6; i++) {
            const mat = this.materials[i];
            const base = this.baseColors[i];
            if (i === this.dragFaceIndex) {
                mat.emissive.set(
                    Math.min(1, base.r * 1.5 + 0.3),
                    Math.min(1, base.g * 1.5 + 0.3),
                    Math.min(1, base.b * 1.5 + 0.3)
                );
            } else if (i === this.hoveredIndex) {
                mat.emissive.set(
                    Math.min(1, base.r * 1.2),
                    Math.min(1, base.g * 1.2),
                    Math.min(1, base.b * 1.2)
                );
            } else {
                mat.emissive.set(base.r * 0.7, base.g * 0.7, base.b * 0.7);
            }
            mat.update();
        }
    }

    // ---- lifecycle ----

    activate() {
        this.active = true;
        const box = this.getCropBox();
        if (box) {
            this.attach(box);
        }
    }

    deactivate() {
        this.active = false;
        this.hoveredIndex = -1;
        this.detach();
        this.updateAppearance();
    }

    // parent the 6 handles to the scene content root (NOT the box pivot, which
    // has a non-unit scale that would distort the spheres). positions are
    // synced per-frame in onPreRender.
    private attach(box: CropBox) {
        for (const handle of this.handles) {
            if (!handle.parent) {
                this.scene.contentRoot.addChild(handle);
            }
            handle.enabled = true;
        }
        // sync positions immediately so the handles appear on the box faces on
        // the very first frame activate() is called. otherwise they would show
        // up at the origin (0,0,0) until the next prerender fires.
        this.updatePositions();
    }

    // sync handle positions, rotations, and sizes. called from attach() for
    // first-frame visibility, and from onPreRender() for per-frame updates.
    //
    // SIZE: all six handles share the SAME world radius, computed from the
    // box CENTER's view-space depth — not each face's individual depth. this
    // is the key insight from the original spherical-handle version: using
    // a single shared distance (the box center's) keeps every handle the
    // same size on screen and stable while orbiting/zooming, because the
    // per-face depth variation no longer leaks into per-handle sizing.
    //
    //   radius_world = BASE_PIXEL_SIZE * depth / (projY * cssH)
    //
    // where projY = projectionMatrix.data[5] = 1/tan(vFov/2) (perspective) or
    // 1/orthoHeight (ortho). this is the minimal, robust form — the screen
    // size simplifies to exactly BASE_PIXEL_SIZE regardless of zoom.
    private updatePositions() {
        const box = this.getCropBox();
        if (!box) return;

        // Re-attach if the handles were detached while another shape was
        // active (see CropBoxShapeHandles for the same issue).
        if (this.handles.length > 0 && !this.handles[0].parent) {
            this.attach(box);
        }

        const boxWorld = box.pivot.getWorldTransform();
        const cam = this.scene.camera.camera;
        const canvas = this.scene.canvas;

        const BASE_PIXEL_SIZE = 18;
        const LENGTH_RATIO = 6.0;

        // shared box-center depth → single radius for all 6 handles
        const projY = cam.projectionMatrix.data[5];
        const cssH = canvas.clientHeight;

        boxWorld.getTranslation(_tmpVec2);
        cam.viewMatrix.transformPoint(_tmpVec2, _tmpVec);
        const depth = Math.max(0.01, -_tmpVec.z);

        let radius: number;
        if (cam.projection === PROJECTION_PERSPECTIVE) {
            radius = (BASE_PIXEL_SIZE * depth) / (cssH * projY);
        } else {
            radius = BASE_PIXEL_SIZE / (cssH * projY);
        }
        radius = Math.max(0.01, radius);

        for (let i = 0; i < 6; i++) {
            const info = FACE_INFOS[i];
            const handle = this.handles[i];
            boxWorld.transformPoint(info.localPos, _worldFacePos);
            handle.setPosition(_worldFacePos);

            // --- rotation: align capsule +Y with the face normal in world space ---
            _localAxis.set(
                info.axis === 0 ? info.sign : 0,
                info.axis === 1 ? info.sign : 0,
                info.axis === 2 ? info.sign : 0
            );
            boxWorld.transformVector(_localAxis, _faceNormal);
            _faceNormal.normalize();

            const dot = Math.max(-1, Math.min(1, UP_Y.dot(_faceNormal)));
            if (dot > 0.99999) {
                _handleQuat.set(0, 0, 0, 1);
            } else if (dot < -0.99999) {
                _handleQuat.setFromAxisAngle(AXIS_X, 180);
            } else {
                _rotAxis.cross(UP_Y, _faceNormal).normalize();
                _handleQuat.setFromAxisAngle(_rotAxis, Math.acos(dot) * 180 / Math.PI);
            }
            handle.setRotation(_handleQuat);

            // --- scale: uniform thickness from the shared box-center radius.
            // hover/drag enlarges the handle so it stays easy to grab.
            const isActive = (i === this.hoveredIndex) || (i === this.dragFaceIndex);
            const scaleMul = isActive ? 1.4 : 1.0;
            const r = radius * scaleMul;

            // default capsule: radius 0.5, total height 3 (along Y).
            const diameter = 2 * r;
            handle.setLocalScale(diameter, diameter * LENGTH_RATIO / 3, diameter);
        }
    }

    private detach() {
        for (const handle of this.handles) {
            if (handle.parent) {
                handle.parent.removeChild(handle);
            }
        }
    }

    // ---- coordinate space ----

    getCoordSpace() { return this.coordSpace; }

    setCoordSpace(space: 'local' | 'world') {
        this.coordSpace = space;
    }

    // ---- per-frame update ----

    onPreRender() {
        if (!this.active) return;
        // face handles are only for the box shape — hide them for
        // cylinder/sphere (those use CropBoxShapeHandles instead).
        const box = this.getCropBox();
        if (!box || box.shape !== 'box') {
            this.detach();
            return;
        }
        this.updatePositions();
    }

    // ---- picking ----

    // test whether a screen-space point (x, y) in CSS pixels hits a face
    // handle. returns the hit handle index or -1. also outputs the ray used,
    // so the caller can reuse it for the drag plane intersection.
    //
    // picking approximates the capsule as a series of spheres sampled along
    // its axis — simple, robust, and fast enough for 6 handles × 7 samples.
    private pickHandle(x: number, y: number, outRayOrigin: Vec3, outRayDir: Vec3): number {
        const box = this.getCropBox();
        if (!box || !this.active) return -1;

        const cam = this.scene.camera.camera;
        const canvas = this.scene.canvas;
        const rect = canvas.getBoundingClientRect();
        const px = x - rect.left;
        const py = y - rect.top;

        cam.screenToWorld(px, py, 0, outRayOrigin);
        cam.screenToWorld(px, py, 1, outRayDir);
        outRayDir.sub(outRayOrigin).normalize();

        let bestDist = Infinity;
        let bestIndex = -1;

        const N = 6; // sample points along the capsule axis (N+1 spheres)
        for (let i = 0; i < 6; i++) {
            const handle = this.handles[i];
            if (!handle.enabled) continue;

            // capsule center and axis in world space
            _handleWorldMat.copy(handle.getWorldTransform());
            _handleWorldMat.getTranslation(_sphereCenter);
            _handleWorldMat.transformVector(UP_Y, _capsuleAxis);
            _capsuleAxis.normalize();

            // effective capsule dimensions from local scale
            const ws = handle.getLocalScale();
            const radius = ws.x * 0.5;      // effective radius (0.5 * scale)
            const totalLen = 3.0 * ws.y;    // effective total length (3 * scaleY)

            // sample N+1 spheres along the capsule axis
            for (let j = 0; j <= N; j++) {
                const f = j / N;
                const offset = (f - 0.5) * totalLen; // -totalLen/2 .. +totalLen/2
                _samplePoint.copy(_capsuleAxis).mulScalar(offset).add(_sphereCenter);

                // ray-sphere intersection: |O + t*D - C|² = r²
                _tmpVec.sub2(outRayOrigin, _samplePoint);
                const b = _tmpVec.dot(outRayDir);
                const c = _tmpVec.dot(_tmpVec) - radius * radius;
                const disc = b * b - c;
                if (disc < 0) continue;

                const t = -b - Math.sqrt(disc);
                if (t > 0 && t < bestDist) {
                    bestDist = t;
                    bestIndex = i;
                }
            }
        }

        return bestIndex;
    }

    // ---- pointer event handling ----

    // called by the host tool on pointerdown. returns true if a handle was hit
    // and the event should be consumed (not forwarded to other gizmos).
    onPointerDown(x: number, y: number): boolean {
        if (!this.active) return false;

        const hitIndex = this.pickHandle(x, y, _rayOrigin, _rayDir);
        if (hitIndex < 0) return false;

        const box = this.getCropBox();
        if (!box) return false;

        const info = FACE_INFOS[hitIndex];
        const cam = this.scene.camera.camera;

        this.dragging = true;
        this.dragFaceIndex = hitIndex;
        this.updateAppearance();

        // capture box state
        _startCenter.copy(box.center);
        _startExtent.copy(box.extent);

        // compute the 3D hit point on the face plane: intersect the pick ray
        // with the (infinite) plane that contains the dragged face.
        _localAxis.set(info.axis === 0 ? 1 : 0, info.axis === 1 ? 1 : 0, info.axis === 2 ? 1 : 0);
        box.rotation.transformVector(_localAxis, _planeNormal);

        _worldMat.copy(box.pivot.getWorldTransform());
        _worldMat.transformPoint(info.localPos, _worldFacePos);

        const facePlaneDist = _worldFacePos.dot(_planeNormal);
        const denom = _rayDir.dot(_planeNormal);
        if (Math.abs(denom) > 1e-6) {
            const tHit = (facePlaneDist - _rayOrigin.dot(_planeNormal)) / denom;
            if (tHit > 0) {
                _dragStartHitPoint.copy(_rayOrigin).add(_tmpVec.copy(_rayDir).mulScalar(tHit));
            } else {
                _dragStartHitPoint.copy(_worldFacePos);
            }
        } else {
            _dragStartHitPoint.copy(_worldFacePos);
        }

        // reference plane: parallel to the camera near plane, passes through
        // the hit point. normal = camera forward (points *into* the screen so
        // rays coming from the camera have positive t).
        const camForward = cam.entity.forward;
        _dragRefPlaneNormal.copy(camForward);
        if (_dragRefPlaneNormal.lengthSq() < 0.99) {
            // fallback: -Z if forward unavailable
            _dragRefPlaneNormal.set(0, 0, -1);
        }

        return true;
    }

    // called by the host tool on pointermove during a drag
    onPointerMove(x: number, y: number) {
        if (!this.dragging || this.dragFaceIndex < 0) return;

        const box = this.getCropBox();
        if (!box) return;

        const info = FACE_INFOS[this.dragFaceIndex];
        const cam = this.scene.camera.camera;
        const canvas = this.scene.canvas;
        const rect = canvas.getBoundingClientRect();
        const px = x - rect.left;
        const py = y - rect.top;

        // current pointer ray
        cam.screenToWorld(px, py, 0, _rayOrigin);
        cam.screenToWorld(px, py, 1, _rayDir);
        _rayDir.sub(_rayOrigin).normalize();

        // face normal in world space (used for the final projection). since
        // the box cannot rotate during a face-only drag, recomputing keeps this
        // correct if an external rotation sneaks in.
        _localAxis.set(info.axis === 0 ? 1 : 0, info.axis === 1 ? 1 : 0, info.axis === 2 ? 1 : 0);
        box.rotation.transformVector(_localAxis, _planeNormal);

        // intersect the current ray with the drag reference plane (parallel
        // to the camera near plane, passing through the initial hit point).
        // this gives us a 3D point that moves proportionally to the screen
        // pointer — the actual intersection geometry with the *face* plane is
        // not what we want here, since that always lies on the original plane
        // and therefore gives zero normal component.
        const refD = _dragStartHitPoint.dot(_dragRefPlaneNormal);
        const denom = _rayDir.dot(_dragRefPlaneNormal);
        if (Math.abs(denom) < 1e-6) return;

        const t = (refD - _rayOrigin.dot(_dragRefPlaneNormal)) / denom;
        if (t < 0) return;

        _dragCurrentHitPoint.copy(_rayOrigin).add(_tmpVec.copy(_rayDir).mulScalar(t));

        // world-space 3D delta since the drag started
        _tmpVec.sub2(_dragCurrentHitPoint, _dragStartHitPoint);

        // project onto the face normal to get how far the face should move
        const delta = _tmpVec.dot(_planeNormal);

        // geometry:
        //   face_position     = center + sign * extent * faceNormal
        //   opposite_position = center - sign * extent * faceNormal
        // moving face_position by (delta * faceNormal) while keeping the
        // opposite face fixed:
        //   new_extent = extent + sign * delta / 2
        //   new_center = center + (delta / 2) * faceNormal
        const startExtentOnAxis = [_startExtent.x, _startExtent.y, _startExtent.z][info.axis];
        const newExtentOnAxis = startExtentOnAxis + info.sign * delta * 0.5;
        const minExtent = 0.01;
        const clampedExtent = Math.max(minExtent, newExtentOnAxis);
        const actualDelta = (clampedExtent - startExtentOnAxis) * 2 / info.sign;

        const newExtent = _startExtent.clone();
        const newCenter = _startCenter.clone();

        // Uniform-scale lock: keep the CENTROID fixed (other faces follow to
        // the same centroid distance via CropBox.enforceUniformExtent), so the
        // cube scales smoothly from its center instead of the centre drifting
        // with the dragged face. Without the lock the opposite face stays
        // fixed and the centre shifts (legacy behaviour).
        if (!box.uniformScale) {
            _tmpVec2.copy(_planeNormal).mulScalar(actualDelta * 0.5);
            newCenter.add(_tmpVec2);
        }

        if (info.axis === 0) newExtent.x = clampedExtent;
        else if (info.axis === 1) newExtent.y = clampedExtent;
        else newExtent.z = clampedExtent;

        box.setState(box.uniformScale ? box.center.clone() : newCenter, newExtent, box.rotation.clone());
    }

    // called by the host tool on pointerup
    onPointerUp() {
        this.dragging = false;
        this.dragFaceIndex = -1;
        this.updateAppearance();
    }

    // called by the host tool on pointermove when NOT dragging, to update
    // the hover highlight. returns true if a handle is currently hovered so
    // the host can switch the cursor to 'grab'. cheap: does one ray test
    // against 6 spheres and only calls updateAppearance when the hovered
    // handle actually changes.
    onPointerHover(x: number, y: number): boolean {
        if (!this.active || this.dragging) return false;
        const hitIndex = this.pickHandle(x, y, _rayOrigin, _rayDir);
        if (hitIndex !== this.hoveredIndex) {
            this.hoveredIndex = hitIndex;
            this.updateAppearance();
        }
        return hitIndex >= 0;
    }

    get isDragging() { return this.dragging; }
}

export { CropBoxFaceHandles };
