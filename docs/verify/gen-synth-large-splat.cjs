// Large synthetic gaussian-splat fixture for performance work (P0-3 interaction degradation,
// K-way selection workers) on a machine that does NOT have the user's real scans.
//
// Why a synthetic model is needed at all: the two real models used before (a 13M-point 695 MB scan
// and a 20M-point scan) were never shipped in the handoff package, so every "20M" number in
// docs/ has to be re-measured here against something. This generator reproduces the two shape
// properties that the reported bugs actually depend on:
//
//   1. a DENSE CORE (what the user looks at) that holds most of the points, and
//   2. a FAR NOISE TAIL that inflates the AABB by ~54x (the ④ "框显所选只显示一小块" root cause:
//      the real scan's core radius was 153 while the AABB half-diagonal was 8297 = 54x).
//
// Layout follows the repo's other generators exactly (see gen-test-splat.cjs / gen-floater-biggrid-splat.cjs):
//   binary_little_endian, float32 columns in this order
//     x y z f_dc_0 f_dc_1 f_dc_2 opacity scale_0 scale_1 scale_2 rot_0 rot_1 rot_2 rot_3 [f_rest_0 .. f_rest_{n-1}]
//   opacity is a logit, scale_* are logs, rot_* is a (w, x, y, z) quaternion, and the colour is
//   SH DC encoded as (v - 0.5) / SH_C0. f_rest_* is only written when SH bands > 0, and its count
//   must be 9 / 24 / 45 (SH1 / SH2 / SH3) or the loader rejects the file.
//   The file size must be exactly headerBytes + points * rowStride or splat-transform rejects it as
//   "truncated or corrupt", so this writes into a fixed reusable block and never pads.
//
// usage: node docs/verify/gen-synth-large-splat.cjs [--out=<path>] [--points=20000000] [--sh=3] [--seed=12345]
// default out: ../_tmp/synth-large.ply  (outside dist/ on purpose: a >4 GB file in dist/ breaks
// electron-builder, and dist/*.ply must be removed before packaging — hardlink it in when needed)
const fs = require('fs');
const path = require('path');

const arg = (name, dflt) => {
    const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : dflt;
};

const POINTS = parseInt(arg('points', '20000000'), 10);
const SH = parseInt(arg('sh', '3'), 10);
const SEED = parseInt(arg('seed', '12345'), 10);
const OUT = arg('out', path.join(__dirname, '..', '..', '..', '_tmp', 'synth-large.ply'));

const SH_C0 = 0.28209479177387814;
const SH_REST = { 0: 0, 1: 9, 2: 24, 3: 45 };
if (!(SH in SH_REST)) {
    throw new Error(`--sh must be 0, 1, 2 or 3 (loader accepts 9/24/45 f_rest columns), got ${SH}`);
}

// shape: dense core of radius ~150, a room-scale surround, and a ~2% tail shell at radius ~4800
// (a sphere of radius 4800 has a half-diagonal of ~8314 => ~54x the core radius, matching the scan).
const CORE_R = 150;
const CORE_FRAC = 0.55;
const ROOM_FRAC = 0.43;
const TAIL_R = 4800;

const COLS = 14 + SH_REST[SH];
const ROW_STRIDE = COLS * 4;

// deterministic LCG, same family as the repo's other generators (no Math.random in fixtures)
let s = SEED >>> 0;
const rnd = () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x80000000;
};
const dc = (v) => (v - 0.5) / SH_C0;

const header = [
    'ply',
    'format binary_little_endian 1.0',
    'comment SplatRoom synthetic large fixture - dense core + far noise tail (gen-synth-large-splat.cjs)',
    `element vertex ${POINTS}`,
    'property float x',
    'property float y',
    'property float z',
    'property float f_dc_0',
    'property float f_dc_1',
    'property float f_dc_2',
    'property float opacity',
    'property float scale_0',
    'property float scale_1',
    'property float scale_2',
    'property float rot_0',
    'property float rot_1',
    'property float rot_2',
    'property float rot_3'
];
for (let i = 0; i < SH_REST[SH]; i++) header.push(`property float f_rest_${i}`);
header.push('end_header');
const headerBuf = Buffer.from(header.join('\n') + '\n', 'ascii');

const fd = fs.openSync(OUT, 'w');
fs.writeSync(fd, headerBuf);

const BLOCK = 500000;                       // 500k points per flush keeps the buffer ~110 MB
const buf = new Float32Array(BLOCK * COLS);
const f32 = new Float32Array(1);
const put = (idx, col, value) => {
    f32[0] = value;
    buf[idx * COLS + col] = f32[0];
};

let written = 0;
let coreCount = 0;
let tailCount = 0;
let minX = Infinity;
let maxX = -Infinity;
let minY = Infinity;
let maxY = -Infinity;
let minZ = Infinity;
let maxZ = -Infinity;

while (written < POINTS) {
    const n = Math.min(BLOCK, POINTS - written);
    for (let i = 0; i < n; i++) {
        const r = rnd();
        let x;
        let y;
        let z;
        let colour;
        let opacity;
        let scale;

        if (r < CORE_FRAC) {
            // dense core: a slightly flattened shell (an artefact-sized blob), 55% of the points
            coreCount++;
            const u = rnd() * 2 - 1;
            const phi = rnd() * Math.PI * 2;
            const w = Math.sqrt(1 - u * u);
            const rad = CORE_R * (0.86 + rnd() * 0.14);
            x = rad * w * Math.cos(phi);
            y = rad * u * 0.72;
            z = rad * w * Math.sin(phi);
            colour = [0.82, 0.72, 0.45];        // warm stone, like the scanned artefact
            opacity = 0.75 + rnd() * 0.24;
            scale = 0.006 + rnd() * 0.02;
        }
        else if (r < CORE_FRAC + ROOM_FRAC) {
            // room-scale surround: floor + walls + clutter, 43%
            const rad = 500 + rnd() * 700;
            const u = rnd() * 2 - 1;
            const phi = rnd() * Math.PI * 2;
            const w = Math.sqrt(1 - u * u);
            x = rad * w * Math.cos(phi);
            y = Math.abs(rad * u) * 0.45;
            z = rad * w * Math.sin(phi);
            colour = [0.45, 0.47, 0.5];
            opacity = 0.35 + rnd() * 0.5;
            scale = 0.03 + rnd() * 0.25;
        }
        else {
            // far noise tail: 2% spread over a shell at ~4800 => AABB inflated ~54x vs the core
            tailCount++;
            const u = rnd() * 2 - 1;
            const phi = rnd() * Math.PI * 2;
            const w = Math.sqrt(1 - u * u);
            const rad = TAIL_R * (0.83 + rnd() * 0.17);
            x = rad * w * Math.cos(phi);
            y = rad * u;
            z = rad * w * Math.sin(phi);
            colour = [0.2, 0.6, 0.3];           // green strays: easy to spot / count in a probe
            opacity = 0.05 + rnd() * 0.2;
            scale = 0.4 + rnd() * 1.6;
        }

        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;

        put(i, 0, x);
        put(i, 1, y);
        put(i, 2, z);
        put(i, 3, dc(colour[0]));
        put(i, 4, dc(colour[1]));
        put(i, 5, dc(colour[2]));
        put(i, 6, Math.log(opacity / (1 - opacity)));
        put(i, 7, Math.log(scale));
        put(i, 8, Math.log(scale));
        put(i, 9, Math.log(scale));
        put(i, 10, 1);          // (w, x, y, z) identity rotation
        put(i, 11, 0);
        put(i, 12, 0);
        put(i, 13, 0);
        // SH rest: small view-dependent values so a reduced band count is actually visible
        for (let c = 0; c < SH_REST[SH]; c++) put(i, 14 + c, (rnd() - 0.5) * 0.12);
    }
    fs.writeSync(fd, Buffer.from(buf.buffer, 0, n * ROW_STRIDE));
    written += n;
}
fs.closeSync(fd);

const size = fs.statSync(OUT).size;
const expected = headerBuf.length + POINTS * ROW_STRIDE;
const cx = (minX + maxX) / 2;
const cy = (minY + maxY) / 2;
const cz = (minZ + maxZ) / 2;
const halfDiagonal = Math.sqrt(((maxX - minX) / 2) ** 2 + ((maxY - minY) / 2) ** 2 + ((maxZ - minZ) / 2) ** 2);

console.log(JSON.stringify({
    out: OUT,
    points: POINTS,
    shBands: SH,
    columns: COLS,
    rowStride: ROW_STRIDE,
    bytesPerPoint: ROW_STRIDE,
    fileBytes: size,
    expectedBytes: expected,
    sizeMatchesHeader: size === expected,
    corePoints: coreCount,
    roomPoints: POINTS - coreCount - tailCount,
    tailPoints: tailCount,
    aabb: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ], centre: [cx, cy, cz] },
    aabbHalfDiagonal: halfDiagonal,
    coreRadius: CORE_R,
    aabbInflationVsCore: halfDiagonal / CORE_R
}, null, 1));
