// Large-model backend check: loads one model on a chosen graphics backend and
// reports whether it renders (pixels), what the gsplat instance looks like
// (sorter / order target / limits), the console output and splatDiag().
//
// Motivation: a large PLY displays on WebGL2 but comes up blank when the app
// *starts* on the experimental WebGPU backend, while small models render there.
// This harness reproduces the pairing on one machine: run it once per backend
// against the same served model.
//
// usage: node docs/verify/verify-large-model-backend.cjs <modelPathUnderDist> [backend] [url]
//   node docs/verify/verify-large-model-backend.cjs big-model.ply webgpu http://localhost:3621/
const puppeteer = require('puppeteer-core');
const { analysePng } = require('./lib/png.cjs');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const MODEL = process.argv[2] || 'big-model.ply';
const BACKEND = process.argv[3] || 'webgpu';
const URL = process.argv[4] || 'http://localhost:3621/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    // no swiftshader: WebGPU needs the real adapter, and both backends must run
    // on the same GPU for the comparison to mean anything
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
    });

    const logs = [];
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        page.on('pageerror', e => logs.push('pageerror: ' + String(e).slice(0, 400)));
        page.on('console', (m) => {
            const t = m.type();
            if (t === 'error' || t === 'warning' || t === 'warn') logs.push(`${t}: ${m.text().slice(0, 400)}`);
        });

        await page.goto(`${URL}?gpu=${BACKEND}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForFunction('!!window.scene', { timeout: 90000 });
        await sleep(1500);

        const device = await page.evaluate(() => {
            const d = window.scene.graphicsDevice;
            const limits = d.limits ?? {};
            return {
                backend: d.isWebGPU ? 'webgpu' : 'webgl2',
                maxTextureSize: d.maxTextureSize ?? null,
                limits: {
                    maxBufferSizeMB: limits.maxBufferSize ? Math.round(limits.maxBufferSize / 1048576) : null,
                    maxStorageBufferBindingSizeMB: limits.maxStorageBufferBindingSize ? Math.round(limits.maxStorageBufferBindingSize / 1048576) : null,
                    maxTextureDimension2D: limits.maxTextureDimension2D ?? null,
                    maxComputeWorkgroupsPerDimension: limits.maxComputeWorkgroupsPerDimension ?? null
                }
            };
        });

        // load the model the same way the file dialog does
        const loadStart = Date.now();
        await page.evaluate(async (model) => {
            const buf = await (await fetch('./' + model)).arrayBuffer();
            await window.scene.events.invoke('import', [{ filename: model, contents: new File([buf], model) }]);
        }, MODEL);
        await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 600000 });
        const loadMs = Date.now() - loadStart;

        // give the sorter/instance a chance to settle, then look at the pixels
        await sleep(8000);

        const state = await page.evaluate(() => {
            const scene = window.scene;
            const splat = scene.getElementsByType('splat')[0];
            const instance = splat?.entity?.gsplat?.instance;
            const sorter = instance?.sorter;
            const resource = instance?.resource;
            return {
                backend: scene.graphicsDevice.isWebGPU ? 'webgpu' : 'webgl2',
                numSplats: splat?.numSplats ?? 0,
                entityEnabled: !!splat?.entity?.enabled,
                entityInScene: !!splat?.entity?.parent,
                gsplatComponent: !!splat?.entity?.gsplat,
                hasInstance: !!instance,
                hasSorter: !!sorter,
                hasOrderTexture: !!instance?.orderTexture,
                orderTargetMB: instance?.orderTexture?.width
                    ? Math.round((instance.orderTexture.width * instance.orderTexture.height * 4) / 1048576)
                    : null,
                hasStreams: !!resource?.streams,
                hasCenters: !!resource?.hasCenters,
                instanceCount: instance?.meshInstance?.instancingCount ?? null,
                diag: window.splatDiag ? window.splatDiag() : null
            };
        });

        const pixels = await page.evaluate(() => {
            const scene = window.scene;
            const source = document.querySelector('canvas');
            return new Promise((resolve) => {
                const onPostRender = () => {
                    scene.app.off('postrender', onPostRender);
                    try {
                        const w = Math.min(600, source.width);
                        const h = Math.min(400, source.height);
                        const copy = document.createElement('canvas');
                        copy.width = w;
                        copy.height = h;
                        const ctx = copy.getContext('2d');
                        ctx.drawImage(source, 0, 0, source.width, source.height, 0, 0, w, h);
                        const data = ctx.getImageData(0, 0, w, h).data;
                        const bg = [data[0], data[1], data[2]];
                        let nonBg = 0;
                        for (let i = 0; i < data.length; i += 4) {
                            const d = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
                            if (d > 30) nonBg++;
                        }
                        resolve({ total: w * h, nonBg, ratio: +(nonBg / (w * h)).toFixed(4), bg });
                    } catch (e) {
                        resolve({ error: String(e).slice(0, 200) });
                    }
                };
                scene.app.on('postrender', onPostRender);
                scene.forceRender = true;
                scene.app.renderNextFrame = true;
            });
        });

        // probe 2: read the app's own render target back through the snapshot path.
        // Independent of canvas presentation, so it says whether the model's pixels
        // exist at all (useful when the canvas readback is inconclusive, e.g. WebGPU).
        const readback = await page.evaluate(async () => {
            const scene = window.scene;
            const camera = scene.camera;
            const rt = camera.mainTarget;
            const w = Math.min(256, rt.width);
            const h = Math.min(192, rt.height);
            try {
                scene.dataProcessor.copyRt(camera.mainTarget, camera.workTarget);
                const data = new Uint8Array(w * h * 4);
                await camera.workTarget.colorBuffer.read(0, 0, w, h, { renderTarget: camera.workTarget, data });
                // count pixels far from the viewport background colour (first pixel)
                let nonBg = 0;
                for (let i = 0; i < data.length; i += 4) {
                    const d = Math.abs(data[i] - data[0]) + Math.abs(data[i + 1] - data[1]) + Math.abs(data[i + 2] - data[2]);
                    if (d > 30) nonBg++;
                }
                return { ok: true, w, h, nonBg, ratio: +(nonBg / (w * h)).toFixed(4), first: [data[0], data[1], data[2], data[3]] };
            } catch (e) {
                return { ok: false, error: String(e).slice(0, 300) };
            }
        });

        // probe 3: a real browser screenshot (composited, so it shows a WebGPU canvas
        // even when drawImage() of the canvas comes back empty)
        let shot = null;
        try {
            const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 800, height: 500 } });
            shot = analysePng(Buffer.from(png));
        } catch (e) {
            shot = { error: String(e).slice(0, 200) };
        }

        const renders = !!pixels && typeof pixels.ratio === 'number' && pixels.ratio > 0.01;
        const rendersByReadback = !!readback && readback.ok && readback.ratio > 0.01;
        const rendersByShot = !!shot && typeof shot.ratio === 'number' && shot.ratio > 0.01;
        console.log(JSON.stringify({
            requested: BACKEND,
            model: MODEL,
            loadMs,
            device,
            state,
            pixels,
            readback,
            shot,
            renders,
            rendersByReadback,
            rendersByShot,
            logs,
            failed: (state.backend !== BACKEND ? 1 : 0) + (rendersByReadback || rendersByShot || renders ? 0 : 1)
        }, null, 2));
        if (state.backend !== BACKEND || !(rendersByReadback || rendersByShot || renders)) process.exitCode = 1;
    } catch (err) {
        console.log(JSON.stringify({ fatal: String(err).slice(0, 800), logs }, null, 2));
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
