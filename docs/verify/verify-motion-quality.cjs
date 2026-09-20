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

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

    const state = () => page.evaluate(() => {
        const scene = window.scene;
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

    const rotate = (ms) => page.evaluate(async (duration) => {
        const cam = window.scene.camera;
        const t0 = performance.now();
        while (performance.now() - t0 < duration) {
            cam.setAzimElev(cam.azim + 1.5, cam.elevation, 0);
            await new Promise((r) => setTimeout(r, 16));
        }
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
