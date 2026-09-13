// Verify the screen-selection DEPTH THICKNESS (B): with "depth" on, a selection used to be exactly one
// layer thick (the id pick returns the front-most splat of a pixel). The settings panel's
// "Selection: depth thickness (% of model)" slider widens it into a slab along the view.
//
// The test model has a front wall at z = 0 and a back wall at z = -0.6, so a rectangle over both walls is a
// direct measurement: with thickness 0 only front-wall splats may be selected; with a thickness of a few
// percent of the model diagonal (the diagonal is ~2.4 for this model, so 5% is ~0.12 and 40% is far more
// than the 0.6 gap) back-wall splats must appear.
//
// usage: node docs/verify/verify-selection-depth-band.cjs "<url>" [model]
const puppeteer = require('C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const logs = [];
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
    });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1200, height: 800 });
        page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text().slice(0, 200)); });
        page.on('pageerror', e => logs.push('pageerror: ' + String(e).slice(0, 200)));
        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForFunction('!!window.scene', { timeout: 90000 });
        await sleep(1500);
        await page.evaluate(async (m) => {
            const buf = await (await fetch('./' + m)).arrayBuffer();
            await window.scene.events.invoke('import', [{ filename: m, contents: new File([buf], m) }]);
        }, MODEL);
        await sleep(4000);

        await page.evaluate(() => {
            const scene = window.scene;
            scene.events.fire('selection', scene.getElementsByType('splat').slice(-1)[0]);
        });
        await sleep(400);
        await page.evaluate(() => window.scene.events.fire('camera.focus'));
        await sleep(1200);

        // depth on: the front-most layer is what the depth method picks
        await page.evaluate(() => window.scene.events.fire('selection.setUseDepth', true));
        await sleep(300);

        const classify = () => page.evaluate(() => {
            const splat = window.scene.getElementsByType('splat').slice(-1)[0];
            const st = splat.splatData.getProp('state');
            const z = splat.splatData.getProp('z');
            let front = 0;
            let back = 0;
            let other = 0;
            for (let i = 0; i < st.length; i++) {
                if (!(st[i] & 1)) continue;
                if (z[i] > -0.3) {
                    front++;
                } else if (z[i] < -0.5) {
                    back++;
                } else {
                    other++;
                }
            }
            return { front, back, other, total: front + back + other };
        });

        const diagonal = await page.evaluate(() => {
            const b = window.scene.bound;
            return b ? Math.hypot(b.halfExtents.x, b.halfExtents.y, b.halfExtents.z) * 2 : null;
        });

        const runRect = async (thicknessPct) => {
            await page.evaluate((t) => {
                window.scene.events.fire('selection.setDepthThickness', t);
                window.scene.events.fire('select.none');
            }, thicknessPct);
            await sleep(500);
            const t0 = Date.now();
            await page.evaluate(() => window.scene.events.invoke('select.rect', 'set', {
                start: { x: 0.25, y: 0.25 },
                end: { x: 0.75, y: 0.75 }
            }));
            const ms = Date.now() - t0;
            const result = await classify();
            console.log(`thickness ${String(thicknessPct).padStart(4)}%: selected ${result.total} (front ${result.front}, back ${result.back}, between ${result.other}) in ${ms} ms`);
            return { ...result, ms };
        };

        const none = await runRect(0);
        const thin = await runRect(5);
        const deep = await runRect(40);

        const stored = await page.evaluate(() => window.scene.events.invoke('selection.depthThickness'));
        await page.evaluate(() => window.scene.events.fire('selection.setDepthThickness', 0));
        await page.evaluate(() => window.scene.events.fire('selection.setUseDepth', false));
        await sleep(300);
        const restored = await page.evaluate(() => window.scene.events.invoke('selection.depthThickness'));

        // Some pixels of the rectangle only ever show the far wall (the front wall does
        // not cover the whole rectangle), so those back-wall splats belong to the visible
        // layer in every case and form the baseline the comparisons are made against.
        const baseline = none.back;

        const checks = [
            {
                name: 'with no thickness the selection is still one visible layer',
                pass: none.front > 0 && baseline <= Math.max(5, none.front * 0.1),
                detail: `thickness 0 selected ${none.total} splats: ${none.front} on the front wall and ${baseline} behind it (pixels where only the far wall has cover)`
            },
            {
                name: 'a small thickness does not reach the wall behind the visible surface',
                pass: thin.back < deep.back * 0.2,
                detail: `thickness 5% of the ${diagonal ? diagonal.toFixed(2) : '?'} diagonal (= ${(diagonal * 0.05).toFixed(2)} units, against a 0.6 gap): ${thin.front} front, ${thin.back} behind it, against ${deep.back} for a 40% thickness`
            },
            {
                name: 'a large thickness reaches the wall behind the visible surface',
                pass: deep.back > Math.max(thin.back * 5, 50) && deep.front > 0,
                detail: `thickness 40% (= ${(diagonal * 0.4).toFixed(2)} units): ${deep.front} front-wall splats and ${deep.back} behind the wall (5%: ${thin.back}, no thickness: ${baseline})`
            },
            {
                name: 'the thickness slider round-trips and the default stays 0',
                pass: stored === 40 && restored === 0,
                detail: `value read back ${stored}, after resetting ${restored}`
            },
            {
                name: 'the band pass stays interactive on a small model',
                pass: deep.ms < 3000,
                detail: `rect selection with thickness 40% took ${deep.ms} ms (front ${none.ms} ms, small ${thin.ms} ms)`
            },
            {
                name: 'no console errors',
                pass: logs.length === 0,
                detail: logs.length ? JSON.stringify(logs.slice(0, 3)) : 'clean'
            }
        ];

        console.log(JSON.stringify({
            url: URL,
            backend: await page.evaluate(() => (window.scene.graphicsDevice.isWebGPU ? 'webgpu' : 'webgl2')),
            diagonal,
            none,
            thin,
            deep,
            checks,
            failed: checks.filter(c => !c.pass).length,
            logs
        }, null, 2));
        if (checks.some(c => !c.pass)) process.exitCode = 1;
    } catch (e) {
        console.log(JSON.stringify({ fatal: String(e).slice(0, 400), logs }, null, 2));
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
