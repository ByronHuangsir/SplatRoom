import { platform } from 'playcanvas';

import { Events } from './events';
import { Shortcuts, ShortcutBinding } from './shortcuts';

// Mac uses different symbols for modifier keys
const isMac = platform.name === 'osx';

// Default shortcut bindings - the source of truth for key mappings
const defaultShortcuts: Record<string, ShortcutBinding> = {
    // Navigation
    'camera.reset': { keys: ['f'], shift: 'required' },
    'camera.focus': { keys: ['f'] },
    'camera.toggleControlMode': { keys: ['v'] },

    // Show
    'camera.toggleOverlay': { keys: ['Tab'] },
    'camera.toggleMode': { keys: ['m'] },
    'grid.toggleVisible': { keys: ['g'] },
    'camera.toggleShowInfo': { keys: ['i'] },
    'select.hide': { keys: ['h'] },
    'select.unhide': { keys: ['h'], shift: 'required' },

    // Playback
    'timeline.togglePlay': { keys: [' '] },
    'timeline.prevFrame': { keys: [','], repeat: true },
    'timeline.nextFrame': { keys: ['.'], repeat: true },
    'timeline.prevKey': { keys: ['<'], shift: 'optional', repeat: true },
    'timeline.nextKey': { keys: ['>'], shift: 'optional', repeat: true },
    'track.addKey': { keys: ['Enter'] },
    'track.removeKey': { keys: ['Enter'], shift: 'required' },

    // Selection
    'select.all': { keys: ['a'], ctrl: 'required', capture: true },
    'select.none': { keys: ['a'], ctrl: 'required', shift: 'required', capture: true },
    'select.invert': { keys: ['i'], ctrl: 'required' },
    'select.delete': { keys: ['Delete', 'Backspace'] },

    // Clipboard
    'edit.copy': { keys: ['c'], ctrl: 'required', capture: true },
    'edit.cut': { keys: ['x'], ctrl: 'required', capture: true },
    'edit.paste': { keys: ['v'], ctrl: 'required', capture: true },

    // Tools
    // 1/2/3 don't fire tool.move/rotate/scale directly: while a shape
    // selection tool (box/sphere) is active they switch its gizmo mode
    // instead of switching tools (see ToolManager)
    'tool.moveShortcut': { keys: ['1'] },
    'tool.rotateShortcut': { keys: ['2'] },
    'tool.scaleShortcut': { keys: ['3'] },
    'tool.rectSelection': { keys: ['r'] },
    'tool.lassoSelection': { keys: ['l'] },
    'tool.polygonSelection': { keys: ['p'] },
    'tool.brushSelection': { keys: ['b'] },
    'tool.floodSelection': { keys: ['o'] },
    'tool.eyedropperSelection': { keys: ['e'], ctrl: 'required', capture: true },
    'tool.brushSelection.smaller': { keys: ['['], repeat: true },
    'tool.brushSelection.bigger': { keys: [']'], repeat: true },
    'tool.sphereBrushSelection': { keys: ['b'], shift: 'required' },
    'tool.deactivate': { keys: ['Escape'] },
    'tool.toggleCoordSpace': { keys: ['c'], shift: 'required' },

    // Other
    'edit.undo': { keys: ['z'], ctrl: 'required', repeat: true, capture: true },
    'edit.redo': { keys: ['z'], ctrl: 'required', shift: 'required', repeat: true, capture: true },
    'dataPanel.toggle': { keys: ['d'], ctrl: 'required', capture: true },
    'timelinePanel.toggle': { keys: ['t'], ctrl: 'required', capture: true },

    // Camera fly keys - use physical positions (codes) for WASD layout on non-QWERTY keyboards
    'camera.fly.forward': { codes: ['KeyW'], held: true, shift: 'optional', alt: 'optional' },
    'camera.fly.backward': { codes: ['KeyS'], held: true, shift: 'optional', alt: 'optional' },
    'camera.fly.left': { codes: ['KeyA'], held: true, shift: 'optional', alt: 'optional' },
    'camera.fly.right': { codes: ['KeyD'], held: true, shift: 'optional', alt: 'optional' },
    'camera.fly.down': { codes: ['KeyQ'], held: true, shift: 'optional', alt: 'optional' },
    'camera.fly.up': { codes: ['KeyE'], held: true, shift: 'optional', alt: 'optional' },
    'camera.modifier.fast': { codes: ['ShiftLeft', 'ShiftRight'], held: true, alt: 'optional' },
    'camera.modifier.slow': { codes: ['AltLeft', 'AltRight'], held: true, shift: 'optional' },

    // Camera preset views (NumPad) — viewFront/viewBack removed (Numpad5/Numpad2
    // reassigned to reset and pitch-decrease respectively)
    'camera.viewLeft': { codes: ['Numpad1'] },
    'camera.viewRight': { codes: ['Numpad3'] },
    'camera.viewTop': { codes: ['Numpad7'] },
    'camera.viewBottom': { codes: ['Numpad0'] },

    // Camera axis step adjustments (NumPad)
    'camera.headingDecrease': { codes: ['Numpad4'] },
    'camera.headingIncrease': { codes: ['Numpad6'] },
    'camera.pitchDecrease': { codes: ['Numpad2'] },
    'camera.pitchIncrease': { codes: ['Numpad8'] },

    // Reset camera via NumPad 5
    'camera.resetNumpad': { codes: ['Numpad5'] }
};

const STORAGE_KEY = 'splatroom.shortcutBindings';

class ShortcutManager {
    private bindings: Record<string, ShortcutBinding>;
    private shortcutsInst: Shortcuts | null = null;

    constructor(events: Events) {
        // Clone the defaults so they can be modified without affecting the originals
        this.bindings = {};
        for (const id in defaultShortcuts) {
            this.bindings[id] = { ...defaultShortcuts[id] };
        }

        // Restore user-customized bindings (persisted by the 自定义操控 panel)
        this.loadCustom();

        // Create shortcuts and register all bindings
        const shortcuts = new Shortcuts(events);
        this.shortcutsInst = shortcuts;
        for (const id in this.bindings) {
            const binding = this.bindings[id];
            shortcuts.register({
                event: id,
                keys: binding.keys,
                codes: binding.codes,
                ctrl: binding.ctrl,
                shift: binding.shift,
                alt: binding.alt,
                held: binding.held,
                repeat: binding.repeat,
                capture: binding.capture
            });
        }
    }

    /**
     * Get a shortcut binding by its event ID.
     */
    get(id: string): ShortcutBinding | undefined {
        return this.bindings[id];
    }

    /** All bindings (for the customization panel). */
    getAll(): Record<string, ShortcutBinding> {
        return this.bindings;
    }

    /**
     * Rebind a shortcut to new keys/codes (used by the 自定义操控 panel).
     * Updates both the binding table AND the live Shortcuts handler (the
     * registered entry is mutated in place, so no re-registration needed).
     */
    rebind(id: string, binding: ShortcutBinding): void {
        if (!this.bindings[id]) return;
        const next = { ...this.bindings[id], ...binding };
        this.bindings[id] = next;

        // live update: find the registered entry by event id and mutate it
        if (this.shortcutsInst) {
            const entry = this.shortcutsInst.shortcuts.find(s => s.event === id);
            if (entry) {
                entry.keys = next.keys;
                entry.codes = next.codes;
                entry.ctrl = next.ctrl;
                entry.shift = next.shift;
                entry.alt = next.alt;
                entry.held = next.held;
                entry.repeat = next.repeat;
                entry.capture = next.capture;
            }
        }

        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.bindings));
    }

    /** Reset ALL bindings back to defaults (persisted immediately). */
    resetAll(): void {
        this.bindings = {};
        for (const id in defaultShortcuts) {
            this.bindings[id] = { ...defaultShortcuts[id] };
        }
        localStorage.removeItem(STORAGE_KEY);
        // live-update every registered entry back to defaults
        if (this.shortcutsInst) {
            for (const entry of this.shortcutsInst.shortcuts) {
                const def = entry.event ? this.bindings[entry.event] : undefined;
                if (!def || !entry.event) continue;
                entry.keys = def.keys;
                entry.codes = def.codes;
                entry.ctrl = def.ctrl;
                entry.shift = def.shift;
                entry.alt = def.alt;
                entry.held = def.held;
                entry.repeat = def.repeat;
                entry.capture = def.capture;
            }
        }
    }

    private loadCustom(): void {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw) as Record<string, ShortcutBinding>;
            for (const id in parsed) {
                if (this.bindings[id]) {
                    this.bindings[id] = { ...this.bindings[id], ...parsed[id] };
                }
            }
        } catch { /* corrupted storage → keep defaults */ }
    }

    /**
     * Format a shortcut for display (e.g., "Ctrl + Shift + Z" or "⌘⇧Z" on Mac).
     */
    formatShortcut(id: string): string {
        const binding = this.bindings[id];
        if (!binding) return '';

        const parts: string[] = [];

        // Use Mac symbols: ⌘ (Cmd), ⌥ (Option), ⇧ (Shift)
        if (binding.ctrl === 'required') parts.push(isMac ? '⌘' : 'Ctrl');
        if (binding.alt === 'required') parts.push(isMac ? '⌥' : 'Alt');
        if (binding.shift === 'required') parts.push(isMac ? '⇧' : 'Shift');

        // Get the first key or code for display
        let keyDisplay = binding.keys?.[0] ?? binding.codes?.[0];
        if (!keyDisplay) return '';

        if (keyDisplay === ' ') {
            keyDisplay = 'Space';
        } else if (keyDisplay === 'Escape') {
            keyDisplay = 'Esc';
        } else if (keyDisplay.startsWith('Key')) {
            // Physical key codes like 'KeyW' -> 'W'
            keyDisplay = keyDisplay.slice(3);
        } else if (keyDisplay.length === 1) {
            keyDisplay = keyDisplay.toUpperCase();
        }

        parts.push(keyDisplay);

        return isMac ? parts.join(' ') : parts.join(' + ');
    }
}

export { ShortcutManager };
