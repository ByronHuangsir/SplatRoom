// Verify the PiP preview renders the ANIMATION camera, not the main viewport camera.
//
// The preview camera entity can sit on the animation path while the picture is drawn with the
// main camera: on WebGPU the splat material takes its camera from material parameters (see
// src/splat/gpu-camera-uniforms.ts) which src/splat.ts writes for the main camera every frame,
// and the preview render pass draws the same material. That made the preview a copy of the
// main viewport (measured before the fix: 0.94 correlation with the viewport, -0.006 with the
// animation camera) even though the preview camera transform was correct.
//
// Method: key the animation camera at pose A (frame 0), park the editor camera at a very
// different pose C, then capture
//   pipC / mainC   preview picture and viewport render with the editor camera at C
//   pipA / mainA   the same after moving the editor camera onto pose A
// A correct preview matches mainA and ignores the editor camera; a preview that draws the main
// camera matches mainC and changes when the editor camera moves.
//
// usage: node docs/verify/verify-pip-camera.cjs "<url>" [model]
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { decodePng } = require('./lib/png.cjs');

const { BROWSER_PATH: EDGE } = require('./lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const OUT = require('path').join(__dirname, '..', '..', '..', '_tmp');
const GW = 48;
const GH = 27;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const pump = (page, n = 14) => page.evaluate(async (count) => {
    const scene = window.scene;
    for (let i = 0; i < count; i++) {
        scene.forceRender = true;
        scene.app.renderNextFrame = true;
        await new Promise(r => requestAnimationFrame(() => setTimeout(r, 25)));
    }
}, n).then(() => sleep(400));

// luminance grid, zero mean / unit norm
const gridOf = (buf) => {
    const { width: w, height: h, channels: ch, data } = decodePng(buf);
    const g = new Float64Array(GW * GH);
    const cnt = new Float64Array(GW * GH);
    for (let y = 0; y < h; y++) {
        const gy = Math.min(GH - 1, Math.floor(y / h * GH));
        for (let x = 0; x < w; x++) {
            const gx = Math.min(GW - 1, Math.floor(x / w * GW));
            const i = (y * w + x) * ch;
            g[gy * GW + gx] += (data[i] + data[i + 1] + data[i + 2]) / 3;
            cnt[gy * GW + gx]++;
        }
    }
    let mean = 0;
    for (let i = 0; i < g.length; i++) {
        g[i] /= Math.max(1, cnt[i]);
        mean += g[i];
    }
    mean /= g.length;
    let norm = 0;
    for (let i = 0; i < g.length; i++) {
        g[i] -= mean;
        norm += g[i] * g[i];
    }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < g.length; i++) g[i] /= norm;
    return g;
};

const corr = (a, b) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return +s.toFixed(3);
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
        await page.setViewport({ width: 1280, height: 720 });
        page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text().slice(0, 200)); });
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

        const moveTo = (azim, elev) => page.evaluate(async (a, e) => {
            const scene = window.scene;
            scene.camera.setAzimElev(a, e);
            for (let i = 0; i < 90; i++) {
                scene.forceRender = true;
                scene.app.renderNextFrame = true;
                await new Promise(r => requestAnimationFrame(() => setTimeout(r, 20)));
            }
        }, azim, elev);

        const hideUi = (hide) => page.evaluate((h) => {
            let el = document.getElementById('__probe_hide_ui');
            if (h) {
                if (!el) {
                    el = document.createElement('style');
                    el.id = '__probe_hide_ui';
                    el.textContent = 'body * { visibility: hidden !important; } canvas { visibility: visible !important; }';
                    document.head.appendChild(el);
                }
            } else if (el) {
                el.remove();
            }
        }, hide);

        const shot = async (selector, tag) => {
            const box = await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
            }, selector);
            if (!box) return null;
            const png = Buffer.from(await page.screenshot({ type: 'png', clip: box }));
            fs.writeFileSync(`${OUT}/verify-pip-camera-${tag}.png`, png);
            return gridOf(png);
        };

        // match the preview camera's fov so the two pictures are comparable
        await page.evaluate(async () => {
            const scene = window.scene;
            scene.events.fire('grid.setVisible', false);
            scene.events.fire('statusBar.panelChanged', 'timeline');
            await new Promise(r => setTimeout(r, 500));
            scene.events.fire('camera.setFov', 75);
            await new Promise(r => setTimeout(r, 300));
        });

        // key pose A at frame 0, pose B at frame 90
        await moveTo(35, 25);
        await page.evaluate(async () => {
            const scene = window.scene;
            scene.events.fire('track.addKeyTo', 'camera', 0);
            await new Promise(r => setTimeout(r, 600));
        });
        await moveTo(200, -20);
        await page.evaluate(async () => {
            const scene = window.scene;
            scene.events.fire('track.addKeyTo', 'camera', 90);
            await new Promise(r => setTimeout(r, 600));
            scene.events.fire('timeline.setFrame', 0);
            await new Promise(r => setTimeout(r, 500));
        });

        // editor camera parked at pose C: preview must NOT follow it
        await moveTo(-90, 70);
        await pump(page, 16);
        const pipC = await shot('.camera-pip-canvas', 'pipC');
        await hideUi(true);
        await pump(page, 6);
        const mainC = await shot('canvas', 'mainC');
        await hideUi(false);

        // editor camera on pose A: preview stays the same, viewport now looks like the preview
        await moveTo(35, 25);
        await pump(page, 16);
        const pipA = await shot('.camera-pip-canvas', 'pipA');
        await hideUi(true);
        await pump(page, 6);
        const mainA = await shot('canvas', 'mainA');
        await hideUi(false);

        if (!pipC || !pipA || !mainA || !mainC) {
            console.log(JSON.stringify({ backend, failed: 1, fatal: 'preview or viewport capture missing', logs }, null, 2));
            process.exitCode = 1;
            return;
        }

        const c = {
            pipVsMainAtC: corr(pipC, mainC),
            pipVsMainAtA: corr(pipC, mainA),
            pipStableAcrossEditorMoves: corr(pipA, pipC),
            viewportPosesDiffer: corr(mainA, mainC)
        };

        const checks = [
            {
                name: 'the two viewport poses really are different (control)',
                pass: Math.abs(c.viewportPosesDiffer) < 0.3,
                detail: `viewport at pose A vs pose C correlation ${c.viewportPosesDiffer}`
            },
            {
                name: 'preview renders the animation camera, not the viewport camera',
                pass: c.pipVsMainAtA > 0.7 && c.pipVsMainAtC < 0.3,
                detail: `preview vs animation camera ${c.pipVsMainAtA}, preview vs viewport at the other pose ${c.pipVsMainAtC}`
            },
            {
                name: 'preview picture is independent of where the editor camera is',
                pass: c.pipStableAcrossEditorMoves > 0.95,
                detail: `preview before/after moving the editor camera: ${c.pipStableAcrossEditorMoves}`
            },
            {
                name: 'no console errors',
                pass: logs.length === 0,
                detail: logs.length ? JSON.stringify(logs.slice(0, 3)) : 'clean'
            }
        ];

        console.log(JSON.stringify({
            backend,
            url: URL,
            correlation: c,
            checks,
            failed: checks.filter(x => !x.pass).length,
            files: ['pipC', 'mainC', 'pipA', 'mainA'].map(t => `${OUT}/verify-pip-camera-${t}.png`),
            logs
        }, null, 2));
        if (checks.some(x => !x.pass)) process.exitCode = 1;
    } catch (e) {
        console.log(JSON.stringify({ fatal: String(e).slice(0, 400), logs }, null, 2));
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
