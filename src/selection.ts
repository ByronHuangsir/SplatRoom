import { Element, ElementType } from './element';
import { Events } from './events';
import { Scene } from './scene';
import { Splat } from './splat';

const registerSelectionEvents = (events: Events, scene: Scene) => {
    let selections = new Set<Splat>();

    const fireChanged = () => {
        const arr = [...selections];
        // backward compat: first splat (or null)
        events.fire('selection.changed', arr[0] ?? null);
        // new: full multi-selection array
        events.fire('selection.changedMulti', arr);
    };

    // clear all and select one (or none)
    events.on('selection.set', (splat: Splat | null) => {
        const valid = !splat || splat.visible;
        const already = splat
            ? (selections.size === 1 && selections.has(splat))
            : (selections.size === 0);
        if (valid && !already) {
            selections = new Set(splat ? [splat] : []);
            fireChanged();
        }
    });

    // add one to selection (Ctrl+Click)
    events.on('selection.add', (splat: Splat) => {
        if (splat && splat.visible && !selections.has(splat)) {
            selections.add(splat);
            fireChanged();
        }
    });

    // remove one from selection (Ctrl+Click on selected)
    events.on('selection.remove', (splat: Splat) => {
        if (splat && selections.has(splat)) {
            selections.delete(splat);
            fireChanged();
        }
    });

    // toggle selection (Ctrl+Click)
    events.on('selection.toggle', (splat: Splat) => {
        if (!splat) return;
        if (selections.has(splat)) {
            events.fire('selection.remove', splat);
        } else if (splat.visible) {
            events.fire('selection.add', splat);
        }
    });

    // backward compat: clear all and select one
    events.on('selection', (splat: Splat) => {
        events.fire('selection.set', splat);
    });

    // backward compat: return first selected splat (or null)
    events.function('selection', () => {
        return selections.size > 0 ? [...selections][0] : null;
    });

    // returns all selected splats as array
    events.function('selection.all', () => {
        return [...selections];
    });

    events.on('selection.next', () => {
        const splats = scene.getElementsByType(ElementType.splat) as Splat[];
        if (splats.length > 1) {
            const current = [...selections][0];
            const idx = splats.indexOf(current);
            const next = splats[(idx + 1) % splats.length];
            selections = new Set(next ? [next] : []);
            fireChanged();
        }
    });

    events.on('scene.elementAdded', (element: Element) => {
        if (element.type === ElementType.splat) {
            selections = new Set([element as Splat]);
            fireChanged();
        }
    });

    events.on('scene.elementRemoved', (element: Element) => {
        if (selections.has(element as Splat)) {
            selections.delete(element as Splat);
            const splats = scene.getElementsByType(ElementType.splat) as Splat[];
            if (selections.size === 0 && splats.length === 1) {
                selections = new Set();
            }
            fireChanged();
        }
    });

    events.on('splat.visibility', (splat: Splat) => {
        if (selections.has(splat) && !splat.visible) {
            selections.delete(splat);
            fireChanged();
        }
    });

    events.on('camera.focalPointPicked', (details: { splat: Splat }) => {
        selections = new Set([details.splat]);
        fireChanged();
    });
};

export { registerSelectionEvents };
