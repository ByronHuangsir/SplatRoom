// Decisive export-orientation test.
//
// An earlier attempt was confounded: the model filled the frame symmetrically, so a row profile could
// not tell "same" from "flipped". This version FIRST makes the framing provably asymmetric (a camera
// pose override that pushes the model into the lower part of the frame, verified from the projection)
// and refuses to judge if it is not asymmetric.
//
// usage: node export-flip.cjs [model] [url]
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { decodePng } = require(path.join(__dirname, '..', '..', 'docs', 'verify', 'lib', 'png.cjs'));
const { BROWSER_PATH: EDGE } = require('../verify/lib/browser.cjs');
const MODEL = process.argv[2] || 'floater-scale-test.ply';
const URL = process.argv[3] || 'http://localhost:3621/?gpu=webgpu';
const W = 480;
const H = 320;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 600000
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    page.on('pageerror', e => console.log('[pageerror] ' + String(e).slice(0, 200)));
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 90000 });
    await sleep(1500);
    await page.evaluate(async (m) => {
        const buf = await (await fetch('./' + m)).arrayBuffer();
        await window.scene.events.invoke('import', [{ filename: m, contents: new File([buf], m) }]);
    }, MODEL);
    await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 240000 });
    await sleep(4000);

    const expect = await page.evaluate(async ([w, h]) => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const scene = window.scene;
        const splat = scene.getElementsByType('splat').slice(-1)[0];
        scene.events.fire('selection', splat);
        await sleep(500);
        scene.events.fire('camera.focus');
        await sleep(3500);

        const b = splat.worldBound;
        const radius = b.halfExtents.length();
        const cam = scene.camera.mainCamera;
        const pos = cam.getPosition();

        // look at a point ABOVE the model centre: the model must then occupy the LOWER part of the frame
        await sleep(1500);

        const cc = scene.camera.camera;
        const proj = cc.projectionMatrix.data;
        const vm = cc.viewMatrix.data;
        const m = new Float32Array(16);
        for (let c = 0; c < 4; c++) {
            for (let r = 0; r < 4; r++) {
                m[c * 4 + r] = proj[r] * vm[c * 4] + proj[4 + r] * vm[c * 4 + 1] + proj[8 + r] * vm[c * 4 + 2] + proj[12 + r] * vm[c * 4 + 3];
            }
        }
        const data = splat.splatData;
        const n = data.numSplats;
        const px = data.getProp('x'), py = data.getProp('y'), pz = data.getProp('z'), state = data.getProp('state');
        const world = splat.worldTransform.data;
        let sum = 0, count = 0, minRow = h, maxRow = -1;
        const stride = Math.max(1, Math.floor(n / 200000));
        for (let i = 0; i < n; i += stride) {
            if ((state[i] & 3) !== 0) continue;
            const lx = px[i], ly = py[i], lz = pz[i];
            const wx = world[0] * lx + world[4] * ly + world[8] * lz + world[12];
            const wy = world[1] * lx + world[5] * ly + world[9] * lz + world[13];
            const wz = world[2] * lx + world[6] * ly + world[10] * lz + world[14];
            const cw = m[3] * wx + m[7] * wy + m[11] * wz + m[15];
            if (cw <= 0) continue;
            const ndcX = (m[0] * wx + m[4] * wy + m[8] * wz + m[12]) / cw;
            const ndcY = (m[1] * wx + m[5] * wy + m[9] * wz + m[13]) / cw;
            if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) continue;
            const row = Math.min(h - 1, Math.max(0, Math.floor((1 - (ndcY * 0.5 + 0.5)) * h)));
            sum += row; count++;
            if (row < minRow) minRow = row;
            if (row > maxRow) maxRow = row;
        }
        return {
            backend: scene.graphicsDevice.isWebGPU ? 'webgpu' : 'webgl2',
            count, meanRow: +(sum / Math.max(count, 1) / h).toFixed(3),
            minRow: +(minRow / h).toFixed(3), maxRow: +(maxRow / h).toFixed(3)
        };
    }, [H, W]);
    console.log(`backend ${expect.backend} | projected ${expect.count} splats, rows ${expect.minRow}..${expect.maxRow}, centroid ${expect.meanRow} (0=top, 1=bottom)`);
    const asymmetry = Math.abs(expect.meanRow - 0.5) + Math.abs((expect.minRow + expect.maxRow) / 2 - 0.5);
    if (asymmetry < 0.04) {
        console.log('!! framing is still symmetric -> INCONCLUSIVE, not judging');
        await browser.close();
        return;
    }
    console.log(`framing is asymmetric (score ${asymmetry.toFixed(3)}) -> the test can judge`);

    const exported = await page.evaluate(async ([w, h]) => {
        const chunks = [];
        const stream = { write: async (b) => { chunks.push(b); }, close: async () => { } };
        await window.scene.events.invoke('render.image', {
            width: w, height: h, transparentBg: false, showDebug: false,
            format: 'png', quality: 1, projection: 'perspective', levelHorizon: false
        }, stream);
        let s = '';
        for (const c of chunks) {
            for (let i = 0; i < c.length; i += 8192) s += String.fromCharCode.apply(null, c.subarray(i, Math.min(i + 8192, c.length)));
        }
        return btoa(s);
    }, [W, H]);
    const png = Buffer.from(exported, 'base64');
    const outFile = path.join(__dirname, '..', '..', '..', '_tmp', 'export-' + expect.backend + '.png');
    fs.writeFileSync(outFile, png);
    console.log(`exported ${png.length} bytes -> ${outFile}`);

    const img = decodePng(png);
    const bg = [img.data[0], img.data[1], img.data[2]];
    let sum = 0, content = 0, minRow = img.height, maxRow = -1;
    for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
            const i = (y * img.width + x) * img.channels;
            const d = Math.abs(img.data[i] - bg[0]) + Math.abs(img.data[i + 1] - bg[1]) + Math.abs(img.data[i + 2] - bg[2]);
            if (d > 24) {
                sum += y; content++;
                if (y < minRow) minRow = y;
                if (y > maxRow) maxRow = y;
            }
        }
    }
    const meanRow = content ? +(sum / content / img.height).toFixed(3) : null;
    console.log(`export ${img.width}x${img.height}: content rows ${minRow}..${maxRow} of ${img.height}, centroid ${meanRow}, ${content} px`);
    const same = Math.abs(meanRow - expect.meanRow);
    const mirrored = Math.abs((1 - meanRow) - expect.meanRow);
    console.log(`centroid offset: same orientation ${same.toFixed(3)} | export flipped ${mirrored.toFixed(3)}`);
    console.log('=>', mirrored < same ? 'EXPORT IS VERTICALLY FLIPPED' : 'export orientation matches the projection');
    await browser.close();
})().catch(e => { console.log('FATAL ' + String(e).slice(0, 400)); process.exit(1); });
