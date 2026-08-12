import { BooleanInput, Container, Label, SliderInput } from '@playcanvas/pcui';
import { Events } from '../events';
import { PlanarFixParams } from '../geometry/planar-fix';
import { i18n } from './localization';

interface DetectCounts {
    floating: number;
    uneven: number;
    holes: number;
    candidates: number;
}

type GizmoMode = 'translate' | 'rotate' | 'scale';

/**
 * Planar Fix panel — right-docked (same position as Surface Panel).
 *
 * Three-step flow (box paradigm):
 *
 *   STEP 1 — Place & Fit
 *     Move / Rotate / Scale the box so its GREEN base face lies on the surface
 *     to iron, then "确认贴合最近平面" snaps it to the closest best-fit plane.
 *
 *   STEP 2 — Slab range
 *     Move the RED limit face (or drag the thickness slider) to set the slab
 *     thickness, then "确认范围并检测" reports floaters / uneven / holes.
 *
 *   STEP 3 — Auto flatten
 *     Set flatten strength, fill density, color tolerance and transparency,
 *     then "自动熨平" projects the detected abnormal splats onto the plane.
 */
class PlanarFixPanel extends Container {
    private _fltEvents: Events;
    private _params: PlanarFixParams;

    private _hintLabel: Label;
    private _statusLabel: Label;
    private _legendLabel: Label;

    private _modeBtns: Record<GizmoMode, HTMLButtonElement> = {} as Record<GizmoMode, HTMLButtonElement>;
    private _fitBtn: HTMLButtonElement;
    private _thicknessSlider: SliderInput;
    private _detectBtn: HTMLButtonElement;
    private _detectLabel: Label;
    private _applyBtn: HTMLButtonElement;

    // suppress slider->event feedback when syncing from the box
    private _suppressThickness = false;
    private _hasSession = false;

    constructor(events: Events, args = {}) {
        super({ id: 'planarfix-panel', class: 'panel', ...args });
        this._fltEvents = events;

        // stop pointer events bubbling to canvas (same as SurfacePanel)
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((name) => {
            this.dom.addEventListener(name, (e: Event) => e.stopPropagation());
        });

        this.hidden = true;

        this._params = {
            flattenStrength: 1.0,
            fillDensity: 1.0,
            removeFloaters: false,
            colorTolerance: 0.25,
            transparency: 0.05
        };

        // ---- Header ----
        const header = new Container({ class: 'planarfix-panel-header' });
        const title = new Label({ text: i18n.t('planarfix.title'), class: 'planarfix-panel-title' });
        i18n.onChange(() => { title.text = i18n.t('planarfix.title'); }, title);
        header.append(title);
        this.append(header);

        // ---- contextual hint ----
        this._hintLabel = new Label({ text: '', class: 'planarfix-hint' });
        this.append(this._hintLabel);

        // ============ STEP 1 ============
        this.append(this._section('planarfix.step1'));
        const modeGroup = this._modeGroup();
        this.append(modeGroup);
        this._fitBtn = this._button('planarfix.confirmFit', 'planarfix-panel-btn', () => {
            this._fltEvents.fire('planarfix.fit');
        });
        this.append(this._fitBtn);

        // ============ STEP 2 ============
        this.append(this._section('planarfix.step2'));
        this._thicknessSlider = this._makeSliderRow(
            'planarfix.thickness', 0.1, 0.01, 3.0, 0.01,
            (v) => {
                if (this._suppressThickness) return;
                this._fltEvents.fire('planarfix.setThickness', v);
            }
        );
        this.append(this._thicknessSlider.parent as Container);
        const thicknessHint = new Label({ text: i18n.t('planarfix.thicknessHint'), class: 'planarfix-hint' });
        i18n.onChange(() => { thicknessHint.text = i18n.t('planarfix.thicknessHint'); }, thicknessHint);
        this.append(thicknessHint);

        this._detectBtn = this._button('planarfix.confirmRange', 'planarfix-panel-btn', () => {
            this._fltEvents.fire('planarfix.detect', { ...this._params });
        });
        this.append(this._detectBtn);

        this._detectLabel = new Label({ text: '--', class: 'planarfix-panel-count' });
        this.append(this._detectLabel);

        // ============ STEP 3 ============
        this.append(this._section('planarfix.step3'));
        this.append(this._makeSliderRow('planarfix.flattenStrength', this._params.flattenStrength, 0, 1, 0.01,
            (v) => { this._params.flattenStrength = v; }).parent as Container);
        this.append(this._makeSliderRow('planarfix.fillDensity', this._params.fillDensity, 0.5, 2.0, 0.1,
            (v) => { this._params.fillDensity = v; }).parent as Container);
        this.append(this._makeSliderRow('planarfix.colorTolerance', this._params.colorTolerance, 0, 1, 0.01,
            (v) => { this._params.colorTolerance = v; }).parent as Container);
        this.append(this._makeSliderRow('planarfix.transparency', this._params.transparency, 0, 1, 0.01,
            (v) => { this._params.transparency = v; }).parent as Container);

        // remove floaters checkbox
        const chkRow = new Container({ class: 'planarfix-panel-row' });
        const chkLabel = new Label({ text: i18n.t('planarfix.removeFloaters'), class: 'planarfix-panel-label' });
        i18n.onChange(() => { chkLabel.text = i18n.t('planarfix.removeFloaters'); }, chkLabel);
        const chk = new BooleanInput({ type: 'toggle', value: false });
        chkRow.append(chkLabel);
        chkRow.append(chk);
        this.append(chkRow);
        chk.on('change', (val: boolean) => { this._params.removeFloaters = val; });

        this._applyBtn = this._button('planarfix.apply', 'planarfix-panel-btn planarfix-panel-apply-btn', () => {
            this._fltEvents.fire('planarfix.apply', { ...this._params });
        });
        this.append(this._applyBtn);

        // ---- status + legend ----
        this._statusLabel = new Label({ text: '', class: 'planarfix-status' });
        this.append(this._statusLabel);
        this._legendLabel = new Label({ text: i18n.t('planarfix.legend'), class: 'planarfix-legend' });
        i18n.onChange(() => { this._legendLabel.text = i18n.t('planarfix.legend'); }, this._legendLabel);
        this.append(this._legendLabel);

        // ---- Event wiring ----
        events.on('planarfix.activated', (name: string | null) => {
            this.hidden = false;
            events.fire('planarfixPanel.visible', true);
            if (name) {
                this._setHint(i18n.t('planarfix.fitHint'));
                this._setStatus('');
            } else {
                this._setHint(i18n.t('planarfix.noSelection'));
                this._setStatus('');
                this._enableActions(false);
            }
        });
        events.on('planarfix.deactivated', () => {
            this.hidden = true;
            events.fire('planarfixPanel.visible', false);
            this._resetState();
        });
        events.on('planarfix.modeChanged', (mode: GizmoMode) => {
            for (const m of ['translate', 'rotate', 'scale'] as GizmoMode[]) {
                this._modeBtns[m].classList.toggle('active', m === mode);
            }
        });
        events.on('planarfix.sessionChanged', (session: { thickness: number }) => {
            this._hasSession = true;
            this._enableActions(true);
            this._syncThickness(session.thickness);
        });
        events.on('planarfix.fitted', () => {
            this._setStatus(i18n.t('planarfix.fitted'));
        });
        events.on('planarfix.thicknessChanged', (T: number) => {
            this._syncThickness(T);
        });
        events.on('planarfix.detected', (r: DetectCounts) => {
            this._detectLabel.text =
                `候选 ${r.candidates}   漂浮 ${r.floating}   不平整 ${r.uneven}   空洞 ${r.holes}`;
        });
        events.on('planarfix.applied', () => {
            this._setStatus(i18n.t('planarfix.applied'));
        });

        // Mutual exclusion with other panels (same as surface panel)
        events.on('surfaceRefinePanel.visible', (visible: boolean) => {
            if (visible && !this.hidden) this.hidden = true;
        });
        events.on('colorPanel.visible', (visible: boolean) => {
            if (visible && !this.hidden) this.hidden = true;
        });
        events.on('settingsPanel.visible', (visible: boolean) => {
            if (visible && !this.hidden) this.hidden = true;
        });
    }

    // ---- helpers ----------------------------------------------------------

    private _section(titleKey: string): Container {
        const c = new Container({ class: 'planarfix-step' });
        const t = new Label({ text: i18n.t(titleKey), class: 'planarfix-step-title' });
        i18n.onChange(() => { t.text = i18n.t(titleKey); }, t);
        c.append(t);
        return c;
    }

    private _modeGroup(): Container {
        const group = new Container({ class: 'planarfix-mode-group' });
        const modes: GizmoMode[] = ['translate', 'rotate', 'scale'];
        const keys: Record<GizmoMode, string> = {
            translate: 'planarfix.modeTranslate',
            rotate: 'planarfix.modeRotate',
            scale: 'planarfix.modeScale'
        };
        this._modeBtns = {} as Record<GizmoMode, HTMLButtonElement>;
        for (const m of modes) {
            const btn = document.createElement('button');
            btn.className = 'planarfix-mode-btn';
            btn.textContent = i18n.t(keys[m]);
            i18n.onChange(() => { btn.textContent = i18n.t(keys[m]); });
            btn.addEventListener('click', () => {
                this._fltEvents.fire('planarfix.setMode', m);
            });
            this._modeBtns[m] = btn;
            group.dom.appendChild(btn);
        }
        return group;
    }

    private _button(textKey: string, className: string, onClick: () => void): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.className = className;
        btn.textContent = i18n.t(textKey);
        i18n.onChange(() => { btn.textContent = i18n.t(textKey); });
        btn.disabled = true;
        btn.addEventListener('click', onClick);
        return btn;
    }

    private _makeSliderRow(
        labelText: string,
        value: number,
        min: number,
        max: number,
        step: number,
        onChange: (v: number) => void
    ): SliderInput {
        const row = new Container({ class: 'planarfix-panel-row' });
        const label = new Label({ text: i18n.t(labelText), class: 'planarfix-panel-label' });
        i18n.onChange(() => { label.text = i18n.t(labelText); }, label);
        const precision = step < 1 ? Math.ceil(-Math.log10(step)) : 0;
        const slider = new SliderInput({ value, min, max, precision, step });
        row.append(label);
        row.append(slider);
        slider.on('change', (v: number) => onChange(v));
        // stash row for callers that need the container
        (slider as any).parent = row;
        return slider;
    }

    private _syncThickness(T: number) {
        if (!this._thicknessSlider) return;
        if (Math.abs(this._thicknessSlider.value - T) < 1e-4) return;
        this._suppressThickness = true;
        this._thicknessSlider.value = T;
        this._suppressThickness = false;
    }

    private _enableActions(enabled: boolean) {
        this._hasSession = enabled;
        this._fitBtn.disabled = !enabled;
        this._thicknessSlider.enabled = enabled;
        this._detectBtn.disabled = !enabled;
        this._applyBtn.disabled = !enabled;
        for (const m of ['translate', 'rotate', 'scale'] as GizmoMode[]) {
            this._modeBtns[m].disabled = !enabled;
        }
    }

    private _setHint(text: string) {
        this._hintLabel.text = text;
    }

    private _setStatus(text: string) {
        this._statusLabel.text = text;
    }

    private _resetState() {
        this._detectLabel.text = '--';
        this._setHint('');
        this._setStatus('');
        this._enableActions(false);
        this._hasSession = false;
    }
}

export { PlanarFixPanel };
