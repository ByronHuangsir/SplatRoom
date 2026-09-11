// Generates a tiny synthetic gaussian PLY for the headless selection checks:
// a front wall of gaussians and a second wall behind it, so depth / footprint
// selection have something meaningful to discriminate. Writes to the path given
// as argv[2].
const fs = require('fs');

const out = process.argv[2] || 'dist/test-model.ply';

const FRONT = 1200;
const BACK = 800;
const total = FRONT + BACK;

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

// log-scale for a ~2cm gaussian, logit for 0.95 opacity
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

for (let i = 0; i < FRONT; ++i) {
    write((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, 0, 0.9, 0.3, 0.3);
}
for (let i = 0; i < BACK; ++i) {
    write((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, -0.6, 0.3, 0.3, 0.9);
}

fs.writeFileSync(out, Buffer.concat([Buffer.from(header, 'ascii'), Buffer.from(data.buffer)]));
console.log(`wrote ${out}: ${total} gaussians (${FRONT} front @z=0, ${BACK} back @z=-0.6)`);
