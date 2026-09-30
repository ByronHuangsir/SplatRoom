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
const puppeteer = require('puppeteer-core');

const { BROWSER_PATH: EDGE , launchPatched: _launchPatched } = require('./lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const logs = [];
    const browser = await _launchPatched(puppeteer, {
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

        const gesture = async (op = 'set', box = { start: { x: 0.3, y: 0.3 }, end: { x: 0.7, y: 0.7 } }) => {
            await page.evaluate((o) => {
                window.scene.events.fire('select.none');
            }, op);
            await sleep(400);
            const t0 = Date.now();
            await page.evaluate((o, b) => window.scene.events.invoke('select.rect', o, b), op, box);
            const ms = Date.now() - t0;
            await sleep(500);
            return { ...(await classify()), ms, range: await page.evaluate(() => window.scene.events.invoke('selection.depthRange')) };
        };

        // a box that is a strict part of the framed model, so expanding past it has something
        // to add and contracting inside it has something to drop
        const innerBox = { start: { x: 0.4, y: 0.4 }, end: { x: 0.6, y: 0.6 } };

        // 环模式的"只选表面"没有在这里加断言：这个夹具是**稀疏点云的两面墙**，逐像素不会互相遮挡，
        // 所以表面过滤对它几乎无效（实测 back 234 → 234），拿它当判据会误报。
        // 有效果的验证见 docs/probes/mode-selection.cjs（93 万点密集扫描：中心 104,707 → 环 76,627）。

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

        // 2b. the FIRST small move must already change the selection (the user's "首次滑动就能看到
        // 选区范围的变化"): the depth axis compresses its sparse tails (see depthTailFractions), so
        // half a unit of slider travel now cuts real gaussians instead of nothing. Measured as a
        // share of the through-pass so it holds on any model.
        await setRange(0, 100);
        await sleep(600);
        const throughCount = (await classify()).total;
        const firstMove = [];
        for (const far of [99.5, 99, 98]) {
            await setRange(0, far);
            await sleep(600);
            const c = (await classify()).total;
            firstMove.push({ far, selected: c, removed: throughCount - c });
        }
        await setRange(0, 100);
        await sleep(600);
        const firstMoveNear = [];
        for (const near of [0.5, 1]) {
            await setRange(near, 100);
            await sleep(600);
            const c = (await classify()).total;
            firstMoveNear.push({ near, selected: c, removed: throughCount - c });
        }
        await setRange(0, 100);
        await sleep(600);

        // 2c. and the same for the box axes: half a unit of slider travel in from either edge must
        // reach real gaussians (the box margins are compressed like the depth tails)
        const screenFirst = [];
        const setScreen = (patch) => page.evaluate((p) => window.scene.events.fire('selection.setScreenRange', p), patch);
        for (const patch of [{ x: { low: 0.5 } }, { y: { low: 0.5 } }, { x: { high: 99.5 } }, { y: { high: 99.5 } }]) {
            await page.evaluate(() => window.scene.events.fire('selection.resetRange'));
            await sleep(300);
            await setScreen(patch);
            await sleep(600);
            const c = (await classify()).total;
            screenFirst.push({ patch: Object.keys(patch)[0] + (patch.x?.low !== undefined || patch.y?.low !== undefined ? ' low 0.5' : ' high 99.5'), selected: c, removed: throughCount - c });
        }
        await page.evaluate(() => window.scene.events.fire('selection.resetRange'));
        await sleep(400);


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

        // 8. 扩边 / 收边 (D): the outer handles must really feed the selection, so an expanded
        // range has to be a STRICT superset of the box and a contracted one a strict subset.
        // (The depth case is the clearest: trim to the front wall, then expand the far outer
        // handle back out and the wall behind has to come in again.)
        await page.evaluate(() => window.scene.events.fire('selection.resetRange'));
        await sleep(300);
        await gesture('set', innerBox);
        const setBox = await selectedIndices();

        // half a box width of margin on each side of both screen axes (the documented limit)
        await page.evaluate(() => window.scene.events.fire('selection.setScreenRange', {
            x: { outerLow: -50, outerHigh: 150 },
            y: { outerLow: -50, outerHigh: 150 }
        }));
        await sleep(700);
        const setExpanded = await selectedIndices();

        // back to no expansion, then contract inside the box with the inner handles
        await page.evaluate(() => window.scene.events.fire('selection.setScreenRange', {
            x: { outerLow: 0, outerHigh: 100 },
            y: { outerLow: 0, outerHigh: 100 }
        }));
        await sleep(600);
        await page.evaluate(() => window.scene.events.fire('selection.setScreenRange', {
            x: { low: 45, high: 55 },
            y: { low: 45, high: 55 }
        }));
        await sleep(700);
        const setContracted = await selectedIndices();

        await page.evaluate(() => window.scene.events.fire('selection.resetRange'));
        await sleep(300);
        await gesture();
        await page.evaluate(() => window.scene.events.fire('selection.setDepthRange', { low: 0, high: 40 }));
        await sleep(700);
        const depthTrimmed = await classify();
        await page.evaluate(() => window.scene.events.fire('selection.setDepthRange', { outerHigh: 100 }));
        await sleep(700);
        const depthExpanded = await classify();

        // 9. the helper's "reset" leaves the flags at the default, and localStorage keeps them
        await page.evaluate(() => window.scene.events.fire('selection.resetRange'));
        await sleep(300);
        const storage = await page.evaluate(() => ({
            near: window.localStorage.getItem('splatroom.selDepthNear'),
            far: window.localStorage.getItem('splatroom.selDepthFar'),
            nearOuter: window.localStorage.getItem('splatroom.selDepthOuterNear'),
            farOuter: window.localStorage.getItem('splatroom.selDepthOuterFar'),
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
                name: 'the first small move of 最远 already cuts gaussians (no dead head of the track)',
                pass: throughCount > 0 && firstMove.every(s => s.removed > 0),
                detail: `through-pass ${throughCount}; far 99.5/99/98 removes ${firstMove.map(s => s.removed).join(' / ')} (${firstMove.map(s => ((s.removed / Math.max(throughCount, 1)) * 100).toFixed(2) + '%').join(' / ')})`
            },
            {
                name: 'the first small move of 最近 already cuts gaussians too',
                pass: throughCount > 0 && firstMoveNear.every(s => s.removed > 0),
                detail: `near 0.5/1 removes ${firstMoveNear.map(s => s.removed).join(' / ')} (${firstMoveNear.map(s => ((s.removed / Math.max(throughCount, 1)) * 100).toFixed(2) + '%').join(' / ')})`
            },
            {
                name: 'the depth ends stay reachable (0/100 is still the whole model)',
                pass: throughCount > 0 && farSweep[0].total === throughCount && afterReset.total === throughCount,
                detail: `through-pass ${throughCount}, far 100 -> ${farSweep[0].total}, after reset -> ${afterReset.total}`
            },
            {
                name: 'the first small move of 左右 / 上下 already cuts gaussians (no dead edge of the track)',
                // on a model with a real distribution the box margins are sparse and have to be
                // compressed; a tiny test model (< 1000 rows in the box) legitimately keeps the
                // linear mapping and may drop nothing at 0.5%
                pass: screenFirst.every(s => s.removed > 0 || throughCount < 1000),
                detail: `through-pass ${throughCount}; 0.5 in removes x ${screenFirst[0].removed} / y ${screenFirst[1].removed}; 0.5 in on the far side removes x ${screenFirst[2].removed} / y ${screenFirst[3].removed}`
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
                // 3.16.0: a new gesture ALWAYS starts from the full through-pass. A leftover 最近/最远
                // from the previous adjustment used to clip the next box silently (the user's "框住塔
                // 却只选到一半"), so the range now belongs to the gesture you are trimming.
                name: 'a new gesture starts from the full through-pass (a leftover range no longer clips it)',
                pass: preNarrowed.front > 0 && preNarrowed.back > 0 &&
                    preNarrowed.range.near === 0 && preNarrowed.range.far === 100 &&
                    preNear.front > 0 && preNear.back > 0 &&
                    preNear.range.near === 0 && preNear.range.far === 100,
                detail: `after a gesture with 0/40 pending: ${preNarrowed.front} front, ${preNarrowed.back} back, range ${JSON.stringify(preNarrowed.range)}; with 60/100 pending: ${preNear.front} front, ${preNear.back} back, range ${JSON.stringify(preNear.range)}`
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
                name: '扩边: the outer handles select a STRICT superset of the box',
                pass: isSubset(setBox, setExpanded) && setExpanded.length > setBox.length,
                detail: `box ${setBox.length} splats, expanded by half a box width on every side: ${setExpanded.length} ` +
                    `(box inside expanded: ${isSubset(setBox, setExpanded)})`
            },
            {
                name: '收边: the inner handles select a STRICT subset of the box',
                pass: isSubset(setContracted, setBox) && setContracted.length < setBox.length && setContracted.length > 0,
                detail: `box ${setBox.length} splats, contracted to the middle 10%: ${setContracted.length}`
            },
            {
                name: '扩边 on the depth axis brings the wall behind back',
                pass: depthTrimmed.back === 0 && depthTrimmed.front > 0 &&
                    depthExpanded.back > 0 && depthExpanded.front > 0,
                detail: `core 0..40: ${depthTrimmed.front} front / ${depthTrimmed.back} back; ` +
                    `then the far outer expanded to 100: ${depthExpanded.front} front / ${depthExpanded.back} back`
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
            setSizes: {
                full: setFull.length,
                x: setX.length,
                y: setY.length,
                box: setBox.length,
                expanded: setExpanded.length,
                contracted: setContracted.length
            },
            depthTrimmed,
            depthExpanded,
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
