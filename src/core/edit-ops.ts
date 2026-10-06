import { Asset, Color, Mat4, Quat, Vec3 } from 'playcanvas';

import { type CurveSet } from './color-curves';
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
    /**
     * 选定作用行。默认在**构造之后由子类在 `do()` 里**覆盖（见 `SelectOp`）：本类的 do/undo 是
     * 同一批行上的互逆位操作，所以"哪些行"必须在**真正执行的那一刻**才确定。
     *
     * 为什么不能让子类在构造函数里数一遍行：op 是排队执行的（`CommandQueue`），构造与执行之间
     * 可能插进别的 op（实测路径：大模型上一次排队的 `SelectRangeOp` 还没跑完，用户按了隐藏 /
     * 全选 / 全不选 / 反选 / 重置）。那样数出来的是**手势之前**的那批行 —— 隐藏会上一次的选择、
     * 重置/恢复删格会作用在错的集合上，去浮云那条路甚至会把用户更早的选择删掉。
     * 2026-09-23 把 `SelectAllOp` / `SelectNoneOp` / `SelectInvertOp` / `HideSelectionOp`
     * 四个也改成 do 时捕获，与 `SelectOp` 一致。
     */
    captureRanges?(): void;

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
        this.captureRanges?.();
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
        // 作用行在 do() 里数（见 StateOp.captureRanges 的说明）：构造与执行之间可能插进别的 op
        super(splat, IndexRanges.fromPredicate(0, () => false), State.selected, BitOp.SET);
    }

    captureRanges() {
        const state = this.splat.splatData.getProp('state') as Uint8Array;
        this.ranges = IndexRanges.fromPredicate(this.splat.splatData.numSplats, i => state[i] === 0);
    }
}

class SelectNoneOp extends StateOp {
    name = 'selectNone';

    constructor(splat: Splat) {
        super(splat, IndexRanges.fromPredicate(0, () => false), State.selected, BitOp.CLEAR);
    }

    captureRanges() {
        const state = this.splat.splatData.getProp('state') as Uint8Array;
        this.ranges = IndexRanges.fromPredicate(this.splat.splatData.numSplats, i => (state[i] & State.selected) !== 0);
    }
}

class SelectInvertOp extends StateOp {
    name = 'selectInvert';

    constructor(splat: Splat) {
        super(splat, IndexRanges.fromPredicate(0, () => false), State.selected, BitOp.TOGGLE);
    }

    captureRanges() {
        const state = this.splat.splatData.getProp('state') as Uint8Array;
        this.ranges = IndexRanges.fromPredicate(this.splat.splatData.numSplats, i => (state[i] & (State.locked | State.deleted)) === 0);
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

    captureRanges() {
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
        super(splat, IndexRanges.fromPredicate(0, () => false), State.locked, BitOp.SET, State.locked);
    }

    captureRanges() {
        const state = this.splat.splatData.getProp('state') as Uint8Array;
        this.ranges = IndexRanges.fromPredicate(this.splat.splatData.numSplats, i => state[i] === State.selected);
    }
}

class UnhideAllOp extends StateOp {
    name = 'unhideAll';

    constructor(splat: Splat) {
        // 作用行在 do() 里数（见 StateOp.captureRanges 的说明）：op 是排队执行的，
        // 构造与执行之间可能插进别的 op
        super(splat, IndexRanges.fromPredicate(0, () => false), State.locked, BitOp.CLEAR, State.locked);
    }

    captureRanges() {
        const state = this.splat.splatData.getProp('state') as Uint8Array;
        this.ranges = IndexRanges.fromPredicate(this.splat.splatData.numSplats, i => (state[i] & (State.locked | State.deleted)) === State.locked);
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

    // the gesture-start selection in range form: undo needs to set it back.
    //
    // **惰性**（2026-09-20）：原来是在构造时（= 每次手势开始时）就用
    // `IndexRanges.fromPredicate` 扫一遍 20M 行建好，实测 108–149ms —— 占"框选期间最长阻塞"
    // 的三分之一强，而绝大多数手势**永远不会被撤销**。现在只在 `undo()` 第一次真正需要时派生并缓存。
    // 派生用的谓词与原来构造时用的逐字相同（`preMask[i] !== 0`，上界同样是 numSplats =
    // preMask.length），输入 preMask 在手势期间是只读的（applySelectionMask / revertSelectionMask
    // 都只读它），所以撤销之后的选中集合与改动前**逐位相同**。
    private pre: IndexRanges | null = null;

    // rows this op owns (monotonic; see SplatState.applySelectionMask)
    private managed: Uint8Array;

    private mask: Uint8Array;

    private op: SelectionOp;

    constructor(
        splat: Splat,
        preMask: Uint8Array,
        mask: Uint8Array,
        managed: Uint8Array,
        op: SelectionOp
    ) {
        this.splat = splat;
        this.preMask = preMask;
        this.mask = mask;
        this.managed = managed;
        this.op = op;
    }

    /** 换一个范围（滑块动了）：调用方随后重新 do() 即可。 */
    setMask(mask: Uint8Array) {
        this.mask = mask;
    }

    /** 手势开始时的选中集（不含 locked），按需派生一次并缓存。 */
    private preRanges(): IndexRanges {
        return (this.pre ??= IndexRanges.fromPredicate(this.preMask.length, i => this.preMask[i] !== 0));
    }

    async do() {
        await this.splat.state.applySelectionMask(this.preMask, this.mask, this.managed, this.op);
        await this.splat.updateState(State.selected);
    }

    async undo() {
        const { state } = this.splat;
        await state.revertSelectionMask(this.preMask, this.mask, this.managed, this.op);
        state.setBits(this.preRanges(), State.selected);
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

    captureRanges() {
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
        super(splat, IndexRanges.fromPredicate(0, () => false), State.deleted, BitOp.CLEAR, State.deleted);
    }

    captureRanges() {
        const state = this.splat.splatData.getProp('state') as Uint8Array;
        this.ranges = IndexRanges.fromPredicate(this.splat.splatData.numSplats, i => state[i] === (State.selected | State.deleted));
    }
}

class ResetOp extends StateOp {
    name = 'reset';

    constructor(splat: Splat) {
        super(splat, IndexRanges.fromPredicate(0, () => false), State.deleted, BitOp.CLEAR, State.deleted);
    }

    captureRanges() {
        const state = this.splat.splatData.getProp('state') as Uint8Array;
        this.ranges = IndexRanges.fromPredicate(this.splat.splatData.numSplats, i => (state[i] & State.deleted) !== 0);
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

    /**
     * `do()` 实际改过的行。**undo 必须重放这一批行，而不是重新看一遍选区**：
     * 选区可以在一次 do 之后被改掉而**不留历史记录**（拖动深度范围滑块就是原地重跑
     * `SelectRangeOp`，见 `editor.ts` 里那条 `select.range` 路径），此时若 undo 按
     * `state[i] === State.selected` 重新筛选，就会出现"do 改过的行没被还原、选区新进来的行被
     * 当成改过"——后者查 `inverseMap` 得到 `undefined`，写进 Uint16Array 变成 0（恒等变换），
     * 而 `free()` 又把那些调色板槽位放回池子，下一次变换再分配就会让高斯**静默跳到无关的变换上**。
     */
    private _affectedRows: number[] = [];

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
        const affected: number[] = [];
        for (let i = 0; i < state.length; ++i) {
            if (state[i] === State.selected) {
                const next = paletteMap.get(indices[i]);
                if (next === undefined) {
                    // 这个索引不在调色板映射里：不是本 op 的目标，跳过（写 undefined 会静默变成 0）
                    continue;
                }
                indices[i] = next;
                affected.push(i);
            }
        }
        this._affectedRows = affected;

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
        const indices = splat.transformTexture.lock() as Uint16Array;

        // invert the palette map
        const inverseMap = new Map<number, number>();
        paletteMap.forEach((newIdx, oldIdx) => {
            inverseMap.set(newIdx, oldIdx);
        });

        // restore the original transform indices —— 只重放 do 改过的那批行（见 _affectedRows）
        for (const i of this._affectedRows) {
            const prev = inverseMap.get(indices[i]);
            if (prev !== undefined) {
                indices[i] = prev;
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
    hslLum?: number[],
    /** 曲线控制点（四个通道；`null` = 清空全部曲线，见 `src/core/color-curves.ts`） */
    curves?: CurveSet | null
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
        const { tintClr, temperature, saturation, brightness, blackPoint, whitePoint, transparency, highlights, shadows, contrast, colorGradeEnabled, hslHue, hslSat, hslLum, curves } = this.newState;
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
        // 曲线：`undefined` = 这次操作不碰曲线；`null` = 清空全部曲线（两者必须区分）
        if (curves !== undefined) splat.setCurves(curves);
    }

    undo() {
        const { splat } = this;
        const { tintClr, temperature, saturation, brightness, blackPoint, whitePoint, transparency, highlights, shadows, contrast, colorGradeEnabled, hslHue, hslSat, hslLum, curves } = this.oldState;
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
        if (curves !== undefined) splat.setCurves(curves);
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
        // 组合算子撤销必须逆序（先 apply 的 op 后撤销），否则去浮云/分离/愈合
        // 这类 [SelectNone, Select+add, DeleteSelection] 序列会把"操作前已选中"的高斯还原错。
        for (let i = this.ops.length - 1; i >= 0; i--) {
            await this.ops[i].undo();
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
