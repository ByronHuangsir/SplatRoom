/**
 * Viewport layout math for the comparison tool.
 *
 * PlayCanvas camera rects are normalized *with the origin at the bottom-left*
 * (y grows upward). To keep the model order intuitive for a user (model 0 on
 * the left / on top), `computeRects` returns rects in that native space.
 *
 * A "rect" is `{ x, y, w, h }` in [0,1] normalized screen coordinates.
 */

export type CompareLayoutMode = 'horizontal';

export interface ViewportRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/**
 * @param count number of viewports (clamped 1..4)
 * @param mode  horizontal (left-right) — the only supported layout
 * @returns one normalized rect per viewport, ordered left-to-right by model index.
 */
export function computeRects(count: number, mode: CompareLayoutMode): ViewportRect[] {
    const n = Math.max(1, Math.min(4, Math.floor(count)));
    const inv = 1 / n;
    const rects: ViewportRect[] = [];
    for (let i = 0; i < n; i++) {
        // left to right
        rects.push({ x: i * inv, y: 0, w: inv, h: 1 });
    }
    return rects;
}

/**
 * Human-readable label for a (count, mode) preset — used by the panel buttons.
 */
export function layoutLabel(count: number, _mode: CompareLayoutMode): string {
    const cn = count === 2 ? '双' : count === 3 ? '三' : '四';
    return `左右${cn}屏`;
}
