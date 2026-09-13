// Verify the 去浮云 detector against synthetic models with a KNOWN floater structure, plus the
// panel's button layout.
//
// Model (gen-floater-test-splat.cjs):
//   main        3000 gaussians, a dense legitimate cloud
//   attached      40 gaussians ON its +X face, low opacity + 10x the scale  -> surface detail
//   strays         5 single gaussians alone in space                        -> real floaters
//   blobs      12/25/40 gaussian clumps 3 units away                        -> the cluster filter's job
//
// The detector used to OR four loose rules: transparency, abnormal volume, low neighbour count and
// distance from the centroid. The first two hit the surface patch (measured: all 40 selected, 117
// in total), so it selected "unusual looking" gaussians instead of floating ones. It now keys on
// "is there anything right next to this gaussian", which is blind to how big or transparent a
// surface gaussian is. This harness pins that down: exactly the strays on the floater model, and
// nothing at all on a clean model.
//
// usage: node docs/verify/verify-floater-detect.cjs "<url>" [model]
const fs = require('fs');
const path = require('path');
const puppeteer = require('C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'floater-test.ply';
const GEN = path.join(__dirname, 'gen-floater-test-splat.cjs');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const gen = JSON.parse(require('child_process').execFileSync(process.execPath, [GEN, path.join(__dirname, '..', '..', 'dist', MODEL)], { encoding: 'utf8' }));

// run the panel against one model and report the detection count, the per-signal breakdown, which
// population was selected, and the two action buttons' geometry
const inspect = async (page, model) => {
    await page.evaluate(async (m) => {
        const buf = await (await fetch('./' + m)).arrayBuffer();
        await window.scene.events.invoke('import', [{ filename: m, contents: new File([buf], m) }]);
    }, model);
    await sleep(4000);

    return page.evaluate(async () => {
        const scene = window.scene;
        const splats = scene.getElementsByType('splat');
        const splat = splats[splats.length - 1];
        scene.events.fire('selection', splat);
        await new Promise(r => setTimeout(r, 600));

        const panel = document.getElementById('floater-panel');
        // expand so the layout is measurable (a collapsed content reports zero-size boxes)
        const header = panel.querySelector('.panel-header');
        header.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise(r => setTimeout(r, 500));

        let text = '--';
        let title = '';
        for (let i = 0; i < 40; i++) {
            await new Promise(r => setTimeout(r, 250));
            const label = panel.querySelector('.floater-panel-result');
            text = (label?.textContent || '').trim();
            title = label?.getAttribute('title') || '';
            if (text && text !== '...' && text !== '--') break;
        }

        // button layout (the reported bug: 仅选中 clipped while 移除浮云 filled the row)
        const rows = Array.from(panel.querySelectorAll('.floater-panel-btn-row'));
        const layout = rows.map((row) => {
            const btns = Array.from(row.querySelectorAll('.pcui-button, button'));
            return btns.map(b => {
                const r = b.getBoundingClientRect();
                const inner = b.querySelector('.pcui-button-label') ?? b;
                return {
                    text: (b.textContent || '').trim(),
                    width: Math.round(r.width),
                    labelClipped: inner.scrollWidth > inner.clientWidth + 1
                };
            });
        });

        // select, then classify what was picked
        const btn = panel.querySelector('.floater-panel-row .floater-panel-select-btn');
        btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        btn.click();
        await new Promise(r => setTimeout(r, 2500));

        const st = splat.splatData.getProp('state');
        const x = splat.splatData.getProp('x');
        const y = splat.splatData.getProp('y');
        const z = splat.splatData.getProp('z');
        let selected = 0;
        let nearSurface = 0;      // the attached patch sits at x ~ 0.34
        let strays = 0;           // beyond 1.5 units from the origin
        for (let i = 0; i < st.length; i++) {
            if (!(st[i] & 1)) continue;
            selected++;
            const x0 = x[i]; const y0 = y[i]; const z0 = z[i];
            const r = Math.sqrt(x0 * x0 + y0 * y0 + z0 * z0);
            if (x0 > 0.3 && x0 < 0.4 && Math.abs(y0) < 0.3 && Math.abs(z0) < 0.3) nearSurface++;
            else if (r > 1.5) strays++;
        }
        return { numSplats: splat.splatData.numSplats, countText: text, breakdown: title, selected, nearSurfacePicked: nearSurface, strayPicked: strays, buttonLayout: layout };
    });
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
        await page.setViewport({ width: 1400, height: 950 });
        page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text().slice(0, 200)); });
        page.on('pageerror', e => logs.push('pageerror: ' + String(e).slice(0, 200)));
        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForFunction('!!window.scene', { timeout: 90000 });
        await sleep(1500);

        const floaterRun = await inspect(page, MODEL);

        // load the plain test model as well: it has no floaters, so nothing may be selected from it
        await page.evaluate(async () => {
            const buf = await (await fetch('./test-model.ply')).arrayBuffer();
            await window.scene.events.invoke('import', [{ filename: 'test-model.ply', contents: new File([buf], 'test-model.ply') }]);
        });
        await sleep(4000);
        const clean = await page.evaluate(async () => {
            const scene = window.scene;
            const splats = scene.getElementsByType('splat');
            const splat = splats[splats.length - 1];
            scene.events.fire('selection', splat);
            await new Promise(r => setTimeout(r, 600));
            const panel = document.getElementById('floater-panel');
            let text = '--';
            for (let i = 0; i < 40; i++) {
                await new Promise(r => setTimeout(r, 250));
                text = (panel.querySelector('.floater-panel-result')?.textContent || '').trim();
                if (text && text !== '...' && text !== '--') break;
            }
            return { numSplats: splat.splatData.numSplats, countText: text };
        });

        const expectedStrays = gen.expected.floaterDetectorSelects;
        const layout = floaterRun.buttonLayout;
        const allButtons = layout.flat();
        const rowWidthsEqual = layout.length > 0 &&
            layout.every(row => row.length === 2 && row[0].width === row[1].width && row[0].width > 20);
        const anyClipped = layout.some(row => row.some(b => b.labelClipped));

        const checks = [
            {
                name: 'the detector selects exactly the isolated strays',
                pass: floaterRun.selected === expectedStrays,
                detail: `selected ${floaterRun.selected} of ${floaterRun.numSplats}, expected ${expectedStrays} (panel said ${floaterRun.countText}, breakdown ${floaterRun.breakdown})`
            },
            {
                name: 'no surface-hugging gaussian is selected',
                pass: floaterRun.nearSurfacePicked === 0,
                detail: `${floaterRun.nearSurfacePicked} of the ${gen.surfaceHugging} low-opacity / oversized gaussians on the surface were picked (used to be all of them)`
            },
            {
                name: 'a clean model with no floaters selects nothing',
                pass: clean.countText === '0',
                detail: `test-model.ply (${clean.numSplats} gaussians): panel reported ${clean.countText}`
            },
            {
                name: 'both action buttons share the row equally',
                pass: rowWidthsEqual,
                detail: `widths ${JSON.stringify(allButtons.map(b => `${b.text}:${b.width}px`))} (a collapsed panel would report 0 and fail here)`
            },
            {
                name: 'no button label is clipped',
                pass: !anyClipped && allButtons.every(b => b.width > 20),
                detail: `clipped=${anyClipped}, widths ${JSON.stringify(allButtons.map(b => b.width))}`
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
            floaterRun,
            cleanModel: clean,
            expected: gen.expected,
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
