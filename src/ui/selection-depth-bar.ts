import { Button, Container, Label } from '@playcanvas/pcui';

import { i18n } from './localization';
import { RangeSlider, RangeValue } from './range-slider';
import { Events } from '../core/events';
import { LIMITS } from '../core/selection-flags';

/**
 * 选择工具的**选区范围**浮条：点开屏幕选择工具时浮出来的一块面板，里面是三个**四柄** range。
 * 每个轴两端各有一对柄（外柄 … 内柄），两个轴标签分列两侧：
 *
 *   ----o 近 o-------o 远 o----       o = 滑块
 *
 *   深度  最近 [外][内] [===track===] [内][外] 最远   —— 沿手势视轴，占模型自身深度范围的百分比
 *   左右  左   [外][内] [===track===] [内][外] 右     —— 占选区框宽度的百分比（可扩到框外）
 *   上下  上   [外][内] [===track===] [内][外] 下     —— 占选区框高度的百分比
 *
 *   - **内柄** = 选区边界（把框裁到哪）；
 *   - **外柄** = **扩边到哪**：外柄与内柄之间那段（半透明橙）就是扩边多吃进来的部分。
 *
 * 两柄默认重合（不扩边），此时与上一版的双柄行为完全一致。三轴都默认整段（0 / 100）= 完整穿透
 * 整个模型；拖动任何一个柄都会**实时重切**当前选区（同一个历史条目）。「重置」把三轴一起还原。
 *
 * 对齐线上编辑器（data.good360vr.com/editor，SUPERSPLAT v2 那套）的"选区深度 + 最近/最远"，
 * 只是把单轴扩成三轴、把两柄扩成四柄（内柄裁、外柄扩）。
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
            min: LIMITS.depth.min,
            max: LIMITS.depth.max,
            value: { low: 0, high: 100, outerLow: 0, outerHigh: 100 },
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
            min: LIMITS.x.min,
            max: LIMITS.x.max,
            value: { low: 0, high: 100, outerLow: 0, outerHigh: 100 },
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
            min: LIMITS.y.min,
            max: LIMITS.y.max,
            value: { low: 0, high: 100, outerLow: 0, outerHigh: 100 },
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
            const depthRange = events.invoke('selection.depthRange') as {
                near: number,
                far: number,
                nearOuter: number,
                farOuter: number
            };
            const screen = events.invoke('selection.screenRange') as {
                x: RangeValue,
                y: RangeValue
            };

            syncing = true;
            depth.value = {
                low: depthRange.near,
                high: depthRange.far,
                outerLow: depthRange.nearOuter,
                outerHigh: depthRange.farOuter
            };
            horizontal.value = screen.x;
            vertical.value = screen.y;
            syncing = false;

            // the title lights up while the selection is not the full through-pass
            const narrowed = (axis: RangeValue) => {
                return axis.low > 0 || axis.high < 100 || axis.outerLow < 0 || axis.outerHigh > 100;
            };
            const active = narrowed(screen.x) || narrowed(screen.y) ||
                depthRange.near > 0 || depthRange.far < 100 ||
                depthRange.nearOuter < 0 || depthRange.farOuter > 100;
            title.class[active ? 'add' : 'remove']('active');
        };

        reset.on('click', () => {
            events.fire('selection.resetRange');
        });

        events.on('selection.depthRange', () => sync());
        events.on('selection.screenRange', () => sync());

        // A3（docs/audit/00-总结.md）：模型超过投影缓存的字节预算时，推杆会退回逐点重算
        // （13M 上实测约 2 秒）。以前这完全静默，用户看到的只是"滑块好像坏了"，所以这里
        // 把标题换成一句说明 —— 文字变了就是可见提示，不需要新的 UI 元素。
        let cacheRefused = false;
        const applyTitle = () => {
            const key = cacheRefused ? 'select-toolbar.rangeCacheTooLarge' : 'select-toolbar.selectionRange';
            title.text = i18n.t(key);
            title.dom.title = cacheRefused ? i18n.t(key) : '';
            title.class[cacheRefused ? 'add' : 'remove']('range-refused');
        };
        events.on('selection.rangeCacheRefused', (refused: boolean) => {
            if (!!refused === cacheRefused) {
                return;
            }
            cacheRefused = !!refused;
            applyTitle();
        });

        // the bar follows the active tool, and is hidden entirely in 环模式（rings）:
        // 环模式的选中集合由 GPU id 拾取决定（V2 的语义），滑块无从作用，留着就是"死 UI"
        // （用户 2026-09-15 拍板：环模式下不需要调范围 —— 见 docs/audit/01-量级复查-bug.md 第 8 条）。
        let activeTool: string | null = null;
        const barVisible = () => activeTool !== null && TOOLS_WITH_RANGE.includes(activeTool) && events.invoke('camera.mode') !== 'rings';
        const updateBar = () => {
            bar.hidden = !barVisible();
            if (barVisible()) {
                sync();
            }
        };
        events.on('tool.activated', (name: string) => {
            activeTool = name;
            updateBar();
        });
        events.on('tool.deactivated', () => {
            activeTool = null;
            updateBar();
        });
        // 切换 中心/环 模式时立刻显隐（camera.mode 由 editor 的 setCameraMode 广播）
        events.on('camera.mode', () => updateBar());

        sync();
    }
}

export { SelectionDepthBar };
