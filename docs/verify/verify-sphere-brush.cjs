// Verify the sphere brush: what a stroke selects, and what the two settings sliders do -
// size (the brush radius, in px) and 厚度 (thickness, the depth the stroke reaches along the view).
//
// The test model has two parallel walls: a front wall at z = 0 and a back wall at z = -0.6. A ball brush
// ("thickness 0") of a given radius reaches only partway into that gap, so it never touches the back wall.
// Making the brush thicker keeps its width and reaches deeper, which is observable three ways:
//   * a THIN thickness (much less than the radius) clips the ball's own depth -> fewer hits, still no back wall;
//   * a THICK one reaches the back wall -> back-wall hits appear;
//   * and the front-wall count stays about the same in both cases, i.e. thickness changes depth WITHOUT
//     widening the brush (that is what makes it a separate control from the size slider).
//
// It also checks that a fast stroke does not leave the spinner (a full-screen overlay that swallows
// pointer events) on screen, which is what made a quick click feel like a one-second freeze.
//
// usage: node docs/verify/verify-sphere-brush.cjs "<url>" [model]
const puppeteer = require('puppeteer-core');

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
        await page.setViewport({ width: 1200, height: 800 });
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

        // give the app a selection target and frame it, so the brush has something to paint on
        await page.evaluate(() => {
            const scene = window.scene;
            scene.events.fire('selection', scene.getElementsByType('splat').slice(-1)[0]);
        });
        await sleep(400);
        await page.evaluate(() => window.scene.events.fire('camera.focus'));
        await sleep(1200);

        const geom = () => page.evaluate(() => {
            const scene = window.scene;
            const splat = scene.getElementsByType('splat').slice(-1)[0];
            const cam = scene.camera.camera;
            const dev = scene.graphicsDevice;
            const canvas = scene.canvas;
            const rect = canvas.getBoundingClientRect();
            // the front wall of the test model is centred on the origin
            const v = cam.entity.getPosition().clone().set(0, 0, 0);
            const sp = cam.worldToScreen(v);
            return {
                numSplats: splat.splatData.numSplats,
                client: {
                    x: rect.left + (sp.x / dev.width) * rect.width,
                    y: rect.top + (sp.y / dev.height) * rect.height
                }
            };
        });

        // classify the selected splats: front wall (z near 0) vs back wall (z near -0.6)
        const classify = () => page.evaluate(() => {
            const splat = window.scene.getElementsByType('splat').slice(-1)[0];
            const st = splat.splatData.getProp('state');
            const z = splat.splatData.getProp('z');
            let front = 0;
            let back = 0;
            let other = 0;
            for (let i = 0; i < st.length; i++) {
                if (!(st[i] & 1)) continue;
                if (z[i] > -0.3) {
                    front++;
                } else if (z[i] < -0.5) {
                    back++;
                } else {
                    other++;
                }
            }
            return { front, back, other, total: front + back + other };
        });

        const spinnerVisible = () => page.evaluate(() => {
            const spinner = document.getElementById('spinner-container');
            return !!spinner && !spinner.classList.contains('pcui-hidden');
        });

        const setBrush = (settings) => page.evaluate((s) => {
            window.scene.events.fire('tool.brushSelection.setSettings', s);
            return window.scene.events.invoke('tool.brushSelection.settings');
        }, settings);

        const stroke = async (label) => {
            await page.evaluate(() => {
                // the tool events toggle, so switch away first
                window.scene.events.fire('tool.rectSelection');
            });
            await sleep(300);
            await page.evaluate(() => window.scene.events.fire('tool.sphereBrushSelection'));
            await sleep(700);
            const g = await geom();
            const start = { x: g.client.x - 40, y: g.client.y };
            await page.mouse.move(start.x, start.y);
            await sleep(120);
            await page.mouse.down();
            await sleep(60);
            for (let i = 1; i <= 8; i++) {
                await page.mouse.move(start.x + i * 10, start.y);
                await sleep(25);
            }
            await page.mouse.up();
            await sleep(2500);
            const result = await classify();
            const spinner = await spinnerVisible();
            console.log(`${label}: selected ${result.total} (front ${result.front}, back ${result.back}, between ${result.other}), spinner visible: ${spinner}`);
            return { ...result, spinner };
        };

        const clearSelection = () => page.evaluate(() => window.scene.events.fire('select.none'));

        // 1) plain ball brush
        await setBrush({ radius: 60, thickness: 0 });
        const ball = await stroke('ball brush (thickness 0)    ');

        await clearSelection();
        await sleep(400);

        // 2) thin slab: much shallower than the ball, and no wider
        await setBrush({ radius: 60, thickness: 8 });
        const thin = await stroke('thin slab (thickness 8px)   ');

        await clearSelection();
        await sleep(400);

        // 3) deep slab: same width, deep enough to reach the wall 0.6 behind
        await setBrush({ radius: 60, thickness: 400 });
        const slab = await stroke('deep slab (thickness 400px) ');

        const settings = await page.evaluate(() => window.scene.events.invoke('tool.brushSelection.settings'));

        await clearSelection();
        await sleep(400);
        await page.evaluate(() => window.scene.events.fire('tool.brushSelection.setSettings', { thickness: 0 }));
        await sleep(300);
        const afterReset = await page.evaluate(() => window.scene.events.invoke('tool.brushSelection.settings'));

        const widthKept = (a, b) => a > 0 && b > 0 && Math.abs(a - b) / Math.max(a, b) < 0.5;

        const checks = [
            {
                name: 'a stroke selects splats on the surface it was painted on',
                pass: ball.front > 0 && ball.back === 0,
                detail: `ball brush (radius 60, thickness 0) selected ${ball.total} splats: ${ball.front} on the front wall, ${ball.back} behind it`
            },
            {
                name: 'a thin thickness clips the brush depth (fewer hits, no wider)',
                pass: thin.total > 0 && thin.total < ball.total && thin.back === 0,
                detail: `thickness 8 px selected ${thin.total} splats against the ball's ${ball.total}, back-wall hits ${thin.back}`
            },
            {
                name: 'a thick setting reaches deeper without widening the brush',
                pass: slab.back > 0 && widthKept(slab.front, ball.front),
                detail: `thickness 400 px selected ${slab.front} front-wall splats (ball: ${ball.front}, so the width is unchanged) and ${slab.back} behind the wall (ball: ${ball.back})`
            },
            {
                name: 'the sliders round-trip through the brush',
                pass: settings.radius === 60 && settings.thickness === 400 && afterReset.thickness === 0,
                detail: `radius ${settings.radius}, thickness ${settings.thickness}; after resetting the slider thickness ${afterReset.thickness}`
            },
            {
                name: 'a fast stroke leaves no spinner over the viewport',
                pass: ball.spinner === false && thin.spinner === false && slab.spinner === false,
                detail: `spinner visible after the strokes: ${ball.spinner} / ${thin.spinner} / ${slab.spinner} (the overlay swallows pointer events, so a stuck one looks like a freeze)`
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
            ball,
            thin,
            slab,
            settings,
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
