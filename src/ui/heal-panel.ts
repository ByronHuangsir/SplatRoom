import { Container, Label, SliderInput } from '@playcanvas/pcui';
import { Events } from '../events';
import { HealStrategy, HealParams, getSelectedIndices } from '../heal-inpaint';
import { i18n } from './localization';

class HealPanel extends Container {
    private _fltEvents: Events;
    private _contentContainer: Container;

    // Strategy buttons (raw HTML)
    private _originalBtn: HTMLButtonElement;
    private _poissonBtn: HTMLButtonElement;
    private _knnBtn: HTMLButtonElement;
    private _applyBtn: HTMLButtonElement;

    // Strategy-specific parameter groups
    private _originalParams: Container;
    private _poissonParams: Container;
    private _knnParams: Container;

    // Result display
    private _previewLabel: Label;

    // Current state
    private _strategy: HealStrategy = HealStrategy.Original;
    private _params: HealParams;
    private _depthThreshold: number = 0.15;

    constructor(events: Events, args = {}) {
        super({ ...args, class: 'heal-panel', hidden: true });
        this._fltEvents = events;

        this._params = {
            strategy: HealStrategy.Original,
            sampleRadius: 0.05,
            jitter: 0.15,
            knnK: 8,
            poissonDensity: 0.02
        };

        // CRITICAL: Stop pointer events from reaching tools-container (sibling)
        this.dom.addEventListener('pointerdown', (e) => e.stopPropagation());
        this.dom.addEventListener('mousedown', (e) => e.stopPropagation());

        // -- Header --
        const header = new Label({
            text: i18n.t('heal.title'),
            class: 'heal-panel-header'
        });
        this.append(header);

        this._contentContainer = new Container({ class: 'heal-panel-content' });
        this.append(this._contentContainer);

        // -- Strategy selection --
        const strategyLabel = new Label({
            text: i18n.t('heal.strategy'),
            class: 'heal-panel-label'
        });
        this._contentContainer.append(strategyLabel);

        // Strategy button row (raw HTML)
        const strategyRow = document.createElement('div');
        strategyRow.className = 'heal-panel-strategy-row';
        this._contentContainer.dom.appendChild(strategyRow);

        this._originalBtn = this._createStrategyBtn(i18n.t('heal.strategy.original'), 'heal-strategy-btn');
        this._poissonBtn = this._createStrategyBtn(i18n.t('heal.strategy.poisson'), 'heal-strategy-btn');
        this._knnBtn = this._createStrategyBtn(i18n.t('heal.strategy.knn'), 'heal-strategy-btn');
        strategyRow.appendChild(this._originalBtn);
        strategyRow.appendChild(this._poissonBtn);
        strategyRow.appendChild(this._knnBtn);

        // -- Depth thickness slider (common to all strategies) --
        this._contentContainer.append(this._makeSliderRow(
            'heal.depth',
            this._depthThreshold, 0.01, 10.0, 0.01,
            (v) => { this._depthThreshold = v; }
        ));

        // -- Strategy-specific parameter groups --
        // Original strategy: sample radius + jitter
        this._originalParams = new Container({ class: 'heal-param-group' });
        this._originalParams.append(this._makeSliderRow(
            'heal.sampleRadius',
            this._params.sampleRadius, 0.005, 0.5, 0.005,
            (v) => { this._params.sampleRadius = v; this._updatePreview(); }
        ));
        this._originalParams.append(this._makeSliderRow(
            'heal.jitter',
            this._params.jitter, 0, 1, 0.05,
            (v) => { this._params.jitter = v; }
        ));
        this._contentContainer.append(this._originalParams);

        // Poisson strategy: sample radius + poisson density
        this._poissonParams = new Container({ class: 'heal-param-group' });
        this._poissonParams.append(this._makeSliderRow(
            'heal.sampleRadius',
            this._params.sampleRadius, 0.005, 0.5, 0.005,
            (v) => { this._params.sampleRadius = v; this._updatePreview(); }
        ));
        this._poissonParams.append(this._makeSliderRow(
            'heal.poissonDensity',
            this._params.poissonDensity, 0.005, 0.2, 0.005,
            (v) => { this._params.poissonDensity = v; this._updatePreview(); }
        ));
        this._contentContainer.append(this._poissonParams);

        // KNN strategy: sample radius + knnK + jitter
        this._knnParams = new Container({ class: 'heal-param-group' });
        this._knnParams.append(this._makeSliderRow(
            'heal.sampleRadius',
            this._params.sampleRadius, 0.005, 0.5, 0.005,
            (v) => { this._params.sampleRadius = v; this._updatePreview(); }
        ));
        this._knnParams.append(this._makeSliderRow(
            'heal.knnK',
            this._params.knnK, 1, 30, 1,
            (v) => { this._params.knnK = Math.round(v); this._updatePreview(); }
        ));
        this._knnParams.append(this._makeSliderRow(
            'heal.jitter',
            this._params.jitter, 0, 1, 0.05,
            (v) => { this._params.jitter = v; }
        ));
        this._contentContainer.append(this._knnParams);

        // -- Preview label --
        const previewRow = new Container({ class: 'heal-panel-preview-row' });
        this._contentContainer.append(previewRow);

        const previewLabel = new Label({
            text: i18n.t('heal.preview'),
            class: 'heal-panel-label'
        });
        previewRow.append(previewLabel);

        this._previewLabel = new Label({
            text: '--',
            class: 'heal-panel-preview-count'
        });
        previewRow.append(this._previewLabel);

        // -- Apply button (raw HTML) --
        this._applyBtn = document.createElement('button');
        this._applyBtn.className = 'heal-panel-apply-btn';
        this._applyBtn.textContent = i18n.t('heal.apply');
        this._applyBtn.type = 'button';
        this._contentContainer.dom.appendChild(this._applyBtn);

        // -- Event handlers (direct DOM events) --
        this._originalBtn.addEventListener('click', () => {
            this._setStrategy(HealStrategy.Original);
        });
        this._poissonBtn.addEventListener('click', () => {
            this._setStrategy(HealStrategy.Poisson);
        });
        this._knnBtn.addEventListener('click', () => {
            this._setStrategy(HealStrategy.KNN);
        });

        this._applyBtn.addEventListener('click', () => {
            this._fltEvents.fire('heal.apply', { ...this._params });
        });

        // Show/hide panel on tool activation
        events.on('heal.activated', () => {
            this.hidden = false;
            this._updatePreview();
        });
        events.on('heal.deactivated', () => {
            this.hidden = true;
        });

        // Provide depth threshold to editor
        events.function('heal.depthThreshold', () => this._depthThreshold);

        // Update preview when selection changes
        events.on('selection.changed', () => {
            if (!this.hidden) {
                this._updatePreview();
            }
        });
        events.on('splat.stateChanged', () => {
            if (!this.hidden) {
                this._updatePreview();
            }
        });

        // Initial strategy UI update
        this._updateStrategyUI();
    }

    private _createStrategyBtn(text: string, className: string): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.className = className;
        btn.textContent = text;
        btn.type = 'button';
        return btn;
    }

    private _setStrategy(strategy: HealStrategy) {
        this._strategy = strategy;
        this._params.strategy = strategy;
        this._updateStrategyUI();
        this._updatePreview();
    }

    private _updateStrategyUI() {
        // Update button highlight
        this._originalBtn.classList.remove('active');
        this._poissonBtn.classList.remove('active');
        this._knnBtn.classList.remove('active');

        if (this._strategy === HealStrategy.Original) {
            this._originalBtn.classList.add('active');
        } else if (this._strategy === HealStrategy.Poisson) {
            this._poissonBtn.classList.add('active');
        } else if (this._strategy === HealStrategy.KNN) {
            this._knnBtn.classList.add('active');
        }

        // Show/hide strategy-specific parameter groups
        this._originalParams.dom.style.display = (this._strategy === HealStrategy.Original) ? '' : 'none';
        this._poissonParams.dom.style.display = (this._strategy === HealStrategy.Poisson) ? '' : 'none';
        this._knnParams.dom.style.display = (this._strategy === HealStrategy.KNN) ? '' : 'none';
    }

    private _makeSliderRow(
        labelText: string,
        value: number,
        min: number,
        max: number,
        step: number,
        onChange: (v: number) => void
    ): Container {
        const row = new Container({ class: 'heal-panel-slider-row' });

        const label = new Label({
            text: i18n.t(labelText),
            class: 'heal-panel-slider-label'
        });
        row.append(label);

        // Compute decimal precision from step size
        const precision = step < 1 ? Math.ceil(-Math.log10(step)) : 0;

        const slider = new SliderInput({
            value,
            min,
            max,
            precision,
            step,
            class: 'heal-panel-slider'
        });
        row.append(slider);

        slider.on('change', (v: number) => onChange(v));

        return row;
    }

    private _updatePreview() {
        const splat = this._fltEvents.invoke('selection');
        if (!splat) {
            this._previewLabel.text = '--';
            return;
        }

        const selectedIndices = getSelectedIndices(splat);
        if (selectedIndices.length === 0) {
            this._previewLabel.text = '--';
            return;
        }

        // Estimate generated count based on strategy
        let estimatedCount: number;
        if (this._strategy === HealStrategy.Original) {
            estimatedCount = selectedIndices.length;
        } else if (this._strategy === HealStrategy.Poisson) {
            estimatedCount = Math.round(selectedIndices.length * 1.5);
        } else {
            estimatedCount = selectedIndices.length;
        }

        this._previewLabel.text = `${selectedIndices.length} → ${estimatedCount}`;
    }
}

export { HealPanel };
