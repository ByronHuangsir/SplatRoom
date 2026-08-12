import { Button, Container, Label, SliderInput, BooleanInput } from '@playcanvas/pcui';

import { Events } from '../events';
import type { Tooltips } from './tooltips';
import { i18n } from './localization';
import type { SurfaceRefineResult, SurfaceRefineLevel2Params } from '../geometry/surface-refiner';

/**
 * Surface Refinement panel — appears when the surface-refine toolbar
 * button is clicked.
 *
 * Contains:
 *   - Strength slider (0-1)
 *   - Edge split toggle
 *   - Normal smoothing toggle
 *   - Apply button
 *   - Result summary
 */
class SurfacePanel extends Container {
    private _surfEvents: Events;
    private _strength = 0.6;
    private _edgeSplit = true;
    private _smoothNormals = true;
    private _resultLabel: Label;

    // Level 2 params
    private _level2Params: SurfaceRefineLevel2Params;

    constructor(events: Events, _tooltips: Tooltips) {
        super({ id: 'surface-panel', class: 'panel' });

        // stop pointer events bubbling
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        this._surfEvents = events;
        this.hidden = true;

        // Level 2 defaults
        this._level2Params = {
            edgeRadiusScale: 0.5,
            radiusFraction: 0.01,    // 1% of bbox diagonal — adaptive to model scale
            scatterMinNeighbors: 2,
            opacityThreshold: 0.3,   // below this opacity = see-through
            removeScatter: true,
            edgeNbrFrac: 0.25
        };

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

        // ---- Edge split toggle ----
        const edgeRow = new Container({ class: 'surface-panel-row' });
        const edgeLabel = new Label({
            class: 'surface-panel-label',
            text: i18n.t('panel.surface-refine.edge-split')
        });
        const edgeToggle = new BooleanInput({
            type: 'toggle',
            value: true
        });
        edgeRow.append(edgeLabel);
        edgeRow.append(edgeToggle);
        this.append(edgeRow);

        edgeToggle.on('change', (val: boolean) => {
            this._edgeSplit = val;
        });

        // ---- Normal smoothing toggle ----
        const smoothRow = new Container({ class: 'surface-panel-row' });
        const smoothLabel = new Label({
            class: 'surface-panel-label',
            text: i18n.t('panel.surface-refine.smooth-normals')
        });
        const smoothToggle = new BooleanInput({
            type: 'toggle',
            value: true
        });
        smoothRow.append(smoothLabel);
        smoothRow.append(smoothToggle);
        this.append(smoothRow);

        smoothToggle.on('change', (val: boolean) => {
            this._smoothNormals = val;
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
                edgeSplit: this._edgeSplit,
                smoothNormals: this._smoothNormals
            });
        });

        // ============ 二级平整（UI 隐藏，功能保留）============
        // The whole Level-2 section lives in `l2Section` which is hidden via
        // CSS (.surface-panel-l2 { display: none }). All handlers/params stay
        // wired — the algorithm remains reachable through the
        // `surfaceRefine.level2` event if an entry point is re-added later.
        const l2Section = new Container({ class: 'surface-panel-l2' });
        const divider = document.createElement('hr');
        divider.className = 'surface-panel-divider';
        l2Section.dom.appendChild(divider);

        const l2Header = new Container({ class: 'surface-panel-section' });
        const l2Title = new Label({
            class: 'surface-panel-section-title',
            text: i18n.t('panel.surface-refine.level2')
        });
        l2Header.append(l2Title);
        l2Section.append(l2Header);

        // edge radius scale
        const edgeScaleRow = new Container({ class: 'surface-panel-row' });
        const edgeScaleLabel = new Label({
            class: 'surface-panel-label',
            text: i18n.t('panel.surface-refine.edgeRadiusScale')
        });
        const edgeScaleSlider = new SliderInput({
            min: 0.1, max: 1.0, value: 0.5, step: 0.05, precision: 2
        });
        edgeScaleRow.append(edgeScaleLabel);
        edgeScaleRow.append(edgeScaleSlider);
        l2Section.append(edgeScaleRow);
        edgeScaleSlider.on('change', (v: number) => { this._level2Params.edgeRadiusScale = v; });

        // search radius (fraction of bounding box diagonal — adaptive)
        const srRow = new Container({ class: 'surface-panel-row' });
        const srLabel = new Label({
            class: 'surface-panel-label',
            text: i18n.t('panel.surface-refine.radiusFraction')
        });
        const srSlider = new SliderInput({
            min: 0.002, max: 0.05, value: 0.01, step: 0.001, precision: 3
        });
        srRow.append(srLabel);
        srRow.append(srSlider);
        l2Section.append(srRow);
        srSlider.on('change', (v: number) => { this._level2Params.radiusFraction = v; });

        // scatter min neighbours
        const smRow = new Container({ class: 'surface-panel-row' });
        const smLabel = new Label({
            class: 'surface-panel-label',
            text: i18n.t('panel.surface-refine.scatterMinNeighbors')
        });
        const smSlider = new SliderInput({
            min: 1, max: 10, value: 2, step: 1, precision: 0
        });
        smRow.append(smLabel);
        smRow.append(smSlider);
        l2Section.append(smRow);
        smSlider.on('change', (v: number) => { this._level2Params.scatterMinNeighbors = v; });

        // opacity threshold
        const otRow = new Container({ class: 'surface-panel-row' });
        const otLabel = new Label({
            class: 'surface-panel-label',
            text: i18n.t('panel.surface-refine.opacityThreshold')
        });
        const otSlider = new SliderInput({
            min: 0.05, max: 0.8, value: 0.3, step: 0.05, precision: 2
        });
        otRow.append(otLabel);
        otRow.append(otSlider);
        l2Section.append(otRow);
        otSlider.on('change', (v: number) => { this._level2Params.opacityThreshold = v; });

        // edge neighbour fraction
        const enfRow = new Container({ class: 'surface-panel-row' });
        const enfLabel = new Label({
            class: 'surface-panel-label',
            text: i18n.t('panel.surface-refine.edgeNbrFrac')
        });
        const enfSlider = new SliderInput({
            min: 0.05, max: 0.5, value: 0.25, step: 0.05, precision: 2
        });
        enfRow.append(enfLabel);
        enfRow.append(enfSlider);
        l2Section.append(enfRow);
        enfSlider.on('change', (v: number) => { this._level2Params.edgeNbrFrac = v; });

        // scatter toggle
        const scRow = new Container({ class: 'surface-panel-row' });
        const scLabel = new Label({
            class: 'surface-panel-label',
            text: i18n.t('panel.surface-refine.removeScatter')
        });
        const scToggle = new BooleanInput({ type: 'toggle', value: true });
        scRow.append(scLabel);
        scRow.append(scToggle);
        l2Section.append(scRow);
        scToggle.on('change', (v: boolean) => { this._level2Params.removeScatter = v; });

        // Level 2 apply button
        const l2Btn = new Button({
            class: 'surface-panel-apply-btn',
            text: i18n.t('panel.surface-refine.applyLevel2')
        });
        l2Btn.dom.classList.add('surface-panel-btn');
        l2Section.append(l2Btn);
        l2Btn.on('click', () => {
            this._surfEvents.fire('surfaceRefine.level2', { ...this._level2Params });
        });

        this.append(l2Section);

        // ---- Panel visibility ----
        events.on('surfaceRefine.toggleVisible', () => {
            this.hidden = !this.hidden;
            events.fire('surfaceRefinePanel.visible', !this.hidden);
            // When surface refine opens, collapse the other tool panels
            // (crop tool is closed via tool.deactivate below)
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
                // Collapse the other tool panels when surface refine opens
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
            .replace('{surface}', String(result.surfaceCount))
            .replace('{edge}', String(result.outlierCount))
            .replace('{total}', String(result.splatsAffected));
    }

    /** Clear the result text. */
    clearResult() {
        this._resultLabel.text = '';
    }
}

export { SurfacePanel };
