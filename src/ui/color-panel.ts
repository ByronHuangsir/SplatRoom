import { Button, Container, Label, SliderInput } from '@playcanvas/pcui';
import { Color } from 'playcanvas';

import { Events } from '../events';
import { i18n } from './localization';
import { Tooltips } from './tooltips';
import { SetSplatColorAdjustmentOp } from '../edit-ops';
import type { ColorAdjustment } from '../edit-ops';
import { Splat } from '../splat';

// pcui slider doesn't include start and end events
class MyFancySliderInput extends SliderInput {
    _onSlideStart(pageX: number) {
        super._onSlideStart(pageX);
        this.emit('slide:start');
    }

    _onSlideEnd(pageX: number) {
        super._onSlideEnd(pageX);
        this.emit('slide:end');
    }
}

class ColorPanel extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'color-panel',
            class: 'panel',
            hidden: true
        };

        super(args);

        // stop pointer events bubbling
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        // ---- State ----

        let suppress = false;
        let selected: Splat = null;
        let op: SetSplatColorAdjustmentOp = null;

        // ---- State helpers (defined early for use in section callbacks) ----

        const buildState = (tgt: Splat): ColorAdjustment => ({
            tintClr: tgt.tintClr.clone(),
            temperature: tgt.temperature,
            saturation: tgt.saturation,
            brightness: tgt.brightness,
            contrast: tgt.contrast,
            highlights: tgt.highlights,
            shadows: tgt.shadows,
            whitePoint: tgt.whitePoint,
            blackPoint: tgt.blackPoint,
            transparency: tgt.transparency,
            colorGradeEnabled: tgt.colorGradeEnabled,
            hslHue: Array.from(tgt.hslHue),
            hslSat: Array.from(tgt.hslSat),
            hslLum: Array.from(tgt.hslLum)
        });

        const resetSingleParam = (newState: Partial<ColorAdjustment>) => {
            if (!selected) return;
            const oldState = buildState(selected);
            const merged = { ...oldState, ...newState };
            const splatOp = new SetSplatColorAdjustmentOp({
                splat: selected, oldState, newState: merged
            });
            events.fire('edit.add', splatOp);
        };

        // ---- Header ----

        const header = new Container({
            class: 'panel-header'
        });

        const icon = new Label({
            class: 'panel-header-icon',
            text: '\uE146'
        });

        const label = new Label({
            class: 'panel-header-label'
        });
        i18n.bindText(label, 'panel.colors');

        header.append(icon);
        header.append(label);

        // ---- Controls ----

        // helper to create a slider row
        const makeSliderRow = (labelKey: string, min: number, max: number, step: number, defaultValue: number): [Container, MyFancySliderInput] => {
            const row = new Container({ class: 'color-panel-row' });
            const lbl = new Label({ class: 'color-panel-row-label' });
            i18n.bindText(lbl, labelKey);
            const slider = new MyFancySliderInput({
                class: 'color-panel-row-slider',
                min, max, step,
                value: defaultValue
            });
            row.append(lbl);
            row.append(slider);
            return [row, slider];
        };

        // helper to create a category section with header + optional reset button
        const makeCategorySection = (labelKey: string, extraElement?: Container, resetAction?: () => void): { section: Container, content: Container } => {
            const section = new Container({ class: 'color-panel-category' });
            const catHeader = new Container({ class: 'color-panel-category-header' });
            const lbl = new Label({ class: 'color-panel-category-label' });
            i18n.bindText(lbl, labelKey);
            catHeader.append(lbl);
            if (extraElement) {
                catHeader.append(extraElement);
            }
            if (resetAction) {
                const resetBtn = new Container({ class: 'category-reset-btn' });
                resetBtn.dom.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';
                resetBtn.on('click', resetAction);
                catHeader.append(resetBtn);
            }
            section.append(catHeader);
            const content = new Container({ class: 'color-panel-category-content' });
            section.append(content);
            return { section, content };
        };

        // ---- Eyedropper button (SVG icon) ----

        const eyedropper = new Container({
            class: 'eyedropper-btn'
        });
        eyedropper.dom.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/></svg>';

        // ---- Slider definitions ----

        // White Balance: temperature, tint
        const [temperatureRow, temperatureSlider] = makeSliderRow('panel.colors.temperature', -0.5, 0.5, 0.005, 0);
        const [tintRow, tintSlider] = makeSliderRow('panel.colors.tint', -0.5, 0.5, 0.005, 0);
        // Tone: brightness, contrast, highlights, shadows, whitePoint, blackPoint
        const [brightnessRow, brightnessSlider] = makeSliderRow('panel.colors.brightness', -0.5, 0.5, 0.01, 0);
        const [contrastRow, contrastSlider] = makeSliderRow('panel.colors.contrast', -1, 1, 0.01, 0);
        const [highlightsRow, highlightsSlider] = makeSliderRow('panel.colors.highlights', -1, 1, 0.01, 0);
        const [shadowsRow, shadowsSlider] = makeSliderRow('panel.colors.shadows', -1, 1, 0.01, 0);
        // White point: slider reversed — slider right = brighter white, slider left = darker white
        // Internal splat.whitePoint = 2 - sliderValue
        const [whitePointRow, whitePointSlider] = makeSliderRow('panel.colors.white-point', 0, 2, 0.01, 1);
        // Black point: slider reversed — slider right = lighter black, slider left = darker black
        // Internal splat.blackPoint = -sliderValue
        const [blackPointRow, blackPointSlider] = makeSliderRow('panel.colors.black-point', -1, 1, 0.01, 0);
        const [saturationRow, saturationSlider] = makeSliderRow('panel.colors.saturation', 0, 2, 0.1, 1);
        // Blend: transparency
        const [transparencyRow, transparencySlider] = makeSliderRow('panel.colors.transparency', -6, 6, 0.01, 0);

        // ---- Category sections ----

        const { section: wbSection, content: wbContent } = makeCategorySection('panel.colors.category.white-balance', eyedropper, () => {
            resetSingleParam({ tintClr: new Color(1, 1, 1), temperature: 0 });
        });
        wbContent.append(temperatureRow);
        wbContent.append(tintRow);

        const { section: toneSection, content: toneContent } = makeCategorySection('panel.colors.category.tone', undefined, () => {
            resetSingleParam({ brightness: 0, contrast: 0, highlights: 0, shadows: 0, whitePoint: 1, blackPoint: 0 });
        });
        toneContent.append(brightnessRow);
        toneContent.append(contrastRow);
        toneContent.append(highlightsRow);
        toneContent.append(shadowsRow);
        toneContent.append(whitePointRow);
        toneContent.append(blackPointRow);

        const { section: blendSection, content: blendContent } = makeCategorySection('panel.colors.category.blend', undefined, () => {
            resetSingleParam({ transparency: 1 });
        });
        blendContent.append(transparencyRow);

        // ---- HSL Color Section (Lightroom-style) ----

        const { section: colorSection, content: colorContent } = makeCategorySection('panel.colors.category.color', undefined, () => {
            resetSingleParam({ saturation: 1, hslHue: [0, 0, 0, 0, 0, 0, 0, 0], hslSat: [0, 0, 0, 0, 0, 0, 0, 0], hslLum: [0, 0, 0, 0, 0, 0, 0, 0] });
        });
        colorContent.append(saturationRow);

        // Tab bar: 色相 / 饱和度 / 明度
        const hslTabBar = new Container({ class: 'hsl-tab-bar' });
        const hslTabHue = new Label({ class: 'hsl-tab' });
        hslTabHue.class.add('active');
        i18n.bindText(hslTabHue, 'panel.colors.hsl.hue');
        const hslTabSat = new Label({ class: 'hsl-tab' });
        i18n.bindText(hslTabSat, 'panel.colors.hsl.saturation');
        const hslTabLum = new Label({ class: 'hsl-tab' });
        i18n.bindText(hslTabLum, 'panel.colors.hsl.luminance');
        hslTabBar.append(hslTabHue);
        hslTabBar.append(hslTabSat);
        hslTabBar.append(hslTabLum);
        colorContent.append(hslTabBar);

        // 8 color zone definitions
        const hslColorNames = [
            'panel.colors.hsl.red', 'panel.colors.hsl.orange', 'panel.colors.hsl.yellow',
            'panel.colors.hsl.green', 'panel.colors.hsl.aqua', 'panel.colors.hsl.blue',
            'panel.colors.hsl.purple', 'panel.colors.hsl.magenta'
        ];
        const hslColorDots = ['#ff0000', '#ff8000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#8000ff', '#ff00ff'];

        // Create 3 containers for each tab (only one visible at a time)
        const hslHueRows = new Container({ class: 'hsl-tab-content' });
        const hslSatRows = new Container({ class: 'hsl-tab-content' });
        hslSatRows.class.add('hidden');
        const hslLumRows = new Container({ class: 'hsl-tab-content' });
        hslLumRows.class.add('hidden');

        // Create 8 sliders per tab
        const hslHueSliders: MyFancySliderInput[] = [];
        const hslSatSliders: MyFancySliderInput[] = [];
        const hslLumSliders: MyFancySliderInput[] = [];

        for (let i = 0; i < 8; i++) {
            // Hue slider row
            const hueRow = new Container({ class: 'color-panel-row' });
            hueRow.class.add('hsl-row');
            const hueDot = new Label({ class: 'hsl-color-dot' });
            hueDot.dom.style.backgroundColor = hslColorDots[i];
            const hueLbl = new Label({ class: 'color-panel-row-label' });
            i18n.bindText(hueLbl, hslColorNames[i]);
            const hueSlider = new MyFancySliderInput({
                class: 'color-panel-row-slider', min: -1, max: 1, step: 0.01, value: 0
            });
            hueRow.append(hueDot);
            hueRow.append(hueLbl);
            hueRow.append(hueSlider);
            hslHueRows.append(hueRow);
            hslHueSliders.push(hueSlider);

            // Saturation slider row
            const satRow = new Container({ class: 'color-panel-row' });
            satRow.class.add('hsl-row');
            const satDot = new Label({ class: 'hsl-color-dot' });
            satDot.dom.style.backgroundColor = hslColorDots[i];
            const satLbl = new Label({ class: 'color-panel-row-label' });
            i18n.bindText(satLbl, hslColorNames[i]);
            const satSlider = new MyFancySliderInput({
                class: 'color-panel-row-slider', min: -1, max: 1, step: 0.01, value: 0
            });
            satRow.append(satDot);
            satRow.append(satLbl);
            satRow.append(satSlider);
            hslSatRows.append(satRow);
            hslSatSliders.push(satSlider);

            // Luminance slider row
            const lumRow = new Container({ class: 'color-panel-row' });
            lumRow.class.add('hsl-row');
            const lumDot = new Label({ class: 'hsl-color-dot' });
            lumDot.dom.style.backgroundColor = hslColorDots[i];
            const lumLbl = new Label({ class: 'color-panel-row-label' });
            i18n.bindText(lumLbl, hslColorNames[i]);
            const lumSlider = new MyFancySliderInput({
                class: 'color-panel-row-slider', min: -1, max: 1, step: 0.01, value: 0
            });
            lumRow.append(lumDot);
            lumRow.append(lumLbl);
            lumRow.append(lumSlider);
            hslLumRows.append(lumRow);
            hslLumSliders.push(lumSlider);
        }

        colorContent.append(hslHueRows);
        colorContent.append(hslSatRows);
        colorContent.append(hslLumRows);

        // Tab switching
        const switchTab = (active: number) => {
            hslTabHue.class.remove('active');
            hslTabSat.class.remove('active');
            hslTabLum.class.remove('active');
            hslHueRows.class.remove('hidden');
            hslSatRows.class.remove('hidden');
            hslLumRows.class.remove('hidden');
            if (active === 0) {
                hslTabHue.class.add('active');
                hslSatRows.class.add('hidden');
                hslLumRows.class.add('hidden');
            } else if (active === 1) {
                hslTabSat.class.add('active');
                hslHueRows.class.add('hidden');
                hslLumRows.class.add('hidden');
            } else {
                hslTabLum.class.add('active');
                hslHueRows.class.add('hidden');
                hslSatRows.class.add('hidden');
            }
        };
        hslTabHue.on('click', () => switchTab(0));
        hslTabSat.on('click', () => switchTab(1));
        hslTabLum.on('click', () => switchTab(2));

        this.append(wbSection);
        this.append(toneSection);
        this.append(blendSection);
        this.append(colorSection);

        // ---- Control Row ----

        const controlRow = new Container({
            class: 'color-panel-control-row'
        });

        const gradeToggleLabel = new Label({
            class: 'color-grade-toggle-label'
        });
        i18n.bindText(gradeToggleLabel, 'panel.colors.toggle');

        const gradeToggle = new Container({
            class: 'color-grade-toggle'
        });
        const gradeToggleKnob = new Label({
            class: 'color-grade-toggle-knob'
        });
        gradeToggle.append(gradeToggleKnob);

        const reset = new Label({
            class: 'panel-header-button',
            text: '\uE304'
        });

        controlRow.append(gradeToggleLabel);
        controlRow.append(gradeToggle);
        controlRow.append(new Label({ class: 'panel-header-spacer' }));
        controlRow.append(reset);
        controlRow.append(new Label({ class: 'panel-header-spacer' }));

        this.append(controlRow);

        // ==========================================
        //  EVENT HANDLERS
        // ==========================================

        const updateUIFromState = (tgt: Splat) => {
            if (suppress) return;
            suppress = true;
            // Tint: derive green-magenta slider from tintClr (tintClr.r = 1 + 0.5*slider, tintClr.g = 1 - 0.5*slider, tintClr.b = 1 + 0.5*slider)
            // slider = (r - g), clamped to [-0.5, 0.5]
            if (tgt) {
                const raw = tgt.tintClr.r - tgt.tintClr.g;
                tintSlider.value = Math.max(-0.5, Math.min(0.5, raw));
            } else {
                tintSlider.value = 0;
            }
            temperatureSlider.value = tgt ? tgt.temperature : 0;
            saturationSlider.value = tgt ? tgt.saturation : 1;
            brightnessSlider.value = tgt ? tgt.brightness : 0;
            contrastSlider.value = tgt ? tgt.contrast : 0;
            highlightsSlider.value = tgt ? tgt.highlights : 0;
            shadowsSlider.value = tgt ? tgt.shadows : 0;
            // Reversed: slider shows 2 - internal value (right = brighter)
            whitePointSlider.value = tgt ? (2 - tgt.whitePoint) : 1;
            // Reversed: slider shows -internal value (right = lighter)
            blackPointSlider.value = tgt ? (-tgt.blackPoint) : 0;
            transparencySlider.value = tgt ? Math.log(tgt.transparency) : 0;

            // HSL sliders
            if (tgt) {
                for (let i = 0; i < 8; i++) {
                    hslHueSliders[i].value = tgt.hslHue[i];
                    hslSatSliders[i].value = tgt.hslSat[i];
                    hslLumSliders[i].value = tgt.hslLum[i];
                }
            } else {
                for (let i = 0; i < 8; i++) {
                    hslHueSliders[i].value = 0;
                    hslSatSliders[i].value = 0;
                    hslLumSliders[i].value = 0;
                }
            }

            // Update grade toggle visual state
            const gradeEnabled = tgt ? tgt.colorGradeEnabled : true;
            if (gradeEnabled) {
                gradeToggle.class.add('on');
                this.class.remove('color-grade-off');
            } else {
                gradeToggle.class.remove('on');
                this.class.add('color-grade-off');
            }

            suppress = false;
        };

        // buildState and resetSingleParam defined above (after state declarations)

        const start = () => {
            if (!selected) return;
            op = new SetSplatColorAdjustmentOp({
                splat: selected,
                oldState: buildState(selected),
                newState: buildState(selected)
            });
        };

        const end = () => {
            if (!op) return;
            op.newState = buildState(selected);
            events.fire('edit.add', op);
            op = null;
        };

        const updateOp = (setFunc: (op: SetSplatColorAdjustmentOp) => void) => {
            if (!suppress) {
                suppress = true;
                if (op) {
                    setFunc(op);
                    op.do();
                } else if (selected) {
                    start();
                    setFunc(op);
                    op.do();
                    end();
                }
                suppress = false;
            }
        };

        // Attach slide start/end events to all sliders
        const allSliders = [
            tintSlider,
            temperatureSlider, saturationSlider,
            brightnessSlider, contrastSlider,
            highlightsSlider, shadowsSlider,
            whitePointSlider, blackPointSlider, transparencySlider,
            ...hslHueSliders, ...hslSatSliders, ...hslLumSliders
        ];

        allSliders.forEach((slider) => {
            slider.on('slide:start', start);
            slider.on('slide:end', end);
        });

        // Tint slider — green-magenta shift via tintClr:
        // slider +0.5 = magenta  (tintClr = 1.25, 0.75, 1.25)
        // slider  0.0 = neutral  (tintClr = 1, 1, 1)
        // slider -0.5 = green    (tintClr = 0.75, 1.25, 0.75)
        tintSlider.on('change', (value: number) => {
            updateOp((op) => {
                op.newState.tintClr = new Color(1 + 0.5 * value, 1 - 0.5 * value, 1 + 0.5 * value);
            });
        });

        // Temperature
        temperatureSlider.on('change', (value: number) => {
            updateOp((op) => { op.newState.temperature = value; });
        });

        // Saturation
        saturationSlider.on('change', (value: number) => {
            updateOp((op) => { op.newState.saturation = value; });
        });

        // Brightness
        brightnessSlider.on('change', (value: number) => {
            updateOp((op) => { op.newState.brightness = value; });
        });

        // Contrast
        contrastSlider.on('change', (value: number) => {
            updateOp((op) => { op.newState.contrast = value; });
        });

        // Highlights
        highlightsSlider.on('change', (value: number) => {
            updateOp((op) => { op.newState.highlights = value; });
        });

        // Shadows
        shadowsSlider.on('change', (value: number) => {
            updateOp((op) => { op.newState.shadows = value; });
        });

        // White Point — reversed: slider right = brighter white
        // Internal splat.whitePoint = 2 - sliderValue
        // Constraint: effective white > effective black → (2 - ws) > -bs → ws < 2 + bs
        whitePointSlider.on('change', (value: number) => {
            updateOp((op) => { op.newState.whitePoint = 2 - value; });
            if (value >= 2 + blackPointSlider.value) {
                blackPointSlider.value = value - 2;
            }
        });

        // Black Point — reversed: slider right = lighter black
        // Internal splat.blackPoint = -sliderValue
        // Constraint: effective white > effective black → (2 - ws) > -bs → bs > ws - 2
        blackPointSlider.on('change', (value: number) => {
            updateOp((op) => { op.newState.blackPoint = -value; });
            if (value <= whitePointSlider.value - 2) {
                whitePointSlider.value = value + 2;
            }
        });

        // Transparency
        transparencySlider.on('change', (value: number) => {
            updateOp((op) => { op.newState.transparency = Math.exp(value); });
        });

        // HSL Hue sliders
        hslHueSliders.forEach((slider, i) => {
            slider.on('change', (value: number) => {
                updateOp((op) => {
                    const arr = [...(op.newState.hslHue ?? buildState(selected).hslHue)];
                    arr[i] = value;
                    op.newState.hslHue = arr;
                });
            });
        });

        // HSL Saturation sliders
        hslSatSliders.forEach((slider, i) => {
            slider.on('change', (value: number) => {
                updateOp((op) => {
                    const arr = [...(op.newState.hslSat ?? buildState(selected).hslSat)];
                    arr[i] = value;
                    op.newState.hslSat = arr;
                });
            });
        });

        // HSL Luminance sliders
        hslLumSliders.forEach((slider, i) => {
            slider.on('change', (value: number) => {
                updateOp((op) => {
                    const arr = [...(op.newState.hslLum ?? buildState(selected).hslLum)];
                    arr[i] = value;
                    op.newState.hslLum = arr;
                });
            });
        });

        // Reset button
        reset.on('click', () => {
            if (selected) {
                const neutral = {
                    tintClr: new Color(1, 1, 1),
                    temperature: 0,
                    saturation: 1,
                    brightness: 0,
                    contrast: 0,
                    highlights: 0,
                    shadows: 0,
                    whitePoint: 1,
                    blackPoint: 0,
                    transparency: 1,
                    hslHue: [0, 0, 0, 0, 0, 0, 0, 0],
                    hslSat: [0, 0, 0, 0, 0, 0, 0, 0],
                    hslLum: [0, 0, 0, 0, 0, 0, 0, 0]
                };
                const oldState = buildState(selected);
                const resetOp = new SetSplatColorAdjustmentOp({
                    splat: selected, oldState, newState: neutral
                });
                events.fire('edit.add', resetOp);
            }
        });

        // Color grade toggle (A/B comparison)
        gradeToggle.on('click', () => {
            if (selected) {
                const oldState = buildState(selected);
                const newState: any = { ...oldState, colorGradeEnabled: !selected.colorGradeEnabled };
                const gradeOp = new SetSplatColorAdjustmentOp({
                    splat: selected, oldState, newState
                });
                events.fire('edit.add', gradeOp);
            }
        });

        // Double-click to reset individual sliders (resetSingleParam defined above)

        tintSlider.dom.addEventListener('dblclick', () => resetSingleParam({ tintClr: new Color(1, 1, 1) }));
        temperatureSlider.dom.addEventListener('dblclick', () => resetSingleParam({ temperature: 0 }));
        saturationSlider.dom.addEventListener('dblclick', () => resetSingleParam({ saturation: 1 }));
        brightnessSlider.dom.addEventListener('dblclick', () => resetSingleParam({ brightness: 0 }));
        contrastSlider.dom.addEventListener('dblclick', () => resetSingleParam({ contrast: 0 }));
        highlightsSlider.dom.addEventListener('dblclick', () => resetSingleParam({ highlights: 0 }));
        shadowsSlider.dom.addEventListener('dblclick', () => resetSingleParam({ shadows: 0 }));
        whitePointSlider.dom.addEventListener('dblclick', () => resetSingleParam({ whitePoint: 1 }));
        blackPointSlider.dom.addEventListener('dblclick', () => resetSingleParam({ blackPoint: 0 }));
        transparencySlider.dom.addEventListener('dblclick', () => resetSingleParam({ transparency: 1 }));

        // HSL slider double-click reset
        hslHueSliders.forEach((slider, i) => {
            slider.dom.addEventListener('dblclick', () => {
                const arr = [...Array.from(selected.hslHue)];
                arr[i] = 0;
                resetSingleParam({ hslHue: arr });
            });
        });
        hslSatSliders.forEach((slider, i) => {
            slider.dom.addEventListener('dblclick', () => {
                const arr = [...Array.from(selected.hslSat)];
                arr[i] = 0;
                resetSingleParam({ hslSat: arr });
            });
        });
        hslLumSliders.forEach((slider, i) => {
            slider.dom.addEventListener('dblclick', () => {
                const arr = [...Array.from(selected.hslLum)];
                arr[i] = 0;
                resetSingleParam({ hslLum: arr });
            });
        });

        // Selection change
        events.on('selection.changed', (splat: Splat) => {
            selected = splat ?? null;
            updateUIFromState(selected);
        });

        // Listen for all splat property changes
        events.on('splat.tintClr', updateUIFromState);
        events.on('splat.temperature', updateUIFromState);
        events.on('splat.saturation', updateUIFromState);
        events.on('splat.brightness', updateUIFromState);
        events.on('splat.contrast', updateUIFromState);
        events.on('splat.blackPoint', updateUIFromState);
        events.on('splat.whitePoint', updateUIFromState);
        events.on('splat.transparency', updateUIFromState);
        events.on('splat.highlights', updateUIFromState);
        events.on('splat.shadows', updateUIFromState);
        events.on('splat.colorGradeEnabled', updateUIFromState);
        events.on('splat.hslHue', updateUIFromState);
        events.on('splat.hslSat', updateUIFromState);
        events.on('splat.hslLum', updateUIFromState);

        // Tooltip for reset
        tooltips.register(reset, () => i18n.t('panel.colors.reset'), 'bottom');

        // Tooltip for grade toggle
        tooltips.register(gradeToggle, () => i18n.t('panel.colors.toggle'), 'bottom');

        // Tooltip for eyedropper
        tooltips.register(eyedropper, () => i18n.t('panel.colors.eyedropper'), 'bottom');

        // ---- Eyedropper (white balance pick) ----
        let pickMode = false;
        let canvasListenerAttached = false;

        // Custom eyedropper cursor (SVG data URI, hotspot at tip ~2,22)
        const eyedropperCursorSVG = '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/><circle cx="2" cy="22" r="1" fill="white" stroke="none"/></svg>';
        const eyedropperCursor = `data:image/svg+xml,${encodeURIComponent(eyedropperCursorSVG)}`;

        // Pick mode hint overlay
        const pickHint = document.createElement('div');
        pickHint.style.cssText = 'position:fixed;bottom:60px;left:50%;transform:translateX(-50%);background:rgba(40,40,40,0.92);color:#e0e0e0;padding:8px 20px;border-radius:20px;font-size:13px;pointer-events:none;z-index:10000;opacity:0;transition:opacity 0.2s ease;white-space:nowrap;box-shadow:0 2px 12px rgba(0,0,0,0.4);backdrop-filter:blur(6px);';
        document.body.appendChild(pickHint);

        const ensureCanvasListener = () => {
            if (canvasListenerAttached) return;
            const canvas = document.querySelector('canvas');
            if (!canvas) return;
            canvasListenerAttached = true;
            canvas.addEventListener('pointerdown', (e: PointerEvent) => {
                if (!pickMode) return;
                e.stopPropagation();
                e.preventDefault();
                const rect = canvas.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                events.fire('pickColor.request', x, y);
            }, true);
        };

        const enterPickMode = () => {
            pickMode = true;
            eyedropper.class.add('active');
            ensureCanvasListener();
            const canvas = document.querySelector('canvas');
            if (canvas) canvas.style.cursor = `url("${eyedropperCursor}") 2 22, crosshair`;
            // Show hint
            pickHint.textContent = i18n.t('panel.colors.pick-hint');
            pickHint.style.opacity = '1';
        };

        const exitPickMode = () => {
            pickMode = false;
            eyedropper.class.remove('active');
            const canvas = document.querySelector('canvas');
            if (canvas) canvas.style.cursor = '';
            pickHint.style.opacity = '0';
        };

        eyedropper.on('click', () => {
            if (pickMode) {
                exitPickMode();
            } else {
                enterPickMode();
            }
        });

        // Exit pick mode on Escape
        document.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Escape' && pickMode) {
                exitPickMode();
            }
        });

        // Receive picked color → apply white balance
        events.on('pickColor.result', (color: { r: number, g: number, b: number }) => {
            exitPickMode();
            if (!selected) return;

            const { r, g, b } = color;
            const avg = (r + g + b) / 3;
            if (avg < 0.02 || avg > 0.98) return; // skip too dark/bright

            // White balance: correct temperature + tint to make picked pixel neutral
            // Temperature: if r > b (too warm) → decrease; if b > r (too cool) → increase
            const tempAdjust = Math.max(-0.5, Math.min(0.5, (b - r) / Math.max(avg, 0.01) * 0.5));
            // Tint: if g > (r+b)/2 (too green) → positive (magenta); if g < (r+b)/2 → negative (green)
            const tintAdjust = Math.max(-0.5, Math.min(0.5, (g - (r + b) / 2) / Math.max(avg, 0.01) * 0.5));

            const oldState = buildState(selected);
            const newTemp = Math.max(-0.5, Math.min(0.5, selected.temperature + tempAdjust));
            const oldTintRaw = selected.tintClr.r - selected.tintClr.g;
            const newTintRaw = Math.max(-0.5, Math.min(0.5, oldTintRaw + tintAdjust));
            const newState = {
                ...oldState,
                temperature: newTemp,
                tintClr: new Color(1 + 0.5 * newTintRaw, 1 - 0.5 * newTintRaw, 1 + 0.5 * newTintRaw)
            };
            const eyedropOp = new SetSplatColorAdjustmentOp({
                splat: selected, oldState, newState
            });
            events.fire('edit.add', eyedropOp);
        });

        // ---- Panel Visibility ----

        // In group mode, color grading is not supported — hide the panel.
        // The user must ungroup first before adjusting colors (per design spec).
        let groupBlocked = false;
        let wasVisibleBeforeGroup = false;

        const setVisible = (visible: boolean) => {
            if (groupBlocked && visible) return; // reject show when group is active
            if (visible === this.hidden) {
                this.hidden = !visible;
                events.fire('colorPanel.visible', visible);
            }
        };

        events.function('colorPanel.visible', () => {
            return !this.hidden;
        });

        events.on('colorPanel.setVisible', (visible: boolean) => {
            setVisible(visible);
        });

        events.on('colorPanel.toggleVisible', () => {
            setVisible(this.hidden);
        });

        events.on('settingsPanel.visible', (visible: boolean) => {
            if (visible) {
                setVisible(false);
            }
        });

        // When a group is created, hide the color panel (grading not
        // supported in group mode). When all groups are removed, restore.
        events.on('group.created', () => {
            if (!groupBlocked) {
                groupBlocked = true;
                wasVisibleBeforeGroup = !this.hidden;
                setVisible(false); // force-hide if currently open
            }
        });

        events.on('group.removed', () => {
            // Only unblock when the GroupRenderer is no longer active
            const hasGroup = events.invoke('groupRenderer.isActive') as boolean;
            if (!hasGroup) {
                groupBlocked = false;
                // Auto-restore panel if it was visible before group was created
                if (wasVisibleBeforeGroup && this.hidden) {
                    wasVisibleBeforeGroup = false;
                    setVisible(true);
                }
            }
        });
    }
}

export { ColorPanel };
