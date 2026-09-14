import { Events } from './events';

// Selection range (V3, "选区范围" —— 三轴四柄 range).
//
// 屏幕选择工具默认**穿透整个模型**：只要高斯的投影落在 2D 选择区域里就选中，不管有多深。之后三个
// 四柄 range 把它收成 / 撑成一个盒子。每个轴两层：
//
//   内柄（low / high）  ：选区边界 —— 就是手势那个框裁到哪；
//   外柄（outerLow/High）：**扩边到哪** —— 外柄与内柄之间那一段就是"扩边多吃进来的部分"。
//
// 两个柄默认重合（不扩边），此时行为与只有内柄时完全一致。约束永远是
// `outerLow ≤ low ≤ high ≤ outerHigh`（拖动时靠"拉下来 / 顶上去"维持，见 ui/range-slider.ts）。
//
// 百分比相对谁：
//   深度（最近-最远）：**模型自身**沿手势视轴的深度范围，0-100（模型之外没有东西，所以不外扩）；
//   左右（左-右）   ：**手势那个框**的宽度，0/100 = 框的两条边，负值 / 大于 100 = 扩到框外；
//   上下（上-下）   ：同上，框的高度。
//
// 真正参与判定的是**外柄**（也就是"扩边之后"的范围），见 splat/selection-range.ts。
// 这个模块独立于 UI：选区范围浮条在构建时就读取这些值，而 editor 的处理器注册得更晚。
// 值会持久化，重启后保持。

type Axis = { low: number, high: number, outerLow: number, outerHigh: number };

type Limits = { min: number, max: number };

// 三个轴用同一段值域，行与行看起来才一致（设计稿是 `----o 近 o-------o 远 o----`：两端留出外扩余地，
// 内柄之间是选区）：
//   0-100 = 这一轴"当前的完整范围" —— 深度是模型自身的深度范围，左右 / 上下是手势那个框；
//   -50..150 = 每侧多留**半个范围**的余地给"扩边"。参考上一轮：之前给左右/上下留了整整一个范围的
//   余地，结果 0-100 只占轨道 1/3，内柄几乎没行程、每像素跳 3%，拖起来又顿又"没反应"。
// 深度轴拖到 0 以下 / 100 以上时模型之外没有东西可选，所以那一段是空的（柄到轨道两端就是极限）。
const LIMITS: Record<'depth' | 'x' | 'y', Limits> = {
    depth: { min: -50, max: 150 },
    x: { min: -50, max: 150 },
    y: { min: -50, max: 150 }
};

const KEYS = {
    depth: { low: 'splatroom.selDepthNear', high: 'splatroom.selDepthFar', outerLow: 'splatroom.selDepthOuterNear', outerHigh: 'splatroom.selDepthOuterFar' },
    x: { low: 'splatroom.selRangeLeft', high: 'splatroom.selRangeRight', outerLow: 'splatroom.selRangeOuterLeft', outerHigh: 'splatroom.selRangeOuterRight' },
    y: { low: 'splatroom.selRangeTop', high: 'splatroom.selRangeBottom', outerLow: 'splatroom.selRangeOuterTop', outerHigh: 'splatroom.selRangeOuterBottom' }
};

const FULL: Axis = { low: 0, high: 100, outerLow: 0, outerHigh: 100 };

let depth: Axis = { ...FULL };
let screenX: Axis = { ...FULL };
let screenY: Axis = { ...FULL };

const readStored = (key: string) => {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
};

const store = (keys: { low: string, high: string, outerLow: string, outerHigh: string }, axis: Axis) => {
    try {
        localStorage.setItem(keys.low, String(axis.low));
        localStorage.setItem(keys.high, String(axis.high));
        localStorage.setItem(keys.outerLow, String(axis.outerLow));
        localStorage.setItem(keys.outerHigh, String(axis.outerHigh));
    } catch { /* storage unavailable */ }
};

/** 把四个值夹进值域并维持 outerLow ≤ low ≤ high ≤ outerHigh。步长 0.1（见 range-slider 的拖动映射）。 */
const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * 芯的最小厚度（正好一个步长）。没有它，两个值可以压成 0 厚：两个方块完全重叠、只有上面那一个
 * 能点到，而且拖不开（实测拖 80px 只是把整块挪了 0.1）。留一个步长后，"两块之间"永远有空间。
 */
export const MIN_THICKNESS = 0.1;

const normalize = (axis: Axis, limits: Limits): Axis => {
    const pick = (value: number, fallback: number) => {
        return Number.isFinite(value) ?
            round1(Math.max(limits.min, Math.min(limits.max, value))) : fallback;
    };
    const next = {
        outerLow: pick(axis.outerLow, FULL.outerLow),
        low: pick(axis.low, FULL.low),
        high: pick(axis.high, FULL.high),
        outerHigh: pick(axis.outerHigh, FULL.outerHigh)
    };
    next.low = Math.max(next.low, next.outerLow);
    next.high = Math.min(next.high, next.outerHigh);
    next.outerLow = Math.min(next.outerLow, next.low);
    next.outerHigh = Math.max(next.outerHigh, next.high);
    // 有效窗口本身不能比一个步长还窄，否则芯也给不出厚度
    if (next.outerHigh - next.outerLow < MIN_THICKNESS) {
        const centre = (next.outerLow + next.outerHigh) / 2;
        next.outerLow = round1(Math.max(limits.min, Math.min(limits.max, centre - MIN_THICKNESS / 2)));
        next.outerHigh = round1(Math.min(limits.max, next.outerLow + MIN_THICKNESS));
    }
    if (next.high - next.low < MIN_THICKNESS) {
        const centre = (next.low + next.high) / 2;
        next.low = round1(Math.max(next.outerLow, Math.min(next.outerHigh, centre - MIN_THICKNESS / 2)));
        next.high = round1(Math.min(next.outerHigh, next.low + MIN_THICKNESS));
    }
    return next;
};

const readAxis = (keys: { low: string, high: string, outerLow: string, outerHigh: string }, limits: Limits): Axis => {
    const low = Number.parseFloat(readStored(keys.low) ?? '');
    const high = Number.parseFloat(readStored(keys.high) ?? '');
    const stored = {
        low: Number.isFinite(low) ? low : FULL.low,
        high: Number.isFinite(high) ? high : FULL.high,
        // a profile stored before the outer handles existed simply has no expansion
        outerLow: Number.isFinite(low) ? low : FULL.outerLow,
        outerHigh: Number.isFinite(high) ? high : FULL.outerHigh
    };
    const outerLow = Number.parseFloat(readStored(keys.outerLow) ?? '');
    const outerHigh = Number.parseFloat(readStored(keys.outerHigh) ?? '');
    if (Number.isFinite(outerLow)) {
        stored.outerLow = outerLow;
    }
    if (Number.isFinite(outerHigh)) {
        stored.outerHigh = outerHigh;
    }
    return normalize(stored, limits);
};

type Patch = { low?: number, high?: number, outerLow?: number, outerHigh?: number };

/**
 * 应用一次写入，规则与控件里拖柄完全一致（所以从事件 API 改值的手感和拖柄一样）：
 *
 *   - 只给内柄（low / high）→ **外柄跟着一起走**（扩边量保持）→ 往里改就是收边；
 *   - 给了外柄（outerLow / outerHigh）→ 往外 = 扩边量变大；越过内柄 = 扩边量收到 0 并顶开内柄；
 *   - 最后统一夹进值域、修好 `outerLow ≤ low ≤ high ≤ outerHigh`。
 */
const merge = (current: Axis, patch: Patch, limits: Limits): Axis => {
    const pick = (value: number | undefined, fallback: number) => {
        return value !== undefined && Number.isFinite(value) ?
            Math.max(limits.min, Math.min(limits.max, value)) : fallback;
    };

    const marginLow = current.low - current.outerLow;
    const marginHigh = current.outerHigh - current.high;

    let low = pick(patch.low, current.low);
    let high = pick(patch.high, current.high);
    let outerLow = patch.outerLow !== undefined ?
        pick(patch.outerLow, current.outerLow) : low - marginLow;
    let outerHigh = patch.outerHigh !== undefined ?
        pick(patch.outerHigh, current.outerHigh) : high + marginHigh;

    // 内柄互相推
    if (low > high) {
        if (patch.low !== undefined && patch.high !== undefined) {
            // 一整对给反了：按大小排好（历史行为：setDepthRange({near:80, far:20}) → 20/80）
            const swapped = low;
            low = high;
            high = swapped;
            if (patch.outerLow === undefined) {
                outerLow = low - marginLow;
            }
            if (patch.outerHigh === undefined) {
                outerHigh = high + marginHigh;
            }
        } else if (patch.low !== undefined) {
            high = low;
            outerHigh = Math.max(outerHigh, high);
        } else {
            low = high;
            outerLow = Math.min(outerLow, low);
        }
    }

    // 外柄越过内柄 = 扩边收到 0 并顶开内柄
    if (outerLow > low) {
        low = outerLow;
        if (low > high) {
            high = low;
            outerHigh = Math.max(outerHigh, high);
        }
    }
    if (outerHigh < high) {
        high = outerHigh;
        if (high < low) {
            low = high;
            outerLow = Math.min(outerLow, low);
        }
    }

    return normalize({ low, high, outerLow: Math.min(outerLow, low), outerHigh: Math.max(outerHigh, high) }, limits);
};

const same = (a: Axis, b: Axis) => {
    return a.low === b.low && a.high === b.high && a.outerLow === b.outerLow && a.outerHigh === b.outerHigh;
};

const registerSelectionFlags = (events: Events) => {
    depth = readAxis(KEYS.depth, LIMITS.depth);
    screenX = readAxis(KEYS.x, LIMITS.x);
    screenY = readAxis(KEYS.y, LIMITS.y);

    const setAxis = (
        keys: { low: string, high: string, outerLow: string, outerHigh: string },
        current: () => Axis,
        assign: (axis: Axis) => void,
        limits: Limits,
        fire: string,
        payload: () => unknown
    ) => {
        return (patch: Patch) => {
            const previous = current();
            const next = merge(previous, patch, limits);
            if (same(previous, next)) {
                return;
            }
            assign(next);
            store(keys, next);
            events.fire(fire, payload());
        };
    };

    const screenPayload = () => ({ x: { ...screenX }, y: { ...screenY } });

    const setDepth = setAxis(KEYS.depth, () => depth, (axis) => {
        depth = axis;
    }, LIMITS.depth, 'selection.depthRange', () => ({
        near: depth.low,
        far: depth.high,
        nearOuter: depth.outerLow,
        farOuter: depth.outerHigh
    }));

    const setScreenX = setAxis(KEYS.x, () => screenX, (axis) => {
        screenX = axis;
    }, LIMITS.x, 'selection.screenRange', screenPayload);

    const setScreenY = setAxis(KEYS.y, () => screenY, (axis) => {
        screenY = axis;
    }, LIMITS.y, 'selection.screenRange', screenPayload);

    // 公开的读接口：深度保持历史形状 { near, far }（= 内柄），外柄另给两个键
    events.function('selection.depthRange', () => ({
        near: depth.low,
        far: depth.high,
        nearOuter: depth.outerLow,
        farOuter: depth.outerHigh
    }));
    events.function('selection.screenRange', () => ({ x: { ...screenX }, y: { ...screenY } }));

    // 兼容历史写法：near/far（= 内柄）与 low/high（= 内柄），外柄用 outerNear/outerFar
    events.on('selection.setDepthRange', (value: Patch & { near?: number, far?: number, nearOuter?: number, farOuter?: number }) => {
        setDepth({
            low: value?.low ?? value?.near,
            high: value?.high ?? value?.far,
            outerLow: value?.outerLow ?? value?.nearOuter,
            outerHigh: value?.outerHigh ?? value?.farOuter
        } as Patch);
    });
    events.on('selection.setScreenRange', (value: { x?: Patch, y?: Patch }) => {
        if (value?.x) {
            setScreenX(value.x);
        }
        if (value?.y) {
            setScreenY(value.y);
        }
    });
    events.on('selection.resetDepthRange', () => setDepth({ ...FULL }));
    events.on('selection.resetRange', () => {
        setDepth({ ...FULL });
        setScreenX({ ...FULL });
        setScreenY({ ...FULL });
    });
};

/** 判定用的实际范围：外柄（= 扩边之后）。 */
const getDepthSelection = () => ({ near: depth.outerLow, far: depth.outerHigh });
const getScreenSelection = () => ({
    left: screenX.outerLow,
    right: screenX.outerHigh,
    top: screenY.outerLow,
    bottom: screenY.outerHigh
});

/** 内柄：核心范围（2D 区域的形状只在这个范围里生效）。 */
const getDepthRange = () => ({ near: depth.low, far: depth.high });
const getScreenRange = () => ({
    left: screenX.low,
    right: screenX.high,
    top: screenY.low,
    bottom: screenY.high
});

export {
    registerSelectionFlags,
    getDepthSelection,
    getScreenSelection,
    getDepthRange,
    getScreenRange,
    LIMITS
};
