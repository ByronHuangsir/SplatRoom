import { BooleanInput, Button, Container, ContainerArgs, Label, SliderInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { i18n } from './localization';
import {
    FloaterParams,
    QUICK_STRATEGIES,
    FINE_STRATEGIES,
    QUICK_DEFAULTS,
    FINE_DEFAULTS,
    detectFloaters
} from '../floater-removal';

/**
 * Floater Removal Panel — placed below the Camera panel in the left sidebar.
 * Provides two modes (quick / fine), threshold sliders, and one-click removal.
 */
class FloaterPanel extends Container {
    private _fltEvents: Events;
    private _contentContainer: Container;
    private _collapsed = true;
    private _collapseArrow: Label;

    // Mode buttons
    private _quickBtn: Button;
    private _fineBtn: Button;

    // Sliders
    private _opacitySlider: SliderInput;
    private _volumeSlider: SliderInput;
    private _isolationRadiusSlider: SliderInput;
    private _isolationMinSlider: SliderInput;
    private _distanceSlider: SliderInput;

    // Isolation rows (only visible in fine mode)
    private _isolationRadiusRow: Container;
    private _isolationMinRow: Container;
    private _distanceRow: Container;

    // Result display
    private _resultLabel: Label;

    // Action button
    private _removeBtn: Button;

    // Enable toggle
    private _enabledToggle: BooleanInput;
    private _fltEnabled = false;

    // Slider rows (for enable/disable dimming)
    private _opacityRow: Container;
    private _volumeRow: Container;

    // Current state
    private _mode: 'quick' | 'fine' = 'quick';
    private _params: FloaterParams;
    private _detectTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(events: Events, args: ContainerArgs = {}) {
        args = {
            ...args,
            id: 'floater-panel'
        };
        super(args);

        this._fltEvents = events;
        this._params = { ...QUICK_DEFAULTS };

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

        // Mode selector
        this._buildModeRow();

        // Threshold sliders
        this._opacityRow = this._buildSliderRow(
            'panel.floater.opacityThreshold',
            1, 50, 1,
            this._params.opacityThreshold * 100,
            (v) => { this._params.opacityThreshold = v / 100; },
            (slider) => { this._opacitySlider = slider; }
        );
        this._volumeRow = this._buildSliderRow(
            'panel.floater.volumeThreshold',
            20, 100, 1,
            this._params.volumeStdThreshold * 10,
            (v) => { this._params.volumeStdThreshold = v / 10; },
            (slider) => { this._volumeSlider = slider; }
        );
        this._isolationRadiusRow = this._buildSliderRow(
            'panel.floater.neighborRadius',
            1, 100, 1,
            this._params.neighborRadius * 1000,
            (v) => { this._params.neighborRadius = v / 1000; },
            (slider) => { this._isolationRadiusSlider = slider; }
        );
        this._isolationMinRow = this._buildSliderRow(
            'panel.floater.minNeighbors',
            1, 30, 1,
            this._params.minNeighbors,
            (v) => { this._params.minNeighbors = v; },
            (slider) => { this._isolationMinSlider = slider; }
        );
        this._distanceRow = this._buildSliderRow(
            'panel.floater.distanceThreshold',
            10, 100, 1,
            this._params.distanceThreshold * 100,
            (v) => { this._params.distanceThreshold = v / 100; },
            (slider) => { this._distanceSlider = slider; }
        );

        // Result label
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

        // Initial mode setup
        this._setMode('quick');

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

        // Sliders
        this._opacitySlider.enabled = enabled;
        this._volumeSlider.enabled = enabled;
        this._isolationRadiusSlider.enabled = enabled;
        this._isolationMinSlider.enabled = enabled;
        this._distanceSlider.enabled = enabled;

        // Mode buttons
        this._quickBtn.enabled = enabled;
        this._fineBtn.enabled = enabled;

        // Remove button
        this._removeBtn.enabled = enabled;

        if (enabled) {
            this._opacityRow.class.remove('dimmed');
            this._volumeRow.class.remove('dimmed');
            this._isolationRadiusRow.class.remove('dimmed');
            this._isolationMinRow.class.remove('dimmed');
            this._distanceRow.class.remove('dimmed');
            this._quickBtn.class.remove('dimmed');
            this._fineBtn.class.remove('dimmed');
            this._removeBtn.class.remove('dimmed');
            this._resultLabel.text = '...';
            this._scheduleDetect();
        } else {
            this._opacityRow.class.add('dimmed');
            this._volumeRow.class.add('dimmed');
            this._isolationRadiusRow.class.add('dimmed');
            this._isolationMinRow.class.add('dimmed');
            this._distanceRow.class.add('dimmed');
            this._quickBtn.class.add('dimmed');
            this._fineBtn.class.add('dimmed');
            this._removeBtn.class.add('dimmed');
            this._resultLabel.text = '--';
        }
    }

    private _buildModeRow() {
        const row = new Container({ class: 'floater-panel-row' });

        const label = new Label({ class: 'floater-panel-label' });
        i18n.bindText(label, 'panel.floater.mode');

        const btnGroup = new Container({ class: 'floater-panel-mode-buttons' });

        this._quickBtn = new Button({ class: 'floater-panel-mode-btn' });
        i18n.bindText(this._quickBtn, 'panel.floater.mode.quick');
        this._quickBtn.on('click', () => this._setMode('quick'));

        this._fineBtn = new Button({ class: 'floater-panel-mode-btn' });
        i18n.bindText(this._fineBtn, 'panel.floater.mode.fine');
        this._fineBtn.on('click', () => this._setMode('fine'));

        btnGroup.append(this._quickBtn);
        btnGroup.append(this._fineBtn);
        row.append(label);
        row.append(btnGroup);
        this._contentContainer.append(row);
    }

    private _buildSliderRow(
        i18nKey: string,
        min: number, max: number, step: number,
        value: number,
        onChange: (v: number) => void,
        setRef: (slider: SliderInput) => void
    ): Container {
        const row = new Container({ class: 'floater-panel-row' });

        const label = new Label({ class: 'floater-panel-label' });
        i18n.bindText(label, i18nKey);

        const slider = new SliderInput({
            class: 'floater-panel-slider',
            min, max, step, value
        });

        slider.on('change', (v: number) => {
            onChange(v);
            this._scheduleDetect();
        });

        setRef(slider);

        row.append(label);
        row.append(slider);
        this._contentContainer.append(row);
        return row;
    }

    // ================================================================
    //  Row enable/disable (dim instead of hide)
    // ================================================================
    private _setRowEnabled(row: Container, slider: SliderInput, enabled: boolean) {
        if (enabled) {
            row.class.remove('dimmed');
            slider.enabled = true;
        } else {
            row.class.add('dimmed');
            slider.enabled = false;
        }
    }

    // ================================================================
    //  Mode switching
    // ================================================================
    private _setMode(mode: 'quick' | 'fine') {
        this._mode = mode;

        // In quick mode, isolation & distance params don't participate — dim them
        // instead of hiding, so the user can still see what fine mode adds.
        const dimmed = mode === 'quick';
        this._setRowEnabled(this._isolationRadiusRow, this._isolationRadiusSlider, !dimmed);
        this._setRowEnabled(this._isolationMinRow, this._isolationMinSlider, !dimmed);
        this._setRowEnabled(this._distanceRow, this._distanceSlider, !dimmed);

        if (mode === 'quick') {
            this._quickBtn.class.add('active');
            this._fineBtn.class.remove('active');
            this._params = { ...QUICK_DEFAULTS };
        } else {
            this._quickBtn.class.remove('active');
            this._fineBtn.class.add('active');
            this._params = { ...FINE_DEFAULTS };
        }

        // Sync slider values
        this._opacitySlider.value = this._params.opacityThreshold * 100;
        this._volumeSlider.value = this._params.volumeStdThreshold * 10;
        this._isolationRadiusSlider.value = this._params.neighborRadius * 1000;
        this._isolationMinSlider.value = this._params.minNeighbors;
        this._distanceSlider.value = this._params.distanceThreshold * 100;

        this._scheduleDetect();
    }

    // ================================================================
    //  Detection (debounced)
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

        const strategies = this._mode === 'quick' ? QUICK_STRATEGIES : FINE_STRATEGIES;

        try {
            const result = detectFloaters(splat, strategies, this._params);
            this._resultLabel.text = `${result.count}`;
        } catch (e) {
            this._resultLabel.text = '!';
        }
    }

    // ================================================================
    //  Apply removal
    // ================================================================
    private _applyRemoval() {
        const splat = this._fltEvents.invoke('selection');
        if (!splat) return;

        const strategies = this._mode === 'quick' ? QUICK_STRATEGIES : FINE_STRATEGIES;
        const result = detectFloaters(splat, strategies, this._params);

        if (result.count === 0) return;

        // Fire event to apply deletion (editor.ts handles the edit operation)
        this._fltEvents.fire('floater.apply', { mask: result.mask, count: result.count });
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
}

export { FloaterPanel };
