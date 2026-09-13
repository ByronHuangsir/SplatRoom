// Generates a synthetic gaussian PLY whose geometry breaks the OLD spacing estimator, for the
// "去浮云 selects nothing on a real scan" regression.
//
//   shell   120,000 gaussians sampled uniformly on a hollow sphere of radius 1 (a dense, legitimate
//           surface: one point every ~0.01 units). The median distance from the centroid is 1.0, so
//           the old estimator ("median radius x 0.3") reported a point spacing of 0.30 - thirty times
//           the truth - and its neighbour box (half width 0.54) swallowed the whole shell.
//   strays  8 gaussians at radius 1.40, i.e. 0.40 clear of the shell, with normal opacity and scale.
//           They are unambiguously floaters (nothing within 0.40, which is ~80x the point spacing),
//           but the old box still reached the shell from there, so the old detector selected *none* of
//           them. The fixed estimator (median nearest-neighbour distance, ~0.005 here) puts the box
//           half width at ~0.17 and finds all 8.
//
// The old rule also OR-ed in a "transparent AND oversized AND far from the centre" clause; with normal
// opacity and scale none of that fires, so this model isolates the neighbour-count path.
//
// usage: node docs/verify/gen-floater-scale-test-splat.cjs [outPath]
const fs = require('fs');

const out = process.argv[2] || 'dist/floater-scale-test.ply';

const SHELL = 120000;
const SHELL_RADIUS = 1;
const STRAYS = 8;
const STRAY_RADIUS = 1.4;
const total = SHELL + STRAYS;

const header = [
    'ply',
    'format binary_little_endian 1.0',
    `element vertex ${total}`,
    'property float x',
    'property float y',
    'property float z',
    'property float nx',
    'property float ny',
    'property float nz',
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
    'property float rot_3',
    'end_header',
    ''
].join('\n');

const SH_C0 = 0.28209479177387814;
const dc = (v) => (v - 0.5) / SH_C0;
const scale = Math.log(0.006);
const opacity = Math.log(0.95 / 0.05);

const data = new Float32Array(total * 17);
let o = 0;
const write = (x, y, z, r, g, b) => {
    data[o++] = x;
    data[o++] = y;
    data[o++] = z;
    data[o++] = 0;
    data[o++] = 0;
    data[o++] = 1;
    data[o++] = dc(r);
    data[o++] = dc(g);
    data[o++] = dc(b);
    data[o++] = opacity;
    data[o++] = scale;
    data[o++] = scale;
    data[o++] = scale;
    data[o++] = 1;
    data[o++] = 0;
    data[o++] = 0;
    data[o++] = 0;
};

// uniform on the sphere: z uniform in [-1,1], phi uniform in [0, 2pi)
for (let i = 0; i < SHELL; i++) {
    const z = Math.random() * 2 - 1;
    const phi = Math.random() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    write(SHELL_RADIUS * r * Math.cos(phi), SHELL_RADIUS * r * Math.sin(phi), SHELL_RADIUS * z, 0.8, 0.8, 0.8);
}

// strays: spread evenly in direction, well outside the shell's neighbourhood box
for (let i = 0; i < STRAYS; i++) {
    const phi = (i / STRAYS) * Math.PI * 2;
    const z = (i % 2 === 0 ? 1 : -1) * (0.25 + 0.5 * (i / STRAYS));
    const r = Math.sqrt(1 - z * z);
    write(STRAY_RADIUS * r * Math.cos(phi), STRAY_RADIUS * r * Math.sin(phi), STRAY_RADIUS * z, 0.9, 0.4, 0.2);
}

fs.writeFileSync(out, Buffer.concat([Buffer.from(header, 'ascii'), Buffer.from(data.buffer)]));
console.log(JSON.stringify({
    out,
    total,
    shell: SHELL,
    shellRadius: SHELL_RADIUS,
    strays: STRAYS,
    strayRadius: STRAY_RADIUS,
    shellPointSpacing: Math.sqrt((4 * Math.PI) / SHELL).toFixed(5),
    expected: {
        floaterDetectorSelects: STRAYS,
        strayInnerRadius: 1.3,        // classification bound: anything beyond this is a stray
        shellRadius: SHELL_RADIUS
    }
}, null, 2));
