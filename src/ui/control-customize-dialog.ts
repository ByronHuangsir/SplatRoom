import { Button, Container, Label, SelectInput, SliderInput } from '@playcanvas/pcui';

import { Events } from '../events';
import {
    DEFAULT_BINDINGS,
    GamepadConfig,
    PresetId,
    RESERVED_BINDING_INDICES,
    bindingName,
    defaultConfig,
    presetConfig
} from '../gamepad-config';
import { DEFAULT_MOUSE_BINDINGS, MOUSE_ACTIONS, MouseAction, MouseBindingsState } from '../mouse-bindings';
import { ShortcutBinding } from '../shortcuts';
import { i18n } from './localization';

/**
 * 自定义操控 (Customize Controls) dialog — reachable from 工具 → 自定义操控.
 *
 * Three panes:
 *   1. Mouse drag actions: what left / middle / right button dragging does.
 *   2. Keyboard shortcuts: view / rebind / reset.
 *   3. Gamepad: remap the 24 controller actions (click a binding row, then
 *      press the gamepad button), tune stick sensitivity / deadzone /
 *      smoothing / axis inversion, and switch Xbox / PlayStation presets.
 *      Persisted via the gamepad config model (localStorage).
 */
class ControlCustomizeDialog extends Container {
    show: () => void;
    hide: () => void;
    destroy: () => void;

    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'control-customize-dialog',
            class: 'settings-dialog',
            hidden: true,
            tabIndex: -1
        };

        super(args);

        const dialog = new Container({ id: 'dialog', class: 'control-customize-dialog-body' });

        // ---- header ----
        const headerText = new Label({ id: 'text' });
        i18n.bindText(headerText, () => i18n.t('dialog.control-customize.header').toUpperCase());
        const header = new Container({ id: 'header' });
        header.append(headerText);
        dialog.append(header);

        // ---- floating panel: drag by the header to move the dialog ----
        let dragActive = false;
        let dragOffsetX = 0, dragOffsetY = 0;
        const dragMove = (e: PointerEvent) => {
            if (!dragActive) return;
            const el = dialog.dom;
            el.style.transform = 'none';
            el.style.left = `${e.clientX - dragOffsetX}px`;
            el.style.top = `${e.clientY - dragOffsetY}px`;
        };
        const dragEnd = () => {
            dragActive = false;
            header.class.remove('cc-dragging');
        };
        header.dom.addEventListener('pointerdown', (e: PointerEvent) => {
            dragActive = true;
            header.class.add('cc-dragging');
            const rect = dialog.dom.getBoundingClientRect();
            dragOffsetX = e.clientX - rect.left;
            dragOffsetY = e.clientY - rect.top;
            header.dom.setPointerCapture(e.pointerId);
            e.preventDefault();
        });
        header.dom.addEventListener('pointermove', dragMove);
        header.dom.addEventListener('pointerup', dragEnd);
        header.dom.addEventListener('pointercancel', dragEnd);

        // ---- body: three-pane layout (mouse | shortcuts | gamepad) ----
        const body = new Container({ class: 'cc-body' });

        // === Left pane: mouse drag actions ===
        const mousePane = new Container({ class: ['cc-pane', 'cc-pane-mouse'] });

        const mouseHeader = new Label({ class: 'section-label' });
        i18n.bindText(mouseHeader, 'dialog.control-customize.mouse-section');
        mousePane.append(mouseHeader);

        const buttonDefs = [
            { id: 'left', labelKey: 'dialog.control-customize.left', titleKey: 'dialog.control-customize.left-tip' },
            { id: 'middle', labelKey: 'dialog.control-customize.middle', titleKey: 'dialog.control-customize.middle-tip' },
            { id: 'right', labelKey: 'dialog.control-customize.right', titleKey: 'dialog.control-customize.right-tip' }
        ] as const;

        const selectRow: Record<string, { row: Container, select: SelectInput }> = {};
        for (const def of buttonDefs) {
            const row = new Container({ class: 'row' });
            const label = new Label({ class: 'label' });
            i18n.bindText(label, def.labelKey);
            const select = new SelectInput({
                class: 'select',
                defaultValue: DEFAULT_MOUSE_BINDINGS[def.id]
            });
            i18n.bindOptions(select, () => MOUSE_ACTIONS.map(a => ({
                v: a,
                t: i18n.t(`dialog.control-customize.action.${a}`)
            })));
            row.append(label);
            row.append(select);
            mousePane.append(row);
            selectRow[def.id] = { row, select };
        }

        // reset mouse bindings to defaults
        const resetMouseBtn = new Button({ class: 'button' });
        i18n.bindText(resetMouseBtn, 'dialog.control-customize.reset-mouse');
        mousePane.append(resetMouseBtn);
        mousePane.append(new Container({ class: 'cc-fill' }));   // vertical spacer
        body.append(mousePane);

        // === vertical divider ===
        body.append(new Container({ class: 'cc-divider-vertical' }));

        // === Middle pane: keyboard shortcuts ===
        const kbPane = new Container({ class: ['cc-pane', 'cc-pane-kb'] });

        const kbHeader = new Label({ class: 'section-label' });
        i18n.bindText(kbHeader, 'dialog.control-customize.kb-section');
        kbPane.append(kbHeader);

        const hint = new Label({ class: 'kb-hint' });
        i18n.bindText(hint, 'dialog.control-customize.kb-hint');
        kbPane.append(hint);

        // Which shortcut ids the panel exposes for customization.
        const editableIds = [
            'camera.reset', 'camera.focus', 'camera.toggleControlMode',
            'camera.toggleOverlay', 'camera.toggleMode', 'grid.toggleVisible',
            'camera.toggleShowInfo', 'select.hide', 'select.unhide',
            'timeline.togglePlay', 'timeline.prevFrame', 'timeline.nextFrame',
            'track.addKey', 'track.removeKey', 'select.all', 'select.none',
            'select.invert', 'select.delete', 'edit.copy', 'edit.cut', 'edit.paste',
            'tool.moveShortcut', 'tool.rotateShortcut', 'tool.scaleShortcut',
            'tool.rectSelection', 'tool.lassoSelection', 'tool.polygonSelection',
            'tool.brushSelection', 'tool.deactivate', 'tool.toggleCoordSpace',
            'edit.undo', 'edit.redo', 'dataPanel.toggle', 'timelinePanel.toggle'
        ];

        const shortcutRows: { id: string, btn: Button }[] = [];
        let capturingId: string | null = null;
        const captureHandler = (e: KeyboardEvent) => {
            // ignore pure modifier presses
            if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
            if (capturingId) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                const binding: ShortcutBinding = {
                    keys: [e.key],
                    ctrl: (e.ctrlKey || e.metaKey) ? 'required' : 'forbidden',
                    shift: e.shiftKey ? 'required' : 'forbidden',
                    alt: e.altKey ? 'required' : 'forbidden'
                };
                (events.invoke('shortcutManager') as any)?.rebind(capturingId, binding);
                capturingId = null;
                refreshShortcutRows();
            }
        };

        const refreshShortcutRows = () => {
            const sm = events.invoke('shortcutManager') as any;
            for (const { id, btn } of shortcutRows) {
                btn.text = capturingId === id ?
                    i18n.t('dialog.control-customize.capturing') :
                    (sm?.formatShortcut(id) || '');
                btn.class[capturingId === id ? 'add' : 'remove']('capturing');
            }
        };

        // build the shortcut list (scrollable)
        const kbList = new Container({ class: 'kb-list' });
        for (const id of editableIds) {
            const row = new Container({ class: 'kb-row' });
            const actionLabel = new Label({ class: 'kb-action' });
            i18n.bindText(actionLabel, `dialog.control-customize.shortcut.${id}`);
            const btn = new Button({ class: 'kb-key' });
            // eslint-disable-next-line no-loop-func -- capturingId 为有意共享状态（所有按钮竞争同一捕获目标）
            btn.on('click', () => {
                if (capturingId === id) {
                    capturingId = null;
                } else {
                    capturingId = id;
                }
                refreshShortcutRows();
                if (capturingId) {
                    window.addEventListener('keydown', captureHandler, true);
                } else {
                    window.removeEventListener('keydown', captureHandler, true);
                }
            });
            row.append(actionLabel);
            row.append(btn);
            kbList.append(row);
            shortcutRows.push({ id, btn });
        }
        kbPane.append(kbList);

        // reset keyboard bindings
        const resetKbBtn = new Button({ class: 'button' });
        i18n.bindText(resetKbBtn, 'dialog.control-customize.reset-kb');
        kbPane.append(resetKbBtn);

        body.append(kbPane);

        // === vertical divider ===
        body.append(new Container({ class: 'cc-divider-vertical' }));

        // === Right pane: gamepad bindings + stick tuning ===
        const gpPane = new Container({ class: ['cc-pane', 'cc-pane-gamepad'] });

        const gpHeaderRow = new Container({ class: 'row' });
        const gpHeader = new Label({ class: 'section-label' });
        i18n.bindText(gpHeader, 'dialog.control-customize.gamepad-section');
        const gpConn = new Label({ class: 'gp-conn' });
        gpHeaderRow.append(gpHeader);
        gpHeaderRow.append(gpConn);
        gpPane.append(gpHeaderRow);

        // preset selector
        const presetRow = new Container({ class: 'row' });
        const presetLabel = new Label({ class: 'label' });
        i18n.bindText(presetLabel, 'dialog.control-customize.preset');
        const presetSelect = new SelectInput({ class: 'select' });
        i18n.bindOptions(presetSelect, () => [
            { v: 'xbox', t: i18n.t('dialog.control-customize.preset.xbox') },
            { v: 'playstation', t: i18n.t('dialog.control-customize.preset.playstation') }
        ]);
        presetRow.append(presetLabel);
        presetRow.append(presetSelect);
        gpPane.append(presetRow);

        // --- stick & sensitivity section ---
        const stickHeader = new Label({ class: 'section-label' });
        i18n.bindText(stickHeader, 'dialog.control-customize.stick-section');
        gpPane.append(stickHeader);

        const readConfig = (): GamepadConfig => {
            const cfg = events.invoke('gamepad.config') as GamepadConfig | undefined;
            const src = cfg ?? defaultConfig();
            return {
                preset: src.preset ?? 'xbox',
                bindings: { ...src.bindings },
                axis: { ...src.axis }
            };
        };

        // 构造期只用默认配置（gamepad.config 由 GamepadController 注册，
        // 其构造晚于 EditorUI —— 真实配置在 show() 时经 readConfig 拉取）。
        let gpConfig = defaultConfig();
        let gpCapturingId: string | null = null;
        const gpPrevButtons: boolean[] = new Array(32).fill(false);
        let gpRaf: number | null = null;
        let gpConnected = false;

        type AxisNumberKeys = 'moveSensitivity' | 'lookSensitivity' | 'lookPitchSensitivity' | 'deadzone' | 'smoothing';
        const sliderDefs: {
            key: AxisNumberKeys;
            labelKey: string;
            min: number;
            max: number;
            step: number;
        }[] = [
            // 分轴灵敏度（对齐 v1.3.0）：平移 / 视角左右 / 视角上下 独立
            { key: 'moveSensitivity', labelKey: 'dialog.control-customize.moveSensitivity', min: 0.5, max: 7.5, step: 0.05 },
            { key: 'lookSensitivity', labelKey: 'dialog.control-customize.lookSensitivity', min: 0.05, max: 0.65, step: 0.01 },
            { key: 'lookPitchSensitivity', labelKey: 'dialog.control-customize.lookPitchSensitivity', min: 0.04, max: 0.36, step: 0.01 },
            { key: 'deadzone', labelKey: 'dialog.control-customize.deadzone', min: 0.0, max: 0.3, step: 0.01 },
            { key: 'smoothing', labelKey: 'dialog.control-customize.smoothing', min: 0.0, max: 0.9, step: 0.01 }
        ];
        const gpSliders: Record<string, SliderInput> = {};
        for (const def of sliderDefs) {
            const row = new Container({ class: 'row' });
            const label = new Label({ class: 'label' });
            i18n.bindText(label, def.labelKey);
            const slider = new SliderInput({
                class: 'slider',
                min: def.min,
                max: def.max,
                step: def.step,
                precision: 2,
                value: gpConfig.axis[def.key] as number
            });
            // eslint-disable-next-line no-loop-func -- gpConfig 为共享配置（所有滑块编辑同一对象）
            slider.on('change', (v: number) => {
                gpConfig.axis[def.key] = v;
                pushGamepadConfig();
            });
            row.append(label);
            row.append(slider);
            gpPane.append(row);
            gpSliders[def.key] = slider;
        }

        // axis inversion toggles
        type AxisBoolKeys = 'invertLeftX' | 'invertLeftY' | 'invertRightX' | 'invertRightY';
        const invertDefs: { key: AxisBoolKeys; labelKey: string }[] = [
            { key: 'invertLeftX', labelKey: 'dialog.control-customize.invert-left-x' },
            { key: 'invertLeftY', labelKey: 'dialog.control-customize.invert-left-y' },
            { key: 'invertRightX', labelKey: 'dialog.control-customize.invert-right-x' },
            { key: 'invertRightY', labelKey: 'dialog.control-customize.invert-right-y' }
        ];
        const gpToggles: Record<string, Button> = {};
        for (const def of invertDefs) {
            const row = new Container({ class: 'row' });
            const label = new Label({ class: 'label' });
            i18n.bindText(label, def.labelKey);
            const toggle = new Button({ class: ['gp-toggle', 'off'] });
            // eslint-disable-next-line no-loop-func -- gpConfig 为共享配置（所有开关编辑同一对象）
            toggle.on('click', () => {
                gpConfig.axis[def.key] = !gpConfig.axis[def.key];
                pushGamepadConfig();
                refreshGamepadUi();
            });
            row.append(label);
            row.append(toggle);
            gpPane.append(row);
            gpToggles[def.key] = toggle;
        }

        // --- button bindings list (scrollable) ---
        const gpListHeader = new Label({ class: 'section-label' });
        i18n.bindText(gpListHeader, 'dialog.control-customize.gamepad-binding-list');
        gpPane.append(gpListHeader);

        const gpList = new Container({ class: 'gp-list' });
        const gpRows: { id: string, btn: Button }[] = [];
        for (const def of DEFAULT_BINDINGS) {
            const row = new Container({ class: 'kb-row' });
            const actionLabel = new Label({ class: 'kb-action' });
            i18n.bindText(actionLabel, def.labelKey);
            const btn = new Button({ class: 'kb-key' });
            // eslint-disable-next-line no-loop-func -- gpCapturingId 为共享捕获状态（同一时刻仅一个按钮在捕获）
            btn.on('click', () => {
                if (gpCapturingId === def.id) {
                    cancelGamepadCapture();
                } else {
                    startGamepadCapture(def.id);
                }
            });
            row.append(actionLabel);
            row.append(btn);
            gpList.append(row);
            gpRows.push({ id: def.id, btn });
        }
        gpPane.append(gpList);

        // reset gamepad bindings
        const resetGpBtn = new Button({ class: 'button' });
        i18n.bindText(resetGpBtn, 'dialog.control-customize.reset-gamepad');
        gpPane.append(resetGpBtn);

        body.append(gpPane);
        dialog.append(body);

        // ---- footer (close button) ----
        const footer = new Container({ class: 'footer' });
        const closeBtn = new Button({ class: 'close-button' });
        i18n.bindText(closeBtn, 'dialog.control-customize.close');
        footer.append(closeBtn);
        dialog.append(footer);

        this.append(dialog);

        // ---- gamepad helpers ----

        const pushGamepadConfig = () => {
            const next: GamepadConfig = {
                preset: gpConfig.preset ?? 'xbox',
                bindings: { ...gpConfig.bindings },
                axis: { ...gpConfig.axis }
            };
            gpConfig = next;
            events.fire('gamepad.setConfig', next);
        };

        const refreshGamepadUi = () => {
            const preset = gpConfig.preset ?? 'xbox';
            presetSelect.value = preset;
            for (const def of sliderDefs) {
                gpSliders[def.key].value = gpConfig.axis[def.key] as number;
            }
            for (const def of invertDefs) {
                const on = gpConfig.axis[def.key] as boolean;
                const t = gpToggles[def.key];
                t.text = on ? i18n.t('gamepad.settings.on') : i18n.t('gamepad.settings.off');
                t.class[on ? 'add' : 'remove']('on');
                t.class[on ? 'remove' : 'add']('off');
            }
            for (const { id, btn } of gpRows) {
                const listening = gpCapturingId === id;
                btn.text = listening ?
                    i18n.t('dialog.control-customize.gamepad-capture-hint') :
                    bindingName(gpConfig.bindings[id] ?? { type: 'button', index: 26 }, preset);
                btn.class[listening ? 'add' : 'remove']('capturing');
            }
            gpConn.text = gpConnected ?
                i18n.t('dialog.control-customize.connected') :
                i18n.t('dialog.control-customize.disconnected');
            gpConn.class[gpConnected ? 'add' : 'remove']('connected');
            gpConn.class[gpConnected ? 'remove' : 'add']('disconnected');
        };

        const stopGamepadCapture = () => {
            gpCapturingId = null;
            if (gpRaf !== null) {
                cancelAnimationFrame(gpRaf);
                gpRaf = null;
            }
            gpPrevButtons.fill(false);
            refreshGamepadUi();
        };

        const cancelGamepadCapture = () => {
            stopGamepadCapture();
        };

        // Poll gamepad buttons while capturing a binding.
        const gpPoll = () => {
            if (!gpCapturingId) return;
            const pads = navigator.getGamepads();
            for (const pad of pads) {
                if (!pad) continue;
                for (let i = 0; i < Math.min(pad.buttons.length, 32); i++) {
                    const b = pad.buttons[i];
                    const active = !!(b && (b.pressed || (typeof b.value === 'number' && b.value > 0.5)));
                    if (active && !gpPrevButtons[i] && !RESERVED_BINDING_INDICES.includes(i)) {
                        // rising edge → bind
                        const bind = gpConfig.bindings[gpCapturingId] ?? { type: 'button' as const, index: 26 };
                        bind.index = i;
                        bind.type = (i === 6 || i === 7) ? 'trigger' : 'button';
                        gpConfig.bindings[gpCapturingId] = bind;
                        pushGamepadConfig();
                        stopGamepadCapture();
                        return;
                    }
                    gpPrevButtons[i] = active;
                }
            }
            gpRaf = requestAnimationFrame(gpPoll);
        };

        const startGamepadCapture = (id: string) => {
            gpCapturingId = id;
            gpPrevButtons.fill(false);
            refreshGamepadUi();
            if (gpRaf === null) {
                gpRaf = requestAnimationFrame(gpPoll);
            }
        };

        // ---- events ----
        const syncMouseSelects = () => {
            const bindings = (events.invoke('mouseBindings.get') as MouseBindingsState) ?? DEFAULT_MOUSE_BINDINGS;
            for (const id of ['left', 'middle', 'right'] as const) {
                selectRow[id].select.value = bindings[id];
            }
        };
        events.on('mouseBindings.changed', () => {
            if (!this.hidden) syncMouseSelects();
        });
        for (const id of ['left', 'middle', 'right'] as const) {
            selectRow[id].select.on('change', (v: string) => {
                const cur = (events.invoke('mouseBindings.get') as MouseBindingsState) ?? DEFAULT_MOUSE_BINDINGS;
                const next: MouseBindingsState = { ...cur, [id]: v as MouseAction };
                events.fire('mouseBindings.set', next);
            });
        }
        resetMouseBtn.on('click', () => {
            events.fire('mouseBindings.reset');
        });
        resetKbBtn.on('click', () => {
            (events.invoke('shortcutManager') as any)?.resetAll();
            refreshShortcutRows();
        });

        presetSelect.on('change', (v: string) => {
            const next = presetConfig(v as PresetId);
            gpConfig = {
                preset: next.preset,
                bindings: { ...next.bindings },
                axis: { ...next.axis }
            };
            pushGamepadConfig();
            refreshGamepadUi();
        });

        resetGpBtn.on('click', () => {
            gpConfig = defaultConfig();
            pushGamepadConfig();
            refreshGamepadUi();
        });

        events.on('gamepad.configChanged', (cfg: GamepadConfig) => {
            if (!this.hidden) {
                gpConfig = {
                    preset: cfg.preset ?? 'xbox',
                    bindings: { ...cfg.bindings },
                    axis: { ...cfg.axis }
                };
                refreshGamepadUi();
            }
        });

        events.on('gamepad.connected', () => {
            gpConnected = true;
            if (!this.hidden) refreshGamepadUi();
        });
        events.on('gamepad.disconnected', () => {
            gpConnected = false;
            if (!this.hidden) refreshGamepadUi();
        });

        // Escape closes the dialog (unless a re-bind capture is in progress)
        const keydown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !capturingId && !gpCapturingId) {
                e.preventDefault();
                this.hide();
            }
        };
        this.show = () => {
            gpConfig = readConfig();
            syncMouseSelects();
            refreshShortcutRows();
            refreshGamepadUi();
            this.hidden = false;
            this.dom.focus();
            document.addEventListener('keydown', keydown);
        };

        this.hide = () => {
            if (capturingId) {
                capturingId = null;
                window.removeEventListener('keydown', captureHandler, true);
            }
            stopGamepadCapture();
            document.removeEventListener('keydown', keydown);
            this.hidden = true;
        };

        closeBtn.on('click', () => this.hide());

        this.destroy = () => {
            document.removeEventListener('keydown', keydown);
            window.removeEventListener('keydown', captureHandler, true);
            stopGamepadCapture();
        };
    }
}

export { ControlCustomizeDialog };
