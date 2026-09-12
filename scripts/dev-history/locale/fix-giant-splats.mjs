// Fix a 3DGS PLY containing a layer of giant grey semi-transparent splats
// (f_dc≈0, opacity≈0, scale >> scene diagonal). Such splats make the renderer
// explode with fill-rate (GPU timeout -> black screen -> white UI).
//
// Detection (conservative, matches the app-side sanitizer):
//   - linear max scale  > diag * GIANT_SCALE_RATIO
//   - |f_dc_0|+|f_dc_1|+|f_dc_2| < GREY_DC_EPS     (neutral grey, uninitialized)
//   - |opacity|           < GREY_OPACITY_EPS       (half-transparent, uninitialized)
//
// Modes:
//   shrink (default): keep every splat but clamp the giant ones' scale down to
//     diag * SHRINK_SCALE_RATIO (preserves the "background ball" coverage the
//     user wants while keeping fill-rate sane). Use --mode=remove to delete
//     the giant splats instead (kept for files where they are pure junk).
//
// Usage: node scripts/fix-giant-splats.mjs <file.ply> [out.ply] [--mode=shrink|remove]
import { openSync, readSync, writeSync, statSync, closeSync } from 'node:fs';

const path = process.argv[2];
if (!path || path.startsWith('--')) { console.error('usage: node fix-giant-splats.mjs <file.ply> [out.ply] [--mode=shrink|remove]'); process.exit(1); }
const args = process.argv.slice(3);
const outPath = args.find(a => !a.startsWith('--')) || path.replace(/\.ply$/i, '-修复.ply');
const mode = (args.find(a => a.startsWith('--mode=')) || '--mode=shrink').split('=')[1];
if (mode !== 'shrink' && mode !== 'remove') { console.error('mode must be shrink or remove'); process.exit(1); }

const GIANT_SCALE_RATIO = 0.005;   // detection: linear scale > 0.5% of scene diagonal
const SHRINK_SCALE_RATIO = 0.001;  // shrink target: linear max scale = 0.1% of diagonal
const GREY_DC_EPS = 0.01;
const GREY_OPACITY_EPS = 0.1;

// ---- parse header ----
const fd = openSync(path, 'r');
const headerBuf = Buffer.alloc(1 << 16);
const headerLen = readSync(fd, headerBuf, 0, headerBuf.length, 0);
const headerText = headerBuf.toString('latin1', 0, headerLen);
const endIdx = headerText.indexOf('end_header');
if (endIdx < 0) { console.error('no end_header'); process.exit(1); }
const dataOffset = endIdx + 'end_header'.length + 1;
const headerLines = headerText.split('\n');

let vertexCount = 0;
const props = [];
let inVertex = false;
for (const line of headerLines) {
    if (line.startsWith('element vertex')) {
        vertexCount = Number(line.split(/\s+/)[2]);
        inVertex = true;
        continue;
    }
    if (line.startsWith('element ')) { inVertex = false; continue; }
    if (inVertex && line.startsWith('property ')) {
        const p = line.split(/\s+/);
        props.push({ type: p[1], name: p[2] });
    }
}
let stride = 0;
for (const p of props) {
    switch (p.type) {
        case 'float': case 'int': case 'uint': stride += 4; break;
        case 'double': stride += 8; break;
        case 'uchar': case 'char': stride += 1; break;
        case 'ushort': case 'short': stride += 2; break;
        default: throw new Error(`unhandled type ${p.type}`);
    }
}
const fileSize = statSync(path).size;
const dataBytes = fileSize - dataOffset;
console.log(`input: ${vertexCount.toLocaleString()} vertices, ${props.length} props, stride=${stride}, data=${(dataBytes / 1048576).toFixed(1)} MB`);

const po = {};
let off = 0;
for (const p of props) {
    const size = p.type === 'double' ? 8 : (p.type === 'uchar' || p.type === 'char') ? 1 : (p.type === 'ushort' || p.type === 'short') ? 2 : 4;
    po[p.name] = off;
    off += size;
}
const need = ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity'];
const missing = need.filter(n => !(n in po));
if (missing.length) { console.error('missing props:', missing.join(',')); process.exit(1); }

// ---- pass 1: bounds (for scene diagonal) ----
let minX = Infinity, minY = Infinity, minZ = Infinity;
let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
{
    const buf = Buffer.alloc(4 << 20);
    let o = dataOffset, rem = dataBytes;
    while (rem > 0) {
        const want = Math.min(buf.length, rem);
        const got = readSync(fd, buf, 0, want, o);
        if (got <= 0) break;
        const view = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(got / 4));
        const n = Math.floor(got / stride);
        for (let i = 0; i < n; i++) {
            const b = i * stride / 4;
            const x = view[b + po.x / 4], y = view[b + po.y / 4], z = view[b + po.z / 4];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
        o += n * stride; rem -= n * stride;
    }
}
const diag = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2);
const scaleThresh = diag * GIANT_SCALE_RATIO;
console.log(`bounds: x[${minX.toFixed(2)},${maxX.toFixed(2)}] y[${minY.toFixed(2)},${maxY.toFixed(2)}] z[${minZ.toFixed(2)},${maxZ.toFixed(2)}] diag=${diag.toFixed(2)}`);
console.log(`giant threshold: linear scale > ${scaleThresh.toFixed(4)} (log > ${Math.log(scaleThresh).toFixed(3)})`);

// ---- pass 2: classify + write filtered output ----
const keep = new Uint8Array(vertexCount);
let giant = 0, greyGiant = 0, kept = 0, shrunk = 0;
let maxGiantLog = -Infinity, minNormalLog = Infinity;
const shrinkLog = Math.log(scaleThresh * (SHRINK_SCALE_RATIO / GIANT_SCALE_RATIO)); // = log(diag * SHRINK_SCALE_RATIO)
console.log(`shrink target: linear max scale = ${Math.exp(shrinkLog).toFixed(4)} (log ${shrinkLog.toFixed(3)})`);
{
    const buf = Buffer.alloc(4 << 20);
    let o = dataOffset, rem = dataBytes;
    let idx = 0;
    while (rem > 0) {
        const want = Math.min(buf.length, rem);
        const got = readSync(fd, buf, 0, want, o);
        if (got <= 0) break;
        const view = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(got / 4));
        const n = Math.floor(got / stride);
        for (let i = 0; i < n; i++, idx++) {
            const b = i * stride / 4;
            const mx = Math.max(view[b + po.scale_0 / 4], view[b + po.scale_1 / 4], view[b + po.scale_2 / 4]);
            const lin = Math.exp(mx);
            const isBig = lin > scaleThresh;
            const grey = Math.abs(view[b + po.f_dc_0 / 4]) + Math.abs(view[b + po.f_dc_1 / 4]) + Math.abs(view[b + po.f_dc_2 / 4]) < GREY_DC_EPS;
            const faint = Math.abs(view[b + po.opacity / 4]) < GREY_OPACITY_EPS;
            if (isBig) {
                giant++;
                if (grey && faint) greyGiant++;
                if (mx > maxGiantLog) maxGiantLog = mx;
            } else {
                if (mx < minNormalLog) minNormalLog = mx;
            }
            if (mode === 'remove') {
                keep[idx] = (isBig && grey && faint) ? 0 : 1;
            } else {
                keep[idx] = 1;
            }
            if (keep[idx]) kept++;
        }
        o += n * stride; rem -= n * stride;
    }
}
console.log(`classification: giant=${giant.toLocaleString()} greyGiant=${greyGiant.toLocaleString()} mode=${mode} kept=${kept.toLocaleString()}`);

// ---- write output PLY ----
const outFd = openSync(outPath, 'w');
const headerOut =
    `ply\nformat binary_little_endian 1.0\nelement vertex ${kept}\n` +
    props.map(p => `property ${p.type} ${p.name}`).join('\n') + '\nend_header\n';
writeSync(outFd, Buffer.from(headerOut, 'latin1'));

{
    const buf = Buffer.alloc(4 << 20);
    const outBuf = Buffer.alloc(4 << 20);
    let o = dataOffset, rem = dataBytes;
    let idx = 0;
    while (rem > 0) {
        const want = Math.min(buf.length, rem);
        const got = readSync(fd, buf, 0, want, o);
        if (got <= 0) break;
        const view = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(got / 4));
        const n = Math.floor(got / stride);
        let outLen = 0;
        for (let i = 0; i < n; i++, idx++) {
            if (!keep[idx]) continue;
            const src = i * stride;
            const dst = outLen;
            buf.copy(outBuf, dst, src, src + stride);
            if (mode === 'shrink') {
                // clamp giant grey splats' scale: subtract the same log amount
                // from all three axes so the ellipsoid shape is preserved but
                // its max axis lands on shrinkLog.
                const ob = new Float32Array(outBuf.buffer, outBuf.byteOffset + dst, stride / 4);
                const s0 = ob[po.scale_0 / 4];
                const s1 = ob[po.scale_1 / 4];
                const s2 = ob[po.scale_2 / 4];
                const mx = Math.max(s0, s1, s2);
                const giantGrey = Math.exp(mx) > scaleThresh &&
                    Math.abs(ob[po.f_dc_0 / 4]) + Math.abs(ob[po.f_dc_1 / 4]) + Math.abs(ob[po.f_dc_2 / 4]) < GREY_DC_EPS &&
                    Math.abs(ob[po.opacity / 4]) < GREY_OPACITY_EPS;
                if (giantGrey && mx > shrinkLog) {
                    const delta = shrinkLog - mx;
                    ob[po.scale_0 / 4] = s0 + delta;
                    ob[po.scale_1 / 4] = s1 + delta;
                    ob[po.scale_2 / 4] = s2 + delta;
                    shrunk++;
                }
            }
            outLen += stride;
        }
        writeSync(outFd, outBuf.subarray(0, outLen));
        o += n * stride; rem -= n * stride;
    }
}
closeSync(outFd);
closeSync(fd);

console.log(`\nwritten: ${outPath}`);
if (mode === 'remove') {
    console.log(`  removed ${greyGiant.toLocaleString()} grey-giant splats (${(100 * greyGiant / vertexCount).toFixed(1)}%), kept ${kept.toLocaleString()}`);
} else {
    console.log(`  shrunk ${shrunk.toLocaleString()} grey-giant splats to max scale ${Math.exp(shrinkLog).toFixed(4)} (${(100 * shrunk / vertexCount).toFixed(1)}%), kept all ${kept.toLocaleString()}`);
}
