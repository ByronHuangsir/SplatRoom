import { Container, Label } from '@playcanvas/pcui';

import { i18n } from './localization';

/**
 * 四值 range 控件（外柄 / 内柄一对），视觉按设计稿 `选择范围设计.png` 来：
 *
 *   一条细轨，两端各一个**长方形块**，块里写着轴标签（最近 / 最远、左 / 右、上 / 下）；
 *   两个块的内边之间（橙色）是选中的部分。
 *
 * 每个块对应一对值：
 *   - **内边 = 选区边界**（内柄）：往中间拖就是收边；
 *   - **外边 = 扩边到哪**（外柄）：往外拖扩边量变大；往里拖过内边 = 扩边量先收到 0，再顶着内边一起走。
 *   块会跟着扩边量变宽，所以"扩边吃进去多少"直接看得见。
 *
 * 两半各是一个隐形抓手（块的外半 = 外柄、内半 = 内柄），所以块再窄也抓得准，不会两个柄打架。
 *
 * **非线性映射**：轨道位置 t ∈ [0,1] 与值之间不是直线，而是
 *   `s = 2t-1; 值 = 中心值 + 半宽 * s * (β + (1-β)s²)`（β = 0.35）
 * 于是**靠近轨道中心（= 包围盒中心）时每像素只动很少的值，越靠两端越快**：
 * 中心 ≈0.08 值/px（比线性细约 6 倍，能精确收到很窄的一段），两端 ≈0.56 值/px（比线性粗，
 * 扩边这种"大范围"动作不用拖半天）。这正是用户要的："高斯集中在包围盒中心，往回收的时候
 * 要收到两个滑块非常接近"，所以中心必须给足分辨率。
 *
 * 步长 0.1，所以非线性最细的那段也不会一跳一跳。
 */
export interface RangeValue {
    /** 内柄：选区边界 */
    low: number;
    high: number;
    /** 外柄：扩边到哪（默认等于 low / high = 不扩边） */
    outerLow: number;
    outerHigh: number;
}

export interface RangeSliderOptions {
    /** data-axis 属性值（验证脚本用它定位某一轴） */
    axis: string;
    /** 低端 / 高端标签的本地化键 */
    lowKey: string;
    highKey: string;
    /** 轨道值域（外柄能到的最外位置；内柄同域，便于整体外移） */
    min: number;
    max: number;
    /** 初始值 */
    value: RangeValue;
    /** 拖动或输入时回调（已经夹好范围、按 step 吸附、链式约束修好） */
    onChange: (value: RangeValue) => void;
}

type HandleName = 'outerLow' | 'low' | 'high' | 'outerHigh';

const HANDLES: HandleName[] = ['outerLow', 'low', 'high', 'outerHigh'];
const SIDES: Record<HandleName, 'low' | 'high'> = {
    outerLow: 'low',
    low: 'low',
    high: 'high',
    outerHigh: 'high'
};

const STEP = 0.1;
// fraction -> value 曲线的形状参数：中心处的斜率（相对线性），越小中心越精细
const FISHEYE = 0.35;
// 反解表的采样数
const TABLE_SIZE = 1024;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const snap = (value: number) => Math.round(value / STEP) * STEP;

class RangeSlider {
    /** 整行（PCUI Container 的 dom），调用方把它 append 进面板 */
    row: HTMLElement;

    private track: HTMLDivElement;

    private core: HTMLDivElement;

    private blocks: { low: HTMLDivElement, high: HTMLDivElement };

    private handles: Record<HandleName, HTMLDivElement>;

    private labels: { low: Label, high: Label };

    private readout: HTMLDivElement;

    private min: number;

    private max: number;

    private _value: RangeValue;

    private onChange: (value: RangeValue) => void;

    private dragging: HandleName | null = null;

    private grabOffset = 0;

    // 反解表：归一化值 -> 轨道位置 t
    private table: Float64Array;

    constructor(options: RangeSliderOptions) {
        const { axis, lowKey, highKey, min, max } = options;

        const row = new Container({ class: 'select-range-row' });
        row.dom.setAttribute('data-axis', axis);

        const track = document.createElement('div');
        track.classList.add('select-range-track');

        const core = document.createElement('div');
        core.classList.add('select-range-fill', 'select-range-core');

        const readout = document.createElement('div');
        readout.classList.add('select-range-readout');

        this.blocks = {} as { low: HTMLDivElement, high: HTMLDivElement };
        this.labels = {} as { low: Label, high: Label };
        this.handles = {} as Record<HandleName, HTMLDivElement>;

        const makeBlock = (side: 'low' | 'high', key: string) => {
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

        // paint order: rail, selection band, the two blocks (with their labels), the invisible
        // grips on top, then the transient readout
        track.appendChild(core);
        track.appendChild(this.blocks.low);
        track.appendChild(this.blocks.high);
        for (const name of HANDLES) {
            track.appendChild(this.handles[name]);
        }
        track.appendChild(readout);

        const wrap = document.createElement('div');
        wrap.classList.add('select-range-track-wrap');
        wrap.appendChild(track);
        row.dom.appendChild(wrap);

        this.row = row.dom;
        this.track = track;
        this.core = core;
        this.readout = readout;
        this.min = min;
        this.max = max;
        this._value = { ...options.value };
        this.onChange = options.onChange;
        this.table = this.buildTable();

        this.commit(this._value, false);

        const beginDrag = (name: HandleName) => (e: PointerEvent) => {
            e.preventDefault();
            e.stopPropagation();
            this.dragging = name;
            this.grabOffset = this.valueForPointer(e.clientX, name) - this._value[name];
            track.setPointerCapture(e.pointerId);
            this.handles[name].classList.add('dragging');
            this.blocks[SIDES[name]].classList.add('dragging');
            this.showReadout(name, this._value[name]);
        };

        for (const name of HANDLES) {
            this.handles[name].addEventListener('pointerdown', beginDrag(name));
        }

        track.addEventListener('pointermove', (e: PointerEvent) => {
            if (this.dragging) {
                const value = this.valueForPointer(e.clientX, this.dragging) - this.grabOffset;
                this.setHandle(this.dragging, value);
                this.showReadout(this.dragging, this._value[this.dragging]);
            }
        });

        const endDrag = (e: PointerEvent) => {
            if (this.dragging) {
                const name = this.dragging;
                this.dragging = null;
                this.handles[name].classList.remove('dragging');
                this.blocks.low.classList.remove('dragging');
                this.blocks.high.classList.remove('dragging');
                this.readout.classList.remove('visible');
                if (track.hasPointerCapture(e.pointerId)) {
                    track.releasePointerCapture(e.pointerId);
                }
            }
        };

        track.addEventListener('pointerup', endDrag);
        track.addEventListener('pointercancel', endDrag);

        // a click on the bare rail moves the nearest bound there
        track.addEventListener('pointerdown', (e: PointerEvent) => {
            if (this.dragging) {
                return;
            }
            if (e.target === track || e.target === core) {
                e.preventDefault();
                e.stopPropagation();
                const at = this.valueAt(e.clientX);
                let nearest: HandleName = HANDLES[0];
                let best = Infinity;
                for (const name of HANDLES) {
                    const distance = Math.abs(this._value[name] - at);
                    if (distance < best) {
                        best = distance;
                        nearest = name;
                    }
                }
                this.dragging = nearest;
                this.grabOffset = 0;
                track.setPointerCapture(e.pointerId);
                this.handles[nearest].classList.add('dragging');
                this.blocks[SIDES[nearest]].classList.add('dragging');
                this.setHandle(nearest, at);
                this.showReadout(nearest, this._value[nearest]);
            }
        });

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

    /** t -> 归一化值（0..1），带鱼眼：中心细、两端粗。 */
    private shape(t: number) {
        const s = 2 * clamp(t, 0, 1) - 1;
        return 0.5 + 0.5 * s * (FISHEYE + (1 - FISHEYE) * s * s);
    }

    // 反解用的采样表（shape 单调，线性插值足够精确）
    private buildTable() {
        const table = new Float64Array(TABLE_SIZE + 1);
        for (let i = 0; i <= TABLE_SIZE; i++) {
            const target = i / TABLE_SIZE;
            let lo = 0;
            let hi = 1;
            for (let k = 0; k < 40; k++) {
                const mid = (lo + hi) / 2;
                if (this.shape(mid) < target) {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            table[i] = (lo + hi) / 2;
        }
        return table;
    }

    /** 值 -> 轨道位置（0..1）。 */
    private fractionOf(value: number) {
        const span = this.max - this.min;
        if (span === 0) {
            return 0;
        }
        const normalized = clamp((value - this.min) / span, 0, 1);
        const index = normalized * TABLE_SIZE;
        const lo = Math.floor(index);
        const hi = Math.min(TABLE_SIZE, lo + 1);
        const f = index - lo;
        return this.table[lo] * (1 - f) + this.table[hi] * f;
    }

    /** 轨道位置（0..1）-> 值。 */
    private valueOf(fraction: number) {
        return this.min + (this.max - this.min) * this.shape(fraction);
    }

    private trackRect() {
        return this.track.getBoundingClientRect();
    }

    private valueAt(clientX: number) {
        const rect = this.trackRect();
        if (rect.width <= 0) {
            return this.min;
        }
        return this.valueOf((clientX - rect.left) / rect.width);
    }

    /**
     * 指针位置 → 该柄的值。外柄那个块的绘制外边在"贴着内边"时会被撑到最小块宽，所以指针要先补回
     * 这段；真实外柄一旦超出块宽就按真实位置换算 —— 两者在边界上连续。
     */
    private valueForPointer(clientX: number, name: HandleName) {
        const rect = this.trackRect();
        if (name !== 'outerLow' && name !== 'outerHigh' || rect.width <= 0) {
            return this.valueAt(clientX);
        }
        const side = SIDES[name];
        const inner = side === 'low' ? this._value.low : this._value.high;
        const innerPx = rect.left + this.fractionOf(inner) * rect.width;
        const blockPx = this.minBlockWidth();
        const outerPx = rect.left + this.fractionOf(this._value[name]) * rect.width;
        const drawnPx = side === 'low' ?
            Math.min(outerPx, innerPx - blockPx) : Math.max(outerPx, innerPx + blockPx);
        // the pointer sits on the drawn edge; shift it by (drawn - true) to get the value
        return this.valueAt(clientX - (drawnPx - outerPx));
    }

    /** 块的视觉最小宽度：装得下标签（再窄标签就藏起来，但内边位置永远是真的）。 */
    private minBlockWidth() {
        const width = Math.max(this.labels.low.dom.offsetWidth, this.labels.high.dom.offsetWidth);
        return Math.max(30, width + 16);
    }

    /**
     * 移动一个柄，维持链式约束 `outerLow ≤ low ≤ high ≤ outerHigh`：
     *   - 内柄：外柄跟着走（扩边量保持）→ 往里拖就是收边；
     *   - 外柄：往外拖扩边；越过内柄先把扩边收到 0，再顶着内柄走。
     */
    private setHandle(name: HandleName, rawValue: number) {
        const limitMin = Math.min(this.min, this.max);
        const limitMax = Math.max(this.min, this.max);
        const value = clamp(snap(rawValue), limitMin, limitMax);
        const next = { ...this._value };
        const marginLow = next.low - next.outerLow;
        const marginHigh = next.outerHigh - next.high;

        if (name === 'low') {
            next.low = value;
            if (next.low > next.high) {
                next.high = next.low;
                next.outerHigh = next.high + marginHigh;
            }
            next.outerLow = next.low - marginLow;
        } else if (name === 'high') {
            next.high = value;
            if (next.high < next.low) {
                next.low = next.high;
                next.outerLow = next.low - marginLow;
            }
            next.outerHigh = next.high + marginHigh;
        } else if (name === 'outerLow') {
            if (value <= next.low) {
                next.outerLow = value;
            } else {
                next.low = value;
                next.outerLow = value;
                if (next.low > next.high) {
                    next.high = next.low;
                    next.outerHigh = Math.max(next.outerHigh, next.high);
                }
            }
            next.outerLow = Math.min(next.outerLow, next.low);
        } else {
            if (value >= next.high) {
                next.outerHigh = value;
            } else {
                next.high = value;
                next.outerHigh = value;
                if (next.high < next.low) {
                    next.low = next.high;
                    next.outerLow = Math.min(next.outerLow, next.low);
                }
            }
            next.outerHigh = Math.max(next.outerHigh, next.high);
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

        this._value = next;
        this.render();
        if (notify) {
            this.onChange({ ...next });
        }
    }

    private render() {
        const { low, high, outerLow, outerHigh } = this._value;
        const rect = this.trackRect();
        const width = rect.width || 1;
        const blockPx = this.minBlockWidth();

        const px = (value: number) => this.fractionOf(value) * width;
        const lowPx = px(low);
        const highPx = px(high);
        const outerLowPx = px(outerLow);
        const outerHighPx = px(outerHigh);

        // the blocks: [drawn outer edge, inner edge]; the inner edge is always the real bound
        const lowBlockOuter = Math.min(outerLowPx, lowPx - blockPx);
        const highBlockOuter = Math.max(outerHighPx, highPx + blockPx);
        const lowWidth = Math.max(0, lowPx - lowBlockOuter);
        const highWidth = Math.max(0, highBlockOuter - highPx);

        this.blocks.low.style.left = `${lowBlockOuter}px`;
        this.blocks.low.style.width = `${lowWidth}px`;
        this.blocks.high.style.left = `${highPx}px`;
        this.blocks.high.style.width = `${highWidth}px`;

        // the orange band between the two inner edges = what is selected
        this.core.style.left = `${lowPx}px`;
        this.core.style.width = `${Math.max(0, highPx - lowPx)}px`;

        // grips: each block's outer half drives the outer value (扩边), the inner half the bound
        const half = (span: number) => Math.max(8, span / 2);
        this.handles.low.style.left = `${lowBlockOuter + lowWidth / 2}px`;
        this.handles.low.style.width = `${half(lowWidth)}px`;
        this.handles.outerLow.style.left = `${lowBlockOuter}px`;
        this.handles.outerLow.style.width = `${half(lowWidth)}px`;
        this.handles.high.style.left = `${highPx}px`;
        this.handles.high.style.width = `${half(highWidth)}px`;
        this.handles.outerHigh.style.left = `${highPx + highWidth / 2}px`;
        this.handles.outerHigh.style.width = `${half(highWidth)}px`;

        // values live in the tooltips (no numeric fields in a row, per the design)
        const hint = i18n.t('select-toolbar.rangeHandleHint');
        this.handles.outerLow.title = `${hint} — 扩边 ${outerLow.toFixed(1)}`;
        this.handles.low.title = `${hint} — 边界 ${low.toFixed(1)}`;
        this.handles.high.title = `${hint} — 边界 ${high.toFixed(1)}`;
        this.handles.outerHigh.title = `${hint} — 扩边 ${outerHigh.toFixed(1)}`;

        // hide a label before the squeezed block clips it
        const labelWidth = this.labels.low.dom.offsetWidth;
        this.labels.low.dom.style.visibility = lowWidth >= labelWidth ? 'visible' : 'hidden';
        this.labels.high.dom.style.visibility = highWidth >= labelWidth ? 'visible' : 'hidden';
    }

    /** 拖动时把数值贴在块旁边浮出来（平时不显示任何数字）。 */
    private showReadout(name: HandleName, value: number) {
        const handle = this.handles[name];
        this.readout.textContent = value.toFixed(1);
        this.readout.style.left = handle.style.left;
        this.readout.style.width = handle.style.width;
        this.readout.classList.add('visible');
    }
}

export { RangeSlider };
