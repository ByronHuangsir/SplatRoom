// Verify the 选区范围 panel: three dual-handle ranges (最近-最远 / 左-右 / 上-下) plus 重置,
// shown while a screen-space selection tool is active, driving `selection.depthRange` and
// `selection.screenRange`.
//
// The handles are dragged with real mouse input (page.mouse) because the control captures the
// pointer on the track, and the numeric fields are typed into as the exact-entry path.
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
            return {
                exists: true,
                visible: !bar.classList.contains('pcui-hidden'),
                size: [Math.round(bar.getBoundingClientRect().width), Math.round(bar.getBoundingClientRect().height)],
                axes: rows.map(r => r.getAttribute('data-axis')),
                handles: rows.map(r => r.querySelectorAll('.select-range-handle').length),
                fills: rows.map(r => {
                    const fill = r.querySelector('.select-range-fill');
                    return fill ? [Math.round(parseFloat(fill.style.left)), Math.round(parseFloat(fill.style.width))] : null;
                }),
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

        const trackBox = (axis) => page.evaluate((selector, a) => {
            const track = document.querySelector(`${selector} .select-range-row[data-axis="${a}"] .select-range-track`);
            const r = track.getBoundingClientRect();
            return { left: r.left, right: r.right, y: r.top + r.height / 2, width: r.width };
        }, BAR, axis);

        // drag one handle to a fraction of the track (real mouse: the widget captures the pointer)
        const dragHandle = async (axis, handle, fraction) => {
            const box = await trackBox(axis);
            const from = handle === 'low' ? box.left + 1 : box.right - 1;
            await page.mouse.move(from, box.y);
            await page.mouse.down();
            await page.mouse.move(box.left + box.width * fraction, box.y, { steps: 8 });
            await page.mouse.up();
            await sleep(400);
        };

        // 左-右: squeeze both handles inwards
        await dragHandle('x', 'low', 0.35);
        const afterXLow = await ranges();
        await dragHandle('x', 'high', 0.65);
        const afterXHigh = await ranges();
        const afterXDrag = await barState();

        // 上-下: squeeze the low handle
        await dragHandle('y', 'low', 0.25);
        const afterYLow = await ranges();

        // 深度: squeeze the far handle
        await dragHandle('depth', 'high', 0.5);
        const afterDepthHigh = await ranges();
        const activeAfterDrag = (await barState()).active;

        // exact entry through the numeric fields
        await page.evaluate((selector) => {
            const input = document.querySelector(`${selector} .select-range-row[data-axis="y"] .select-range-value[data-handle="high"] input`);
            input.focus();
            input.value = '70';
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.blur();
        }, BAR);
        await sleep(400);
        const afterTyped = await ranges();

        // reset restores all six bounds
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
                name: 'the panel carries three axes, each with two handles and a fill',
                pass: JSON.stringify(rect.axes) === '["depth","x","y"]' &&
                    rect.handles.every(n => n === 2) && rect.fills.every(f => !!f),
                detail: `axes ${JSON.stringify(rect.axes)}, handles ${JSON.stringify(rect.handles)}, fills ${JSON.stringify(rect.fills)}`
            },
            {
                name: 'the axis end labels are localised and a reset button is there',
                pass: JSON.stringify(rect.labels) === '[["最近","最远"],["左","右"],["上","下"]]' &&
                    rect.reset === true && rect.title === '选区范围',
                detail: `labels ${JSON.stringify(rect.labels)}, title ${JSON.stringify(rect.title)}, reset ${rect.reset}`
            },
            {
                name: 'all three axes start at the full through-pass (0 / 100)',
                pass: rect.values.every(v => v[0] === 0 && v[1] === 100) &&
                    before.depth.near === 0 && before.depth.far === 100 &&
                    before.screen.x.low === 0 && before.screen.x.high === 100 &&
                    before.screen.y.low === 0 && before.screen.y.high === 100,
                detail: `sliders ${JSON.stringify(rect.values)}, ${JSON.stringify(before)}`
            },
            {
                name: 'dragging the 左 handle writes the left bound',
                pass: near(afterXLow.screen.x.low, 35) && afterXLow.screen.x.high === 100,
                detail: `screen.x ${JSON.stringify(afterXLow.screen.x)} (dragged to 35% of the track)`
            },
            {
                name: 'dragging the 右 handle writes the right bound',
                pass: near(afterXHigh.screen.x.high, 65) && near(afterXHigh.screen.x.low, 35),
                detail: `screen.x ${JSON.stringify(afterXHigh.screen.x)} (dragged to 65% of the track)`
            },
            {
                name: 'the highlighted span follows the handles',
                pass: afterXDrag.fills[1][0] === 35 && near(afterXDrag.fills[1][1], 30),
                detail: `x row fill left/width ${JSON.stringify(afterXDrag.fills[1])}`
            },
            {
                name: 'dragging the 上 handle writes the top bound',
                pass: near(afterYLow.screen.y.low, 25) && afterYLow.screen.y.high === 100,
                detail: `screen.y ${JSON.stringify(afterYLow.screen.y)}`
            },
            {
                name: 'dragging the 最远 handle writes the far depth bound',
                pass: near(afterDepthHigh.depth.far, 50) && afterDepthHigh.depth.near === 0,
                detail: `depth ${JSON.stringify(afterDepthHigh.depth)}`
            },
            {
                name: 'the title highlights once any axis is narrowed',
                pass: activeAfterDrag === true,
                detail: `title active ${activeAfterDrag}`
            },
            {
                name: 'typing into a numeric field writes that bound',
                pass: afterTyped.screen.y.high === 70,
                detail: `screen.y ${JSON.stringify(afterTyped.screen.y)} after typing 70 into 下`
            },
            {
                name: 'reset restores all six bounds and drops the highlight',
                pass: afterReset.depth.near === 0 && afterReset.depth.far === 100 &&
                    afterReset.screen.x.low === 0 && afterReset.screen.x.high === 100 &&
                    afterReset.screen.y.low === 0 && afterReset.screen.y.high === 100 &&
                    afterResetBar.values.every(v => v[0] === 0 && v[1] === 100) && !afterResetBar.active,
                detail: `${JSON.stringify(afterReset)}, sliders ${JSON.stringify(afterResetBar.values)}, active ${afterResetBar.active}`
            },
            {
                name: 'the panel hides when the tool deactivates',
                pass: !afterDeactivate.visible,
                detail: JSON.stringify(afterDeactivate)
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
            bars: results,
            before,
            afterXLow,
            afterXHigh,
            afterYLow,
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
