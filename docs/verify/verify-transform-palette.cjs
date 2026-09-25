// Verify the per-splat transform path on a chosen backend: the gizmo drag writes new
// matrices into the transform palette texture and new indices into the splat transform
// texture, and the splat shader applies them (transpose(t) * model * position). On WebGPU
// that is the WGSL twin's transform branch, so this exercises texture uploads for both
// textures on that backend.
//
// The harness drives the same three steps the handler does (allocate a palette entry, point
// the splats at it, upload the matrix), then measures the frame and restores the original
// state.
//
// usage: node docs/verify/verify-transform-palette.cjs "<url>" [model]
const puppeteer = require('puppeteer-core');
const { decodePng } = require('./lib/png.cjs');

const { BROWSER_PATH: EDGE } = require('./lib/browser.cjs');
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
    let lit = 0;
    let sum = 0;
    const n = img.width * img.height;
    for (let i = 0; i < img.data.length; i += img.channels) {
        const r = img.data[i];
        const g = img.data[i + 1];
        const b = img.data[i + 2];
        if (Math.max(r, g, b) - Math.min(r, g, b) > 20) colourful++;
        if (r + g + b > 30) lit++;
        sum += r + g + b;
    }
    return {
        colourfulPct: +((colourful / n) * 100).toFixed(1),
        litPct: +((lit / n) * 100).toFixed(1),
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

const short = (s) => ({ colourfulPct: s.colourfulPct, litPct: s.litPct, meanLum: s.meanLum });

// apply a uniform scale about the model centre through the transform palette
const scaleViaPalette = async (page, scale) => {
    return page.evaluate(async (s) => {
        const scene = window.scene;
        const splat = scene.getElementsByType('splat')[0];
        const palette = splat.transformPalette;

        // remember the original per-splat indices once, so the harness can put them back
        if (!splat.__saved) {
            const view = splat.transformTexture.lock();
            splat.__saved = { indices: Array.from(view), alloc: 0 };
            splat.transformTexture.unlock();
        }
        const saved = splat.__saved;

        const data = splat.transformTexture.lock();
        if (s === 1) {
            data.set(saved.indices);
            splat.transformTexture.unlock();
            if (saved.alloc) {
                palette.free(saved.alloc);
                saved.alloc = 0;
            }
            splat.__paletteIndex = null;
        } else {
            const center = splat.localBound && splat.localBound.center ?
                splat.localBound.center : { x: 0, y: 0, z: 0 };

            // allocate a palette entry and fill it with a uniform scale about the centre.
            // Mat4 data is column-major: elements 12..14 are the translation.
            const idx = palette.alloc(1);
            saved.alloc = 1;

            const m = splat.entity.getWorldTransform().clone();
            const d = m.data;
            d.fill(0);
            d[0] = s;
            d[5] = s;
            d[10] = s;
            d[12] = center.x * (1 - s);
            d[13] = center.y * (1 - s);
            d[14] = center.z * (1 - s);
            d[15] = 1;
            palette.setTransform(idx, m);

            // point every splat at the new matrix
            data.fill(idx);
            splat.transformTexture.unlock();
            splat.__paletteIndex = idx;
        }

        scene.forceRender = true;
        scene.app.renderNextFrame = true;
        await new Promise(r => setTimeout(r, 1500));
        scene.forceRender = true;
        scene.app.renderNextFrame = true;
        await new Promise(r => setTimeout(r, 900));

        return { paletteIndex: splat.__paletteIndex ?? null, paletteAlloc: saved.alloc };
    }, scale);
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
        const textures = await page.evaluate(() => {
            const splat = window.scene.getElementsByType('splat')[0];
            const p = splat.transformPalette.texture;
            const t = splat.transformTexture;
            return {
                palette: p ? { w: p.width, h: p.height, format: p.format } : null,
                transform: t ? { w: t.width, h: t.height, format: t.format } : null
            };
        });

        await scaleViaPalette(page, 1);
        const base = await grab(page);

        const applied = await scaleViaPalette(page, 0.5);
        const scaled = await grab(page);

        const restoredState = await scaleViaPalette(page, 1);
        const restored = await grab(page);

        const scaledPx = diffPx(base, scaled);
        const restorePx = diffPx(base, restored);

        const checks = [
            { name: 'model visible at baseline', pass: base.litPct > 20, detail: `${base.litPct}% lit` },
            { name: 'palette + transform textures exist', pass: !!textures.palette && !!textures.transform, detail: JSON.stringify(textures) },
            {
                name: 'palette transform moves the splats',
                pass: scaledPx > 10000,
                detail: `${scaledPx} px changed, lit ${base.litPct}% -> ${scaled.litPct}%, mean ${base.meanLum} -> ${scaled.meanLum} (palette index ${applied.paletteIndex})`
            },
            {
                name: 'restoring the palette restores the model',
                pass: restorePx < base.img.width * base.img.height * 0.02,
                detail: `${restorePx} px still differ, lit ${restored.litPct}%, alloc ${restoredState.paletteAlloc}`
            }
        ];

        console.log(JSON.stringify({
            backend, textures, base: short(base), scaled: short(scaled), restored: short(restored),
            px: { scaled: scaledPx, restore: restorePx },
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
