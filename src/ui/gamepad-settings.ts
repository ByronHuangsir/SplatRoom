// gamepad-settings.ts — 全屏手柄设置面板（键位重绑 / 轴调参 / 预设切换）。
// 移植自 3DGS-Gamepad v3，文案接入 i18n。
// 支持三种输入：手柄（十字键导航 + A/右 确认）、键盘（方向键 + Enter）、鼠标。

import { Container } from '@playcanvas/pcui';

import { i18n } from './localization';
import { Events } from '../core/events';
import {
    DEFAULT_BINDINGS,
    GamepadConfig,
    PresetId,
    RESERVED_BINDING_INDICES,
    bindingName,
    defaultConfig,
    presetConfig
} from '../gamepad/gamepad-config';

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

interface RowInfo {
    kind: 'binding' | 'slider' | 'toggle' | 'button' | 'stepper' | 'lock';
    key: string;
    label: string;
    el: HTMLElement;
    bindingKey?: string;
    keyEl?: HTMLElement;
    getValue?: () => number;
    setValue?: (v: number) => void;
    rangeEl?: HTMLInputElement;
    valueEl?: HTMLElement;
    min?: number;
    max?: number;
    step?: number;
    getToggle?: () => boolean;
    setToggle?: (v: boolean) => void;
    switchEl?: HTMLElement;
    onActivate?: () => void;
    btnEl?: HTMLElement;
    presetId?: PresetId;
}

class GamepadSettings extends Container {
    private events: Events;
    private config: GamepadConfig;
    private open = false;
    private selectedIndex = 0;
    private rows: RowInfo[] = [];
    private listeningKey: string | null = null;
    private listenArmed = false;
    private rafId: number | null = null;
    private prevButtons: boolean[] = new Array(18).fill(false);
    private bodyEl: HTMLElement;
    private hintEl: HTMLElement;
    private gearValue = 2;
    private heightLocked = false;

    constructor(events: Events, args = {}) {
        args = { ...args, id: 'gamepad-settings', class: 'blocks-shortcuts' };
        super(args);
        this.events = events;
        this.config = defaultConfig();
        this.hintEl = document.createElement('div');
        this.bodyEl = document.createElement('div');
        this.buildPanelDom();
        this.hidden = true;

        events.on('gamepad.settingsOpen', () => this.openPanel());
        events.on('gamepad.settingsClosed', () => this.closePanel());

        events.on('gamepad.configChanged', (cfg: GamepadConfig) => {
            this.config = {
                preset: cfg.preset ?? 'xbox',
                bindings: { ...cfg.bindings },
                axis: { ...cfg.axis }
            };
            this.refresh();
        });

        events.on('gamepad.speedGear', (gear: number) => {
            this.gearValue = gear; this.refresh();
        });
        events.on('gamepad.heightLock', (locked: boolean) => {
            this.heightLocked = locked; this.refresh();
        });

        document.addEventListener('keydown', (e) => {
            if (!this.open) return;
            if (this.listeningKey) {
                if (e.key === 'Escape') {
                    this.cancelListen(); e.preventDefault();
                }
                return;
            }
            const target = e.target as HTMLElement | null;
            switch (e.key) {
                case 'Escape': this.closePanel(); break;
                case 'ArrowUp': this.moveSelection(-1); e.preventDefault(); break;
                case 'ArrowDown': this.moveSelection(1); e.preventDefault(); break;
                case 'ArrowLeft':
                case 'ArrowRight':
                    if (target?.tagName === 'INPUT') return;
                    this.activateRow(e.key === 'ArrowLeft' ? 'left' : 'right');
                    e.preventDefault();
                    break;
                case 'Enter':
                    if (target?.tagName === 'BUTTON') return;
                    this.activateRow('right');
                    e.preventDefault();
                    break;
                default: break;
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key !== 'F2') return;
            e.preventDefault();
            if (this.open) {
                this.closePanel();
            } else {
                this.events.fire('gamepad.settingsOpen');
            }
        });
    }

    private readConfig(): GamepadConfig {
        const cfg = this.events.invoke('gamepad.config') as GamepadConfig | undefined;
        const src = cfg ?? defaultConfig();
        return {
            preset: src.preset ?? 'xbox',
            bindings: { ...src.bindings },
            axis: { ...src.axis }
        };
    }

    private buildPanelDom() {
        const dom = this.dom;
        const backdrop = document.createElement('div');
        backdrop.className = 'gps-backdrop';
        backdrop.addEventListener('click', () => this.closePanel());
        dom.appendChild(backdrop);

        const panel = document.createElement('div');
        panel.className = 'gps-panel';
        dom.appendChild(panel);

        const header = document.createElement('div');
        header.className = 'gps-header';
        const titleWrap = document.createElement('div');
        titleWrap.className = 'gps-title-wrap';
        const title = document.createElement('div');
        title.className = 'gps-title';
        title.textContent = i18n.t('gamepad.settings.title');
        titleWrap.appendChild(title);
        const subtitle = document.createElement('div');
        subtitle.className = 'gps-subtitle';
        subtitle.textContent = i18n.t('gamepad.settings.subtitle');
        titleWrap.appendChild(subtitle);
        header.appendChild(titleWrap);
        const closeBtn = document.createElement('button');
        closeBtn.className = 'gps-close-btn';
        closeBtn.textContent = '✕';
        closeBtn.title = i18n.t('gamepad.settings.close');
        closeBtn.addEventListener('click', () => this.closePanel());
        header.appendChild(closeBtn);
        panel.appendChild(header);

        this.bodyEl.className = 'gps-body';
        panel.appendChild(this.bodyEl);

        // Section: config presets
        this.bodyEl.appendChild(this.sectionTitle(i18n.t('gamepad.settings.presets'), 'ONE-CLICK PRESETS'));
        this.rows.push(this.buildButtonRow('preset-xbox', i18n.t('gamepad.settings.presets.xbox'), () => {
            this.applyPreset('xbox');
        }, 'xbox'));
        this.rows.push(this.buildButtonRow('preset-playstation', i18n.t('gamepad.settings.presets.playstation'), () => {
            this.applyPreset('playstation');
        }, 'playstation'));

        // Section: button bindings
        this.bodyEl.appendChild(this.sectionTitle(i18n.t('gamepad.settings.bindings'), 'BUTTON BINDINGS'));
        for (const def of DEFAULT_BINDINGS) {
            this.rows.push(this.buildBindingRow(def.id, i18n.t(def.labelKey)));
        }

        // Section: flight controls
        this.bodyEl.appendChild(this.sectionTitle(i18n.t('gamepad.settings.flight'), 'FLIGHT CONTROLS'));
        this.rows.push(this.buildStepperRow('speedGear', i18n.t('gamepad.settings.speedGear'), 0, 5, () => this.gearValue, index => this.events.fire('gamepad.setSpeedGear', index)));
        this.rows.push(this.buildLockRow('heightLock', i18n.t('gamepad.settings.heightLock'), () => this.heightLocked, () => this.events.fire('gamepad.toggleHeightLock')));

        // Section: stick tuning
        this.bodyEl.appendChild(this.sectionTitle(i18n.t('gamepad.settings.stick'), 'STICK & SENSITIVITY'));
        // 分轴灵敏度（对齐 v1.3.0）：平移 / 视角左右 / 视角上下 独立调节
        this.rows.push(this.buildSliderRow('moveSensitivity', i18n.t('gamepad.settings.moveSensitivity'), 0.5, 7.5, 0.05, () => this.config.axis.moveSensitivity, (v) => {
            this.config.axis.moveSensitivity = v;
        }));
        this.rows.push(this.buildSliderRow('lookSensitivity', i18n.t('gamepad.settings.lookSensitivity'), 0.05, 0.65, 0.01, () => this.config.axis.lookSensitivity, (v) => {
            this.config.axis.lookSensitivity = v;
        }));
        this.rows.push(this.buildSliderRow('lookPitchSensitivity', i18n.t('gamepad.settings.lookPitchSensitivity'), 0.04, 0.36, 0.01, () => this.config.axis.lookPitchSensitivity, (v) => {
            this.config.axis.lookPitchSensitivity = v;
        }));
        this.rows.push(this.buildSliderRow('deadzone', i18n.t('gamepad.settings.deadzone'), 0.0, 0.3, 0.01, () => this.config.axis.deadzone, (v) => {
            this.config.axis.deadzone = v;
        }));
        this.rows.push(this.buildSliderRow('smoothing', i18n.t('gamepad.settings.smoothing'), 0.0, 0.9, 0.01, () => this.config.axis.smoothing, (v) => {
            this.config.axis.smoothing = v;
        }));
        this.rows.push(this.buildToggleRow('invertLeftX', i18n.t('gamepad.settings.invertLeftX'), () => this.config.axis.invertLeftX, (v) => {
            this.config.axis.invertLeftX = v;
        }));
        this.rows.push(this.buildToggleRow('invertLeftY', i18n.t('gamepad.settings.invertLeftY'), () => this.config.axis.invertLeftY, (v) => {
            this.config.axis.invertLeftY = v;
        }));
        this.rows.push(this.buildToggleRow('invertRightX', i18n.t('gamepad.settings.invertRightX'), () => this.config.axis.invertRightX, (v) => {
            this.config.axis.invertRightX = v;
        }));
        this.rows.push(this.buildToggleRow('invertRightY', i18n.t('gamepad.settings.invertRightY'), () => this.config.axis.invertRightY, (v) => {
            this.config.axis.invertRightY = v;
        }));

        // Footer buttons
        this.rows.push(this.buildButtonRow('reset', i18n.t('gamepad.settings.reset'), () => {
            this.events.fire('gamepad.resetConfig');
        }));
        this.rows.push(this.buildButtonRow('done', i18n.t('gamepad.settings.done'), () => {
            this.closePanel();
        }));

        this.bodyEl.addEventListener('click', (e) => {
            const target = (e.target as HTMLElement).closest('.gps-row') as HTMLElement | null;
            if (!target) return;
            const idx = parseInt(target.dataset.rowIndex ?? '-1', 10);
            if (idx < 0 || idx >= this.rows.length) return;
            this.selectedIndex = idx;
            const row = this.rows[idx];
            switch (row.kind) {
                case 'binding': this.startListen(row.bindingKey!); break;
                case 'slider':
                case 'stepper': break;
                case 'toggle': this.toggleRow(row); break;
                case 'lock': this.toggleRow(row); break;
                case 'button': row.onActivate?.(); break;
                default: break;
            }
            this.refresh();
        });

        this.rows.forEach((row, i) => {
            row.el.dataset.rowIndex = String(i);
        });

        this.hintEl.className = 'gps-hint';
        this.hintEl.textContent = i18n.t('gamepad.settings.hint');
        panel.appendChild(this.hintEl);
    }

    private sectionTitle(title: string, sub: string): HTMLElement {
        const el = document.createElement('div');
        el.className = 'gps-section-title';
        const t = document.createElement('span');
        t.textContent = title;
        el.appendChild(t);
        const s = document.createElement('span');
        s.className = 'gps-section-sub';
        s.textContent = sub;
        el.appendChild(s);
        return el;
    }

    private buildBindingRow(actionId: string, label: string): RowInfo {
        const row = document.createElement('div');
        row.className = 'gps-row';
        const labelEl = document.createElement('span');
        labelEl.className = 'gps-row-label';
        labelEl.textContent = label;
        row.appendChild(labelEl);
        const keyEl = document.createElement('button');
        keyEl.className = 'gps-key';
        keyEl.title = i18n.t('gamepad.settings.rebind');
        row.appendChild(keyEl);
        this.bodyEl.appendChild(row);
        return { kind: 'binding', key: actionId, label, el: row, bindingKey: actionId, keyEl };
    }

    /**
     * 滑条轨道填充：双层背景（橙色渐变叠灰底），background-size 的第一个值
     * 控制已填充比例。没有它填充不会跟随滑块（v1.3.0 UI 增强）。
     */
    private setRangeFill(rangeEl: HTMLInputElement, min: number, max: number) {
        if (max <= min) return;
        const val = parseFloat(rangeEl.value);
        if (isNaN(val)) return;
        const pct = ((val - min) / (max - min)) * 100;
        rangeEl.style.backgroundSize = `${Math.max(0, Math.min(100, pct))}% 100%`;
    }

    private buildSliderRow(key: string, label: string, min: number, max: number, step: number, getValue: () => number, setValue: (v: number) => void): RowInfo {
        const row = document.createElement('div');
        row.className = 'gps-row gps-row-slider';
        const labelEl = document.createElement('span');
        labelEl.className = 'gps-row-label';
        labelEl.textContent = label;
        row.appendChild(labelEl);
        const valueEl = document.createElement('span');
        valueEl.className = 'gps-slider-value';
        const rangeEl = document.createElement('input');
        rangeEl.type = 'range';
        rangeEl.className = 'gps-range';
        rangeEl.min = String(min);
        rangeEl.max = String(max);
        rangeEl.step = String(step);
        rangeEl.value = String(getValue());
        this.setRangeFill(rangeEl, min, max);
        rangeEl.addEventListener('input', () => {
            setValue(parseFloat(rangeEl.value));
            valueEl.textContent = parseFloat(rangeEl.value).toFixed(2);
            this.setRangeFill(rangeEl, min, max);
            this.pushConfig();
        });
        const control = document.createElement('div');
        control.className = 'gps-row-control';
        control.appendChild(rangeEl);
        control.appendChild(valueEl);
        row.appendChild(control);
        this.bodyEl.appendChild(row);
        return { kind: 'slider', key, label, el: row, getValue, setValue, rangeEl, valueEl, min, max, step };
    }

    private buildToggleRow(key: string, label: string, getToggle: () => boolean, setToggle: (v: boolean) => void): RowInfo {
        const row = document.createElement('div');
        row.className = 'gps-row';
        const labelEl = document.createElement('span');
        labelEl.className = 'gps-row-label';
        labelEl.textContent = label;
        row.appendChild(labelEl);
        const switchEl = document.createElement('button');
        switchEl.className = 'gps-switch off';
        row.appendChild(switchEl);
        this.bodyEl.appendChild(row);
        return { kind: 'toggle', key, label, el: row, getToggle, setToggle, switchEl };
    }

    private buildStepperRow(key: string, label: string, min: number, max: number, getValue: () => number, setValue: (v: number) => void): RowInfo {
        const row = document.createElement('div');
        row.className = 'gps-row gps-row-stepper';
        const labelEl = document.createElement('span');
        labelEl.className = 'gps-row-label';
        labelEl.textContent = label;
        row.appendChild(labelEl);
        const control = document.createElement('div');
        control.className = 'gps-row-control';
        const minusBtn = document.createElement('button');
        minusBtn.className = 'gps-stepper-btn';
        minusBtn.textContent = '−';
        minusBtn.title = i18n.t('gamepad.settings.decrease');
        minusBtn.addEventListener('click', (e) => {
            e.stopPropagation(); setValue(clamp(getValue() - 1, min, max));
        });
        const valueEl = document.createElement('span');
        valueEl.className = 'gps-stepper-value';
        const plusBtn = document.createElement('button');
        plusBtn.className = 'gps-stepper-btn';
        plusBtn.textContent = '+';
        plusBtn.title = i18n.t('gamepad.settings.increase');
        plusBtn.addEventListener('click', (e) => {
            e.stopPropagation(); setValue(clamp(getValue() + 1, min, max));
        });
        control.appendChild(minusBtn);
        control.appendChild(valueEl);
        control.appendChild(plusBtn);
        row.appendChild(control);
        this.bodyEl.appendChild(row);
        return { kind: 'stepper', key, label, el: row, getValue, setValue, valueEl, min, max };
    }

    private buildLockRow(key: string, label: string, getToggle: () => boolean, setToggle: (v: boolean) => void): RowInfo {
        const row = document.createElement('div');
        row.className = 'gps-row gps-row-lock';
        const labelEl = document.createElement('span');
        labelEl.className = 'gps-row-label';
        labelEl.textContent = label;
        row.appendChild(labelEl);
        const lockBtn = document.createElement('button');
        lockBtn.className = 'gps-lock-btn off';
        lockBtn.addEventListener('click', (e) => {
            e.stopPropagation(); setToggle(!getToggle());
        });
        row.appendChild(lockBtn);
        this.bodyEl.appendChild(row);
        return { kind: 'lock', key, label, el: row, getToggle, setToggle, switchEl: lockBtn };
    }

    private buildButtonRow(key: string, label: string, onActivate: () => void, presetId?: PresetId): RowInfo {
        const row = document.createElement('div');
        row.className = 'gps-row gps-button-row';
        const btn = document.createElement('button');
        btn.className = 'gps-action-btn';
        btn.textContent = label;
        row.appendChild(btn);
        this.bodyEl.appendChild(row);
        return { kind: 'button', key, label, el: row, onActivate, btnEl: btn, presetId };
    }

    private openPanel() {
        if (this.open) return;
        this.open = true;
        this.config = this.readConfig();
        this.gearValue = (this.events.invoke('gamepad.speedGear') as number | undefined) ?? 2;
        this.heightLocked = (this.events.invoke('gamepad.heightLocked') as boolean | undefined) ?? false;
        this.selectedIndex = 0;
        this.listeningKey = null;
        this.listenArmed = false;
        this.prevButtons.fill(false);
        this.hidden = false;
        this.refresh();
        this.updateSelection(true);   // 面板打开：滚动到选中行
        (document.activeElement as HTMLElement | null)?.blur?.();
        this.rafId = requestAnimationFrame(this.tick);
    }

    private closePanel() {
        if (!this.open) return;
        this.open = false;
        this.hidden = true;
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId); this.rafId = null;
        }
        this.listeningKey = null;
        this.listenArmed = false;
        this.hintEl.textContent = i18n.t('gamepad.settings.hint');
        this.events.fire('gamepad.settingsClosed');
    }

    private tick = () => {
        if (!this.open) return;
        const gp = this.pollGamepad();
        if (gp) this.processGamepad(gp);
        this.rafId = requestAnimationFrame(this.tick);
    };

    private pollGamepad(): Gamepad | null {
        const pads = navigator.getGamepads();
        for (let i = 0; i < pads.length; i++) {
            if (pads[i]) return pads[i];
        }
        return null;
    }

    private btnPressed(gp: Gamepad, i: number): boolean {
        const b = gp.buttons[i];
        if (!b) return false;
        if (b.pressed) return true;
        return typeof b.value === 'number' && b.value > 0.5;
    }

    private processGamepad(gp: Gamepad) {
        let pressedIdx = -1;
        let anyPressed = false;
        for (let i = 0; i < Math.min(gp.buttons.length, 18); i++) {
            if (this.btnPressed(gp, i)) {
                pressedIdx = i; anyPressed = true; break;
            }
        }

        if (this.listeningKey) {
            if (this.btnPressed(gp, 1) && !this.prevButtons[1]) {
                this.cancelListen();
            } else if (!anyPressed) {
                this.listenArmed = true;
            } else if (this.listenArmed && !RESERVED_BINDING_INDICES.includes(pressedIdx)) {
                const binding = this.config.bindings[this.listeningKey];
                binding.index = pressedIdx;
                binding.type = (pressedIdx === 6 || pressedIdx === 7) ? 'trigger' : 'button';
                this.listeningKey = null;
                this.listenArmed = false;
                this.hintEl.textContent = i18n.t('gamepad.settings.hint');
                this.pushConfig();
            }
            for (let i = 0; i < 18; i++) {
                this.prevButtons[i] = this.btnPressed(gp, i);
            }
            return;
        }

        const jp = (i: number) => this.btnPressed(gp, i) && !this.prevButtons[i];
        if (jp(12)) {
            this.moveSelection(-1);
        } else if (jp(13)) {
            this.moveSelection(1);
        } else if (jp(14)) {
            this.activateRow('left');
        } else if (jp(15) || jp(0)) {
            this.activateRow('right');
        } else if (jp(1) || jp(9) || jp(2)) {
            this.closePanel();
        }

        for (let i = 0; i < 18; i++) {
            this.prevButtons[i] = this.btnPressed(gp, i);
        }
    }

    private moveSelection(delta: number) {
        if (this.rows.length === 0) return;
        this.selectedIndex = (this.selectedIndex + delta + this.rows.length) % this.rows.length;
        this.updateSelection(true);
    }

    /**
     * 刷新选中高亮。scroll=true 时滚动到选中行；数据刷新（滑块拖拽/重绑等
     * 非导航触发）传 false，避免面板每次跳回顶部（v1.3.0 修复）。
     */
    private updateSelection(scroll = false) {
        this.rows.forEach((row, i) => {
            row.el.classList.toggle('selected', i === this.selectedIndex);
        });
        if (scroll) {
            const active = this.rows[this.selectedIndex];
            if (active) {
                active.el.scrollIntoView({ block: 'nearest' });
            }
        }
    }

    private activateRow(dir: 'left' | 'right') {
        const row = this.rows[this.selectedIndex];
        if (!row) return;
        switch (row.kind) {
            case 'binding': this.startListen(row.bindingKey!); break;
            case 'slider': {
                if (row.rangeEl && row.step && row.min !== undefined && row.max !== undefined) {
                    const step = (dir === 'left' ? -1 : 1) * row.step;
                    const v = clamp(parseFloat(row.rangeEl.value) + step, row.min, row.max);
                    row.rangeEl.value = String(v);
                    row.setValue?.(v);
                    if (row.valueEl) row.valueEl.textContent = v.toFixed(2);
                    this.pushConfig();
                }
                break;
            }
            case 'toggle': this.toggleRow(row); break;
            case 'stepper': {
                if (row.getValue && row.setValue && row.min !== undefined && row.max !== undefined) {
                    const delta = dir === 'left' ? -1 : 1;
                    row.setValue(clamp(row.getValue() + delta, row.min, row.max));
                }
                break;
            }
            case 'lock': this.toggleRow(row); break;
            case 'button': row.onActivate?.(); break;
            default: break;
        }
        this.refresh();
    }

    private startListen(actionId: string) {
        this.listeningKey = actionId;
        this.listenArmed = false;
        this.hintEl.textContent = i18n.t('gamepad.settings.listen-hint');
        this.refresh();
    }

    private cancelListen() {
        this.listeningKey = null;
        this.listenArmed = false;
        this.hintEl.textContent = i18n.t('gamepad.settings.hint');
        this.refresh();
    }

    private toggleRow(row: RowInfo) {
        const next = !(row.getToggle?.() ?? false);
        row.setToggle?.(next);
        this.pushConfig();
    }

    private applyPreset(id: PresetId) {
        const next = presetConfig(id);
        this.config = {
            preset: next.preset,
            bindings: { ...next.bindings },
            axis: { ...next.axis }
        };
        this.pushConfig();
    }

    private pushConfig() {
        const next: GamepadConfig = {
            preset: this.config.preset ?? 'xbox',
            bindings: { ...this.config.bindings },
            axis: { ...this.config.axis }
        };
        this.config = next;
        this.events.fire('gamepad.setConfig', next);
    }

    private refresh() {
        for (const row of this.rows) {
            switch (row.kind) {
                case 'binding': {
                    const isListening = this.listeningKey === row.bindingKey;
                    if (row.keyEl) {
                        row.keyEl.textContent = isListening ?
                            i18n.t('gamepad.settings.listen-any') :
                            bindingName(this.config.bindings[row.bindingKey!], this.config.preset ?? 'xbox');
                        row.keyEl.classList.toggle('listening', isListening);
                    }
                    break;
                }
                case 'slider': {
                    if (row.rangeEl && row.getValue) {
                        const v = row.getValue();
                        row.rangeEl.value = String(v);
                        if (row.valueEl) row.valueEl.textContent = v.toFixed(2);
                    }
                    break;
                }
                case 'toggle': {
                    const on = row.getToggle?.() ?? false;
                    if (row.switchEl) {
                        row.switchEl.textContent = on ? i18n.t('gamepad.settings.on') : i18n.t('gamepad.settings.off');
                        row.switchEl.classList.toggle('on', on);
                        row.switchEl.classList.toggle('off', !on);
                    }
                    break;
                }
                case 'stepper': {
                    if (row.valueEl && row.getValue !== undefined) {
                        const v = row.getValue();
                        const total = (row.max ?? 0) + 1;
                        row.valueEl.textContent = `${v + 1}/${total}`;
                    }
                    break;
                }
                case 'lock': {
                    const on = row.getToggle?.() ?? false;
                    if (row.switchEl) {
                        row.switchEl.textContent = on ? i18n.t('gamepad.settings.locked') : i18n.t('gamepad.settings.lockHeight');
                        row.switchEl.classList.toggle('on', on);
                        row.switchEl.classList.toggle('off', !on);
                    }
                    break;
                }
                case 'button':
                    if (row.presetId && row.btnEl) {
                        const active = (this.config.preset ?? 'xbox') === row.presetId;
                        row.btnEl.textContent = active ? `${row.label}${i18n.t('gamepad.settings.current')}` : row.label;
                        row.btnEl.classList.toggle('gps-preset-active', active);
                    }
                    break;
                default: break;
            }
        }
        this.updateSelection();
    }
}

export { GamepadSettings };
