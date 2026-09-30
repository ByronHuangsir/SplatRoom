// Verify what the box / sphere volume actually draws for a SMALL volume, at two zoom levels.
//
// User report: "when the box and sphere are set very small, only two lines are left at the boundary,
// so you cannot see the range that is actually selected." The strips are a fixed world-space grid
// (0.5 units for the box, 0.5 units of arc for the sphere), so a small volume contains at most one or
// two lines and nothing delineates it. Two changes fixed that: the strip spacing is capped so an axis
// (or the sphere) always shows a minimum number of lines, and the box's 12 edges / the sphere's
// silhouette are drawn with a constant width in SCREEN space on top of the strips.
//
// This checks the pixels, not the source: for a 0.05-unit box and a 0.02-radius sphere it counts the
// volume's line pixels per screen row and column inside the volume's projected bounding box, and
// requires that most rows/columns cross at least two lines (left+right / top+bottom boundary), that the
// lines stay thin (a few pixels) and that they still run at the edge of the box. The same measurement
// runs after zooming in, because the line width has to follow the view rather than the world.
//
// usage: node docs/verify/verify-shape-volume-lines.cjs "<url>"
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { decodePng } = require('./lib/png.cjs');

const { BROWSER_PATH: EDGE , launchPatched: _launchPatched } = require('./lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- pixel analysis -------------------------------------------------------------------
// The volume draws bright cyan (near side) and blue (far side) lines; the model behind it is faded to
// exp(-2) brightness while the volume tool is active, so a brightness floor plus "clearly more blue
// than red" isolates the volume's own lines without a per-line colour constant.
// 'inner' is the volume's projected bounding box inside the crop (crop coordinates).
const analyse = (img, inner) => {
    const { width: w, height: h, channels: ch, data } = img;
    const mask = new Uint8Array(w * h);
    let linePixels = 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * ch;
            const r = data[i], g = data[i + 1], b = data[i + 2];
            if (b >= 100 && b - r >= 40 && g < b + 20) {
                mask[y * w + x] = 1;
                linePixels++;
            }
        }
    }

    // line thickness: a horizontal line is thin across rows and long along columns, so the two
    // directions are reported separately - the median is the line width, the maximum is the length
    const hRuns = [];
    const vRuns = [];
    for (let y = inner.y0; y <= inner.y1; y++) {
        let run = 0;
        for (let x = inner.x0; x <= inner.x1; x++) {
            if (mask[y * w + x]) {
                run++;
            } else if (run) {
                hRuns.push(run);
                run = 0;
            }
        }
        if (run) hRuns.push(run);
    }
    for (let x = inner.x0; x <= inner.x1; x++) {
        let run = 0;
        for (let y = inner.y0; y <= inner.y1; y++) {
            if (mask[y * w + x]) {
                run++;
            } else if (run) {
                vRuns.push(run);
                run = 0;
            }
        }
        if (run) vRuns.push(run);
    }
    hRuns.sort((a, b) => a - b);
    vRuns.sort((a, b) => a - b);
    const median = (a) => (a.length ? a[a.length >> 1] : 0);

    // how many of the volume's rows / columns cross at least two lines
    let rowsTotal = 0, rowsWithTwo = 0, colsWithTwo = 0, colsTotal = 0;
    for (let y = inner.y0; y <= inner.y1; y++) {
        let n = 0;
        for (let x = inner.x0; x <= inner.x1; x++) {
            if (mask[y * w + x]) n++;
        }
        rowsTotal++;
        if (n >= 2) rowsWithTwo++;
    }
    for (let x = inner.x0; x <= inner.x1; x++) {
        let n = 0;
        for (let y = inner.y0; y <= inner.y1; y++) {
            if (mask[y * w + x]) n++;
        }
        colsTotal++;
        if (n >= 2) colsWithTwo++;
    }

    // does the volume's boundary reach the edges of its projected box?
    const pad = 3;
    let left = 0, right = 0, top = 0, bottom = 0;
    for (let y = inner.y0; y <= inner.y1; y++) {
        for (let x = inner.x0; x <= inner.x1; x++) {
            if (!mask[y * w + x]) continue;
            if (x <= inner.x0 + pad) left++;
            if (x >= inner.x1 - pad) right++;
            if (y <= inner.y0 + pad) top++;
            if (y >= inner.y1 - pad) bottom++;
        }
    }

    return {
        size: `${w}x${h}`,
        linePixels,
        coveragePct: +(linePixels / Math.max(1, (inner.x1 - inner.x0 + 1) * (inner.y1 - inner.y0 + 1)) * 100).toFixed(1),
        rowsWithTwoPlusPct: +(rowsWithTwo / Math.max(1, rowsTotal) * 100).toFixed(1),
        colsWithTwoPlusPct: +(colsWithTwo / Math.max(1, colsTotal) * 100).toFixed(1),
        lineWidthFromRowsPx: median(hRuns),
        lineWidthFromColsPx: median(vRuns),
        longestHorizontalRunPx: hRuns.length ? hRuns[hRuns.length - 1] : 0,
        longestVerticalRunPx: vRuns.length ? vRuns[vRuns.length - 1] : 0,
        boundarySides: { left, right, top, bottom },
        ascii: process.argv.includes('--ascii') ? asciiMap(mask, w, h, inner) : undefined
    };
};

// coarse map of the detected line pixels, for eyeballing the silhouette / edges in a terminal
const asciiMap = (mask, w, h, inner) => {
    const cols = 48;
    const rows = Math.max(8, Math.round(cols * (inner.y1 - inner.y0 + 1) / Math.max(1, inner.x1 - inner.x0 + 1) * 0.5));
    const cw = (inner.x1 - inner.x0 + 1) / cols;
    const chh = (inner.y1 - inner.y0 + 1) / rows;
    const out = [];
    for (let r = 0; r < rows; r++) {
        let line = '';
        for (let c = 0; c < cols; c++) {
            let hits = 0;
            for (let y = Math.floor(inner.y0 + r * chh); y < Math.floor(inner.y0 + (r + 1) * chh); y++) {
                for (let x = Math.floor(inner.x0 + c * cw); x < Math.floor(inner.x0 + (c + 1) * cw); x++) {
                    if (mask[y * w + x]) hits++;
                }
            }
            line += hits === 0 ? '.' : (hits > cw * chh * 0.5 ? '#' : '+');
        }
        out.push(line);
    }
    return out;
};

(async () => {
    const logs = [];
    const shots = [];
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
        // A model is imported so the camera frames the scene and the volume gets fitted like it would
        // for a user, but the splats are then hidden and the gizmo layer switched off, so the crop
        // around the volume contains the volume's own lines and nothing else: the model would add a
        // blue wall of its own and the gizmo draws bright axis handles right at the volume centre,
        // both of which swamped an earlier version of this measurement.
        await page.evaluate(async () => {
            const buf = await (await fetch('./test-model.ply')).arrayBuffer();
            await window.scene.events.invoke('import', [{ filename: 'test-model.ply', contents: new File([buf], 'test-model.ply') }]);
        });
        await sleep(4000);
        await page.evaluate(() => {
            const scene = window.scene;
            scene.gizmoLayer.enabled = false;
            for (const s of scene.getElementsByType('splat')) {
                scene.remove(s);
            }
        });
        await sleep(500);

        const prepare = (tool) => page.evaluate(async (name) => {
            const scene = window.scene;
            scene.events.fire(`tool.${name}`);
            await new Promise(r => setTimeout(r, 1500));
            const toolbars = Array.from(document.querySelectorAll('.select-toolbar'));
            const toolbar = toolbars.find(t => !t.classList.contains('pcui-hidden') && t.querySelectorAll('.select-toolbar-mode').length) ||
                toolbars.find(t => t.querySelectorAll('.select-toolbar-mode').length);
            // the tool re-enables its own gizmo, and it re-dims the model: undo both so the crop only
            // holds the volume
            scene.gizmoLayer.enabled = false;
            for (const s of scene.getElementsByType('splat')) {
                scene.remove(s);
            }
            return { inputs: toolbar.querySelectorAll('input').length };
        }, tool);

        // render on demand (there is no model to keep the frame loop busy) and wait for the GPU
        const renderFrame = () => page.evaluate(async () => {
            const scene = window.scene;
            scene.forceRender = true;
            if (scene.app) {
                scene.app.renderNextFrame = true;
            }
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        });

        // set a numeric PCUI input the way a user typing a value does
        const setInput = (index, value) => page.evaluate((i, v) => {
            const toolbars = Array.from(document.querySelectorAll('.select-toolbar'));
            const toolbar = toolbars.find(t => !t.classList.contains('pcui-hidden') && t.querySelectorAll('.select-toolbar-mode').length) ||
                toolbars.find(t => t.querySelectorAll('.select-toolbar-mode').length);
            const input = toolbar.querySelectorAll('input')[i];
            if (!input) return false;
            input.focus();
            input.value = String(v);
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.blur();
            return true;
        }, index, value);

        const readValues = () => page.evaluate(() => {
            const toolbars = Array.from(document.querySelectorAll('.select-toolbar'));
            const toolbar = toolbars.find(t => !t.classList.contains('pcui-hidden') && t.querySelectorAll('.select-toolbar-mode').length) ||
                toolbars.find(t => t.querySelectorAll('.select-toolbar-mode').length);
            return toolbar ? Array.from(toolbar.querySelectorAll('input')).map(i => i.value) : null;
        });

        // project the volume's world-space bounding box (position + size/radius, no rotation) to
        // screen and return a padded clip rect for the screenshot
        const volumeBox = (spec) => page.evaluate((s) => {
            const scene = window.scene;
            const dev = scene.graphicsDevice;
            const cam = scene.camera.camera;
            const canvas = scene.canvas;
            const rect = canvas.getBoundingClientRect();
            const toScreen = (x, y, z) => {
                const v = cam.entity.getPosition().clone().set(x, y, z);
                return cam.worldToScreen(v);
            };
            const half = s.mode === 'box' ? [s.a / 2, s.b / 2, s.c / 2] : [s.r, s.r, s.r];
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            if (s.mode === 'box') {
                for (const sx of [-1, 1]) {
                    for (const sy of [-1, 1]) {
                        for (const sz of [-1, 1]) {
                            const p = toScreen(s.pos[0] + sx * half[0], s.pos[1] + sy * half[1], s.pos[2] + sz * half[2]);
                            minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
                            minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
                        }
                    }
                }
            } else {
                // a sphere's silhouette is what the user reads, and it lies INSIDE the projection of
                // its bounding box: take the extremes from the points r along the camera's own right
                // and up axes, which project exactly onto the silhouette in each direction
                const centre = toScreen(s.pos[0], s.pos[1], s.pos[2]);
                const right = cam.entity.right;
                const up = cam.entity.up;
                const px = toScreen(s.pos[0] + right.x * s.r, s.pos[1] + right.y * s.r, s.pos[2] + right.z * s.r);
                const py = toScreen(s.pos[0] + up.x * s.r, s.pos[1] + up.y * s.r, s.pos[2] + up.z * s.r);
                const dx = Math.abs(px.x - centre.x);
                const dy = Math.abs(py.y - centre.y);
                minX = centre.x - dx; maxX = centre.x + dx;
                minY = centre.y - dy; maxY = centre.y + dy;
            }
            const pad = 12;
            const inner = {
                x0: Math.max(0, Math.round(minX)),
                y0: Math.max(0, Math.round(minY)),
                x1: Math.min(dev.width - 1, Math.round(maxX)),
                y1: Math.min(dev.height - 1, Math.round(maxY))
            };
            return {
                inner,
                clip: {
                    x0: Math.max(0, inner.x0 - pad),
                    y0: Math.max(0, inner.y0 - pad),
                    x1: Math.min(dev.width - 1, inner.x1 + pad),
                    y1: Math.min(dev.height - 1, inner.y1 + pad)
                },
                deviceWidth: dev.width,
                deviceHeight: dev.height,
                canvasLeft: rect.left,
                canvasTop: rect.top,
                canvasWidth: rect.width,
                canvasHeight: rect.height
            };
        }, spec);

        const measure = async (tag, spec) => {
            await renderFrame();
            const box = await volumeBox(spec);
            const sx = box.canvasWidth / box.deviceWidth;
            const sy = box.canvasHeight / box.deviceHeight;
            const file = path.join(os.tmpdir(), `splatroom-volume-${tag}.png`);
            await page.screenshot({
                path: file,
                clip: {
                    x: box.canvasLeft + box.clip.x0 * sx,
                    y: box.canvasTop + box.clip.y0 * sy,
                    width: (box.clip.x1 - box.clip.x0 + 1) * sx,
                    height: (box.clip.y1 - box.clip.y0 + 1) * sy
                }
            });
            const img = decodePng(fs.readFileSync(file));
            const inner = {
                x0: box.inner.x0 - box.clip.x0,
                y0: box.inner.y0 - box.clip.y0,
                x1: box.inner.x1 - box.clip.x0,
                y1: box.inner.y1 - box.clip.y0
            };
            const scale = img.width / Math.max(1, box.clip.x1 - box.clip.x0 + 1);
            return {
                tag,
                file,
                cropSize: `${img.width}x${img.height}`,
                scale: +scale.toFixed(3),
                projectedSize: `${box.inner.x1 - box.inner.x0 + 1}x${box.inner.y1 - box.inner.y0 + 1}`,
                ...analyse(img, inner)
            };
        };

        // ---- box: shrink it to 0.05 units ----
        await prepare('boxSelection');
        // [x, y, z, lenX, lenY, lenZ, rotX, rotY, rotZ]
        await setInput(3, 0.05);
        await setInput(4, 0.05);
        await setInput(5, 0.05);
        await sleep(600);
        const boxValues = await readValues();

        const boxSpec = { mode: 'box', pos: [Number(boxValues[0]), Number(boxValues[1]), Number(boxValues[2])], a: Number(boxValues[3]), b: Number(boxValues[4]), c: Number(boxValues[5]) };
        const smallBox = await measure('box-small', boxSpec);

        // zoom in twice and measure again: the lines must stay thin and present
        await page.mouse.move(600, 400);
        await page.mouse.wheel({ deltaY: -300 });
        await sleep(700);
        const zoomedBox = await measure('box-zoomed', boxSpec);

        // ---- sphere: shrink the radius ----
        await prepare('sphereSelection');
        await setInput(3, 0.02);
        await sleep(600);
        const sphereValues = await readValues();
        const sphereSpec = { mode: 'sphere', pos: [Number(sphereValues[0]), Number(sphereValues[1]), Number(sphereValues[2])], r: Number(sphereValues[3]) };
        const smallSphere = await measure('sphere-small', sphereSpec);

        const checks = [];
        const lineCheck = (label, m) => {
            checks.push({
                name: `${label}: the boundary and the interior are lined across the volume`,
                pass: m.rowsWithTwoPlusPct >= 60 && m.colsWithTwoPlusPct >= 85 && m.coveragePct >= 5,
                detail: `rows ${m.rowsWithTwoPlusPct}%, columns ${m.colsWithTwoPlusPct}%, ${m.linePixels} line pixels (${m.coveragePct}% of the volume's projected box, so the lines reach across it)`
            });
            checks.push({
                name: `${label}: the lines stay thin (a few pixels) at this zoom`,
                pass: m.lineWidthFromRowsPx >= 1 && m.lineWidthFromRowsPx <= 8 && m.lineWidthFromColsPx >= 1 && m.lineWidthFromColsPx <= 8,
                detail: `width across rows ${m.lineWidthFromRowsPx}px, across columns ${m.lineWidthFromColsPx}px (longest runs ${m.longestHorizontalRunPx}/${m.longestVerticalRunPx}px are the lines' lengths)`
            });
            checks.push({
                name: `${label}: the boundary reaches all four sides of the volume`,
                pass: m.boundarySides.left > 0 && m.boundarySides.right > 0 && m.boundarySides.top > 0 && m.boundarySides.bottom > 0,
                detail: `line pixels near the box sides: ${JSON.stringify(m.boundarySides)}`
            });
        };
        lineCheck('tiny box (0.05 units)', smallBox);
        lineCheck('tiny box, zoomed in', zoomedBox);
        lineCheck('tiny sphere (r = 0.02)', smallSphere);

        checks.push({
            name: 'the volume tool actually shrank the volume',
            pass: Number(boxValues[3]) < 0.1 && Number(sphereValues[3]) < 0.05,
            detail: `box size ${boxValues.slice(3, 6).join('/')}, sphere radius ${sphereValues[3]}`
        });
        checks.push({
            name: 'no console errors',
            pass: logs.length === 0,
            detail: logs.length ? JSON.stringify(logs.slice(0, 3)) : 'clean'
        });

        console.log(JSON.stringify({
            url: URL,
            backend: await page.evaluate(() => (window.scene.graphicsDevice.isWebGPU ? 'webgpu' : 'webgl2')),
            measurements: { smallBox, zoomedBox, smallSphere },
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
