import { Vec3 } from 'playcanvas';

import type { Camera } from './camera';
import type { Events } from './events';

// 死区：摇杆中心附近的微小漂移忽略不计
const DEADZONE = 0.15;
// 旋转速度（度/秒，满杆时）
const ROTATE_SPEED = 110;
// 平移速度：相对当前相机距离的比例（场景单位/秒），让平移随缩放自适应
const PAN_SPEED = 1.2;
// 缩放速度（每秒指数因子）
const ZOOM_SPEED = 2.2;

type SubMode = 'normal' | 'browse';

/**
 * GamepadController — 标准 W3C 手柄映射驱动相机。
 *
 * 启用方式（两种都汇聚到同一 enabled 状态）：
 *   - 右工具栏「手柄」按钮点击 → fire('gamepad.toggle')
 *   - 手柄 Start 键 → fire('gamepad.toggle')
 *
 * 子模式（普通 / 浏览）：
 *   - 手柄 X 键 → fire('gamepad.setSubMode', 'browse' | 'normal')
 *   - 浏览态按 B/Back 或 ESC → fire('gamepad.setSubMode', 'normal')
 */
export class GamepadController {
    enabled = false;
    subMode: SubMode = 'normal';

    private camera: Camera;
    private events: Events;
    // 边沿检测：记录上一帧各按键是否被按下
    private prevButtons: boolean[] = [];

    constructor(camera: Camera, events: Events) {
        this.camera = camera;
        this.events = events;

        events.on('gamepad.toggle', () => {
            this.setEnabled(!this.enabled);
        });
        events.on('gamepad.setEnabled', (value: boolean) => {
            this.setEnabled(value);
        });
        events.on('gamepad.setSubMode', (mode: SubMode) => {
            this.setSubMode(mode);
        });
    }

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

    update(deltaTime: number) {
        if (!this.enabled) return;

        const pads = navigator.getGamepads ? navigator.getGamepads() : [];
        let pad: Gamepad | null = null;
        for (const p of pads) {
            if (p && p.connected) {
                pad = p;
                break;
            }
        }
        if (!pad) return;

        const ax = pad.axes;
        const lx = deadzone(ax[0] ?? 0);
        const ly = deadzone(ax[1] ?? 0);
        const rx = deadzone(ax[2] ?? 0);
        const ry = deadzone(ax[3] ?? 0);

        // 左摇杆：旋转（orbit = 绕焦点，fly = 绕相机自身）
        if (lx !== 0 || ly !== 0) {
            const headingDelta = -lx * ROTATE_SPEED * deltaTime;
            const pitchDelta = -ly * ROTATE_SPEED * deltaTime;
            this.camera.adjustHeading(headingDelta);
            this.camera.adjustPitch(pitchDelta);
        }

        // 右摇杆：平移焦点（屏幕平行）
        if (rx !== 0 || ry !== 0) {
            this.pan(rx, ry, deltaTime);
        }

        // 扳机：LT 拉近 / RT 拉远
        const lt = pad.buttons[6]?.value ?? 0;
        const rt = pad.buttons[7]?.value ?? 0;
        if (lt > 0.01 || rt > 0.01) {
            const factor = Math.exp((rt - lt) * ZOOM_SPEED * deltaTime);
            this.camera.setDistance(this.camera.distance * factor);
        }

        this.handleButtons(pad);
    }

    private pan(rx: number, ry: number, dt: number) {
        const wt = this.camera.worldTransform;
        const d = wt.data;
        // 列主序：data[0..2] = 右轴, data[4..6] = 上轴
        const right = new Vec3(d[0], d[1], d[2]);
        const up = new Vec3(d[4], d[5], d[6]);
        const scale = PAN_SPEED * this.camera.distance * dt;
        const focal = this.camera.focalPoint;
        const move = new Vec3();
        move.add(right.mulScalar(-rx * scale));
        move.add(up.mulScalar(ry * scale));
        this.camera.setFocalPoint(focal.add(move));
    }

    private handleButtons(pad: Gamepad) {
        const b = pad.buttons;
        const pressed = (i: number) => !!(b[i] && b[i].pressed);
        const edge = (i: number) => {
            const now = pressed(i);
            const was = this.prevButtons[i] || false;
            this.prevButtons[i] = now;
            return now && !was;
        };

        // A (0) —— 聚焦
        if (edge(0)) this.events.fire('camera.focus');
        // B (1) —— 退出浏览
        if (edge(1) && this.subMode === 'browse') this.setSubMode('normal');
        // X (2) —— 切换普通/浏览子模式
        if (edge(2)) this.toggleSubMode();
        // Y (3) —— 切换 orbit / fly
        if (edge(3)) {
            const mode = this.camera.controlMode === 'orbit' ? 'fly' : 'orbit';
            this.events.fire('camera.setControlMode', mode);
        }
        // Start (9) —— 切换手柄模式
        if (edge(9)) this.events.fire('gamepad.toggle');
        // D-pad (12-15) —— 预设视角快照
        if (edge(12)) this.camera.viewTop();
        if (edge(13)) this.camera.viewBottom();
        if (edge(14)) this.camera.viewLeft();
        if (edge(15)) this.camera.viewRight();
    }
}

// 死区处理：小于阈值返回 0，否则保持原始方向并扣除阈值，避免中心漂移
function deadzone(v: number): number {
    if (Math.abs(v) < DEADZONE) return 0;
    const sign = v > 0 ? 1 : -1;
    return sign * (Math.abs(v) - DEADZONE) / (1 - DEADZONE);
}
