import { Events } from './events';

// Selection depth / footprint state (V3, SuperSplat 3 semantics).
//
// This lives in its own module so it can be registered before the UI is built:
// the settings panel reads these values while it is constructed, which happens
// before the editor registers its handlers.
//
//   useDepth : only splats visible on the surface can be selected. Screen-space
//              gestures then run on the per-pixel id pick (front-most wins),
//              which is SuperSplat's "selection depth".
//   footprint: 0 tests the splat's center point, >0 widens the hit test by the
//              splat's rendered gaussian extent, so a splat whose visible cover
//              touches the region counts even when its center falls outside it.
//
// Both persist; the defaults (depth off, footprint 0) are SplatRoom's historical
// centre-based behaviour.

let useDepth = false;
let footprint = 0;

const readStored = (key: string, legacyKey?: string) => {
    try {
        return localStorage.getItem(key) ?? (legacyKey ? localStorage.getItem(legacyKey) : null);
    } catch {
        return null;
    }
};

const store = (key: string, value: string) => {
    try {
        localStorage.setItem(key, value);
    } catch { /* storage unavailable */ }
};

const registerSelectionFlags = (events: Events) => {
    useDepth = readStored('splatroom.selUseDepth', 'splatroom.selSurfaceOnly') === '1';
    footprint = readStored('splatroom.selFootprint', 'splatroom.selUseFootprint') === '1' ? 1 : 0;

    const setUseDepth = (value: boolean) => {
        if (value !== useDepth) {
            useDepth = value;
            store('splatroom.selUseDepth', value ? '1' : '0');
            events.fire('selection.useDepth', value);
        }
    };

    const setFootprint = (value: number) => {
        const next = value > 0 ? 1 : 0;
        if (next !== footprint) {
            footprint = next;
            store('splatroom.selFootprint', next ? '1' : '0');
            events.fire('selection.footprint', next);
        }
    };

    events.function('selection.useDepth', () => useDepth);
    events.function('selection.footprint', () => footprint);
    events.on('selection.setUseDepth', setUseDepth);
    events.on('selection.setFootprint', setFootprint);
    events.on('selection.toggleUseDepth', () => setUseDepth(!useDepth));
    events.on('selection.toggleFootprint', () => setFootprint(footprint > 0 ? 0 : 1));
};

const getUseDepth = () => useDepth;
const getFootprint = () => footprint;

export { registerSelectionFlags, getUseDepth, getFootprint };
