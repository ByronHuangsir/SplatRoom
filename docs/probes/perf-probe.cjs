// Frame-time probe for the "interaction is not smooth" work (⑥ / P0-3).
//
// The comparison study (docs/perf/supersplat-3.3.0-对比调研.md §4.1/§4.2) defines the acceptance
// line for a big model as:
//     rotating: p95 frame <= 33 ms (30 fps), max <= 100 ms, long tasks (>50 ms) <= 1/s
// and this probe is the instrument for it. It reports four independent things so a change can be
// judged without trusting a single number:
//   1. rAF frame gaps while IDLE and while ROTATING (p50 / p95 / max, plus the >33 ms and >100 ms
//      frame counts) — the primary metric;
//   2. long tasks from PerformanceObserver (browser-reported main-thread blocks);
//   3. renderer.info draw instances — confirms whether a frame really draws the full model
//      (20M splats = 312500 instanced quads) rather than a surviving subset;
//   4. the GPU profiler, when the adapter exposes timestamp queries (best effort; null if not).
//
// Rotation uses the same in-page convention as docs/probes/sortrate.cjs (push the azimuth by 1.2
// degrees every 16 ms through camera.setAzimElev), so numbers are comparable with the P0-2 runs.
//
// usage: node docs/probes/perf-probe.cjs "<url>" [model] [seconds]
//   e.g. node docs/probes/perf-probe.cjs "http://localhost:3621/?gpu=webgpu" test-20m.ply 4
const puppeteer = require('puppeteer-core');

const { BROWSER_PATH: EDGE , launchPatched: _launchPatched } = require('../verify/lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-20m.ply';
const SECONDS = parseFloat(process.argv[4] || '4');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = await _launchPatched(puppeteer, {
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

    const result = await page.evaluate(async (seconds) => {
        const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
        const scene = window.scene;
        const cam = scene.camera;
        const splat = scene.getElementsByType('splat').slice(-1)[0];

        scene.events.fire('selection', splat);
        await sleep2(500);
        scene.events.fire('camera.focus');
        await sleep2(3000);

        // long tasks (browser-reported main-thread blocks), sampled over the whole probe window
        const longTasks = [];
        let obs = null;
        try {
            obs = new PerformanceObserver((list) => {
                for (const e of list.getEntries()) longTasks.push(+e.duration.toFixed(1));
            });
            obs.observe({ entryTypes: ['longtask'] });
        }
        catch (e) { obs = null; }

        // best-effort GPU profiler
        let gpu = { available: false };
        try {
            const gd = scene.app.graphicsDevice;
            if (gd.gpuProfiler) {
                gd.gpuProfiler.enabled = true;
                gpu.available = true;
            }
        }
        catch (e) { gpu = { available: false, error: String(e).slice(0, 120) }; }

        const sample = async (ms, rotate) => {
            const deltas = [];
            let last = performance.now();
            let stop = false;
            const loop = () => {
                const now = performance.now();
                deltas.push(now - last);
                last = now;
                if (!stop) requestAnimationFrame(loop);
            };
            requestAnimationFrame(loop);
            const t0 = performance.now();
            while (performance.now() - t0 < ms) {
                if (rotate) cam.setAzimElev(cam.azim + 1.2, cam.elevation, 0);
                await sleep2(16);
            }
            stop = true;
            await sleep2(300);
            deltas.shift();
            const sorted = deltas.slice().sort((a, b) => a - b);
            const pick = (p) => (sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(1) : null);
            return {
                frames: sorted.length,
                p50: pick(0.5),
                p95: pick(0.95),
                max: sorted.length ? +sorted[sorted.length - 1].toFixed(1) : null,
                over33: sorted.filter((d) => d > 33).length,
                over100: sorted.filter((d) => d > 100).length
            };
        };

        const idle = await sample(2000, false);
        const before = longTasks.length;
        const rotating = await sample(seconds * 1000, true);
        const rotateLongTasks = longTasks.slice(before);

        let drawInstances = null;
        try {
            const inst = splat.entity.gsplat.instance;
            const stats = scene.app.stats;
            drawInstances = {
                // 20M splats / 128 per instance = 312500 quads (the doc's "156250" is the 20M/128 count
                // for the instancingCount the engine actually issues per draw)
                instancingCount: inst.meshInstance ? inst.meshInstance.instancingCount : null,
                numSplats: splat.splatData.numSplats,
                visible: inst.meshInstance ? inst.meshInstance.visible : null,
                drawCalls: stats && stats.drawCalls ? { ...stats.drawCalls } : null,
                vram: stats && stats.vram ? { ...stats.vram } : null,
                gpu: stats && stats.gpu ? { ...stats.gpu } : null
            };
        }
        catch (e) { drawInstances = { error: String(e).slice(0, 150) }; }

        if (obs) obs.disconnect();

        return {
            numSplats: splat.splatData.numSplats,
            shBands: splat.entity?.gsplat?.instance?.resource?.shBands ?? null,
            backend: scene.app.graphicsDevice?.deviceType ?? null,
            idle,
            rotating,
            longTasks: { total: longTasks.length, rotateWindow: rotateLongTasks.length, worstMs: longTasks.length ? Math.max(...longTasks) : null },
            drawInstances,
            gpu
        };
    }, SECONDS);

    console.log(JSON.stringify({ model: MODEL, url: URL, seconds: SECONDS, ...result, errors: consoleErrors.slice(0, 6) }, null, 1));
    await browser.close();
    process.exit(0);
})().catch((e) => {
    console.log(JSON.stringify({ fatal: String(e).slice(0, 400) }));
    process.exit(1);
});
