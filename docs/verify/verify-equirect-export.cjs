// Verify the 360 / equirectangular export ("render.image" with projection: equirect).
//
// Three separate WebGPU-only defects used to hide here behind a *successful* call that
// produced a fully transparent 512x256 frame (588 bytes):
//   1. the projector readback used the deferred Texture.read path, which resolves with an
//      all-zero buffer on WebGPU (now immediate: true, like the frame readback),
//   2. the projector's face lookups sat inside a per-face weight branch, and WGSL rejects
//      implicit-derivative sampling (textureSample) in non-uniform control flow, so the
//      shader silently failed to build (now texture2DLod(..., 0.0)),
//   3. gl_FragCoord starts at the top-left on WebGPU while the capture basis is the GL
//      bottom-left one, so the panorama came out upside down (now flipped under
//      GSPLAT_FRAGCOORD_TOPLEFT).
//
// Checks: the export returns real pixels, the result looks like a panorama (background plus
// content across the full width), and - when a reference png from the other backend is given
// - the frame matches that reference in the same orientation rather than a flipped one.
//
// usage: node docs/verify/verify-equirect-export.cjs "<url>" [model] [--ref <otherBackendPng>] [--out <png>]
const fs = require('fs');
const path = require('path');
const puppeteer = require('C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
const { decodePng } = require('./lib/png.cjs');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const args = process.argv.slice(2);
const URL = args[0] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = args[1] && !args[1].startsWith('--') ? args[1] : 'test-model.ply';
const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};
const REF = opt('--ref');
const OUT = opt('--out');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const WIDTH = 512;
const HEIGHT = 256;

const stats = (buf) => {
    const img = decodePng(buf);
    const { width: w, height: h, channels: ch, data } = img;
    let opaque = 0;
    let content = 0;
    const colContent = new Uint32Array(w);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * ch;
            const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
            const alpha = ch > 3 ? data[i + 3] : 255;
            if (alpha > 250) opaque++;
            if (lum > 12) {
                content++;
                colContent[x]++;
            }
        }
    }
    // how many of the 16 horizontal slices carry content: a panorama of a centred model has
    // content spread around the horizon, a broken/empty frame has none anywhere
    let columnsWithContent = 0;
    for (let x = 0; x < w; x++) if (colContent[x] > 0) columnsWithContent++;
    // and how many of the four horizontal quarters carry content: a frame projected from a
    // single face (or a failed projection) stays inside one quarter
    let quartersWithContent = 0;
    for (let q = 0; q < 4; q++) {
        let n = 0;
        for (let x = Math.floor(q * w / 4); x < Math.floor((q + 1) * w / 4); x++) if (colContent[x] > 0) n++;
        if (n > 0) quartersWithContent++;
    }
    return {
        size: [w, h],
        opaquePct: +(opaque / (w * h) * 100).toFixed(2),
        contentPct: +(content / (w * h) * 100).toFixed(2),
        columnCoveragePct: +(columnsWithContent / w * 100).toFixed(1),
        quartersWithContent
    };
};

const compareWithReference = (buf, refFile) => {
    const A = decodePng(buf);
    const B = decodePng(fs.readFileSync(refFile));
    const w = Math.min(A.width, B.width);
    const h = Math.min(A.height, B.height);
    const diff = (flip) => {
        let sum = 0;
        for (let y = 0; y < h; y++) {
            const by = flip ? (B.height - 1 - y) : y;
            for (let x = 0; x < w; x++) {
                const ia = (y * A.width + x) * A.channels;
                const ib = (by * B.width + x) * B.channels;
                sum += (Math.abs(A.data[ia] - B.data[ib]) + Math.abs(A.data[ia + 1] - B.data[ib + 1]) + Math.abs(A.data[ia + 2] - B.data[ib + 2])) / 3;
            }
        }
        return +(sum / (w * h)).toFixed(3);
    };
    return { direct: diff(false), flipped: diff(true) };
};

(async () => {
    const logs = [];
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
    });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        // a shader that fails to build is reported through console.log by the WebGPU path,
        // so collect every non-log message and the log lines that mention sampling
        page.on('console', (m) => {
            const t = m.text();
            if (m.type() === 'error' || /must only be called from uniform control flow|control flow depends/.test(t)) {
                logs.push(`${m.type()}: ${t.slice(0, 200)}`);
            }
        });
        page.on('pageerror', e => logs.push('pageerror: ' + String(e).slice(0, 200)));

        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForFunction('!!window.scene', { timeout: 90000 });
        await sleep(1500);
        await page.evaluate(async (model) => {
            const buf = await (await fetch('./' + model)).arrayBuffer();
            await window.scene.events.invoke('import', [{ filename: model, contents: new File([buf], model) }]);
        }, MODEL);
        await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 120000 });
        await sleep(3000);

        // tilt the camera: a vertically symmetric frame could not reveal a flip
        await page.evaluate(() => window.scene.camera.mainCamera.setEulerAngles(20, 30, 0));
        await sleep(800);

        const runExport = (settings) => page.evaluate(async (s) => {
            const scene = window.scene;
            const chunks = [];
            const stream = {
                write: async (bytes) => { chunks.push(Array.from(bytes)); },
                close: async () => { }
            };
            let result = null;
            let error = null;
            try {
                result = await scene.events.invoke('render.image', s, stream);
            } catch (e) {
                error = String(e).slice(0, 300);
            }
            const total = chunks.reduce((n, c) => n + c.length, 0);
            const all = new Uint8Array(total);
            let o = 0;
            for (const c of chunks) { all.set(c, o); o += c.length; }
            let b64 = '';
            for (let i = 0; i < all.length; i += 0x8000) b64 += String.fromCharCode.apply(null, all.subarray(i, i + 0x8000));
            return {
                result,
                error,
                bytes: total,
                backend: scene.graphicsDevice.isWebGPU ? 'webgpu' : 'webgl2',
                b64: btoa(b64)
            };
        }, settings);

        const common = {
            width: WIDTH, height: HEIGHT, transparentBg: false, showDebug: false, format: 'png', levelHorizon: true
        };
        const equirect = await runExport({ ...common, projection: 'equirect' });
        const perspective = await runExport({ ...common, projection: 'perspective' });

        let pano = null;
        let panoStats = null;
        let panoCompare = null;
        const eqBytes = Buffer.from(equirect.b64, 'base64');
        delete equirect.b64;
        delete perspective.b64;
        const isPng = eqBytes.length > 8 && eqBytes[0] === 0x89 && eqBytes[1] === 0x50 && eqBytes[2] === 0x4e && eqBytes[3] === 0x47;
        if (isPng) {
            pano = eqBytes;
            panoStats = stats(eqBytes);
            if (OUT) {
                fs.mkdirSync(path.dirname(OUT), { recursive: true });
                fs.writeFileSync(OUT, eqBytes);
            }
            if (REF) panoCompare = compareWithReference(eqBytes, REF);
        }

        const checks = [
            {
                name: '360 export renders and encodes a PNG',
                pass: equirect.result === true && isPng && equirect.error === null,
                detail: `result=${equirect.result} bytes=${equirect.bytes} png=${isPng} ${equirect.error ?? ''}`
            },
            {
                name: '360 frame is not a blank/transparent frame',
                pass: !!panoStats && panoStats.opaquePct > 99 && panoStats.contentPct > 3,
                detail: panoStats
                    ? `opaque=${panoStats.opaquePct}% content=${panoStats.contentPct}% (a blank frame is 0% opaque, 0% content)`
                    : 'no png to inspect'
            },
            {
                name: 'panorama content spans several faces (not one quadrant)',
                // >= 2 rather than 4: how many quarters carry *any* pixel above the
                // background threshold depends on how far a few faint splats reach, which
                // legitimately differs a little between backends. A failed or single-face
                // projection stays inside one quarter.
                pass: !!panoStats && panoStats.quartersWithContent >= 2,
                detail: panoStats
                    ? `${panoStats.quartersWithContent}/4 horizontal quarters carry content, ${panoStats.columnCoveragePct}% of columns`
                    : 'no png to inspect'
            },
            {
                name: 'the equirect frame differs from the perspective frame (projection was applied)',
                pass: equirect.bytes !== perspective.bytes && perspective.bytes > 0,
                detail: `equirect=${equirect.bytes} bytes, perspective=${perspective.bytes} bytes`
            },
            {
                name: 'projector shader builds on this backend',
                pass: !logs.some(l => /uniform control flow|control flow depends/.test(l)),
                detail: logs.length ? JSON.stringify(logs.slice(0, 3)) : 'no shader build complaints'
            },
            {
                name: 'backend makes no console errors',
                pass: logs.length === 0,
                detail: logs.length ? JSON.stringify(logs.slice(0, 3)) : 'clean'
            }
        ];

        if (panoCompare) {
            checks.push({
                name: 'orientation matches the reference backend',
                pass: panoCompare.direct < 2 && panoCompare.direct < panoCompare.flipped,
                detail: `mean abs diff: same orientation ${panoCompare.direct}, flipped ${panoCompare.flipped} (reference ${path.basename(REF)})`
            });
        }

        console.log(JSON.stringify({
            backend: equirect.backend,
            url: URL,
            out: OUT ?? null,
            equirect,
            perspective,
            panorama: panoStats,
            reference: panoCompare,
            checks,
            failed: checks.filter(c => !c.pass).length,
            logs
        }, null, 2));
        if (checks.some(c => !c.pass)) process.exitCode = 1;
    } catch (e) {
        console.log(JSON.stringify({ fatal: String(e).slice(0, 400), logs }, null, 2));
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
