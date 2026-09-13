// Generates a synthetic gaussian PLY with a KNOWN floater structure, for the 去浮云 detector
// checks. Three populations:
//
//   main        3000 gaussians, uniform in a 0.6-unit cube at the origin (a dense, legitimate cloud)
//   attached      40 gaussians in a thin patch ON the +X face of that cube (offset by roughly one
//                 point spacing, so they hug the surface), deliberately abnormal in the two ways
//                 the old detector keyed on: low opacity and a much larger scale. These are
//                 surface detail, NOT floaters - selecting them is the bug this model guards.
//   blobs         12 / 25 / 40 gaussians at 3 units out on +X / +Y / +Z, well clear of everything.
//   strays         5 single gaussians alone in space.
//
// The detector keys on TWO things now: how empty the space around a gaussian is (at a scale tied to the
// point spacing), measured together with how faint the gaussian is. The faintness clause exists because
// on the user's real scan the room surfaces are sampled as coarsely as the floaters, so sparseness alone
// selected the walls and floor (see docs/V3-WebGPU-现状.md 6.31). Consequence for this model: the 5 strays
// are still selected (nothing around them at all -> the count clause alone decides, whatever the opacity),
// while the 77 opaque points of the detached islands fall to the connected-cluster filter, which is where
// whole patches belong anyway. The surface patch and the main cloud are never selected.
//
// usage: node docs/verify/gen-floater-test-splat.cjs [outPath]
const fs = require('fs');

const out = process.argv[2] || 'dist/floater-test.ply';

const MAIN = 3000;
const ATTACHED = 40;
const STRAYS = 5;                 // single gaussians alone in space: what 去浮云 itself must catch
const BLOBS = [
    { count: 12, at: [3, 0, 0] },
    { count: 25, at: [0, 3, 0] },
    { count: 40, at: [0, 0, 3] }
];
const total = MAIN + ATTACHED + STRAYS + BLOBS.reduce((n, b) => n + b.count, 0);

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

const data = new Float32Array(total * 17);
let o = 0;
const write = (x, y, z, r, g, b, opacityLinear, scaleLinear) => {
    data[o++] = x;
    data[o++] = y;
    data[o++] = z;
    data[o++] = 0;
    data[o++] = 0;
    data[o++] = 1;
    data[o++] = dc(r);
    data[o++] = dc(g);
    data[o++] = dc(b);
    data[o++] = Math.log(opacityLinear / (1 - opacityLinear));   // logit
    data[o++] = Math.log(scaleLinear);
    data[o++] = Math.log(scaleLinear);
    data[o++] = Math.log(scaleLinear);
    data[o++] = 1;
    data[o++] = 0;
    data[o++] = 0;
    data[o++] = 0;
};

// main cloud: normal opacity and size
for (let i = 0; i < MAIN; i++) {
    write(
        (Math.random() - 0.5) * 0.6,
        (Math.random() - 0.5) * 0.6,
        (Math.random() - 0.5) * 0.6,
        0.8, 0.8, 0.8,
        0.95, 0.02
    );
}

// surface-hugging patch: one point spacing off the +X face (0.3 + ~0.04), low opacity, big scale
for (let i = 0; i < ATTACHED; i++) {
    write(
        0.34 + Math.random() * 0.02,
        (Math.random() - 0.5) * 0.5,
        (Math.random() - 0.5) * 0.5,
        0.9, 0.5, 0.3,
        0.08,        // very transparent
        0.12         // ten times the size of a main gaussian
    );
}

// detached blobs: whole patches of floaters - the connected-cluster filter's job
for (const { count, at } of BLOBS) {
    for (let i = 0; i < count; i++) {
        write(
            at[0] + (Math.random() - 0.5) * 0.06,
            at[1] + (Math.random() - 0.5) * 0.06,
            at[2] + (Math.random() - 0.5) * 0.06,
            0.9, 0.4, 0.2,
            0.95, 0.02
        );
    }
}

// single strays: each one alone in space (>= 0.5 units from anything else, i.e. far more than one
// point spacing), which is exactly what the 去浮云 detector is supposed to pick up
const STRAY_AT = [
    [-2.2, 1.4, 0.6],
    [1.9, -1.7, -0.9],
    [-1.3, -2.1, 1.5],
    [2.4, 2.0, -1.3],
    [0.4, -2.6, -2.3]
];
for (let i = 0; i < STRAYS; i++) {
    const at = STRAY_AT[i % STRAY_AT.length];
    write(at[0], at[1], at[2], 0.9, 0.4, 0.2, 0.95, 0.02);
}

fs.writeFileSync(out, Buffer.concat([Buffer.from(header, 'ascii'), Buffer.from(data.buffer)]));
console.log(JSON.stringify({
    out,
    total,
    main: MAIN,
    surfaceHugging: ATTACHED,
    strays: STRAYS,
    floaterBlobs: BLOBS.reduce((n, b) => n + b.count, 0),
    expected: {
        // 去浮云 的判据是"几乎空的 且 偏透明"：孤立散点无论透明度都会命中（邻居数低于 hardLimit 那一支），
        // 而这 3 团 island 的 opacity 是 0.95（不透明），所以留给下方"连通簇"处理
        floaterDetectorSelects: STRAYS,
        strays: STRAYS,
        detachedIslands: BLOBS.reduce((n, b) => n + b.count, 0),
        mustNotSelect: ATTACHED,                                           // surface detail
        clusterFilterSelects: BLOBS.reduce((n, b) => n + b.count, 0) + STRAYS   // 连通簇: patches + strays
    }
}, null, 2));

