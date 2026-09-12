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
import { EditHistory } from '../edit-history';
import { Events } from '../events';
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
    events.function('lod.allowProxy', () => {
        if (!autoEnabled) return false;
        const scene = getScene();
        if (!scene) return false;
        if (scene.lockedRenderMode) return false;
        if (scene.camera?.userDragging) return false;
        if (editHistory.isUndoingRedoing()) return false;
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

    // Auto-generate for the first large splat of a fresh load (auto mode only).
    events.on('scene.elementAdded', (element: Element) => {
        if (!autoEnabled) return;
        if (element.type !== ElementType.splat) return;
        const scene = getScene();
        if (!scene) return;
        const splats = scene.getElementsByType(ElementType.splat) as Splat[];
        if (splats.length > 1) return; // not the fresh single-splat load
        const splat = element as unknown as Splat;
        if (!splat?.splatData || splat.splatData.numSplats < LOD_GENERATE_MIN) return;
        // defer until the scene is interactive (focus/import done)
        setTimeout((): void => {
            void generateForSplat(splat);
        }, 400);
    });
};
