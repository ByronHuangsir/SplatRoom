import { Events } from './events';

// Selection range (V3, "选区范围" —— 三轴双柄 range：最近-最远 / 左-右 / 上-下).
//
// 屏幕选择工具默认**穿透整个模型**：只要高斯的投影落在 2D 选择区域里就选中，不管有多深。之后三个
// 双柄范围把它收成一个盒子（低端标签 …… 高端标签，两个柄之间就是选中的部分）：
//
//   深度（最近-最远）：占**模型自身深度范围**的百分比，沿**手势当时**的视轴量取；0/100 = 整段；
//   左右（左-右）   ：占**选区框**宽度的百分比；0/100 = 整框；
//   上下（上-下）   ：占**选区框**高度的百分比；0/100 = 整框。
//
// 三个轴的默认值都是"整段"，也就是"完整穿透"。判定在 splat/selection-range.ts，UI 在
// ui/selection-depth-bar.ts（双柄控件是 ui/range-slider.ts）。
//
// 这个模块独立于 UI：选区范围浮条在构建时就读取这些值，而 editor 的处理器注册得更晚。
// 值会持久化，重启后保持。

const DEPTH_KEYS = { low: 'splatroom.selDepthNear', high: 'splatroom.selDepthFar' };
const X_KEYS = { low: 'splatroom.selRangeLeft', high: 'splatroom.selRangeRight' };
const Y_KEYS = { low: 'splatroom.selRangeTop', high: 'splatroom.selRangeBottom' };

const DEFAULT_LOW = 0;
const DEFAULT_HIGH = 100;

type Axis = { low: number, high: number };

let depth: Axis = { low: DEFAULT_LOW, high: DEFAULT_HIGH };
let screenX: Axis = { low: DEFAULT_LOW, high: DEFAULT_HIGH };
let screenY: Axis = { low: DEFAULT_LOW, high: DEFAULT_HIGH };

const clampPct = (value: number, fallback: number) => {
    return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : fallback;
};

const readStored = (key: string) => {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
};

const store = (keys: { low: string, high: string }, axis: Axis) => {
    try {
        localStorage.setItem(keys.low, String(axis.low));
        localStorage.setItem(keys.high, String(axis.high));
    } catch { /* storage unavailable */ }
};

// 两个柄互相约束：低端不能越过高端。写一整对时按大小排好；只写一个值时按"双柄 range"的手感
// **顶开对面那个柄**（把低端拖过高端，高端跟着走，不会把手里的值丢掉）。
const order = (low: number, high: number): Axis => {
    const l = clampPct(low, DEFAULT_LOW);
    const h = clampPct(high, DEFAULT_HIGH);
    return l <= h ? { low: l, high: h } : { low: h, high: l };
};

const readAxis = (keys: { low: string, high: string }): Axis => {
    return order(
        Number.parseFloat(readStored(keys.low) ?? ''),
        Number.parseFloat(readStored(keys.high) ?? '')
    );
};

const registerSelectionFlags = (events: Events) => {
    depth = readAxis(DEPTH_KEYS);
    screenX = readAxis(X_KEYS);
    screenY = readAxis(Y_KEYS);

    // 部分写入（只有 low 或只有 high）→ 顶开对面；整对写入 → 排序
    const merge = (current: Axis, value: { low?: number, high?: number }): Axis => {
        const movedLow = value?.low !== undefined;
        const movedHigh = value?.high !== undefined;
        let low = movedLow ? value.low : current.low;
        let high = movedHigh ? value.high : current.high;
        if (movedLow && !movedHigh && low > high) {
            high = low;
        } else if (movedHigh && !movedLow && high < low) {
            low = high;
        }
        return order(low, high);
    };

    const setAxis = (
        keys: { low: string, high: string },
        current: () => Axis,
        assign: (axis: Axis) => void,
        fire: string,
        payload: () => unknown
    ) => {
        return (value: { low?: number, high?: number }) => {
            const previous = current();
            const next = merge(previous, value);
            if (next.low === previous.low && next.high === previous.high) {
                return;
            }
            assign(next);
            store(keys, next);
            events.fire(fire, payload());
        };
    };

    const screenPayload = () => ({ x: { ...screenX }, y: { ...screenY } });
    const setDepth = setAxis(DEPTH_KEYS, () => depth, (axis) => {
        depth = axis;
    }, 'selection.depthRange', () => ({ ...depth }));
    const setScreenX = setAxis(X_KEYS, () => screenX, (axis) => {
        screenX = axis;
    }, 'selection.screenRange', screenPayload);
    const setScreenY = setAxis(Y_KEYS, () => screenY, (axis) => {
        screenY = axis;
    }, 'selection.screenRange', screenPayload);

    // the depth axis keeps its historical { near, far } shape (the screen axes below are
    // generic { low, high } pairs)
    events.function('selection.depthRange', () => ({ near: depth.low, far: depth.high }));
    events.function('selection.screenRange', () => ({ x: { ...screenX }, y: { ...screenY } }));
    events.on('selection.setDepthRange', (value: { low?: number, high?: number, near?: number, far?: number }) => {
        // `near`/`far` is the pre-3.8 spelling: accept it so older callers and stored
        // preferences keep working
        const mapped = {
            low: value?.low ?? value?.near,
            high: value?.high ?? value?.far
        };
        setDepth(mapped);
    });
    events.on('selection.setScreenRange', (value: { x?: { low?: number, high?: number }, y?: { low?: number, high?: number } }) => {
        if (value?.x) {
            setScreenX(value.x);
        }
        if (value?.y) {
            setScreenY(value.y);
        }
    });
    events.on('selection.resetDepthRange', () => setDepth({ low: DEFAULT_LOW, high: DEFAULT_HIGH }));
    events.on('selection.resetRange', () => {
        setDepth({ low: DEFAULT_LOW, high: DEFAULT_HIGH });
        setScreenX({ low: DEFAULT_LOW, high: DEFAULT_HIGH });
        setScreenY({ low: DEFAULT_LOW, high: DEFAULT_HIGH });
    });
};

const getDepthRange = () => ({ near: depth.low, far: depth.high });
const getScreenRange = () => ({
    left: screenX.low,
    right: screenX.high,
    top: screenY.low,
    bottom: screenY.high
});

export { registerSelectionFlags, getDepthRange, getScreenRange, DEFAULT_LOW, DEFAULT_HIGH };
