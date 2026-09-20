// Range sliders: dragging a block OUTWARD must select more (the region outside the gesture box), and
// dragging it back INWARD must still shrink the selection on the very first small move.
//
// Why this exists: the panel has two blocks per axis and they used to move BOTH the core window and the
// outer window together (margin 0), while "outside the drawn shape" can only be selected through the
// band between core and outer (`selection-core.ts`: outside the outer window → dropped; inside the band
// → selected regardless of shape; inside the core → the drawn shape decides). With the band always
// empty, expansion was structurally impossible — measured on the 20M fixture: screen range pushed
// outward (-40/140) left the count at 8506, pushed inward (40/60) dropped it to 174. Reported by the
// user as "选取范围滑块依然只能收缩，不能扩展".
//
// The fix gives the two blocks a two-way meaning: dragging away from the grab point grows `outer`
// (core stays on the box, so the band outside the shape gets selected), dragging toward it shrinks
// `low`/`high` (+ outer, margin preserved) exactly as before.
//
// usage: node docs/verify/verify-range-expand.cjs "<url>" [model]
const puppeteer = require('puppeteer-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const BAR = '#selection-range-bar';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
    });
    const errors = [];
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1500);
    await page.evaluate(async (m) => {
        const buf = await (await fetch('./' + m)).arrayBuffer();
        window.__loadErr = null;
        window.scene.events.invoke('import', [{ filename: m, contents: new File([buf], m) }])
            .catch((e) => { window.__loadErr = String(e).slice(0, 200); });
    }, MODEL);
    for (let i = 0; i < 60; i++) {
        await sleep(1000);
        const n = await page.evaluate(() => window.scene.getElementsByType('splat').length);
        if (n > 0) break;
    }
    await sleep(3000);

    const selected = () => page.evaluate(() => {
        const splat = window.scene.getElementsByType('splat').slice(-1)[0];
        const state = splat.splatData.getProp('state');
        const total = splat.splatData.numSplats;
        let n = 0;
        for (let i = 0; i < total; i++) {
            if ((state[i] & 1) !== 0) n++;
        }
        return n;
    });

    // drag one block along its track with a REAL mouse (the control captures the pointer)
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
        await sleep(400);
    };

    const bandWidth = (axis) => page.evaluate((selector, a) => {
        const row = document.querySelector(`${selector} .select-range-row[data-axis="${a}"]`);
        const band = row.querySelector('.select-range-core');
        return Math.round(band.getBoundingClientRect().width);
    }, BAR, axis);

    const checks = [];
    const check = (name, pass, detail) => checks.push({ name, pass, detail });

    try {
        // Activate a range-capable tool first: the panel only exists/is visible for
        // rect / lasso / polygon / brush / flood selection (see TOOLS_WITH_RANGE in
        // src/ui/selection-depth-bar.ts). Without this the bar is `pcui-hidden` at zero size, the
        // mouse drags land on the canvas instead, and every measurement reads the same number.
        await page.evaluate(() => {
            window.scene.events.fire('tool.deactivate');
            window.scene.events.fire('tool.rectSelection');
        });
        await sleep(800);

        // a small box in the middle, so there is plenty of model outside it
        await page.evaluate(() => {
            window.scene.events.invoke('select.rect', 'set', { start: { x: 0.4, y: 0.4 }, end: { x: 0.6, y: 0.6 } });
        });
        await sleep(2500);
        const base = await selected();
        const baseBand = await bandWidth('x');
        check('the range panel is visible and laid out',
            baseBand > 0,
            `band width = ${baseBand} px (0 means the panel was hidden and the drags missed it)`);

        // ---- 1. outward drag on 左 must ADD splats (this was impossible before) ----
        await dragBlock('x', 'low', -70);
        const expanded = await selected();
        const expandedBand = await bandWidth('x');
        check('dragging 左 OUTWARD selects more than the box',
            base > 0 && expanded > base,
            `selected ${base} -> ${expanded} after dragging 左 outward by 70 px`);
        check('the selected band grows while expanding (visible feedback)',
            expandedBand > baseBand,
            `band width ${baseBand} -> ${expandedBand} px`);

        // ---- 2. the very first small INWARD move must still shrink ----
        await dragBlock('x', 'low', 20);
        const shrunk = await selected();
        check('the first small INWARD move already shrinks the selection',
            shrunk < expanded,
            `selected ${expanded} -> ${shrunk} after dragging 左 inward by 20 px`);

        // ---- 3. the same two-way behaviour on the depth axis ----
        // Depth outward has nothing to add: 0..100 IS the model's own depth range
        // (selection-flags.ts says so explicitly), so the honest assertion is "it must not shrink".
        // For inward, assert on the **reported range value** rather than on the splat count: whether a
        // 25 px push cuts anything depends on the model's depth distribution (this fixture is two flat
        // walls, and the suite for the panel already documents that a small model may legitimately
        // drop nothing). The user-visible "first small move does something" requirement is asserted on
        // the screen axes above, where the box really does exclude splats.
        const depthRange = () => page.evaluate(() => window.scene.events.invoke('selection.depthRange'));
        const beforeDepthRange = await depthRange();
        const beforeDepth = await selected();
        await dragBlock('depth', 'low', -70);
        const depthOut = await selected();
        const afterDepthOutRange = await depthRange();
        check('dragging 最近 OUTWARD does not shrink the selection',
            depthOut >= beforeDepth,
            `selected ${beforeDepth} -> ${depthOut} (depth 0..100 already spans the model)`);
        check('dragging 最近 OUTWARD does not pull the reported range the wrong way',
            !afterDepthOutRange || afterDepthOutRange.near <= (beforeDepthRange ? beforeDepthRange.near : 0) + 0.5,
            `depth near ${beforeDepthRange ? beforeDepthRange.near : 'n/a'} -> ${afterDepthOutRange ? afterDepthOutRange.near : 'n/a'}`);
        await dragBlock('depth', 'low', 90);
        const afterDepthInRange = await depthRange();
        check('dragging 最近 INWARD moves the range (toward the near end)',
            afterDepthInRange && afterDepthOutRange && afterDepthInRange.near > afterDepthOutRange.near,
            `depth near ${afterDepthOutRange ? afterDepthOutRange.near : 'n/a'} -> ${afterDepthInRange ? afterDepthInRange.near : 'n/a'} after a 90 px inward push`);

        // ---- 4. reset returns to the full box ----
        await page.evaluate(() => {
            const btn = document.querySelector('#selection-range-bar .select-toolbar-button');
            if (btn) {
                btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
                btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
                btn.click();
            }
        });
        await sleep(2000);
        const afterReset = await selected();
        const afterResetRange = await depthRange();
        check('reset restores the full box range',
            afterResetRange && afterResetRange.near === 0 && afterResetRange.far === 100,
            `depth range after reset = ${JSON.stringify(afterResetRange)}, selected ${afterReset} (box was ${base})`);
    } catch (e) {
        check('suite ran without throwing', false, String(e).slice(0, 200));
    }

    console.log(JSON.stringify({ checks, failed: checks.filter((c) => !c.pass).length, errors: errors.slice(0, 5) }, null, 1));
    await browser.close();
    process.exit(0);
})().catch((e) => {
    console.log(JSON.stringify({ fatal: String(e).slice(0, 400) }));
    process.exit(1);
});
