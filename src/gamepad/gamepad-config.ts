/**
 * gamepad-config.ts
 *
 * 手柄控制器配置模型：可重绑动作、Xbox/PlayStation 预设、摇杆参数、持久化。
 *
 * 动作集合 = 开发包查看器动作（reset/fullscreen/menu/...）+ SplatRoom 编辑器
 * 动作（focus/browse/controlMode/预设视角/开关手柄模式），默认键位为混合方案：
 * 常用开发包动作直接绑定，编辑器动作与次要动作默认未绑定（可在设置面板重绑）。
 *
 * 持久化 key 为 `splatroom.gamepad.config.v1`（SplatRoom 专用，与旧版互不影响）。
 */

// --- Binding model ---

export type BindingType = 'button' | 'trigger';

export interface Binding {
    type: BindingType;
    index: number;
}

export interface ActionDef {
    id: string;
    /** i18n key —— 动作显示名 */
    labelKey: string;
    default: Binding;
}

// Standard gamepad button indices
const BTN_NAMES: Record<number, string> = {
    0: 'A',
    1: 'B',
    2: 'X',
    3: 'Y',
    4: 'LB',
    5: 'RB',
    6: 'LT',
    7: 'RT',
    8: 'Back',
    9: 'Start',
    10: 'LS',
    11: 'RS',
    12: '十字键上',
    13: '十字键下',
    14: '十字键左',
    15: '十字键右',
    16: 'Home',
    17: '分享',
    26: '未绑定'
};

// PlayStation protocol names (indices identical; labels differ)
const BTN_NAMES_PS: Record<number, string> = {
    0: '✕ (Cross)',
    1: '○ (Circle)',
    2: '□ (Square)',
    3: '△ (Triangle)',
    4: 'L1',
    5: 'R1',
    6: 'L2',
    7: 'R2',
    8: 'Share',
    9: 'Options',
    10: 'L3',
    11: 'R3',
    12: '十字键上',
    13: '十字键下',
    14: '十字键左',
    15: '十字键右',
    16: 'PS',
    17: '触摸板',
    26: '未绑定'
};

export type PresetId = 'xbox' | 'playstation';

export const bindingName = (binding: Binding, preset: PresetId = 'xbox'): string => {
    const table = preset === 'playstation' ? BTN_NAMES_PS : BTN_NAMES;
    return table[binding.index] ?? `按键${binding.index}`;
};

const bindingEquals = (a: Binding, b: Binding): boolean => {
    return a.type === b.type && a.index === b.index;
};

// Indices that can never be reassigned: LS/RS clicks open the settings panel.
export const RESERVED_BINDING_INDICES = [10, 11];

/** 哨兵索引：表示未绑定 */
const UNBOUND_INDEX = 26;

// --- Default bindings ---
// 混合方案：开发包常用动作直接绑定（对齐 v1.3.0 默认键位：setOrigin=A）；
// 编辑器动作（focus 改未绑定 / browse / controlMode / 预设视角 / toggleEnabled）
// 默认未绑定，可在设置面板重绑；browse 亦可通过控制菜单按钮触发。
export const DEFAULT_BINDINGS: ActionDef[] = [
    { id: 'reset', labelKey: 'gamepad.action.reset', default: { type: 'button', index: 16 } },  // HOME 回出生点
    { id: 'setOrigin', labelKey: 'gamepad.action.setOrigin', default: { type: 'button', index: 0 } },  // A 设为出生点（对齐 v1.3.0）
    { id: 'fullscreen', labelKey: 'gamepad.action.fullscreen', default: { type: 'button', index: 1 } },   // B 全屏
    { id: 'menu', labelKey: 'gamepad.action.menu', default: { type: 'button', index: 2 } },   // X 控制菜单
    { id: 'lockHeight', labelKey: 'gamepad.action.lockHeight', default: { type: 'button', index: 3 } },   // Y 锁高
    { id: 'sprint', labelKey: 'gamepad.action.sprint', default: { type: 'button', index: 4 } },   // LB 冲刺
    { id: 'slow', labelKey: 'gamepad.action.slow', default: { type: 'button', index: 5 } },   // RB 慢速
    { id: 'ascend', labelKey: 'gamepad.action.ascend', default: { type: 'trigger', index: 6 } },   // LT 上升
    { id: 'descend', labelKey: 'gamepad.action.descend', default: { type: 'trigger', index: 7 } },   // RT 下降
    { id: 'gearUp', labelKey: 'gamepad.action.gearUp', default: { type: 'button', index: 12 } },  // 十字上 升档
    { id: 'gearDown', labelKey: 'gamepad.action.gearDown', default: { type: 'button', index: 13 } },  // 十字下 降档
    { id: 'dpadLeft', labelKey: 'gamepad.action.dpadLeft', default: { type: 'button', index: 14 } },  // 十字左 FOV-
    { id: 'dpadRight', labelKey: 'gamepad.action.dpadRight', default: { type: 'button', index: 15 } },  // 十字右 FOV+
    { id: 'screenshot', labelKey: 'gamepad.action.screenshot', default: { type: 'button', index: 8 } },   // Back 截屏
    { id: 'recordVideo', labelKey: 'gamepad.action.recordVideo', default: { type: 'button', index: 9 } },   // Start 录制
    { id: 'resetView', labelKey: 'gamepad.action.resetView', default: { type: 'button', index: UNBOUND_INDEX } },
    // --- SplatRoom 编辑器动作（默认未绑定，可在设置面板重绑） ---
    { id: 'focus', labelKey: 'gamepad.action.focus', default: { type: 'button', index: UNBOUND_INDEX } },  // 聚焦（A 已让位给 setOrigin）
    { id: 'browse', labelKey: 'gamepad.action.browse', default: { type: 'button', index: UNBOUND_INDEX } },  // 浏览模式（也可经控制菜单）
    { id: 'controlMode', labelKey: 'gamepad.action.controlMode', default: { type: 'button', index: UNBOUND_INDEX } },  // orbit/fly 切换
    { id: 'viewTop', labelKey: 'gamepad.action.viewTop', default: { type: 'button', index: UNBOUND_INDEX } },
    { id: 'viewBottom', labelKey: 'gamepad.action.viewBottom', default: { type: 'button', index: UNBOUND_INDEX } },
    { id: 'viewLeft', labelKey: 'gamepad.action.viewLeft', default: { type: 'button', index: UNBOUND_INDEX } },
    { id: 'viewRight', labelKey: 'gamepad.action.viewRight', default: { type: 'button', index: UNBOUND_INDEX } },
    { id: 'toggleEnabled', labelKey: 'gamepad.action.toggleEnabled', default: { type: 'button', index: UNBOUND_INDEX } }  // 开关手柄模式（工具栏按钮同样可开关）
];

// --- Presets (one-click config profiles) ---

export interface PresetDef {
    id: PresetId;
    label: string;
    bindings: Record<string, Binding>;
}

const buildPreset = (id: PresetId, label: string, indexMap: Record<string, number>): PresetDef => {
    const bindings: Record<string, Binding> = {};
    for (const def of DEFAULT_BINDINGS) {
        const idx = indexMap[def.id] ?? def.default.index;
        const trigger = def.default.type === 'trigger' || idx === 6 || idx === 7;
        bindings[def.id] = { type: trigger ? 'trigger' : 'button', index: idx };
    }
    return { id, label, bindings };
};

export const PRESETS: PresetDef[] = [
    buildPreset('xbox', 'Xbox 手柄预设（默认）', {}),
    buildPreset('playstation', 'PlayStation 手柄预设', {
        reset: 16,       // PS button
        fullscreen: 1,   // ○ Circle
        menu: 2,         // □ Square
        lockHeight: 3,   // △ Triangle
        sprint: 4,       // L1
        slow: 5,         // R1
        ascend: 6,       // L2
        descend: 7,      // R2
        gearUp: 12,
        gearDown: 13,
        dpadLeft: 14,
        dpadRight: 15,
        setOrigin: 0,    // ✕ Cross
        screenshot: 8,   // Share
        recordVideo: 9,  // Options
        resetView: 26    // 未绑定
    })
];

// Full config for a preset: preset bindings + fresh axis defaults.
export const presetConfig = (id: PresetId): GamepadConfig => {
    const preset = PRESETS.find(p => p.id === id) ?? PRESETS[0];
    const bindings: Record<string, Binding> = {};
    for (const [k, v] of Object.entries(preset.bindings)) {
        bindings[k] = { ...v };
    }
    return {
        preset: preset.id,
        bindings,
        axis: { ...DEFAULT_AXIS }
    };
};

// --- Axis settings ---
// 分轴灵敏度（对齐 v1.3.0）：平移 / 视角左右 / 视角上下 独立调节。

export interface AxisSettings {
    /** 平移灵敏度（移动速度倍率，默认 4.0——原单一 sensitivity=1.0 太慢） */
    moveSensitivity: number;
    /** 视角旋转灵敏度（左右 / 偏航，默认 0.35——避免轻拨转圈） */
    lookSensitivity: number;
    /** 视角旋转灵敏度（上下 / 俯仰，通常低于左右，默认 0.20） */
    lookPitchSensitivity: number;
    deadzone: number;
    smoothing: number;
    invertLeftX: boolean;
    invertLeftY: boolean;
    invertRightX: boolean;
    invertRightY: boolean;
}

const DEFAULT_AXIS: AxisSettings = {
    moveSensitivity: 4.0,
    lookSensitivity: 0.35,
    lookPitchSensitivity: 0.20,
    deadzone: 0.08,
    smoothing: 0.15,
    invertLeftX: false,
    invertLeftY: false,
    invertRightX: false,
    invertRightY: false
};

export interface GamepadConfig {
    preset?: PresetId;
    bindings: Record<string, Binding>;
    axis: AxisSettings;
}

const CONFIG_STORAGE_KEY = 'splatroom.gamepad.config.v1';

// --- Persistence ---

export const defaultConfig = (): GamepadConfig => {
    const bindings: Record<string, Binding> = {};
    for (const def of DEFAULT_BINDINGS) {
        bindings[def.id] = { ...def.default };
    }
    return {
        preset: 'xbox',
        bindings,
        axis: { ...DEFAULT_AXIS }
    };
};

export const loadConfig = (): GamepadConfig => {
    const cfg = defaultConfig();
    try {
        const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
        if (!raw) return cfg;

        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            if (parsed.preset === 'xbox' || parsed.preset === 'playstation') {
                cfg.preset = parsed.preset;
            }
            if (parsed.bindings && typeof parsed.bindings === 'object') {
                for (const def of DEFAULT_BINDINGS) {
                    const b = parsed.bindings[def.id];
                    if (b && typeof b.index === 'number' && (b.type === 'button' || b.type === 'trigger') && !RESERVED_BINDING_INDICES.includes(b.index)) {
                        cfg.bindings[def.id] = { type: b.type, index: Math.round(b.index) };
                    }
                }
            }
            if (parsed.axis && typeof parsed.axis === 'object') {
                const a = parsed.axis;
                // 兼容旧版单一 sensitivity：旧字段存在且新字段缺失时迁移
                // （旧 sensitivity=1.0 → 平移 ×4，视角左右 ×0.35，上下 ×0.20）
                if (typeof a.moveSensitivity === 'number') cfg.axis.moveSensitivity = clamp(a.moveSensitivity, 0.5, 7.5);
                else if (typeof a.sensitivity === 'number') cfg.axis.moveSensitivity = clamp(a.sensitivity * 4.0, 0.5, 7.5);
                if (typeof a.lookSensitivity === 'number') cfg.axis.lookSensitivity = clamp(a.lookSensitivity, 0.05, 0.65);
                else if (typeof a.sensitivity === 'number') cfg.axis.lookSensitivity = clamp(a.sensitivity * 0.35, 0.05, 0.65);
                if (typeof a.lookPitchSensitivity === 'number') cfg.axis.lookPitchSensitivity = clamp(a.lookPitchSensitivity, 0.04, 0.36);
                else if (typeof a.sensitivity === 'number') cfg.axis.lookPitchSensitivity = clamp(a.sensitivity * 0.20, 0.04, 0.36);
                if (typeof a.deadzone === 'number') cfg.axis.deadzone = clamp(a.deadzone, 0.0, 0.3);
                if (typeof a.smoothing === 'number') cfg.axis.smoothing = clamp(a.smoothing, 0.0, 0.9);
                if (typeof a.invertLeftX === 'boolean') cfg.axis.invertLeftX = a.invertLeftX;
                if (typeof a.invertLeftY === 'boolean') cfg.axis.invertLeftY = a.invertLeftY;
                if (typeof a.invertRightX === 'boolean') cfg.axis.invertRightX = a.invertRightX;
                if (typeof a.invertRightY === 'boolean') cfg.axis.invertRightY = a.invertRightY;
            }
        }
    } catch (e) {
        console.warn('Failed to load gamepad config, using defaults', e);
    }
    return cfg;
};

export const saveConfig = (cfg: GamepadConfig) => {
    try {
        localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(cfg));
    } catch (e) {
        console.warn('Failed to save gamepad config', e);
    }
};

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
