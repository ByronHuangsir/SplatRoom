import { Button, Container, Element, Label, VectorInput } from '@playcanvas/pcui';
import { Vec3 } from 'playcanvas';

import { selectionTargetSplats, selectionTargetBound, volumeReachesTarget, fitBoxToBound } from './shape-fit';
import { ShapeGizmoMode, ShapeTransformGizmo } from './shape-transform-gizmo';
import { dimModelForVolumeTool, restoreModelAfterVolumeTool } from './volume-dim';
import { ShapeTransformOp } from '../core/edit-ops';
import { Events } from '../core/events';
import { ShortcutManager } from '../core/shortcut-manager';
import { BoxShape } from '../scene/box-shape';
import { Scene } from '../scene/scene';
import { Splat } from '../splat/splat';
import { enableReliableInputDrag, hidePcuiSliderStrip } from '../ui/input-drag';
import { i18n } from '../ui/localization';
import addSvg from '../ui/svg/select-add.svg';
import intersectSvg from '../ui/svg/select-intersect.svg';
import removeSvg from '../ui/svg/select-remove.svg';
import setSvg from '../ui/svg/select-set.svg';
import { Tooltips } from '../ui/tooltips';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

class BoxSelection {
    activate: () => void;
    deactivate: () => void;
    setTransformMode: (mode: Exclude<ShapeGizmoMode, 'none'>) => boolean;
    getFocus: () => { position: Vec3, radius: number };

    active = false;

    constructor(events: Events, scene: Scene, canvasContainer: Container, tooltips: Tooltips) {
        const box = new BoxShape();

        // ui
        const selectToolbar = new Container({
            class: 'select-toolbar',
            hidden: true
        });

        selectToolbar.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
        });

        const translateButton = new Button({ class: 'select-toolbar-mode', icon: 'E111' });
        const rotateButton = new Button({ class: 'select-toolbar-mode', icon: 'E113' });
        const scaleButton = new Button({ class: 'select-toolbar-mode', icon: 'E112' });

        const setButton = new Button({ class: 'select-toolbar-op' });
        const addButton = new Button({ class: 'select-toolbar-op' });
        const removeButton = new Button({ class: 'select-toolbar-op' });
        const intersectButton = new Button({ class: 'select-toolbar-op' });

        setButton.dom.appendChild(createSvg(setSvg));
        addButton.dom.appendChild(createSvg(addSvg));
        removeButton.dom.appendChild(createSvg(removeSvg));
        intersectButton.dom.appendChild(createSvg(intersectSvg));

        // icon-only buttons need localized accessible names
        i18n.onChange(() => {
            setButton.dom.setAttribute('aria-label', i18n.t('select-toolbar.set'));
            addButton.dom.setAttribute('aria-label', i18n.t('select-toolbar.add'));
            removeButton.dom.setAttribute('aria-label', i18n.t('select-toolbar.remove'));
            intersectButton.dom.setAttribute('aria-label', i18n.t('select-toolbar.intersect'));
        }, setButton);

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

        const size = new VectorInput({
            class: 'select-toolbar-vector',
            precision: 2,
            dimensions: 3,
            placeholder: ['X', 'Y', 'Z'],
            value: [box.lenX, box.lenY, box.lenZ],
            min: 0.01
        });

        const rotationLabel = new Label({ class: 'select-toolbar-label', hidden: true });
        i18n.bindText(rotationLabel, 'select-toolbar.rotation');

        const rotation = new VectorInput({
            class: 'select-toolbar-vector',
            precision: 2,
            dimensions: 3,
            placeholder: ['X', 'Y', 'Z'],
            value: [0, 0, 0],
            hidden: true
        });

        selectToolbar.append(translateButton);
        selectToolbar.append(rotateButton);
        selectToolbar.append(scaleButton);
        selectToolbar.append(new Element({ class: 'select-toolbar-separator' }));
        selectToolbar.append(setButton);
        selectToolbar.append(addButton);
        selectToolbar.append(removeButton);
        selectToolbar.append(intersectButton);
        selectToolbar.append(positionLabel);
        selectToolbar.append(position);
        selectToolbar.append(sizeLabel);
        selectToolbar.append(size);
        selectToolbar.append(rotationLabel);
        selectToolbar.append(rotation);

        canvasContainer.append(selectToolbar);

        // write the volume's transform into the ui without retriggering the
        // inputs' change handlers
        let uiUpdating = false;
        const updateUI = () => {
            uiUpdating = true;
            const p = box.pivot.getPosition();
            position.value = [p.x, p.y, p.z];
            size.value = [box.lenX, box.lenY, box.lenZ];
            const e = box.pivot.getLocalEulerAngles();
            rotation.value = [e.x, e.y, e.z];
            uiUpdating = false;
        };

        const syncModeUI = (mode: ShapeGizmoMode) => {
            translateButton.class[mode === 'translate' ? 'add' : 'remove']('active');
            rotateButton.class[mode === 'rotate' ? 'add' : 'remove']('active');
            scaleButton.class[mode === 'scale' ? 'add' : 'remove']('active');

            // show the rotation fields while rotating, the size fields otherwise
            const rotating = mode === 'rotate';
            sizeLabel.hidden = rotating;
            size.hidden = rotating;
            rotationLabel.hidden = !rotating;
            rotation.hidden = !rotating;
        };

        // undo/redo support for volume transforms
        const captureState = () => ({
            position: box.pivot.getPosition().clone(),
            rotation: box.pivot.getRotation().clone(),
            lens: new Vec3(box.lenX, box.lenY, box.lenZ)
        });

        type BoxState = ReturnType<typeof captureState>;

        const statesEqual = (a: BoxState, b: BoxState) => {
            return a.position.equals(b.position) && a.rotation.equals(b.rotation) && a.lens.equals(b.lens);
        };

        const addOp = (oldState: BoxState, newState: BoxState) => {
            if (!statesEqual(oldState, newState)) {
                // the change is already applied, so suppress the op's do()
                events.fire('edit.add', new ShapeTransformOp({ shape: box, oldState, newState }), true);
            }
        };

        // true once the user has positioned the volume themselves (gizmo, inputs or
        // undo/redo), so re-activating the tool keeps their placement instead of
        // re-fitting the volume over the selection
        let userPlaced = false;

        // record an undo op for the state change performed by fn
        const recordOp = (fn: () => void) => {
            const oldState = captureState();
            fn();
            userPlaced = true;
            addOp(oldState, captureState());
        };

        let dragState: BoxState | null = null;

        // undo grouping for toolbar-input drags: PCUI's built-in numeric
        // slider strips rely on pointer lock (unreliable in Electron), so we
        // drive the inputs with a pointer-capture drag. Each change event
        // applies live, and exactly one undo op is committed on drag end (the
        // same pattern as the gizmo's onTransformStart/onTransformEnd).
        let uiDragState: BoxState | null = null;
        const startUiDrag = () => {
            uiDragState = captureState();
            userPlaced = true;
        };
        const endUiDrag = () => {
            if (uiDragState) {
                addOp(uiDragState, captureState());
                uiDragState = null;
            }
        };

        const gizmo = new ShapeTransformGizmo(events, scene, {
            rotate: true,
            scaleHandles: 'all',
            lowerBoundScale: new Vec3(0.01, 0.01, 0.01),
            onTransformStart: () => {
                dragState = captureState();
                userPlaced = true;
            },
            onTransform: (mode) => {
                if (mode === 'scale') {
                    // snapshot the live scale vector before the length setters mutate it
                    const { x, y, z } = box.pivot.getLocalScale();
                    box.lenX = x;
                    box.lenY = y;
                    box.lenZ = z;
                } else {
                    box.moved();
                }
                updateUI();
            },
            onTransformEnd: () => {
                if (dragState) {
                    addOp(dragState, captureState());
                    dragState = null;
                }
            },
            onModeChanged: syncModeUI
        });
        syncModeUI(gizmo.mode);

        this.setTransformMode = (mode) => {
            gizmo.toggleMode(mode);
            return true;
        };

        // the focus shortcut frames the volume while this tool is active
        this.getFocus = () => {
            const half = Math.sqrt(box.lenX * box.lenX + box.lenY * box.lenY + box.lenZ * box.lenZ) * 0.5;
            return {
                position: box.pivot.getPosition().clone(),
                radius: half
            };
        };

        // fit the volume over the current target (the selected splats, or every splat
        // when nothing is selected)
        const fitToTarget = () => {
            const splats = selectionTargetSplats(events, scene);
            const bound = selectionTargetBound(events, scene);
            if (bound) {
                fitBoxToBound(scene, box, bound, splats);
                updateUI();
            }
            return !!bound;
        };

        const apply = (op: 'set' | 'add' | 'remove' | 'intersect') => {
            events.fire('select.byBox', op, box.pivot.getWorldTransform().clone());
        };

        translateButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            gizmo.toggleMode('translate');
        });
        rotateButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            gizmo.toggleMode('rotate');
        });
        scaleButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            gizmo.toggleMode('scale');
        });
        setButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            apply('set');
        });
        addButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            apply('add');
        });
        removeButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            apply('remove');
        });
        intersectButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            apply('intersect');
        });
        position.on('change', (v: number[]) => {
            if (!uiUpdating) {
                if (uiDragState) {
                    box.pivot.setPosition(v[0], v[1], v[2]);
                    box.moved();
                } else {
                    recordOp(() => {
                        box.pivot.setPosition(v[0], v[1], v[2]);
                        box.moved();
                    });
                }
                gizmo.attach(box.pivot);
            }
        });
        size.on('change', (v: number[]) => {
            if (!uiUpdating) {
                if (uiDragState) {
                    box.lenX = v[0];
                    box.lenY = v[1];
                    box.lenZ = v[2];
                } else {
                    recordOp(() => {
                        box.lenX = v[0];
                        box.lenY = v[1];
                        box.lenZ = v[2];
                    });
                }
            }
        });
        rotation.on('change', (v: number[]) => {
            if (!uiUpdating) {
                if (uiDragState) {
                    box.pivot.setLocalEulerAngles(v[0], v[1], v[2]);
                    box.moved();
                } else {
                    recordOp(() => {
                        box.pivot.setLocalEulerAngles(v[0], v[1], v[2]);
                        box.moved();
                    });
                }
                gizmo.attach(box.pivot);
            }
        });

        // replace PCUI's pointer-lock slider strips (dead in Electron) with the
        // reliable pointer-capture drag, and hide the unusable strips.
        [position, size, rotation].forEach((vec) => {
            vec.inputs.forEach((input) => {
                enableReliableInputDrag(input, () => { }, startUiDrag, endUiDrag);
                hidePcuiSliderStrip(input);
            });
        });

        events.on('camera.focalPointPicked', (details: { splat: Splat, position: Vec3 }) => {
            if (this.active) {
                recordOp(() => {
                    box.pivot.setPosition(details.position);
                    box.moved();
                });
                gizmo.attach(box.pivot);
                updateUI();
            }
        });

        // refresh the ui when undo/redo changes the volume while the tool is active
        events.on('shapeSelection.changed', (shape: unknown) => {
            if (this.active && shape === box) {
                updateUI();
            }
        });

        // compose localized tooltip text with the shortcut key
        const shortcutManager: ShortcutManager = events.invoke('shortcutManager');
        const tooltip = (localeKey: string, shortcutId: string) => () => {
            const text = i18n.t(localeKey);
            const shortcut = shortcutManager.formatShortcut(shortcutId);
            return shortcut ? i18n.formatTooltipWithShortcut(text, shortcut) : text;
        };

        tooltips.register(translateButton, tooltip('tooltip.bottom-toolbar.move', 'tool.moveShortcut'), 'top');
        tooltips.register(rotateButton, tooltip('tooltip.bottom-toolbar.rotate', 'tool.rotateShortcut'), 'top');
        tooltips.register(scaleButton, tooltip('tooltip.bottom-toolbar.scale', 'tool.scaleShortcut'), 'top');
        tooltips.register(setButton, () => i18n.t('select-toolbar.set'), 'top');
        tooltips.register(addButton, () => i18n.t('select-toolbar.add'), 'top');
        tooltips.register(removeButton, () => i18n.t('select-toolbar.remove'), 'top');
        tooltips.register(intersectButton, () => i18n.t('select-toolbar.intersect'), 'top');

        this.activate = () => {
            this.active = true;
            scene.add(box);
            // a volume that is not over its target (first use, or the model moved since)
            // would make "set" select nothing, which reads as a broken tool
            const target = selectionTargetBound(events, scene);
            if (!userPlaced || (target && !volumeReachesTarget(box.worldBound, target))) {
                fitToTarget();
            }
            // fade the model out while the volume is being placed (exp(-2), the same value the
            // camera-path control uses and what the colour panel shows as transparency -2)
            dimModelForVolumeTool(scene);
            if (gizmo.mode === 'none') {
                gizmo.setMode('translate');
            }
            gizmo.attach(box.pivot);
            updateUI();
            selectToolbar.hidden = false;
        };

        this.deactivate = () => {
            selectToolbar.hidden = true;
            gizmo.detach();
            scene.remove(box);
            this.active = false;
            restoreModelAfterVolumeTool(scene);

            // the volume is transient tool state: drop its ops from history so
            // undo/redo never hits steps that visibly change nothing while the
            // tool is hidden
            events.fire('edit.removeForShape', box);
        };
    }
}

export { BoxSelection };
