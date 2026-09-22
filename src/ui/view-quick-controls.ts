import { BooleanInput, Container, Label, SliderInput } from '@playcanvas/pcui';

import { i18n } from './localization';
import { Events } from '../core/events';

/**
 * 视图快捷控件（**左上角、菜单栏右侧**）—— 用户要求（2026-09-22）：
 * **视野角 / 显示边界 / 显示网格** 三个高频开关要能随手够到，
 * 设置面板里原有的那三份**保持不动**（这里只是同一套事件的第二个入口）。
 *
 * 版式（用户第二轮要求）：
 *   • 第一行：「视野角 75°」+ 滑轨（滑轨紧跟在标签后面，不另起一行）
 *   • 第二行：「显示」+「边界」开关 +「网格」开关（原来两行开关压成一行，
 *     共用一次「显示」前缀 ⇒ 面板从 3 行 96px 降到 2 行）
 *
 * 位置：**菜单栏右侧**。菜单栏宽度随语言/折叠状态变化（中文 444px、德语更长），
 * 所以 `left` **不写死**——量 `#menu-bar` 的右边缘 + 12px 间距，并用 `ResizeObserver`
 * 跟着菜单栏变化重算（语言切换、菜单折叠都会触发）。
 *
 * 事件接线（与 `camera-panel` / `settings-panel` 完全一致，所以两边永远同步）：
 *   • 视野角：`camera.setFov` / 监听 `camera.fov`，初值 `invoke('camera.fov')`
 *   • 显示边界：`camera.setBound` / 监听 `camera.bound`
 *   • 显示网格：`grid.setVisible` / 监听 `grid.visible`，初值 `invoke('grid.visible')`
 *
 * 文案：视野角与开关沿用设置面板已有的键；「显示 / 边界 / 网格」三个短标签是
 * `panel.settings.show` / `panel.settings.short-bounding-box` / `panel.settings.short-grid`
 * （9 个语言包都补齐了——各语言「显示」前缀的位置不同，所以不能靠裁字符串生成）。
 */
class ViewQuickControls extends Container {
    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'view-quick-controls'
        };

        super(args);

        // **必须**拦下指针事件，否则这块面板的开关根本点不动（用户 2026-09-22 报的"点击没反应"）。
        // 真凶不是 z-index、也不是 pointer-events：面板挂在 `#canvas-container` 里，而相机控制器
        // 在 `#canvas-container` 上监听 `pointerdown` 并 `target.setPointerCapture(pointerId)`。
        // 于是 pointerdown 一冒泡上去就被相机抢走指针捕获，**pointerup / mouseup / click 全部被改派到
        // `#canvas-container`**（实测：pointerdown 的 target 是开关本身，pointerup 和 click 的 target 变成了
        // `#canvas-container`）⇒ PCUI 的 `BooleanInput` 靠 `click` 才翻转，自然永远收不到。
        // 副作用还有：在面板上点击/拖动会被当成相机拖动。
        // 其它面板（scene-panel / settings-panel / color-panel …）都是这么处理的，这里补齐。
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        // ---- 视野角（第一行）----
        // 用户反馈（2026-09-22）：① 不要输入框；② 滑轨要长；③ **滑轨就跟在"视野角"三个字后面，
        // 不要另起一行**（另起一行太占纵向空间）。
        // 所以：单行 =「视野角 75°」+ 滑轨（PCUI 自带的数字输入框在 CSS 里藏掉，
        // 角度读数并进标签文本里，右侧整段留给轨道）。标签文本随语言/角度刷新。
        const fovSlider = new SliderInput({
            class: 'vqc-slider',
            min: 10,
            max: 120,
            step: 1,
            value: 75
        });
        const fovRow = new Container({ class: 'vqc-row' });
        const fovLabel = new Label({ class: 'vqc-label' });
        const refreshFovLabel = (v: number) => {
            fovLabel.text = `${i18n.t('panel.camera.fov')} ${Math.round(v)}°`;
        };
        const initialFov = Number(events.invoke('camera.fov') ?? 75);
        fovSlider.value = initialFov;
        refreshFovLabel(initialFov);
        i18n.onChange(() => refreshFovLabel(fovSlider.value), fovLabel);
        fovRow.append(fovLabel);
        fovRow.append(fovSlider);
        this.append(fovRow);
        fovSlider.on('change', (value: number) => {
            refreshFovLabel(value);
            events.fire('camera.setFov', value);
        });

        // ---- 第二行：「显示」+ 边界开关 + 网格开关 ----
        const displayRow = new Container({ class: ['vqc-row', 'vqc-display-row'] });
        const showLabel = new Label({ class: 'vqc-label' });
        i18n.bindText(showLabel, 'panel.settings.show');
        displayRow.append(showLabel);

        // 每个开关 = 短标签 + 拨动开关，成组不换行（窄屏也不会把标签和开关拆开）
        const group = (labelKey: string, onChange: (value: boolean) => void) => {
            const wrap = new Container({ class: 'vqc-group' });
            const label = new Label({ class: ['vqc-label', 'vqc-group-label'] });
            i18n.bindText(label, labelKey);
            const toggle = new BooleanInput({ type: 'toggle', class: 'vqc-toggle', value: true });
            toggle.on('change', () => onChange(toggle.value));
            wrap.append(label);
            wrap.append(toggle);
            displayRow.append(wrap);
            return toggle;
        };

        const boundToggle = group('panel.settings.short-bounding-box', value => events.fire('camera.setBound', value));
        const gridToggle = group('panel.settings.short-grid', value => events.fire('grid.setVisible', value));
        this.append(displayRow);

        // 与设置面板 / 快捷键 / 文档加载保持同步（哪边改都更新这边，不回灌）
        try {
            const initialGrid = events.invoke('grid.visible');
            if (typeof initialGrid === 'boolean') {
                gridToggle.value = initialGrid;
            }
        } catch {
            // 没这个接口就保持默认
        }
        try {
            const initialBound = events.invoke('camera.bound');
            if (typeof initialBound === 'boolean') {
                boundToggle.value = initialBound;
            }
        } catch {
            // 同上
        }

        events.on('camera.fov', (fov: number) => {
            if (fovSlider.value !== fov) {
                fovSlider.value = fov;
            }
            refreshFovLabel(fov);
        });
        events.on('grid.visible', (visible: boolean) => {
            if (gridToggle.value !== visible) {
                gridToggle.value = visible;
            }
        });
        events.on('camera.bound', (visible: boolean) => {
            if (boundToggle.value !== visible) {
                boundToggle.value = visible;
            }
        });

        // ---- 贴菜单栏右侧（宽度随语言/折叠变化 ⇒ 测量 + 跟随）----
        // 注意：构造时菜单栏可能还没进 DOM（实测过：那会儿挂 ResizeObserver 挂了个 null，
        // 面板就只会停在首帧位置、菜单栏变宽也不跟 —— 回归里那条"菜单栏变宽后必须跟着走"
        // 正是这么抓出来的）。所以测量和挂观察器都放进 rAF 之后，并且在里面惰性挂载。
        const MENU_GAP = 12;
        let observer: ResizeObserver | null = null;
        const stickToMenuBar = () => {
            const bar = document.querySelector('#menu-bar') as HTMLElement | null;
            if (!bar) {
                return;
            }
            const rect = bar.getBoundingClientRect();
            if (rect.width > 0) {
                this.dom.style.left = `${Math.round(rect.right + MENU_GAP)}px`;
            }
            if (!observer && typeof ResizeObserver !== 'undefined') {
                observer = new ResizeObserver(() => stickToMenuBar());
                observer.observe(bar);
                this.on('destroy', () => {
                    try {
                        observer?.disconnect();
                    } catch {
                        // 忽略
                    }
                });
            }
        };
        requestAnimationFrame(stickToMenuBar);
        window.addEventListener('resize', stickToMenuBar);
    }
}

export { ViewQuickControls };
