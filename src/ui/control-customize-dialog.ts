import { Button, Container, Label, SelectInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { DEFAULT_MOUSE_BINDINGS, MOUSE_ACTIONS, MouseAction, MouseBindingsState } from '../mouse-bindings';
import { ShortcutBinding } from '../shortcuts';
import { i18n } from './localization';

/**
 * 自定义操控 (Customize Controls) dialog — reachable from 工具 → 自定义操控.
 *
 * Lets the user customize:
 *   1. Mouse drag actions: what left / middle / right button dragging does
 *      (orbit / pan / look / zoom). Persisted via the MouseBindings module.
 *   2. Keyboard shortcuts: view the current bindings, click one to re-bind it
 *      (press the new key combination), or reset everything to defaults.
 *      Persisted via ShortcutManager.rebind().
 */
class ControlCustomizeDialog extends Container {
    show: () => void;
    hide: () => void;
    destroy: () => void;

    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'control-customize-dialog',
            class: 'settings-dialog',
            hidden: true,
            tabIndex: -1
        };

        super(args);

        const dialog = new Container({ id: 'dialog', class: 'control-customize-dialog-body' });

        // ---- header ----
        const headerText = new Label({ id: 'text' });
        i18n.bindText(headerText, () => i18n.t('dialog.control-customize.header').toUpperCase());
        const header = new Container({ id: 'header' });
        header.append(headerText);
        dialog.append(header);

        // ---- floating panel: drag by the header to move the dialog ----
        // The dialog is position:fixed; we only touch inline left/top when the
        // user drags (clearing the centering transform once dragged).
        let dragActive = false;
        let dragOffsetX = 0, dragOffsetY = 0;
        const dragMove = (e: PointerEvent) => {
            if (!dragActive) return;
            const el = dialog.dom;
            el.style.transform = 'none';
            el.style.left = (e.clientX - dragOffsetX) + 'px';
            el.style.top = (e.clientY - dragOffsetY) + 'px';
        };
        const dragEnd = () => {
            dragActive = false;
            header.class.remove('cc-dragging');
        };
        header.dom.addEventListener('pointerdown', (e: PointerEvent) => {
            // only start a drag from the header itself (not its children that
            // are interactive — there are none in the header, but be safe)
            dragActive = true;
            header.class.add('cc-dragging');
            const rect = dialog.dom.getBoundingClientRect();
            dragOffsetX = e.clientX - rect.left;
            dragOffsetY = e.clientY - rect.top;
            header.dom.setPointerCapture(e.pointerId);
            e.preventDefault();
        });
        header.dom.addEventListener('pointermove', dragMove);
        header.dom.addEventListener('pointerup', dragEnd);
        header.dom.addEventListener('pointercancel', dragEnd);

        // ---- body: two-pane layout (mouse | divider | shortcuts) ----
        const body = new Container({ class: 'cc-body' });

        // === Left pane: mouse drag actions ===
        const mousePane = new Container({ class: ['cc-pane', 'cc-pane-mouse'] });

        const mouseHeader = new Label({ class: 'section-label' });
        i18n.bindText(mouseHeader, 'dialog.control-customize.mouse-section');
        mousePane.append(mouseHeader);

        const buttonDefs = [
            { id: 'left', labelKey: 'dialog.control-customize.left', titleKey: 'dialog.control-customize.left-tip' },
            { id: 'middle', labelKey: 'dialog.control-customize.middle', titleKey: 'dialog.control-customize.middle-tip' },
            { id: 'right', labelKey: 'dialog.control-customize.right', titleKey: 'dialog.control-customize.right-tip' }
        ] as const;

        const selectRow: Record<string, { row: Container, select: SelectInput }> = {};
        for (const def of buttonDefs) {
            const row = new Container({ class: 'row' });
            const label = new Label({ class: 'label' });
            i18n.bindText(label, def.labelKey);
            const select = new SelectInput({
                class: 'select',
                defaultValue: DEFAULT_MOUSE_BINDINGS[def.id]
            });
            i18n.bindOptions(select, () => MOUSE_ACTIONS.map(a => ({
                v: a,
                t: i18n.t(`dialog.control-customize.action.${a}`)
            })));
            row.append(label);
            row.append(select);
            mousePane.append(row);
            selectRow[def.id] = { row, select };
        }

        // reset mouse bindings to defaults
        const resetMouseBtn = new Button({ class: 'button' });
        i18n.bindText(resetMouseBtn, 'dialog.control-customize.reset-mouse');
        mousePane.append(resetMouseBtn);
        mousePane.append(new Container({ class: 'cc-fill' }));   // vertical spacer
        body.append(mousePane);

        // === vertical divider (the requested horizontal-line separator) ===
        body.append(new Container({ class: 'cc-divider-vertical' }));

        // === Right pane: keyboard shortcuts ===
        const kbPane = new Container({ class: ['cc-pane', 'cc-pane-kb'] });

        const kbHeader = new Label({ class: 'section-label' });
        i18n.bindText(kbHeader, 'dialog.control-customize.kb-section');
        kbPane.append(kbHeader);

        const hint = new Label({ class: 'kb-hint' });
        i18n.bindText(hint, 'dialog.control-customize.kb-hint');
        kbPane.append(hint);

        // Which shortcut ids the panel exposes for customization.
        const editableIds = [
            'camera.reset', 'camera.focus', 'camera.toggleControlMode',
            'camera.toggleOverlay', 'camera.toggleMode', 'grid.toggleVisible',
            'camera.toggleShowInfo', 'select.hide', 'select.unhide',
            'timeline.togglePlay', 'timeline.prevFrame', 'timeline.nextFrame',
            'track.addKey', 'track.removeKey', 'select.all', 'select.none',
            'select.invert', 'select.delete', 'edit.copy', 'edit.cut', 'edit.paste',
            'tool.moveShortcut', 'tool.rotateShortcut', 'tool.scaleShortcut',
            'tool.rectSelection', 'tool.lassoSelection', 'tool.polygonSelection',
            'tool.brushSelection', 'tool.deactivate', 'tool.toggleCoordSpace',
            'edit.undo', 'edit.redo', 'dataPanel.toggle', 'timelinePanel.toggle'
        ];

        const shortcutRows: { id: string, btn: Button }[] = [];
        let capturingId: string | null = null;
        const captureHandler = (e: KeyboardEvent) => {
            // ignore pure modifier presses
            if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
            if (capturingId) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                const binding: ShortcutBinding = {
                    keys: [e.key],
                    ctrl: (e.ctrlKey || e.metaKey) ? 'required' : 'forbidden',
                    shift: e.shiftKey ? 'required' : 'forbidden',
                    alt: e.altKey ? 'required' : 'forbidden'
                };
                (events.invoke('shortcutManager') as any)?.rebind(capturingId, binding);
                capturingId = null;
                refreshShortcutRows();
            }
        };

        const refreshShortcutRows = () => {
            const sm = events.invoke('shortcutManager') as any;
            for (const { id, btn } of shortcutRows) {
                btn.text = capturingId === id
                    ? i18n.t('dialog.control-customize.capturing')
                    : (sm?.formatShortcut(id) || '');
                btn.class[capturingId === id ? 'add' : 'remove']('capturing');
            }
        };

        // build the shortcut list (scrollable)
        const kbList = new Container({ class: 'kb-list' });
        for (const id of editableIds) {
            const row = new Container({ class: 'kb-row' });
            const actionLabel = new Label({ class: 'kb-action' });
            i18n.bindText(actionLabel, `dialog.control-customize.shortcut.${id}`);
            const btn = new Button({ class: 'kb-key' });
            btn.on('click', () => {
                if (capturingId === id) {
                    capturingId = null;
                } else {
                    capturingId = id;
                }
                refreshShortcutRows();
                if (capturingId) {
                    window.addEventListener('keydown', captureHandler, true);
                } else {
                    window.removeEventListener('keydown', captureHandler, true);
                }
            });
            row.append(actionLabel);
            row.append(btn);
            kbList.append(row);
            shortcutRows.push({ id, btn });
        }
        kbPane.append(kbList);

        // reset keyboard bindings
        const resetKbBtn = new Button({ class: 'button' });
        i18n.bindText(resetKbBtn, 'dialog.control-customize.reset-kb');
        kbPane.append(resetKbBtn);

        body.append(kbPane);
        dialog.append(body);

        // ---- footer (close button) ----
        const footer = new Container({ class: 'footer' });
        const closeBtn = new Button({ class: 'close-button' });
        i18n.bindText(closeBtn, 'dialog.control-customize.close');
        footer.append(closeBtn);
        dialog.append(footer);

        this.append(dialog);

        // ---- events ----
        const syncMouseSelects = () => {
            const bindings = (events.invoke('mouseBindings.get') as MouseBindingsState) ?? DEFAULT_MOUSE_BINDINGS;
            for (const id of ['left', 'middle', 'right'] as const) {
                selectRow[id].select.value = bindings[id];
            }
        };
        events.on('mouseBindings.changed', () => {
            if (!this.hidden) syncMouseSelects();
        });
        for (const id of ['left', 'middle', 'right'] as const) {
            selectRow[id].select.on('change', (v: string) => {
                const cur = (events.invoke('mouseBindings.get') as MouseBindingsState) ?? DEFAULT_MOUSE_BINDINGS;
                const next: MouseBindingsState = { ...cur, [id]: v as MouseAction };
                events.fire('mouseBindings.set', next);
            });
        }
        resetMouseBtn.on('click', () => {
            events.fire('mouseBindings.reset');
        });
        resetKbBtn.on('click', () => {
            (events.invoke('shortcutManager') as any)?.resetAll();
            refreshShortcutRows();
        });

        // Escape closes the dialog (unless a re-bind capture is in progress)
        const keydown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !capturingId) {
                e.preventDefault();
                this.hide();
            }
        };
        this.show = () => {
            syncMouseSelects();
            refreshShortcutRows();
            this.hidden = false;
            this.dom.focus();
            document.addEventListener('keydown', keydown);
        };

        this.hide = () => {
            if (capturingId) {
                capturingId = null;
                window.removeEventListener('keydown', captureHandler, true);
            }
            document.removeEventListener('keydown', keydown);
            this.hidden = true;
        };

        closeBtn.on('click', () => this.hide());

        // Escape closes the dialog (unless a re-bind capture is in progress).

        this.destroy = () => {
            document.removeEventListener('keydown', keydown);
            window.removeEventListener('keydown', captureHandler, true);
        };
    }
}

export { ControlCustomizeDialog };
