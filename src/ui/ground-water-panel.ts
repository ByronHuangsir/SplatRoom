import { Button, Container, ContainerArgs, Label, SliderInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { i18n } from './localization';

/**
 * 地面/水域平整面板（左侧 ScenePanel 内嵌，可折叠，样式与"去浮云"一致）。
 *
 * 展开时通过 groundwater.expanded 事件让 ScenePanel 折叠摄像机与去浮云
 * 面板；内容含：地面/水域切换（默认不启用，点击才运行检测）、进度条、
 * 熨平按钮、参数滑杆。
 */
class GroundWaterPanel extends Container {
    private events: Events;
    private _collapsed = true;
    private _collapseArrow: Label;
    private _contentContainer: Container;
    private stats: Label;
    private groundBtn: Button;
    private waterBtn: Button;
    private flattenBtn: Button;
    private tolSlider: SliderInput;
    private ghostSlider: SliderInput;
    private _progressBar: HTMLElement;
    private _progressFill: HTMLElement;
    private _params = {
        tolFactor: 0.01,
        ghostColorTol: 0.18
    };

    constructor(events: Events, args: ContainerArgs = {}) {
        args = { ...args, id: 'groundwater-panel' };
        super(args);

        this.events = events;

        // ---- collapsible header（与 floater-panel 一致）----
        const header = new Container({ class: 'panel-header' });
        header.dom.style.cursor = 'pointer';

        this._collapseArrow = new Label({
            class: 'groundwater-panel-collapse-arrow',
            text: '\u25B6'   // ▶  collapsed
        });

        const icon = new Label({
            text: '\uE15E',   // terrain/ground icon
            class: 'panel-header-icon'
        });

        const titleLabel = new Label({ class: 'panel-header-label' });
        i18n.bindText(titleLabel, 'panel.groundwater.title');

        header.append(this._collapseArrow);
        header.append(icon);
        header.append(titleLabel);
        header.dom.addEventListener('click', (e: MouseEvent) => {
            e.stopPropagation();
            this._toggleCollapse();
        });
        this.append(header);

        // ---- content ----
        this._contentContainer = new Container({ class: 'groundwater-panel-content' });
        this.append(this._contentContainer);

        this.stats = new Label({ class: 'groundwater-panel-stats', text: '—' });
        this._contentContainer.append(this.stats);

        // 进度条（自定义 div）
        this._progressBar = document.createElement('div');
        this._progressBar.className = 'groundwater-panel-progress';
        this._progressFill = document.createElement('div');
        this._progressFill.className = 'groundwater-panel-progress-fill';
        this._progressFill.style.width = '0%';
        this._progressBar.appendChild(this._progressFill);
        this._progressBar.style.display = 'none';
        this._contentContainer.dom.appendChild(this._progressBar);

        // 地面/水域切换（默认都不启用）
        const row = new Container({ class: 'groundwater-panel-row' });
        this.groundBtn = new Button({ class: 'groundwater-panel-btn' });
        i18n.bindText(this.groundBtn, 'panel.groundwater.ground');
        this.waterBtn = new Button({ class: 'groundwater-panel-btn' });
        i18n.bindText(this.waterBtn, 'panel.groundwater.water');
        row.append(this.groundBtn);
        row.append(this.waterBtn);
        this._contentContainer.append(row);

        // 参数调节
        const tolLabel = new Label({ class: 'groundwater-panel-param-label' });
        i18n.bindText(tolLabel, 'panel.groundwater.tol');
        this.tolSlider = new SliderInput({
            class: 'groundwater-panel-slider',
            min: 0.002,
            max: 0.05,
            step: 0.001,
            precision: 3,
            value: this._params.tolFactor
        });
        this.tolSlider.on('change', (v: number) => {
            this._params.tolFactor = v;
            events.fire('groundwater.paramsChanged', this._params);
        });
        this._contentContainer.append(tolLabel);
        this._contentContainer.append(this.tolSlider);

        const ghostLabel = new Label({ class: 'groundwater-panel-param-label' });
        i18n.bindText(ghostLabel, 'panel.groundwater.ghostTol');
        this.ghostSlider = new SliderInput({
            class: 'groundwater-panel-slider',
            min: 0.05,
            max: 0.5,
            step: 0.01,
            precision: 2,
            value: this._params.ghostColorTol
        });
        this.ghostSlider.on('change', (v: number) => {
            this._params.ghostColorTol = v;
            events.fire('groundwater.paramsChanged', this._params);
        });
        this._contentContainer.append(ghostLabel);
        this._contentContainer.append(this.ghostSlider);

        // 熨平按钮
        this.flattenBtn = new Button({ class: ['groundwater-panel-flatten', 'active'] });
        i18n.bindText(this.flattenBtn, 'panel.groundwater.flatten');
        this._contentContainer.append(this.flattenBtn);

        // ---- wire events ----
        // 点击地面：亮起 + 运行检测；再点取消
        this.groundBtn.on('click', () => {
            const wasActive = this.groundBtn.class.contains('active');
            this._setRegionActive('ground', !wasActive);
        });
        this.waterBtn.on('click', () => {
            const wasActive = this.waterBtn.class.contains('active');
            this._setRegionActive('water', !wasActive);
        });
        this.flattenBtn.on('click', () => {
            events.fire('groundwater.flatten');
        });

        // 进度更新
        events.on('groundwater.progress', (f: number) => {
            this._progressBar.style.display = 'block';
            this._progressFill.style.width = `${Math.min(100, Math.max(0, f * 100))}%`;
            this.stats.text = `${Math.round(f * 100)}%`;
        });

        // 检测完成（preview 事件 = 完成信号）
        events.on('groundwater.preview', (info: { region: string; ground: number; water: number }) => {
            this._progressBar.style.display = 'none';
            const regionLabel = info.region === 'ground' ?
                i18n.t('panel.groundwater.ground') :
                i18n.t('panel.groundwater.water');
            this.stats.text = `${regionLabel}: ${info.region === 'ground' ? info.ground : info.water} gaussians`;
        });

        events.on('groundwater.activated', (name: string | null) => {
            this.stats.text = name ? `splat: ${name}` : i18n.t('panel.groundwater.noSelection');
        });
        events.on('groundwater.deactivated', () => {
            this.stats.text = '—';
            this._progressBar.style.display = 'none';
        });

        // 初始折叠
        this._contentContainer.hidden = true;
    }

    /** 设置某区域按钮激活状态；激活时触发检测。 */
    private _setRegionActive(region: 'ground' | 'water', active: boolean) {
        const btn = region === 'ground' ? this.groundBtn : this.waterBtn;
        const other = region === 'ground' ? this.waterBtn : this.groundBtn;
        if (active) {
            btn.class.add('active');
            other.class.remove('active');
            this.events.fire('groundwater.setRegion', region);
        } else {
            // 取消当前区域 → 清除选区
            btn.class.remove('active');
            this.events.fire('groundwater.clearRegion');
        }
    }

    private _toggleCollapse() {
        this._collapsed = !this._collapsed;
        if (this._collapsed) {
            this._contentContainer.hidden = true;
            this._collapseArrow.text = '\u25B6';
        } else {
            this._contentContainer.hidden = false;
            this._collapseArrow.text = '\u25BC';
            // 展开时折叠摄像机与去浮云面板（ScenePanel 处理）
            this.events.fire('groundwater.expanded');
        }
    }
}

export { GroundWaterPanel };
