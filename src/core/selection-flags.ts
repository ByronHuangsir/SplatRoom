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
//   footprint: 0 tests the splat's center point; >0 widens the hit test by a
//              fraction of the splat's rendered gaussian extent, so a splat
//              whose visible cover touches the region counts even when its
//              center falls outside it. The value is continuous in [0, 1] (as
//              upstream's footprint slider is): 1 = the full rendered
//              footprint, 0.5 = half of it, and so on.
//
// Both persist; the defaults (depth off, footprint 0) are SplatRoom's historical
// centre-based behaviour.

let useDepth = false;
let footprint = 0;
// what the toggle (toolbar button / Shift+M) restores when it turns footprint
// back on: the last non-zero value the user picked, so a slider setting survives
// a toggle round trip
let lastFootprint = 1;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

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

// legacy keys stored '0' / '1'; both parse as numbers, so an old preference
// carries over unchanged
const readFootprint = () => {
    const raw = readStored('splatroom.selFootprint', 'splatroom.selUseFootprint');
    if (raw === null) return 0;
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? clamp01(value) : 0;
};

const registerSelectionFlags = (events: Events) => {
    useDepth = readStored('splatroom.selUseDepth', 'splatroom.selSurfaceOnly') === '1';
    footprint = readFootprint();
    if (footprint > 0) {
        lastFootprint = footprint;
    }

    const setUseDepth = (value: boolean) => {
        if (value !== useDepth) {
            useDepth = value;
            store('splatroom.selUseDepth', value ? '1' : '0');
            events.fire('selection.useDepth', value);
        }
    };

    // accepts any value in [0, 1]; the hit test scales the splat extent by it,
    // so fractional values give partial-coverage selections
    const setFootprint = (value: number) => {
        const next = Number.isFinite(value) ? clamp01(value) : 0;
        if (next === footprint) {
            return;
        }
        footprint = next;
        if (next > 0) {
            lastFootprint = next;
        }
        store('splatroom.selFootprint', String(next));
        events.fire('selection.footprint', next);
    };

    events.function('selection.useDepth', () => useDepth);
    events.function('selection.footprint', () => footprint);
    events.on('selection.setUseDepth', setUseDepth);
    events.on('selection.setFootprint', setFootprint);
    events.on('selection.toggleUseDepth', () => setUseDepth(!useDepth));
    events.on('selection.toggleFootprint', () => setFootprint(footprint > 0 ? 0 : lastFootprint));
};

const getUseDepth = () => useDepth;
const getFootprint = () => footprint;

export { registerSelectionFlags, getUseDepth, getFootprint };
