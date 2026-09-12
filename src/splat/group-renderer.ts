import { Column, DataTable } from '@playcanvas/splat-transform';
import {
    ADDRESS_CLAMP_TO_EDGE,
    FILTER_NEAREST,
    PIXELFORMAT_R8,
    PIXELFORMAT_R16U,
    Asset,
    BoundingBox,
    Entity,
    GSplatData,
    GSplatResource,
    Quat,
    Texture,
    Vec3
} from 'playcanvas';

import { Splat } from './splat';
import { SplatGroup } from './splat-group';
import { State } from './splat-state';
import { TransformPalette } from './transform-palette';
import { vertexShader, fragmentShader, gsplatCenter, gsplatModifyVS } from '../shaders/splat-shader';
import { vertexShaderWGSL, fragmentShaderWGSL, gsplatCenterWGSL, gsplatModifyWGSL } from '../shaders/splat-shader-wgsl';

// Column types that carry per-gaussian position data in local space.
const POS_COLS = ['x', 'y', 'z'];

// Column types that carry per-gaussian rotation quaternion data in local space.
const ROT_COLS = ['rot_0', 'rot_1', 'rot_2', 'rot_3'];

// Standard gaussian columns (positions, scales, DC color, opacity, rotations).
const STANDARD_COLS = new Set([
    ...POS_COLS,
    ...ROT_COLS,
    'scale_0', 'scale_1', 'scale_2',
    'f_dc_0', 'f_dc_1', 'f_dc_2',
    'opacity'
]);

// Columns to skip during merge.
const SKIP_COLS = new Set(['transform']);

// Per-channel SH rest column count indexed by SH bands (0-3).
// 注意：splat-transform 的 f_rest_* 列是「每系数 × 3 通道」的展开列数，
// 即 1 阶=9、2 阶=24、3 阶=45（不是系数个数 3/8/15）。写错会丢弃高阶
// 球谐系数，合并后颜色角度细节急剧下降。
const SH_REST_COUNTS = [0, 9, 24, 45];

const _v3 = new Vec3();
const _quat = new Quat();
const _quat2 = new Quat();

/**
 * GroupRenderer merges the raw gaussian data of all splats in a group into a
 * single unified Entity that renders on the splatLayer with correct per-gaussian
 * global depth sorting. Individual splat meshInstances are hidden while the
 * group is active.
 *
 * Trade-offs:
 * - The merged entity uses a default shader (no per-splat color grading).
 * - Editing individual gaussians is not supported through the merged entity.
 * - Rebuild is synchronous and may be slow for very large groups.
 */
class GroupRenderer {
    private scene: any; // Scene (avoids circular import)
    private events: any;
    private group: SplatGroup | null = null;
    private mergedEntity: Entity | null = null;
    private mergedAsset: Asset | null = null;
    private dirty = true;

    // restore info for when the group is dissolved
    private hiddenSplats: { splat: Splat; oldLayers: number[] }[] = [];

    // pending old entity to clean up after new entity initializes (double-buffering)
    private pendingCleanupEntity: Entity | null = null;
    private pendingCleanupAsset: Asset | null = null;

    // Track each splat's range in the merged GSPlatData
    private splatOffsets = new Map<Splat, { start: number; count: number }>();
    private mergedGSplatData: GSplatData | null = null;

    // Cached zero textures for the merged entity shader. Created once on first
    // rebuild and reused across rebuilds to avoid WebGL texture leaks.
    private stateTex: Texture | null = null;
    private transformTex: Texture | null = null;
    // Identity transform palette bound to the merged material — the merged
    // transform column is all-zero (index 0), so the palette only needs the
    // identity entry. WITHOUT this binding the shader's applyPaletteTransform
    // samples an unbound texture → zero matrix → every gaussian collapses
    // (merged rendering looks corrupted / quality collapses).
    private mergedPalette: TransformPalette | null = null;

    // AABB recompute throttle (ms): during a drag the merged data updates every
    // frame, but walking all merged points for the AABB is O(total) — recompute
    // at most every ~33ms so drags stay smooth; the slight cull-box lag is
    // invisible in practice.
    private lastAabbUpdate = 0;

    constructor(scene: any, events: any) {
        this.scene = scene;
        this.events = events;
    }

    /** Whether a group is currently being rendered as a unified entity. */
    get isActive(): boolean {
        return this.mergedEntity !== null;
    }

    /**
     * Restore main camera sort request after PiP rendering.
     * PiP's render pass overwrites the shared GSplatInstance sorter with
     * the PiP camera position. Call this after PiP rendering to ensure
     * the next frame's main render uses the correct sort.
     */
    restoreMainSort(mainCameraEntity: Entity): void {
        if (!this.mergedEntity) return;
        const instance = (this.mergedEntity as any).gsplat?.instance;
        instance?.sort(mainCameraEntity);
    }

    /** Mark the merge as needing rebuild (e.g., after a splat transform/draw/edit). */
    markDirty(): void {
        this.dirty = true;
    }

    /**
     * Update the merged GSPlatData for a single splat whose transform has
     * changed (e.g. during a pivot drag). Re-applies the splat's current
     * world transform to its local gaussian data and writes the result into
     * the merged GSPlatData, then uploads to GPU.
     *
     * This keeps the merged entity intact with all splats, so per-gaussian
     * depth sorting remains correct throughout the drag.
     */
    updateSplatTransform(splat: Splat): void {
        if (!this.isActive || !this.group || !this.group.has(splat)) return;
        if (!this.mergedGSplatData || !this.mergedAsset) return;

        const offset = this.splatOffsets.get(splat);
        if (!offset) return;

        const sd = splat.splatData as GSplatData;
        const num = sd.numSplats;

        // Safety: if point count changed since rebuild, skip to avoid OOB write
        if (offset.count !== num) return;

        const worldMatrix = splat.entity.getWorldTransform();
        const worldRot = splat.entity.getRotation();

        const xs = sd.getProp('x') as Float32Array;
        const ys = sd.getProp('y') as Float32Array;
        const zs = sd.getProp('z') as Float32Array;
        const r0 = sd.getProp('rot_0') as Float32Array;
        const r1 = sd.getProp('rot_1') as Float32Array;
        const r2 = sd.getProp('rot_2') as Float32Array;
        const r3 = sd.getProp('rot_3') as Float32Array;
        const hasRot = !!(r0 && r1 && r2 && r3);

        const mx = this.mergedGSplatData.getProp('x') as Float32Array;
        const my = this.mergedGSplatData.getProp('y') as Float32Array;
        const mz = this.mergedGSplatData.getProp('z') as Float32Array;
        const mr0 = this.mergedGSplatData.getProp('rot_0') as Float32Array;
        const mr1 = this.mergedGSplatData.getProp('rot_1') as Float32Array;
        const mr2 = this.mergedGSplatData.getProp('rot_2') as Float32Array;
        const mr3 = this.mergedGSplatData.getProp('rot_3') as Float32Array;
        // 缩放烘焙（log 域加法）：merged 中该 splat 的 scale 段 = 原 scale + log(模型缩放)
        const ms0 = this.mergedGSplatData.getProp('scale_0') as Float32Array;
        const ms1 = this.mergedGSplatData.getProp('scale_1') as Float32Array;
        const ms2 = this.mergedGSplatData.getProp('scale_2') as Float32Array;
        const srcS0 = sd.getProp('scale_0') as Float32Array;
        const srcS1 = sd.getProp('scale_1') as Float32Array;
        const srcS2 = sd.getProp('scale_2') as Float32Array;
        const localScale = splat.entity.getLocalScale();
        const scaleLog = new Vec3(
            localScale.x > 0 ? Math.log(localScale.x) : 0,
            localScale.y > 0 ? Math.log(localScale.y) : 0,
            localScale.z > 0 ? Math.log(localScale.z) : 0
        );

        const { start } = offset;

        for (let i = 0; i < num; i++) {
            const srcIdx = i;
            const dstIdx = start + i;

            // Update position
            _v3.set(xs[srcIdx], ys[srcIdx], zs[srcIdx]);
            worldMatrix.transformPoint(_v3, _v3);
            mx[dstIdx] = _v3.x;
            my[dstIdx] = _v3.y;
            mz[dstIdx] = _v3.z;

            // Update rotation
            // GSplatData rot_0..3 = (w,x,y,z)（PLY 序）；PlayCanvas Quat = (x,y,z,w)
            if (hasRot && mr0) {
                _quat.set(r1[srcIdx], r2[srcIdx], r3[srcIdx], r0[srcIdx]);
                _quat2.copy(worldRot).mul(_quat).normalize();
                mr0[dstIdx] = _quat2.w;
                mr1[dstIdx] = _quat2.x;
                mr2[dstIdx] = _quat2.y;
                mr3[dstIdx] = _quat2.z;
            }

            // Update scale（log 域加法烘焙模型缩放）
            if (srcS0 && ms0) {
                ms0[dstIdx] = srcS0[srcIdx] + scaleLog.x;
                ms1[dstIdx] = srcS1[srcIdx] + scaleLog.y;
                ms2[dstIdx] = srcS2[srcIdx] + scaleLog.z;
            }
        }

        // Update GPU texture data from the merged GSPlatData
        const resource = this.mergedAsset.resource as GSplatResource;
        resource.updateTransformData(this.mergedGSplatData);

        // Refresh the merged entity's world AABB (positions moved during the
        // drag), throttled to ~30Hz — without a fresh box the frustum-cull box
        // stays stale and the model can vanish at angles where the old box
        // leaves the camera frustum; but recomputing it every frame doubles
        // the per-frame full-model walk.
        const now = performance.now();
        if (now - this.lastAabbUpdate > 33) {
            this.lastAabbUpdate = now;
            const inst = this.mergedEntity.gsplat?.instance;
            if (inst && this.mergedGSplatData) {
                // @ts-ignore
                inst.meshInstance._aabb = this._computeMergedAabb(this.mergedGSplatData);
            }
        }

        this.scene.boundDirty = true;
        this.scene.forceRender = true;
    }

    /** Set the active group for unified rendering, null to dissolve. */
    setGroup(group: SplatGroup | null): void {
        if (this.group === group) return;
        this.destroy();
        this.group = group;
        this.dirty = true;
    }

    /** Call before each render frame. Rebuilds if dirty. */
    sync(): void {
        // Clean up old merged entity once force-render frames have elapsed
        // (gives new entity's GSplat pipeline time to initialize).
        if (this.scene.forceRenderFrames <= 0 && (this.pendingCleanupEntity || this.pendingCleanupAsset)) {
            this.cleanupOldEntity();
        }

        if (!this.dirty) return;
        this.dirty = false;

        if (this.group && this.group.size >= 2) {
            this.rebuild();
        }
    }

    /** Get the unified world bounding box of the current merged group entity. */
    get worldBound(): any | null {
        if (!this.mergedEntity) return null;
        const instance = this.mergedEntity.gsplat?.instance;
        if (!instance) return null;
        // @ts-ignore
        return instance.meshInstance?._aabb ?? null;
    }

    // ---- internals ----

    /**
     * Build a merged GSplatData from the given splats. Positions and rotations
     * are transformed to world space. SH bands are aligned via zero-padding.
     * Does NOT add state/transform columns — the caller may add them as needed.
     *
     * This is shared by rebuild() (for live rendering) and the merge-to-new-model
     * flow in editor.ts.
     */
    buildMergedGSplatData(splats: Splat[]): GSplatData {
        // -- Step 1: find max SH bands across all splats --
        let maxSHBands = 0;
        for (const s of splats) {
            const res = (s.asset.resource as GSplatResource);
            const bands = (res.shBands ?? 0);
            if (bands > maxSHBands) maxSHBands = bands;
        }
        const maxRestCols = SH_REST_COUNTS[maxSHBands] ?? 0;

        // -- Step 2: transform & collect columns --
        const mergedColumns: Map<string, { type: string; data: any; byteSize: number }> = new Map();

        for (const s of splats) {
            const sd = s.splatData as GSplatData;
            const num = sd.numSplats;

            const worldMatrix = s.entity.getWorldTransform();
            const worldRot = s.entity.getRotation();
            const worldRotQ = worldRot.clone();
            // 模型缩放烘焙：GSplat scale 为 log 域，均匀缩放因子以 log 加法合成
            // （旋转已并入 splat rot；非均匀缩放按各轴 log 相加近似）
            const localScale = s.entity.getLocalScale();
            const scaleLog = new Vec3(
                localScale.x > 0 ? Math.log(localScale.x) : 0,
                localScale.y > 0 ? Math.log(localScale.y) : 0,
                localScale.z > 0 ? Math.log(localScale.z) : 0
            );

            const props = sd.getElement('vertex').properties as any[];
            const propMap = new Map<string, any>();
            for (const p of props) {
                propMap.set(p.name, p);
            }

            // Single pass: count rest columns + ensure columns exist in merged map
            let thisRestCount = 0;
            for (const p of props) {
                const name = p.name;
                if (SKIP_COLS.has(name)) continue;

                if (name.startsWith('f_rest_')) {
                    const idx = parseInt(name.split('_')[2], 10);
                    if (idx + 1 > thisRestCount) thisRestCount = idx + 1;
                    if (idx >= maxRestCols) continue;
                }

                this.ensureColumn(mergedColumns, name, p);
            }

            const hasPos = POS_COLS.every(c => propMap.has(c));
            const hasRot = ROT_COLS.every(c => propMap.has(c));

            for (const p of props) {
                const name = p.name;
                if (SKIP_COLS.has(name)) continue;

                if (name.startsWith('f_rest_')) {
                    const idx = parseInt(name.split('_')[2], 10);
                    if (idx >= maxRestCols) continue;
                    this.appendData(mergedColumns, name, p);
                } else if (name === 'x' && hasPos) {
                    const xs = propMap.get('x').storage as Float32Array;
                    const ys = propMap.get('y').storage as Float32Array;
                    const zs = propMap.get('z').storage as Float32Array;
                    const newX = new Float32Array(num);
                    const newY = new Float32Array(num);
                    const newZ = new Float32Array(num);
                    const newRot0 = hasRot ? new Float32Array(num) : null;
                    const newRot1 = hasRot ? new Float32Array(num) : null;
                    const newRot2 = hasRot ? new Float32Array(num) : null;
                    const newRot3 = hasRot ? new Float32Array(num) : null;

                    // Hoist rot column lookups out of the per-gaussian loop
                    const srcR0 = hasRot ? (propMap.get('rot_0').storage as Float32Array) : null;
                    const srcR1 = hasRot ? (propMap.get('rot_1').storage as Float32Array) : null;
                    const srcR2 = hasRot ? (propMap.get('rot_2').storage as Float32Array) : null;
                    const srcR3 = hasRot ? (propMap.get('rot_3').storage as Float32Array) : null;

                    for (let i = 0; i < num; i++) {
                        _v3.set(xs[i], ys[i], zs[i]);
                        worldMatrix.transformPoint(_v3, _v3);
                        newX[i] = _v3.x;
                        newY[i] = _v3.y;
                        newZ[i] = _v3.z;

                        if (hasRot) {
                            // GSplatData rot_0..3 = (w,x,y,z)（PLY 序）；PlayCanvas Quat = (x,y,z,w）
                            _quat.set(srcR1![i], srcR2![i], srcR3![i], srcR0![i]);
                            _quat2.copy(worldRotQ).mul(_quat).normalize();
                            newRot0![i] = _quat2.w;
                            newRot1![i] = _quat2.x;
                            newRot2![i] = _quat2.y;
                            newRot3![i] = _quat2.z;
                        }
                    }
                    this.concatArray(mergedColumns, 'x', newX);
                    this.concatArray(mergedColumns, 'y', newY);
                    this.concatArray(mergedColumns, 'z', newZ);
                    if (hasRot) {
                        this.concatArray(mergedColumns, 'rot_0', newRot0!);
                        this.concatArray(mergedColumns, 'rot_1', newRot1!);
                        this.concatArray(mergedColumns, 'rot_2', newRot2!);
                        this.concatArray(mergedColumns, 'rot_3', newRot3!);
                    }
                } else if (POS_COLS.includes(name) || ROT_COLS.includes(name)) {
                    continue;
                } else if (name === 'opacity') {
                    // Deleted gaussians must NOT reappear in the merged model.
                    // Single-splat rendering hides them via the sorter mapping
                    // (splat.ts updateSorting → setMapping), but the merge copies
                    // raw data and resets the GPU state texture to all-zeros, so
                    // deleted points would render again as stray "flying" splats
                    // → visible quality drop. Zero their opacity instead (the
                    // point count stays aligned, so splatOffsets remain valid for
                    // updateSplatTransform).
                    const op = p.storage as Float32Array;
                    const st = propMap.get('state')?.storage as Uint8Array | undefined;
                    const out = new Float32Array(num);
                    if (st) {
                        for (let i = 0; i < num; i++) {
                            out[i] = (st[i] & State.deleted) ? 0 : op[i];
                        }
                    } else {
                        out.set(op);
                    }
                    this.concatArray(mergedColumns, name, out);
                } else if (name === 'scale_0' || name === 'scale_1' || name === 'scale_2') {
                    // 烘焙模型缩放：scale 为 log 域，均匀缩放以 log 加法合成
                    const src = p.storage as Float32Array;
                    const logAdd = name === 'scale_0' ? scaleLog.x : name === 'scale_1' ? scaleLog.y : scaleLog.z;
                    if (Math.abs(logAdd) < 1e-9) {
                        this.appendData(mergedColumns, name, p);
                    } else {
                        const out = new Float32Array(num);
                        for (let i = 0; i < num; i++) out[i] = src[i] + logAdd;
                        this.concatArray(mergedColumns, name, out);
                    }
                } else if (STANDARD_COLS.has(name)) {
                    this.appendData(mergedColumns, name, p);
                } else {
                    this.appendData(mergedColumns, name, p);
                }
            }

            for (let r = thisRestCount; r < maxRestCols; r++) {
                const colName = `f_rest_${r}`;
                if (!mergedColumns.has(colName)) {
                    mergedColumns.set(colName, {
                        type: 'float',
                        data: new Float32Array(0),
                        byteSize: 4
                    });
                }
                const zeros = new Float32Array(num);
                this.concatArray(mergedColumns, colName, zeros);
            }
        }

        // -- Step 3: Build DataTable from merged columns --
        const columns: Column[] = [];
        for (const [name, col] of mergedColumns) {
            columns.push(new Column(name, col.data));
        }
        const dataTable = new DataTable(columns);

        // -- Step 4: Convert to GSplatData --
        return this.dataTableToGSplatData(dataTable);
    }

    private rebuild(): void {
        if (!this.group) return;

        // -- Schedule old entity for deferred cleanup (double-buffering).
        if (this.pendingCleanupEntity) {
            this.cleanupOldEntity();
        }
        if (this.mergedEntity) {
            this.pendingCleanupEntity = this.mergedEntity;
            this.pendingCleanupAsset = this.mergedAsset;
            this.mergedEntity = null;
            this.mergedAsset = null;
        }

        // Build merged GSPlatData from ALL group splats
        const splats = [...this.group.splats];
        const gsplatData = this.buildMergedGSplatData(splats);
        this.mergedGSplatData = gsplatData;

        // Record each splat's offset in the merged data
        this.splatOffsets.clear();
        let currentOffset = 0;
        for (const s of splats) {
            const num = s.splatData.numSplats;
            this.splatOffsets.set(s, { start: currentOffset, count: num });
            currentOffset += num;
        }

        // -- Step 4b: Add minimal state & transform columns required by the custom
        //    shader. All zeros: no selection/deletion/lock, identity palette index 0.
        if (!gsplatData.getProp('state')) {
            gsplatData.getElement('vertex').properties.push({
                type: 'uchar',
                name: 'state',
                storage: new Uint8Array(gsplatData.numSplats),
                byteSize: 1
            });
        }
        if (!gsplatData.getProp('transform')) {
            gsplatData.getElement('vertex').properties.push({
                type: 'ushort',
                name: 'transform',
                storage: new Uint16Array(gsplatData.numSplats),
                byteSize: 2
            });
        }

        // -- Step 5: Create asset & entity --
        const filename = `group-${this.group.id}`;
        this.mergedAsset = new Asset(filename, 'gsplat', {
            url: `local-group-${this.group.id}`,
            filename
        });
        this.mergedAsset.resource = new GSplatResource(
            this.scene.app.graphicsDevice,
            gsplatData
        );
        this.scene.app.assets.add(this.mergedAsset);

        this.mergedEntity = new Entity(`mergedGroup_${this.group.id}`);
        this.mergedEntity.addComponent('gsplat', {
            asset: this.mergedAsset,
            unified: false
        });

        // -- Step 6: Hide individual splat rendering by removing them from layers.
        // PlayCanvas GSplatComponent uses unified rendering (GSplatPlacement)
        // by default, so meshInstance.visible = false does NOT work.
        // We must clear layers to remove the placement from the render pipeline.
        //
        // IMPORTANT: rebuild() may be called multiple times while the group is
        // active (e.g. after transform changes). On subsequent calls g.layers
        // is already [], so we must carry forward the original oldLayers from
        // the previous hiddenSplats entry instead of saving [].
        const preservedOldLayers = new Map<Splat, number[]>();
        for (const entry of this.hiddenSplats) {
            preservedOldLayers.set(entry.splat, entry.oldLayers);
        }
        this.hiddenSplats = [];
        for (const s of splats) {
            const g = s.entity.gsplat;
            if (g) {
                if (preservedOldLayers.has(s)) {
                    // Already hidden — keep the original layers from first hide
                    this.hiddenSplats.push({ splat: s, oldLayers: preservedOldLayers.get(s)! });
                } else if (g.layers.length > 0) {
                    // First time hiding — save and clear
                    const oldLayers = [...g.layers];
                    g.layers = [];
                    this.hiddenSplats.push({ splat: s, oldLayers });
                }
                // else: layers already empty and no preserved record — skip
            }
        }

        // -- Step 7: Add merged entity to scene --
        this.scene.contentRoot.addChild(this.mergedEntity);
        // Layers must be set after adding to scene
        if (this.mergedEntity.gsplat) {
            this.mergedEntity.gsplat.layers = [this.scene.splatLayer.id];
        }

        // -- Step 7b: Apply the custom splat shader so the merged entity writes
        //    to ALL draw buffers of the MRT (RT0 color + RT1 overlay). Without
        //    this the default gsplat shader only outputs to RT0, triggering
        //    GL_INVALID_OPERATION on the multi-buffer render target.
        {
            const instance = this.mergedEntity.gsplat.instance;
            const { material } = instance;
            const { glsl, wgsl } = material.shaderChunks;
            glsl.set('gsplatVS', vertexShader);
            glsl.set('gsplatPS', fragmentShader);
            glsl.set('gsplatCenterVS', gsplatCenter);
            glsl.set('gsplatModifyVS', gsplatModifyVS);

            // see splat.ts: the WebGPU backend compiles the splat material from WGSL
            if (this.scene.app.graphicsDevice.isWebGPU) {
                wgsl.set('gsplatVS', vertexShaderWGSL);
                wgsl.set('gsplatPS', fragmentShaderWGSL);
                wgsl.set('gsplatCenterVS', gsplatCenterWGSL);
                wgsl.set('gsplatModifyVS', gsplatModifyWGSL);
            }

            const bands = (instance.resource as GSplatResource).shBands ?? 0;
            material.setDefine('SH_BANDS', `${Math.min(bands, 3)}`);

            // Lazily create zero-filled state & transform textures — reused across
            // rebuilds so WebGL texture resources are not leaked.
            if (!this.stateTex) {
                const { x: texW, y: texH } = (instance.resource as any).textureDimensions ?? { x: 512, y: 512 };
                this.stateTex = new Texture(this.scene.app.graphicsDevice, {
                    name: 'mergedState',
                    width: texW,
                    height: texH,
                    format: PIXELFORMAT_R8,
                    mipmaps: false,
                    minFilter: FILTER_NEAREST,
                    magFilter: FILTER_NEAREST,
                    addressU: ADDRESS_CLAMP_TO_EDGE,
                    addressV: ADDRESS_CLAMP_TO_EDGE
                });
                this.transformTex = new Texture(this.scene.app.graphicsDevice, {
                    name: 'mergedTransform',
                    width: texW,
                    height: texH,
                    format: PIXELFORMAT_R16U,
                    mipmaps: false,
                    minFilter: FILTER_NEAREST,
                    magFilter: FILTER_NEAREST,
                    addressU: ADDRESS_CLAMP_TO_EDGE,
                    addressV: ADDRESS_CLAMP_TO_EDGE
                });
            }
            material.setParameter('splatState', this.stateTex);
            material.setParameter('splatTransform', this.transformTex);
            // Identity transform palette（transform 列全 0 → 索引 0 = identity）。
            // 缺失绑定会让 applyPaletteTransform 采样到空纹理 → 零矩阵 → 高斯塌缩。
            if (!this.mergedPalette) {
                this.mergedPalette = new TransformPalette(this.scene.app.graphicsDevice);
            }
            material.setParameter('transformPalette', this.mergedPalette.texture);

            // Always use neutral defaults — color grading is handled per-splat
            // in single mode only. Group is for transforms and unified rendering.
            material.setParameter('clrOffset', [0, 0, 0]);
            material.setParameter('clrScale', [1, 1, 1, 1]);
            material.setParameter('saturation', 1.0);
            material.setParameter('highlights', 0.0);
            material.setParameter('shadows', 0.0);
            material.setParameter('contrast', 0.0);
            material.setParameter('hslHueA', [0, 0, 0, 0]);
            material.setParameter('hslHueB', [0, 0, 0, 0]);
            material.setParameter('hslSatA', [0, 0, 0, 0]);
            material.setParameter('hslSatB', [0, 0, 0, 0]);
            material.setParameter('hslLumA', [0, 0, 0, 0]);
            material.setParameter('hslLumB', [0, 0, 0, 0]);
            material.setParameter('showDeleted', 0.0);
            // 中性选择/锁定色：merged 的 state 纹理全零（无选择/锁定），
            // 设置中性值防止意外非零时模型被染色（与单模型默认一致）
            material.setParameter('selectedClr', [0, 0, 0, 0]);
            material.setParameter('lockedClr', [1, 1, 1, 1]);

            // 粒子化散射 uniform（默认 0 = 完整模型）；merged 场景不参与
            // 散射动画（散射作用于单个 splat，合并渲染保持完整）
            material.setParameter('uScatterProgress', 0);
            material.setParameter('uScatterRadius', 1);
            material.setParameter('uScatterCenter', [0, 0, 0]);
            material.setParameter('uEffectMode', 0);
            material.setParameter('uEffectTime', 0);
            material.setParameter('uEffectColor', [1, 1, 1]);
            material.setParameter('uEffectFade', 1);

            material.update();
        }

        // Disable auto AABB update on the merged instance and set its world
        // AABB EXPLICITLY. With _updateAabb=false the engine's MeshInstance.aabb
        // getter returns _aabb as-is, which is then used for frustum culling
        // (engine cullMeshInstances → _isVisible → containsSphere). If we leave
        // _aabb empty (center 0,0,0 / halfExtents 0,0,0) the merged entity is
        // culled whenever the ORIGIN leaves the camera frustum → "model disappears
        // at some angles" / flickers as the camera orbits. Merged positions are
        // already world-space (each splat's world transform baked in) and the
        // merged entity transform is identity, so world == local.
        //
        // NOTE: gsplatData.calcAabb() is NOT used — for hand-built GSplatData it
        // returns exaggerated bounds (project lesson). We compute min/max manually.
        try {
            const inst = this.mergedEntity.gsplat.instance;
            // @ts-ignore
            inst.meshInstance._updateAabb = false;
            // @ts-ignore
            inst.meshInstance._aabb = this._computeMergedAabb(gsplatData);
            // Prime instancingCount so the first frame renders with the identity
            // order seed instead of nothing (the async sorter lands a frame or
            // two later). Mirrors splat.ts — prevents a blank merged entity
            // during group rebuild warm-up.
            inst.meshInstance.instancingCount = Math.ceil(gsplatData.numSplats / 128);
            inst.material.setParameter('numSplats', gsplatData.numSplats);
        } catch (_) { /* best-effort */ }

        // Force render for several frames so the new entity's GSplat pipeline
        // (texture uploads, sorting) has time to initialize before we clean up
        // the old entity. Old entity stays visible during this warm-up period.
        this.scene.forceRenderFrames = 2;
        this.scene.boundDirty = true;
        this.scene.forceRender = true;
    }

    /** Clean up the old merged entity after the new one has initialized. */
    private cleanupOldEntity(): void {
        try {
            if (this.pendingCleanupEntity) {
                if (this.pendingCleanupEntity.parent) {
                    this.pendingCleanupEntity.parent.removeChild(this.pendingCleanupEntity);
                }
                this.pendingCleanupEntity.destroy();
            }
        } catch (_) { /* entity may already be destroyed by engine */ }
        this.pendingCleanupEntity = null;

        if (this.pendingCleanupAsset) {
            try {
                this.scene.app.assets.remove(this.pendingCleanupAsset);
                // unload destroys the GSplatResource (GPU streams/textures) —
                // registry removal alone leaks the full merged GPU copy
                this.pendingCleanupAsset.unload();
            } catch (_) { /* asset may already be removed */ }
            this.pendingCleanupAsset = null;
        }
        // Force render so the old entity's removal is visible immediately
        this.scene.boundDirty = true;
        this.scene.forceRender = true;
    }

    private destroy(): void {
        // Clear tracking state
        this.splatOffsets.clear();
        this.mergedGSplatData = null;

        // Destroy cached textures to free WebGL resources
        if (this.stateTex) {
            this.stateTex.destroy();
            this.stateTex = null;
        }
        if (this.transformTex) {
            this.transformTex.destroy();
            this.transformTex = null;
        }
        if (this.mergedPalette) {
            this.mergedPalette.texture.destroy();
            this.mergedPalette = null;
        }

        // Restore individual splat rendering by restoring their layers
        for (const { splat: s, oldLayers } of this.hiddenSplats) {
            const g = s.entity.gsplat;
            if (g) {
                g.layers = oldLayers;
            }
        }
        this.hiddenSplats = [];

        // Clean up pending old entity (double-buffering residue)
        this.cleanupOldEntity();

        // Remove merged entity from scene
        if (this.mergedEntity) {
            if (this.mergedEntity.parent) {
                this.mergedEntity.parent.removeChild(this.mergedEntity);
            }
            this.mergedEntity.destroy();
            this.mergedEntity = null;
        }

        // Remove merged asset
        if (this.mergedAsset) {
            this.scene.app.assets.remove(this.mergedAsset);
            // unload destroys the GSplatResource (GPU streams/textures) —
            // registry removal alone leaks the full merged GPU copy
            this.mergedAsset.unload();
            this.mergedAsset = null;
        }

        this.group = null;
        this.scene.boundDirty = true;
        this.scene.forceRender = true;
    }

    // -- helpers --

    /**
     * Compute the merged data's world-space AABB from the merged x/y/z columns.
     * gsplatData.calcAabb() is unreliable for hand-built GSplatData (returns
     * exaggerated bounds), so we walk the positions manually. Merged positions
     * are world-space and the merged entity transform is identity, so this box
     * doubles as the world bound used by the engine's frustum culling.
     */
    private _computeMergedAabb(gsplatData: GSplatData): BoundingBox {
        const xs = gsplatData.getProp('x') as Float32Array;
        const ys = gsplatData.getProp('y') as Float32Array;
        const zs = gsplatData.getProp('z') as Float32Array;
        const n = gsplatData.numSplats;
        const aabb = new BoundingBox();
        if (!xs || !ys || !zs || n === 0) return aabb;

        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < n; i++) {
            const x = xs[i], y = ys[i], z = zs[i];
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (z < minZ) minZ = z;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            if (z > maxZ) maxZ = z;
        }
        aabb.center.set((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5);
        aabb.halfExtents.set((maxX - minX) * 0.5, (maxY - minY) * 0.5, (maxZ - minZ) * 0.5);
        return aabb;
    }

    /** Ensure a column exists in the merged map. */
    private ensureColumn(map: Map<string, any>, name: string, prop: any): void {
        if (!map.has(name)) {
            const storage = prop.storage;
            // Create an empty array of the same type
            let data: any;
            if (storage instanceof Float32Array) data = new Float32Array(0);
            else if (storage instanceof Uint8Array) data = new Uint8Array(0);
            else if (storage instanceof Uint16Array) data = new Uint16Array(0);
            else if (storage instanceof Uint32Array) data = new Uint32Array(0);
            else if (storage instanceof Int8Array) data = new Int8Array(0);
            else if (storage instanceof Int16Array) data = new Int16Array(0);
            else if (storage instanceof Int32Array) data = new Int32Array(0);
            else data = new Float32Array(0);
            map.set(name, {
                type: prop.type ?? 'float',
                data,
                byteSize: prop.byteSize ?? data.BYTES_PER_ELEMENT
            });
        }
    }

    /** Concatenate new data to the end of a column. */
    private concatArray(map: Map<string, any>, name: string, newData: any): void {
        const col = map.get(name);
        if (!col) return;
        const old = col.data;
        const combined = new old.constructor(old.length + newData.length);
        combined.set(old, 0);
        combined.set(newData, old.length);
        col.data = combined;
    }

    /** Append a property's data to the merged column. */
    private appendData(map: Map<string, any>, name: string, prop: any): void {
        this.concatArray(map, name, prop.storage);
    }

    /** Convert DataTable to GSplatData (mirrors loader.ts helper). */
    private dataTableToGSplatData(dataTable: DataTable): GSplatData {
        const columnTypeToGSplatType = (colType: string | null): string => {
            switch (colType) {
                case 'int8': return 'char';
                case 'uint8': return 'uchar';
                case 'int16': return 'short';
                case 'uint16': return 'ushort';
                case 'int32': return 'int';
                case 'uint32': return 'uint';
                case 'float32': return 'float';
                case 'float64': return 'double';
                default: return 'float';
            }
        };

        const properties = dataTable.columns.map((col: Column) => ({
            type: columnTypeToGSplatType(col.dataType),
            name: col.name,
            storage: col.data,
            byteSize: col.data.BYTES_PER_ELEMENT
        }));

        const gsplatData = new GSplatData([{
            name: 'vertex',
            count: dataTable.numRows,
            properties
        }]);

        // Support 2D splats: add scale_2 if missing
        if (gsplatData.getProp('scale_0') && gsplatData.getProp('scale_1') && !gsplatData.getProp('scale_2')) {
            const scale2 = new Float32Array(gsplatData.numSplats).fill(Math.log(1e-6));
            gsplatData.addProp('scale_2', scale2);
            const props = gsplatData.getElement('vertex').properties as any[];
            props.splice(
                props.findIndex((p: any) => p.name === 'scale_1') + 1,
                0,
                props.splice(props.length - 1, 1)[0]
            );
        }

        return gsplatData;
    }
}

export { GroupRenderer };
