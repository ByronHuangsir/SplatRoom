/**
 * 曲线调色（Curves）的模型与采样 —— 纯函数，可在 node 里单测。
 *
 * 为什么先做这一层：曲线最终要落在**四份数学**里（GLSL 顶点/片元 + WGSL 顶点/片元 + CPU 导出镜像 +
 * 直方图/范围选择的 GPU 值通路），而"控制点 → 采样表"这件事只该有一份实现。这里把它做成
 * 33 点采样表（步长 1/32），着色器一侧只需要一张 33×1 的浮点纹理 + 一次线性插值，
 * CPU 一侧用 `evaluateCurveAt()` 得到**逐位相同**的结果。
 *
 * 采样点为什么是 33：0 与 1 都必须是采样点（曲线的两个端点，抬黑/压白都落在端点上），
 * 33 = 32 段 ⇒ 每段 1/32，纹理宽度 33 也是 2 的幂附近的舒适值（不需要 mipmap，用 NEAREST + 手工 mix）。
 *
 * 插值为什么用单调三次（Fritsch–Carlson）：摄影曲线的手感是"拉中间点不把两端甩出去"，
 * 普通 Catmull-Rom 会过冲（暗部出现负值/亮部冲过头），单调三次保证**不产生新的极值**。
 *
 * 默认是**恒等**（`samples[i] = i/32`），并且着色器里还有一个 `uCurveEnabled` 开关：
 * 没设曲线时整段跳过 ⇒ 对现有画面是**零改动**（这是本仓库的硬规矩：观感类改变默认不动）。
 */

/** 采样点数（0..1 之间 32 段） */
export const CURVE_SAMPLES = 33;

/** 曲线控制点（x/y 都在 0..1；x 递增，重复 x 会被去掉） */
export type CurvePoint = { x: number; y: number };

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 恒等曲线（`y = x`）的采样表。 */
export const identityCurveSamples = (): Float32Array => {
    const out = new Float32Array(CURVE_SAMPLES);
    const step = 1 / (CURVE_SAMPLES - 1);
    for (let i = 0; i < CURVE_SAMPLES; i++) {
        out[i] = i * step;
    }
    return out;
};

/**
 * 归一化控制点：夹到 [0,1]、按 x 排序、去掉重复 x（后者优先）。
 * 面板编辑器与采样共用同一套规则，避免"UI 里的点"和"算出来的表"不一致。
 *
 * @param points - 原始控制点
 * @returns 归一化后的新数组（不改原数组）
 */
export const normalizeCurvePoints = (points: CurvePoint[]): CurvePoint[] => {
    const sorted = points
    .map(p => ({ x: clamp01(p.x), y: clamp01(p.y) }))
    .sort((a, b) => a.x - b.x);
    const out: CurvePoint[] = [];
    for (const p of sorted) {
        if (out.length > 0 && Math.abs(p.x - out[out.length - 1].x) < 1e-6) {
            out[out.length - 1] = p;
        } else {
            out.push(p);
        }
    }
    return out;
};

/**
 * 把控制点采样成 `CURVE_SAMPLES` 个点（单调保形三次插值）。
 *
 * @param points - 控制点列表（至少 2 个；不足 2 个时返回恒等曲线）
 * @param out - 可选的目标缓冲（长度必须 ≥ `CURVE_SAMPLES`），便于零分配复用
 * @returns 采样表（长度 `CURVE_SAMPLES`，值夹在 0..1）
 */
export const sampleCurve = (points: CurvePoint[], out?: Float32Array): Float32Array => {
    const dst = out ?? new Float32Array(CURVE_SAMPLES);
    if (!points || points.length < 2) {
        const ident = identityCurveSamples();
        dst.set(ident);
        return dst;
    }

    // 1) 归一化：夹到 [0,1]，按 x 排序，去掉重复 x（后者优先 —— 拖到同一个 x 时以最后一次为准）
    const norm = normalizeCurvePoints(points);
    const xs: number[] = norm.map(p => p.x);
    const ys: number[] = norm.map(p => p.y);
    const n = xs.length;
    if (n < 2) {
        dst.set(identityCurveSamples());
        return dst;
    }

    // 2) 割线斜率
    const d: number[] = [];
    for (let i = 0; i < n - 1; i++) {
        d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]));
    }

    // 3) Fritsch–Carlson 切线（保证单调、不过冲）
    const m: number[] = new Array(n).fill(0);
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) {
        m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) * 0.5;
    }
    for (let i = 0; i < n - 1; i++) {
        if (d[i] === 0) {
            m[i] = 0;
            m[i + 1] = 0;
            continue;
        }
        const a = m[i] / d[i];
        const b = m[i + 1] / d[i];
        const s = a * a + b * b;
        if (s > 9) {
            const t = 3 / Math.sqrt(s);
            m[i] = t * a * d[i];
            m[i + 1] = t * b * d[i];
        }
    }

    // 4) 等距采样（Hermite 基）
    const step = 1 / (CURVE_SAMPLES - 1);
    let seg = 0;
    for (let i = 0; i < CURVE_SAMPLES; i++) {
        const x = i * step;
        while (seg < n - 2 && x > xs[seg + 1]) {
            seg++;
        }
        const x0 = xs[seg];
        const x1 = xs[seg + 1];
        const h = Math.max(1e-6, x1 - x0);
        const t = clamp01((x - x0) / h);
        const t2 = t * t;
        const t3 = t2 * t;
        const h00 = 2 * t3 - 3 * t2 + 1;
        const h10 = t3 - 2 * t2 + t;
        const h01 = -2 * t3 + 3 * t2;
        const h11 = t3 - t2;
        dst[i] = clamp01(h00 * ys[seg] + h10 * h * m[seg] + h01 * ys[seg + 1] + h11 * h * m[seg + 1]);
    }
    return dst;
};

/** 是不是恒等曲线（用来决定要不要打开着色器里的开关）。 */
export const isIdentityCurve = (samples: Float32Array | null | undefined): boolean => {
    if (!samples || samples.length < CURVE_SAMPLES) {
        return true;
    }
    const step = 1 / (CURVE_SAMPLES - 1);
    for (let i = 0; i < CURVE_SAMPLES; i++) {
        if (Math.abs(samples[i] - i * step) > 1e-6) {
            return false;
        }
    }
    return true;
};

/**
 * CPU 侧求值 —— **必须与着色器里的 `curveLookup()` 逐位一致**（同样的 33 点线性插值）。
 * 导出（`ColorGrade`）与直方图/范围选择都靠它保持与视口一致。
 *
 * @param samples - 采样表
 * @param x - 输入（会被夹到 0..1）
 * @returns 曲线输出
 */
export const evaluateCurveAt = (samples: Float32Array, x: number): number => {
    // NaN 原样透传（不"发明"数值，便于定位上游问题）；±Infinity 当作越界夹到两端
    if (Number.isNaN(x)) {
        return x;
    }
    const t = clamp01(x) * (CURVE_SAMPLES - 1);
    const i0 = Math.min(CURVE_SAMPLES - 1, Math.floor(t));
    const i1 = Math.min(CURVE_SAMPLES - 1, i0 + 1);
    const f = t - i0;
    const a = samples[i0];
    const b = samples[i1];
    return a + (b - a) * f;
};

/**
 * 对 RGB 三个通道施加同一条曲线（RGB 主曲线；与着色器 GLSL/WGSL 里的做法一致）。
 *
 * @param rgb - 就地修改的颜色（长度 ≥ 3）
 * @param samples - 采样表
 */
export const applyCurveToRGB = (rgb: Float32Array | number[], samples: Float32Array): void => {
    rgb[0] = evaluateCurveAt(samples, rgb[0]);
    rgb[1] = evaluateCurveAt(samples, rgb[1]);
    rgb[2] = evaluateCurveAt(samples, rgb[2]);
};

// ---- 分通道（RGB 主 / 红 / 绿 / 蓝）----
//
// 着色器里是一张 **33×4 的 R32F 纹理**：行 0 = RGB 主曲线，行 1/2/3 = R/G/B。
// 施加顺序与 Lightroom 一致：**先主曲线（三通道同一条），再各自通道的曲线**，
// 也就是 `out.r = f_red(f_master(in.r))`。四份数学（GLSL/WGSL 顶点、CPU 导出镜像、
// 直方图/范围选择的值通路）都必须按这个顺序。

/** 曲线通道 */
export type CurveChannel = 'master' | 'red' | 'green' | 'blue';

/** 通道顺序 = 纹理行号（0..3），别改：着色器里的 `ch` 就是它 */
export const CURVE_CHANNELS: readonly CurveChannel[] = ['master', 'red', 'green', 'blue'];

/** 一组曲线（每条可以是 `null` = 恒等） */
export type CurveSet = Record<CurveChannel, CurvePoint[] | null>;

/** 全恒等的一组曲线 */
export const emptyCurveSet = (): CurveSet => ({ master: null, red: null, green: null, blue: null });

/** 把一组控制点拷贝成 `CurveSet`（缺的通道填空） */
export const toCurveSet = (partial: Partial<CurveSet> | null | undefined): CurveSet => ({
    master: partial?.master ? partial.master.map(p => ({ x: p.x, y: p.y })) : null,
    red: partial?.red ? partial.red.map(p => ({ x: p.x, y: p.y })) : null,
    green: partial?.green ? partial.green.map(p => ({ x: p.x, y: p.y })) : null,
    blue: partial?.blue ? partial.blue.map(p => ({ x: p.x, y: p.y })) : null
});

/** 一组曲线是不是全恒等（全恒等 ⇒ 着色器整段跳过） */
export const isIdentityCurveSet = (set: CurveSet | null | undefined): boolean => {
    if (!set) {
        return true;
    }
    return CURVE_CHANNELS.every(ch => !set[ch] || isIdentityCurve(sampleCurve(set[ch]!)));
};

/**
 * 把一组曲线采样成**一张扁平表**：`tables[ch * CURVE_SAMPLES + i]`，`ch` 见 `CURVE_CHANNELS`。
 * 全恒等时返回 `null`（调用方据此走"没有曲线"的快路径）。
 *
 * @param set - 控制点集合
 * @param out - 可选目标缓冲（长度 ≥ `CURVE_SAMPLES * 4`）
 * @returns 长度 `CURVE_SAMPLES * 4` 的采样表，或 `null`
 */
export const curveSetToTables = (set: CurveSet | null | undefined, out?: Float32Array): Float32Array | null => {
    if (!set) {
        return null;
    }
    const dst = out ?? new Float32Array(CURVE_SAMPLES * CURVE_CHANNELS.length);
    let any = false;
    for (let ch = 0; ch < CURVE_CHANNELS.length; ch++) {
        const points = set[CURVE_CHANNELS[ch]];
        const slice = dst.subarray(ch * CURVE_SAMPLES, (ch + 1) * CURVE_SAMPLES);
        if (points && points.length >= 2) {
            sampleCurve(points, slice);
            if (!isIdentityCurve(slice)) {
                any = true;
            }
        } else {
            slice.set(identityCurveSamples());
        }
    }
    return any ? dst : null;
};

/**
 * 按"先主曲线、再各自通道"的顺序对一个 RGB 施加整组曲线（CPU 导出镜像用）。
 * 接受任何带 r/g/b 的对象或数组（`ColorGrade` 用的是 `{r,g,b}`）。
 *
 * @param rgb - 就地修改（`{r,g,b}` 或长度 ≥ 3 的数组）
 * @param tables - `curveSetToTables()` 的输出
 */
export const applyCurveSetToRGB = (rgb: number[] | Float32Array | { r: number, g: number, b: number }, tables: Float32Array): void => {
    const isObj = !Array.isArray(rgb) && !(rgb instanceof Float32Array);
    const get = (i: number) => (isObj ? (i === 0 ? (rgb as any).r : i === 1 ? (rgb as any).g : (rgb as any).b) : (rgb as any)[i]);
    const set = (i: number, v: number) => {
        if (isObj) {
            if (i === 0) {
                (rgb as any).r = v;
            } else if (i === 1) {
                (rgb as any).g = v;
            } else {
                (rgb as any).b = v;
            }
        } else {
            (rgb as any)[i] = v;
        }
    };
    const master = tables.subarray(0, CURVE_SAMPLES);
    const red = tables.subarray(CURVE_SAMPLES, CURVE_SAMPLES * 2);
    const green = tables.subarray(CURVE_SAMPLES * 2, CURVE_SAMPLES * 3);
    const blue = tables.subarray(CURVE_SAMPLES * 3, CURVE_SAMPLES * 4);
    const perCh = [red, green, blue];
    for (let i = 0; i < 3; i++) {
        set(i, evaluateCurveAt(perCh[i], evaluateCurveAt(master, get(i))));
    }
};

// ---- 文档（JSON）形式 ----
//
// `.ssproj` 与 `.sscg` 侧车都要把曲线写进 JSON。控制点存成 `[[x, y], …]`
// （比 `{x, y}` 短、比 33×4 个采样值可读），每个通道 `null` = 该通道恒等。
// 这两个转换器放在纯函数层，`.ssproj`（`Splat.docSerialize/docDeserialize`）与
// `.sscg`（`color-grade-file.ts`）共用同一份语义 —— 两边不可能漂移，
// 也就能在 node 里单测（`docs/verify/verify-color-curves.mts`）。

/** JSON 里的曲线形状：四个通道，各是 `[[x, y], …]` 或 `null` */
export type CurveSetDoc = Partial<Record<CurveChannel, number[][] | null>> | null;

/** `CurveSet` → JSON 形状（通道缺失 ⇒ `null`） */
export const curveSetToDoc = (set: CurveSet | null | undefined): Record<CurveChannel, number[][] | null> => {
    const out = {} as Record<CurveChannel, number[][] | null>;
    for (const ch of CURVE_CHANNELS) {
        const pts = set?.[ch];
        out[ch] = pts && pts.length ? pts.map(p => [p.x, p.y]) : null;
    }
    return out;
};

/**
 * JSON 形状 → `CurveSet`。
 *
 * **`null` 与"字段缺失"要分开看**（HANDOFF 52 的同一类坑）：`.sscg` 里
 * `curves: null` 表示"存的时候就没有曲线 ⇒ 读的时候要清空"，而**整个 `curves` 字段缺失**
 * 表示"这份文件（v4 及更早）没有曲线概念 ⇒ 什么都别动"。所以缺失的判断在调用方做，
 * 这里只负责把一个 `CurveSetDoc` 转成 `CurveSet`。
 *
 * 通道里少于 2 个点（或不是数字对）按恒等处理 —— 与 `sampleCurve` 的下限一致。
 */
export const curveSetFromDoc = (doc: CurveSetDoc | undefined): CurveSet => {
    const out = emptyCurveSet();
    if (!doc || typeof doc !== 'object') {
        return out;
    }
    for (const ch of CURVE_CHANNELS) {
        const raw = (doc as any)[ch];
        if (Array.isArray(raw) && raw.length >= 2) {
            const pts: CurvePoint[] = [];
            for (const p of raw) {
                if (Array.isArray(p) && p.length >= 2) {
                    const x = Number(p[0]);
                    const y = Number(p[1]);
                    if (Number.isFinite(x) && Number.isFinite(y)) {
                        pts.push({ x, y });
                    }
                }
            }
            if (pts.length >= 2) {
                out[ch] = pts;
            }
        }
    }
    return out;
};
