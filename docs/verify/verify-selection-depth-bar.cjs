// Verify the 选区范围 panel: one rail per axis with exactly TWO labelled blocks that always park at
// the same two rail positions (20% / 80%), a push-drag whose sensitivity grows with how far you push
// (near the park = fine, far = fast), an automatic return to the park on release, and no numbers at all.
//
// Grips are driven with real mouse input (page.mouse) because the control captures the pointer.
//
// usage: node docs/verify/verify-selection-depth-bar.cjs "<url>" [model]
const puppeteer = require('puppeteer-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const BAR = '#selection-range-bar';
// the widget parks the two blocks at these fractions of the track
const HOME_LOW = 0.2;
const HOME_HIGH = 0.8;
// the push curve the widget is specified to use (see range-slider.ts)
const NUDGE_BASE = 0.02;
const NUDGE_GROWTH = 40;
const nudge = (dx) => Math.sign(dx) * NUDGE_BASE * (Math.abs(dx) + (dx * dx) / (2 * NUDGE_GROWTH));

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
            const fraction = (track, el) => {
                const t = track.getBoundingClientRect();
                const b = el.getBoundingClientRect();
                return +(((b.left + b.width / 2) - t.left) / t.width).toFixed(3);
            };
            return {
                exists: true,
                visible: !bar.classList.contains('pcui-hidden'),
                size: [Math.round(bar.getBoundingClientRect().width), Math.round(bar.getBoundingClientRect().height)],
                axes: rows.map(r => r.getAttribute('data-axis')),
                blocks: rows.map(r => r.querySelectorAll('.select-range-block').length),
                grips: rows.map(r => r.querySelectorAll('.select-range-handle').length),
                outerHandles: rows.map(r => r.querySelectorAll('.select-range-handle-outer').length),
                numericFields: rows.map(r => r.querySelectorAll('.select-range-value, .pcui-numeric-input').length),
                readouts: rows.map(r => r.querySelectorAll('.select-range-readout').length),
                // any digit anywhere inside a row would be "a number the user has to read"
                digits: rows.map(r => (r.textContent.match(/[0-9]/g) || []).length + r.querySelectorAll('input').length),
                layout: rows.map((r) => {
                    const track = r.querySelector('.select-range-track');
                    const t = track.getBoundingClientRect();
                    const blocks = Array.from(r.querySelectorAll('.select-range-block')).map(b => {
                        const box = b.getBoundingClientRect();
                        return {
                            side: b.getAttribute('data-block'),
                            box: [Math.round(box.left - t.left), Math.round(box.width)],
                            at: fraction(track, b),
                            labelInside: !!b.querySelector('.select-range-label')
                        };
                    });
                    return {
                        axis: r.getAttribute('data-axis'),
                        track: Math.round(t.width),
                        blocks,
                        core: (() => { const c = r.querySelector('.select-range-core').getBoundingClientRect(); return [Math.round(c.left - t.left), Math.round(c.width)]; })(),
                        bands: r.querySelectorAll('.select-range-band').length,
                        labels: Array.from(r.querySelectorAll('.select-range-label')).map(l => l.textContent)
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

        const selectedCount = () => page.evaluate(() => {
            const splat = window.scene.getElementsByType('splat').slice(-1)[0];
            const st = splat.splatData.getProp('state');
            let n = 0;
            for (let i = 0; i < st.length; i++) if (st[i] & 1) n++;
            return n;
        });

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

        await activate('rectSelection');
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

        const blockOf = (state, side) => state.layout[1].blocks.find(b => b.side === side);

        // drag one block by N pixels along the track with a real mouse
        const dragBlock = async (axis, handle, pixels, steps = 8) => {
            const geometry = await page.evaluate((selector, a, h) => {
                const row = document.querySelector(`${selector} .select-range-row[data-axis="${a}"]`);
                const track = row.querySelector('.select-range-track');
                const el = track.querySelector(`.select-range-handle[data-handle="${h}"]`);
                const t = track.getBoundingClientRect();
                const b = el.getBoundingClientRect();
                return { fromX: b.left + b.width / 2, y: t.top + t.height / 2 };
            }, BAR, axis, handle);
            await page.mouse.move(geometry.fromX, geometry.y);
            await page.mouse.down();
            await page.mouse.move(geometry.fromX + pixels, geometry.y, { steps });
            await page.mouse.up();
            await sleep(250);
        };

        // --- structure ---
        const rect = await activate('rectSelection');
        const defaultState = rect;
        const reset = (await ranges());
        const resetBar = rect;

        // a real rect gesture so the rows are live, then a trim through the panel
        await page.evaluate(() => window.scene.events.fire('selection.resetRange'));
        await sleep(300);
        await page.evaluate(() => window.scene.events.fire('select.none'));
        await sleep(800);
        await page.evaluate(() => window.scene.events.invoke('select.rect', 'set', { start: { x: 0.4, y: 0.4 }, end: { x: 0.6, y: 0.6 } }));
        await sleep(1500);
        const through = await selectedCount();
        const throughState = await barState();

        // --- the park: the two blocks sit at 20% / 80% and stay there in every state ---
        const parkedState = async (patch) => {
            await setRange(patch);
            await sleep(400);
            const s = await barState();
            return { low: blockOf(s, 'low').at, high: blockOf(s, 'high').at, gap: s.layout[1].core[1], width: blockOf(s, 'low').box[1] };
        };
        const parkDefault = await parkedState({ x: { low: 0, high: 100, outerLow: 0, outerHigh: 100 } });
        const parkWide = await parkedState({ x: { low: 30, high: 70, outerLow: 30, outerHigh: 70 } });
        const parkThin = await parkedState({ x: { low: 49.9, high: 50.1, outerLow: 49.9, outerHigh: 50.1 } });
        const parkTiny = await parkedState({ x: { low: 50, high: 50.1, outerLow: 50, outerHigh: 50.1 } });

        // --- the push curve: the SAME 20px of travel moves much more once you are pushed far out.
        // Both samples come from one held drag (0->20px at the park, 200->220px far out) ---
        await setRange({ x: { low: 0, high: 100, outerLow: 0, outerHigh: 100 } });
        await sleep(400);
        const tapered = [];
        {
            const geometry = await page.evaluate((selector) => {
                const row = document.querySelector(`${selector} .select-range-row[data-axis="x"]`);
                const track = row.querySelector('.select-range-track');
                const el = track.querySelector('.select-range-handle[data-handle="low"]');
                const t = track.getBoundingClientRect();
                const b = el.getBoundingClientRect();
                return { fromX: b.left + b.width / 2, y: t.top + t.height / 2 };
            }, BAR);
            await page.mouse.move(geometry.fromX, geometry.y);
            await page.mouse.down();
            for (const dx of [0, 20, 200, 220]) {
                await page.mouse.move(geometry.fromX + dx, geometry.y, { steps: 1 });
                await sleep(120);
                tapered.push({ dx, low: (await ranges()).screen.x.low });
            }
            await page.mouse.up();
            await sleep(300);
        }
        const nearPush = +(tapered[1].low - tapered[0].low).toFixed(1);
        const farPush = +(tapered[3].low - tapered[2].low).toFixed(1);
        await page.evaluate(() => window.scene.events.fire('selection.resetRange'));
        await sleep(300);

        // --- the held drag: the block follows the pointer and parks inside the rail ---
        await setRange({ x: { low: 0, high: 100, outerLow: 0, outerHigh: 100 } });
        await sleep(400);
        const held = [];
        {
            const geometry = await page.evaluate((selector) => {
                const row = document.querySelector(`${selector} .select-range-row[data-axis="x"]`);
                const track = row.querySelector('.select-range-track');
                const el = track.querySelector('.select-range-handle[data-handle="low"]');
                const t = track.getBoundingClientRect();
                const b = el.getBoundingClientRect();
                return { fromX: b.left + b.width / 2, y: t.top + t.height / 2 };
            }, BAR);
            await page.mouse.move(geometry.fromX, geometry.y);
            await page.mouse.down();
            for (const dx of [0, 40, 200, 400, 700]) {
                await page.mouse.move(geometry.fromX + dx, geometry.y, { steps: 1 });
                await sleep(120);
                const s = await barState();
                held.push({ dx, at: blockOf(s, 'low').at, low: (await ranges()).screen.x.low });
            }
            await page.mouse.up();
            await sleep(400);
        }
        const afterHeld = await barState();
        const afterHeldRange = await ranges();
        const heldTrimmed = await selectedCount();

        // --- the trim/return behaviour with the model live ---
        await page.evaluate(() => window.scene.events.fire('selection.resetRange'));
        await sleep(300);
        await dragBlock('x', 'low', 60, 6);
        const afterTrim = await ranges();
        const afterTrimBar = await barState();
        const trimmed = await selectedCount();

        // --- a full push into the other block must not collapse the core ---
        await page.evaluate(() => window.scene.events.fire('selection.resetRange'));
        await sleep(300);
        await dragBlock('x', 'low', 900, 12);
        const collapsed = await ranges();
        const collapsedBar = await barState();
        const collapsedThickness = +(collapsed.screen.x.high - collapsed.screen.x.low).toFixed(1);
        const collapsedPark = { low: blockOf(collapsedBar, 'low').at, high: blockOf(collapsedBar, 'high').at };

        // --- reset ---
        await page.evaluate((sel) => document.querySelector(`${sel} .select-toolbar-button`).click(), BAR);
        await sleep(600);
        const afterReset = await ranges();
        const afterResetBar = await barState();

        await page.evaluate(() => window.scene.events.fire('tool.rectSelection'));
        await sleep(200);
        await page.evaluate(() => window.scene.events.fire('selection.resetRange'));
        await sleep(300);
        await page.evaluate(() => window.scene.events.fire('select.none'));
        await sleep(600);
        await page.evaluate(() => window.scene.events.invoke('select.rect', 'set', { start: { x: 0.4, y: 0.4 }, end: { x: 0.6, y: 0.6 } }));
        await sleep(1200);
        await page.evaluate(() => window.scene.events.fire('tool.deactivate'));
        await sleep(400);
        const hidden = await barState();

        const full = (axis) => axis.low === 0 && axis.high === 100 && axis.outerLow === 0 && axis.outerHigh === 100;
        const fullDepth = (d) => d.near === 0 && d.far === 100 && d.nearOuter === 0 && d.farOuter === 100;
        const park = (p) => Math.abs(p.low - HOME_LOW) < 0.01 && Math.abs(p.high - HOME_HIGH) < 0.01;

        const checks = [
            {
                name: 'the range panel appears for every screen-space selection tool',
                pass: ['rectSelection', 'lassoSelection', 'polygonSelection', 'brushSelection', 'floodSelection']
                    .every(t => results[t].exists && results[t].visible),
                detail: ['rectSelection', 'lassoSelection', 'polygonSelection', 'brushSelection', 'floodSelection']
                    .map(t => `${t}: ${results[t].visible ? 'visible' : 'hidden'} ${results[t].size.join('x')}`).join(', ')
            },
            {
                name: 'the panel stays hidden for the volume / brush tools',
                pass: ['sphereBrushSelection', 'sphereSelection', 'boxSelection'].every(t => !results[t].visible),
                detail: ['sphereBrushSelection', 'sphereSelection', 'boxSelection'].map(t => `${t}: ${results[t].visible ? 'visible' : 'hidden'}`).join(', ')
            },
            {
                name: 'the panel is long: a 440px track per axis',
                pass: defaultState.layout.every(r => r.track === 440),
                detail: defaultState.layout.map(r => `${r.axis}: ${r.track}px`).join(', ')
            },
            {
                name: 'each axis is ONE rail with exactly TWO labelled blocks (no outer handles)',
                pass: defaultState.axes.length === 3 && defaultState.blocks.every(n => n === 2) &&
                    defaultState.outerHandles.every(n => n === 0) && defaultState.layout.every(r => r.bands === 1) &&
                    defaultState.layout.every(r => r.blocks.every(b => b.labelInside)) &&
                    defaultState.grips.every(n => n === 2),
                detail: `axes ${JSON.stringify(defaultState.axes)}, blocks ${JSON.stringify(defaultState.blocks)}, outerHandles ${JSON.stringify(defaultState.outerHandles)}, bands/row ${defaultState.layout.map(r => r.bands).join('/')}, label inside every block ${defaultState.layout.every(r => r.blocks.every(b => b.labelInside))}`
            },
            {
                name: 'the axis labels are localised and a reset button is there',
                pass: JSON.stringify(defaultState.layout.map(r => r.labels)) === JSON.stringify([['最近', '最远'], ['左', '右'], ['上', '下']]) &&
                    defaultState.reset,
                detail: `labels ${JSON.stringify(defaultState.layout.map(r => r.labels))}, title "${defaultState.title}", reset ${defaultState.reset}`
            },
            {
                name: 'no numbers in a row: no fields, no readout, no digits',
                pass: defaultState.numericFields.every(n => n === 0) && defaultState.readouts.every(n => n === 0) &&
                    defaultState.digits.every(n => n === 0),
                detail: `numeric fields ${JSON.stringify(defaultState.numericFields)}, readout elements ${JSON.stringify(defaultState.readouts)}, digits + inputs ${JSON.stringify(defaultState.digits)}`
            },
            {
                name: 'the two blocks park at 20% / 80% of the rail in EVERY state',
                pass: park(parkDefault) && park(parkWide) && park(parkThin) && park(parkTiny),
                detail: `100-wide ${JSON.stringify(parkDefault)} | 40-wide ${JSON.stringify(parkWide)} | 0.2-wide ${JSON.stringify(parkThin)} | 0.1-wide ${JSON.stringify(parkTiny)}`
            },
            {
                name: 'the band between the parked blocks is the selection and never changes width',
                pass: new Set([parkDefault.gap, parkWide.gap, parkThin.gap, parkTiny.gap]).size === 1 && parkDefault.gap > 200,
                detail: `band width ${[parkDefault.gap, parkWide.gap, parkThin.gap, parkTiny.gap].join('/')}px (all states)`
            },
            {
                name: 'the blocks are a fixed size (they never resize)',
                pass: new Set([parkDefault.width, parkWide.width, parkThin.width, parkTiny.width]).size === 1,
                detail: `block width ${[parkDefault.width, parkWide.width, parkThin.width, parkTiny.width].join('/')}px`
            },
            {
                name: 'the push accelerates: the same 20px moves much more once pushed far out',
                pass: nearPush > 0 && farPush > nearPush * 2 &&
                    Math.abs(nearPush - nudge(20)) < 0.2 && Math.abs(farPush - (nudge(220) - nudge(200))) < 0.4,
                detail: `in one drag: 0->20px moves ${nearPush} (spec ${nudge(20).toFixed(2)}), 200->220px moves ${farPush} (spec ${(nudge(220) - nudge(200)).toFixed(2)}) -> ${(farPush / Math.max(nearPush, 0.01)).toFixed(1)}x faster`
            },
            {
                name: 'while held the block follows the pointer, then parks at the rail end',
                pass: held[0].at === HOME_LOW && Math.abs(held[1].at - (HOME_LOW + 40 / 440)) < 0.01 &&
                    held[3].at === 1 && held[4].at === 1 && held[4].low > held[3].low,
                detail: held.map(h => `${h.dx}px -> block ${h.at}, low ${h.low}`).join(' | ')
            },
            {
                name: 'releasing returns BOTH blocks to their park, and the value stays',
                pass: park({ low: blockOf(afterHeld, 'low').at, high: blockOf(afterHeld, 'high').at }) &&
                    afterHeldRange.screen.x.low === held[4].low,
                detail: `pushed to low ${held[4].low} -> released at ${JSON.stringify({ low: blockOf(afterHeld, 'low').at, high: blockOf(afterHeld, 'high').at })}, value kept ${afterHeldRange.screen.x.low}`
            },
            {
                name: 'all three axes start at the full through-pass',
                pass: fullDepth(reset.depth) && full(reset.screen.x) && full(reset.screen.y),
                detail: JSON.stringify(reset)
            },
            {
                name: 'pushing the block trims the selection (real gesture on the model)',
                pass: through > 0 && trimmed > 0 && trimmed < through && afterTrim.screen.x.low > 0 &&
                    park({ low: blockOf(afterTrimBar, 'low').at, high: blockOf(afterTrimBar, 'high').at }),
                detail: `rect 40-60% -> ${through} selected; push 60px -> ${trimmed}; x ${JSON.stringify(afterTrim.screen.x)}`
            },
            {
                name: 'the core can never collapse: a 900px push keeps one step and the blocks stay apart',
                pass: collapsedThickness >= 0.1 && park(collapsedPark),
                detail: `900px push -> thickness ${collapsedThickness}, blocks ${JSON.stringify(collapsedPark)}, band ${collapsedBar.layout[1].core[1]}px`
            },
            {
                name: 'the title highlights once any axis is narrowed',
                pass: afterTrimBar.active,
                detail: `title active ${afterTrimBar.active}`
            },
            {
                name: 'reset restores all twelve bounds and drops the highlight',
                pass: fullDepth(afterReset.depth) && full(afterReset.screen.x) && full(afterReset.screen.y) && !afterResetBar.active,
                detail: `${JSON.stringify(afterReset)}, active ${afterResetBar.active}`
            },
            {
                name: 'the panel hides when the tool deactivates',
                pass: hidden.exists && !hidden.visible,
                detail: JSON.stringify({ exists: hidden.exists, visible: hidden.visible })
            },
            {
                name: 'no console errors',
                pass: logs.length === 0,
                detail: logs.length ? logs.slice(0, 3).join(' | ') : 'clean'
            }
        ];

        console.log(JSON.stringify({
            results: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { visible: v.visible, size: v.size }])),
            through,
            trimmed,
            nearPush,
            farPush,
            tapered,
            park: { default: parkDefault, wide: parkWide, thin: parkThin, tiny: parkTiny },
            held,
            collapsedThickness,
            checks,
            failed: checks.filter(c => !c.pass).length
        }, null, 1));
        if (logs.length) {
            process.exitCode = 1;
        }
    } catch (e) {
        console.log(JSON.stringify({ fatal: String(e).slice(0, 600), logs }, null, 1));
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
