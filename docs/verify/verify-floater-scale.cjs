// Verify the 去浮云 detector's spatial scale on a model whose geometry breaks the OLD spacing estimate.
//
// Why this exists: on the user's real 931,720-gaussian scan the detector selected almost nothing
// ("现在基本上选不中浮云"). The cause was the "typical point spacing" estimate: it took the *median
// distance from the centroid* (a scene measurement) times 0.3, which on that scan gave 0.371 while
// the true median nearest-neighbour distance was 0.001637 - 226x too large. Every neighbour box was
// therefore big enough to contain hundreds of surface gaussians, so "there is nothing around this
// point" was never true. It now uses the median nearest-neighbour distance, and this model reproduces
// the failure mode with synthetic geometry (gen-floater-scale-test-splat.cjs):
//
//   shell   120,000 gaussians on a hollow sphere of radius 1 (point spacing ~0.005)
//   strays  8 gaussians at radius 1.40, i.e. 0.40 clear of the shell, normal opacity and scale
//
// Old behaviour (measured by the offline port in _tmp/predict-detector.cjs): spacing estimate 0.30,
// neighbour box half width 0.54, which reaches the shell from a stray -> 0 selected.
// New behaviour: spacing ~0.005, box half width ~0.17 -> exactly the 8 strays, no shell gaussian.
//
// usage: node docs/verify/verify-floater-scale.cjs "<url>" [model]
const path = require('path');
const puppeteer = require('C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'floater-scale-test.ply';
const GEN = path.join(__dirname, 'gen-floater-scale-test-splat.cjs');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
        await sleep(6000);

        const run = await page.evaluate(async () => {
            const scene = window.scene;
            const splats = scene.getElementsByType('splat');
            const splat = splats[splats.length - 1];
            scene.events.fire('selection', splat);
            await new Promise(r => setTimeout(r, 800));

            const panel = document.getElementById('floater-panel');
            // the panel is off by default (3.7.7 on): the header's toggle is the switch, and
            // clicking the panel header itself no longer enables it, so without this the
            // panel keeps reading "--" and only the tooltip assertions fail
            const toggle = panel.querySelector('.floater-panel-header-toggle .pcui-boolean-input-toggle');
            if (toggle) {
                toggle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
                toggle.click();
            }
            await new Promise(r => setTimeout(r, 500));

            let text = '--';
            let title = '';
            for (let i = 0; i < 60; i++) {
                await new Promise(r => setTimeout(r, 250));
                const label = panel.querySelector('.floater-panel-result');
                text = (label?.textContent || '').trim();
                title = label?.getAttribute('title') || '';
                if (text && text !== '...' && text !== '--') break;
            }

            const btn = panel.querySelector('.floater-panel-row .floater-panel-select-btn');
            btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            btn.click();
            await new Promise(r => setTimeout(r, 6000));

            const st = splat.splatData.getProp('state');
            const x = splat.splatData.getProp('x');
            const y = splat.splatData.getProp('y');
            const z = splat.splatData.getProp('z');
            let selected = 0;
            let strays = 0;
            let shell = 0;
            let minStrayRadius = Infinity;
            for (let i = 0; i < st.length; i++) {
                if (!(st[i] & 1)) continue;
                selected++;
                const r = Math.sqrt(x[i] * x[i] + y[i] * y[i] + z[i] * z[i]);
                if (r > 1.3) {
                    strays++;
                    minStrayRadius = Math.min(minStrayRadius, r);
                } else {
                    shell++;
                }
            }
            return {
                numSplats: splat.splatData.numSplats,
                countText: text,
                tooltip: title,
                selected,
                strays,
                shellPointsSelected: shell,
                minStrayRadius: Number.isFinite(minStrayRadius) ? +minStrayRadius.toFixed(3) : null
            };
        });

        // The tooltip carries the numbers the criterion used (radius = 34.5 x spacing). It is a
        // translated string, so instead of matching a label this asserts that SOME number in it is the
        // point-spacing-scale radius: the old scene-scale estimate reported 0.540, and the limit /
        // reference counts are integers far outside this window.
        const numbers = (run.tooltip.match(/[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/g) || []).map(Number);
        const spacingRadius = numbers.find(n => n > 0.08 && n < 0.3);
        const expectedStrays = gen.expected.floaterDetectorSelects;

        const checks = [
            {
                name: 'the detector finds the strays on a densely sampled surface',
                pass: run.selected === expectedStrays,
                detail: `selected ${run.selected} of ${run.numSplats}, expected ${expectedStrays} (panel said ${run.countText}); ` +
                    'the old scene-scale spacing estimate selected 0 here'
            },
            {
                name: 'every selected point is a stray, none is on the shell',
                pass: run.shellPointsSelected === 0 && run.strays === expectedStrays,
                detail: `${run.strays} strays (nearest at r=${run.minStrayRadius}, shell at r=${gen.expected.shellRadius}), ${run.shellPointsSelected} shell gaussians selected`
            },
            {
                name: 'the neighbour box is tied to the point spacing, not to the scene size',
                pass: spacingRadius !== undefined,
                detail: `tooltip numbers ${JSON.stringify(numbers)} from "${run.tooltip}"; expected a radius of about ` +
                    `${(34.5 * 0.0048).toFixed(3)} = 34.5 x the measured ~0.0048 point spacing, the old estimate gave 0.540`
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
            generated: gen.expected,
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
