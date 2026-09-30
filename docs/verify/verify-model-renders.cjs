// Pixel-level check that a loaded model actually renders, plus a dump of the
// gsplat instance state that decides it (backend, sorter/order texture,
// visibility). The selection tests only assert counts, so nothing until now
// verified that pixels reach the viewport.
//
// usage: node docs/verify/verify-model-renders.cjs [url]
const puppeteer = require('puppeteer-core');

const { BROWSER_PATH: EDGE , launchPatched: _launchPatched } = require('./lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3100/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await _launchPatched(puppeteer, {
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
    });

    const errors = [];
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        page.on('pageerror', e => errors.push('pageerror: ' + String(e).slice(0, 300)));
        page.on('console', (m) => {
            if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 300));
        });

        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForFunction('!!window.scene', { timeout: 60000 });
        await sleep(2500);

        await page.evaluate(async () => {
            const buf = await (await fetch('./test-model.ply')).arrayBuffer();
            await window.scene.events.invoke('import', [{ filename: 'test-model.ply', contents: new File([buf], 'test-model.ply') }]);
        });
        await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 60000 });
        await sleep(4000);

        const diagnostics = await page.evaluate(() => {
            const scene = window.scene;
            const splat = scene.getElementsByType('splat')[0];
            const instance = splat?.entity?.gsplat?.instance;
            const resource = instance?.resource;
            return {
                backend: scene.graphicsDevice.isWebGPU ? 'webgpu' : 'webgl2',
                splatName: splat?.name ?? null,
                numSplats: splat?.numSplats ?? 0,
                entityEnabled: !!splat?.entity?.enabled,
                entityInScene: !!splat?.entity?.parent,
                gsplatComponent: !!splat?.entity?.gsplat,
                hasInstance: !!instance,
                hasSorter: !!instance?.sorter,
                hasOrderTexture: !!instance?.orderTexture,
                hasStreams: !!resource?.streams,
                hasCenters: !!resource?.hasCenters,
                instanceCount: instance?.meshInstance?.instancingCount ?? null,
                cameraMode: scene.events.invoke('camera.mode'),
                overlay: scene.events.invoke('camera.overlay'),
                splatSize: scene.events.invoke('camera.splatSize')
            };
        });

        // sample the drawing buffer inside a postrender callback: with
        // preserveDrawingBuffer off (PlayCanvas default) the buffer is cleared
        // once the frame is composited, so reading it from outside the render
        // loop always reports an empty viewport
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

                        // background is whatever colour the corner shows
                        const bg = [data[0], data[1], data[2]];
                        let nonBg = 0;
                        let maxChannel = 0;
                        for (let i = 0; i < data.length; i += 4) {
                            const d = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
                            if (d > 30) nonBg++;
                            maxChannel = Math.max(maxChannel, data[i], data[i + 1], data[i + 2]);
                        }
                        resolve({ total: w * h, nonBg, maxChannel, bg });
                    } catch (e) {
                        resolve({ error: String(e).slice(0, 200) });
                    }
                };
                scene.app.on('postrender', onPostRender);
                // make sure a frame is rendered even when the scene is idle
                scene.forceRender = true;
                scene.app.renderNextFrame = true;
            });
        });

        // the console helper must agree with reality: ok for a healthy model,
        // and a specific "missing" list once the instance is stripped
        const diag = await page.evaluate(() => {
            const scene = window.scene;
            const splat = scene.getElementsByType('splat')[0];
            const instance = splat.entity.gsplat.instance;
            const healthy = window.splatDiag ? window.splatDiag()[0] : null;

            const savedSorter = instance.sorter;
            const savedOrder = instance.orderTexture;
            instance.sorter = null;
            instance.orderTexture = undefined;
            const bare = window.splatDiag ? window.splatDiag()[0] : null;
            instance.sorter = savedSorter;
            instance.orderTexture = savedOrder;

            return { healthy, bare };
        });

        const checks = [
            { name: 'splat element loaded', pass: diagnostics.numSplats > 0, detail: `${diagnostics.numSplats} splats` },
            { name: 'entity is in the scene and enabled', pass: diagnostics.entityInScene && diagnostics.entityEnabled },
            { name: 'gsplat instance exists', pass: diagnostics.hasInstance },
            { name: 'renderable (sorter + order texture)', pass: diagnostics.hasSorter && diagnostics.hasOrderTexture },
            { name: 'viewport drew more than background', pass: !!pixels && pixels.nonBg / pixels.total > 0.01, detail: pixels ? `${((pixels.nonBg / pixels.total) * 100).toFixed(1)}% non-background` : 'no gl context' },
            { name: 'splatDiag() reports a healthy model', pass: !!diag.healthy && diag.healthy.ok === true, detail: diag.healthy?.summary ?? 'missing' },
            { name: 'splatDiag() names the missing pieces', pass: !!diag.bare && diag.bare.ok === false && /hasSorter|hasOrderTexture/.test(diag.bare.summary), detail: diag.bare?.summary ?? 'missing' }
        ];

        console.log(JSON.stringify({ diagnostics, pixels, diag, checks, failed: checks.filter(c => !c.pass).length, errors }, null, 2));
        if (checks.some(c => !c.pass) || errors.length) process.exitCode = 1;
    } catch (err) {
        console.log(JSON.stringify({ fatal: String(err).slice(0, 700), errors }, null, 2));
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
