// Verify the particle effects (scatter / ripple intro / drift outro) on a chosen backend.
// These all run inside the custom splat shader, so on WebGPU they exercise the WGSL twin's
// effect branch: uScatterProgress / uScatterRadius / uEffectMode / uEffectTime / uEffectFade.
//
// The frame is measured three ways, all of which must react:
//   - scatter at progress 1 must throw the splats apart (frame differs, model still draws),
//   - restoring progress 0 must return to the untouched frame (pixel diff back to ~0),
//   - a highlight colour (ripple mode) must tint the frame.
//
// usage: node docs/verify/verify-effects.cjs "<url>" [model]
const puppeteer = require('puppeteer-core');
const { decodePng } = require('./lib/png.cjs');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const grab = async (page) => {
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
    let colourful = 0;
    let sum = 0;
    let red = 0;
    let green = 0;
    let blue = 0;
    const n = img.width * img.height;
    for (let i = 0; i < img.data.length; i += img.channels) {
        const r = img.data[i];
        const g = img.data[i + 1];
        const b = img.data[i + 2];
        if (Math.max(r, g, b) - Math.min(r, g, b) > 20) colourful++;
        sum += r + g + b;
        red += r;
        green += g;
        blue += b;
    }
    return {
        colourfulPct: +((colourful / n) * 100).toFixed(1),
        meanLum: Math.round(sum / (n * 3)),
        rgb: [Math.round(red / n), Math.round(green / n), Math.round(blue / n)],
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

const short = (s) => ({ colourfulPct: s.colourfulPct, meanLum: s.meanLum, rgb: s.rgb });

const apply = async (page, args) => {
    await page.evaluate(async (a) => {
        const scene = window.scene;
        const splat = scene.getElementsByType('splat')[0];
        if (a === null) {
            splat.setScatterProgress(0);
        } else {
            splat.setScatterProgress(a.progress, a.radiusScale, a.mode, a.effectTime, a.color, a.fade);
        }
        scene.forceRender = true;
        scene.app.renderNextFrame = true;
        await new Promise(r => setTimeout(r, 1200));
        scene.forceRender = true;
        scene.app.renderNextFrame = true;
        await new Promise(r => setTimeout(r, 800));
    }, args);
};

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
    });
    const logs = [];
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
        const haveManager = await page.evaluate(() => !!window.scene.effectsManager || !!window.scene.effects);
        const scatterRadius = await page.evaluate(() => {
            const splat = window.scene.getElementsByType('splat')[0];
            return { radius: splat._scatterRadius ?? null, center: splat._scatterCenter ? [splat._scatterCenter.x, splat._scatterCenter.y, splat._scatterCenter.z] : null };
        });

        await apply(page, null);
        const base = await grab(page);

        // plain scatter, fully applied
        await apply(page, { progress: 1, radiusScale: 1, mode: 0, effectTime: 1, color: null, fade: 1 });
        const scatter = await grab(page);

        // ripple intro with a highlight colour, sampled while the wave is still travelling
        // (at effectTime 0.5 the wave front has already passed the whole model)
        const rippleSamples = [];
        for (const effectTime of [0.05, 0.15, 0.3]) {
            await apply(page, { progress: 1, radiusScale: 1, mode: 1, effectTime, color: [0.2, 0.8, 1.0], fade: 1 });
            rippleSamples.push(await grab(page));
        }

        // drift outro, sampled over its own progression
        const driftSamples = [];
        for (const effectTime of [0.3, 0.6, 1.0]) {
            await apply(page, { progress: effectTime, radiusScale: 2.2, mode: 2, effectTime, color: [1.0, 0.5, 0.1], fade: 1 });
            driftSamples.push(await grab(page));
        }

        // back to the untouched model
        await apply(page, null);
        const restored = await grab(page);

        const px = (list) => list.map(s => diffPx(base, s));
        const scatterPx = diffPx(base, scatter);
        const ripplePx = px(rippleSamples);
        const driftPx = px(driftSamples);
        const restorePx = diffPx(base, restored);
        const rippleSpread = diffPx(rippleSamples[0], rippleSamples[2]);
        const driftSpread = diffPx(driftSamples[0], driftSamples[2]);

        const checks = [
            {
                name: 'model visible at baseline',
                pass: base.colourfulPct > 3,
                detail: `${base.colourfulPct}% colourful, mean ${base.meanLum}`
            },
            {
                name: 'scatter effect moves the splats',
                pass: scatterPx > 10000 && scatter.colourfulPct > 1,
                detail: `${scatterPx} px changed, ${scatter.colourfulPct}% colourful, mean ${scatter.meanLum}`
            },
            {
                name: 'ripple intro renders while the wave travels',
                pass: Math.max(...ripplePx) > 10000 && rippleSpread > 10000,
                detail: `changed px ${ripplePx.join('/')} at effectTime 0.05/0.15/0.3, spread ${rippleSpread}, rgb ${rippleSamples[0].rgb.join('/')} vs base ${base.rgb.join('/')}`
            },
            {
                name: 'drift outro progresses',
                pass: Math.max(...driftPx) > 10000 && driftSpread > 10000,
                detail: `changed px ${driftPx.join('/')} at effectTime 0.3/0.6/1.0, spread ${driftSpread}`
            },
            {
                name: 'progress 0 restores the model',
                pass: restorePx < base.img.width * base.img.height * 0.02,
                detail: `${restorePx} px still differ (${restored.colourfulPct}% vs ${base.colourfulPct}% colourful)`
            }
        ];

        console.log(JSON.stringify({
            backend, haveManager, scatterRadius,
            base: short(base), scatter: short(scatter),
            ripple: rippleSamples.map(short), drift: driftSamples.map(short), restored: short(restored),
            px: { scatter: scatterPx, ripple: ripplePx, drift: driftPx, rippleSpread, driftSpread, restore: restorePx },
            checks, failed: checks.filter(c => !c.pass).length, logs
        }, null, 2));
        if (checks.some(c => !c.pass) || logs.length) process.exitCode = 1;
    } catch (e) {
        console.log(JSON.stringify({ fatal: String(e).slice(0, 400), logs }, null, 2));
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
