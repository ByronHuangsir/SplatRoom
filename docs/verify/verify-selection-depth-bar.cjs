// Verify the selection depth bar: it appears when a screen-space selection tool is activated, hides for
// other tools, and its toggle + slider drive the selection depth (useDepth / depthThickness).
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
        await sleep(4000);
        await page.evaluate(() => {
            const scene = window.scene;
            scene.events.fire('selection', scene.getElementsByType('splat').slice(-1)[0]);
        });
        await sleep(400);

        const barState = () => page.evaluate(() => {
            const bar = document.getElementById('selection-depth-bar');
            if (!bar) {
                return { exists: false };
            }
            const hidden = bar.classList.contains('pcui-hidden');
            const rect = bar.getBoundingClientRect();
            const slider = bar.querySelector('.pcui-slider');
            const toggle = bar.querySelector('.pcui-boolean-input-toggle');
            const labels = Array.from(bar.querySelectorAll('.select-toolbar-label')).map(l => (l.textContent || '').trim());
            const numeric = bar.querySelector('.pcui-numeric-input input');
            return {
                exists: true,
                hidden,
                visible: !hidden && rect.width > 50 && rect.height > 10,
                size: [Math.round(rect.width), Math.round(rect.height)],
                labels,
                sliderValue: numeric ? Number(numeric.value) : null,
                sliderExists: !!slider,
                toggleExists: !!toggle,
                dimmed: !!bar.querySelector('.pcui-slider.dimmed')
            };
        });

        const activate = async (tool) => {
            // tool events toggle, so deactivate first to make the call deterministic
            await page.evaluate(() => window.scene.events.fire('tool.deactivate'));
            await sleep(300);
            await page.evaluate((t) => window.scene.events.fire(`tool.${t}`), tool);
            await sleep(700);
            return barState();
        };

        const results = {};
        for (const tool of ['rectSelection', 'lassoSelection', 'polygonSelection', 'brushSelection', 'sphereBrushSelection', 'sphereSelection']) {
            results[tool] = await activate(tool);
        }

        // with the rect tool active, drive the toggle and the slider from the bar
        const rect = await activate('rectSelection');
        const flagsBefore = await page.evaluate(() => ({
            useDepth: window.scene.events.invoke('selection.useDepth'),
            thickness: window.scene.events.invoke('selection.depthThickness')
        }));

        // toggle depth on via the bar's switch
        await page.evaluate(() => {
            const bar = document.getElementById('selection-depth-bar');
            const toggle = bar.querySelector('.pcui-boolean-input-toggle');
            toggle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            toggle.click();
        });
        await sleep(500);
        const afterToggle = await page.evaluate(() => ({
            useDepth: window.scene.events.invoke('selection.useDepth'),
            dimmed: !!document.querySelector('#selection-depth-bar .pcui-slider.dimmed')
        }));

        // set the thickness through the slider's numeric field (typing a value fires change)
        await page.evaluate(() => {
            const bar = document.getElementById('selection-depth-bar');
            const input = bar.querySelector('.pcui-numeric-input input');
            input.focus();
            input.value = '6';
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.blur();
        });
        await sleep(600);
        const afterSlider = await page.evaluate(() => ({
            thickness: window.scene.events.invoke('selection.depthThickness'),
            sliderValue: Number(document.querySelector('#selection-depth-bar .pcui-numeric-input input').value)
        }));

        // reset for the other tests
        await page.evaluate(() => {
            window.scene.events.fire('selection.setDepthThickness', 0);
            window.scene.events.fire('selection.setUseDepth', false);
            window.scene.events.fire('tool.deactivate');
        });
        await sleep(300);
        const afterDeactivate = await barState();
        await page.evaluate(() => window.scene.events.fire('selection.setUseDepth', false));

        const screenTools = ['rectSelection', 'lassoSelection', 'polygonSelection', 'brushSelection'];
        const others = ['sphereBrushSelection', 'sphereSelection'];

        const checks = [
            {
                name: 'the depth bar appears for every screen-space selection tool',
                pass: screenTools.every(t => results[t].visible),
                detail: screenTools.map(t => `${t}: ${results[t].visible ? `visible ${results[t].size.join('x')}` : 'hidden'}`).join(', ')
            },
            {
                name: 'it stays hidden for tools that bring their own controls',
                pass: others.every(t => !results[t].visible),
                detail: others.map(t => `${t}: ${results[t].visible ? 'visible' : 'hidden'}`).join(', ')
            },
            {
                name: 'it carries a depth toggle and a thickness slider with localised labels',
                pass: rect.sliderExists && rect.toggleExists && rect.labels.length >= 2 && rect.labels.every(l => l.length > 0),
                detail: `labels ${JSON.stringify(rect.labels)}, slider ${rect.sliderExists}, toggle ${rect.toggleExists}`
            },
            {
                name: 'the toggle switches depth mode',
                pass: afterToggle.useDepth === true && afterToggle.dimmed === false,
                detail: `useDepth ${flagsBefore.useDepth} -> ${afterToggle.useDepth}, slider dimmed ${afterToggle.dimmed}`
            },
            {
                name: 'the slider sets the depth thickness',
                pass: afterSlider.thickness === 6 && afterSlider.sliderValue === 6,
                detail: `flag ${afterSlider.thickness}, slider shows ${afterSlider.sliderValue}`
            },
            {
                name: 'the bar hides again when the tool is deactivated',
                pass: afterDeactivate.hidden === true,
                detail: `hidden ${afterDeactivate.hidden}`
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
            results,
            flagsBefore,
            afterToggle,
            afterSlider,
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
