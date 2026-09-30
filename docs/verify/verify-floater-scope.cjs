// Verify the 去浮云 detector's Scope control (处理范围), which exists because walls / windows / floor /
// tabletop on real scans are sampled as coarsely as the floaters themselves: no point-local statistic can
// tell them apart (measured on the user's 931k scan - see docs/V3-WebGPU-现状.md 6.31), so the workflow
// answer is to let the selection decide where the tool may act.
//
//   whole model     - default, every valid gaussian is a candidate
//   selection only  - only gaussians that are currently selected are candidates
//   skip selection  - everything except the current selection
//
// The model is gen-floater-test-splat.cjs: a dense main cloud, a surface patch, 5 isolated strays and 3
// opaque detached islands. Rows are marked as selected by setting State.selected (bit 0) on the state
// property, which is exactly what the brush / box / footprint tools do.
//
// usage: node docs/verify/verify-floater-scope.cjs "<url>" [model]
const path = require('path');
const puppeteer = require('puppeteer-core');

const { BROWSER_PATH: EDGE , launchPatched: _launchPatched } = require('./lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'floater-test.ply';
const GEN = path.join(__dirname, 'gen-floater-test-splat.cjs');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const gen = JSON.parse(require('child_process').execFileSync(process.execPath, [GEN, path.join(__dirname, '..', '..', 'dist', MODEL)], { encoding: 'utf8' }));

(async () => {
    const logs = [];
    const browser = await _launchPatched(puppeteer, {
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
    });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1400, height: 950 });
        page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text().slice(0, 200)); });
        page.on('pageerror', e => logs.push('pageerror: ' + String(e).slice(0, 200)));
        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForFunction('!!window.scene', { timeout: 90000 });
        await sleep(1500);

        await page.evaluate(async (m) => {
            const buf = await (await fetch('./' + m)).arrayBuffer();
            await window.scene.events.invoke('import', [{ filename: m, contents: new File([buf], m) }]);
        }, MODEL);
        await sleep(5000);

        const run = await page.evaluate(async () => {
            const scene = window.scene;
            const splats = scene.getElementsByType('splat');
            const splat = splats[splats.length - 1];
            scene.events.fire('selection', splat);
            await new Promise(r => setTimeout(r, 800));

            const panel = document.getElementById('floater-panel');
            panel.querySelector('.panel-header').dispatchEvent(new MouseEvent('click', { bubbles: true }));
            await new Promise(r => setTimeout(r, 500));

            // the panel is off by default now, so switch the detector on before reading counts
            const toggle = panel.querySelector('.floater-panel-header-toggle .pcui-boolean-input-toggle');
            if (toggle) {
                toggle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
                toggle.click();
            }
            await new Promise(r => setTimeout(r, 300));

            const label = () => panel.querySelector('.floater-panel-result');
            const waitFor = async (avoid = '...') => {
                for (let i = 0; i < 80; i++) {
                    const t = (label()?.textContent || '').trim();
                    if (t && t !== avoid && t !== '--') return t;
                    await new Promise(r => setTimeout(r, 100));
                }
                return 'timeout';
            };

            const st = splat.splatData.getProp('state');
            const x = splat.splatData.getProp('x');
            const y = splat.splatData.getProp('y');
            const z = splat.splatData.getProp('z');
            const isStray = (i) => Math.hypot(x[i], y[i], z[i]) > 1.5;

            // PCUI SelectInput renders each option as a Label whose DOM id is the option value
            const pickScope = async (value) => {
                const option = panel.querySelector(`#${value}`);
                if (!option) return false;
                option.click();
                await new Promise(r => setTimeout(r, 200));
                return true;
            };

            const clearSelection = () => { for (let i = 0; i < st.length; i++) st[i] &= ~1; };

            // 1) baseline: whole model
            const baseline = await waitFor();

            // 2) selection only, with the DENSE main cloud selected (no floaters in scope)
            clearSelection();
            let picked = 0;
            for (let i = 0; i < st.length && picked < 500; i++) {
                if (!isStray(i)) { st[i] |= 1; picked++; }
            }
            const okSelection = await pickScope('selection');
            await new Promise(r => setTimeout(r, 400));
            const onlyMainCloudInScope = await waitFor();

            // 3) skip selection with the same dense rows selected: the strays are outside it
            const okExclude = await pickScope('exclude');
            await new Promise(r => setTimeout(r, 400));
            const straysOutsideScope = await waitFor();

            // 4) apply "select only" in that state: the mask must be the strays, and the previous
            //    selection (the dense rows) must be replaced
            const btn = panel.querySelector('.floater-panel-row .floater-panel-select-btn');
            btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            btn.click();
            await new Promise(r => setTimeout(r, 2500));
            let selectedAfter = 0;
            let straysSelected = 0;
            for (let i = 0; i < st.length; i++) {
                if (st[i] & 1) {
                    selectedAfter++;
                    if (isStray(i)) straysSelected++;
                }
            }

            // 5) back to the whole model
            const okAll = await pickScope('all');
            await new Promise(r => setTimeout(r, 400));
            const backToAll = await waitFor();

            return {
                numSplats: splat.splatData.numSplats,
                baseline, onlyMainCloudInScope, straysOutsideScope, backToAll,
                scopeOptionFound: okSelection && okExclude && okAll,
                selectedAfterApply: selectedAfter,
                straysSelectedAfterApply: straysSelected,
                tooltip: label()?.getAttribute('title') || ''
            };
        });

        const strays = gen.expected.strays;
        const checks = [
            {
                name: 'whole model scope finds the isolated strays (baseline)',
                pass: run.baseline === `${strays}`,
                detail: `panel reported ${run.baseline}, expected ${strays}`
            },
            {
                name: 'selection-only scope ignores floaters outside the selection',
                pass: run.onlyMainCloudInScope === '0',
                detail: `with 500 dense main-cloud rows selected and scope "selection only" the count is ${run.onlyMainCloudInScope} (expected 0: nothing inside that selection is isolated)`
            },
            {
                name: 'skip-selection scope still finds floaters outside the selection',
                pass: run.straysOutsideScope === `${strays}`,
                detail: `same selection, scope "skip selection": count ${run.straysOutsideScope} (expected ${strays})`
            },
            {
                name: 'the applied selection is the mask, and the previous selection is replaced',
                pass: run.selectedAfterApply === strays && run.straysSelectedAfterApply === strays,
                detail: `${run.selectedAfterApply} rows selected after the action (${run.straysSelectedAfterApply} of them strays; the 500 manually marked rows must be gone)`
            },
            {
                name: 'switching back to whole model restores the full count',
                pass: run.backToAll === `${strays}`,
                detail: `count ${run.backToAll} (expected ${strays})`
            },
            {
                name: 'the scope control is reachable in the panel',
                pass: run.scopeOptionFound === true,
                detail: `tooltip: ${run.tooltip}`
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
            model: MODEL,
            run,
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
