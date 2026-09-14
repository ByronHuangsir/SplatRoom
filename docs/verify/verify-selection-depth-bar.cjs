// Verify the 选区范围 panel: three FOUR-handle range rows laid out exactly like the design sketch
// `----o 近 o-------o 远 o----` (the axis labels sit ON the track, between the two handles of a
// pair; the outer handles are drawn apart from their inner partner; there are no numeric fields
// in a row - the value floats next to the handle while dragging).
//
// The handles are dragged with real mouse input (page.mouse) because the control captures the
// pointer on the track.
//
// usage: node docs/verify/verify-selection-depth-bar.cjs "<url>" [model]
const puppeteer = require('C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const BAR = '#selection-range-bar';

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

        // geometry of one row, in track-relative pixels
        const barState = () => page.evaluate((selector) => {
            const bar = document.querySelector(selector);
            if (!bar) {
                return { exists: false };
            }
            const rows = Array.from(bar.querySelectorAll('.select-range-row'));
            const title = bar.querySelector('.select-toolbar-label');
            const round = (v) => Math.round(parseFloat(v));
            return {
                exists: true,
                visible: !bar.classList.contains('pcui-hidden'),
                size: [Math.round(bar.getBoundingClientRect().width), Math.round(bar.getBoundingClientRect().height)],
                axes: rows.map(r => r.getAttribute('data-axis')),
                handles: rows.map(r => r.querySelectorAll('.select-range-handle').length),
                outerHandles: rows.map(r => r.querySelectorAll('.select-range-handle-outer').length),
                numericFields: rows.map(r => r.querySelectorAll('.select-range-value, .pcui-numeric-input').length),
                // [ marginLow, core, marginHigh ] as [left, width] pixels inside the track
                fills: rows.map((r) => {
                    const track = r.querySelector('.select-range-track').getBoundingClientRect();
                    return Array.from(r.querySelectorAll('.select-range-fill')).map((f) => {
                        const b = f.getBoundingClientRect();
                        return [Math.round(b.left - track.left), Math.round(b.width), getComputedStyle(f).visibility];
                    });
                }),
                // handle and label centres relative to the track's left edge
                layout: rows.map((r) => {
                    const track = r.querySelector('.select-range-track').getBoundingClientRect();
                    const centre = (el) => Math.round(el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2 - track.left);
                    const handles = {};
                    for (const h of r.querySelectorAll('.select-range-handle')) {
                        handles[h.getAttribute('data-handle')] = centre(h);
                    }
                    const labels = Array.from(r.querySelectorAll('.select-range-label')).map(l => ({ text: l.textContent, cx: centre(l) }));
                    return { axis: r.getAttribute('data-axis'), track: Math.round(track.width), handles, labels };
                }),
                labels: rows.map(r => Array.from(r.querySelectorAll('.select-range-label')).map(l => l.textContent)),
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
            // tool events toggle, so deactivate first to make the call deterministic
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

        // with the rect tool active, drive the three axes from the panel
        const rect = await activate('rectSelection');
        const before = await ranges();

        // track fraction of a value on an axis (all three tracks span -50..150)
        const fractionOf = (axis, value) => (value + 50) / 200;

        // drag one handle to a value on its axis, starting from the handle's own centre
        const dragHandle = async (axis, handle, value) => {
            const geometry = await page.evaluate((selector, a, h, fraction) => {
                const track = document.querySelector(`${selector} .select-range-row[data-axis="${a}"] .select-range-track`);
                const el = track.querySelector(`.select-range-handle[data-handle="${h}"]`);
                const t = track.getBoundingClientRect();
                const r = el.getBoundingClientRect();
                return {
                    fromX: r.left + r.width / 2,
                    y: t.top + t.height / 2,
                    left: t.left,
                    width: t.width,
                    fraction
                };
            }, BAR, axis, handle, fractionOf(axis, value));
            await page.mouse.move(geometry.fromX, geometry.y);
            await page.mouse.down();
            await page.mouse.move(geometry.left + geometry.width * geometry.fraction, geometry.y, { steps: 8 });
            await page.mouse.up();
            await sleep(400);
        };

        // the readout only exists while a drag is in progress: sample it mid-drag
        const readoutDuringDrag = async (axis, handle) => {
            const geometry = await page.evaluate((selector, a, h) => {
                const track = document.querySelector(`${selector} .select-range-row[data-axis="${a}"] .select-range-track`);
                const el = track.querySelector(`.select-range-handle[data-handle="${h}"]`);
                const t = track.getBoundingClientRect();
                const r = el.getBoundingClientRect();
                return { fromX: r.left + r.width / 2, y: t.top + t.height / 2, left: t.left, width: t.width };
            }, BAR, axis, handle);
            await page.mouse.move(geometry.fromX, geometry.y);
            await page.mouse.down();
            await page.mouse.move(geometry.left + geometry.width * 0.6, geometry.y, { steps: 4 });
            const shown = await page.evaluate((selector, a) => {
                const row = document.querySelector(`${selector} .select-range-row[data-axis="${a}"]`);
                const readout = row.querySelector('.select-range-readout');
                return { text: readout.textContent, visible: readout.classList.contains('visible') };
            }, BAR, axis);
            await page.mouse.up();
            await sleep(250);
            const after = await page.evaluate((selector, a) => {
                const row = document.querySelector(`${selector} .select-range-row[data-axis="${a}"]`);
                const readout = row.querySelector('.select-range-readout');
                return { visible: readout.classList.contains('visible') };
            }, BAR, axis);
            return { ...shown, visibleAfter: after.visible };
        };

        const readout = await readoutDuringDrag('x', 'low');

        // 左-右: trim with the inner handles (收边), then expand past the box with the outer one
        await dragHandle('x', 'low', 30);
        const afterXLow = await ranges();
        await dragHandle('x', 'high', 70);
        const afterXHigh = await ranges();
        await dragHandle('x', 'outerLow', -20);
        const afterXOuter = await ranges();
        const afterXDrag = await barState();

        // 上-下: expand the far side only
        await dragHandle('y', 'outerHigh', 130);
        const afterYOuter = await ranges();

        // 深度: trim the far bound with the inner handle
        await dragHandle('depth', 'high', 50);
        const afterDepthHigh = await ranges();
        const activeAfterDrag = (await barState()).active;

        // reset restores all twelve bounds
        await page.evaluate((selector) => {
            document.querySelector(`${selector} .select-toolbar-button`).click();
        }, BAR);
        await sleep(500);
        const afterReset = await ranges();
        const afterResetBar = await barState();

        await page.evaluate(() => window.scene.events.fire('tool.deactivate'));
        await sleep(300);
        const afterDeactivate = await barState();

        const screenTools = ['rectSelection', 'lassoSelection', 'polygonSelection', 'brushSelection', 'floodSelection'];
        const others = ['sphereBrushSelection', 'sphereSelection', 'boxSelection'];
        const near = (a, b, tol = 6) => Math.abs(a - b) <= tol;
        const full = (axis) => axis.low === 0 && axis.high === 100 && axis.outerLow === 0 && axis.outerHigh === 100;
        const rows = rect.layout;

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
                name: 'each axis carries four handles (two inner dots, two outer rings)',
                pass: JSON.stringify(rect.axes) === '["depth","x","y"]' &&
                    rect.handles.every(n => n === 4) && rect.outerHandles.every(n => n === 2),
                detail: `axes ${JSON.stringify(rect.axes)}, handles ${JSON.stringify(rect.handles)} (outer ${JSON.stringify(rect.outerHandles)})`
            },
            {
                name: 'the layout is the design line: `----o 近 o-------o 远 o----`',
                // 4 handles on one track, each pair visibly apart, the label between the pair,
                // and the core between the two inner handles
                pass: rows.every((row) => {
                    const { handles, labels } = row;
                    const ordered = handles.outerLow < handles.low && handles.low < handles.high && handles.high < handles.outerHigh;
                    const gaps = Math.min(handles.low - handles.outerLow, handles.outerHigh - handles.high);
                    const labelInPair = labels.length === 2 &&
                        labels[0].cx > handles.outerLow && labels[0].cx < handles.low &&
                        labels[1].cx > handles.high && labels[1].cx < handles.outerHigh;
                    const coreWide = handles.high - handles.low > gaps * 2;
                    return ordered && gaps >= 14 && labelInPair && coreWide;
                }),
                detail: rows.map(r => `${r.axis}: track ${r.track}, outerLow ${r.handles.outerLow} < low ${r.handles.low} < high ${r.handles.high} < outerHigh ${r.handles.outerHigh}, labels ${JSON.stringify(r.labels)}`).join(' | ')
            },
            {
                name: 'the axis end labels are localised, on the track, and a reset button is there',
                pass: JSON.stringify(rect.labels) === '[["最近","最远"],["左","右"],["上","下"]]' &&
                    rect.reset === true && rect.title === '选区范围',
                detail: `labels ${JSON.stringify(rect.labels)}, title ${JSON.stringify(rect.title)}, reset ${rect.reset}`
            },
            {
                name: 'no numeric fields inside a row (the value floats while dragging)',
                pass: rect.numericFields.every(n => n === 0),
                detail: `numeric inputs per row ${JSON.stringify(rect.numericFields)}; drag readout ${JSON.stringify(readout)}`
            },
            {
                name: 'the value readout shows during a drag and hides after it',
                pass: readout.visible === true && readout.text !== '' && readout.visibleAfter === false,
                detail: `readout ${JSON.stringify(readout)}`
            },
            {
                name: 'all three axes start at the full through-pass with no expansion',
                pass: before.depth.near === 0 && before.depth.far === 100 &&
                    before.depth.nearOuter === 0 && before.depth.farOuter === 100 &&
                    full(before.screen.x) && full(before.screen.y) &&
                    rect.fills.every(f => f[0][2] === 'hidden' && f[2][2] === 'hidden'),
                detail: `${JSON.stringify(before)}; margin bands ${JSON.stringify(rect.fills.map(f => [f[0][2], f[2][2]]))}`
            },
            {
                name: 'trimming with the 左 inner handle carries its outer handle along (收边)',
                pass: near(afterXLow.screen.x.low, 30) && near(afterXLow.screen.x.outerLow, 30) &&
                    afterXLow.screen.x.high === 100,
                detail: `screen.x ${JSON.stringify(afterXLow.screen.x)} (inner dragged to 30, expansion stays 0)`
            },
            {
                name: 'trimming with the 右 inner handle writes the right bound',
                pass: near(afterXHigh.screen.x.high, 70) && near(afterXHigh.screen.x.outerHigh, 70) &&
                    near(afterXHigh.screen.x.low, 30),
                detail: `screen.x ${JSON.stringify(afterXHigh.screen.x)}`
            },
            {
                name: 'the 左 outer handle expands past the box (扩边)',
                pass: near(afterXOuter.screen.x.outerLow, -20) && near(afterXOuter.screen.x.low, 30),
                detail: `screen.x ${JSON.stringify(afterXOuter.screen.x)} (outer dragged to -20 = 50% of the box outside)`
            },
            {
                name: 'the highlighted margin band appears once something has been eaten',
                pass: afterXDrag.fills[1][0][2] === 'visible' && afterXDrag.fills[1][2][2] === 'hidden',
                detail: `x row fills [marginLow, core, marginHigh] = ${JSON.stringify(afterXDrag.fills[1])}`
            },
            {
                name: 'the 下 outer handle expands the vertical axis',
                pass: near(afterYOuter.screen.y.outerHigh, 130) && near(afterYOuter.screen.y.high, 100),
                detail: `screen.y ${JSON.stringify(afterYOuter.screen.y)}`
            },
            {
                name: 'the 最远 inner handle trims the far depth bound',
                pass: near(afterDepthHigh.depth.far, 50) && near(afterDepthHigh.depth.farOuter, 50) &&
                    near(afterDepthHigh.depth.near, 0),
                detail: `depth ${JSON.stringify(afterDepthHigh.depth)}`
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
            bars: { rect: results.rectSelection },
            before,
            readout,
            afterXLow,
            afterXHigh,
            afterXOuter,
            afterYOuter,
            afterDepthHigh,
            afterReset,
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
