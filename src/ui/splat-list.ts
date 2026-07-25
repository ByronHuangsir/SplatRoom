import { Container, Label, Element as PcuiElement, TextInput } from '@playcanvas/pcui';

import { SplatRenameOp } from '../edit-ops';
import { Element, ElementType } from '../element';
import { Events } from '../events';
import { Splat } from '../splat';
import deleteSvg from './svg/delete.svg';
import chainSvg from './svg/chain.svg';
import ghostSvg from './svg/ghost.svg';
import hiddenSvg from './svg/hidden.svg';
import shownSvg from './svg/shown.svg';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

class SplatItem extends Container {
    getName: () => string;
    setName: (value: string) => void;
    getSelected: () => boolean;
    setSelected: (value: boolean) => void;
    getVisible: () => boolean;
    setVisible: (value: boolean) => void;
    getShowDeleted: () => boolean;
    setShowDeleted: (value: boolean) => void;
    destroy: () => void;

    constructor(name: string, edit: TextInput, events: Events, splat: Splat, args = {}) {
        args = {
            ...args,
            class: ['splat-item', 'visible']
        };

        super(args);

        const text = new Label({
            class: 'splat-item-text',
            text: name
        });

        const chainIcon = new PcuiElement({
            dom: createSvg(chainSvg),
            class: 'splat-item-chain'
        });

        const visible = new PcuiElement({
            dom: createSvg(shownSvg),
            class: 'splat-item-visible'
        });

        const invisible = new PcuiElement({
            dom: createSvg(hiddenSvg),
            class: 'splat-item-visible',
            hidden: true
        });

        const remove = new PcuiElement({
            dom: createSvg(deleteSvg),
            class: 'splat-item-delete'
        });

        const ghost = new PcuiElement({
            dom: createSvg(ghostSvg),
            class: 'splat-item-ghost'
        });

        this.append(text);
        this.append(chainIcon);
        this.append(visible);
        this.append(invisible);
        this.append(ghost);
        this.append(remove);

        this.getName = () => {
            return text.value;
        };

        this.setName = (value: string) => {
            text.value = value;
        };

        this.getSelected = () => {
            return this.class.contains('selected');
        };

        this.setSelected = (value: boolean) => {
            if (value !== this.selected) {
                if (value) {
                    this.class.add('selected');
                    this.emit('select', this);
                } else {
                    this.class.remove('selected');
                    this.emit('unselect', this);
                }
            }
        };

        this.getVisible = () => {
            return this.class.contains('visible');
        };

        this.setVisible = (value: boolean) => {
            if (value !== this.visible) {
                visible.hidden = !value;
                invisible.hidden = value;
                if (value) {
                    this.class.add('visible');
                    this.emit('visible', this);
                } else {
                    this.class.remove('visible');
                    this.emit('invisible', this);
                }
            }
        };

        this.getShowDeleted = () => {
            return this.class.contains('show-deleted');
        };

        this.setShowDeleted = (value: boolean) => {
            if (value !== this.showDeleted) {
                if (value) {
                    this.class.add('show-deleted');
                    this.emit('showDeleted', this);
                } else {
                    this.class.remove('show-deleted');
                    this.emit('hideDeleted', this);
                }
            }
        };

        const toggleVisible = (event: MouseEvent) => {
            event.stopPropagation();
            this.visible = !this.visible;
        };

        const toggleShowDeleted = (event: MouseEvent) => {
            event.stopPropagation();
            this.showDeleted = !this.showDeleted;
        };

        const handleRemove = (event: MouseEvent) => {
            event.stopPropagation();
            this.emit('removeClicked', this);
        };

        // rename on double click
        text.dom.addEventListener('dblclick', (event: MouseEvent) => {
            event.stopPropagation();

            const onblur = () => {
                this.remove(edit);
                this.emit('rename', edit.value);
                edit.input.removeEventListener('blur', onblur);
                text.hidden = false;
            };

            text.hidden = true;

            this.appendAfter(edit, text);
            edit.value = text.value;
            edit.input.addEventListener('blur', onblur);
            edit.focus();
        });

        // handle clicks
        visible.dom.addEventListener('click', toggleVisible);
        invisible.dom.addEventListener('click', toggleVisible);
        ghost.dom.addEventListener('click', toggleShowDeleted);
        remove.dom.addEventListener('click', handleRemove);

        // handle clicks on the splat item itself (not on buttons)
        // Use capture phase (true) to run BEFORE PCUI's built-in _onClick handler.
        // This ensures we can read ctrlKey from the native event and directly
        // call the events bus without going through PCUI's event chain.
        const clickHandler = (event: MouseEvent) => {
            // Ignore clicks on action buttons (visible, ghost, delete)
            const target = event.target as HTMLElement;
            if (target.closest('.splat-item-visible') ||
                target.closest('.splat-item-ghost') ||
                target.closest('.splat-item-delete')) {
                return;
            }
            // In solo mode the clicked item might be hidden — make it visible first
            if (!splat.visible) {
                splat.visible = true;
            }
            if (event.ctrlKey || event.metaKey) {
                events.fire('selection.toggle', splat);
            } else {
                events.fire('selection.set', splat);
            }
        };
        this.dom.addEventListener('click', clickHandler, true);

        this.destroy = () => {
            this.dom.removeEventListener('click', clickHandler, true);
            visible.dom.removeEventListener('click', toggleVisible);
            invisible.dom.removeEventListener('click', toggleVisible);
            ghost.dom.removeEventListener('click', toggleShowDeleted);
            remove.dom.removeEventListener('click', handleRemove);
        };
    }

    set name(value: string) {
        this.setName(value);
    }

    get name() {
        return this.getName();
    }

    set selected(value) {
        this.setSelected(value);
    }

    get selected() {
        return this.getSelected();
    }

    set visible(value) {
        this.setVisible(value);
    }

    get visible() {
        return this.getVisible();
    }

    set showDeleted(value) {
        this.setShowDeleted(value);
    }

    get showDeleted() {
        return this.getShowDeleted();
    }
}

class SplatList extends Container {
    constructor(events: Events, args = {}) {
        args = {
            ...args,
            class: 'splat-list'
        };

        super(args);

        const items = new Map<Splat, SplatItem>();
        let soloMode = false;
        const savedVisibility = new Map<Splat, boolean>();

        // edit input used during renames
        const edit = new TextInput({
            id: 'splat-edit'
        });

        events.on('scene.elementAdded', (element: Element) => {
            if (element.type === ElementType.splat) {
                const splat = element as Splat;
                const item = new SplatItem(splat.name, edit, events, splat);
                this.append(item);
                items.set(splat, item);

                if (soloMode) {
                    savedVisibility.set(splat, splat.visible);
                    splat.visible = false;
                }

                item.on('visible', () => {
                    splat.visible = true;

                    // also select it if there is no other selection
                    if (!events.invoke('selection')) {
                        events.fire('selection', splat);
                    }
                });
                item.on('invisible', () => {
                    splat.visible = false;
                });
                item.on('showDeleted', () => {
                    splat.showDeleted = true;
                });
                item.on('hideDeleted', () => {
                    splat.showDeleted = false;
                });
                item.on('rename', (value: string) => {
                    events.fire('edit.add', new SplatRenameOp(splat, value));
                });
            }
        });

        events.on('scene.elementRemoved', (element: Element) => {
            if (element.type === ElementType.splat) {
                const splat = element as Splat;
                const item = items.get(splat);
                if (item) {
                    this.remove(item);
                    items.delete(splat);
                }
                savedVisibility.delete(splat);
            }
        });

        events.on('selection.changedMulti', (current: Splat[]) => {
            const currentSet = new Set(current);
            items.forEach((value, key) => {
                value.selected = currentSet.has(key);
            });

            if (soloMode) {
                // hide all, then show only selected
                items.forEach((item, splat) => {
                    if (!currentSet.has(splat)) {
                        splat.visible = false;
                    } else {
                        splat.visible = true;
                    }
                });
            }
        });

        events.on('scene.solo', (value: boolean) => {
            soloMode = value;
            const selection = events.invoke('selection.all') as Splat[];
            const selectionSet = new Set(selection);

            if (soloMode) {
                items.forEach((item, splat) => {
                    savedVisibility.set(splat, splat.visible);
                    splat.visible = selectionSet.has(splat);
                });
            } else {
                items.forEach((item, splat) => {
                    const wasVisible = savedVisibility.get(splat);
                    splat.visible = wasVisible !== undefined ? wasVisible : true;
                });
                savedVisibility.clear();
            }
        });

        events.on('splat.name', (splat: Splat) => {
            const item = items.get(splat);
            if (item) {
                item.name = splat.name;
            }
        });

        events.on('splat.visibility', (splat: Splat) => {
            const item = items.get(splat);
            if (item) {
                item.visible = splat.visible;
            }
        });

        events.on('splat.showDeleted', (splat: Splat) => {
            const item = items.get(splat);
            if (item) {
                item.showDeleted = splat.showDeleted;
            }
        });

        // update group visual indicator
        const updateGroupedClass = (splat: Splat, grouped: boolean) => {
            const item = items.get(splat);
            if (item) {
                if (grouped) {
                    item.class.add('grouped');
                } else {
                    item.class.remove('grouped');
                }
            }
        };

        events.on('group.created', (group: any) => {
            for (const splat of group.splats) {
                updateGroupedClass(splat, true);
            }
        });

        events.on('group.removed', (group: any) => {
            for (const splat of group.splats) {
                updateGroupedClass(splat, false);
            }
        });

        this.on('removeClicked', async (item: SplatItem) => {
            let splat;
            for (const [key, value] of items) {
                if (item === value) {
                    splat = key;
                    break;
                }
            }

            if (!splat) {
                return;
            }

            const result = await events.invoke('showPopup', {
                type: 'yesno',
                header: 'Remove Splat',
                message: `Are you sure you want to remove '${splat.name}' from the scene? This operation can not be undone.`
            });

            if (result?.action === 'yes') {
                splat.destroy();
            }
        });
    }

    protected _onAppendChild(element: PcuiElement): void {
        super._onAppendChild(element);

        if (element instanceof SplatItem) {
            element.on('removeClicked', () => {
                this.emit('removeClicked', element);
            });
        }
    }

    protected _onRemoveChild(element: PcuiElement): void {
        if (element instanceof SplatItem) {
            element.unbind('removeClicked');
        }

        super._onRemoveChild(element);
    }
}

export { SplatList, SplatItem };
