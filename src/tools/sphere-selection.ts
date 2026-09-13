import { Button, Container, Element, Label, NumericInput, VectorInput } from '@playcanvas/pcui';
import { Vec3 } from 'playcanvas';

import { selectionTargetSplats, selectionTargetBound, volumeReachesTarget, fitSphereToBound } from './shape-fit';
import { ShapeGizmoMode, ShapeTransformGizmo } from './shape-transform-gizmo';
import { dimModelForVolumeTool, restoreModelAfterVolumeTool } from './volume-dim';
import { ShapeTransformOp } from '../core/edit-ops';
import { Events } from '../core/events';
import { ShortcutManager } from '../core/shortcut-manager';
import { Scene } from '../scene/scene';
import { SphereShape } from '../scene/sphere-shape';
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

class SphereSelection {
    activate: () => void;
    deactivate: () => void;
    setTransformMode: (mode: Exclude<ShapeGizmoMode, 'none'>) => boolean;
    getFocus: () => { position: Vec3, radius: number };

    active = false;

    constructor(events: Events, scene: Scene, canvasContainer: Container, tooltips: Tooltips) {
        const sphere = new SphereShape();

        // ui
        const selectToolbar = new Container({
            class: 'select-toolbar',
            hidden: true
        });

        selectToolbar.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
        });

        const translateButton = new Button({ class: 'select-toolbar-mode', icon: 'E111' });
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

        const radiusLabel = new Label({ class: 'select-toolbar-label' });
        i18n.bindText(radiusLabel, 'select-toolbar.radius');

        const radius = new NumericInput({
            precision: 2,
            value: sphere.radius,
            min: 0.01
        });

        selectToolbar.append(translateButton);
        selectToolbar.append(scaleButton);
        selectToolbar.append(new Element({ class: 'select-toolbar-separator' }));
        selectToolbar.append(setButton);
        selectToolbar.append(addButton);
        selectToolbar.append(removeButton);
        selectToolbar.append(intersectButton);
        selectToolbar.append(positionLabel);
        selectToolbar.append(position);
        selectToolbar.append(radiusLabel);
        selectToolbar.append(radius);

        canvasContainer.append(selectToolbar);

        // write the volume's transform into the ui without retriggering the
        // inputs' change handlers
        let uiUpdating = false;
        const updateUI = () => {
            uiUpdating = true;
            const p = sphere.pivot.getPosition();
            position.value = [p.x, p.y, p.z];
            radius.value = sphere.radius;
            uiUpdating = false;
        };

        const syncModeUI = (mode: ShapeGizmoMode) => {
            translateButton.class[mode === 'translate' ? 'add' : 'remove']('active');
            scaleButton.class[mode === 'scale' ? 'add' : 'remove']('active');
        };

        // undo/redo support for volume transforms
        const captureState = () => ({
            position: sphere.pivot.getPosition().clone(),
            radius: sphere.radius
        });

        type SphereState = ReturnType<typeof captureState>;

        // true once the user has positioned the volume themselves (gizmo, inputs or
        // undo/redo), so re-activating the tool keeps their placement instead of
        // re-fitting the volume over the selection
        let userPlaced = false;

        const statesEqual = (a: SphereState, b: SphereState) => {
            return a.position.equals(b.position) && a.radius === b.radius;
        };

        const addOp = (oldState: SphereState, newState: SphereState) => {
            if (!statesEqual(oldState, newState)) {
                // the change is already applied, so suppress the op's do()
                events.fire('edit.add', new ShapeTransformOp({ shape: sphere, oldState, newState }), true);
            }
        };

        // record an undo op for the state change performed by fn
        const recordOp = (fn: () => void) => {
            const oldState = captureState();
            fn();
            userPlaced = true;
            addOp(oldState, captureState());
        };

        let dragState: SphereState | null = null;

        // undo grouping for toolbar-input drags (same pattern as the gizmo):
        // PCUI's pointer-lock slider strips are unreliable in Electron, so
        // value dragging uses pointer-capture; live changes apply on each
        // change event and one undo op is committed on drag end.
        let uiDragState: SphereState | null = null;
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
            rotate: false,
            scaleHandles: 'axes',
            lowerBoundScale: new Vec3(0.02, 0.02, 0.02),
            onTransformStart: () => {
                dragState = captureState();
                userPlaced = true;
            },
            onTransform: (mode) => {
                if (mode === 'scale') {
                    // The sphere's only size parameter is its radius, so whatever handle is dragged
                    // (any of the three axis boxes or the centre box) scales it UNIFORMLY: the
                    // largest component of the pivot's local scale is the one the user just
                    // changed, and the radius setter writes all three axes back to the diameter.
                    //
                    // Before this, the scale gizmo offered only its uniform centre handle, and that
                    // handle turned out to be unusable in practice: it is about 8 px across at the
                    // default gizmo size and drags on it produced no radius change at all (measured
                    // by dragging with real mouse input at seven offsets around the centre - the box
                    // volume, which keeps its axis handles, resized from the same gesture). So the
                    // user could not set the sphere's size with the gizmo at all.
                    const s = sphere.pivot.getLocalScale();
                    sphere.radius = Math.max(s.x, s.y, s.z) * 0.5;
                } else {
                    sphere.moved();
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
            return {
                position: sphere.pivot.getPosition().clone(),
                radius: sphere.radius
            };
        };

        // fit the volume over the current target (the selected splats, or every splat
        // when nothing is selected)
        const fitToTarget = () => {
            const splats = selectionTargetSplats(events, scene);
            const bound = selectionTargetBound(events, scene);
            if (bound) {
                fitSphereToBound(scene, sphere, bound, splats);
                updateUI();
            }
            return !!bound;
        };

        const apply = (op: 'set' | 'add' | 'remove' | 'intersect') => {
            events.fire('select.bySphere', op, sphere.pivot.getWorldTransform().clone());
        };

        translateButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            gizmo.toggleMode('translate');
        });
        scaleButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            gizmo.toggleMode('scale');
        });
        setButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation(); apply('set');
        });
        addButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation(); apply('add');
        });
        removeButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation(); apply('remove');
        });
        intersectButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation(); apply('intersect');
        });
        position.on('change', (v: number[]) => {
            if (!uiUpdating) {
                if (uiDragState) {
                    sphere.pivot.setPosition(v[0], v[1], v[2]);
                    sphere.moved();
                } else {
                    recordOp(() => {
                        sphere.pivot.setPosition(v[0], v[1], v[2]);
                        sphere.moved();
                    });
                }
                gizmo.attach(sphere.pivot);
            }
        });
        radius.on('change', () => {
            if (!uiUpdating) {
                if (uiDragState) {
                    sphere.radius = radius.value;
                } else {
                    recordOp(() => {
                        sphere.radius = radius.value;
                    });
                }
            }
        });

        // replace PCUI's pointer-lock slider strips (dead in Electron) with the
        // reliable pointer-capture drag, and hide the unusable strips.
        position.inputs.forEach((input) => {
            enableReliableInputDrag(input, () => { }, startUiDrag, endUiDrag);
            hidePcuiSliderStrip(input);
        });
        enableReliableInputDrag(radius, () => { }, startUiDrag, endUiDrag);
        hidePcuiSliderStrip(radius);

        events.on('camera.focalPointPicked', (details: { splat: Splat, position: Vec3 }) => {
            if (this.active) {
                recordOp(() => {
                    sphere.pivot.setPosition(details.position);
                    sphere.moved();
                });
                gizmo.attach(sphere.pivot);
                updateUI();
            }
        });

        // refresh the ui when undo/redo changes the volume while the tool is active
        events.on('shapeSelection.changed', (shape: unknown) => {
            if (this.active && shape === sphere) {
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
        tooltips.register(scaleButton, tooltip('tooltip.bottom-toolbar.scale', 'tool.scaleShortcut'), 'top');
        tooltips.register(setButton, () => i18n.t('select-toolbar.set'), 'top');
        tooltips.register(addButton, () => i18n.t('select-toolbar.add'), 'top');
        tooltips.register(removeButton, () => i18n.t('select-toolbar.remove'), 'top');
        tooltips.register(intersectButton, () => i18n.t('select-toolbar.intersect'), 'top');

        this.activate = () => {
            this.active = true;
            scene.add(sphere);
            // a volume that is not over its target (first use, or the model moved since)
            // would make "set" select nothing, which reads as a broken tool
            const target = selectionTargetBound(events, scene);
            if (!userPlaced || (target && !volumeReachesTarget(sphere.worldBound, target))) {
                fitToTarget();
            }
            // fade the model out while the volume is being placed (exp(-2), the same value the
            // camera-path control uses and what the colour panel shows as transparency -2)
            dimModelForVolumeTool(scene);
            if (gizmo.mode === 'none') {
                gizmo.setMode('translate');
            }
            gizmo.attach(sphere.pivot);
            updateUI();
            selectToolbar.hidden = false;
        };

        this.deactivate = () => {
            selectToolbar.hidden = true;
            gizmo.detach();
            scene.remove(sphere);
            this.active = false;
            restoreModelAfterVolumeTool(scene);

            // the volume is transient tool state: drop its ops from history so
            // undo/redo never hits steps that visibly change nothing while the
            // tool is hidden
            events.fire('edit.removeForShape', sphere);
        };
    }
}

export { SphereSelection };
