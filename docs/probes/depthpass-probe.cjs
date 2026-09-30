// Does the depth pass (camera.depthPrep + readDepths) actually return data?
// The rings-mode surface band only kept 100 of 104,707 splats, and selectDepthBand skips every splat
// whose pixel came back null — so this measures the readback itself.
// usage: node depthpass-probe.cjs [model] [url]
const puppeteer = require('puppeteer-core');
const { BROWSER_PATH: EDGE , launchPatched: _launchPatched } = require('../verify/lib/browser.cjs');
const MODEL = process.argv[2] || 'test-model.ply';
const URL = process.argv[3] || 'http://localhost:3621/?gpu=webgpu';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await _launchPatched(puppeteer, {
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
    await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 300000 });
    await sleep(4000);

    const out = await page.evaluate(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const scene = window.scene;
        const splat = scene.getElementsByType('splat').slice(-1)[0];
        scene.events.fire('selection', splat);
        await sleep(500);
        scene.events.fire('camera.focus');
        await sleep(4000);
        scene.events.fire('tool.rectSelection');
        await sleep(800);

        const { width, height } = scene.targetSize;
        const info = {
            backend: scene.graphicsDevice.isWebGPU ? 'webgpu' : 'webgl2',
            target: [width, height],
            cameraNear: scene.camera.near,
            clipNear: scene.camera.camera.nearClip,
            clipFar: scene.camera.camera.farClip,
            cameraFar: scene.camera.far,
            hasDepthPrep: typeof scene.camera.depthPrep === 'function',
            hasReadDepths: typeof scene.camera.readDepths === 'function'
        };

        // a grid over the middle of the viewport, like the rings-mode wiring builds
        const x0 = Math.round(width * 0.4);
        const x1 = Math.round(width * 0.6);
        const y0 = Math.round(height * 0.4);
        const y1 = Math.round(height * 0.6);
        const step = 4;
        const columns = Math.floor((x1 - x0) / step) + 1;
        const rows = Math.floor((y1 - y0) / step) + 1;
        const points = [];
        for (let row = 0; row < rows; row++) {
            for (let column = 0; column < columns; column++) {
                points.push({ x: (x0 + column * step + 0.5) / width, y: (y0 + row * step + 0.5) / height });
            }
        }

        scene.camera.depthPrep(splat);
        const t0 = performance.now();
        const depths = await scene.camera.readDepths(points);
        info.readMs = Math.round(performance.now() - t0);
        info.samples = depths.length;
        let nonNull = 0;
        let min = Infinity;
        let max = -Infinity;
        let zeros = 0;
        for (const d of depths) {
            if (typeof d === 'number') {
                nonNull++;
                if (d < min) min = d;
                if (d > max) max = d;
                if (d === 0) zeros++;
            }
        }
        info.nonNull = nonNull;
        info.zeros = zeros;
        info.min = nonNull ? +min.toFixed(4) : null;
        info.max = nonNull ? +max.toFixed(4) : null;
        info.first10 = depths.slice(0, 10).map(d => (typeof d === 'number' ? +d.toFixed(3) : null));

        // the ACTUAL nearest splat distance at a few of those pixels, to see which near/far makes
        // normalizedToViewDistance() agree with reality
        const data = splat.splatData;
        const n = data.numSplats;
        const spx = data.getProp('x'), spy = data.getProp('y'), spz = data.getProp('z'), st = data.getProp('state');
        const world = splat.worldTransform.data;
        const cc = scene.camera.camera;
        const proj = cc.projectionMatrix.data, vm = cc.viewMatrix.data;
        const m = new Float32Array(16);
        for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) m[c * 4 + r] = proj[r] * vm[c * 4] + proj[4 + r] * vm[c * 4 + 1] + proj[8 + r] * vm[c * 4 + 2] + proj[12 + r] * vm[c * 4 + 3];
        const camPos = scene.camera.mainCamera.getPosition();
        const dir = scene.camera.mainCamera.forward;
        const nearest = new Map();
        const stride = Math.max(1, Math.floor(n / 300000));
        for (let i = 0; i < n; i += stride) {
            if ((st[i] & 3) !== 0) continue;
            const lx = spx[i], ly = spy[i], lz = spz[i];
            const wx = world[0] * lx + world[4] * ly + world[8] * lz + world[12];
            const wy = world[1] * lx + world[5] * ly + world[9] * lz + world[13];
            const wz = world[2] * lx + world[6] * ly + world[10] * lz + world[14];
            const cw = m[3] * wx + m[7] * wy + m[11] * wz + m[15];
            if (cw <= 0) continue;
            const ndcX = (m[0] * wx + m[4] * wy + m[8] * wz + m[12]) / cw;
            const ndcY = (m[1] * wx + m[5] * wy + m[9] * wz + m[13]) / cw;
            if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) continue;
            const px = Math.floor((ndcX * 0.5 + 0.5) * width);
            const py = Math.floor((1 - (ndcY * 0.5 + 0.5)) * height);
            const key = px * 4096 + py;
            const d = (wx - camPos.x) * dir.x + (wy - camPos.y) * dir.y + (wz - camPos.z) * dir.z;
            const prev = nearest.get(key);
            if (prev === undefined || d < prev) nearest.set(key, d);
        }
        const probes = [];
        for (const pt of points.slice(0, 6)) {
            const px = Math.floor(pt.x * width);
            const py = Math.floor(pt.y * height);
            probes.push({ px, py, actualNearest: +(nearest.get(px * 4096 + py) ?? -1).toFixed(3) });
        }
        info.probes = probes;
        return info;
    });
    console.log(JSON.stringify(out, null, 1));
    await browser.close();
})().catch(e => { console.log('FATAL ' + String(e).slice(0, 300)); process.exit(1); });
