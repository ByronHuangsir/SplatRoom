import { Button, BooleanInput, Container, Label, SliderInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { i18n } from './localization';
import type { Tooltips } from './tooltips';
import type { SurfaceRefineResult } from '../geometry/surface-refiner';

/**
 * Surface Refinement panel — appears when the surface-refine toolbar button
 * is clicked.
 *
 * One-click workflow (SplatRoom 2.0): flatten protruding blobs + density-fill
 * holes (budget-controlled split) + remove outside scatter (interior
 * protected). Only three simple controls are exposed; all advanced tuning is
 * built in with sensible defaults.
 */
class SurfacePanel extends Container {
    private _surfEvents: Events;
    private _strength = 0.6;
    private _densify = true;
    private _removeScatter = true;
    private _resultLabel: Label;

    constructor(events: Events, _tooltips: Tooltips) {
        super({ id: 'surface-panel', class: 'panel' });

        // stop pointer events bubbling
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        this._surfEvents = events;
        this.hidden = true;

        // ---- Header ----
        const header = new Container({ class: 'surface-panel-header' });
        const title = new Label({
            class: 'surface-panel-title',
            text: i18n.t('panel.surface-refine.title')
        });
        header.append(title);
        this.append(header);

        // ---- Strength slider ----
        const strengthRow = new Container({ class: 'surface-panel-row' });
        const strengthLabel = new Label({
            class: 'surface-panel-label',
            text: i18n.t('panel.surface-refine.strength')
        });
        const strengthSlider = new SliderInput({
            min: 0,
            max: 1,
            value: 0.6,
            step: 0.01,
            precision: 2
        });
        strengthRow.append(strengthLabel);
        strengthRow.append(strengthSlider);
        this.append(strengthRow);

        strengthSlider.on('change', (val: number) => {
            this._strength = val;
        });

        // ---- Density fill (split) toggle ----
        const densifyRow = new Container({ class: 'surface-panel-row' });
        const densifyLabel = new Label({
            class: 'surface-panel-label',
            text: i18n.t('panel.surface-refine.densify')
        });
        const densifyToggle = new BooleanInput({
            type: 'toggle',
            value: true
        });
        densifyRow.append(densifyLabel);
        densifyRow.append(densifyToggle);
        this.append(densifyRow);

        densifyToggle.on('change', (val: boolean) => {
            this._densify = val;
        });

        // ---- Outside scatter cleanup toggle ----
        const cleanupRow = new Container({ class: 'surface-panel-row' });
        const cleanupLabel = new Label({
            class: 'surface-panel-label',
            text: i18n.t('panel.surface-refine.cleanup')
        });
        const cleanupToggle = new BooleanInput({
            type: 'toggle',
            value: true
        });
        cleanupRow.append(cleanupLabel);
        cleanupRow.append(cleanupToggle);
        this.append(cleanupRow);

        cleanupToggle.on('change', (val: boolean) => {
            this._removeScatter = val;
        });

        // ---- Result label ----
        this._resultLabel = new Label({
            class: 'surface-panel-result',
            text: ''
        });
        this.append(this._resultLabel);

        // ---- Apply button ----
        const applyBtn = new Button({
            class: 'surface-panel-btn',
            text: i18n.t('panel.surface-refine.apply')
        });
        this.append(applyBtn);

        applyBtn.on('click', () => {
            this._surfEvents.fire('surfaceRefine.apply', {
                strength: this._strength,
                edgeSplit: this._densify,
                removeScatter: this._removeScatter
            });
        });

        // ---- Panel visibility ----
        events.on('surfaceRefine.toggleVisible', () => {
            this.hidden = !this.hidden;
            events.fire('surfaceRefinePanel.visible', !this.hidden);
            if (!this.hidden) {
                events.fire('tool.deactivate');
                events.fire('colorPanel.setVisible', false);
                events.fire('settingsPanel.setVisible', false);
            }
        });

        events.on('surfaceRefinePanel.setVisible', (visible: boolean) => {
            if (visible !== this.hidden) return;
            this.hidden = !visible;
            events.fire('surfaceRefinePanel.visible', visible);
            if (visible) {
                events.fire('tool.deactivate');
                events.fire('colorPanel.setVisible', false);
                events.fire('settingsPanel.setVisible', false);
            }
        });

        events.on('cropBoxPanel.visible', (visible: boolean) => {
            if (visible && !this.hidden) {
                this.hidden = true;
                events.fire('surfaceRefinePanel.visible', false);
            }
        });

        events.on('colorPanel.visible', (visible: boolean) => {
            if (visible && !this.hidden) {
                this.hidden = true;
                events.fire('surfaceRefinePanel.visible', false);
            }
        });

        events.on('settingsPanel.visible', (visible: boolean) => {
            if (visible && !this.hidden) {
                this.hidden = true;
                events.fire('surfaceRefinePanel.visible', false);
            }
        });

        // Show result when refine completes
        events.on('surfaceRefine.result', (result: SurfaceRefineResult) => {
            this.showResult(result);
        });
    }

    /** Show result summary after refinement completes. */
    showResult(result: SurfaceRefineResult) {
        this._resultLabel.text = i18n.t('panel.surface-refine.result-summary')
        .replace('{flattened}', String(result.flattened))
        .replace('{split}', String(result.splitAdded))
        .replace('{removed}', String(result.removed));
    }

    /** Clear the result text. */
    clearResult() {
        this._resultLabel.text = '';
    }
}

export { SurfacePanel };
