import { Button, Container, ContainerArgs, Label, NumericInput, VectorInput } from '@playcanvas/pcui';
import { Quat, Vec3 } from 'playcanvas';

import { Events } from '../events';
import { i18n } from './localization';
import { Pivot } from '../pivot';

const v = new Vec3();

/** step size for quick-rotate buttons (degrees) */
const QUICK_ROTATE_STEP = 90;

class Transform extends Container {
    constructor(events: Events, args: ContainerArgs = {}) {
        args = {
            ...args,
            id: 'transform'
        };

        super(args);

        // position
        const position = new Container({
            class: 'transform-row'
        });

        const positionLabel = new Label({
            class: 'transform-label'
        });
        i18n.bindText(positionLabel, 'panel.scene.transform.position');

        const positionVector = new VectorInput({
            class: 'transform-expand',
            precision: 3,
            dimensions: 3,
            placeholder: ['X', 'Y', 'Z'],
            value: [0, 0, 0],
            enabled: false
        });

        position.append(positionLabel);
        position.append(positionVector);

        // rotation — header row with label
        const rotation = new Container({
            class: 'transform-row'
        });

        const rotationLabel = new Label({
            class: 'transform-label'
        });
        i18n.bindText(rotationLabel, 'panel.scene.transform.rotation');

        const rotationContainer = new Container({
            class: 'transform-expand'
        });
        rotationContainer.dom.classList.add('transform-rotation-axes');

        // build 3 per-axis rows: X / Y / Z with ◀ [value] ▶
        const rotationInputs: NumericInput[] = [];
        const AXES = ['X', 'Y', 'Z'];

        AXES.forEach((axis) => {
            const axisRow = new Container({
                class: 'transform-rotation-axis-row'
            });

            const axisLabel = new Label({
                class: 'transform-rotation-axis-label',
                text: axis
            });

            const decBtn = new Button({
                class: 'transform-rotation-btn'
            });
            decBtn.dom.innerHTML = '&#9664;';  // ◀

            const numInput = new NumericInput({
                class: 'transform-rotation-input',
                precision: 2,
                value: 0,
                enabled: false
            });

            const incBtn = new Button({
                class: 'transform-rotation-btn'
            });
            incBtn.dom.innerHTML = '&#9654;';  // ▶

            axisRow.append(axisLabel);
            axisRow.append(decBtn);
            axisRow.append(numInput);
            axisRow.append(incBtn);
            rotationContainer.append(axisRow);

            rotationInputs.push(numInput);

            // quick-rotate: −90°
            decBtn.on('click', () => {
                const pivot = events.invoke('pivot') as Pivot;
                if (!pivot) return;
                numInput.value -= QUICK_ROTATE_STEP;
                pivot.start();
                updatePivot(pivot);
                pivot.end();
            });

            // quick-rotate: +90°
            incBtn.on('click', () => {
                const pivot = events.invoke('pivot') as Pivot;
                if (!pivot) return;
                numInput.value += QUICK_ROTATE_STEP;
                pivot.start();
                updatePivot(pivot);
                pivot.end();
            });
        });

        rotation.append(rotationLabel);
        rotation.append(rotationContainer);

        // scale
        const scale = new Container({
            class: 'transform-row'
        });

        const scaleLabel = new Label({
            class: 'transform-label'
        });
        i18n.bindText(scaleLabel, 'panel.scene.transform.scale');

        const scaleInput = new NumericInput({
            class: 'transform-expand',
            precision: 3,
            value: 1,
            min: 0.001,
            max: 10000,
            enabled: false
        });

        scale.append(scaleLabel);
        scale.append(scaleInput);

        this.append(position);
        this.append(rotation);
        this.append(scale);

        const toArray = (v: Vec3) => {
            return [v.x, v.y, v.z];
        };

        let uiUpdating = false;
        let mouseUpdating = false;

        // update UI with pivot
        const updateUI = (pivot: Pivot) => {
            uiUpdating = true;
            const transform = pivot.transform;
            transform.rotation.getEulerAngles(v);
            positionVector.value = toArray(transform.position);
            rotationInputs[0].value = v.x;
            rotationInputs[1].value = v.y;
            rotationInputs[2].value = v.z;
            scaleInput.value = transform.scale.x;
            uiUpdating = false;
        };

        // update pivot with UI
        const updatePivot = (pivot: Pivot) => {
            const p = positionVector.value;
            const r = rotationInputs.map(inp => inp.value);
            const q = new Quat().setFromEulerAngles(r[0], r[1], r[2]);
            const s = scaleInput.value;

            if (q.w < 0) {
                q.mulScalar(-1);
            }

            pivot.moveTRS(new Vec3(p[0], p[1], p[2]), q, new Vec3(s, s, s));
        };

        // handle a change in the UI state
        const change = () => {
            if (!uiUpdating) {
                const pivot = events.invoke('pivot') as Pivot;
                if (mouseUpdating) {
                    updatePivot(pivot);
                } else {
                    pivot.start();
                    updatePivot(pivot);
                    pivot.end();
                }
            }
        };

        const mousedown = () => {
            mouseUpdating = true;
            const pivot = events.invoke('pivot') as Pivot;
            pivot.start();
        };

        const mouseup = () => {
            const pivot = events.invoke('pivot') as Pivot;
            updatePivot(pivot);
            mouseUpdating = false;
            pivot.end();
        };

        positionVector.inputs.forEach((input) => {
            input.on('change', change);
            input.on('slider:mousedown', mousedown);
            input.on('slider:mouseup', mouseup);
        });

        rotationInputs.forEach((input) => {
            input.on('change', change);
            input.on('slider:mousedown', mousedown);
            input.on('slider:mouseup', mouseup);
        });

        scaleInput.on('change', change);
        scaleInput.on('slider:mousedown', mousedown);
        scaleInput.on('slider:mouseup', mouseup);

        // toggle ui availability based on selection
        events.on('selection.changed', (selection) => {
            const enabled = !!selection;
            positionVector.enabled = enabled;
            rotationInputs.forEach(inp => inp.enabled = enabled);
            scaleInput.enabled = enabled;
        });

        events.on('pivot.placed', (pivot: Pivot) => {
            updateUI(pivot);
        });

        events.on('pivot.moved', (pivot: Pivot) => {
            if (!mouseUpdating) {
                updateUI(pivot);
            }
        });

        events.on('pivot.ended', (pivot: Pivot) => {
            updateUI(pivot);
        });
    }
}

export { Transform };
