// GPU time per frame, measured with the engine's timestamp queries, plus a lit-pixel check.
//
// Answers the question the frame-gap probes cannot: on this model, how much of the frame cost is GPU
// versus CPU (sort/upload)? The reading comes from `scene.gpuFrameTiming` (see
// src/core/gpu-frame-timing.ts), which wraps the engine's `gpuProfiler.report` so each async span is
// attributed to the frame that produced it and tagged moving/idle by `scene.cameraMotion`.
//
// Two phases, because this app renders on demand — a truly idle app renders nothing, so a static
// measurement has to force frames:
//   1. static   - camera parked, `scene.forceRender = true` each frame.
//   2. rotating - the same forced frames while the azimuth advances 1.2 deg / 16 ms.
// Both phases report rAF gaps, browser long tasks, GPU spans and `litPercent`.
//
// `litPercent` is not decoration: gaussians whose projected size is under `minPixelSize` (engine
// default 2 px) are culled, so a large model with sub-pixel splats renders an empty screen and
// reports fast frames. Any measurement without a lit check can be measuring nothing.
//
// The rotation uses `cam.elevation`; this fork's Camera has no `elev` property, and passing
// `undefined` there makes the elevation NaN, which makes the whole camera matrix NaN (measured:
// 0/60 frames of movement detected, 948 NaN console errors per second vs 60/60 and 0 with
// `elevation`). `docs/probes/sortrate.cjs` was fixed for the same reason.
//
// usage: node docs/probes/gpu-frame-probe.cjs "<url>" [model] [seconds]
const puppeteer = require('puppeteer-core');
const { decodePng } = require('../verify/lib/png.cjs');

const { BROWSER_PATH: EDGE } = require('../verify/lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-20m.ply';
const SECONDS = parseFloat(process.argv[4] || '4');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// lit-pixel fraction of the viewport centre, using the convention of
// docs/verify/verify-large-model-ui.cjs (max(r,g,b) > 60)
const litPercent = async (page) => {
    const rect = await page.evaluate(() => {
        const c = document.querySelector('canvas').getBoundingClientRect();
        return { x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.width), h: Math.round(c.height) };
    });
    const png = await page.screenshot({
        type: 'png',
        clip: {
            x: Math.round(rect.x + rect.w * 0.25),
            y: Math.round(rect.y + rect.h * 0.2),
            width: Math.round(rect.w * 0.5),
            height: Math.round(rect.h * 0.6)
        }
    });
    const img = decodePng(Buffer.from(png));
    let lit = 0;
    const n = img.width * img.height;
    for (let i = 0; i < img.data.length; i += img.channels) {
        if (Math.max(img.data[i], img.data[i + 1], img.data[i + 2]) > 60) lit++;
    }
    return +((lit / n) * 100).toFixed(2);
};

const PHASE_FN = async ({ ms, rotate }) => {
    const sleep2 = (ms2) => new Promise((r) => setTimeout(r, ms2));
    const scene = window.scene;
    const cam = scene.camera;
    const timing = scene.gpuFrameTiming;

    const deltas = [];
    let last = performance.now();
    let stop = false;
    const loop = () => {
        const now = performance.now();
        deltas.push(now - last);
        last = now;
        scene.forceRender = true;      // demand-driven renderer: force a frame for a static view
        if (!stop) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);

    timing.reset();
    const before = window.__probeLongTasks.length;
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
        if (rotate) cam.setAzimElev(cam.azim + 1.2, cam.elevation, 0);
        await sleep2(16);
    }
    stop = true;
    await sleep2(400);

    deltas.shift();
    const sorted = deltas.slice().sort((a, b) => a - b);
    const pick = (p) => (sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(1) : null);
    return {
        raf: {
            frames: sorted.length,
            p50: pick(0.5),
            p95: pick(0.95),
            max: sorted.length ? +sorted[sorted.length - 1].toFixed(1) : null,
            over33: sorted.filter((d) => d > 33).length,
            over100: sorted.filter((d) => d > 100).length
        },
        longTasks: window.__probeLongTasks.slice(before),
        gpu: timing.stats()
    };
};

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
    });
    const consoleErrors = [];
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e).slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });

    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1500);

    await page.evaluate(async (m) => {
        const head = await fetch('./' + m, { headers: { Range: 'bytes=0-0' } });
        const total = parseInt(head.headers.get('content-range').split('/')[1], 10);
        const CHUNK = 256 * 1048576;
        const parts = [];
        for (let off = 0; off < total; off += CHUNK) {
            const end = Math.min(off + CHUNK - 1, total - 1);
            parts.push(await (await fetch('./' + m, { headers: { Range: `bytes=${off}-${end}` } })).blob());
        }
        window.__loadErr = null;
        window.scene.events.invoke('import', [{ filename: m, contents: new File(parts, m) }])
            .catch((e) => { window.__loadErr = String(e).slice(0, 300); });
    }, MODEL);

    for (let i = 0; i < 120; i++) {
        await sleep(5000);
        const st = await page.evaluate(() => ({
            n: window.scene.getElementsByType('splat').length,
            s: window.scene.getElementsByType('splat').map((x) => (x.splatData ? x.splatData.numSplats : 0)),
            err: window.__loadErr
        }));
        if (st.n > 0 && st.s[0] > 0) break;
        if (st.err) throw new Error(st.err);
    }
    await sleep(8000);

    // framing + profiler + long-task observer
    const setup = await page.evaluate(async () => {
        const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
        const scene = window.scene;
        const splat = scene.getElementsByType('splat').slice(-1)[0];
        scene.events.fire('selection', splat);
        await sleep2(500);
        scene.events.fire('camera.focus');
        await sleep2(3000);

        window.__probeLongTasks = [];
        try {
            const obs = new PerformanceObserver((list) => {
                for (const e of list.getEntries()) window.__probeLongTasks.push(+e.duration.toFixed(1));
            });
            obs.observe({ entryTypes: ['longtask'] });
            window.__probeObserver = obs;
        } catch (e) { window.__probeObserver = null; }

        scene.gpuFrameTiming.setEnabled(true);
        await sleep2(1000);

        const inst = splat.entity.gsplat.instance;
        return {
            numSplats: splat.splatData.numSplats,
            shBands: inst.resource?.shBands ?? null,
            supported: scene.gpuFrameTiming.supported,
            minPixelSize: inst.material.getParameter ? inst.material.getParameter('minPixelSize') : null,
            instancingCount: inst.meshInstance ? inst.meshInstance.instancingCount : null,
            framingRadius: splat.framingRadius ? Math.round(splat.framingRadius()) : null
        };
    });

    const staticPhase = await page.evaluate(PHASE_FN, { ms: 2000, rotate: false });
    const staticLit = await litPercent(page);
    const rotatePhase = await page.evaluate(PHASE_FN, { ms: SECONDS * 1000, rotate: true });
    const rotateLit = await litPercent(page);

    await page.evaluate(() => {
        window.scene.gpuFrameTiming.setEnabled(false);
        if (window.__probeObserver) window.__probeObserver.disconnect();
    });

    console.log(JSON.stringify({
        model: MODEL,
        url: URL,
        seconds: SECONDS,
        ...setup,
        static: { ...staticPhase, litPercent: staticLit },
        rotating: { ...rotatePhase, litPercent: rotateLit },
        errors: consoleErrors.slice(0, 6)
    }, null, 1));

    await browser.close();
    process.exit(0);
})().catch((e) => {
    console.log(JSON.stringify({ fatal: String(e).slice(0, 400) }));
    process.exit(1);
});
