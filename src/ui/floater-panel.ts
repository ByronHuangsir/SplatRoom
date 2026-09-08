import { BooleanInput, Button, Container, ContainerArgs, Label, SliderInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { i18n } from './localization';
import { detectFloaters } from '../floater-removal';

/**
 * Floater Removal Panel — 去浮云（简化版）。
 *
 * 原版暴露 5 个参数 + 快速/精细两种模式，方向不明确、不适合新手。
 * 现简化为：开关 + 单个「灵敏度」滑条（0-100，默认 40）+ 检出明细 + 一键移除。
 * 灵敏度内部联动 透明度/体积/隔离/距离 四策略（见 floater-removal.ts）。
 */
class FloaterPanel extends Container {
    private _fltEvents: Events;
    private _contentContainer: Container;
    private _collapsed = true;
    private _collapseArrow: Label;

    // Sensitivity slider
    private _sensitivitySlider: SliderInput;
    private _sensitivityRow: Container;

    // Result display（计数 + 各策略明细）
    private _resultLabel: Label;

    // Action button
    private _removeBtn: Button;

    // Enable toggle
    private _enabledToggle: BooleanInput;
    private _fltEnabled = false;

    private _sensitivity = 40;
    private _detectTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(events: Events, args: ContainerArgs = {}) {
        args = {
            ...args,
            id: 'floater-panel'
        };
        super(args);

        this._fltEvents = events;

        // ---- collapsible header ----
        const header = new Container({ class: 'panel-header' });
        header.dom.style.cursor = 'pointer';

        this._collapseArrow = new Label({
            class: 'floater-panel-collapse-arrow',
            text: '\u25B6'   // ▶  collapsed
        });

        const icon = new Label({
            text: '\uE73E',   // cloud icon
            class: 'panel-header-icon'
        });

        const titleLabel = new Label({ class: 'panel-header-label' });
        i18n.bindText(titleLabel, 'panel.floater');

        header.append(this._collapseArrow);
        header.append(icon);
        header.append(titleLabel);

        // Toggle switch on the right side of the header
        const toggleWrapper = new Container({ class: 'floater-panel-header-toggle' });
        this._enabledToggle = new BooleanInput({
            type: 'toggle',
            value: false
        });
        this._enabledToggle.on('change', (v: boolean) => this._updateEnabled(v));
        toggleWrapper.dom.addEventListener('click', (e: MouseEvent) => e.stopPropagation());
        toggleWrapper.append(this._enabledToggle);
        header.append(toggleWrapper);

        header.dom.addEventListener('click', () => this._toggleCollapse());

        // ---- content ----
        this._contentContainer = new Container({ class: 'floater-panel-content' });

        // 灵敏度滑条：唯一的调参入口（越高删得越多）
        this._sensitivityRow = this._buildSliderRow(
            'panel.floater.sensitivity',
            0, 100, 1,
            this._sensitivity,
            (v) => {
                this._sensitivity = v;
            }
        );

        // 使用提示
        const hintRow = new Container({ class: 'floater-panel-row' });
        const hintLabel = new Label({ class: 'floater-panel-hint' });
        i18n.bindText(hintLabel, 'panel.floater.sensitivityHint');
        hintRow.append(hintLabel);
        this._contentContainer.append(hintRow);

        // Result label（检出数 + 各策略明细）
        const resultRow = new Container({ class: 'floater-panel-row' });
        this._resultLabel = new Label({
            class: 'floater-panel-result',
            text: '--'
        });
        resultRow.append(this._resultLabel);
        this._contentContainer.append(resultRow);

        // Remove button
        const btnRow = new Container({ class: 'floater-panel-row' });
        this._removeBtn = new Button({ class: 'floater-panel-remove-btn' });
        i18n.bindText(this._removeBtn, 'panel.floater.remove');
        this._removeBtn.on('click', () => this._applyRemoval());
        btnRow.append(this._removeBtn);
        this._contentContainer.append(btnRow);

        // ---- assemble ----
        this.append(header);
        this.append(this._contentContainer);

        // Start collapsed by default
        this._contentContainer.hidden = true;

        // Listen for selection changes to re-detect
        events.on('selection', () => this._scheduleDetect());
        events.on('splat.stateChanged', () => this._scheduleDetect());
    }

    // ================================================================
    //  Enable/disable all controls
    // ================================================================
    private _updateEnabled(enabled: boolean) {
        this._fltEnabled = enabled;
        this._sensitivitySlider.enabled = enabled;
        this._removeBtn.enabled = enabled;
        if (enabled) {
            this._sensitivityRow.class.remove('dimmed');
            this._removeBtn.class.remove('dimmed');
            this._resultLabel.text = '...';
            this._scheduleDetect();
        } else {
            this._sensitivityRow.class.add('dimmed');
            this._removeBtn.class.add('dimmed');
            this._resultLabel.text = '--';
        }
    }

    private _buildSliderRow(
        i18nKey: string,
        min: number, max: number, step: number,
        value: number,
        onChange: (v: number) => void
    ): Container {
        const row = new Container({ class: 'floater-panel-row' });

        const label = new Label({ class: 'floater-panel-label' });
        i18n.bindText(label, i18nKey);

        const slider = new SliderInput({
            class: 'floater-panel-slider',
            min,
            max,
            step,
            value
        });

        slider.on('change', (v: number) => {
            onChange(v);
            this._scheduleDetect();
        });

        this._sensitivitySlider = slider;

        row.append(label);
        row.append(slider);
        this._contentContainer.append(row);
        return row;
    }

    // ================================================================
    //  Detection (debounced; preview samples for speed)
    // ================================================================
    private _scheduleDetect() {
        if (!this._fltEnabled) return;
        if (this._detectTimer) clearTimeout(this._detectTimer);
        this._resultLabel.text = '...';
        this._detectTimer = setTimeout(() => this._runDetect(), 200);
    }

    private _runDetect() {
        const splat = this._fltEvents.invoke('selection');
        if (!splat) {
            this._resultLabel.text = '--';
            return;
        }

        try {
            // 预览：采样检测（8000 点），速度快
            const result = detectFloaters(splat, this._sensitivity, 8000);
            this._resultLabel.text = `${result.count}`;
            // 明细：帮助新手理解检出来源与调节方向（悬停查看）
            const d = result.details;
            this._resultLabel.dom.title =
                `透明 ${d.opacity} · 体积 ${d.volume} · 隔离 ${d.isolation} · 距离 ${d.distance}`;
        } catch (e) {
            this._resultLabel.text = '!';
        }
    }

    // ================================================================
    //  Apply removal（全量精确检测）
    // ================================================================
    private _applyRemoval() {
        const splat = this._fltEvents.invoke('selection');
        if (!splat) return;

        try {
            this._resultLabel.text = '...';
            const result = detectFloaters(splat, this._sensitivity, Infinity);
            if (result.count === 0) {
                this._resultLabel.text = '0';
                return;
            }
            // Fire event to apply deletion (editor.ts handles the edit operation)
            this._fltEvents.fire('floater.apply', { mask: result.mask, count: result.count });
            this._resultLabel.text = `${result.count}`;
        } catch (e) {
            this._resultLabel.text = '!';
        }
    }

    // ================================================================
    //  Collapse
    // ================================================================
    private _toggleCollapse() {
        this._collapsed = !this._collapsed;
        if (this._collapsed) {
            this._contentContainer.hidden = true;
            this._collapseArrow.text = '\u25B6';
        } else {
            this._contentContainer.hidden = false;
            this._collapseArrow.text = '\u25BC';
        }
    }

    /** 强制折叠（供其他面板展开时调用，如地面/水域面板）。 */
    collapse() {
        if (!this._collapsed) this._toggleCollapse();
    }
}

export { FloaterPanel };
