// 生成一个**没有 SH 列**的合成大模型（17 列：x/y/z + nx/ny/nz + f_dc_0..2 + opacity + scale_0..2 + rot_0..3），
// 用来标定"查看器 / SOG 导出"在**无 SH** 模型上的每行内存 —— 用户的 merged-scene 就是这种列结构，
// 而已有的夹具（scan.ply）带 48 列 SH，拿它标出来的系数对无 SH 模型偏保守、会误拦。
// usage: node gen-nosh-model.cjs [outPath] [points]
const fs = require('fs');

const out = process.argv[2] || 'dist/nosh-test.ply';
const N = Number(process.argv[3] || 1500000);

const header = [
    'ply',
    'format binary_little_endian 1.0',
    `element vertex ${N}`,
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

// 一个"房间壳"：长方体表面 + 少量内部点，模拟真实扫描的点云形态
const CHUNK = 100000;
let seed = 987654321;
const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
};

const fd = fs.openSync(out, 'w');
fs.writeSync(fd, Buffer.from(header, 'ascii'));

const buf = Buffer.alloc(CHUNK * 17 * 4);
let written = 0;
while (written < N) {
    const count = Math.min(CHUNK, N - written);
    let o = 0;
    const put = (v) => {
        buf.writeFloatLE(v, o);
        o += 4;
    };
    for (let i = 0; i < count; i++) {
        const face = Math.floor(rnd() * 6);
        let x = (rnd() - 0.5) * 20, y = (rnd() - 0.5) * 6, z = (rnd() - 0.5) * 20;
        if (face === 0) y = -3;
        else if (face === 1) y = 3;
        else if (face === 2) x = -10;
        else if (face === 3) x = 10;
        else if (face === 4) z = -10;
        else z = 10;
        put(x); put(y); put(z);
        put(0); put(0); put(1);
        put(0.5); put(0.5); put(0.5);
        put(2.0);
        put(-6); put(-6); put(-6);
        put(1); put(0); put(0); put(0);
    }
    fs.writeSync(fd, buf, 0, count * 17 * 4);
    written += count;
}
fs.closeSync(fd);
console.log(JSON.stringify({ out, points: N, columns: 17, bytes: fs.statSync(out).size }));
