import { BooleanInput, Button, Container, ContainerArgs, Label, SelectInput, SliderInput } from '@playcanvas/pcui';

import { i18n } from './localization';
import { Events } from '../core/events';
import { ElementType } from '../scene/element';
import { detectClusters } from '../splat/cluster-filter';
import { detectFloaters } from '../splat/floater-removal';
import { Splat } from '../splat/splat';

/**
 * Floater Removal Panel — 去浮云 + 连通簇过滤。
 *
 * 去浮云：开关 + 单个「灵敏度」滑条（0-100，默认 40）+ 检出明细 + 「仅选中 / 移除浮云」两个动作。
 * 判据只有一个：以该点为中心、半宽 = 34.5 × 典型点间距的方块里有几个邻居；低于"模型自身典型密度 ×
 * 比例（灵敏度）"就算浮云（见 splat/floater-removal.ts，里面有真实扫描上的标定数据）。
 *
 * 连通簇：把高斯中心按体素量化后做 26 邻域连通分量（思路对齐 PlayCanvas splat-transform 的
 * `--filter-cluster`），两种模式：「删除小簇」（小于阈值的簇）与「保留最大簇」（除最大簇外全算）。
 * 见 splat/cluster-filter.ts。
 *
 * 两个功能都**按选中的每个模型分别检测/分别生成掩码**（早先版本用「主选中模型」检测，
 * 再把同一份掩码套到所有选中模型上，多模型时会张冠李戴），动作都走同一个 `floater.apply` 事件，
 * 由 editor 打包成一次可撤销的操作。
 */

type Target = { splat: Splat, mask: Uint8Array };

class FloaterPanel extends Container {
    private _fltEvents: Events;
    private _contentContainer: Container;
    private _collapsed = true;
    private _collapseArrow: Label;

    // Sensitivity slider
    private _sensitivitySlider: SliderInput;
    private _sensitivityRow: Container;

    // Result display（计数 + 各策略明细）
    private _resultLabel: Label;

    // Action buttons
    private _selectBtn: Button;
    private _removeBtn: Button;

    // ---- cluster filter ----
    private _clusterMode: SelectInput;
    private _clusterDetailSlider: SliderInput;
    private _clusterDetailRow: Container;
    private _clusterSizeSlider: SliderInput;
    private _clusterSizeRow: Container;
    private _clusterResultLabel: Label;
    private _clusterSelectBtn: Button;
    private _clusterRemoveBtn: Button;

    // Enable toggle
    private _enabledToggle: BooleanInput;
    private _fltEnabled = true;

    private _sensitivity = 50;
    private _clusterDetail = 50;      // 0..100 -> voxel size = spacing x lerp(24, 8); higher = finer
    private _clusterMinPct = 2;       // clusters smaller than this % of the largest are "small"
    private _clusterModeValue = 'small';
    private _detectTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(events: Events, args: ContainerArgs = {}) {
        args = {
            ...args,
            id: 'floater-panel'
        };
        super(args);

        this._fltEvents = events;

        // ---- collapsible header ----
        const header = new Container({ class: 'panel-header' });
        header.dom.style.cursor = 'pointer';

        this._collapseArrow = new Label({
            class: 'floater-panel-collapse-arrow',
            text: '\u25B6'   // ▶  collapsed
        });

        const icon = new Label({
            text: '\uE73E',   // cloud icon
            class: 'panel-header-icon'
        });

        const titleLabel = new Label({ class: 'panel-header-label' });
        i18n.bindText(titleLabel, 'panel.floater');

        header.append(this._collapseArrow);
        header.append(icon);
        header.append(titleLabel);

        // Toggle switch on the right side of the header. Detection is cheap enough to be on by
        // default (a strided sample for the counts), so the panel starts active and the toggle
        // is there to switch the whole thing off.
        const toggleWrapper = new Container({ class: 'floater-panel-header-toggle' });
        this._enabledToggle = new BooleanInput({
            type: 'toggle',
            value: true
        });
        this._enabledToggle.on('change', (v: boolean) => this._updateEnabled(v));
        toggleWrapper.dom.addEventListener('click', (e: MouseEvent) => e.stopPropagation());
        toggleWrapper.append(this._enabledToggle);
        header.append(toggleWrapper);

        header.dom.addEventListener('click', () => this._toggleCollapse());

        // ---- content ----
        this._contentContainer = new Container({ class: 'floater-panel-content' });

        // 灵敏度滑条：唯一的调参入口（越高删得越多）
        this._sensitivityRow = this._buildSliderRow(
            'panel.floater.sensitivity',
            0, 100, 1,
            this._sensitivity,
            (v) => {
                this._sensitivity = v;
            }
        );

        // 使用提示
        const hintRow = new Container({ class: 'floater-panel-row' });
        const hintLabel = new Label({ class: 'floater-panel-hint' });
        i18n.bindText(hintLabel, 'panel.floater.sensitivityHint');
        hintRow.append(hintLabel);
        this._contentContainer.append(hintRow);

        // Result label（检出数 + 各策略明细）
        const resultRow = new Container({ class: 'floater-panel-row' });
        this._resultLabel = new Label({
            class: 'floater-panel-result',
            text: '--'
        });
        resultRow.append(this._resultLabel);
        this._contentContainer.append(resultRow);

        // Actions: select only (review first) / remove.
        // PCUI's `class` takes a single token (a space-separated string throws in DOMTokenList.add),
        // so the extra layout class is added through ClassName#add.
        const btnRow = new Container({ class: 'floater-panel-row' });
        btnRow.class.add('floater-panel-btn-row');
        this._selectBtn = new Button({ class: 'floater-panel-select-btn', text: '' });
        i18n.bindText(this._selectBtn, 'panel.floater.selectOnly');
        this._selectBtn.on('click', () => this._apply(false));

        this._removeBtn = new Button({ class: 'floater-panel-remove-btn' });
        i18n.bindText(this._removeBtn, 'panel.floater.remove');
        this._removeBtn.on('click', () => this._apply(true));

        btnRow.append(this._selectBtn);
        btnRow.append(this._removeBtn);
        this._contentContainer.append(btnRow);

        // ---- cluster filter section ----
        const clusterSep = new Container({ class: 'floater-panel-separator' });
        this._contentContainer.append(clusterSep);

        const clusterTitle = new Label({ class: 'floater-panel-section' });
        i18n.bindText(clusterTitle, 'panel.floater.cluster');
        this._contentContainer.append(clusterTitle);

        const modeRow = new Container({ class: 'floater-panel-row' });
        const modeLabel = new Label({ class: 'floater-panel-label' });
        i18n.bindText(modeLabel, 'panel.floater.clusterMode');
        this._clusterMode = new SelectInput({
            class: 'floater-panel-select',
            defaultValue: 'small',
            options: [
                { v: 'small', t: i18n.t('panel.floater.clusterMode.small') },
                { v: 'largest', t: i18n.t('panel.floater.clusterMode.largest') }
            ]
        });
        this._clusterMode.on('change', (v: string) => {
            this._clusterModeValue = v;
            this._updateClusterUi();
            this._scheduleDetect();
        });
        modeRow.append(modeLabel);
        modeRow.append(this._clusterMode);
        this._contentContainer.append(modeRow);

        // 体素精细度（越高体素越小，簇划分越细）
        this._clusterDetailRow = this._buildSliderRow(
            'panel.floater.clusterDetail',
            0, 100, 1,
            this._clusterDetail,
            (v) => {
                this._clusterDetail = v;
            }
        );

        // 小簇阈值（占最大簇的百分比）—— 固定行引用，slider 本身在 _buildSliderRow 里赋值
        this._clusterSizeRow = this._buildSliderRow(
            'panel.floater.clusterMin',
            0, 50, 0.5,
            this._clusterMinPct,
            (v) => {
                this._clusterMinPct = v;
            }
        );

        const clusterHintRow = new Container({ class: 'floater-panel-row' });
        const clusterHint = new Label({ class: 'floater-panel-hint' });
        i18n.bindText(clusterHint, 'panel.floater.clusterHint');
        clusterHintRow.append(clusterHint);
        this._contentContainer.append(clusterHintRow);

        const clusterResultRow = new Container({ class: 'floater-panel-row' });
        this._clusterResultLabel = new Label({
            class: 'floater-panel-result',
            text: '--'
        });
        clusterResultRow.append(this._clusterResultLabel);
        this._contentContainer.append(clusterResultRow);

        const clusterBtnRow = new Container({ class: 'floater-panel-row' });
        clusterBtnRow.class.add('floater-panel-btn-row');
        this._clusterSelectBtn = new Button({ class: 'floater-panel-select-btn' });
        i18n.bindText(this._clusterSelectBtn, 'panel.floater.selectOnly');
        this._clusterSelectBtn.on('click', () => this._applyClusters(false));

        this._clusterRemoveBtn = new Button({ class: 'floater-panel-remove-btn' });
        i18n.bindText(this._clusterRemoveBtn, 'panel.floater.remove');
        this._clusterRemoveBtn.on('click', () => this._applyClusters(true));

        clusterBtnRow.append(this._clusterSelectBtn);
        clusterBtnRow.append(this._clusterRemoveBtn);
        this._contentContainer.append(clusterBtnRow);

        // ---- assemble ----
        this.append(header);
        this.append(this._contentContainer);

        // Start collapsed by default
        this._contentContainer.hidden = true;

        this._updateClusterUi();
        this._scheduleDetect();

        // Listen for selection changes to re-detect
        events.on('selection', () => this._scheduleDetect());
        events.on('splat.stateChanged', () => this._scheduleDetect());
    }

    // ================================================================
    //  Enable/disable all controls
    // ================================================================
    private _updateEnabled(enabled: boolean) {
        this._fltEnabled = enabled;
        this._sensitivitySlider.enabled = enabled;
        this._selectBtn.enabled = enabled;
        this._removeBtn.enabled = enabled;
        this._clusterMode.enabled = enabled;
        this._clusterDetailSlider.enabled = enabled;
        this._clusterSizeSlider.enabled = enabled;
        this._clusterSelectBtn.enabled = enabled;
        this._clusterRemoveBtn.enabled = enabled;
        if (enabled) {
            this._sensitivityRow.class.remove('dimmed');
            this._selectBtn.class.remove('dimmed');
            this._removeBtn.class.remove('dimmed');
            this._clusterDetailRow.class.remove('dimmed');
            this._scheduleDetect();
        } else {
            this._sensitivityRow.class.add('dimmed');
            this._selectBtn.class.add('dimmed');
            this._removeBtn.class.add('dimmed');
            this._resultLabel.text = '--';
            this._clusterResultLabel.text = '--';
        }
        this._updateClusterUi();
    }

    private _updateClusterUi() {
        const largest = this._clusterModeValue === 'largest';
        // in "keep largest" mode the threshold is irrelevant: everything but the largest cluster goes
        this._clusterSizeSlider.enabled = this._fltEnabled && !largest;
        this._clusterSizeRow.class[largest ? 'add' : 'remove']('dimmed');
    }

    private _buildSliderRow(
        i18nKey: string,
        min: number, max: number, step: number,
        value: number,
        onChange: (v: number) => void
    ): Container {
        const row = new Container({ class: 'floater-panel-row' });

        const label = new Label({ class: 'floater-panel-label' });
        i18n.bindText(label, i18nKey);

        const slider = new SliderInput({
            class: 'floater-panel-slider',
            min,
            max,
            step,
            value
        });

        slider.on('change', (v: number) => {
            onChange(v);
            this._scheduleDetect();
        });

        if (i18nKey === 'panel.floater.sensitivity') {
            this._sensitivitySlider = slider;
        } else if (i18nKey === 'panel.floater.clusterDetail') {
            this._clusterDetailSlider = slider;
        } else if (i18nKey === 'panel.floater.clusterMin') {
            this._clusterSizeSlider = slider;
        }

        row.append(label);
        row.append(slider);
        this._contentContainer.append(row);
        return row;
    }

    // ================================================================
    //  Targets: every selected model, each with its own mask
    // ================================================================
    private _targetSplats(): Splat[] {
        const all = (this._fltEvents.invoke('selection.all') as Splat[]) ?? [];
        if (all.length) {
            return all;
        }
        const primary = this._fltEvents.invoke('selection') as Splat;
        if (primary) {
            return [primary];
        }
        return this._fltEvents.invoke('scene')?.getElementsByType(ElementType.splat) as Splat[] ?? [];
    }

    private _floaterTargets(): Target[] {
        const targets: Target[] = [];
        for (const splat of this._targetSplats()) {
            try {
                const result = detectFloaters(splat, this._sensitivity);
                targets.push({ splat, mask: result.mask });
            } catch (e) {
                // skip models whose data cannot be read
            }
        }
        return targets;
    }

    private _clusterTargets(): Target[] {
        const targets: Target[] = [];
        for (const splat of this._targetSplats()) {
            try {
                const result = detectClusters(splat, {
                    detail: this._clusterDetail,
                    mode: this._clusterModeValue === 'largest' ? 'largest' : 'small',
                    minPct: this._clusterMinPct
                });
                targets.push({ splat, mask: result.mask });
            } catch (e) {
                // skip models whose data cannot be read
            }
        }
        return targets;
    }

    // ================================================================
    //  Detection (debounced; the counts are the expensive part)
    // ================================================================
    private _scheduleDetect() {
        if (!this._fltEnabled) return;
        if (this._detectTimer) clearTimeout(this._detectTimer);
        this._resultLabel.text = '...';
        this._clusterResultLabel.text = '...';
        this._detectTimer = setTimeout(() => this._runDetect(), 200);
    }

    private _runDetect() {
        const splats = this._targetSplats();
        if (!splats.length) {
            this._resultLabel.text = '--';
            this._clusterResultLabel.text = '--';
            return;
        }

        // The detection itself is exact (the count grid has to cover every gaussian anyway, so
        // sampling the candidates would save nothing and would mis-report small counts); the
        // debounce above is what keeps slider drags responsive.
        try {
            let count = 0;
            let radius = 0;
            let limit = 0;
            let reference = 0;
            for (const splat of splats) {
                const result = detectFloaters(splat, this._sensitivity);
                count += result.count;
                radius = Math.max(radius, result.details.radius);
                reference = Math.max(reference, result.details.reference);
                limit = Math.max(limit, result.details.limit);
            }
            this._resultLabel.text = `${count}`;
            this._resultLabel.dom.title = i18n.t('panel.floater.details', {
                radius: radius.toPrecision(3),
                limit,
                reference
            });
        } catch (e) {
            this._resultLabel.text = '!';
        }

        try {
            let clusters = 0;
            let largest = 0;
            let small = 0;
            let smallPoints = 0;
            for (const splat of splats) {
                const result = detectClusters(splat, {
                    detail: this._clusterDetail,
                    mode: this._clusterModeValue === 'largest' ? 'largest' : 'small',
                    minPct: this._clusterMinPct
                });
                clusters += result.clusterCount;
                largest = Math.max(largest, result.largestSize);
                small += result.smallClusterCount;
                smallPoints += result.count;
            }
            this._clusterResultLabel.text = `${clusters} / ${smallPoints}`;
            this._clusterResultLabel.dom.title = i18n.t('panel.floater.clusterDetails', {
                clusters,
                largest,
                small,
                points: smallPoints
            });
        } catch (e) {
            this._clusterResultLabel.text = '!';
        }
    }

    // ================================================================
    //  Apply
    // ================================================================
    private _apply(remove: boolean) {
        if (!this._targetSplats().length) return;
        try {
            this._resultLabel.text = '...';
            const targets = this._floaterTargets();
            const count = targets.reduce((sum, t) => sum + (t.mask as Uint8Array).reduce((n, v) => n + (v ? 1 : 0), 0), 0);
            if (!targets.length || count === 0) {
                this._resultLabel.text = '0';
                return;
            }
            this._fltEvents.fire('floater.apply', { targets, remove, count });
            this._resultLabel.text = `${count}`;
        } catch (e) {
            this._resultLabel.text = '!';
        }
    }

    private _applyClusters(remove: boolean) {
        if (!this._targetSplats().length) return;
        try {
            this._clusterResultLabel.text = '...';
            const targets = this._clusterTargets();
            const count = targets.reduce((sum, t) => sum + (t.mask as Uint8Array).reduce((n, v) => n + (v ? 1 : 0), 0), 0);
            if (!targets.length || count === 0) {
                this._clusterResultLabel.text = '0';
                return;
            }
            this._fltEvents.fire('floater.apply', { targets, remove, count });
            this._clusterResultLabel.text = `${count}`;
        } catch (e) {
            this._clusterResultLabel.text = '!';
        }
    }

    // ================================================================
    //  Collapse
    // ================================================================
    private _toggleCollapse() {
        this._collapsed = !this._collapsed;
        if (this._collapsed) {
            this._contentContainer.hidden = true;
            this._collapseArrow.text = '\u25B6';
        } else {
            this._contentContainer.hidden = false;
            this._collapseArrow.text = '\u25BC';
        }
    }

    /** 强制折叠（供其他面板展开时调用，如地面/水域面板）。 */
    collapse() {
        if (!this._collapsed) this._toggleCollapse();
    }
}

export { FloaterPanel };
