// 纯 node 单测：曲线调色的模型与采样（src/core/color-curves.ts）。
//
// 曲线最终要落在四份数学里（GLSL/WGSL 顶点 + CPU 导出镜像 + 直方图值通路），
// 而"控制点 → 33 点采样表"只有这一份实现 —— 这里把它逐条钉死，
// 并**用一份独立的参考实现**核对 `evaluateCurveAt`（着色器里就是同一条线性插值）。
//
// usage: node --experimental-strip-types docs/verify/verify-color-curves.mts
import {
    CURVE_CHANNELS,
    CURVE_SAMPLES,
    applyCurveSetToRGB,
    applyCurveToRGB,
    curveSetFromDoc,
    curveSetToDoc,
    curveSetToTables,
    emptyCurveSet,
    evaluateCurveAt,
    identityCurveSamples,
    isIdentityCurve,
    isIdentityCurveSet,
    sampleCurve,
    toCurveSet
} from '../../src/core/color-curves.ts';

const checks: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

// ---- 1. 恒等 ----
const ident = identityCurveSamples();
check('the identity curve is y = x sampled at 33 points (and is recognised as identity)',
    ident.length === CURVE_SAMPLES && ident[0] === 0 && Math.abs(ident[CURVE_SAMPLES - 1] - 1) < 1e-6 &&
    Math.abs(ident[16] - 0.5) < 1e-6 && isIdentityCurve(ident),
    `33 点，第 17 点 = ${ident[16]}（应为 0.5），isIdentity=${isIdentityCurve(ident)}`);

check('null / short / missing curves are treated as identity (so "no curve" is safe)',
    isIdentityCurve(null) && isIdentityCurve(undefined) && isIdentityCurve(new Float32Array(4)),
    'null / undefined / 长度不足 ⇒ 都算恒等');

// ---- 2. 采样：端点、单调、不过冲 ----
const sCurve = sampleCurve([{ x: 0, y: 0 }, { x: 0.25, y: 0.15 }, { x: 0.75, y: 0.85 }, { x: 1, y: 1 }]);
check('an S-curve samples to 33 points with both endpoints pinned',
    sCurve.length === CURVE_SAMPLES && sCurve[0] === 0 && Math.abs(sCurve[CURVE_SAMPLES - 1] - 1) < 1e-6,
    `首点 ${sCurve[0]}，末点 ${sCurve[32]}，中点 ${sCurve[16].toFixed(4)}`);

const monotone = (() => {
    for (let i = 1; i < sCurve.length; i++) {
        if (sCurve[i] < sCurve[i - 1] - 1e-6) return false;
    }
    return true;
})();
check('a monotone control polygon yields a monotone sample table (Fritsch–Carlson, no overshoot)',
    monotone && sCurve.every(v => v >= -1e-6 && v <= 1 + 1e-6) &&
    sCurve[8] < 0.25 && sCurve[24] > 0.75,
    `单调=${monotone}；x=0.25 处 ${sCurve[8].toFixed(4)}（控制点 0.15，不过冲）；x=0.75 处 ${sCurve[24].toFixed(4)}（控制点 0.85）`);

const lifted = sampleCurve([{ x: 0, y: 0 }, { x: 0.5, y: 0.65 }, { x: 1, y: 1 }]);
const crushed = sampleCurve([{ x: 0, y: 0 }, { x: 0.5, y: 0.35 }, { x: 1, y: 1 }]);
check('a lifted midpoint raises mid-tones and a crushed midpoint lowers them',
    lifted[16] > 0.6 && crushed[16] < 0.4,
    `抬亮曲线中点 ${lifted[16].toFixed(4)}（控制点 0.65）；压暗曲线中点 ${crushed[16].toFixed(4)}（控制点 0.35）`);

check('a flat (constant) curve is allowed: control points can pin blacks/whites',
    (() => {
        const c = sampleCurve([{ x: 0, y: 0.2 }, { x: 1, y: 0.2 }]);
        return Math.abs(c[0] - 0.2) < 1e-6 && Math.abs(c[32] - 0.2) < 1e-6 && Math.abs(c[16] - 0.2) < 1e-6;
    })(),
    '两端都抬到 0.2 ⇒ 整条曲线恒定 0.2（抬黑）');

check('control points are clamped to [0,1] and duplicate x keeps the last point',
    (() => {
        const c = sampleCurve([{ x: -0.5, y: -1 }, { x: 0.5, y: 0.3 }, { x: 0.5, y: 0.7 }, { x: 1.5, y: 2 }]);
        return c[0] === 0 && c[32] === 1 && Math.abs(c[16] - 0.7) < 1e-6;
    })(),
    '越界被夹到 0..1；重复 x=0.5 取后一个（0.7）');

// ---- 3. evaluateCurveAt 必须与着色器同一套线性插值 ----
const referenceLookup = (table: Float32Array, x: number) => {
    // 独立参考实现（照着 GLSL/WGSL 里的 curveLookup 写一遍，故意不复用生产代码）
    const t = Math.min(1, Math.max(0, x)) * 32;
    const i0 = Math.floor(t);
    const i1 = Math.min(i0 + 1, 32);
    const a = table[i0];
    const b = table[i1];
    return a + (b - a) * (t - i0);
};
let maxDiff = 0;
for (let i = 0; i <= 200; i++) {
    const x = i / 200;
    maxDiff = Math.max(maxDiff, Math.abs(evaluateCurveAt(sCurve, x) - referenceLookup(sCurve, x)));
}
check('evaluateCurveAt matches an independent re-implementation of the shader lookup (bit-for-bit)',
    maxDiff < 1e-9,
    `200 个采样点的最大差 ${maxDiff.toExponential(2)}（着色器用同一套 33 点线性插值）`);

check('evaluateCurveAt clamps out-of-range input and passes non-finite values through',
    evaluateCurveAt(sCurve, -5) === sCurve[0] && evaluateCurveAt(sCurve, 5) === sCurve[32] &&
    Number.isNaN(evaluateCurveAt(sCurve, NaN)) && evaluateCurveAt(sCurve, Infinity) === sCurve[32],
    `x=-5 → ${evaluateCurveAt(sCurve, -5)}；x=5 → ${evaluateCurveAt(sCurve, 5)}；` +
    `x=NaN → NaN（不发明数值）；x=Infinity → ${evaluateCurveAt(sCurve, Infinity)}`);

check('an identity table is a no-op through evaluateCurveAt (mean error ≈ 0)',
    (() => {
        let e = 0;
        for (let i = 0; i <= 200; i++) {
            const x = i / 200;
            e = Math.max(e, Math.abs(evaluateCurveAt(ident, x) - x));
        }
        return e < 1e-6;
    })(),
    '恒等表逐点最大误差 < 1e-6（所以"默认不设曲线"与"显式设恒等曲线"画面一致）');

const rgb = [0.1, 0.5, 0.9];
applyCurveToRGB(rgb, lifted);
check('applyCurveToRGB applies the same curve to all three channels (RGB master curve)',
    rgb[0] > 0.1 && rgb[1] > 0.5 && rgb[2] > 0.9 - 1e-6 && rgb[0] < rgb[1] && rgb[1] <= rgb[2],
    `[0.1, 0.5, 0.9] → [${rgb.map(v => v.toFixed(4)).join(', ')}]（抬亮曲线，逐通道）`);

// ---- 4. 分通道（第十四轮）：四通道表 + 组合顺序 ----
check('emptyCurveSet / isIdentityCurveSet agree, and a partial set fills the rest with null',
    isIdentityCurveSet(emptyCurveSet()) &&
    isIdentityCurveSet(null) &&
    isIdentityCurveSet(toCurveSet({ red: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })) &&
    !isIdentityCurveSet(toCurveSet({ red: [{ x: 0, y: 0 }, { x: 1, y: 0.8 }] })) &&
    toCurveSet({ master: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }).green === null,
    '全 null、只给正常红通道 ⇒ 都算恒等；给一条压暗的红通道 ⇒ 不算；缺的通道补 null');

check('curveSetToTables lays out 4 channels × 33 samples (master first) and returns null for all-identity',
    curveSetToTables(emptyCurveSet()) === null &&
    (() => {
        const t = curveSetToTables({ red: [{ x: 0, y: 0 }, { x: 1, y: 0.5 }] });
        if (!t || t.length !== CURVE_SAMPLES * 4) {
            return false;
        }
        // 行 0（主）恒等；行 1（红）末端 ~0.5；行 2/3 恒等
        return Math.abs(t[16] - 0.5) < 1e-6 && Math.abs(t[CURVE_SAMPLES + 32] - 0.5) < 1e-6 &&
            Math.abs(t[CURVE_SAMPLES * 2 + 32] - 1) < 1e-6 && Math.abs(t[CURVE_SAMPLES * 3 + 32] - 1) < 1e-6;
    })(),
    '所有通道恒等 ⇒ null；只设红通道 ⇒ 长度 132、行 1 末端 0.5、其余两行仍是恒等');

check('the composition order is master-then-channel (out.r = f_red(f_master(x)))',
    (() => {
        const masterOnly = curveSetToTables({ master: [{ x: 0, y: 0.2 }, { x: 1, y: 1 }] })!;
        const masterAndRed = curveSetToTables({
            master: [{ x: 0, y: 0.2 }, { x: 1, y: 1 }],
            red: [{ x: 0, y: 0 }, { x: 1, y: 0.5 }]
        })!;
        const a = { r: 0.4, g: 0.4, b: 0.4 };
        const b = { r: 0.4, g: 0.4, b: 0.4 };
        applyCurveSetToRGB(a, masterOnly);     // 只过主曲线
        applyCurveSetToRGB(b, masterAndRed);   // 主曲线 + 红通道
        (globalThis as any).__comp = { a, b };
        // 红通道是 y→y/2；G/B 只过主曲线 ⇒ 必须与"只有主曲线"完全一致
        return Math.abs(b.r - a.r * 0.5) < 0.02 &&
            Math.abs(b.g - a.g) < 1e-9 && Math.abs(b.b - a.b) < 1e-9;
    })(),
    (() => {
        const c = (globalThis as any).__comp;
        return c ? `0.4 只过主曲线 ⇒ ${c.a.r.toFixed(4)}（=0.2+0.4×0.8）；再叠红通道（×0.5）⇒ R=${c.b.r.toFixed(4)}，` +
            `G/B 保持不变（${c.b.g.toFixed(4)} / ${c.b.b.toFixed(4)}）` : 'no data';
    })());

check('applyCurveSetToRGB works on {r,g,b} objects (ColorGrade) and on arrays alike',
    (() => {
        const tables = curveSetToTables({ blue: [{ x: 0, y: 0 }, { x: 1, y: 0.4 }] })!;
        const obj = { r: 0.5, g: 0.5, b: 0.5 };
        const arr = [0.5, 0.5, 0.5];
        applyCurveSetToRGB(obj, tables);
        applyCurveSetToRGB(arr, tables);
        return Math.abs(obj.r - arr[0]) < 1e-9 && Math.abs(obj.b - arr[2]) < 1e-9 && obj.b < 0.25 && obj.r > 0.45;
    })(),
    '同一组表对对象与数组结果一致；蓝通道被压到 ~0.2，红/绿保持 0.5');

// ---- 5. 文档（JSON）形式（第十七轮）：`.ssproj` 与 `.sscg` 侧车共用 ----
const docSet = toCurveSet({
    master: [{ x: 0, y: 0.05 }, { x: 0.5, y: 0.6 }, { x: 1, y: 0.98 }],
    red: [{ x: 0, y: 0 }, { x: 1, y: 0.8 }]
});
const doc = curveSetToDoc(docSet);
check('curveSetToDoc writes [[x,y],…] per channel and null for the empty ones',
    Array.isArray(doc.master) && doc.master.length === 3 && doc.master[1][0] === 0.5 && doc.master[1][1] === 0.6 &&
    Array.isArray(doc.red) && doc.red.length === 2 && doc.green === null && doc.blue === null,
    `curves=${JSON.stringify(doc)}`);

check('curveSetFromDoc round-trips the control points (and 33×4 tables stay bit-identical)',
    (() => {
        const back = curveSetFromDoc(doc);
        const t0 = curveSetToTables(docSet);
        const t1 = curveSetToTables(back);
        return JSON.stringify(back) === JSON.stringify(docSet) &&
            !!t0 && !!t1 && JSON.stringify(Array.from(t0)) === JSON.stringify(Array.from(t1));
    })(),
    '控制点逐点一致，采样表逐位一致（所以"存了再读"画面不会变）');

check('curveSetFromDoc(null / undefined / {} ) is the identity set (nothing invented)',
    isIdentityCurveSet(curveSetFromDoc(null)) &&
    isIdentityCurveSet(curveSetFromDoc(undefined)) &&
    isIdentityCurveSet(curveSetFromDoc({})),
    '侧车里 `curves: null` 与"整个字段缺失"都落到全恒等（"缺失 = 不碰"由调用方区分，见 color-grade-file.ts）');

check('curveSetFromDoc drops junk: non-pairs, non-finite values, and channels with < 2 usable points',
    (() => {
        const s = curveSetFromDoc({
            master: [[0, 0], [1, 1]],
            red: [[0, 0]],                        // 只有 1 个点 ⇒ 恒等
            green: [[0, 0], ['x', 0.5], [1, 1]],  // 中间那个不是数字对 ⇒ 丢掉
            blue: [[0, NaN], [1, 'q'], [0.5, 0.5]]
        } as any);
        return s.master!.length === 2 && s.red === null && s.green!.length === 2 && s.blue === null;
    })(),
    '红通道 1 个点 ⇒ 恒等；绿通道丢掉坏点后剩两个；蓝通道全是坏值 ⇒ 恒等（不会拿 NaN 去采样）');

check('curveSetToDoc of a cleared set is all-null (so "清空曲线"能存进侧车)',
    CURVE_CHANNELS.every(ch => curveSetToDoc(emptyCurveSet())[ch] === null) &&
    CURVE_CHANNELS.every(ch => curveSetToDoc(null)[ch] === null),
    '全恒等 / null ⇒ 四个通道都是 null');

const failed = checks.filter(c => !c.pass).length;
console.log(JSON.stringify({ checks, failed }, null, 1));
process.exit(failed === 0 ? 0 : 1);