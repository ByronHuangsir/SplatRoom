// Verify the surface refine worker pipeline on synthetic data.
// Loads the built dist/surface-worker.js with a mocked `self` (postMessage),
// feeds a small synthetic gaussian cloud, and asserts the result is sane.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// ---- mock worker global ----
let captured = null;
const selfMock = {
    location: { href: 'file:///D:/DeepSeek/SplatRoomV2/SplatRoomV2-5/dist/index.html' },
    postMessage: (payload) => { captured = payload; },
    onmessage: null
};
globalThis.self = selfMock;

const code = await readFile('dist/surface-worker.js', 'utf8');
// Rewrite the bare import to an absolute file URL so node can resolve it.
const rewritten = code.replace(
    /from"([^"]+)"/g,
    (m, p) => {
        if (p.startsWith('./') || p.startsWith('../')) {
            const url = pathToFileURL(new URL(p, new URL('dist/surface-worker.js', pathToFileURL(process.cwd() + '/')).href)).href;
            return `from"${url}"`;
        }
        return m;
    }
);

const tmp = 'dist/.surface-worker-test.mjs';
await import('node:fs/promises').then(fs => fs.writeFile(tmp, rewritten, 'utf8'));

// Build a synthetic gaussian cloud: a flat disk (surface) + a few outliers.
const N = 4000;
const x = new Float32Array(N);
const y = new Float32Array(N);
const z = new Float32Array(N);
const s0 = new Float32Array(N);
const s1 = new Float32Array(N);
const s2 = new Float32Array(N);
const r0 = new Float32Array(N);
const r1 = new Float32Array(N);
const r2 = new Float32Array(N);
const r3 = new Float32Array(N);
const op = new Float32Array(N);
const state = new Uint8Array(N);

let seed = 12345;
const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
};

for (let i = 0; i < N; i++) {
    // Flat disk in the xy plane, thickness 0.05, radius ~3
    const a = rnd() * Math.PI * 2;
    const rad = Math.sqrt(rnd()) * 3;
    x[i] = Math.cos(a) * rad;
    y[i] = Math.sin(a) * rad;
    z[i] = (rnd() - 0.5) * 0.1;
    // log-scale: flat pancake (z much smaller)
    const ls = 0.08 + rnd() * 0.05;
    s0[i] = Math.log(ls);
    s1[i] = Math.log(ls);
    s2[i] = Math.log(0.02);
    // identity-ish quaternion
    r0[i] = 0; r1[i] = 0; r2[i] = 0; r3[i] = 1;
    op[i] = 5; // opaque
    state[i] = 0;
}
// Add 20 protruding outliers far off the disk (huge scale, far z)
for (let i = N - 20; i < N; i++) {
    x[i] = rnd() * 6 - 3;
    y[i] = rnd() * 6 - 3;
    z[i] = 5 + rnd() * 2;
    s0[i] = s1[i] = s2[i] = Math.log(2.0);
    op[i] = 5;
    state[i] = 0;
}

const input = {
    id: 1,
    type: 'refine',
    options: { strength: 0.6, edgeSplit: true, removeScatter: true, targetSplitSize: 0 },
    x, y, z, s0, s1, s2, r0, r1, r2, r3, op, state,
    extra: [],
    N
};

const mod = await import(pathToFileURL(tmp).href);
selfMock.onmessage({ data: input });

// worker runs async; wait for postMessage
let waited = 0;
while (!captured && waited < 200) {
    await new Promise(r => setTimeout(r, 50));
    waited++;
}

const out = captured;
if (!out) {
    console.error('FAIL: worker never posted a result');
    process.exit(1);
}

console.log('=== worker result ===');
console.log('flattened:', out.flattened, 'splitAdded:', out.splitAdded, 'removed:', out.removed);
console.log('outlierCount:', out.outlierCount, 'surfaceCount:', out.surfaceCount);
console.log('totalBefore:', out.totalBefore, 'totalAfter:', out.totalAfter, 'outCount:', out.outCount);
console.log('has columns:', !!out.x && !!out.state);

// Sanity checks
let fail = false;
if (out.totalBefore !== N) { console.error('FAIL totalBefore'); fail = true; }
if (out.outCount !== out.totalAfter) { console.error('FAIL outCount mismatch'); fail = true; }
const ox = out.x, oy = out.y, oz = out.z, os0 = out.scale_0, os1 = out.scale_1, os2 = out.scale_2;
for (let i = 0; i < out.outCount; i++) {
    for (const v of [ox[i], oy[i], oz[i], os0[i], os1[i], os2[i]]) {
        if (Number.isNaN(v) || !Number.isFinite(v)) {
            console.error(`FAIL non-finite value at ${i}: ${v}`);
            fail = true;
            break;
        }
    }
    if (fail) break;
}
if (!fail) {
    console.log('=== ALL SANITY CHECKS PASSED ===');
    process.exit(0);
} else {
    process.exit(1);
}
