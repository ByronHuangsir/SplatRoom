import {
    BLEND_NORMAL,
    Color,
    CULLFACE_NONE,
    Entity,
    Mat4,
    Mesh,
    MeshInstance,
    PRIMITIVE_TRIANGLES,
    PROJECTION_PERSPECTIVE,
    Quat,
    StandardMaterial,
    Vec3
} from 'playcanvas';

import { Scene } from './scene';
import { Splat } from './splat';
import { PlanarFixSession } from './geometry/planar-fix';
import { eigenDecompSym3x3 } from './geometry/surface-analyzer';

// unit cube corner offsets ([-0.5, 0.5]^3) for the wireframe
const unitCorners: Vec3[] = [];
for (const x of [-0.5, 0.5]) {
    for (const y of [-0.5, 0.5]) {
        for (const z of [-0.5, 0.5]) {
            unitCorners.push(new Vec3(x, y, z));
        }
    }
}

// Face corner indices for each of the 2 slab faces (rectangle outlines)
// Base face (-Y): corners where y = -0.5 → indices 0,1,2,3
// Limit face (+Y): corners where y = +0.5 → indices 4,5,6,7
const baseFaceEdges: [number, number][] = [
    [0, 1], [1, 3], [3, 2], [2, 0]
];
const limitFaceEdges: [number, number][] = [
    [4, 5], [5, 7], [7, 6], [6, 4]
];
// Four vertical edges connecting base to limit
const verticalEdges: [number, number][] = [
    [0, 4], [1, 5], [2, 6], [3, 7]
];

// Colors matching user's reference image:
//   - Base face (−Y): thin translucent cyan
//   - Limit face (+Y): thin translucent pink
//   - Connector lines: faint blue-grey
const BASE_COLOR = new Color(0.18, 0.78, 0.72, 0.70);   // cyan, semi-transparent
const LIMIT_COLOR = new Color(0.92, 0.42, 0.52, 0.65);   // pink, semi-transparent
const EDGE_COLOR = new Color(0.55, 0.68, 0.82, 0.40);    // faint connector lines
// Grid lines on faces — brighter than outline for depth perception
const BASE_GRID_COLOR = new Color(0.20, 0.85, 0.78, 0.55);  // bright cyan grid
const LIMIT_GRID_COLOR = new Color(0.95, 0.50, 0.58, 0.50); // bright pink grid

// ---- scratch vectors (shared, never carry persistent state) ----
const _m = new Mat4();
const _v = new Vec3();
const _w = new Vec3();
const _tmpVec = new Vec3();
const _tmpVec2 = new Vec3();

// ---- thickness handle scratch vectors ----
const UP_Y = new Vec3(0, 1, 0);
const AXIS_X = new Vec3(1, 0, 0);
const _faceNormal = new Vec3();
const _handleQuat = new Quat();
const _rotAxis = new Vec3();
const _capsuleAxis = new Vec3();
const _samplePoint = new Vec3();
const _handleWorldMat = new Mat4();
const _rayOrigin = new Vec3();
const _rayDir = new Vec3();
const _currentHit = new Vec3();

// Capsule handle color (pink, matches limit face)
const HANDLE_COLOR = new Color(0.92, 0.42, 0.52);

// build a quaternion from an orthonormal right-handed basis (x, y, z)
function quatFromBasis(x: Vec3, y: Vec3, z: Vec3): Quat {
    const m = new Mat4();
    m.data[0] = x.x; m.data[1] = x.y; m.data[2] = x.z; m.data[3] = 0;
    m.data[4] = y.x; m.data[5] = y.y; m.data[6] = y.z; m.data[7] = 0;
    m.data[8] = z.x; m.data[9] = z.y; m.data[10] = z.z; m.data[11] = 0;
    m.data[12] = 0; m.data[13] = 0; m.data[14] = 0; m.data[15] = 1;
    const q = new Quat();
    q.setFromMat4(m);
    return q;
}

/**
 * Oriented box that defines the planar-fix slab.
 *
 * The box's local +Y axis is the slab normal. Visualized as:
 *   - **Base face** (−Y): cyan translucent fill + cyan rectangle outline —
 *     the reference plane to align against a wall / floor
 *   - **Limit face** (+Y): pink translucent fill + pink rectangle outline —
 *     the slab cap controlling thickness
 *   - **Vertical edges**: faint lines linking the two faces
 *
 * The two slab faces are rendered as unlit emissive quads on the scene's
 * World layer (the only layer the camera renders), giving a visual reference
 * for the region that will be flattened. A capsule handle on the +Y limit
 * face allows quick thickness adjustment via drag.
 */
class PlanarFixBox {
    private scene: Scene;

    // canonical state (world space)
    _center = new Vec3();
    _extent = new Vec3(1, 1, 1); // half-extents (world)
    _rotation = new Quat();

    // gizmo attaches here (scale carries 2*extent)
    gizmoTarget: Entity;

    // thickness handle (capsule mesh on the +Y limit face)
    private thicknessHandle: Entity;
    private handleMaterial: StandardMaterial;

    // filled translucent face meshes (base −Y, limit +Y) — visual reference
    private faceEntities: Entity[] = [];
    private faceMaterials: StandardMaterial[] = [];

    // thickness drag interaction state
    private draggingHandle = false;
    private handleHovered = false;
    private startThickness = 0;
    private _dragStartHitPoint = new Vec3();
    private _dragPlaneNormal = new Vec3();

    // pre-allocated world-space corners for per-frame wireframe
    private worldCorners: Vec3[] = unitCorners.map(() => new Vec3());

    enabled = false;

    constructor(scene: Scene) {
        this.scene = scene;
        this.gizmoTarget = new Entity('planarFixBoxTarget');
        this._buildHandle();
        this._buildFaces();
    }

    // ---- capsule thickness handle (only mesh entity) ----
    private _buildHandle() {
        this.handleMaterial = new StandardMaterial();
        this.handleMaterial.diffuse.set(0, 0, 0);
        this.handleMaterial.emissive.copy(HANDLE_COLOR);
        this.handleMaterial.specular.set(0, 0, 0);
        this.handleMaterial.useLighting = false;
        this.handleMaterial.cull = CULLFACE_NONE;
        this.handleMaterial.depthTest = true;
        this.handleMaterial.depthWrite = true;
        this.handleMaterial.update();

        this.thicknessHandle = new Entity('planarFixThicknessHandle');
        this.thicknessHandle.addComponent('render', {
            type: 'capsule',
            material: this.handleMaterial,
            layers: [this.scene.worldLayer.id]
        });
    }

    // ---- filled translucent faces (base −Y, limit +Y) ----
    // These provide a visual reference for the slab. Rendered as unlit
    // emissive quads on the scene's World layer (the only layer the camera
    // renders), so they appear reliably unlike the earlier plane-primitive
    // attempt which landed on the engine-default WORLD layer.
    private _buildFaces() {
        const defs = [
            { y: -0.5, color: BASE_COLOR, alpha: 0.45 }, // base −Y : cyan — visible!
            { y: 0.5, color: LIMIT_COLOR, alpha: 0.35 }   // limit +Y : pink — visible!
        ];
        const mesh = this._makeQuadMesh();
        for (const d of defs) {
            const mat = new StandardMaterial();
            mat.diffuse.set(0, 0, 0);
            mat.emissive.copy(d.color);
            mat.specular.set(0, 0, 0);
            mat.opacity = d.alpha;
            mat.blendType = BLEND_NORMAL;
            mat.depthWrite = false;
            mat.useLighting = false;
            mat.cull = CULLFACE_NONE;
            mat.update();

            const ent = new Entity('planarFixFace');
            ent.addComponent('render', {
                meshInstances: [new MeshInstance(mesh, mat)]
            });
            ent.render.layers = [this.scene.worldLayer.id];
            ent.setLocalPosition(0, d.y, 0); // base/limit local offset (gizmoTarget scale = 2*extent)
            this.gizmoTarget.addChild(ent);
            this.faceEntities.push(ent);
            this.faceMaterials.push(mat);
        }
    }

    // unit quad in the XZ plane (normal +Y), spanning [-0.5, 0.5]^2.
    // The parent gizmoTarget carries the box transform (scale = 2*extent),
    // so this unit quad is stretched to exactly cover each slab face.
    private _makeQuadMesh(): Mesh {
        const device = this.scene.app.graphicsDevice;
        const mesh = new Mesh(device);
        mesh.setPositions([
            -0.5, 0, -0.5,
             0.5, 0, -0.5,
             0.5, 0,  0.5,
            -0.5, 0,  0.5
        ]);
        mesh.setNormals([
            0, 1, 0,
            0, 1, 0,
            0, 1, 0,
            0, 1, 0
        ]);
        mesh.setUvs(0, [0, 0, 1, 0, 1, 1, 0, 1]);
        mesh.setIndices([0, 1, 2, 0, 2, 3]);
        mesh.update(PRIMITIVE_TRIANGLES);
        return mesh;
    }

    private _updateHandleAppearance() {
        const base = HANDLE_COLOR;
        if (this.draggingHandle) {
            this.handleMaterial.emissive.set(
                Math.min(1, base.r * 1.5 + 0.3),
                Math.min(1, base.g * 1.5 + 0.3),
                Math.min(1, base.b * 1.5 + 0.3)
            );
        } else if (this.handleHovered) {
            this.handleMaterial.emissive.set(
                Math.min(1, base.r * 1.2),
                Math.min(1, base.g * 1.2),
                Math.min(1, base.b * 1.2)
            );
        } else {
            this.handleMaterial.emissive.set(base.r * 0.75, base.g * 0.75, base.b * 0.75);
        }
        this.handleMaterial.update();
    }

    // screen-space-constant sizing, same pattern as CropBoxFaceHandles
    private _updateHandlePosition() {
        const wt = this.gizmoTarget.getWorldTransform();
        const cam = this.scene.camera.camera;
        const canvas = this.scene.canvas;

        const BASE_PIXEL_SIZE = 18;
        const LENGTH_RATIO = 6.0;
        const projY = cam.projectionMatrix.data[5];
        const cssH = canvas.clientHeight;

        wt.getTranslation(_tmpVec2);
        cam.viewMatrix.transformPoint(_tmpVec2, _tmpVec);
        const depth = Math.max(0.01, -_tmpVec.z);

        let radius: number;
        if (cam.projection === PROJECTION_PERSPECTIVE) {
            radius = (BASE_PIXEL_SIZE * depth) / (cssH * projY);
        } else {
            radius = BASE_PIXEL_SIZE / (cssH * projY);
        }
        radius = Math.max(0.01, radius);

        // position: center of the +Y (limit) face in world space
        const limitLocal = new Vec3(0, 1, 0);
        const limitWorld = new Vec3();
        wt.transformPoint(limitLocal, limitWorld);
        this.thicknessHandle.setPosition(limitWorld);

        // rotation: align capsule +Y with box +Y in world space
        _faceNormal.set(0, 1, 0);
        wt.transformVector(_faceNormal, _faceNormal);
        _faceNormal.normalize();

        const dot = Math.max(-1, Math.min(1, UP_Y.dot(_faceNormal)));
        if (dot > 0.99999) {
            this.thicknessHandle.setRotation(0, 0, 0, 1);
        } else if (dot < -0.99999) {
            this.thicknessHandle.setRotation(new Quat().setFromAxisAngle(AXIS_X, 180));
        } else {
            _rotAxis.cross(UP_Y, _faceNormal).normalize();
            this.thicknessHandle.setRotation(new Quat().setFromAxisAngle(_rotAxis, Math.acos(dot) * 180 / Math.PI));
        }

        const isActive = this.handleHovered || this.draggingHandle;
        const scaleMul = isActive ? 1.4 : 1.0;
        const r = radius * scaleMul;
        const diameter = 2 * r;
        this.thicknessHandle.setLocalScale(diameter, diameter * LENGTH_RATIO / 3, diameter);
    }

    // ---- lifecycle ----

    add() {
        this.scene.contentRoot.addChild(this.gizmoTarget);
        this.scene.contentRoot.addChild(this.thicknessHandle);
        this.enabled = true;
        console.log('[PlanarFixBox] add() called, faces:', this.faceEntities.length,
            'handle:', !!this.thicknessHandle,
            'extent:', this._extent.x.toFixed(2), this._extent.y.toFixed(2), this._extent.z.toFixed(2));
    }

    remove() {
        this.enabled = false;
        if (this.gizmoTarget.parent) this.gizmoTarget.parent.removeChild(this.gizmoTarget);
        if (this.thicknessHandle.parent) this.thicknessHandle.parent.removeChild(this.thicknessHandle);
    }

    destroy() {
        this.remove();
        for (const ent of this.faceEntities) {
            if (ent.render) ent.removeComponent('render');
            if (ent.parent) ent.parent.removeChild(ent);
        }
        this.faceEntities = [];
        for (const m of this.faceMaterials) m.destroy();
        this.faceMaterials = [];
    }

    // ---- coordinate conversion helpers ----
    private _worldToLocal(p: Vec3, out: Vec3): Vec3 {
        _m.copy(this.scene.contentRoot.getWorldTransform()).invert();
        return _m.transformPoint(p, out);
    }
    private _worldRotToLocal(q: Quat, out: Quat): Quat {
        _m.copy(this.scene.contentRoot.getWorldTransform()).invert();
        const cr = new Quat().setFromMat4(_m);
        return out.copy(cr).mul(q);
    }

    // write canonical state into gizmoTarget (scale = 2*extent)
    private syncTarget() {
        this.gizmoTarget.setLocalPosition(this._center);
        this.gizmoTarget.setLocalRotation(this._rotation);
        this.gizmoTarget.setLocalScale(this._extent.x * 2, this._extent.y * 2, this._extent.z * 2);
    }

    // read canonical state back from gizmoTarget (after a gizmo gesture)
    readFromTarget() {
        const wt = this.gizmoTarget.getWorldTransform();
        const c = wt.getTranslation();
        const r = new Quat().setFromMat4(wt);
        const s = wt.getScale();
        this._worldToLocal(c, this._center);
        this._worldRotToLocal(r, this._rotation);
        const crScale = this.scene.contentRoot.getWorldTransform().getScale();
        this._extent.set(
            Math.max(0.001, s.x / crScale.x * 0.5),
            Math.max(0.001, s.y / crScale.y * 0.5),
            Math.max(0.001, s.z / crScale.z * 0.5)
        );
    }

    // initialise the box from a splat: match the model's world bounding box
    // footprint (XZ) with a small thickness; centered on the model.
    initializeFromSplat(splat: Splat) {
        const wb: any = (splat as any).worldBoundStorage;
        let exWorld = 1, eyWorld = 1, ezWorld = 1;
        let centerWorld: Vec3;
        if (wb && wb.halfExtents) {
            exWorld = wb.halfExtents.x * 1.1;
            eyWorld = wb.halfExtents.y * 1.1;
            ezWorld = wb.halfExtents.z * 1.1;
            centerWorld = wb.center.clone();
        } else {
            const lb: any = (splat as any).localBoundStorage;
            if (lb && lb.halfExtents) {
                const sw = splat.worldTransform.getScale();
                exWorld = lb.halfExtents.x * Math.abs(sw.x) * 1.1;
                eyWorld = lb.halfExtents.y * Math.abs(sw.y) * 1.1;
                ezWorld = lb.halfExtents.z * Math.abs(sw.z) * 1.1;
            }
            centerWorld = splat.worldTransform.getTranslation();
        }
        const diag = 2 * Math.hypot(exWorld, eyWorld, ezWorld);
        this._worldToLocal(centerWorld, this._center);
        this._rotation.copy(new Quat());
        this._extent.set(exWorld, Math.max(diag * 0.02, 0.01), ezWorld);
        this.syncTarget();
    }

    // set thickness keeping the base (−Y) face fixed in world space
    setThicknessKeepBase(T: number) {
        const wt = this.gizmoTarget.getWorldTransform();
        const r = new Quat().setFromMat4(wt);
        const s = wt.getScale();
        const nWorld = r.transformVector(new Vec3(0, 1, 0));
        const centerWorld = this.scene.contentRoot.getWorldTransform().transformPoint(this._center);
        const curExtentWorldY = s.y * 0.5;
        const baseWorld = centerWorld.clone().sub(nWorld.clone().mulScalar(curExtentWorldY));
        const newExtentY = Math.max(0.001, T * 0.5);
        const newCenterWorld = baseWorld.add(nWorld.clone().mulScalar(newExtentY));
        this._worldToLocal(newCenterWorld, this._center);
        this._extent.y = newExtentY;
        this._extent.x = s.x * 0.5;
        this._extent.z = s.z * 0.5;
        this.syncTarget();
    }

    // snap the base face to the closest best-fit plane through nearby splats
    fitToClosestPlane(splat: Splat) {
        const session = this.getSession(splat);
        const sw = splat.worldTransform;
        const baseWorld = sw.transformPoint(session.plane.origin);
        const nWorld = new Quat().setFromMat4(sw).transformVector(session.plane.normal);
        const T = session.thickness;
        const wb: any = (splat as any).worldBoundStorage;
        const diag = wb ? 2 * Math.hypot(wb.halfExtents.x, wb.halfExtents.y, wb.halfExtents.z) : 1;
        const band = Math.max(T * 0.5, diag * 0.03);

        const sd = splat.splatData;
        const xs = sd.getProp('x') as Float32Array;
        const ys = sd.getProp('y') as Float32Array;
        const zs = sd.getProp('z') as Float32Array;
        const state = sd.getProp('state') as Uint8Array;
        const n = sd.numSplats;
        const pts: number[] = [];
        const wp = new Vec3();
        for (let i = 0; i < n; i++) {
            if (state && (state[i] & 4) !== 0) continue;
            _v.set(xs[i], ys[i], zs[i]);
            sw.transformPoint(_v, wp);
            const dd = wp.clone().sub(baseWorld).dot(nWorld);
            if (Math.abs(dd) < band) {
                pts.push(wp.x, wp.y, wp.z);
            }
        }
        const count = pts.length / 3;
        if (count < 3) return;

        const centroid = new Vec3(0, 0, 0);
        for (let i = 0; i < count; i++) centroid.add(new Vec3(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]));
        centroid.mulScalar(1 / count);

        let c00 = 0, c01 = 0, c02 = 0, c11 = 0, c12 = 0, c22 = 0;
        for (let i = 0; i < count; i++) {
            const dx = pts[i * 3] - centroid.x;
            const dy = pts[i * 3 + 1] - centroid.y;
            const dz = pts[i * 3 + 2] - centroid.z;
            c00 += dx * dx; c01 += dx * dy; c02 += dx * dz;
            c11 += dy * dy; c12 += dy * dz; c22 += dz * dz;
        }
        c00 /= count; c01 /= count; c02 /= count; c11 /= count; c12 /= count; c22 /= count;
        const { values, vectors } = eigenDecompSym3x3([[c00, c01, c02], [c01, c11, c12], [c02, c12, c22]]);
        let minIdx = 0;
        if (values[1] < values[minIdx]) minIdx = 1;
        if (values[2] < values[minIdx]) minIdx = 2;
        let normal = new Vec3(vectors[minIdx][0], vectors[minIdx][1], vectors[minIdx][2]);
        if (normal.lengthSq() < 1e-12) normal = nWorld.clone();
        normal.normalize();
        if (normal.dot(nWorld) < 0) normal.mulScalar(-1);

        const boxRotWorld = new Quat().setFromMat4(this.gizmoTarget.getWorldTransform());
        let boxX = boxRotWorld.transformVector(new Vec3(1, 0, 0));
        boxX.sub(normal.clone().mulScalar(boxX.dot(normal)));
        if (boxX.lengthSq() < 1e-8) {
            boxX = new Vec3(1, 0, 0).sub(normal.clone().mulScalar(normal.x));
            if (boxX.lengthSq() < 1e-8) boxX = new Vec3(0, 0, 1).sub(normal.clone().mulScalar(normal.z));
        }
        boxX.normalize();
        const boxZ = new Vec3().cross(normal, boxX).normalize();
        const newRotWorld = quatFromBasis(boxX, normal, boxZ);

        const newCenterWorld = centroid.clone().add(normal.clone().mulScalar(T * 0.5));
        this._worldToLocal(newCenterWorld, this._center);
        this._worldRotToLocal(newRotWorld, this._rotation);
        this.syncTarget();
    }

    // build a splat-local PlanarFixSession from the current box
    getSession(splat: Splat): PlanarFixSession {
        const wt = this.gizmoTarget.getWorldTransform();
        const centerWorld = wt.getTranslation();
        const rotWorld = new Quat().setFromMat4(wt);
        const scaleWorld = wt.getScale();

        const sw = splat.worldTransform;
        const swInv = sw.clone().invert();
        const centerLocal = swInv.transformPoint(centerWorld);

        const swRot = new Quat().setFromMat4(sw);
        const swScale = sw.getScale();
        const rotLocal = swRot.invert().mul(rotWorld);

        const n = rotLocal.transformVector(new Vec3(0, 1, 0));
        const u = rotLocal.transformVector(new Vec3(1, 0, 0));
        const v = rotLocal.transformVector(new Vec3(0, 0, 1));

        const lx = scaleWorld.x / swScale.x;
        const ly = scaleWorld.y / swScale.y;
        const lz = scaleWorld.z / swScale.z;

        const T = ly;
        const halfU = lx * 0.5;
        const halfV = lz * 0.5;
        const baseOrigin = centerLocal.clone().sub(n.clone().mulScalar(T * 0.5));

        return {
            plane: { origin: baseOrigin, normal: n, u, v },
            thickness: T,
            halfU,
            halfV,
            backEps: T * 0.15
        };
    }

    // ---- thickness handle picking ----
    private _pickHandle(x: number, y: number): boolean {
        if (!this.enabled) return false;

        const cam = this.scene.camera.camera;
        const canvas = this.scene.canvas;
        const rect = canvas.getBoundingClientRect();
        const px = x - rect.left;
        const py = y - rect.top;

        cam.screenToWorld(px, py, 0, _rayOrigin);
        cam.screenToWorld(px, py, 1, _rayDir);
        _rayDir.sub(_rayOrigin).normalize();

        _handleWorldMat.copy(this.thicknessHandle.getWorldTransform());
        _handleWorldMat.getTranslation(_tmpVec2);
        _handleWorldMat.transformVector(UP_Y, _capsuleAxis);
        _capsuleAxis.normalize();

        const ws = this.thicknessHandle.getLocalScale();
        const radius = ws.x * 0.5;
        const totalLen = 3.0 * ws.y;

        const N = 6;
        for (let j = 0; j <= N; j++) {
            const f = j / N;
            const offset = (f - 0.5) * totalLen;
            _samplePoint.copy(_capsuleAxis).mulScalar(offset).add(_tmpVec2);

            _tmpVec.sub2(_rayOrigin, _samplePoint);
            const b = _tmpVec.dot(_rayDir);
            const c = _tmpVec.dot(_tmpVec) - radius * radius;
            const disc = b * b - c;
            if (disc < 0) continue;

            const t = -b - Math.sqrt(disc);
            if (t > 0) return true;
        }

        return false;
    }

    // ---- thickness handle interaction ----

    startHandleDrag(x: number, y: number): number | null {
        if (!this.enabled || !this._pickHandle(x, y)) return null;

        this.draggingHandle = true;
        const s = this.gizmoTarget.getWorldTransform().getScale();
        this.startThickness = s.y;

        const cam = this.scene.camera.camera;
        const camFwd = cam.entity.forward;
        this._dragPlaneNormal.copy(camFwd).normalize();
        if (this._dragPlaneNormal.lengthSq() < 0.99) {
            this._dragPlaneNormal.set(0, 0, -1);
        }

        this._dragStartHitPoint.copy(this.thicknessHandle.getPosition());

        this._updateHandleAppearance();
        return this.startThickness;
    }

    moveHandleDrag(x: number, y: number): number | null {
        if (!this.draggingHandle || !this.enabled) return null;

        const cam = this.scene.camera.camera;
        const canvas = this.scene.canvas;
        const rect = canvas.getBoundingClientRect();
        const px = x - rect.left;
        const py = y - rect.top;

        cam.screenToWorld(px, py, 0, _rayOrigin);
        cam.screenToWorld(px, py, 1, _rayDir);
        _rayDir.sub(_rayOrigin).normalize();

        const refD = this._dragStartHitPoint.dot(this._dragPlaneNormal);
        const denom = _rayDir.dot(this._dragPlaneNormal);
        if (Math.abs(denom) < 1e-6) return null;

        const t = (refD - _rayOrigin.dot(this._dragPlaneNormal)) / denom;
        if (t < 0) return null;

        _currentHit.copy(_rayOrigin).add(_tmpVec.copy(_rayDir).mulScalar(t));

        const wt = this.gizmoTarget.getWorldTransform();
        const r = new Quat().setFromMat4(wt);
        _faceNormal.set(0, 1, 0);
        r.transformVector(_faceNormal, _faceNormal);

        const delta = _currentHit.clone().sub(this._dragStartHitPoint).dot(_faceNormal);
        const newT = Math.max(0.001, this.startThickness + delta);
        return newT;
    }

    endHandleDrag() {
        this.draggingHandle = false;
        this._updateHandleAppearance();
    }

    hoverHandle(x: number, y: number): boolean {
        if (!this.enabled || this.draggingHandle) return this.handleHovered;
        const hovering = this._pickHandle(x, y);
        if (hovering !== this.handleHovered) {
            this.handleHovered = hovering;
            this._updateHandleAppearance();
        }
        return hovering;
    }

    get isDraggingHandle(): boolean {
        return this.draggingHandle;
    }

    /**
     * Redraw the complete wireframe each frame using drawLine.
     *
     * Draws:
     *  1. Base face (−Y): cyan filled quad + rectangle outline + grid lines
     *  2. Limit face (+Y): pink filled quad + rectangle outline + grid lines
     *  3. Vertical edges: 4 faint lines connecting the faces
     * Then updates the capsule handle position.
     */
    onPreRender() {
        if (!this.enabled) return;

        const layer = this.scene.worldLayer;

        // transform all 8 unit-cube corners to world space
        const wt = this.gizmoTarget.getWorldTransform();
        for (let i = 0; i < 8; i++) {
            wt.transformPoint(unitCorners[i], this.worldCorners[i]);
        }

        // 1) Base face (−Y): cyan outline + grid
        this._drawFaceGrid(
            [this.worldCorners[0], this.worldCorners[1],
             this.worldCorners[3], this.worldCorners[2]],
            BASE_COLOR, BASE_GRID_COLOR, layer
        );

        // 2) Limit face (+Y): pink outline + grid
        this._drawFaceGrid(
            [this.worldCorners[4], this.worldCorners[5],
             this.worldCorners[7], this.worldCorners[6]],
            LIMIT_COLOR, LIMIT_GRID_COLOR, layer
        );

        // 3) Vertical connector edges
        for (const [i, j] of verticalEdges) {
            this.scene.app.drawLine(this.worldCorners[i], this.worldCorners[j], EDGE_COLOR, true, layer);
        }

        // 4) Update capsule handle position/size
        this._updateHandlePosition();
    }

    /**
     * Draw a rectangular face with outline border + internal grid lines.
     * @param corners - 4 world-space corners in order (bottom-left, bottom-right, top-right, top-left)
     * @param outlineColor - border color
     * @param gridColor - internal grid line color (slightly brighter)
     */
    private _drawFaceGrid(
        corners: Vec3[],
        outlineColor: Color,
        gridColor: Color,
        layer: any
    ) {
        const DIVS = 4; // 4×4 grid cells (5 lines each direction)
        const bl = corners[0], br = corners[1], tr = corners[2], tl = corners[3];
        const _a = _v, _b = _tmpVec;

        // outline border
        this.scene.app.drawLine(bl, br, outlineColor, true, layer);
        this.scene.app.drawLine(br, tr, outlineColor, true, layer);
        this.scene.app.drawLine(tr, tl, outlineColor, true, layer);
        this.scene.app.drawLine(tl, bl, outlineColor, true, layer);

        // grid lines parallel to X edge (bl→br direction)
        for (let i = 1; i < DIVS; i++) {
            const t = i / DIVS;
            _a.lerp(tl, bl, t);
            _b.lerp(tr, br, t);
            this.scene.app.drawLine(_a, _b, gridColor, true, layer);
        }
        // grid lines parallel to Z edge (bl→tl direction)
        for (let i = 1; i < DIVS; i++) {
            const t = i / DIVS;
            _a.lerp(bl, br, t);
            _b.lerp(tl, tr, t);
            this.scene.app.drawLine(_a, _b, gridColor, true, layer);
        }
    }
}

export { PlanarFixBox };
