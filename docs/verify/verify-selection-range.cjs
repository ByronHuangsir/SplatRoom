// Verify the screen selection DEPTH RANGE ("选区深度" 最近 / 最远).
//
// The model has a front wall at z = 0 and a back wall at z = -0.6, so a rectangle over both is a
// direct measurement: with the default range (0 / 100) a screen gesture must select through the
// WHOLE model (both walls), and narrowing 最近 / 最远 must carve the slab the user asks for.
//
// Everything here runs against the live selection: the sweeps below only fire
// `selection.setDepthRange` after ONE gesture, which is exactly the interaction being ported
// (select in the front view, orbit to the side, drag the two sliders).
//
// usage: node docs/verify/verify-selection-range.cjs "<url>" [model]
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
        // a front view puts the two walls at different depths along the view axis
        await page.evaluate(() => window.scene.events.fire('camera.focus'));
        await sleep(1200);
        await page.evaluate(() => window.scene.events.fire('camera.viewFront'));
        await sleep(1200);

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

        const setRange = (near, far) => page.evaluate((n, f) => {
            window.scene.events.fire('selection.setDepthRange', { near: n, far: f });
        }, near, far);

        const gesture = async (op = 'set') => {
            await page.evaluate((o) => {
                window.scene.events.fire('select.none');
            }, op);
            await sleep(400);
            const t0 = Date.now();
            await page.evaluate((o) => window.scene.events.invoke('select.rect', o, {
                start: { x: 0.3, y: 0.3 },
                end: { x: 0.7, y: 0.7 }
            }), op);
            const ms = Date.now() - t0;
            await sleep(500);
            return { ...(await classify()), ms };
        };

        // range at the default before anything else happens
        const defaults = await page.evaluate(() => window.scene.events.invoke('selection.depthRange'));

        // 1. default range: full through-pass
        const through = await gesture();

        // 2. live narrowing of 最远 on the SAME selection (no new gesture). The model is two
        // discrete walls, so the count only drops when the cut crosses the far wall's own
        // depth - the check is therefore "monotone, ends empty, and does drop somewhere"
        // rather than a specific value per step.
        const farSweep = [];
        for (const far of [100, 90, 80, 60, 40, 0]) {
            await setRange(0, far);
            await sleep(600);
            farSweep.push({ far, ...(await classify()) });
        }

        // 3. live narrowing of 最近 with 最远 back at 100
        const nearSweep = [];
        for (const near of [0, 20, 40, 60, 80]) {
            await setRange(near, 100);
            await sleep(600);
            nearSweep.push({ near, ...(await classify()) });
        }

        // 4. reset restores the full through-pass
        await page.evaluate(() => window.scene.events.fire('selection.resetDepthRange'));
        await sleep(700);
        const afterReset = { ...(await classify()), range: await page.evaluate(() => window.scene.events.invoke('selection.depthRange')) };

        // 5. a range set BEFORE the gesture applies to it (persisted across gestures)
        await setRange(0, 40);
        await sleep(200);
        const preNarrowed = await gesture();

        // 6. and the same for the near side
        await setRange(60, 100);
        await sleep(200);
        const preNear = await gesture();

        // 7. the two screen axes (左右 / 上下) trim the same gesture live. The sets are
        // compared by index so "the window really is a subset of the box" is checked, not
        // just the counts.
        const selectedIndices = () => page.evaluate(() => {
            const splat = window.scene.getElementsByType('splat').slice(-1)[0];
            const st = splat.splatData.getProp('state');
            const out = [];
            for (let i = 0; i < st.length; i++) {
                if (st[i] & 1) out.push(i);
            }
            return out;
        });

        await page.evaluate(() => window.scene.events.fire('selection.resetRange'));
        await sleep(300);
        const screenFull = await gesture();
        const setFull = await selectedIndices();

        await page.evaluate(() => window.scene.events.fire('selection.setScreenRange', { x: { low: 30, high: 70 } }));
        await sleep(700);
        const screenX = await classify();
        const setX = await selectedIndices();

        await page.evaluate(() => window.scene.events.fire('selection.setScreenRange', {
            x: { low: 0, high: 100 },
            y: { low: 30, high: 70 }
        }));
        await sleep(700);
        const screenY = await classify();
        const setY = await selectedIndices();

        await page.evaluate(() => window.scene.events.fire('selection.setScreenRange', {
            y: { low: 0, high: 100 }
        }));
        await sleep(700);
        const screenBack = await classify();

        // 8. the helper's "reset" leaves the depth flag at the default, and localStorage keeps it
        await page.evaluate(() => window.scene.events.fire('selection.resetRange'));
        await sleep(300);
        const storage = await page.evaluate(() => ({
            near: window.localStorage.getItem('splatroom.selDepthNear'),
            far: window.localStorage.getItem('splatroom.selDepthFar'),
            left: window.localStorage.getItem('splatroom.selRangeLeft'),
            right: window.localStorage.getItem('splatroom.selRangeRight'),
            top: window.localStorage.getItem('splatroom.selRangeTop'),
            bottom: window.localStorage.getItem('splatroom.selRangeBottom')
        }));

        const backAt = (list, key) => list.map(s => s.back);
        const frontAt = (list, key) => list.map(s => s.front);
        const monotonicDown = (list) => list.every((v, i) => i === 0 || v <= list[i - 1]);
        const farBacks = backAt(farSweep);
        const farFronts = frontAt(farSweep);
        const nearFronts = frontAt(nearSweep);
        const nearBacks = backAt(nearSweep);

        // subset test: every index in `inner` must be in `outer`
        const isSubset = (inner, outer) => {
            const set = new Set(outer);
            return inner.every(i => set.has(i));
        };

        const checks = [
            {
                name: 'the default range is 0 / 100 (full through-pass)',
                pass: defaults.near === 0 && defaults.far === 100,
                detail: JSON.stringify(defaults)
            },
            {
                name: 'a screen gesture selects through the whole model by default',
                pass: through.front > 0 && through.back > 0,
                detail: `rect over both walls selected ${through.total} splats: ${through.front} on the front wall, ${through.back} behind it`
            },
            {
                name: 'dragging 最远 in cuts the far side monotonically',
                pass: monotonicDown(farBacks) && farBacks[0] > 0 && farBacks[farBacks.length - 1] === 0 &&
                    farBacks.some((v, i) => i > 0 && v < farBacks[i - 1]),
                detail: `far 100/90/80/60/40/0 -> back ${farBacks.join(', ')}`
            },
            {
                name: 'the near wall survives the whole far sweep',
                pass: farFronts.every(v => v > 0),
                detail: `front ${farFronts.join(', ')} at far 100/90/80/60/40/0`
            },
            {
                name: 'dragging 最近 in cuts the near side monotonically',
                pass: monotonicDown(nearFronts) && nearFronts[0] > 0 &&
                    nearFronts.some((v, i) => i > 0 && v < nearFronts[i - 1]),
                detail: `near 0/20/40/60/80 -> front ${nearFronts.join(', ')}`
            },
            {
                name: 'the far wall stays out while 最远 is at 100 and 最近 moves',
                pass: nearBacks.every(v => v > 0),
                detail: `back ${nearBacks.join(', ')}`
            },
            {
                name: 'reset restores the full through-pass',
                pass: afterReset.range.near === 0 && afterReset.range.far === 100 && afterReset.front > 0 && afterReset.back > 0,
                detail: `range ${JSON.stringify(afterReset.range)}, ${afterReset.front} front / ${afterReset.back} back`
            },
            {
                name: 'a pre-set range applies to the next gesture (far side cut)',
                pass: preNarrowed.front > 0 && preNarrowed.back === 0,
                detail: `range 0/40 before the gesture: ${preNarrowed.front} front, ${preNarrowed.back} back`
            },
            {
                name: 'a pre-set range applies to the next gesture (near side cut)',
                pass: preNear.back > 0 && preNear.front === 0,
                detail: `range 60/100 before the gesture: ${preNear.front} front, ${preNear.back} back`
            },
            {
                name: 'the range persists in localStorage',
                pass: storage.near === '0' && storage.far === '100',
                detail: JSON.stringify(storage)
            },
            {
                name: 'the 左右 range trims the box (a strict subset of the full box)',
                pass: setX.length > 0 && setX.length < setFull.length && isSubset(setX, setFull),
                detail: `x 30-70%: ${setX.length} of ${setFull.length} splats, subset ${isSubset(setX, setFull)} (${screenX.total} counted)`
            },
            {
                name: 'the 左右 range keeps roughly its share of the box',
                pass: setX.length / setFull.length > 0.15 && setX.length / setFull.length < 0.6,
                detail: `a 40% wide band kept ${(setX.length / setFull.length * 100).toFixed(1)}% of the splats`
            },
            {
                name: 'the 上下 range trims the box (a strict subset of the full box)',
                pass: setY.length > 0 && setY.length < setFull.length && isSubset(setY, setFull),
                detail: `y 30-70%: ${setY.length} of ${setFull.length} splats, subset ${isSubset(setY, setFull)} (${screenY.total} counted)`
            },
            {
                name: 'the 上下 range keeps roughly its share of the box',
                pass: setY.length / setFull.length > 0.15 && setY.length / setFull.length < 0.6,
                detail: `a 40% high band kept ${(setY.length / setFull.length * 100).toFixed(1)}% of the splats`
            },
            {
                name: 'widening the screen range back restores the full box',
                pass: screenBack.total === screenFull.total,
                detail: `${screenFull.total} -> ${screenY.total} -> ${screenBack.total}`
            },
            {
                name: 'the range pass stays interactive on a small model',
                pass: through.ms < 3000,
                detail: `rect selection took ${through.ms} ms`
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
            defaults,
            through,
            farSweep,
            nearSweep,
            afterReset,
            preNarrowed,
            preNear,
            screenFull,
            screenX,
            screenY,
            screenBack,
            setSizes: { full: setFull.length, x: setX.length, y: setY.length },
            storage,
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
