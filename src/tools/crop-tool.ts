import { Container, Label, VectorInput } from '@playcanvas/pcui';
import { Quat, Vec3 } from 'playcanvas';

import { CropBoxFaceHandles } from './crop-box-face-handles';
import { CropBoxShapeHandles } from './crop-box-shape-handles';
import { CropBox } from '../crop-box';
import { EditOp } from '../edit-ops';
import { Events } from '../events';
import { Scene } from '../scene';
import { i18n } from '../ui/localization';

// undo/redo op for crop box transforms.
type CropBoxState = {
    position: Vec3;
    rotation: Quat;
    extent: Vec3;
};

class CropBoxTransformOp implements EditOp {
    name = 'cropBoxTransform';
    cropBox: CropBox;
    oldState: CropBoxState;
    newState: CropBoxState;

    constructor(options: { cropBox: CropBox, oldState: CropBoxState, newState: CropBoxState }) {
        this.cropBox = options.cropBox;
        this.oldState = options.oldState;
        this.newState = options.newState;
    }

    private apply(state: CropBoxState) {
        this.cropBox.setState(state.position.clone(), state.extent.clone(), state.rotation.clone());
        this.cropBox.scene?.events.fire('cropBox.changed');
    }

    do() { this.apply(this.newState); }
    undo() { this.apply(this.oldState); }
}

// Crop tool: face-drag handles on the crop box for per-face positioning,
// plus numeric inputs for center/size. No rotate gizmo — the box is
// axis-aligned by design, which matches the user's workflow (adjust each
// face independently to define the clipping region).
class CropTool {
    activate: () => void;
    deactivate: () => void;

    active = false;

    constructor(events: Events, scene: Scene, canvasContainer: Container) {
        // ui toolbar
        const selectToolbar = new Container({
            class: 'select-toolbar',
            hidden: true
        });

        selectToolbar.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
        });

        const positionLabel = new Label({ class: 'select-toolbar-label' });
        i18n.bindText(positionLabel, 'select-toolbar.position');

        const position = new VectorInput({
            class: 'select-toolbar-vector',
            precision: 2,
            dimensions: 3,
            placeholder: ['X', 'Y', 'Z'],
            value: [0, 0, 0]
        });

        const sizeLabel = new Label({ class: 'select-toolbar-label' });
        i18n.bindText(sizeLabel, 'select-toolbar.size');

        // size shown as full lengths (2 * extent)
        const size = new VectorInput({
            class: 'select-toolbar-vector',
            precision: 2,
            dimensions: 3,
            placeholder: ['X', 'Y', 'Z'],
            value: [2, 2, 2],
            min: 0.01
        });

        selectToolbar.append(positionLabel);
        selectToolbar.append(position);
        selectToolbar.append(sizeLabel);
        selectToolbar.append(size);

        canvasContainer.append(selectToolbar);

        const getCropBox = (): CropBox | null => events.invoke('cropBox') as CropBox | null;

        // write the crop box state into the ui without retriggering inputs
        let uiUpdating = false;
        const updateUI = () => {
            const box = getCropBox();
            if (!box) return;
            uiUpdating = true;
            const p = box.center;
            position.value = [p.x, p.y, p.z];
            size.value = [box.extent.x * 2, box.extent.y * 2, box.extent.z * 2];
            uiUpdating = false;
        };

        // ---- undo/redo support ----
        const captureState = (): CropBoxState | null => {
            const box = getCropBox();
            if (!box) return null;
            return {
                position: box.center.clone(),
                rotation: box.rotation.clone(),
                extent: box.extent.clone()
            };
        };

        const statesEqual = (a: CropBoxState, b: CropBoxState) => {
            return a.position.equals(b.position) &&
                   a.rotation.equals(b.rotation) &&
                   a.extent.equals(b.extent);
        };

        const addOp = (oldState: CropBoxState, newState: CropBoxState) => {
            const box = getCropBox();
            if (box && !statesEqual(oldState, newState)) {
                events.fire('edit.add', new CropBoxTransformOp({ cropBox: box, oldState, newState }), true);
            }
        };

        const recordOp = (fn: () => void) => {
            const oldState = captureState();
            fn();
            const newState = captureState();
            if (oldState && newState) addOp(oldState, newState);
        };

        // ---- face drag handles (RealityCapture-style) ----
        // 6 draggable spheres on the box faces. dragging a sphere moves that
        // face along its normal, adjusting the box extent on that axis while
        // keeping the opposite face fixed.
        const faceHandles = new CropBoxFaceHandles(scene, events, getCropBox);
        // expose for debugging / testing; safe because it lives on the dev
        // browser's window object only.
        (window as any).__faceHandles = faceHandles;

        // ---- shape drag handles (cylinder / sphere) ----
        // top/bottom & rim handles that resize radius/height directly, so the
        // non-box shapes are still grabbable in the viewport.
        const shapeHandles = new CropBoxShapeHandles(scene, events, getCropBox);
        (window as any).__shapeHandles = shapeHandles;

        // canvas pointer interception: face handles capture pointerdown on the
        // canvas so dragging a handle doesn't also orbit the camera.
        const canvas = scene.canvas;
        let dragStartState: CropBoxState | null = null;

        // face handles only exist for the box shape; cylinder/sphere use the
        // shape handles (radius/height), so handle hit-testing is dispatched
        // by the current shape.
        const isBoxShape = () => {
            const b = getCropBox();
            return !b || b.shape === 'box';
        };

        // the active handle set for the current shape (face vs shape handles)
        const currentHandles = () => {
            const b = getCropBox();
            return b && b.shape !== 'box' ? shapeHandles : faceHandles;
        };

        const onCanvasPointerDown = (e: PointerEvent) => {
            const h = currentHandles();
            if (h.onPointerDown(e.clientX, e.clientY)) {
                // a handle was hit — record undo state and consume.
                // stopImmediatePropagation (not stopPropagation) because we're
                // in capture phase and need to block target/bubble listeners
                // (camera orbit, transform gizmo) on the same canvas.
                dragStartState = captureState();
                canvas.style.cursor = 'grabbing';
                e.stopImmediatePropagation();
                e.preventDefault();
            }
        };
        const onWindowPointerMove = (e: PointerEvent) => {
            const h = currentHandles();
            if (h.isDragging) {
                h.onPointerMove(e.clientX, e.clientY);
                e.stopImmediatePropagation();
                e.preventDefault();
            } else if (this.active) {
                // hover highlight: cheap ray-sphere test against the handles.
                // only fires when the tool is active and no drag is in progress.
                const hovering = h.onPointerHover(e.clientX, e.clientY);
                canvas.style.cursor = hovering ? 'grab' : '';
            }
        };
        const onWindowPointerUp = (e: PointerEvent) => {
            const h = currentHandles();
            if (h.isDragging) {
                h.onPointerUp();
                // record undo/redo op for the drag
                if (dragStartState) {
                    const newState = captureState();
                    if (newState) addOp(dragStartState, newState);
                    dragStartState = null;
                }
                // restore hover cursor if still over a handle, else default
                const hovering = h.onPointerHover(e.clientX, e.clientY);
                canvas.style.cursor = hovering ? 'grab' : '';
                e.stopImmediatePropagation();
                e.preventDefault();
            }
        };

        canvas.addEventListener('pointerdown', onCanvasPointerDown, true);
        window.addEventListener('pointermove', onWindowPointerMove);
        window.addEventListener('pointerup', onWindowPointerUp);

        // numeric input handlers
        position.on('change', (v: number[]) => {
            if (!uiUpdating) {
                recordOp(() => {
                    const box = getCropBox();
                    if (box) {
                        box.pivot.setPosition(v[0], v[1], v[2]);
                        box.movedFromPivot(false);
                    }
                });
            }
        });
        size.on('change', (v: number[]) => {
            if (!uiUpdating) {
                recordOp(() => {
                    const box = getCropBox();
                    if (box) {
                        // full length -> half-extent
                        box.pivot.setLocalScale(v[0], v[1], v[2]);
                        box.movedFromPivot(true);
                    }
                });
            }
        });

        // refresh the ui when the crop box changes (undo/redo, config load,
        // initialize, face-drag). only while the tool is active.
        events.on('cropBox.changed', () => {
            if (this.active) updateUI();
        });

        // refresh handle positions/sizes each frame. both handle sets are
        // ticked; each hides itself when its shape is not active (face handles
        // → box, shape handles → cylinder/sphere).
        events.on('prerender', () => {
            if (this.active) {
                faceHandles.onPreRender();
                shapeHandles.onPreRender();
            }
        });

        this.activate = () => {
            this.active = true;
            // ensure a crop box exists; initialize from splats if none yet
            let box = getCropBox();
            if (!box) {
                events.fire('cropBox.initialize');
                box = getCropBox();
            }
            if (box) {
                box.visible = true;
                faceHandles.activate();
                shapeHandles.activate();
                updateUI();
            }
            // show the side panel (initialize button, visibility/clipping
            // toggles, six face inputs). The right-toolbar crop button is now
            // the entry point for the whole crop UX, so the panel must
            // appear together with the 3D handles. The bottom-toolbar crop
            // button also fires tool.crop, so the panel appears there too.
            events.fire('cropBoxPanel.setVisible', true);
            selectToolbar.hidden = false;
        };

        this.deactivate = () => {
            selectToolbar.hidden = true;
            faceHandles.deactivate();
            shapeHandles.deactivate();
            canvas.style.cursor = '';
            // hide the side panel when the tool is dismissed so the user is
            // not left with a floating panel that no longer corresponds to
            // any active UI
            events.fire('cropBoxPanel.setVisible', false);
            this.active = false;
            // hide the crop box wireframe when the tool is not active
            const box = getCropBox();
            if (box) box.visible = false;
        };
    }
}

export { CropTool };
