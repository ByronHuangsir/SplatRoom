// Verify the connected-cluster filter (去浮云 面板 → 连通簇) against a synthetic model with a
// known cluster structure: a dense main cloud plus three small separated blobs of 12 / 25 / 40
// gaussians (see gen-cluster-test-splat.cjs).
//
// Checks: the voxel connectivity groups them into exactly 4 clusters with the main cloud as the
// largest; "small" mode (default threshold 2% of the largest = 60) flags exactly the three blobs
// (77 gaussians) and never the main cloud; "Select only" selects exactly that many without
// deleting; "Remove" deletes exactly those and leaves the main cloud; one undo restores them.
//
// usage: node docs/verify/verify-cluster-filter.cjs "<url>" [model]
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const { BROWSER_PATH: EDGE } = require('./lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'cluster-test.ply';
const GEN = path.join(__dirname, 'gen-cluster-test-splat.cjs');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// regenerate the synthetic model next to the served bundle so the expectations below hold
const gen = JSON.parse(require('child_process').execFileSync(process.execPath, [GEN, path.join(__dirname, '..', '..', 'dist', MODEL)], { encoding: 'utf8' }));

(async () => {
    const logs = [];
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
    });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });
        page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text().slice(0, 200)); });
        page.on('pageerror', e => logs.push('pageerror: ' + String(e).slice(0, 200)));
        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForFunction('!!window.scene', { timeout: 90000 });
        await sleep(1500);
        await page.evaluate(async (model) => {
            const buf = await (await fetch('./' + model)).arrayBuffer();
            await window.scene.events.invoke('import', [{ filename: model, contents: new File([buf], model) }]);
        }, MODEL);
        await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 300000 });
        await sleep(3000);

        const backend = await page.evaluate(() => (window.scene.graphicsDevice.isWebGPU ? 'webgpu' : 'webgl2'));

        // select the model element and enable the panel, then read what the cluster section reports
        const setup = await page.evaluate(async () => {
            const scene = window.scene;
            const splat = scene.getElementsByType('splat')[0];
            scene.events.fire('selection', splat);
            await new Promise(r => setTimeout(r, 400));

            const panel = document.getElementById('floater-panel');
            // the panel is off by default (3.7.7 on): the switch is the toggle inside the
            // header row. A click on the wrapper (pcui-boolean-input) does not flip it, so
            // aim at the toggle element itself the way verify-floater-detect does.
            const toggleEl = panel.querySelector('.floater-panel-header-toggle .pcui-boolean-input-toggle');
            if (toggleEl) {
                toggleEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
                toggleEl.click();
            }
            await new Promise(r => setTimeout(r, 1500));   // debounced detection

            const results = Array.from(panel.querySelectorAll('.floater-panel-result'));
            return {
                numSplats: splat.splatData.numSplats,
                resultTexts: results.map(el => (el.textContent || '').trim()),
                titles: results.map(el => el.getAttribute('title') || '')
            };
        });

        const state = () => page.evaluate(() => {
            const splat = window.scene.getElementsByType('splat')[0];
            const st = splat.splatData.getProp('state');
            let sel = 0;
            let del = 0;
            for (let i = 0; i < st.length; i++) {
                if (st[i] & 1) sel++;
                if (st[i] & 4) del++;
            }
            return { selected: sel, deleted: del, numSplats: splat.numSplats, numSelected: splat.numSelected, numDeleted: splat.numDeleted };
        });

        const clickCluster = (which) => page.evaluate(async (w) => {
            const panel = document.getElementById('floater-panel');
            const rows = Array.from(panel.querySelectorAll('.floater-panel-row'));
            // the cluster action row is the last one holding a button
            const rowsWithButtons = rows.filter(r => r.querySelector('button, .pcui-button'));
            const row = rowsWithButtons[rowsWithButtons.length - 1];
            const btns = Array.from(row.querySelectorAll('button, .pcui-button'));
            const btn = w === 'remove' ? btns[btns.length - 1] : btns[0];
            btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            btn.click();
            await new Promise(r => setTimeout(r, 2500));
        }, which);

        const before = await state();

        // 1) select only
        await clickCluster('select');
        const afterSelect = await state();

        // 2) remove
        await clickCluster('remove');
        const afterRemove = await state();

        // 3) undo
        await page.evaluate(() => window.scene.events.fire('edit.undo'));
        await sleep(2500);
        const afterUndo = await state();

        const expected = gen.expectedSmallMask;
        const range = (v, target, tolPct) => Math.abs(v - target) <= Math.max(2, target * tolPct);
        const clusterTitle = setup.titles[1] || '';

        const checks = [
            {
                name: 'the panel reports the cluster structure of the synthetic model',
                pass: /4\b/.test(setup.resultTexts[1] || '') && /3000/.test(clusterTitle),
                detail: `cluster row text ${JSON.stringify(setup.resultTexts[1])}, tooltip ${JSON.stringify(clusterTitle)} (expected 4 clusters, largest ${gen.main})`
            },
            {
                name: 'select-only flags exactly the three small blobs',
                pass: range(afterSelect.selected, expected, 0.05) && afterSelect.deleted === 0,
                detail: `selected ${afterSelect.selected} (expected ${expected} = 12+25+40), deleted ${afterSelect.deleted}`
            },
            {
                name: 'remove deletes exactly those gaussians and keeps the main cloud',
                pass: range(afterRemove.deleted, expected, 0.05) && afterRemove.numSplats === gen.main,
                detail: `deleted ${afterRemove.deleted} (expected ${expected}), live splats ${afterRemove.numSplats} (expected ${gen.main})`
            },
            {
                name: 'one undo brings the blobs back',
                pass: afterUndo.deleted === before.deleted && afterUndo.numSplats === before.numSplats,
                detail: `deleted ${afterRemove.deleted} -> ${afterUndo.deleted}, live splats ${afterRemove.numSplats} -> ${afterUndo.numSplats}`
            },
            {
                name: 'no console errors',
                pass: logs.length === 0,
                detail: logs.length ? JSON.stringify(logs.slice(0, 3)) : 'clean'
            }
        ];

        console.log(JSON.stringify({
            backend,
            url: URL,
            model: MODEL,
            setup,
            before,
            afterSelect,
            afterRemove,
            afterUndo,
            expected: { clusters: gen.expectedClusters, largestSize: gen.main, smallMask: expected },
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
