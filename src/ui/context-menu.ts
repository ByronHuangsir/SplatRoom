import { Container, Element } from '@playcanvas/pcui';

import { Events } from '../events';
import { i18n } from './localization';
import { MenuPanel, MenuItem } from './menu-panel';

import deleteSvg from './svg/delete.svg';
import importSvg from './svg/import.svg';
import measureSvg from './svg/measure.svg';
import orientSvg from './svg/orient.svg';
import selectDuplicateSvg from './svg/select-duplicate.svg';
import brushSvg from './svg/select-brush.svg';
import eyedropperSvg from './svg/select-eyedropper.svg';
import floodSvg from './svg/select-flood.svg';
import lassoSvg from './svg/select-lasso.svg';
import pickerSvg from './svg/select-picker.svg';
import polygonSvg from './svg/select-poly.svg';
import sphereSvg from './svg/select-sphere.svg';
import boxSvg from './svg/show-hide-splats.svg';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new Element({
        dom: new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement
    });
};

class ContextMenu {
    private panel: MenuPanel;
    private wrapper: HTMLDivElement;

    constructor(events: Events, canvasContainer: Container) {
        // ---- submenus ----

        const pasteSubmenu = new MenuPanel([{
            text: () => i18n.t('context.paste'),
            icon: createSvg(importSvg),
            isEnabled: () => events.invoke('clipboard.has'),
            onSelect: () => events.fire('edit.paste')
        }, {
            text: () => i18n.t('context.paste-as-new-scene'),
            icon: createSvg(importSvg),
            isEnabled: () => events.invoke('clipboard.has'),
            onSelect: () => events.fire('edit.pasteAsNewScene')
        }]);

        const selectSubmenu = new MenuPanel([{
            text: () => i18n.t('context.select.rect'),
            icon: createSvg(pickerSvg),
            onSelect: () => events.fire('tool.rectSelection')
        }, {
            text: () => i18n.t('context.select.lasso'),
            icon: createSvg(lassoSvg),
            onSelect: () => events.fire('tool.lassoSelection')
        }, {
            text: () => i18n.t('context.select.polygon'),
            icon: createSvg(polygonSvg),
            onSelect: () => events.fire('tool.polygonSelection')
        }, {
            text: () => i18n.t('context.select.brush'),
            icon: createSvg(brushSvg),
            onSelect: () => events.fire('tool.brushSelection')
        }, {
            text: () => i18n.t('context.select.flood'),
            icon: createSvg(floodSvg),
            onSelect: () => events.fire('tool.floodSelection')
        }, {
            text: () => i18n.t('context.select.eyedropper'),
            icon: createSvg(eyedropperSvg),
            onSelect: () => events.fire('tool.eyedropperSelection')
        }, {
            text: () => i18n.t('context.select.sphere'),
            icon: createSvg(sphereSvg),
            onSelect: () => events.fire('tool.sphereSelection')
        }, {
            text: () => i18n.t('context.select.box'),
            icon: createSvg(boxSvg),
            onSelect: () => events.fire('tool.boxSelection')
        }]);

        const transformSubmenu = new MenuPanel([{
            text: () => i18n.t('context.transform.move'),
            icon: 'E111',
            onSelect: () => events.fire('tool.move')
        }, {
            text: () => i18n.t('context.transform.rotate'),
            icon: 'E113',
            onSelect: () => events.fire('tool.rotate')
        }, {
            text: () => i18n.t('context.transform.scale'),
            icon: 'E112',
            onSelect: () => events.fire('tool.scale')
        }]);

        const viewSubmenu = new MenuPanel([{
            text: () => i18n.t('context.view.front'),
            onSelect: () => events.fire('camera.viewFront')
        }, {
            text: () => i18n.t('context.view.back'),
            onSelect: () => events.fire('camera.viewBack')
        }, {
            text: () => i18n.t('context.view.left'),
            onSelect: () => events.fire('camera.viewLeft')
        }, {
            text: () => i18n.t('context.view.right'),
            onSelect: () => events.fire('camera.viewRight')
        }, {
            text: () => i18n.t('context.view.top'),
            onSelect: () => events.fire('camera.viewTop')
        }, {
            text: () => i18n.t('context.view.bottom'),
            onSelect: () => events.fire('camera.viewBottom')
        }]);

        // ---- main menu items ----

        const items: MenuItem[] = [
            {
                text: () => i18n.t('context.copy'),
                icon: createSvg(selectDuplicateSvg),
                isEnabled: () => events.invoke('selection.splats'),
                onSelect: () => events.fire('edit.copy')
            },
            {
                text: () => i18n.t('context.cut'),
                icon: createSvg(deleteSvg),
                isEnabled: () => events.invoke('selection.splats'),
                onSelect: () => events.fire('edit.cut')
            },
            {
                text: () => i18n.t('context.paste'),
                icon: createSvg(importSvg),
                subMenu: pasteSubmenu
            },
            {}, // separator
            {
                text: () => i18n.t('context.select'),
                subMenu: selectSubmenu
            },
            {
                text: () => i18n.t('context.transform'),
                subMenu: transformSubmenu
            },
            {
                text: () => i18n.t('context.measure'),
                icon: createSvg(measureSvg),
                onSelect: () => events.fire('tool.measure')
            },
            {
                text: () => i18n.t('context.orient'),
                icon: createSvg(orientSvg),
                onSelect: () => events.fire('tool.orient')
            },
            {}, // separator
            {
                text: () => i18n.t('context.restore'),
                icon: createSvg(importSvg),
                isEnabled: () => events.invoke('selection.hasDeletedSelected'),
                onSelect: () => events.fire('edit.undelete')
            },
            {
                text: () => i18n.t('context.view'),
                subMenu: viewSubmenu
            },
            {
                text: () => i18n.t('context.autoRotate'),
                onSelect: () => {
                    const currentMode = events.invoke('camera.getAutoRotateMode');
                    events.fire('camera.setAutoRotateMode', currentMode === 'off' ? 'orbit' : 'off');
                }
            }
        ];

        this.panel = new MenuPanel(items);

        // wrapper div at viewport (0,0) serves as the offset parent for
        // absolute-positioned menu panels and submenus
        this.wrapper = document.createElement('div');
        this.wrapper.style.position = 'fixed';
        this.wrapper.style.top = '0';
        this.wrapper.style.left = '0';
        this.wrapper.style.width = '0';
        this.wrapper.style.height = '0';
        this.wrapper.style.zIndex = '10000';
        this.wrapper.appendChild(this.panel.dom);
        this.wrapper.appendChild(pasteSubmenu.dom);
        this.wrapper.appendChild(selectSubmenu.dom);
        this.wrapper.appendChild(transformSubmenu.dom);
        this.wrapper.appendChild(viewSubmenu.dom);
        document.body.appendChild(this.wrapper);

        // ---- right-button drag tracking (distinguish click vs drag) ----
        // Right-click without drag → show context menu
        // Right-drag → fly look (handled by controllers.ts), suppress menu
        let rmbDown = false;
        let rmbStartX = 0, rmbStartY = 0;
        let rmbDragged = false;
        const DRAG_THRESHOLD = 4;

        canvasContainer.dom.addEventListener('pointerdown', (e: PointerEvent) => {
            if (e.button === 2) {
                rmbDown = true;
                rmbStartX = e.clientX;
                rmbStartY = e.clientY;
                rmbDragged = false;
            }
        });

        canvasContainer.dom.addEventListener('pointermove', (e: PointerEvent) => {
            if (rmbDown && !rmbDragged) {
                const dx = e.clientX - rmbStartX;
                const dy = e.clientY - rmbStartY;
                if (dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) {
                    rmbDragged = true;
                }
            }
        });

        canvasContainer.dom.addEventListener('pointerup', (e: PointerEvent) => {
            if (e.button === 2) {
                rmbDown = false;
            }
        });

        // ---- show on right-click (no drag) over the canvas ----
        canvasContainer.dom.addEventListener('contextmenu', (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            // Don't show context menu if right button was dragged (fly look)
            if (rmbDragged) {
                rmbDragged = false;
                return;
            }
            this.show(e.clientX, e.clientY);
        });

        // ---- close handlers ----

        // close on click outside the menu
        window.addEventListener('pointerdown', (e: PointerEvent) => {
            if (!this.panel.hidden && !this.wrapper.contains(e.target as Node)) {
                this.hide();
            }
        }, true);

        // close on Escape
        window.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !this.panel.hidden) {
                this.hide();
            }
        });

        // close on scroll or resize
        window.addEventListener('scroll', () => this.hide(), true);
        window.addEventListener('resize', () => this.hide());
    }

    private show(x: number, y: number) {
        // reset submenu state
        this.hide();

        // position the main panel at cursor
        this.panel.dom.style.left = `${x}px`;
        this.panel.dom.style.top = `${y}px`;
        this.panel.hidden = false;

        // adjust if the menu overflows the viewport
        requestAnimationFrame(() => {
            if (this.panel.hidden) return;
            const rect = this.panel.dom.getBoundingClientRect();
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            if (rect.right > vw) {
                this.panel.dom.style.left = `${Math.max(0, x - rect.width)}px`;
            }
            if (rect.bottom > vh) {
                this.panel.dom.style.top = `${Math.max(0, y - rect.height)}px`;
            }
        });
    }

    private hide() {
        this.panel.hidden = true;
    }
}

export { ContextMenu };
