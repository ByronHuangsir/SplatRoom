import { Button, Container, Label, SliderInput } from '@playcanvas/pcui';

import { i18n } from './localization';
import { Events } from '../core/events';

/**
 * 选择工具的**深度条**：点开屏幕选择工具时浮出来的小工具栏，里面是"选区深度"的
 * 最近 / 最远 两个滑块（外加一个重置）。
 *
 * 对齐线上编辑器（data.good360vr.com/editor，SUPERSPLAT v2 那套）：选中区域时，默认
 * **穿透整个模型**完整选择，再拖最近 / 最远把这段穿透空间切出想要的板层。所以滑块
 * 一启动就有效 —— 不需要先开什么开关，0 / 100 就是"整段"。
 *
 *   - 最近 / 最远 = `selection.depthRange`（占模型自身深度范围的百分比）；
 *   - 拖动即**实时重切当前选区**（同一个历史条目，不会刷出一堆撤销步）；
 *   - 重置 = 回到 0 / 100（完整穿透）。
 *
 * 只挂在会用到它的工具上（矩形/套索/多边形/2D 笔刷/快速填充）；球体、盒体是三维体选择，
 * 球刷有自己的"厚度"（贴着表面往里的板层），都不需要再来一套视线深度。
 */
const TOOLS_WITH_RANGE = ['rectSelection', 'lassoSelection', 'polygonSelection', 'brushSelection', 'floodSelection'];

class SelectionDepthBar {
    constructor(events: Events, parent: HTMLElement) {
        const bar = new Container({
            class: 'select-toolbar',
            id: 'selection-depth-bar',
            hidden: true
        });

        // the toolbar itself must not let clicks fall through to the tools underneath
        bar.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
        });

        const title = new Label({ class: 'select-toolbar-label', text: '' });
        i18n.bindText(title, 'select-toolbar.selectionDepth');

        const nearLabel = new Label({ class: 'select-toolbar-label', text: '' });
        i18n.bindText(nearLabel, 'select-toolbar.depthNear');

        const near = new SliderInput({
            class: 'select-toolbar-slider',
            min: 0,
            max: 100,
            step: 1,
            precision: 0,
            value: 0
        });

        const farLabel = new Label({ class: 'select-toolbar-label', text: '' });
        i18n.bindText(farLabel, 'select-toolbar.depthFar');

        const far = new SliderInput({
            class: 'select-toolbar-slider',
            min: 0,
            max: 100,
            step: 1,
            precision: 0,
            value: 100
        });

        const reset = new Button({ class: 'select-toolbar-button', text: '' });
        i18n.bindText(reset, 'select-toolbar.depthReset');

        bar.append(title);
        bar.append(new Container({ class: 'select-toolbar-separator' }));
        bar.append(nearLabel);
        bar.append(near);
        bar.append(farLabel);
        bar.append(far);
        bar.append(new Container({ class: 'select-toolbar-separator' }));
        bar.append(reset);
        parent.appendChild(bar.dom);

        // PCUI fires 'change' when a value is set programmatically, so the echo back into
        // the controls has to be guarded (otherwise a clamped value would be written back)
        let updating = false;

        const range = () => (events.invoke('selection.depthRange') as { near: number, far: number }) ?? { near: 0, far: 100 };

        const sync = () => {
            const { near: nearValue, far: farValue } = range();
            updating = true;
            near.value = nearValue;
            far.value = farValue;
            updating = false;
            // the title lights up while the selection is not the full through-pass
            const narrowed = nearValue > 0 || farValue < 100;
            title.class[narrowed ? 'add' : 'remove']('active');
        };

        near.on('change', (value: number) => {
            if (!updating) {
                events.fire('selection.setDepthRange', { near: value });
            }
        });

        far.on('change', (value: number) => {
            if (!updating) {
                events.fire('selection.setDepthRange', { far: value });
            }
        });

        reset.on('click', () => {
            events.fire('selection.resetDepthRange');
        });

        events.on('selection.depthRange', () => sync());

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
