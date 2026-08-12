/**
 * CompareScene — the comparison workspace.
 *
 * Owns an independent PlayCanvas `Application` (created in compare-app.ts) and
 * renders 2–4 gaussian splat models. Each model lives on its own `Layer` and
 * is drawn by its own `Camera`; the cameras are positioned by ONE shared orbit
 * state so every viewport shows the same viewpoint of a different model.
 *
 * This module is deliberately editor-agnostic: it never imports `Scene`,
 * `Splat`, `Editor` or any core editor symbol. Splats are mounted directly via
 * the raw `gsplat` component (reusing the editor's proven `loadGSplatData` +
 * `GSplatResource` path) so no `Scene` dependency is required.
 */

import {
    Application,
    Asset,
    BoundingBox,
    Color,
    Entity,
    GSplatResource,
    Layer,
    Mat4,
    MeshInstance,
    Quat,
    SORTMODE_CUSTOM,
    Vec3,
    Vec4
} from 'playcanvas';

import { loadGSplatDataAsync, MappedReadFileSystem, validateGSplatData } from '../io';
import { computeRects, CompareLayoutMode, ViewportRect } from './compare-layout';
import { createStatsPanel, StatsPanel, AttrKey } from './compare-stats';
import { createAnalysisOverlay, AnalysisOverlay, AnalysisMode } from './compare-analysis';

export interface CompareModel {
    index: number;
    name: string;
    entity: Entity;
    layer: Layer;
    camera: Entity;
    splatCount: number;
    gsplatData: any;
    rect: ViewportRect;
    labelEl: HTMLDivElement;
    /** AABB centre in world space (used as the orbit pivot for this model). */
    modelCenter: Vec3;
    /** Half-diagonal of the world-space AABB. */
    modelRadius: number;
    /** Per-viewport statistics panel. */
    statsPanel: StatsPanel;
    /** Analysis overlay canvas (2-D heatmap / detection). */
    analysisOverlay: AnalysisOverlay;
    /** Whether this model is currently visible (checkbox in panel). */
    visible: boolean;
}

const MAX_MODELS = 4;

// Replicates scene.ts splatLayer sorting: back-to-front by the AABB corner
// furthest along the camera view direction. GSplat instances rely on this
// custom sort path to update their internal depth-sorted order texture.
const sortCorner = new Vec3();
const specialSort = (instances: MeshInstance[], numInstances: number, cameraPos: Vec3, cameraDir: Vec3) => {
    const distances = new Map<MeshInstance, number>();
    for (let i = 0; i < numInstances; i++) {
        const instance = instances[i];
        const { center, halfExtents } = instance.aabb;
        let maxDist = -Infinity;
        for (let cx = -1; cx <= 1; cx += 2) {
            for (let cy = -1; cy <= 1; cy += 2) {
                for (let cz = -1; cz <= 1; cz += 2) {
                    sortCorner.set(
                        center.x + cx * halfExtents.x,
                        center.y + cy * halfExtents.y,
                        center.z + cz * halfExtents.z
                    );
                    const dist = (sortCorner.x - cameraPos.x) * cameraDir.x +
                                    (sortCorner.y - cameraPos.y) * cameraDir.y +
                                    (sortCorner.z - cameraPos.z) * cameraDir.z;
                    if (dist > maxDist) maxDist = dist;
                }
            }
        }
        distances.set(instance, maxDist);
    }
    instances.sort((a, b) => distances.get(b) - distances.get(a));
};

export class CompareScene {
    readonly app: Application;
    readonly contentRoot: Entity;
    readonly models: CompareModel[] = [];
    /** The 3-D canvas element (exposed for snapshots). */
    readonly canvas: HTMLCanvasElement;

    // ------------------------------------------------------------------
    // Camera state — shared azimuth / elevation / zoom factor.
    // Each model gets its own `modelCenter` + `modelRadius` (computed
    // from its AABB), which are used to place the camera independently
    // so different-sized models appear at the same zoom level.
    // ------------------------------------------------------------------
    private fov = 50;
    private readonly clearColor = new Color(0.10, 0.12, 0.16);

    // ---- current layout ----
    private currentMode: CompareLayoutMode = 'horizontal';
    private currentCount = 2;

    // ---- analysis overlay state ----
    private currentAnalysisMode: AnalysisMode = null;
    private currentAnalysisSensitivity = 25;  // 0-100

    // ---- shared camera parameters ----
    private azimuth = -45;           // deg (editor default initialAzim)
    private elevation = -10;         // deg (editor default initialElev)
    private baseDistance = 4;        // reference distance, scaled per model
    private zoomLevel = 1;           // user zoom multiplier

    // ---- max radius across all models (for uniform zoom) ----
    private maxRadius = 1;

    // ---- input tracking ----
    private activeButton: number | null = null;
    private lastX = 0;
    private lastY = 0;
    private logFrame = 0;

    // double-click detection (manual, fires on second *mousedown* so the user
    // can keep the button held and immediately orbit)
    private lastClickTime = 0;
    private lastClickX = 0;
    private lastClickY = 0;
    private readonly DBL_CLICK_MS = 300;
    private readonly DBL_CLICK_PX = 5;

    constructor(app: Application, canvas: HTMLCanvasElement) {
        this.app = app;
        this.canvas = canvas;
        this.contentRoot = new Entity('compare-content');
        app.root.addChild(this.contentRoot);
        this.bindInput();
        app.on('update', () => this.update());
    }

    // ------------------------------------------------------------------
    // Loading
    // ------------------------------------------------------------------

    /**
     * Load a batch of files (each is the same model from a different source).
     * Appends up to MAX_MODELS total. Returns how many were actually loaded.
     */
    async loadFiles(files: { name: string; blob: Blob }[]): Promise<number> {
        let added = 0;
        for (const f of files) {
            if (this.models.length >= MAX_MODELS) {
                console.warn('[CompareScene] model limit reached (4)');
                break;
            }
            if (await this.loadOne(f.name, f.blob)) {
                added++;
            }
        }
        // Match the layout to the actual number of models loaded so a single
        // model fills the whole viewport (not just the left half of a 2-up grid).
        const targetCount = this.models.length;
        this.applyLayout(targetCount, this.currentMode);
        this.frameAll();
        return added;
    }

    private async loadOne(name: string, blob: Blob): Promise<boolean> {
        try {
            const fs = new MappedReadFileSystem();
            fs.addFile(name, blob);
            const result = await loadGSplatDataAsync(name, fs, false);
            if (!result) return false;

            const { gsplatData, transform } = result;
            validateGSplatData(gsplatData);

            const asset = this.createGSplatAsset(gsplatData, name);

            // NOTE: no asset.ready() needed — PlayCanvas GSplatComponent checks
            // asset.resource directly in _onGSplatAssetAdded() and creates the
            // GSplatInstance synchronously.  Calling asset.ready() here would
            // hang forever because manually setting resource doesn't set
            // asset.loaded = true (the ready callback never fires).

            const index = this.models.length;

            // Each model gets its own layer so each viewport camera only draws
            // one model. Use SORTMODE_CUSTOM so GSplatInstance sorting runs.
            const layer = new Layer({
                name: `compare-splat-${index}`,
                opaqueSortMode: SORTMODE_CUSTOM,
                transparentSortMode: SORTMODE_CUSTOM
            });
            layer.customCalculateSortValues = specialSort;
            this.app.scene.layers.push(layer);
            this.app.scene.layers._update();

            const entity = new Entity(`compare-splat-${index}`);
            entity.addComponent('gsplat', { asset, unified: false } as any);
            if (transform && transform.rotation) {
                entity.setLocalRotation(transform.rotation);
            }
            // Add to scene BEFORE setting layers, matching Splat.add() order.
            this.contentRoot.addChild(entity);
            entity.gsplat.layers = [layer.id];

            const camera = new Entity(`compare-cam-${index}`);
            camera.addComponent('camera', {
                clearColor: this.clearColor.clone(),
                clearColorBuffer: true,
                clearDepthBuffer: true,
                fov: this.fov,
                nearClip: 0.01,
                // farClip must be much larger than the largest model extent —
                // PLY exports can be in the thousands of world units.  1e6
                // covers even the largest captures while staying inside
                // float32 precision.
                farClip: 1000000,
                layers: [layer.id]
            });
            this.app.root.addChild(camera);

            const labelEl = document.createElement('div');
            labelEl.className = 'compare-label';
            labelEl.textContent = name;
            Object.assign(labelEl.style, {
                position: 'absolute',
                padding: '2px 8px',
                background: 'rgba(20,24,30,0.72)',
                color: '#eaeaea',
                font: '12px/1.4 system-ui, sans-serif',
                borderRadius: '4px',
                pointerEvents: 'none',
                zIndex: '101',
                whiteSpace: 'nowrap'
            } as CSSStyleDeclaration);
            document.body.appendChild(labelEl);

            const statsPanel = createStatsPanel(gsplatData, gsplatData.numSplats, name);
            const analysisOverlay = createAnalysisOverlay();

            const inst = entity.gsplat?.instance;
            console.log('[CompareScene] loaded', name,
                'splats=', gsplatData.numSplats,
                'instance=', !!inst,
                'meshInstance=', !!inst?.meshInstance,
                'aabb=', inst?.resource?.aabb?.center?.toString?.() ?? 'none',
                'layerId=', layer.id,
                'camLayers=', camera.camera.layers,
                'camRect=', camera.camera.rect?.toString?.() ?? 'none');

            this.models.push({
                index,
                name,
                entity,
                layer,
                camera,
                splatCount: gsplatData.numSplats,
                gsplatData,
                rect: { x: 0, y: 0, w: 1, h: 1 },
                labelEl,
                statsPanel,
                analysisOverlay,
                modelCenter: new Vec3(0, 0, 0),  // filled by frameAll
                modelRadius: 1,
                visible: true,
            });
            return true;
        } catch (e) {
            console.error('[CompareScene] loadOne failed:', name, e);
            return false;
        }
    }

    private createGSplatAsset(gsplatData: any, filename: string): Asset {
        const asset = new Asset(filename, 'gsplat', {
            url: `compare-local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            filename
        } as any);
        this.app.assets.add(asset);
        asset.resource = new GSplatResource(this.app.graphicsDevice, gsplatData);
        return asset;
    }

    // ------------------------------------------------------------------
    // Layout
    // ------------------------------------------------------------------

    /** Left panel width in pixels; zero when the panel is collapsed. */
    private panelOffsetPx = 0;

    /** Called by ComparePanel when it is collapsed / expanded. */
    setPanelOffset(px: number) {
        this.panelOffsetPx = px;
        this.applyLayout(this.currentCount, this.currentMode);
    }

    /**
     * Sync the active attribute across every stats panel.  Called by
     * ComparePanel when any of the per-viewport tab buttons is clicked.
     */
    setStatsAttribute(key: AttrKey | null) {
        for (const m of this.models) m.statsPanel.setActive(key);
    }

    /** Adjust the camera field of view (updated on all per-model cameras). */
    setFov(deg: number) {
        this.fov = deg;
        for (const m of this.models) {
            if (m.camera.camera) m.camera.camera.fov = deg;
        }
    }

    /** Show or hide a model.  When visibility changes the layout is
     *  recalculated so only the checked models claim viewports. */
    setModelVisibility(index: number, vis: boolean) {
        const m = this.models.find(mm => mm.index === index);
        if (!m || m.visible === vis) return;
        m.visible = vis;
        m.entity.enabled = vis;
        m.camera.enabled = vis;
        // recompute layout for the active count
        const active = this.models.filter(mm => mm.visible);
        const count = active.length > 0 ? active.length : 1;
        this.applyLayout(active.length, this.currentMode);
        this.frameAll();
    }

    /** Enable an analysis overlay on all visible models.
     *  When enabled the 3-D canvas desaturates so the coloured overlay pops. */
    setAnalysisMode(mode: AnalysisMode, sensitivity: number) {
        this.currentAnalysisMode = mode;
        this.currentAnalysisSensitivity = sensitivity;
        this._analysisFrame = 0;

        // desaturate the 3-D canvas while an analysis mode is active so the
        // coloured overlay reads clearly against a neutral background
        if (mode) this.canvas.style.filter = 'saturate(0.05)';
        else this.canvas.style.filter = '';

        for (const m of this.models) {
            if (!m.visible) continue;
            const cam = m.camera.camera;
            if (mode) {
                m.analysisOverlay.show();
                m.analysisOverlay.refresh(
                    mode, sensitivity, m.gsplatData,
                    m.entity.getWorldTransform(),
                    cam.projectionMatrix,
                    cam.viewMatrix,
                    this.canvas,  // source canvas
                    m.rect        // viewport rect in source pixels (normalized)
                );
            } else {
                m.analysisOverlay.hide();
            }
        }
    }

    /** Re-draw analysis overlays for all visible models (called on camera change). */
    private refreshAnalysisOverlays() {
        if (!this.currentAnalysisMode) return;
        this.setAnalysisMode(this.currentAnalysisMode, this.currentAnalysisSensitivity);
    }

    applyLayout(count: number, mode: CompareLayoutMode) {
        this.currentMode = mode;
        this.currentCount = Math.max(1, Math.min(MAX_MODELS, Math.floor(count)));

        const rects = computeRects(this.currentCount, mode);

        // Reserve left-side canvas space for the panel when it is expanded.
        const canvasW = Math.max(1, this.canvas.clientWidth);
        const panelFrac = this.panelOffsetPx / canvasW;
        const availW = 1 - panelFrac;

        // Assign viewports only to visible models, renumbering them 0..N-1
        const visibleModels = this.models.filter(m => m.visible);

        for (const m of this.models) {
            if (!m.visible) {
                m.camera.enabled = false;
                m.labelEl.style.display = 'none';
                m.statsPanel.root.style.display = 'none';
                continue;
            }
            const vi = visibleModels.indexOf(m);
            if (vi < 0 || vi >= this.currentCount) {
                m.camera.enabled = false;
                m.labelEl.style.display = 'none';
                m.statsPanel.root.style.display = 'none';
                continue;
            }
            const r = rects[vi];
            m.rect = {
                x: panelFrac + r.x * availW,
                y: r.y,
                w: r.w * availW,
                h: r.h
            };
            m.camera.enabled = true;
            m.camera.camera.rect = new Vec4(m.rect.x, m.rect.y, m.rect.w, m.rect.h);
            m.labelEl.style.display = '';
        }

        this.layoutLabels();
        this.layoutStatsPanels();
    }

    /** Re-position the per-viewport name labels after a layout/resize change. */
    layoutLabels() {
        const rect = this.canvas.getBoundingClientRect();
        for (const m of this.models) {
            if (m.labelEl.style.display === 'none') continue;
            const px = rect.left + m.rect.x * rect.width + 8;
            // rect.y is bottom-left origin; convert to top-left for the DOM
            const pyTop = rect.top + (1 - m.rect.y - m.rect.h) * rect.height + 8;
            m.labelEl.style.left = `${px}px`;
            m.labelEl.style.top = `${pyTop}px`;
        }
    }

    onResize() {
        this.layoutLabels();
        this.layoutStatsPanels();
    }

    /** Position the per-viewport stats panel.
     *  - horizontal (left/right split): panel at viewport BOTTOM (wide row)
     *  - vertical (top/bottom split) & grid: panel on viewport LEFT (wide row)
     *  All three layouts use the same wide panel — only the position and the
     *  wide-ish dimensions differ. */
    layoutStatsPanels() {
        const rc = this.canvas.getBoundingClientRect();
        const isHorizontal = this.currentMode === 'horizontal';
        for (const m of this.models) {
            if (!m.camera.enabled) {
                m.statsPanel.root.style.display = 'none';
                m.analysisOverlay.hide();
                continue;
            }
            m.statsPanel.root.style.display = '';
            const vpx = rc.left + m.rect.x * rc.width;
            const vw = m.rect.w * rc.width;
            const vh = m.rect.h * rc.height;
            const vpyTop = rc.top + (1 - m.rect.y - m.rect.h) * rc.height;

            // Overlay canvas spans the 3-D viewport region only (not the
            // surrounding UI chrome).  projectPoint() inside the overlay uses
            // a 1:1 NDC→pixel mapping, so the overlay rect must match the
            // model's camera rect for markers to line up with the splat.
            m.analysisOverlay.setRect(vpx, vpyTop, vw, vh);
            if (isHorizontal) {
                // ── horizontal split: panel at bottom, full width ──
                const panelH = Math.min(280, Math.max(180, vh * 0.35));
                m.statsPanel.setRect(vpx, vpyTop + vh - panelH, vw, panelH);
            } else {
                // ── vertical / grid: panel on left, full height ──
                const panelW = Math.min(480, Math.max(360, vw * 0.38));
                m.statsPanel.setRect(vpx, vpyTop, panelW, vh);
            }
            if (this.currentAnalysisMode) m.analysisOverlay.show();
        }
    }

    // ------------------------------------------------------------------
    // Framing
    // ------------------------------------------------------------------

    // ------------------------------------------------------------------
    // Shared camera state (used after alignment — all models share the same
    // world AABB, so a single orbit pose can frame all viewports identically).
    // ------------------------------------------------------------------
    private readonly sharedTarget = new Vec3(0, 0, 0);
    private sharedRadius = 1;

    /** Compute per-model PCA (centroid + principal axes via eigendecomposition),
     *  then ALIGN all models to the reference model: same centroid, same orientation,
     *  same scale.  This handles the "same object captured from different angles" case. */
    frameAll() {
        if (this.models.length === 0) {
            console.log('[CompareScene] frameAll: no models');
            return;
        }

        // ---- 1. Compute PCA for every model (from sampled splat centers) ----
        const pca = this.models.map(m => this.computePCA(m.gsplatData, 2000));
        const validPCA = pca.filter(p => p && isFinite(p.centroid.x));

        if (validPCA.length === 0) return;
        const refPCA = pca.find(p => p && isFinite(p.centroid.x))!;
        const refCenter = refPCA.centroid;
        // refAxes is the eigenvector matrix (3x3) sorted by eigenvalue desc.
        // refValues is the array of eigenvalues sorted desc.

        // ---- 2. For PCA-based scale, use the LARGEST extent (sqrt of largest
        //        eigenvalue) — the longest dimension of the model.  This is
        //        more intuitive than the characteristic radius and gives better
        //        visual scaling for elongated objects (where λ₂, λ₃ are tiny). ----
        const refCharRadius = Math.sqrt(Math.max(refPCA.values[0], 0.001));

        // ---- 3. Align every model (including the reference) to the canonical pose.
        //      Treating the reference as a special case skipped here caused
        //      it to keep whatever transform loadOne gave it (often a data
        //      rotation that subsequent PCA did NOT apply to the others).
        //      For identical files the PCA result is identity, so the
        //      reference ends up with the same transform as the others. ----
        for (let i = 0; i < this.models.length; i++) {
            const m = this.models[i];
            const p = pca[i];
            if (!p || !isFinite(p.centroid.x)) continue;

            // --- Scale: match the largest extent (longest axis) of the reference ---
            const thisCharRadius = Math.sqrt(Math.max(p.values[0], 0.001));
            let uniformScale = refCharRadius / thisCharRadius;
            // Snap scale to 1 if close — prevents identical models from
            // being misaligned due to PCA eigenvalue noise.
            if (Math.abs(uniformScale - 1) < 0.1) uniformScale = 1;

            // --- Rotation: R such that R * p.axes ≈ refPCA.axes ---
            let R = this.computeRotationToMatchAxes(p.axes, p.centroid,
                                                    refPCA.axes, refPCA.centroid);
            // Snap rotation to identity if very close.
            const identityErr = 1 - Math.abs(R.w);
            if (identityErr < 0.1) {
                R = new Quat(0, 0, 0, 1);
                uniformScale = 1;
            }

            // --- Translation: move centroid to refCenter ---
            const scaledLocalCentroid = new Vec3(
                p.centroid.x * uniformScale,
                p.centroid.y * uniformScale,
                p.centroid.z * uniformScale
            );
            const rotatedCentroid = new Vec3();
            R.transformVector(scaledLocalCentroid, rotatedCentroid);
            let newPos = new Vec3(
                refCenter.x - rotatedCentroid.x,
                refCenter.y - rotatedCentroid.y,
                refCenter.z - rotatedCentroid.z
            );

            // Apply initial PCA alignment
            m.entity.setLocalPosition(newPos.x, newPos.y, newPos.z);
            m.entity.setLocalRotation(R);
            m.entity.setLocalScale(uniformScale, uniformScale, uniformScale);

            // ---- 4. Refine with ICP (iterative closest point) ----
            // Skip ICP if PCA already snapped to identity — saves a lot of CPU.
            const skipICP = identityErr < 0.1;
            if (!skipICP) {
                const refPoints = this.sampleSplatPoints(refPCA, refPCA, 400);
                const pPoints = this.sampleSplatPoints(p, p, 400);
                if (refPoints && pPoints) {
                    const refined = this.icpRefine(refPoints, pPoints, 6);
                    if (refined) {
                        let newRot = refined.R.mul(R);
                        const qx = newRot.x, qy = newRot.y, qz = newRot.z, qw = newRot.w;
                        const newIdentityErr = Math.sqrt(
                            qx * qx + qy * qy + qz * qz + (1 - qw) * (1 - qw)
                        );
                        if (newIdentityErr < 0.1) {
                            newRot = new Quat(0, 0, 0, 1);
                        }
                        const sCent = new Vec3(
                            p.centroid.x * uniformScale,
                            p.centroid.y * uniformScale,
                            p.centroid.z * uniformScale
                        );
                        const rotated = new Vec3();
                        newRot.transformVector(sCent, rotated);
                        newPos = new Vec3(
                            refCenter.x - rotated.x,
                            refCenter.y - rotated.y,
                            refCenter.z - rotated.z
                        );
                        m.entity.setLocalPosition(newPos.x, newPos.y, newPos.z);
                        m.entity.setLocalRotation(newRot);
                        console.log('[CompareScene] ICP-refined model', i,
                            'newPos=', newPos.toString(),
                            'R_err=', newIdentityErr.toFixed(3));
                    }
                }
            }

            console.log('[CompareScene] PCA-aligned model', i,
                'pos=', newPos.toString(),
                'scale=', uniformScale.toFixed(3),
                'PCA_R_err=', identityErr.toFixed(3),
                'eigenvalues=', p.values.map(v => v.toFixed(1)).join(','));
        }

        // ---- 4. Update shared camera params ----
        const refHalfDiag = Math.sqrt(
            (refPCA.values[0] + refPCA.values[1] + refPCA.values[2])) || 1;
        this.sharedTarget.copy(refCenter);
        this.sharedRadius = Math.max(1, refHalfDiag);
        this.maxRadius = this.sharedRadius;
        this.baseDistance = this.sharedRadius;
        this.zoomLevel = 1;
        this.azimuth = -45;
        this.elevation = -10;

        for (const m of this.models) {
            m.modelCenter.copy(this.sharedTarget);
            m.modelRadius = this.sharedRadius;
        }

        console.log('[CompareScene] frameAll (PCA) sharedRadius=', this.sharedRadius.toFixed(1),
            'models=', this.models.length,
            'sharedTarget=', this.sharedTarget.toString());
    }

    // ------------------------------------------------------------------
    // PCA on a gsplat point cloud: returns centroid + principal axes
    // (as a rotation matrix) + eigenvalues, sorted by descending value.
    // ------------------------------------------------------------------
    private computePCA(gsplatData: any, maxPoints = 2000): {
        centroid: Vec3;
        axes: number[][];   // 3 eigenvectors, each [x,y,z]
        values: number[];   // 3 eigenvalues
    } | null {
        if (!gsplatData) return null;
        let centers: Float32Array;
        try {
            centers = gsplatData.getCenters();
        } catch (_) {
            return null;
        }
        const total = centers.length / 3;
        if (total === 0) return null;

        // Sample evenly
        const step = Math.max(1, Math.floor(total / maxPoints));
        const n = Math.floor(total / step);

        // Centroid
        let sx = 0, sy = 0, sz = 0;
        for (let i = 0; i < n; i++) {
            const idx = i * step;
            sx += centers[idx * 3];
            sy += centers[idx * 3 + 1];
            sz += centers[idx * 3 + 2];
        }
        const centroid = new Vec3(sx / n, sy / n, sz / n);

        // Covariance
        const m = [0, 0, 0, 0, 0, 0, 0, 0, 0]; // 3x3
        for (let i = 0; i < n; i++) {
            const idx = i * step;
            const x = centers[idx * 3] - centroid.x;
            const y = centers[idx * 3 + 1] - centroid.y;
            const z = centers[idx * 3 + 2] - centroid.z;
            m[0] += x * x; m[1] += x * y; m[2] += x * z;
            m[3] += y * x; m[4] += y * y; m[5] += y * z;
            m[6] += z * x; m[7] += z * y; m[8] += z * z;
        }
        for (let i = 0; i < 9; i++) m[i] /= n;

        // Jacobi eigendecomposition (3x3)
        const { values, vectors } = this.jacobi3(m);
        // values[] are NOT yet sorted; sort indices by descending value
        const indices = [0, 1, 2].sort((a, b) => values[b] - values[a]);
        const sortedValues = indices.map(i => values[i]);
        // vectors is column-major: vectors[i*3 + axis] = axis-component of i-th eigenvector
        const sortedAxes: number[][] = indices.map(i => [
            vectors[i * 3 + 0],
            vectors[i * 3 + 1],
            vectors[i * 3 + 2]
        ]);

        // Sign disambiguation: try both signs of the first axis, pick the one
        // that maximizes |sum of (point . axis)|.  Then derive axis 2 to be in
        // the same hemisphere as the reference's axis 2 (closest to it), and
        // axis 3 = cross(axis1, axis2).
        const dotSum = (axis: number[]) => {
            let s = 0;
            for (let i = 0; i < n; i++) {
                const idx = i * step;
                s += (centers[idx * 3] - centroid.x) * axis[0] +
                     (centers[idx * 3 + 1] - centroid.y) * axis[1] +
                     (centers[idx * 3 + 2] - centroid.z) * axis[2];
            }
            return s;
        };
        if (dotSum(sortedAxes[0]) < 0) {
            sortedAxes[0] = sortedAxes[0].map(v => -v);
        }
        // Third axis = first × second (using the *unsorted* second as a reference,
        // then re-orthonormalize).  If the model is left-handed, flip the third.
        const cross = (a: number[], b: number[]) => [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0]
        ];
        const normalize = (v: number[]) => {
            const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1;
            return [v[0] / len, v[1] / len, v[2] / len];
        };
        let axis3 = normalize(cross(sortedAxes[0], sortedAxes[1]));
        if (dotSum(axis3) < 0) axis3 = axis3.map(v => -v);
        let axis2 = normalize(cross(axis3, sortedAxes[0]));
        sortedAxes[1] = axis2;
        sortedAxes[2] = axis3;

        return { centroid, axes: sortedAxes, values: sortedValues };
    }

    /** 3x3 symmetric Jacobi eigendecomposition. Returns eigenvalues and
     *  eigenvectors (column-major in `vectors`). */
    private jacobi3(m: number[]): { values: number[]; vectors: number[] } {
        const a = [...m];
        let v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
        const maxIter = 30;
        for (let iter = 0; iter < maxIter; iter++) {
            // Find largest off-diagonal
            let p = 0, q = 1;
            let max = Math.abs(a[1]);
            if (Math.abs(a[2]) > max) { p = 0; q = 2; max = Math.abs(a[2]); }
            if (Math.abs(a[5]) > max) { p = 1; q = 2; max = Math.abs(a[5]); }
            if (max < 1e-10) break;
            // Compute Jacobi rotation
            const app = a[p * 3 + p], aqq = a[q * 3 + q], apq = a[p * 3 + q];
            const theta = (aqq - app) / (2 * apq);
            const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
            const c = 1 / Math.sqrt(t * t + 1);
            const s = t * c;
            // Update A: A = J^T A J
            a[p * 3 + p] = app - t * apq;
            a[q * 3 + q] = aqq + t * apq;
            a[p * 3 + q] = 0; a[q * 3 + p] = 0;
            for (let k = 0; k < 3; k++) {
                if (k !== p && k !== q) {
                    const akp = a[k * 3 + p], akq = a[k * 3 + q];
                    a[k * 3 + p] = c * akp - s * akq;
                    a[p * 3 + k] = a[k * 3 + p];
                    a[k * 3 + q] = s * akp + c * akq;
                    a[q * 3 + k] = a[k * 3 + q];
                }
            }
            // Update V: V = V J
            for (let k = 0; k < 3; k++) {
                const vkp = v[k * 3 + p], vkq = v[k * 3 + q];
                v[k * 3 + p] = c * vkp - s * vkq;
                v[k * 3 + q] = s * vkp + c * vkq;
            }
        }
        return { values: [a[0], a[4], a[8]], vectors: v };
    }

    /** Compute a rotation R such that R * (p - p.centroid) ≈ ref - ref.centroid
     *  (with sign-disambiguated axes so R is closest to identity).  Returns Quat. */
    private computeRotationToMatchAxes(
        pAxes: number[][], _pCentroid: Vec3,
        refAxes: number[][], _refCentroid: Vec3
    ): Quat {
        // For each axis, choose the sign of pAxes[i] that aligns best with refAxes[i].
        // Then R = refAxes * (signed-pAxes)^T
        const signed: number[][] = pAxes.map((axis, i) => {
            const dot = axis[0] * refAxes[i][0] + axis[1] * refAxes[i][1] + axis[2] * refAxes[i][2];
            return dot < 0 ? axis.map(v => -v) : axis;
        });
        // R[i][j] = sum_k refAxes[i][k] * signed[k][j]
        const R = [0, 0, 0, 0, 0, 0, 0, 0, 0];
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                R[i * 3 + j] = refAxes[i][0] * signed[0][j] +
                               refAxes[i][1] * signed[1][j] +
                               refAxes[i][2] * signed[2][j];
            }
        }
        // Convert to Quat
        const m00 = R[0], m10 = R[1], m20 = R[2];
        const m01 = R[3], m11 = R[4], m21 = R[5];
        const m02 = R[6], m12 = R[7], m22 = R[8];
        const trace = m00 + m11 + m22;
        let qx, qy, qz, qw;
        if (trace > 0) {
            const s = 0.5 / Math.sqrt(trace + 1);
            qw = 0.25 / s;
            qx = (m21 - m12) * s;
            qy = (m02 - m20) * s;
            qz = (m10 - m01) * s;
        } else if (m00 > m11 && m00 > m22) {
            const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
            qx = 0.25 * s;
            qy = (m01 + m10) / s;
            qz = (m02 + m20) / s;
            qw = (m21 - m12) / s;
        } else if (m11 > m22) {
            const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
            qx = (m01 + m10) / s;
            qy = 0.25 * s;
            qz = (m12 + m21) / s;
            qw = (m02 - m20) / s;
        } else {
            const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
            qx = (m02 + m20) / s;
            qy = (m12 + m21) / s;
            qz = 0.25 * s;
            qw = (m10 - m01) / s;
        }
        return new Quat(qx, qy, qz, qw);
    }

    /** Sample N positions from a model's gsplat data.  Returns a Float32Array
     *  of length 3N (interleaved x,y,z).  Currently not used; ICP uses
     *  the centroids we already have via PCA + dense point sampling via
     *  PlayCanvas's getCenters(). */
    private sampleSplatPoints(p: any, _ref: any, n: number): Float32Array | null {
        if (!p) return null;
        const gsplatData = (p as any).gsplatData;
        if (!gsplatData || typeof gsplatData.getCenters !== 'function') return null;
        const all = gsplatData.getCenters();
        const total = all.length / 3;
        if (total === 0) return null;
        const out = new Float32Array(n * 3);
        const step = Math.max(1, Math.floor(total / n));
        for (let i = 0; i < n; i++) {
            const src = Math.min(total - 1, i * step) * 3;
            out[i * 3]     = all[src];
            out[i * 3 + 1] = all[src + 1];
            out[i * 3 + 2] = all[src + 2];
        }
        return out;
    }

    /** Iterative Closest Point: refine the rigid transform between two
     *  centred point clouds (both in the same reference frame, e.g. already
     *  PCA-aligned).  Returns the additional rotation/translation/scale that
     *  best aligns `p` to `ref`. */
    private icpRefine(
        refPoints: Float32Array,
        pPoints: Float32Array,
        iterations: number
    ): { R: Quat; t: Vec3; scale: number } | null {
        const n = Math.min(refPoints.length, pPoints.length) / 3;
        if (n < 3) return null;

        // Transform p points into the ref frame: start with identity, then
        // iteratively refine.
        let R = new Quat(0, 0, 0, 1);
        let t = new Vec3(0, 0, 0);
        let scale = 1;

        const transformedP = new Float32Array(pPoints.length);

        for (let iter = 0; iter < iterations; iter++) {
            // Apply current transform to p points
            for (let i = 0; i < n; i++) {
                const p = new Vec3(
                    pPoints[i * 3] * scale,
                    pPoints[i * 3 + 1] * scale,
                    pPoints[i * 3 + 2] * scale
                );
                R.transformVector(p, p);
                p.add(t);
                transformedP[i * 3]     = p.x;
                transformedP[i * 3 + 1] = p.y;
                transformedP[i * 3 + 2] = p.z;
            }

            // Find nearest neighbors (brute force; OK for ~800 points)
            // Track mean NN distance; we'll reject correspondences further
            // than 2x the median in the Kabsch step (outlier rejection).
            const distances = new Float32Array(n);
            let cxP = 0, cyP = 0, czP = 0;
            let cxR = 0, cyR = 0, czR = 0;
            const NN = new Float32Array(n);  // ref points for each transformedP
            for (let i = 0; i < n; i++) {
                let minDist = Infinity;
                let minIdx = 0;
                for (let j = 0; j < n; j++) {
                    const dx = transformedP[i * 3]     - refPoints[j * 3];
                    const dy = transformedP[i * 3 + 1] - refPoints[j * 3 + 1];
                    const dz = transformedP[i * 3 + 2] - refPoints[j * 3 + 2];
                    const d = dx * dx + dy * dy + dz * dz;
                    if (d < minDist) { minDist = d; minIdx = j; }
                }
                distances[i] = Math.sqrt(minDist);
                cxP += transformedP[i * 3];
                cyP += transformedP[i * 3 + 1];
                czP += transformedP[i * 3 + 2];
                cxR += refPoints[minIdx * 3];
                cyR += refPoints[minIdx * 3 + 1];
                czR += refPoints[minIdx * 3 + 2];
                NN[i * 3]     = refPoints[minIdx * 3];
                NN[i * 3 + 1] = refPoints[minIdx * 3 + 1];
                NN[i * 3 + 2] = refPoints[minIdx * 3 + 2];
            }
            cxP /= n; cyP /= n; czP /= n;
            cxR /= n; cyR /= n; czR /= n;

            // Compute median NN distance for outlier rejection
            const sortedDist = Array.from(distances).sort((a, b) => a - b);
            const medianDist = sortedDist[Math.floor(n / 2)] || 1;
            const distThresh = medianDist * 3.0;  // reject > 3x median

            // Center both (only over inliers)
            // H = sum (P_centered_i * NN_centered_i^T) for inliers only
            const H = [0, 0, 0, 0, 0, 0, 0, 0, 0];
            let inlierCount = 0;
            for (let i = 0; i < n; i++) {
                if (distances[i] > distThresh) continue;  // reject outlier
                const px = transformedP[i * 3]     - cxP;
                const py = transformedP[i * 3 + 1] - cyP;
                const pz = transformedP[i * 3 + 2] - czP;
                const qx = NN[i * 3]     - cxR;
                const qy = NN[i * 3 + 1] - cyR;
                const qz = NN[i * 3 + 2] - czR;
                H[0] += px * qx; H[1] += px * qy; H[2] += px * qz;
                H[3] += py * qx; H[4] += py * qy; H[5] += py * qz;
                H[6] += pz * qx; H[7] += pz * qy; H[8] += pz * qz;
                inlierCount++;
            }
            if (inlierCount < 3) break;  // too few inliers, stop ICP

            // SVD of H: 3x3 Jacobi
            const svd = this.svd3(H);
            if (!svd) break;

            // Kabsch rotation: R_iter = V * U^T (with sign correction for det)
            const detUV = svd.U[0] * svd.V[0] + svd.U[1] * svd.V[1] + svd.U[2] * svd.V[2] +
                          svd.U[3] * svd.V[3] + svd.U[4] * svd.V[4] + svd.U[5] * svd.V[5] +
                          svd.U[6] * svd.V[6] + svd.U[7] * svd.V[7] + svd.U[8] * svd.V[8];
            const sign = detUV < 0 ? -1 : 1;
            const R_iter = [0, 0, 0, 0, 0, 0, 0, 0, 0];
            for (let i = 0; i < 3; i++) {
                for (let j = 0; j < 3; j++) {
                    R_iter[i * 3 + j] = svd.V[i * 3 + 0] * svd.U[0 * 3 + j] +
                                        svd.V[i * 3 + 1] * svd.U[1 * 3 + j] +
                                        svd.V[i * 3 + 2] * svd.U[2 * 3 + j];
                    if (j === 2) R_iter[i * 3 + j] *= sign;  // last column flipped
                }
            }
            // (More compact: R_iter = V * diag(1,1,sign) * U^T, but the above works)

            // Convert R_iter to Quat and compose with current R
            const qIter = this.mat3ToQuat(R_iter);
            // newR = qIter * R (apply R_iter first, then existing R)
            const newR = qIter.mul(R);
            R = newR;

            // Translation: t_iter = cR - R_iter * cP
            const tIter = new Vec3(
                cxR - (R_iter[0] * cxP + R_iter[1] * cyP + R_iter[2] * czP),
                cyR - (R_iter[3] * cxP + R_iter[4] * cyP + R_iter[5] * czP),
                czR - (R_iter[6] * cxP + R_iter[7] * cyP + R_iter[8] * czP)
            );
            // new t = R_iter * t + t_iter
            t = new Vec3(
                R_iter[0] * t.x + R_iter[1] * t.y + R_iter[2] * t.z + tIter.x,
                R_iter[3] * t.x + R_iter[4] * t.y + R_iter[5] * t.z + tIter.y,
                R_iter[6] * t.x + R_iter[7] * t.y + R_iter[8] * t.z + tIter.z
            );
        }

        return { R, t, scale };
    }

    /** 3x3 SVD via Jacobi rotations on H^T H.
     *  Returns { U, V } where H ≈ U * diag(s) * V^T, with V column-major and U also.
     *  (For Kabsch, we only need U and V; the singular values are unused.) */
    private svd3(h: number[]): { U: number[]; V: number[] } | null {
        // H^T H is symmetric 3x3
        const A = [
            h[0] * h[0] + h[3] * h[3] + h[6] * h[6],
            h[0] * h[1] + h[3] * h[4] + h[6] * h[7],
            h[0] * h[2] + h[3] * h[5] + h[6] * h[8],
            h[1] * h[0] + h[4] * h[3] + h[7] * h[6],
            h[1] * h[1] + h[4] * h[4] + h[7] * h[7],
            h[1] * h[2] + h[4] * h[5] + h[7] * h[8],
            h[2] * h[0] + h[5] * h[3] + h[8] * h[6],
            h[2] * h[1] + h[5] * h[4] + h[8] * h[7],
            h[2] * h[2] + h[5] * h[5] + h[8] * h[8]
        ];
        const eig = this.jacobi3(A);
        if (!eig) return null;
        const V = eig.vectors;  // column-major
        // Singluar values: sqrt(eigenvalues), with eps to avoid div-by-zero
        const s = eig.values.map(v => Math.sqrt(Math.max(v, 1e-10)));
        // U = H * V * diag(1/s)
        const U = [0, 0, 0, 0, 0, 0, 0, 0, 0];
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                let sum = 0;
                for (let k = 0; k < 3; k++) {
                    sum += h[i * 3 + k] * V[k * 3 + j] / s[j];
                }
                U[i * 3 + j] = sum;
            }
        }
        return { U, V };
    }

    /** Convert a 3x3 rotation matrix to a Quat using the standard formula. */
    private mat3ToQuat(m: number[]): Quat {
        const m00 = m[0], m10 = m[1], m20 = m[2];
        const m01 = m[3], m11 = m[4], m21 = m[5];
        const m02 = m[6], m12 = m[7], m22 = m[8];
        const trace = m00 + m11 + m22;
        let qx, qy, qz, qw;
        if (trace > 0) {
            const s = 0.5 / Math.sqrt(trace + 1);
            qw = 0.25 / s;
            qx = (m21 - m12) * s;
            qy = (m02 - m20) * s;
            qz = (m10 - m01) * s;
        } else if (m00 > m11 && m00 > m22) {
            const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
            qx = 0.25 * s;
            qy = (m01 + m10) / s;
            qz = (m02 + m20) / s;
            qw = (m21 - m12) / s;
        } else if (m11 > m22) {
            const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
            qx = (m01 + m10) / s;
            qy = 0.25 * s;
            qz = (m12 + m21) / s;
            qw = (m02 - m20) / s;
        } else {
            const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
            qx = (m02 + m20) / s;
            qy = (m12 + m21) / s;
            qz = 0.25 * s;
            qw = (m10 - m01) / s;
        }
        return new Quat(qx, qy, qz, qw);
    }

    private transformAabb(local: BoundingBox, worldTransform: Mat4): BoundingBox {
        const c = local.center;
        const he = local.halfExtents;
        const min = new Vec3(Infinity, Infinity, Infinity);
        const max = new Vec3(-Infinity, -Infinity, -Infinity);
        const p = new Vec3();
        for (const sx of [-1, 1]) {
            for (const sy of [-1, 1]) {
                for (const sz of [-1, 1]) {
                    p.set(c.x + sx * he.x, c.y + sy * he.y, c.z + sz * he.z);
                    worldTransform.transformPoint(p, p);
                    min.x = Math.min(min.x, p.x); min.y = Math.min(min.y, p.y); min.z = Math.min(min.z, p.z);
                    max.x = Math.max(max.x, p.x); max.y = Math.max(max.y, p.y); max.z = Math.max(max.z, p.z);
                }
            }
        }
        return new BoundingBox(min, max);
    }

    // ------------------------------------------------------------------
    // Clear / remove
    // ------------------------------------------------------------------

    /** Remove a single model by its index. */
    removeModel(index: number) {
        const idx = this.models.findIndex((m) => m.index === index);
        if (idx < 0) return;
        const m = this.models[idx];
        m.camera.destroy();
        m.entity.destroy();
        m.statsPanel.root.remove();
        m.analysisOverlay.dispose();
        try {
            this.app.scene.layers.remove(m.layer);
            this.app.scene.layers._update();
        } catch (_) {
            /* layer already gone */
        }
        m.labelEl.remove();
        this.models.splice(idx, 1);
        this.models.forEach((mm, i) => (mm.index = i));
        this.applyLayout(this.currentCount, this.currentMode);
        this.frameAll();
    }

    /** Remove every model. */
    clear() {
        for (const m of this.models) {
            m.camera.destroy();
            m.entity.destroy();
            try {
                this.app.scene.layers.remove(m.layer);
            } catch (_) {
                /* ignore */
            }
            m.labelEl.remove();
            m.statsPanel.root.remove();
        m.analysisOverlay.dispose();
        }
        try {
            this.app.scene.layers._update();
        } catch (_) {
            /* ignore */
        }
        this.models.length = 0;
    }

    // ------------------------------------------------------------------
    // Per-frame camera update — runs every frame so zoom/orbit/pan feel
    // snappy even when inputs fire between frames.
    // ------------------------------------------------------------------

    private update() {
        this.updateCameras();
        // re-draw analysis overlays every 5 frames (~12 fps) so they track
        // smoothly when the camera rotates or zooms
        if (this.currentAnalysisMode && ++this._analysisFrame % 5 === 0) {
            this.refreshAnalysisOverlays();
        }
    }
    private _analysisFrame = 0;

    private updateCameras() {
        const forward = this.calcForward();
        const fovRad = (this.fov * Math.PI) / 180;
        const dist = Math.max(0.1,
            (this.sharedRadius / Math.sin(fovRad / 2)) * 1.2 * this.zoomLevel);
        const pos = this.sharedTarget.clone().add(forward.clone().mulScalar(dist));

        for (const m of this.models) {
            if (!m.camera.enabled) continue;
            m.camera.setPosition(pos.x, pos.y, pos.z);
            m.camera.lookAt(this.sharedTarget.x, this.sharedTarget.y, this.sharedTarget.z);
        }

        const doLog = this.logFrame++ % 60 === 0;
        if (doLog && this.models.length > 0) {
            console.log('[CompareScene] azim=', this.azimuth.toFixed(1),
                'elev=', this.elevation.toFixed(1),
                'zoomLevel=', this.zoomLevel.toFixed(3),
                'dist=', dist.toFixed(1));
        }
    }

    // ------------------------------------------------------------------
    // Input — exactly matches SplatRoom editor's PointerController
    //   LEFT  drag → orbit (azim/elev around focal point)
    //   LEFT  dbl  → focus (AABB intersection, same as editor pickFocalPoint)
    //   MID   drag → pan  (screenToWorld at focal distance)
    //   RIGHT drag → look  (keep camera position, recompute target from new dir)
    //   WHEEL      → zoom (exponential/linear hybrid, matching editor)
    // ------------------------------------------------------------------

    private readonly ORBIT_SENSITIVITY = 0.3;   // deg/px (matches sceneConfig)
    private readonly ZOOM_SENSITIVITY = 0.25;   // halved — large PLY scenes need gentler zoom
    private zoomLogCount = 0;

    /** Pre-computed forward-vector scratch for performance. */
    private readonly _fwdScratch = new Vec3();

    private bindInput() {
        const c = this.canvas;

        // ---- mouse down ----
        c.addEventListener('mousedown', (e: MouseEvent) => {
            if (e.button === 0) {
                const now = performance.now();
                if (now - this.lastClickTime < this.DBL_CLICK_MS &&
                    Math.abs(e.clientX - this.lastClickX) < this.DBL_CLICK_PX &&
                    Math.abs(e.clientY - this.lastClickY) < this.DBL_CLICK_PX) {
                    // double-click — set focus (editor: pickFocalPoint via depth buffer)
                    this.setFocusFromScreen(e.clientX, e.clientY);
                    this.lastClickTime = 0;
                    this.activeButton = 0;
                    this.lastX = e.clientX;
                    this.lastY = e.clientY;
                    return;
                }
                this.lastClickTime = now;
                this.lastClickX = e.clientX;
                this.lastClickY = e.clientY;
            }

            this.activeButton = e.button;
            this.lastX = e.clientX;
            this.lastY = e.clientY;
            if (e.button === 1) e.preventDefault();
        });

        // ---- mouse up ----
        window.addEventListener('mouseup', () => {
            this.activeButton = null;
        });

        // ---- mouse move ----
        window.addEventListener('mousemove', (e: MouseEvent) => {
            if (this.activeButton === null) return;
            const dx = e.clientX - this.lastX;
            const dy = e.clientY - this.lastY;
            this.lastX = e.clientX;
            this.lastY = e.clientY;

            if (this.activeButton === 0) {
                this.orbit(dx, dy);
            } else if (this.activeButton === 1) {
                this.pan(e.clientX, e.clientY, dx, dy);
            } else if (this.activeButton === 2) {
                this.look(dx, dy);
            }
        });

        // ---- wheel: zoom (listen on window so it works even when the pointer
        //     is over the panel) ----
        const onWheel = (e: WheelEvent) => {
            // Only zoom when the pointer is over the canvas area (not the panel).
            const rect = c.getBoundingClientRect();
            if (e.clientX < rect.left || e.clientX > rect.right ||
                e.clientY < rect.top || e.clientY > rect.bottom) return;
            e.preventDefault();
            this.zoom(e.deltaY * -0.002);
        };
        window.addEventListener('wheel', onWheel, { passive: false });

        // ---- context menu ----
        c.addEventListener('contextmenu', (e: Event) => e.preventDefault());
    }

    // ------------------------------------------------------------------
    // Forward vector — identical to Camera.calcForwardVec
    // ------------------------------------------------------------------

    /**
     * Replica of `Camera.calcForwardVec`.
     * Given azimuth (deg) and elevation (deg), returns the world-space forward
     * direction (from focal point toward camera).
     */
    private calcForward(azim: number = this.azimuth, elev: number = this.elevation): Vec3 {
        const ex = elev * (Math.PI / 180);
        const ey = azim * (Math.PI / 180);
        const s1 = Math.sin(-ex);
        const c1 = Math.cos(-ex);
        const s2 = Math.sin(-ey);
        const c2 = Math.cos(-ey);
        this._fwdScratch.set(-c1 * s2, s1, c1 * c2);
        return this._fwdScratch;
    }

    // ------------------------------------------------------------------
    // Orbit / pan / look / zoom — matching editor controllers.ts exactly
    // ------------------------------------------------------------------

    /** LEFT drag: orbit around the current focal point. */
    private orbit(dx: number, dy: number) {
        this.azimuth  -= dx * this.ORBIT_SENSITIVITY;
        this.elevation -= dy * this.ORBIT_SENSITIVITY;
        this.elevation = Math.max(-89, Math.min(89, this.elevation));
    }

    /** MIDDLE drag: pan the shared target (all models are aligned, so they
     *  move together). */
    private pan(sx: number, sy: number, dx: number, dy: number) {
        const m = this.models.find(mm => mm.camera.enabled);
        if (!m) return;
        const cam = m.camera.camera;
        if (!cam) return;

        const rect = this.canvas.getBoundingClientRect();
        const cx = sx - rect.left;
        const cy = sy - rect.top;

        const fovRad = (this.fov * Math.PI) / 180;
        const refDist = (this.sharedRadius / Math.sin(fovRad / 2)) * 1.2 * this.zoomLevel;
        const from = new Vec3();
        const to = new Vec3();
        cam.screenToWorld(cx, cy, refDist, from);
        cam.screenToWorld(cx - dx, cy - dy, refDist, to);
        this.sharedTarget.add(to.sub(from));
    }

    /** RIGHT drag: look — keep camera world position, recompute shared target. */
    private look(dx: number, dy: number) {
        if (this.models.length === 0) return;

        const forward = this.calcForward();
        const fovRad = (this.fov * Math.PI) / 180;
        const refDist = (this.sharedRadius / Math.sin(fovRad / 2)) * 1.2 * this.zoomLevel;
        const cameraPos = this.sharedTarget.clone().add(forward.clone().mulScalar(refDist));

        const newAzim = this.azimuth - dx * this.ORBIT_SENSITIVITY;
        const newElev = Math.max(-89, Math.min(89, this.elevation - dy * this.ORBIT_SENSITIVITY));
        const newForward = this.calcForward(newAzim, newElev);

        this.sharedTarget.copy(cameraPos.sub(newForward.clone().mulScalar(refDist)));
        this.azimuth = newAzim;
        this.elevation = newElev;
    }

    /** WHEEL: zoom — scale zoomLevel for all models uniformly. */
    private zoom(amount: number) {
        const z = this.zoomLevel * 0.999 + 0.001;
        this.zoomLevel = Math.max(0.01, this.zoomLevel - z * amount * this.ZOOM_SENSITIVITY);
        if (++this.zoomLogCount % 5 === 0) {
            console.log('[CompareScene] zoom amount=', amount.toFixed(4),
                'zoomLevel=', this.zoomLevel.toFixed(3));
        }
    }

    /** Double-click: reset zoom to 1.0 and re-center the shared azimuth/elevation. */
    private setFocusFromScreen(_sx: number, _sy: number) {
        // Snap all models to their default fit
        this.zoomLevel = 1;
        this.azimuth = -45;
        this.elevation = -10;
        console.log('[CompareScene] focus reset — zoom=1, azim=-45, elev=-10');
    }

    /**
     * Ray-vs-AABB intersection (slab method).  Returns `true` and writes the
     * nearest positive-*t* intersection point into `out`; otherwise `false`.
     */
    private rayAabbIntersect(
        origin: Vec3,
        dir: Vec3,
        box: BoundingBox,
        out: Vec3
    ): boolean {
        const get = (v: Vec3, axis: number) =>
            axis === 0 ? v.x : axis === 1 ? v.y : v.z;
        const set = (v: Vec3, axis: number, val: number) => {
            if (axis === 0) v.x = val; else if (axis === 1) v.y = val; else v.z = val;
        };

        const min = box.getMin();
        const max = box.getMax();
        let tMin = -Infinity;
        let tMax = Infinity;

        for (let i = 0; i < 3; i++) {
            const o = get(origin, i);
            const d = get(dir, i);
            if (Math.abs(d) < 1e-10) {
                if (o < get(min as Vec3, i) || o > get(max as Vec3, i)) return false;
            } else {
                let t1 = (get(min as Vec3, i) - o) / d;
                let t2 = (get(max as Vec3, i) - o) / d;
                if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
                tMin = Math.max(tMin, t1);
                tMax = Math.min(tMax, t2);
                if (tMin > tMax) return false;
            }
        }

        const t = tMin >= 0 ? tMin : tMax;
        if (t < 0) return false;

        out.set(origin.x + t * dir.x, origin.y + t * dir.y, origin.z + t * dir.z);
        return true;
    }
}
