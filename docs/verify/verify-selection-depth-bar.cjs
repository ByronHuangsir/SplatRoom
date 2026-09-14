// Verify the 选区范围 panel against the design (`选择范围设计.png`): one thin rail per axis with a
// rectangular labelled block at each end, the selection band between the two inner edges, and a
// NON-LINEAR track mapping (fine near the centre, fast near the ends).
//
// Grips are driven with real mouse input (page.mouse) because the control captures the pointer.
//
// usage: node docs/verify/verify-selection-depth-bar.cjs "<url>" [model]
const puppeteer = require('C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const BAR = '#selection-range-bar';
// the mapping the widget is specified to use (t = fraction along the track, values -50..150)
const FISHEYE = 0.35;
const valueOfFraction = (t) => {
    const s = 2 * t - 1;
    return -50 + 200 * (0.5 + 0.5 * s * (FISHEYE + (1 - FISHEYE) * s * s));
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
        await page.setViewport({ width: 1400, height: 900 });
        page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text().slice(0, 200)); });
        page.on('pageerror', e => logs.push('pageerror: ' + String(e).slice(0, 200)));
        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForFunction('!!window.scene', { timeout: 90000 });
        await sleep(1500);
        await page.evaluate(async (m) => {
            const buf = await (await fetch('./' + m)).arrayBuffer();
            await window.scene.events.invoke('import', [{ filename: m, contents: new File([buf], m) }]);
        }, MODEL);
        await sleep(3500);

        const barState = () => page.evaluate((selector) => {
            const bar = document.querySelector(selector);
            if (!bar) {
                return { exists: false };
            }
            const rows = Array.from(bar.querySelectorAll('.select-range-row'));
            const title = bar.querySelector('.select-toolbar-label');
            return {
                exists: true,
                visible: !bar.classList.contains('pcui-hidden'),
                size: [Math.round(bar.getBoundingClientRect().width), Math.round(bar.getBoundingClientRect().height)],
                axes: rows.map(r => r.getAttribute('data-axis')),
                blocks: rows.map(r => r.querySelectorAll('.select-range-block').length),
                grips: rows.map(r => r.querySelectorAll('.select-range-handle').length),
                numericFields: rows.map(r => r.querySelectorAll('.select-range-value, .pcui-numeric-input').length),
                labels: rows.map(r => Array.from(r.querySelectorAll('.select-range-label')).map(l => l.textContent)),
                layout: rows.map((r) => {
                    const track = r.querySelector('.select-range-track').getBoundingClientRect();
                    const box = (el) => {
                        const b = el.getBoundingClientRect();
                        return [Math.round(b.left - track.left), Math.round(b.width)];
                    };
                    const blocks = Array.from(r.querySelectorAll('.select-range-block')).map(b => ({
                        side: b.getAttribute('data-block'),
                        box: box(b),
                        labelInside: !!b.querySelector('.select-range-label')
                    }));
                    const grips = {};
                    for (const h of r.querySelectorAll('.select-range-handle')) {
                        grips[h.getAttribute('data-handle')] = box(h);
                    }
                    return {
                        axis: r.getAttribute('data-axis'),
                        track: Math.round(track.width),
                        blocks,
                        grips,
                        core: box(r.querySelector('.select-range-core')),
                        margins: Array.from(r.querySelectorAll('.select-range-margin')).map(m => ({
                            box: box(m),
                            visible: getComputedStyle(m).visibility === 'visible'
                        }))
                    };
                }),
                reset: !!bar.querySelector('.select-toolbar-button'),
                title: title ? title.textContent : null,
                active: !!title && title.classList.contains('active')
            };
        }, BAR);

        const ranges = () => page.evaluate(() => ({
            depth: window.scene.events.invoke('selection.depthRange'),
            screen: window.scene.events.invoke('selection.screenRange')
        }));

        const activate = async (tool) => {
            await page.evaluate(() => window.scene.events.fire('tool.deactivate'));
            await sleep(250);
            await page.evaluate((t) => window.scene.events.fire(`tool.${t}`), tool);
            await sleep(600);
            return barState();
        };

        const results = {};
        for (const tool of ['rectSelection', 'lassoSelection', 'polygonSelection', 'brushSelection', 'floodSelection', 'sphereBrushSelection', 'sphereSelection', 'boxSelection']) {
            results[tool] = await activate(tool);
        }

        const rect = await activate('rectSelection');
        const before = await ranges();

        // the panel has no numeric fields, so state is set through the API
        const setRange = (patch) => page.evaluate((p) => {
            if (p.depth) {
                window.scene.events.fire('selection.setDepthRange', p.depth);
            }
            if (p.x || p.y) {
                window.scene.events.fire('selection.setScreenRange', { x: p.x, y: p.y });
            }
        }, patch);

        // drag a grip N pixels along its axis, starting at the grip's own centre
        const dragGripPixels = async (axis, handle, pixels) => {
            const geometry = await page.evaluate((selector, a, h) => {
                const track = document.querySelector(`${selector} .select-range-row[data-axis="${a}"] .select-range-track`);
                const el = track.querySelector(`.select-range-handle[data-handle="${h}"]`);
                const t = track.getBoundingClientRect();
                const b = el.getBoundingClientRect();
                return { fromX: b.left + b.width / 2, y: t.top + t.height / 2 };
            }, BAR, axis, handle);
            await page.mouse.move(geometry.fromX, geometry.y);
            await page.mouse.down();
            await page.mouse.move(geometry.fromX + pixels, geometry.y, { steps: 8 });
            await page.mouse.up();
            await sleep(200);
        };

        // --- the adaptive scale: the closer the two blocks get, the finer the adjustment, and the
        // pixel gap between them never collapses (that is "留够操作的空间") ---
        await setRange({ x: { low: 0, high: 100, outerLow: 0, outerHigh: 100 } });
        await sleep(350);
        const wideGap = (await barState()).layout[1].core[1];
        const wideBefore = (await ranges()).screen.x.low;
        await dragGripPixels('x', 'low', 20);
        const wideAfter = (await ranges()).screen.x.low;
        const wideDelta = wideAfter - wideBefore;

        await setRange({ x: { low: 49, high: 51, outerLow: 49, outerHigh: 51 } });
        await sleep(350);
        const narrowState = await barState();
        const narrowGap = narrowState.layout[1].core[1];
        const narrowBlockWidth = narrowState.layout[1].blocks.find(b => b.side === 'low').box[1];
        const narrowBefore = (await ranges()).screen.x.low;
        await dragGripPixels('x', 'low', 20);
        const narrowAfter = (await ranges()).screen.x.low;
        const narrowDelta = narrowAfter - narrowBefore;

        // an extremely thin slab still has a comfortable gap
        await setRange({ x: { low: 49.9, high: 50.1, outerLow: 49.9, outerHigh: 50.1 } });
        await sleep(350);
        const thinState = await barState();
        const thinGap = thinState.layout[1].core[1];
        const thinBlockWidth = thinState.layout[1].blocks.find(b => b.side === 'low').box[1];

        // the finest legal thickness (one STEP) must still get the whole track/ZOOM gap, so the
        // invariant reads: no matter how thin the slab gets, the two blocks keep the same room
        await setRange({ x: { low: 50, high: 50.1, outerLow: 50, outerHigh: 50.1 } });
        await sleep(350);
        const finestState = await barState();
        const finestGap = finestState.layout[1].core[1];

        // and the drag really is finer the thinner the slab: how much does a fixed 40px buy?
        const stepTravel = async (low, high) => {
            await setRange({ x: { low, high, outerLow: low, outerHigh: high } });
            await sleep(350);
            const before = (await ranges()).screen.x.low;
            await dragGripPixels('x', 'low', 40);
            const now = (await ranges()).screen.x.low;
            return { steps: +((now - before) / 0.1).toFixed(2) };
        };
        const stepTravelThick = await stepTravel(30, 70);
        const stepTravelThin = await stepTravel(49.9, 50.1);

        // --- structure / interaction ---
        await page.evaluate(() => window.scene.events.fire('selection.resetRange'));
        await sleep(300);
        const reset = await ranges();
        const resetBar = await barState();

        // 收边 with the inner grip: the block keeps its width, the selection band shrinks
        await dragGripPixels('x', 'low', 60);
        const afterTrim = await ranges();
        const afterTrimBar = await barState();

        // 扩边 with the outer grip: the block itself widens
        await page.evaluate(() => window.scene.events.fire('selection.resetRange'));
        await sleep(250);
        await dragGripPixels('x', 'outerLow', -80);
        const afterExpand = await ranges();
        const afterExpandBar = await barState();

        await dragGripPixels('depth', 'high', -60);
        const afterDepth = await ranges();
        const activeAfterDrag = (await barState()).active;

        await page.evaluate((selector) => document.querySelector(`${selector} .select-toolbar-button`).click(), BAR);
        await sleep(400);
        const afterReset = await ranges();
        const afterResetBar = await barState();

        await page.evaluate(() => window.scene.events.fire('tool.deactivate'));
        await sleep(300);
        const afterDeactivate = await barState();

        const screenTools = ['rectSelection', 'lassoSelection', 'polygonSelection', 'brushSelection', 'floodSelection'];
        const others = ['sphereBrushSelection', 'sphereSelection', 'boxSelection'];
        const near = (a, b, tol) => Math.abs(a - b) <= tol;
        const rows = resetBar.layout;
        const full = (axis) => axis.low === 0 && axis.high === 100 && axis.outerLow === 0 && axis.outerHigh === 100;
        const blockOf = (state, side) => state.layout[1].blocks.find(b => b.side === side);

        const checks = [
            {
                name: 'the range panel appears for every screen-space selection tool',
                pass: screenTools.every(t => results[t].visible),
                detail: screenTools.map(t => `${t}: ${results[t].visible ? `visible ${results[t].size.join('x')}` : 'hidden'}`).join(', ')
            },
            {
                name: 'the panel stays hidden for the volume / brush tools',
                pass: others.every(t => !results[t].visible),
                detail: others.map(t => `${t}: ${results[t].visible ? 'visible' : 'hidden'}`).join(', ')
            },
            {
                name: 'the panel is long: a 440px track per axis',
                pass: rows.every(r => r.track === 440),
                detail: rows.map(r => `${r.axis}: ${r.track}px`).join(', ')
            },
            {
                name: 'each axis is a rail with a labelled block at both ends',
                pass: JSON.stringify(rect.axes) === '["depth","x","y"]' && rect.blocks.every(n => n === 2) &&
                    rect.grips.every(n => n === 4) && rows.every(r => r.blocks.every(b => b.labelInside)),
                detail: `axes ${JSON.stringify(rect.axes)}, blocks ${JSON.stringify(rect.blocks)}, grips ${JSON.stringify(rect.grips)}, label inside every block ${rows.every(r => r.blocks.every(b => b.labelInside))}`
            },
            {
                name: 'the blocks are fixed-size handles centred on their bounds, band between them',
                pass: rows.every((r) => {
                    const low = r.blocks.find(b => b.side === 'low');
                    const high = r.blocks.find(b => b.side === 'high');
                    const lowCentre = low.box[0] + low.box[1] / 2;
                    const highCentre = high.box[0] + high.box[1] / 2;
                    return low.box[1] === high.box[1] && highCentre > lowCentre &&
                        near(r.core[0], lowCentre, 2) && near(r.core[1], highCentre - lowCentre, 2);
                }),
                detail: rows.map((r) => {
                    const low = r.blocks.find(b => b.side === 'low');
                    const high = r.blocks.find(b => b.side === 'high');
                    return `${r.axis}: low ${low.box.join('+')}, core ${r.core.join('+')}, high ${high.box.join('+')}`;
                }).join(' | ')
            },
            {
                name: 'the axis labels are localised and a reset button is there',
                pass: JSON.stringify(rect.labels) === '[["最近","最远"],["左","右"],["上","下"]]' &&
                    rect.reset === true && rect.title === '选区范围',
                detail: `labels ${JSON.stringify(rect.labels)}, title ${JSON.stringify(rect.title)}, reset ${rect.reset}`
            },
            {
                name: 'no numeric fields inside a row',
                pass: rect.numericFields.every(n => n === 0),
                detail: `numeric inputs per row ${JSON.stringify(rect.numericFields)}`
            },
            {
                name: 'the scale adapts: the closer the blocks, the finer the same 20px drag',
                pass: wideDelta > 5 && narrowDelta > 0 && narrowDelta < wideDelta * 0.5 &&
                    wideGap > 150 && narrowGap >= 120 && thinGap >= 120 && finestGap >= 120,
                detail: `20px drag moves the bound by ${wideDelta.toFixed(1)} with a 100-wide core, ` +
                    `${narrowDelta.toFixed(1)} with a 2-wide core (${(wideDelta / Math.max(narrowDelta, 0.01)).toFixed(1)}x finer); ` +
                    `core gap ${wideGap}px -> ${narrowGap}px -> ${thinGap}px -> ${finestGap}px (0.1-wide core)`
            },
            {
                name: 'the thinner the slab, the fewer 0.1 steps a fixed 40px drag buys',
                pass: stepTravelThick && stepTravelThin && stepTravelThick.steps > 20 &&
                    stepTravelThin.steps > 0 && stepTravelThin.steps < stepTravelThick.steps / 10,
                detail: `40px of drag = ${stepTravelThick ? stepTravelThick.steps : '?'} x 0.1 with a 40-wide core ` +
                    `vs ${stepTravelThin ? stepTravelThin.steps : '?'} x 0.1 with a 0.2-wide core ` +
                    `(${stepTravelThick && stepTravelThin ? (stepTravelThick.steps / stepTravelThin.steps).toFixed(0) : '?'}x finer)`
            },
            {
                name: 'all three axes start at the full through-pass with no expansion',
                pass: reset.depth.near === 0 && reset.depth.far === 100 &&
                    reset.depth.nearOuter === 0 && reset.depth.farOuter === 100 &&
                    full(reset.screen.x) && full(reset.screen.y),
                detail: JSON.stringify(reset)
            },
            {
                name: 'dragging the block trims the selection and keeps the block size',
                pass: afterTrim.screen.x.low > 0 && afterTrim.screen.x.outerLow === afterTrim.screen.x.low &&
                    blockOf(afterTrimBar, 'low').box[1] === blockOf(resetBar, 'low').box[1] &&
                    blockOf(afterTrimBar, 'low').box[1] === narrowBlockWidth && thinBlockWidth === narrowBlockWidth,
                detail: `x ${JSON.stringify(afterTrim.screen.x)}; block width ${blockOf(resetBar, 'low').box[1]} -> ${blockOf(afterTrimBar, 'low').box[1]}`
            },
            {
                name: '扩边 shows up as a band on the rail, NOT by resizing the block',
                pass: afterExpand.screen.x.outerLow < 0 &&
                    afterExpandBar.layout[1].margins[0].visible && afterExpandBar.layout[1].margins[0].box[1] > 20 &&
                    blockOf(afterExpandBar, 'low').box[1] === blockOf(resetBar, 'low').box[1],
                detail: `x ${JSON.stringify(afterExpand.screen.x)}; low margin band ${JSON.stringify(afterExpandBar.layout[1].margins[0])}; block width ${blockOf(resetBar, 'low').box[1]} -> ${blockOf(afterExpandBar, 'low').box[1]} (unchanged)`
            },
            {
                name: 'dragging the 最远 inner grip trims the far depth bound',
                pass: afterDepth.depth.far < 100 && afterDepth.depth.far > 0 &&
                    afterDepth.depth.farOuter === afterDepth.depth.far && afterDepth.depth.near === 0,
                detail: `depth ${JSON.stringify(afterDepth.depth)}`
            },
            {
                name: 'the title highlights once any axis is narrowed',
                pass: activeAfterDrag === true,
                detail: `title active ${activeAfterDrag}`
            },
            {
                name: 'reset restores all twelve bounds and drops the highlight',
                pass: full(afterReset.screen.x) && full(afterReset.screen.y) &&
                    afterReset.depth.near === 0 && afterReset.depth.far === 100 &&
                    afterReset.depth.nearOuter === 0 && afterReset.depth.farOuter === 100 &&
                    !afterResetBar.active,
                detail: `${JSON.stringify(afterReset)}, active ${afterResetBar.active}`
            },
            {
                name: 'the panel hides when the tool deactivates',
                pass: !afterDeactivate.visible,
                detail: JSON.stringify({ exists: afterDeactivate.exists, visible: afterDeactivate.visible })
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
            panel: { size: rect.size, axes: rect.axes, tracks: rows.map(r => r.track), numericFields: rect.numericFields },
            adaptiveScale: { wideDelta: +wideDelta.toFixed(1), narrowDelta: +narrowDelta.toFixed(1), gaps: [wideGap, narrowGap, thinGap, finestGap], blockWidths: [narrowBlockWidth, thinBlockWidth], steps40px: [stepTravelThick && stepTravelThick.steps, stepTravelThin && stepTravelThin.steps] },
            reset: { depth: reset.depth, x: reset.screen.x },
            afterTrim: afterTrim.screen.x,
            afterExpand: afterExpand.screen.x,
            afterDepth: afterDepth.depth,
            afterReset: { depth: afterReset.depth, x: afterReset.screen.x },
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
