import { CommandQueue } from './command-queue';
import { EditOp, MultiOp } from './edit-ops';
import { Events } from './events';
import { Splat } from '../splat/splat';

// Check if an operation references a specific splat
const opReferencesSplat = (op: EditOp, splat: Splat): boolean => {
    // Handle MultiOp by checking nested operations
    if (op instanceof MultiOp) {
        return op.ops.some(nestedOp => opReferencesSplat(nestedOp, splat));
    }
    // Check for splat property on the operation
    return (op as any).splat === splat;
};

class EditHistory {
    history: EditOp[] = [];
    cursor = 0;
    // true while an undo/redo op body is executing (see isUndoingRedoing)
    private _undoRedoBusy = false;
    events: Events;

    // shared queue used to serialize every history mutation. the same physical
    // CommandQueue is shared with DataProcessor callers via scene.commandQueue
    // and the 'queue' event, so all async splat work applies in initiation order.
    private commandQueue: CommandQueue;

    constructor(events: Events, commandQueue: CommandQueue) {
        this.events = events;
        this.commandQueue = commandQueue;

        events.on('edit.undo', () => this.undo());
        events.on('edit.redo', () => this.redo());
        events.on('edit.add', (editOp: EditOp, suppressOp = false) => this.add(editOp, suppressOp));
        events.on('edit.removeForShape', (shape: unknown) => this.removeForShape(shape));
    }

    private queue<T>(fn: () => T | Promise<T>): Promise<T> {
        return this.commandQueue.enqueue(fn);
    }

    add(editOp: EditOp, suppressOp = false) {
        return this.queue(() => this._add(editOp, suppressOp));
    }

    canUndo() {
        return this.cursor > 0;
    }

    canRedo() {
        return this.cursor < this.history.length;
    }

    undo() {
        return this.queue(async () => {
            if (this.canUndo()) {
                await this._undo();
            }
        });
    }

    redo(suppressOp = false) {
        return this.queue(async () => {
            if (this.canRedo()) {
                await this._redo(suppressOp);
            }
        });
    }

    private async _add(editOp: EditOp, suppressOp = false) {
        while (this.cursor < this.history.length) {
            this.history.pop().destroy?.();
        }
        this.history.push(editOp);
        try {
            await this._redo(suppressOp);
        } catch (e) {
            // 应用失败（例如 SurfaceRefine 的 replaceData 在大模型上 OOM）时**必须把这一条撤出来**：
            // 留在 history 里会变成一条"重做一遍什么都没发生"的幽灵记录（`canRedo()` 为真、Ctrl+Z
            // 之后 Ctrl+Y 又把它推上去），而调用方多半是 fire-and-forget（`void editHistory.add(op)`），
            // 用户看不到任何错误。这里收回 + 销毁，并把异常继续抛给调用方。
            if (this.history[this.history.length - 1] === editOp) {
                this.history.pop();
            }
            editOp.destroy?.();
            this.fireEvents();
            throw e;
        }
    }

    /**
     * M3-4：op 的 do/undo **执行之前**先让渲染侧的代理层回到全分辨率。
     *
     * 理由是代码级的：`StateOp.apply()` 写在 `this.splat.state` 上，而它的行范围是
     * `captureRanges()` 按 `this.splat.splatData.numSplats` 数出来的 —— 也就是说
     * **op 记的行号是"执行那一刻绑定的那份数据"的行号**。代理层只有全分辨率的 10%~35%，
     * 行号完全不同；让 op 落在代理层上，等于按代理层的行号去改全分辨率的数据
     * ⇒ **删错点**（改的是用户的数据，不是慢一点的问题）。
     * 这就是 M3-4 敢放宽"编辑过就永不用代理层"的前提：编辑一律发生在最高级。
     *
     * 走事件而不是直接依赖 LOD 模块：EditHistory 不该知道 LOD 的存在。
     * 注册方见 `src/lod/editor-lod.ts` 的 `edit.beforeApply`。
     */
    private async beforeApply() {
        if (!this.events.functions.has('edit.beforeApply')) return;
        const r = this.events.invoke('edit.beforeApply');
        if (r && typeof (r as any).then === 'function') await r;
    }

    private async _undo() {
        // only advance the cursor after a successful undo so a thrown editOp leaves
        // history in a consistent state for subsequent undo/redo.
        this._undoRedoBusy = true;
        try {
            await this.beforeApply();
            const editOp = this.history[this.cursor - 1];
            await editOp.undo();
            this.cursor--;
            this.events.fire('edit.apply', editOp);
            this.fireEvents();
        } finally {
            this._undoRedoBusy = false;
        }
    }

    private async _redo(suppressOp = false) {
        // only advance the cursor after a successful redo so a thrown editOp leaves
        // history in a consistent state for subsequent undo/redo.
        this._undoRedoBusy = true;
        try {
            await this.beforeApply();
            const editOp = this.history[this.cursor];
            if (!suppressOp) {
                await editOp.do();
            }
            this.cursor++;
            this.events.fire('edit.apply', editOp);
            this.fireEvents();
        } finally {
            this._undoRedoBusy = false;
        }
    }

    /**
     * True while an undo/redo op is executing. During that window, scene
     * removals (e.g. AddSplatOp.undo removing a separated/duplicated layer)
     * must NOT purge the very op being undone — otherwise redo is lost and the
     * op's GPU resources leak. Callers listen on scene.elementRemoved and skip
     * removeForSplat while this is set.
     */
    isUndoingRedoing() {
        return this._undoRedoBusy;
    }

    fireEvents() {
        this.events.fire('edit.canUndo', this.canUndo());
        this.events.fire('edit.canRedo', this.canRedo());
    }

    clear() {
        // route through the queue so any in-flight add/undo/redo finishes before we wipe
        // history, preventing queued ops from running against a cleared state.
        return this.queue(() => {
            this.history.forEach((editOp) => {
                editOp.destroy?.();
            });
            this.history = [];
            this.cursor = 0;
            this.fireEvents();
        });
    }

    // Remove all operations that reference a specific selection shape. Called
    // when a shape tool deactivates: the volume is transient tool state, so
    // its ops must not linger in history as steps that visibly change nothing.
    // Shape ops are never nested inside MultiOp, so a flat scan suffices.
    removeForShape(shape: unknown) {
        return this.queue(() => {
            let newCursor = 0;
            const newHistory: EditOp[] = [];

            for (let i = 0; i < this.history.length; i++) {
                const op = this.history[i];
                if ((op as any).shape === shape) {
                    op.destroy?.();
                } else {
                    newHistory.push(op);
                    if (i < this.cursor) {
                        newCursor++;
                    }
                }
            }

            this.history = newHistory;
            this.cursor = newCursor;
            this.fireEvents();
        });
    }

    // Remove all operations that reference a specific splat
    removeForSplat(splat: Splat) {
        // serialize with the queue so we don't reshape history while a queued op is mid-flight
        // (which could leave queued undo/redo pointing at indices that no longer exist).
        return this.queue(() => {
            let newCursor = 0;
            const newHistory: EditOp[] = [];

            for (let i = 0; i < this.history.length; i++) {
                const op = this.history[i];
                if (!opReferencesSplat(op, splat)) {
                    // Keep this operation
                    newHistory.push(op);
                    // Track cursor position (count kept operations before original cursor)
                    if (i < this.cursor) {
                        newCursor++;
                    }
                } else {
                    // 引用被移除 splat 的 op 必须在这里收尾。原来的注释说"调用方会处理"，
                    // 但唯一的调用方（`editor.ts` 的 `scene.elementRemoved` 处理）**没有**处理 ——
                    // 于是被丢掉的 op 还攥着自己的快照 Asset（`SurfaceRefineOp` 的两张
                    // registry.add 过的快照），`app.assets` 一直持有 ⇒ 整个 GSplatResource
                    // （全部列 + GPU 缓冲）永远不释放：1~7 GB 的模型上每做一次表面修复就永久多留一份。
                    // 同一文件里的 `removeForShape` 一直是这么做的（`op.destroy?.()`），这里补齐。
                    op.destroy?.();
                }
            }

            this.history = newHistory;
            this.cursor = newCursor;
            this.fireEvents();
        });
    }
}

export { EditHistory };
