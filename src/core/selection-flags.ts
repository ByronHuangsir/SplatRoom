import { Events } from './events';

// Selection depth range (V3, "选区深度" —— 最近 / 最远).
//
// 屏幕选择工具默认**穿透整个模型**：只要高斯的投影落在 2D 选择区域里就选中，不管有多深。
// 这两个值把这段穿透空间再切一刀，是**占模型自身深度范围的百分比**（沿手势当时的视轴量取）：
//
//   near = 0   -> 从模型最近的一端开始选
//   far  = 100 -> 一直选到最远的一端
//
// 所以 0 / 100 就是"完整穿透"（默认）。0 与 100 之间是同一段区间，两个值夹出要保留的板层；
// 判定在 splat/selection-range.ts。
//
// 这个模块独立于 UI：选区深度浮条在构建时就读取这些值，而 editor 的处理器注册得更晚。
// 值会持久化，重启后保持。

const NEAR_KEY = 'splatroom.selDepthNear';
const FAR_KEY = 'splatroom.selDepthFar';

const DEFAULT_NEAR = 0;
const DEFAULT_FAR = 100;

let depthNear = DEFAULT_NEAR;
let depthFar = DEFAULT_FAR;

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

const store = (key: string, value: string) => {
    try {
        localStorage.setItem(key, value);
    } catch { /* storage unavailable */ }
};

// 两个值互相约束：最近不能越过最远。写进来的是一整对时按大小排好；只写一个值时按
// "双柄 range" 的手感**顶开对面那个柄**（拖最近越过最远，最远跟着走），而不是把手里的值丢掉。
const order = (near: number, far: number) => {
    const n = clampPct(near, DEFAULT_NEAR);
    const f = clampPct(far, DEFAULT_FAR);
    return n <= f ? { near: n, far: f } : { near: f, far: n };
};

const registerSelectionFlags = (events: Events) => {
    const stored = order(
        Number.parseFloat(readStored(NEAR_KEY) ?? ''),
        Number.parseFloat(readStored(FAR_KEY) ?? '')
    );
    depthNear = stored.near;
    depthFar = stored.far;

    const setRange = (near: number, far: number) => {
        const next = order(near, far);
        if (next.near === depthNear && next.far === depthFar) {
            return;
        }
        depthNear = next.near;
        depthFar = next.far;
        store(NEAR_KEY, String(next.near));
        store(FAR_KEY, String(next.far));
        events.fire('selection.depthRange', { near: next.near, far: next.far });
    };

    events.function('selection.depthRange', () => ({ near: depthNear, far: depthFar }));
    events.on('selection.setDepthRange', (value: { near?: number, far?: number }) => {
        const movedNear = value?.near !== undefined;
        const movedFar = value?.far !== undefined;
        let near = movedNear ? value.near : depthNear;
        let far = movedFar ? value.far : depthFar;
        if (movedNear && !movedFar && near > far) {
            far = near;
        } else if (movedFar && !movedNear && far < near) {
            near = far;
        }
        setRange(near, far);
    });
    events.on('selection.resetDepthRange', () => setRange(DEFAULT_NEAR, DEFAULT_FAR));
};

const getDepthRange = () => ({ near: depthNear, far: depthFar });

export { registerSelectionFlags, getDepthRange, DEFAULT_NEAR, DEFAULT_FAR };
