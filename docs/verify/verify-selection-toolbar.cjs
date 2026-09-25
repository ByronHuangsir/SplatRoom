// Headless verification for the SuperSplat-style selection toolbar:
//   - the depth / footprint mode buttons are gone (the depth range bar replaced them)
//   - grouped tool buttons (polygon+lasso, eyedropper+flood) toggle on a short
//     press and open their popup on a press-and-hold
//   - the sphere brush button activates the tool
// Reports console/page errors as well.
//
// usage: node docs/verify/verify-selection-toolbar.cjs [url]
const puppeteer = require('puppeteer-core');

const { BROWSER_PATH: EDGE } = require('./lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3100/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
    });

    const errors = [];
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        page.on('pageerror', e => errors.push('pageerror: ' + String(e).slice(0, 400)));
        page.on('console', (m) => {
            if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 400));
        });

        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForFunction('!!window.scene', { timeout: 60000 });
        await sleep(2500);

        const report = await page.evaluate(async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const events = window.scene.events;
            const out = { checks: [] };
            const check = (name, pass, detail) => out.checks.push({ name, pass, detail });

            const byId = (id) => document.getElementById(id);
            const visible = (el) => !!el && el.style.display !== 'none';
            const icons = (el) => Array.from(el.querySelectorAll('svg'));

            // --- the removed selection mode buttons (选择深度 / 选择覆盖范围) ---
            // they were replaced by the depth range bar, so the old toolbar buttons and
            // their flag API must be gone rather than left as dead controls
            check('depth toggle removed from the toolbar', !byId('bottom-toolbar-selection-mode'));
            check('footprint toggle removed from the toolbar', !byId('bottom-toolbar-selection-footprint'));
            check('the useDepth flag API is gone', events.invoke('selection.useDepth') === undefined);
            check('the footprint flag API is gone', events.invoke('selection.footprint') === undefined);
            check('the depth range API is present', typeof events.invoke('selection.depthRange') === 'object');

            // --- grouped tool buttons ---
            const polygonGroup = byId('bottom-toolbar-polygon');
            const eyedropperGroup = byId('bottom-toolbar-eyedropper');
            check('polygon group exists', !!polygonGroup);
            check('eyedropper group exists', !!eyedropperGroup);
            if (!polygonGroup || !eyedropperGroup) return out;

            check('polygon group is marked as a group', polygonGroup.classList.contains('bottom-toolbar-group'));
            check('polygon group has 2 tool icons', icons(polygonGroup).length === 2, icons(polygonGroup).length);
            check('eyedropper group has 2 tool icons', icons(eyedropperGroup).length === 2, icons(eyedropperGroup).length);

            // short press toggles the current tool
            const click = (el) => {
                el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 }));
                el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1 }));
            };
            click(polygonGroup);
            await sleep(200);
            check('polygon group short press activates polygonSelection', events.invoke('tool.active') === 'polygonSelection');

            // after activation the group should show the polygon icon and be active
            check('polygon group shows active state', polygonGroup.classList.contains('active'));

            // holding opens the popup with both tools listed
            polygonGroup.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 2 }));
            await sleep(600);
            const popups = Array.from(document.querySelectorAll('#bottom-toolbar .menu-panel')).filter(p => !p.classList.contains('pcui-hidden'));
            check('hold opens a popup', popups.length === 1, popups.length);
            if (popups.length) {
                const rows = popups[0].querySelectorAll('.menu-row');
                check('popup lists both group tools', rows.length === 2, rows.length);
                popups[0].hidden = true;
            }
            polygonGroup.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 2 }));

            // eyedropper group short press
            click(eyedropperGroup);
            await sleep(200);
            check('eyedropper group toggles eyedropperSelection', events.invoke('tool.active') === 'eyedropperSelection');

            // --- sphere brush button ---
            const sphereBrush = byId('bottom-toolbar-sphere-brush');
            check('sphere brush button exists', !!sphereBrush);
            if (sphereBrush) {
                sphereBrush.click();
                await sleep(200);
                check('sphere brush button activates the tool', events.invoke('tool.active') === 'sphereBrushSelection');
                events.fire('tool.deactivate');
            }

            // flat tool buttons still work
            const picker = byId('bottom-toolbar-picker');
            picker.click();
            await sleep(200);
            check('rect button activates rectSelection', events.invoke('tool.active') === 'rectSelection');
            events.fire('tool.deactivate');

            return out;
        });

        const failed = report.checks.filter(c => !c.pass);
        console.log(JSON.stringify({ ...report, failed: failed.length, errors }, null, 2));
        if (failed.length) process.exitCode = 1;
    } catch (err) {
        console.log(JSON.stringify({ fatal: String(err).slice(0, 700), errors }, null, 2));
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
