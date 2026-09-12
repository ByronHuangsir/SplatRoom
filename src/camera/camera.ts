import {
    math,
    ADDRESS_CLAMP_TO_EDGE,
    ASPECT_MANUAL,
    FILTER_NEAREST,
    PIXELFORMAT_RGBA8,
    PIXELFORMAT_RGBA16F,
    PIXELFORMAT_DEPTH,
    PROJECTION_ORTHOGRAPHIC,
    PROJECTION_PERSPECTIVE,
    TONEMAP_ACES,
    TONEMAP_ACES2,
    TONEMAP_FILMIC,
    TONEMAP_HEJL,
    TONEMAP_LINEAR,
    TONEMAP_NEUTRAL,
    BoundingBox,
    Color,
    Entity,
    Mat4,
    Quat,
    Ray,
    RenderPass,
    RenderPassForward,
    RenderTarget,
    Texture,
    Vec3,
    Vec4
} from 'playcanvas';

import { PointerController } from './controllers';
import { Element, ElementType } from '../scene/element';
import { Picker } from '../scene/picker';
import { Serializer } from '../serializer';
import { TweenValue } from './tween-value';
import { vertexShader, fragmentShader } from '../shaders/blit-shader';
import { Splat } from '../splat/splat';
import { ShaderQuad, SimpleRenderPass } from '../utils/simple-render-pass';

// work globals
const forwardVec = new Vec3();
const cameraPosition = new Vec3();
const ray = new Ray();
const vec = new Vec3();
const vecb = new Vec3();
const va = new Vec3();
const m = new Mat4();
const v4 = new Vec4();

// modulo dealing with negative numbers
const mod = (n: number, m: number) => ((n % m) + m) % m;

class Camera extends Element {
    /**
     * Calculate the forward vector given azimuth and elevation angles.
     *
     * @param {Vec3} result - The Vec3 to store the result in.
     * @param {number} azim - Azimuth angle in degrees.
     * @param {number} elev - Elevation angle in degrees.
     */
    static calcForwardVec(result: Vec3, azim: number, elev: number) {
        const ex = elev * math.DEG_TO_RAD;
        const ey = azim * math.DEG_TO_RAD;
        const s1 = Math.sin(-ex);
        const c1 = Math.cos(-ex);
        const s2 = Math.sin(-ey);
        const c2 = Math.cos(-ey);
        result.set(-c1 * s2, s1, c1 * c2);
    }

    /**
     * 计算相机朝向四元数：q = qYaw(azim) · qPitch(elev)（先俯仰后偏航）。
     *
     * 替代 setLocalEulerAngles(elev, azim, 0)（PlayCanvas XYZ 欧拉）以消除万向节锁：
     * 欧拉方案在 elev≈±90° 时 up 不随 azim 旋转（固定在 (0, cos(elev), sin(elev))），
     * 旋转视角时出现"视角翻转"。本方案（合成测试已验证）：
     *   • 前向（-Z 列）= -calcForwardVec = 指向 focal（与 calcForwardVec 位置
     *     计算完全一致，相机始终看向 focal 点）
     *   • up（Y 列）= (sin(elev)sin(azim), cos(elev), sin(elev)cos(azim))，
     *     随 azim 平滑旋转，elev=±90° 无跳变
     *   • 非极端俯仰（|elev| 不接近 90°）时与旧欧拉方案行为一致（无感知变化）
     *
     * @param {number} azim - 方位角（度）。
     * @param {number} elev - 俯仰角（度），正 = 俯视。
     * @returns {Quat} 相机朝向四元数。
     */
    private calcYawPitchQuat(azim: number, elev: number): Quat {
        const halfAz = azim * math.DEG_TO_RAD * 0.5;
        const halfEl = elev * math.DEG_TO_RAD * 0.5;
        const sy = Math.sin(halfAz);
        const cy = Math.cos(halfAz);
        const sp = Math.sin(halfEl);
        const cp = Math.cos(halfEl);
        // qYaw(azim) 绕世界 Y 旋转 azim：(0, sy, 0, cy)
        // qPitch(elev) 绕世界 X 旋转 elev：(sp, 0, 0, cp)
        // q = qYaw · qPitch（Hamilton 积，先应用 qPitch 再 qYaw）
        const q = new Quat();
        q.x = cy * sp;
        q.y = sy * cp;
        q.z = -sy * sp;
        q.w = cy * cp;
        return q;
    }

    controller: PointerController;
    focalPointTween = new TweenValue({ x: 0, y: 0.5, z: 0 });
    azimElevTween = new TweenValue({ azim: 30, elev: -15 });
    distanceTween = new TweenValue({ distance: 1 });

    minElev = -90;
    maxElev = 90;

    sceneRadius = 1;

    flySpeed = 1;

    controlMode: 'orbit' | 'fly' | 'walk' = 'orbit';

    // ---- walk mode (first-person floor traversal, V3) ----
    // Ground plane height + eye height used while controlMode === 'walk'.
    // The camera keeps a frozen position (lookCameraPos) at groundY + eyeH
    // and moves horizontally with WASD; look() turns in place.
    walkGroundY = 0;
    walkEyeHeight = 0.1;

    // during fly-mode look, stores the camera position that must stay fixed
    // while the azim/elev tween smoothly converges
    lookCameraPos: Vec3 | null = null;

    // True while the user is actively dragging in the main viewport (mouse /
    // touch), coasting on inertia, or moving via fly keys. The PiP preview
    // shows the animation camera, whose pose does not change during main-view
    // interaction — its content is static, so re-rendering it (a full splat
    // pass + sort) is wasted work that directly hurts drag smoothness when
    // the timeline panel is open. Overlays read this to skip such work.
    userDragging = false;

    // snapshot of camera state captured when entering fly mode, used by
    // reset-camera to restore the view that was active at the transition point
    flyEntryPose: { azim: number; elev: number; focalPoint: Vec3; distance: number } | null = null;

    picker: Picker;

    mainCamera: Entity;

    mainTarget: RenderTarget;
    splatTarget: RenderTarget;
    colorTarget: RenderTarget;
    workTarget: RenderTarget;

    // Render passes
    clearPass: RenderPass;
    mainPass: RenderPassForward;
    splatPass: RenderPassForward;
    gizmoPass: RenderPassForward;
    finalPass: SimpleRenderPass;

    // overridden target size
    targetSizeOverride: { width: number, height: number } = null;

    // when set, overrides the tween-driven pose, fov and clipping planes each
    // update (used by 360 capture to render arbitrary face orientations that
    // the azim/elev pose system cannot express)
    poseOverride: { position: Vec3, rotation: Quat, fov: number, near: number, far: number } | null = null;

    // Camera View Mode — when true, the viewport camera syncs to the virtual
    // animation camera each frame (like Blender's Numpad 0). Exits on any user
    // interaction (pointerdown, scroll). When false, the viewport runs its
    // own independent orbit/fly state machine.
    cameraViewMode = false;

    // world transform of the user-facing camera pose. while a pose override
    // is active this holds the last tween-driven pose, so ui elements (view
    // cube, overlays) don't track the internal capture poses
    displayTransform = new Mat4();

    renderOverlays = true;

    updateCameraUniforms: () => void;

    constructor() {
        super(ElementType.camera);

        // create the camera entity
        this.mainCamera = new Entity('Camera');
        this.mainCamera.addComponent('camera');
    }

    // ortho
    set ortho(value: boolean) {
        if (value !== this.ortho) {
            this.camera.projection = value ? PROJECTION_ORTHOGRAPHIC : PROJECTION_PERSPECTIVE;
            this.scene.events.fire('camera.ortho', value);
        }
    }

    get ortho() {
        return this.camera.projection === PROJECTION_ORTHOGRAPHIC;
    }

    // fov
    set fov(value: number) {
        this.camera.fov = value;
    }

    get fov() {
        return this.camera.fov;
    }

    // tonemapping
    set tonemapping(value: string) {
        const mapping: Record<string, number> = {
            linear: TONEMAP_LINEAR,
            neutral: TONEMAP_NEUTRAL,
            aces: TONEMAP_ACES,
            aces2: TONEMAP_ACES2,
            filmic: TONEMAP_FILMIC,
            hejl: TONEMAP_HEJL
        };

        const tvalue = mapping[value];

        if (tvalue !== undefined && tvalue !== this.camera.toneMapping) {
            this.camera.toneMapping = tvalue;
            this.scene.events.fire('camera.tonemapping', value);
        }
    }

    get tonemapping() {
        switch (this.camera.toneMapping) {
            case TONEMAP_LINEAR: return 'linear';
            case TONEMAP_NEUTRAL: return 'neutral';
            case TONEMAP_ACES: return 'aces';
            case TONEMAP_ACES2: return 'aces2';
            case TONEMAP_FILMIC: return 'filmic';
            case TONEMAP_HEJL: return 'hejl';
        }
        return 'linear';
    }

    // near clip
    set near(value: number) {
        this.camera.nearClip = value;
    }

    get near() {
        return this.camera.nearClip;
    }

    // far clip
    set far(value: number) {
        this.camera.farClip = value;
    }

    get far() {
        return this.camera.farClip;
    }

    // focal point — returns the current tween value (not target) so
    // keyframe capture records the actual mid-tween camera state
    get focalPoint() {
        const v = this.focalPointTween.value;
        return new Vec3(v.x, v.y, v.z);
    }

    // azimuth, elevation
    get azimElev() {
        return this.azimElevTween.target;
    }

    get azim() {
        return this.azimElev.azim;
    }

    get elevation() {
        return this.azimElev.elev;
    }

    get distance() {
        return this.distanceTween.target.distance;
    }

    setFocalPoint(point: Vec3, dampingFactorFactor: number = 1) {
        this.lookCameraPos = null;
        this.focalPointTween.goto(point, dampingFactorFactor * this.scene.config.controls.dampingFactor);
    }

    // Fly mode: rotate camera around itself, keeping the camera position fixed
    look(dx: number, dy: number) {
        const sensitivity = this.scene.config.controls.orbitSensitivity;
        const d = this.distance * this.sceneRadius / this.fovFactor;

        // Reuse the frozen camera position from a previous look() so the
        // camera does not drift with the damped focal point; compute it from
        // the focal point only on the first look after entering fly mode
        // (lookCameraPos is null after orbit interactions cleared it).
        if (!this.lookCameraPos) {
            Camera.calcForwardVec(forwardVec, this.azim, this.elevation);
            this.lookCameraPos = this.focalPoint.add(forwardVec.clone().mulScalar(d));
        }
        const cameraPos = this.lookCameraPos;

        const azim = this.azim - dx * sensitivity;
        const elev = this.elevation - dy * sensitivity;

        Camera.calcForwardVec(forwardVec, azim, elev);
        const focalPoint = cameraPos.clone().sub(forwardVec.clone().mulScalar(d));

        // Immediate updates (damping factor 0): right-drag must track the
        // pointer 1:1. The previous damped azim/elev + focalPoint tweens made
        // fly-look lag behind the pointer, and the lookCameraPos lifecycle
        // (cleared when the azim/elev tween finishes) made the camera position
        // jump — together that read as jitter/stutter while right-dragging.
        this.setAzimElev(azim, elev, 0);
        this.focalPointTween.goto(focalPoint, 0);
        this.lookCameraPos = cameraPos;
    }

    // ---- walk mode (first-person floor traversal, V3) ----

    /**
     * Enter walk mode. `groundY` is the walkable floor height and `eyeHeight`
     * the eye above it; the eye is placed above the ground at the current
     * camera's x/z. Renders via the frozen-position branch (lookCameraPos) so
     * WASD walks and look() turns the eye in place.
     */
    prepareWalk(groundY: number, eyeHeight: number) {
        this.walkGroundY = groundY;
        this.walkEyeHeight = Math.max(0.02, eyeHeight);
        if (!this.lookCameraPos) {
            const d = this.distance * this.sceneRadius / this.fovFactor;
            Camera.calcForwardVec(forwardVec, this.azim, this.elevation);
            this.lookCameraPos = this.focalPoint.clone().add(forwardVec.clone().mulScalar(d));
        }
        this.lookCameraPos.x = this.mainCamera.getPosition().x;
        this.lookCameraPos.z = this.mainCamera.getPosition().z;
        this.lookCameraPos.y = this.walkGroundY + this.walkEyeHeight;
        // modest pitch clamp for first person — tween directly (setAzimElev
        // would clear the frozen lookCameraPos we just established)
        const elev = Math.max(-80, Math.min(80, this.elevation));
        if (elev !== this.elevation) {
            this.azimElevTween.goto({ azim: this.azim, elev }, 0);
        }
        this.scene.forceRender = true;
    }

    /** Move the walk eye horizontally by a world-space delta (floor-locked). */
    walkMove(dx: number, dy: number, dz: number) {
        if (!this.lookCameraPos) {
            this.prepareWalk(this.walkGroundY, this.walkEyeHeight);
        }
        this.lookCameraPos.x += dx;
        this.lookCameraPos.z += dz;
        // keep the eye glued to the floor plane (no free vertical in walk mode)
        this.lookCameraPos.y = this.walkGroundY + this.walkEyeHeight;
        this.scene.forceRender = true;
    }

    /**
     * Leave walk mode back into orbit at the current first-person pose: the
     * focal point is re-pointed so the orbit camera sits where the walk eye
     * was (azim/elev already track the look direction).
     */
    exitWalk() {
        const camPos = this.lookCameraPos ? this.lookCameraPos.clone() : this.mainCamera.getPosition();
        const d = this.distance * this.sceneRadius / this.fovFactor;
        Camera.calcForwardVec(forwardVec, this.azim, this.elevation);
        const focal = camPos.clone().add(forwardVec.clone().mulScalar(d));
        this.lookCameraPos = null;
        this.focalPointTween.goto(focal, 0);
        this.azimElevTween.goto({ azim: this.azim, elev: this.elevation }, 0);
        this.scene.forceRender = true;
    }

    /**
     * Adjust heading (azimuth) by delta degrees. In orbit mode rotates around
     * the focal point; in fly mode rotates around the camera position.
     */
    adjustHeading(delta: number) {
        this.cameraViewMode = false;
        if (this.controlMode === 'fly') {
            // Fly mode: rotate around camera position (look-style)
            const d = this.distance * this.sceneRadius / this.fovFactor;
            Camera.calcForwardVec(forwardVec, this.azim, this.elevation);
            const pos = this.focalPoint.clone().add(forwardVec.clone().mulScalar(d));
            const newAzim = this.azim + delta;
            this.setAzimElev(newAzim, this.elevation);
            Camera.calcForwardVec(forwardVec, newAzim, this.elevation);
            const newFocalPoint = pos.clone().sub(forwardVec.clone().mulScalar(d));
            this.focalPointTween.goto(newFocalPoint, this.scene.config.controls.dampingFactor);
            this.lookCameraPos = pos;
        } else if (this.controlMode === 'walk') {
            // Walk mode: yaw in place — tween directly so the frozen eye
            // position (lookCameraPos) is not cleared by setAzimElev.
            this.azimElevTween.goto({ azim: mod(this.azim + delta, 360), elev: this.elevation }, 0);
        } else {
            // Orbit mode: rotate around focal point
            this.setAzimElev(this.azim + delta, this.elevation);
        }
    }

    /**
     * Adjust pitch (elevation) by delta degrees. In orbit mode rotates around
     * the focal point; in fly mode rotates around the camera position.
     */
    adjustPitch(delta: number) {
        this.cameraViewMode = false;
        if (this.controlMode === 'fly') {
            // Fly mode: rotate around camera position (look-style)
            const d = this.distance * this.sceneRadius / this.fovFactor;
            Camera.calcForwardVec(forwardVec, this.azim, this.elevation);
            const pos = this.focalPoint.clone().add(forwardVec.clone().mulScalar(d));
            const newElev = this.elevation + delta;
            this.setAzimElev(this.azim, newElev);
            Camera.calcForwardVec(forwardVec, this.azim, newElev);
            const newFocalPoint = pos.clone().sub(forwardVec.clone().mulScalar(d));
            this.focalPointTween.goto(newFocalPoint, this.scene.config.controls.dampingFactor);
            this.lookCameraPos = pos;
        } else if (this.controlMode === 'walk') {
            // Walk mode: pitch in place — tween directly (keeps lookCameraPos)
            const elev = Math.max(this.minElev, Math.min(this.maxElev, this.elevation + delta));
            this.azimElevTween.goto({ azim: this.azim, elev }, 0);
        } else {
            // Orbit mode: rotate around focal point
            this.setAzimElev(this.azim, this.elevation + delta);
        }
    }

    setAzimElev(azim: number, elev: number, dampingFactorFactor: number = 1) {
        // setAzimElev is the orbit-mode rotation primitive — it rotates around
        // the focal point. Any frozen camera position from a prior look() call
        // (fly-mode right-drag or auto-rotate) must be cleared so onUpdate()
        // computes cameraPos from focalPoint + forward*distance, not the stale
        // frozen position.
        this.lookCameraPos = null;

        // clamp
        azim = mod(azim, 360);
        elev = Math.max(this.minElev, Math.min(this.maxElev, elev));

        const t = this.azimElevTween;
        t.goto({ azim, elev }, dampingFactorFactor * this.scene.config.controls.dampingFactor);

        // handle wraparound — use while loop (not single if) to handle
        // cases where source azim has accumulated beyond ±360° from
        // repeated setPose calls during timeline scrubbing.
        while (t.source.azim - azim < -180) {
            t.source.azim += 360;
        }
        while (t.source.azim - azim > 180) {
            t.source.azim -= 360;
        }

        // return to perspective mode on rotation
        this.ortho = false;

        // Notify UI of pose change
        this.scene?.events.fire('camera.poseChanged', { azim, elev });
    }

    setDistance(distance: number, dampingFactorFactor: number = 1) {
        this.lookCameraPos = null;

        const controls = this.scene.config.controls;

        // clamp
        distance = Math.max(controls.minZoom, Math.min(controls.maxZoom, distance));

        const t = this.distanceTween;
        t.goto({ distance }, dampingFactorFactor * controls.dampingFactor);
    }

    /**
     * Animate camera to a specific view with smooth transition.
     * All parameters are optional — missing ones keep the current value.
     */
    animateToView(azim: number, elev: number, distance?: number, duration: number = 1.0) {
        const dampingFactor = 1.0 / Math.max(0.1, duration);
        this.setAzimElev(azim, elev, dampingFactor);
        if (distance !== undefined) {
            this.setDistance(distance, dampingFactor);
        }
    }

    viewFront() {
        this.animateToView(0, 0);
    }
    viewBack() {
        this.animateToView(180, 0);
    }
    viewLeft() {
        this.animateToView(90, 0);
    }
    viewRight() {
        this.animateToView(-90, 0);
    }
    viewTop() {
        this.animateToView(this.azim, 89);
    }
    viewBottom() {
        this.animateToView(this.azim, -89);
    }

    setPose(position: Vec3, target: Vec3, dampingFactorFactor: number = 1) {
        vec.sub2(target, position);
        const l = vec.length();
        // Guard: when position approaches target (e.g. during spline
        // interpolation) the azim/elev reverse-calculation becomes
        // numerically unstable. Skip the setPose in this case.
        if (l < 1e-6) return;
        const azim = Math.atan2(-vec.x / l, -vec.z / l) * math.RAD_TO_DEG;
        const elev = Math.asin(Math.max(-1, Math.min(1, vec.y / l))) * math.RAD_TO_DEG;
        this.setFocalPoint(target, dampingFactorFactor);
        this.setAzimElev(azim, elev, dampingFactorFactor);
        this.setDistance(l / this.sceneRadius * this.fovFactor, dampingFactorFactor);
    }

    // set or clear the pose override and apply it immediately so subsequent
    // splat sorting and rendering see the new transform
    setPoseOverride(override: Camera['poseOverride']) {
        this.poseOverride = override;
        this.onUpdate(0);
    }

    // transform the world space coordinate to normalized screen coordinate
    worldToScreen(world: Vec3, screen: Vec3) {
        const { camera } = this;
        m.mul2(camera.projectionMatrix, camera.viewMatrix);

        v4.set(world.x, world.y, world.z, 1);
        m.transformVec4(v4, v4);

        screen.x = v4.x / v4.w * 0.5 + 0.5;
        screen.y = 1.0 - (v4.y / v4.w * 0.5 + 0.5);
        screen.z = v4.z / v4.w;
    }

    add() {
        const { camera, scene } = this;

        scene.cameraRoot.addChild(this.mainCamera);

        // configure camera to render all layers
        this.mainCamera.camera.layers = [
            scene.worldLayer.id,
            scene.splatLayer.id,
            scene.overlayLayer.id,
            scene.gizmoLayer.id,
            scene.pathLayer.id
        ];

        // use manual aspect ratio mode so we can set it based on targetSize
        camera.aspectRatioMode = ASPECT_MANUAL;

        // create render passes
        const device = scene.graphicsDevice;
        const { app } = scene;
        const renderer = app.renderer;
        const composition = app.scene.layers;

        this.clearPass = new RenderPass(device);
        this.mainPass = new RenderPassForward(device, composition, app.scene, renderer);
        this.splatPass = new RenderPassForward(device, composition, app.scene, renderer);
        this.gizmoPass = new RenderPassForward(device, composition, app.scene, renderer);
        this.finalPass = new SimpleRenderPass(device,
            new ShaderQuad(device, vertexShader, fragmentShader, 'final-blit'), {
                vars: () => {
                    return {
                        srcTexture: this.mainTarget.colorBuffer
                    };
                }
            });

        const target = document.getElementById('canvas-container');
        this.controller = new PointerController(this, target);

        // apply scene config
        const config = scene.config;
        const controls = config.controls;

        this.minElev = (controls.minPolarAngle * 180) / Math.PI - 90;
        this.maxElev = (controls.maxPolarAngle * 180) / Math.PI - 90;

        // tonemapping
        camera.toneMapping = {
            linear: TONEMAP_LINEAR,
            filmic: TONEMAP_FILMIC,
            hejl: TONEMAP_HEJL,
            aces: TONEMAP_ACES,
            aces2: TONEMAP_ACES2,
            neutral: TONEMAP_NEUTRAL
        }[config.camera.toneMapping];

        // exposure
        scene.app.scene.exposure = config.camera.exposure;

        this.fov = config.camera.fov;

        // initial camera position and orientation
        this.setAzimElev(controls.initialAzim, controls.initialElev, 0);
        this.setDistance(controls.initialZoom, 0);

        // picker
        this.picker = new Picker(scene);

        scene.events.on('scene.boundChanged', this.onBoundChanged, this);

        // prepare camera-specific uniforms
        this.updateCameraUniforms = () => {
            const device = scene.graphicsDevice;
            const entity = this.mainCamera;
            const camera = entity.camera;

            const set = (name: string, vec: Vec3) => {
                device.scope.resolve(name).setValue([vec.x, vec.y, vec.z]);
            };

            // get frustum corners in world space
            const points = camera.camera.getFrustumCorners(-100);
            const worldTransform = this.worldTransform;
            for (let i = 0; i < points.length; i++) {
                worldTransform.transformPoint(points[i], points[i]);
            }

            // near
            if (camera.projection === PROJECTION_PERSPECTIVE) {
                // perspective
                set('near_origin', worldTransform.getTranslation());
                set('near_x', Vec3.ZERO);
                set('near_y', Vec3.ZERO);
            } else {
                // orthographic
                set('near_origin', points[3]);
                set('near_x', va.sub2(points[0], points[3]));
                set('near_y', va.sub2(points[2], points[3]));
            }

            // far
            set('far_origin', points[7]);
            set('far_x', va.sub2(points[4], points[7]));
            set('far_y', va.sub2(points[6], points[7]));
        };

        // temp control of camera start
        const url = new URL(location.href);
        const focal = url.searchParams.get('focal');
        if (focal) {
            const parts = focal.toString().split(',');
            if (parts.length === 3) {
                this.setFocalPoint(new Vec3(parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2])), 0);
            }
        }
        const angles = url.searchParams.get('angles');
        if (angles) {
            const parts = angles.toString().split(',');
            if (parts.length === 2) {
                this.setAzimElev(parseFloat(parts[0]), parseFloat(parts[1]), 0);
            }
        }
        const distance = url.searchParams.get('distance');
        if (distance) {
            this.setDistance(parseFloat(distance), 0);
        }
    }

    remove() {
        const { scene } = this;

        this.controller.destroy();
        this.controller = null;

        // cleanup render passes
        this.clearPass?.destroy();
        this.mainPass?.destroy();
        this.splatPass?.destroy();
        this.gizmoPass?.destroy();
        this.finalPass?.destroy();
        this.camera.framePasses = null;

        scene.cameraRoot.removeChild(this.mainCamera);

        this.picker.destroy();
        this.picker = null;

        scene.events.off('scene.boundChanged', this.onBoundChanged, this);
    }

    // handle the scene's bound changing. the camera must be configured to render
    // the entire extents as well as possible.
    // also update the existing camera distance to maintain the current view
    onBoundChanged(bound: BoundingBox) {
        const prevDistance = this.distanceTween.value.distance * this.sceneRadius;
        this.sceneRadius = Math.max(1e-03, bound.halfExtents.length());
        this.setDistance(prevDistance / this.sceneRadius, 0);
    }

    serialize(serializer: Serializer) {
        serializer.packa(this.worldTransform.data);
        serializer.pack(
            this.fov,
            this.tonemapping,
            this.targetSize.width,
            this.targetSize.height
        );
    }

    // handle the viewer canvas resizing
    rebuildRenderTargets() {
        const { width, height } = this.targetSize;

        // Guard against zero-size targets (e.g. window minimized/hidden at
        // startup, or a 0-sized canvas between resize events): creating or
        // resizing a 0×0 RenderTarget/Texture crashes the graphics device.
        // Keep the previous targets untouched and retry next frame.
        if (!(width > 0 && height > 0)) {
            return;
        }

        const { mainTarget, scene } = this;

        // early out if size is unchanged
        if (mainTarget && mainTarget.width === width && mainTarget.height === height) {
            return;
        }

        if (!mainTarget) {
            // first time - construct render targets
            const { graphicsDevice } = scene;

            const createTexture = (name: string, width: number, height: number, format: number) => {
                return new Texture(graphicsDevice, {
                    name,
                    width,
                    height,
                    format,
                    mipmaps: false,
                    minFilter: FILTER_NEAREST,
                    magFilter: FILTER_NEAREST,
                    addressU: ADDRESS_CLAMP_TO_EDGE,
                    addressV: ADDRESS_CLAMP_TO_EDGE
                });
            };

            const colorBuffer = createTexture('cameraColor', width, height, PIXELFORMAT_RGBA16F);
            const workBuffer = createTexture('workColor', width, height, PIXELFORMAT_RGBA8);
            const depthBuffer = createTexture('cameraDepth', width, height, PIXELFORMAT_DEPTH);

            // create main render target
            this.mainTarget = new RenderTarget({
                colorBuffer,
                depthBuffer,
                flipY: false,
                autoResolve: false
            });

            // create MRT render target for splat pass
            this.splatTarget = new RenderTarget({
                colorBuffers: [
                    colorBuffer,        // RT0: main color (shared)
                    workBuffer          // RT1: overlay output (shared with workTarget)
                ],
                depthBuffer,
                flipY: false,
                autoResolve: false
            });

            this.colorTarget = new RenderTarget({
                colorBuffer,
                depth: false,
                autoResolve: false
            });

            // create work buffer (used for picking, overlay output, and other operations)
            this.workTarget = new RenderTarget({
                colorBuffer: workBuffer,
                depth: false,
                autoResolve: false
            });

            // set picker render targets
            this.picker.setRenderTargets(this.colorTarget, this.workTarget);

            // clear all targets
            this.clearPass.init(this.splatTarget);
            this.clearPass.setClearColor(new Color(0, 0, 0, 0));
            this.clearPass.setClearDepth(1);
            this.clearPass.setClearStencil(0);

            // configure main pass - world layer with clears
            this.mainPass.init(this.mainTarget);
            this.mainPass.addLayer(this.camera, scene.worldLayer, false, false);
            this.mainPass.addLayer(this.camera, scene.worldLayer, true, false);
            this.mainPass.addLayer(this.camera, scene.pathLayer, false, false);
            this.mainPass.addLayer(this.camera, scene.pathLayer, true, false);

            // configure splat pass - MRT target, no clears
            this.splatPass.init(this.splatTarget);
            this.splatPass.addLayer(this.camera, scene.splatLayer, false, false);
            this.splatPass.addLayer(this.camera, scene.splatLayer, true, false);

            // configure gizmo pass. the depth clear is attached to the first
            // render action, which is the tool overlay layer: its ghost
            // materials ignore depth entirely, so the clear effectively
            // belongs to the gizmo layers that follow
            this.gizmoPass.init(this.mainTarget);
            this.gizmoPass.addLayer(this.camera, scene.overlayLayer, false, false);
            this.gizmoPass.addLayer(this.camera, scene.overlayLayer, true, false);
            this.gizmoPass.addLayer(this.camera, scene.gizmoLayer, false, true);
            this.gizmoPass.addLayer(this.camera, scene.gizmoLayer, true, false);

            this.finalPass.init(null);

            // assign render passes to camera
            this.camera.framePasses = [this.clearPass, this.mainPass, this.splatPass, this.gizmoPass, this.finalPass];
        } else {
            // resize existing render targets
            const { splatTarget, colorTarget, workTarget } = this;

            mainTarget.resize(width, height);
            workTarget.resize(width, height);
            colorTarget.resize(width, height);
            splatTarget.resize(width, height);
        }

        this.camera.horizontalFov = width > height;
        this.camera.aspectRatio = width / height;
        scene.events.fire('camera.resize', { width, height });
    }

    onUpdate(deltaTime: number) {
        // controller update
        this.controller.update(deltaTime);

        // update underlying values
        this.focalPointTween.update(deltaTime);
        this.azimElevTween.update(deltaTime);
        this.distanceTween.update(deltaTime);

        const azimElev = this.azimElevTween.value;
        const distance = this.distanceTween.value;

        Camera.calcForwardVec(forwardVec, azimElev.azim, azimElev.elev);

        if (this.lookCameraPos) {
            cameraPosition.copy(this.lookCameraPos);
            if (this.controlMode === 'walk') {
                // first person: eye stays glued to the floor plane
                cameraPosition.y = this.walkGroundY + this.walkEyeHeight;
            } else if (this.azimElevTween.timer >= this.azimElevTween.transitionTime) {
                this.lookCameraPos = null;
            }
        } else {
            cameraPosition.copy(forwardVec);
            cameraPosition.mulScalar(distance.distance * this.sceneRadius / this.fovFactor);
            cameraPosition.add(this.focalPointTween.value);
        }

        if (this.poseOverride) {
            // cameraRoot has identity transform, so local space is world space
            const { position, rotation, fov, near, far } = this.poseOverride;
            this.mainCamera.setLocalPosition(position);
            this.mainCamera.setLocalRotation(rotation);
            this.camera.fov = fov;
            this.near = near;
            this.far = far;
        } else if (this.cameraViewMode) {
            // Camera View Mode: sync viewport to the virtual animation camera.
            // Copies position + rotation + fov from the animCameraEntity each
            // frame, bypassing the orbit state machine. Exits when the user
            // interacts (pointerdown in controllers.ts).
            const animEntity = this.scene.animCameraEntity;
            if (animEntity) {
                const ap = animEntity.getLocalPosition();
                const ar = animEntity.getLocalRotation();
                this.mainCamera.setLocalPosition(ap);
                this.mainCamera.setLocalRotation(ar);
                this.camera.fov = animEntity.camera.fov;
                this.fitClippingPlanes(ap, this.mainCamera.forward);
                this.displayTransform.copy(this.mainCamera.getWorldTransform());
            }
        } else {
            this.mainCamera.setLocalPosition(cameraPosition);

            // 相机朝向：用偏航-俯仰四元数组合替代 setLocalEulerAngles(elev, azim, 0)。
            // 欧拉角在 elev≈±90° 时存在万向节锁：up 不随 azim 旋转（up 固定在
            // (0, cos(elev), sin(elev))），旋转视角时出现"视角翻转"。四元数方案
            // q = qYaw(azim) · qPitch(elev)（先俯仰后偏航）：
            //   • 前向（-Z 列）= -calcForwardVec = 指向 focal（与位置计算一致）
            //   • up（Y 列）= (sin(elev)sin(azim), cos(elev), sin(elev)cos(azim))
            //     随 azim 平滑旋转，±90° 无跳变（合成测试已验证 0 跳变）。
            this.mainCamera.setLocalRotation(this.calcYawPitchQuat(azimElev.azim, azimElev.elev));

            this.fitClippingPlanes(this.mainCamera.getLocalPosition(), this.mainCamera.forward);

            this.displayTransform.copy(this.mainCamera.getWorldTransform());
        }

        const { camera } = this.mainCamera;
        const { targetSize } = this;

        // update ortho height
        camera.orthoHeight = this.distanceTween.value.distance * this.sceneRadius / this.fovFactor * (this.fov / 90) * (camera.horizontalFov ? targetSize.height / targetSize.width : 1);
        camera.camera._updateViewProjMat();
    }

    fitClippingPlanes(cameraPosition: Vec3, forwardVec: Vec3) {
        const bound = this.scene.bound;
        const boundRadius = bound.halfExtents.length();

        vec.sub2(bound.center, cameraPosition);
        const dist = vec.dot(forwardVec);

        if (dist > 0) {
            this.far = dist + boundRadius;
            // if camera is placed inside the sphere bound calculate near based far
            this.near = Math.max(1e-6, dist < boundRadius ? this.far / (1024 * 16) : dist - boundRadius);
        } else {
            // if the scene is behind the camera
            this.far = boundRadius * 2;
            this.near = this.far / (1024 * 16);
        }
    }

    onPreRender() {
        this.rebuildRenderTargets();
        this.updateCameraUniforms();
    }

    onPostRender() {

    }

    focus(options?: { focalPoint: Vec3, radius: number, speed: number }) {
        // Force scene bound update so bound values are current.
        const sceneBound = this.scene.bound;

        const getSplatInfo = () => {
            for (const element of this.scene.elements) {
                if (element.type === ElementType.splat) {
                    const splat = element as Splat;
                    const fp = splat.focalPoint?.();
                    if (fp) {
                        // Focal point = density-weighted center (dense region).
                        // Radius = full bounding box so the entire model is visible.
                        const boundR = splat.worldBound.halfExtents.length();
                        return { focalPoint: fp, radius: boundR };
                    }
                }
            }
        };

        const splatInfo = options ? null : getSplatInfo();
        const focalPoint = options ? options.focalPoint : (splatInfo?.focalPoint ?? sceneBound.center);
        const focalRadius = options ? options.radius : (splatInfo?.radius ?? sceneBound.halfExtents.length());

        // setDistance stores a normalized value directly (no conversion).
        // onUpdate converts back: worldDist = distance * sceneRadius / fovFactor.
        // So to achieve a desired world distance W, we must pass:
        //   normalized = W / sceneRadius * fovFactor
        const sceneRadius = sceneBound.halfExtents.length();
        const fdist = focalRadius / sceneRadius * this.fovFactor;

        const speed = options?.speed ?? 0;

        this.setDistance(isFinite(fdist) ? fdist : 1, speed);
        this.setFocalPoint(focalPoint, speed);

        // Only reset viewing direction on initial import (no options).
        // When F is pressed with a selection (options provided), preserve
        // the user's current viewing angle — just refocus target & distance.
        // elev=-15 puts the camera slightly above the focal point looking
        // down, which is the standard natural 3D viewing angle.
        if (!options) {
            this.setAzimElev(0, -15, speed);
        }
    }

    get fovFactor() {
        // use the larger axis fov (which is always this.fov) so camera distance
        // stays constant regardless of viewport aspect ratio. Clamp fov to a
        // small positive floor: fov=0 (corrupt doc, animation keyframe, pose
        // override) would make sin()=0 and every distance computation below
        // divide by zero, producing NaN camera positions.
        const fov = Math.max(this.fov, 1e-4);
        return Math.sin(fov * math.DEG_TO_RAD * 0.5);
    }

    getRay(screenX: number, screenY: number, ray: Ray) {
        const { camera, ortho } = this;
        const cameraPos = this.mainCamera.getPosition();

        // create the pick ray in world space
        if (ortho) {
            camera.screenToWorld(screenX, screenY, -1.0, vec);
            camera.screenToWorld(screenX, screenY, 1.0, vecb);
            vecb.sub(vec).normalize();
            ray.set(vec, vecb);
        } else {
            camera.screenToWorld(screenX, screenY, 1.0, vec);
            vec.sub(cameraPos).normalize();
            ray.set(cameraPos, vec);
        }
    }

    // intersect the scene at the given normalized screen coordinate (0-1 range) using depth picking
    async intersect(x: number, y: number) {
        return (await this.intersectMany([{ x, y }]))[0];
    }

    // world size of one screen pixel at the given view depth (ortho is
    // depth-independent)
    worldSizePerPixel(depth: number) {
        const pixelScale = (2 / this.camera.projectionMatrix.data[5]) / Math.max(1, this.scene.canvas.clientHeight);
        return this.ortho ? pixelScale : pixelScale * depth;
    }

    // batch depth picking: intersect the scene at many normalized screen
    // coordinates (0-1 range), rendering the depth pass once per splat for the
    // whole batch - which is what keeps a sampled brush stroke practical (V3
    // sphere brush). The optional pose snapshot pins the frame the gesture was
    // made in: the call may run from the command queue well after the gesture
    // and the camera can move in between.
    async intersectMany(
        points: { x: number, y: number }[],
        splats = this.scene.getElementsByType(ElementType.splat) as Splat[],
        pose?: { position: Vec3, rotation: Quat, orthoHeight: number, near: number, far: number }
    ) {
        const { scene } = this;
        const closestDepths = points.map(() => Infinity);
        const closestSplats: (Splat | null)[] = new Array(points.length).fill(null);

        const cameraPos = pose?.position ?? this.mainCamera.getPosition().clone();
        const cameraRot = pose?.rotation ?? this.mainCamera.getRotation().clone();
        const orthoHeight = pose?.orthoHeight ?? this.camera.orthoHeight;
        const near = pose?.near ?? this.near;
        const far = pose?.far ?? this.far;
        const forward = cameraRot.transformVector(Vec3.FORWARD, new Vec3());

        // run fn with the camera swapped to the snapshot frame and restored
        // before returning: the rays, every depth pass and the near/far encoding
        // the depths are decoded with must all share one frame
        const withSnapshotCamera = (fn: () => void) => {
            const livePos = this.mainCamera.getPosition().clone();
            const liveRot = this.mainCamera.getRotation().clone();
            const liveOrthoHeight = this.camera.orthoHeight;
            const liveNear = this.near;
            const liveFar = this.far;

            this.mainCamera.setPosition(cameraPos);
            this.mainCamera.setRotation(cameraRot);
            this.camera.orthoHeight = orthoHeight;
            this.near = near;
            this.far = far;
            fn();
            this.mainCamera.setPosition(livePos);
            this.mainCamera.setRotation(liveRot);
            this.camera.orthoHeight = liveOrthoHeight;
            this.near = liveNear;
            this.far = liveFar;
        };

        // build the pick rays under the snapshot frame. getRay seeds the ray
        // origin differently per projection (the camera for perspective, the
        // near plane for ortho), so each origin's own view depth is measured
        // here rather than assuming near
        const rays: { origin: Vec3, direction: Vec3, cosAngle: number, originDepth: number }[] = [];
        withSnapshotCamera(() => {
            for (const { x, y } of points) {
                this.getRay(x * scene.canvas.clientWidth, y * scene.canvas.clientHeight, ray);
                rays.push({
                    origin: ray.origin.clone(),
                    direction: ray.direction.clone(),
                    cosAngle: ray.direction.dot(forward),
                    originDepth: vecb.sub2(ray.origin, cameraPos).dot(forward)
                });
            }
        });

        // find the splat with the smallest depth at each screen position
        for (let i = 0; i < splats.length; ++i) {
            const splat = splats[i];

            withSnapshotCamera(() => {
                this.picker.prepareDepth(splat);
            });
            const depths = await this.picker.readDepths(points);
            for (let j = 0; j < depths.length; ++j) {
                const depth = depths[j];
                if (depth !== null && depth < closestDepths[j]) {
                    closestDepths[j] = depth;
                    closestSplats[j] = splat;
                }
            }
        }

        return points.map((point, index) => {
            const splat = closestSplats[index];
            if (!splat) {
                return null;
            }

            // convert normalized depth to linear depth
            const linearDepth = closestDepths[index] * (far - near) + near;

            // calculate the world position from the snapshotted ray + view depth
            const { origin, direction, cosAngle, originDepth } = rays[index];
            const t = (linearDepth - originDepth) / cosAngle;
            const position = new Vec3();
            position.copy(origin).add(vec.copy(direction).mulScalar(t));

            return {
                splat,
                position,
                distance: t,
                depth: linearDepth
            };
        });
    }

    // intersect the scene at the normalized screen location (0-1 range) and focus the camera on this location
    async pickFocalPoint(x: number, y: number) {
        const result = await this.intersect(x, y);
        if (result) {
            const { scene } = this;

            this.setFocalPoint(result.position);
            this.setDistance(result.distance / this.sceneRadius * this.fovFactor);
            scene.events.fire('camera.focalPointPicked', {
                camera: this,
                splat: result.splat,
                position: result.position
            });
        }
    }

    // pick mode

    // render picker contents
    pickPrep(splat: Splat, mode: 'add' | 'remove' | 'set' | 'intersect') {
        this.picker.prepareId(splat, mode);
    }

    pick(x: number, y: number) {
        return this.picker.readId(x, y);
    }

    pickRect(x: number, y: number, width: number, height: number) {
        return this.picker.readIds(x, y, width, height);
    }

    docSerialize() {
        const pack3 = (v: Vec3) => [v.x, v.y, v.z];

        return {
            focalPoint: pack3(this.focalPointTween.target),
            azim: this.azim,
            elev: this.elevation,
            distance: this.distance,
            fov: this.fov,
            tonemapping: this.tonemapping
        };
    }

    docDeserialize(settings: any) {
        this.setFocalPoint(new Vec3(settings.focalPoint), 0);
        this.setAzimElev(settings.azim, settings.elev, 0);
        this.setDistance(settings.distance, 0);
        this.fov = settings.fov;
        this.tonemapping = settings.tonemapping;
    }

    // offscreen render mode

    startOffscreenMode(width: number, height: number) {
        this.targetSizeOverride = { width, height };
        this.finalPass.enabled = false;
        this.rebuildRenderTargets();
        this.onUpdate(0);
    }

    endOffscreenMode() {
        this.targetSizeOverride = null;
        this.finalPass.enabled = true;
        this.rebuildRenderTargets();
        this.onUpdate(0);
    }

    get targetSize() {
        return this.targetSizeOverride ?? this.scene.targetSize;
    }

    get camera() {
        return this.mainCamera.camera;
    }

    get worldTransform() {
        return this.mainCamera.getWorldTransform();
    }

    get position() {
        return this.mainCamera.getPosition();
    }

    get forward() {
        return this.mainCamera.forward;
    }
}

export { Camera };
