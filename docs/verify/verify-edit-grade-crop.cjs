// Verify colour grading and crop-box clipping on a chosen backend by measuring the
// viewport pixels before/after each change. Both features run entirely in the custom
// splat shader (WGSL on the WebGPU backend), so identical numbers on the two backends
// mean the WGSL twin behaves like the GLSL one.
//
// usage: node docs/verify/verify-edit-grade-crop.cjs "<url>" [model]
const puppeteer = require('puppeteer-core');
const { decodePng } = require('./lib/png.cjs');

const { BROWSER_PATH: EDGE , launchPatched: _launchPatched } = require('./lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const stats = async (page) => {
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
        if (Math.max(r, g, b) > 60) lit++;
        sum += r + g + b;
    }
    return {
        colourfulPct: +((colourful / n) * 100).toFixed(1),
        litPct: +((lit / n) * 100).toFixed(1),
        meanLum: Math.round(sum / (n * 3))
    };
};

const settle = async (page) => {
    await page.evaluate(() => { window.scene.forceRender = true; window.scene.app.renderNextFrame = true; });
    await sleep(1000);
};

(async () => {
    const browser = await _launchPatched(puppeteer, {
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
    });
    const errors = [];
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`); });
        page.on('pageerror', e => errors.push('pageerror: ' + String(e).slice(0, 200)));

        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForFunction('!!window.scene', { timeout: 90000 });
        await sleep(1500);
        await page.evaluate(async (model) => {
            const buf = await (await fetch('./' + model)).arrayBuffer();
            await window.scene.events.invoke('import', [{ filename: model, contents: new File([buf], model) }]);
        }, MODEL);
        await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 120000 });
        await sleep(3500);
        await settle(page);

        const backend = await page.evaluate(() => (window.scene.graphicsDevice.isWebGPU ? 'webgpu' : 'webgl2'));
        const baseline = await stats(page);

        // 1. colour grading: saturation 0 must remove all colour from the splats
        await page.evaluate(async () => {
            const splat = window.scene.getElementsByType('splat')[0];
            splat.saturation = 0;
            await new Promise(r => setTimeout(r, 600));
        });
        await settle(page);
        const desaturated = await stats(page);

        // 2. restore
        await page.evaluate(async () => {
            const splat = window.scene.getElementsByType('splat')[0];
            splat.saturation = 1;
            await new Promise(r => setTimeout(r, 600));
        });
        await settle(page);
        const restored = await stats(page);

        // 3. crop box: enable clipping with a small shape -> splats outside are removed
        // ⚠️ 2026-10-02：**必须先显式把「显示外部（预览）」关掉**。该项现在是默认开（盒外以 25% 淡显
        // 保留，见 crop-box.ts 的 _preview 注释），此时"亮像素"不会大幅下降（实测 ratio 0.88），
        // 这条断言测的就不再是"裁切把盒外删掉"而是"淡显"。显式关闭后它测回原本的语义（discard 路径）。
        const cropState = await page.evaluate(async () => {
            const scene = window.scene;
            // the crop box is built from the selection bound, so select first
            scene.events.fire('select.all');
            await new Promise(r => setTimeout(r, 800));
            scene.events.fire('cropBox.initialize');
            await new Promise(r => setTimeout(r, 400));
            const box = scene.events.invoke('cropBox');
            if (box) {
                // box mode clips against the box's half-extents (the pivot scale is derived from
                // them every frame), so shrink the extents themselves
                const ext = box._extent ?? box.extent;
                if (ext && ext.set) ext.set(0.3, 0.3, 0.3);
                scene.events.fire('cropBox.changed');
            }
            scene.events.fire('cropBox.setPreview', false);
            scene.events.fire('cropBox.setClipping', true);
            await new Promise(r => setTimeout(r, 800));
            const state = scene.events.invoke('cropBox.getState');
            return state ? { enabled: state.enabled, clipping: state.clipping, shape: state.shape, preview: state.preview } : null;
        });
        await settle(page);
        const cropped = await stats(page);

        // 3b. 预览（盒外淡显）必须让模型**仍然可见** —— 这是"用户能看出裁到哪"的那条通路
        await page.evaluate(() => { window.scene.events.fire('cropBox.setPreview', true); });
        await settle(page);
        const previewed = await stats(page);

        const checks = [
            { name: 'model visible at baseline', pass: baseline.colourfulPct > 20, detail: `${baseline.colourfulPct}% colourful` },
            { name: 'saturation 0 removes the colour', pass: desaturated.colourfulPct < baseline.colourfulPct * 0.3, detail: `${baseline.colourfulPct}% -> ${desaturated.colourfulPct}%` },
            { name: 'saturation 1 restores it', pass: restored.colourfulPct > baseline.colourfulPct * 0.8, detail: `${restored.colourfulPct}%` },
            { name: 'crop box clipping removes splats (preview off)', pass: cropped.litPct < baseline.litPct * 0.85, detail: `lit ${baseline.litPct}% -> ${cropped.litPct}% (ratio ${(cropped.litPct / baseline.litPct).toFixed(2)})` },
            { name: 'crop preview keeps the model visible (box-outside reference)', pass: previewed.litPct > cropped.litPct * 1.25, detail: `lit preview-off ${cropped.litPct}% -> preview-on ${previewed.litPct}%（盒外淡显保留参照）` }
        ];
        console.log(JSON.stringify({ backend, baseline, desaturated, restored, cropped, previewed, cropState, checks, failed: checks.filter(c => !c.pass).length, errors }, null, 2));
        if (checks.some(c => !c.pass) || errors.length) process.exitCode = 1;
    } catch (e) {
        console.log(JSON.stringify({ fatal: String(e).slice(0, 400), errors }, null, 2));
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
