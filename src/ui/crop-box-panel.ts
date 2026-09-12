import { BooleanInput, Button, Container, Label, NumericInput, SliderInput } from '@playcanvas/pcui';
import { Vec3 } from 'playcanvas';

import { Events } from '../events';
import { enableReliableInputDrag, hidePcuiSliderStrip } from './input-drag';
import { i18n } from './localization';
import { Tooltips } from './tooltips';
import { CropBox } from '../scene/crop-box';
import { ElementType } from '../scene/element';

// local-axis scratch vectors for face-coordinate math
const axisX = new Vec3();
const axisY = new Vec3();
const axisZ = new Vec3();
const center = new Vec3();
const eulerBuf = new Vec3();

// unit basis vectors for quaternion axis extraction (Quat has no getAxis* API)
const RIGHT = new Vec3(1, 0, 0);
const UP = new Vec3(0, 1, 0);
const FORWARD = new Vec3(0, 0, 1);

// axis chip palette — matches the +X/-X face handles' refined tones so the
// whole panel reads as one design system with the in-scene gizmos.
const AXIS_COLORS = ['#e65966', '#4dcc8c', '#6699f2']; // X red, Y green, Z blue

// Crop Box control panel (UltraSplat).
//
// Provides:
//  - Initialize Crop Box button (smart AABB from 95% core of the point cloud)
//  - Crop Box Visibility toggle (wireframe on/off)
//  - Enable Clipping toggle (fragment discard on/off)
//  - Six single-face offset inputs (local-axis-projected face coordinates)
//  - XYZ Euler rotation inputs (degrees) with axis chips & reset button
//
// The 6 face inputs show each face's signed coordinate along the box's local
// axis (i.e. the projected position of that face). Editing one face keeps the
// opposite face fixed in world space: the extent grows/shrinks and the center
// shifts along the box's local axis so only the edited face moves.
class CropBoxPanel extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'crop-box-panel',
            class: 'panel',
            hidden: true
        };

        super(args);

        // stop pointer events bubbling to the canvas
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        // ---- header ----
        const header = new Container({ class: 'panel-header' });
        const icon = new Label({ text: '\uE403', class: 'panel-header-icon' });
        const label = new Label({ class: 'panel-header-label' });
        i18n.bindText(label, 'panel.crop-box');
        header.append(icon);
        header.append(label);
        this.append(header);

        // ---- initialize button ----
        const initRow = new Container({ class: 'settings-panel-row' });
        const initButton = new Button({ class: 'settings-panel-row-button' });
        i18n.bindText(initButton, 'panel.crop-box.initialize');
        initRow.append(initButton);
        this.append(initRow);

        // ---- PCA auto-orient button ----
        const pcaRow = new Container({ class: 'settings-panel-row' });
        const pcaButton = new Button({ class: ['settings-panel-row-button', 'crop-box-pca-button'] });
        i18n.bindText(pcaButton, 'panel.crop-box.orient-to-pca');
        pcaRow.append(pcaButton);
        this.append(pcaRow);

        // ---- visibility toggle ----
        const visRow = new Container({ class: 'settings-panel-row' });
        const visLabel = new Label({ class: 'settings-panel-row-label' });
        i18n.bindText(visLabel, 'panel.crop-box.visibility');
        const visToggle = new BooleanInput({ type: 'toggle', class: 'settings-panel-row-toggle', value: true });
        visRow.append(visLabel);
        visRow.append(visToggle);
        this.append(visRow);

        // ---- clipping toggle ----
        const clipRow = new Container({ class: 'settings-panel-row' });
        const clipLabel = new Label({ class: 'settings-panel-row-label' });
        i18n.bindText(clipLabel, 'panel.crop-box.clipping');
        const clipToggle = new BooleanInput({ type: 'toggle', class: 'settings-panel-row-toggle', value: true });
        clipRow.append(clipLabel);
        clipRow.append(clipToggle);
        this.append(clipRow);

        // ---- preview toggle (show outside faintly instead of discarding) ----
        const previewRow = new Container({ class: 'settings-panel-row' });
        const previewLabel = new Label({ class: 'settings-panel-row-label' });
        i18n.bindText(previewLabel, 'panel.crop-box.preview');
        const previewToggle = new BooleanInput({ type: 'toggle', class: 'settings-panel-row-toggle', value: true });
        previewRow.append(previewLabel);
        previewRow.append(previewToggle);
        this.append(previewRow);

        // ---- soft edge slider (0 = laser sharp, 0.05 = soft) ----
        const softEdgeRow = new Container({ class: ['settings-panel-row', 'crop-box-soft-edge-row'] });
        const softEdgeLabel = new Label({ class: 'settings-panel-row-label' });
        i18n.bindText(softEdgeLabel, 'panel.crop-box.soft-edge');
        const softEdgeSlider = new SliderInput({
            class: 'crop-box-soft-edge-slider',
            min: 0,
            max: 0.05,
            step: 0.001,
            precision: 3,
            value: 0.005
        });
        softEdgeRow.append(softEdgeLabel);
        softEdgeRow.append(softEdgeSlider);
        this.append(softEdgeRow);

        // ---- clip shape: box / cylinder / sphere ----
        this.append(this.buildSectionHeader('panel.crop-box.section.shape'));

        const shapeRow = new Container({ class: 'crop-box-shape-row' });
        const shapeBtns = (['box', 'cylinder', 'sphere'] as const).map((s) => {
            // NOTE: never include an empty string in the class array — pcui
            // calls classList.add(token) and an empty token throws.
            const btn = new Button({ class: s === 'box' ? ['crop-box-shape-btn', 'active'] : 'crop-box-shape-btn' });
            i18n.bindText(btn, `panel.crop-box.shape.${s}`);
            shapeRow.append(btn);
            return { shape: s, btn };
        });
        this.append(shapeRow);

        // radius sliders (cylinder / sphere): R1 (X), R2 (Z) — unequal radii
        // give an elliptic cylinder / ellipsoid; R3 (Y) is sphere-only
        // (sphere Y radius) → triaxial ellipsoid. The uniform lock keeps all
        // radii equal.
        const radiusRow = new Container({ class: ['settings-panel-row', 'crop-box-radius-row'] });
        const radiusLabel = new Label({ class: 'settings-panel-row-label' });
        i18n.bindText(radiusLabel, 'panel.crop-box.radius');
        const radiusXSlider = new SliderInput({
            class: 'crop-box-radius-slider',
            min: 0.02,
            max: 0.5,
            step: 0.01,
            precision: 2,
            value: 0.35
        });
        radiusRow.append(radiusLabel);
        radiusRow.append(radiusXSlider);
        this.append(radiusRow);

        const radiusZRow = new Container({ class: ['settings-panel-row', 'crop-box-radius-row'] });
        const radiusZLabel = new Label({ class: 'settings-panel-row-label' });
        i18n.bindText(radiusZLabel, 'panel.crop-box.radius-z');
        const radiusZSlider = new SliderInput({
            class: 'crop-box-radius-slider',
            min: 0.02,
            max: 0.5,
            step: 0.01,
            precision: 2,
            value: 0.35
        });
        radiusZRow.append(radiusZLabel);
        radiusZRow.append(radiusZSlider);
        this.append(radiusZRow);

        // R3 (Y) slider — sphere only (sphere's Y radius)
        const radiusYRow = new Container({ class: ['settings-panel-row', 'crop-box-radius-row'] });
        const radiusYLabel = new Label({ class: 'settings-panel-row-label' });
        i18n.bindText(radiusYLabel, 'panel.crop-box.radius-y');
        const radiusYSlider = new SliderInput({
            class: 'crop-box-radius-slider',
            min: 0.02,
            max: 0.5,
            step: 0.01,
            precision: 2,
            value: 0.35
        });
        radiusYRow.append(radiusYLabel);
        radiusYRow.append(radiusYSlider);
        this.append(radiusYRow);

        // height slider (cylinder only; total height, pivot-local units)
        const heightRow = new Container({ class: ['settings-panel-row', 'crop-box-height-row'] });
        const heightLabel = new Label({ class: 'settings-panel-row-label' });
        i18n.bindText(heightLabel, 'panel.crop-box.height');
        const heightSlider = new SliderInput({
            class: 'crop-box-height-slider',
            min: 0.05,
            max: 1.0,
            step: 0.01,
            precision: 2,
            value: 0.8
        });
        heightRow.append(heightLabel);
        heightRow.append(heightSlider);
        this.append(heightRow);

        // ---- uniform-scale lock (keep the shape regular) ----
        const uniformRow = new Container({ class: ['settings-panel-row', 'crop-box-uniform-row'] });
        const uniformLabel = new Label({ class: 'settings-panel-row-label' });
        i18n.bindText(uniformLabel, 'panel.crop-box.uniform');
        const uniformToggle = new BooleanInput({ type: 'toggle', class: 'settings-panel-row-toggle', value: false });
        uniformRow.append(uniformLabel);
        uniformRow.append(uniformToggle);
        this.append(uniformRow);

        // sections that only make sense for a box (face offsets + rotation)
        const shapeSensitive: Container[] = [];

        // reflect the current shape in the UI (button highlight + row visibility)
        const updateShapeUI = () => {
            const box = getCropBox();
            const shape = box ? box.shape : 'box';
            shapeBtns.forEach(({ shape: s, btn }) => {
                btn.class[shape === s ? 'add' : 'remove']('active');
            });
            const isBox = shape === 'box';
            const isCyl = shape === 'cylinder';
            const isSphere = shape === 'sphere';
            radiusRow.hidden = isBox;
            radiusZRow.hidden = isBox;
            radiusYRow.hidden = !isSphere;
            heightRow.hidden = !isCyl;
            for (const el of shapeSensitive) el.hidden = !isBox;
            if (box) {
                updating = true;
                radiusXSlider.value = box.radiusX;
                radiusZSlider.value = box.radiusZ;
                radiusYSlider.value = box.radiusY;
                heightSlider.value = box.height;
                uniformToggle.value = box.uniformScale;
                updating = false;
            }
        };
        shapeBtns.forEach(({ shape: s, btn }) => {
            btn.on('click', () => {
                const box = getCropBox();
                if (box && box.shape !== s) {
                    box.shape = s;   // setter fires cropBox.changed + shapeChanged
                }
            });
        });
        radiusXSlider.on('change', (v: number) => {
            if (updating) return;
            const box = getCropBox();
            if (box) box.radiusX = v;
        });
        radiusZSlider.on('change', (v: number) => {
            if (updating) return;
            const box = getCropBox();
            if (box) box.radiusZ = v;
        });
        radiusYSlider.on('change', (v: number) => {
            if (updating) return;
            const box = getCropBox();
            if (box) box.radiusY = v;
        });
        heightSlider.on('change', (v: number) => {
            if (updating) return;
            const box = getCropBox();
            if (box) box.height = v;
        });
        uniformToggle.on('change', (v: boolean) => {
            if (updating) return;
            const box = getCropBox();
            if (box) box.uniformScale = v;
        });
        events.on('cropBox.shapeChanged', () => {
            updateShapeUI(); scheduleStatsUpdate();
        });

        // ---- section: face offsets ----
        const faceSectionHeader = this.buildSectionHeader('panel.crop-box.section.faces');
        this.append(faceSectionHeader);

        // inputs show the local-axis-projected face coordinate. labels: X-, X+, Y-, Y+, Z-, Z+
        // each cell pairs an axis color chip with the +/- face label so the
        // user can tell at a glance which axis a row controls.
        const faceRow = new Container({ class: 'crop-box-face-row' });
        const faceLabels: { text: string; axis: number; sign: number }[] = [
            { text: 'X-', axis: 0, sign: -1 }, { text: 'X+', axis: 0, sign: 1 },
            { text: 'Y-', axis: 1, sign: -1 }, { text: 'Y+', axis: 1, sign: 1 },
            { text: 'Z-', axis: 2, sign: -1 }, { text: 'Z+', axis: 2, sign: 1 }
        ];
        const faceInputs = faceLabels.map((l) => {
            const wrap = new Container({ class: 'crop-box-face-cell' });
            const lbl = new Label({ class: 'crop-box-face-label', text: l.text });
            lbl.dom.style.setProperty('--axis-chip-color', AXIS_COLORS[l.axis]);
            const inp = new NumericInput({
                class: 'crop-box-face-input',
                precision: 3,
                step: 0.05,
                value: 0
            });
            wrap.append(lbl);
            wrap.append(inp);
            faceRow.append(wrap);
            return inp;
        });
        this.append(faceRow);

        const [xMin, xMax, yMin, yMax, zMin, zMax] = faceInputs;
        shapeSensitive.push(faceSectionHeader, faceRow);

        // ---- section: rotation ----
        const rotationSectionHeader = this.buildSectionHeader('panel.crop-box.section.rotation');
        this.append(rotationSectionHeader);

        const rotRow = new Container({ class: 'crop-box-rotation-row' });
        const rotAxes: { label: string; axis: number }[] = [
            { label: 'X', axis: 0 },
            { label: 'Y', axis: 1 },
            { label: 'Z', axis: 2 }
        ];
        const rotInputs = rotAxes.map((a) => {
            const cell = new Container({ class: 'crop-box-rotation-cell' });
            const chip = new Label({ class: 'crop-box-axis-chip', text: a.label });
            chip.dom.style.setProperty('--axis-chip-color', AXIS_COLORS[a.axis]);
            const inp = new NumericInput({
                class: 'crop-box-rotation-input',
                precision: 2,
                step: 1,
                value: 0
            });
            const unit = new Label({ class: 'crop-box-rotation-unit', text: '°' });
            cell.append(chip);
            cell.append(inp);
            cell.append(unit);
            rotRow.append(cell);
            return inp;
        });
        const [rotX, rotY, rotZ] = rotInputs;
        this.append(rotRow);

        // ---- reset rotation button ----
        const resetRow = new Container({ class: ['settings-panel-row', 'crop-box-reset-row'] });
        const resetBtn = new Button({ class: ['settings-panel-row-button', 'crop-box-reset-button'] });
        i18n.bindText(resetBtn, 'panel.crop-box.rotation.reset');
        resetRow.append(resetBtn);
        this.append(resetRow);
        shapeSensitive.push(rotationSectionHeader, rotRow, resetRow);

        // ---- splat count statistics (inside box / total) ----
        const statsRow = new Container({ class: 'crop-box-stats-row' });
        const statsPrefix = new Label({ class: 'crop-box-stats-prefix' });
        i18n.bindText(statsPrefix, 'panel.crop-box.stats');
        const statsLabel = new Label({ class: 'crop-box-stats-label', text: '—' });
        statsRow.append(statsPrefix);
        statsRow.append(statsLabel);
        this.append(statsRow);

        // ---- helpers ----
        const getCropBox = (): CropBox | null => events.invoke('cropBox') as CropBox | null;

        // read the 6 local-axis-projected face coordinates from the crop box
        const readFaces = (box: CropBox) => {
            box.rotation.transformVector(RIGHT, axisX);
            box.rotation.transformVector(UP, axisY);
            box.rotation.transformVector(FORWARD, axisZ);
            center.copy(box.center);
            const ex = box.extent.x, ey = box.extent.y, ez = box.extent.z;
            const cx = center.dot(axisX);
            const cy = center.dot(axisY);
            const cz = center.dot(axisZ);
            return [
                cx - ex, cx + ex,   // X-, X+
                cy - ey, cy + ey,   // Y-, Y+
                cz - ez, cz + ez    // Z-, Z+
            ];
        };

        // apply an edited face: keep the opposite face fixed, recompute extent
        // and shift the center along the box's local axis.
        // axisIndex: 0=X, 1=Y, 2=Z. plusSide: true for + face, false for - face.
        const applyFace = (box: CropBox, axisIndex: number, plusSide: boolean, newValue: number) => {
            const axes = [axisX, axisY, axisZ];
            const axis = axes[axisIndex];
            box.rotation.transformVector(RIGHT, axisX);
            box.rotation.transformVector(UP, axisY);
            box.rotation.transformVector(FORWARD, axisZ);

            center.copy(box.center);
            const cProj = center.dot(axis);
            const e = [box.extent.x, box.extent.y, box.extent.z][axisIndex];

            const plus = cProj + e;
            const minus = cProj - e;

            // the face being edited takes newValue; the opposite stays fixed
            const newPlus = plusSide ? newValue : plus;
            const newMinus = plusSide ? minus : newValue;

            const newExtent = (newPlus - newMinus) / 2;
            const newCProj = (newPlus + newMinus) / 2;

            if (newExtent <= 0.001) return; // ignore degenerate

            // shift the center along the local axis from cProj to newCProj
            const delta = newCProj - cProj;
            const newCenter = new Vec3(
                center.x + axis.x * delta,
                center.y + axis.y * delta,
                center.z + axis.z * delta
            );

            const newExt = new Vec3(box.extent.x, box.extent.y, box.extent.z);
            if (axisIndex === 0) newExt.x = newExtent;
            else if (axisIndex === 1) newExt.y = newExtent;
            else newExt.z = newExtent;

            box.setState(newCenter, newExt, box.rotation.clone());
        };

        let updating = false;
        const refreshFromBox = () => {
            const box = getCropBox();
            if (!box) {
                [xMin, xMax, yMin, yMax, zMin, zMax].forEach((i) => {
                    i.value = 0;
                });
                rotX.value = 0; rotY.value = 0; rotZ.value = 0;
                visToggle.value = false;
                clipToggle.value = false;
                previewToggle.value = false;
                softEdgeSlider.value = 0.005;
                uniformToggle.value = false;
                updateShapeUI();
                return;
            }
            updating = true;
            const f = readFaces(box);
            xMin.value = f[0]; xMax.value = f[1];
            yMin.value = f[2]; yMax.value = f[3];
            zMin.value = f[4]; zMax.value = f[5];
            box.getRotationEulerDegrees(eulerBuf);
            rotX.value = eulerBuf.x;
            rotY.value = eulerBuf.y;
            rotZ.value = eulerBuf.z;
            visToggle.value = box.visible;
            clipToggle.value = box.enabled;
            previewToggle.value = box.preview;
            softEdgeSlider.value = box.softEdge;
            updating = false;
            updateShapeUI();
        };

        // ---- wire events ----
        initButton.on('click', () => {
            events.fire('cropBox.initialize');
            refreshFromBox();
        });

        pcaButton.on('click', () => {
            events.fire('cropBox.orientToPCA');
            refreshFromBox();
        });

        visToggle.on('change', (v: boolean) => {
            if (!updating) events.fire('cropBox.setVisible', v);
        });
        clipToggle.on('change', (v: boolean) => {
            if (!updating) events.fire('cropBox.setClipping', v);
        });
        previewToggle.on('change', (v: boolean) => {
            if (!updating) events.fire('cropBox.setPreview', v);
        });
        softEdgeSlider.on('change', (v: number) => {
            if (!updating) events.fire('cropBox.setSoftEdge', v);
        });

        // face input handlers. index 0,2,4 = minus sides; 1,3,5 = plus sides.
        const handlers: [NumericInput, number, boolean][] = [
            [xMin, 0, false], [xMax, 0, true],
            [yMin, 1, false], [yMax, 1, true],
            [zMin, 2, false], [zMax, 2, true]
        ];
        handlers.forEach(([inp, axisIdx, plus]) => {
            inp.on('change', (v: number) => {
                if (updating) return;
                const box = getCropBox();
                if (box) {
                    applyFace(box, axisIdx, plus, v);
                }
            });
        });

        // rotation input handlers. each axis is independently editable; we
        // read the current euler angles back from the box so editing one axis
        // does not reset the others (which would happen if we constructed the
        // quaternion from the single edited value).
        //
        // SHIFT snapping: while Shift is held, rotation values snap to the
        // nearest 10° grid — handy for aligning to 90°/45° standard angles.
        let shiftDown = false;
        this.dom.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Shift') shiftDown = true;
        });
        this.dom.addEventListener('keyup', (e: KeyboardEvent) => {
            if (e.key === 'Shift') shiftDown = false;
        });
        // also track when shift is released outside the panel
        window.addEventListener('keyup', (e: KeyboardEvent) => {
            if (e.key === 'Shift') shiftDown = false;
        });

        const SNAP_STEP = 10; // degrees
        const rotHandlers: [NumericInput, number][] = [
            [rotX, 0], [rotY, 1], [rotZ, 2]
        ];
        rotHandlers.forEach(([inp, axisIdx]) => {
            inp.on('change', (v: number) => {
                if (updating) return;
                const box = getCropBox();
                if (!box) return;
                box.getRotationEulerDegrees(eulerBuf);
                const next = [eulerBuf.x, eulerBuf.y, eulerBuf.z];
                if (shiftDown) {
                    v = Math.round(v / SNAP_STEP) * SNAP_STEP;
                    // reflect the snapped value back into the input
                    updating = true;
                    inp.value = v;
                    updating = false;
                }
                next[axisIdx] = v;
                box.setRotationEulerDegrees(next[0], next[1], next[2]);
            });
        });

        // PCUI's built-in numeric slider strips rely on pointer lock, which is
        // unreliable in the packaged Electron renderer. Replace the drag with a
        // pointer-capture based one and hide the dead strips. The inputs' own
        // change handlers keep firing on every value update, so dragging stays
        // live; each input remains click-to-focus and typeable.
        [...faceInputs, ...rotInputs].forEach((inp) => {
            enableReliableInputDrag(inp, () => { });
            hidePcuiSliderStrip(inp);
        });

        // ---- splat count statistics (debounced) ----
        let statsTimer: ReturnType<typeof setTimeout> | null = null;
        const updateStats = () => {
            const box = getCropBox();
            if (!box) {
                statsLabel.text = '—';
                return;
            }
            const result = events.invoke('cropBox.countSplats') as { inside: number, total: number };
            if (!result || result.total === 0) {
                statsLabel.text = '—';
                return;
            }
            const pct = (result.inside / result.total * 100).toFixed(1);
            statsLabel.text = `${result.inside.toLocaleString()} / ${result.total.toLocaleString()}  (${pct}%)`;
        };
        const scheduleStatsUpdate = () => {
            if (statsTimer) clearTimeout(statsTimer);
            statsTimer = setTimeout(updateStats, 150);
        };

        resetBtn.on('click', () => {
            const box = getCropBox();
            if (box) box.setRotationEulerDegrees(0, 0, 0);
        });

        // refresh whenever the crop box changes (gizmo move, undo/redo, init, load)
        events.on('cropBox.changed', () => {
            refreshFromBox();
            scheduleStatsUpdate();
        });

        // ---- panel visibility (toggle like the settings panel) ----
        const setVisible = (visible: boolean) => {
            if (visible === this.hidden) {
                this.hidden = !visible;
                events.fire('cropBoxPanel.visible', visible);
                if (visible) {
                    // Close other panels when crop panel opens (mutual exclusion)
                    events.fire('colorPanel.setVisible', false);
                    events.fire('settingsPanel.setVisible', false);
                    refreshFromBox();
                }
            }
        };
        events.function('cropBoxPanel.visible', () => !this.hidden);
        events.on('cropBoxPanel.setVisible', setVisible);
        events.on('cropBoxPanel.toggleVisible', () => setVisible(this.hidden));

        // initial state
        refreshFromBox();
    }

    // small section header — a thin divider with a one-line label. used to
    // visually separate the "faces" and "rotation" numeric groups from the
    // toggles above.
    private buildSectionHeader(i18nKey: string): Container {
        const row = new Container({ class: 'crop-box-section-header' });
        const lbl = new Label({ class: 'crop-box-section-header-label' });
        i18n.bindText(lbl, i18nKey);
        row.append(lbl);
        return row;
    }
}

export { CropBoxPanel };
