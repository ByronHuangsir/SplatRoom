import { Container, Label, NumericInput } from '@playcanvas/pcui';

import { i18n } from './localization';

/**
 * 四柄 range 控件：`外柄 …内柄` 一对夹住一个轴标签，两对之间是选区。
 *
 *   ----o 近 o-------o 远 o----      o = 滑块（外柄 / 内柄）
 *
 * 每个轴有两个"层次"：
 *   - **内柄**（内层的两个）= 选区边界（裁到哪），和上一版的双柄一样；
 *   - **外柄**（外层的两个）= **扩边到哪**：外柄与内柄之间那段（半透明橙）就是"扩边多吃进来的部分"。
 *
 * 两者默认重合（不扩边），此时行为与只有内柄时完全一致。拖动手感（链式约束
 * outerLow ≤ low ≤ high ≤ outerHigh 始终成立）：
 *   - 外柄**向外**拖 → 扩边量变大（选区变大）；
 *   - 外柄**向内**拖 → 先把扩边量收到 0，继续拖就带着内柄一起收（收边）；
 *   - 内柄向外拖 → 外柄跟着走（整段平移，扩边量保持）。
 *
 * 用 DOM 搭（PCUI 只有单柄滑块，也没有多柄 range）。拖动、点击轨道、方向键（Shift ×10）、
 * 数值框输入都能改；写回控件时用 `updating` 守卫（PCUI 赋值会触发 change），
 * `Number.isFinite` 兜底（坏值不会渲染成 NaN% 和空数值框）。
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

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

class RangeSlider {
    /** 整行（PCUI Container 的 dom），调用方把它 append 进面板 */
    row: HTMLElement;

    private inputs: Record<HandleName, NumericInput>;

    private track: HTMLDivElement;

    private fills: { marginLow: HTMLDivElement, core: HTMLDivElement, marginHigh: HTMLDivElement };

    private handles: Record<HandleName, HTMLDivElement>;

    private min: number;

    private max: number;

    private _value: RangeValue;

    private onChange: (value: RangeValue) => void;

    private updating = false;

    // which handle the current drag owns
    private dragging: HandleName | null = null;

    constructor(options: RangeSliderOptions) {
        const { axis, lowKey, highKey, min, max } = options;

        const row = new Container({ class: 'select-range-row' });
        row.dom.setAttribute('data-axis', axis);

        const lowLabel = new Label({ class: 'select-range-label', text: '' });
        i18n.bindText(lowLabel, lowKey);

        const highLabel = new Label({ class: 'select-range-label', text: '' });
        i18n.bindText(highLabel, highKey);

        const makeInput = (handle: HandleName) => {
            const input = new NumericInput({
                class: 'select-range-value',
                min,
                max,
                step: 1,
                precision: 0,
                value: 0
            });
            input.dom.setAttribute('data-handle', handle);
            return input;
        };

        this.inputs = {
            outerLow: makeInput('outerLow'),
            low: makeInput('low'),
            high: makeInput('high'),
            outerHigh: makeInput('outerHigh')
        };

        // the track is plain DOM: PCUI's slider has a single handle and no range concept
        const track = document.createElement('div');
        track.classList.add('select-range-track');

        const marginLow = document.createElement('div');
        marginLow.classList.add('select-range-fill', 'select-range-margin');
        const core = document.createElement('div');
        core.classList.add('select-range-fill');
        const marginHigh = document.createElement('div');
        marginHigh.classList.add('select-range-fill', 'select-range-margin');
        track.appendChild(marginLow);
        track.appendChild(core);
        track.appendChild(marginHigh);

        this.handles = {} as Record<HandleName, HTMLDivElement>;
        for (const name of HANDLES) {
            const handle = document.createElement('div');
            handle.classList.add('select-range-handle');
            if (name === 'outerLow' || name === 'outerHigh') {
                handle.classList.add('select-range-handle-outer');
            }
            handle.setAttribute('data-handle', name);
            handle.tabIndex = 0;
            handle.title = i18n.t('select-toolbar.rangeHandleHint');
            track.appendChild(handle);
            this.handles[name] = handle;
        }
        // the outer handles are drawn *under* the inner dots but are larger rings, so their rim
        // has to be the topmost thing there: the inner handles come after them in DOM order,
        // which would put the inner dot on top of the ring's rim as well
        for (const name of ['outerLow', 'outerHigh'] as HandleName[]) {
            this.handles[name].style.zIndex = '0';
        }
        for (const name of ['low', 'high'] as HandleName[]) {
            this.handles[name].style.zIndex = '1';
        }

        // layout: 最近 [外][内] [====track====] [内][外] 最远
        // the outer handle's field sits outside its inner one, mirroring the handles
        row.append(lowLabel);
        row.append(this.inputs.outerLow);
        row.append(this.inputs.low);
        const wrap = document.createElement('div');
        wrap.classList.add('select-range-track-wrap');
        wrap.appendChild(track);
        row.dom.appendChild(wrap);
        row.append(this.inputs.high);
        row.append(this.inputs.outerHigh);
        row.append(highLabel);

        this.row = row.dom;
        this.track = track;
        this.fills = { marginLow, core, marginHigh };
        this.min = min;
        this.max = max;
        this._value = { ...options.value };
        this.onChange = options.onChange;

        this.commit(this._value, false);

        for (const name of HANDLES) {
            this.inputs[name].on('change', (value: number) => {
                if (!this.updating) {
                    this.setHandle(name, value);
                }
            });
        }

        // dragging: capture on the track so the pointer can leave the small handle
        const beginDrag = (name: HandleName) => (e: PointerEvent) => {
            e.preventDefault();
            e.stopPropagation();
            this.dragging = name;
            track.setPointerCapture(e.pointerId);
            this.handles[name].classList.add('dragging');
        };

        for (const name of HANDLES) {
            this.handles[name].addEventListener('pointerdown', beginDrag(name));
        }

        track.addEventListener('pointermove', (e: PointerEvent) => {
            if (this.dragging) {
                this.setHandle(this.dragging, this.valueAt(e.clientX));
            }
        });

        const endDrag = (e: PointerEvent) => {
            if (this.dragging) {
                const name = this.dragging;
                this.dragging = null;
                this.handles[name].classList.remove('dragging');
                if (track.hasPointerCapture(e.pointerId)) {
                    track.releasePointerCapture(e.pointerId);
                }
            }
        };

        track.addEventListener('pointerup', endDrag);
        track.addEventListener('pointercancel', endDrag);

        // a click on the empty track moves the nearest handle there
        track.addEventListener('pointerdown', (e: PointerEvent) => {
            if (e.target === track || (e.target as HTMLElement).classList.contains('select-range-fill')) {
                e.preventDefault();
                e.stopPropagation();
                const position = this.valueAt(e.clientX);
                let nearest: HandleName = HANDLES[0];
                let best = Infinity;
                for (const name of HANDLES) {
                    const distance = Math.abs(this._value[name] - position);
                    if (distance < best) {
                        best = distance;
                        nearest = name;
                    }
                }
                this.dragging = nearest;
                track.setPointerCapture(e.pointerId);
                this.handles[nearest].classList.add('dragging');
                this.setHandle(nearest, position);
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

    private valueAt(clientX: number) {
        const rect = this.track.getBoundingClientRect();
        if (rect.width <= 0) {
            return this.min;
        }
        const fraction = clamp((clientX - rect.left) / rect.width, 0, 1);
        return this.min + (this.max - this.min) * fraction;
    }

    /**
     * 移动一个柄，并维持链式约束 `outerLow ≤ low ≤ high ≤ outerHigh`：
     *
     *   - 内柄（low / high）：**外柄跟着一起走**（扩边量保持不变）—— 所以把内柄往里拖就是"收边"，
     *     整段（含扩边带）一起缩；
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
                // dragged inward past the inner handle: the margin collapses, the box follows
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

    // normalized value, pushed into the DOM/inputs
    private commit(value: RangeValue, notify = true) {
        // a bad caller (or a stale stored value) must not render NaN% and blank fields
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

    private render() {
        const { low, high, outerLow, outerHigh } = this._value;
        const span = this.max - this.min;
        const percent = (value: number) => (span === 0 ? 0 : ((value - this.min) / span) * 100);

        this.fills.marginLow.style.left = `${percent(outerLow)}%`;
        this.fills.marginLow.style.width = `${percent(low) - percent(outerLow)}%`;
        this.fills.core.style.left = `${percent(low)}%`;
        this.fills.core.style.width = `${percent(high) - percent(low)}%`;
        this.fills.marginHigh.style.left = `${percent(high)}%`;
        this.fills.marginHigh.style.width = `${percent(outerHigh) - percent(high)}%`;

        for (const name of HANDLES) {
            this.handles[name].style.left = `${percent(this._value[name])}%`;
        }

        this.updating = true;
        for (const name of HANDLES) {
            this.inputs[name].value = this._value[name];
        }
        this.updating = false;
    }
}

export { RangeSlider };
