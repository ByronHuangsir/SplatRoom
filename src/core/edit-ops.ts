import { Asset, Color, Mat4, Quat, Vec3 } from 'playcanvas';

import { IndexRanges, sortedPredicate } from './index-ranges';
import { BoxShape } from '../scene/box-shape';
import { Pivot } from '../scene/pivot';
import { Scene } from '../scene/scene';
import { SphereShape } from '../scene/sphere-shape';
import { Splat } from '../splat/splat';
import { SelectionOp, State } from '../splat/splat-state';
import { AnimTrack } from '../timeline/anim-track';
import { Transform } from '../transform/transform';

interface EditOp {
    name: string;
    do(): void | Promise<void>;
    undo(): void | Promise<void>;
    destroy?(): void;
}

const enum BitOp {
    SET,
    CLEAR,
    TOGGLE
}

class StateOp {
    splat: Splat;
    ranges: IndexRanges;
    mask: number;
    op: BitOp;
    updateFlags: number;

    constructor(splat: Splat, ranges: IndexRanges, mask: number, op: BitOp, updateFlags = State.selected) {
        this.splat = splat;
        this.ranges = ranges;
        this.mask = mask;
        this.op = op;
        this.updateFlags = updateFlags;
    }

    private apply(op: BitOp) {
        const { state } = this.splat;
        const { mask, ranges } = this;

        switch (op) {
            case BitOp.SET:
                state.setBits(ranges, mask);
                break;
            case BitOp.CLEAR:
                state.clearBits(ranges, mask);
                break;
            case BitOp.TOGGLE:
                state.toggleBits(ranges, mask);
                break;
        }
    }

    async do() {
        this.apply(this.op);
        await this.splat.updateState(this.updateFlags);
    }

    async undo() {
        const undoOp = this.op === BitOp.TOGGLE ? BitOp.TOGGLE :
            this.op === BitOp.SET ? BitOp.CLEAR : BitOp.SET;
        this.apply(undoOp);
        await this.splat.updateState(this.updateFlags);
    }

    destroy() {
        this.splat = null;
        this.ranges = null;
    }
}

class SelectAllOp extends StateOp {
    name = 'selectAll';

    constructor(splat: Splat) {
        const state = splat.splatData.getProp('state') as Uint8Array;
        super(splat, IndexRanges.fromPredicate(splat.splatData.numSplats, i => state[i] === 0), State.selected, BitOp.SET);
    }
}

class SelectNoneOp extends StateOp {
    name = 'selectNone';

    constructor(splat: Splat) {
        const state = splat.splatData.getProp('state') as Uint8Array;
        super(splat, IndexRanges.fromPredicate(splat.splatData.numSplats, i => (state[i] & State.selected) !== 0), State.selected, BitOp.CLEAR);
    }
}

class SelectInvertOp extends StateOp {
    name = 'selectInvert';

    constructor(splat: Splat) {
        const state = splat.splatData.getProp('state') as Uint8Array;
        super(splat, IndexRanges.fromPredicate(splat.splatData.numSplats, i => (state[i] & (State.locked | State.deleted)) === 0), State.selected, BitOp.TOGGLE);
    }
}

class SelectOp extends StateOp {
    name = 'selectOp';

    private sel: Uint8Array | Uint32Array;

    private opKind: 'add' | 'remove' | 'set' | 'intersect';

    // `sel` is a committed snapshot of hits: either a per-splat mask
    // (Uint8Array, 255 = hit) or a sorted Uint32Array of indices. taking a
    // committed mask rather than a closure removes the foot-gun where a
    // predicate captured `state[i]` at call time and was evaluated later.
    // `op` semantics:
    //   add       — select valid splats that are hit and currently unselected
    //   remove    — deselect valid splats that are hit and currently selected
    //   set       — make selection match the hit mask (toggle valid splats whose
    //               current selection state differs from the mask). NOT a replace —
    //               the underlying BitOp is TOGGLE on the rows where selection and
    //               hit disagree, which leaves locked/deleted bits untouched.
    //   intersect — keep only splats currently selected AND in the hit mask
    //               (clear the selected bit on selected splats that are not hit).
    //
    // The index ranges are resolved when the op RUNS, not when it is built: the mask is already
    // fixed, but "currently unselected" has to mean "unselected at the moment this op applies".
    // A MultiOp that deselects and then selects the same rows (the 去浮云 / 连通簇 apply path, run
    // a second time when those rows were already selected) used to compute an empty range at
    // construction time and then select nothing, which also left the following DeleteSelectionOp
    // with nothing to delete. Every op in a MultiOp now reads the state left by the op before it.
    constructor(splat: Splat, op: 'add' | 'remove' | 'set' | 'intersect', sel: Uint8Array | Uint32Array) {
        super(splat, IndexRanges.fromPredicate(0, () => false), State.selected, BitOp.SET);
        this.sel = sel;
        this.opKind = op;
    }

    private captureRanges() {
        const splatData = this.splat.splatData;
        const state = splatData.getProp('state') as Uint8Array;
        const sel = this.sel;
        const isHit = sel instanceof Uint32Array ? sortedPredicate(sel) : (i: number) => sel[i] === 255;

        // op → bit operation and op → predicate, kept as parallel lookups keyed
        // by the same union so adding an op forces both to be updated together.
        const bitOps = {
            add: BitOp.SET,
            remove: BitOp.CLEAR,
            set: BitOp.TOGGLE,
            intersect: BitOp.CLEAR
        };

        // single rule applied uniformly: only non-locked splats are considered.
        // deleted splats are also valid (so they can be selected when showDeleted
        // is on, enabling the restore/undelete workflow).
        //
        // O3 (docs/audit/00-总结.md): `valid(i)` used to be a second closure call on top of
        // `isHit(i)` for every index — 39–52M calls per push on a 13M model. It is a single
        // masked compare, so it is inlined; for add/remove the locked and selected bit tests
        // collapse into one `state[i] & (locked | selected)` read. Operand order is unchanged
        // (short-circuiting `isHit` is safe now that sortedPredicate advances its cursor).
        const preds = {
            add: (i: number) => (state[i] & (State.locked | State.selected)) === 0 && isHit(i),
            remove: (i: number) => (state[i] & (State.locked | State.selected)) === State.selected && isHit(i),
            set: (i: number) => (state[i] & State.locked) === 0 && (((state[i] & State.selected) !== 0) !== isHit(i)),
            intersect: (i: number) => (state[i] & State.locked) === 0 && (state[i] & State.selected) !== 0 && !isHit(i)
        };

        this.mask = State.selected;
        this.op = bitOps[this.opKind];
        this.ranges = IndexRanges.fromPredicate(splatData.numSplats, preds[this.opKind]);
    }

    // undo() inherits from StateOp and reuses the ranges captured here (StateOp's undo is the
    // inverse bit operation over the same rows, which is what "undo my selection" means)
    do() {
        this.captureRanges();
        return super.do();
    }
}

class HideSelectionOp extends StateOp {
    name = 'hideSelection';

    constructor(splat: Splat) {
        const state = splat.splatData.getProp('state') as Uint8Array;
        super(splat, IndexRanges.fromPredicate(splat.splatData.numSplats, i => state[i] === State.selected), State.locked, BitOp.SET, State.locked);
    }
}

class UnhideAllOp extends StateOp {
    name = 'unhideAll';

    constructor(splat: Splat) {
        const state = splat.splatData.getProp('state') as Uint8Array;
        super(splat, IndexRanges.fromPredicate(splat.splatData.numSplats, i => (state[i] & (State.locked | State.deleted)) === State.locked), State.locked, BitOp.CLEAR, State.locked);
    }
}

// 屏幕选择的"深度范围"（选区深度：最近/最远）专用：把选区**完全替换**成给定的掩码，
// 而且可以**原地重放** —— 用户拖滑块时同一个历史条目要反复应用新的范围。
//
// 用一个 SelectOp('set', mask) 也能选出同样的结果，但它记的是"受影响的行"（当前选中状态与掩码
// 不一致的那些），换一个范围再应用一次之后，undo 会退回到上一个中间状态而不是手势之前的状态。
//
// O2（docs/audit/00-总结.md）：原来是「掩码 → fromPredicate 建 IndexRanges → clearBits(pre) +
// clearBits(applied) + setBits(post)」，13M 上等于四趟全扫（推杆 500–700ms）。现在算子直接持
// **掩码**，交给 SplatState.applySelectionMask 一趟写完（同一趟里增量维护 numSelected）。
// 逐位语义与旧实现等价：
//   managed = 手势开始时的选中集(preMask) ∪ 用过的每一个掩码（只增不减）
//   被接管的行上：selected = combine(preMask, mask)
// locked（隐藏）的行不在 managed 里 —— 它们带着 selected 位，旧实现的 clearBits(pre) 也只碰
// "selected 且没锁"的行，所以必须原样保留。
class SelectRangeOp implements EditOp {
    name = 'selectRange';

    splat: Splat;

    private preMask: Uint8Array;

    // the gesture-start selection in range form: undo needs to set it back
    private pre: IndexRanges;

    // rows this op owns (monotonic; see SplatState.applySelectionMask)
    private managed: Uint8Array;

    private mask: Uint8Array;

    private op: SelectionOp;

    constructor(
        splat: Splat,
        preMask: Uint8Array,
        pre: IndexRanges,
        mask: Uint8Array,
        managed: Uint8Array,
        op: SelectionOp
    ) {
        this.splat = splat;
        this.preMask = preMask;
        this.pre = pre;
        this.mask = mask;
        this.managed = managed;
        this.op = op;
    }

    /** 换一个范围（滑块动了）：调用方随后重新 do() 即可。 */
    setMask(mask: Uint8Array) {
        this.mask = mask;
    }

    async do() {
        this.splat.state.applySelectionMask(this.preMask, this.mask, this.managed, this.op);
        await this.splat.updateState(State.selected);
    }

    async undo() {
        const { state } = this.splat;
        state.revertSelectionMask(this.preMask, this.mask, this.managed, this.op);
        state.setBits(this.pre, State.selected);
        await this.splat.updateState(State.selected);
    }

    destroy() {
        this.splat = null;
        this.preMask = null;
        this.pre = null;
        this.managed = null;
        this.mask = null;
    }
}

class DeleteSelectionOp extends StateOp {
    name = 'deleteSelection';

    // The deleted ranges are captured when the op RUNS rather than when it is constructed.
    // StateOp subclasses normally snapshot their ranges up front, which is right for ops whose
    // input is already fixed - but this op's input is "whatever is selected right now", and it
    // is used inside a MultiOp that selects first and deletes second (the 去浮云 / floater
    // removal path). Building that MultiOp snapshotted the selection while it was still empty,
    // so pressing 移除浮云 selected the floaters and deleted nothing.
    constructor(splat: Splat) {
        super(splat, IndexRanges.fromPredicate(0, () => false), State.deleted, BitOp.SET, State.deleted);
    }

    private captureRanges() {
        const state = this.splat.splatData.getProp('state') as Uint8Array;
        this.ranges = IndexRanges.fromPredicate(this.splat.splatData.numSplats, i => state[i] === State.selected);
    }

    // undo() inherits from StateOp and reuses the ranges captured here, so it removes exactly
    // what this op deleted
    do() {
        this.captureRanges();
        return super.do();
    }
}

class UndeleteSelectionOp extends StateOp {
    name = 'undeleteSelection';

    // restore splats that are both selected AND deleted (state = 5).
    // clears the deleted bit, leaving them as just selected (state = 1).
    constructor(splat: Splat) {
        const state = splat.splatData.getProp('state') as Uint8Array;
        super(splat, IndexRanges.fromPredicate(splat.splatData.numSplats, i => state[i] === (State.selected | State.deleted)), State.deleted, BitOp.CLEAR, State.deleted);
    }
}

class ResetOp extends StateOp {
    name = 'reset';

    constructor(splat: Splat) {
        const state = splat.splatData.getProp('state') as Uint8Array;
        super(splat, IndexRanges.fromPredicate(splat.splatData.numSplats, i => (state[i] & State.deleted) !== 0), State.deleted, BitOp.CLEAR, State.deleted);
    }
}

// op for modifying a splat transform
class EntityTransformOp {
    name = 'entityTransform';
    splat: Splat;
    oldt: Transform;
    newt: Transform;

    constructor(options: { splat: Splat, oldt: Transform, newt: Transform }) {
        this.splat = options.splat;
        this.oldt = options.oldt;
        this.newt = options.newt;
    }

    do() {
        this.splat.move(this.newt.position, this.newt.rotation, this.newt.scale);
    }

    undo() {
        this.splat.move(this.oldt.position, this.oldt.rotation, this.oldt.scale);
    }

    destroy() {
        this.splat = null;
        this.oldt = null;
        this.newt = null;
    }
}

const mat = new Mat4();

// op for modifying a subset of individual splats
class SplatsTransformOp {
    name = 'splatsTransform';

    splat: Splat;
    transform: Mat4;
    paletteMap: Map<number, number>;

    constructor(options: { splat: Splat, transform: Mat4, paletteMap: Map<number, number> }) {
        this.splat = options.splat;
        this.transform = options.transform;
        this.paletteMap = options.paletteMap;
    }

    async do() {
        const { splat, transform, paletteMap } = this;
        const state = splat.splatData.getProp('state') as Uint8Array;
        const indices = splat.transformTexture.lock() as Uint16Array;

        // update splat transform palette indices
        for (let i = 0; i < state.length; ++i) {
            if (state[i] === State.selected) {
                indices[i] = paletteMap.get(indices[i]);
            }
        }

        splat.transformTexture.unlock();

        splat.transformPalette.alloc(paletteMap.size);

        // update transform palette
        const { transformPalette } = splat;
        this.paletteMap.forEach((newIdx, oldIdx) => {
            transformPalette.getTransform(oldIdx, mat);
            mat.mul2(transform, mat);
            transformPalette.setTransform(newIdx, mat);
        });

        await splat.updatePositions();
    }

    async undo() {
        const { splat, paletteMap } = this;
        const state = splat.splatData.getProp('state') as Uint8Array;
        const indices = splat.transformTexture.lock() as Uint16Array;

        // invert the palette map
        const inverseMap = new Map<number, number>();
        paletteMap.forEach((newIdx, oldIdx) => {
            inverseMap.set(newIdx, oldIdx);
        });

        // restore the original transform indices
        for (let i = 0; i < state.length; ++i) {
            if (state[i] === State.selected) {
                indices[i] = inverseMap.get(indices[i]);
            }
        }

        splat.transformTexture.unlock();

        splat.transformPalette.free(paletteMap.size);

        await splat.updatePositions();
    }

    destroy() {
        this.splat = null;
        this.transform = null;
        this.paletteMap = null;
    }
}

class PlacePivotOp {
    name = 'setPivot';
    pivot: Pivot;
    oldt: Transform;
    newt: Transform;

    constructor(options: { pivot: Pivot, oldt: Transform, newt: Transform }) {
        this.pivot = options.pivot;
        this.oldt = options.oldt;
        this.newt = options.newt;
    }

    do() {
        this.pivot.place(this.newt);
    }

    undo() {
        this.pivot.place(this.oldt);
    }
}

type ShapeTransformState = {
    position: Vec3;
    rotation?: Quat;
    lens?: Vec3;        // box lengths
    radius?: number;    // sphere radius
};

// moves/rotates/resizes a box/sphere selection volume
class ShapeTransformOp {
    name = 'shapeTransform';
    shape: BoxShape | SphereShape;
    oldState: ShapeTransformState;
    newState: ShapeTransformState;

    constructor(options: { shape: BoxShape | SphereShape, oldState: ShapeTransformState, newState: ShapeTransformState }) {
        this.shape = options.shape;
        this.oldState = options.oldState;
        this.newState = options.newState;
    }

    apply(state: ShapeTransformState) {
        const { shape } = this;
        shape.pivot.setPosition(state.position);
        if (state.rotation) {
            shape.pivot.setRotation(state.rotation);
        }
        if (shape instanceof BoxShape && state.lens) {
            // the length setters refresh the bound with the new transform
            shape.lenX = state.lens.x;
            shape.lenY = state.lens.y;
            shape.lenZ = state.lens.z;
        } else if (shape instanceof SphereShape && state.radius !== undefined) {
            // the radius setter refreshes the bound with the new transform
            shape.radius = state.radius;
        } else {
            shape.moved();
        }

        // refresh the owning tool's ui. shape ops are purged from history when
        // the tool deactivates, so the shape is normally in the scene here; the
        // guard covers the brief window where an already-queued undo/redo runs
        // after a synchronous deactivate.
        shape.scene?.events.fire('shapeSelection.changed', shape);
    }

    do() {
        this.apply(this.newState);
    }

    undo() {
        this.apply(this.oldState);
    }
}

type ColorAdjustment = {
    tintClr?: Color
    temperature?: number,
    saturation?: number,
    brightness?: number,
    blackPoint?: number,
    whitePoint?: number,
    transparency?: number,
    highlights?: number,
    shadows?: number,
    contrast?: number,
    colorGradeEnabled?: boolean,
    hslHue?: number[],
    hslSat?: number[],
    hslLum?: number[]
};

class SetSplatColorAdjustmentOp {
    name = 'setSplatColor';
    splat: Splat;

    newState: ColorAdjustment;
    oldState: ColorAdjustment;

    constructor(options: { splat: Splat, oldState: ColorAdjustment, newState: ColorAdjustment }) {
        const { splat, oldState, newState } = options;
        this.splat = splat;
        this.oldState = oldState;
        this.newState = newState;
    }

    do() {
        const { splat } = this;
        const { tintClr, temperature, saturation, brightness, blackPoint, whitePoint, transparency, highlights, shadows, contrast, colorGradeEnabled, hslHue, hslSat, hslLum } = this.newState;
        if (tintClr) splat.tintClr = tintClr;
        if (temperature !== undefined && temperature !== null) splat.temperature = temperature;
        if (saturation !== undefined && saturation !== null) splat.saturation = saturation;
        if (brightness !== undefined && brightness !== null) splat.brightness = brightness;
        if (blackPoint !== undefined && blackPoint !== null) splat.blackPoint = blackPoint;
        if (whitePoint !== undefined && whitePoint !== null) splat.whitePoint = whitePoint;
        if (transparency !== undefined && transparency !== null) splat.transparency = transparency;
        if (highlights !== undefined && highlights !== null) splat.highlights = highlights;
        if (shadows !== undefined && shadows !== null) splat.shadows = shadows;
        if (contrast !== undefined && contrast !== null) splat.contrast = contrast;
        if (colorGradeEnabled !== undefined && colorGradeEnabled !== null) splat.colorGradeEnabled = colorGradeEnabled;
        if (hslHue) splat.hslHue = hslHue;
        if (hslSat) splat.hslSat = hslSat;
        if (hslLum) splat.hslLum = hslLum;
    }

    undo() {
        const { splat } = this;
        const { tintClr, temperature, saturation, brightness, blackPoint, whitePoint, transparency, highlights, shadows, contrast, colorGradeEnabled, hslHue, hslSat, hslLum } = this.oldState;
        if (tintClr) splat.tintClr = tintClr;
        if (temperature !== undefined && temperature !== null) splat.temperature = temperature;
        if (saturation !== undefined && saturation !== null) splat.saturation = saturation;
        if (brightness !== undefined && brightness !== null) splat.brightness = brightness;
        if (blackPoint !== undefined && blackPoint !== null) splat.blackPoint = blackPoint;
        if (whitePoint !== undefined && whitePoint !== null) splat.whitePoint = whitePoint;
        if (transparency !== undefined && transparency !== null) splat.transparency = transparency;
        if (highlights !== undefined && highlights !== null) splat.highlights = highlights;
        if (shadows !== undefined && shadows !== null) splat.shadows = shadows;
        if (contrast !== undefined && contrast !== null) splat.contrast = contrast;
        if (colorGradeEnabled !== undefined && colorGradeEnabled !== null) splat.colorGradeEnabled = colorGradeEnabled;
        if (hslHue) splat.hslHue = hslHue;
        if (hslSat) splat.hslSat = hslSat;
        if (hslLum) splat.hslLum = hslLum;
    }
}

// Snapshot-based undo/redo for animation track edits.
// Captures the full track state before and after a mutation.
class AnimTrackEditOp {
    name: string;
    track: AnimTrack;
    before: unknown;
    after: unknown;

    constructor(name: string, track: AnimTrack, before: unknown, after: unknown) {
        this.name = name;
        this.track = track;
        this.before = before;
        this.after = after;
    }

    do() {
        this.track.restore(this.after);
    }

    undo() {
        this.track.restore(this.before);
    }
}

class MultiOp {
    name = 'multiOp';
    ops: EditOp[];

    constructor(ops: EditOp[]) {
        this.ops = ops;
    }

    async do() {
        for (const op of this.ops) {
            await op.do();
        }
    }

    async undo() {
        for (const op of this.ops) {
            await op.undo();
        }
    }

    destroy() {
        // forward teardown to children so ops dropped from history (truncation,
        // clear, removeForShape) release their GPU resources instead of leaking
        // them — e.g. SurfaceRefineOp's full-size old/new asset copies.
        for (const op of this.ops) {
            op.destroy?.();
        }
        this.ops = [];
    }
}

class AddSplatOp {
    name = 'addSplat';
    scene: Scene;
    splat: Splat;

    constructor(scene: Scene, splat: Splat) {
        this.scene = scene;
        this.splat = splat;
    }

    async do() {
        await this.scene.add(this.splat);
    }

    undo() {
        this.scene.remove(this.splat);
    }

    destroy() {
        this.splat.destroy();
    }
}

class SplatRenameOp {
    name = 'splatRename';
    splat: Splat;
    oldName: string;
    newName: string;

    constructor(splat: Splat, newName: string) {
        this.splat = splat;
        this.oldName = splat.name;
        this.newName = newName;
    }

    do() {
        this.splat.name = this.newName;
    }

    undo() {
        this.splat.name = this.oldName;
    }
}

/**
 * Surface refine operation — applies scale/rotation adjustments to improve
 * surface flatness and edge sharpness. Fully undoable via snapshot restore.
 */
class SurfaceRefineOp {
    name = 'surfaceRefine';
    splat: Splat;
    oldAsset: Asset | null = null;
    newAsset: Asset | null = null;

    constructor(splat: Splat, newAsset: Asset, oldAsset?: Asset) {
        this.splat = splat;
        this.newAsset = newAsset;
        this.oldAsset = oldAsset ?? null;
    }

    async do() {
        if (this.newAsset) {
            // keep the previous asset alive when it's our undo snapshot (redo
            // path) so a later undo can swap back without a stale resource;
            // on the first apply the previous asset is the original load asset,
            // which replaceData releases.
            await this.splat.replaceData(this.newAsset, this.splat.asset === this.oldAsset);
        }
    }

    async undo() {
        if (this.oldAsset) {
            // keep newAsset loaded: redo() re-binds it and an unloaded resource
            // would crash the swap.
            await this.splat.replaceData(this.oldAsset, true);
        }
    }

    destroy() {
        // Only unload the asset the splat is NOT currently rendering from.
        // After do() the splat uses newAsset; after undo() it uses oldAsset.
        // Unloading the live one would destroy the render data in use, so
        // compare against the splat's current asset and release the other.
        const currentAsset = this.splat?.asset ?? null;
        if (this.newAsset && this.newAsset !== currentAsset) {
            this.newAsset.registry?.remove(this.newAsset);
            this.newAsset.unload();
        }
        if (this.oldAsset && this.oldAsset !== currentAsset) {
            this.oldAsset.registry?.remove(this.oldAsset);
            this.oldAsset.unload();
        }
        this.newAsset = null;
        this.oldAsset = null;
        this.splat = null;
    }
}

export {
    EditOp,
    SelectAllOp,
    SelectNoneOp,
    SelectInvertOp,
    SelectOp,
    SelectRangeOp,
    HideSelectionOp,
    UnhideAllOp,
    DeleteSelectionOp,
    UndeleteSelectionOp,
    ResetOp,
    EntityTransformOp,
    SplatsTransformOp,
    PlacePivotOp,
    ShapeTransformOp,
    ShapeTransformState,
    ColorAdjustment,
    SetSplatColorAdjustmentOp,
    AnimTrackEditOp,
    MultiOp,
    AddSplatOp,
    SplatRenameOp,
    SurfaceRefineOp
};
