import {
    ADDRESS_CLAMP_TO_EDGE,
    FILTER_NEAREST,
    PIXELFORMAT_R8,
    PIXELFORMAT_R16U,
    Asset,
    Entity,
    GSplatData,
    GSplatResource,
    Quat,
    Texture,
    Vec3
} from 'playcanvas';

import { Column, DataTable } from '@playcanvas/splat-transform';
import { Splat } from './splat';
import { SplatGroup } from './splat-group';
import { vertexShader, fragmentShader, gsplatCenter } from './shaders/splat-shader';

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
const SH_REST_COUNTS = [0, 3, 8, 15];

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

    constructor(scene: any, events: any) {
        this.scene = scene;
        this.events = events;
    }

    /** Whether a group is currently being rendered as a unified entity. */
    get isActive(): boolean {
        return this.mergedEntity !== null;
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
            if (hasRot && mr0) {
                _quat.set(r0[srcIdx], r1[srcIdx], r2[srcIdx], r3[srcIdx]);
                _quat2.copy(worldRot).mul(_quat);
                mr0[dstIdx] = _quat2.x;
                mr1[dstIdx] = _quat2.y;
                mr2[dstIdx] = _quat2.z;
                mr3[dstIdx] = _quat2.w;
            }
        }

        // Update GPU texture data from the merged GSPlatData
        const resource = this.mergedAsset.resource as GSplatResource;
        resource.updateTransformData(this.mergedGSplatData);

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
                            _quat.set(srcR0![i], srcR1![i], srcR2![i], srcR3![i]);
                            _quat2.copy(worldRotQ).mul(_quat);
                            newRot0![i] = _quat2.x;
                            newRot1![i] = _quat2.y;
                            newRot2![i] = _quat2.z;
                            newRot3![i] = _quat2.w;
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
            const { glsl } = material.shaderChunks;
            glsl.set('gsplatVS', vertexShader);
            glsl.set('gsplatPS', fragmentShader);
            glsl.set('gsplatCenterVS', gsplatCenter);

            const bands = (instance.resource as GSplatResource).shBands ?? 0;
            material.setDefine('SH_BANDS', `${Math.min(bands, 3)}`);

            // Lazily create zero-filled state & transform textures — reused across
            // rebuilds so WebGL texture resources are not leaked.
            if (!this.stateTex) {
                const { x: texW, y: texH } = (instance.resource as any).textureDimensions ?? { x: 512, y: 512 };
                this.stateTex = new Texture(this.scene.app.graphicsDevice, {
                    name: 'mergedState',
                    width: texW, height: texH,
                    format: PIXELFORMAT_R8,
                    mipmaps: false,
                    minFilter: FILTER_NEAREST,
                    magFilter: FILTER_NEAREST,
                    addressU: ADDRESS_CLAMP_TO_EDGE,
                    addressV: ADDRESS_CLAMP_TO_EDGE
                });
                this.transformTex = new Texture(this.scene.app.graphicsDevice, {
                    name: 'mergedTransform',
                    width: texW, height: texH,
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

            material.update();
        }

        // Disable auto AABB update on the merged instance
        try {
            const inst = this.mergedEntity.gsplat.instance;
            // @ts-ignore
            inst.meshInstance._updateAabb = false;
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
            this.mergedAsset = null;
        }

        this.group = null;
        this.scene.boundDirty = true;
        this.scene.forceRender = true;
    }

    // -- helpers --

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
