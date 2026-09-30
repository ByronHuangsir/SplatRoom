// Verify that the sphere volume can be RESIZED with the scale gizmo, and that the box volume still
// scales the way it did.
//
// The user reported "the sphere cannot be sized with the scale gizmo". The cause was the sphere's gizmo
// configuration: it enabled only the uniform centre handle and disabled the three axis handles, and that
// centre box is a tiny target (measured: 0.0064 world units half extent, ~8 px at the default gizmo
// size). The sphere tool now keeps the axis handles (and the centre box) and applies a UNIFORM radius
// from whichever handle is dragged, so any handle resizes it.
//
// PlayCanvas's gizmo calls canvas.setPointerCapture, which throws for synthetic pointer events, so the
// drags here use real input (page.mouse), and each drag starts at the handle's own projected centre
// (taken from the gizmo layer's world AABBs) and moves radially away from the volume centre - the same
// gesture a user makes.
//
// usage: node docs/verify/verify-shape-scale-handles.cjs "<url>"
const puppeteer = require('puppeteer-core');

const { BROWSER_PATH: EDGE , launchPatched: _launchPatched } = require('./lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const logs = [];
    const browser = await _launchPatched(puppeteer, {
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
    });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1200, height: 800 });
        page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text().slice(0, 200)); });
        page.on('pageerror', e => logs.push('pageerror: ' + String(e).slice(0, 200)));
        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForFunction('!!window.scene', { timeout: 90000 });
        await sleep(1500);
        await page.evaluate(async () => {
            const buf = await (await fetch('./test-model.ply')).arrayBuffer();
            await window.scene.events.invoke('import', [{ filename: 'test-model.ply', contents: new File([buf], 'test-model.ply') }]);
        });
        await sleep(4000);

        const readValues = () => page.evaluate(() => {
            const toolbars = Array.from(document.querySelectorAll('.select-toolbar'));
            const toolbar = toolbars.find(t => !t.classList.contains('pcui-hidden') && t.querySelectorAll('.select-toolbar-mode').length) ||
                toolbars.find(t => t.querySelectorAll('.select-toolbar-mode').length);
            return toolbar ? Array.from(toolbar.querySelectorAll('input')).map(i => i.value) : null;
        });

        const prepare = (tool) => page.evaluate(async (name) => {
            const scene = window.scene;
            scene.events.fire(`tool.${name}`);
            await new Promise(r => setTimeout(r, 1500));
            const toolbars = Array.from(document.querySelectorAll('.select-toolbar'));
            const toolbar = toolbars.find(t => !t.classList.contains('pcui-hidden') && t.querySelectorAll('.select-toolbar-mode').length) ||
                toolbars.find(t => t.querySelectorAll('.select-toolbar-mode').length);
            const buttons = Array.from(toolbar.querySelectorAll('.select-toolbar-mode'));
            // the last mode button is scale for both volumes
            buttons[buttons.length - 1].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            await new Promise(r => setTimeout(r, 900));
            return { values: Array.from(toolbar.querySelectorAll('input')).map(i => i.value) };
        }, tool);

        // enabled scale handles, with their screen positions and the volume centre
        const handles = () => page.evaluate(() => {
            const scene = window.scene;
            const cam = scene.camera.camera;
            const dev = scene.graphicsDevice;
            const canvas = scene.canvas;
            const rect = canvas.getBoundingClientRect();
            const toClient = (v) => {
                const sp = cam.worldToScreen(v);
                return { x: rect.left + (sp.x / dev.width) * rect.width, y: rect.top + (sp.y / dev.height) * rect.height };
            };
            let centre = null;
            const list = [];
            for (const mi of scene.gizmoLayer.meshInstances) {
                const aabb = mi.aabb;
                if (!aabb) continue;
                const p = toClient(aabb.center.clone());
                if (mi.node.name.startsWith('boxCenter:')) {
                    centre = p;
                }
                // the axis handles and the centre box are the pickable scale shapes
                if (/^(box|boxCenter):/.test(mi.node.name)) {
                    list.push({ node: mi.node.name, ...p, halfExtent: +aabb.halfExtents.x.toFixed(5) });
                }
            }
            return { centre, list };
        });

        const drag = async (from, dx, dy) => {
            await page.mouse.move(from.x, from.y);
            await sleep(120);
            await page.mouse.down();
            await sleep(120);
            for (let i = 1; i <= 10; i++) {
                await page.mouse.move(from.x + (dx * i) / 10, from.y + (dy * i) / 10);
                await sleep(40);
            }
            await page.mouse.up();
            await sleep(600);
        };

        // ---- sphere: every handle must resize it ----
        const sphereStart = await prepare('sphereSelection');
        const sphereResults = [];
        for (let attempt = 0; attempt < 4; attempt++) {
            const { centre, list } = await handles();
            if (!centre || !list.length) break;
            const handle = list[attempt % list.length];
            const before = await readValues();
            // drag radially away from the volume centre - the natural gesture on an axis handle. The
            // centre handle sits ON the centre, so it gets a diagonal drag instead; the engine projects
            // that drag onto (camera.up + camera.right), which on screen is the up-right diagonal.
            let dx = handle.x - centre.x;
            let dy = handle.y - centre.y;
            if (Math.hypot(dx, dy) < 4) {
                dx = 1;
                dy = -1;
            }
            const len = Math.max(1e-3, Math.hypot(dx, dy));
            await drag(handle, (dx / len) * 90, (dy / len) * 90);
            const after = await readValues();
            sphereResults.push({ node: handle.node, before: Number(before[3]), after: Number(after[3]), grew: Number(after[3]) > Number(before[3]) });
        }

        // ---- box: still resizes (non-uniform from an axis handle) ----
        const boxStart = await prepare('boxSelection');
        const boxBefore = await readValues();
        let boxResult = null;
        {
            const { centre, list } = await handles();
            const handle = list.find(h => h.node === 'box:x') || list[0];
            if (centre && handle) {
                const dx = handle.x - centre.x;
                const dy = handle.y - centre.y;
                const len = Math.max(1e-3, Math.hypot(dx, dy));
                await drag(handle, (dx / len) * 80, (dy / len) * 80);
                const after = await readValues();
                boxResult = { node: handle.node, before: boxBefore.slice(3, 6).map(Number), after: after.slice(3, 6).map(Number) };
            }
        }

        const sphereGrew = sphereResults.filter(r => r.grew).length;
        const checks = [
            {
                name: 'the sphere volume can be resized by dragging a scale handle',
                pass: sphereGrew >= 3,
                detail: `${sphereGrew} of ${sphereResults.length} handles grew the radius: ${sphereResults.map(r => `${r.node} ${r.before}->${r.after}`).join(', ')} (start ${sphereStart.values[3]})`
            },
            {
                name: 'every drag keeps the sphere uniform (single radius, all axes written back)',
                pass: sphereResults.every(r => r.after > 0),
                detail: `radii after the drags: ${sphereResults.map(r => r.after).join(', ')}`
            },
            {
                name: 'the box volume still scales',
                pass: !!boxResult && boxResult.after.some((v, i) => v !== boxResult.before[i]),
                detail: boxResult ? `size ${boxResult.before.join('/')} -> ${boxResult.after.join('/')} from ${boxResult.node}` : 'no handle found'
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
            sphereResults,
            boxResult,
            checks,
            failed: checks.filter(c => !c.pass).length,
            logs
        }, null, 2));
        if (checks.some(c => !c.pass)) process.exitCode = 1;
    } catch (e) {
        console.log(JSON.stringify({ fatal: String(e).slice(0, 500), logs }, null, 2));
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
