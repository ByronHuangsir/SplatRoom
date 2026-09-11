// Headless check that the mask (stroke) selection path agrees with the rect
// selection path for the SAME screen region, using a vertically asymmetric
// model. A vertical flip in the render/pick mapping (pick row indexing) would
// show up as the mask stroke in the upper half matching the rect in the lower
// half instead.
//
// Requires the asymmetric model: node docs/gen-test-splat.cjs dist/test-model.ply --asym
// usage: node docs/verify-mask-vs-rect.cjs [url]
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
        await sleep(2000);

        await page.evaluate(async () => {
            const buf = await (await fetch('./test-model.ply')).arrayBuffer();
            await window.scene.events.invoke('import', [{ filename: 'test-model.ply', contents: new File([buf], 'test-model.ply') }]);
        });
        await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 60000 });
        await sleep(2500);

        const report = await page.evaluate(async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const scene = window.scene;
            const events = scene.events;
            const splat = scene.getElementsByType('splat')[0];
            events.fire('selection.set', splat);
            await sleep(400);

            const state = splat.splatData.getProp('state');
            const countSelected = () => {
                let n = 0;
                for (let i = 0; i < state.length; ++i) if (state[i] & 1) n++;
                return n;
            };

            const clear = async () => {
                events.fire('select.none');
                const deadline = Date.now() + 5000;
                while (Date.now() < deadline && countSelected() !== 0) await sleep(200);
            };

            const settle = async (timeoutMs = 15000) => {
                const deadline = Date.now() + timeoutMs;
                let last = -1;
                let stable = 0;
                while (Date.now() < deadline) {
                    await sleep(300);
                    const now = countSelected();
                    if (now === last && now > 0) {
                        if (++stable >= 2) break;
                    } else {
                        stable = 0;
                    }
                    last = now;
                }
                return countSelected();
            };

            // depth + footprint so both paths pick the visible surface
            events.fire('selection.setUseDepth', true);
            events.fire('selection.setFootprint', 1);

            // a stroke canvas covering either the upper or the lower half band
            const makeStroke = (y0) => {
                const canvas = document.createElement('canvas');
                canvas.width = scene.canvas.clientWidth;
                canvas.height = scene.canvas.clientHeight;
                const ctx = canvas.getContext('2d');
                ctx.strokeStyle = '#f60';
                ctx.lineCap = 'round';
                ctx.lineWidth = canvas.height * 0.28;
                ctx.beginPath();
                ctx.moveTo(canvas.width * 0.2, canvas.height * y0);
                ctx.lineTo(canvas.width * 0.8, canvas.height * y0);
                ctx.stroke();
                return { canvas, ctx };
            };

            const rectOf = (y0) => ({
                start: { x: 0.2, y: Math.max(0, y0 - 0.14) },
                end: { x: 0.8, y: Math.min(1, y0 + 0.14) }
            });

            const out = { bands: [] };
            for (const [name, y] of [['upper', 0.3], ['lower', 0.7]]) {
                await clear();
                await events.invoke('select.rect', 'add', rectOf(y));
                const rectCount = await settle();

                await clear();
                const { canvas, ctx } = makeStroke(y);
                await events.invoke('select.byMask', 'add', canvas, ctx);
                const maskCount = await settle();

                out.bands.push({ name, rectCount, maskCount });
            }

            events.fire('selection.setUseDepth', false);
            events.fire('selection.setFootprint', 0);
            return out;
        });

        // the mask stroke must agree with the rect over the same band; a flip
        // would make each band's mask count track the OTHER band's rect count
        const [upper, lower] = report.bands;
        const agree = (a, b) => b > 0 && Math.abs(a - b) / b < 0.25;
        // the two bands see different walls (front wall upper, back wall lower)
        const bandsDiffer = Math.abs(upper.rectCount - lower.rectCount) > 0.05 * Math.max(upper.rectCount, lower.rectCount);
        const checks = [
            { name: 'upper: mask agrees with rect', pass: agree(upper.maskCount, upper.rectCount), detail: `${upper.maskCount} vs ${upper.rectCount}` },
            { name: 'lower: mask agrees with rect', pass: agree(lower.maskCount, lower.rectCount), detail: `${lower.maskCount} vs ${lower.rectCount}` },
            { name: 'bands differ (the two bands see different walls)', pass: bandsDiffer, detail: `${upper.rectCount} vs ${lower.rectCount}` }
        ];

        console.log(JSON.stringify({ ...report, checks, failed: checks.filter(c => !c.pass).length, errors }, null, 2));
        if (checks.some(c => !c.pass) || errors.length) process.exitCode = 1;
    } catch (err) {
        console.log(JSON.stringify({ fatal: String(err).slice(0, 700), errors }, null, 2));
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
