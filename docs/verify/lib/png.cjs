// Minimal PNG decoder for screenshot analysis (8-bit RGB/RGBA, no interlace).
// Kept dependency-free on purpose: puppeteer-core is the only package the
// headless harnesses are allowed to borrow.
const zlib = require('zlib');

const decodePng = (buf) => {
    if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
    let pos = 8;
    let width = 0;
    let height = 0;
    let colorType = 0;
    let bitDepth = 0;
    const idat = [];
    while (pos < buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.toString('ascii', pos + 4, pos + 8);
        const data = buf.subarray(pos + 8, pos + 8 + len);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
            if (data[12] !== 0) throw new Error('interlaced PNG unsupported');
        } else if (type === 'IDAT') {
            idat.push(data);
        } else if (type === 'IEND') {
            break;
        }
        pos += 12 + len;
    }
    if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
    const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
    if (!channels) throw new Error(`unsupported colour type ${colorType}`);

    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    const out = Buffer.alloc(height * stride);
    let prev = Buffer.alloc(stride);
    let p = 0;
    for (let y = 0; y < height; ++y) {
        const filter = raw[p++];
        const line = raw.subarray(p, p + stride);
        p += stride;
        const cur = Buffer.alloc(stride);
        for (let x = 0; x < stride; ++x) {
            const a = x >= channels ? cur[x - channels] : 0;
            const b = prev[x];
            const c = x >= channels ? prev[x - channels] : 0;
            let v = line[x];
            if (filter === 1) v += a;
            else if (filter === 2) v += b;
            else if (filter === 3) v += (a + b) >> 1;
            else if (filter === 4) {
                const pp = a + b - c;
                const pa = Math.abs(pp - a);
                const pb = Math.abs(pp - b);
                const pc = Math.abs(pp - c);
                v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
            }
            cur[x] = v & 0xff;
        }
        cur.copy(out, y * stride);
        prev = cur;
    }
    return { width, height, channels, data: out };
};

// Fraction of pixels that differ from the top-left pixel (the app's viewport
// background), plus the brightest pixel seen.
const analysePng = (buf, threshold = 30) => {
    const img = decodePng(buf);
    const { width, height, channels, data } = img;
    const bg = [data[0], data[1], data[2]];
    let nonBg = 0;
    let maxChannel = 0;
    for (let i = 0; i < data.length; i += channels) {
        const d = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
        if (d > threshold) nonBg++;
        maxChannel = Math.max(maxChannel, data[i], data[i + 1], data[i + 2]);
    }
    return { width, height, bg, nonBg, total: width * height, ratio: +(nonBg / (width * height)).toFixed(4), maxChannel };
};

module.exports = { decodePng, analysePng };
