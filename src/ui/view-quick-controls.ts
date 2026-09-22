import { BooleanInput, Container, Label, SliderInput } from '@playcanvas/pcui';

import { i18n } from './localization';
import { Events } from '../core/events';

/**
 * 视图快捷控件（右上角坐标轴正下方）—— 用户要求（2026-09-22）：
 * **视野角 / 显示边界 / 显示网格** 三个高频开关要能随手够到，
 * 设置面板里原有的那三份**保持不动**（这里只是同一套事件的第二个入口）。
 *
 * 事件接线（与 `camera-panel` / `settings-panel` 完全一致，所以两边永远同步）：
 *   • 视野角：`camera.setFov` / 监听 `camera.fov`，初值 `invoke('camera.fov')`
 *   • 显示边界：`camera.setBound` / 监听 `camera.bound`
 *   • 显示网格：`grid.setVisible` / 监听 `grid.visible`，初值 `invoke('grid.visible')`
 *
 * 文案**复用设置面板已有的键**（`panel.camera.fov` / `panel.settings.show-bounding-box` /
 * `panel.settings.show-grid`）⇒ 不动 9 个语言包。
 */
class ViewQuickControls extends Container {
    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'view-quick-controls'
        };

        super(args);

        const row = (labelKey: string) => {
            const container = new Container({ class: 'vqc-row' });
            const label = new Label({ class: 'vqc-label' });
            i18n.bindText(label, labelKey);
            container.append(label);
            this.append(container);
            return container;
        };

        // ---- 视野角 ----
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

        // ---- 显示边界 ----
        const boundRow = row('panel.settings.show-bounding-box');
        const boundToggle = new BooleanInput({ type: 'toggle', class: 'vqc-toggle', value: true });
        boundRow.append(boundToggle);
        boundToggle.on('change', () => {
            events.fire('camera.setBound', boundToggle.value);
        });

        // ---- 显示网格 ----
        const gridRow = row('panel.settings.show-grid');
        const gridToggle = new BooleanInput({ type: 'toggle', class: 'vqc-toggle', value: true });
        gridRow.append(gridToggle);
        gridToggle.on('change', () => {
            events.fire('grid.setVisible', gridToggle.value);
        });

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
    }
}

export { ViewQuickControls };
