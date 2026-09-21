// 纯 node 单测：曲线调色的模型与采样（src/core/color-curves.ts）。
//
// 曲线最终要落在四份数学里（GLSL/WGSL 顶点 + CPU 导出镜像 + 直方图值通路），
// 而"控制点 → 33 点采样表"只有这一份实现 —— 这里把它逐条钉死，
// 并**用一份独立的参考实现**核对 `evaluateCurveAt`（着色器里就是同一条线性插值）。
//
// usage: node --experimental-strip-types docs/verify/verify-color-curves.mts
import {
    CURVE_SAMPLES,
    applyCurveToRGB,
    evaluateCurveAt,
    identityCurveSamples,
    isIdentityCurve,
    sampleCurve
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

const failed = checks.filter(c => !c.pass).length;
console.log(JSON.stringify({ checks, failed }, null, 1));
process.exit(failed === 0 ? 0 : 1);
