import { BooleanInput, Button, Container, ContainerArgs, Label, SliderInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { i18n } from './localization';

const STEP_DEFAULT = 15;   // default arrow button step
const STEP_COARSE = 1;     // drag without CTRL
const STEP_FINE = 0.05;    // drag with CTRL
const DRAG_PX_PER_STEP = 3; // pixels per coarse step during drag

/**
 * Camera/Director panel — placed below the Transform panel in the left sidebar.
 * Provides camera mode toggle, heading/pitch axis controls with dragging,
 * inertia/auto-rotate toggles, and a reset button.
 */
class CameraPanel extends Container {
    private _camEvents: Events;
    private _contentContainer: Container;
    private _collapsed = true;
    private _collapseArrow: Label;
    private _orbitBtn: Button;
    private _flyBtn: Button;
    private _inertiaToggle: BooleanInput;
    private _rotateOrbitBtn: Button;
    private _rotateOffBtn: Button;
    private _rotateLookBtn: Button;
    private _pathControlToggle: BooleanInput;
    private _fovSlider: SliderInput;
    private _speedConstantBtn: Button;
    private _speedVariableBtn: Button;
    private _playSpeedSlider: SliderInput;
    private _playSpeedLabel: Label;
    private _playSpeedRow: Container;
    private _rotateSpeedSlider: SliderInput;
    private _rotateSpeedRow: Container;
    private _rotateSpeedLabel: Label;

    // Axis value labels
    private _headingValue: Label;
    private _pitchValue: Label;

    // Drag state for numeric value adjustment
    private _dragAxis: 'heading' | 'pitch' | null = null;
    private _dragStartX = 0;
    private _dragAccum = 0;

    // On-screen overlay
    private _overlayEl: HTMLElement | null = null;
    private _overlayTimeout: ReturnType<typeof setTimeout> | null = null;
    private _overlayThrottleMs = 50;  // throttle DOM updates
    private _overlayLastUpdate = 0;
    private _overlayPending = false;
    private _pendingHeading = 0;
    private _pendingPitch = 0;
    private _panelDragging = false;   // true while user drags a value in the panel

    constructor(events: Events, args: ContainerArgs = {}) {
        args = {
            ...args,
            id: 'camera-panel'
        };
        super(args);

        this._camEvents = events;

        // ---- collapsible header ----
        const cameraHeader = new Container({
            class: 'panel-header'
        });
        cameraHeader.dom.style.cursor = 'pointer';

        this._collapseArrow = new Label({
            class: 'camera-panel-collapse-arrow',
            text: '\u25B6'   // ▶  right-pointing triangle (collapsed)
        });

        const cameraIcon = new Label({
            text: '\uE252',
            class: 'panel-header-icon'
        });

        const cameraLabel = new Label({
            class: 'panel-header-label'
        });
        i18n.bindText(cameraLabel, 'panel.camera');

        cameraHeader.append(this._collapseArrow);
        cameraHeader.append(cameraIcon);
        cameraHeader.append(cameraLabel);


        cameraHeader.dom.addEventListener('click', () => {
            this._toggleCollapse();
        });

        // ---- content (collapsible) ----
        this._contentContainer = new Container({
            class: 'camera-panel-content'
        });

        // ---- Group 1: camera controls ----
        // -- row: camera mode --
        this._buildModeRow();
        // -- row: heading axis --
        this._buildAxisRow('heading');
        // -- row: pitch axis --
        this._buildAxisRow('pitch');
        // -- row: focal length (FOV) slider --
        this._buildFovSliderRow();
        // -- row: inertia toggle --
        this._buildToggleRow(
            'panel.camera.inertia',
            false,
            (v) => events.fire('camera.inertia', v),
            (toggle) => { this._inertiaToggle = toggle; }
        );

        // ---- divider between groups ----
        const divider = new Container({ class: 'camera-panel-divider' });
        this._contentContainer.append(divider);

        // ---- Group 2: path & motion ----
        // -- row: path control toggle --
        this._buildToggleRow(
            'panel.camera.pathControl',
            false,
            (v) => events.invoke('camera.setPathControlEnabled', v),
            (toggle) => { this._pathControlToggle = toggle; }
        );
        // -- row: camera speed mode --
        this._buildSpeedModeRow();
        // -- row: play speed slider (constant mode) --
        this._playSpeedRow = this._buildPlaySpeedRow();
        // -- row: auto rotate mode selector (环绕 / 关闭 / 环视) --
        this._buildRotateModeRow();
        // -- row: rotate speed slider --
        this._rotateSpeedRow = this._buildRotateSpeedRow();
        // -- row: reset camera --
        this._buildResetRow();

        // ---- assemble ----
        this.append(cameraHeader);
        this.append(this._contentContainer);

        // ---- event listeners for external state changes ----
        this._bindEvents();

        // ---- set up overlay on canvas-container ----
        this._setupOverlay();
    }

    // ================================================================
    //  Mode row
    // ================================================================
    private _buildModeRow() {
        const modeRow = new Container({ class: 'camera-panel-row' });

        const modeLabel = new Label({ class: 'camera-panel-label' });
        i18n.bindText(modeLabel, 'panel.camera.mode');

        const modeButtons = new Container({ class: 'camera-panel-mode-buttons' });

        this._orbitBtn = new Button({ class: ['camera-panel-mode-btn', 'active'] });
        i18n.bindText(this._orbitBtn, 'panel.camera.mode.orbit');
        this._orbitBtn.on('click', () => this._camEvents.fire('camera.setControlMode', 'orbit'));

        this._flyBtn = new Button({ class: 'camera-panel-mode-btn' });
        i18n.bindText(this._flyBtn, 'panel.camera.mode.fly');
        this._flyBtn.on('click', () => this._camEvents.fire('camera.setControlMode', 'fly'));

        modeButtons.append(this._orbitBtn);
        modeButtons.append(this._flyBtn);
        modeRow.append(modeLabel);
        modeRow.append(modeButtons);
        this._contentContainer.append(modeRow);
    }

    // ================================================================
    //  Rotate mode row — 3-button selector: 环绕 / 关闭 / 环视
    // ================================================================
    private _buildRotateModeRow() {
        const row = new Container({ class: 'camera-panel-row' });

        const label = new Label({ class: 'camera-panel-label' });
        i18n.bindText(label, 'panel.camera.autoRotate');

        const btnGroup = new Container({ class: 'camera-panel-mode-buttons' });

        this._rotateOrbitBtn = new Button({ class: 'camera-panel-mode-btn' });
        i18n.bindText(this._rotateOrbitBtn, 'panel.camera.rotateMode.orbit');
        this._rotateOrbitBtn.on('click', () => this._camEvents.fire('camera.setAutoRotateMode', 'orbit'));

        this._rotateOffBtn = new Button({ class: ['camera-panel-mode-btn', 'active'] });
        i18n.bindText(this._rotateOffBtn, 'panel.camera.rotateMode.off');
        this._rotateOffBtn.on('click', () => this._camEvents.fire('camera.setAutoRotateMode', 'off'));

        this._rotateLookBtn = new Button({ class: 'camera-panel-mode-btn' });
        i18n.bindText(this._rotateLookBtn, 'panel.camera.rotateMode.look');
        this._rotateLookBtn.on('click', () => this._camEvents.fire('camera.setAutoRotateMode', 'look'));

        btnGroup.append(this._rotateOrbitBtn);
        btnGroup.append(this._rotateOffBtn);
        btnGroup.append(this._rotateLookBtn);
        row.append(label);
        row.append(btnGroup);
        this._contentContainer.append(row);
    }

    // ================================================================
    //  Axis row (heading / pitch) with ◀ [value] ▶ and drag support
    // ================================================================
    private _buildAxisRow(axis: 'heading' | 'pitch') {
        const row = new Container({ class: 'camera-panel-row' });

        const label = new Label({ class: 'camera-panel-label' });
        i18n.bindText(label, `panel.camera.axis.${axis}`);

        // decrement button ◀
        const decBtn = new Button({ class: 'camera-panel-axis-btn' });
        decBtn.dom.innerHTML = '&#9664;';  // ◀
        decBtn.on('click', () => {
            this._panelDragging = true;
            const dir = axis === 'heading' ? -1 : 1;
            this._fireAdjust(axis, STEP_DEFAULT * dir);
            // Show single-axis overlay
            const val = this._getCurrentValue(axis);
            this._showOverlay(axis, val);
            this._hideOverlayDelayed();
            setTimeout(() => { this._panelDragging = false; }, 100);
        });

        // value label (draggable)
        const valueLabel = new Label({ class: 'camera-panel-axis-value' });
        valueLabel.text = '0.00°';
        valueLabel.dom.style.cursor = 'ew-resize';
        valueLabel.dom.title = axis === 'heading'
            ? '拖拽调整航向角 (Ctrl=精确)'
            : '拖拽调整俯仰角 (Ctrl=精确)';

        // Make the value label draggable
        valueLabel.dom.addEventListener('pointerdown', (e: PointerEvent) => {
            e.preventDefault();
            e.stopPropagation();
            this._startDrag(axis, e);
        });

        // increment button ▶
        const incBtn = new Button({ class: 'camera-panel-axis-btn' });
        incBtn.dom.innerHTML = '&#9654;';  // ▶
        incBtn.on('click', () => {
            this._panelDragging = true;
            const dir = axis === 'heading' ? 1 : -1;
            this._fireAdjust(axis, STEP_DEFAULT * dir);
            // Show single-axis overlay
            const val = this._getCurrentValue(axis);
            this._showOverlay(axis, val);
            this._hideOverlayDelayed();
            setTimeout(() => { this._panelDragging = false; }, 100);
        });

        // store reference
        if (axis === 'heading') {
            this._headingValue = valueLabel;
        } else {
            this._pitchValue = valueLabel;
        }

        row.append(label);
        row.append(decBtn);
        row.append(valueLabel);
        row.append(incBtn);
        this._contentContainer.append(row);
    }

    // ================================================================
    //  FOV / focal length slider row
    // ================================================================
    private _buildFovSliderRow() {
        const row = new Container({ class: 'camera-panel-row' });

        const label = new Label({ class: 'camera-panel-label' });
        i18n.bindText(label, 'panel.camera.fov');

        this._fovSlider = new SliderInput({
            class: 'camera-panel-fov-slider',
            min: 10,
            max: 120,
            step: 1,
            value: 75   // default FOV
        });

        // fire event on slider change
        this._fovSlider.on('change', (value: number) => {
            this._camEvents.fire('camera.setFov', value);
        });

        row.append(label);
        row.append(this._fovSlider);
        this._contentContainer.append(row);
    }

    // ================================================================
    //  Speed mode row (constant / variable toggle)
    // ================================================================
    private _buildSpeedModeRow() {
        const row = new Container({ class: 'camera-panel-row' });

        const label = new Label({ class: 'camera-panel-label' });
        i18n.bindText(label, 'panel.camera.speedMode');

        const btnGroup = new Container({ class: 'camera-panel-mode-buttons' });

        this._speedConstantBtn = new Button({ class: ['camera-panel-mode-btn', 'active'] });
        i18n.bindText(this._speedConstantBtn, 'panel.camera.speedMode.constant');
        this._speedConstantBtn.on('click', () => {
            this._camEvents.fire('timeline.setSpeedMode', 'constant');
        });

        this._speedVariableBtn = new Button({ class: 'camera-panel-mode-btn' });
        i18n.bindText(this._speedVariableBtn, 'panel.camera.speedMode.variable');
        this._speedVariableBtn.on('click', () => {
            this._camEvents.fire('timeline.setSpeedMode', 'variable');
        });

        btnGroup.append(this._speedConstantBtn);
        btnGroup.append(this._speedVariableBtn);
        row.append(label);
        row.append(btnGroup);
        this._contentContainer.append(row);
    }

    // ================================================================
    //  Play speed slider row (only visible in constant mode)
    // ================================================================
    private _buildPlaySpeedRow(): Container {
        const row = new Container({ class: 'camera-panel-row' });

        const label = new Label({ class: 'camera-panel-label' });
        i18n.bindText(label, 'panel.camera.playSpeed');

        this._playSpeedSlider = new SliderInput({
            class: 'camera-panel-speed-slider',
            min: 0.1,
            max: 5,
            step: 0.1,
            value: 1
        });

        this._playSpeedSlider.on('change', (value: number) => {
            this._camEvents.fire('timeline.setPlaySpeed', value);
            this._playSpeedLabel.text = value.toFixed(1) + 'x';
        });

        this._playSpeedLabel = new Label({
            class: 'camera-panel-speed-value',
            text: '1.0x'
        });

        row.append(label);
        row.append(this._playSpeedSlider);
        row.append(this._playSpeedLabel);
        this._contentContainer.append(row);

        return row;
    }

    // ================================================================
    //  Rotate speed slider row (placed under auto-rotate toggle)
    // ================================================================
    private _buildRotateSpeedRow(): Container {
        const row = new Container({ class: 'camera-panel-row' });

        const label = new Label({ class: 'camera-panel-label' });
        i18n.bindText(label, 'panel.camera.rotateSpeed');

        this._rotateSpeedSlider = new SliderInput({
            class: 'camera-panel-speed-slider',
            min: 1,
            max: 60,
            step: 1,
            value: 15
        });

        this._rotateSpeedSlider.on('change', (value: number) => {
            this._camEvents.fire('camera.setAutoRotateSpeed', value);
            this._rotateSpeedLabel.text = value.toFixed(0) + '°/s';
        });

        this._rotateSpeedLabel = new Label({
            class: 'camera-panel-speed-value',
            text: '15°/s'
        });

        row.append(label);
        row.append(this._rotateSpeedSlider);
        row.append(this._rotateSpeedLabel);
        this._contentContainer.append(row);

        return row;
    }

    private _buildToggleRow(
        i18nKey: string,
        defaultValue: boolean,
        onChange: (value: boolean) => void,
        setRef: (toggle: BooleanInput) => void
    ) {
        const row = new Container({ class: 'camera-panel-toggle-row' });

        const label = new Label({ class: 'camera-panel-toggle-label' });
        i18n.bindText(label, i18nKey);

        const toggle = new BooleanInput({
            type: 'toggle',
            class: 'camera-panel-toggle',
            value: defaultValue
        });
        toggle.on('change', onChange);
        setRef(toggle);

        row.append(label);
        row.append(toggle);
        this._contentContainer.append(row);
    }

    // ================================================================
    //  Reset row
    // ================================================================
    private _buildResetRow() {
        const row = new Container({ class: 'camera-panel-row' });
        const btn = new Button({ class: 'camera-panel-reset-btn' });
        i18n.bindText(btn, 'panel.camera.reset');
        btn.on('click', () => this._camEvents.fire('camera.reset'));
        row.append(btn);
        this._contentContainer.append(row);

        // Start collapsed by default
        this._contentContainer.hidden = true;
    }

    // ================================================================
    //  Drag logic for numeric value
    // ================================================================
    private _startDrag(axis: 'heading' | 'pitch', event: PointerEvent) {
        this._dragAxis = axis;
        this._dragStartX = event.clientX;
        this._dragAccum = 0;
        this._panelDragging = true;  // suppress dual overlay during panel drag

        // Capture pointer for tracking outside the element
        const target = event.target as HTMLElement;
        target.setPointerCapture(event.pointerId);

        const onMove = (e: PointerEvent) => this._onDragMove(e);
        const onUp = (e: PointerEvent) => {
            target.removeEventListener('pointermove', onMove);
            target.removeEventListener('pointerup', onUp);
            target.releasePointerCapture(e.pointerId);
            this._endDrag();
            this._hideOverlayDelayed();
        };

        target.addEventListener('pointermove', onMove);
        target.addEventListener('pointerup', onUp);
    }

    private _onDragMove(event: PointerEvent) {
        if (!this._dragAxis) return;

        const dx = event.clientX - this._dragStartX;
        const ctrl = event.ctrlKey || event.metaKey;
        const step = ctrl ? STEP_FINE : STEP_COARSE;

        // Accumulate movement in pixel-based steps
        const totalSteps = dx / DRAG_PX_PER_STEP;
        const integerSteps = Math.round(totalSteps);
        const delta = (integerSteps - this._dragAccum) * step;

        if (Math.abs(delta) > 0.001) {
            // heading: positive dx → decrease azim (rotate view left)
            // pitch:   positive dx → decrease elev (tilt view down)
            const dir = this._dragAxis === 'heading' ? -1 : -1;
            this._fireAdjust(this._dragAxis, delta * dir);
            this._dragAccum = integerSteps;

            // Show overlay
            const currentVal = this._getCurrentValue(this._dragAxis);
            this._showOverlay(this._dragAxis, currentVal);
        }
    }

    private _endDrag() {
        this._dragAxis = null;
        this._dragAccum = 0;
        // Clear the drag flag after a brief delay so any trailing poseChanged
        // events (from the last adjust call) are suppressed as well
        setTimeout(() => { this._panelDragging = false; }, 100);
    }

    private _fireAdjust(axis: 'heading' | 'pitch', delta: number) {
        this._camEvents.fire(`camera.adjust${axis.charAt(0).toUpperCase() + axis.slice(1)}`, delta);
    }

    // ================================================================
    //  On-screen angle overlay (graduation display)
    // ================================================================
    private _setupOverlay() {
        // Create overlay after a short delay to ensure DOM is ready
        setTimeout(() => {
            const canvasContainer = document.getElementById('canvas-container');
            if (!canvasContainer) return;

            this._overlayEl = document.createElement('div');
            this._overlayEl.id = 'camera-angle-overlay';
            this._overlayEl.style.cssText = `
                position: absolute;
                bottom: 120px;
                left: 50%;
                transform: translateX(-50%);
                background: rgba(0,0,0,0.75);
                color: #fff;
                padding: 8px 16px;
                border-radius: 8px;
                font-family: monospace;
                font-size: 20px;
                font-weight: bold;
                pointer-events: none;
                opacity: 0;
                transition: opacity 0.15s ease;
                z-index: 100;
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 6px;
                min-width: 180px;
            `;
            canvasContainer.appendChild(this._overlayEl);
        }, 100);
    }

    private _showOverlay(axis: 'heading' | 'pitch', value: number) {
        if (!this._overlayEl) return;

        const axisLabel = axis === 'heading' ? '航向' : '俯仰';
        const valStr = value.toFixed(2);

        // Build graduation bar
        const gradBar = this._buildGraduationBar(axis, value);

        this._overlayEl.innerHTML = `
            <div style="font-size:12px;color:#aaa;margin-bottom:2px">${axisLabel}</div>
            <div style="font-size:28px;line-height:1">${valStr}°</div>
            ${gradBar}
        `;
        this._overlayEl.style.opacity = '1';
    }

    /**
     * Show both heading and pitch in the overlay — used for general camera
     * movement (mouse orbit, auto-rotate, inertia, preset views, etc.).
     * Throttled to avoid excessive DOM writes during continuous motion.
     */
    private _showDualOverlayThrottled(heading: number, pitch: number) {
        // Never show the dual overlay while the user is dragging a value
        // in the panel — the single-axis graduation bar has priority.
        if (this._panelDragging) return;

        this._pendingHeading = heading;
        this._pendingPitch = pitch;

        if (this._overlayPending) return;
        const now = performance.now();
        if (now - this._overlayLastUpdate < this._overlayThrottleMs) {
            this._overlayPending = true;
            requestAnimationFrame(() => {
                this._overlayPending = false;
                this._showDualOverlayNow(this._pendingHeading, this._pendingPitch);
            });
            return;
        }
        this._showDualOverlayNow(heading, pitch);
    }

    private _showDualOverlayNow(heading: number, pitch: number) {
        if (!this._overlayEl) return;
        this._overlayLastUpdate = performance.now();

        // Normalize heading
        const h = ((heading % 360) + 360) % 360;

        this._overlayEl.innerHTML = `
            <div style="display:flex;gap:20px;align-items:flex-start">
                <div style="text-align:center">
                    <div style="font-size:11px;color:#888;margin-bottom:2px">航向</div>
                    <div style="font-size:22px;line-height:1;color:#ff9500">${h.toFixed(1)}°</div>
                </div>
                <div style="width:1px;background:#444;align-self:stretch"></div>
                <div style="text-align:center">
                    <div style="font-size:11px;color:#888;margin-bottom:2px">俯仰</div>
                    <div style="font-size:22px;line-height:1;color:#ff9500">${pitch.toFixed(1)}°</div>
                </div>
            </div>
        `;
        this._overlayEl.style.opacity = '1';
    }

    private _buildGraduationBar(axis: 'heading' | 'pitch', value: number): string {
        const range = 30; // show ±15° around current value
        const ticks = 7;  // number of tick marks
        const start = value - range / 2;

        let html = '<div style="display:flex;align-items:flex-end;justify-content:space-between;width:100%;height:24px;position:relative;margin-top:2px">';

        for (let i = 0; i < ticks; i++) {
            const tickVal = start + (range / (ticks - 1)) * i;
            const isCenter = Math.abs(tickVal - value) < range / (ticks - 1) / 2;
            const height = isCenter ? 18 : (i % 2 === 0 ? 12 : 8);
            html += `
                <div style="display:flex;flex-direction:column;align-items:center;flex:1">
                    <div style="height:${height}px;width:${isCenter ? 2 : 1}px;background:${isCenter ? '#ff9500' : '#888'};border-radius:1px"></div>
                    <span style="font-size:9px;color:#888;margin-top:2px">${tickVal.toFixed(0)}°</span>
                </div>
            `;
        }
        html += '</div>';
        return html;
    }

    private _hideOverlayDelayed() {
        if (this._overlayTimeout) clearTimeout(this._overlayTimeout);
        this._overlayTimeout = setTimeout(() => {
            if (this._overlayEl) {
                this._overlayEl.style.opacity = '0';
            }
        }, 800);
    }

    // ================================================================
    //  Value display helpers
    // ================================================================
    private _getCurrentValue(axis: 'heading' | 'pitch'): number {
        const label = axis === 'heading' ? this._headingValue : this._pitchValue;
        return parseFloat(label.text.replace('°', '')) || 0;
    }

    private _setAxisValue(axis: 'heading' | 'pitch', value: number) {
        const label = axis === 'heading' ? this._headingValue : this._pitchValue;
        // Normalize heading to [0, 360)
        if (axis === 'heading') {
            value = ((value % 360) + 360) % 360;
        }
        label.text = value.toFixed(2) + '°';
    }

    // ================================================================
    //  Event bindings
    // ================================================================
    private _bindEvents() {
        const events = this._camEvents;

        // camera control mode
        events.on('camera.controlMode', (mode: 'orbit' | 'fly') => {
            if (mode === 'orbit') {
                this._orbitBtn.class.add('active');
                this._flyBtn.class.remove('active');
            } else {
                this._flyBtn.class.add('active');
                this._orbitBtn.class.remove('active');
            }
        });

        // auto-rotate state sync
        events.on('camera.autoRotateChanged', (mode: string) => {
            // Update 3-button mode selector active state
            this._rotateOrbitBtn.class.remove('active');
            this._rotateOffBtn.class.remove('active');
            this._rotateLookBtn.class.remove('active');
            if (mode === 'orbit') {
                this._rotateOrbitBtn.class.add('active');
            } else if (mode === 'look') {
                this._rotateLookBtn.class.add('active');
            } else {
                this._rotateOffBtn.class.add('active');
            }
            // Show/hide rotate speed slider (hidden only when 'off')
            if (this._rotateSpeedRow) {
                this._rotateSpeedRow.hidden = (mode === 'off');
            }
        });

        // speed mode sync
        events.on('timeline.speedMode', (mode: 'constant' | 'variable') => {
            if (mode === 'constant') {
                this._speedConstantBtn.class.add('active');
                this._speedVariableBtn.class.remove('active');
                this._playSpeedRow.hidden = false;
            } else {
                this._speedVariableBtn.class.add('active');
                this._speedConstantBtn.class.remove('active');
                this._playSpeedRow.hidden = true;
            }
        });

        // play speed sync
        events.on('timeline.playSpeed', (value: number) => {
            if (this._playSpeedSlider && Math.abs(this._playSpeedSlider.value - value) > 0.001) {
                this._playSpeedSlider.value = value;
            }
            if (this._playSpeedLabel) {
                this._playSpeedLabel.text = value.toFixed(1) + 'x';
            }
        });

        // inertia state sync
        events.on('camera.inertiaChanged', (active: boolean) => {
            if (this._inertiaToggle && this._inertiaToggle.value !== active) {
                this._inertiaToggle.value = active;
            }
        });

        // Sync axis values from camera (called when camera pose changes from outside)
        events.on('camera.poseChanged', (pose: { azim: number; elev: number }) => {
            this._setAxisValue('heading', pose.azim);
            this._setAxisValue('pitch', pose.elev);
            // Show overlay on any camera movement
            this._showDualOverlayThrottled(pose.azim, pose.elev);
            this._hideOverlayDelayed();
        });

        // Initial value sync — try to get from camera (delay to ensure
        // editor.ts has registered the handler functions)
        setTimeout(() => {
            const initialPose = events.invoke('camera.getAzimElev');
            if (initialPose) {
                this._setAxisValue('heading', initialPose.azim);
                this._setAxisValue('pitch', initialPose.elev);
            }

            const initialFov = events.invoke('camera.fov');
            if (initialFov !== undefined && this._fovSlider) {
                this._fovSlider.value = initialFov;
            }

            // Initial speed mode and play speed sync
            const initialSpeedMode = events.invoke('timeline.speedMode') as string;
            if (initialSpeedMode) {
                if (initialSpeedMode === 'constant') {
                    this._speedConstantBtn.class.add('active');
                    this._speedVariableBtn.class.remove('active');
                    this._playSpeedRow.hidden = false;
                } else {
                    this._speedVariableBtn.class.add('active');
                    this._speedConstantBtn.class.remove('active');
                    this._playSpeedRow.hidden = true;
                }
            }
            const initialPlaySpeed = events.invoke('timeline.playSpeed') as number;
            if (initialPlaySpeed !== undefined && this._playSpeedSlider) {
                this._playSpeedSlider.value = initialPlaySpeed;
                this._playSpeedLabel.text = initialPlaySpeed.toFixed(1) + 'x';
            }
        }, 0);
        events.on('camera.fov', (fov: number) => {
            if (this._fovSlider && this._fovSlider.value !== fov) {
                this._fovSlider.value = fov;
            }
        });
    }

    // ================================================================
    //  Collapse toggle
    // ================================================================
    private _toggleCollapse() {
        this._collapsed = !this._collapsed;
        if (this._collapsed) {
            this._contentContainer.hidden = true;
            this._collapseArrow.text = '\u25B6';   // ▶  collapsed
        } else {
            this._contentContainer.hidden = false;
            this._collapseArrow.text = '\u25BC';   // ▼  expanded
        }
    }
}

export { CameraPanel };
