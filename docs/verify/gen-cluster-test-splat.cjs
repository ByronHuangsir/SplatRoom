// Generates a synthetic gaussian PLY with a KNOWN cluster structure, for the connected-cluster
// filter checks: one dense main cloud at the origin plus three small, well-separated blobs.
//
//   main   3000 gaussians, uniform in a 0.6-unit cube centred on the origin
//   blob A   12 gaussians at (3, 0, 0)
//   blob B   25 gaussians at (0, 3, 0)
//   blob C   40 gaussians at (0, 0, 3)
//
// With the cluster filter's defaults (detail 50, mode "small", threshold 2% of the largest
// cluster = 60 gaussians) all three blobs count as small and the main cloud never does, so the
// expected mask is exactly 12 + 25 + 40 = 77 gaussians, and the expected cluster count is 4.
//
// usage: node docs/verify/gen-cluster-test-splat.cjs [outPath]
const fs = require('fs');

const out = process.argv[2] || 'dist/cluster-test.ply';

const MAIN = 3000;
const BLOBS = [
    { count: 12, at: [3, 0, 0] },
    { count: 25, at: [0, 3, 0] },
    { count: 40, at: [0, 0, 3] }
];
const total = MAIN + BLOBS.reduce((n, b) => n + b.count, 0);

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
const scale = Math.log(0.02);
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

// main cloud: dense enough that adjacent points land in neighbouring voxels at the default
// detail level, so it forms exactly one cluster
for (let i = 0; i < MAIN; i++) {
    write(
        (Math.random() - 0.5) * 0.6,
        (Math.random() - 0.5) * 0.6,
        (Math.random() - 0.5) * 0.6,
        0.8, 0.8, 0.8
    );
}

// small blobs: tight (every point inside one voxel at the default detail) and 3 units away from
// everything else, so they are separate clusters and never touch the main cloud
for (const { count, at } of BLOBS) {
    for (let i = 0; i < count; i++) {
        write(
            at[0] + (Math.random() - 0.5) * 0.06,
            at[1] + (Math.random() - 0.5) * 0.06,
            at[2] + (Math.random() - 0.5) * 0.06,
            0.9, 0.4, 0.2
        );
    }
}

fs.writeFileSync(out, Buffer.concat([Buffer.from(header, 'ascii'), Buffer.from(data.buffer)]));
console.log(JSON.stringify({
    out,
    total,
    main: MAIN,
    blobs: BLOBS.map(b => ({ count: b.count, at: b.at })),
    expectedClusters: 1 + BLOBS.length,
    expectedSmallMask: BLOBS.reduce((n, b) => n + b.count, 0)
}, null, 2));
