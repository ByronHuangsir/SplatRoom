import {
    BoundingBox,
    Color,
    Entity,
    Mat4,
    Quat,
    Vec3
} from 'playcanvas';

import { Element, ElementType } from './element';
import { Serializer } from '../core/serializer';
import { Splat } from '../splat/splat';

// unit cube corner offsets ([-0.5, 0.5]^3). the crop box pivot's world transform
// maps this unit cube to the oriented world box, so transforming these 8 corners
// by the world transform yields the box vertices in world space.
const unitCorners: Vec3[] = [];
for (const x of [-0.5, 0.5]) {
    for (const y of [-0.5, 0.5]) {
        for (const z of [-0.5, 0.5]) {
            unitCorners.push(new Vec3(x, y, z));
        }
    }
}

// 12 edges of the cube as index pairs into unitCorners
const cubeEdges: [number, number][] = [
    [0, 1], [0, 2], [0, 4],
    [1, 3], [1, 5],
    [2, 3], [2, 6],
    [3, 7],
    [4, 5], [4, 6],
    [5, 7],
    [6, 7]
];

const invMat = new Mat4();
const tmpVec = new Vec3();
const tmpVec2 = new Vec3();
const worldMatTmp = new Mat4();
const bound = new BoundingBox();
const unitBound = new BoundingBox(new Vec3(0, 0, 0), new Vec3(0.5, 0.5, 0.5));
const wireColor = new Color(1.0, 0.78, 0.0, 1.0); // amber
/**
 * 线框是否参与深度测试。**必须是 false**（2026-10-02 用户实测）：
 * 盒子经常沉在模型内部（用户把盒子缩小/拉大时更是如此），带深度测试时 12 条边会被高斯挡得
 * 一个像素都看不见 —— 用户只能靠"把相机拉远到边露出模型轮廓"来找盒子，而这又让模型在画面里
 * 变成一小团（用户原话："这个显示完全没有参考价值，我无法知道我裁切到什么位置了"）。
 * 关掉深度测试后，盒子始终可见（X 光式），任何距离/任何盒子大小下都知道自己裁在哪。
 * 注意：这只影响**线框**的可见性；模型本体的裁切判据完全不变。
 */
const wireDepthTest = false;

// default padding added to the auto-fit box so it starts LARGER than the
// object's bounding box (the user shrinks it down). 0.2 = +20% on each axis
// half-extent. applied by both initializeFromSplats and orientToPCA.
const CROP_BOX_DEFAULT_MARGIN = 0.2;

// reusable world-space corner storage
const worldCorners: Vec3[] = unitCorners.map(() => new Vec3());

type CropShape = 'box' | 'cylinder' | 'sphere';

// configuration carried alongside a .ply export (see .config.json schema).
// soft_edge was removed: the fragment shader now uses a tiny fixed feather
// internally for anti-aliasing + hiding reconstruction inaccuracy near the
// boundary, so there is nothing user-configurable about edge softness.
type CropBoxConfig = {
    version: string;
    metadata: {
        generator: string;
        updated_at: string;
    };
    crop_box: {
        enabled: boolean;
        shape: CropShape;
        radius_x: number;     // R1 (X direction, pivot-local, <= 0.5)
        radius_y: number;     // R3 (Y direction, sphere only, pivot-local, <= 0.5)
        radius_z: number;     // R2 (Z direction, pivot-local, <= 0.5)
        height: number;       // cylinder total height (pivot-local units, <= 1.0)
        uniform_scale: boolean; // keep the shape regular (cube / circular / perfect sphere)
        center: [number, number, number];
        extent: [number, number, number];
        rotation_quat: [number, number, number, number];
    };
};

// Oriented crop box for fragment-level clipping of gaussian splats.
//
// The box is represented by a pivot entity whose world transform maps the unit
// cube [-0.5, 0.5]^3 to the oriented world box. The pivot's local scale carries
// 2 * half-extent on each axis, so in the pivot's local space the box is always
// the unit cube. The fragment shader transforms the splat's world position by
// the inverse of this world transform and discards fragments outside [-0.5, 0.5].
//
// The wireframe is drawn as immediate-mode lines and is therefore never subject
// to the splat clipping shader, satisfying "线框本身不受裁切逻辑影响".
class CropBox extends Element {
    // clipping state
    _enabled = true;        // apply fragment discard
    _visible = true;        // show wireframe
    /**
     * 盒外淡显（面板上的「显示外部（预览）」）。
     *
     * 2026-10-02 用户实测反馈：默认 `false`（盒外直接 discard）时，一打开裁切盒就只剩盒内那点内容，
     * "我无法知道我裁切到什么位置了" —— 屏幕失去参照价值。改成默认 `true`：盒外以 3.5% alpha 淡显，
     * 整个模型仍在视野里，盒子切在哪一目了然。**只影响显示**，真正的裁剪/导出走的是盒内判据
     * （`countSplatsInside` / `applyCropToExport`），与这个开关无关，所以不改变任何导出结果。
     */
    _preview = true;        // show outside fragments faintly instead of discarding
    _softEdge = 0.005;      // soft edge feather width (0 = laser sharp, 0.05 = soft)

    // clip shape: box | cylinder | sphere. cylinder is aligned to the pivot
    // LOCAL Y axis; sphere is centred at the pivot origin. radiusX/radiusY/
    // radiusZ are the X/Y/Z LOCAL-space radii (unit cube spans [-0.5, 0.5],
    // so radii <= 0.5). radiusX != radiusZ → elliptic cylinder (Y uses height);
    // sphere uses all three → triaxial ellipsoid. height is the cylinder's
    // TOTAL height (<= 1.0). Radii are independent of `extent` (pivot scale
    // only normalises local space).
    _shape: CropShape = 'box';
    _radiusX = 0.35;
    _radiusY = 0.35;
    _radiusZ = 0.35;
    _height = 0.8;

    // uniform-scale lock: when on, the pivot extent stays proportional so the
    // shape stays "regular" — box → cube (all axes equal), cylinder → circular
    // section (extent.x == extent.z, height independent), sphere → perfect
    // sphere (all axes equal).
    _uniformScale = false;

    // box geometry (extent = half-extents, per spec)
    _center = new Vec3(0, 0, 0);
    _extent = new Vec3(1, 1, 1);
    _rotation = new Quat();

    pivot: Entity;

    constructor() {
        super(ElementType.debug);

        this.pivot = new Entity('cropBoxPivot');
        // no render component: the wireframe is drawn as immediate-mode lines in
        // onPreRender so it is independent of the splat material/clipping shader
        this.syncPivot();
    }

    // write the canonical state into the pivot's local TRS. the pivot scale
    // carries 2 * extent so the unit cube maps to [-extent, +extent].
    private syncPivot() {
        this.pivot.setLocalPosition(this._center.x, this._center.y, this._center.z);
        this.pivot.setLocalRotation(this._rotation);
        this.pivot.setLocalScale(this._extent.x * 2, this._extent.y * 2, this._extent.z * 2);
    }

    add() {
        this.scene.contentRoot.addChild(this.pivot);
        this.scene.boundDirty = true;
    }

    remove() {
        this.scene.contentRoot.removeChild(this.pivot);
        this.scene.boundDirty = true;
    }

    destroy() {
        // nothing to free beyond the entity which the engine gc handles
    }

    serialize(serializer: Serializer): void {
        // pack the state so scene-state diffing detects changes and triggers a
        // re-render (Scene.onUpdate compares serialized state).
        serializer.packa(this.pivot.getWorldTransform().data);
        serializer.pack(this._enabled ? 1 : 0);
        serializer.pack(this._visible ? 1 : 0);
        // shape + params so switching shape / radius / height also triggers a
        // re-render (the fragment shader consumes these as uniforms).
        serializer.pack(this._shape === 'box' ? 0 : this._shape === 'cylinder' ? 1 : 2);
        serializer.pack(this._radiusX);
        serializer.pack(this._radiusY);
        serializer.pack(this._radiusZ);
        serializer.pack(this._height);
        serializer.pack(this._uniformScale ? 1 : 0);
    }

    onPreRender() {
        // keep the pivot scale in sync (extent may have changed without going
        // through the setter, e.g. via undo/redo of a ShapeTransformOp)
        this.syncPivot();

        // draw the wireframe as immediate-mode lines. lines are not splats so
        // they are never affected by the crop-box fragment shader.
        if (this._visible) {
            const wt = this.pivot.getWorldTransform();
            if (this._shape === 'box') {
                for (let i = 0; i < 8; i++) {
                    wt.transformPoint(unitCorners[i], worldCorners[i]);
                }
                for (const [a, b] of cubeEdges) {
                    this.scene.app.drawLine(worldCorners[a], worldCorners[b], wireColor, wireDepthTest, this.scene.worldLayer);
                }
            } else if (this._shape === 'cylinder') {
                // top + bottom circles (local XZ plane, radius _radius) + 4 meridians.
                // _radius / _height are pivot-local units; the pivot's world
                // transform maps them to the world (with extent stretch applied).
                const h = this._height * 0.5;
                const rx = this._radiusX;
                const rz = this._radiusZ;
                const segs = 48;
                const a = new Vec3(), b = new Vec3();
                const aw = new Vec3(), bw = new Vec3();
                for (let i = 0; i < segs; i++) {
                    const t0 = (i / segs) * Math.PI * 2;
                    const t1 = ((i + 1) / segs) * Math.PI * 2;
                    // top ellipse (rx, rz)
                    a.set(Math.cos(t0) * rx, h, Math.sin(t0) * rz);
                    b.set(Math.cos(t1) * rx, h, Math.sin(t1) * rz);
                    wt.transformPoint(a, aw); wt.transformPoint(b, bw);
                    this.scene.app.drawLine(aw, bw, wireColor, wireDepthTest, this.scene.worldLayer);
                    // bottom ellipse
                    a.y = -h; b.y = -h;
                    wt.transformPoint(a, aw); wt.transformPoint(b, bw);
                    this.scene.app.drawLine(aw, bw, wireColor, wireDepthTest, this.scene.worldLayer);
                }
                // 4 meridians at 90° steps
                for (let i = 0; i < 4; i++) {
                    const t = (i / 4) * Math.PI * 2;
                    a.set(Math.cos(t) * rx, h, Math.sin(t) * rz);
                    b.set(Math.cos(t) * rx, -h, Math.sin(t) * rz);
                    wt.transformPoint(a, aw); wt.transformPoint(b, bw);
                    this.scene.app.drawLine(aw, bw, wireColor, wireDepthTest, this.scene.worldLayer);
                }
            } else {
                // ellipsoid: 3 orthogonal great ellipses (XY / XZ / YZ planes)
                // with radii (rx, ry, rz) — triaxial ellipsoid
                const rx = this._radiusX;
                const rz = this._radiusZ;
                const ry = this._radiusY;
                const segs = 48;
                const a = new Vec3(), b = new Vec3();
                const aw = new Vec3(), bw = new Vec3();
                for (let i = 0; i < segs; i++) {
                    const t0 = (i / segs) * Math.PI * 2;
                    const t1 = ((i + 1) / segs) * Math.PI * 2;
                    const c0 = Math.cos(t0), s0 = Math.sin(t0);
                    const c1 = Math.cos(t1), s1 = Math.sin(t1);
                    // XY ellipse (rx, ry)
                    a.set(c0 * rx, s0 * ry, 0); b.set(c1 * rx, s1 * ry, 0);
                    wt.transformPoint(a, aw); wt.transformPoint(b, bw);
                    this.scene.app.drawLine(aw, bw, wireColor, wireDepthTest, this.scene.worldLayer);
                    // XZ ellipse (rx, rz)
                    a.set(c0 * rx, 0, s0 * rz); b.set(c1 * rx, 0, s1 * rz);
                    wt.transformPoint(a, aw); wt.transformPoint(b, bw);
                    this.scene.app.drawLine(aw, bw, wireColor, wireDepthTest, this.scene.worldLayer);
                    // YZ ellipse (ry, rz)
                    a.set(0, c0 * ry, s0 * rz); b.set(0, c1 * ry, s1 * rz);
                    wt.transformPoint(a, aw); wt.transformPoint(b, bw);
                    this.scene.app.drawLine(aw, bw, wireColor, wireDepthTest, this.scene.worldLayer);
                }
            }
        }
    }

    // the inverse world matrix data (column-major Float32Array of length 16),
    // consumed by the splat material's uCropBoxInverseMatrix uniform.
    get inverseMatrixData(): Float32Array {
        invMat.copy(this.pivot.getWorldTransform()).invert();
        return invMat.data;
    }

    get enabled(): boolean {
        return this._enabled;
    }
    set enabled(v: boolean) {
        if (v !== this._enabled) {
            this._enabled = v;
            this.scene?.events.fire('cropBox.changed');
            this.scene.forceRender = true;
        }
    }

    get visible(): boolean {
        return this._visible;
    }
    set visible(v: boolean) {
        if (v !== this._visible) {
            this._visible = v;
            this.scene?.events.fire('cropBox.changed');
            this.scene.forceRender = true;
        }
    }

    get preview(): boolean {
        return this._preview;
    }
    set preview(v: boolean) {
        if (v !== this._preview) {
            this._preview = v;
            this.scene?.events.fire('cropBox.changed');
            this.scene.forceRender = true;
        }
    }

    get softEdge(): number {
        return this._softEdge;
    }
    set softEdge(v: number) {
        v = Math.max(0, Math.min(0.05, v));
        if (v !== this._softEdge) {
            this._softEdge = v;
            this.scene?.events.fire('cropBox.changed');
            this.scene.forceRender = true;
        }
    }

    get shape(): CropShape {
        return this._shape;
    }
    set shape(v: CropShape) {
        if (v !== this._shape) {
            this._shape = v;
            if (this._uniformScale) this.enforceUniformExtent(null);
            this.scene?.events.fire('cropBox.changed');
            this.scene.events.fire('cropBox.shapeChanged', v);
            this.scene.forceRender = true;
        }
    }

    get radiusX(): number {
        return this._radiusX;
    }
    set radiusX(v: number) {
        v = Math.max(0.02, Math.min(0.5, v));
        if (v !== this._radiusX) {
            this._radiusX = v;
            // uniform lock: keep all radii equal (circular section / perfect sphere)
            if (this._uniformScale && this._radiusZ !== v) {
                this._radiusZ = v;
            }
            if (this._uniformScale && this._shape === 'sphere' && this._radiusY !== v) {
                this._radiusY = v;
            }
            this.scene?.events.fire('cropBox.changed');
            this.scene.forceRender = true;
        }
    }

    get radiusY(): number {
        return this._radiusY;
    }
    set radiusY(v: number) {
        v = Math.max(0.02, Math.min(0.5, v));
        if (v !== this._radiusY) {
            this._radiusY = v;
            // uniform lock: keep all radii equal (perfect sphere)
            if (this._uniformScale && this._radiusX !== v) {
                this._radiusX = v;
            }
            if (this._uniformScale && this._radiusZ !== v) {
                this._radiusZ = v;
            }
            this.scene?.events.fire('cropBox.changed');
            this.scene.forceRender = true;
        }
    }

    get radiusZ(): number {
        return this._radiusZ;
    }
    set radiusZ(v: number) {
        v = Math.max(0.02, Math.min(0.5, v));
        if (v !== this._radiusZ) {
            this._radiusZ = v;
            // uniform lock: keep all radii equal (circular section / perfect sphere)
            if (this._uniformScale && this._radiusX !== v) {
                this._radiusX = v;
            }
            if (this._uniformScale && this._shape === 'sphere' && this._radiusY !== v) {
                this._radiusY = v;
            }
            this.scene?.events.fire('cropBox.changed');
            this.scene.forceRender = true;
        }
    }

    get height(): number {
        return this._height;
    }
    set height(v: number) {
        v = Math.max(0.05, Math.min(1.0, v));
        if (v !== this._height) {
            this._height = v;
            this.scene?.events.fire('cropBox.changed');
            this.scene.forceRender = true;
        }
    }

    /** True when the clip shape is not a box (cylinder/sphere). */
    get isNonBox(): boolean {
        return this._shape !== 'box';
    }

    get uniformScale(): boolean {
        return this._uniformScale;
    }
    set uniformScale(v: boolean) {
        if (v !== this._uniformScale) {
            this._uniformScale = v;
            if (v) {
                this.enforceUniformExtent(null);
                // radii become equal — circular section (cylinder) / perfect sphere
                const r = Math.max(this._radiusX, this._radiusZ, this._radiusY);
                this._radiusX = r;
                this._radiusZ = r;
                this._radiusY = r;
            }
            this.scene?.events.fire('cropBox.changed');
            this.scene.forceRender = true;
        }
    }

    /**
     * Enforce proportional extent for the current shape (uniform-scale lock):
     *   box / sphere → all three axes equal (cube / perfect sphere)
     *   cylinder     → extent.x == extent.z (circular section), Y independent
     *
     * `prev` = the extent BEFORE the change. Pass null for "initialize"-style
     * calls (turning the lock on, switching shapes) — there we keep the current
     * size by taking max(). When `prev` is given, the axis that changed the
     * MOST becomes the driving value and the others follow it, so dragging one
     * handle pulls the other faces/radii along ("other faces follow towards
     * the centroid"): box → all three axes = the driven axis; cylinder → the
     * two radius directions (x/z) stay equal, height (y) stays free; sphere →
     * all three axes equal.
     */
    private enforceUniformExtent(prev: Vec3 | null) {
        // axis accessors (Vec3 has no numeric index signature)
        const getAxis = (v: Vec3, i: number) => (i === 0 ? v.x : i === 1 ? v.y : v.z);
        const drivingAxis = (): number => {
            let a = 0;
            let maxDiff = -1;
            for (let i = 0; i < 3; i++) {
                const d = Math.abs(getAxis(this._extent, i) - getAxis(prev!, i));
                if (d > maxDiff) {
                    maxDiff = d; a = i;
                }
            }
            return a;
        };
        if (this._shape === 'cylinder') {
            if (prev) {
                const a = drivingAxis();
                if (a === 1) {
                    // height axis changed → radius directions keep equal (R1 = R2)
                    const r = Math.max(this._extent.x, this._extent.z);
                    this._extent.x = r;
                    this._extent.z = r;
                } else {
                    const u = getAxis(this._extent, a);
                    this._extent.x = u;
                    this._extent.z = u;
                }
            } else {
                const m = Math.max(this._extent.x, this._extent.z);
                this._extent.x = m;
                this._extent.z = m;
            }
        } else {
            if (prev) {
                const u = getAxis(this._extent, drivingAxis());
                this._extent.set(u, u, u);
            } else {
                const m = Math.max(this._extent.x, this._extent.y, this._extent.z);
                this._extent.set(m, m, m);
            }
        }
        this.syncPivot();
        this.updateBound();
    }

    get center(): Vec3 {
        return this._center;
    }
    get extent(): Vec3 {
        return this._extent;
    }
    get rotation(): Quat {
        return this._rotation;
    }

    // current rotation as XYZ Euler angles in degrees. used by the panel's
    // numeric rotation inputs so the user can read & type rotation in degrees
    // instead of a quaternion. (PlayCanvas Quat.getEulerAngles returns XYZ.)
    getRotationEulerDegrees(out: Vec3): Vec3 {
        const e = this._rotation.getEulerAngles();
        out.set(e.x, e.y, e.z);
        return out;
    }

    // set rotation from XYZ Euler angles (degrees), keeping center & extent
    // unchanged. fires a single change notification.
    setRotationEulerDegrees(x: number, y: number, z: number) {
        this._rotation.setFromEulerAngles(x, y, z);
        this.syncPivot();
        this.updateBound();
        this.scene?.events.fire('cropBox.changed');
        this.scene.forceRender = true;
    }

    // apply a full state set (used by gizmo / ui / undo-redo / config load).
    // triggers a single change notification.
    setState(center: Vec3, extent: Vec3, rotation: Quat) {
        // snapshot the pre-change extent so the uniform lock can pick the
        // DRIVING axis (the one that changed most) and pull the others along
        const prev = this._uniformScale ? this._extent.clone() : null;
        this._center.copy(center);
        this._extent.copy(extent);
        this._rotation.copy(rotation);
        if (this._uniformScale) this.enforceUniformExtent(prev);
        this.syncPivot();
        this.updateBound();
        this.scene?.events.fire('cropBox.changed');
        this.scene.forceRender = true;
    }

    // called after the gizmo has moved the pivot directly. reads the pivot's
    // transform back into the canonical state. when scaled, the gizmo sets the
    // pivot scale to 2*extent, so extent = scale / 2.
    movedFromPivot(scaleChanged: boolean) {
        // snapshot before reading the pivot back, for the uniform-lock driving
        // axis selection
        const prev = this._uniformScale ? this._extent.clone() : null;
        const p = this.pivot.getLocalPosition();
        const r = this.pivot.getLocalRotation();
        this._center.set(p.x, p.y, p.z);
        this._rotation.copy(r);
        if (scaleChanged) {
            const s = this.pivot.getLocalScale();
            // clamp to a small positive minimum to avoid degenerate boxes
            this._extent.set(Math.max(0.001, s.x * 0.5), Math.max(0.001, s.y * 0.5), Math.max(0.001, s.z * 0.5));
        }
        if (this._uniformScale) this.enforceUniformExtent(prev);
        this.syncPivot();
        this.updateBound();
        this.scene?.events.fire('cropBox.changed');
        this.scene.forceRender = true;
    }

    moved() {
        this.updateBound();
        this.scene?.events.fire('cropBox.changed');
        this.scene.forceRender = true;
    }

    updateBound() {
        this.syncPivot();
        bound.setFromTransformedAabb(unitBound, this.pivot.getWorldTransform());
        if (this.scene) {
            this.scene.boundDirty = true;
        }
    }

    get worldBound(): BoundingBox | null {
        return bound;
    }

    /**
     * Test whether a WORLD-space point lies inside the crop shape
     * (box / elliptic cylinder / ellipsoid). Used by export to mark
     * clipped-out gaussians as deleted so the saved file matches the crop.
     */
    isPointInsideWorld(worldX: number, worldY: number, worldZ: number): boolean {
        invMat.copy(this.pivot.getWorldTransform()).invert();
        tmpVec.set(worldX, worldY, worldZ);
        invMat.transformPoint(tmpVec, tmpVec2);
        const lx = tmpVec2.x, ly = tmpVec2.y, lz = tmpVec2.z;
        if (this._shape === 'box') {
            return Math.abs(lx) <= 0.5 && Math.abs(ly) <= 0.5 && Math.abs(lz) <= 0.5;
        } else if (this._shape === 'cylinder') {
            const rx = this._radiusX, rz = this._radiusZ;
            const ex = lx / rx, ez = lz / rz;
            return ex * ex + ez * ez <= 1.0 && Math.abs(ly) <= this._height * 0.5;
        }
        const rx = this._radiusX, ry = this._radiusY, rz = this._radiusZ;
        const ex = lx / rx, ey = ly / ry, ez = lz / rz;
        return ex * ex + ey * ey + ez * ez <= 1.0;

    }

    // ---- smart initialization ------------------------------------------------

    // Compute an initial crop box from the loaded splats using statistical
    // outlier filtering: drop the 5% of points farthest from the centroid, then
    // take the AABB of the remaining 95% core. The box is centered on the
    // centroid and axis-aligned (identity rotation). Returns true on success.
    // count splats whose world-space center falls inside the box. this is a
    // center-based approximation (not per-fragment), so straddling gaussians
    // whose center is outside but whose ellipsoid extends into the box will
    // not be counted. for the panel's "N gaussians kept" readout this is the
    // right level of fidelity — fragment-exact counting would require a GPU
    // occlusion query and is impractical to run on every box change.
    countSplatsInside(splats: Splat[]): { inside: number, total: number } {
        let inside = 0;
        let total = 0;
        invMat.copy(this.pivot.getWorldTransform()).invert();
        for (const splat of splats) {
            if (!splat || !splat.visible || !splat.splatData) continue;
            const xs = splat.splatData.getProp('x') as Float32Array | null;
            const ys = splat.splatData.getProp('y') as Float32Array | null;
            const zs = splat.splatData.getProp('z') as Float32Array | null;
            if (!xs || !ys || !zs) continue;

            worldMatTmp.copy(splat.worldTransform);
            const n = splat.splatData.numSplats;
            const state = splat.splatData.getProp('state') as Uint8Array | null;
            for (let i = 0; i < n; i++) {
                // skip deleted splats (bit 2 of state byte)
                if (state && (state[i] & 4) !== 0) continue;
                total++;
                tmpVec.set(xs[i], ys[i], zs[i]);
                worldMatTmp.transformPoint(tmpVec, tmpVec2);
                invMat.transformPoint(tmpVec2, tmpVec);
                if (this._shape === 'box') {
                    if (tmpVec.x >= -0.5 && tmpVec.x <= 0.5 &&
                        tmpVec.y >= -0.5 && tmpVec.y <= 0.5 &&
                        tmpVec.z >= -0.5 && tmpVec.z <= 0.5) {
                        inside++;
                    }
                } else if (this._shape === 'cylinder') {
                    // elliptic cylinder: (x/rx)^2 + (z/rz)^2 <= 1, |y| <= h/2
                    const rx = this._radiusX, rz = this._radiusZ;
                    const ex = tmpVec.x / rx;
                    const ez = tmpVec.z / rz;
                    if (ex * ex + ez * ez <= 1.0 &&
                        Math.abs(tmpVec.y) <= this._height * 0.5) {
                        inside++;
                    }
                } else { // sphere — triaxial ellipsoid (x/rx)^2 + (y/ry)^2 + (z/rz)^2 <= 1
                    const rx = this._radiusX, ry = this._radiusY, rz = this._radiusZ;
                    const ex = tmpVec.x / rx;
                    const ey = tmpVec.y / ry;
                    const ez = tmpVec.z / rz;
                    if (ex * ex + ey * ey + ez * ez <= 1.0) {
                        inside++;
                    }
                }
            }
        }
        return { inside, total };
    }

    // ---- helpers: collect world-space centers into a flat number[] for PCA / init ----

    // collect visible non-deleted splat centers as flat (x,y,z) triples. returns null
    // if no valid points. shared by initializeFromSplats and orientToPCA.
    private collectWorldCenters(splats: Splat[]): { points: number[]; count: number } | null {
        const valid = splats.filter(s => s && s.visible && s.splatData);
        if (valid.length === 0) return null;

        const points: number[] = [];
        const worldMat = new Mat4();
        for (const splat of valid) {
            const xs = splat.splatData.getProp('x') as Float32Array | null;
            const ys = splat.splatData.getProp('y') as Float32Array | null;
            const zs = splat.splatData.getProp('z') as Float32Array | null;
            if (!xs || !ys || !zs) continue;

            worldMat.copy(splat.worldTransform);
            const n = splat.splatData.numSplats;
            const state = splat.splatData.getProp('state') as Uint8Array | null;
            for (let i = 0; i < n; i++) {
                if (state && (state[i] & 4) !== 0) continue;
                tmpVec.set(xs[i], ys[i], zs[i]);
                worldMat.transformPoint(tmpVec, tmpVec2);
                points.push(tmpVec2.x, tmpVec2.y, tmpVec2.z);
            }
        }

        const count = points.length / 3;
        if (count === 0) return null;
        return { points, count };
    }

    // Reorient the current crop box so its axes align with the point cloud's
    // principal axes (PCA). Keizer / Vj
    // principal axes (PCA / inertia tensor eigenvectors).
    // Center and extent are recomputed as the oriented bounding box (OBB) of the
    // 95% core of points (5% outlier filter) in the PCA frame.
    // Returns true on success.
    orientToPCA(splats: Splat[]): boolean {
        const collected = this.collectWorldCenters(splats);
        if (!collected) return false;
        const { points, count } = collected;

        // ---- centroid ----
        const centroid = new Vec3(0, 0, 0);
        for (let i = 0; i < count; i++) {
            centroid.x += points[i * 3];
            centroid.y += points[i * 3 + 1];
            centroid.z += points[i * 3 + 2];
        }
        centroid.mulScalar(1 / count);

        // ---- inertia / covariance matrix (symmetric 3x3, C_ij = sum (dx_i dx_j) ----
        let c00 = 0, c01 = 0, c02 = 0, c11 = 0, c12 = 0, c22 = 0;
        for (let i = 0; i < count; i++) {
            const dx = points[i * 3]     - centroid.x;
            const dy = points[i * 3 + 1] - centroid.y;
            const dz = points[i * 3 + 2] - centroid.z;
            c00 += dx * dx;
            c01 += dx * dy;
            c02 += dx * dz;
            c11 += dy * dy;
            c12 += dy * dz;
            c22 += dz * dz;
        }
        const nf = 1 / Math.max(1, count - 1);
        c00 *= nf; c01 *= nf; c02 *= nf; c11 *= nf; c12 *= nf; c22 *= nf;

        // ---- 3x3 symmetric eigendecomposition: Jacobi iterations (robust & simple)
        // Returns eigenvalues eig[0..2] DESCENDING and eigenvectors as columns of mat[0..2,0..2].
        const eig = new Float64Array(3);
        const ev = new Float64Array(9); // column-major: ev[col*3+row]
        // initialize identity
        ev[0] = 1; ev[4] = 1; ev[8] = 1;
        // working copy of the covariance
        const a = new Float64Array([c00, c01, c02, c01, c11, c12, c02, c12, c22]); // row-major symmetric
        for (let iter = 0; iter < 50; iter++) {
            // find largest off-diagonal
            let p = 0, q = 1;
            let maxA = Math.abs(a[0 * 3 + 1]);
            {
                const v02 = Math.abs(a[0 * 3 + 2]);
                const v12 = Math.abs(a[1 * 3 + 2]);
                if (v02 > maxA) {
                    maxA = v02; p = 0; q = 2;
                }
                if (v12 > maxA) {
                    maxA = v12; p = 1; q = 2;
                }
            }
            if (maxA < 1e-12) break;

            const app = a[p * 3 + p];
            const aqq = a[q * 3 + q];
            const apq = a[p * 3 + q];
            const theta = (aqq - app) / (2 * apq);
            const t = theta >= 0 ? 1 / (theta + Math.sqrt(1 + theta * theta)) :
                1 / (theta - Math.sqrt(1 + theta * theta));
            const c = 1 / Math.sqrt(1 + t * t);
            const s = t * c;

            // rotate a
            a[p * 3 + p] = app - t * apq;
            a[q * 3 + q] = aqq + t * apq;
            a[p * 3 + q] = 0;
            a[q * 3 + p] = 0;
            for (let i = 0; i < 3; i++) {
                if (i !== p && i !== q) {
                    const aip = a[i * 3 + p];
                    const aiq = a[i * 3 + q];
                    a[i * 3 + p] = c * aip - s * aiq;
                    a[p * 3 + i] = a[i * 3 + p];
                    a[i * 3 + q] = s * aip + c * aiq;
                    a[q * 3 + i] = a[i * 3 + q];
                }
            }
            // accumulate eigenvector rotation (ev is column-major 3x3)
            for (let i = 0; i < 3; i++) {
                const vip = ev[p * 3 + i];
                const viq = ev[q * 3 + i];
                ev[p * 3 + i] = c * vip - s * viq;
                ev[q * 3 + i] = s * vip + c * viq;
            }
        }
        eig[0] = a[0]; eig[1] = a[4]; eig[2] = a[8];

        // ---- sort eigenvalues descending by index ----
        const idx = [0, 1, 2];
        idx.sort((i, j) => eig[j] - eig[i]);
        const axisX = new Vec3(ev[idx[0] * 3 + 0], ev[idx[0] * 3 + 1], ev[idx[0] * 3 + 2]);
        const axisY = new Vec3(ev[idx[1] * 3 + 0], ev[idx[1] * 3 + 1], ev[idx[1] * 3 + 2]);
        const axisZ = new Vec3(ev[idx[2] * 3 + 0], ev[idx[2] * 3 + 1], ev[idx[2] * 3 + 2]);

        // enforce right-handed: if det([axisX axisY axisZ]) < 0 → flip axisZ
        tmpVec.cross(axisX, axisY);
        if (tmpVec.dot(axisZ) < 0) axisZ.mulScalar(-1);
        axisX.normalize(); axisY.normalize(); axisZ.normalize();

        // ---- 95% outlier filter in world space (reuse distances from centroid) ----
        const dists = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            const dx = points[i * 3] - centroid.x;
            const dy = points[i * 3 + 1] - centroid.y;
            const dz = points[i * 3 + 2] - centroid.z;
            dists[i] = dx * dx + dy * dy + dz * dz;
        }
        const sorted = Float32Array.from(dists).sort();
        const threshold = sorted[Math.floor(count * 0.95)];

        // transform core 95% points into PCA frame; compute AABB there
        let mnx = Infinity, mny = Infinity, mnz = Infinity;
        let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
        const ax = new Vec3(), ay = new Vec3(), az = new Vec3();
        for (let i = 0; i < count; i++) {
            if (dists[i] > threshold) continue;
            const dx = points[i * 3]     - centroid.x;
            const dy = points[i * 3 + 1] - centroid.y;
            const dz = points[i * 3 + 2] - centroid.z;
            const u = dx * axisX.x + dy * axisX.y + dz * axisX.z;
            const v = dx * axisY.x + dy * axisY.y + dz * axisY.z;
            const w = dx * axisZ.x + dy * axisZ.y + dz * axisZ.z;
            if (u < mnx) mnx = u; if (u > mxx) mxx = u;
            if (v < mny) mny = v; if (v > mxy) mxy = v;
            if (w < mnz) mnz = w; if (w > mxz) mxz = w;
        }
        // edge case: no points survived the filter → fall back to all points
        if (!isFinite(mnx)) {
            for (let i = 0; i < count; i++) {
                const dx = points[i * 3] - centroid.x;
                const dy = points[i * 3 + 1] - centroid.y;
                const dz = points[i * 3 + 2] - centroid.z;
                const u = dx * axisX.x + dy * axisX.y + dz * axisX.z;
                const v = dx * axisY.x + dy * axisY.y + dz * axisY.z;
                const w = dx * axisZ.x + dy * axisZ.y + dz * axisZ.z;
                if (u < mnx) mnx = u; if (u > mxx) mxx = u;
                if (v < mny) mny = v; if (v > mxy) mxy = v;
                if (w < mnz) mnz = w; if (w > mxz) mxz = w;
            }
        }

        // OBB center = centroid + 0.5*(min+max) expressed in PCA axes
        const cu = (mnx + mxx) * 0.5;
        const cv = (mny + mxy) * 0.5;
        const cw = (mnz + mxz) * 0.5;
        const newCenter = new Vec3(
            centroid.x + cu * axisX.x + cv * axisY.x + cw * axisZ.x,
            centroid.y + cu * axisX.y + cv * axisY.y + cw * axisZ.y,
            centroid.z + cu * axisX.z + cv * axisY.z + cw * axisZ.z
        );
        const newExtent = new Vec3(
            Math.max(0.001, (mxx - mnx) * 0.5),
            Math.max(0.001, (mxy - mny) * 0.5),
            Math.max(0.001, (mxz - mnz) * 0.5)
        );
        // pad the auto-fit box so it starts larger than the object's OBB
        const m = 1 + CROP_BOX_DEFAULT_MARGIN;
        newExtent.mulScalar(m);

        // rotation quaternion from column matrix [axisX axisY axisZ]
        // Quat.setFromMat4 expects a pure-rotation 4x4
        const rotMat = new Mat4();
        rotMat.data[0] = axisX.x; rotMat.data[1] = axisX.y; rotMat.data[2] = axisX.z; rotMat.data[3] = 0;
        rotMat.data[4] = axisY.x; rotMat.data[5] = axisY.y; rotMat.data[6] = axisY.z; rotMat.data[7] = 0;
        rotMat.data[8] = axisZ.x; rotMat.data[9] = axisZ.y; rotMat.data[10] = axisZ.z; rotMat.data[11] = 0;
        rotMat.data[12] = 0; rotMat.data[13] = 0; rotMat.data[14] = 0; rotMat.data[15] = 1;
        const newRot = new Quat();
        newRot.setFromMat4(rotMat);
        newRot.normalize();

        this.setState(newCenter, newExtent, newRot);
        return true;
    }

    initializeFromSplats(splats: Splat[]): boolean {
        const collected = this.collectWorldCenters(splats);
        if (!collected) return false;
        const { points, count } = collected;

        // centroid
        const cx = points[0], cy = points[1], cz = points[2];
        const centroid = new Vec3(cx, cy, cz);
        for (let i = 1; i < count; i++) {
            centroid.x += points[i * 3];
            centroid.y += points[i * 3 + 1];
            centroid.z += points[i * 3 + 2];
        }
        centroid.mulScalar(1 / count);

        // distance of each point to the centroid
        const dists = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            const dx = points[i * 3] - centroid.x;
            const dy = points[i * 3 + 1] - centroid.y;
            const dz = points[i * 3 + 2] - centroid.z;
            dists[i] = dx * dx + dy * dy + dz * dz;
        }

        // find the 95th percentile distance threshold via a sorted copy
        const sorted = Float32Array.from(dists).sort();
        const thresholdIndex = Math.floor(count * 0.95);
        const threshold = sorted[thresholdIndex];

        // AABB of the core 95% (points with distance <= threshold)
        const min = new Vec3(Infinity, Infinity, Infinity);
        const max = new Vec3(-Infinity, -Infinity, -Infinity);
        let included = 0;
        for (let i = 0; i < count; i++) {
            if (dists[i] <= threshold) {
                const px = points[i * 3];
                const py = points[i * 3 + 1];
                const pz = points[i * 3 + 2];
                if (px < min.x) min.x = px;
                if (py < min.y) min.y = py;
                if (pz < min.z) min.z = pz;
                if (px > max.x) max.x = px;
                if (py > max.y) max.y = py;
                if (pz > max.z) max.z = pz;
                included++;
            }
        }

        if (included === 0) return false;

        const center = new Vec3().add2(min, max).mulScalar(0.5);
        const extent = new Vec3().sub2(max, min).mulScalar(0.5);

        // pad the default box so it comfortably contains the object (starts
        // larger than the snug AABB) — gives the user room to shrink it.
        const m = 1 + CROP_BOX_DEFAULT_MARGIN;
        extent.mulScalar(m);

        this.setState(center, extent, new Quat());
        return true;
    }

    // ---- config serialization (sidecar .config.json) -------------------------

    toConfig(): CropBoxConfig {
        return {
            version: '1.3',
            metadata: {
                generator: 'SuperSplat-Private-Custom',
                updated_at: new Date().toISOString()
            },
            crop_box: {
                enabled: this._enabled,
                shape: this._shape,
                radius_x: this._radiusX,
                radius_y: this._radiusY,
                radius_z: this._radiusZ,
                height: this._height,
                uniform_scale: this._uniformScale,
                center: [this._center.x, this._center.y, this._center.z],
                extent: [this._extent.x, this._extent.y, this._extent.z],
                rotation_quat: [this._rotation.x, this._rotation.y, this._rotation.z, this._rotation.w]
            }
        };
    }

    fromConfig(config: CropBoxConfig): boolean {
        try {
            const cb = config.crop_box;
            this._enabled = !!cb.enabled;
            if (cb.shape === 'cylinder' || cb.shape === 'sphere') {
                this._shape = cb.shape;
            } else {
                this._shape = 'box';
            }
            // v1.3: radius_x / radius_z (fall back to legacy single `radius`)
            const legacyR = Math.max(0.02, Math.min(0.5, (cb as any).radius ?? 0.35));
            this._radiusX = Math.max(0.02, Math.min(0.5, cb.radius_x ?? legacyR));
            this._radiusZ = Math.max(0.02, Math.min(0.5, cb.radius_z ?? legacyR));
            // v1.4: radius_y (sphere's Y radius; fall back to radius_x for old files)
            this._radiusY = Math.max(0.02, Math.min(0.5, cb.radius_y ?? this._radiusX));
            this._height = Math.max(0.05, Math.min(1.0, cb.height ?? 0.8));
            this._uniformScale = !!cb.uniform_scale;
            this._center.set(cb.center[0] ?? 0, cb.center[1] ?? 0, cb.center[2] ?? 0);
            const ex = cb.extent;
            this._extent.set(
                Math.max(0.001, ex[0] ?? 1),
                Math.max(0.001, ex[1] ?? 1),
                Math.max(0.001, ex[2] ?? 1)
            );
            const q = cb.rotation_quat;
            this._rotation.set(q[0] ?? 0, q[1] ?? 0, q[2] ?? 0, q[3] ?? 1);
            this.syncPivot();
            this.updateBound();
            this.scene?.events.fire('cropBox.changed');
            this.scene.forceRender = true;
            return true;
        } catch (e) {
            return false;
        }
    }
}

export { CropBox, CropBoxConfig };
