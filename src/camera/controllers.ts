import { Vec3 } from 'playcanvas';

import { Camera } from './camera';
import { DEFAULT_MOUSE_BINDINGS, MouseAction, MouseBindingsState } from './mouse-bindings';

const fromWorldPoint = new Vec3();
const toWorldPoint = new Vec3();
const worldDiff = new Vec3();
const moveVec = new Vec3();

// calculate the distance between two 2d points
const dist = (x0: number, y0: number, x1: number, y1: number) => Math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2);

class PointerController {
    update: (deltaTime: number) => void;
    destroy: () => void;

    constructor(camera: Camera, target: HTMLElement) {

        // Orbit mode: rotate camera around the focal point
        const orbit = (dx: number, dy: number) => {
            // clear any frozen camera position from a prior look() call,
            // otherwise orbit rotates around the frozen position (fly-like)
            camera.lookCameraPos = null;
            const azim = camera.azim - dx * camera.scene.config.controls.orbitSensitivity;
            const elev = camera.elevation - dy * camera.scene.config.controls.orbitSensitivity;
            camera.setAzimElev(azim, elev);
        };

        const look = (dx: number, dy: number) => {
            camera.look(dx, dy);
        };

        const pan = (x: number, y: number, dx: number, dy: number) => {
            // For panning to work at any zoom level, we use screen point to world projection
            // to work out how far we need to pan the pivotEntity in world space
            const c = camera.camera;
            const distance = camera.distanceTween.value.distance * camera.sceneRadius / camera.fovFactor;

            c.screenToWorld(x, y, distance, fromWorldPoint);
            c.screenToWorld(x - dx, y - dy, distance, toWorldPoint);

            worldDiff.sub2(toWorldPoint, fromWorldPoint);
            worldDiff.add(camera.focalPoint);

            camera.setFocalPoint(worldDiff);
        };

        const zoom = (amount: number) => {
            camera.setDistance(camera.distance - (camera.distance * 0.999 + 0.001) * amount * camera.scene.config.controls.zoomSensitivity, 2);
        };

        // ---- customizable mouse-button → action mapping ----
        // Reads the user-configured layout (tools → 自定义操控 panel). Falls
        // back to the default layout (left=orbit, middle=pan, right=look) when
        // the binding module is unavailable or storage is empty.
        const getActionForButton = (button: number): MouseAction => {
            try {
                const bindings = (camera.scene.events.invoke('mouseBindings.get') as MouseBindingsState) ?? DEFAULT_MOUSE_BINDINGS;
                if (button === 0) return bindings.left;
                if (button === 1) return bindings.middle;
                if (button === 2) return bindings.right;
            } catch { /* fall through to default */ }
            return DEFAULT_MOUSE_BINDINGS.left;
        };

        // dispatch one drag-step (dx, dy) to the action mapped for `button`
        const applyButtonAction = (button: number, dx: number, dy: number, px: number, py: number) => {
            // First-person walk: any drag turns the head (ignore custom mapping)
            if (camera.controlMode === 'walk') {
                look(dx, dy);
                return;
            }
            const action = getActionForButton(button);
            if (action === 'pan') {
                pan(px, py, dx, dy);
            } else if (action === 'look') {
                look(dx, dy);
            } else if (action === 'zoom') {
                zoom(dy * 0.01);
            } else {
                orbit(dx, dy);
            }
        };

        // mouse state
        let pressedButton = -1;  // no button pressed, otherwise 0, 1, or 2
        let x: number, y: number;

        // ---- inertial momentum (drag-release coasting) ----
        let velocityX = 0, velocityY = 0;
        let inertiaButton = -1;  // which button mode to coast with (0=orbit,1=pan,2=look)
        let inertiaActive = false;
        let inertiaEnabled = false;
        const INERTIA_DAMPING = 0.92;
        const INERTIA_THRESHOLD = 0.05;

        // ---- auto-rotation turntable ----
        let autoRotateMode: 'off' | 'orbit' | 'look' = 'off';
        let autoRotateSpeed = 15;  // degrees per second (configurable via slider)

        // touch state
        let touches: { id: number, x: number, y: number}[] = [];
        let midx: number, midy: number, midlen: number;

        const pointerdown = (event: PointerEvent) => {
            // Exit Camera View Mode when user interacts with the viewport,
            // returning to the normal free-orbit state machine.
            camera.cameraViewMode = false;

            if (event.pointerType === 'mouse') {
                // If a button is already pressed, ignore this press
                if (pressedButton !== -1) {
                    return;
                }
                // Any manual viewport interaction stops auto-rotation.
                velocityX = 0; velocityY = 0;
                inertiaActive = false;
                if (autoRotateMode !== 'off') {
                    autoRotateMode = 'off';
                    camera.scene.events.fire('camera.autoRotateChanged', 'off');
                }

                // Left-click in fly mode (entered via WASD/QE movement) returns
                // to orbit mode: the user moved the view with the keyboard and
                // expects a left drag to orbit again, not to fly-look. The
                // right toolbar's fly/orbit buttons follow via camera.controlMode.
                if (event.button === 0 && camera.controlMode === 'fly') {
                    camera.scene.events.fire('camera.setControlMode', 'orbit');
                }

                target.setPointerCapture(event.pointerId);
                pressedButton = event.button;
                x = event.offsetX;
                y = event.offsetY;
                camera.userDragging = true;
            } else if (event.pointerType === 'touch') {
                if (touches.length === 0) {
                    target.setPointerCapture(event.pointerId);
                }
                camera.userDragging = true;
                touches.push({
                    x: event.offsetX,
                    y: event.offsetY,
                    id: event.pointerId
                });

                if (touches.length === 2) {
                    midx = (touches[0].x + touches[1].x) * 0.5;
                    midy = (touches[0].y + touches[1].y) * 0.5;
                    midlen = dist(touches[0].x, touches[0].y, touches[1].x, touches[1].y);
                }
            }
        };

        const pointerup = (event: PointerEvent) => {
            if (event.pointerType === 'mouse') {
                // Only release if this is the button that was initially pressed
                if (event.button === pressedButton) {
                    // Start inertial coasting (if enabled)
                    if (inertiaEnabled && (Math.abs(velocityX) > 0.1 || Math.abs(velocityY) > 0.1)) {
                        inertiaButton = pressedButton;
                        inertiaActive = true;
                    }
                    pressedButton = -1;
                    // the capture may already be gone (implicit release, or a
                    // pointerup that never had one): releasing again throws
                    if (target.hasPointerCapture(event.pointerId)) {
                        target.releasePointerCapture(event.pointerId);
                    }
                    // Stay "dragging" while inertia coasts so overlays (PiP)
                    // keep skipping work until the view settles.
                    camera.userDragging = inertiaActive;
                }
            } else {
                touches = touches.filter(touch => touch.id !== event.pointerId);
                if (touches.length === 0) {
                    if (target.hasPointerCapture(event.pointerId)) {
                        target.releasePointerCapture(event.pointerId);
                    }
                    camera.userDragging = false;
                }
            }
        };

        // pointercancel (system gesture, touch scroll capture, alt-tab mid-drag)
        // never fires pointerup — without this the drag state (pressedButton /
        // touches) stays stuck and the camera keeps orbiting with no button
        // pressed. NOTE: we deliberately do NOT release pointer capture here —
        // the canvas capture may belong to an active gizmo (TransformGizmo also
        // setPointerCaptures the same canvas on its own drags), and releasing it
        // out from under the gizmo leaves ITS drag state stuck. We only clear
        // our own bookkeeping; the browser releases capture itself after cancel.
        const pointercancel = (event: PointerEvent) => {
            if (event.pointerType === 'mouse') {
                pressedButton = -1;
                inertiaActive = false;
                camera.userDragging = false;
            } else {
                touches = touches.filter(touch => touch.id !== event.pointerId);
            }
        };

        const pointermove = (event: PointerEvent) => {
            if (event.pointerType === 'mouse') {
                // Only process if we're tracking a button
                if (pressedButton === -1) {
                    return;
                }

                // Verify the button we're tracking is still pressed
                // 1 = left button, 4 = middle button, 2 = right button
                const buttonMask = [1, 4, 2][pressedButton];
                if ((event.buttons & buttonMask) === 0) {
                    // Button is no longer pressed, clean up
                    pressedButton = -1;
                    return;
                }

                const dx = event.offsetX - x;
                const dy = event.offsetY - y;
                x = event.offsetX;
                y = event.offsetY;

                // Record velocity for inertial coasting
                velocityX = dx;
                velocityY = dy;

                // Customizable button mappings (tools → 自定义操控 panel):
                // each of left/middle/right can be orbit / pan / look / zoom.
                applyButtonAction(pressedButton, dx, dy, x, y);
            } else {
                if (touches.length === 1) {
                    const touch = touches[0];
                    const dx = event.offsetX - touch.x;
                    const dy = event.offsetY - touch.y;
                    touch.x = event.offsetX;
                    touch.y = event.offsetY;

                    if (camera.controlMode === 'fly' || camera.controlMode === 'walk') {
                        look(dx, dy);
                    } else {
                        orbit(dx, dy);
                    }
                } else if (touches.length === 2) {
                    const touch = touches[touches.map(t => t.id).indexOf(event.pointerId)];
                    touch.x = event.offsetX;
                    touch.y = event.offsetY;

                    const mx = (touches[0].x + touches[1].x) * 0.5;
                    const my = (touches[0].y + touches[1].y) * 0.5;
                    const ml = dist(touches[0].x, touches[0].y, touches[1].x, touches[1].y);

                    if (camera.controlMode === 'fly' || camera.controlMode === 'walk') {
                        // In fly mode, pinch moves forward/backward by moving focal point
                        const zoomDelta = (ml - midlen) * 0.01;
                        const worldTransform = camera.mainCamera.getWorldTransform();
                        const zAxis = worldTransform.getZ();
                        moveVec.copy(zAxis).mulScalar(-zoomDelta * camera.flySpeed);
                        if (camera.controlMode === 'walk') {
                            camera.walkMove(moveVec.x, 0, moveVec.z);
                        } else {
                            const p = camera.focalPoint.add(moveVec);
                            camera.setFocalPoint(p);
                        }
                    } else {
                        pan(mx, my, (mx - midx), (my - midy));
                        zoom((ml - midlen) * 0.01);
                    }

                    midx = mx;
                    midy = my;
                    midlen = ml;
                }
            }
        };

        // A physical mouse wheel and a trackpad two-finger swipe are
        // indistinguishable from their wheel-event deltas alone - every
        // per-event heuristic (wheelDelta % 120, deltaMode, fractional or
        // diagonal deltas) misfires on hi-res mice and in momentum tails
        // (see issue #919). The one reliable trackpad signal the platform
        // gives us is the macOS-synthesized pinch: a wheel event with
        // ctrlKey set while the physical Ctrl key is *not* held. So we no
        // longer classify the device and instead drive everything from
        // modifier keys, treating a bare scroll as zoom regardless of device:
        //
        // | Input                       | Action |
        // |-----------------------------|--------|
        // | Bare scroll (wheel / swipe) | zoom   |
        // | Pinch (synthetic Ctrl)      | zoom   |
        // | Physical Ctrl + scroll      | orbit  |
        // | Shift + scroll              | pan    |

        // Track the physical Ctrl key so we can tell a real Ctrl+scroll
        // (orbit) from a macOS pinch (zoom). Listeners live on window so they
        // fire regardless of which element currently has focus.
        let ctrlDown = false;
        const keydown = (event: KeyboardEvent) => {
            if (event.key === 'Control') ctrlDown = true;
        };
        const keyup = (event: KeyboardEvent) => {
            if (event.key === 'Control') ctrlDown = false;
        };

        const wheel = (event: WheelEvent) => {
            const { deltaX, deltaY } = event;

            // Wheel interaction window: overlays (PiP) skip work for a short
            // while after the last wheel event (see update()).
            lastWheelTime = performance.now();
            camera.userDragging = true;

            // Stop auto-rotation on scroll interaction
            if (autoRotateMode !== 'off') {
                autoRotateMode = 'off';
                camera.scene.events.fire('camera.autoRotateChanged', 'off');
            }

            // Some browsers (notably Safari/Firefox on macOS) remap a vertical
            // mouse wheel to deltaX when Shift is held. Only fall back to
            // deltaX for that remapped case so horizontal-only scrolling
            // (tilt wheel, horizontal trackpad swipe) is not treated as
            // zoom / fly movement.
            const wheelDelta = event.shiftKey && deltaY === 0 ? deltaX : deltaY;

            // Synthetic Ctrl (macOS/Magic Mouse pinch) or Cmd: fine zoom.
            // Physical Ctrl held down: orbit.
            const isPinch = (event.ctrlKey && !ctrlDown) || event.metaKey;
            const isOrbit = event.ctrlKey && ctrlDown;

            if (camera.controlMode === 'fly' || camera.controlMode === 'walk') {
                if (isOrbit) {
                    look(deltaX, deltaY);
                } else if (event.shiftKey) {
                    pan(event.offsetX, event.offsetY, deltaX, deltaY);
                } else if (camera.ortho) {
                    // moving forward/backward has no visual effect in ortho
                    // (ortho height derives from distance), so zoom instead,
                    // with the same pinch/scroll factors as the orbit path
                    zoom(isPinch ? deltaY * -0.02 : wheelDelta * -0.002);
                } else {
                    // Bare scroll / pinch: walk/fly forward or backward
                    const factor = camera.flySpeed * 0.01;
                    const worldTransform = camera.mainCamera.getWorldTransform();
                    const zAxis = worldTransform.getZ();
                    moveVec.copy(zAxis).mulScalar(wheelDelta * factor);
                    if (camera.controlMode === 'walk') {
                        camera.walkMove(moveVec.x, 0, moveVec.z);
                    } else {
                        const p = camera.focalPoint.add(moveVec);
                        camera.setFocalPoint(p);
                    }
                }
            } else if (isOrbit) {
                orbit(deltaX, deltaY);
            } else if (event.shiftKey) {
                pan(event.offsetX, event.offsetY, deltaX, deltaY);
            } else if (isPinch) {
                zoom(deltaY * -0.02);
            } else {
                zoom(wheelDelta * -0.002);
            }

            event.preventDefault();
        };

        // FIXME: safari sends canvas as target of dblclick event but chrome sends the target element
        const canvas = camera.scene.app.graphicsDevice.canvas;

        const dblclick = (event: globalThis.MouseEvent) => {
            if (event.target === target || event.target === canvas) {
                // Switch to orbit mode when double-clicking to focus
                if (camera.controlMode === 'fly') {
                    camera.scene.events.fire('camera.setControlMode', 'orbit');
                }
                camera.pickFocalPoint(event.offsetX / target.clientWidth, event.offsetY / target.clientHeight);
            }
        };

        // fly movement state (updated via shortcut events)
        let flyForward = false;
        let flyBackward = false;
        let flyLeft = false;
        let flyRight = false;
        let flyDown = false;
        let flyUp = false;

        // track modifier keys for speed control (updated via shortcut events)
        let fastDown = false;
        let slowDown = false;

        // Timestamp of the last wheel event; the view is considered "in
        // interaction" for a short window after it so overlays (PiP) skip work
        // during scroll-zoom too (a continuous wheel stream re-renders the PiP
        // every throttle frame otherwise).
        let lastWheelTime = 0;

        // Clear all keys when window loses focus to prevent stuck keys
        const clearAllKeys = () => {
            flyForward = false;
            flyBackward = false;
            flyLeft = false;
            flyRight = false;
            flyDown = false;
            flyUp = false;
            fastDown = false;
            slowDown = false;
            ctrlDown = false;
        };

        // Helper to switch to fly mode when a fly key is pressed. Walk mode is
        // a movement mode too — a WASD press must not pull the user out of it.
        const handleFlyKey = (down: boolean) => {
            if (down && camera.controlMode === 'orbit') {
                camera.scene.events.fire('camera.setControlMode', 'fly');
            }
        };

        // Listen for fly movement shortcut events
        const events = camera.scene.events;

        const onFlyForward = (down: boolean) => {
            flyForward = down;
            handleFlyKey(down);
        };
        const onFlyBackward = (down: boolean) => {
            flyBackward = down;
            handleFlyKey(down);
        };
        const onFlyLeft = (down: boolean) => {
            flyLeft = down;
            handleFlyKey(down);
        };
        const onFlyRight = (down: boolean) => {
            flyRight = down;
            handleFlyKey(down);
        };
        const onFlyDown = (down: boolean) => {
            flyDown = down;
            handleFlyKey(down);
        };
        const onFlyUp = (down: boolean) => {
            flyUp = down;
            handleFlyKey(down);
        };
        const onModifierFast = (down: boolean) => {
            fastDown = down;
        };
        const onModifierSlow = (down: boolean) => {
            slowDown = down;
        };

        events.on('camera.fly.forward', onFlyForward);
        events.on('camera.fly.backward', onFlyBackward);
        events.on('camera.fly.left', onFlyLeft);
        events.on('camera.fly.right', onFlyRight);
        events.on('camera.fly.down', onFlyDown);
        events.on('camera.fly.up', onFlyUp);
        events.on('camera.modifier.fast', onModifierFast);
        events.on('camera.modifier.slow', onModifierSlow);

        this.update = (deltaTime: number) => {
            // ---- inertial coasting (when no button pressed) ----
            if (inertiaActive && pressedButton === -1) {
                const speed = Math.abs(velocityX) + Math.abs(velocityY);
                if (speed < INERTIA_THRESHOLD) {
                    velocityX = 0;
                    velocityY = 0;
                    inertiaActive = false;
                } else {
                    applyButtonAction(inertiaButton, velocityX, velocityY, x, y);
                    velocityX *= INERTIA_DAMPING;
                    velocityY *= INERTIA_DAMPING;
                }
            }

            // ---- auto-rotation turntable ----
            // Skip auto-rotate when deltaTime is 0 (e.g. during video export,
            // offscreen mode setup). Auto-rotate should only advance when real
            // time passes; otherwise adjustHeading(0) in 'look' mode modifies
            // focal point tweens and sets lookCameraPos, which interferes with
            // the orbit camera position calculation.
            if (autoRotateMode !== 'off' && deltaTime > 0) {
                // advance azimuth to create automatic rotation
                // 'orbit' mode: rotate around focal point
                // 'look' mode:  rotate camera in place (look around)
                const deltaAzim = autoRotateSpeed * deltaTime;
                if (autoRotateMode === 'look') {
                    camera.adjustHeading(deltaAzim);
                } else {
                    camera.setAzimElev(camera.azim + deltaAzim, camera.elevation);
                }
            }

            // Keep camera.userDragging in sync with every interaction state:
            // active button press, inertial coasting, or a recent wheel stream.
            // Must run BEFORE the fly-mode early return so orbit-mode inertia
            // stop clears it too.
            const wheelActive = performance.now() - lastWheelTime < 150;
            camera.userDragging = pressedButton !== -1 || inertiaActive || wheelActive;

            // ---- fly/walk WASD movement ----
            // walk mode reuses the fly movement keys, but moves the eye
            // horizontally (floor-locked) instead of the orbit focal point.
            const isWalk = camera.controlMode === 'walk';
            if (camera.controlMode !== 'fly' && !isWalk) return;

            // Fly/walk: WASD for movement, Q/E for up/down (ignored in walk)
            const forward = (flyForward ? 1 : 0) - (flyBackward ? 1 : 0);
            const strafe = (flyRight ? 1 : 0) - (flyLeft ? 1 : 0);
            const vertical = isWalk ? 0 : (flyUp ? 1 : 0) - (flyDown ? 1 : 0);

            if (forward || strafe || vertical) {
                // Calculate speed modifier based on current modifier key state
                const speedMod = fastDown ? 10 : (slowDown ? 0.1 : 1);
                const factor = deltaTime * camera.flySpeed * speedMod;
                const worldTransform = camera.worldTransform;

                moveVec.set(0, 0, 0);

                // Forward/backward along horizontal forward direction (fixed Y)
                if (forward) {
                    const zAxis = worldTransform.getZ();
                    zAxis.y = 0;
                    zAxis.normalize();
                    moveVec.add(zAxis.mulScalar(-forward * factor));
                }

                // Strafe left/right (horizontal)
                if (strafe) {
                    const xAxis = worldTransform.getX();
                    xAxis.y = 0;
                    xAxis.normalize();
                    moveVec.add(xAxis.mulScalar(strafe * factor));
                }

                // Up/down in world space
                if (vertical) {
                    moveVec.y += vertical * factor;
                }

                if (isWalk) {
                    // walk: translate the frozen eye position horizontally
                    camera.walkMove(moveVec.x, 0, moveVec.z);
                } else {
                    // Move the focal point (camera follows due to orbit calculation)
                    const p = camera.focalPoint.add(moveVec);
                    camera.setFocalPoint(p);
                }
                // Fly/walk-key movement is interaction too — overlays keep skipping.
                camera.userDragging = true;
            }
        };

        let destroy: () => void = null;

        // ---- auto-rotation mode event ----
        events.on('camera.setAutoRotateMode', (mode: 'off' | 'orbit' | 'look') => {
            autoRotateMode = mode;
            camera.scene.events.fire('camera.autoRotateChanged', mode);
            if (mode === 'look') {
                // 环视：以相机当前位置为中心旋转，自动切到飞行模式
                if (camera.controlMode !== 'fly') {
                    camera.scene.events.fire('camera.setControlMode', 'fly');
                }
            } else if (mode === 'orbit') {
                // 环绕：回归初始焦点，切回环绕模式
                if (camera.controlMode === 'fly' && camera.flyEntryPose) {
                    camera.setFocalPoint(camera.flyEntryPose.focalPoint);
                    camera.scene.events.fire('camera.setControlMode', 'orbit');
                }
            }
        });
        events.function('camera.getAutoRotateMode', () => autoRotateMode);

        // ---- auto-rotation speed event ----
        events.on('camera.setAutoRotateSpeed', (speed: number) => {
            autoRotateSpeed = speed;
        });
        events.function('camera.getAutoRotateSpeed', () => autoRotateSpeed);

        // ---- inertia toggle event ----
        events.on('camera.inertia', (enabled: boolean) => {
            inertiaEnabled = enabled;
            if (!enabled) {
                inertiaActive = false;
                velocityX = 0;
                velocityY = 0;
            }
            camera.scene.events.fire('camera.inertiaChanged', enabled);
        });

        const wrap = (target: any, name: string, fn: any, options?: any) => {
            const callback = (event: any) => {
                camera.scene.events.fire('camera.controller', name);
                fn(event);
            };
            target.addEventListener(name, callback, options);
            const prevDestroy = destroy;
            destroy = () => {
                prevDestroy?.();
                target.removeEventListener(name, callback);
            };
        };

        wrap(target, 'pointerdown', pointerdown);
        wrap(target, 'pointerup', pointerup);
        wrap(target, 'pointercancel', pointercancel);
        wrap(target, 'pointermove', pointermove);
        wrap(target, 'wheel', wheel, { passive: false });
        wrap(target, 'dblclick', dblclick);
        wrap(window, 'blur', clearAllKeys);

        // Registered directly (not via wrap) so physical-Ctrl tracking
        // doesn't fire camera.controller on every keystroke. Capture phase
        // ensures we see Ctrl keydown/keyup even when a focused UI element
        // (dialogs, popups) calls stopPropagation() on key events - otherwise
        // ctrlDown could go stale and a real Ctrl+wheel would be misread as a
        // synthetic-Ctrl pinch.
        window.addEventListener('keydown', keydown, { capture: true });
        window.addEventListener('keyup', keyup, { capture: true });

        this.destroy = () => {
            destroy?.();
            window.removeEventListener('keydown', keydown, { capture: true });
            window.removeEventListener('keyup', keyup, { capture: true });
            events.off('camera.fly.forward', onFlyForward);
            events.off('camera.fly.backward', onFlyBackward);
            events.off('camera.fly.left', onFlyLeft);
            events.off('camera.fly.right', onFlyRight);
            events.off('camera.fly.down', onFlyDown);
            events.off('camera.fly.up', onFlyUp);
            events.off('camera.modifier.fast', onModifierFast);
            events.off('camera.modifier.slow', onModifierSlow);
            events.off('camera.setAutoRotateMode');
        };
    }
}

export { PointerController };
