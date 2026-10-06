import { Button, Container, Label, NumericInput } from '@playcanvas/pcui';
import { Entity, Mat4, Quat, TranslateGizmo, Vec3 } from 'playcanvas';

import { Events } from '../core/events';
import { Scene } from '../scene/scene';
import { ToolOverlay, OverlayWriter } from '../scene/tool-overlay';
import { Splat } from '../splat/splat';
import { Transform } from '../transform/transform';
import { enableReliableInputDrag, hidePcuiSliderStrip } from '../ui/input-drag';
import { i18n } from '../ui/localization';

// pointer movement below this many pixels still counts as a click
const CLICK_TOLERANCE = 4;
const MAX_POINTS = 32;

const mat = new Mat4();
const p = new Vec3();
const p0 = new Vec3();
const p1 = new Vec3();
const nrm = new Vec3();
const u = new Vec3();
const v = new Vec3();

const t = new Transform();

class MeasureTransformHandler {
    activate() {}
    deactivate() {}
}

/** 多边形周长（模型单位，隐式封闭：末点→首点）。 */
const polygonPerimeter = (pts: Vec3[], count: number): number => {
    let sum = 0;
    for (let i = 0; i < count; i++) {
        sum += pts[i].distance(pts[(i + 1) % count]);
    }
    return sum;
};

/** 多边形面积（模型单位²）：Newell 法线 → 平面基 → 鞋带公式。 */
const polygonArea = (pts: Vec3[], count: number): number => {
    if (count < 3) return 0;
    // Newell's method: 平面法线
    nrm.set(0, 0, 0);
    for (let i = 0; i < count; i++) {
        const a = pts[i], b = pts[(i + 1) % count];
        nrm.x += (a.y - b.y) * (a.z + b.z);
        nrm.y += (a.z - b.z) * (a.x + b.x);
        nrm.z += (a.x - b.x) * (a.y + b.y);
    }
    const nl = nrm.length();
    if (nl < 1e-12) return 0; // 共线/退化 → 面积为 0
    nrm.mulScalar(1 / nl);
    // 平面正交基 (u, v) ⊥ 法线
    u.set(1, 0, 0);
    if (Math.abs(nrm.dot(u)) > 0.9) u.set(0, 1, 0);
    v.cross(u, nrm);
    v.normalize();
    u.cross(v, nrm);
    u.normalize();
    // 鞋带公式
    let sum = 0;
    for (let i = 0; i < count; i++) {
        const a = pts[i], b = pts[(i + 1) % count];
        sum += (a.dot(u)) * (b.dot(v)) - (b.dot(u)) * (a.dot(v));
    }
    return Math.abs(sum) * 0.5;
};

class MeasureTool {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, scene: Scene, canvasContainer: Container) {
        // ui
        const hintLabel = new Label({ class: 'select-toolbar-label' });

        const scaleToggle = new Button({ class: 'select-toolbar-button' });
        i18n.bindText(scaleToggle, 'measure.setScale');

        // 比例尺校准行（scaleMode 时显示）
        const scaleHintLabel = new Label({ class: 'select-toolbar-label', hidden: true });
        const scaleInput = new NumericInput({
            width: 70,
            placeholder: 'm',
            precision: 3,
            min: 0.0001,
            value: 1
        });
        const applyScaleButton = new Button({ class: 'select-toolbar-button', enabled: false });
        i18n.bindText(applyScaleButton, 'measure.apply');

        // PCUI's pointer-lock slider strip is unreliable in Electron; use the
        // reliable pointer-capture drag and hide the dead strip.
        enableReliableInputDrag(scaleInput, () => { });
        hidePcuiSliderStrip(scaleInput);

        // 测量结果显示
        const distanceLabel = new Label({ class: 'select-toolbar-label', hidden: true });
        const perimeterLabel = new Label({ class: 'select-toolbar-label', hidden: true });
        const areaLabel = new Label({ class: 'select-toolbar-label', hidden: true });

        const clearButton = new Button({ class: 'select-toolbar-button', enabled: false });
        i18n.bindText(clearButton, 'measure.clear');

        const selectToolbar = new Container({
            class: ['select-toolbar', 'select-toolbar-tool'],
            hidden: true
        });

        selectToolbar.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
        });

        selectToolbar.append(hintLabel);
        selectToolbar.append(scaleToggle);
        selectToolbar.append(scaleHintLabel);
        selectToolbar.append(scaleInput);
        selectToolbar.append(applyScaleButton);
        selectToolbar.append(distanceLabel);
        selectToolbar.append(perimeterLabel);
        selectToolbar.append(areaLabel);
        selectToolbar.append(clearButton);
        canvasContainer.append(selectToolbar);

        const gizmo = new TranslateGizmo(scene.camera.camera, scene.gizmoLayer);
        const entity = new Entity('measureGizmoPivot');
        const transformHandler = new MeasureTransformHandler();

        let active = false;
        let splat: Splat;
        let scaleMode = false;

        // get world space point
        const getPoint = (index: number, result: Vec3) => {
            splat.worldTransform.transformPoint(splat.measurePoints[index], result);
        };

        const getPoint2d = (index: number, result: Vec3) => {
            getPoint(index, result);
            scene.camera.worldToScreen(result, result);
            result.x *= canvasContainer.dom.clientWidth;
            result.y *= canvasContainer.dom.clientHeight;
        };

        // reusable world-space point storage
        const pts: Vec3[] = [];
        for (let i = 0; i < MAX_POINTS; i++) pts.push(new Vec3());

        // the measurement points, edges and polygon fill render in the scene via
        // the shared tool overlay (occluded by gaussians, faint ghost through)
        const overlay = new ToolOverlay();
        overlay.provider = (writer: OverlayWriter) => {
            if (!active || !splat) {
                return;
            }
            const count = splat.measurePoints.length;
            for (let i = 0; i < count; i++) {
                getPoint(i, pts[i]);
                writer.dot(pts[i]);
            }
            for (let i = 0; i < count - 1; i++) {
                writer.segment(pts[i], pts[i + 1]);
            }
            if (count >= 3) {
                writer.segment(pts[count - 1], pts[0]); // 封闭边
                for (let i = 1; i < count - 1; i++) {
                    writer.fill(pts[0], pts[i], pts[i + 1]); // 三角扇填充
                }
            }
        };

        const updateVisuals = () => {
            gizmo.detach();

            if (splat && active && splat.measureSelection >= 0 && splat.measureSelection < splat.measurePoints.length) {
                getPoint(splat.measureSelection, p);
                t.set(p, Quat.IDENTITY, Vec3.ONE);
                events.invoke('pivot').place(t);
                entity.setLocalPosition(p);
                gizmo.attach(entity);
            }

            const count = splat ? splat.measurePoints.length : 0;
            const scale = splat?.measureScale ?? null;
            const unit = splat?.measureScaleUnit ?? 'm';
            const factor = scale ?? 1;
            const noScaleNote = scale === null ? ` (${i18n.t('measure.noScale')})` : '';

            // hint / calibration row
            if (scaleMode) {
                hintLabel.text = i18n.t('measure.scaleHint');
                scaleHintLabel.hidden = true;
                scaleInput.enabled = count >= 1;
                scaleInput.hidden = false;
                applyScaleButton.hidden = false;
                applyScaleButton.enabled = count === 2 && Number(scaleInput.value) > 0;
            } else {
                hintLabel.text = count >= 3 ?
                    i18n.t('measure.hintPolygon') :
                    i18n.t('measure.hint');
                scaleHintLabel.hidden = true;
                scaleInput.hidden = true;
                applyScaleButton.hidden = true;
            }

            distanceLabel.hidden = !(count === 2);
            perimeterLabel.hidden = !(count >= 3);
            areaLabel.hidden = !(count >= 3);

            if (count === 2) {
                getPoint(0, p0);
                getPoint(1, p1);
                const len = p0.distance(p1) * factor;
                distanceLabel.text = `${i18n.t('measure.distance')}: ${len.toFixed(scale !== null ? 2 : 3)} ${unit}${noScaleNote}`;
            }

            if (count >= 3) {
                for (let i = 0; i < count; i++) {
                    getPoint(i, pts[i]);
                }
                const per = polygonPerimeter(pts, count) * factor;
                const area = polygonArea(pts, count) * factor * factor;
                const dec = scale !== null ? 2 : 3;
                perimeterLabel.text = `${i18n.t('measure.perimeter')}: ${per.toFixed(dec)} ${unit}${noScaleNote}`;
                areaLabel.text = `${i18n.t('measure.area')}: ${area.toFixed(dec)} ${unit}²${noScaleNote}`;
            }

            clearButton.enabled = count > 0;
        };

        // ---- 比例尺 ----
        scaleToggle.on('click', () => {
            if (!splat) return;
            scaleMode = !scaleMode;
            if (scaleMode) {
                splat.measurePoints.length = 0;
                splat.measureSelection = -1;
                splat.measureScale = null; // 重新校准前按模型单位显示
            }
            updateVisuals();
            scene.forceRender = true;
        });

        applyScaleButton.on('click', () => {
            if (!splat || splat.measurePoints.length !== 2) return;
            const real = Number(scaleInput.value);
            if (!(real > 0)) return;
            getPoint(0, p0);
            getPoint(1, p1);
            const modelLen = p0.distance(p1);
            if (modelLen < 1e-9) return;
            splat.measureScale = real / modelLen;
            splat.measureScaleUnit = 'm';
            scaleMode = false;
            splat.measurePoints.length = 0;
            splat.measureSelection = -1;
            hintLabel.text = i18n.t('measure.scaleSet', { value: real.toFixed(3) });
            updateVisuals();
            scene.forceRender = true;
        });

        clearButton.on('click', () => {
            if (splat) {
                splat.measurePoints.length = 0;
                splat.measureSelection = -1;
                updateVisuals();
                scene.forceRender = true;
            }
        });

        gizmo.on('render:update', () => {
            scene.forceRender = true;
        });

        gizmo.on('transform:start', () => {
            events.invoke('pivot').start();
        });

        gizmo.on('transform:move', () => {
            events.invoke('pivot').moveTRS(entity.getLocalPosition(), entity.getLocalRotation(), entity.getLocalScale());
        });

        gizmo.on('transform:end', () => {
            events.invoke('pivot').end();
        });

        events.on('selection.changed', (selection: Splat) => {
            splat = selection;
            if (active) {
                // for now we always deactivate the tool so the current transform handler remains in place
                events.fire('tool.deactivate');
            }
        });

        events.on('pivot.started', () => {

        });

        events.on('pivot.moved', () => {
            if (active && splat && splat.measureSelection >= 0 && splat.measureSelection < splat.measurePoints.length) {
                const pivotPos = events.invoke('pivot').transform.position;
                mat.invert(splat.worldTransform);
                mat.transformPoint(pivotPos, splat.measurePoints[splat.measureSelection]);
            }
            scene.forceRender = true;
        });

        events.on('pivot.ended', () => {
            if (active && splat && splat.measureSelection >= 0 && splat.measureSelection < splat.measurePoints.length) {
                updateVisuals();
            }
        });

        events.on('select.delete', () => {
            if (active && splat && splat.measureSelection >= 0 && splat.measureSelection < splat.measurePoints.length) {
                splat.measurePoints.splice(splat.measureSelection, 1);
                splat.measureSelection--;
                updateVisuals();
            }
        });

        const isPrimary = (e: PointerEvent) => {
            return e.pointerType === 'mouse' ? e.button === 0 : e.isPrimary;
        };

        let clicked = false;
        let clickX = 0;
        let clickY = 0;

        const pointerdown = (e: PointerEvent) => {
            if (!clicked && isPrimary(e)) {
                clicked = true;
                clickX = e.offsetX;
                clickY = e.offsetY;
            }
        };

        const pointermove = (e: PointerEvent) => {
            // forgive small jitter between down and up; only a real drag cancels the click
            if (clicked && Math.hypot(e.offsetX - clickX, e.offsetY - clickY) > CLICK_TOLERANCE) {
                clicked = false;
            }
        };

        const pointerup = async (e: PointerEvent) => {
            if (splat && clicked && isPrimary(e)) {
                clicked = false;

                let closestIdx = -1;

                // check for intersection with existing point
                const cameraPos = scene.camera.mainCamera.getPosition();
                const cameraFwd = scene.camera.mainCamera.forward;
                for (let i = 0; i < splat.measurePoints.length; i++) {
                    // ignore points behind the camera (their projection is mirrored)
                    getPoint(i, p);
                    if (p.sub(cameraPos).dot(cameraFwd) <= 0) {
                        continue;
                    }

                    getPoint2d(i, p);

                    if (Math.abs(p.x - clickX) < 8 && Math.abs(p.y - clickY) < 8) {
                        closestIdx = i;
                        break;
                    }
                }

                if (closestIdx >= 0) {
                    splat.measureSelection = closestIdx;
                    updateVisuals();
                    return;
                }

                // place at the pointer-down position: that is where the user aimed
                if (splat.measurePoints.length < MAX_POINTS) {
                    const result = await scene.camera.intersect(clickX / canvasContainer.dom.clientWidth, clickY / canvasContainer.dom.clientHeight);
                    if (result) {
                        mat.invert(splat.worldTransform);
                        mat.transformPoint(result.position, p);
                        splat.measureSelection = splat.measurePoints.length;
                        splat.measurePoints.push(p.clone());
                        updateVisuals();
                    }
                }

                e.preventDefault();
                e.stopPropagation();
            }
        };

        const updateGizmoSize = () => {
            const { camera, canvas } = scene;
            if (camera.ortho) {
                gizmo.size = 1125 / canvas.clientHeight;
            } else {
                gizmo.size = 1200 / Math.max(canvas.clientWidth, canvas.clientHeight);
            }
        };
        updateGizmoSize();
        events.on('camera.resize', updateGizmoSize);
        events.on('camera.ortho', updateGizmoSize);

        this.activate = () => {
            active = true;
            scaleMode = false;
            updateVisuals();
            canvasContainer.dom.addEventListener('pointerdown', pointerdown);
            canvasContainer.dom.addEventListener('pointermove', pointermove);
            canvasContainer.dom.addEventListener('pointerup', pointerup, true);
            selectToolbar.hidden = false;

            events.fire('transformHandler.push', transformHandler);

            scene.add(overlay);

            scene.forceRender = true;
        };

        this.deactivate = () => {
            active = false;
            scaleMode = false;

            scene.remove(overlay);

            updateVisuals();
            canvasContainer.dom.removeEventListener('pointerdown', pointerdown);
            canvasContainer.dom.removeEventListener('pointermove', pointermove);
            canvasContainer.dom.removeEventListener('pointerup', pointerup, true);
            selectToolbar.hidden = true;

            events.fire('transformHandler.pop');

            scene.forceRender = true;
        };
    }
}

export { MeasureTool };
