import { Container, Label, NumericInput } from '@playcanvas/pcui';

import { i18n } from './localization';

/**
 * 双柄 range 控件：`低端标签 [====●------●====] 高端标签`，两个柄之间亮起来的那段就是"选中的部分"。
 *
 * PCUI 只有单柄 `SliderInput`，把两个单柄并排放并不能表达"两个柄夹住的是一段区间"，
 * 所以这里自己用 DOM 搭（外观沿用 PCUI 的配色变量，见 select-toolbar.scss）：
 *
 *   - 拖柄：pointerdown 在柄上 → 轨道 setPointerCapture → pointermove 换算成百分比（按 step 吸附）；
 *   - 越过对面：拖低柄越过高柄会把高柄一起顶过去（整段平移的手感），反之亦然；
 *   - 两个数值框可以精确输入，回车/失焦都会写进去（写回控件时用 `updating` 守卫，PCUI 赋值会触发 change）；
 *   - 点击轨道空白处 = 移动最近的那个柄。
 *
 * 值域固定 0-100（百分比），语义由调用方决定（深度、左右、上下）。
 */
export interface RangeValue {
    low: number;
    high: number;
}

export interface RangeSliderOptions {
    /** data-axis 属性值（验证脚本用它定位某一轴） */
    axis: string;
    /** 低端 / 高端标签的本地化键 */
    lowKey: string;
    highKey: string;
    /** 初始值 */
    value: RangeValue;
    /** 拖动或输入时回调（已经夹好范围、按 step 吸附） */
    onChange: (value: RangeValue) => void;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

class RangeSlider {
    /** 整行（PCUI Container 的 dom），调用方把它 append 进面板 */
    row: HTMLElement;

    private lowInput: NumericInput;

    private highInput: NumericInput;

    private track: HTMLDivElement;

    private fill: HTMLDivElement;

    private handles: { low: HTMLDivElement, high: HTMLDivElement };

    private _value: RangeValue;

    private onChange: (value: RangeValue) => void;

    private updating = false;

    // which handle the current drag owns
    private dragging: 'low' | 'high' | null = null;

    constructor(options: RangeSliderOptions) {
        const { axis, lowKey, highKey } = options;

        const row = new Container({ class: 'select-range-row' });
        row.dom.setAttribute('data-axis', axis);

        const lowLabel = new Label({ class: 'select-range-label', text: '' });
        i18n.bindText(lowLabel, lowKey);

        const highLabel = new Label({ class: 'select-range-label', text: '' });
        i18n.bindText(highLabel, highKey);

        const lowInput = new NumericInput({
            class: 'select-range-value',
            min: 0,
            max: 100,
            step: 1,
            precision: 0,
            value: options.value.low
        });
        lowInput.dom.setAttribute('data-handle', 'low');

        const highInput = new NumericInput({
            class: 'select-range-value',
            min: 0,
            max: 100,
            step: 1,
            precision: 0,
            value: options.value.high
        });
        highInput.dom.setAttribute('data-handle', 'high');

        // the track is plain DOM: PCUI's slider has a single handle and no range concept
        const track = document.createElement('div');
        track.classList.add('select-range-track');

        const fill = document.createElement('div');
        fill.classList.add('select-range-fill');
        track.appendChild(fill);

        const handles = {
            low: document.createElement('div'),
            high: document.createElement('div')
        };
        for (const side of ['low', 'high'] as const) {
            handles[side].classList.add('select-range-handle');
            handles[side].setAttribute('data-handle', side);
            handles[side].tabIndex = 0;
            track.appendChild(handles[side]);
        }

        row.append(lowLabel);
        row.append(lowInput);
        // the track lives in a plain wrapper div so the flex row can size it
        const wrap = document.createElement('div');
        wrap.classList.add('select-range-track-wrap');
        wrap.appendChild(track);
        row.dom.appendChild(wrap);
        row.append(highInput);
        row.append(highLabel);

        this.row = row.dom;
        this.lowInput = lowInput;
        this.highInput = highInput;
        this.track = track;
        this.fill = fill;
        this.handles = handles;
        this._value = { low: options.value.low, high: options.value.high };
        this.onChange = options.onChange;

        this.apply(this._value);

        lowInput.on('change', (value: number) => {
            if (!this.updating) {
                this.commit({ low: value, high: this._value.high });
            }
        });

        highInput.on('change', (value: number) => {
            if (!this.updating) {
                this.commit({ low: this._value.low, high: value });
            }
        });

        // dragging: capture on the track so the pointer can leave the small handle
        const beginDrag = (side: 'low' | 'high') => (e: PointerEvent) => {
            e.preventDefault();
            e.stopPropagation();
            this.dragging = side;
            track.setPointerCapture(e.pointerId);
            this.handles[side].classList.add('dragging');
        };

        handles.low.addEventListener('pointerdown', beginDrag('low'));
        handles.high.addEventListener('pointerdown', beginDrag('high'));

        track.addEventListener('pointermove', (e: PointerEvent) => {
            if (this.dragging) {
                this.dragTo(this.dragging, e.clientX);
            }
        });

        const endDrag = (e: PointerEvent) => {
            if (this.dragging) {
                const side = this.dragging;
                this.dragging = null;
                this.handles[side].classList.remove('dragging');
                if (track.hasPointerCapture(e.pointerId)) {
                    track.releasePointerCapture(e.pointerId);
                }
            }
        };

        track.addEventListener('pointerup', endDrag);
        track.addEventListener('pointercancel', endDrag);

        // a click on the empty track moves the nearer handle there
        track.addEventListener('pointerdown', (e: PointerEvent) => {
            if (e.target === track || e.target === fill) {
                e.preventDefault();
                e.stopPropagation();
                const pct = this.percentAt(e.clientX);
                const side = Math.abs(pct - this.value.low) <= Math.abs(pct - this.value.high) ? 'low' : 'high';
                this.dragging = side;
                track.setPointerCapture(e.pointerId);
                this.handles[side].classList.add('dragging');
                this.dragTo(side, e.clientX);
            }
        });

        // keyboard: the handles are focusable, arrows nudge them
        for (const side of ['low', 'high'] as const) {
            handles[side].addEventListener('keydown', (e: KeyboardEvent) => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') {
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                const delta = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1);
                const next = { ...this.value };
                next[side] += delta;
                this.commit(next);
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

    private percentAt(clientX: number) {
        const rect = this.track.getBoundingClientRect();
        if (rect.width <= 0) {
            return 0;
        }
        return clamp(((clientX - rect.left) / rect.width) * 100, 0, 100);
    }

    private dragTo(side: 'low' | 'high', clientX: number) {
        const pct = Math.round(this.percentAt(clientX));
        const next = { ...this._value };
        next[side] = pct;
        this.commit(next);
    }

    // normalized + ordered value, pushed into the DOM/inputs
    private commit(value: RangeValue, notify = true) {
        // Number.isFinite guards a NaN slipping in (a bad caller would otherwise render
        // "NaN%" and blank the numeric fields)
        const low = Number.isFinite(value.low) ? clamp(Math.round(value.low), 0, 100) : this._value.low;
        const high = Number.isFinite(value.high) ? clamp(Math.round(value.high), 0, 100) : this._value.high;
        const next = low <= high ? { low, high } : { low: high, high: low };
        this._value = next;
        this.render();
        if (notify) {
            this.onChange({ ...next });
        }
    }

    private render() {
        const { low, high } = this._value;
        this.handles.low.style.left = `${low}%`;
        this.handles.high.style.left = `${high}%`;
        this.fill.style.left = `${low}%`;
        this.fill.style.width = `${high - low}%`;

        this.updating = true;
        this.lowInput.value = low;
        this.highInput.value = high;
        this.updating = false;
    }

    /** 初值写入：构造函数里走 commit 但不回调（还没有值可用）。 */
    private apply(value: RangeValue) {
        this.commit(value, false);
    }
}

export { RangeSlider };
