import {
    PRIMITIVE_LINES,
    Entity,
    Mesh,
    MeshInstance,
    ShaderMaterial,
    Vec3
} from 'playcanvas';

import { Element, ElementType } from './element';
import { vertexShader, fragmentShader } from './shaders/debug-shader';
import { AnimationController } from './animation/animation-controller';
import { TrackId } from './animation/animation-data';

// Temp vectors for geometry calculation (module-scope to avoid allocations)
const tmpA = new Vec3();
const tmpB = new Vec3();
const tmpC = new Vec3();
const tmpD = new Vec3();

// Color constants (RGBA 0-255)
const COLOR_POS_PATH = [255, 140, 0, 255];       // orange
const COLOR_TGT_PATH = [155, 89, 182, 255];     // purple
const COLOR_CONNECT = [120, 120, 120, 100];     // grey, semi-transparent
const COLOR_KF_MARKER = [255, 255, 255, 255];   // white
const COLOR_CURRENT = [0, 255, 0, 255];         // green
const COLOR_CP_NORMAL = [0, 200, 255, 255];     // cyan - control point normal
const COLOR_CP_HOVER = [255, 255, 0, 255];      // yellow - control point hovered
const COLOR_CP_DRAG = [255, 100, 0, 255];       // orange-red - control point dragging
const COLOR_KF_HOVER = [255, 255, 120, 255];    // bright yellow - keyframe hovered
const COLOR_KF_DRAG = [255, 150, 0, 255];       // orange - keyframe dragging
// Cone (direction control, in front of camera) — warm orange/amber
const COLOR_CONE_LINE = [255, 180, 80, 180];       // amber, semi-transparent
const COLOR_CONE_NORMAL = [255, 160, 50, 255];     // orange
const COLOR_CONE_HOVER = [255, 220, 80, 255];      // bright amber
const COLOR_CONE_DRAG = [255, 100, 0, 255];        // deep orange
// Sphere (focal-length control, behind camera) — cool blue
const COLOR_SPHERE_LINE = [80, 160, 255, 140];     // blue, semi-transparent
const COLOR_SPHERE_NORMAL = [80, 150, 255, 255];   // blue
const COLOR_SPHERE_HOVER = [130, 200, 255, 255];   // bright blue
const COLOR_SPHERE_DRAG = [40, 255, 180, 255];     // teal

const PUSH_LINE = (positions: number[], colors: number[], a: Vec3, b: Vec3, color: number[]) => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    colors.push(...color, ...color);
};

/** Push a thick line by rendering N parallel copies offset perpendicular to the segment.
 *  Each copy is offset by ±offset * i pixels in world space. */
const PUSH_THICK_LINE = (positions: number[], colors: number[], a: Vec3, b: Vec3,
                         color: number[], thicknessPx: number, worldPerPixel: number) => {
    if (thicknessPx <= 1) {
        PUSH_LINE(positions, colors, a, b, color);
        return;
    }
    const dir = tmpA.sub2(b, a).normalize();
    // Perpendicular world vector: cross segment dir with camera-relative up
    const up = Math.abs(dir.y) < 0.99 ? Vec3.UP : Vec3.RIGHT;
    const perp = tmpB.cross(dir, up).normalize();
    const offset = worldPerPixel * thicknessPx * 0.5;
    const copies = Math.floor(thicknessPx);
    const step = (2 * offset) / Math.max(copies - 1, 1);
    for (let i = 0; i < copies; i++) {
        const o = -offset + i * step;
        positions.push(
            a.x + perp.x * o, a.y + perp.y * o, a.z + perp.z * o,
            b.x + perp.x * o, b.y + perp.y * o, b.z + perp.z * o
        );
        colors.push(...color, ...color);
    }
};

/**
 * 3D Camera path visualization in the scene.
 * Draws:
 *   - Position path (orange line)
 *   - Keyframe markers (white boxes)
 *   - Control points (cyan diamonds, draggable)
 *   - Live frustum (green) — camera position marker + direction arrow
 *     + near/far planes + FOV edges, updated frame-by-frame during playback
 */
class CameraPath3D extends Element {
    entity: Entity;
    mesh: Mesh;
    material: ShaderMaterial;
    meshInstance: MeshInstance;
    dirty = true;

    // Guard: prevents re-entrant rebuildMesh calls
    private _isRebuilding = false;
    private _meshInitialized = false;

    // ---- Live frustum visualization (separate mesh for frame-by-frame updates) ----
    frustumDirty = true;
    private _frustumEntity: Entity;
    private _frustumMesh: Mesh;
    private _frustumMeshInstance: MeshInstance;

    // Current frame for highlight marker
    currentFrame = 0;

    // Control point data (exposed for interaction layer)
    controlPoints: Vec3[] = [];
    controlPointFrames: number[] = [];
    controlPointIndices: Array<{vertexStart: number; vertexCount: number; isHovered: boolean; isDragging: boolean}> = [];
    // Full color array (kept for incremental updates)
    private _colorArray: Uint8Array = new Uint8Array(0);
    private _positionArray: number[] = [];

    // Segment boundaries: which CP indices belong to which keyframe interval
    // Used during drag to apply smooth displacement to adjacent CPs
    private _segmentBoundaries: Array<{startIdx: number; endIdx: number; startFrame: number; endFrame: number}> = [];

    // Keyframe marker data (exposed for interaction layer)
    kfMarkers: Vec3[] = [];
    kfMarkerFrames: number[] = [];
    kfMarkerIndices: Array<{vertexStart: number; vertexCount: number}> = [];

    // Cone data (direction control, placed near camera along the forward direction)
    // Dragging the cone changes the camera look direction (value[3-5]) without affecting FOV.
    kfConePositions: Vec3[] = [];
    kfConeIndices: Array<{vertexStart: number; vertexCount: number; hasLine: boolean}> = [];
    // Actual target distances from camera center — used to map cone drag back to target position
    kfTargetDistances: number[] = [];
    // Sphere data (focal-length control, behind camera)
    // The sphere lies on the opposite side of the camera from the target.
    // Distance from camera to sphere determines FOV — closer = wider, farther = tele.
    kfSpherePositions: Vec3[] = [];
    kfSphereIndices: Array<{vertexStart: number; vertexCount: number; hasLine: boolean}> = [];

    // ---- Control-point & keyframe-marker screen-space rendering (shared mesh) ----
    // Both are drawn with a fixed pixel size regardless of camera zoom.
    // This mesh is rebuilt every frame to maintain constant screen-space dimensions.
    private _cpEntity: Entity;
    private _cpMesh: Mesh;
    private _cpMeshInstance: MeshInstance;
    private _cpStates: Array<'normal' | 'hover' | 'drag'> = [];
    private _kfStates: Array<'normal' | 'hover' | 'drag'> = [];
    // Cone (direction) + Sphere (focal-length) states per keyframe
    private _coneStates: Array<'normal' | 'hover' | 'drag'> = [];
    private _sphereStates: Array<'normal' | 'hover' | 'drag'> = [];
    private _cpDirty = true;

    // Solo drag mode: when active, only the dragged element is rendered.
    // All other control points, keyframes, cones, and spheres are hidden
    // to reduce visual clutter during interaction.
    private _soloDragType: 'cp' | 'kf' | 'cone' | 'sphere' | null = null;
    private _soloDragIndex = -1;
    // Target sizes in screen pixels
    private static readonly CP_TARGET_PX = 8;   // control-point diamond
    private static readonly KF_TARGET_PX = 12;  // keyframe box (slightly larger)
    private static readonly CONE_TARGET_PX = 10; // cone (slightly larger than CP)
    private static readonly SPHERE_TARGET_PX = 10; // sphere
    private static readonly SIGHT_AXIS_PX = 3;  // sight-axis line thickness (px)

    constructor() {
        super(ElementType.debug);
    }

    add() {
        const scene = this.scene;
        const device = scene.graphicsDevice;

        this.material = new ShaderMaterial({
            uniqueName: 'cameraPath3DMaterial',
            vertexGLSL: vertexShader,
            fragmentGLSL: fragmentShader
        });
        this.material.depthWrite = true;
        this.material.depthTest = true;
        this.material.update();

        this.mesh = new Mesh(device);
        this.mesh.primitive[0] = {
            baseVertex: 0,
            type: PRIMITIVE_LINES,
            base: 0,
            count: 0
        };

        this.meshInstance = new MeshInstance(this.mesh, this.material, null);
        this.meshInstance.cull = false;

        this.entity = new Entity('cameraPath3D');
        this.entity.addComponent('render', {
            meshInstances: [this.meshInstance],
            layers: [scene.pathLayer.id]
        });

        scene.app.root.addChild(this.entity);

        // ---- Frustum entity (live camera position / direction / FOV) ----
        this._frustumMesh = new Mesh(device);
        this._frustumMesh.primitive[0] = {
            baseVertex: 0,
            type: PRIMITIVE_LINES,
            base: 0,
            count: 0
        };
        this._frustumMeshInstance = new MeshInstance(this._frustumMesh, this.material, null);
        this._frustumMeshInstance.cull = false;

        this._frustumEntity = new Entity('cameraFrustum');
        this._frustumEntity.addComponent('render', {
            meshInstances: [this._frustumMeshInstance],
            layers: [scene.pathLayer.id]
        });
        scene.app.root.addChild(this._frustumEntity);

        // ---- Control-point mesh (screen-space, rebuilt every frame) ----
        this._cpMesh = new Mesh(device);
        this._cpMesh.primitive[0] = {
            baseVertex: 0,
            type: PRIMITIVE_LINES,
            base: 0,
            count: 0
        };
        this._cpMeshInstance = new MeshInstance(this._cpMesh, this.material, null);
        this._cpMeshInstance.cull = false;

        this._cpEntity = new Entity('cameraPathControlPoints');
        this._cpEntity.addComponent('render', {
            meshInstances: [this._cpMeshInstance],
            layers: [scene.pathLayer.id]
        });
        scene.app.root.addChild(this._cpEntity);

        // Mark dirty when camera track changes or timeline updates
        const markDirty = () => {
            this.dirty = true;
            this.frustumDirty = true;
            this._cpDirty = true;
            if (this.isVisible()) {
                scene.forceRender = true;
            }
        };

        const { events } = scene;
        events.on('track.keyAdded', markDirty);
        events.on('track.keyRemoved', markDirty);
        events.on('track.keyMoved', markDirty);
        events.on('track.keyUpdated', markDirty);
        events.on('track.keysLoaded', markDirty);
        events.on('track.keysCleared', markDirty);
        events.on('timeline.frame', (frame: number) => {
            this.currentFrame = frame;
            if (this.isVisible()) {
                this.frustumDirty = true;
                scene.forceRender = true;
            }
        });
        events.on('statusBar.panelChanged', () => {
            this.dirty = true;
            this._cpDirty = true;
            if (this.isVisible()) {
                scene.forceRender = true;
            }
        });
        events.on('scene.boundChanged', markDirty);
        events.on('scene.clear', () => {
            this.mesh.primitive[0].count = 0;
            this._frustumMesh.primitive[0].count = 0;
            this._cpMesh.primitive[0].count = 0;
            this.dirty = false;
            this.frustumDirty = false;
            this._cpDirty = true;
        });
    }

    destroy() {
        this.entity?.destroy();
        this._frustumEntity?.destroy();
        this._cpEntity?.destroy();
    }

    onPreRender() {
        const visible = this.isVisible();

        if (!visible) {
            this.entity.enabled = false;
            this._frustumEntity.enabled = false;
            this._cpEntity.enabled = false;
            return;
        }

        // Rebuild static mesh (path / markers) only when dirty
        if (this.dirty && !this._isRebuilding) {
            this.dirty = false;
            this.rebuildMesh();
        }

        // Rebuild screen-space markers (CPs + KF boxes) every frame (camera-dependent)
        if ((this.controlPoints.length > 0 || this.kfMarkers.length > 0) && (this._cpDirty || this._shouldRebuildCP())) {
            this.rebuildControlPoints();
        }

        // Rebuild live frustum every frame it's dirty
        if (this.frustumDirty) {
            this.frustumDirty = false;
            this.rebuildFrustum();
        }

        // Only enable when the mesh actually has vertex data to render
        this.entity.enabled = this.mesh.primitive[0].count > 0;
        this._frustumEntity.enabled = this._frustumMesh.primitive[0].count > 0;
        this._cpEntity.enabled = (this.controlPoints.length > 0 || this.kfMarkers.length > 0) && this._cpMesh.primitive[0].count > 0;
    }

    // Track last camera position to avoid unnecessary CP rebuilds
    private _lastCamPos: Vec3 | null = null;
    private _shouldRebuildCP(): boolean {
        const camPos = this.scene.camera.mainCamera.getPosition();
        if (!this._lastCamPos || camPos.distance(this._lastCamPos) > 0.001) {
            this._lastCamPos = camPos.clone();
            return true;
        }
        return false;
    }

    isVisible(): boolean {
        // Show when camera poses are enabled OR when timeline panel is open
        const showPoses = this.scene.events.invoke('camera.showPoses');
        const timelineOpen = this.scene.events.invoke('statusBar.panel') === 'timeline';
        return (showPoses || timelineOpen) && this.scene.camera.renderOverlays;
    }

    // Draw a diamond shape at position (4 triangles = 2 quads, 12 line segments)
    private drawControlPointDiamond(positions: number[], colors: number[], center: Vec3, size: number, color: number[]) {
        const s = size;
        // 6 vertices of an octahedron (diamond): +X, -X, +Y, -Y, +Z, -Z from center
        const px = new Vec3(center.x + s, center.y, center.z);
        const nx = new Vec3(center.x - s, center.y, center.z);
        const py = new Vec3(center.x, center.y + s, center.z);
        const ny = new Vec3(center.x, center.y - s, center.z);
        const pz = new Vec3(center.x, center.y, center.z + s);
        const nz = new Vec3(center.x, center.y, center.z - s);

        // XZ plane ring
        PUSH_LINE(positions, colors, px, pz, color);
        PUSH_LINE(positions, colors, pz, nx, color);
        PUSH_LINE(positions, colors, nx, nz, color);
        PUSH_LINE(positions, colors, nz, px, color);

        // Y connections
        PUSH_LINE(positions, colors, px, py, color);
        PUSH_LINE(positions, colors, nx, py, color);
        PUSH_LINE(positions, colors, pz, py, color);
        PUSH_LINE(positions, colors, nz, py, color);
        PUSH_LINE(positions, colors, px, ny, color);
        PUSH_LINE(positions, colors, nx, ny, color);
        PUSH_LINE(positions, colors, pz, ny, color);
        PUSH_LINE(positions, colors, nz, ny, color);
    }

    // Draw a cone/pyramid shape: base square + 4 edges from apex to base corners.
    // The cone points "backward" toward the camera (apex toward kfPos).
    // For simplicity, we draw it as a diamond with Y-elongation.
    private drawConeShape(positions: number[], colors: number[], center: Vec3, size: number, color: number[]) {
        // Draw as diamond, but Y-elongated to suggest a cone
        const sXY = size * 0.5;
        const sZ = size * 0.7;
        const px = new Vec3(center.x + sXY, center.y, center.z);
        const nx = new Vec3(center.x - sXY, center.y, center.z);
        const py = new Vec3(center.x, center.y + sZ, center.z);
        const ny = new Vec3(center.x, center.y - sZ, center.z);
        const pz = new Vec3(center.x, center.y, center.z + sXY);
        const nz = new Vec3(center.x, center.y, center.z - sXY);

        PUSH_LINE(positions, colors, px, pz, color);
        PUSH_LINE(positions, colors, pz, nx, color);
        PUSH_LINE(positions, colors, nx, nz, color);
        PUSH_LINE(positions, colors, nz, px, color);
        PUSH_LINE(positions, colors, px, py, color);
        PUSH_LINE(positions, colors, nx, py, color);
        PUSH_LINE(positions, colors, pz, py, color);
        PUSH_LINE(positions, colors, nz, py, color);
        PUSH_LINE(positions, colors, px, ny, color);
        PUSH_LINE(positions, colors, nx, ny, color);
        PUSH_LINE(positions, colors, pz, ny, color);
        PUSH_LINE(positions, colors, nz, ny, color);
    }

    // Draw a sphere approximation (octagon ring in XY plane + Y-axis poles)
    private drawSphereShape(positions: number[], colors: number[], center: Vec3, radius: number, color: number[]) {
        const r = radius;
        const n = 8;
        const pi2 = Math.PI * 2;
        const ringPts: Vec3[] = [];
        for (let i = 0; i < n; i++) {
            const angle = (i / n) * pi2;
            ringPts.push(new Vec3(center.x + Math.cos(angle) * r, center.y, center.z + Math.sin(angle) * r));
        }
        // Ring
        for (let i = 0; i < n; i++) {
            PUSH_LINE(positions, colors, ringPts[i], ringPts[(i + 1) % n], color);
        }
        // Poles
        const top = new Vec3(center.x, center.y + r, center.z);
        const bot = new Vec3(center.x, center.y - r, center.z);
        for (let i = 0; i < n; i++) {
            PUSH_LINE(positions, colors, ringPts[i], top, color);
            PUSH_LINE(positions, colors, ringPts[i], bot, color);
        }
    }
    updateControlPointColor(index: number, state: 'normal' | 'hover' | 'drag') {
        if (index < 0 || index >= this._cpStates.length) return;
        if (this._cpStates[index] === state) return;
        this._cpStates[index] = state;
        this._cpDirty = true;
        if (this._cpEntity.enabled) {
            this.scene.forceRender = true;
        }
    }

    /**
     * Real-time control point movement during drag.
     * Updates CP world position and marks both path and CP meshes dirty.
     * Adjacent control points in the same segment are displaced with quadratic
     * decay to maintain path smoothness during drag.
     */
    moveControlPoint(index: number, newPos: Vec3): void {
        if (index < 0 || index >= this.controlPoints.length) return;

        const delta = new Vec3().sub2(newPos, this.controlPoints[index]);
        if (delta.length() < 0.0001) return;

        // Find segment range for this CP
        let segStart = 0;
        let segEnd = this.controlPoints.length;
        let segFrameSpan = 1;
        for (const seg of this._segmentBoundaries) {
            if (index >= seg.startIdx && index < seg.endIdx) {
                segStart = seg.startIdx;
                segEnd = seg.endIdx;
                segFrameSpan = Math.max(1, seg.endFrame - seg.startFrame);
                break;
            }
        }

        const draggedFrame = this.controlPointFrames[index];

        // Find max frame distance among CPs in this segment (for normalization)
        let maxCpFrameDist = 0;
        for (let i = segStart; i < segEnd; i++) {
            maxCpFrameDist = Math.max(maxCpFrameDist, Math.abs(this.controlPointFrames[i] - draggedFrame));
        }
        if (maxCpFrameDist === 0) maxCpFrameDist = 1;

        // Apply weighted displacement to all CPs in range
        for (let i = segStart; i < segEnd; i++) {
            const frameDist = Math.abs(this.controlPointFrames[i] - draggedFrame);
            const normDist = frameDist / maxCpFrameDist;
            const weight = Math.max(0, (1 - normDist) ** 2);

            const offset = new Vec3().copy(delta).mulScalar(weight);
            this.controlPoints[i].add(offset);
        }

        this._cpDirty = true;
        this.scene.forceRender = true;
    }

    // Hit test: find nearest control point within radius
    hitTestControlPoint(worldPos: Vec3, radius: number): number {
        let bestDist = radius;
        let bestIdx = -1;
        for (let i = 0; i < this.controlPoints.length; i++) {
            const d = this.controlPoints[i].distance(worldPos);
            if (d < bestDist) {
                bestDist = d;
                bestIdx = i;
            }
        }
        return bestIdx;
    }

    // ---- Keyframe marker interaction ----

    /** Hit test: find nearest keyframe marker within radius */
    hitTestKeyframeMarker(worldPos: Vec3, radius: number): number {
        let bestDist = radius;
        let bestIdx = -1;
        for (let i = 0; i < this.kfMarkers.length; i++) {
            const d = this.kfMarkers[i].distance(worldPos);
            if (d < bestDist) {
                bestDist = d;
                bestIdx = i;
            }
        }
        return bestIdx;
    }

    /** Update color for a keyframe marker (hover/drag feedback) */
    updateKeyframeMarkerColor(index: number, state: 'normal' | 'hover' | 'drag') {
        if (index < 0 || index >= this._kfStates.length) return;
        if (this._kfStates[index] === state) return;
        this._kfStates[index] = state;
        this._cpDirty = true;
        if (this._cpEntity.enabled) {
            this.scene.forceRender = true;
        }
    }

    /** Move a keyframe marker to a new position (drag feedback) */
    moveKeyframeMarker(index: number, newPos: Vec3): void {
        if (index < 0 || index >= this.kfMarkers.length) return;

        const delta = new Vec3().sub2(newPos, this.kfMarkers[index]);
        if (delta.length() < 0.0001) return;

        this.kfMarkers[index].copy(newPos);
        // Move cone and sphere too, preserving camera look direction
        if (index < this.kfConePositions.length) {
            this.kfConePositions[index].add(delta);
        }
        if (index < this.kfSpherePositions.length) {
            this.kfSpherePositions[index].add(delta);
        }
        this._cpDirty = true;
        this.scene.forceRender = true;
    }

    // ---- Cone control (direction, at target position) ----

    /** Hit test: find nearest cone within radius */
    hitTestCone(worldPos: Vec3, radius: number): number {
        let bestDist = radius;
        let bestIdx = -1;
        for (let i = 0; i < this.kfConePositions.length; i++) {
            const d = this.kfConePositions[i].distance(worldPos);
            if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        return bestIdx;
    }

    updateConeColor(index: number, state: 'normal' | 'hover' | 'drag') {
        if (index < 0 || index >= this._coneStates.length) return;
        if (this._coneStates[index] === state) return;
        this._coneStates[index] = state;
        this._cpDirty = true;
        if (this._cpEntity.enabled) this.scene.forceRender = true;
    }

    moveConePosition(index: number, newPos: Vec3): void {
        if (index < 0 || index >= this.kfConePositions.length) return;
        const delta = new Vec3().sub2(newPos, this.kfConePositions[index]);
        if (delta.length() < 0.0001) return;
        this.kfConePositions[index].copy(newPos);
        this._cpDirty = true;
        this.scene.forceRender = true;
    }

    // ---- Sphere control (focal length, behind camera) ----

    /** Hit test: find nearest sphere within radius */
    hitTestSphere(worldPos: Vec3, radius: number): number {
        let bestDist = radius;
        let bestIdx = -1;
        for (let i = 0; i < this.kfSpherePositions.length; i++) {
            const d = this.kfSpherePositions[i].distance(worldPos);
            if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        return bestIdx;
    }

    updateSphereColor(index: number, state: 'normal' | 'hover' | 'drag') {
        if (index < 0 || index >= this._sphereStates.length) return;
        if (this._sphereStates[index] === state) return;
        this._sphereStates[index] = state;
        this._cpDirty = true;
        if (this._cpEntity.enabled) this.scene.forceRender = true;
    }

    moveSpherePosition(index: number, newPos: Vec3): void {
        if (index < 0 || index >= this.kfSpherePositions.length) return;
        const delta = new Vec3().sub2(newPos, this.kfSpherePositions[index]);
        if (delta.length() < 0.0001) return;
        this.kfSpherePositions[index].copy(newPos);
        this._cpDirty = true;
        this.scene.forceRender = true;
    }

    /**
     * Enter/exit solo drag mode. When active, only the specified element
     * is rendered — all other control points, keyframes, cones, and spheres
     * are hidden to reduce visual clutter during interaction.
     *
     * @param type The type of element being dragged, or null to exit solo mode.
     * @param index The index of the element being dragged (ignored when type is null).
     */
    setSoloDrag(type: 'cp' | 'kf' | 'cone' | 'sphere' | null, index: number): void {
        if (this._soloDragType === type && this._soloDragIndex === index) return;
        this._soloDragType = type;
        this._soloDragIndex = index;
        this._cpDirty = true;
        if (this._cpEntity.enabled) {
            this.scene.forceRender = true;
        }
    }

    // ---- Live frustum drawing ----

    /**
     * Rebuild the live frustum mesh showing the current-frame camera's
     * position, direction, and FOV range.
     */
    private rebuildFrustum() {
        const mesh = this._frustumMesh;
        mesh.primitive[0].count = 0;

        const { events } = this.scene;
        const controller = events.invoke('animation.controller') as AnimationController | undefined;
        const track = controller?.getTrack(TrackId.Camera);

        if (!track || track.keys.length === 0) {
            mesh.update(PRIMITIVE_LINES);
            return;
        }

        const val = (track as any).getValueAt?.(this.currentFrame) as number[] | null;
        if (!val || val.length < 7) {
            mesh.update(PRIMITIVE_LINES);
            return;
        }

        const camPos = new Vec3(val[0], val[1], val[2]);
        const camTarget = new Vec3(val[3], val[4], val[5]);
        const fov = val[6];

        // Camera basis vectors
        const forward = new Vec3().sub2(camTarget, camPos);
        const targetDist = forward.length();
        if (targetDist < 0.0001) {
            mesh.update(PRIMITIVE_LINES);
            return;   // degenerate pose
        }
        forward.mulScalar(1 / targetDist);  // normalize
        const worldUp = new Vec3(0, 1, 0);
        const right = new Vec3().cross(forward, worldUp).normalize();
        if (right.length() < 0.001) { right.set(1, 0, 0); }
        const up = new Vec3().cross(right, forward).normalize();

        const sceneRadius = this.scene.camera.sceneRadius || 1;

        // Near / far plane distances (proportional to scene size)
        const nearDist = Math.max(sceneRadius * 0.002, targetDist * 0.01);
        const farDist = Math.min(sceneRadius * 0.12, targetDist * 0.5);

        // Plane half-extents
        const nearHalfH = nearDist * Math.tan(fov * Math.PI / 360);
        const farHalfH = farDist * Math.tan(fov * Math.PI / 360);
        const aspect = 16 / 9;
        const nearHalfW = nearHalfH * aspect;
        const farHalfW = farHalfH * aspect;

        // Plane centers
        const nearCenter = new Vec3().copy(camPos).addScaled(forward, nearDist);
        const farCenter = new Vec3().copy(camPos).addScaled(forward, farDist);

        // Scaled up / right vectors
        const uN = new Vec3().copy(up).mulScalar(nearHalfH);
        const rN = new Vec3().copy(right).mulScalar(nearHalfW);
        const uF = new Vec3().copy(up).mulScalar(farHalfH);
        const rF = new Vec3().copy(right).mulScalar(farHalfW);

        // Near-plane corners
        const nTL = new Vec3().add2(nearCenter, uN).sub(rN);
        const nTR = new Vec3().add2(nearCenter, uN).add(rN);
        const nBL = new Vec3().sub2(nearCenter, uN).sub(rN);
        const nBR = new Vec3().sub2(nearCenter, uN).add(rN);

        // Far-plane corners
        const fTL = new Vec3().add2(farCenter, uF).sub(rF);
        const fTR = new Vec3().add2(farCenter, uF).add(rF);
        const fBL = new Vec3().sub2(farCenter, uF).sub(rF);
        const fBR = new Vec3().sub2(farCenter, uF).add(rF);

        const positions: number[] = [];
        const colors: number[] = [];

        // ---- Frustum edges (camera position → far corners) ----
        const edgeColor = [0, 220, 80, 200];   // vibrant green, semi-transparent
        PUSH_LINE(positions, colors, camPos, fTL, edgeColor);
        PUSH_LINE(positions, colors, camPos, fTR, edgeColor);
        PUSH_LINE(positions, colors, camPos, fBL, edgeColor);
        PUSH_LINE(positions, colors, camPos, fBR, edgeColor);

        // ---- Near-plane rectangle ----
        const nearColor = [80, 220, 80, 140];
        PUSH_LINE(positions, colors, nTL, nTR, nearColor);
        PUSH_LINE(positions, colors, nTR, nBR, nearColor);
        PUSH_LINE(positions, colors, nBR, nBL, nearColor);
        PUSH_LINE(positions, colors, nBL, nTL, nearColor);

        // ---- Far-plane rectangle ----
        const farColor = [80, 220, 80, 180];
        PUSH_LINE(positions, colors, fTL, fTR, farColor);
        PUSH_LINE(positions, colors, fTR, fBR, farColor);
        PUSH_LINE(positions, colors, fBR, fBL, farColor);
        PUSH_LINE(positions, colors, fBL, fTL, farColor);

        // ---- Camera body marker ----
        const markerSize = sceneRadius * 0.012;
        const camColor = [255, 255, 80, 255];   // bright yellow

        // Direction line (camera position → forward)
        const dirEnd = new Vec3().copy(camPos).addScaled(forward, markerSize * 4);
        PUSH_LINE(positions, colors, camPos, dirEnd, camColor);

        // Small square at camera position, perpendicular to view direction
        const sq = markerSize * 0.7;
        const uSq = new Vec3().copy(up).mulScalar(sq);
        const rSq = new Vec3().copy(right).mulScalar(sq);
        const sqTL = new Vec3().add2(camPos, uSq).sub(rSq);
        const sqTR = new Vec3().add2(camPos, uSq).add(rSq);
        const sqBL = new Vec3().sub2(camPos, uSq).sub(rSq);
        const sqBR = new Vec3().sub2(camPos, uSq).add(rSq);

        PUSH_LINE(positions, colors, sqTL, sqTR, camColor);
        PUSH_LINE(positions, colors, sqTR, sqBR, camColor);
        PUSH_LINE(positions, colors, sqBR, sqBL, camColor);
        PUSH_LINE(positions, colors, sqBL, sqTL, camColor);

        // ---- Upload to GPU ----
        mesh.clear(false, false);
        mesh.setPositions(positions);
        mesh.setColors32(new Uint8Array(colors));
        mesh.update(PRIMITIVE_LINES);
        mesh.primitive[0].count = positions.length / 3;
    }

    // ---- Screen-space markers (control points + keyframe boxes, rebuilt every frame) ----

    /**
     * Rebuild the screen-space marker mesh with fixed-pixel-sized geometry.
     * Contains both control-point diamonds (~8px) and keyframe boxes (~12px).
     * World-space size is computed per-marker based on camera distance.
     */
    private rebuildControlPoints() {
        this._cpDirty = false;
        const mesh = this._cpMesh;
        mesh.primitive[0].count = 0;

        if (this.controlPoints.length === 0 && this.kfMarkers.length === 0) {
            mesh.update(PRIMITIVE_LINES);
            return;
        }

        // Compute pixel-to-world scale factor
        const canvas = this.scene.canvas;
        const canvasH = canvas.height;
        const fovRad = (this.scene.camera.fov ?? 60) * Math.PI / 180;
        // World height at distance=1: 2 * tan(fov/2)
        const worldPerPixelAtUnitDist = (2 * Math.tan(fovRad / 2)) / Math.max(canvasH, 1);
        const cameraPos = this.scene.camera.mainCamera.getPosition();

        const positions: number[] = [];
        const colorsArr: number[] = [];

        // Helper: draw a box (12 edges) at center with given half-size
        const pushBox = (center: Vec3, half: number, color: number[]) => {
            const minX = center.x - half, maxX = center.x + half;
            const minY = center.y - half, maxY = center.y + half;
            const minZ = center.z - half, maxZ = center.z + half;
            const c1 = new Vec3(minX, minY, minZ);
            const c2 = new Vec3(maxX, minY, minZ);
            const c3 = new Vec3(maxX, maxY, minZ);
            const c4 = new Vec3(minX, maxY, minZ);
            const c5 = new Vec3(minX, minY, maxZ);
            const c6 = new Vec3(maxX, minY, maxZ);
            const c7 = new Vec3(maxX, maxY, maxZ);
            const c8 = new Vec3(minX, maxY, maxZ);
            PUSH_LINE(positions, colorsArr, c1, c2, color);
            PUSH_LINE(positions, colorsArr, c2, c3, color);
            PUSH_LINE(positions, colorsArr, c3, c4, color);
            PUSH_LINE(positions, colorsArr, c4, c1, color);
            PUSH_LINE(positions, colorsArr, c5, c6, color);
            PUSH_LINE(positions, colorsArr, c6, c7, color);
            PUSH_LINE(positions, colorsArr, c7, c8, color);
            PUSH_LINE(positions, colorsArr, c8, c5, color);
            PUSH_LINE(positions, colorsArr, c1, c5, color);
            PUSH_LINE(positions, colorsArr, c2, c6, color);
            PUSH_LINE(positions, colorsArr, c3, c7, color);
            PUSH_LINE(positions, colorsArr, c4, c8, color);
        };

        // ---- Keyframe boxes (white, ~12px) ----
        for (let i = 0; i < this.kfMarkers.length; i++) {
            // Solo drag: only show the dragged keyframe, hide everything else
            // (including cones/spheres — those are hidden by the cone/sphere loop below)
            if (this._soloDragType && !(this._soloDragType === 'kf' && this._soloDragIndex === i)) continue;

            const kfPos = this.kfMarkers[i];
            const dist = Math.max(kfPos.distance(cameraPos), 0.001);
            const worldSize = CameraPath3D.KF_TARGET_PX * worldPerPixelAtUnitDist * dist;
            const half = worldSize * 0.5;

            const state = this._kfStates[i] ?? 'normal';
            let color: number[];
            switch (state) {
                case 'hover': color = COLOR_KF_HOVER; break;
                case 'drag': color = COLOR_KF_DRAG; break;
                default: color = COLOR_KF_MARKER; break;
            }

            const vertStart = positions.length / 3;
            pushBox(kfPos, half, color);
            const vertEnd = positions.length / 3;
            const info = this.kfMarkerIndices[i];
            if (info) {
                info.vertexStart = vertStart;
                info.vertexCount = vertEnd - vertStart;
            }
        }

        // ---- Cone + Sphere controls (per keyframe) ----
        // Cone (amber/orange diamond) at target position — drag to change look direction.
        // Sphere (blue) behind camera — drag to change focal length (FOV).
        for (let i = 0; i < this.kfMarkers.length; i++) {
            // Solo drag: hide cones/spheres unless they are the dragged element
            if (this._soloDragType && !(
                (this._soloDragType === 'cone' || this._soloDragType === 'sphere') &&
                this._soloDragIndex === i
            )) continue;

            const kfPos = this.kfMarkers[i];
            const conePos = this.kfConePositions[i];
            const spherePos = this.kfSpherePositions[i];
            if (!kfPos || !conePos || !spherePos) continue;

            // ---- Cone line (kfPos → cone, amber) ----
            const coneState = this._coneStates[i] ?? 'normal';
            let coneLineColor: number[];
            switch (coneState) {
                case 'hover': coneLineColor = [255, 220, 80, 220]; break;
                case 'drag': coneLineColor = [255, 100, 0, 220]; break;
                default: coneLineColor = COLOR_CONE_LINE; break;
            }
            const coneInfo = this.kfConeIndices[i];
            if (coneInfo) { coneInfo.vertexStart = positions.length / 3; coneInfo.hasLine = true; }
            PUSH_THICK_LINE(positions, colorsArr, kfPos, conePos, coneLineColor,
                CameraPath3D.SIGHT_AXIS_PX, worldPerPixelAtUnitDist * Math.max(kfPos.distance(cameraPos), 0.001));

            // Cone diamond (screen-space, at target position)
            const coneDist = Math.max(conePos.distance(cameraPos), 0.001);
            const coneWorldSize = CameraPath3D.CONE_TARGET_PX * worldPerPixelAtUnitDist * coneDist;
            let coneColor: number[];
            switch (coneState) {
                case 'hover': coneColor = COLOR_CONE_HOVER; break;
                case 'drag': coneColor = COLOR_CONE_DRAG; break;
                default: coneColor = COLOR_CONE_NORMAL; break;
            }
            // Draw a pyramid/cone shape: Y-axis elongated diamond
            this.drawConeShape(positions, colorsArr, conePos, coneWorldSize, coneColor);

            if (coneInfo) { coneInfo.vertexCount = (positions.length / 3) - coneInfo.vertexStart; }

            // ---- Sphere line (kfPos → sphere, blue, dashed look) ----
            const sphereState = this._sphereStates[i] ?? 'normal';
            let sphereLineColor: number[];
            switch (sphereState) {
                case 'hover': sphereLineColor = [130, 200, 255, 220]; break;
                case 'drag': sphereLineColor = [40, 255, 180, 220]; break;
                default: sphereLineColor = COLOR_SPHERE_LINE; break;
            }
            const sphereInfo = this.kfSphereIndices[i];
            if (sphereInfo) { sphereInfo.vertexStart = positions.length / 3; sphereInfo.hasLine = true; }
            PUSH_THICK_LINE(positions, colorsArr, kfPos, spherePos, sphereLineColor,
                CameraPath3D.SIGHT_AXIS_PX, worldPerPixelAtUnitDist * Math.max(kfPos.distance(cameraPos), 0.001));

            // Sphere diamond (screen-space, behind camera)
            const sphereDist = Math.max(spherePos.distance(cameraPos), 0.001);
            const sphereWorldSize = CameraPath3D.SPHERE_TARGET_PX * worldPerPixelAtUnitDist * sphereDist;
            let sphereColor: number[];
            switch (sphereState) {
                case 'hover': sphereColor = COLOR_SPHERE_HOVER; break;
                case 'drag': sphereColor = COLOR_SPHERE_DRAG; break;
                default: sphereColor = COLOR_SPHERE_NORMAL; break;
            }
            // Draw small circle approximation (octagon)
            this.drawSphereShape(positions, colorsArr, spherePos, sphereWorldSize * 0.5, sphereColor);

            if (sphereInfo) { sphereInfo.vertexCount = (positions.length / 3) - sphereInfo.vertexStart; }
        }
        for (let i = 0; i < this.controlPoints.length; i++) {
            // Solo drag: only show the dragged control point
            if (this._soloDragType && !(this._soloDragType === 'cp' && this._soloDragIndex === i)) continue;

            const cpPos = this.controlPoints[i];
            const dist = Math.max(cpPos.distance(cameraPos), 0.001);
            const worldSize = CameraPath3D.CP_TARGET_PX * worldPerPixelAtUnitDist * dist;

            const state = this._cpStates[i] ?? 'normal';
            let color: number[];
            switch (state) {
                case 'hover': color = COLOR_CP_HOVER; break;
                case 'drag': color = COLOR_CP_DRAG; break;
                default: color = COLOR_CP_NORMAL; break;
            }

            const vertStart = positions.length / 3;
            this.drawControlPointDiamond(positions, colorsArr, cpPos, worldSize * 0.5, color);
            const vertEnd = positions.length / 3;

            const cpInfo = this.controlPointIndices[i];
            if (cpInfo) {
                cpInfo.vertexStart = vertStart;
                cpInfo.vertexCount = vertEnd - vertStart;
            }
        }

        mesh.clear(false, false);
        mesh.setPositions(positions);
        mesh.setColors32(new Uint8Array(colorsArr));
        mesh.update(PRIMITIVE_LINES);
        mesh.primitive[0].count = positions.length / 3;
    }

    // ---- Static path mesh ----

    private rebuildMesh() {
        // Re-entrancy guard — prevents feedback loops where events fired
        // during rebuild trigger another rebuild
        if (this._isRebuilding) return;
        this._isRebuilding = true;

        try {
            const { events } = this.scene;
            const controller = events.invoke('animation.controller') as AnimationController | undefined;
            const track = controller?.getTrack(TrackId.Camera);

            if (!track) {
                this.mesh.primitive[0].count = 0;
                return;
            }

            const totalFrames = events.invoke('timeline.frames') as number;
            const allKeys = [...track.keys].filter(f => f < totalFrames).sort((a, b) => a - b);
            const userKeyFrames = [...track.userKeys].filter(f => f < totalFrames).sort((a, b) => a - b);

            if (allKeys.length < 1) {
                this.mesh.primitive[0].count = 0;
                return;
            }

            // Sampling rate: ~1 sample per 2 frames for smooth paths
            const sampleRate = 2;

            const positions: number[] = [];
            const colors: number[] = [];

            // ---- Sample position path ----
            const posSamples: Vec3[] = [];
            const sampleFrames: number[] = [];

            for (let f = 0; f < totalFrames; f += sampleRate) {
                const val = (track as any).getValueAt?.(f) as number[] | null;
                if (val && val.length >= 6) {
                    posSamples.push(new Vec3(val[0], val[1], val[2]));
                    sampleFrames.push(f);
                }
            }
            // Ensure last frame
            const lastVal = (track as any).getValueAt?.(totalFrames - 1) as number[] | null;
            if (lastVal && lastVal.length >= 6) {
                const lastPos = new Vec3(lastVal[0], lastVal[1], lastVal[2]);
                if (posSamples.length === 0 || lastPos.distance(posSamples[posSamples.length - 1]) > 0.001) {
                    posSamples.push(lastPos);
                    sampleFrames.push(totalFrames - 1);
                }
            }

            if (posSamples.length === 0) {
                this.mesh.primitive[0].count = 0;
                return;
            }

            // ---- Position path (orange) ----
            for (let i = 1; i < posSamples.length; i++) {
                PUSH_LINE(positions, colors, posSamples[i - 1], posSamples[i], COLOR_POS_PATH);
            }

            // ---- Keyframe markers: store world positions, drawn separately in screen-space ----
            this.kfMarkers = [];
            this.kfMarkerFrames = [];
            this.kfMarkerIndices = [];
            this._kfStates = [];
            const kfList: Array<{pos: Vec3; target: Vec3; fov: number}> = [];

            for (const f of userKeyFrames) {
                const val = (track as any).getValueAt?.(f) as number[] | null;
                if (val && val.length >= 6) {
                    const kfPos = new Vec3(val[0], val[1], val[2]);
                    const target = new Vec3(val[3], val[4], val[5]);
                    const toTarget = new Vec3().sub2(target, kfPos);
                    const fov = val.length >= 7 ? val[6] : 60;
                    if (toTarget.length() < 0.001) {
                        const sr = this.scene.camera.sceneRadius || 1;
                        target.copy(kfPos).add(new Vec3(0, 0, -sr * 0.5));
                        toTarget.set(0, 0, -1);
                    }
                    kfList.push({pos: kfPos, target, fov});
                    this.kfMarkers.push(kfPos);
                    this.kfMarkerFrames.push(f);
                    this.kfMarkerIndices.push({ vertexStart: -1, vertexCount: 0 });
                    this._kfStates.push('normal');
                }
            }

            // Compute cone + sphere positions from keyframe data
            // Cone = near camera along forward direction (closer for easier interaction)
            // Sphere = behind camera, distance maps to FOV
            this.kfConePositions = [];
            this.kfConeIndices = [];
            this._coneStates = [];
            this.kfTargetDistances = [];
            this.kfSpherePositions = [];
            this.kfSphereIndices = [];
            this._sphereStates = [];

            const sceneRadius = this.scene.camera.sceneRadius || 1;
            const defaultFov = 60;
            const coneVisualDist = sceneRadius * 0.3;   // cone placed close to camera
            const defaultSphereDist = sceneRadius * 0.18; // sphere behind camera (was 0.35)

            for (const k of kfList) {
                const forward = new Vec3().sub2(k.target, k.pos).normalize();
                const targetDist = Math.max(k.target.distance(k.pos), 0.001);
                // Cone: placed coneVisualDist from camera along forward direction
                const conePos = new Vec3().copy(k.pos).addScaled(forward, coneVisualDist);
                // Sphere behind camera: distance proportional to FOV (narrower FOV = farther sphere)
                const sphereDist = defaultSphereDist * (defaultFov / Math.max(k.fov, 1));
                const spherePos = new Vec3().copy(k.pos).addScaled(forward, -sphereDist);

                this.kfConePositions.push(conePos);
                this.kfConeIndices.push({ vertexStart: -1, vertexCount: 0, hasLine: true });
                this._coneStates.push('normal');
                this.kfTargetDistances.push(targetDist);
                this.kfSpherePositions.push(spherePos);
                this.kfSphereIndices.push({ vertexStart: -1, vertexCount: 0, hasLine: true });
                this._sphereStates.push('normal');
            }

            // ---- Path control points: store world positions, drawn separately in screen-space ----
            this.controlPoints = [];
            this.controlPointFrames = [];
            this.controlPointIndices = [];
            this._segmentBoundaries = [];
            this._cpStates = [];

            // Collect CP world positions (no drawing here — handled by rebuildControlPoints)
            const CP_PER_SEGMENT = 4;
            for (let ki = 0; ki < userKeyFrames.length - 1; ki++) {
                const f0 = userKeyFrames[ki];
                const f1 = userKeyFrames[ki + 1];
                const step = Math.max(1, Math.floor((f1 - f0) / (CP_PER_SEGMENT + 1)));

                const segStartIdx = this.controlPoints.length;
                for (let f = f0 + step; f < f1; f += step) {
                    const val = (track as any).getValueAt?.(f) as number[] | null;
                    if (val && val.length >= 6) {
                        this.controlPoints.push(new Vec3(val[0], val[1], val[2]));
                        this.controlPointFrames.push(f);
                        this.controlPointIndices.push({
                            vertexStart: -1,
                            vertexCount: 0,
                            isHovered: false,
                            isDragging: false
                        });
                        this._cpStates.push('normal');
                    }
                }
                const segEndIdx = this.controlPoints.length;
                if (segEndIdx > segStartIdx) {
                    this._segmentBoundaries.push({
                        startIdx: segStartIdx,
                        endIdx: segEndIdx,
                        startFrame: f0,
                        endFrame: f1
                    });
                }
            }

            // Create vertex buffer with DYNAMIC usage on first call to enable
            // efficient partial updates during drag (moveControlPoint, etc.)
            if (!this._meshInitialized) {
                this.mesh.clear(true, false); // verticesDynamic=true, indicesDynamic=false
                this._meshInitialized = true;
            }

            // Update mesh
            this.mesh.setPositions(positions);
            const colorBytes = new Uint8Array(colors);
            this.mesh.setColors32(colorBytes);
            this.mesh.update(PRIMITIVE_LINES);
            this.mesh.primitive[0].count = positions.length / 3;

            // Save arrays for incremental updates
            this._colorArray = colorBytes;
            this._positionArray = positions;
        } finally {
            this._isRebuilding = false;
        }
    }
}

export { CameraPath3D };
