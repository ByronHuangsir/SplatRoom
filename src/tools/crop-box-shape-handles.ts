import {
    Color,
    CULLFACE_NONE,
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

// Drag handles for the crop cylinder / sphere shapes. The box shape uses
// CropBoxFaceHandles (six face capsules); cylinder/sphere have no faces, so
// they get dedicated handles that resize `radius` / `height`:
//
//   cylinder:  top & bottom center (drag along Y → height)
//              X+ / Z+ rim points (drag along X / Z → radius)
//   sphere:    X+ equator & Y+ pole (drag → radius)
//
// All handles are sphere entities parented under scene.contentRoot so their
// size is independent of the pivot's non-unit scale. Dragging uses the same
// camera-near-plane reference-plane technique as CropBoxFaceHandles.

type HandleKind = 'heightTop' | 'heightBottom' | 'radiusX' | 'radiusY' | 'radiusZ';

interface ShapeHandleDef {
    kind: HandleKind;
    axis: number;    // projection axis: 0=X, 1=Y, 2=Z
    sign: number;    // +1/-1 for the two height handles
    color: Color;
    getLocalPos(box: CropBox): Vec3;
}

const CYLINDER_DEFS: ShapeHandleDef[] = [
    { kind: 'heightTop', axis: 1, sign: 1, color: new Color(0.30, 0.80, 0.55), getLocalPos: (b) => new Vec3(0, b.height * 0.5, 0) },
    { kind: 'heightBottom', axis: 1, sign: -1, color: new Color(0.30, 0.80, 0.55), getLocalPos: (b) => new Vec3(0, -b.height * 0.5, 0) },
    { kind: 'radiusX', axis: 0, sign: 1, color: new Color(0.90, 0.35, 0.40), getLocalPos: (b) => new Vec3(b.radiusX, b.height * 0.5, 0) },
    { kind: 'radiusZ', axis: 2, sign: 1, color: new Color(0.40, 0.60, 0.95), getLocalPos: (b) => new Vec3(0, b.height * 0.5, b.radiusZ) }
];

// sphere: X+ equator (R1), Y+ pole (R3) and Z+ equator (R2) — triaxial ellipsoid
const SPHERE_DEFS: ShapeHandleDef[] = [
    { kind: 'radiusX', axis: 0, sign: 1, color: new Color(0.90, 0.35, 0.40), getLocalPos: (b) => new Vec3(b.radiusX, 0, 0) },
    { kind: 'radiusY', axis: 1, sign: 1, color: new Color(0.30, 0.80, 0.55), getLocalPos: (b) => new Vec3(0, b.radiusY, 0) },
    { kind: 'radiusZ', axis: 2, sign: 1, color: new Color(0.40, 0.60, 0.95), getLocalPos: (b) => new Vec3(0, 0, b.radiusZ) }
];

// scratch (avoid per-frame allocation)
const _rayOrigin = new Vec3();
const _rayDir = new Vec3();
const _worldPos = new Vec3();
const _pivotMat = new Mat4();
const _axisLocal = new Vec3();
const _axisWorld = new Vec3();
const _tmpVec = new Vec3();
const _startHit = new Vec3();
const _currentHit = new Vec3();
const _refNormal = new Vec3();
const _handleQuat = new Quat();
const _rotAxis = new Vec3();
const _samplePoint = new Vec3();

const UP_Y = new Vec3(0, 1, 0);
const _xAxis = new Vec3(1, 0, 0);
// capsule total length relative to its radius (same as the box face handles)
const CAPSULE_LENGTH_RATIO = 6.0;

class CropBoxShapeHandles {
    private scene: Scene;
    private events: Events;
    private getCropBox: () => CropBox | null;

    private defs: ShapeHandleDef[] = [];
    private handles: Entity[] = [];
    private materials: StandardMaterial[] = [];
    private baseColors: Color[] = [];

    private active = false;
    private dragging = false;
    private dragIndex = -1;
    private hoveredIndex = -1;

    // drag-start state
    private startRadiusX = 0;
    private startRadiusY = 0;
    private startRadiusZ = 0;
    private startHeight = 0;

    constructor(scene: Scene, events: Events, getCropBox: () => CropBox | null) {
        this.scene = scene;
        this.events = events;
        this.getCropBox = getCropBox;
    }

    private updateDefs() {
        const box = this.getCropBox();
        const next = box && box.shape === 'cylinder' ? CYLINDER_DEFS : SPHERE_DEFS;
        if (next === this.defs) return;
        // shape switched — rebuild handle entities
        this.detach();
        for (const e of this.handles) e.destroy();
        this.handles = [];
        this.materials = [];
        this.baseColors = [];
        this.defs = next;
        for (let i = 0; i < this.defs.length; i++) {
            const def = this.defs[i];
            const entity = new Entity(`cropShapeHandle_${i}`);
            // capsule handle, same style as the box's CropBoxFaceHandles:
            // elongated capsule with its long axis along the drag direction,
            // so it protrudes outward and stays grabbable when partially
            // occluded by splats.
            const material = new StandardMaterial();
            material.diffuse = new Color(0, 0, 0);
            material.emissive = def.color.clone();
            material.specular = new Color(0, 0, 0);
            material.useLighting = false;
            material.cull = CULLFACE_NONE;
            material.depthTest = true;
            material.depthWrite = true;
            material.update();
            entity.addComponent('render', {
                type: 'capsule',
                material,
                layers: [this.scene.worldLayer.id]
            });
            this.materials.push(material);
            this.baseColors.push(def.color.clone());
            this.handles.push(entity);
        }
        if (this.active) {
            const b = this.getCropBox();
            if (b) this.attach(b);
        }
        this.updateAppearance();
    }

    private updateAppearance() {
        for (let i = 0; i < this.materials.length; i++) {
            const mat = this.materials[i];
            const base = this.baseColors[i];
            if (i === this.dragIndex) {
                mat.emissive.set(Math.min(1, base.r * 1.5 + 0.3), Math.min(1, base.g * 1.5 + 0.3), Math.min(1, base.b * 1.5 + 0.3));
            } else if (i === this.hoveredIndex) {
                mat.emissive.set(Math.min(1, base.r * 1.2), Math.min(1, base.g * 1.2), Math.min(1, base.b * 1.2));
            } else {
                mat.emissive.set(base.r * 0.7, base.g * 0.7, base.b * 0.7);
            }
            mat.update();
        }
    }

    // ---- lifecycle ----

    activate() {
        this.active = true;
        this.updateDefs();
        const box = this.getCropBox();
        if (box) this.attach(box);
    }

    deactivate() {
        this.active = false;
        this.hoveredIndex = -1;
        this.dragIndex = -1;
        this.dragging = false;
        this.detach();
        this.updateAppearance();
    }

    private attach(box: CropBox) {
        for (const handle of this.handles) {
            if (!handle.parent) this.scene.contentRoot.addChild(handle);
            handle.enabled = true;
        }
        this.updatePositions();
    }

    private detach() {
        for (const handle of this.handles) {
            if (handle.parent) handle.parent.removeChild(handle);
        }
    }

    // handle world positions + uniform on-screen size (from box-center depth)
    private updatePositions() {
        const box = this.getCropBox();
        if (!box) return;
        this.updateDefs();
        // Re-attach if the handles were detached (e.g. the user switched to
        // box and back — onPreRender detaches them for the box shape and the
        // attach() call only runs on activate/rebuild, so without this the
        // sphere/cylinder handles would not reappear).
        if (this.handles.length > 0 && !this.handles[0].parent) {
            this.attach(box);
        }
        const boxWorld = box.pivot.getWorldTransform();
        const cam = this.scene.camera.camera;
        const canvas = this.scene.canvas;

        const BASE_PIXEL_SIZE = 16;
        const projY = cam.projectionMatrix.data[5];
        const cssH = canvas.clientHeight;
        boxWorld.getTranslation(_tmpVec);
        cam.viewMatrix.transformPoint(_tmpVec, _worldPos);
        const depth = Math.max(0.01, -_worldPos.z);

        let radius: number;
        if (cam.projection === PROJECTION_PERSPECTIVE) {
            radius = (BASE_PIXEL_SIZE * depth) / (cssH * projY);
        } else {
            radius = BASE_PIXEL_SIZE / (cssH * projY);
        }
        radius = Math.max(0.01, radius);

        for (let i = 0; i < this.handles.length; i++) {
            const handle = this.handles[i];
            const def = this.defs[i];
            boxWorld.transformPoint(def.getLocalPos(box), _worldPos);
            handle.setPosition(_worldPos);

            // --- rotation: align capsule +Y with the drag axis in world space ---
            _axisLocal.set(def.axis === 0 ? 1 : 0, def.axis === 1 ? 1 : 0, def.axis === 2 ? 1 : 0);
            boxWorld.transformVector(_axisLocal, _axisWorld);
            _axisWorld.normalize();
            const dot = Math.max(-1, Math.min(1, UP_Y.dot(_axisWorld)));
            if (dot > 0.99999) {
                _handleQuat.set(0, 0, 0, 1);
            } else if (dot < -0.99999) {
                _handleQuat.setFromAxisAngle(_xAxis, 180);
            } else {
                _rotAxis.cross(UP_Y, _axisWorld).normalize();
                _handleQuat.setFromAxisAngle(_rotAxis, Math.acos(dot) * 180 / Math.PI);
            }
            handle.setRotation(_handleQuat);

            // --- scale: capsule radius from the shared box-center depth;
            // hover/drag enlarges the handle so it stays easy to grab ---
            const isActive = i === this.hoveredIndex || i === this.dragIndex;
            const r = radius * (isActive ? 1.4 : 1.0);
            const diameter = 2 * r;
            handle.setLocalScale(diameter, diameter * CAPSULE_LENGTH_RATIO / 3, diameter);
        }
    }

    onPreRender() {
        if (!this.active) return;
        // shape handles are only for cylinder/sphere — hide them for box
        // (the box uses CropBoxFaceHandles).
        const box = this.getCropBox();
        if (!box || box.shape === 'box') {
            this.detach();
            return;
        }
        this.updatePositions();
    }

    // ---- picking ----

    private pickHandle(x: number, y: number, outOrigin: Vec3, outDir: Vec3): number {
        const box = this.getCropBox();
        if (!box || !this.active) return -1;
        const cam = this.scene.camera.camera;
        const canvas = this.scene.canvas;
        const rect = canvas.getBoundingClientRect();
        const px = x - rect.left;
        const py = y - rect.top;

        cam.screenToWorld(px, py, 0, outOrigin);
        cam.screenToWorld(px, py, 1, outDir);
        outDir.sub(outOrigin).normalize();

        let bestDist = Infinity;
        let bestIndex = -1;
        const N = 6; // samples along the capsule axis
        for (let i = 0; i < this.handles.length; i++) {
            const handle = this.handles[i];
            if (!handle.enabled) continue;
            _pivotMat.copy(handle.getWorldTransform());
            _pivotMat.getTranslation(_worldPos);
            _pivotMat.transformVector(UP_Y, _axisWorld);
            _axisWorld.normalize();

            const ws = handle.getLocalScale();
            const hr = Math.max(0.01, ws.x * 0.5);       // capsule radius
            const totalLen = 3.0 * ws.y;                  // capsule total length

            for (let j = 0; j <= N; j++) {
                const f = j / N;
                const offset = (f - 0.5) * totalLen;
                _samplePoint.copy(_axisWorld).mulScalar(offset).add(_worldPos);
                _tmpVec.sub2(outOrigin, _samplePoint);
                const b = _tmpVec.dot(outDir);
                const c = _tmpVec.dot(_tmpVec) - hr * hr;
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

    // ---- pointer handling ----

    onPointerDown(x: number, y: number): boolean {
        if (!this.active) return false;
        const hit = this.pickHandle(x, y, _rayOrigin, _rayDir);
        if (hit < 0) return false;
        const box = this.getCropBox();
        if (!box) return false;

        this.dragging = true;
        this.dragIndex = hit;
        this.startRadiusX = box.radiusX;
        this.startRadiusY = box.radiusY;
        this.startRadiusZ = box.radiusZ;
        this.startHeight = box.height;
        this.updateAppearance();

        // intersect pick ray with the camera-near-parallel plane through the hit point
        const cam = this.scene.camera.camera;
        _pivotMat.copy(box.pivot.getWorldTransform());
        _pivotMat.transformPoint(this.defs[hit].getLocalPos(box), _worldPos);

        const refD = _worldPos.dot(cam.entity.forward);
        const denom = _rayDir.dot(cam.entity.forward);
        if (Math.abs(denom) > 1e-6) {
            const t = (refD - _rayOrigin.dot(cam.entity.forward)) / denom;
            _startHit.copy(_rayOrigin).add(_tmpVec.copy(_rayDir).mulScalar(t));
        } else {
            _startHit.copy(_worldPos);
        }
        _refNormal.copy(cam.entity.forward);
        if (_refNormal.lengthSq() < 0.99) _refNormal.set(0, 0, -1);
        return true;
    }

    onPointerMove(x: number, y: number) {
        if (!this.dragging || this.dragIndex < 0) return;
        const box = this.getCropBox();
        if (!box) return;
        const cam = this.scene.camera.camera;
        const canvas = this.scene.canvas;
        const rect = canvas.getBoundingClientRect();
        const px = x - rect.left;
        const py = y - rect.top;

        cam.screenToWorld(px, py, 0, _rayOrigin);
        cam.screenToWorld(px, py, 1, _rayDir);
        _rayDir.sub(_rayOrigin).normalize();

        const refD = _startHit.dot(_refNormal);
        const denom = _rayDir.dot(_refNormal);
        if (Math.abs(denom) < 1e-6) return;
        const t = (refD - _rayOrigin.dot(_refNormal)) / denom;
        if (t < 0) return;
        _currentHit.copy(_rayOrigin).add(_tmpVec.copy(_rayDir).mulScalar(t));

        // world-space 3D delta since drag start
        _tmpVec.sub2(_currentHit, _startHit);

        const def = this.defs[this.dragIndex];
        // project delta onto the pivot's local axis (world direction, normalized)
        _axisLocal.set(def.axis === 0 ? 1 : 0, def.axis === 1 ? 1 : 0, def.axis === 2 ? 1 : 0);
        _pivotMat.copy(box.pivot.getWorldTransform());
        _pivotMat.transformVector(_axisLocal, _axisWorld);
        _axisWorld.normalize();
        const scale = def.axis === 0 ? box.pivot.getLocalScale().x
            : def.axis === 1 ? box.pivot.getLocalScale().y
            : box.pivot.getLocalScale().z;
        const localDelta = _tmpVec.dot(_axisWorld) / Math.max(1e-6, scale);

        if (def.kind === 'heightTop') {
            box.height = Math.max(0.05, Math.min(1.0, this.startHeight + 2 * localDelta));
        } else if (def.kind === 'heightBottom') {
            box.height = Math.max(0.05, Math.min(1.0, this.startHeight - 2 * localDelta));
        } else if (def.kind === 'radiusX') {
            // R1 handle → change the X radius only. With the uniform-scale
            // lock ON the setter keeps all radii equal (sphere) / R1=R2 (cylinder).
            box.radiusX = Math.max(0.02, Math.min(0.5, this.startRadiusX + localDelta));
        } else if (def.kind === 'radiusY') {
            // R3 handle (sphere pole) → change the Y radius (all equal when locked)
            box.radiusY = Math.max(0.02, Math.min(0.5, this.startRadiusY + localDelta));
        } else {
            // R2 handle → change the Z radius (R1 = R2 when locked)
            box.radiusZ = Math.max(0.02, Math.min(0.5, this.startRadiusZ + localDelta));
        }
    }

    onPointerUp() {
        this.dragging = false;
        this.dragIndex = -1;
        this.updateAppearance();
    }

    onPointerHover(x: number, y: number): boolean {
        if (!this.active || this.dragging) return false;
        const hit = this.pickHandle(x, y, _rayOrigin, _rayDir);
        if (hit !== this.hoveredIndex) {
            this.hoveredIndex = hit;
            this.updateAppearance();
        }
        return hit >= 0;
    }

    get isDragging() { return this.dragging; }
}

export { CropBoxShapeHandles };
