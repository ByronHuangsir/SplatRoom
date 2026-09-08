import { Vec3, math } from 'playcanvas';

import { Camera } from './camera';
import { Events } from './events';
import {
    GamepadConfig,
    defaultConfig,
    loadConfig,
    saveConfig,
    RESERVED_BINDING_INDICES
} from './gamepad-config';

// --- Constants ---

const DEADZONE = 0.08;          // default deadzone (used as applyDeadzone fallback)
const TRIGGER_DEADZONE = 0.02;  // analog trigger deadzone (fixed)
const PITCH_LIMIT = 80;         // degrees, -80 ~ +80

// Base movement speed (scene units per second at gear 1)
const BASE_MOVE_SPEED = 2.0;
// Rotation speed (degrees per second at full stick deflection)
const ROTATION_SPEED = 120.0;
// Height change speed (scene units per second)
const HEIGHT_SPEED = 3.0;
// Gimbal pitch speed (degrees per second, drone mode)
const GIMBAL_PITCH_SPEED = 60.0;
// FOV adjust speed (degrees per second, D-pad left/right held)
const FOV_ADJUST_SPEED = 30.0;

// 指数速度档位（每档 ×2），档位 2 = 2.0x 为默认（对齐 v1.3.0）
const SPEED_GEARS = [0.5, 1.0, 2.0, 4.0, 8.0, 16.0];

// --- Utility functions ---

const mod = (n: number, m: number) => ((n % m) + m) % m;
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

const applyDeadzone = (value: number, deadzone: number = DEADZONE) => {
    const mag = Math.abs(value);
    if (mag < deadzone) return 0;
    const sign = Math.sign(value);
    const normalized = (mag - deadzone) / (1 - deadzone);
    return sign * normalized;
};

// Square easing curve - finer control at low deflection, full speed at max
const applyCurve = (value: number) => Math.sign(value) * value * value;

// Exponential smoothing - lerp current towards target
const smooth = (current: number, target: number, factor: number) => current + (target - current) * factor;

// --- Types ---

export type GamepadMode = 'gamepad' | 'drone';
export type SubMode = 'normal' | 'browse';

interface StickState {
    x: number;
    y: number;
}

// Reusable vectors
const forwardVec = new Vec3();
const cameraPos = new Vec3();
const moveVec = new Vec3();
const newFocal = new Vec3();

/**
 * GamepadController - 手柄输入核心控制器（SplatRoom 合并版）。
 *
 * 融合来源：
 *  - 开发包（3DGS-Gamepad v3）：双操控模式（FPS 漫游 / 无人机遥控）、5 档速度、
 *    FOV 调节、出生点、锁高、可重绑键位（Xbox/PS 预设 + localStorage 持久化）
 *  - SplatRoom 原有 gamepad.ts：enabled 开关（右工具栏按钮 / 可重绑动作）、
 *    浏览子模式（隐藏 UI 沉浸查看）、编辑器动作（聚焦 / orbit-fly 切换 / 预设视角）
 *
 * 启用方式：
 *  - 右工具栏「手柄」按钮 → fire('gamepad.toggle')
 *  - 可重绑动作 toggleEnabled（默认未绑定）
 */
class GamepadController {
    private camera: Camera;
    private events: Events;

    /** 手柄模式开关（工具栏按钮 / toggleEnabled 动作） */
    private enabled = false;
    /** 浏览子模式：隐藏编辑器 UI 沉浸查看（仅手柄启用时有效） */
    private subMode: SubMode = 'normal';
    private mode: GamepadMode = 'gamepad';

    // User configuration (button bindings + axis tuning) - single source of truth
    private config: GamepadConfig;

    // True while the settings panel is open (panel takes over all input)
    private settingsOpen = false;

    // Speed state
    private speedGearIndex = 2;  // start at gear 2 (2.0x, the default)

    // Height lock
    private heightLocked = false;

    // True while the bottom control menu is open (D-pad left/right switch mode)
    private menuOpen = false;

    // Drone mode gimbal independence
    private followMode = true;

    // Smoothed stick values
    private leftStick: StickState = { x: 0, y: 0 };
    private rightStick: StickState = { x: 0, y: 0 };
    private ltValue = 0;
    private rtValue = 0;
    private lbHeld = false;
    private rbHeld = false;

    // Button edge detection (previous frame state)
    private prevButtons: boolean[] = new Array(18).fill(false);

    // Throttle for the button-mapping diagnostic log
    private diagLogTime = 0;

    // Initial camera pose for reset (model baseline, set when the scene bound changes)
    private initialPose: {
        focalPoint: Vec3;
        azim: number;
        elev: number;
        distance: number;
    } | null = null;

    // User-defined start pose (set via the "set origin" action).
    private startPose: {
        focalPoint: Vec3;
        azim: number;
        elev: number;
        distance: number;
    } | null = null;

    // Active gamepad index
    private gamepadIndex: number | null = null;

    private wasConnected = false;

    constructor(camera: Camera, events: Events) {
        this.camera = camera;
        this.events = events;

        // Load persisted user configuration (button bindings + axis tuning)
        this.config = loadConfig();

        // Guarantee every action has a valid binding even if persisted storage
        // is partial/corrupted.
        const fullDefaults = defaultConfig();
        for (const id of Object.keys(fullDefaults.bindings)) {
            const b = this.config.bindings[id];
            if (!b || typeof b.index !== 'number' || (b.type !== 'button' && b.type !== 'trigger')) {
                this.config.bindings[id] = { ...fullDefaults.bindings[id] };
            }
        }

        // Expose the authoritative config to UI panels
        events.function('gamepad.config', () => this.config);

        events.on('gamepad.setConfig', (cfg: GamepadConfig) => {
            this.config = cfg;
            saveConfig(cfg);
            events.fire('gamepad.configChanged', cfg);
        });

        events.on('gamepad.resetConfig', () => {
            this.config = defaultConfig();
            saveConfig(this.config);
            events.fire('gamepad.configChanged', this.config);
        });

        // --- SplatRoom: enabled toggle + browse sub-mode ---
        events.on('gamepad.toggle', () => {
            this.setEnabled(!this.enabled);
        });
        events.on('gamepad.setEnabled', (value: boolean) => {
            this.setEnabled(value);
        });
        events.on('gamepad.setSubMode', (mode: SubMode) => {
            this.setSubMode(mode);
        });

        // Settings panel open/close (triggered by LS click or the bottom menu)
        events.on('gamepad.settingsOpen', () => {
            this.settingsOpen = true;
        });
        events.on('gamepad.settingsClosed', () => {
            this.settingsOpen = false;
        });

        // Mode changes from the menu UI
        events.on('gamepad.setMode', (mode: GamepadMode) => {
            this.mode = mode;
        });
        events.function('gamepad.mode', () => this.mode);

        // Bottom control menu visibility (D-pad left/right switch mode while open)
        events.on('gamepad.menuVisibility', (open: boolean) => {
            this.menuOpen = open;
        });

        events.on('gamepad.toggleHeightLock', () => {
            this.toggleHeightLock();
        });
        events.function('gamepad.heightLocked', () => this.heightLocked);

        events.on('gamepad.setSpeedGear', (index: number) => {
            this.speedGearIndex = clamp(index, 0, SPEED_GEARS.length - 1);
            events.fire('gamepad.speedGear', this.speedGearIndex);
        });
        events.function('gamepad.speedGear', () => this.speedGearIndex);

        // Store initial pose when scene bound changes (model loaded)
        events.on('scene.boundChanged', () => {
            this.storeInitialPose();
        });

        // Detect gamepad connection/disconnection
        window.addEventListener('gamepadconnected', (e: GamepadEvent) => {
            this.gamepadIndex = e.gamepad.index;
            this.wasConnected = true;
            console.log(`Gamepad connected: ${e.gamepad.id}`);
            events.fire('gamepad.connected', e.gamepad.id);
        });

        window.addEventListener('gamepaddisconnected', (e: GamepadEvent) => {
            if (this.gamepadIndex === e.gamepad.index) {
                this.gamepadIndex = null;
                console.log(`Gamepad disconnected: ${e.gamepad.id}`);
                events.fire('gamepad.disconnected');
            }
        });

        // Register for the per-frame update event (scene.ts fires 'update')
        events.on('update', (dt: number) => this.update(dt));
    }

    // --- SplatRoom: enabled / sub-mode state ---

    private setEnabled(value: boolean) {
        if (this.enabled === value) return;
        this.enabled = value;
        this.events.fire('gamepad.modeChanged', this.enabled);
        // 进入手柄模式时默认回到普通子模式
        if (value && this.subMode !== 'normal') {
            this.setSubMode('normal');
        }
    }

    private setSubMode(mode: SubMode) {
        if (this.subMode === mode) return;
        this.subMode = mode;
        this.events.fire('gamepad.subModeChanged', mode);
    }

    private toggleSubMode() {
        this.setSubMode(this.subMode === 'browse' ? 'normal' : 'browse');
    }

    // --- Scene baseline ---

    private storeInitialPose() {
        const pose = {
            focalPoint: this.camera.focalPoint.clone(),
            azim: this.camera.azim,
            elev: this.camera.elevation,
            distance: this.camera.distance
        };
        this.initialPose = pose;
        // A newly loaded model also resets the user-defined start point
        this.startPose = pose;
    }

    // --- Gamepad polling ---

    private getGamepad(): Gamepad | null {
        if (this.gamepadIndex !== null) {
            const pads = navigator.getGamepads();
            if (pads[this.gamepadIndex]) {
                return pads[this.gamepadIndex];
            }
        }
        const pads = navigator.getGamepads();
        for (let i = 0; i < pads.length; i++) {
            if (pads[i]) {
                this.gamepadIndex = i;
                return pads[i];
            }
        }
        return null;
    }

    private btnActive(buttonIndex: number, gamepad: Gamepad): boolean {
        const b = gamepad.buttons[buttonIndex];
        if (!b) return false;
        if (b.pressed) return true;
        return typeof b.value === 'number' && b.value > 0.5;
    }

    private justPressed(buttonIndex: number, gamepad: Gamepad): boolean {
        const current = this.btnActive(buttonIndex, gamepad);
        const prev = this.prevButtons[buttonIndex] ?? false;
        return current && !prev;
    }

    private getTriggerValue(buttonIndex: number, gamepad: Gamepad): number {
        const button = gamepad.buttons[buttonIndex];
        if (!button) return 0;
        if (typeof button.value === 'number') {
            return Math.max(0, button.value - TRIGGER_DEADZONE) / (1 - TRIGGER_DEADZONE);
        }
        return this.btnActive(buttonIndex, gamepad) ? 1 : 0;
    }

    /**
     * Snapshot the current button state into prevButtons for rising-edge
     * detection. MUST run at the END of the frame - after every justPressed()
     * consumer - otherwise all rising edges read prev == current and silently
     * disable every button action.
     */
    private refreshPrevButtons(gamepad: Gamepad) {
        for (let i = 0; i < gamepad.buttons.length; i++) {
            this.prevButtons[i] = this.btnActive(i, gamepad);
        }
    }

    // --- Per-frame update ---

    private update(deltaTime: number) {
        const gamepad = this.getGamepad();
        if (!gamepad) return;

        const bindings = this.config.bindings;

        // LS click (index 10 - fixed, not rebindable) toggles the settings panel.
        // Checked even while the panel is open so it can be closed from the controller.
        if (this.justPressed(10, gamepad)) {
            if (this.settingsOpen) {
                this.settingsOpen = false;
                this.events.fire('gamepad.settingsClosed');
            } else {
                this.settingsOpen = true;
                this.events.fire('gamepad.settingsOpen');
            }
        }

        // toggleEnabled: 无论手柄模式是否启用都响应（否则无法用手柄开机）。
        // 默认未绑定，工具栏按钮同样可开关。
        const toggleIdx = bindings.toggleEnabled?.index;
        if (toggleIdx !== undefined && !RESERVED_BINDING_INDICES.includes(toggleIdx) && this.justPressed(toggleIdx, gamepad)) {
            this.setEnabled(!this.enabled);
        }

        // While the settings panel is open the controller pauses all camera input.
        if (this.settingsOpen) {
            this.refreshPrevButtons(gamepad);
            return;
        }

        // 手柄模式未启用：仅响应开关/设置，不处理任何相机输入。
        if (!this.enabled) {
            this.refreshPrevButtons(gamepad);
            return;
        }

        const cfg = this.config.axis;

        // --- Read raw stick values ---
        const rawLeftX = gamepad.axes[0] ?? 0;
        const rawLeftY = gamepad.axes[1] ?? 0;
        const rawRightX = gamepad.axes[2] ?? 0;
        const rawRightY = gamepad.axes[3] ?? 0;

        const targetLeftX = applyDeadzone(rawLeftX, cfg.deadzone);
        const targetLeftY = applyDeadzone(rawLeftY, cfg.deadzone);
        const targetRightX = applyDeadzone(rawRightX, cfg.deadzone);
        const targetRightY = applyDeadzone(rawRightY, cfg.deadzone);

        // 平方缓动曲线后按轴应用灵敏度（分轴：平移 / 视角左右 / 视角上下 独立）
        // 物理含义因模式而异：
        //   gamepad 模式：左杆 = 移动(平移)，右杆 = 视角(旋转)
        //   drone 模式：  左杆 = 偏航(旋转) + 油门(平移)，右杆 = 俯仰/前后 + 横滚/平移
        let curvedLeftX = applyCurve(targetLeftX);
        let curvedLeftY = applyCurve(targetLeftY);
        let curvedRightX = applyCurve(targetRightX);
        let curvedRightY = applyCurve(targetRightY);
        if (this.mode === 'gamepad') {
            curvedLeftX *= cfg.moveSensitivity;
            curvedLeftY *= cfg.moveSensitivity;
            curvedRightX *= cfg.lookSensitivity;        // 偏航
            curvedRightY *= cfg.lookPitchSensitivity;   // 俯仰
        } else {
            curvedLeftX *= cfg.lookSensitivity;         // 偏航（航向）
            curvedLeftY *= cfg.moveSensitivity;         // 油门（升降）
            curvedRightX *= cfg.moveSensitivity;        // 横滚（平移）
            curvedRightY *= cfg.moveSensitivity;        // 俯仰（前后）
        }
        if (cfg.invertLeftX) curvedLeftX = -curvedLeftX;
        if (cfg.invertLeftY) curvedLeftY = -curvedLeftY;
        if (cfg.invertRightX) curvedRightX = -curvedRightX;
        if (cfg.invertRightY) curvedRightY = -curvedRightY;

        const sf = 1 - Math.pow(1 - cfg.smoothing, deltaTime * 60);
        this.leftStick.x = smooth(this.leftStick.x, curvedLeftX, sf);
        this.leftStick.y = smooth(this.leftStick.y, curvedLeftY, sf);
        this.rightStick.x = smooth(this.rightStick.x, curvedRightX, sf);
        this.rightStick.y = smooth(this.rightStick.y, curvedRightY, sf);

        const targetLT = this.getTriggerValue(bindings.ascend.index, gamepad);
        const targetRT = this.getTriggerValue(bindings.descend.index, gamepad);
        this.ltValue = smooth(this.ltValue, targetLT, sf);
        this.rtValue = smooth(this.rtValue, targetRT, sf);

        this.lbHeld = this.btnActive(bindings.sprint.index, gamepad);
        this.rbHeld = this.btnActive(bindings.slow.index, gamepad);

        // --- Handle button presses (edge detected) ---
        this.handleButtons(gamepad);

        // --- D-pad left/right ---
        // 控制菜单打开时：左/右切换操控模式（左 = FPS 漫游，右 = 无人机）
        if (this.menuOpen) {
            if (this.justPressed(bindings.dpadLeft.index, gamepad)) {
                this.events.fire('gamepad.setMode', 'gamepad');
            }
            if (this.justPressed(bindings.dpadRight.index, gamepad)) {
                this.events.fire('gamepad.setMode', 'drone');
            }
        } else {
            // 菜单关闭：FOV 调节（按住连续变化）
            if (this.btnActive(bindings.dpadLeft.index, gamepad)) {
                const fov = this.events.invoke('camera.fov') as number;
                this.events.fire('camera.setFov', clamp(fov - FOV_ADJUST_SPEED * deltaTime, 10, 120));
            }
            if (this.btnActive(bindings.dpadRight.index, gamepad)) {
                const fov = this.events.invoke('camera.fov') as number;
                this.events.fire('camera.setFov', clamp(fov + FOV_ADJUST_SPEED * deltaTime, 10, 120));
            }
        }

        // --- Apply movement based on mode ---
        if (this.mode === 'gamepad') {
            this.updateGamepadMode(deltaTime);
        } else {
            this.updateDroneMode(deltaTime);
        }

        this.refreshPrevButtons(gamepad);
    }

    // --- Button actions ---

    private handleButtons(gamepad: Gamepad) {
        const b = this.config.bindings;

        const action = (id: string) => {
            const bind = b[id];
            if (bind && bind.index !== 26) return this.justPressed(bind.index, gamepad);
            return false;
        };

        if (action('reset')) this.resetToInitial();
        if (action('setOrigin')) this.setOrigin();
        if (action('fullscreen')) this.toggleFullscreen();
        if (action('menu')) this.events.fire('gamepad.menu.toggle');
        if (action('lockHeight')) this.toggleHeightLock();
        if (action('gearUp')) {
            if (this.speedGearIndex < SPEED_GEARS.length - 1) {
                this.speedGearIndex++;
                this.events.fire('gamepad.speedGear', this.speedGearIndex);
            }
        }
        if (action('gearDown')) {
            if (this.speedGearIndex > 0) {
                this.speedGearIndex--;
                this.events.fire('gamepad.speedGear', this.speedGearIndex);
            }
        }
        if (action('screenshot')) this.events.fire('gamepad.capture');
        if (action('recordVideo')) this.events.fire('gamepad.recordToggle');
        if (action('resetView')) {
            const cam = this.camera;
            cam.setAzimElev(cam.azim, 0, 0);
        }

        // --- SplatRoom 编辑器动作 ---
        if (action('focus')) this.events.fire('camera.focus');
        if (action('browse')) this.toggleSubMode();
        if (action('controlMode')) {
            const mode = this.camera.controlMode === 'orbit' ? 'fly' : 'orbit';
            this.events.fire('camera.setControlMode', mode);
        }
        if (action('viewTop')) this.camera.viewTop();
        if (action('viewBottom')) this.camera.viewBottom();
        if (action('viewLeft')) this.camera.viewLeft();
        if (action('viewRight')) this.camera.viewRight();

        // --- Diagnostic: pressed buttons that map to no action ---
        const now = Date.now();
        if (now - this.diagLogTime > 3000) {
            const pressedIdx: number[] = [];
            for (let i = 0; i < Math.min(gamepad.buttons.length, 32); i++) {
                const btn = gamepad.buttons[i];
                if (btn?.pressed) pressedIdx.push(i);
                else if (btn && typeof btn.value === 'number' && btn.value > 0.5) pressedIdx.push(i);
            }
            if (pressedIdx.length > 0) {
                const bound = new Set<number>();
                for (const key of Object.keys(b)) {
                    const bind = b[key];
                    if (bind && typeof bind.index === 'number') bound.add(bind.index);
                }
                const unbound = pressedIdx.filter(i => !bound.has(i));
                if (unbound.length > 0) {
                    console.warn(
                        `[gamepad] 检测到未绑定/异常的按钮按下: [${unbound.join(', ')}] ` +
                        '(默认: A=0 B=1 X=2 Y=3 LB=4 RB=5 LT=6 RT=7 Back=8 Start=9 LS=10 RS=11 ' +
                        '十字=12-15 Home=16 Share=17)。若与实际按键不符，说明手柄处于非标准映射模式，' +
                        '可在设置面板中重新绑定按键。'
                    );
                    this.diagLogTime = now;
                }
            }
        }
    }

    // --- Speed ---

    private getSpeedMultiplier(): number {
        const gear = SPEED_GEARS[this.speedGearIndex];
        if (this.lbHeld) return gear * 2.0;       // LB: sprint 2x
        if (this.rbHeld) return gear * 0.3;       // RB: precision 0.3x
        return gear;
    }

    // --- Camera manipulation helpers ---

    private moveFocalPoint(dx: number, dy: number, dz: number) {
        const cam = this.camera;
        const fp = cam.focalPoint;
        newFocal.set(fp.x + dx, fp.y + dy, fp.z + dz);
        cam.setFocalPoint(newFocal, 0);
    }

    private lookAround(deltaAzim: number, deltaElev: number) {
        const cam = this.camera;
        const d = cam.distance * cam.sceneRadius / cam.fovFactor;

        Camera.calcForwardVec(forwardVec, cam.azim, cam.elevation);
        cameraPos.copy(cam.focalPoint).add(forwardVec.mulScalar(d));

        const newAzim = mod(cam.azim - deltaAzim, 360);
        const newElev = clamp(cam.elevation - deltaElev, -PITCH_LIMIT, PITCH_LIMIT);

        Camera.calcForwardVec(forwardVec, newAzim, newElev);
        newFocal.copy(cameraPos).sub(forwardVec.mulScalar(d));

        cam.setAzimElev(newAzim, newElev, 0);
        cam.setFocalPoint(newFocal, 0);
        cam.lookCameraPos = null;
    }

    private pitchGimbal(deltaElev: number) {
        this.lookAround(0, deltaElev);
    }

    // --- Mode: Gamepad (FPS roaming) ---

    private updateGamepadMode(deltaTime: number) {
        const cam = this.camera;
        const speed = this.getSpeedMultiplier();
        const moveSpeed = BASE_MOVE_SPEED * speed * deltaTime;
        const rotSpeed = ROTATION_SPEED * speed * deltaTime;
        const heightSpd = HEIGHT_SPEED * speed * deltaTime;

        const strafe = this.leftStick.x;
        const forward = -this.leftStick.y;

        if (strafe !== 0 || forward !== 0) {
            const wt = cam.worldTransform;
            moveVec.set(0, 0, 0);

            if (forward !== 0) {
                const zAxis = wt.getZ();
                zAxis.y = 0;
                if (zAxis.lengthSq() < 1e-6) {
                    const azimRad = cam.azim * math.DEG_TO_RAD;
                    zAxis.set(Math.sin(azimRad), 0, -Math.cos(azimRad));
                }
                zAxis.normalize();
                moveVec.add(zAxis.mulScalar(-forward * moveSpeed));
            }

            if (strafe !== 0) {
                const xAxis = wt.getX();
                xAxis.y = 0;
                if (xAxis.lengthSq() < 1e-6) {
                    const azimRad = cam.azim * math.DEG_TO_RAD;
                    xAxis.set(Math.cos(azimRad), 0, Math.sin(azimRad));
                }
                xAxis.normalize();
                moveVec.add(xAxis.mulScalar(strafe * moveSpeed));
            }

            this.moveFocalPoint(moveVec.x, moveVec.y, moveVec.z);
        }

        const lookX = this.rightStick.x;
        const lookY = this.rightStick.y;
        if (lookX !== 0 || lookY !== 0) {
            this.lookAround(lookX * rotSpeed, lookY * rotSpeed);
        }

        if (!this.heightLocked) {
            const heightDelta = (this.rtValue - this.ltValue) * heightSpd;
            if (heightDelta !== 0) {
                this.moveFocalPoint(0, heightDelta, 0);
            }
        }
    }

    // --- Mode: Drone (American-hand flight) ---

    private updateDroneMode(deltaTime: number) {
        const cam = this.camera;
        const speed = this.getSpeedMultiplier();
        const moveSpeed = BASE_MOVE_SPEED * speed * deltaTime;
        const rotSpeed = ROTATION_SPEED * speed * deltaTime;
        const heightSpd = HEIGHT_SPEED * speed * deltaTime;

        const throttle = -this.leftStick.y;
        const yaw = this.leftStick.x;
        const pitch = -this.rightStick.y;
        const roll = this.rightStick.x;

        if (yaw !== 0) {
            this.lookAround(yaw * rotSpeed, 0);
        }

        if (!this.heightLocked && throttle !== 0) {
            this.moveFocalPoint(0, throttle * heightSpd, 0);
        }

        if (pitch !== 0 || roll !== 0) {
            moveVec.set(0, 0, 0);

            if (this.followMode) {
                const wt = cam.worldTransform;
                if (pitch !== 0) {
                    const zAxis = wt.getZ();
                    zAxis.y = 0;
                    if (zAxis.lengthSq() < 1e-6) {
                        const azimRad = cam.azim * math.DEG_TO_RAD;
                        zAxis.set(Math.sin(azimRad), 0, -Math.cos(azimRad));
                    }
                    zAxis.normalize();
                    moveVec.add(zAxis.mulScalar(-pitch * moveSpeed));
                }
                if (roll !== 0) {
                    const xAxis = wt.getX();
                    xAxis.y = 0;
                    if (xAxis.lengthSq() < 1e-6) {
                        const azimRad = cam.azim * math.DEG_TO_RAD;
                        xAxis.set(Math.cos(azimRad), 0, Math.sin(azimRad));
                    }
                    xAxis.normalize();
                    moveVec.add(xAxis.mulScalar(roll * moveSpeed));
                }
            } else {
                const azimRad = cam.azim * math.DEG_TO_RAD;
                const sinA = Math.sin(-azimRad);
                const cosA = Math.cos(-azimRad);
                if (pitch !== 0) {
                    moveVec.x += -sinA * pitch * moveSpeed;
                    moveVec.z += -cosA * pitch * moveSpeed;
                }
                if (roll !== 0) {
                    moveVec.x += cosA * roll * moveSpeed;
                    moveVec.z += -sinA * roll * moveSpeed;
                }
            }

            if (moveVec.x !== 0 || moveVec.y !== 0 || moveVec.z !== 0) {
                this.moveFocalPoint(moveVec.x, moveVec.y, moveVec.z);
            }
        }

        // 云台俯仰由模拟触发键驱动（RT = 抬头、LT = 低头，倾角速度随按压力度
        // 线性变化，获得精细幅度控制）+ 分轴俯仰灵敏度
        const gimbalDelta = (this.ltValue - this.rtValue) * GIMBAL_PITCH_SPEED * this.config.axis.lookPitchSensitivity * deltaTime;
        if (gimbalDelta !== 0) {
            this.pitchGimbal(gimbalDelta);
        }
    }

    // --- Action handlers ---

    private toggleHeightLock() {
        this.heightLocked = !this.heightLocked;
        this.events.fire('gamepad.heightLock', this.heightLocked);
    }

    private setOrigin() {
        this.startPose = {
            focalPoint: this.camera.focalPoint.clone(),
            azim: this.camera.azim,
            elev: this.camera.elevation,
            distance: this.camera.distance
        };
        this.events.fire('gamepad.originSet');
    }

    private resetToInitial() {
        const pose = this.startPose ?? this.initialPose;
        if (!pose) {
            this.events.fire('camera.reset');
            return;
        }

        const cam = this.camera;
        cam.setFocalPoint(pose.focalPoint.clone(), 0);
        cam.setAzimElev(pose.azim, pose.elev, 0);
        cam.setDistance(pose.distance, 0);

        if (this.heightLocked) this.toggleHeightLock();
        this.followMode = true;
        this.events.fire('gamepad.followMode', true);
    }

    private toggleFullscreen() {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(() => {
                const anyEl = document.documentElement as any;
                if (anyEl.webkitRequestFullscreen) {
                    anyEl.webkitRequestFullscreen();
                }
            });
        } else {
            document.exitFullscreen().catch(() => {
                const anyDoc = document as any;
                if (anyDoc.webkitExitFullscreen) {
                    anyDoc.webkitExitFullscreen();
                }
            });
        }
    }
}

export { GamepadController };
