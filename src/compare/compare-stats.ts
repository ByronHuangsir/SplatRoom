/**
 * CompareStats — per-viewport data analysis panel.
 *
 * Layout mirrors SplatRoom's main-viewport data panel (`src/ui/data-panel.ts`):
 *   ┌────────────┬──────────────────────────────────────────────┐
 *   │ attribute  │                                              │
 *   │  list      │             histogram                        │
 *   │ (vertical) │  ┌──────────────────────────────────────┐    │
 *   │            │  │     [stats overlay top-right]        │    │
 *   │ 位置 X     │  │                                      │    │
 *   │ 位置 Y     │  │         bar bar bar bar              │    │
 *   │ 位置 Z     │  │         bar ▌▌▌▌▌▌▌▌▌▌               │    │
 *   │ 距离       │  │                                      │    │
 *   │ ...        │  └──────────────────────────────────────┘    │
 *   │ 球谐 DC R  │  min: -1.2                  max: 1.4         │
 *   └────────────┴──────────────────────────────────────────────┘
 *
 * Implemented in pure DOM (no pcui) so it is self-contained and
 * independent of the editor's panel chrome.
 *
 * Synchronisation: panels are *passive*. ComparePanel owns the shared
 * active-attribute state and calls setActive() on every panel to keep
 * all viewports showing the same attribute histogram.
 */

const SH_C0 = 0.28209479177387814;

export type AttrKey =
    | 'x' | 'y' | 'z' | 'distance' | 'camera-depth'
    | 'red' | 'green' | 'blue' | 'opacity'
    | 'scale_0' | 'scale_1' | 'scale_2'
    | 'rot_0' | 'rot_1' | 'rot_2' | 'rot_3'
    | 'volume' | 'surface-area'
    | 'hue' | 'saturation' | 'value'
    | 'f_dc_0' | 'f_dc_1' | 'f_dc_2';

export interface StatsPanel {
    root: HTMLDivElement;
    setRect: (x: number, y: number, w: number, h: number) => void;
    /** Show histogram for `key`, or hide (set to null) the histogram region. */
    setActive: (key: AttrKey | null) => void;
    /** Recompute attributes whose data may have changed (e.g. re-import). */
    recompute?: () => void;
}

const BIN_COUNT = 64;
const SAMPLE_STEP_CAP = 2000;   // sample up to 2000 points per attribute

// ---- helper: a single attribute descriptor ----
interface AttrDesc {
    key: AttrKey;
    label: string;
    /** true if raw property exists on the gsplat data */
    available: (gd: any) => boolean;
    /** extract N values as Float32Array (length = N) */
    extract: (gd: any, n: number) => Float32Array;
}

const ATTRS: AttrDesc[] = [
    { key: 'x',
        label: '位置 X',
        available: gd => !!gd.getProp('x'),
        extract: (gd, n) => sampleFrom3(gd.getCenters(), 0, n) },
    { key: 'y',
        label: '位置 Y',
        available: gd => !!gd.getProp('y'),
        extract: (gd, n) => sampleFrom3(gd.getCenters(), 1, n) },
    { key: 'z',
        label: '位置 Z',
        available: gd => !!gd.getProp('z'),
        extract: (gd, n) => sampleFrom3(gd.getCenters(), 2, n) },
    { key: 'distance',
        label: '距离',
        available: gd => !!gd.getCenters,
        extract: (gd, n) => sampleFromCentersMag(gd, n) },
    { key: 'camera-depth',
        label: '深度',
        available: gd => false,
        extract: () => new Float32Array(0) },
    { key: 'red',
        label: '红',
        available: gd => !!gd.getProp('f_dc_0'),
        extract: (gd, n) => sigmoidFromDc(gd.getProp('f_dc_0'), n) },
    { key: 'green',
        label: '绿',
        available: gd => !!gd.getProp('f_dc_1'),
        extract: (gd, n) => sigmoidFromDc(gd.getProp('f_dc_1'), n) },
    { key: 'blue',
        label: '蓝',
        available: gd => !!gd.getProp('f_dc_2'),
        extract: (gd, n) => sigmoidFromDc(gd.getProp('f_dc_2'), n) },
    { key: 'opacity',
        label: '不透明度',
        available: gd => !!gd.getProp('opacity'),
        extract: (gd, n) => opacityExtract(gd, n) },
    { key: 'scale_0',
        label: '尺度 X',
        available: gd => !!gd.getProp('scale_0'),
        extract: (gd, n) => scaleExtract(gd, 0, n) },
    { key: 'scale_1',
        label: '尺度 Y',
        available: gd => !!gd.getProp('scale_1'),
        extract: (gd, n) => scaleExtract(gd, 1, n) },
    { key: 'scale_2',
        label: '尺度 Z',
        available: gd => !!gd.getProp('scale_2'),
        extract: (gd, n) => scaleExtract(gd, 2, n) },
    { key: 'rot_0',
        label: '四元数 W',
        available: gd => !!gd.getProp('rot_0'),
        extract: (gd, n) => sampleFrom1(gd.getProp('rot_0'), n) },
    { key: 'rot_1',
        label: '四元数 X',
        available: gd => !!gd.getProp('rot_1'),
        extract: (gd, n) => sampleFrom1(gd.getProp('rot_1'), n) },
    { key: 'rot_2',
        label: '四元数 Y',
        available: gd => !!gd.getProp('rot_2'),
        extract: (gd, n) => sampleFrom1(gd.getProp('rot_2'), n) },
    { key: 'rot_3',
        label: '四元数 Z',
        available: gd => !!gd.getProp('rot_3'),
        extract: (gd, n) => sampleFrom1(gd.getProp('rot_3'), n) },
    { key: 'volume',
        label: '体积',
        available: gd => !!gd.getProp('scale_0') && !!gd.getProp('scale_1') && !!gd.getProp('scale_2'),
        extract: (gd, n) => volumeExtract(gd, n) },
    { key: 'surface-area',
        label: '表面积',
        available: gd => !!gd.getProp('scale_0') && !!gd.getProp('scale_1') && !!gd.getProp('scale_2'),
        extract: (gd, n) => surfaceAreaExtract(gd, n) },
    { key: 'hue',
        label: '色相',
        available: gd => !!gd.getProp('f_dc_0'),
        extract: (gd, n) => hsvExtract(gd, n, 0) },
    { key: 'saturation',
        label: '饱和度',
        available: gd => !!gd.getProp('f_dc_0'),
        extract: (gd, n) => hsvExtract(gd, n, 1) },
    { key: 'value',
        label: '明度',
        available: gd => !!gd.getProp('f_dc_0'),
        extract: (gd, n) => hsvExtract(gd, n, 2) },
    { key: 'f_dc_0',
        label: '球谐 DC R',
        available: gd => !!gd.getProp('f_dc_0'),
        extract: (gd, n) => sampleFrom1(gd.getProp('f_dc_0'), n) },
    { key: 'f_dc_1',
        label: '球谐 DC G',
        available: gd => !!gd.getProp('f_dc_1'),
        extract: (gd, n) => sampleFrom1(gd.getProp('f_dc_1'), n) },
    { key: 'f_dc_2',
        label: '球谐 DC B',
        available: gd => !!gd.getProp('f_dc_2'),
        extract: (gd, n) => sampleFrom1(gd.getProp('f_dc_2'), n) }
];

// ===========================================================================
// Extractors — turn raw gsplat data into sampled Float32Array
// ===========================================================================

function sampleFrom1(raw: Float32Array, n: number): Float32Array {
    const total = raw.length;
    if (total === 0) return new Float32Array(0);
    const step = Math.max(1, Math.floor(total / Math.min(SAMPLE_STEP_CAP, n)));
    const out = new Float32Array(Math.min(SAMPLE_STEP_CAP, Math.floor(total / step)));
    for (let i = 0; i < out.length; i++) out[i] = raw[Math.min(total - 1, i * step)];
    return out;
}

function sampleFrom3(raw: Float32Array, axis: number, _n: number): Float32Array {
    const total = raw.length / 3;
    if (total === 0) return new Float32Array(0);
    const step = Math.max(1, Math.floor(total / SAMPLE_STEP_CAP));
    const out = new Float32Array(Math.floor(total / step));
    for (let i = 0; i < out.length; i++) {
        const idx = Math.min(total - 1, i * step);
        out[i] = raw[idx * 3 + axis];
    }
    return out;
}

function sampleFromCentersMag(gd: any, _n: number): Float32Array {
    let raw: Float32Array;
    try {
        raw = gd.getCenters();
    } catch (_) {
        return new Float32Array(0);
    }
    const total = raw.length / 3;
    if (total === 0) return new Float32Array(0);
    const step = Math.max(1, Math.floor(total / SAMPLE_STEP_CAP));
    const out = new Float32Array(Math.floor(total / step));
    for (let i = 0; i < out.length; i++) {
        const idx = Math.min(total - 1, i * step);
        const x = raw[idx * 3], y = raw[idx * 3 + 1], z = raw[idx * 3 + 2];
        out[i] = Math.sqrt(x * x + y * y + z * z);
    }
    return out;
}

function sigmoidFromDc(raw: Float32Array, n: number): Float32Array {
    const sampled = sampleFrom1(raw, n);
    for (let i = 0; i < sampled.length; i++) {
        const v = 0.5 + SH_C0 * sampled[i];
        sampled[i] = 1 / (1 + Math.exp(-v));
    }
    return sampled;
}

function opacityExtract(gd: any, n: number): Float32Array {
    const raw = gd.getProp('opacity') as Float32Array;
    if (!raw || raw.length === 0) return new Float32Array(0);
    const sampled = sampleFrom1(raw, n);
    if (gd.activated) return sampled;
    // pre-sigmoid → post-sigmoid (alpha in [0, 1])
    for (let i = 0; i < sampled.length; i++) {
        sampled[i] = 1 / (1 + Math.exp(-sampled[i]));
    }
    return sampled;
}

function scaleExtract(gd: any, axis: number, n: number): Float32Array {
    const raw = gd.getProp(`scale_${axis}`) as Float32Array;
    if (!raw || raw.length === 0) return new Float32Array(0);
    const sampled = sampleFrom1(raw, n);
    if (gd.activated) return sampled;
    // log-space → linear
    for (let i = 0; i < sampled.length; i++) sampled[i] = Math.exp(sampled[i]);
    return sampled;
}

function volumeExtract(gd: any, n: number): Float32Array {
    const sx = scaleExtract(gd, 0, n);
    const sy = scaleExtract(gd, 1, n);
    const sz = scaleExtract(gd, 2, n);
    const out = new Float32Array(sx.length);
    const k = 4 / 3 * Math.PI;
    for (let i = 0; i < out.length; i++) out[i] = k * sx[i] * sy[i] * sz[i];
    return out;
}

function surfaceAreaExtract(gd: any, n: number): Float32Array {
    const sx = scaleExtract(gd, 0, n);
    const sy = scaleExtract(gd, 1, n);
    const sz = scaleExtract(gd, 2, n);
    const out = new Float32Array(sx.length);
    // Knud Thomsen approximation: 4π * ((sx*sy)^p + (sy*sz)^p + (sz*sx)^p) / 3
    const p = 1.6075;
    const k = 4 * Math.PI / 3;
    for (let i = 0; i < out.length; i++) {
        const a = Math.pow(sx[i] * sy[i], p);
        const b = Math.pow(sy[i] * sz[i], p);
        const c = Math.pow(sz[i] * sx[i], p);
        out[i] = k * (a + b + c);
    }
    return out;
}

function hsvExtract(gd: any, n: number, channel: 0 | 1 | 2): Float32Array {
    const raw0 = gd.getProp('f_dc_0') as Float32Array;
    const raw1 = gd.getProp('f_dc_1') as Float32Array;
    const raw2 = gd.getProp('f_dc_2') as Float32Array;
    if (!raw0 || !raw1 || !raw2) return new Float32Array(0);
    const total = raw0.length;
    const step = Math.max(1, Math.floor(total / SAMPLE_STEP_CAP));
    const m = Math.floor(total / step);
    const r = sampleFrom1(raw0, n);
    const g = sampleFrom1(raw1, n);
    const b = sampleFrom1(raw2, n);
    const out = new Float32Array(m);
    for (let i = 0; i < m; i++) {
        const R = 1 / (1 + Math.exp(-(0.5 + SH_C0 * r[i])));
        const G = 1 / (1 + Math.exp(-(0.5 + SH_C0 * g[i])));
        const B = 1 / (1 + Math.exp(-(0.5 + SH_C0 * b[i])));
        const max = Math.max(R, G, B);
        const min = Math.min(R, G, B);
        const d = max - min;
        if (channel === 2) {
            out[i] = max; continue;
        }
        if (channel === 1) {
            out[i] = max > 0 ? d / max : 0; continue;
        }
        // hue
        if (d === 0) {
            out[i] = 0; continue;
        }
        let h: number;
        if (max === R) h = ((G - B) / d) % 6;
        else if (max === G) h = (B - R) / d + 2;
        else h = (R - G) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
        out[i] = h;
    }
    return out;
}

// ===========================================================================
// Histogram binner
// ===========================================================================

function computeBins(values: Float32Array, binCount: number): { bins: number[]; min: number; max: number } | null {
    if (!values || values.length === 0) return null;
    let minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
    }
    if (!isFinite(minV) || !isFinite(maxV) || minV === maxV) {
        return { bins: new Array(binCount).fill(values.length / binCount), min: minV, max: maxV };
    }
    const range = maxV - minV;
    const bins = new Array(binCount).fill(0);
    for (let i = 0; i < values.length; i++) {
        const idx = Math.min(binCount - 1, Math.floor(((values[i] - minV) / range) * binCount));
        bins[idx]++;
    }
    return { bins, min: minV, max: maxV };
}

// ===========================================================================
// The StatsPanel itself
// ===========================================================================

let stylesInstalled = false;
function installStylesOnce() {
    if (stylesInstalled) return;
    stylesInstalled = true;
    const s = document.createElement('style');
    s.textContent = `
        .compare-stats-panel {
            display: flex;
            flex-direction: column;
            position: absolute;
            pointer-events: auto;
            z-index: 101;
            font: 11px/1.3 system-ui, sans-serif;
            color: rgba(234,234,234,0.92);
            box-sizing: border-box;
            overflow: hidden;
            background: rgba(24,28,34,0.94);
            border: 1px solid rgba(255,255,255,0.12);
            box-shadow: 0 0 8px rgba(0,0,0,0.35);
        }
        /* ── header (top, spans full panel width) ── */
        .compare-stats-panel .header {
            flex: 0 0 auto;
            padding: 4px 10px;
            font-size: 12px;
            font-weight: 600;
            background: rgba(14,18,22,0.95);
            border-bottom: 1px solid rgba(255,255,255,0.10);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .compare-stats-panel .body {
            flex: 1 1 auto;
            min-height: 0;
            min-width: 0;
            display: flex;
            overflow: hidden;
        }
        /* ── wide layout (panel at viewport bottom): row — list left, hist right ── */
        .compare-stats-panel.wide .body { flex-direction: row; }
        .compare-stats-panel.wide .listCol {
            flex: 0 0 100px;
            background: rgba(20,24,30,0.94);
            border-right: 1px solid rgba(255,255,255,0.10);
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }
        .compare-stats-panel.wide .histCol {
            flex: 1 1 auto;
            border-left: 1px solid rgba(255,255,255,0.04);
        }
        /* ── narrow layout (panel on viewport left): column — list top, hist bottom ── */
        .compare-stats-panel.narrow .body { flex-direction: column; }
        .compare-stats-panel.narrow .listCol {
            flex: 1 1 auto;
            min-height: 0;
            min-width: 0;
            background: rgba(20,24,30,0.94);
            border-right: none;
            border-bottom: 1px solid rgba(255,255,255,0.10);
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }
        .compare-stats-panel.narrow .histCol {
            flex: 0 0 110px;
            border-top: 1px solid rgba(255,255,255,0.10);
        }
        /* ── list + histogram internals (shared) ── */
        .compare-stats-panel .listBox {
            flex: 1 1 auto;
            min-height: 0;
            overflow-y: auto;
            overflow-x: hidden;
            padding: 2px 0;
        }
        .compare-stats-panel .histCol {
            position: relative;
            display: flex;
            flex-direction: column;
            background: rgba(28,32,38,0.94);
            overflow: hidden;
        }
        /* ── min/max data ruler (axis row) ── */
        .compare-stats-panel .axisRow {
            flex: 0 0 18px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 1px 6px 0;
            font-size: 9px;
            color: rgba(234,234,234,0.65);
            font-variant-numeric: tabular-nums;
            background: rgba(14,18,22,0.6);
            border-top: 1px solid rgba(255,255,255,0.06);
            white-space: nowrap;
        }
        .compare-stats-panel .axisRow .minLabel,
        .compare-stats-panel .axisRow .maxLabel {
            color: rgba(234,234,234,0.65);
        }
        /* horizontal range line, drawn above tick labels */
        .compare-stats-panel .axisRow .rangeLine {
            flex: 1 1 auto;
            margin: 0 8px;
            height: 1px;
            background: linear-gradient(to right,
                rgba(255,255,255,0.35),
                rgba(255,255,255,0.45) 50%,
                rgba(255,255,255,0.35));
            position: relative;
        }
        .compare-stats-panel .axisRow .rangeLine::before,
        .compare-stats-panel .axisRow .rangeLine::after {
            content: '';
            position: absolute;
            top: -2px;
            width: 1px;
            height: 5px;
            background: rgba(255,255,255,0.45);
        }
        .compare-stats-panel .axisRow .rangeLine::before { left: 0; }
        .compare-stats-panel .axisRow .rangeLine::after { right: 0; }
        /* ── list item ── */
        .compare-stats-item {
            padding: 3px 10px;
            font-size: 12px;
            color: rgba(234,234,234,0.85);
            cursor: pointer;
            border-left: 3px solid transparent;
            user-select: none;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .compare-stats-item:hover {
            background: rgba(255,255,255,0.06);
            color: rgba(234,234,234,1);
        }
        .compare-stats-item.active {
            background: rgba(60,80,110,0.85);
            color: #9bc4ff;
            font-weight: 600;
            border-left: 3px solid #5a8be0;
        }
        .compare-stats-item.unavailable {
            color: rgba(234,234,234,0.30);
            cursor: default;
        }
        .compare-stats-item.unavailable:hover {
            background: transparent;
            color: rgba(234,234,234,0.30);
        }
    `;
    document.head.appendChild(s);
}

export function createStatsPanel(
    gsplatData: any,
    splatCount: number,
    name: string
): StatsPanel {
    const root = document.createElement('div');
    root.className = 'compare-stats-panel wide';     // default to wide (bottom) layout
    document.body.appendChild(root);

    // ---- header (top, spans full panel width) ----
    const header = document.createElement('div');
    header.className = 'header';
    header.textContent = `${name}（${(splatCount / 1000).toFixed(1)}k 点）`;
    root.appendChild(header);

    // ---- body: row (wide) or column (narrow) of list + histogram ----
    const body = document.createElement('div');
    body.className = 'body';
    root.appendChild(body);

    // ---- attribute list column (left in wide mode, top in narrow mode) ----
    const listCol = document.createElement('div');
    listCol.className = 'listCol';
    body.appendChild(listCol);

    const listBox = document.createElement('div');
    listBox.className = 'listBox';
    listCol.appendChild(listBox);

    // ---- histogram column (right in wide mode, bottom in narrow mode) ----
    const histCol = document.createElement('div');
    histCol.className = 'histCol';
    body.appendChild(histCol);

    // top stats overlay (top-right inside histogram)
    const statsOverlay = document.createElement('div');
    Object.assign(statsOverlay.style, {
        position: 'absolute',
        top: '3px',
        right: '6px',
        padding: '1px 6px',
        fontSize: '10px',
        background: 'rgba(0,0,0,0.55)',
        borderRadius: '2px',
        color: 'rgba(234,234,234,0.9)',
        fontVariantNumeric: 'tabular-nums',
        pointerEvents: 'none',
        zIndex: '2',
        whiteSpace: 'nowrap'
    } as CSSStyleDeclaration);
    const splatsLabel = document.createElement('span');
    splatsLabel.textContent = `Splat  ${splatCount.toLocaleString()} (100.0%)`;
    statsOverlay.appendChild(splatsLabel);
    histCol.appendChild(statsOverlay);

    // bars area (with horizontal grid lines behind)
    const barsArea = document.createElement('div');
    Object.assign(barsArea.style, {
        flex: '1 1 auto',
        minHeight: '0',
        position: 'relative',
        overflow: 'hidden'
    } as CSSStyleDeclaration);
    histCol.appendChild(barsArea);

    // faint horizontal grid lines (4 evenly spaced)
    for (let g = 1; g <= 4; g++) {
        const gridLine = document.createElement('div');
        Object.assign(gridLine.style, {
            position: 'absolute',
            left: '3px',
            right: '3px',
            bottom: `${g * 20}%`,
            height: '1px',
            background: 'rgba(255,255,255,0.10)',
            pointerEvents: 'none',
            zIndex: '0'
        } as CSSStyleDeclaration);
        barsArea.appendChild(gridLine);
    }

    const barsContainer = document.createElement('div');
    Object.assign(barsContainer.style, {
        flex: '1 1 auto',
        minHeight: '0',
        display: 'flex',
        alignItems: 'flex-end',
        gap: '1px',
        padding: '4px 4px 0',
        position: 'absolute',
        inset: '0',
        zIndex: '1'
    } as CSSStyleDeclaration);
    barsArea.appendChild(barsContainer);

    const bars: HTMLDivElement[] = [];
    for (let i = 0; i < BIN_COUNT; i++) {
        const bar = document.createElement('div');
        Object.assign(bar.style, {
            flex: '1',
            minWidth: '1px',
            background: 'rgba(110,140,255,0.85)',
            borderRadius: '1px 1px 0 0',
            height: '0%'
        } as CSSStyleDeclaration);
        barsContainer.appendChild(bar);
        bars.push(bar);
    }

    // ---- bottom axis row — min/max with horizontal range ruler ----
    const axisRow = document.createElement('div');
    axisRow.className = 'axisRow';
    histCol.appendChild(axisRow);

    const minLabel = document.createElement('span');
    minLabel.className = 'minLabel';
    minLabel.textContent = '-';
    axisRow.appendChild(minLabel);

    const rangeLine = document.createElement('div');
    rangeLine.className = 'rangeLine';
    axisRow.appendChild(rangeLine);

    const maxLabel = document.createElement('span');
    maxLabel.className = 'maxLabel';
    maxLabel.textContent = '-';
    axisRow.appendChild(maxLabel);

    // ---- cache for each attribute ----
    const cache: Partial<Record<AttrKey, { bins: number[]; min: number; max: number; n: number }>> = {};

    function recomputeAll() {
        if (!gsplatData) return;
        for (const a of ATTRS) {
            if (!a.available(gsplatData)) {
                cache[a.key] = null;
                continue;
            }
            const values = a.extract(gsplatData, SAMPLE_STEP_CAP);
            const hist = computeBins(values, BIN_COUNT);
            if (hist) cache[a.key] = { ...hist, n: values.length };
        }
    }

    function setActive(key: AttrKey | null) {
        // refresh list-item styles
        for (const el of listItems) {
            el.classList.toggle('active', el.dataset.key === key);
        }
        if (!key) {
            // hide histogram
            for (const b of bars) b.style.height = '0%';
            minLabel.textContent = '-';
            maxLabel.textContent = '-';
            splatsLabel.textContent = `Splat  ${splatCount.toLocaleString()} (100.0%)`;
            return;
        }
        const data = cache[key];
        if (!data) {
            for (const b of bars) b.style.height = '0%';
            minLabel.textContent = '-';
            maxLabel.textContent = '-';
            splatsLabel.textContent = `Splat  ${splatCount.toLocaleString()} (100.0%)`;
            return;
        }
        let maxBin = 1;
        const bins = data.bins;
        for (let i = 0; i < bins.length; i++) if (bins[i] > maxBin) maxBin = bins[i];
        for (let i = 0; i < BIN_COUNT; i++) {
            bars[i].style.height = `${(data.bins[i] / maxBin) * 100}%`;
        }
        // ---- min/max data ruler ----
        minLabel.textContent = `min: ${formatTick(data.min)}`;
        maxLabel.textContent = `max: ${formatTick(data.max)}`;
        splatsLabel.textContent = `Splat  ${splatCount.toLocaleString()} (100.0%)`;
    }

    function formatTick(v: number): string {
        if (!isFinite(v)) return '-';
        const a = Math.abs(v);
        if (a !== 0 && (a < 0.01 || a >= 10000)) return v.toExponential(2);
        return v.toFixed(2);
    }

    // ---- build attribute list items ----
    installStylesOnce();
    const listItems: HTMLDivElement[] = [];
    for (const a of ATTRS) {
        const item = document.createElement('div');
        item.className = 'compare-stats-item';
        item.dataset.key = a.key;
        item.textContent = a.label;
        const available = gsplatData && a.available(gsplatData);
        if (!available) item.classList.add('unavailable');
        if (available) {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                // dispatch a CustomEvent; ComparePanel listens and keeps all
                // viewports in sync by calling setActive on each panel.
                root.dispatchEvent(new CustomEvent('stats-attr', {
                    detail: { key: a.key, source: root }
                }));
            });
        }
        listBox.appendChild(item);
        listItems.push(item);
    }

    // pre-compute on construction
    recomputeAll();

    return {
        root,
        setRect(x: number, y: number, w: number, h: number) {
            root.style.left = `${x}px`;
            root.style.top = `${y}px`;
            root.style.width = `${w}px`;
            root.style.height = `${h}px`;
            // adapt internal layout to panel shape:
            //   wide  (w >= 360): row layout — list left, hist right (bottom mode)
            //   narrow (w <  360): column layout — list top, hist bottom (left mode)
            root.classList.toggle('wide', w >= 360);
            root.classList.toggle('narrow', w <  360);
        },
        setActive,
        recompute: recomputeAll
    };
}
