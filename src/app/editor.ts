import { MemoryFileSystem } from '@playcanvas/splat-transform';
import { Asset, Color, GSplatData, GSplatResource, Mat4, path, Quat, Texture, Vec3, Vec4 } from 'playcanvas';

import { serializeGrade, deserializeGrade } from './color-grade-file';
import { EditHistory } from '../core/edit-history';
import { SelectAllOp, SelectNoneOp, SelectInvertOp, SelectOp, SelectRangeOp, HideSelectionOp, UnhideAllOp, DeleteSelectionOp, UndeleteSelectionOp, ResetOp, MultiOp, AddSplatOp, SurfaceRefineOp, EditOp } from '../core/edit-ops';
import { Events } from '../core/events';
import { healInpaint, getSelectedIndices, HealParams } from '../core/heal-inpaint';
import { IndexRanges } from '../core/index-ranges';
import { getDepthSelection, getScreenRange, getScreenSelection } from '../core/selection-flags';
import { detectProblems, applyFix, PlanarFixParams, PlanarFixSession } from '../geometry/planar-fix';
import { semanticSelect } from '../geometry/semantic-select';
import { refineSurface, refineSurfaceLevel2, SurfaceRefineLevel2Params } from '../geometry/surface-refiner';
import { MappedReadFileSystem } from '../io/index';
import { CropBox, CropBoxConfig } from '../scene/crop-box';
import { Element, ElementType } from '../scene/element';
import type { GridPlane } from '../scene/infinite-grid';
import { Scene } from '../scene/scene';
import { selectDepthBand } from '../splat/selection-band';
import { RangeProjectionCache, SelectionRangeRegion, SelectionRangeView, createRangeCache, selectRange, selectRangeFromCache, rangeDistances, screenWindow, tailFractions, vec3Like, viewExtentFromBound, viewExtentFromSplats } from '../splat/selection-range';
import { Splat } from '../splat/splat';
import { writeSplatFile } from '../splat/splat-serialize';
import { State } from '../splat/splat-state';
import { i18n } from '../ui/localization';

const removeExtension = (filename: string) => {
    return filename.substring(0, filename.length - path.getExtension(filename).length);
};

/**
 * 环模式（camera.mode === 'rings'）下"只选表面"的薄壳厚度，按模型自身深度范围取比例。
 * 1% 是拿 93 万点房间扫描（深度范围 ~3m → 3cm 壳）与 13M 合并场景试出来的：
 * 再薄会把同一层表面切掉一半，再厚就等于穿透了。
 */
const SURFACE_SHELL = 0.01;

/** 环模式"表面层"的厚度：模型对角线（2×halfExtents）的百分比，越小越只留最前那一层。 */
const RINGS_SURFACE_PCT = 0.05;

// ---- crop box events (SplatRoom) ------------------------------------------
let _cropBox: CropBox | null = null;

const registerCropBoxEvents = (events: Events, getScene: () => Scene | null) => {
    events.function('cropBox', () => _cropBox);
    events.function('cropBox.getState', () => (_cropBox ? _cropBox.toConfig() : null));
    events.on('cropBox.initialize', () => {
        const scene = getScene();
        if (!scene) return;
        const splats = scene.getElementsByType(ElementType.splat) as Splat[];
        if (!_cropBox) {
            _cropBox = new CropBox(); scene.add(_cropBox);
        }
        const ok = _cropBox.initializeFromSplats(splats);
        if (!ok) _cropBox.setState(new Vec3(0, 0, 0), new Vec3(1, 1, 1), new Quat());
        events.fire('cropBox.changed');
    });
    events.on('cropBox.setVisible', (v: boolean) => {
        if (_cropBox) _cropBox.visible = v;
    });
    events.on('cropBox.setClipping', (v: boolean) => {
        if (_cropBox) _cropBox.enabled = v;
    });
    events.on('cropBox.setPreview', (v: boolean) => {
        if (_cropBox) _cropBox.preview = v;
    });
    events.on('cropBox.setSoftEdge', (v: number) => {
        if (_cropBox) _cropBox.softEdge = v;
    });
    events.on('cropBox.orientToPCA', () => {
        if (!_cropBox) return;
        const scene = getScene(); if (!scene) return;
        _cropBox.orientToPCA(scene.getElementsByType(ElementType.splat) as Splat[]);
    });
    events.function('cropBox.countSplats', () => {
        if (!_cropBox) return { inside: 0, total: 0 };
        const scene = getScene(); if (!scene) return { inside: 0, total: 0 };
        return _cropBox.countSplatsInside(scene.getElementsByType(ElementType.splat) as Splat[]);
    });
    events.on('cropBox.load', (config: CropBoxConfig) => {
        const scene = getScene(); if (!scene) return;
        if (!_cropBox) {
            _cropBox = new CropBox(); scene.add(_cropBox);
        }
        _cropBox.fromConfig(config);
    });
    events.function('cropBox.hasConfig', () => _cropBox !== null);
    events.on('scene.clear', () => {
        const scene = getScene();
        if (_cropBox) {
            if (scene) scene.remove(_cropBox); _cropBox = null;
        }
    });
};

// ---- surface refine events (SplatRoom) ------------------------------------

const registerSurfaceRefineEvents = (events: Events, editHistory: EditHistory, getScene: () => Scene | null) => {
    // ---- apply ----
    events.on('surfaceRefine.apply', async (options: { strength: number; edgeSplit: boolean; removeScatter: boolean }) => {
        console.log('[SurfaceRefine] apply called with', options);
        const scene = getScene();
        if (!scene) {
            console.warn('[SurfaceRefine] scene is null, aborting'); return;
        }

        const splats = scene.getElementsByType(ElementType.splat) as Splat[];
        if (splats.length === 0) {
            console.warn('[SurfaceRefine] no splats in scene, aborting'); return;
        }

        console.log(`[SurfaceRefine] processing ${splats.length} splat(s) with ${splats[0]?.splatData?.numSplats ?? 0} gaussians`);
        events.fire('progressStart', i18n.t('panel.surface-refine.progress'), false);

        try {
            const allOps: SurfaceRefineOp[] = [];

            for (const splat of splats) {
                const device = splat.scene.app.graphicsDevice;

                const undoResource = new GSplatResource(device, splat.splatData);
                const undoAsset = new Asset('surface-undo', 'gsplat', {
                    url: `surface-undo-${Date.now()}-${splat.name || 'splat'}`,
                    filename: splat.name || 'splat'
                });
                undoAsset.resource = undoResource;
                undoAsset.loaded = true;
                undoAsset.loading = false;
                splat.scene.app.assets.add(undoAsset);

                const { asset, result } = await refineSurface(splat, options);
                console.log('[SurfaceRefine] result:', result);

                const op = new SurfaceRefineOp(splat, asset, undoAsset);
                allOps.push(op);

                (op as any).__result = result;
            }

            if (allOps.length === 1) {
                await editHistory.add(allOps[0]);
                events.fire('surfaceRefine.result', (allOps[0] as any).__result);
            } else {
                const multiOp = new MultiOp(allOps);
                await editHistory.add(multiOp);
                for (const op of allOps) {
                    events.fire('surfaceRefine.result', (op as any).__result);
                }
            }

            scene.forceRender = true;
        } catch (err) {
            console.error('Surface refine failed:', err);
            // Surface-refine failing silently looks like "the button does
            // nothing" (no history entry, no visual change). Surface the real
            // error so it can be reported instead of swallowed.
            const stackLines = (err as any)?.stack?.split('\n').slice(0, 6).join('\n') ?? '';
            await events.invoke('showPopup', {
                type: 'error',
                header: i18n.t('panel.surface-refine.title'),
                message: `'${(err as any)?.message ?? err}'\n\n${stackLines}`
            });
        } finally {
            events.fire('progressEnd');
        }
    });

    // ---- Level 2 surface refine: edge smoothing + scatter cleanup ----
    events.on('surfaceRefine.level2', async (params: SurfaceRefineLevel2Params) => {
        const scene = getScene();
        if (!scene) return;
        const splats = scene.getElementsByType(ElementType.splat) as Splat[];
        if (splats.length === 0) return;

        events.fire('startSpinner');
        try {
            const allOps: SurfaceRefineOp[] = [];

            for (const splat of splats) {
                const device = splat.scene.app.graphicsDevice;
                const undoResource = new GSplatResource(device, splat.splatData);
                const undoAsset = new Asset('surface-l2-undo', 'gsplat', {
                    url: `surface-l2-undo-${Date.now()}-${splat.name || 'splat'}`,
                    filename: splat.name || 'splat'
                });
                undoAsset.resource = undoResource;
                undoAsset.loaded = true;
                undoAsset.loading = false;
                splat.scene.app.assets.add(undoAsset);

                const newData = await refineSurfaceLevel2(splat.splatData, params);
                const asset = scene.assetLoader.createGSplatAsset(newData, 'surface-l2.ply');
                const op = new SurfaceRefineOp(splat, asset, undoAsset);
                allOps.push(op);
            }

            if (allOps.length === 1) {
                await editHistory.add(allOps[0]);
            } else {
                await editHistory.add(new MultiOp(allOps));
            }
            scene.forceRender = true;
            events.fire('surfaceRefine.applied');
        } catch (err) {
            console.error('[surfaceRefine.level2] ERROR:', err);
            const stackLines = (err as any)?.stack?.split('\n').slice(0, 6).join('\n') ?? '';
            await events.invoke('showPopup', {
                type: 'error',
                header: i18n.t('panel.surface-refine.level2'),
                message: `'${(err as any)?.message ?? err}'\n\n${stackLines}`
            });
        } finally {
            events.fire('stopSpinner');
        }
    });
};


// register for editor and scene events
const registerEditorEvents = (events: Events, editHistory: EditHistory, scene: Scene) => {
    const vec = new Vec3();
    const vec2 = new Vec3();
    const vec4 = new Vec4();
    const mat = new Mat4();
    const SH_C0 = 0.28209479177387814;

    const decodeColorChannel = (value: number) => {
        return Math.min(1, Math.max(0, 0.5 + value * SH_C0));
    };

    // get the list of selected splats (supports multi-select via Ctrl+Click in scene panel)
    const selectedSplats = () => {
        return (events.invoke('selection.all') as Splat[]) ?? [];
    };

    let lastExportCursor = 0;

    // add unsaved changes warning message.
    window.addEventListener('beforeunload', (e) => {
        if (!events.invoke('scene.dirty')) {
            // if the undo cursor matches last export, then we have no unsaved changes
            return undefined;
        }

        const msg = 'You have unsaved changes. Are you sure you want to leave?';
        e.returnValue = msg;
        return msg;
    });

    // Expose hooks so the Electron main process can show a native
    // "unsaved changes" confirmation when the window close button (X) is clicked.
    // __splatroomIsDirty: returns whether there are unsaved changes.
    // __splatroomRequestSave: saves the document and resolves to whether the
    //   save actually completed (false if the user cancelled the save dialog).
    (window as any).__splatroomIsDirty = () => !!events.invoke('scene.dirty');
    (window as any).__splatroomRequestSave = async () => {
        await events.invoke('doc.save');
        return !events.invoke('scene.dirty');
    };

    events.function('targetSize', () => {
        return scene.targetSize;
    });

    events.on('scene.clear', () => {
        scene.clear();
        editHistory.clear();
        lastExportCursor = 0;
    });

    // When a splat is removed from the scene, remove all edit operations that reference it
    events.on('scene.elementRemoved', (element: Element) => {
        if (element.type === ElementType.splat) {
            // Skip while an undo/redo is executing: AddSplatOp.undo removes the
            // duplicated/separated layer, and purging its op here would kill
            // redo and leak the layer's GPU resources.
            if (!editHistory.isUndoingRedoing()) {
                editHistory.removeForSplat(element as Splat);
            }
        }
    });

    // When a splat is first added, focus the camera on its dense region.
    // Skip if there were already other splats in the scene (undo/redo, merge).
    events.on('scene.elementAdded', (element: Element) => {
        if (element.type === ElementType.splat) {
            const splatCount = scene.getElementsByType(ElementType.splat).length;
            if (splatCount <= 1) {
                scene.camera.focus();
                // 打开模型默认中心模式：重置为 centers 视觉模式并关闭
                // 中心点/环绕叠加（显示模型本体，而非高斯边界/环），
                // 避免持久化的 rings/overlay 偏好影响默认呈现。
                setCameraMode('centers');
                events.fire('camera.setOverlay', false);

                // Adaptive default fly speed: scale with the scene size so the
                // fly camera crosses the scene in ~5 seconds, regardless of
                // whether the model is a 10-unit trinket or a 2000-unit scan.
                // (Fly speed is still user-adjustable afterwards; this only
                // sets the sensible initial value for the newly loaded scene.)
                const bound = scene.bound;
                if (bound && bound.halfExtents.length() > 0) {
                    const diag = bound.halfExtents.length() * 2;
                    const speed = Math.max(0.5, Math.min(30, diag / 5));
                    setFlySpeed(speed);
                }
            }
        }
    });

    events.function('scene.dirty', () => {
        return editHistory.cursor !== lastExportCursor;
    });

    events.on('doc.saved', () => {
        lastExportCursor = editHistory.cursor;
    });

    // force render on some events

    [
        'camera.mode', 'camera.overlay', 'camera.splatSize', 'view.outlineSelection',
        'view.centersUseGaussianColor', 'view.bands', 'camera.bound', 'camera.boundDimensions', 'camera.showPoses',
        'camera.showInfo', 'selection.changed', 'tool.coordSpace', 'cropBox.changed'
    ].forEach((eventName) => {
        events.on(eventName, () => {
            scene.forceRender = true;
        });
    });

    // grid.visible

    const setGridVisible = (visible: boolean) => {
        if (visible !== scene.grid.visible) {
            scene.grid.visible = visible;
            events.fire('grid.visible', visible);
        }
    };

    events.function('grid.visible', () => {
        return scene.grid.visible;
    });

    events.on('grid.setVisible', (visible: boolean) => {
        setGridVisible(visible);
    });

    events.on('grid.toggleVisible', () => {
        setGridVisible(!scene.grid.visible);
    });

    setGridVisible(scene.config.show.grid);

    // grid.plane

    const setGridPlane = (plane: GridPlane) => {
        if (plane !== scene.grid.plane) {
            scene.grid.plane = plane;
            events.fire('grid.plane', plane);
        }
    };

    events.function('grid.plane', () => {
        return scene.grid.plane;
    });

    events.on('grid.setPlane', (plane: GridPlane) => {
        setGridPlane(plane);
    });

    // camera.fovDolly

    let fovDolly = false;

    const setFovDolly = (value: boolean) => {
        if (value !== fovDolly) {
            fovDolly = value;
            events.fire('camera.fovDolly', fovDolly);
        }
    };

    events.function('camera.fovDolly', () => {
        return fovDolly;
    });

    events.on('camera.setFovDolly', (value: boolean) => {
        setFovDolly(value);
    });

    // camera.fov

    const setCameraFov = (fov: number) => {
        const { camera } = scene;
        if (fov !== camera.fov) {
            const oldFovFactor = camera.fovFactor;
            camera.fov = fov;

            // by default a fov change acts like a lens zoom: scale distance so
            // the camera's world-space offset from the focal point (distance *
            // sceneRadius / fovFactor) is unchanged. with auto-dolly enabled
            // the camera moves instead, preserving the subject's framing.
            if (!fovDolly) {
                const { controls } = scene.config;
                const k = camera.fovFactor / oldFovFactor;
                const t = camera.distanceTween;
                for (const s of [t.value, t.source, t.target]) {
                    s.distance = Math.max(controls.minZoom, Math.min(controls.maxZoom, s.distance * k));
                }
            }

            events.fire('camera.fov', camera.fov);
        }
    };

    events.function('camera.fov', () => {
        return scene.camera.fov;
    });

    events.on('camera.setFov', (fov: number) => {
        setCameraFov(fov);
    });

    // camera.tonemapping

    events.function('camera.tonemapping', () => {
        return scene.camera.tonemapping;
    });

    events.on('camera.setTonemapping', (value: string) => {
        scene.camera.tonemapping = value;
    });

    // camera.bound

    let bound = scene.config.show.bound;

    const setBoundVisible = (visible: boolean) => {
        if (visible !== bound) {
            bound = visible;
            events.fire('camera.bound', bound);
        }
    };

    events.function('camera.bound', () => {
        return bound;
    });

    events.on('camera.setBound', (value: boolean) => {
        setBoundVisible(value);
    });

    events.on('camera.toggleBound', () => {
        setBoundVisible(!events.invoke('camera.bound'));
    });

    // camera.boundDimensions

    let boundDimensions = scene.config.show.boundDimensions;

    const setBoundDimensionsVisible = (visible: boolean) => {
        if (visible !== boundDimensions) {
            boundDimensions = visible;
            events.fire('camera.boundDimensions', boundDimensions);
        }
    };

    events.function('camera.boundDimensions', () => {
        return boundDimensions;
    });

    events.on('camera.setBoundDimensions', (value: boolean) => {
        setBoundDimensionsVisible(value);
    });

    events.on('camera.toggleBoundDimensions', () => {
        setBoundDimensionsVisible(!events.invoke('camera.boundDimensions'));
    });

    // camera.showPoses

    let showPoses = scene.config.show.cameraPoses;

    const setShowPoses = (visible: boolean) => {
        if (visible !== showPoses) {
            showPoses = visible;
            events.fire('camera.showPoses', showPoses);
        }
    };

    events.function('camera.showPoses', () => {
        return showPoses;
    });

    events.on('camera.setShowPoses', (value: boolean) => {
        setShowPoses(value);
    });

    events.on('camera.toggleShowPoses', () => {
        setShowPoses(!events.invoke('camera.showPoses'));
    });

    // camera.showInfo

    let showInfo = scene.config.show.cameraInfo;

    const setShowInfo = (visible: boolean) => {
        if (visible !== showInfo) {
            showInfo = visible;
            events.fire('camera.showInfo', showInfo);
        }
    };

    events.function('camera.showInfo', () => {
        return showInfo;
    });

    events.on('camera.setShowInfo', (value: boolean) => {
        setShowInfo(value);
    });

    events.on('camera.toggleShowInfo', () => {
        setShowInfo(!events.invoke('camera.showInfo'));
    });

    // camera.focus

    events.on('camera.focus', () => {
        // Exit Camera View Mode so focus takes effect on the viewport camera
        scene.camera.cameraViewMode = false;

        // a tool with its own volume (sphere/box selection) frames that instead
        // of the selection bound
        const toolFocus = events.invoke('tool.focus') as { position: Vec3, radius: number } | null;
        if (toolFocus) {
            scene.camera.focus({ focalPoint: toolFocus.position, radius: toolFocus.radius, speed: 1 });
            return;
        }

        const splats = selectedSplats();
        if (splats.length === 0) {
            scene.camera.focus();
            return;
        }
        const splat = splats[0];

        // if selected splats are in a group, use the group's combined center
        const group = scene.groupManager.getForSplat(splat);
        if (group && group.size > 1) {
            const fp = group.focalPoint;
            const br = group.radius;
            scene.camera.focus({
                focalPoint: fp,
                radius: br,
                speed: 1
            });
            return;
        }

        // Focal point = density-weighted center, radius = full bounding box.
        const boundR = splat.worldBound.halfExtents.length();
        scene.camera.focus({
            focalPoint: splat.focalPoint(),
            radius: boundR,
            speed: 1
        });
    });

    events.on('camera.reset', () => {
        const camera = scene.camera;

        // Exit Camera View Mode so reset takes effect on the viewport camera
        camera.cameraViewMode = false;

        if ((camera.controlMode === 'fly' || camera.controlMode === 'walk') && camera.flyEntryPose) {
            // Fly/walk mode: restore the snapshot captured when entering the mode
            const pose = camera.flyEntryPose;
            if (camera.controlMode === 'walk') camera.exitWalk();
            camera.setFocalPoint(pose.focalPoint, 1);
            camera.setAzimElev(pose.azim, pose.elev, 1);
            camera.setDistance(pose.distance, 1);
        } else {
            // Orbit mode (or no snapshot yet): reset to front-facing view
            const { initialZoom } = scene.config.controls;
            camera.setFocalPoint(new Vec3(0, 0, 0), 1);
            camera.setAzimElev(0, 0, 1);
            camera.setDistance(initialZoom, 1);
        }
    });

    // handle camera align events
    events.on('camera.align', (axis: string) => {
        scene.camera.cameraViewMode = false;
        switch (axis) {
            case 'px': scene.camera.setAzimElev(90, 0); break;
            case 'py': scene.camera.setAzimElev(0, -90); break;
            case 'pz': scene.camera.setAzimElev(0, 0); break;
            case 'nx': scene.camera.setAzimElev(270, 0); break;
            case 'ny': scene.camera.setAzimElev(0, 90); break;
            case 'nz': scene.camera.setAzimElev(180, 0); break;
        }

        // switch to ortho mode
        scene.camera.ortho = true;

        // Re-fit the model into the ortho view, centered on the CURRENT focal
        // point (the point the user is orbiting around 鈥?their "focus"), not
        // the raw scene AABB center. Without this the perspective zoom distance
        // carries over into orthoHeight (model looks tiny / off-screen), and the
        // view centers on the wrong point. focus() preserves the axial view just
        // set and only recomputes distance + refocuses on the existing pivot.
        const focusPoint = scene.camera.focalPoint.clone();
        const bound = scene.bound;
        const radius = bound.halfExtents.length();
        scene.camera.focus({
            focalPoint: focusPoint,
            radius: radius > 0 ? radius : 1,
            speed: 0
        });
    });

    // returns true if the selected splat has selected gaussians
    events.function('selection.splats', () => {
        const splat = events.invoke('selection') as Splat;
        return splat?.numSelected > 0;
    });

    // check if the selected splat has any gaussians that are both selected AND deleted
    events.function('selection.hasDeletedSelected', () => {
        const splat = events.invoke('selection') as Splat;
        if (!splat) return false;
        const state = splat.splatData.getProp('state') as Uint8Array;
        for (let i = 0; i < state.length; i++) {
            if (state[i] === (State.selected | State.deleted)) return true;
        }
        return false;
    });

    // returns true if multiple splats are selected (for group operations)
    events.function('selection.hasMultiple', () => {
        const sel = events.invoke('selection.all') as Splat[];
        return sel.length > 1;
    });

    // returns true if any selected splat is already in a group
    events.function('group.hasActive', () => {
        const sel = events.invoke('selection.all') as Splat[];
        if (sel.length === 0) return false;
        for (const s of sel) {
            if (scene.groupManager.getForSplat(s)) return true;
        }
        return false;
    });

    // returns true if GroupRenderer is currently active (rendering a merged entity)
    events.function('groupRenderer.isActive', () => {
        return scene.groupRenderer.isActive;
    });

    // toggle group: create or remove group for selected splats
    events.on('scene.group.toggle', () => {
        const sel = events.invoke('selection.all') as Splat[];
        if (sel.length === 0) return;

        // check if these exact splats already form a group (for unbind)
        const exactGroup = scene.groupManager.getForSplats(sel);
        if (exactGroup) {
            scene.groupRenderer.setGroup(null);
            scene.groupManager.remove(exactGroup);
            scene.forceRender = true;
            return;
        }

        // if only one splat selected and it's part of a group, unbind that group
        if (sel.length === 1) {
            const singleGroup = scene.groupManager.getForSplat(sel[0]);
            if (singleGroup) {
                scene.groupRenderer.setGroup(null);
                scene.groupManager.remove(singleGroup);
                scene.forceRender = true;
                return;
            }
        }

        // need at least 2 splats to create a group
        if (sel.length < 2) return;

        // remove any splats that are already in other groups
        for (const s of sel) {
            scene.groupManager.removeSplatFromAll(s);
        }
        scene.groupRenderer.setGroup(null); // clear old group first
        const newGroup = scene.groupManager.create(sel);
        scene.groupRenderer.setGroup(newGroup);
        scene.forceRender = true;

        // Update camera focal point to group's joint center so orbit
        // rotates around the unified center, not individual splat centers.
        const fp = newGroup.focalPoint;
        const r = newGroup.radius;
        scene.camera.focus({
            focalPoint: fp,
            radius: r,
            speed: 1
        });
    });

    // when a group is removed by the manager (e.g. element removed), clean up renderer
    events.on('group.removed', () => {
        scene.groupRenderer.setGroup(null);
    });

    // merge selected splats into a single new model
    events.on('scene.group.merge', async () => {
        const sel = events.invoke('selection.all') as Splat[];
        if (sel.length < 2) return;

        // 0. Unbind any active group that contains these splats first.
        // The merged entity replaces the group; leaving stale group state
        // would cause rendering/selection issues.
        const existingGroup = scene.groupManager.getForSplats(sel);
        if (existingGroup) {
            scene.groupRenderer.setGroup(null);
            scene.groupManager.remove(existingGroup);
        } else {
            // Also check each splat individually for partial group membership
            for (const s of sel) {
                const g = scene.groupManager.getForSplat(s);
                if (g) {
                    scene.groupRenderer.setGroup(null);
                    scene.groupManager.remove(g);
                }
            }
        }

        events.fire('startSpinner');
        try {
            // 1. Build merged GSplatData with world-space positions from GroupRenderer
            const gsplatData = scene.groupRenderer.buildMergedGSplatData(sel);

            // 2. Create a new Splat from the merged data
            const asset = scene.assetLoader.createGSplatAsset(gsplatData, 'merged.ply');
            const newSplat = new Splat(asset, new Quat());

            // Transform is identity 鈥?positions are already in world space
            newSplat.entity.setLocalPosition(0, 0, 0);
            newSplat.entity.setLocalRotation(0, 0, 0, 1);
            newSplat.entity.setLocalScale(1, 1, 1);

            // 3. Add new splat to scene
            await scene.add(newSplat);

            // 4. Hide the original splats
            for (const s of sel) {
                s.visible = false;
            }

            // 5. Select the new merged splat
            events.fire('selection.set', newSplat);

            // 6. Focus camera on the merged model
            const bound = newSplat.worldBound;
            if (bound) {
                const center = bound.center.clone();
                const radius = bound.halfExtents.length();
                scene.camera.focus({ focalPoint: center, radius, speed: 1 });
            }
        } finally {
            events.fire('stopSpinner');
        }
    });

    events.on('select.all', () => {
        selectedSplats().forEach((splat) => {
            events.fire('edit.add', new SelectAllOp(splat));
        });
    });

    events.on('select.none', () => {
        selectedSplats().forEach((splat) => {
            events.fire('edit.add', new SelectNoneOp(splat));
        });
    });

    events.on('select.invert', () => {
        selectedSplats().forEach((splat) => {
            events.fire('edit.add', new SelectInvertOp(splat));
        });
    });

    events.on('select.mask', (op: 'add'|'remove'|'set'|'intersect', mask: Uint8Array | Uint32Array) => {
        selectedSplats().forEach((splat) => {
            events.fire('edit.add', new SelectOp(splat, op, mask));
        });
    });

    // ---- selection helpers -------------------------------------------------
    // GPU intersect + fire + release inside one queued task so the gpu readback
    // is ordered relative to other queued history ops (rapid drag + undo,
    // drag-while-camera-settling, etc). Used by the 3D shapes (sphere / box) and
    // the sphere brush; the screen-space tools run on the CPU range pass below.
    const runSelectIntersect = (splat: Splat, op: 'add'|'remove'|'set'|'intersect', options: any) => {
        return scene.commandQueue.enqueue(async () => {
            const data = await scene.dataProcessor.intersect(options, splat);
            // SelectOp consumes `data` synchronously in its constructor
            // (IndexRanges.fromPredicate iterates immediately), so we can
            // return the buffer to the pool as soon as the op is constructed.
            events.fire('edit.add', new SelectOp(splat, op, data));
            scene.dataProcessor.releaseMask(data);
        });
    };

    // transform maps the unit sphere (diameter 1) to world space
    events.on('select.bySphere', async (op: 'add'|'remove'|'set'|'intersect', transform: Mat4) => {
        for (const splat of selectedSplats()) {
            await runSelectIntersect(splat, op, {
                sphere: { transform }
            });
        }
    });

    // transform maps the unit cube (side 1) to world space
    events.on('select.byBox', async (op: 'add'|'remove'|'set'|'intersect', transform: Mat4) => {
        for (const splat of selectedSplats()) {
            await runSelectIntersect(splat, op, {
                box: { transform }
            });
        }
    });

    // ---- sphere brush (V3): depth-aligned 3D paint -------------------------
    // The stroke is sampled into a world-space path: every sample is depth
    // picked in ONE batched pass (camera.intersectMany), its radius is matched
    // to the on-screen brush size at that depth, and a depth discontinuity
    // starts a new subpath (negative radius). The whole path then runs through a
    // single GPU intersect dispatch per splat (capsule test), so a stroke costs
    // one history entry and one readback instead of one per sample.
    events.function('select.bySphereBrush', async (
        op: 'add'|'remove'|'set'|'intersect',
        points: { x: number, y: number, radius: number }[],
        canvas: HTMLCanvasElement,
        thicknessPx = 0
    ) => {
        const splats = selectedSplats();
        if (!splats.length || !points.length) return;

        // snapshot the gesture frame: the stroke canvas may be repainted by a
        // later tool and the camera can move before the queued work runs
        const mask = new Texture(scene.graphicsDevice);
        mask.setSource(canvas);

        const camera = scene.camera;
        const pose = {
            position: camera.mainCamera.getPosition().clone(),
            rotation: camera.mainCamera.getRotation().clone(),
            orthoHeight: camera.camera.orthoHeight,
            near: camera.near,
            far: camera.far
        };
        const pixelScale = camera.worldSizePerPixel(1);
        const ortho = camera.ortho;

        // Brush thickness (the panel's 厚度 slider) arrives in the same unit as the
        // brush radius - css pixels at the stroke's depth - and becomes a world-space
        // slab depth once the stroke's depths are known. The view direction is the
        // stroke's own view axis, so "深度" always means "behind the surface the
        // stroke touched".
        const viewDirVec = pose.rotation.transformVector(Vec3.FORWARD, new Vec3());
        const viewDir = [viewDirVec.x, viewDirVec.y, viewDirVec.z];

        // A brush stroke is usually quick, but the spinner overlay covers the whole
        // viewport and swallows pointer events, so a fast click used to dim the app
        // for no reason (reported as "click, wait a second"): it is only shown once
        // the stroke has actually been running for a moment.
        let spinnerShown = false;
        const spinnerTimer = setTimeout(() => {
            spinnerShown = true;
            events.fire('startSpinner');
        }, 200);
        try {
            // one queued operation reserves the stroke's place in history now
            // and runs the depth picking and the intersect against the same
            // scene state; enqueueing only after the readbacks would let a
            // queued delete/undo apply in between
            await scene.commandQueue.enqueue(async () => {
                const hits = await camera.intersectMany(points, splats, pose);

                const path: number[] = [];
                let previous: { position: Vec3, radius: number } | null = null;
                let depthSum = 0;
                let depthCount = 0;

                for (let i = 0; i < points.length; ++i) {
                    const hit = hits[i];
                    if (!hit) {
                        // the stroke left the surface: the next hit starts a
                        // new subpath so the brush never spans the gap
                        previous = null;
                        continue;
                    }

                    const radius = points[i].radius * pixelScale * (ortho ? 1 : hit.depth);
                    const startsPath = !previous || previous.position.distance(hit.position) > Math.max(previous.radius, radius) * 2;
                    path.push(hit.position.x, hit.position.y, hit.position.z, startsPath ? -radius : radius);
                    previous = { position: hit.position, radius };
                    depthSum += ortho ? 1 : hit.depth;
                    depthCount++;
                }

                if (!path.length) {
                    return;
                }

                // css pixels -> world units at the stroke's own depth, so the slab
                // stays the same thickness on screen as the user zooms
                const meanDepth = depthCount > 0 ? depthSum / depthCount : 1;
                const brushThickness = thicknessPx > 0 ? thicknessPx * pixelScale * meanDepth : 0;

                const pathPoints = new Float32Array(path);
                for (const splat of splats) {
                    const data = await scene.dataProcessor.intersect({
                        sphereBrush: {
                            points: pathPoints,
                            mask,
                            thickness: brushThickness,
                            viewDir
                        }
                    }, splat);
                    // SelectOp consumes `data` synchronously in its constructor
                    events.fire('edit.add', new SelectOp(splat, op, data));
                    scene.dataProcessor.releaseMask(data);
                }
            });
        } finally {
            clearTimeout(spinnerTimer);
            if (spinnerShown) {
                events.fire('stopSpinner');
            }
            mask.destroy();
        }
    });

    // ---- screen selection: 2D region × depth range (V3, 选区深度) ----------
    // Every screen-space gesture (rect / lasso / polygon / 2D brush / click) now runs the
    // same CPU pass: project every splat, keep the ones whose pixel falls inside the 2D
    // region, inside the 左右 / 上下 window, and whose distance along the gesture's view
    // axis lies inside [最近, 最远]. Depth is a percentage of the model's own depth extent;
    // the two screen axes are percentages of the gesture's own box. All three default to
    // the full range, i.e. "穿透整个模型完整选择"; narrowing them carves a box out of it.
    //
    // There is no id pick, no footprint widening and no depth-pass readback any more: the
    // whole test is splat/selection-range.ts, one projection loop per gesture.
    //
    // The gesture is remembered so the three range controls can re-cut it live: select from
    // the front, orbit to the side, drag the handles and the box shrinks along the
    // *gesture's* axes (it does not drift when the camera moves). Any other history op
    // drops it.

    type RangeEntry = {
        splat: Splat;
        op: SelectRangeOp;
        // camera pose captured with the gesture (viewProjection / viewDir / worldTransform…)
        view: SelectionRangeView;
        // the model's depth extent along that pose's view axis, used to re-derive the range
        extent: { min: number, max: number };
        // per-gaussian screen position + depth, captured in the gesture's own pass: a slider push then
        // only re-tests the windows instead of re-projecting 13M points (see RangeProjectionCache)
        cache: RangeProjectionCache | null;
        // where the gaussians actually are along that axis (see tailFractions): the empty tails
        // at both ends get compressed so the first push of 最近 / 最远 already changes the selection
        tails: { near: number, far: number } | null;
        // the same for 左右 / 上下: the gesture box's sparse margins get compressed too
        screenTails: { x: { near: number, far: number } | null, y: { near: number, far: number } | null } | null;
        // selection bits as they were before the gesture, locked rows excluded (that is
        // SelectOp's notion of valid): add / remove / intersect recombine off this
        preMask: Uint8Array;
        opKind: 'add' | 'remove' | 'set' | 'intersect';
    };

    type RangeGesture = {
        region: SelectionRangeRegion;
        // the gesture's own box in device pixels: the 左右 / 上下 percentages are relative to it
        bounds: { x0: number, y0: number, x1: number, y1: number };
        entries: RangeEntry[];
    };

    let rangeGesture: RangeGesture | null = null;
    const rangeOps = new Set<SelectRangeOp>();

    // any other edit invalidates the remembered gesture: its post mask no longer describes
    // the selection. Undo/redo of the gesture's own op keeps it (moving a handle re-applies)
    events.on('edit.apply', (op: EditOp) => {
        if (rangeGesture && !rangeOps.has(op as SelectRangeOp)) {
            rangeGesture = null;
        }
    });

    const poseSnapshot = () => {
        const camera = scene.camera;
        const { width, height } = scene.targetSize;
        const viewProjection = new Mat4().mul2(camera.camera.projectionMatrix, camera.camera.viewMatrix);
        const cameraPosition = camera.mainCamera.getPosition();
        const viewDir = camera.mainCamera.getRotation().transformVector(Vec3.FORWARD, new Vec3());
        return {
            viewProjection: viewProjection.data,
            cameraPosition: vec3Like(cameraPosition),
            viewDir: vec3Like(viewDir),
            width,
            height
        };
    };

    // the model's depth extent along the pose's view axis: the world bound is the cheap
    // path, a per-splat scan the fallback (the WebGPU bound readback returns zeros, see
    // splat.updateLocalBounds, and a degenerate extent would select nothing at all)
    const poseExtent = (splat: Splat, pose: ReturnType<typeof poseSnapshot>) => {
        return viewExtentFromBound(splat.worldBound, pose.cameraPosition, pose.viewDir) ??
            viewExtentFromSplats(splat, splat.worldTransform.data, pose.cameraPosition, pose.viewDir) ??
            { min: 0, max: 1 };
    };

    const rangeCombine = {
        set: (had: boolean, hit: boolean) => hit,
        add: (had: boolean, hit: boolean) => had || hit,
        remove: (had: boolean, hit: boolean) => had && !hit,
        intersect: (had: boolean, hit: boolean) => had && hit
    };

    // the core window (inner handles) in device pixels, spelled for SelectionRangeView: the
    // drawn shape only applies inside it, the band out to the outer handles is rectangular
    const coreScreenWindow = (
        bounds: { x0: number, y0: number, x1: number, y1: number },
        tails: RangeEntry['screenTails']
    ) => {
        const window = screenWindow(bounds, getScreenRange(), tails);
        return {
            coreMinX: window.minX,
            coreMaxX: window.maxX,
            coreMinY: window.minY,
            coreMaxY: window.maxY
        };
    };

    // one entry's view for the current three-axis range: the pose + model transform captured
    // with the gesture, plus the depth window and the two screen windows (outer = what is
    // selected, core = where the drawn shape still applies) derived from it
    const rangeView = (gesture: RangeGesture, entry: RangeEntry): SelectionRangeView => {
        const { near, far } = getDepthSelection();
        return {
            ...entry.view,
            ...rangeDistances(entry.extent.min, entry.extent.max, near, far, entry.tails),
            ...screenWindow(gesture.bounds, getScreenSelection(), entry.screenTails),
            ...coreScreenWindow(gesture.bounds, entry.screenTails),
            ...surfaceWindow(entry)
        };
    };

    // 环模式下"只选表面"现在走 **GPU id 拾取**（V2 的做法，见 runRangeSelection 里的注释），
    // 1% 薄壳那套近似被否掉了（用户实测"会选择过多"）。这个函数保留为空壳，等下次和 keepSurface
    // 一起删掉。
    const surfaceWindow = (entry: RangeEntry) => {
        return {};
    };

    // one entry's post mask for the current range: the 2D hit mask recombined with the
    // selection the gesture started from
    const rangePost = (gesture: RangeGesture, entry: RangeEntry): IndexRanges => {
        const view = rangeView(gesture, entry);
        const mask = entry.cache ?
            selectRangeFromCache(entry.splat, gesture.region, view, entry.cache) :
            selectRange(entry.splat, gesture.region, view);
        const combine = rangeCombine[entry.opKind];
        const preMask = entry.preMask;
        return IndexRanges.fromPredicate(entry.splat.splatData.numSplats, i => combine(preMask[i] !== 0, mask[i] === 255));
    };

    // run a screen gesture: capture the pose, build one op per splat, hand them to history
    const runRangeSelection = async (
        region: SelectionRangeRegion,
        opKind: 'add' | 'remove' | 'set' | 'intersect',
        splats: Splat[],
        bounds: { x0: number, y0: number, x1: number, y1: number }
    ) => {
        if (!splats.length) {
            return;
        }

        // 新手友好：**新的一次框选从整段穿透开始**。范围属于"你正在微调的那一次选择"，上一次留下的
        // 最近/左右 不该悄悄把这一次裁掉（用户实测：框住塔却只选到塔身一半 —— 就是上一轮的滑块值
        // 还在生效）。先清掉旧手势再复位，这样复位事件不会触发一次没用的重切。
        rangeGesture = null;
        events.fire('selection.resetRange');

        const pose = poseSnapshot();
        const { near, far } = getDepthSelection();
        const entries: RangeEntry[] = [];
        const combine = rangeCombine[opKind];

        for (const splat of splats) {
            const state = splat.splatData.getProp('state') as Uint8Array;
            const numSplats = splat.splatData.numSplats;
            if (!state || !numSplats) {
                continue;
            }

            const extent = poseExtent(splat, pose);

            // where the gaussians this gesture sees actually sit — along the view axis and inside the
            // box — in ONE subsampled pass: the sparse tails / margins get compressed so the first
            // push of any block already changes the selection (see tailFractions). On a 13M-splat
            // scene the full-scan version cost 1.5s per gesture; this is ~30ms
            const analyzed = tailFractions(splat, { ...pose, worldTransform: splat.worldTransform.data }, extent, bounds, region);
            const tails = analyzed.depth;
            const screenTails = { x: analyzed.x, y: analyzed.y };

            const distances = rangeDistances(extent.min, extent.max, near, far, tails);
            const view: SelectionRangeView = {
                ...pose,
                worldTransform: splat.worldTransform.data,
                ...distances,
                ...screenWindow(bounds, getScreenSelection(), screenTails),
                ...coreScreenWindow(bounds, screenTails),
                ...surfaceWindow({ extent } as RangeEntry)
            };

            // the selection as it stands, minus locked rows: a hidden splat is locked AND
            // still carries the selected bit (see HideSelectionOp)
            const preMask = new Uint8Array(numSplats);
            for (let i = 0; i < numSplats; i++) {
                if ((state[i] & State.selected) !== 0 && (state[i] & State.locked) === 0) {
                    preMask[i] = 255;
                }
            }

            // the projection cache is filled by this same pass, so later slider pushes are cheap
            const cache = createRangeCache(numSplats);
            const hit = selectRange(splat, region, view, cache);

            // 环模式：**只选"表面能碰到的部分"** —— 对齐 V2 / SuperSplat 的 selection depth 语义：
            // 渲染一次深度 pass（每像素最前表面），只保留落在那层表面前后极薄一带里的高斯。
            // 用的就是 V3 3.8.0 删掉的 selection-band（已从 git 恢复），不是那个没调通的 id 拾取。
            if (events.invoke('camera.mode') === 'rings') {
                const bound = scene.bound;
                const diag = bound ? bound.halfExtents.length() * 2 : 1;
                const thickness = Math.max(1e-6, diag * RINGS_SURFACE_PCT * 0.01);
                scene.camera.depthPrep(splat);
                const step = (bounds.x1 - bounds.x0 + 1) * (bounds.y1 - bounds.y0 + 1) > 400000 ? 4 : 2;
                const columns = Math.floor((bounds.x1 - bounds.x0) / step) + 1;
                const rows = Math.floor((bounds.y1 - bounds.y0) / step) + 1;
                const points: { x: number, y: number }[] = new Array(columns * rows);
                let w = 0;
                for (let row = 0; row < rows; row++) {
                    for (let column = 0; column < columns; column++) {
                        points[w++] = {
                            x: (bounds.x0 + column * step + 0.5) / pose.width,
                            y: (bounds.y0 + row * step + 0.5) / pose.height
                        };
                    }
                }
                const depths = await scene.camera.readDepths(points);
                const frontDepth = (px: number, py: number): number | null => {
                    const column = Math.min(columns - 1, Math.max(0, Math.round((px - bounds.x0) / step)));
                    const row = Math.min(rows - 1, Math.max(0, Math.round((py - bounds.y0) / step)));
                    const value = depths[row * columns + column];
                    return typeof value === 'number' ? value : null;
                };
                const surface = selectDepthBand(splat, {
                    region,
                    frontDepth,
                    viewProjection: pose.viewProjection,
                    worldTransform: splat.worldTransform.data,
                    cameraPosition: pose.cameraPosition,
                    viewDir: pose.viewDir,
                    near: scene.camera.near,
                    far: scene.camera.far,
                    thickness,
                    width: pose.width,
                    height: pose.height
                });
                let analytic = 0;
                let onSurface = 0;
                for (let i = 0; i < numSplats; i++) {
                    if (hit[i] === 255 && surface[i] !== 0) {
                        analytic++;
                        onSurface++;
                    }
                }
                // 用户判断：这个数字可能本来就是对的 —— 深度 pass 记的是"每像素最前的那个高斯"，
                // 一个高斯能盖成百上千像素，所以可见层本来就是"少量、大块"的高斯（93 万点扫描的框内
                // 104,707 个里只留约 100 个）。之前那个"看起来太少就放弃"的保险是基于我的错误假设，
                // 已经去掉；带宽只留一点点容差（RINGS_SURFACE_PCT = 0.05）。
                for (let i = 0; i < numSplats; i++) {
                    if (hit[i] === 255 && surface[i] === 0) {
                        hit[i] = 0;
                    }
                }
                console.log(`[v3] rings surface: kept ${onSurface} of ${analytic} analytic`);
            }
            const pre = IndexRanges.fromPredicate(numSplats, i => preMask[i] !== 0);
            const post = IndexRanges.fromPredicate(numSplats, i => combine(preMask[i] !== 0, hit[i] === 255));

            entries.push({
                splat,
                op: new SelectRangeOp(splat, pre, post),
                view,
                extent,
                cache,
                tails,
                screenTails,
                preMask,
                opKind
            });
        }

        // applied through history so every gesture stays one undo step
        for (const entry of entries) {
            await editHistory.add(entry.op);
        }

        rangeGesture = entries.length ? { region, bounds, entries } : null;
        rangeOps.clear();
        entries.forEach(entry => rangeOps.add(entry.op));
    };

    // live re-cut while one of the three range controls moves. Recomputed as fast as the CPU
    // pass allows and always with the newest values: a drag fires 'change' far faster than a
    // 900k-splat pass finishes, so intermediate values are dropped rather than queued.
    let rangePumpBusy = false;
    let rangePending = false;

    const pumpRange = async () => {
        if (rangePumpBusy) {
            return;
        }
        rangePumpBusy = true;
        try {
            while (rangePending) {
                const gesture = rangeGesture;
                rangePending = false;
                if (!gesture) {
                    continue;
                }
                for (const entry of gesture.entries) {
                    entry.op.setPost(rangePost(gesture, entry));
                    await scene.commandQueue.enqueue(() => entry.op.do());
                }
            }
        } finally {
            rangePumpBusy = false;
        }
    };

    const requestRange = () => {
        if (!rangeGesture) {
            return;
        }
        rangePending = true;
        void pumpRange();
    };

    events.on('selection.depthRange', requestRange);
    events.on('selection.screenRange', requestRange);

    events.function('select.rect', async (op: 'add'|'remove'|'set'|'intersect', rect: { start: { x: number, y: number }, end: { x: number, y: number } }) => {
        const { width, height } = scene.targetSize;
        const px0 = Math.min(rect.start.x, rect.end.x) * width;
        const px1 = Math.max(rect.start.x, rect.end.x) * width;
        const py0 = Math.min(rect.start.y, rect.end.y) * height;
        const py1 = Math.max(rect.start.y, rect.end.y) * height;

        await runRangeSelection(
            { contains: (px, py) => px >= px0 && px <= px1 && py >= py0 && py <= py1 },
            op,
            selectedSplats(),
            { x0: px0, y0: py0, x1: px1, y1: py1 }
        );
    });

    // lasso / polygon / 2D brush strokes: the region is the stroke's own alpha, read out
    // of the canvas ONCE. The old path called getImageData per candidate splat, which on
    // a 931k model meant hundreds of thousands of canvas reads inside the selection loop.
    events.function('select.byMask', async (op: 'add'|'remove'|'set'|'intersect', canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) => {
        const { width, height } = scene.targetSize;
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        const cw = canvas.width;
        const ch = canvas.height;
        const alpha = new Uint8Array(cw * ch);
        // the stroke's bounding box comes out of the same pass: the 左右 / 上下 ranges are
        // percentages of it, so a lasso gets the same "trim what I drew" feel as a rect
        let bx0 = cw - 1;
        let by0 = ch - 1;
        let bx1 = 0;
        let by1 = 0;
        for (let i = 0; i < alpha.length; i++) {
            const a = image.data[i * 4 + 3];
            alpha[i] = a;
            if (a > 0) {
                const px = i % cw;
                const py = (i - px) / cw;
                if (px < bx0) bx0 = px;
                if (px > bx1) bx1 = px;
                if (py < by0) by0 = py;
                if (py > by1) by1 = py;
            }
        }
        const empty = bx1 < bx0 || by1 < by0;

        await runRangeSelection(
            {
                contains: (px, py) => {
                    const mx = Math.floor((px / width) * cw);
                    const my = Math.floor((py / height) * ch);
                    if (mx < 0 || my < 0 || mx >= cw || my >= ch) {
                        return false;
                    }
                    return alpha[my * cw + mx] > 0;
                }
            },
            op,
            selectedSplats(),
            // canvas pixels -> device pixels (the same mapping the region test uses)
            empty ? { x0: 0, y0: 0, x1: 0, y1: 0 } : {
                x0: (bx0 / cw) * width,
                y0: (by0 / ch) * height,
                x1: ((bx1 + 1) / cw) * width,
                y1: ((by1 + 1) / ch) * height
            }
        );
    });

    // ---- L1/L2 语义区域选择（地面 / 水域）----
    // 用 RANSAC 平面检测 + 水域特征把"地面/水面"高斯选中（255 掩码），
    // 复用现有 SelectOp 选区管线；可配合"熨平"（semantic.flatten）。
    events.function('semantic.select', async (region: 'ground' | 'water' | 'both', selectOp: 'add'|'remove'|'set'|'intersect' = 'set') => {
        const splat = events.invoke('selection') as Splat;
        if (!splat) return { ok: false, reason: 'no-selection' } as const;
        const result = await semanticSelect(splat, { region });
        // 掩码 0/1 → 0/255（SelectOp 约定 255 = hit）
        const mask = new Uint8Array(result.selection.length);
        for (let i = 0; i < result.selection.length; i++) {
            mask[i] = result.selection[i] ? 255 : 0;
        }
        events.fire('edit.add', new SelectOp(splat, selectOp, mask));
        return {
            ok: true,
            ground: result.counts.ground,
            water: result.counts.water,
            region
        } as const;
    });

    // 语义地面熨平：识别最大平面后执行 applyFix（整平 + 补漏），
    // 结果直接替换 splat 数据（先做验证用；历史化后续接入）。
    events.function('semantic.flatten', async (options?: { detect?: { distanceTol?: number; iterations?: number; minInliers?: number }; fix?: object }) => {
        const splat = events.invoke('selection') as Splat;
        if (!splat) return { ok: false, reason: 'no-selection' } as const;
        const result = await semanticSelect(splat, {
            region: 'ground',
            flattenGround: true,
            detect: options?.detect,
            fix: options?.fix
        });
        if (!result.fixed) return { ok: false, reason: 'no-plane' } as const;

        // GSplatData → Asset（沿用 surfaceRefine 的 undo/redo 模式）
        const device = splat.scene.app.graphicsDevice;
        const undoResource = new GSplatResource(device, splat.splatData);
        const undoAsset = new Asset('semantic-flatten-undo', 'gsplat', {
            url: `semantic-flatten-undo-${Date.now()}-${splat.name || 'splat'}`,
            filename: splat.name || 'splat'
        });
        undoAsset.resource = undoResource;
        undoAsset.loaded = true;
        undoAsset.loading = false;
        splat.scene.app.assets.add(undoAsset);

        const newResource = new GSplatResource(device, result.fixed);
        const newAsset = new Asset('semantic-flatten-new', 'gsplat', {
            url: `semantic-flatten-new-${Date.now()}-${splat.name || 'splat'}`,
            filename: splat.name || 'splat'
        });
        newAsset.resource = newResource;
        newAsset.loaded = true;
        newAsset.loading = false;
        splat.scene.app.assets.add(newAsset);

        const op = new SurfaceRefineOp(splat, newAsset, undoAsset);
        void editHistory.add(op);
        scene.forceRender = true;

        return {
            ok: true,
            flattened: result.counts.ground,
            fixed: result.fixed
        } as const;
    });

    // a click without a drag: the region is a small box under the cursor (a strict single
    // pixel is too brittle - on a coarse model no splat lands exactly there, and touch
    // input has its own slack), so with the default range the click selects the column
    // through the model that the rect tool would. The depth-range sliders narrow it.
    events.function('select.point', async (op: 'add'|'remove'|'set'|'intersect', point: { x: number, y: number }) => {
        const { width, height } = scene.targetSize;
        const clickX = Math.min(width - 1, Math.max(0, Math.floor(point.x * width)));
        const clickY = Math.min(height - 1, Math.max(0, Math.floor(point.y * height)));
        const slack = 3;

        await runRangeSelection(
            {
                contains: (px, py) => Math.abs(px - clickX) <= slack && Math.abs(py - clickY) <= slack
            },
            op,
            selectedSplats(),
            { x0: clickX - slack, y0: clickY - slack, x1: clickX + slack, y1: clickY + slack }
        );
    });

    // Eyedropper selection with SelectOp so undo/redo and selection state updates remain consistent.
    // Threshold acts as a per-channel absolute difference: 0 only matches identical colors while 1 matches everything.
    // TO DO:
    // -  alternative distance metrics such as HSV.
    // -  alternative UI for threshold, two handles for min/max?
    events.function('select.colorMatch', async (op: 'add'|'remove'|'set'|'intersect', point: { x: number, y: number }, threshold = 0) => {
        const splats = selectedSplats();
        const targetSize = scene.targetSize;
        if (!splats.length || !targetSize || !point) {
            return;
        }

        const { width, height } = targetSize;
        if (!width || !height) {
            return;
        }

        // Clamp normalized coordinates to valid range
        const nx = Math.max(0, Math.min(1, point.x));
        const ny = Math.max(0, Math.min(1, point.y));
        const colorThreshold = Math.min(1, Math.max(0, Number.isFinite(threshold) ? threshold : 0));

        for (const splat of splats) {
            scene.camera.pickPrep(splat, 'set');
            // Use normalized coordinates with minimal size for single pixel pick
            const pickBuffer = await scene.camera.pickRect(nx, ny, 1 / width, 1 / height);
            const pickId = pickBuffer?.[0];
            if (pickId === undefined || pickId === 0xffffffff) {
                continue;
            }

            const reds = splat.splatData.getProp('f_dc_0') as Float32Array;
            const greens = splat.splatData.getProp('f_dc_1') as Float32Array;
            const blues = splat.splatData.getProp('f_dc_2') as Float32Array;
            // validate pickId and color channels exist
            if (!reds || !greens || !blues || pickId < 0 || pickId >= reds.length) {
                continue;
            }
            // decode color channels for the reference pixel
            const refR = decodeColorChannel(reds[pickId]);
            const refG = decodeColorChannel(greens[pickId]);
            const refB = decodeColorChannel(blues[pickId]);

            // materialize hits into an owned mask up front; SelectOp consumes
            // a committed snapshot.
            const numSplats = splat.splatData.numSplats;
            const mask = new Uint8Array(numSplats);
            for (let i = 0; i < numSplats; i++) {
                if (Math.abs(decodeColorChannel(reds[i]) - refR) <= colorThreshold &&
                    Math.abs(decodeColorChannel(greens[i]) - refG) <= colorThreshold &&
                    Math.abs(decodeColorChannel(blues[i]) - refB) <= colorThreshold) {
                    mask[i] = 255;
                }
            }

            events.fire('edit.add', new SelectOp(splat, op, mask));
        }
    });

    events.on('select.hide', () => {
        selectedSplats().forEach((splat) => {
            events.fire('edit.add', new HideSelectionOp(splat));
        });
    });

    events.on('select.unhide', () => {
        const ops = (scene.getElementsByType(ElementType.splat) as Splat[])
        .map(splat => new UnhideAllOp(splat))
        .filter(op => !op.ranges.empty);

        if (ops.length > 0) {
            events.fire('edit.add', ops.length === 1 ? ops[0] : new MultiOp(ops));
        }
    });

    events.on('select.delete', () => {
        // Don't delete gaussians when a point-placing tool is active (backspace deletes its points instead)
        if (['measure', 'orient'].includes(events.invoke('tool.active'))) {
            return;
        }
        // Don't delete gaussians while a polygon selection is in progress (backspace removes the last point instead)
        if (events.invoke('polygonSelection.removeLastPoint')) {
            return;
        }
        selectedSplats().forEach((splat) => {
            editHistory.add(new DeleteSelectionOp(splat));
        });
    });

    // restore (undelete) selected+deleted gaussians
    events.on('edit.undelete', () => {
        selectedSplats().forEach((splat) => {
            editHistory.add(new UndeleteSelectionOp(splat));
        });
    });

    const performSelectionFunc = async (func: 'duplicate' | 'separate') => {
        const splats = selectedSplats();

        const memFs = new MemoryFileSystem();

        await writeSplatFile(splats, {
            maxSHBands: 3,
            selected: true
        }, 'ply', 'output.ply', {}, memFs);

        const data = memFs.results.get('output.ply');

        if (data) {
            const splat = splats[0];

            // wrap PLY in a blob and load it. pass the view rather than the
            // underlying buffer, which is the writer's oversized scratch allocation
            const blob = new Blob([data as BlobPart], { type: 'application/octet-stream' });
            const filename = `${removeExtension(splat.filename)}.ply`;
            const fileSystem = new MappedReadFileSystem();
            fileSystem.addFile(filename, blob);
            const copy = await scene.assetLoader.load(filename, fileSystem);

            if (func === 'separate') {
                // delete the selected gaussians from EVERY source splat (the
                // merged copy holds all of them); a single DeleteSelectionOp
                // would leave the other splats' selections duplicated
                editHistory.add(new MultiOp([
                    ...splats.map(s => new DeleteSelectionOp(s)),
                    new AddSplatOp(scene, copy)
                ]));
            } else {
                editHistory.add(new AddSplatOp(scene, copy));
            }
        }
    };

    // duplicate the current selection
    events.on('edit.duplicate', async () => {
        await performSelectionFunc('duplicate');
    });

    events.on('edit.separate', async () => {
        await performSelectionFunc('separate');
    });

    // ------- clipboard (copy / cut / paste) -------
    // in-memory clipboard stores serialized PLY blob of selected gaussians
    let clipboard: { blob: Blob, filename: string } | null = null;

    // returns true if clipboard has data ready to paste
    events.function('clipboard.has', () => clipboard !== null);

    // copy selected gaussians to in-memory clipboard
    events.on('edit.copy', async () => {
        const splats = selectedSplats();
        if (splats.length === 0) return;

        const splat = splats[0];
        const memFs = new MemoryFileSystem();
        await writeSplatFile(splats, {
            maxSHBands: 3,
            selected: true
        }, 'ply', 'output.ply', {}, memFs);

        const data = memFs.results.get('output.ply');
        if (data) {
            const blob = new Blob([data as BlobPart], { type: 'application/octet-stream' });
            clipboard = {
                blob,
                filename: `${removeExtension(splat.filename)}_copy.ply`
            };
        }
    });

    // cut: copy to clipboard then delete selection
    events.on('edit.cut', async () => {
        const splats = selectedSplats();
        if (splats.length === 0) return;

        // copy first
        const splat = splats[0];
        const memFs = new MemoryFileSystem();
        await writeSplatFile(splats, {
            maxSHBands: 3,
            selected: true
        }, 'ply', 'output.ply', {}, memFs);

        const data = memFs.results.get('output.ply');
        if (data) {
            const blob = new Blob([data as BlobPart], { type: 'application/octet-stream' });
            clipboard = {
                blob,
                filename: `${removeExtension(splat.filename)}_copy.ply`
            };
            // now delete the selection
            editHistory.add(new DeleteSelectionOp(splat));
        }
    });

    // paste: load from clipboard and add to current scene
    events.on('edit.paste', async () => {
        if (!clipboard) return;
        const fileSystem = new MappedReadFileSystem();
        fileSystem.addFile(clipboard.filename, clipboard.blob);
        const copy = await scene.assetLoader.load(clipboard.filename, fileSystem);
        editHistory.add(new AddSplatOp(scene, copy));
    });

    // paste as new scene: create empty scene then paste
    events.on('edit.pasteAsNewScene', async () => {
        if (!clipboard) return;
        // create new empty scene (may prompt for unsaved changes confirmation)
        const result = await events.invoke('doc.new');
        // doc.new returns false if user cancelled the confirmation dialog
        if (result === false) return;
        const fileSystem = new MappedReadFileSystem();
        fileSystem.addFile(clipboard.filename, clipboard.blob);
        const copy = await scene.assetLoader.load(clipboard.filename, fileSystem);
        editHistory.add(new AddSplatOp(scene, copy));
    });

    events.on('scene.reset', () => {
        selectedSplats().forEach((splat) => {
            editHistory.add(new ResetOp(splat));
        });
    });

    // floater removal / cluster filter: one undoable step for every selected model.
    //
    // The caller sends one mask PER MODEL (each is detected against that model's own data) plus
    // whether to delete. Selecting and deleting have to be separate ops in that order:
    // DeleteSelectionOp takes "what is selected" as its input, and the mask is only turned into a
    // selection by the SelectOp before it.
    events.on('floater.apply', (data: { targets: { splat: Splat, mask: Uint8Array }[], remove: boolean, count: number }) => {
        const ops: EditOp[] = [];
        for (const { splat, mask } of data.targets) {
            ops.push(
                new SelectNoneOp(splat),
                new SelectOp(splat, 'add', mask)
            );
            if (data.remove) {
                ops.push(new DeleteSelectionOp(splat));
            }
        }
        if (ops.length) {
            events.fire('edit.add', ops.length === 1 ? ops[0] : new MultiOp(ops));
        }
    });

    // ---- heal tool: depth-limited lasso selection ----
    // Uses ID picking (frontmost splats only) to avoid selecting far-away points
    events.function('heal.select', async (op: 'add'|'remove'|'set'|'intersect', canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) => {
        const depthThreshold = events.invoke('heal.depthThreshold') ?? 0.15;

        for (const splat of selectedSplats()) {
            const mask = context.getImageData(0, 0, canvas.width, canvas.height);

            // calculate mask bounds
            let mx0 = mask.width - 1;
            let my0 = mask.height - 1;
            let mx1 = 0;
            let my1 = 0;
            for (let y = 0; y < mask.height; ++y) {
                for (let x = 0; x < mask.width; ++x) {
                    if (mask.data[(y * mask.width + x) * 4 + 3] === 255) {
                        mx0 = Math.min(mx0, x);
                        my0 = Math.min(my0, y);
                        mx1 = Math.max(mx1, x);
                        my1 = Math.max(my1, y);
                    }
                }
            }

            if (mx1 < mx0 || my1 < my0) continue;

            // Convert mask bounds to normalized coordinates
            const nx0 = mx0 / mask.width;
            const ny0 = my0 / mask.height;
            const nx1 = (mx1 + 1) / mask.width;
            const ny1 = (my1 + 1) / mask.height;
            const nw = nx1 - nx0;
            const nh = ny1 - ny0;

            // Step 1: ID picking for front-most splat depth reference
            scene.camera.pickPrep(splat, 'set');
            const pick = await scene.camera.pickRect(nx0, ny0, nw, nh);

            const { width, height } = scene.targetSize;
            const px = Math.floor(nx0 * width);
            const py = Math.floor(ny0 * height);
            const pw = Math.max(1, Math.ceil((nx0 + nw) * width) - px);
            const ph = Math.max(1, Math.ceil((ny0 + nh) * height) - py);

            // Step 2: Get splat data and camera matrix
            const splatData = splat.splatData;
            const xs = splatData.getProp('x');
            const ys = splatData.getProp('y');
            const zs = splatData.getProp('z');
            const numSplats = splatData.numSplats;
            const stateData = splat.state.data;

            const camEntity = scene.camera.camera;
            mat.mul2(camEntity.camera._viewProjMat, splat.worldTransform);

            // Step 3: Build depth reference map from front-most splats
            // clip.w = -viewSpaceZ = distance along camera forward axis (linear, world units)
            const depthMap = new Float32Array(pw * ph);
            depthMap.fill(Infinity);
            const selected = new Set<number>();

            for (let y = 0; y < ph; ++y) {
                for (let x = 0; x < pw; ++x) {
                    const mx = Math.floor((nx0 + x / width) * mask.width);
                    const my = Math.floor((ny0 + y / height) * mask.height);
                    if (mask.data[(my * mask.width + mx) * 4] === 255) {
                        const id = pick[(ph - 1 - y) * pw + x];
                        if (id !== 0xffffffff && id < numSplats) {
                            selected.add(id);
                            // Compute view-space depth from clip.w
                            vec4.set(xs[id], ys[id], zs[id], 1.0);
                            mat.transformVec4(vec4, vec4);
                            depthMap[y * pw + x] = vec4.w > 0 ? vec4.w : Infinity;
                        }
                    }
                }
            }

            // Step 4: Project ALL non-deleted splats to screen space
            // Select those within the mask AND within depth threshold of front-most
            for (let i = 0; i < numSplats; i++) {
                if (selected.has(i)) continue;
                if ((stateData[i] & 4) !== 0) continue; // skip deleted

                vec4.set(xs[i], ys[i], zs[i], 1.0);
                mat.transformVec4(vec4, vec4);

                if (vec4.w <= 0) continue; // behind camera

                // Screen-space position
                const sx = (vec4.x / vec4.w * 0.5 + 0.5) * width;
                const sy = (-vec4.y / vec4.w * 0.5 + 0.5) * height;

                // Check if within pick rect
                const pickX = Math.floor(sx - px);
                const pickY = Math.floor(sy - py);
                if (pickX < 0 || pickX >= pw || pickY < 0 || pickY >= ph) continue;

                // Check if within mask
                const mx = Math.floor(sx / width * mask.width);
                const my = Math.floor(sy / height * mask.height);
                if (mx < 0 || mx >= mask.width || my < 0 || my >= mask.height) continue;
                if (mask.data[(my * mask.width + mx) * 4] !== 255) continue;

                // Depth check: view-space distance from camera
                const splatDepth = vec4.w;
                const frontDepth = depthMap[pickY * pw + pickX];

                if (frontDepth !== Infinity && (splatDepth - frontDepth) <= depthThreshold) {
                    selected.add(i);
                }
            }

            const sortedIds = new Uint32Array(selected).sort();
            if (sortedIds.length > 0) {
                events.fire('edit.add', new SelectOp(splat, op, sortedIds));
            }
        }
    });

    // ---- heal tool: apply inpainting ----
    events.on('heal.apply', (params: HealParams) => {
        try {
            const splats = selectedSplats();
            if (splats.length === 0) return;

            for (const splat of splats) {
                const selectedIndices = getSelectedIndices(splat);
                if (selectedIndices.length === 0) continue;

                // Generate new splat data via inpainting
                const result = healInpaint(splat, selectedIndices, params);
                if (result.count === 0) continue;

                // Build new GSplatData
                const gsplatData = new GSplatData(result.elements);
                const asset = scene.assetLoader.createGSplatAsset(gsplatData, 'heal-patch.ply');
                const newSplat = new Splat(asset, new Quat());

                // Copy entity transform from source so positions align
                newSplat.entity.setLocalPosition(splat.entity.getLocalPosition());
                newSplat.entity.setLocalRotation(splat.entity.getLocalRotation());
                newSplat.entity.setLocalScale(splat.entity.getLocalScale());

                // Delete selected splats + add new patch splat as single undoable op.
                // The SelectSplatOp at the end re-selects the source splat after
                // AddSplatOp.do() triggers scene.elementAdded (which would otherwise
                // change selection to the patch). It also re-selects the source on
                // undo, after AddSplatOp.undo() removes the patch and the
                // scene.elementRemoved handler may set selection to null.
                const sourceSplat = splat;
                events.fire('edit.add', new MultiOp([
                    new DeleteSelectionOp(sourceSplat),
                    new AddSplatOp(scene, newSplat),
                    {
                        name: 'reselectSource',
                        do: () => {
                            events.fire('selection', sourceSplat);
                        },
                        undo: () => {
                            events.fire('selection', sourceSplat);
                        },
                        destroy: () => {}
                    } as any
                ]));
            }
        } catch (err) {
            console.error('[heal.apply] ERROR:', err);
        }
    });

    // ---- planar-fix tool: box-defined slab, fit a plane, flatten / fill ----
    // The tool builds an oriented BOX on the selected splat and converts it into
    // a PlanarFixSession (splat-local plane + slab thickness + in-plane extents).
    // It streams the session to us via `planarfix.sessionChanged`; detect/apply
    // read the latest stored session.
    let planarSession: PlanarFixSession | null = null;

    events.on('planarfix.sessionChanged', (session: PlanarFixSession) => {
        planarSession = session;
    });

    // detect floaters / uneven splats / holes within the slab (updates panel)
    events.on('planarfix.detect', (params: PlanarFixParams) => {
        const splat = events.invoke('selection') as Splat | undefined;
        const empty = { floating: 0, uneven: 0, holes: 0, candidates: 0 };
        if (!splat || !planarSession) {
            events.fire('planarfix.detected', empty);
            return;
        }
        try {
            const res = detectProblems(splat, planarSession, params);
            events.fire('planarfix.detected', {
                floating: res.floating.length,
                uneven: res.uneven.length,
                holes: res.holes,
                candidates: res.candidates
            });
        } catch (err) {
            console.error('[planarfix.detect] ERROR:', err);
            events.fire('planarfix.detected', empty);
        }
    });

    // apply fix (flatten + fill + optional floater removal) as one undoable op
    events.on('planarfix.apply', async (params: PlanarFixParams) => {
        const splat = events.invoke('selection') as Splat | undefined;
        if (!splat || !planarSession) return;
        events.fire('startSpinner');
        try {
            const device = splat.scene.app.graphicsDevice;

            const undoResource = new GSplatResource(device, splat.splatData);
            const undoAsset = new Asset('planarfix-undo', 'gsplat', {
                url: `planarfix-undo-${Date.now()}-${splat.name || 'splat'}`,
                filename: splat.name || 'splat'
            });
            undoAsset.resource = undoResource;
            undoAsset.loaded = true;
            undoAsset.loading = false;
            splat.scene.app.assets.add(undoAsset);

            const newData = applyFix(splat, planarSession, params);
            const asset = scene.assetLoader.createGSplatAsset(newData, 'planar-fix.ply');
            const op = new SurfaceRefineOp(splat, asset, undoAsset);
            await editHistory.add(op);

            events.fire('planarfix.applied');
        } catch (err) {
            console.error('[planarfix.apply] ERROR:', err);
        } finally {
            events.fire('stopSpinner');
        }
    });

    // camera mode (visual: centers/rings)

    let activeMode = 'centers';

    const setCameraMode = (mode: string) => {
        if (mode !== activeMode) {
            activeMode = mode;
            events.fire('camera.mode', activeMode);
        }
    };

    events.function('camera.mode', () => {
        return activeMode;
    });

    events.on('camera.setMode', (mode: string) => {
        setCameraMode(mode);
    });

    events.on('camera.toggleMode', () => {
        setCameraMode(events.invoke('camera.mode') === 'centers' ? 'rings' : 'centers');
    });

    // camera control mode (orbit / fly / walk)

    let controlMode: 'orbit' | 'fly' | 'walk' = 'orbit';

    const setControlMode = (mode: 'orbit' | 'fly' | 'walk') => {
        if (mode === controlMode) return;
        const cam = scene.camera;
        if (mode === 'fly' || mode === 'walk') {
            // snapshot the current orbit view so reset-camera / exiting back to
            // orbit can restore it later
            cam.flyEntryPose = {
                azim: cam.azim,
                elev: cam.elevation,
                focalPoint: cam.focalPoint.clone(),
                distance: cam.distance
            };
        }
        if (mode === 'walk') {
            // first-person floor traversal at eye height above the scene floor
            const bound = scene.bound;
            const groundY = bound && Number.isFinite(bound.center.y) ?
                bound.center.y - bound.halfExtents.y :
                0;
            const eyeH = Math.max(cam.sceneRadius * 0.04, 0.05);
            cam.prepareWalk(groundY, eyeH);
        } else if (controlMode === 'walk') {
            // leaving walk: re-point orbit at the current first-person pose
            cam.exitWalk();
        } else if (mode === 'orbit') {
            // switching back to orbit: discard any frozen camera position
            // left over from fly-mode look() or auto-rotate, so the camera
            // resumes rotating around the focal point.
            cam.lookCameraPos = null;
        }
        controlMode = mode;
        cam.controlMode = mode;
        events.fire('camera.controlMode', controlMode);
    };

    events.function('camera.controlMode', () => {
        return controlMode;
    });

    events.on('camera.setControlMode', (mode: 'orbit' | 'fly' | 'walk') => {
        setControlMode(mode);
    });

    events.on('camera.toggleControlMode', () => {
        setControlMode(controlMode === 'orbit' ? 'fly' : 'orbit');
    });

    // camera preset views
    events.on('camera.viewFront', () => scene.camera.viewFront());
    events.on('camera.viewBack', () => scene.camera.viewBack());
    events.on('camera.viewLeft', () => scene.camera.viewLeft());
    events.on('camera.viewRight', () => scene.camera.viewRight());
    events.on('camera.viewTop', () => scene.camera.viewTop());
    events.on('camera.viewBottom', () => scene.camera.viewBottom());

    // ---- camera axis step via shortcuts (NumPad) ----
    events.on('camera.headingDecrease', () => scene.camera.adjustHeading(-15));
    events.on('camera.headingIncrease', () => scene.camera.adjustHeading(15));
    events.on('camera.pitchDecrease', () => scene.camera.adjustPitch(-15));
    events.on('camera.pitchIncrease', () => scene.camera.adjustPitch(15));

    // NumPad 5 鈫?reset camera (in addition to Shift+F)
    events.on('camera.resetNumpad', () => events.fire('camera.reset'));

    // ---- camera axis adjustments (heading / pitch) ----
    events.on('camera.adjustHeading', (delta: number) => {
        scene.camera.adjustHeading(delta);
    });

    events.on('camera.adjustPitch', (delta: number) => {
        scene.camera.adjustPitch(delta);
    });

    events.function('camera.getAzimElev', () => {
        const camera = scene.camera;
        return { azim: camera.azim, elev: camera.elevation };
    });

    // camera overlay

    let cameraOverlay = scene.config.camera.overlay;

    const setCameraOverlay = (enabled: boolean) => {
        if (enabled !== cameraOverlay) {
            cameraOverlay = enabled;
            events.fire('camera.overlay', cameraOverlay);
        }
    };

    events.function('camera.overlay', () => {
        return cameraOverlay;
    });

    events.on('camera.setOverlay', (value: boolean) => {
        setCameraOverlay(value);
    });

    events.on('camera.toggleOverlay', () => {
        setCameraOverlay(!events.invoke('camera.overlay'));
    });

    // splat size

    let splatSize = 2;

    const setSplatSize = (value: number) => {
        if (value !== splatSize) {
            splatSize = value;
            events.fire('camera.splatSize', splatSize);
        }
    };

    events.function('camera.splatSize', () => {
        return splatSize;
    });

    events.on('camera.setSplatSize', (value: number) => {
        setSplatSize(value);
    });

    // camera fly speed

    const setFlySpeed = (value: number) => {
        if (value !== scene.camera.flySpeed) {
            scene.camera.flySpeed = value;
            events.fire('camera.flySpeed', value);
        }
    };

    events.function('camera.flySpeed', () => {
        return scene.camera.flySpeed;
    });

    events.on('camera.setFlySpeed', (value: number) => {
        setFlySpeed(value);
    });

    // outline selection

    let outlineSelection = false;

    const setOutlineSelection = (value: boolean) => {
        if (value !== outlineSelection) {
            outlineSelection = value;
            events.fire('view.outlineSelection', outlineSelection);
        }
    };

    events.function('view.outlineSelection', () => {
        return outlineSelection;
    });

    events.on('view.setOutlineSelection', (value: boolean) => {
        setOutlineSelection(value);
    });

    // view spherical harmonic bands

    let viewBands = scene.config.show.shBands;

    const setViewBands = (value: number) => {
        if (value !== viewBands) {
            viewBands = value;
            events.fire('view.bands', viewBands);
        }
    };

    events.function('view.bands', () => {
        return viewBands;
    });

    events.on('view.setBands', (value: number) => {
        setViewBands(value);
    });

    // centers gaussian color toggle
    let centersUseGaussianColor = false;
    events.function('view.centersUseGaussianColor', () => centersUseGaussianColor);
    events.on('view.setCentersUseGaussianColor', (value: boolean) => {
        centersUseGaussianColor = value;
        events.fire('view.centersUseGaussianColor', value);
    });

    events.function('camera.getPose', () => {
        // Always return the viewport camera's actual orbit state. The virtual
        // animation camera is a completely separate entity 鈥?if the user wants
        // to capture keyframes from the animation camera's perspective, they
        // enter Camera View Mode (Numpad 0) and the viewport position/focalPoint
        // will match the animation camera's actual pose.
        const camera = scene.camera;
        const position = camera.position;
        const focalPoint = camera.focalPoint;
        return {
            position: { x: position.x, y: position.y, z: position.z },
            target: { x: focalPoint.x, y: focalPoint.y, z: focalPoint.z },
            fov: camera.fov
        };
    });

    events.on('camera.setPose', (pose: { position: Vec3, target: Vec3, fov?: number }, speed = 1) => {
        // assign fov before setPose so distance is computed using the new fovFactor
        if (pose.fov !== undefined) {
            // pose-driven fov (timeline playback, fly-to-pose) is not a user
            // preference - suspend capture around the notify and the
            // synchronous ui echo it triggers
            events.fire('preferences.suspend');
            try {
                scene.camera.fov = pose.fov;
                events.fire('camera.fov', pose.fov);
            } finally {
                events.fire('preferences.resume');
            }
        }
        scene.camera.setPose(pose.position, pose.target, speed);
    });

    // Virtual animation camera update: drives the animCameraEntity directly
    // with setLocalPosition + lookAt, bypassing the orbit state machine entirely.
    // This is the output side of the spline 鈫?camera pipeline.
    events.on('animCamera.update', (pose: { position: Vec3, target: Vec3, fov?: number }) => {
        const animEntity = scene.animCameraEntity;
        if (!animEntity) return;

        // Guard: skip if position 鈮?target (spline interpolation artifact).
        // The forward vector would be zero-length causing lookAt to produce NaN.
        const pos = pose.position;
        const tgt = pose.target;
        const dx = tgt.x - pos.x;
        const dy = tgt.y - pos.y;
        const dz = tgt.z - pos.z;
        if (dx * dx + dy * dy + dz * dz < 1e-12) return;

        animEntity.setLocalPosition(pos.x, pos.y, pos.z);

        // Use a dynamic up vector to avoid gimbal lock when the forward
        // direction is nearly vertical. PlayCanvas lookAt uses Y-up by default,
        // which causes a 180掳 roll flip when looking straight up/down.
        const forward = new Vec3(dx, dy, dz).normalize();
        const up = Math.abs(forward.y) > 0.99 ? new Vec3(0, 0, 1) : new Vec3(0, 1, 0);
        animEntity.lookAt(tgt.x, tgt.y, tgt.z, up.x, up.y, up.z);

        if (pose.fov !== undefined) {
            animEntity.camera.fov = pose.fov;
            // Also update the viewport camera's fov for consistency with UI
            events.fire('preferences.suspend');
            try {
                scene.camera.fov = pose.fov;
                events.fire('camera.fov', pose.fov);
            } finally {
                events.fire('preferences.resume');
            }
        }
    });

    // Toggle Camera View Mode 鈥?syncs the viewport to the animation camera
    // (like Blender's Numpad 0). Exits on user interaction in controllers.ts.
    events.on('camera.toggleViewMode', () => {
        scene.camera.cameraViewMode = !scene.camera.cameraViewMode;
        events.fire('camera.viewModeChanged', scene.camera.cameraViewMode);
    });

    // hack: fire events to initialize UI
    events.fire('camera.fov', scene.camera.fov);
    events.fire('camera.overlay', cameraOverlay);
    events.fire('view.bands', viewBands);
    events.fire('camera.showInfo', showInfo);

    // doc serialization
    events.function('docSerialize.view', () => {
        const packC = (c: Color) => [c.r, c.g, c.b, c.a];
        return {
            bgColor: packC(events.invoke('bgClr')),
            selectedColor: packC(events.invoke('selectedClr')),
            unselectedColor: packC(events.invoke('unselectedClr')),
            lockedColor: packC(events.invoke('lockedClr')),
            shBands: events.invoke('view.bands'),
            centersSize: events.invoke('camera.splatSize'),
            outlineSelection: events.invoke('view.outlineSelection'),
            showGrid: events.invoke('grid.visible'),
            gridPlane: events.invoke('grid.plane'),
            showBound: events.invoke('camera.bound'),
            showBoundDimensions: events.invoke('camera.boundDimensions'),
            showCameraPoses: events.invoke('camera.showPoses'),
            showCameraInfo: events.invoke('camera.showInfo'),
            flySpeed: events.invoke('camera.flySpeed'),
            fovDolly: events.invoke('camera.fovDolly')
        };
    });

    events.function('docDeserialize.view', (docView: any) => {
        events.fire('setBgClr', new Color(docView.bgColor));
        events.fire('setSelectedClr', new Color(docView.selectedColor));
        events.fire('setUnselectedClr', new Color(docView.unselectedColor));
        events.fire('setLockedClr', new Color(docView.lockedColor));
        events.fire('view.setBands', docView.shBands);
        events.fire('camera.setSplatSize', docView.centersSize);
        events.fire('view.setOutlineSelection', docView.outlineSelection);
        events.fire('grid.setVisible', docView.showGrid);
        events.fire('grid.setPlane', docView.gridPlane ?? 'xz');
        events.fire('camera.setBound', docView.showBound);
        events.fire('camera.setBoundDimensions', docView.showBoundDimensions ?? false);
        events.fire('camera.setShowPoses', docView.showCameraPoses ?? false);
        events.fire('camera.setShowInfo', docView.showCameraInfo ?? false);
        events.fire('camera.setFlySpeed', docView.flySpeed);
        events.fire('camera.setFovDolly', docView.fovDolly ?? false);
    });

    // ---- Color Grade Sidecar Save/Load ----

    // save color grade as .sscg sidecar file
    events.on('grade.save', async () => {
        const splat = selectedSplats()[0];
        if (!splat) return;

        const gradeData = serializeGrade(splat);
        const json = JSON.stringify(gradeData, null, 2);
        const sidecarName = `${splat.filename}.sscg`;
        const blob = new Blob([json], { type: 'application/json' });

        if (window.showSaveFilePicker) {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: sidecarName,
                    types: [{
                        description: 'Color Grade Sidecar',
                        accept: { 'application/json': ['.sscg'] }
                    }]
                });
                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
            } catch (error) {
                if (error.name !== 'AbortError') {
                    console.error('Failed to save color grade:', error);
                }
            }
        } else {
            // fallback: download
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = sidecarName;
            a.click();
            URL.revokeObjectURL(url);
        }
    });

    // load color grade from .sscg sidecar file
    events.on('grade.load', async () => {
        const splat = selectedSplats()[0];
        if (!splat) return;

        if (window.showOpenFilePicker) {
            try {
                const [handle] = await window.showOpenFilePicker({
                    types: [{
                        description: 'Color Grade Sidecar',
                        accept: { 'application/json': ['.sscg'] }
                    }],
                    multiple: false
                });
                const file = await handle.getFile();
                const text = await file.text();
                const gradeData = JSON.parse(text);
                deserializeGrade(splat, gradeData);
                events.fire('splat.tintClr', splat);
            } catch (error) {
                if (error.name !== 'AbortError') {
                    console.error('Failed to load color grade:', error);
                }
            }
        } else {
            // fallback: use file input
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.sscg';
            input.onchange = async () => {
                const file = input.files?.[0];
                if (file) {
                    const text = await file.text();
                    const gradeData = JSON.parse(text);
                    deserializeGrade(splat, gradeData);
                    events.fire('splat.tintClr', splat);
                }
            };
            input.click();
        }
    });

    events.function('grade.canSave', () => {
        return selectedSplats().length > 0;
    });

    events.function('grade.canLoad', () => {
        return selectedSplats().length > 0;
    });
};

export { registerEditorEvents, registerCropBoxEvents, registerSurfaceRefineEvents };
