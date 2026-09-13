// Headless verification for the V3 screen-selection paths and the selection ops.
//
// Since 3.7.9 every screen-space gesture (rect / lasso / mask stroke / click) runs the same
// CPU pass: project every splat, keep the ones inside the 2D region, keep those inside the
// depth range (default 0 / 100 = the whole model). This suite drives each entry point plus
// the modifier ops (set / add / remove / intersect) and the 3D tools that are unchanged
// (sphere, box, sphere brush), so a regression in any of them is visible.
//
// usage: node docs/verify/verify-selection-depth.cjs "<url>" [model]
const puppeteer = require('C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
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

        const imported = await page.evaluate(async (m) => {
            const buf = await (await fetch('./' + m)).arrayBuffer();
            await window.scene.events.invoke('import', [{ filename: m, contents: new File([buf], m) }]);
            return buf.byteLength;
        }, MODEL);

        await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 60000 });
        await sleep(2500);

        const result = await page.evaluate(async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const scene = window.scene;
            const events = scene.events;
            const splat = scene.getElementsByType('splat').slice(-1)[0];

            events.fire('selection', splat);
            await sleep(500);
            events.fire('camera.focus');
            await sleep(1200);

            const state = splat.splatData.getProp('state');
            const countSelected = () => {
                let n = 0;
                for (let i = 0; i < state.length; ++i) {
                    if (state[i] & 1) n++;
                }
                return n;
            };

            const out = { numSplats: splat.splatData.numSplats, steps: [], flags: {} };
            const Mat4Ctor = scene.camera.mainCamera.getWorldTransform().constructor;
            const Vec3Ctor = scene.camera.mainCamera.getPosition().constructor;
            const QuatCtor = scene.camera.mainCamera.getRotation().constructor;

            const selectNone = async () => {
                events.fire('select.none');
                const deadline = Date.now() + 5000;
                while (Date.now() < deadline && countSelected() !== 0) {
                    await sleep(200);
                }
            };

            const record = async (name, timeoutMs = 20000) => {
                const deadline = Date.now() + timeoutMs;
                let last = -1;
                let stable = 0;
                while (Date.now() < deadline) {
                    await sleep(250);
                    const now = countSelected();
                    if (now === last) {
                        if (++stable >= 2) break;
                    } else {
                        stable = 0;
                    }
                    last = now;
                }
                const selected = countSelected();
                out.steps.push({ name, selected });
                return selected;
            };

            const rect = { start: { x: 0.25, y: 0.25 }, end: { x: 0.75, y: 0.75 } };
            const wide = { start: { x: 0.05, y: 0.05 }, end: { x: 0.95, y: 0.95 } };
            const left = { start: { x: 0.05, y: 0.25 }, end: { x: 0.45, y: 0.75 } };
            const right = { start: { x: 0.55, y: 0.25 }, end: { x: 0.95, y: 0.75 } };

            // the range is a straight replacement of the old depth/footprint flags
            events.fire('selection.resetDepthRange');
            await sleep(200);

            // 1. rect, set
            await selectNone();
            await events.invoke('select.rect', 'set', rect);
            const rectSet = await record('rect / set');

            // 2. the same rect again with add: an already selected region adds nothing
            await events.invoke('select.rect', 'add', rect);
            const rectAddSame = await record('rect / add (same region)');

            // 3. add a disjoint region: the selection has to grow
            await events.invoke('select.rect', 'add', right);
            const rectAddOther = await record('rect / add (disjoint region)');

            // 4. intersect with the right region: only the overlap survives
            await events.invoke('select.rect', 'intersect', right);
            const rectIntersect = await record('rect / intersect');

            // 5. remove the right region: back to nothing
            await events.invoke('select.rect', 'remove', right);
            const rectRemove = await record('rect / remove');

            // 6. a wide rect, then a narrow one, proves 'set' replaces rather than adds
            await selectNone();
            await events.invoke('select.rect', 'set', wide);
            const wideSet = await record('rect / set (wide)');
            await events.invoke('select.rect', 'set', left);
            const leftSet = await record('rect / set (left half, replaces)');

            // 7. mask stroke (lasso / polygon / 2D brush entry point)
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

            await selectNone();
            await events.invoke('select.byMask', 'set', canvas, ctx);
            const maskSet = await record('mask / set');

            // 8. click (select.point): with the default range it is a column through the model.
            // The click goes to the projected position of a real splat read back from the
            // model - the synthetic test model is sparse (points ~6 px apart on screen), so
            // clicking a fixed (0.5, 0.5) can land between splats and legitimately select
            // nothing, which would test the model rather than the path.
            const vp = new Mat4Ctor().mul2(scene.camera.camera.projectionMatrix, scene.camera.camera.viewMatrix).data;
            const world = splat.worldTransform.data;
            const px_ = splat.splatData.getProp('x');
            const py_ = splat.splatData.getProp('y');
            const pz_ = splat.splatData.getProp('z');
            const target = (() => {
                const { width, height } = scene.targetSize;
                const cx = width * 0.5;
                const cy = height * 0.5;
                let best = null;
                let bestDistance = Infinity;
                for (let i = 0; i < splat.splatData.numSplats; i++) {
                    const lx = px_[i], ly = py_[i], lz = pz_[i];
                    const wx = world[0] * lx + world[4] * ly + world[8] * lz + world[12];
                    const wy = world[1] * lx + world[5] * ly + world[9] * lz + world[13];
                    const wz = world[2] * lx + world[6] * ly + world[10] * lz + world[14];
                    const cw = vp[3] * wx + vp[7] * wy + vp[11] * wz + vp[15];
                    if (cw <= 0) continue;
                    const sx = ((vp[0] * wx + vp[4] * wy + vp[8] * wz + vp[12]) / cw * 0.5 + 0.5) * width;
                    const sy = (1 - ((vp[1] * wx + vp[5] * wy + vp[9] * wz + vp[13]) / cw * 0.5 + 0.5)) * height;
                    const distance = Math.hypot(sx - cx, sy - cy);
                    if (distance < bestDistance) {
                        bestDistance = distance;
                        best = { x: sx / width, y: sy / height };
                    }
                }
                return best;
            })();

            await selectNone();
            await events.invoke('select.point', 'set', target);
            const pointSet = await record('point / set');

            // 9. sphere volume (GPU intersect, unchanged)
            const t = new Mat4Ctor();
            t.setTRS(splat.entity.getPosition(), new QuatCtor(), new Vec3Ctor(0.8, 0.8, 0.8));
            await selectNone();
            events.fire('select.bySphere', 'set', t);
            const sphereSet = await record('sphere / set');

            // 10. box volume (GPU intersect, unchanged)
            const tb = new Mat4Ctor();
            tb.setTRS(splat.entity.getPosition(), new QuatCtor(), new Vec3Ctor(0.8, 0.8, 0.8));
            await selectNone();
            events.fire('select.byBox', 'set', tb);
            const boxSet = await record('box / set');

            // 11. sphere brush (batched depth picks + capsule intersect, unchanged)
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
            await selectNone();
            await events.invoke('select.bySphereBrush', 'set', points, brushCanvas);
            const brushSet = await record('sphere brush / set');

            // 12. the depth range API round-trips and clamps
            out.flags.defaultRange = JSON.stringify(events.invoke('selection.depthRange'));
            events.fire('selection.setDepthRange', { near: 30, far: 70 });
            await sleep(150);
            out.flags.setRange = JSON.stringify(events.invoke('selection.depthRange'));
            // near past far: the pair is kept ordered
            events.fire('selection.setDepthRange', { near: 80, far: 20 });
            await sleep(150);
            out.flags.crossedRange = JSON.stringify(events.invoke('selection.depthRange'));
            events.fire('selection.resetDepthRange');
            await sleep(150);
            out.flags.resetRange = JSON.stringify(events.invoke('selection.depthRange'));

            return out;
        });

        const byName = Object.fromEntries(result.steps.map(s => [s.name, s.selected]));
        const rectSet = byName['rect / set'];
        const rectAddSame = byName['rect / add (same region)'];
        const rectAddOther = byName['rect / add (disjoint region)'];
        const rectIntersect = byName['rect / intersect'];
        const rectRemove = byName['rect / remove'];
        const wideSet = byName['rect / set (wide)'];
        const leftSet = byName['rect / set (left half, replaces)'];

        const checks = [
            { name: 'rect set selects through the model', pass: rectSet > 0, detail: `${rectSet} splats` },
            {
                name: 'add over an already selected region is idempotent',
                pass: rectAddSame === rectSet,
                detail: `${rectSet} -> ${rectAddSame}`
            },
            {
                name: 'add over a disjoint region grows the selection',
                pass: rectAddOther > rectSet,
                detail: `${rectSet} -> ${rectAddOther}`
            },
            {
                name: 'intersect keeps only the overlap',
                pass: rectIntersect > 0 && rectIntersect <= rectAddOther,
                detail: `${rectAddOther} -> ${rectIntersect}`
            },
            {
                name: 'remove clears the region',
                pass: rectRemove === 0,
                detail: `${rectIntersect} -> ${rectRemove}`
            },
            {
                name: 'set replaces the selection (narrow after wide)',
                pass: wideSet > 0 && leftSet > 0 && leftSet < wideSet,
                detail: `wide ${wideSet} -> left half ${leftSet}`
            },
            { name: 'the mask stroke path selects', pass: byName['mask / set'] > 0, detail: `${byName['mask / set']} splats` },
            { name: 'the click path selects', pass: byName['point / set'] > 0, detail: `${byName['point / set']} splats` },
            { name: 'the sphere volume still selects', pass: byName['sphere / set'] > 0, detail: `${byName['sphere / set']} splats` },
            { name: 'the box volume still selects', pass: byName['box / set'] > 0, detail: `${byName['box / set']} splats` },
            { name: 'the sphere brush still selects', pass: byName['sphere brush / set'] > 0, detail: `${byName['sphere brush / set']} splats` },
            {
                name: 'the depth range round-trips, clamps and resets',
                pass: result.flags.defaultRange === '{"near":0,"far":100}' &&
                    result.flags.setRange === '{"near":30,"far":70}' &&
                    result.flags.crossedRange === '{"near":20,"far":80}' &&
                    result.flags.resetRange === '{"near":0,"far":100}',
                detail: JSON.stringify(result.flags)
            },
            { name: 'no console errors', pass: errors.length === 0, detail: errors.slice(0, 2).join(' | ') || 'clean' }
        ];

        console.log(JSON.stringify({
            url: URL,
            importedBytes: imported,
            backend: await page.evaluate(() => (window.scene.graphicsDevice.isWebGPU ? 'webgpu' : 'webgl2')),
            ...result,
            checks,
            failed: checks.filter(c => !c.pass).length,
            errors,
            warnings: warnings.slice(0, 20)
        }, null, 2));
        if (checks.some(c => !c.pass)) process.exitCode = 1;
    } catch (err) {
        console.log(JSON.stringify({ fatal: String(err).slice(0, 800), errors, warnings: warnings.slice(0, 20) }, null, 2));
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
