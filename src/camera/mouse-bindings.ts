import { Events } from '../events';

/**
 * Mouse drag actions available for customization.
 * These map 1:1 onto the camera functions in controllers.ts:
 *   orbit  → rotate the camera around the focal point (dragging)
 *   pan    → move the camera sideways (pan the view)
 *   look   → fly-mode look: rotate the view in place
 *   zoom   → dolly in/out (vertical drag distance drives zoom amount)
 */
export type MouseAction = 'orbit' | 'pan' | 'look' | 'zoom';

export const MOUSE_ACTIONS: MouseAction[] = ['orbit', 'pan', 'look', 'zoom'];

/**
 * Per-button mapping. `button` here is the PointerEvent.button value:
 *   0 = left, 1 = middle (auxiliary), 2 = right
 */
export interface MouseBindingsState {
    left: MouseAction;
    middle: MouseAction;
    right: MouseAction;
}

export const DEFAULT_MOUSE_BINDINGS: MouseBindingsState = {
    left: 'orbit',
    middle: 'pan',
    right: 'look'
};

const STORAGE_KEY = 'splatroom.mouseBindings';

/**
 * Manages the customizable mouse-button → camera-action mapping.
 * Persisted to localStorage so the user's custom layout survives reloads.
 */
class MouseBindings {
    private state: MouseBindingsState;

    constructor(events: Events) {
        this.state = this.load();

        // notify controllers / UI whenever the mapping changes
        events.function('mouseBindings.get', () => this.state);
        events.on('mouseBindings.set', (next: MouseBindingsState) => {
            this.state = { ...DEFAULT_MOUSE_BINDINGS, ...next };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
            events.fire('mouseBindings.changed', this.state);
        });
        events.on('mouseBindings.reset', () => {
            this.state = { ...DEFAULT_MOUSE_BINDINGS };
            localStorage.removeItem(STORAGE_KEY);
            events.fire('mouseBindings.changed', this.state);
        });
    }

    /** Resolve the action for a PointerEvent.button value (0/1/2). */
    getAction(button: number): MouseAction {
        switch (button) {
            case 0: return this.state.left;
            case 1: return this.state.middle;
            case 2: return this.state.right;
            default: return 'orbit';
        }
    }

    private load(): MouseBindingsState {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                return {
                    left: MOUSE_ACTIONS.includes(parsed?.left) ? parsed.left : DEFAULT_MOUSE_BINDINGS.left,
                    middle: MOUSE_ACTIONS.includes(parsed?.middle) ? parsed.middle : DEFAULT_MOUSE_BINDINGS.middle,
                    right: MOUSE_ACTIONS.includes(parsed?.right) ? parsed.right : DEFAULT_MOUSE_BINDINGS.right
                };
            }
        } catch { /* corrupted storage → defaults */ }
        return { ...DEFAULT_MOUSE_BINDINGS };
    }
}

export { MouseBindings };
