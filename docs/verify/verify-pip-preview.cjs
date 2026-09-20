// Verify the picture-in-picture camera preview on a chosen backend.
//
// The PiP renders the shared splat material from the animation-path camera with its own
// depth-sort pipeline: an independent GSplatSorter plus its own order storage. That storage
// is an R32U order texture on WebGL2 and an order storage buffer on WebGPU (the engine's
// WGSL reads splatOrder as array<u32> there), so this exercises the buffer write path and
// the swap/restore of the shared material's splatOrder parameter.
//
// usage: node docs/verify/verify-pip-preview.cjs "<url>" [model]
const puppeteer = require('puppeteer-core');
const { decodePng } = require('./lib/png.cjs');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The preview runs on a frame-rate throttle (every 6th rendered frame), and the app only
// renders on demand, so a check has to force a burst of frames rather than wait.
const pumpFrames = async (page, frames = 16) => {
    await page.evaluate(async (n) => {
        const scene = window.scene;
        for (let i = 0; i < n; i++) {
            scene.forceRender = true;
            scene.app.renderNextFrame = true;
            await new Promise(r => requestAnimationFrame(() => setTimeout(r, 30)));
        }
    }, frames);
    await sleep(400);
};

// stats for the main viewport (the PiP must not damage it)
const viewportStats = async (page) => {
    const rect = await page.evaluate(() => {
        const c = document.querySelector('canvas').getBoundingClientRect();
        return { x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.width), h: Math.round(c.height) };
    });
    const png = await page.screenshot({
        type: 'png',
        clip: {
            x: Math.round(rect.x + rect.w * 0.32),
            y: Math.round(rect.y + rect.h * 0.25),
            width: Math.round(rect.w * 0.5),
            height: Math.round(rect.h * 0.5)
        }
    });
    const img = decodePng(Buffer.from(png));
    let lit = 0;
    let sum = 0;
    let colourful = 0;
    const n = img.width * img.height;
    for (let i = 0; i < img.data.length; i += img.channels) {
        const r = img.data[i];
        const g = img.data[i + 1];
        const b = img.data[i + 2];
        if (r + g + b > 30) lit++;
        if (Math.max(r, g, b) - Math.min(r, g, b) > 20) colourful++;
        sum += r + g + b;
    }
    return {
        litPct: +((lit / n) * 100).toFixed(1),
        colourfulPct: +((colourful / n) * 100).toFixed(1),
        meanLum: Math.round(sum / (n * 3)),
        img
    };
};

const diffPx = (a, b, threshold = 8) => {
    let changed = 0;
    const n = Math.min(a.img.data.length, b.img.data.length);
    const ch = a.img.channels;
    for (let i = 0; i < n; i += ch) {
        if (Math.abs(a.img.data[i] - b.img.data[i]) > threshold ||
            Math.abs(a.img.data[i + 1] - b.img.data[i + 1]) > threshold ||
            Math.abs(a.img.data[i + 2] - b.img.data[i + 2]) > threshold) {
            changed++;
        }
    }
    return changed;
};

// the PiP picture itself (its DOM container, wherever the app placed it)
const pipStats = async (page) => {
    const box = await page.evaluate(() => {
        const el = document.querySelector('.camera-pip');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const w = Math.round(r.width);
        const h = Math.round(r.height);
        if (!(w > 4) || !(h > 4)) return null;
        return { x: Math.round(r.x), y: Math.round(r.y), w, h };
    });
    if (!box) return null;
    const png = await page.screenshot({
        type: 'png',
        clip: { x: box.x, y: box.y, width: box.w, height: box.h }
    });
    const img = decodePng(Buffer.from(png));
    let lit = 0;
    let colourful = 0;
    const n = img.width * img.height;
    for (let i = 0; i < img.data.length; i += img.channels) {
        const r = img.data[i];
        const g = img.data[i + 1];
        const b = img.data[i + 2];
        if (r + g + b > 30) lit++;
        if (Math.max(r, g, b) - Math.min(r, g, b) > 20) colourful++;
    }
    return { box, litPct: +((lit / n) * 100).toFixed(1), colourfulPct: +((colourful / n) * 100).toFixed(1) };
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
        page.on('console', (m) => { if (m.type() === 'error') logs.push(`error: ${m.text().slice(0, 200)}`); });
        page.on('pageerror', e => logs.push('pageerror: ' + String(e).slice(0, 200)));

        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForFunction('!!window.scene', { timeout: 90000 });
        await sleep(1500);
        await page.evaluate(async (model) => {
            const buf = await (await fetch('./' + model)).arrayBuffer();
            await window.scene.events.invoke('import', [{ filename: model, contents: new File([buf], model) }]);
        }, MODEL);
        await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 120000 });
        await sleep(3500);

        const backend = await page.evaluate(() => (window.scene.graphicsDevice.isWebGPU ? 'webgpu' : 'webgl2'));
        await page.evaluate(() => { window.scene.forceRender = true; window.scene.app.renderNextFrame = true; });
        await sleep(900);
        // baseline: preview off (timeline panel closed)
        const before = await viewportStats(page);

        // open the timeline panel and give the camera track two keys -> preview turns on
        await page.evaluate(async () => {
            const scene = window.scene;
            scene.events.fire('statusBar.panelChanged', 'timeline');
            await new Promise(r => setTimeout(r, 400));
            scene.events.fire('track.addKeyTo', 'camera', 0);
            await new Promise(r => setTimeout(r, 400));
            scene.events.fire('track.addKeyTo', 'camera', 30);
        });
        // the preview updates on a throttle, so force enough frames for it to run
        await pumpFrames(page, 20);

        const state = await page.evaluate(() => {
            const scene = window.scene;
            const pip = scene.cameraPreview;
            const instance = scene.getElementsByType('splat')[0].entity.gsplat.instance;
            const entry = pip._pipSort && pip._pipSort.values().next().value;
            return {
                hasTrack: pip.hasTrack,
                enabled: pip.enabled,
                pipSwapActive: pip.pipSwapActive,
                pipEntries: pip._pipSort ? pip._pipSort.size : null,
                pipOrderKind: entry && entry.pipOrder ?
                    (entry.pipOrder.impl && 'buffer' in entry.pipOrder.impl ? 'buffer' : 'texture') : null,
                mainOrderKind: (() => {
                    const o = instance.material.getParameter('splatOrder');
                    if (!o) return null;
                    return o.impl && 'buffer' in o.impl ? 'buffer' : 'texture';
                })(),
                container: !!document.querySelector('.camera-pip')
            };
        });

        const pip = await pipStats(page);

        // close the timeline again: the preview must leave the main view exactly as it was
        await page.evaluate(() => { window.scene.events.fire('statusBar.panelChanged', ''); });
        await pumpFrames(page, 10);
        const after = await viewportStats(page);
        const mainDamage = diffPx(before, after);

        const checks = [
            { name: 'model visible before the preview', pass: before.litPct > 20, detail: `${before.litPct}% lit, mean ${before.meanLum}` },
            { name: 'camera track created', pass: state.hasTrack === true, detail: `hasTrack=${state.hasTrack}` },
            {
                name: 'preview enabled on this backend',
                pass: state.enabled === true,
                detail: `enabled=${state.enabled} on ${backend}, container=${state.container}`
            },
            {
                name: 'private sort pipeline built',
                // WebGL2 keeps its own R32U order texture, WebGPU an order storage buffer
                pass: state.pipEntries === 1 && state.pipOrderKind === (backend === 'webgpu' ? 'buffer' : 'texture'),
                detail: `entries=${state.pipEntries} pipOrder=${state.pipOrderKind} mainOrder=${state.mainOrderKind}`
            },
            {
                name: 'preview window shows the model',
                pass: !!pip && pip.colourfulPct > 5,
                detail: pip ? `${pip.colourfulPct}% colourful, ${pip.litPct}% lit in ${JSON.stringify(pip.box)}` : 'preview window not visible'
            },
            {
                name: 'main view unchanged once the preview is off',
                pass: mainDamage < before.img.width * before.img.height * 0.02,
                detail: `${mainDamage} px differ (${after.litPct}% lit vs ${before.litPct}%), swapActive=${state.pipSwapActive}`
            }
        ];

        console.log(JSON.stringify({
            backend, state, before: { litPct: before.litPct, colourfulPct: before.colourfulPct, meanLum: before.meanLum },
            after: { litPct: after.litPct, colourfulPct: after.colourfulPct, meanLum: after.meanLum },
            pip, mainDamage, checks, failed: checks.filter(c => !c.pass).length, logs
        }, null, 2));
        if (checks.some(c => !c.pass) || logs.length) process.exitCode = 1;
    } catch (e) {
        console.log(JSON.stringify({ fatal: String(e).slice(0, 400), logs }, null, 2));
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
