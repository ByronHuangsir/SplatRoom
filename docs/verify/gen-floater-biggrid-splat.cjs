// A1 regression model: a cloud whose floater grid is FAR bigger than 2^31 cells.
//
// Why this model exists: `detectFloaters` keeps one cell index per gaussian. The index is
// (ix*nY + iy)*nZ + iz, and on the user's real 13M scan that value is ~2.4e10 (a 3061x3059x2562
// grid) — an Int32Array wraps it, every neighbour lookup then misses, the neighbour sum comes out
// 0, the median goes negative, `limit` becomes 0 and the detector reports a meaningless handful of
// floaters. This model reproduces the same *shape* (a fine grid over a wide model) at 16k points so
// the check runs in seconds.
//
// Populations (deliberately unambiguous):
//   clumps   2000 x 8 gaussians, each clump a 0.0002 cube  -> every one of them has neighbours
//   strays     50 single gaussians alone in space          -> these are the floaters
//
// The grid the detector builds is driven by the estimated point spacing (median nearest-neighbour
// distance, which is the intra-clump 0.0001) and the model extent (20 units), giving ~8700 cells
// per axis => ~6.6e11 cells, well past 2^31.
//
// usage: node docs/verify/gen-floater-biggrid-splat.cjs [outPath]
const fs = require('fs');

const out = process.argv[2] || 'dist/floater-biggrid-test.ply';

const CLUMPS = 2000;
const PER_CLUMP = 8;
const STRAYS = 50;
const EXTENT = 20;              // clumps live in a 20-unit cube
const CLUMP_SIZE = 0.0002;      // intra-clump cube: NN distance ~0.0001
const total = CLUMPS * PER_CLUMP + STRAYS;

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

// deterministic PRNG so the model is reproducible
let seed = 12345;
const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
};

const body = Buffer.alloc(total * 17 * 4);
let o = 0;
const put = (v) => {
    body.writeFloatLE(v, o);
    o += 4;
};

const opacity = 2.0;            // opaque: the faintness clause must not be what decides here
const scale = Math.log(0.002);
const writePoint = (x, y, z) => {
    put(x); put(y); put(z);
    put(0); put(0); put(1);
    put(0.5); put(0.5); put(0.5);
    put(opacity);
    put(scale); put(scale); put(scale);
    put(1); put(0); put(0); put(0);
};

for (let c = 0; c < CLUMPS; c++) {
    const cx = (rnd() - 0.5) * EXTENT;
    const cy = (rnd() - 0.5) * EXTENT;
    const cz = (rnd() - 0.5) * EXTENT;
    for (let k = 0; k < PER_CLUMP; k++) {
        writePoint(
            cx + (rnd() - 0.5) * CLUMP_SIZE,
            cy + (rnd() - 0.5) * CLUMP_SIZE,
            cz + (rnd() - 0.5) * CLUMP_SIZE
        );
    }
}

// strays: alone, far from any clump (on a shell well outside the clump cube)
for (let s = 0; s < STRAYS; s++) {
    const r = EXTENT * 0.9 + rnd() * EXTENT * 0.5;
    const a = rnd() * Math.PI * 2;
    const b = Math.acos(rnd() * 2 - 1);
    writePoint(r * Math.sin(b) * Math.cos(a), r * Math.sin(b) * Math.sin(a), r * Math.cos(b));
}

fs.writeFileSync(out, Buffer.concat([Buffer.from(header, 'ascii'), body]));
console.log(JSON.stringify({
    out,
    points: total,
    clumps: CLUMPS,
    perClump: PER_CLUMP,
    strays: STRAYS,
    expectedFloaters: STRAYS,
    expectedGridPerAxis: Math.round(EXTENT / (0.0001 * 34.5 / 1.5))
}));
