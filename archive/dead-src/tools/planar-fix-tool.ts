import { Container, Label } from '@playcanvas/pcui';
import {
    Entity, Mat4, Quat, RotateGizmo, ScaleGizmo, TranslateGizmo, Vec3
} from 'playcanvas';

import { Events } from '../events';
import { PlanarFixSession } from '../geometry/planar-fix';
import { PlanarFixBox } from '../planar-fix-box';
import { Scene } from '../scene';
import { Splat } from '../splat';
import { Transform } from '../transform';
import { i18n } from '../ui/localization';

type GizmoMode = 'translate' | 'rotate' | 'scale';

/**
 * Planar-fix tool — box paradigm.
 *
 * Clicking the planar-fix icon creates an oriented BOX on the selected splat.
 * The box's largest faces are the **base** (green, -Y, reference plane) and the
 * **limit** (red, +Y, slab cap). The user moves / rotates / scales the box so
 * its base face roughly lies on the surface to iron, then:
 *   1. "确认贴合" snaps the base face to the closest best-fit plane.
 *   2. The thickness slider / handle drag moves the limit face (base stays fixed) → slab range.
 *   3. "自动熨平" flattens the detected abnormal splats onto the plane.
 *
 * The box is driven by a Translate/Rotate/Scale gizmo attached to
 * `box.gizmoTarget`. A capsule thickness handle on the +Y face allows quick
 * drag-to-adjust (same pattern as crop-box face handles).
 *
 * An empty transform handler is pushed so the model-move handler never fires
 * while the tool is active.
 */
class PlanarFixTool {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, scene: Scene, parent: HTMLElement, canvasContainer: Container) {
        const box = new PlanarFixBox(scene);

        // ---- gizmos (one per mode) ----
        const gizmoTranslate = new TranslateGizmo(scene.camera.camera, scene.gizmoLayer);
        const gizmoRotate = new RotateGizmo(scene.camera.camera, scene.gizmoLayer);
        const gizmoScale = new ScaleGizmo(scene.camera.camera, scene.gizmoLayer);
        gizmoRotate.rotationMode = 'orbit';
        const gizmos = { translate: gizmoTranslate, rotate: gizmoRotate, scale: gizmoScale };

        // Empty transform handler: while the planar tool is active we never want
        // the model-transform handler (EntityTransformHandler) to react to
        // pivot.moved — dragging the box must not move the whole splat.
        class PlanarTransformHandler {
            activate() {}
            deactivate() {}
        }

        let active = false;
        let splat: Splat | null = null;
        let mode: GizmoMode = 'translate';
        let curGizmo: TranslateGizmo | RotateGizmo | ScaleGizmo = gizmoTranslate;

        const fireSession = () => {
            if (!splat || !active) return;
            const session: PlanarFixSession = box.getSession(splat);
            events.fire('planarfix.sessionChanged', session);
        };

        const attachGizmo = () => {
            curGizmo.detach();
            curGizmo = gizmos[mode];
            curGizmo.attach(box.gizmoTarget);
        };

        const onGizmoTransform = () => {
            box.readFromTarget();
            scene.forceRender = true;
            fireSession();
        };
        for (const g of [gizmoTranslate, gizmoRotate, gizmoScale]) {
            g.on('render:update', () => {
                scene.forceRender = true;
            });
            g.on('transform:start', () => {
                scene.forceRender = true;
            });
            g.on('transform:move', onGizmoTransform);
            g.on('transform:end', onGizmoTransform);
        }

        // per-frame wireframe redraw + handle position update
        const onPrerender = () => {
            box.onPreRender();
        };

        // ---- selection ----
        const setSplat = (s: Splat | null) => {
            splat = s;
            if (active && splat) {
                box.initializeFromSplat(splat);
                attachGizmo();
                fireSession();
                events.fire('planarfix.activated', splat.name);
            }
        };
        events.on('selection.changed', (selection: Splat) => {
            if (active) setSplat(selection);
        });

        // ---- fit to closest plane (step 1 confirm) ----
        const fit = () => {
            if (!splat) return;
            box.fitToClosestPlane(splat);
            scene.forceRender = true;
            fireSession();
            events.fire('planarfix.fitted');
        };

        // ---- thickness / limit face (step 2) ----
        const setThickness = (T: number) => {
            box.setThicknessKeepBase(T);
            scene.forceRender = true;
            fireSession();
            events.fire('planarfix.thicknessChanged', T);
        };

        // ---- gizmo mode switch (from panel) ----
        events.on('planarfix.setMode', (m: GizmoMode) => {
            if (m === mode) return;
            mode = m;
            if (active) attachGizmo();
            events.fire('planarfix.modeChanged', mode);
        });

        events.on('planarfix.fit', fit);
        events.on('planarfix.setThickness', setThickness);

        // ---- thickness handle pointer events (capture phase on canvas) ----
        const canvas = scene.canvas;

        const onCanvasPointerDown = (e: PointerEvent) => {
            if (!active) return;
            // check thickness handle first (before gizmo gets it)
            const startT = box.startHandleDrag(e.clientX, e.clientY);
            if (startT !== null) {
                canvas.style.cursor = 'grabbing';
                e.stopImmediatePropagation();
                e.preventDefault();
            }
        };

        const onWindowPointerMove = (e: PointerEvent) => {
            if (!active) return;
            if (box.isDraggingHandle) {
                const newT = box.moveHandleDrag(e.clientX, e.clientY);
                if (newT !== null) {
                    setThickness(newT);
                }
                e.stopImmediatePropagation();
                e.preventDefault();
            } else {
                // hover highlight
                const hovering = box.hoverHandle(e.clientX, e.clientY);
                canvas.style.cursor = hovering ? 'grab' : '';
            }
        };

        const onWindowPointerUp = (e: PointerEvent) => {
            if (!active) return;
            if (box.isDraggingHandle) {
                box.endHandleDrag();
                // restore cursor (may still be over handle after release)
                const hovering = box.hoverHandle(e.clientX, e.clientY);
                canvas.style.cursor = hovering ? 'grab' : '';
                e.stopImmediatePropagation();
                e.preventDefault();
            }
        };

        canvas.addEventListener('pointerdown', onCanvasPointerDown, true);
        window.addEventListener('pointermove', onWindowPointerMove);
        window.addEventListener('pointerup', onWindowPointerUp);

        // ---- activate / deactivate ----
        this.activate = () => {
            active = true;
            mode = 'translate';
            const sel = events.invoke('selection') as Splat | undefined;
            splat = sel ?? null;
            console.log('[PlanarFix] activate', { splat: splat?.name });
            if (!splat) {
                // nothing selected; still show panel with a hint
                events.fire('planarfix.activated', null);
                return;
            }
            box.add();
            console.log('[PlanarFix] box added, extent:', box._extent);
            box.initializeFromSplat(splat);
            attachGizmo();
            events.on('prerender', onPrerender);
            scene.forceRender = true;
            // suppress model-transform handler
            events.fire('transformHandler.push', new PlanarTransformHandler());
            events.fire('planarfix.activated', splat.name);
            events.fire('planarfix.modeChanged', mode);
            fireSession();
        };

        this.deactivate = () => {
            active = false;
            events.off('prerender', onPrerender);
            curGizmo.detach();
            box.remove();
            splat = null;
            canvas.style.cursor = '';
            scene.forceRender = true;
            events.fire('planarfix.deactivated');
            events.fire('transformHandler.pop');
        };

        // reset after apply
        events.on('planarfix.applied', () => {
            // keep the box; the session is unchanged so the user can re-run
        });
    }
}

export { PlanarFixTool };
