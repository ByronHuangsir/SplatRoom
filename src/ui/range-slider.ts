import { Container, Label } from '@playcanvas/pcui';

import { i18n } from './localization';
import { MIN_THICKNESS } from '../core/selection-flags';

/**
 * 选区范围的一行（一个轴）：一条细轨 + 两端各一个**固定尺寸的方块滑块**（块里写轴标签），
 * 中间橙色带是选中的部分。方块外侧各有一条细柄 = 扩边（外柄），它与方块之间的暗橙带 =
 * 扩边吃进去的部分。
 *
 *   ▐█████████▌  ← 外柄（细柄，扩边到哪）
 *     ┌──────┐
 *   ══╡ 最近 ╞══════════ 选区 ══════════╡ 最远 ╞══
 *     └──────┘
 *
 * **滑块本身永远不变**（方块宽度只由标签决定，细柄固定 8px），变的只有**尺度**：
 * 轨道不是把整个值域铺满，而是显示一段**自适应窗口** `[viewMin, viewMax]`，窗口在窗口内是**线性**
 * 映射。窗口每次都按当前四个值算出来：
 *
 *   1. 至少盖住四个值（含 25% 余量），这样外柄永远够得着；
 *   2. **两个方块（选区内边）之间至少占窗口的 1/ZOOM**（ZOOM = 3.5，即约 28%、440px 轨道里约 126px）；
 *   3. 窗口以两个方块的中点为中点，最后夹回值域。
 *
 * 于是：**两个滑块越靠近，窗口越小、它们之间的刻度越细**（"变化越慢"），而它们之间的像素距离
 * 永远不会小到没法操作 —— 厚度收到很窄时也不用小心翼翼地调。拖动时窗口跟着值实时重算，被拖的
 * 那个柄始终贴在指针下（值由指针位置经当前窗口换算），另一个柄随着窗口缩放自动让开空间。
 */
export interface RangeValue {
    /** 内柄（方块）：选区边界 */
    low: number;
    high: number;
    /** 外柄（细柄）：扩边到哪（默认等于 low / high = 不扩边） */
    outerLow: number;
    outerHigh: number;
}

export interface RangeSliderOptions {
    /** data-axis 属性值（验证脚本用它定位某一轴） */
    axis: string;
    /** 低端 / 高端标签的本地化键 */
    lowKey: string;
    highKey: string;
    /** 轨道值域上下限（外柄能到的最外位置） */
    min: number;
    max: number;
    /** 初始值 */
    value: RangeValue;
    /** 拖动时回调（已夹好范围、按 step 吸附、链式约束修好） */
    onChange: (value: RangeValue) => void;
}

type HandleName = 'outerLow' | 'low' | 'high' | 'outerHigh';

const HANDLES: HandleName[] = ['outerLow', 'low', 'high', 'outerHigh'];

const STEP = 0.1;
// 两个方块之间的像素距离至少占轨道的 1/ZOOM
const ZOOM = 3.5;
// 窗口的最小值跨度：正好 = ZOOM × 步长，也就是"最薄的合法厚度（0.1）也仍然拿到完整的
// 轨道 1/ZOOM 间隙"。同时它兜住四个值完全重合时的除零。
const MIN_SPAN = ZOOM * STEP;
// 方块 / 细柄的固定尺寸（见 scss）
const BLOCK_PADDING = 14;
const OUTER_HANDLE_WIDTH = 8;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const snap = (value: number) => Math.round(value / STEP) * STEP;

class RangeSlider {
    /** 整行（PCUI Container 的 dom），调用方把它 append 进面板 */
    row: HTMLElement;

    private track: HTMLDivElement;

    private bands: { marginLow: HTMLDivElement, core: HTMLDivElement, marginHigh: HTMLDivElement };

    private blocks: { low: HTMLDivElement, high: HTMLDivElement };

    private handles: Record<HandleName, HTMLDivElement>;

    private labels: { low: Label, high: Label };

    private readout: HTMLDivElement;

    private min: number;

    private max: number;

    private _value: RangeValue;

    private onChange: (value: RangeValue) => void;

    private dragging: HandleName | null = null;

    // 拖动期间**整张映射表冻结**：pointerdown 那一刻的窗口（比例尺 + 原点）锁死，值严格按指针位移
    // 线性走（1px = span/轨道 宽度的值，全程不变）。以前窗口会跟着值实时收缩，于是拖到一半灵敏度
    // 突然变细、滑块开始落后于指针（实测落后 12px、灵敏度从每 22px 10 个单位掉到 1.8）——
    // 用户的原话是"非线性变化的尺度……很麻烦，而且不直观"。冻结后拖动永远跟手。
    private dragView: { min: number, max: number } | null = null;

    private dragGrabX = 0;

    private dragGrabValue = 0;

    // the visible value window (linear mapping inside it)
    private view = { min: 0, max: 100 };

    constructor(options: RangeSliderOptions) {
        const { axis, lowKey, highKey, min, max } = options;

        const row = new Container({ class: 'select-range-row' });
        row.dom.setAttribute('data-axis', axis);

        const track = document.createElement('div');
        track.classList.add('select-range-track');

        const marginLow = document.createElement('div');
        marginLow.classList.add('select-range-band', 'select-range-margin');
        const core = document.createElement('div');
        core.classList.add('select-range-band', 'select-range-core');
        const marginHigh = document.createElement('div');
        marginHigh.classList.add('select-range-band', 'select-range-margin');

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
            if (name === 'outerLow' || name === 'outerHigh') {
                handle.classList.add('select-range-handle-outer');
            }
            handle.setAttribute('data-handle', name);
            handle.tabIndex = 0;
            handle.title = i18n.t('select-toolbar.rangeHandleHint');
            this.handles[name] = handle;
        }

        // paint order: rail, bands, outer bars, the two labelled blocks, then the readout
        track.appendChild(marginLow);
        track.appendChild(core);
        track.appendChild(marginHigh);
        track.appendChild(this.handles.outerLow);
        track.appendChild(this.handles.outerHigh);
        track.appendChild(this.blocks.low);
        track.appendChild(this.blocks.high);
        track.appendChild(this.handles.low);
        track.appendChild(this.handles.high);
        track.appendChild(readout);

        const wrap = document.createElement('div');
        wrap.classList.add('select-range-track-wrap');
        wrap.appendChild(track);
        row.dom.appendChild(wrap);

        this.row = row.dom;
        this.track = track;
        this.bands = { marginLow, core, marginHigh };
        this.readout = readout;
        this.min = min;
        this.max = max;
        this._value = { ...options.value };
        this.onChange = options.onChange;

        this.commit(this._value, false);

        const beginDrag = (name: HandleName) => (e: PointerEvent) => {
            e.preventDefault();
            e.stopPropagation();
            this.dragging = name;
            // the scale you see when you grab is the scale you get for the whole drag
            this.computeView();
            this.dragView = { ...this.view };
            this.dragGrabX = e.clientX;
            this.dragGrabValue = this._value[name];
            track.setPointerCapture(e.pointerId);
            this.handles[name].classList.add('dragging');
            this.blocks.low.classList[name === 'low' ? 'add' : 'remove']('dragging');
            this.blocks.high.classList[name === 'high' ? 'add' : 'remove']('dragging');
            this.showReadout(name, this._value[name]);
        };

        // the whole labelled block is the grab surface for its bound
        this.blocks.low.addEventListener('pointerdown', beginDrag('low'));
        this.blocks.high.addEventListener('pointerdown', beginDrag('high'));
        this.handles.low.addEventListener('pointerdown', beginDrag('low'));
        this.handles.high.addEventListener('pointerdown', beginDrag('high'));
        this.handles.outerLow.addEventListener('pointerdown', beginDrag('outerLow'));
        this.handles.outerHigh.addEventListener('pointerdown', beginDrag('outerHigh'));

        track.addEventListener('pointermove', (e: PointerEvent) => {
            if (!this.dragging || !this.dragView) {
                return;
            }
            const rect = this.trackRect();
            if (rect.width <= 0) {
                return;
            }
            const span = this.dragView.max - this.dragView.min;
            // 1:1 with the pointer and a constant span -> the handle never drifts away from the finger
            const value = this.dragGrabValue + ((e.clientX - this.dragGrabX) / rect.width) * span;
            this.setHandle(this.dragging, value);
            // 贴到轨道两端就平移窗口（用落定后的值算，否则 0.1 的吸附会让柄来回跳）
            if (this.panForValue(this._value[this.dragging])) {
                this.render();
            }
            this.showReadout(this.dragging, this._value[this.dragging]);
        });

        const endDrag = (e: PointerEvent) => {
            if (this.dragging) {
                const name = this.dragging;
                this.dragging = null;
                // unfreeze: the rail re-fits the settled selection (the two blocks always come back to
                // at least 1/ZOOM of the track apart), so a very thin slab gets its fine scale back
                this.dragView = null;
                this.render();
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
     * 自适应窗口：至少盖住四个值（含 25% 余量），且让两个方块之间至少占轨道的 1 个 ZOOM，
     * 以两个方块的中点为中点，最后夹回值域。**只在不拖动时算** —— 拖动期间用冻结的窗口。
     */
    private computeView() {
        const { low, high, outerLow, outerHigh } = this._value;
        const domainSpan = this.max - this.min;
        const allMin = Math.min(low, outerLow);
        const allMax = Math.max(high, outerHigh);
        const innerSpan = high - low;
        const center = (low + high) / 2;

        // padding in value units that corresponds to the block footprint on screen
        const padUnits = (this.blockWidth() * 0.75 / this.trackWidth()) * Math.max(innerSpan, MIN_SPAN);
        const padding = Math.max(padUnits, (allMax - allMin) * 0.12);

        const span = Math.min(
            domainSpan,
            Math.max((allMax - allMin) + padding * 2, innerSpan * ZOOM, MIN_SPAN)
        );

        let viewMin = center - span / 2;
        let viewMax = center + span / 2;

        // keep the whole domain covered when the window is the full domain, otherwise shift it inside
        if (span >= domainSpan) {
            this.view = { min: this.min, max: this.max };
            return;
        }
        if (viewMin < this.min) {
            viewMin = this.min;
            viewMax = viewMin + span;
        }
        if (viewMax > this.max) {
            viewMax = this.max;
            viewMin = viewMax - span;
        }
        this.view = { min: viewMin, max: viewMax };
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
     * 拖动时如果被拖的柄贴到轨道两端，就**平移**窗口（比例尺一点不动）把它留在轨道里，
     * 于是"一个方向一直拖"永远够得着整个值域，不用松手重抓。平移只改原点、不改 span，
     * 而且值只由指针位移决定，所以不会形成反馈回路。
     */
    private panForValue(value: number) {
        if (!this.dragView) {
            return false;
        }
        const span = this.dragView.max - this.dragView.min;
        if (span <= 0) {
            return false;
        }
        const fraction = (value - this.dragView.min) / span;
        const EDGE = 0.06;
        let shift = 0;
        if (fraction < EDGE) {
            // 新原点 = value - EDGE*span  => 位移 = (fraction - EDGE)*span（负：窗口往左让）
            shift = (fraction - EDGE) * span;
        } else if (fraction > 1 - EDGE) {
            shift = (fraction - (1 - EDGE)) * span;
        }
        if (shift === 0) {
            return false;
        }
        let min = this.dragView.min + shift;
        let max = min + span;
        if (min < this.min) {
            min = this.min;
            max = min + span;
        }
        if (max > this.max) {
            max = this.max;
            min = max - span;
        }
        this.dragView = { min, max };
        return true;
    }

    /** 轨道位置（0..1）-> 值。 */
    private valueOf(fraction: number) {
        return this.view.min + (this.view.max - this.view.min) * fraction;
    }

    /**
     * 移动一个柄，维持链式约束 `outerLow ≤ low ≤ high ≤ outerHigh`：
     *   - 内柄（方块）：外柄跟着走（扩边量保持）→ 往里拖就是收边；顶到对面就**推着走**（保持一个步长的厚
     *     度，两块永远不重叠 —— 重叠了就只有上面那一个点得到，也拖不开）；
     *   - 外柄（细柄）：往外拖扩边；越过内柄先把扩边收到 0，再顶着内柄走。
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
            if (next.low > next.high - MIN_THICKNESS) {
                next.high = Math.min(limitMax, next.low + MIN_THICKNESS);
                next.outerHigh = Math.max(next.outerHigh, next.high + marginHigh);
            }
            next.outerLow = next.low - marginLow;
        } else if (name === 'high') {
            next.high = value;
            if (next.high < next.low + MIN_THICKNESS) {
                next.low = Math.max(limitMin, next.high - MIN_THICKNESS);
                next.outerLow = Math.min(next.outerLow, next.low - marginLow);
            }
            next.outerHigh = next.high + marginHigh;
        } else if (name === 'outerLow') {
            if (value <= next.low) {
                next.outerLow = value;
            } else {
                next.low = value;
                next.outerLow = value;
                if (next.low > next.high - MIN_THICKNESS) {
                    next.high = Math.min(limitMax, next.low + MIN_THICKNESS);
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
                if (next.high < next.low + MIN_THICKNESS) {
                    next.low = Math.max(limitMin, next.high - MIN_THICKNESS);
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

        // 最后一道保险：芯和有效窗口都不许压到比一个步长还薄（否则两块完全重叠、拖不开）
        if (next.outerHigh - next.outerLow < MIN_THICKNESS) {
            const centre = (next.outerLow + next.outerHigh) / 2;
            next.outerLow = clamp(snap(centre - MIN_THICKNESS / 2), limitMin, limitMax);
            next.outerHigh = Math.min(limitMax, snap(next.outerLow + MIN_THICKNESS));
        }
        if (next.high - next.low < MIN_THICKNESS) {
            const centre = (next.low + next.high) / 2;
            next.low = clamp(snap(centre - MIN_THICKNESS / 2), next.outerLow, next.outerHigh);
            next.high = Math.min(next.outerHigh, snap(next.low + MIN_THICKNESS));
        }

        this._value = next;
        this.render();
        if (notify) {
            this.onChange({ ...next });
        }
    }

    private render() {
        if (this.dragView) {
            // frozen for the whole drag: nothing about the scale moves under the user's hand
            this.view = { ...this.dragView };
        } else {
            this.computeView();
        }

        const { low, high, outerLow, outerHigh } = this._value;
        const width = this.trackWidth();
        const blockWidth = this.blockWidth();

        const px = (value: number) => this.fractionOf(value) * width;
        const lowPx = px(low);
        const highPx = px(high);
        const outerLowPx = px(outerLow);
        const outerHighPx = px(outerHigh);

        // fixed-size blocks, centred on their bound: the block itself never changes size
        this.blocks.low.style.left = `${lowPx - blockWidth / 2}px`;
        this.blocks.low.style.width = `${blockWidth}px`;
        this.blocks.high.style.left = `${highPx - blockWidth / 2}px`;
        this.blocks.high.style.width = `${blockWidth}px`;

        // the orange band between the two blocks = what is selected
        this.bands.core.style.left = `${lowPx}px`;
        this.bands.core.style.width = `${Math.max(0, highPx - lowPx)}px`;

        // the eaten part, between an outer bar and its block on the rail
        this.bands.marginLow.style.left = `${outerLowPx}px`;
        this.bands.marginLow.style.width = `${Math.max(0, lowPx - outerLowPx)}px`;
        this.bands.marginHigh.style.left = `${highPx}px`;
        this.bands.marginHigh.style.width = `${Math.max(0, outerHighPx - highPx)}px`;
        this.bands.marginLow.classList[outerLow < low ? 'add' : 'remove']('visible');
        this.bands.marginHigh.classList[outerHigh > high ? 'add' : 'remove']('visible');

        // the outer bars: fixed width, only their position moves
        this.handles.outerLow.style.left = `${outerLowPx - OUTER_HANDLE_WIDTH / 2}px`;
        this.handles.outerLow.style.width = `${OUTER_HANDLE_WIDTH}px`;
        this.handles.outerHigh.style.left = `${outerHighPx - OUTER_HANDLE_WIDTH / 2}px`;
        this.handles.outerHigh.style.width = `${OUTER_HANDLE_WIDTH}px`;

        // the inner grips cover their block (the block is the grab surface, these keep the
        // keyboard/automation targets aligned with the bound)
        this.handles.low.style.left = `${lowPx - blockWidth / 2}px`;
        this.handles.low.style.width = `${blockWidth}px`;
        this.handles.high.style.left = `${highPx - blockWidth / 2}px`;
        this.handles.high.style.width = `${blockWidth}px`;

        // values live in the tooltips (no numeric fields in a row, per the design)
        const hint = i18n.t('select-toolbar.rangeHandleHint');
        this.handles.outerLow.title = `${hint} — 扩边 ${outerLow.toFixed(1)}`;
        this.handles.low.title = `${hint} — 边界 ${low.toFixed(1)}`;
        this.handles.high.title = `${hint} — 边界 ${high.toFixed(1)}`;
        this.handles.outerHigh.title = `${hint} — 扩边 ${outerHigh.toFixed(1)}`;
    }

    /** 拖动时把数值贴在滑块旁边浮出来（平时不显示任何数字）。 */
    private showReadout(name: HandleName, value: number) {
        const handle = this.handles[name];
        this.readout.textContent = value.toFixed(1);
        this.readout.style.left = handle.style.left;
        this.readout.style.width = handle.style.width;
        this.readout.classList.add('visible');
    }
}

export { RangeSlider };
