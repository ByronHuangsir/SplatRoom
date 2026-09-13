// Verify the 选区深度 bar (the floating toolbar that appears while a screen-space selection
// tool is active): 最近 / 最远 sliders plus 重置, driving `selection.depthRange`.
//
// usage: node docs/verify/verify-selection-depth-bar.cjs "<url>" [model]
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
        await page.setViewport({ width: 1280, height: 800 });
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

        const barState = () => page.evaluate(() => {
            const bar = document.getElementById('selection-depth-bar');
            const sliders = bar ? Array.from(bar.querySelectorAll('.pcui-slider')) : [];
            const title = bar ? bar.querySelector('.select-toolbar-label') : null;
            return {
                exists: !!bar,
                visible: !!bar && !bar.classList.contains('pcui-hidden'),
                size: bar ? [bar.getBoundingClientRect().width, bar.getBoundingClientRect().height].map(Math.round) : null,
                sliders: sliders.length,
                values: sliders.map(s => Number(s.querySelector('.pcui-numeric-input input').value)),
                title: title ? title.textContent : null,
                active: !!bar && !!title && title.classList.contains('active'),
                reset: !!bar && !!bar.querySelector('.select-toolbar-button')
            };
        });

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

        // with the rect tool active, drive the two sliders and the reset button from the bar
        const rect = await activate('rectSelection');
        const before = await page.evaluate(() => window.scene.events.invoke('selection.depthRange'));

        // type into 最近 (the first slider's numeric field: typing a value fires change)
        await page.evaluate(() => {
            const bar = document.getElementById('selection-depth-bar');
            const input = bar.querySelectorAll('.pcui-numeric-input input')[0];
            input.focus();
            input.value = '30';
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.blur();
        });
        await sleep(500);
        const afterNear = await page.evaluate(() => ({
            range: window.scene.events.invoke('selection.depthRange'),
            values: Array.from(document.querySelectorAll('#selection-depth-bar .pcui-numeric-input input')).map(i => Number(i.value))
        }));

        // type into 最远
        await page.evaluate(() => {
            const bar = document.getElementById('selection-depth-bar');
            const input = bar.querySelectorAll('.pcui-numeric-input input')[1];
            input.focus();
            input.value = '70';
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.blur();
        });
        await sleep(500);
        const afterFar = await page.evaluate(() => ({
            range: window.scene.events.invoke('selection.depthRange'),
            active: !!document.querySelector('#selection-depth-bar .select-toolbar-label.active')
        }));

        // drive 最近 past 最远: the pair has to stay ordered (the other handle is pushed)
        await page.evaluate(() => {
            const bar = document.getElementById('selection-depth-bar');
            const input = bar.querySelectorAll('.pcui-numeric-input input')[0];
            input.focus();
            input.value = '100';
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.blur();
        });
        await sleep(500);
        const crossed = await page.evaluate(() => ({
            range: window.scene.events.invoke('selection.depthRange'),
            values: Array.from(document.querySelectorAll('#selection-depth-bar .pcui-numeric-input input')).map(i => Number(i.value))
        }));

        // the reset button restores 0 / 100
        await page.evaluate(() => {
            const bar = document.getElementById('selection-depth-bar');
            bar.querySelector('.select-toolbar-button').click();
        });
        await sleep(500);
        const afterReset = await page.evaluate(() => ({
            range: window.scene.events.invoke('selection.depthRange'),
            values: Array.from(document.querySelectorAll('#selection-depth-bar .pcui-numeric-input input')).map(i => Number(i.value)),
            active: !!document.querySelector('#selection-depth-bar .select-toolbar-label.active')
        }));

        await page.evaluate(() => window.scene.events.fire('tool.deactivate'));
        await sleep(300);
        const afterDeactivate = await barState();

        const screenTools = ['rectSelection', 'lassoSelection', 'polygonSelection', 'brushSelection', 'floodSelection'];
        const others = ['sphereBrushSelection', 'sphereSelection', 'boxSelection'];

        const checks = [
            {
                name: 'the depth range bar appears for every screen-space selection tool',
                pass: screenTools.every(t => results[t].visible),
                detail: screenTools.map(t => `${t}: ${results[t].visible ? `visible ${results[t].size.join('x')}` : 'hidden'}`).join(', ')
            },
            {
                name: 'the bar stays hidden for the volume / brush tools',
                pass: others.every(t => !results[t].visible),
                detail: others.map(t => `${t}: ${results[t].visible ? 'visible' : 'hidden'}`).join(', ')
            },
            {
                name: 'the bar carries a title, two sliders and a reset button',
                pass: rect.sliders === 2 && rect.reset === true && rect.title === '选区深度',
                detail: `sliders ${rect.sliders}, reset ${rect.reset}, title ${JSON.stringify(rect.title)}`
            },
            {
                name: 'the sliders start at the full through-pass (0 / 100)',
                pass: rect.values[0] === 0 && rect.values[1] === 100,
                detail: `${JSON.stringify(rect.values)} (range ${JSON.stringify(before)})`
            },
            {
                name: 'the 最近 slider writes the near bound',
                pass: afterNear.range.near === 30 && afterNear.range.far === 100,
                detail: `range ${JSON.stringify(afterNear.range)}, sliders ${JSON.stringify(afterNear.values)}`
            },
            {
                name: 'the 最远 slider writes the far bound and the title highlights',
                pass: afterFar.range.near === 30 && afterFar.range.far === 70 && afterFar.active,
                detail: `range ${JSON.stringify(afterFar.range)}, title active ${afterFar.active}`
            },
            {
                name: 'dragging 最近 past 最远 pushes the far handle instead of being lost',
                pass: crossed.range.near === crossed.range.far && crossed.values[0] === crossed.values[1],
                detail: `typed 100 into 最近 while 最远 was 70 -> range ${JSON.stringify(crossed.range)}, sliders ${JSON.stringify(crossed.values)}`
            },
            {
                name: 'the reset button restores 0 / 100 and drops the highlight',
                pass: afterReset.range.near === 0 && afterReset.range.far === 100 &&
                    afterReset.values[0] === 0 && afterReset.values[1] === 100 && !afterReset.active,
                detail: `range ${JSON.stringify(afterReset.range)}, sliders ${JSON.stringify(afterReset.values)}, active ${afterReset.active}`
            },
            {
                name: 'the bar hides when the tool deactivates',
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
            afterNear,
            afterFar,
            crossed,
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
