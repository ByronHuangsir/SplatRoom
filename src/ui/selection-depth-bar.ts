import { BooleanInput, Container, Label, SliderInput } from '@playcanvas/pcui';

import { i18n } from './localization';
import { Events } from '../core/events';

/**
 * 选择工具的**深度条**：点开屏幕选择工具（矩形/套索/多边形/2D 笔刷）时浮出来的小工具栏，
 * 里面是一个"深度"开关 + 一个深度滑块。
 *
 * 参照用户给的线上编辑器（data.good360vr.com/editor）：那边点开选择工具就会出现深度滑块，而我们的深度
 * 原本只藏在设置面板里，用起来要先翻面板，和"边选边调"的工作流不搭。
 *
 * 两个控件的作用：
 *   - 深度开关 = `selection.useDepth`：开 = 只作用于可见表面（每像素最前面的高斯），关 = 穿透所有层；
 *   - 深度滑块 = `selection.depthThickness`（占模型对角线的百分比，0 = 只选一层）：大于 0 时选择变成
 *     "前表面往后 T 的一段带"，判定在 splat/selection-band.ts。滑块一离开 0 会自动把深度开关打开 ——
 *     厚度只有在深度模式下才有意义，省得用户调了没反应。
 *
 * 只挂在屏幕选择工具上：球刷有自己的"厚度"滑块（沿视线的板状体），不需要再来一个深度滑块。
 */
const TOOLS_WITH_DEPTH = ['rectSelection', 'lassoSelection', 'polygonSelection', 'brushSelection'];

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

        const depthLabel = new Label({ class: 'select-toolbar-label' });
        i18n.bindText(depthLabel, 'select-toolbar.depth');

        const depthToggle = new BooleanInput({
            type: 'toggle',
            class: 'select-toolbar-toggle',
            value: !!events.invoke('selection.useDepth')
        });

        const thicknessLabel = new Label({ class: 'select-toolbar-label' });
        i18n.bindText(thicknessLabel, 'select-toolbar.depthThickness');

        const thickness = new SliderInput({
            class: 'select-toolbar-slider',
            min: 0,
            max: 20,
            step: 0.5,
            precision: 1,
            value: (events.invoke('selection.depthThickness') as number) ?? 0
        });

        bar.append(depthLabel);
        bar.append(depthToggle);
        bar.append(new Container({ class: 'select-toolbar-separator' }));
        bar.append(thicknessLabel);
        bar.append(thickness);
        parent.appendChild(bar.dom);

        // PCUI fires 'change' when the value is set programmatically, so the echo back into the
        // control has to be guarded (otherwise writing the flag in would write a clamped value back)
        let updating = false;

        const syncEnabled = () => {
            const useDepth = !!events.invoke('selection.useDepth');
            depthToggle.value = useDepth;
            thickness.enabled = useDepth;
            thickness.class[useDepth ? 'remove' : 'add']('dimmed');
        };

        depthToggle.on('change', (value: boolean) => {
            if (!updating) {
                events.fire('selection.setUseDepth', value);
            }
        });

        thickness.on('change', (value: number) => {
            if (!updating) {
                if (value > 0 && !events.invoke('selection.useDepth')) {
                    // a thickness without depth would do nothing, so switch depth on with it
                    events.fire('selection.setUseDepth', true);
                }
                events.fire('selection.setDepthThickness', value);
            }
        });

        events.on('selection.useDepth', () => syncEnabled());
        events.on('selection.depthThickness', (value: number) => {
            updating = true;
            thickness.value = value;
            updating = false;
        });

        // the bar follows the active tool
        events.on('tool.activated', (name: string) => {
            const visible = TOOLS_WITH_DEPTH.includes(name);
            bar.hidden = !visible;
            if (visible) {
                syncEnabled();
            }
        });
        events.on('tool.deactivated', () => {
            bar.hidden = true;
        });

        syncEnabled();
    }
}

export { SelectionDepthBar };
