import { NumericInput } from '@playcanvas/pcui';

/**
 * Reliable value dragging for PCUI NumericInput / VectorInput sub-fields.
 *
 * PCUI's built-in numeric slider strip relies on `requestPointerLock()`, which
 * is unreliable in the packaged Electron renderer (pointer lock can be refused
 * or silently lost, leaving the drag dead). This replaces that behaviour with a
 * pointer-capture based drag attached directly to the field's <input>:
 *
 *  - press records the start (does NOT preventDefault, so a plain click still
 *    focuses the field and the user can type a value);
 *  - once the pointer moves past a small threshold the press becomes a drag and
 *    the value is adjusted by movementX (one step per 100 px, matching PCUI);
 *  - pointerup commits; Alt = fine precision (stepPrecision), like PCUI's shift.
 *
 * Call once per input after construction. `onChange` fires while dragging
 * (value updates live); `onDragStart` / `onDragEnd` bracket the drag (used to
 * start/end an undo group on the edited entity).
 */
export const enableReliableInputDrag = (
    input: NumericInput,
    onChange: () => void,
    onDragStart?: () => void,
    onDragEnd?: () => void
): void => {
    const dom = (input as any).dom as HTMLElement;
    const field = dom.querySelector('input') ?? dom;

    // Hover affordance: horizontal-resize cursor signals the box is draggable.
    dom.style.cursor = 'ew-resize';
    field.style.cursor = 'ew-resize';

    const DRAG_THRESHOLD = 3;  // px of movement before a press becomes a drag
    const step = (input as any)._step ?? 1;
    const stepPrecision = (input as any)._stepPrecision ?? step * 0.1;

    let dragging = false;
    let startValue = 0;
    let accumulated = 0;
    let startX = 0;
    let startY = 0;
    let pointerId = -1;

    const onDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        if (!(input as any).enabled) return;
        dragging = false;
        startValue = input.value;
        accumulated = 0;
        startX = e.clientX;
        startY = e.clientY;
        pointerId = e.pointerId;
        field.setPointerCapture(e.pointerId);
        e.stopPropagation();
    };
    const onMove = (e: PointerEvent) => {
        if (pointerId === -1 || e.pointerId !== pointerId) return;
        const dx = Math.abs(e.clientX - startX);
        const dy = Math.abs(e.clientY - startY);
        if (!dragging) {
            if (dx + dy < DRAG_THRESHOLD) return;
            dragging = true;
            onDragStart?.();
            e.preventDefault();
        }
        const s = e.altKey ? stepPrecision : step;
        accumulated += e.movementX / 100 * s;
        input.value = startValue + accumulated;
        onChange();
    };
    const onUp = (e: PointerEvent) => {
        if (pointerId === -1 || e.pointerId !== pointerId) return;
        pointerId = -1;
        const wasDrag = dragging;
        dragging = false;
        if (field.hasPointerCapture?.(e.pointerId)) {
            field.releasePointerCapture(e.pointerId);
        }
        if (wasDrag) {
            onDragEnd?.();
        }
    };
    // Window-level fallback: if pointer capture is lost (context menu, alt-tab,
    // driver hiccup) the field never receives pointerup/pointercancel and the
    // drag state (dragging / onDragStart's undo group) would hang forever —
    // subsequent typed edits would silently miss undo. Reset on any release of
    // the tracked pointer.
    const onWindowUp = (e: PointerEvent) => {
        if (e.pointerId === pointerId) {
            onUp(e);
        }
    };

    field.addEventListener('pointerdown', onDown);
    field.addEventListener('pointermove', onMove);
    field.addEventListener('pointerup', onUp);
    field.addEventListener('pointercancel', onUp);
    window.addEventListener('pointerup', onWindowUp);
    window.addEventListener('pointercancel', onWindowUp);
};

/**
 * Hide PCUI's built-in pointer-lock slider strip on a NumericInput so only our
 * reliable input drag is active. Call before/after construction; hideSlider can
 * be passed directly to NumericInput args (VectorInput does not forward it, so
 * this helper hides the strip on the sub-fields too).
 */
export const hidePcuiSliderStrip = (input: NumericInput): void => {
    const dom = (input as any).dom as HTMLElement;
    const strip = dom.querySelector('.pcui-numeric-input-slider-control') as HTMLElement | null;
    if (strip) {
        strip.style.display = 'none';
    }
};
