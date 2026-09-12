// Headless verification for the V3 selection depth / footprint / sphere brush
// work (SuperSplat-aligned quadrants + single-dispatch brush).
//
// Boots the built app in headless Edge (swiftshader WebGL), imports a small
// synthetic gaussian PLY, then drives every selection path and reports:
//   - page errors and console errors (shader compile failures show up here)
//   - how many splats each path selected (proves the pass actually ran)
//
// usage: node docs/verify/verify-selection-depth.cjs [url]
const puppeteer = require('C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3100/';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
    });

    const errors = [];
    const warnings = [];

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });

        page.on('pageerror', e => errors.push('pageerror: ' + String(e).slice(0, 600)));
        page.on('console', (m) => {
            const t = m.text();
            if (m.type() === 'error') {
                errors.push('console: ' + t.slice(0, 600));
            } else if (/shader|compile|error|warn/i.test(t)) {
                warnings.push(t.slice(0, 300));
            }
        });

        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForFunction('!!window.scene', { timeout: 60000 });
        await sleep(2000);

        // import the synthetic model through the app's own import entry point
        const imported = await page.evaluate(async () => {
            const buf = await (await fetch('./test-model.ply')).arrayBuffer();
            const file = new File([buf], 'test-model.ply');
            await window.scene.events.invoke('import', [{ filename: 'test-model.ply', contents: file }]);
            return buf.byteLength;
        });

        await page.waitForFunction(
            "window.scene.getElementsByType('splat').length > 0", { timeout: 60000 });
        await sleep(2500);

        const result = await page.evaluate(async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const scene = window.scene;
            const events = scene.events;
            const splat = scene.getElementsByType('splat')[0];

            events.fire('selection.set', splat);
            await sleep(500);

            const state = splat.splatData.getProp('state');
            const countSelected = () => {
                let n = 0;
                for (let i = 0; i < state.length; ++i) {
                    if (state[i] & 1) n++;
                }
                return n;
            };

            const out = { numSplats: splat.splatData.numSplats, steps: [], toggles: {} };
            // Mat4 / Vec3 / Quat helpers built from instances the app exposes
            const Mat4Ctor = scene.camera.mainCamera.getWorldTransform().constructor;
            const Vec3Ctor = scene.camera.mainCamera.getPosition().constructor;
            const QuatCtor = scene.camera.mainCamera.getRotation().constructor;

            const selectNone = async () => {
                events.fire('select.none');
                // wait until the queued ops have actually cleared the selection,
                // otherwise a late-applying previous step confounds the count
                const deadline = Date.now() + 5000;
                while (Date.now() < deadline && countSelected() !== 0) {
                    await sleep(200);
                }
            };

            // record the selected count once it has settled (async GPU work)
            const record = async (name, timeoutMs = 20000) => {
                const deadline = Date.now() + timeoutMs;
                let last = -1;
                let stable = 0;
                while (Date.now() < deadline) {
                    await sleep(300);
                    const now = countSelected();
                    if (now === last && now > 0) {
                        if (++stable >= 2) break;
                    } else {
                        stable = 0;
                    }
                    last = now;
                }
                out.steps.push({ name, selected: countSelected() });
            };

            const rect = { start: { x: 0.25, y: 0.25 }, end: { x: 0.75, y: 0.75 } };

            // 1. centers (both toggles off)
            events.fire('selection.setFootprint', 0);
            events.fire('selection.setUseDepth', false);
            await selectNone();
            await events.invoke('select.rect', 'add', rect);
            await record('rect / centers');

            // 2. footprint (depth off): projected gaussian extent vs rect
            events.fire('selection.setFootprint', 1);
            await selectNone();
            await events.invoke('select.rect', 'add', rect);
            await record('rect / footprint 1.00');

            // 2b. the footprint value is continuous: partial coverage has to land
            // between the center test and the full footprint
            events.fire('selection.setFootprint', 0.35);
            await selectNone();
            await events.invoke('select.rect', 'add', rect);
            await record('rect / footprint 0.35');

            // 3. depth without footprint: visible picks narrowed to centers
            events.fire('selection.setFootprint', 0);
            events.fire('selection.setUseDepth', true);
            await selectNone();
            await events.invoke('select.rect', 'add', rect);
            await record('rect / depth');

            // 4. depth + footprint: visible coverage in the region
            events.fire('selection.setFootprint', 1);
            await selectNone();
            await events.invoke('select.rect', 'add', rect);
            await record('rect / depth+footprint');

            // 5. mask stroke (footprint on, depth off) + 6. mask with depth on
            const canvas = document.createElement('canvas');
            canvas.width = scene.canvas.clientWidth;
            canvas.height = scene.canvas.clientHeight;
            const ctx = canvas.getContext('2d');
            ctx.strokeStyle = '#f60';
            ctx.lineCap = 'round';
            ctx.lineWidth = 90;
            ctx.beginPath();
            ctx.moveTo(canvas.width * 0.3, canvas.height * 0.5);
            ctx.lineTo(canvas.width * 0.7, canvas.height * 0.5);
            ctx.stroke();

            events.fire('selection.setFootprint', 1);
            events.fire('selection.setUseDepth', false);
            await selectNone();
            await events.invoke('select.byMask', 'add', canvas, ctx);
            await record('mask / footprint');

            events.fire('selection.setUseDepth', true);
            await selectNone();
            await events.invoke('select.byMask', 'add', canvas, ctx);
            await record('mask / depth');

            // 7. sphere volume: center test vs footprint (support-function) test
            // with a radius that does NOT cover the whole model, so the two
            // criteria have to disagree
            const t = new Mat4Ctor();
            const rot = new QuatCtor();
            const scale = new Vec3Ctor(0.8, 0.8, 0.8);
            const center = splat.entity.getPosition();
            t.setTRS(center, rot, scale);
            events.fire('selection.setFootprint', 0);
            events.fire('selection.setUseDepth', false);
            await selectNone();
            events.fire('select.bySphere', 'add', t);
            await record('sphere / centers (r=0.4)');
            events.fire('selection.setFootprint', 1);
            await selectNone();
            events.fire('select.bySphere', 'add', t);
            await record('sphere / footprint (r=0.4)');

            // 8. sphere brush path (batched depth picks + capsule intersect)
            events.fire('selection.setFootprint', 0);
            events.fire('selection.setUseDepth', false);
            await selectNone();
            const brushCanvas = document.createElement('canvas');
            brushCanvas.width = scene.canvas.clientWidth;
            brushCanvas.height = scene.canvas.clientHeight;
            const bctx = brushCanvas.getContext('2d');
            bctx.strokeStyle = '#f60';
            bctx.lineCap = 'round';
            bctx.lineWidth = 60;
            bctx.beginPath();
            bctx.moveTo(brushCanvas.width * 0.35, brushCanvas.height * 0.5);
            bctx.lineTo(brushCanvas.width * 0.65, brushCanvas.height * 0.5);
            bctx.stroke();
            const points = [];
            for (let i = 0; i <= 20; ++i) {
                points.push({ x: 0.35 + (0.3 * i) / 20, y: 0.5, radius: 30 });
            }
            await events.invoke('select.bySphereBrush', 'add', points, brushCanvas);
            await record('sphere brush (path)');

            // 9. same brush with footprint on (extent-widened capsules)
            events.fire('selection.setFootprint', 1);
            await selectNone();
            await events.invoke('select.bySphereBrush', 'add', points, brushCanvas);
            await record('sphere brush (path, footprint)');

            // read the toggle state back so a stale bundle cannot masquerade as a
            // passing run
            out.toggles.depth = events.invoke('selection.useDepth');
            out.toggles.footprint = events.invoke('selection.footprint');
            events.fire('selection.setUseDepth', true);
            await sleep(120);
            out.toggles.depthAfterSet = events.invoke('selection.useDepth');
            events.fire('selection.setUseDepth', false);
            // toggle returns to the last non-zero value, not always 1
            events.fire('selection.setFootprint', 0.35);
            await sleep(120);
            events.fire('selection.toggleFootprint');
            await sleep(120);
            out.toggles.footprintAfterToggleOff = events.invoke('selection.footprint');
            events.fire('selection.toggleFootprint');
            await sleep(120);
            out.toggles.footprintAfterToggleOn = events.invoke('selection.footprint');
            events.fire('selection.setFootprint', 0);

            return out;
        });

        // ordering checks: the footprint value must be continuous, i.e. partial
        // coverage sits between the center test and the full footprint
        const byName = Object.fromEntries(result.steps.map(s => [s.name, s.selected]));
        const centers = byName['rect / centers'];
        const half = byName['rect / footprint 0.35'];
        const full = byName['rect / footprint 1.00'];
        const checks = [
            { name: 'footprint 1.00 covers at least the centers', pass: full >= centers, detail: `${full} vs ${centers}` },
            { name: 'footprint 0.35 sits between centers and full', pass: half >= centers && half <= full, detail: `${centers} <= ${half} <= ${full}` },
            { name: 'toggle restores the last footprint value', pass: Math.abs(result.toggles.footprintAfterToggleOn - 0.35) < 1e-6, detail: String(result.toggles.footprintAfterToggleOn) }
        ];

        console.log(JSON.stringify({ importedBytes: imported, ...result, checks, failed: checks.filter(c => !c.pass).length, errors, warnings: warnings.slice(0, 20) }, null, 2));
        if (checks.some(c => !c.pass) || errors.length) process.exitCode = 1;
    } catch (err) {
        console.log(JSON.stringify({ fatal: String(err).slice(0, 800), errors, warnings: warnings.slice(0, 20) }, null, 2));
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
