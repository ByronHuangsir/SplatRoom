import { Asset, Color, Entity, GSplatResource, Layer, Mat4, Quat, SORTMODE_CUSTOM, SORTMODE_NONE, TranslateGizmo, Vec3 } from 'playcanvas';
import type { Application } from 'playcanvas';
import { loadGSplatDataAsync, MappedReadFileSystem, validateGSplatData } from '../io';
import { MergeModel, createChain, removeFromChain, applyChainDelta } from './merge-model';
import { autoAlign, kabsch, matToQuat, pcaPrealign, raycastPick } from './merge-align';
import { buildMergedGSplatData, computeMergedAabb, exportMergedPly } from './merge-export';
import { MergeGrid } from './merge-grid';
import { MergeViewCube } from './merge-view-cube';

/**
 * 合并工具（模块 3）— 合并工作台。
 *
 * 独立窗口（?mode=merge）+ 独立 PlayCanvas app：此场景不 import 主编辑器任何
 * 模块，渲染链路（canvas/device/app/scene/camera）与主视窗和 PiP 完全隔离。
 *
 * 交互：
 *   - 左键单击  → 选中模型（Ctrl+Click 多选/反选）
 *   - 左键拖拽  → 环绕（orbit）
 *   - 中键拖拽  → 平移（pan）
 *   - 右键拖拽  → 环视（look）
 *   - 滚轮      → 缩放
 *   - 双击      → 聚焦
 *   - 对应点模式下单击模型表面 → 记录对应点
 */

const MAX_MODELS = 8;

/** 模型表面排序（与主编辑器 splatLayer 相同的角点排序，保证 GSplat 深度正确）。 */
const sortCorner = new Vec3();
const specialSort = (instances: any[], numInstances: number, cameraPos: Vec3, cameraDir: Vec3) => {
    const distances = new Map<any, number>();
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
                    const d = (sortCorner.x - cameraPos.x) * cameraDir.x +
                              (sortCorner.y - cameraPos.y) * cameraDir.y +
                              (sortCorner.z - cameraPos.z) * cameraDir.z;
                    if (d > maxDist) maxDist = d;
                }
            }
        }
        distances.set(instance, maxDist);
    }
    instances.sort((a: any, b: any) => distances.get(b) - distances.get(a));
};

/** 历史快照：记录若干模型在某一时刻的局部变换（位置/旋转/缩放）。 */
interface HistoryEntry {
    type: string;
    states: { model: MergeModel; pos: Vec3; rot: Quat; scale: Vec3 }[];
}

/** 标记 overlay 元素。 */
interface MarkerEl {
    el: HTMLDivElement;
    model: MergeModel | null;
    group: number;
    key: 'm1' | 'm2';
    active: boolean;
    hitLocal: Vec3;
}

export class MergeScene {
    readonly app: Application;
    readonly contentRoot: Entity;
    readonly canvas: HTMLCanvasElement;
    readonly models: MergeModel[] = [];

    private readonly clearColor = new Color(0.10, 0.12, 0.16);
    private fov = 50;
    private layer!: Layer;
    private camera!: Entity;

    // 相机状态（共享 orbit）
    private azimuth = -45;
    private elevation = -10;
    private zoomLevel = 1;
    private target = new Vec3(0, 0, 0);
    private baseRadius = 1;

    // 输入
    private activeButton: number | null = null;
    private lastX = 0;
    private lastY = 0;
    private lastClickTime = 0;
    private lastClickX = 0;
    private lastClickY = 0;
    private readonly DBL_CLICK_MS = 300;
    private readonly DBL_CLICK_PX = 5;

    // 标记（对应点）对齐状态
    markerModel1: MergeModel | null = null;   // 参考模型（模型1，默认第一个选中）
    markerModel2: MergeModel | null = null;   // 模型2（第二个选中）
    markerActive: 'm1' | 'm2' = 'm1';          // 当前正在标记的模型
    markerPicking = false;                     // 是否处于拾取标记模式
    markerGroups: { m1?: Vec3; m2?: Vec3 }[] = [{}, {}, {}];  // 最多 3 组对应点（local 坐标）
    onMarkerChange: (() => void) | null = null;

    // 撤销/重做历史
    private undoStack: HistoryEntry[] = [];
    private redoStack: HistoryEntry[] = [];
    private readonly MAX_HISTORY = 20;
    onHistoryChange: (() => void) | null = null;

    // 回调（由 UI 面板注入）
    onSelectionChange: (() => void) | null = null;
    onModelsChange: (() => void) | null = null;
    onStatus: ((msg: string) => void) | null = null;
    onAlignModeChange: (() => void) | null = null;

    constructor(app: Application, canvas: HTMLCanvasElement) {
        this.app = app;
        this.canvas = canvas;
        this.contentRoot = new Entity('merge-content');
        app.root.addChild(this.contentRoot);

        // 专用 splat 层
        this.layer = new Layer({
            name: 'merge-splat',
            opaqueSortMode: SORTMODE_CUSTOM,
            transparentSortMode: SORTMODE_CUSTOM
        });
        this.layer.customCalculateSortValues = specialSort;
        this.app.scene.layers.push(this.layer);
        this.app.scene.layers._update();

        // 相机（layers 含 World 层：drawLine 包围盒/轴/标记可见）
        this.camera = new Entity('merge-cam');
        const worldLayer = this.app.scene.layers.getLayerByName('World');
        this.worldLayerId = worldLayer?.id ?? this.layer.id;
        this.camera.addComponent('camera', {
            clearColor: this.clearColor.clone(),
            clearColorBuffer: true,
            clearDepthBuffer: true,
            fov: this.fov,
            nearClip: 0.01,
            farClip: 1000000,
            layers: [this.layer.id, ...(worldLayer ? [worldLayer.id] : [])]
        });
        this.app.root.addChild(this.camera);

        // 标记点三轴 gizmo（TranslateGizmo）：选中标记点时显示，用于精确轴向调整位置
        this.markerGizmoLayer = new Layer({
            name: 'merge-marker-gizmo',
            clearDepthBuffer: true,
            opaqueSortMode: SORTMODE_NONE,
            transparentSortMode: SORTMODE_NONE
        });
        this.app.scene.layers.push(this.markerGizmoLayer);
        this.app.scene.layers._update();
        const camComp = this.camera.camera as any;
        camComp.layers = [this.layer.id, this.markerGizmoLayer.id, ...(worldLayer ? [worldLayer.id] : [])];

        this.markerGizmoPivot = new Entity('merge-marker-gizmo-pivot');
        this.app.root.addChild(this.markerGizmoPivot);
        this.markerGizmo = new TranslateGizmo(this.camera.camera, this.markerGizmoLayer);
        // size 会在 updateMarkerGizmo 中根据相机距离动态调整，保持屏幕约 120px
        this.markerGizmo.size = 1.2;
        this.markerGizmo.on('transform:start', () => {
            this.gizmoDragging = true;
        });
        this.markerGizmo.on('transform:move', () => {
            if (!this.markerSelection || !this.markerSelection.model) return;
            const world = this.markerGizmoPivot.getPosition();
            const inv = this.markerSelection.model.entity.getWorldTransform().clone().invert();
            const local = inv.transformPoint(world) as Vec3;
            this.markerSelection.hitLocal.copy(local);
            const g = this.markerGroups[this.markerSelection.group];
            if (g) g[this.markerSelection.key] = local.clone();
            this.onMarkerChange?.();
        });
        this.markerGizmo.on('transform:end', () => {
            this.gizmoDragging = false;
            if (this.markerSelection) {
                this.onStatus?.(`已调整标记点 ${this.markerSelection.group + 1}`);
            }
        });

        // 主程序风格无限网格（GPU shader，挂在 preRenderLayer）
        this.grid = new MergeGrid(this.app, this.camera, this.worldLayerId);

        this.initAxesOverlay();
        this.initViewButtons();
        this.createTransformPanel();
        this.initRectEl();
        this.initMarkerEls();
        this.bindInput();
        app.on('update', () => this.update());
    }

    // --------------------------------------------------------------
    // 加载
    // --------------------------------------------------------------

    async loadFiles(files: { name: string; blob: Blob }[]): Promise<number> {
        let added = 0;
        for (const f of files) {
            if (this.models.length >= MAX_MODELS) {
                this.onStatus?.(`已达模型上限（${MAX_MODELS}）`);
                break;
            }
            if (await this.loadOne(f.name, f.blob)) added++;
        }
        if (added > 0) {
            this.frameAll();
            this.onModelsChange?.();
        }
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
            const model = new MergeModel(this.app, asset, name, gsplatData);
            if (transform && transform.rotation) {
                model.entity.setLocalRotation(transform.rotation);
            }
            this.contentRoot.addChild(model.entity);
            model.entity.gsplat.layers = [this.layer.id];
            model.computeWorldAabb();
            this.models.push(model);
            return true;
        } catch (e) {
            console.error('[MergeScene] loadOne failed:', name, e);
            this.onStatus?.(`✗ 加载失败：${name}`);
            return false;
        }
    }

    private createGSplatAsset(gsplatData: any, filename: string): Asset {
        const asset = new Asset(filename, 'gsplat', {
            url: `merge-local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            filename
        } as any);
        this.app.assets.add(asset);
        asset.resource = new GSplatResource(this.app.graphicsDevice, gsplatData);
        return asset;
    }

    removeModel(model: MergeModel): void {
        removeFromChain(model);
        model.destroy(this.app);
        const i = this.models.indexOf(model);
        if (i >= 0) this.models.splice(i, 1);
        if (this.models.length > 0) this.frameAll();
        this.onModelsChange?.();
    }

    // --------------------------------------------------------------
    // 选择
    // --------------------------------------------------------------

    /** 单击拾取（不拖拽时触发）。Ctrl = 多选/反选。 */
    private handleClick(x: number, y: number, ctrl: boolean): void {
        const pick = this.pickScreen(x, y);
        if (!pick) {
            if (!ctrl && this.alignMode !== 'marker') this.setSelection([]);
            return;
        }
        if (this.alignMode === 'marker' && this.markerPicking) {
            const m1 = this.markerModel1, m2 = this.markerModel2;
            if (pick.model !== m1 && pick.model !== m2) {
                this.onStatus?.('请在被指定为「模型1 / 模型2」的模型上点击（先在列表或点选指定）');
                return;
            }
            const key: 'm1' | 'm2' = (pick.model === m1) ? 'm1' : 'm2';
            if (key !== this.markerActive) this.markerActive = key;
            this.addMarkerPoint(key, pick);
            return;
        }
        if (ctrl) {
            pick.model.selected = !pick.model.selected;
            this.onSelectionChange?.();
        } else if (!pick.model.selected) {
            this.setSelection([pick.model]);
        }
        // 选中模型后默认进入「移动」模式（gizmo 显示移动箭头；按住拖拽 = 移动模型，未命中手柄 = orbit 相机）
        if (pick.model.selected && this.toolMode === 'view') {
            this.setToolMode('move');
        }
        this.onSelectionChange?.();
    }

    private pickScreen(x: number, y: number): { model: MergeModel; pos: Vec3; dist: number; index: number } | null {
        const rect = this.canvas.getBoundingClientRect();
        const sx = x - rect.left;
        const sy = y - rect.top;
        // 使用 PlayCanvas 官方的 screenToWorld，与 GPU 渲染用同一组 view/proj 矩阵，
        // 避免手算投影矩阵与引擎实际不一致导致的标记点漂移/失踪。
        const cam = this.camera.camera;
        const near = cam.screenToWorld(sx, sy, cam.nearClip);
        const far = cam.screenToWorld(sx, sy, cam.farClip);
        const origin = this.camera.getPosition();
        const dir = far.clone().sub(near).normalize();
        return raycastPick(this.models, origin, dir);
    }

    setSelection(models: MergeModel[]): void {
        for (const m of this.models) {
            m.selected = false;
        }
        for (const m of models) {
            m.selected = true;
        }
        if (this.alignMode === 'marker') this.assignMarkerModels();
        this.onSelectionChange?.();
    }

    /** 每帧重画选中模型的包围盒线框（12 条边，量小）。 */
    private drawSelectionBoxes(): void {
        const sel = this.selected;
        if (sel.length === 0) return;
        const v = new Vec3();
        for (const m of sel) {
            const { center, halfExtents } = m.worldBound;
            const cx = center.x, cy = center.y, cz = center.z;
            const hx = halfExtents.x, hy = halfExtents.y, hz = halfExtents.z;
            const corners = [
                new Vec3(cx - hx, cy - hy, cz - hz), new Vec3(cx + hx, cy - hy, cz - hz),
                new Vec3(cx + hx, cy + hy, cz - hz), new Vec3(cx - hx, cy + hy, cz - hz),
                new Vec3(cx - hx, cy - hy, cz + hz), new Vec3(cx + hx, cy - hy, cz + hz),
                new Vec3(cx + hx, cy + hy, cz + hz), new Vec3(cx - hx, cy + hy, cz + hz)
            ];
            const edges: [number, number][] = [
                [0, 1], [1, 2], [2, 3], [3, 0],
                [4, 5], [5, 6], [6, 7], [7, 4],
                [0, 4], [1, 5], [2, 6], [3, 7]
            ];
            for (const [a, b] of edges) {
                this.app.drawLine(corners[a], corners[b], this.boxColor, true, this.layer);
            }
        }
    }

    private readonly boxColor = new Color(1.0, 0.706, 0.33, 1.0);
    private worldLayerId: number | null = null;

    get selected(): MergeModel[] {
        return this.models.filter(m => m.selected);
    }

    // --------------------------------------------------------------
    // 链接（链锁联动）
    // --------------------------------------------------------------

    linkSelected(): void {
        const sel = this.selected;
        if (sel.length < 2) {
            this.onStatus?.('链接需要至少选中 2 个模型');
            return;
        }
        const chain = createChain(sel);
        this.onStatus?.(`已链接 ${chain.members.length} 个模型（链锁联动变换）`);
        this.onModelsChange?.();
    }

    unlinkSelected(): void {
        const sel = this.selected;
        for (const m of sel) removeFromChain(m);
        this.onStatus?.(`已取消 ${sel.length} 个模型的链接`);
        this.onModelsChange?.();
    }

    /** 应用变换增量到选中模型；链锁组内其余成员联动（同组只应用一次）。 */
    applyTransformDelta(mode: 'translate' | 'rotate' | 'scale', delta: Vec3 | number): void {
        const processed = new Set<MergeModel>();
        const applyTo = (m: MergeModel) => {
            if (mode === 'translate') {
                const d = delta as Vec3;
                const p = m.entity.getLocalPosition();
                m.entity.setLocalPosition(p.x + d.x, p.y + d.y, p.z + d.z);
            } else if (mode === 'rotate') {
                const d = delta as Vec3;
                const e = m.entity.getLocalEulerAngles();
                m.entity.setLocalEulerAngles(e.x + d.x, e.y + d.y, e.z + d.z);
            } else {
                const s = delta as number;
                const sc = m.entity.getLocalScale();
                m.entity.setLocalScale(sc.x * s, sc.y * s, sc.z * s);
            }
            m.computeWorldAabb();
        };
        for (const m of this.selected) {
            if (processed.has(m)) continue;
            if (m.chain) {
                // 链锁组：leader 应用增量，其余成员同步同一增量
                applyTo(m);
                applyChainDelta(m.chain, m, mode, delta);
                for (const mm of m.chain.members) processed.add(mm);
            } else {
                applyTo(m);
            }
        }
        this.onModelsChange?.();
    }

    // --------------------------------------------------------------
    // 对齐
    // --------------------------------------------------------------

    /** 自动对齐：选中的第一个为基准，其余对齐到它（或指定 dst）。 */
    /** 自动对齐两阶段状态回调（panel 用）：running=对齐中 / done=完成待确认 / idle=空闲 */
    onAutoAlignState: ((state: 'idle' | 'running' | 'done') => void) | null = null;
    private alignBackup: { model: MergeModel; pos: Vec3; rot: Quat; scale: Vec3 }[] | null = null;

    async autoAlignSelection(): Promise<void> {
        const sel = this.selected;
        if (sel.length < 2) {
            this.onStatus?.('自动对齐需要至少选中 2 个模型（基准 = 第一个）');
            return;
        }
        // 备份（撤销用）
        this.alignBackup = sel.map(m => ({
            model: m,
            pos: m.entity.getLocalPosition().clone(),
            rot: m.entity.getLocalRotation().clone(),
            scale: m.entity.getLocalScale().clone()
        }));
        this.onAutoAlignState?.('running');
        this.onStatus?.('对齐中，请等待…');
        const dst = sel[0];
        for (let i = 1; i < sel.length; i++) {
            const src = sel[i];
            try {
                await autoAlign(src, dst, (stage, pct) => {
                    this.onStatus?.(`对齐中，请等待… ${Math.round(pct)}%`);
                });
            } catch (e) {
                this.onStatus?.(`✗ 对齐失败 ${src.name}：${e instanceof Error ? e.message : String(e)}`);
            }
        }
        this.frameAll();
        this.onAutoAlignState?.('done');
        this.onStatus?.('对齐完成（确认无误请点「应用」，不对请点「撤销」）');
        this.onModelsChange?.();
    }

    /** 撤销自动对齐（恢复备份变换）。 */
    undoAlign(): void {
        if (!this.alignBackup) return;
        for (const b of this.alignBackup) {
            b.model.entity.setLocalPosition(b.pos);
            b.model.entity.setLocalRotation(b.rot);
            b.model.entity.setLocalScale(b.scale);
            b.model.computeWorldAabb();
        }
        this.alignBackup = null;
        this.onAutoAlignState?.('idle');
        this.frameAll();
        this.onStatus?.('已撤销自动对齐');
        this.onModelsChange?.();
    }

    /** 应用自动对齐（清除备份，保持当前变换）。 */
    applyAlign(): void {
        this.alignBackup = null;
        this.onAutoAlignState?.('idle');
        this.onStatus?.('已应用自动对齐');
    }

    // ---- 标记（对应点）对齐 ----

    /** 标记 overlay：每个 (模型, 组) 一个彩色圆形；模型1 青色 / 模型2 粉色。
     *  存"射线-高斯最近交点"的 entity-local 坐标（hitLocal），每帧 × 模型世界变换投影，
     *  marker 落在用户点击的真实 3D 位置，模型移动/旋转时标记跟随。 */
    private markerEls: MarkerEl[] = [];
    /** 拖拽中的标记点（主程序测量交互范式：点中已有点可拖动）。 */
    private markerDrag: MarkerEl | null = null;
    private markerDragMoved = false;
    /** 当前选中的标记点（显示三轴 gizmo 用于精调位置）。 */
    private markerSelection: MarkerEl | null = null;
    /** TranslateGizmo 正在拖拽其手柄（阻止 orbit/模型操作）。 */
    private gizmoDragging = false;
    private markerGizmoLayer!: Layer;
    private markerGizmo!: TranslateGizmo;
    private markerGizmoPivot!: Entity;

    private initMarkerEls(): void {
        const colors: Record<'m1' | 'm2', string> = { m1: '#3fd0e0', m2: '#ef5da8' };
        for (const key of ['m1', 'm2'] as const) {
            for (let g = 0; g < 3; g++) {
                const el = document.createElement('div');
                el.style.cssText =
                    'position:fixed;z-index:20;pointer-events:none;width:22px;height:22px;border-radius:50%;' +
                    'display:none;align-items:center;justify-content:center;' +
                    'font:bold 12px system-ui,sans-serif;color:#10202a;border:2px solid rgba(255,255,255,0.75);' +
                    'box-shadow:0 0 6px rgba(0,0,0,0.5);';
                el.style.background = colors[key];
                el.textContent = String(g + 1);
                document.body.appendChild(el);
                this.markerEls.push({ el, model: null, group: g, key, active: false, hitLocal: new Vec3() });
            }
        }
    }

    /** 由当前选择指派 模型1 / 模型2（顺序：第一个为模型1，另一个不同的为模型2）。 */
    private assignMarkerModels(): void {
        if (this.alignMode !== 'marker') return;
        const sel = this.selected;
        if (sel.length === 0) return;
        if (!this.markerModel1 || !this.models.includes(this.markerModel1)) {
            this.markerModel1 = sel[0];
        }
        const other = sel.find(m => m !== this.markerModel1) ?? null;
        if (other && (!this.markerModel2 || !this.models.includes(this.markerModel2))) {
            this.markerModel2 = other;
        }
        if (sel.length === 1) {
            this.markerActive = (sel[0] === this.markerModel2) ? 'm2' : 'm1';
        } else {
            this.markerActive = 'm2';
        }
        this.onMarkerChange?.();
    }

    /** 切换拾取开关（面板「开始/结束标记」按钮）。 */
    toggleMarkerPicking(): void {
        this.markerPicking = !this.markerPicking;
        this.onStatus?.(this.markerPicking ? '标记拾取已开启：点击模型表面放置标记' : '已暂停标记拾取');
        this.onMarkerChange?.();
    }

    /** 在指定模型上记录一处标记（按组顺序填充 0→1→2）。
     *  存"射线-高斯最近交点"的 entity-local 坐标（不是 splat 中心）——这样 marker 100%
     *  落在用户点击的真实 3D 位置，且只依赖 entity local、不依赖 splat 下标，
     *  模型移动/旋转时标记自然跟随。 */
    private addMarkerPoint(key: 'm1' | 'm2', pick: { model: MergeModel; pos: Vec3; index: number }): void {
        const model = pick.model;
        let gi = this.markerGroups.findIndex(g => g[key] === undefined);
        if (gi === -1) {
            this.onStatus?.(`${key === 'm1' ? '模型1' : '模型2'} 已完成 3 处标记`);
            return;
        }
        // pick.pos 是世界坐标的射线-高斯最近点；转回 entity-local 存储
        const hitLocal = model.entity.getWorldTransform().clone().invert().transformPoint(pick.pos) as Vec3;
        if (!this.markerGroups[gi]) this.markerGroups[gi] = {};
        this.markerGroups[gi][key] = hitLocal;
        const el = this.markerEls.find(e => e.key === key && e.group === gi);
        if (el) {
            el.model = model;
            el.hitLocal.copy(hitLocal);
            el.active = true;
            el.el.style.display = 'flex';
            this.selectMarker(el);
        }
        const count = this.markerGroups.filter(g => g[key] !== undefined).length;
        this.onStatus?.(`${key === 'm1' ? '模型1' : '模型2'} 标记 ${count}/3 已记录`);
        this.onMarkerChange?.();
        if (this.canApplyMarker()) {
            this.onStatus?.('✓ 3 组对应点齐备，自动对齐中……');
            setTimeout(() => this.applyMarkerAlign(), 60);
        }
    }

    /** 每帧刷新标记 overlay 屏幕位置：用存储的 entity-local 命中点 × 模型当前世界变换 → 投影。
     *  marker 落在用户点击的真实 3D 位置，模型移动/旋转/缩放时标记跟随。 */
    private updateMarkerOverlays(): void {
        for (const mk of this.markerEls) {
            if (!mk.active || !mk.model || !mk.model.visible) {
                mk.el.style.display = 'none';
                continue;
            }
            const w = mk.model.entity.getWorldTransform().transformPoint(mk.hitLocal) as Vec3;
            const s = this.worldToScreen(w);
            if (!s) { mk.el.style.display = 'none'; continue; }
            mk.el.style.display = 'flex';
            mk.el.style.left = (s.x - 11) + 'px';
            mk.el.style.top = (s.y - 11) + 'px';
        }
    }

    /** 选中/取消标记点：Attach/Detach TranslateGizmo。 */
    private selectMarker(mk: MarkerEl | null): void {
        if (this.markerSelection === mk) return;
        this.markerSelection = mk;
        if (mk && mk.model && mk.model.visible) {
            const w = mk.model.entity.getWorldTransform().transformPoint(mk.hitLocal) as Vec3;
            this.markerGizmoPivot.setPosition(w);
            this.markerGizmo.attach(this.markerGizmoPivot);
        } else {
            this.markerGizmo.detach();
        }
        this.onMarkerChange?.();
    }

    /** 每帧更新选中标记点的三轴 gizmo 位置与尺寸。 */
    private updateMarkerGizmo(): void {
        if (!this.markerSelection || !this.markerSelection.model || !this.markerSelection.model.visible) {
            if (this.markerGizmo.enabled) this.markerGizmo.detach();
            return;
        }
        const w = this.markerSelection.model.entity.getWorldTransform().transformPoint(this.markerSelection.hitLocal) as Vec3;
        this.markerGizmoPivot.setPosition(w);
        // 动态尺寸：保持 gizmo 在屏幕中约 90px。
        // 关键：PlayCanvas 的 TranslateGizmo 内部已用「_scale ∝ 相机距离」保证屏幕大小恒定，
        // 因此 size 只需是与距离无关的常数（约 targetPx/0.102/H px），切勿再乘 worldHeightAtDist，
        // 否则会与内部距离因子叠加，导致相机拉远时 gizmo 线性放大、撑满屏幕。
        const H = Math.max(this.canvas.clientHeight || 1, 1);
        const targetSize = 90 / (0.102 * H);
        this.markerGizmo.size = Math.max(0.001, targetSize);
    }

    /** marker 的当前屏幕位置（worldToScreen 投影）。 */
    private markerScreen(mk: MarkerEl): { x: number; y: number } | null {
        if (!mk.active || !mk.model || !mk.model.visible) return null;
        const w = mk.model.entity.getWorldTransform().transformPoint(mk.hitLocal) as Vec3;
        return this.worldToScreen(w);
    }

    /** 拾取屏幕 8px 内已有的标记点（主程序测量交互范式）。 */
    private pickMarkerPoint(x: number, y: number): MarkerEl | null {
        let best: MarkerEl | null = null;
        let bestD2 = 8 * 8;
        for (const mk of this.markerEls) {
            if (!mk.active || !mk.model) continue;
            const s = this.markerScreen(mk);
            if (!s) continue;
            const d2 = (s.x - x) ** 2 + (s.y - y) ** 2;
            if (d2 < bestD2) { bestD2 = d2; best = mk; }
        }
        return best;
    }

    /** 拖拽已有点到新位置（沿模型表面求交，同步 markerGroups 与 overlay）。 */
    private dragMarkerTo(mk: MarkerEl, x: number, y: number): void {
        if (!mk.model) return;
        let pick = this.pickScreen(x, y);
        // 未命中模型表面时，用宽松阈值再试一次（避免拖拽稍快就丢失）
        if (!pick || pick.model !== mk.model) {
            const rect = this.canvas.getBoundingClientRect();
            const sx = x - rect.left;
            const sy = y - rect.top;
            const cam = this.camera.camera;
            const near = cam.screenToWorld(sx, sy, cam.nearClip);
            const far = cam.screenToWorld(sx, sy, cam.farClip);
            const origin = this.camera.getPosition();
            const dir = far.clone().sub(near).normalize();
            pick = raycastPick([mk.model], origin, dir, Infinity, -1);
        }
        if (!pick) return;
        const local = mk.model.entity.getWorldTransform().clone().invert().transformPoint(pick.pos) as Vec3;
        mk.hitLocal.copy(local);
        const g = this.markerGroups[mk.group];
        if (g) g[mk.key] = local.clone();
        this.onMarkerChange?.();
        this.onStatus?.(`已移动标记点 ${mk.group + 1}`);
    }

    /** 是否可应用对齐（两模型已指定且 ≥3 组完整对应点）。 */
    canApplyMarker(): boolean {
        const pairs = this.markerGroups.filter(g => g.m1 && g.m2).length;
        return !!this.markerModel1 && !!this.markerModel2 && pairs >= 3;
    }

    /** 应用标记对齐：模型2 刚体变换对齐到 模型1（Kabsch）。 */
    applyMarkerAlign(): void {
        const m1 = this.markerModel1, m2 = this.markerModel2;
        if (!m1 || !m2) { this.onStatus?.('需要先指定 模型1 与 模型2'); return; }
        const pairs = this.markerGroups.filter(g => g.m1 && g.m2);
        if (pairs.length < 3) { this.onStatus?.(`至少需要 3 组对应点（当前 ${pairs.length}）`); return; }

        // 退化检查：3 个对应点不能共线或近似共线
        const w1 = pairs.map(g => m1.entity.getWorldTransform().transformPoint(g.m1!) as Vec3);
        const w2 = pairs.map(g => m2.entity.getWorldTransform().transformPoint(g.m2!) as Vec3);
        const area = this.triangleArea(w1[0], w1[1], w1[2]) * this.triangleArea(w2[0], w2[1], w2[2]);
        if (area < 1e-12) {
            this.onStatus?.('✗ 标记点近似共线，无法确定可靠旋转，请重新选择特征点');
            return;
        }

        const A = new Float32Array(9), B = new Float32Array(9);
        for (let i = 0; i < 3; i++) {
            A[i * 3] = w2[i].x; A[i * 3 + 1] = w2[i].y; A[i * 3 + 2] = w2[i].z; // A = 模型2
            B[i * 3] = w1[i].x; B[i * 3 + 1] = w1[i].y; B[i * 3 + 2] = w1[i].z; // B = 模型1
        }
        try {
            const { R, t } = kabsch(A, B);
            const r = R.data;
            const T = new Mat4();
            T.set([
                r[0], r[1], r[2], 0,
                r[4], r[5], r[6], 0,
                r[8], r[9], r[10], 0,
                t.x, t.y, t.z, 1
            ]);

            // 校验 T 无 NaN/Inf 且行列式正常
            if (!this.isRigidTransformValid(T)) {
                this.onStatus?.('✗ 计算出的对齐变换异常（可能标记点退化），请重新标记');
                return;
            }

            // 撤销快照：只记录会被移动的模型2
            this.pushHistory('标记对齐', [m2]);

            const oldScale = m2.entity.getLocalScale().clone();
            const W2 = m2.entity.getWorldTransform();
            const W2p = T.clone().mul(W2);
            const parent = m2.entity.getParent();
            const invP = parent ? parent.getWorldTransform().clone().invert() : new Mat4();
            const newLocal = invP.mul(W2p);

            // 从 newLocal 提取正交旋转（防止数值误差导致 scale 被污染）
            const rotQuat = this.extractRotationQuat(newLocal);
            m2.entity.setLocalPosition(newLocal.getTranslation());
            m2.entity.setLocalRotation(rotQuat);
            m2.entity.setLocalScale(oldScale); // 刚性对齐不改变 scale

            m2.computeWorldAabb();
            this.frameAll();
            this.onStatus?.('✓ 标记对齐完成：模型2 已对齐到 模型1');
            this.onModelsChange?.();
        } catch (e) {
            this.onStatus?.('✗ 标记对齐失败：' + (e instanceof Error ? e.message : String(e)));
        }
    }

    private triangleArea(a: Vec3, b: Vec3, c: Vec3): number {
        const ab = b.clone().sub(a);
        const ac = c.clone().sub(a);
        const cross = new Vec3().cross(ab, ac);
        return cross.length() * 0.5;
    }

    private isRigidTransformValid(m: Mat4): boolean {
        for (let i = 0; i < 16; i++) {
            const v = m.data[i];
            if (!Number.isFinite(v)) return false;
        }
        const det = m.data[0] * (m.data[5] * m.data[10] - m.data[6] * m.data[9])
                  - m.data[4] * (m.data[1] * m.data[10] - m.data[2] * m.data[9])
                  + m.data[8] * (m.data[1] * m.data[6] - m.data[2] * m.data[5]);
        return Math.abs(det) > 1e-6 && Math.abs(det) < 1e6;
    }

    private extractRotationQuat(m: Mat4): Quat {
        // 提取正交归一化基，避免 scale/shear 污染四元数
        const sx = new Vec3(m.data[0], m.data[1], m.data[2]).normalize();
        const sy = new Vec3(m.data[4], m.data[5], m.data[6]).normalize();
        // 重新正交化：sz = sx × sy，sy = sz × sx
        const sz = new Vec3().cross(sx, sy).normalize();
        const sy2 = new Vec3().cross(sz, sx).normalize();
        const rotMat = new Mat4();
        rotMat.set([
            sx.x, sx.y, sx.z, 0,
            sy2.x, sy2.y, sy2.z, 0,
            sz.x, sz.y, sz.z, 0,
            0, 0, 0, 1
        ]);
        return matToQuat(rotMat);
    }

    // ---- 撤销 / 重做 ----

    /** 记录当前变换快照（用于撤销/重做）。 */
    pushHistory(type: string, models: MergeModel[]): void {
        this.redoStack = [];
        this.undoStack.push({
            type,
            states: models.map(m => ({
                model: m,
                pos: m.entity.getLocalPosition().clone(),
                rot: m.entity.getLocalRotation().clone(),
                scale: m.entity.getLocalScale().clone()
            }))
        });
        if (this.undoStack.length > this.MAX_HISTORY) this.undoStack.shift();
        this.onHistoryChange?.();
    }

    canUndo(): boolean { return this.undoStack.length > 0; }
    canRedo(): boolean { return this.redoStack.length > 0; }

    undo(): void {
        if (!this.canUndo()) return;
        const entry = this.undoStack.pop()!;
        // 保存当前状态到 redo
        this.redoStack.push({
            type: entry.type,
            states: entry.states.map(s => ({
                model: s.model,
                pos: s.model.entity.getLocalPosition().clone(),
                rot: s.model.entity.getLocalRotation().clone(),
                scale: s.model.entity.getLocalScale().clone()
            }))
        });
        // 应用历史状态
        for (const s of entry.states) {
            if (!this.models.includes(s.model)) continue;
            s.model.entity.setLocalPosition(s.pos);
            s.model.entity.setLocalRotation(s.rot);
            s.model.entity.setLocalScale(s.scale);
            s.model.computeWorldAabb();
        }
        this.frameAll();
        this.onModelsChange?.();
        this.onStatus?.(`已撤销：${entry.type}`);
        this.onHistoryChange?.();
    }

    redo(): void {
        if (!this.canRedo()) return;
        const entry = this.redoStack.pop()!;
        // 保存当前状态到 undo
        this.undoStack.push({
            type: entry.type,
            states: entry.states.map(s => ({
                model: s.model,
                pos: s.model.entity.getLocalPosition().clone(),
                rot: s.model.entity.getLocalRotation().clone(),
                scale: s.model.entity.getLocalScale().clone()
            }))
        });
        if (this.undoStack.length > this.MAX_HISTORY) this.undoStack.shift();
        for (const s of entry.states) {
            if (!this.models.includes(s.model)) continue;
            s.model.entity.setLocalPosition(s.pos);
            s.model.entity.setLocalRotation(s.rot);
            s.model.entity.setLocalScale(s.scale);
            s.model.computeWorldAabb();
        }
        this.frameAll();
        this.onModelsChange?.();
        this.onStatus?.(`已重做：${entry.type}`);
        this.onHistoryChange?.();
    }

    /** 清空所有标记（保留模型指派）。 */
    clearMarkerAlign(): void {
        this.markerGroups = [{}, {}, {}];
        for (const el of this.markerEls) {
            el.active = false;
            el.model = null;
            el.hitLocal.set(0, 0, 0);
            el.el.style.display = 'none';
        }
        this.selectMarker(null);
        this.onStatus?.('已清空标记');
        this.onMarkerChange?.();
    }

    /** 点击面板 tab 切换当前标记模型（同步选择高亮）。 */
    setMarkerActive(key: 'm1' | 'm2'): void {
        const m = key === 'm1' ? this.markerModel1 : this.markerModel2;
        if (!m) { this.onStatus?.(`尚未指定 ${key === 'm1' ? '模型1' : '模型2'}`); return; }
        this.setSelection([m]);
        this.onMarkerChange?.();
    }

    // --------------------------------------------------------------
    // 合并导出
    // --------------------------------------------------------------

    async exportMerged(outName: string): Promise<{ name: string; data: Uint8Array; count: number }> {
        const sel = this.selected;
        const targets = sel.length >= 2 ? sel : this.models;
        if (targets.length < 1) throw new Error('没有可导出的模型');
        this.onStatus?.(`合并 ${targets.length} 个模型（${targets.reduce((s, m) => s + m.numSplats, 0)} 高斯）…`);
        const gsplatData = buildMergedGSplatData(targets);
        const data = await exportMergedPly(gsplatData, outName);
        this.onStatus?.(`✓ 合并完成 ${outName}（${data.length} 字节，${gsplatData.numSplats} 高斯）`);
        return { name: outName, data, count: gsplatData.numSplats };
    }

    /** 用户指定的输出文件夹（合并导出"输出到该文件夹"按钮，可选）。 */
    private outputDirHandle: FileSystemDirectoryHandle | null = null;
    setOutputFolder(dir: FileSystemDirectoryHandle | null): void {
        this.outputDirHandle = dir;
        this.onModelsChange?.();
    }
    get hasOutputFolder(): boolean {
        return !!this.outputDirHandle;
    }
    get outputFolderName(): string {
        return this.outputDirHandle?.name || '';
    }
    get outputDir(): FileSystemDirectoryHandle | null {
        return this.outputDirHandle;
    }

    // --------------------------------------------------------------
    // 相机
    // --------------------------------------------------------------

    frameAll(): void {
        if (this.models.length === 0) return;
        // 合并 AABB
        const xs = this.models.map(m => m.worldBound.center.x - m.worldBound.halfExtents.x);
        const xe = this.models.map(m => m.worldBound.center.x + m.worldBound.halfExtents.x);
        const ys = this.models.map(m => m.worldBound.center.y - m.worldBound.halfExtents.y);
        const ye = this.models.map(m => m.worldBound.center.y + m.worldBound.halfExtents.y);
        const zs = this.models.map(m => m.worldBound.center.z - m.worldBound.halfExtents.z);
        const ze = this.models.map(m => m.worldBound.center.z + m.worldBound.halfExtents.z);
        this.target.set(
            (Math.min(...xs) + Math.max(...xe)) / 2,
            (Math.min(...ys) + Math.max(...ye)) / 2,
            (Math.min(...zs) + Math.max(...ze)) / 2
        );
        this.baseRadius = Math.max(
            Math.max(...xe) - Math.min(...xs),
            Math.max(...ye) - Math.min(...ys),
            Math.max(...ze) - Math.min(...zs)
        ) * 0.5 || 1;
        this.zoomLevel = 1;
    }

    private calcForward(): Vec3 {
        const az = (this.azimuth * Math.PI) / 180;
        const el = (this.elevation * Math.PI) / 180;
        const ce = Math.cos(el);
        return new Vec3(ce * Math.sin(az), Math.sin(el), ce * Math.cos(az));
    }

    /** 计算相机的 up 向量，在竖直视角附近平滑过渡，避免 lookAt 退化与 roll 翻转。
     *  水平时 up=(0,1,0)；接近竖直时按 azimuth  blended 到水平方向，保证过顶/过底连续。 */
    private calcCameraUp(forward: Vec3, azimuth: number): Vec3 {
        const fy = forward.y;
        const blend = Math.max(0, (Math.abs(fy) - 0.85) / (1 - 0.85));
        const az = (azimuth * Math.PI) / 180;
        // 竖直时的 screen-up：与当前 azimuth 水平方向一致
        const verticalUp = new Vec3(-Math.sin(az), 0, -Math.cos(az));
        const defaultUp = new Vec3(0, 1, 0);
        return new Vec3().lerp(defaultUp, verticalUp, blend).normalize();
    }

    /** 右上角 X/Y/Z 轴导航 overlay */
    /** 主程序风格无限网格（GPU shader）。 */
    private grid!: MergeGrid;
    /** 右上角坐标轴（SVG ViewCube，主程序样式）。 */
    private viewCube: MergeViewCube | null = null;

    private initAxesOverlay(): void {
        // 主程序样式 SVG 坐标轴（替换旧 canvas Blender 环）
        this.viewCube = new MergeViewCube((axis, neg) => {
            this.snapToAxis(axis, neg);
        });
    }

    /** 视窗底部 3 个正方形按钮：俯视 / 正视 / 侧视，点击直接进入对应正交视角。 */
    private initViewButtons(): void {
        // 清理旧实例（防止重复初始化叠加）
        document.getElementById('merge-view-btns')?.remove();

        const wrap = document.createElement('div');
        wrap.id = 'merge-view-btns';
        wrap.style.cssText =
            'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);' +
            'display:flex;gap:10px;z-index:11;user-select:none;';

        const defs: { label: string; axis: 'x' | 'y' | 'z'; neg: boolean }[] = [
            { label: '俯视', axis: 'y', neg: false }, // 从上往下看（Y 轴负方向）
            { label: '正视', axis: 'z', neg: false }, // 沿 Z 轴正视（XY 平面）
            { label: '侧视', axis: 'x', neg: false }  // 沿 X 轴侧视（ZY 平面）
        ];

        for (const d of defs) {
            const b = document.createElement('button');
            b.textContent = d.label;
            b.title = `${d.label}（直接对齐正交视角）`;
            b.style.cssText =
                'width:46px;height:46px;border-radius:8px;cursor:pointer;' +
                'font:bold 14px system-ui,"Microsoft YaHei",sans-serif;color:#eaecef;' +
                'background:rgba(28,32,38,0.85);border:1px solid rgba(255,255,255,0.22);' +
                'box-shadow:0 2px 8px rgba(0,0,0,0.35);outline:none;transition:all .12s ease;';
            b.addEventListener('mouseenter', () => {
                b.style.background = 'rgba(48,54,62,0.95)';
                b.style.borderColor = '#ffb454';
            });
            b.addEventListener('mouseleave', () => {
                b.style.background = 'rgba(28,32,38,0.85)';
                b.style.borderColor = 'rgba(255,255,255,0.22)';
            });
            b.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.snapToAxis(d.axis, d.neg);
            });
            wrap.appendChild(b);
        }
        document.body.appendChild(wrap);
    }

    /** 正视某轴：azimuth/elevation 对齐到对应方向。neg=true 表示负方向。 */
    private snapToAxis(axis: 'x' | 'y' | 'z', neg: boolean): void {
        const sign = neg ? -1 : 1;
        if (axis === 'x') {
            this.azimuth = sign * 90;
            this.elevation = 0;
        } else if (axis === 'y') {
            // Y 轴：elevation=+90 = 俯视（从上方看顶部），elevation=-90 = 仰视（从下方看底部）
            this.azimuth = 0;
            this.elevation = neg ? -90 : 90;
        } else {
            // z
            this.azimuth = neg ? 180 : 0;
            this.elevation = 0;
        }
        // 重新定位 target 到模型焦点（如果有选中模型）
        const sel = this.selected;
        if (sel.length > 0) {
            const min = new Vec3(Infinity, Infinity, Infinity);
            const max = new Vec3(-Infinity, -Infinity, -Infinity);
            for (const m of sel) {
                const { center, halfExtents } = m.worldBound;
                min.x = Math.min(min.x, center.x - halfExtents.x);
                min.y = Math.min(min.y, center.y - halfExtents.y);
                min.z = Math.min(min.z, center.z - halfExtents.z);
                max.x = Math.max(max.x, center.x + halfExtents.x);
                max.y = Math.max(max.y, center.y + halfExtents.y);
                max.z = Math.max(max.z, center.z + halfExtents.z);
            }
            this.target.set((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
        }
    }

    /** 拾取 gizmo 手柄（屏幕距离判据）。返回 'mx'|'my'|'mz'|'rx'|'ry'|'rz'|'sx'|'sy'|'sz'|null。 */
    private pickGizmo(clientX: number, clientY: number): string | null {
        const ctx = this.gizmoContext();
        if (!ctx) return null;
        const { center, radius } = ctx;
        const L = radius * 1.0;
        const TH = 20;
        const axes = [
            { v: new Vec3(1, 0, 0), n: 'x' },
            { v: new Vec3(0, 1, 0), n: 'y' },
            { v: new Vec3(0, 0, 1), n: 'z' }
        ];
        const near = (x: number, y: number, tx: number, ty: number) => Math.hypot(x - tx, y - ty) < TH;
        for (const ax of axes) {
            const endW = center.clone().add(ax.v.clone().mulScalar(L));
            const endS = this.worldToScreen(endW);
            if (!endS) continue;
            if (near(clientX, clientY, endS.x, endS.y)) return 'm' + ax.n;
            // 缩放块在轴端略偏内
            const sW = center.clone().add(ax.v.clone().mulScalar(L * 0.85));
            const sS = this.worldToScreen(sW);
            if (sS && near(clientX, clientY, sS.x, sS.y)) return 's' + ax.n;
        }
        return null;
    }

    /** gizmo 手柄拖拽（增量累积），应用到选中模型（链锁联动）。 */
    private gizmoDrag(hit: string, dx: number, dy: number): void {
        const ctx = this.gizmoContext();
        if (!ctx || this.selected.length === 0) return;
        const { center, radius } = ctx;
        const L = radius * 1.0;
        const worldPerPx = this.worldPerPixelAt(center);

        if (hit.startsWith('m')) {
            // 沿轴移动：屏幕位移投影到轴方向
            const axis = hit[1] === 'x' ? new Vec3(1, 0, 0) : hit[1] === 'y' ? new Vec3(0, 1, 0) : new Vec3(0, 0, 1);
            const aS = this.worldToScreen(center.clone().add(axis.clone().mulScalar(L)));
            const cS = this.worldToScreen(center);
            if (!aS || !cS) return;
            const ax = aS.x - cS.x, ay = aS.y - cS.y;
            const al = Math.hypot(ax, ay) || 1;
            const t = (dx * ax + dy * ay) / al;
            const d = axis.clone().mulScalar(t * worldPerPx);
            this.applyTransformDelta('translate', d);
        } else if (hit.startsWith('s')) {
            const factor = Math.exp(-dy * 0.012);
            this.applyTransformDelta('scale', factor);
        }
    }

    private gizmoHit: string | null = null;

    // 框选状态
    private rectState: { x0: number; y0: number; x1: number; y1: number } | null = null;
    private rectEl: HTMLDivElement | null = null;

    private initRectEl(): void {
        const el = document.createElement('div');
        el.style.cssText = 'position:fixed;border:1px dashed #ffb454;background:rgba(255,180,84,0.12);z-index:8;display:none;pointer-events:none;';
        document.body.appendChild(el);
        this.rectEl = el;
    }

    private updateRectEl(): void {
        if (!this.rectEl || !this.rectState) { if (this.rectEl) this.rectEl.style.display = 'none'; return; }
        const { x0, y0, x1, y1 } = this.rectState;
        const x = Math.min(x0, x1), y = Math.min(y0, y1);
        this.rectEl.style.display = 'block';
        this.rectEl.style.left = x + 'px';
        this.rectEl.style.top = y + 'px';
        this.rectEl.style.width = Math.abs(x1 - x0) + 'px';
        this.rectEl.style.height = Math.abs(y1 - y0) + 'px';
    }

    /** 模型 AABB 在屏幕上的包围盒。 */
    private modelScreenAabb(model: MergeModel): { x0: number; y0: number; x1: number; y1: number } | null {
        const { center, halfExtents } = model.worldBound;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        let any = false;
        for (let cx = -1; cx <= 1; cx += 2) {
            for (let cy = -1; cy <= 1; cy += 2) {
                for (let cz = -1; cz <= 1; cz += 2) {
                    const p = new Vec3(
                        center.x + cx * halfExtents.x,
                        center.y + cy * halfExtents.y,
                        center.z + cz * halfExtents.z
                    );
                    const s = this.worldToScreen(p);
                    if (!s) continue;
                    any = true;
                    if (s.x < x0) x0 = s.x;
                    if (s.y < y0) y0 = s.y;
                    if (s.x > x1) x1 = s.x;
                    if (s.y > y1) y1 = s.y;
                }
            }
        }
        if (!any) return null;
        return { x0, y0, x1, y1 };
    }

    private finishRectSelect(): void {
        if (!this.rectState) return;
        const { x0, y0, x1, y1 } = this.rectState;
        const rx = Math.min(x0, x1), ry = Math.min(y0, y1);
        const rw = Math.abs(x1 - x0), rh = Math.abs(y1 - y0);
        const picked: MergeModel[] = [];
        for (const m of this.models) {
            if (!m.visible) continue;
            const s = this.modelScreenAabb(m);
            if (!s) continue;
            // 相交（或包含）
            if (s.x0 < rx + rw && s.x1 > rx && s.y0 < ry + rh && s.y1 > ry) picked.push(m);
        }
        this.setSelection(picked);
        this.rectState = null;
        this.updateRectEl();
        this.onStatus?.(picked.length ? `框选 ${picked.length} 个模型` : '框选：未选中模型');
    }

    /** 世界坐标 → 屏幕像素坐标（使用 PlayCanvas 官方 API，与渲染一致）。 */
    private worldToScreen(w: Vec3): { x: number; y: number } | null {
        // 点在相机后方/近平面后时剔除，防止 overlay 跳到屏幕另一侧或失踪。
        const camPos = this.camera.getPosition();
        const forward = this.camera.getWorldTransform().transformVector(new Vec3(0, 0, -1));
        const toPoint = new Vec3().sub2(w, camPos);
        if (toPoint.dot(forward) <= 0.01) return null;

        const s = this.camera.camera.worldToScreen(w);
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: rect.left + s.x,
            y: rect.top + s.y
        };
    }

    // --------------------------------------------------------------
    // Gizmo（3 轴移动 + 缩放 + 旋转手柄）
    // --------------------------------------------------------------


    /** 返回 gizmo 中心（选中模型合并 AABB 中心）与尺寸。 */
    private gizmoContext(): { center: Vec3; radius: number } | null {
        const sel = this.selected;
        if (sel.length === 0) return null;
        const min = new Vec3(Infinity, Infinity, Infinity);
        const max = new Vec3(-Infinity, -Infinity, -Infinity);
        for (const m of sel) {
            const { center, halfExtents } = m.worldBound;
            min.x = Math.min(min.x, center.x - halfExtents.x);
            min.y = Math.min(min.y, center.y - halfExtents.y);
            min.z = Math.min(min.z, center.z - halfExtents.z);
            max.x = Math.max(max.x, center.x + halfExtents.x);
            max.y = Math.max(max.y, center.y + halfExtents.y);
            max.z = Math.max(max.z, center.z + halfExtents.z);
        }
        const center = new Vec3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
        const radius = Math.max(max.x - min.x, max.y - min.y, max.z - min.z) * 0.5;
        return { center, radius: Math.max(radius, 0.001) };
    }

    /** 每帧绘制 gizmo：3 轴箭头 + 轴端缩放块 + 旋转环。 */
    private drawGizmo(): void {
        const ctx = this.gizmoContext();
        if (!ctx) return;
        const { center, radius } = ctx;
        const L = radius * 1.3;   // 手柄比模型外扩 30%，方便点击
        const axisDefs = [
            { v: new Vec3(1, 0, 0), color: new Color(0.93, 0.27, 0.27, 1), name: 'x' },
            { v: new Vec3(0, 1, 0), color: new Color(0.30, 0.78, 0.30, 1), name: 'y' },
            { v: new Vec3(0, 0, 1), color: new Color(0.27, 0.50, 0.95, 1), name: 'z' }
        ];
        const drawLine = (a: Vec3, b: Vec3, color: Color) =>
            this.app.drawLine(a, b, color, true, this.layer);
        const cube = (p: Vec3, half: number, ax: Vec3, perp1: Vec3, perp2: Vec3, color: Color) => {
            const off = ax.clone().mulScalar(half);
            const c00 = p.clone().add(perp1.clone().mulScalar(-half)).add(perp2.clone().mulScalar(-half)).add(off);
            const c01 = p.clone().add(perp1.clone().mulScalar(half)).add(perp2.clone().mulScalar(-half)).add(off);
            const c02 = p.clone().add(perp1.clone().mulScalar(half)).add(perp2.clone().mulScalar(half)).add(off);
            const c03 = p.clone().add(perp1.clone().mulScalar(-half)).add(perp2.clone().mulScalar(half)).add(off);
            const c10 = p.clone().add(perp1.clone().mulScalar(-half)).add(perp2.clone().mulScalar(-half)).sub(off);
            const c11 = p.clone().add(perp1.clone().mulScalar(half)).add(perp2.clone().mulScalar(-half)).sub(off);
            const c12 = p.clone().add(perp1.clone().mulScalar(half)).add(perp2.clone().mulScalar(half)).sub(off);
            const c13 = p.clone().add(perp1.clone().mulScalar(-half)).add(perp2.clone().mulScalar(half)).sub(off);
            for (const [a, b] of [[c00, c01], [c01, c02], [c02, c03], [c03, c00],
                                   [c10, c11], [c11, c12], [c12, c13], [c13, c10],
                                   [c00, c10], [c01, c11], [c02, c12], [c03, c13]] as [Vec3, Vec3][]) {
                drawLine(a, b, color);
            }
        };

        for (const ax of axisDefs) {
            const end = center.clone().add(ax.v.clone().mulScalar(L));
            const perp1 = new Vec3(ax.v.z, 0, -ax.v.x); if (perp1.lengthSq() < 1e-6) perp1.set(0, 1, 0);
            perp1.normalize();
            const perp2 = new Vec3().cross(ax.v, perp1).normalize();

            if (this.toolMode === 'move') {
                // Blender 风格：粗箭头（轴线）+ 端部箭头锥（3 条线围出锥）
                // 主轴（粗一些画两次：第一次稍微缩进，第二次外扩，视觉近似粗线）
                const tipBack = L * 0.15;
                const tipW = L * 0.09;
                const tipStart = end.clone().sub(ax.v.clone().mulScalar(tipBack));
                drawLine(center, tipStart, ax.color);  // 轴主干
                drawLine(center, tipStart, ax.color);  // 第二次叠加（粗线效果）
                // 箭头锥：从 end 拉 3 条线回到 tipStart 周围（围出锥形）
                const a1 = end;
                const a2 = tipStart.clone().add(perp1.clone().mulScalar(tipW));
                const a3 = tipStart.clone().add(perp2.clone().mulScalar(tipW));
                const a4 = tipStart.clone().sub(perp1.clone().mulScalar(tipW));
                const a5 = tipStart.clone().sub(perp2.clone().mulScalar(tipW));
                drawLine(a1, a2, ax.color); drawLine(a1, a3, ax.color);
                drawLine(a1, a4, ax.color); drawLine(a1, a5, ax.color);
                // 底面四边（封口）
                drawLine(a2, a3, ax.color); drawLine(a3, a5, ax.color);
                drawLine(a5, a4, ax.color); drawLine(a4, a2, ax.color);
            } else if (this.toolMode === 'rotate') {
                // Blender 风格：白色外圈 + 三色四分之一弧（仅可见半圆 → 3 段 60°）
                const ringR = radius * 0.65;
                const white = new Color(1, 1, 1, 1);
                // 白色外圈
                const rv1 = perp1.clone().mulScalar(ringR);
                const rv2 = perp2.clone().mulScalar(ringR);
                let prev = center.clone().add(rv1);
                for (let i = 1; i <= 48; i++) {
                    const a = (i / 48) * Math.PI * 2;
                    const pt = center.clone().add(rv1.clone().mulScalar(Math.cos(a))).add(rv2.clone().mulScalar(Math.sin(a)));
                    drawLine(prev, pt, white);
                    prev.copy(pt);
                }
                // 三色弧（每个轴 60°，从顶端向两侧对称）
                const arcR = ringR * 1.0;
                const arcSeg = 16;
                const drawArc = (startA: number, endA: number, c: Color) => {
                    let p0 = center.clone().add(rv1.clone().mulScalar(Math.cos(startA) * arcR)).add(rv2.clone().mulScalar(Math.sin(startA) * arcR));
                    for (let i = 1; i <= arcSeg; i++) {
                        const t = startA + (endA - startA) * (i / arcSeg);
                        const pt = center.clone().add(rv1.clone().mulScalar(Math.cos(t) * arcR)).add(rv2.clone().mulScalar(Math.sin(t) * arcR));
                        drawLine(p0, pt, c);
                        p0 = pt;
                    }
                };
                // 每轴：在当前正对相机方向画一段 60° 弧
                drawArc(0, Math.PI / 3, ax.color);
            } else if (this.toolMode === 'scale') {
                // Blender 风格：灰色线 + 灰色立方块
                const stopW = center.clone().add(ax.v.clone().mulScalar(L * 0.85));
                const gray = new Color(0.78, 0.78, 0.82, 1);
                drawLine(center, stopW, gray);
                drawLine(center, stopW, gray);  // 加粗（双画）
                const s = L * 0.11;
                cube(stopW, s, ax.v, perp1, perp2, gray);
            }
        }
    }

    /** 变换面板绝对设置：把选中模型某轴值设为目标值（链锁组内同增量联动）。 */
    setTransformValue(mode: 'position' | 'rotation' | 'scale', axis: 0 | 1 | 2, value: number): void {
        const sel = this.selected;
        if (sel.length === 0) return;
        const m = sel[0];
        let cur: number;
        if (mode === 'position') {
            const p = m.entity.getLocalPosition();
            cur = axis === 0 ? p.x : axis === 1 ? p.y : p.z;
        } else if (mode === 'rotation') {
            const e = m.entity.getLocalEulerAngles();
            cur = axis === 0 ? e.x : axis === 1 ? e.y : e.z;
        } else {
            const s = m.entity.getLocalScale();
            cur = axis === 0 ? s.x : axis === 1 ? s.y : s.z;
        }
        const delta = value - cur;
        if (Math.abs(delta) < 1e-9) return;
        if (mode === 'position') {
            this.applyTransformDelta('translate', new Vec3(axis === 0 ? delta : 0, axis === 1 ? delta : 0, axis === 2 ? delta : 0));
        } else if (mode === 'rotation') {
            this.applyTransformDelta('rotate', new Vec3(axis === 0 ? delta : 0, axis === 1 ? delta : 0, axis === 2 ? delta : 0));
        } else {
            this.applyTransformDelta('scale', value / (cur || 1e-9));
        }
        this.onModelsChange?.();
    }

    /** 读取选中模型某轴当前值（变换面板显示用）。 */
    getTransformValue(mode: 'position' | 'rotation' | 'scale', axis: 0 | 1 | 2): number {
        const sel = this.selected;
        if (sel.length === 0) return 0;
        const m = sel[0];
        if (mode === 'position') {
            const p = m.entity.getLocalPosition();
            return axis === 0 ? p.x : axis === 1 ? p.y : p.z;
        } else if (mode === 'rotation') {
            const e = m.entity.getLocalEulerAngles();
            return axis === 0 ? e.x : axis === 1 ? e.y : e.z;
        } else {
            const s = m.entity.getLocalScale();
            return axis === 0 ? s.x : axis === 1 ? s.y : s.z;
        }
    }

    /** 变换面板：左上角浮层（0.01 步进拖拽精确调整）。 */
    private createTransformPanel(): HTMLElement {
        const panel = document.createElement('div');
        panel.className = 'merge-tf-panel';
        panel.style.cssText = 'position:fixed;left:314px;top:14px;z-index:9;background:#1e2228;border:1px solid #333a42;border-radius:8px;padding:8px 10px;color:#e8e8e8;font:12px/1.5 system-ui,sans-serif;min-width:230px;display:none;';
        const header = document.createElement('div');
        header.style.cssText = 'color:#ffb454;font-weight:700;margin-bottom:6px;';
        header.textContent = '变换面板';
        panel.appendChild(header);

        // 三个互斥的 gizmo 选择器：移动 / 旋转 / 缩放
        const radios = document.createElement('div');
        radios.style.cssText = 'display:flex;gap:4px;margin-bottom:6px;';
        const modeBtns: Record<'move' | 'rotate' | 'scale', HTMLButtonElement> = {
            move: document.createElement('button'),
            rotate: document.createElement('button'),
            scale: document.createElement('button')
        };
        const labels = { move: '移动', rotate: '旋转', scale: '缩放' } as const;
        for (const k of ['move', 'rotate', 'scale'] as const) {
            const b = modeBtns[k];
            b.dataset.mode = k;
            b.textContent = labels[k];
            b.style.cssText = 'flex:1;padding:3px 6px;background:#262b32;border:1px solid #3d4650;border-radius:4px;color:#c9d1d9;cursor:pointer;font:inherit;';
            b.onmouseenter = () => { if (b.dataset.on !== '1') b.style.borderColor = '#ffb454'; };
            b.onmouseleave = () => { if (b.dataset.on !== '1') b.style.borderColor = '#3d4650'; };
            b.onclick = () => self.setToolMode(k);
            radios.appendChild(b);
        }
        panel.appendChild(radios);

        const self = this;
        const makeRow = (label: string, mode: 'position' | 'rotation' | 'scale', axis: 0 | 1 | 2) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:4px;margin:2px 0;';
            const lab = document.createElement('span');
            lab.textContent = label;
            lab.style.cssText = 'width:14px;color:#9aa4af;text-align:center;';
            const val = document.createElement('span');
            val.textContent = '0.000';
            val.style.cssText = 'flex:1;background:#262b32;border:1px solid #3d4650;border-radius:4px;padding:1px 6px;cursor:ew-resize;text-align:right;color:#c9d1d9;';
            row.appendChild(lab);
            row.appendChild(val);
            let dragging = false, startX = 0, startVal = 0;
            const refresh = () => {
                const v = self.getTransformValue(mode, axis);
                val.textContent = v.toFixed(3);
            };
            val.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                dragging = true;
                startX = e.clientX;
                startVal = self.getTransformValue(mode, axis);
                val.style.borderColor = '#ffb454';
                const onMove = (ev: MouseEvent) => {
                    if (!dragging) return;
                    // 0.01 步进：每像素 0.01
                    const target = startVal + (ev.clientX - startX) * 0.01;
                    const rounded = Math.round(target * 100) / 100;
                    self.setTransformValue(mode, axis, rounded);
                    val.textContent = rounded.toFixed(3);
                };
                const onUp = () => {
                    dragging = false;
                    val.style.borderColor = '';
                    window.removeEventListener('mousemove', onMove);
                    window.removeEventListener('mouseup', onUp);
                };
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
            });
            (val as any)._refresh = refresh;
            return { row, refresh };
        };

        // 每种模式的 X/Y/Z 容器（默认隐藏，根据 toolMode 切换显示）
        const containers: Record<'position' | 'rotation' | 'scale', { div: HTMLDivElement; rows: { refresh: () => void }[] }> = {
            position: { div: document.createElement('div'), rows: [] },
            rotation: { div: document.createElement('div'), rows: [] },
            scale: { div: document.createElement('div'), rows: [] }
        };
        const modeLabels: Array<['position' | 'rotation' | 'scale', string]> = [
            ['position', '位置'], ['rotation', '旋转'], ['scale', '缩放']
        ];
        const axisLabels = ['X', 'Y', 'Z'];
        for (const [modeKey, modeLabel] of modeLabels) {
            const c = containers[modeKey];
            c.div.style.cssText = 'display:none;flex-direction:column;gap:2px;margin-top:2px;';
            const lab = document.createElement('div');
            lab.textContent = modeLabel;
            lab.style.cssText = 'color:#9aa4af;font-size:11px;margin-top:4px;';
            c.div.appendChild(lab);
            for (let a = 0; a < 3; a++) {
                const { row, refresh } = makeRow(axisLabels[a], modeKey, a as 0 | 1 | 2);
                c.div.appendChild(row);
                c.rows.push({ refresh });
            }
            panel.appendChild(c.div);
        }
        const showContainer = (modeKey: 'position' | 'rotation' | 'scale') => {
            for (const k of ['position', 'rotation', 'scale'] as const) {
                containers[k].div.style.display = (k === modeKey) ? 'flex' : 'none';
            }
        };

        this._tfRefresh = () => {
            const show = self.selected.length > 0;
            panel.style.display = show ? 'block' : 'none';
            if (!show) return;
            // 根据 toolMode 决定显示哪个组的 X/Y/Z
            const tfm: 'position' | 'rotation' | 'scale' = self.toolMode === 'move' ? 'position'
                : self.toolMode === 'rotate' ? 'rotation'
                : self.toolMode === 'scale' ? 'scale' : 'position';
            showContainer(tfm);
            for (const r of containers[tfm].rows) r.refresh();
            // 同步 radio 按钮高亮
            for (const k of ['move', 'rotate', 'scale'] as const) {
                const b = modeBtns[k];
                const on = (self.toolMode === k);
                b.dataset.on = on ? '1' : '0';
                b.style.background = on ? '#3d3024' : '#262b32';
                b.style.borderColor = on ? '#ffb454' : '#3d4650';
                b.style.color = on ? '#ffb454' : '#c9d1d9';
            }
        };
        this._tfShowContainer = showContainer;
        this._tfModeBtns = modeBtns;
        document.body.appendChild(panel);
        // 初始默认显示移动
        showContainer('position');
        modeBtns.move.dataset.on = '1';
        modeBtns.move.style.background = '#3d3024';
        modeBtns.move.style.borderColor = '#ffb454';
        modeBtns.move.style.color = '#ffb454';
        return panel;
    }
    private _tfRefresh: (() => void) | null = null;
    private _tfShowContainer: ((m: 'position' | 'rotation' | 'scale') => void) | null = null;
    private _tfModeBtns: Record<'move' | 'rotate' | 'scale', HTMLButtonElement> | null = null;
    /** 同步左上角变换面板的 gizmo 选择器与 toolMode 一致（外部调用 setToolMode 时刷新）。 */
    private syncTfModeUI(): void {
        this._tfRefresh?.();
    }
    refreshTransformPanel(): void {
        this._tfRefresh?.();
    }

    /** 变换面板：左上角浮层（0.01 步进拖拽精确调整）。 */
    private update(): void {        const forward = this.calcForward();
        const fovRad = (this.fov * Math.PI) / 180;
        const dist = Math.max(0.1, (this.baseRadius / Math.sin(fovRad / 2)) * 1.15 * this.zoomLevel);
        const pos = this.target.clone().add(forward.clone().mulScalar(dist));
        this.camera.setPosition(pos.x, pos.y, pos.z);
        // 用平滑 up，避免俯视/仰视（视线接近竖直）时朝向退化与 roll 翻转
        const up = this.calcCameraUp(forward, this.azimuth);
        this.camera.lookAt(this.target.x, this.target.y, this.target.z, up.x, up.y, up.z);

        // 每帧强制排序（GSplat 需要 sorter 感知相机；模型少，代价小）
        for (const m of this.models) {
            const inst = m.entity.gsplat?.instance;
            if (inst?.sorter) {
                try { inst.sort(this.camera); } catch { /* best-effort */ }
            }
        }
        this.grid.updateCameraUniforms();
        this.drawSelectionBoxes();
        this.drawGizmo();
        this.viewCube?.update(this.camera.getWorldTransform());
        this.updateMarkerOverlays();
        this.updateMarkerGizmo();
        this.refreshTransformPanel();
    }

    // --------------------------------------------------------------
    // 输入
    // --------------------------------------------------------------

    private readonly ORBIT_SENSITIVITY = 0.3;
    private readonly ZOOM_SENSITIVITY = 0.25;
    private dragMoved = false;

    // 工具模式：view=相机操作；move/rotate/scale=拖拽调整选中模型
    private toolMode: 'view' | 'move' | 'rotate' | 'scale' = 'view';
    private dragModel: MergeModel | null = null;
    private dragLastX = 0;
    private dragLastY = 0;

    // WSAD 键盘平移选中模型
    private keys: Record<string, boolean> = {};
    private canvasHover = false;

    setToolMode(mode: 'view' | 'move' | 'rotate' | 'scale'): void {
        this.toolMode = mode;
        // 同步面板 gizmo 选择器与 gizmo 渲染
        this.syncTfModeUI();
    }

    get activeToolMode(): string {
        return this.toolMode;
    }

    /** 对齐模式：manual=手动(默认)、auto=一键自动对齐、marker=标记(对应点)对齐。 */
    private alignMode: 'manual' | 'auto' | 'marker' = 'manual';
    setAlignMode(mode: 'manual' | 'auto' | 'marker'): void {
        const prev = this.alignMode;
        this.alignMode = mode;
        if (mode === 'marker') {
            this.markerPicking = true;
            this.assignMarkerModels();
            this.onStatus?.('标记对齐：先在列表或点选指定「模型1」，在特征处点 3 处标记；再指定「模型2」点对应 3 处，自动对齐');
        } else if (prev === 'marker') {
            // 离开 marker 模式：隐藏 overlay、停止拾取、释放 gizmo
            this.markerPicking = false;
            for (const el of this.markerEls) { el.active = false; el.el.style.display = 'none'; }
            this.selectMarker(null);
        }
        this.onAlignModeChange?.();
        this.onMarkerChange?.();
    }
    get currentAlignMode(): string {
        return this.alignMode;
    }

    private bindInput(): void {
        const c = this.canvas;

        // WSAD 键盘平移选中模型（仅在鼠标悬停合并画布时生效，避免干扰主编辑器）
        this.canvasHover = false;
        c.addEventListener('mouseenter', () => { this.canvasHover = true; });
        c.addEventListener('mouseleave', () => { this.canvasHover = false; });
        const tagOk = (t: EventTarget | null) =>
            !(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement);
        window.addEventListener('keydown', (e: KeyboardEvent) => {
            if (!this.canvasHover || !tagOk(e.target)) return;
            if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight'].includes(e.code)) {
                this.keys[e.code] = true;
                e.preventDefault();
            }
        });
        window.addEventListener('keyup', (e: KeyboardEvent) => {
            this.keys[e.code] = false;
        });
        window.addEventListener('blur', () => { this.keys = {}; });

        c.addEventListener('mousedown', (e: MouseEvent) => {
            // TranslateGizmo 手柄拖拽优先：命中并拖拽手柄时，不启动 orbit/模型操作
            if (this.gizmoDragging) return;
            if (e.button === 1) e.preventDefault();

            this.activeButton = e.button;
            this.lastX = e.clientX;
            this.lastY = e.clientY;
            this.dragMoved = false;

            // 左键
            if (e.button === 0) {
            // 0) 标记模式：命中已有标记点 → 选中显示 gizmo + 进入拖拽编辑（主程序测量交互范式）
            if (this.alignMode === 'marker' && this.markerPicking) {
                const mhit = this.pickMarkerPoint(e.clientX, e.clientY);
                if (mhit) {
                    this.markerDrag = mhit;
                    this.selectMarker(mhit);
                    this.markerDragMoved = false;
                    return;
                }
            }
                // 1) gizmo 手柄优先（拖拽变换）
                if (this.toolMode !== 'view') {
                    const gizmoH = this.pickGizmo(e.clientX, e.clientY);
                    if (gizmoH) {
                        this.gizmoHit = gizmoH;
                        return;
                    }
                }
                // 2) 双击检测
                const now = performance.now();
                if (now - this.lastClickTime < this.DBL_CLICK_MS &&
                    Math.abs(e.clientX - this.lastClickX) < this.DBL_CLICK_PX &&
                    Math.abs(e.clientY - this.lastClickY) < this.DBL_CLICK_PX) {
                    const pick = this.pickScreen(e.clientX, e.clientY);
                    if (pick && !this.markerPicking) this.setSelection([pick.model]);
                    this.lastClickTime = 0;
                    return;
                }
                this.lastClickTime = now;
                this.lastClickX = e.clientX;
                this.lastClickY = e.clientY;
                // 3) 单击无拖拽在 mouseup 中处理
                // 4) 空格拖拽 = orbit（mousemove 中触发）；Ctrl+空格拖拽 = 框选
                if (e.ctrlKey) {
                    this.rectState = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
                    this.updateRectEl();
                }
            }
        });

        window.addEventListener('mouseup', () => {
            // 标记拖拽结束：点中已有点（含拖拽移动后），不新增标记点
            if (this.markerDrag) {
                this.markerDrag = null;
                this.markerDragMoved = false;
                this.gizmoHit = null;
                this.rectState = null;
                this.activeButton = null;
                this.updateRectEl();
                return;
            }
            // 单击（无拖拽）→ 选中
            if (this.activeButton === 0 && !this.dragMoved) {
                this.handleClick(this.lastX, this.lastY, false);
            } else if (this.rectState && this.activeButton === 0 && this.dragMoved) {
                // 真正拖拽出的框选
                this.finishRectSelect();
            }
            this.gizmoHit = null;
            this.rectState = null;
            this.activeButton = null;
            this.updateRectEl();
        });

        window.addEventListener('mousemove', (e: MouseEvent) => {
            if (this.activeButton === null && !this.gizmoDragging) return;
            const dx = e.clientX - this.lastX;
            const dy = e.clientY - this.lastY;
            if (Math.abs(dx) + Math.abs(dy) > 3) this.dragMoved = true;
            this.lastX = e.clientX;
            this.lastY = e.clientY;

            // 0) TranslateGizmo 手柄拖拽优先
            if (this.gizmoDragging) return;
            // 1) 标记点拖拽（标记模式点中已有点）
            if (this.markerDrag && this.activeButton === 0) {
                this.markerDragMoved = true;
                this.dragMarkerTo(this.markerDrag, e.clientX, e.clientY);
                return;
            }
            // 2) 模型 gizmo 拖拽
            if (this.gizmoHit && this.activeButton === 0) {
                this.gizmoDrag(this.gizmoHit, dx, dy);
                return;
            }
            // 2) 框选（Ctrl+左键拖拽）
            if (this.rectState && this.activeButton === 0) {
                this.rectState.x1 = e.clientX;
                this.rectState.y1 = e.clientY;
                this.updateRectEl();
                return;
            }
            // 3) 左键空格拖拽 = orbit
            if (this.activeButton === 0) {
                this.orbit(dx, dy);
            }
            // 4) 中键 = 平移
            else if (this.activeButton === 1) this.pan(dx, dy);
            // 5) 右键 = 飞行
            else if (this.activeButton === 2) {
                this.fly(dx, dy);
            }
        });

        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            this.zoom(e.deltaY * 0.002);
        };
        window.addEventListener('wheel', onWheel, { passive: false });
        c.addEventListener('contextmenu', (e: Event) => e.preventDefault());

        // WASD 键盘：仅在 X/Y/Z 正交正视时生效，用于模型精准对接
        // Q/E：仅影响视野（环绕旋转），不移动模型
        window.addEventListener('keydown', (e: KeyboardEvent) => {
            if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
            const k = e.key.toLowerCase();

            // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y = 撤销/重做
            if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y')) {
                e.preventDefault();
                if (k === 'y' || (k === 'z' && e.shiftKey)) this.redo();
                else this.undo();
                return;
            }

            // Q/E = 视野环绕（不影响模型）
            if (k === 'q' || k === 'e') {
                e.preventDefault();
                const deg = (k === 'e' ? 1 : -1) * (e.shiftKey ? 3 : 1);
                this.azimuth += deg;
                return;
            }

            // WASD = 模型移动（仅手动模式 + 正交正视视角下生效，按屏幕上下左右方向）
            if (this.alignMode !== 'manual' || !this.canvasHover) return;
            if (this.selected.length === 0 || !['w','a','s','d'].includes(k)) return;

            const fwd = this.calcForward();
            const absX = Math.abs(fwd.x), absY = Math.abs(fwd.y), absZ = Math.abs(fwd.z);
            // 只在前向与某轴重合 < 3° 时才视为正交正视（俯视/正视/侧视）
            const isFaceOn = absX > 0.998 || absY > 0.998 || absZ > 0.998;
            if (!isFaceOn) return;

            // 步长随模型尺寸与缩放自适应，Shift 加速 5 倍
            const base = Math.max(0.001, this.baseRadius * this.zoomLevel);
            const step = (e.shiftKey ? 5 : 1) * base * 0.01;
            // 屏幕右/上方向（基于相机朝向，而非世界轴）
            const az = (this.azimuth * Math.PI) / 180;
            const scrRight = new Vec3(Math.cos(az), 0, -Math.sin(az)).normalize();
            const scrUp = new Vec3().cross(fwd, scrRight).normalize();

            let delta: Vec3 | null = null;
            switch (k) {
                case 'w': delta = scrUp.clone().mulScalar(step); break;
                case 's': delta = scrUp.clone().mulScalar(-step); break;
                case 'a': delta = scrRight.clone().mulScalar(-step); break;
                case 'd': delta = scrRight.clone().mulScalar(step); break;
            }
            if (delta) {
                e.preventDefault();
                this.applyTransformDelta('translate', delta);
                this.onModelsChange?.();
            }
        });
    }

    /** 模型深度处的世界单位/像素（用于把屏幕位移映射到世界）。 */
    private worldPerPixelAt(worldPos: Vec3): number {
        const dist = worldPos.distance(this.camera.getPosition());
        const fovRad = (this.fov * Math.PI) / 180;
        const h = Math.max(1, this.canvas.height);
        return 2 * dist * Math.tan(fovRad / 2) / h;
    }

    private orbit(dx: number, dy: number): void {
        this.azimuth -= dx * this.ORBIT_SENSITIVITY;
        this.elevation = Math.max(-89, Math.min(89, this.elevation + dy * this.ORBIT_SENSITIVITY));
        // 如果有选中模型，把 target 同步到模型焦点（焦点旋转）
        const sel = this.selected;
        if (sel.length > 0) {
            const min = new Vec3(Infinity, Infinity, Infinity);
            const max = new Vec3(-Infinity, -Infinity, -Infinity);
            for (const m of sel) {
                const { center, halfExtents } = m.worldBound;
                min.x = Math.min(min.x, center.x - halfExtents.x);
                min.y = Math.min(min.y, center.y - halfExtents.y);
                min.z = Math.min(min.z, center.z - halfExtents.z);
                max.x = Math.max(max.x, center.x + halfExtents.x);
                max.y = Math.max(max.y, center.y + halfExtents.y);
                max.z = Math.max(max.z, center.z + halfExtents.z);
            }
            this.target.set(
                (min.x + max.x) / 2,
                (min.y + max.y) / 2,
                (min.z + max.z) / 2
            );
        }
    }

    /** 飞行视角：相机位置不变，相对当前观看方向旋转（不绕 target）。 */
    private fly(dx: number, dy: number): void {
        // 当前相机到 target 的方向
        const camPos = this.camera.getPosition();
        const dir = this.target.clone().sub(camPos);
        const dist = dir.length() || 1;
        dir.normalize();
        // 球面角：从 dir 反推当前 azimuth/elevation
        const el = Math.asin(Math.max(-1, Math.min(1, dir.y))) * 180 / Math.PI;
        const az = Math.atan2(dir.x, dir.z) * 180 / Math.PI;
        // 应用增量
        const newAz = az - dx * this.ORBIT_SENSITIVITY;
        const newEl = Math.max(-89, Math.min(89, el + dy * this.ORBIT_SENSITIVITY));
        this.azimuth = newAz;
        this.elevation = newEl;
        // 重新计算 target（保持相机位置不变，使新 target 在新方向上）
        const ce = Math.cos(newEl * Math.PI / 180);
        const newDir = new Vec3(ce * Math.sin(newAz), Math.sin(newEl * Math.PI / 180), ce * Math.cos(newAz));
        this.target.set(
            camPos.x + newDir.x * dist,
            camPos.y + newDir.y * dist,
            camPos.z + newDir.z * dist
        );
    }

    private pan(dx: number, dy: number): void {
        const az = (this.azimuth * Math.PI) / 180;
        const el = (this.elevation * Math.PI) / 180;
        const fwd = this.calcForward();
        const right = new Vec3(Math.cos(az), 0, -Math.sin(az));
        const up = new Vec3().cross(fwd, right).normalize();
        const scale = this.baseRadius * 0.002 * this.zoomLevel;
        this.target.add(right.clone().mulScalar(-dx * scale));
        this.target.add(up.clone().mulScalar(dy * scale));
    }

    private look(dx: number, dy: number): void {
        this.azimuth -= dx * this.ORBIT_SENSITIVITY;
        this.elevation = Math.max(-89, Math.min(89, this.elevation + dy * this.ORBIT_SENSITIVITY));
    }

    private zoom(delta: number): void {
        this.zoomLevel = Math.max(0.05, Math.min(20, this.zoomLevel * Math.exp(delta * this.ZOOM_SENSITIVITY * 2)));
    }
}
