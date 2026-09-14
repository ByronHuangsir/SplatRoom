import { Container, Label } from '@playcanvas/pcui';

import { i18n } from './localization';

/**
 * 四柄 range 控件，严格按设计稿的 `----o 近 o-------o 远 o----` 来排：
 *
 *   - **4 个圆柄都在同一条轨道上**：每端一对 = 外柄（扩边到哪）+ 内柄（现在选到哪）；
 *   - **轴标签（近/远、左/右、上/下）画在轨道上、就在那对柄的中间**（不是放在行两端）；
 *   - 两端露出的是空轨道（外扩余地），两个内柄之间是选区；
 *   - 两柄之间那一段（半透明橙）= 扩边多吃进来的部分，默认零扩边时是空的；
 *   - **行里没有数字框**：数值在拖动时贴在柄旁边浮出，平时收在柄的 tooltip 里。
 *
 * 为了让"一对柄"永远看得出是两个柄、并给中间的字留位置，外柄的**绘制位置**在离内柄太近时
 * 会往外让开一个"标签宽 + 6px"的固定间隙（纯视觉，数值语义不变：拖动时按这个间隙换算回真实值，
 * 所以柄始终跟着指针走）。零扩边时两个柄就是这样一个在里一个在外、中间是轴标签的样子。
 *
 * 拖动规则（链式约束 `outerLow ≤ low ≤ high ≤ outerHigh` 恒成立）：
 *   - 拖**内柄**：外柄跟着一起走（扩边量保持）→ 往里拖就是收边、整段一起缩；
 *   - 拖**外柄**往外：扩边量变大；往里越过内柄：扩边量先收到 0，再继续拖就顶着内柄一起走。
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

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

class RangeSlider {
    /** 整行（PCUI Container 的 dom），调用方把它 append 进面板 */
    row: HTMLElement;

    private track: HTMLDivElement;

    private fills: { marginLow: HTMLDivElement, core: HTMLDivElement, marginHigh: HTMLDivElement };

    private handles: Record<HandleName, HTMLDivElement>;

    private lowLabel: Label;

    private highLabel: Label;

    private readout: HTMLDivElement;

    private min: number;

    private max: number;

    private _value: RangeValue;

    private onChange: (value: RangeValue) => void;

    // which handle the current drag owns, and how far the pointer was from its value when the drag
    // started (grabbing a handle off-centre must not make it snap under the pointer)
    private dragging: HandleName | null = null;

    private grabOffset = 0;

    // the visual gap that keeps the two handles of a pair apart and leaves room for the label
    private gap = 34;

    // the labels the gap was measured for (so the reflow happens on locale changes only)
    private gapText = '';

    constructor(options: RangeSliderOptions) {
        const { axis, lowKey, highKey, min, max } = options;

        const row = new Container({ class: 'select-range-row' });
        row.dom.setAttribute('data-axis', axis);

        const lowLabel = new Label({ class: 'select-range-label', text: '' });
        i18n.bindText(lowLabel, lowKey);

        const highLabel = new Label({ class: 'select-range-label', text: '' });
        i18n.bindText(highLabel, highKey);

        // the track is plain DOM: PCUI's slider has a single handle and no range concept
        const track = document.createElement('div');
        track.classList.add('select-range-track');

        const marginLow = document.createElement('div');
        marginLow.classList.add('select-range-fill', 'select-range-margin', 'select-range-margin-low');
        const core = document.createElement('div');
        core.classList.add('select-range-fill');
        const marginHigh = document.createElement('div');
        marginHigh.classList.add('select-range-fill', 'select-range-margin', 'select-range-margin-high');

        const readout = document.createElement('div');
        readout.classList.add('select-range-readout');

        this.handles = {} as Record<HandleName, HTMLDivElement>;
        for (const name of HANDLES) {
            const handle = document.createElement('div');
            handle.classList.add('select-range-handle');
            handle.classList.add(SIDES[name] === 'low' ? 'select-range-handle-low' : 'select-range-handle-high');
            if (name === 'outerLow' || name === 'outerHigh') {
                handle.classList.add('select-range-handle-outer');
            }
            handle.setAttribute('data-handle', name);
            handle.tabIndex = 0;
            handle.title = i18n.t('select-toolbar.rangeHandleHint');
            this.handles[name] = handle;
        }

        // paint order: fills, then the outer rings, then the inner dots, then the labels and the
        // readout on top
        track.appendChild(marginLow);
        track.appendChild(core);
        track.appendChild(marginHigh);
        for (const name of ['outerLow', 'outerHigh'] as HandleName[]) {
            track.appendChild(this.handles[name]);
        }
        for (const name of ['low', 'high'] as HandleName[]) {
            track.appendChild(this.handles[name]);
        }

        const wrap = document.createElement('div');
        wrap.classList.add('select-range-track-wrap');
        wrap.appendChild(track);
        row.dom.appendChild(wrap);
        row.dom.appendChild(lowLabel.dom);
        row.dom.appendChild(highLabel.dom);
        row.dom.appendChild(readout);

        this.row = row.dom;
        this.track = track;
        this.fills = { marginLow, core, marginHigh };
        this.lowLabel = lowLabel;
        this.highLabel = highLabel;
        this.readout = readout;
        this.min = min;
        this.max = max;
        this._value = { ...options.value };
        this.onChange = options.onChange;

        this.commit(this._value, false);

        // dragging: capture on the track so the pointer can leave the small handle
        const beginDrag = (name: HandleName) => (e: PointerEvent) => {
            e.preventDefault();
            e.stopPropagation();
            this.dragging = name;
            this.grabOffset = this.valueForPointer(e.clientX, name) - this._value[name];
            track.setPointerCapture(e.pointerId);
            this.handles[name].classList.add('dragging');
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
                this.readout.classList.remove('visible');
                if (track.hasPointerCapture(e.pointerId)) {
                    track.releasePointerCapture(e.pointerId);
                }
            }
        };

        track.addEventListener('pointerup', endDrag);
        track.addEventListener('pointercancel', endDrag);

        // a click on the empty track moves the nearest handle there
        track.addEventListener('pointerdown', (e: PointerEvent) => {
            if (this.dragging) {
                return;
            }
            if (e.target === track || (e.target as HTMLElement).classList.contains('select-range-fill')) {
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
                this.setHandle(nearest, at);
                this.showReadout(nearest, this._value[nearest]);
            }
        });

        // keyboard: the handles are focusable, arrows nudge them
        for (const name of HANDLES) {
            this.handles[name].addEventListener('keydown', (e: KeyboardEvent) => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') {
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                const step = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1);
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

    /** 轨道上的像素位置 → 值（不考虑外柄的让位间隙）。 */
    private valueAt(clientX: number) {
        const rect = this.track.getBoundingClientRect();
        if (rect.width <= 0) {
            return this.min;
        }
        const fraction = clamp((clientX - rect.left) / rect.width, 0, 1);
        return this.min + (this.max - this.min) * fraction;
    }

    /**
     * 指针位置 → 该柄的值。外柄在"离内柄太近"时被绘制成让开一个间隙，所以指针要先补回间隙；
     * 一旦外柄的真实位置已经超出间隙（正在往外扩），就按真实位置换算 —— 两种情况在边界上连续。
     */
    private valueForPointer(clientX: number, name: HandleName) {
        if (name !== 'outerLow' && name !== 'outerHigh') {
            return this.valueAt(clientX);
        }
        const rect = this.track.getBoundingClientRect();
        const span = this.max - this.min;
        if (rect.width <= 0 || span === 0) {
            return this.min;
        }
        const gapValue = (this.gap / rect.width) * span;
        const side = SIDES[name];
        const inner = side === 'low' ? this._value.low : this._value.high;
        const innerPx = rect.left + ((inner - this.min) / span) * rect.width;
        if (side === 'low') {
            // the drawn position is min(valuePos, innerPos - gap)
            return clientX >= innerPx - this.gap ?
                this.valueAt(clientX + this.gap) : this.valueAt(clientX);
        }
        return clientX <= innerPx + this.gap ?
            this.valueAt(clientX - this.gap) : this.valueAt(clientX);
    }

    /**
     * 移动一个柄，并维持链式约束 `outerLow ≤ low ≤ high ≤ outerHigh`：
     *   - 内柄（low / high）：**外柄跟着一起走**（扩边量保持不变）—— 往里拖就是收边；
     *   - 外柄（outerLow / outerHigh）：往外拖 = 扩边量变大；往里拖过内柄 = 扩边量先收到 0，
     *     再继续拖就带着内柄一起走（把内柄顶过去）。
     */
    private setHandle(name: HandleName, rawValue: number) {
        const limitMin = Math.min(this.min, this.max);
        const limitMax = Math.max(this.min, this.max);
        const value = clamp(Math.round(rawValue), limitMin, limitMax);
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

    // normalized value, pushed into the DOM
    private commit(value: RangeValue, notify = true) {
        // a bad caller (or a stale stored value) must not render NaN% and blank the fields
        const previous = this._value ?? { low: this.min, high: this.max, outerLow: this.min, outerHigh: this.max };
        const pick = (candidate: number, fallback: number) => {
            return Number.isFinite(candidate) ? clamp(Math.round(candidate), this.min, this.max) : fallback;
        };
        const next: RangeValue = {
            outerLow: pick(value.outerLow, previous.outerLow),
            low: pick(value.low, previous.low),
            high: pick(value.high, previous.high),
            outerHigh: pick(value.outerHigh, previous.outerHigh)
        };

        // enforce the chain no matter what the caller passed
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

    /** 外柄让开的视觉间隙：够放下中间的轴标签，并留一点呼吸。 */
    private updateGap() {
        const text = `${this.lowLabel.text}|${this.highLabel.text}`;
        if (text === this.gapText) {
            return;
        }
        const width = Math.max(this.lowLabel.dom.offsetWidth, this.highLabel.dom.offsetWidth);
        if (width <= 0) {
            // not in the document yet (the panel is appended after construction): measure again
            // on the next render instead of caching a bogus width
            return;
        }
        this.gapText = text;
        // a 30px floor keeps the three rows visually aligned (the widest label here is two CJK
        // characters) while a long translation still gets the room it needs
        this.gap = Math.max(34, width + 8);
    }

    private render() {
        this.updateGap();

        const { low, high, outerLow, outerHigh } = this._value;
        const span = this.max - this.min;
        const percent = (value: number) => (span === 0 ? 0 : ((value - this.min) / span) * 100);

        const lowPct = percent(low);
        const highPct = percent(high);
        const outerLowPct = percent(outerLow);
        const outerHighPct = percent(outerHigh);

        // the outer handles are pushed outward when they would sit on top of their inner partner
        const drawnLow = `min(${outerLowPct}%, calc(${lowPct}% - ${this.gap}px))`;
        const drawnHigh = `max(${outerHighPct}%, calc(${highPct}% + ${this.gap}px))`;
        this.handles.low.style.left = `${lowPct}%`;
        this.handles.high.style.left = `${highPct}%`;
        this.handles.outerLow.style.left = drawnLow;
        this.handles.outerHigh.style.left = drawnHigh;

        // the labels sit halfway between the two *drawn* handles of their pair (which is what
        // puts them inside the pair even when the expansion is zero)
        this.lowLabel.dom.style.left = `calc((${drawnLow} + ${lowPct}%) / 2)`;
        this.highLabel.dom.style.left = `calc((${highPct}% + ${drawnHigh}) / 2)`;

        // the core band spans the inner handles, the margins the eaten part (empty when 0)
        this.fills.core.style.left = `${lowPct}%`;
        this.fills.core.style.width = `${highPct - lowPct}%`;
        this.fills.marginLow.style.left = drawnLow;
        this.fills.marginLow.style.width = `calc(${lowPct}% - (${drawnLow}))`;
        this.fills.marginHigh.style.left = drawnHigh;
        this.fills.marginHigh.style.width = `calc((${drawnHigh}) - ${highPct}%)`;
        this.fills.marginLow.classList[outerLow < low ? 'add' : 'remove']('visible');
        this.fills.marginHigh.classList[outerHigh > high ? 'add' : 'remove']('visible');

        // the values live in the tooltips: no numeric fields in the row (per the design)
        this.handles.outerLow.title = `${i18n.t('select-toolbar.rangeHandleHint')} — ${outerLow}`;
        this.handles.low.title = `${i18n.t('select-toolbar.rangeHandleHint')} — ${low}`;
        this.handles.high.title = `${i18n.t('select-toolbar.rangeHandleHint')} — ${high}`;
        this.handles.outerHigh.title = `${i18n.t('select-toolbar.rangeHandleHint')} — ${outerHigh}`;
    }

    /** 拖动时把数值贴在柄旁边浮出来（平时不占地方、也不显示数字框）。 */
    private showReadout(name: HandleName, value: number) {
        const target = this.handles[name];
        this.readout.textContent = String(value);
        this.readout.style.left = target.style.left;
        this.readout.classList.add('visible');
    }
}

export { RangeSlider };
