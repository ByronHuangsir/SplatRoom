// Verify the 选区范围 panel: three FOUR-handle ranges (最近-最远 / 左-右 / 上-下) plus 重置,
// shown while a screen-space selection tool is active, driving `selection.depthRange` and
// `selection.screenRange`.
//
// Each axis has two handle levels: the inner pair trims the box, the outer pair expands past it
// (the span between an outer and its inner handle is the 扩边 part). The handles are dragged with
// real mouse input (page.mouse) because the control captures the pointer on the track, and the
// numeric fields are typed into as the exact-entry path.
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
                // [ marginLow, core, marginHigh ] as [left, width] percentages of the track
                fills: rows.map(r => Array.from(r.querySelectorAll('.select-range-fill')).map((f) => {
                    return [round(f.style.left), round(f.style.width)];
                })),
                values: rows.map(r => Array.from(r.querySelectorAll('.select-range-value input')).map(i => Number(i.value))),
                labels: rows.map(r => Array.from(r.querySelectorAll('.select-range-label')).map(l => l.textContent)),
                title: title ? title.textContent : null,
                active: !!title && title.classList.contains('active'),
                reset: !!bar.querySelector('.select-toolbar-button')
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

        // track fraction of a value on an axis (the x/y tracks span -100..200, depth 0..100)
        const fractionOf = (axis, value) => {
            const limits = axis === 'depth' ? { min: 0, max: 100 } : { min: -100, max: 200 };
            return (value - limits.min) / (limits.max - limits.min);
        };

        // drag one handle to a value on its axis, starting from the handle's own position
        // (real mouse: the widget captures the pointer on the track).
        //
        // The two handles of a pair are concentric at zero expansion, so a grab at the exact
        // centre of an OUTER handle would land on the inner dot that sits on top of it: the outer
        // ones are grabbed at their rim, which is what a user has to do as well.
        const dragHandle = async (axis, handle, value) => {
            const geometry = await page.evaluate((selector, a, h) => {
                const track = document.querySelector(`${selector} .select-range-row[data-axis="${a}"] .select-range-track`);
                const el = track.querySelector(`.select-range-handle[data-handle="${h}"]`);
                const t = track.getBoundingClientRect();
                const r = el.getBoundingClientRect();
                const outer = el.classList.contains('select-range-handle-outer');
                // the concentric ring leaves a 4px band; grab 2px inside the outer edge of it
                const rim = outer ? 2 : 0;
                const fromX = h === 'outerLow' || h === 'low' ?
                    r.left + rim + 1 : r.right - rim - 1;
                return { fromX, y: t.top + t.height / 2, left: t.left, width: t.width };
            }, BAR, axis, handle);
            await page.mouse.move(geometry.fromX, geometry.y);
            await page.mouse.down();
            await page.mouse.move(geometry.left + geometry.width * fractionOf(axis, value), geometry.y, { steps: 8 });
            await page.mouse.up();
            await sleep(400);
        };

        // 左-右: trim with the inner handles (收边), then expand past the box with the outer one
        await dragHandle('x', 'low', 30);
        const afterXLow = await ranges();
        await dragHandle('x', 'high', 70);
        const afterXHigh = await ranges();
        await dragHandle('x', 'outerLow', -20);
        const afterXOuter = await ranges();
        const afterXDrag = await barState();

        // 上-下: expand the far side only
        await dragHandle('y', 'outerHigh', 120);
        const afterYOuter = await ranges();

        // 深度: trim the far bound with the inner handle
        await dragHandle('depth', 'high', 50);
        const afterDepthHigh = await ranges();
        const activeAfterDrag = (await barState()).active;

        // exact entry through the numeric fields
        await page.evaluate((selector) => {
            const input = document.querySelector(`${selector} .select-range-row[data-axis="y"] .select-range-value[data-handle="high"] input`);
            input.focus();
            input.value = '65';
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.blur();
        }, BAR);
        await sleep(400);
        const afterTyped = await ranges();

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
                name: 'each axis carries four handles (two inner, two outer) and a three-part fill',
                pass: JSON.stringify(rect.axes) === '["depth","x","y"]' &&
                    rect.handles.every(n => n === 4) && rect.outerHandles.every(n => n === 2) &&
                    rect.fills.every(f => f.length === 3),
                detail: `axes ${JSON.stringify(rect.axes)}, handles ${JSON.stringify(rect.handles)} (outer ${JSON.stringify(rect.outerHandles)}), fills ${JSON.stringify(rect.fills)}`
            },
            {
                name: 'the axis end labels are localised and a reset button is there',
                pass: JSON.stringify(rect.labels) === '[["最近","最远"],["左","右"],["上","下"]]' &&
                    rect.reset === true && rect.title === '选区范围',
                detail: `labels ${JSON.stringify(rect.labels)}, title ${JSON.stringify(rect.title)}, reset ${rect.reset}`
            },
            {
                name: 'all three axes start at the full through-pass with no expansion',
                pass: rect.values.every(v => JSON.stringify(v) === '[0,0,100,100]') &&
                    before.depth.near === 0 && before.depth.far === 100 &&
                    before.depth.nearOuter === 0 && before.depth.farOuter === 100 &&
                    full(before.screen.x) && full(before.screen.y),
                detail: `sliders ${JSON.stringify(rect.values)}, ${JSON.stringify(before)}`
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
                name: 'the highlighted bands follow the handles (margin / core / margin)',
                pass: near(afterXDrag.fills[1][0][0], 27, 2) && near(afterXDrag.fills[1][0][1], 17, 2) &&
                    near(afterXDrag.fills[1][1][0], 43, 2) && near(afterXDrag.fills[1][1][1], 13, 2) &&
                    afterXDrag.fills[1][2][1] === 0,
                detail: `x row fills [marginLow, core, marginHigh] = ${JSON.stringify(afterXDrag.fills[1])} ` +
                    '(expected the -20..30 margin, the 30..70 core, and an empty right margin)'
            },
            {
                name: 'the 下 outer handle expands the vertical axis',
                pass: near(afterYOuter.screen.y.outerHigh, 120) && near(afterYOuter.screen.y.high, 100),
                detail: `screen.y ${JSON.stringify(afterYOuter.screen.y)}`
            },
            {
                name: 'the 最远 inner handle trims the far depth bound',
                pass: near(afterDepthHigh.depth.far, 50) && near(afterDepthHigh.depth.farOuter, 50) &&
                    afterDepthHigh.depth.near === 0,
                detail: `depth ${JSON.stringify(afterDepthHigh.depth)}`
            },
            {
                name: 'the title highlights once any axis is narrowed',
                pass: activeAfterDrag === true,
                detail: `title active ${activeAfterDrag}`
            },
            {
                name: 'typing into a numeric field writes that bound',
                pass: afterTyped.screen.y.high === 65,
                detail: `screen.y ${JSON.stringify(afterTyped.screen.y)} after typing 65 into 下`
            },
            {
                name: 'reset restores all twelve bounds and drops the highlight',
                pass: full(afterReset.screen.x) && full(afterReset.screen.y) &&
                    afterReset.depth.near === 0 && afterReset.depth.far === 100 &&
                    afterReset.depth.nearOuter === 0 && afterReset.depth.farOuter === 100 &&
                    afterResetBar.values.every(v => JSON.stringify(v) === '[0,0,100,100]') && !afterResetBar.active,
                detail: `${JSON.stringify(afterReset)}, sliders ${JSON.stringify(afterResetBar.values)}, active ${afterResetBar.active}`
            },
            {
                name: 'the panel hides when the tool deactivates',
                pass: !afterDeactivate.visible,
                detail: JSON.stringify({ ...afterDeactivate, values: undefined, labels: undefined })
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
            afterXLow,
            afterXHigh,
            afterXOuter,
            afterYOuter,
            afterDepthHigh,
            afterTyped,
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
