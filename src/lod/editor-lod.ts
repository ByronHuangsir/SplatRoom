/**
 * V3 runtime LOD — editor wiring.
 *
 * Provides:
 *  - `lod.autoEnabled` / `lod.setAuto`   master switch (default OFF: this is an
 *    opt-in experiment that must not change existing behaviour until verified).
 *  - `lod.allowProxy`                    browsing-state gate: proxy levels are
 *    only rendered while nothing is selected, nothing is being dragged/exported
 *    and no undo/redo is running.
 *  - `lod.generateForSplat(splat)`       (re)build proxy levels for one splat on
 *    the lod worker and register them via Splat.setLodAssets.
 *
 * On the first large splat added to an empty scene (while auto is ON) levels
 * are generated automatically a moment after load so the viewport isn't
 * blocked during the initial focus/import.
 */
import { buildLodAssets, planLodFractions, setLodDistances, getLodDistances } from './lod';
import { EditHistory } from '../core/edit-history';
import { Events } from '../core/events';
import { splatTier } from '../core/splat-tier';
import { Element, ElementType } from '../scene/element';
import type { Scene } from '../scene/scene';
import { Splat } from '../splat/splat';

const LOD_GENERATE_MIN = 900_000; // splats

export const registerLodEvents = (
    events: Events,
    editHistory: EditHistory,
    getScene: () => Scene | null
) => {
    let autoEnabled = false;
    let generating = false;

    // engagement-distance tuning (camera-distance/model-radius)
    events.function('lod.distances', getLodDistances);
    events.on('lod.setDistances', (near: number, far: number) => {
        setLodDistances(near, far);
        events.fire('lod.distancesChanged', getLodDistances());
    });

    events.function('lod.autoEnabled', () => autoEnabled);
    events.on('lod.setAuto', (v: boolean) => {
        autoEnabled = !!v;
        events.fire('lod.autoChanged', autoEnabled);
        // leaving auto mode: restore full resolution everywhere
        if (!autoEnabled) {
            const scene = getScene();
            if (!scene) return;
            const splats = scene.getElementsByType(ElementType.splat) as Splat[];
            for (const s of splats) {
                if (s.lodLevel !== -1) void s.applyLod(-1);
            }
        }
    });

    // Non-editing browsing gate: only then may a proxy level stay active.
    //
    // 2026-09-25：加"**文档必须没有被编辑过**"这一条。原因是代码级证据的：
    // `Splat.bindAsset()` 会让 `this.splatData` **跟着当前绑定的 asset 走**（splat.ts:525），
    // 并且给每一份被绑定的数据各建一份 state 列（splat.ts:574-581）。于是代理层生效期间：
    //   · 框选/删除写在**代理层自己的 state** 上（只有 10%~35% 的行，且行号是代理层的行号）；
    //   · 任何一次选择都会把闸门翻回"有选区 ⇒ 不许可代理" ⇒ 立刻 `applyLod(-1)` 换回全分辨率，
    //     而全分辨率那份 state 是**它自己之前的**内容 ⇒ 用户看到的是"选区没了 / 删了没反应"；
    //   · 更糟的是历史里的 op 记的是**代理层行号**，换回全分辨率后再撤销/重做，
    //     就会按代理层的行号去改全分辨率的数据 ⇒ **删错点**（这是改用户的数据，不是慢一点的问题）。
    // 所以代理层只用于"**导入后还没动过**"的浏览态；一旦有编辑历史（含选区）就一律回到全分辨率。
    // 代价：编辑过的超大模型在看远时不再降级（慢一点），换来的是不会悄悄改错数据。
    //
    // ---- M3-4：编辑态放宽 ------------------------------------------------------------
    // 上面那条"代价"由 M3-3 解决了一半（浏览态解除 `canUndo()` 这一条），M3-4 解决剩下
    // 的那一半 —— **把 M3-3 那道单会话保险也拿掉**，编辑过的模型在浏览态也能稳定用代理层。
    //
    // 能拿掉的前提是"行号不再会错"，由两处保证（都不是概率上的侥幸）：
    //   · **`edit.beforeApply`（下面注册）**：EditHistory 在 do/undo/redo **执行 op 之前**
    //     先 await 一次"全部回到全分辨率"。op 的行号是在执行那一刻按当前绑定数据数出来的
    //     （见 `src/core/edit-ops.ts` 的 `StateOp.captureRanges`），所以只要保证执行时绑的是
    //     全分辨率，行号就一定对得上。Ctrl+Z 这类不依赖 UI 的入口也被这条覆盖。
    //   · **代理层 state 同步**（`Splat.syncProxyStateFromBase`）：全分辨率上删掉的点，
    //     进代理层时按行映射搬过去，不会复活。
    //
    // 逃生门：`window.__SPLATROOM_LOD_EDIT_RELAX__ = false` 回到 M3-3 行为
    // （编辑过 ⇒ 浏览态也不用代理层）。
    const editRelax = () => (globalThis as any).__SPLATROOM_LOD_EDIT_RELAX__ !== false;

    /**
     * 由 `EditHistory` 在 do/undo/redo 之前 await（见那里的注释）：把所有还挂着代理层的
     * splat 切回全分辨率。
     *
     * 注意要**先补帧再 await**：静止时本应用按需渲染不出帧，而 `replaceData` 要
     * `waitForRender()`，不补帧就会挂死（M3-3 踩过同一个坑）。
     */
    events.function('edit.beforeApply', async () => {
        const scene = getScene();
        if (!scene) return;
        const splats = scene.getElementsByType(ElementType.splat) as Splat[];
        const pending = splats.filter(s => s.lodLevel !== -1);
        if (pending.length === 0) return;
        scene.requestFrames(12);
        for (const s of pending) await s.applyLod(-1);
    });

    events.function('lod.allowProxy', () => {
        if (!autoEnabled) return false;
        const scene = getScene();
        if (!scene) return false;
        if (scene.lockedRenderMode) return false;
        if (scene.camera?.userDragging) return false;
        if (editHistory.isUndoingRedoing()) return false;
        if (editHistory.canUndo()) {
            // 编辑过：只有浏览态（且未关闭放宽）才允许继续用代理层
            const browse = events.invoke('browse.active') === true;
            if (!browse || !editRelax()) return false;
        }
        const selection = events.invoke('selection.splats') as unknown[] | undefined;
        if (selection && selection.length > 0) return false;
        return true;
    });

    const generateForSplat = async (splat: Splat) => {
        if (!splat?.splatData || splat.splatData.numSplats < LOD_GENERATE_MIN) return;
        if (generating) return; // one build at a time
        generating = true;
        try {
            const scene = getScene();
            const app = (scene as any)?.app ?? splat.scene?.app;
            if (!app) return;
            const fractions = planLodFractions(splat.splatData.numSplats);
            if (fractions.length === 0) return;
            events.fire('progressStart', 'Generating LOD…', false);
            const built = await buildLodAssets(
                app,
                splat.splatData,
                fractions,
                splat.name || 'splat',
                f => events.fire('progressSet', Math.round(f * 100))
            );
            if (!splat.scene) return; // splat removed mid-build
            splat.setLodAssets(built.map(b => ({ asset: b.asset, numSplats: b.count })));
            events.fire('lod.ready', splat, splat.lodAssets.map(a => a.numSplats));
        } catch (e) {
            console.warn('[lod] generate failed:', e);
        } finally {
            generating = false;
            events.fire('progressEnd');
        }
    };

    events.function('lod.generateForSplat', (splat: Splat) => generateForSplat(splat));
    events.function('lod.generateForAll', async () => {
        const scene = getScene();
        if (!scene) return;
        const splats = scene.getElementsByType(ElementType.splat) as Splat[];
        for (const s of splats) await generateForSplat(s);
    });

    // 按需构建代理层：`Scene.updateLodSwitching` 判定"相机已经远到需要代理层、但这个 splat
    // 还没有代理层"时会 fire 一次 `lod.needs`（每个 splat 只发一次，见 `Splat._lodBuildRequested`）。
    //
    // 2026-09-25：原来是在导入后用 `requestIdleCallback`（+8s 兜底）**抢建**。实测用户真实扫描件
    // （2000 万点 / 4.96GB，`_tmp/probe-big-workflow.cjs`）：导入完成 JS 堆 10.3GB →
    // 代理层建好 **13.1GB**（两层抽样+打包要多花约 2.9GB），而这段开销正好落在
    // "导入刚结束、用户开始框选/删除"的那一刻。改成按需：近距离编辑一分钱不花，
    // 远距离浏览时补上（首次晚一个构建时间，建好之后一直可用）。
    events.on('lod.needs', (splat: Splat) => {
        if (!autoEnabled) return;
        void generateForSplat(splat);
    });

    // Auto-enable for the first large splat of a fresh load.
    //
    // 2026-09-22 分级：B 档（500 万~5000 万）与 C 档（> 5000 万）**自动开启** —— 这是用户要的
    // "不同等级采取不同策略"里性能那一半：代理层只在相机远离到阈值之外才会接管
    // （`lod.allowProxy` 还要求"没选中、没在拖、没在撤销、**文档没有被编辑过**"），
    // 近距离仍是全分辨率。
    // 关掉的办法：设置面板里的 Runtime LOD 开关，或 `window.__SPLATROOM_TIER_LOD__ = false`。
    events.on('scene.elementAdded', (element: Element) => {
        if (element.type !== ElementType.splat) return;
        const scene = getScene();
        if (!scene) return;
        const splats = scene.getElementsByType(ElementType.splat) as Splat[];
        if (splats.length > 1) return; // not the fresh single-splat load
        const splat = element as unknown as Splat;
        if (!splat?.splatData) return;

        // 分级决定要不要自动开（A 档不动 —— 小模型不需要代理层）
        const tierAuto = (globalThis as any).__SPLATROOM_TIER_LOD__ !== false;
        const numSplats = splat.splatData.numSplats;
        if (tierAuto && splatTier(numSplats) !== 'A' && !autoEnabled) {
            autoEnabled = true;
            events.fire('lod.autoChanged', autoEnabled);
        }
        // 这里不再构建代理层：见上面的 'lod.needs'。
    });
};
