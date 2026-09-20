// Interaction-time degradation: while the camera moves the viewport renders at a lower resolution,
// and the moment it settles the full-resolution target comes back — exactly, and without touching any
// user setting.
//
// What is asserted (all read from the live app):
//   1. settled: no override, full resolution
//   2. moving:   render scale drops below 1 and the render target actually shrinks
//   3. moving:   `view.bands` (the user-facing setting that feeds preferences, the .ssproj and the
//                export dialog) is UNCHANGED — the degradation is transient by construction and must
//                never leak into saved state (see docs/perf/P0-3-交互期降级-前置侦察.md §1/§5.1)
//   4. settled again: the override is cleared and the render target returns to full size
//   5. the escape hatch `window.__SPLATROOM_MOTION_QUALITY__ = false` disables it entirely
//
// The rotation uses `cam.elevation`: this fork's Camera has no `elev` property, and passing
// `undefined` there makes the elevation (and therefore the whole camera matrix) NaN — that bug in
// docs/probes/sortrate.cjs made a "rotating" measurement run against a camera that was not rendering.
//
// usage: node docs/verify/verify-motion-quality.cjs "<url>" [model]
const puppeteer = require('puppeteer-core');
const { decodePng } = require('./lib/png.cjs');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Coverage of the lit content over the FULL canvas. Guards the blit: the final pass copies the
// offscreen main target onto the backbuffer, and it used to be a 1:1 `texelFetch` copy, which is only
// correct while the two are the same size. The moment the degradation shrinks the target, a 1:1 copy
// leaves the picture in the bottom-left with the rest of the frame reading out-of-range texels —
// reported by the user on 2026-09-21 as "移动、缩放时画面会收缩到左下角，在上部、右部产生黑色空间".
// Measured with the old copy: degraded lit 31.4% vs settled 76.3%, top-right quadrant 40.2% vs 92.7%.
const canvasCoverage = async (page) => {
    const clip = await page.evaluate(() => {
        const c = document.querySelector('canvas').getBoundingClientRect();
        return {
            x: Math.round(c.x),
            y: Math.round(c.y),
            width: Math.max(1, Math.round(c.width)),
            height: Math.max(1, Math.round(c.height))
        };
    });
    const png = await page.screenshot({ type: 'png', clip });
    const img = decodePng(Buffer.from(png));
    let lit = 0;
    let maxX = -1;
    let minY = img.height;
    for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
            const i = (y * img.width + x) * img.channels;
            if (Math.max(img.data[i], img.data[i + 1], img.data[i + 2]) > 60) {
                lit++;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
            }
        }
    }
    return {
        size: `${img.width}x${img.height}`,
        litPercent: +((lit / (img.width * img.height)) * 100).toFixed(1),
        rightMarginPx: maxX < 0 ? img.width : img.width - 1 - maxX,
        topMarginPx: minY >= img.height ? img.height : minY
    };
};


(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
    });
    const errors = [];
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1500);

    await page.evaluate(async (m) => {
        const buf = await (await fetch('./' + m)).arrayBuffer();
        window.__loadErr = null;
        window.scene.events.invoke('import', [{ filename: m, contents: new File([buf], m) }])
            .catch((e) => { window.__loadErr = String(e).slice(0, 200); });
    }, MODEL);

    for (let i = 0; i < 60; i++) {
        await sleep(1000);
        const st = await page.evaluate(() => ({
            n: window.scene.getElementsByType('splat').length,
            err: window.__loadErr
        }));
        if (st.n > 0) break;
        if (st.err) throw new Error(st.err);
    }
    await sleep(3000);

    const state = () => page.evaluate(() => {        const scene = window.scene;
        const cam = scene.camera;
        return {
            engaged: scene.motionQuality.engaged,
            level: scene.motionQuality.level,
            renderScale: scene.motionQuality.renderScale,
            moving: scene.cameraMotion.moving,
            override: cam.targetSizeOverride ? `${cam.targetSizeOverride.width}x${cam.targetSizeOverride.height}` : null,
            mainTarget: cam.mainTarget ? `${cam.mainTarget.width}x${cam.mainTarget.height}` : null,
            fullTarget: `${scene.targetSize.width}x${scene.targetSize.height}`,
            viewBands: scene.events.invoke('view.bands')
        };
    });

    // Rotate the camera for `ms`. `scene.forceRender` is set every iteration because this app renders
    // on demand and a *programmatic* `setAzimElev` does not mark the scene dirty (there is no pointer
    // input behind it) — without the forced frame a synthetic drag renders almost nothing, and the
    // per-frame work under test (motion tracking, the sorter gate, the settle sort) never runs.
    // Measured the hard way: `onPreRender` was called 0 times in the 1.5 s after such a drag, which
    // made the settle-sort check report 0 dispatches for the wrong reason.
    const rotate = (ms) => page.evaluate(async (duration) => {
        const cam = window.scene.camera;
        const scene = window.scene;
        const t0 = performance.now();
        let stop = false;
        const loop = () => {
            scene.forceRender = true;
            if (!stop) requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
        while (performance.now() - t0 < duration) {
            cam.setAzimElev(cam.azim + 1.5, cam.elevation, 0);
            await new Promise((r) => setTimeout(r, 16));
        }
        stop = true;
    }, ms);

    const checks = [];
    const check = (name, pass, detail) => checks.push({ name, pass, detail });

    try {
        // force engagement: a 2000-point model is far too fast to engage on its own, and this suite is
        // about the mechanism, not about the threshold (which verify-motion-quality-policy.mts covers)
        await page.evaluate(() => {
            window.scene.motionQuality.enabled = true;
            window.scene.motionQuality.forceEngaged = true;
        });
        await sleep(600);

        const settledBefore = await state();
        check('settled: renders at full resolution',
            settledBefore.engaged === false && settledBefore.override === null &&
            settledBefore.renderScale === 1 && settledBefore.mainTarget === settledBefore.fullTarget,
            `engaged=${settledBefore.engaged} scale=${settledBefore.renderScale} target=${settledBefore.mainTarget} full=${settledBefore.fullTarget}`);

        // rotate in the background while sampling
        const rotating = rotate(1200);
        await sleep(500);
        const movingState = await state();
        const bandsDuring = movingState.viewBands;
        await rotating;
        await sleep(150);

        check('moving: render scale drops below 1',
            movingState.moving === true && movingState.engaged === true && movingState.renderScale < 1,
            `moving=${movingState.moving} engaged=${movingState.engaged} scale=${movingState.renderScale} level=${movingState.level}`);

        check('moving: the render target actually shrinks',
            movingState.override !== null && parseInt(movingState.override, 10) < parseInt(movingState.fullTarget, 10),
            `override=${movingState.override} full=${movingState.fullTarget} mainTarget=${movingState.mainTarget}`);

        check('moving: the user setting view.bands is untouched',
            bandsDuring === settledBefore.viewBands,
            `view.bands ${settledBefore.viewBands} -> ${bandsDuring}`);

        // wait past the settle window (CameraMotion.settleMs = 200)
        await sleep(900);
        const settledAfter = await state();
        check('settled again: full resolution is restored exactly',
            settledAfter.moving === false && settledAfter.engaged === false &&
            settledAfter.override === null && settledAfter.mainTarget === settledAfter.fullTarget,
            `moving=${settledAfter.moving} engaged=${settledAfter.engaged} override=${settledAfter.override} target=${settledAfter.mainTarget}`);

        check('the document/view bands are still the user value after a full cycle',
            settledAfter.viewBands === settledBefore.viewBands,
            `view.bands ${settledBefore.viewBands} -> ${settledAfter.viewBands}`);

        // escape hatch
        await page.evaluate(() => { window.__SPLATROOM_MOTION_QUALITY__ = false; });
        await rotate(700);
        await sleep(200);
        const disabled = await state();
        check('window.__SPLATROOM_MOTION_QUALITY__ = false disables it while rotating',
            disabled.engaged === false && disabled.override === null,
            `engaged=${disabled.engaged} override=${disabled.override} moving=${disabled.moving}`);

        // ---- sorter gate + settle-time clean frame ----
        // The degradation must not disturb the P0-2 gate, and the frame that settles must issue a final
        // sort so the resting image uses the final pose.
        //
        // Measured through the gate's own bookkeeping rather than `worker.postMessage` counts: on a
        // 2000-point fixture the engine's sort path never engages the worker at all, so post counts are
        // legitimately 0 here (the post-level evidence lives in
        // docs/probes/settle-20m.cjs / docs/perf/交互期降级-实现与实测.md, measured on the 20M fixture
        // where a drag really does post ~1.2×/s). What is fixture-independent is how often the throttle
        // lets a dispatch opportunity through, and whether a settle sort is left owed.
        const gateState = () => page.evaluate(() => {
            const splat = window.scene.getElementsByType('splat').slice(-1)[0];
            return {
                lastDispatch: splat._sortLastDispatch,
                pending: splat.sortSettlePending
            };
        });

        // degradation ON for this part: the point is that it does not disturb the sorter gate
        await page.evaluate(() => {
            delete window.__SPLATROOM_MOTION_QUALITY__;
            window.scene.motionQuality.enabled = true;
            window.scene.motionQuality.forceEngaged = true;
        });
        await sleep(300);

        // sample _sortLastDispatch while dragging: each change is one dispatch opportunity the 800 ms
        // throttle allowed through
        const dispatchSamples = [];
        const sampler = (async () => {
            for (let i = 0; i < 26; i++) {
                dispatchSamples.push((await gateState()).lastDispatch);
                await sleep(100);
            }
        })();
        await rotate(2500);
        await sampler;
        let allowedChanges = 0;
        for (let i = 1; i < dispatchSamples.length; i++) {
            if (dispatchSamples[i] !== dispatchSamples[i - 1]) {
                allowedChanges++;
            }
        }
        check('the 800 ms sorter gate still limits dispatch opportunities during a 2.5 s drag',
            allowedChanges >= 1 && allowedChanges <= 6,
            `dispatch opportunities allowed during the drag = ${allowedChanges} (2.5 s / 800 ms ≈ 3)`);

        // the settle sort must be consumed, not left owed (this is the deadlock guard: the armed frame
        // only happens if something keeps rendering)
        let owed = null;
        for (let i = 0; i < 12; i++) {
            await sleep(100);
            owed = await gateState();
            if (!owed.pending) {
                break;
            }
        }
        check('the settle sort is issued, not left pending',
            owed !== null && owed.pending === false,
            `sortSettlePending after the drag = ${owed ? owed.pending : 'null'}`);

        // ---- the degraded frame must still cover the whole canvas ----
        // A 1:1 blit regression is invisible to every other check here (the render target *is*
        // smaller, the state is correct, the restore works) yet ruins the picture on screen.
        const settledCoverage = await canvasCoverage(page);
        const spin = rotate(1500);
        await sleep(700);                                   // degraded and rendering
        const degradedCoverage = await canvasCoverage(page);
        const degradedState = await state();
        await spin;
        check('while degraded the image still fills the canvas (no black corner)',
            degradedState.engaged === true &&
            degradedCoverage.rightMarginPx <= 16 && degradedCoverage.topMarginPx <= 16 &&
            degradedCoverage.litPercent >= settledCoverage.litPercent * 0.6,
            `degraded ${degradedCoverage.size} margins right/top = ${degradedCoverage.rightMarginPx}/${degradedCoverage.topMarginPx} px, ` +
            `lit ${degradedCoverage.litPercent}% (settled ${settledCoverage.litPercent}%, engaged=${degradedState.engaged}, scale=${degradedState.renderScale})`);

        await page.evaluate(() => {
            delete window.__SPLATROOM_MOTION_QUALITY__;
            window.scene.motionQuality.forceEngaged = null;
        });
    } catch (e) {
        check('suite ran without throwing', false, String(e).slice(0, 200));
    }

    console.log(JSON.stringify({ checks, failed: checks.filter((c) => !c.pass).length, errors: errors.slice(0, 5) }, null, 1));
    await browser.close();
    process.exit(0);
})().catch((e) => {
    console.log(JSON.stringify({ fatal: String(e).slice(0, 400) }));
    process.exit(1);
});
