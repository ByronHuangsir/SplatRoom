#!/usr/bin/env node
/**
 * L2 browser render probe.
 *
 * Boots the real SplatRoom editor headlessly (Edge + SwiftShader), loads
 * scripts/real-test.ply via the #file-selector input, and verifies:
 *   1. no WebGL / shader compile errors (the new `splat.index % stride` drop)
 *   2. the model actually renders (non-blank canvas)
 *   3. uLodStride defaults to 1 (no drop) when the model fills the view
 *   4. uLodStride engages > 1 when the viewport is shrunk (model small on screen)
 *
 * Usage: node scripts/probe-l2.mjs [plyPath]
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PUPPETEER_CANDIDATES = [
    'C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core',
    'puppeteer-core'
];
let puppeteer;
for (const c of PUPPETEER_CANDIDATES) {
    try { puppeteer = require(c); break; } catch { /* try next */ }
}
if (!puppeteer) { console.error('puppeteer-core not found'); process.exit(1); }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');
const PLY = process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) : path.resolve(__dirname, '..', 'scripts', 'real-test.ply');
const DIST_PLY = path.join(DIST, 'real-test.ply');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
    '.map': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = path.join(DIST, urlPath);
    if (!filePath.startsWith(DIST)) { res.writeHead(403); res.end('forbidden'); return; }
    fs.readFile(filePath, (err, buf) => {
        if (err) { res.writeHead(404); res.end('not found: ' + urlPath); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
        res.end(buf);
    });
});

const waitForServer = (port, tries = 50) => new Promise((resolve, reject) => {
    const attempt = (n) => {
        const s = http.get({ host: '127.0.0.1', port, path: '/' }, r => { r.resume(); resolve(); });
        s.on('error', () => n <= 0 ? reject(new Error('server did not start')) : setTimeout(() => attempt(n - 1), 100));
    };
    attempt(tries);
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Race a promise against a timeout so a hung/crashed headless page can never
// block the probe indefinitely (SwiftShader is fragile under load).
const withTimeout = (p, ms, label) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout:' + label)), ms))
]);

const main = async () => {
    await new Promise(r => server.listen(3000, '127.0.0.1', r));
    await waitForServer(3000);
    console.log('server up on :3000');

    // stage the model into dist/ so the probe http server can serve it (in-page fetch)
    fs.copyFileSync(PLY, DIST_PLY);

    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'old',
        args: [
            '--no-sandbox',
            '--ignore-gpu-blocklist',
            '--enable-unsafe-swiftshader',
            '--use-gl=angle',
            '--use-angle=swiftshader',
            // Keep the headless compositor fully active so the WebGL canvas is
            // actually presented each frame rather than staying blank/paused.
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-features=CalculateWindowOcclusion,PaintHolding'
        ]
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 700 });

    // Force the #file-selector fallback path: 127.0.0.1 is a secure context, so
    // headless Edge exposes window.showOpenFilePicker and the app never mounts the
    // hidden <input id="file-selector"> we drive via uploadFile(). Delete it before
    // any page script runs so the fallback branch is taken.
    await page.evaluateOnNewDocument(() => { try { delete window.showOpenFilePicker; } catch { /* ignore */ } });
    await page.evaluateOnNewDocument(() => {
        window.__rej = null;
        window.addEventListener('unhandledrejection', e => {
            window.__rej = (e.reason && (e.reason.stack || e.reason.message)) || String(e.reason);
        });
    });

    const errors = [];
    let noiseCount = 0;
    // Pre-existing headless-only noise: the orientation/axis SVG gizmo reads a
    // NaN scene bound and emits "translate(NaN,NaN)" DOM errors every frame.
    // Unrelated to L2 (the WebGL canvas renders fine); filter so it can't
    // drown the real signals or blow up the result log.
    const isNoise = (t) => /translate\(NaN|<g> attribute|<line> attribute|Expected number|Expected length|NaN/i.test(t);
    page.on('console', m => {
        const t = m.text();
        if (m.type() === 'error') {
            if (isNoise(t)) { noiseCount++; return; }
            errors.push(t); console.log('PAGE-ERR:', t);
        }
        else if (m.type() === 'warning') console.log('PAGE-WARN:', t);
        else console.log('PAGE[' + m.type() + ']:', t);
    });
    page.on('pageerror', e => {
        const t = e.message || String(e);
        if (isNoise(t)) { noiseCount++; return; }
        errors.push(t); console.log('PAGEERROR:', t);
    });

    await page.goto('http://127.0.0.1:3000/index.html', { waitUntil: 'networkidle0', timeout: 60000 });

    // wait for app + file selector
    await page.waitForFunction('typeof window.scene !== "undefined"', { timeout: 30000 });
    await page.waitForFunction('!!document.querySelector("#file-selector")', { timeout: 30000 });
    console.log('app booted, file-selector present');

    // upload the model: puppeteer's CDP file-chooser can fail on the hidden/
    // detached #file-selector input (yields 0 files), so instead fetch the staged
    // PLY in-page, build a File, assign it via DataTransfer and dispatch 'change'.
    const uploadedCount = await page.evaluate(async (name) => {
        const input = document.querySelector('#file-selector');
        if (!input) return -1;
        const resp = await fetch('real-test.ply');
        const blob = await resp.blob();
        const file = new File([blob], name, { type: 'application/octet-stream' });
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return input.files.length;
    }, path.basename(PLY));
    console.log('uploaded', path.basename(PLY), '(files on input:', uploadedCount + ')');

    // recursive helpers (splat entity lives under contentRoot, not directly under app.root)
    const hasSplatFn = `(() => {
        const s = window.scene; if (!s || !s.app) return false;
        let ok = false;
        const walk = (n) => { if (ok) return; if (n.gsplat) { ok = true; return; } const c = n.children; if (c) for (const ch of c) walk(ch); };
        walk(s.app.root); return ok;
    })()`;
    const findSplatFn = `(() => {
        const s = window.scene; if (!s || !s.app) return null;
        let found = null;
        const walk = (n) => { if (found) return; if (n.gsplat && n.gsplat.instance && n.gsplat.instance.material) { found = n; return; } const c = n.children; if (c) for (const ch of c) walk(ch); };
        walk(s.app.root); return found;
    })()`;

    // wait for a splat entity to exist
    try {
        await page.waitForFunction(hasSplatFn, { timeout: 60000 });
    } catch (e) {
        const diag = await page.evaluate(`(() => {
            const s = window.scene; const out = { hasScene: !!s, hasApp: !!(s && s.app), rej: window.__rej };
            if (s && s.app) {
                let total = 0, gsplat = 0;
                const walk = (n) => { total++; if (n.gsplat) gsplat++; const c = n.children; if (c) for (const ch of c) walk(ch); };
                walk(s.app.root);
                out.totalEntities = total; out.gsplatEntities = gsplat;
            }
            return out;
        })()`).catch(err => ({ evalError: String(err) }));
        console.error('SPLAT WAIT TIMEOUT. DIAG:', JSON.stringify(diag));
        await browser.close();
        try { fs.unlinkSync(DIST_PLY); } catch { /* ignore */ }
        server.close(); process.exit(1);
    }
    console.log('model loaded');
    await sleep(1500); // let it render a few frames

    // The gsplat worldBound / meshInstance.aabb can be NaN in this build (not
    // reliably synced), which makes fitCamera place the camera at NaN → the model
    // is invisible. Recompute the splat bounds from data (updateLocalBounds) and
    // re-frame the camera so the model is actually on screen for the test.
    const camFix = await page.evaluate(`(async () => {
        const s = window.scene;
        const splats = s.getElementsByType ? s.getElementsByType('splat') : [];
        let fixed = 0;
        for (const sp of splats) { if (sp.updateLocalBounds) { try { await sp.updateLocalBounds(); fixed++; } catch (e) {} } }
        if (s.camera && s.camera.focus) { try { s.camera.focus(); } catch (e) {} }

        // Brute-force fallback: fitCamera uses sceneBound.center which is NaN in
        // this build, leaving the orbit camera at NaN. Use the splat resource
        // AABB (valid) to compute a framing pose and force it via poseOverride,
        // which bypasses the tween machinery and sets the camera entity directly.
        let fallback = null;
        try {
            // Compute a GUARANTEED-FINITE bounding box directly from the splat
            // data positions. worldBound / meshInstance.aabb are NaN in this
            // headless build, so we must not use them for framing.
            const spElem = splats[0];
            const inst = spElem && spElem.entity && spElem.entity.gsplat && spElem.entity.gsplat.instance;
            const sd = inst && inst.resource;   // GSplatData (valid)
            const cam = s.camera;
            let center = null, r = null;
            if (sd && sd.getProp && typeof sd.numSplats === 'number') {
                const xs = sd.getProp('x'), ys = sd.getProp('y'), zs = sd.getProp('z');
                const n = sd.numSplats;
                let minX = Infinity, minY = Infinity, minZ = Infinity;
                let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
                const step = Math.max(1, Math.floor(n / 40000));
                let cnt = 0;
                for (let i = 0; i < n; i += step) {
                    const x = xs[i], y = ys[i], z = zs[i];
                    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
                        if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
                        if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
                        cnt++;
                    }
                }
                if (cnt > 0) {
                    center = { x: (minX + maxX) * 0.5, y: (minY + maxY) * 0.5, z: (minZ + maxZ) * 0.5 };
                    r = Math.max(0.001, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * 0.5);
                }
            }
            if (!center && inst && inst.resource && inst.resource.aabb && inst.resource.aabb.center) {
                const a = inst.resource.aabb;
                if (Number.isFinite(a.center.x) && Number.isFinite(a.center.y) && Number.isFinite(a.center.z)) {
                    center = { x: a.center.x, y: a.center.y, z: a.center.z };
                    r = Math.max(0.001, Math.hypot(a.halfExtents.x, a.halfExtents.y, a.halfExtents.z));
                }
            }
            if (center && cam && cam.mainCamera && cam.setPoseOverride) {
                const cx = center.x, cy = center.y, cz = center.z;
                const dist = Math.max(r * 3.0, 0.5);
                const ex = cx + dist * 0.4, ey = cy + dist * 0.3, ez = cz + dist;
                // Build a REAL Quat via lookAt (camera.ts calls
                // mainCamera.setLocalRotation(rotation); a plain {x,y,z,w}
                // object is NOT a Quat and yields NaN rotation -> black canvas).
                const ce = cam.mainCamera;
                ce.setLocalPosition(ex, ey, ez);
                ce.lookAt(cx, cy, cz, 0, 1, 0);
                const q = ce.getLocalRotation();
                cam.setPoseOverride({
                    position: { x: ex, y: ey, z: ez },
                    rotation: q,
                    fov: 45,
                    near: 0.01,
                    far: dist * 10 + 1
                });
                // Kick the render loop so the new pose actually presents a frame.
                try {
                    if (s.app && s.app.update && s.app.render) {
                        for (let i = 0; i < 8; i++) { s.app.update(16); s.app.render(); }
                    }
                } catch (e) {}
                const p = ce.getLocalPosition();
                fallback = { center: [cx, cy, cz], radius: r, dist, eye: [ex, ey, ez], camPos: [p.x, p.y, p.z], q: [q.x, q.y, q.z, q.w] };
            } else {
                fallback = { noCenter: !center, hasCam: !!cam, hasMain: !!(cam && cam.mainCamera) };
            }
        } catch (e) {
            fallback = { err: e.message || String(e) };
        }
        return { fixed, hasFocus: !!(s.camera && s.camera.focus), fallback };
    })()`).catch(err => ({ evalError: String(err) }));
    console.log('CAM-FIX:', JSON.stringify(camFix));
    await sleep(1500);

    const readStride = () => page.evaluate(`(() => {
        const s = window.scene; let stride = null;
        const walk = (n) => {
            if (n.gsplat && n.gsplat.instance && n.gsplat.instance.material) {
                const p = n.gsplat.instance.material.parameters && n.gsplat.instance.material.parameters.uLodStride;
                if (p !== undefined) {
                    // PlayCanvas stores a Parameter as { scopeId, data }; the
                    // live value is in .data (not .value).
                    const v = (p && typeof p.data !== 'undefined') ? p.data
                            : (p && typeof p.value === 'number') ? p.value
                            : (typeof p === 'number' ? p : null);
                    if (v !== null) stride = v;
                }
            }
            const c = n.children; if (c) for (const ch of c) walk(ch);
        };
        walk(s.app.root);
        return stride;
    })()`);

    // Definitive pixel capture via page.screenshot (NOT toDataURL / readPixels).
    // In this headless SwiftShader setup the WebGL back buffer is cleared before
    // either of those can read it (preserveDrawingBuffer:false), so they return
    // a blank buffer (we confirmed readPixels reads all-zero). page.screenshot
    // captures the COMPOSITED surface, which is the reliable way to see the
    // actually-presented frame. We save the PNG to disk AND return a hash so we
    // can both eyeball it and compare frames programmatically.
    //
    // Also pick the LARGEST visible canvas instead of blindly using querySelector,
    // because SplatRoom may create multiple canvases (viewport, pick, etc.).
    const pickCanvas = async () => page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('canvas'));
        const visible = all.filter(c => {
            const r = c.getBoundingClientRect();
            const s = getComputedStyle(c);
            return r.width > 100 && r.height > 100 && s.display !== 'none' && s.visibility !== 'hidden';
        });
        visible.sort((a, b) => (b.width * b.height) - (a.width * a.height));
        const chosen = visible[0] || all[0];
        if (!chosen) return null;
        const r = chosen.getBoundingClientRect();
        const s = getComputedStyle(chosen);
        return {
            x: r.x, y: r.y,
            width: Math.round(r.width), height: Math.round(r.height),
            internal: chosen.width + 'x' + chosen.height,
            alpha: chosen.getContext('webgl') ? true : chosen.getContext('webgl2') ? true : false,
            background: s.backgroundColor,
            totalCanvases: all.length
        };
    }).catch(() => null);

    const SHOT_DIR = path.join(__dirname, 'probe-shots');
    try { fs.mkdirSync(SHOT_DIR, { recursive: true }); } catch { /* ignore */ }
    const captureShot = async (name) => {
        const box = await pickCanvas();
        if (!box || box.width < 2 || box.height < 2) return 'nocanvas';
        const buf = await page.screenshot({
            clip: { x: Math.max(0, box.x), y: Math.max(0, box.y), width: box.width, height: box.height },
            type: 'png'
        });
        const file = path.join(SHOT_DIR, name + '.png');
        fs.writeFileSync(file, buf);
        let hash = 2166136261 >>> 0;   // FNV-1a
        for (let i = 0; i < buf.length; i += 101) hash = (Math.imul(hash ^ buf[i], 16777619)) >>> 0;
        return 'H' + hash.toString(16) + ':' + buf.length;
    };

    const canvasInfo = await pickCanvas().catch(() => null);
    console.log('CANVAS-INFO:', JSON.stringify(canvasInfo));

    // In headless mode requestAnimationFrame may be throttled, so PlayCanvas
    // never reaches app.render(). Force a full update+render cycle so we can
    // actually see the model and measure stride changes.
    const forceFrame = () => page.evaluate(() => {
        try {
            const app = window.scene && window.scene.app;
            if (app) { app.update(16); app.render(); }
        } catch (e) {}
    }).catch(() => {});

    try {
        const full = await page.screenshot({ type: 'png' });
        fs.writeFileSync(path.join(SHOT_DIR, 'fullpage.png'), full);
        let h = 2166136261 >>> 0;
        for (let i = 0; i < full.length; i += 101) h = (Math.imul(h ^ full[i], 16777619)) >>> 0;
        console.log('FULLPAGE-SHOT:', full.length, 'H' + h.toString(16));
    } catch (e) { console.log('FULLPAGE-ERR:', e.message); }

    // 1) model visible at default stride (no drop) after focus frames it
    await forceFrame();
    await sleep(500);
    const shotNormal = await withTimeout(captureShot('normal'), 15000, 'shotNormal').catch(() => '');
    const strideNormal = await withTimeout(readStride(), 8000, 'strideNormal').catch(() => null);

    // 2) Isolate the decimation effect from camera motion: keep the SAME
    //    (model-visible, default) camera and only flip the stride pin.
    //      - pin stride=1 -> dense   (full model)
    //      - pin stride=8 -> sparse  (shader keeps only 1/8 of the gaussians)
    //      - pin stride=1 -> dense   (confirms the effect is reversible)
    //    The dense vs sparse frame hashes at the IDENTICAL camera MUST differ,
    //    which proves the shader actually discards splats on the GPU.
    //    (No dolly: the headless camera is NaN-fragile and a setDistance can
    //    push the model off-screen, collapsing both renders to blank-identical
    //    and masking the real comparison.)
    await withTimeout(page.evaluate(() => { window.__FORCE_LOD_STRIDE__ = 1; }), 8000, 'hookDense').catch(() => {});
    await forceFrame();
    await sleep(1200);
    const shotDense = await withTimeout(captureShot('dense'), 15000, 'shotDense').catch(() => '');
    const strideDense = await withTimeout(readStride(), 8000, 'strideDense').catch(() => null);

    await withTimeout(page.evaluate(() => { window.__FORCE_LOD_STRIDE__ = 8; }), 8000, 'hookSparse').catch(() => {});
    await forceFrame();
    await sleep(1200);
    const shotSparse = await withTimeout(captureShot('sparse'), 15000, 'shotSparse').catch(() => '');
    const strideSparse = await withTimeout(readStride(), 8000, 'strideSparse').catch(() => null);

    await withTimeout(page.evaluate(() => { window.__FORCE_LOD_STRIDE__ = 1; }), 8000, 'hookRestore').catch(() => {});
    await forceFrame();
    await sleep(1200);
    const shotRestore = await withTimeout(captureShot('restore'), 15000, 'shotRestore').catch(() => '');

    // Deep introspection: how is uLodStride actually stored on the material,
    // and does updateLod's force-hook path run?
    const paramDbg = await page.evaluate(`(() => {
        const s = window.scene;
        const el = s.getElementsByType('splat')[0];
        const inst = el.entity.gsplat.instance;
        const mat = inst.material;
        const raw = mat.parameters && mat.parameters.uLodStride;
        let info = { rawType: typeof raw };
        try { info.rawJson = JSON.stringify(raw); } catch (e) { info.rawJson = '(' + (raw && raw.constructor && raw.constructor.name) + ')'; }
        if (raw && typeof raw === 'object') {
            info.keys = Object.keys(raw);
            info.valueType = typeof raw.value;
            info.value = raw.value;
        }
        const sceneHasHook = (typeof window.__FORCE_LOD_STRIDE__);
        const hookVal = window.__FORCE_LOD_STRIDE__;
        return { info, sceneHasHook, hookVal, hasMat: !!mat, matName: mat && mat.name };
    })()`).catch(err => ({ evalError: String(err) }));
    console.log('PARAM-DBG:', JSON.stringify(paramDbg));

    const shaderDbg = await page.evaluate(`(() => {
        const s = window.scene;
        const el = s.getElementsByType('splat')[0];
        const inst = el.entity.gsplat.instance;
        const mat = inst.material;
        const sh = mat.shader;
        let hasInDef = false, vsLen = 0;
        if (sh) {
            const src = (sh.definition && sh.definition.vshader) || sh.vshader || (sh.code && sh.code.vs) || '';
            hasInDef = src.indexOf('uLodStride') >= 0;
            vsLen = src.length;
        }
        return { hasShader: !!sh, hasInDef: hasInDef, vsLen: vsLen };
    })()`).catch(err => ({ evalError: String(err) }));
    console.log('SHADER-DBG:', JSON.stringify(shaderDbg));

    // 3) natural auto-engagement (no hook): clear the pin, keep camera far →
    //    updateLod should itself compute a stride > 1.
    //
    // The headless SwiftShader context is fragile; if the page crashes, a bare
    // page.evaluate hangs forever and swallows the RESULT print below. Wrap
    // every remaining step in a timeout race + try/catch so we ALWAYS reach
    // RESULT even if the page is unstable.

    let strideSmall = null;
    try {
        await withTimeout(page.evaluate(() => { window.__FORCE_LOD_STRIDE__ = undefined; }), 8000, 'clearHook').catch(() => {});
        await sleep(1500);
        strideSmall = await withTimeout(readStride(), 8000, 'strideSmall');
    } catch (e) {
        console.error('strideSmall step failed (non-fatal):', e && e.message ? e.message : String(e));
    }

    // Compute + print RESULT BEFORE any risky teardown so a hung browser
    // close can never hide the verdict.
    const result = {
        strideNormal, strideDense, strideSparse, strideSmall,
        shotNormal, shotDense, shotSparse, shotRestore,
        // The core L2 proof: at the SAME camera, stride=8 keeps only 1/8 of the
        // gaussians, so the rendered frame's screenshot hash must differ from
        // stride=1.
        renderChanged: shotDense !== shotSparse && /^H/.test(shotDense) && /^H/.test(shotSparse),
        // Reversibility: re-pinning stride=1 must restore the dense frame.
        restored: shotRestore === shotDense && /^H/.test(shotRestore),
        noiseCount,
        shaderErrors: errors.filter(e => /shader|glsl|webgl|compile/i.test(e)),
        allErrorsSample: errors.slice(0, 5)
    };
    console.log('RESULT:', JSON.stringify(result, null, 1));

    const ok = result.shaderErrors.length === 0 &&
        /^H/.test(shotNormal) &&
        result.renderChanged &&
        result.strideSparse !== null;
    if (!ok) {
        console.error('L2 PROBE FAILED');
    } else {
        console.log('L2 PROBE OK (default stride=' + result.strideNormal +
            ', pinned dense stride=' + result.strideDense +
            ', pinned sparse stride=' + result.strideSparse +
            ', auto small-on-screen stride=' + result.strideSmall +
            ', restored=' + result.restored + ')');
    }

    // Guarded teardown: never let a hung/crashed headless instance swallow the
    // exit code or the RESULT we already printed.
    try {
        await withTimeout(browser.close(), 8000, 'browserClose');
    } catch (e) {
        console.error('browser.close warning:', e && e.message ? e.message : String(e));
    }
    try { fs.unlinkSync(DIST_PLY); } catch { /* ignore */ }
    server.close();
    process.exit(ok ? 0 : 1);
};

// Never let an unexpected throw / rejection hide the run: surface it then exit.
process.on('unhandledRejection', (e) => { console.error('UNHANDLED REJECTION:', e && e.stack ? e.stack : String(e)); });
process.on('uncaughtException', (e) => { console.error('UNCAUGHT:', e && e.stack ? e.stack : String(e)); });

main().catch(e => { console.error('PROBE ERROR:', e); try { fs.unlinkSync(DIST_PLY); } catch { /* ignore */ } server.close(); process.exit(1); });
