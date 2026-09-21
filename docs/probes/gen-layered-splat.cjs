// 分层夹具（第九轮，给"运动期不依赖顺序的渲染"用）：两面**深度差距很大**、颜色不同的平板。
//
// 为什么需要它：20M fill 合成夹具虽然点很多，但 overdraw 极大、颜色相近 ⇒ 同一个位姿下把顺序换成
// 恒等顺序（= 最坏顺序）画面只差 **1.62/255**（实测）——它**对顺序错误不敏感**，测不出
// "背面内容跑到前面"这件事。真实扫描件的结构是"前景物体 + 后面一堵墙"，顺序错了前景会被墙盖住，
// 差异极大。这个夹具就是那个结构的最小化版本：
//
//   近板（z = -Z_GAP/2，暖色）在前，远板（z = +Z_GAP/2，冷色）在后，两者都是大高斯（>2px）。
//   正确顺序：远板先画、近板后画 ⇒ 看到暖色的近板。
//   最坏顺序：恒等索引（两块交错）⇒ alpha 混合下近板被远板"糊"掉一大片。
//   不透明 + 深度写：无论什么顺序，近板赢 ⇒ 与顺序无关（这就是要证明的）。
//
// 格式与仓库里其它生成器逐字节一致（见 gen-synth-large-splat.cjs 头部说明）：
//   binary_little_endian, float32 × (x y z f_dc_0 f_dc_1 f_dc_2 opacity scale_0 scale_1 scale_2 rot_0..3)
//
// usage: node docs/probes/gen-layered-splat.cjs [--out=<path>] [--points=600000] [--seed=7]
//                                               [--size=0.35] [--gap=6] [--half=4]
const fs = require('fs');
const path = require('path');

const arg = (name, dflt) => {
    const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : dflt;
};

const POINTS = parseInt(arg('points', '600000'), 10);
const SEED = parseInt(arg('seed', '7'), 10);
const OUT = arg('out', path.join(__dirname, '..', '..', '..', '_tmp', 'synth-layered.ply'));
const SIZE = parseFloat(arg('size', '0.35'));     // 高斯半尺寸（世界单位）
const GAP = parseFloat(arg('gap', '6'));          // 两板中心距
const HALF = parseFloat(arg('half', '4'));        // 每板半边长

const SH_C0 = 0.28209479177387814;

// 确定性 LCG：每次生成逐字节一致
let seed = SEED;
const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
};

// 颜色：近板暖橙，远板冷蓝（SH DC 编码）
const dc = (r, g, b) => [(r - 0.5) / SH_C0, (g - 0.5) / SH_C0, (b - 0.5) / SH_C0];
const NEAR = dc(0.95, 0.55, 0.25);
const FAR = dc(0.20, 0.40, 0.95);

const perPlane = Math.floor(POINTS / 2);
const rowStride = 14 * 4;
const header = Buffer.from(
    'ply\n' +
    'format binary_little_endian 1.0\n' +
    `element vertex ${perPlane * 2}\n` +
    'property float x\nproperty float y\nproperty float z\n' +
    'property float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\n' +
    'property float opacity\n' +
    'property float scale_0\nproperty float scale_1\nproperty float scale_2\n' +
    'property float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\n' +
    'end_header\n', 'utf8');

const buf = Buffer.alloc(perPlane * 2 * rowStride);
const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
let off = 0;
const logit = (p) => Math.log(p / (1 - p));
const logScale = Math.log(SIZE);

const writePlane = (zCenter, color) => {
    for (let i = 0; i < perPlane; i++) {
        view.setFloat32(off + 0, (rnd() * 2 - 1) * HALF, true);
        view.setFloat32(off + 4, (rnd() * 2 - 1) * HALF, true);
        view.setFloat32(off + 8, zCenter, true);
        view.setFloat32(off + 12, color[0], true);
        view.setFloat32(off + 16, color[1], true);
        view.setFloat32(off + 20, color[2], true);
        view.setFloat32(off + 24, logit(0.95), true);      // 不透明度（logit）
        view.setFloat32(off + 28, logScale, true);
        view.setFloat32(off + 32, logScale, true);
        view.setFloat32(off + 36, logScale, true);
        view.setFloat32(off + 40, 1, true);                // 四元数 (w,x,y,z) = 单位
        view.setFloat32(off + 44, 0, true);
        view.setFloat32(off + 48, 0, true);
        view.setFloat32(off + 52, 0, true);
        off += rowStride;
    }
};

// splat-transform 的 +Z 朝向约定：先写"远"（+Z）再写"近"（-Z）会让恒等顺序成为最坏顺序
writePlane(+GAP / 2, FAR);
writePlane(-GAP / 2, NEAR);

fs.writeFileSync(OUT, Buffer.concat([header, buf]));
console.log(JSON.stringify({
    out: OUT,
    splats: perPlane * 2,
    mb: +(fs.statSync(OUT).size / 1048576).toFixed(1),
    size: SIZE,
    gap: GAP,
    half: HALF
}, null, 1));
