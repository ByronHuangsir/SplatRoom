import { Button, Container, Label } from '@playcanvas/pcui';

import { i18n } from './localization';
import { RangeSlider, RangeValue } from './range-slider';
import { Events } from '../core/events';

/**
 * 选择工具的**选区范围**浮条：点开屏幕选择工具时浮出来的一块面板，里面是三个双柄 range
 * （低端标签 …… 高端标签，两个柄之间就是选中的部分）：
 *
 *   深度  最近 [====●------●====] 最远    —— 沿手势当时的视轴，占模型自身深度范围的百分比
 *   左右  左   [====●------●====] 右      —— 占选区框宽度的百分比
 *   上下  上   [====●------●====] 下      —— 占选区框高度的百分比
 *
 * 三个轴的默认值都是整段（0 / 100），也就是"完整穿透整个模型"；拖动任何一个柄都会**实时重切**当前
 * 选区（同一个历史条目）。「重置」把三轴一起还原。
 *
 * 对齐线上编辑器（data.good360vr.com/editor，SUPERSPLAT v2 那套）的"选区深度 + 最近/最远"，
 * 只是把单轴扩成三轴：一个轴只能切板层，三个轴才能把穿透空间收成想要的盒子。
 *
 * 只挂在会用到它的工具上（矩形/套索/多边形/2D 笔刷/快速填充）；球体、盒体是三维体选择，
 * 球刷有自己的"厚度"（贴着表面往里的板层），都不需要再来一套视线范围。
 */
const TOOLS_WITH_RANGE = ['rectSelection', 'lassoSelection', 'polygonSelection', 'brushSelection', 'floodSelection'];

class SelectionDepthBar {
    constructor(events: Events, parent: HTMLElement) {
        const bar = new Container({
            class: ['select-toolbar', 'select-toolbar-stacked'],
            id: 'selection-range-bar',
            hidden: true
        });

        // the toolbar itself must not let clicks fall through to the tools underneath
        bar.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
        });

        const title = new Label({ class: 'select-toolbar-label', text: '' });
        i18n.bindText(title, 'select-toolbar.selectionRange');

        // guards the echo back into the widgets: PCUI's controls fire 'change' when written
        // programmatically, so without this a clamped value would be written back
        let syncing = false;

        const depth = new RangeSlider({
            axis: 'depth',
            lowKey: 'select-toolbar.depthNear',
            highKey: 'select-toolbar.depthFar',
            value: { low: 0, high: 100 },
            onChange: (value: RangeValue) => {
                if (!syncing) {
                    events.fire('selection.setDepthRange', value);
                }
            }
        });

        const horizontal = new RangeSlider({
            axis: 'x',
            lowKey: 'select-toolbar.rangeLeft',
            highKey: 'select-toolbar.rangeRight',
            value: { low: 0, high: 100 },
            onChange: (value: RangeValue) => {
                if (!syncing) {
                    events.fire('selection.setScreenRange', { x: value });
                }
            }
        });

        const vertical = new RangeSlider({
            axis: 'y',
            lowKey: 'select-toolbar.rangeTop',
            highKey: 'select-toolbar.rangeBottom',
            value: { low: 0, high: 100 },
            onChange: (value: RangeValue) => {
                if (!syncing) {
                    events.fire('selection.setScreenRange', { y: value });
                }
            }
        });

        const reset = new Button({ class: 'select-toolbar-button', text: '' });
        i18n.bindText(reset, 'select-toolbar.depthReset');

        const resetRow = new Container({ class: 'select-range-reset-row' });
        resetRow.append(reset);

        bar.append(title);
        bar.dom.appendChild(depth.row);
        bar.dom.appendChild(horizontal.row);
        bar.dom.appendChild(vertical.row);
        bar.append(resetRow);
        parent.appendChild(bar.dom);

        const sync = () => {
            const { near, far } = events.invoke('selection.depthRange') as { near: number, far: number };
            const screen = events.invoke('selection.screenRange') as {
                x: RangeValue,
                y: RangeValue
            };

            syncing = true;
            depth.value = { low: near, high: far };
            horizontal.value = screen.x;
            vertical.value = screen.y;
            syncing = false;

            // the title lights up while the selection is not the full through-pass
            const narrowed = near > 0 || far < 100 ||
                screen.x.low > 0 || screen.x.high < 100 ||
                screen.y.low > 0 || screen.y.high < 100;
            title.class[narrowed ? 'add' : 'remove']('active');
        };

        reset.on('click', () => {
            events.fire('selection.resetRange');
        });

        events.on('selection.depthRange', () => sync());
        events.on('selection.screenRange', () => sync());

        // the bar follows the active tool
        events.on('tool.activated', (name: string) => {
            const visible = TOOLS_WITH_RANGE.includes(name);
            bar.hidden = !visible;
            if (visible) {
                sync();
            }
        });
        events.on('tool.deactivated', () => {
            bar.hidden = true;
        });

        sync();
    }
}

export { SelectionDepthBar };
