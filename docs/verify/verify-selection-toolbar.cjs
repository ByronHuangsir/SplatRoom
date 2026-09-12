// Headless verification for the SuperSplat-style selection toolbar:
//   - the depth / footprint mode toggles exist, swap icons and drive the flags
//   - grouped tool buttons (polygon+lasso, eyedropper+flood) toggle on a short
//     press and open their popup on a press-and-hold
//   - the sphere brush button activates the tool
// Reports console/page errors as well.
//
// usage: node docs/verify/verify-selection-toolbar.cjs [url]
const puppeteer = require('C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
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

            // --- the two selection mode toggles ---
            const depthBtn = byId('bottom-toolbar-selection-mode');
            const footBtn = byId('bottom-toolbar-selection-footprint');
            check('depth toggle exists', !!depthBtn);
            check('footprint toggle exists', !!footBtn);
            if (!depthBtn || !footBtn) return out;

            check('depth toggle has 2 icons', icons(depthBtn).length === 2, icons(depthBtn).length);
            check('footprint toggle has 2 icons', icons(footBtn).length === 2, icons(footBtn).length);

            // initial state: depth off, footprint 0 -> off icon + centers icon
            const depthIcons = icons(depthBtn);
            const footIcons = icons(footBtn);
            check('depth starts with the off icon', visible(depthIcons[1]) && !visible(depthIcons[0]));
            check('footprint starts on centers', visible(footIcons[0]) && !visible(footIcons[1]));

            // click depth -> flag on, icon swapped, aria-pressed
            depthBtn.click();
            await sleep(150);
            check('depth click sets the flag', events.invoke('selection.useDepth') === true);
            check('depth click swaps the icon', visible(depthIcons[0]) && !visible(depthIcons[1]));
            check('depth aria-pressed updated', depthBtn.getAttribute('aria-pressed') === 'true');
            depthBtn.click();
            await sleep(150);
            check('depth click toggles back', events.invoke('selection.useDepth') === false);

            // click footprint -> footprint 1, rings icon
            footBtn.click();
            await sleep(150);
            check('footprint click sets the value', events.invoke('selection.footprint') === 1);
            check('footprint click swaps the icon', visible(footIcons[1]) && !visible(footIcons[0]));
            check('footprint aria-pressed updated', footBtn.getAttribute('aria-pressed') === 'true');
            footBtn.click();
            await sleep(150);
            check('footprint click toggles back', events.invoke('selection.footprint') === 0);

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
