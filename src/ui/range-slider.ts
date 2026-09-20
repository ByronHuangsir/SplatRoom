import { Container, Label } from '@playcanvas/pcui';

import { i18n } from './localization';
import { MIN_THICKNESS } from '../core/selection-flags';

/**
 * 选区范围的一行（一个轴）：一条轨道 + **两个带字的方块滑块**，块里写轴标签（最近/最远、左/右、上/下）。
 *
 *   ----■------------■----
 *
 * **两个滑块永远停在固定位置**（轨道 20% / 80%），拖动是"推一下"：按住往一边推，值跟着变，
 * **松手滑块自动回到原位**，值留在你推到的地方。所以面板看起来永远一样，新手不用找把手。
 *
 * **推得越远越快、越近越精确**：值的变化量不是指针位移的直线，而是
 *
 *     offset(dx) = sign(dx) · BASE · ( |dx| + dx² / (2·GROWTH) )
 *
 * 起点附近 ≈ BASE 值/px（BASE = 0.02，即 0.1 需要一个 5px 的小动作，能一格一格地抠），
 * 推到轨道端点（440px）已经是 ~57 个单位 —— 想快就多推一点，想慢就少推一点，同一手势里都做得到。
 *
 * 拖动过程中**比例尺一动不动**（窗口在 pointerdown 冻结），松手才按新的选区把轨道重新排好，
 * 于是两个滑块回到固定位置 —— 用户看到的只有"滑块归位"，没有尺度在手里变。
 *
 * 一行里没有任何数字（没有数字框、也没有浮出来的读数），块里的字是唯一文字。
 */
export interface RangeValue {
    /** 低端边界（方块） */
    low: number;
    /** 高端边界（方块） */
    high: number;
    /** 扩边到哪（默认等于 low / high = 不扩边）。面板不再画它，语义仍由 API / 选择逻辑使用 */
    outerLow: number;
    outerHigh: number;
}

export interface RangeSliderOptions {
    /** data-axis 属性值（验证脚本用它定位某一轴） */
    axis: string;
    /** 低端 / 高端标签的本地化键 */
    lowKey: string;
    highKey: string;
    /** 轨道值域上下限 */
    min: number;
    max: number;
    /** 初始值 */
    value: RangeValue;
    /** 拖动时回调（已夹好范围、按 step 吸附、链式约束修好） */
    onChange: (value: RangeValue) => void;
}

type HandleName = 'low' | 'high';

const HANDLES: HandleName[] = ['low', 'high'];

const STEP = 0.1;
/** 两个滑块的固定停靠位置（轨道比例） */
const HOME_LOW = 0.2;
const HOME_HIGH = 0.8;
/** 推杆手感：起点灵敏度（值/px）与"加速度"（推到多远灵敏度翻倍） */
const NUDGE_BASE = 0.02;
const NUDGE_GROWTH = 40;
/** 方块宽度 = 标签宽度 + 这个内边距 */
const BLOCK_PADDING = 14;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const snap = (value: number) => Math.round(value / STEP) * STEP;

/** 指针位移 -> 值的变化量（非线性：越远越快） */
const nudge = (dx: number) => {
    const magnitude = Math.abs(dx);
    return Math.sign(dx) * NUDGE_BASE * (magnitude + (magnitude * magnitude) / (2 * NUDGE_GROWTH));
};

class RangeSlider {
    /** 整行（PCUI Container 的 dom），调用方把它 append 进面板 */
    row: HTMLElement;

    private track: HTMLDivElement;

    private core: HTMLDivElement;

    private blocks: Record<'low' | 'high', HTMLDivElement>;

    private labels: Record<'low' | 'high', Label>;

    private handles: Record<HandleName, HTMLDivElement>;

    private min: number;

    private max: number;

    private _value: RangeValue;

    private onChange: (value: RangeValue) => void;

    private dragging: HandleName | null = null;

    // 拖动期间比例尺冻结：pointerdown 时的窗口整张留用，松手才重新排版（滑块归位）
    private dragView: { min: number, max: number } | null = null;

    private dragGrabX = 0;

    private dragGrabValue = 0;

    /** 被拖的滑块在轨道上的临时位置（比例），松手就回 HOME */
    private dragFraction: number | null = null;

    // 值 -> 轨道的窗口（拖动期间冻结）
    private view = { min: 0, max: 100 };

    constructor(options: RangeSliderOptions) {
        const { axis, lowKey, highKey, min, max } = options;

        const row = new Container({ class: 'select-range-row' });
        row.dom.setAttribute('data-axis', axis);

        const track = document.createElement('div');
        track.classList.add('select-range-track');

        const core = document.createElement('div');
        core.classList.add('select-range-band', 'select-range-core');

        this.blocks = {} as Record<'low' | 'high', HTMLDivElement>;
        this.labels = {} as Record<'low' | 'high', Label>;
        this.handles = {} as Record<HandleName, HTMLDivElement>;

        const makeBlock = (side: HandleName, key: string) => {
            const block = document.createElement('div');
            block.classList.add('select-range-block', `select-range-block-${side}`);
            block.setAttribute('data-block', side);
            const label = new Label({ class: 'select-range-label', text: '' });
            i18n.bindText(label, key);
            block.appendChild(label.dom);
            return { block, label };
        };

        const lowBlock = makeBlock('low', lowKey);
        const highBlock = makeBlock('high', highKey);
        this.blocks.low = lowBlock.block;
        this.blocks.high = highBlock.block;
        this.labels.low = lowBlock.label;
        this.labels.high = highBlock.label;

        for (const name of HANDLES) {
            const handle = document.createElement('div');
            handle.classList.add('select-range-handle');
            handle.setAttribute('data-handle', name);
            handle.tabIndex = 0;
            handle.title = i18n.t('select-toolbar.rangeHandleHint');
            this.handles[name] = handle;
        }

        // paint order: rail, the selected band, the two labelled blocks, then the grips
        track.appendChild(core);
        track.appendChild(this.blocks.low);
        track.appendChild(this.blocks.high);
        track.appendChild(this.handles.low);
        track.appendChild(this.handles.high);

        const wrap = document.createElement('div');
        wrap.classList.add('select-range-track-wrap');
        wrap.appendChild(track);
        row.dom.appendChild(wrap);

        this.row = row.dom;
        this.track = track;
        this.core = core;
        this.min = min;
        this.max = max;
        this._value = { ...options.value };
        this.onChange = options.onChange;

        this.commit(this._value, false);

        const beginDrag = (name: HandleName) => (e: PointerEvent) => {
            e.preventDefault();
            e.stopPropagation();
            this.dragging = name;
            this.computeView();
            // 比例尺在按下的一刻冻结，整个拖动过程不变
            this.dragView = { ...this.view };
            this.dragGrabX = e.clientX;
            this.dragGrabValue = this._value[name];
            this.dragFraction = name === 'low' ? HOME_LOW : HOME_HIGH;
            track.setPointerCapture(e.pointerId);
            this.handles[name].classList.add('dragging');
            this.blocks[name].classList.add('dragging');
            this.render();
        };

        this.blocks.low.addEventListener('pointerdown', beginDrag('low'));
        this.blocks.high.addEventListener('pointerdown', beginDrag('high'));
        this.handles.low.addEventListener('pointerdown', beginDrag('low'));
        this.handles.high.addEventListener('pointerdown', beginDrag('high'));

        track.addEventListener('pointermove', (e: PointerEvent) => {
            if (!this.dragging) {
                return;
            }
            const rect = this.trackRect();
            if (rect.width <= 0) {
                return;
            }
            const dx = e.clientX - this.dragGrabX;
            // 值按非线性手感走（越远越快）；滑块本身 1:1 跟手，但停在轨道里不会跑出去。
            // 方向决定语义：背离抓取点（近端向左 / 远端向右）= 向外扩边，朝抓取点 = 向内收芯。
            const expand = this.dragging === 'low' ? dx < 0 : dx > 0;
            this.setHandle(this.dragging, this.dragGrabValue + nudge(dx), expand);
            const home = this.dragging === 'low' ? HOME_LOW : HOME_HIGH;
            this.dragFraction = clamp(home + dx / rect.width, 0, 1);
            this.render();
        });

        const endDrag = (e: PointerEvent) => {
            if (this.dragging) {
                const name = this.dragging;
                this.dragging = null;
                // 松手：丢掉冻结的窗口，轨道按新选区重排 -> 两个滑块回到固定位置
                this.dragView = null;
                this.dragFraction = null;
                this.render();
                this.handles[name].classList.remove('dragging');
                this.blocks.low.classList.remove('dragging');
                this.blocks.high.classList.remove('dragging');
                if (track.hasPointerCapture(e.pointerId)) {
                    track.releasePointerCapture(e.pointerId);
                }
            }
        };

        track.addEventListener('pointerup', endDrag);
        track.addEventListener('pointercancel', endDrag);

        for (const name of HANDLES) {
            this.handles[name].addEventListener('keydown', (e: KeyboardEvent) => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') {
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                const step = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : STEP);
                this.setHandle(name, this._value[name] + step);
            });
        }
    }

    /** 外部写值（手势/复位回写），不回调 onChange。 */
    set value(value: RangeValue) {
        this.commit(value, false);
    }

    get value(): RangeValue {
        return { ...this._value };
    }

    private trackRect() {
        return this.track.getBoundingClientRect();
    }

    private trackWidth() {
        const rect = this.trackRect();
        return rect.width > 0 ? rect.width : 440;
    }

    private blockWidth() {
        const width = Math.max(this.labels.low.dom.offsetWidth, this.labels.high.dom.offsetWidth);
        return width + BLOCK_PADDING;
    }

    /**
     * 窗口：**让两个滑块永远落在固定的两个位置上**（HOME_LOW / HOME_HIGH），也就是
     * `track * (HOME_HIGH - HOME_LOW)` 恒定宽的一段。值域不再铺满轨道，轨道显示的是选区附近，
     * 于是面板的样子在任何厚度下都一样。只在没拖动时算；拖动期间用冻结的窗口。
     */
    private computeView() {
        const inner = Math.max(this._value.high - this._value.low, MIN_THICKNESS);
        const span = inner / (HOME_HIGH - HOME_LOW);
        this.view = { min: this._value.low - span * HOME_LOW, max: this._value.low + span * (1 - HOME_LOW) };
    }

    /** 值 -> 轨道位置（0..1）：窗口内线性。 */
    private fractionOf(value: number) {
        const span = this.view.max - this.view.min;
        if (span <= 0) {
            return 0.5;
        }
        return (value - this.view.min) / span;
    }

    /**
     * 移动一个边界，维持 `outerLow ≤ low ≤ high ≤ outerHigh`。芯不许薄过一个步长：顶到对面就推着走。
     *
     * **2026-09-21：加了"向外 = 扩边、向内 = 收芯"的双语义**（用户报"范围滑块只能收缩、不能扩展"，
     * 并同意按这个方案修）。为什么必须是两个值分别动：
     * 判定规则（`selection-core.ts`：外窗之外直接丢；**core 与 outer 之间的带**不看形状直接选；
     * core 之内才由画出的形状决定）意味着"选中框外的东西"**只可能来自那条带**。面板只有两个方块，
     * 原来它们同时带动 core 与 outer（margin 恒为 0）⇒ 带永远为空 ⇒ 向框外扩展在结构上不可能
     * （实测：屏幕轴向外推 −40/140，选中数 8506 → 8506 不变；向内推 40/60 → 174 有效）。
     * 现在：
     *   • **向外**（`expand = true`）：只动 outer，core 钉在框上 ⇒ 带长出来 ⇒ 框外那圈按矩形被选中，
     *     框内仍然由画出的形状决定（套索/多边形/笔刷的形状语义不变）；
     *   • **向内**：沿用原来的行为（core 与 outer 一起收，margin 保持）⇒ 收缩语义、含"首个小平移
     *     就能看到变化"的手感完全不变。
     */
    private setHandle(name: HandleName, rawValue: number, expand = false) {
        const limitMin = Math.min(this.min, this.max);
        const limitMax = Math.max(this.min, this.max);
        const value = clamp(snap(rawValue), limitMin, limitMax);
        const next = { ...this._value };
        const marginLow = next.low - next.outerLow;
        const marginHigh = next.outerHigh - next.high;

        if (name === 'low') {
            if (expand) {
                // 向外：只扩 outer（core 不动）
                next.outerLow = Math.max(limitMin, Math.min(value, next.low));
            } else {
                next.low = value;
                if (next.low > next.high - MIN_THICKNESS) {
                    next.high = Math.min(limitMax, next.low + MIN_THICKNESS);
                }
                next.outerLow = Math.max(limitMin, next.low - marginLow);
                next.outerHigh = Math.max(next.outerHigh, next.high);
            }
        } else if (expand) {
            // 向外：只扩 outer（core 不动）
            next.outerHigh = Math.min(limitMax, Math.max(value, next.high));
        } else {
            next.high = value;
            if (next.high < next.low + MIN_THICKNESS) {
                next.low = Math.max(limitMin, next.high - MIN_THICKNESS);
            }
            next.outerHigh = Math.min(limitMax, next.high + marginHigh);
            next.outerLow = Math.min(next.outerLow, next.low);
        }

        this.commit(next);
    }

    private commit(value: RangeValue, notify = true) {
        const previous = this._value ?? { low: this.min, high: this.max, outerLow: this.min, outerHigh: this.max };
        const limitMin = Math.min(this.min, this.max);
        const limitMax = Math.max(this.min, this.max);
        const pick = (candidate: number, fallback: number) => {
            return Number.isFinite(candidate) ? clamp(snap(candidate), limitMin, limitMax) : fallback;
        };
        const next: RangeValue = {
            outerLow: pick(value.outerLow, previous.outerLow),
            low: pick(value.low, previous.low),
            high: pick(value.high, previous.high),
            outerHigh: pick(value.outerHigh, previous.outerHigh)
        };

        next.low = Math.max(next.low, next.outerLow);
        next.high = Math.min(next.high, next.outerHigh);
        next.outerLow = Math.min(next.outerLow, next.low);
        next.outerHigh = Math.max(next.outerHigh, next.high);

        // 保险：芯不许薄过一个步长。先试着把高端顶出去；顶不动（已经贴到值域上限）就把低端收回来，
        // 否则在 150 这种边界上两端会一起夹到同一个值、厚度变 0。
        if (next.high - next.low < MIN_THICKNESS) {
            next.high = Math.min(limitMax, snap(next.low + MIN_THICKNESS));
            if (next.high - next.low < MIN_THICKNESS) {
                next.low = Math.max(limitMin, snap(next.high - MIN_THICKNESS));
            }
        }
        // 修完再兜一次链式约束：外窗不许比芯更窄（否则下游会把芯拖回去、又塌成 0）
        next.outerLow = Math.min(next.outerLow, next.low);
        next.outerHigh = Math.max(next.outerHigh, next.high);

        this._value = next;
        this.render();
        if (notify) {
            this.onChange({ ...next });
        }
    }

    private render() {
        if (this.dragView) {
            this.view = { ...this.dragView };
        } else {
            this.computeView();
        }

        // 选中带按 **outer** 画：向外扩边时带要跟着长出来（否则用户看不到"扩展"这件事发生了），
        // 收芯时 outer 跟着 core 一起收，看起来与以前完全一致。
        const { outerLow, outerHigh } = this._value;
        const width = this.trackWidth();
        const blockWidth = this.blockWidth();
        const half = blockWidth / 2;

        // 停靠位置：没拖动时两个滑块钉在 HOME；拖动时被拖的那个跟着指针（夹在轨道里）
        let lowFraction = this.fractionOf(outerLow);
        let highFraction = this.fractionOf(outerHigh);
        if (this.dragging === 'low' && this.dragFraction !== null) {
            lowFraction = this.dragFraction;
        }
        if (this.dragging === 'high' && this.dragFraction !== null) {
            highFraction = this.dragFraction;
        }
        lowFraction = clamp(lowFraction, 0, 1);
        highFraction = clamp(highFraction, 0, 1);

        const lowPx = lowFraction * width;
        const highPx = highFraction * width;
        const from = Math.min(lowPx, highPx);
        const to = Math.max(lowPx, highPx);

        this.core.style.left = `${from}px`;
        this.core.style.width = `${Math.max(0, to - from)}px`;

        this.blocks.low.style.left = `${lowPx - half}px`;
        this.blocks.low.style.width = `${blockWidth}px`;
        this.blocks.high.style.left = `${highPx - half}px`;
        this.blocks.high.style.width = `${blockWidth}px`;

        this.handles.low.style.left = `${lowPx - half}px`;
        this.handles.low.style.width = `${blockWidth}px`;
        this.handles.high.style.left = `${highPx - half}px`;
        this.handles.high.style.width = `${blockWidth}px`;
    }
}

export { RangeSlider };
