// Regression for the three selection complaints reported on 2026-09-18:
//   1. "clicking takes a moment before anything is selected" (not responsive)
//   2. "selection suddenly stops working"
//   3. "the L/R/U/D range blocks are hit and miss; sometimes several drags do nothing"
//
// Two deterministic causes found this round, both guarded here:
//   a) `tailFractions` gave up on the tails with an ABSOLUTE sample-count floor of 200
//      (docs/audit/01-bug item 10). A click (7x7 px box) or a small marquee samples only a few
//      dozen to a few hundred points, so `counted < 200` returned no tails at all and the mapping
//      fell back to plain linear => the FIRST push of any block removed nothing. That is exactly
//      the "hit and miss, several drags do nothing" report. The floor is now 20 (with 512 bins,
//      20 samples is enough to locate the first non-empty bin).
//   b) every gesture armed a deferred bounding-box pass 120ms later (the O1 deferral); starting the
//      next gesture immediately meant that pass was already queued in front of it (25-75ms at 13M
//      plus a yielded frame). A new gesture now cancels any pending deferred pass first.
//
// Assertions:
//   1. the same box six times in a row selects exactly the same set (no "sometimes it works")
//   2. a click selects a non-empty set
//   3. ALL SIX blocks must change the selection on their FIRST push, after a big box, after a small
//      box and after a click -> this is the core of complaint 3
//   4. the floater panel's auto-detection gate (complaint 2's cause on huge models: it used to run a
//      synchronous O(n) pass on every selection change, measured at a 101s freeze on 13M) shows a
//      hint instead of freezing when the model is over the threshold, and recovers when it is not
//
// usage: node docs/verify/verify-selection-responsiveness.cjs [url] [model]
//   model defaults to scan.ply (the T1 fixture, needs dist\scan.ply, so it is NOT part of the
//   batch); test-model.ply also works.
const puppeteer = require('puppeteer-core');

const { BROWSER_PATH: EDGE } = require('./lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'scan.ply';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'], protocolTimeout: 1800000 });
    const errors = [];
    let out = null;
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        page.on('pageerror', e => errors.push('pageerror: ' + String(e).slice(0, 200)));
        page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });

        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForFunction('!!window.scene', { timeout: 90000, polling: 500 });
        await sleep(1500);
        await page.evaluate(async (m) => {
            window.__buf = new Uint8Array(await (await fetch('./' + m)).arrayBuffer());
        }, MODEL);
        await page.evaluate(async (m) => {
            const scene = window.scene;
            window.__loadDone = false;
            scene.events.invoke('import', [{ filename: m, contents: new File([window.__buf], m) }])
                .then(() => { window.__loadDone = true; })
                .catch((e) => { window.__loadErr = String(e).slice(0, 200); });
        }, MODEL);
        for (let i = 0; i < 40 && !(await page.evaluate(() => window.__loadDone || window.__loadErr)); i++) await sleep(5000);
        await sleep(5000);

        const result = await page.evaluate(async () => {
            const sleep2 = (ms) => new Promise(r => setTimeout(r, ms));
            const scene = window.scene;
            const splat = scene.getElementsByType('splat').slice(-1)[0];
            const count = () => {
                const st = splat.splatData.getProp('state');
                let n = 0;
                for (let i = 0; i < st.length; i++) if (st[i] & 1) n++;
                return n;
            };
            scene.events.fire('selection', splat);
            await sleep2(600);
            scene.events.fire('camera.focus');
            await sleep2(4000);
            scene.events.fire('tool.rectSelection');
            await sleep2(600);
            scene.events.fire('selection.resetRange');
            await sleep2(400);

            const r = { numSplats: splat.splatData.numSplats, errors: [] };

            r.repeat = [];
            for (let k = 0; k < 6; k++) {
                const t = performance.now();
                await scene.events.invoke('select.rect', 'set', { start: { x: 0.35, y: 0.35 }, end: { x: 0.65, y: 0.65 } });
                r.repeat.push({ ms: Math.round(performance.now() - t), selected: count() });
                await sleep2(400);
            }

            r.click = [];
            for (const pt of [[0.46, 0.48], [0.5, 0.5], [0.54, 0.52]]) {
                const t = performance.now();
                await scene.events.invoke('select.point', 'set', { x: pt[0], y: pt[1] });
                r.click.push({ ms: Math.round(performance.now() - t), selected: count() });
                await sleep2(400);
            }

            const axes = [
                { name: 'depth.near', fire: () => scene.events.fire('selection.setDepthRange', { near: 2 }) },
                { name: 'depth.far', fire: () => scene.events.fire('selection.setDepthRange', { far: 98 }) },
                { name: 'x.low', fire: () => scene.events.fire('selection.setScreenRange', { x: { low: 2 } }) },
                { name: 'x.high', fire: () => scene.events.fire('selection.setScreenRange', { x: { high: 98 } }) },
                { name: 'y.low', fire: () => scene.events.fire('selection.setScreenRange', { y: { low: 2 } }) },
                { name: 'y.high', fire: () => scene.events.fire('selection.setScreenRange', { y: { high: 98 } }) }
            ];
            const starts = [
                { tag: 'bigRect', start: async () => scene.events.invoke('select.rect', 'set', { start: { x: 0.35, y: 0.35 }, end: { x: 0.65, y: 0.65 } }) },
                { tag: 'smallRect', start: async () => scene.events.invoke('select.rect', 'set', { start: { x: 0.46, y: 0.44 }, end: { x: 0.54, y: 0.52 } }) },
                { tag: 'click', start: async () => scene.events.invoke('select.point', 'set', { x: 0.5, y: 0.5 }) }
            ];
            r.pushAfter = {};
            for (const s of starts) {
                r.pushAfter[s.tag] = {};
                for (const axis of axes) {
                    await s.start();
                    await sleep2(900);
                    const base = count();
                    axis.fire();
                    await sleep2(900);
                    const after = count();
                    r.pushAfter[s.tag][axis.name] = { base, after, reacted: after !== base };
                    scene.events.fire('selection.resetRange');
                    await sleep2(300);
                }
            }

            const gate = await (async () => {
                const panel = document.getElementById('floater-panel');
                if (!panel) return { error: 'no #floater-panel' };
                // the panel is OFF by default (its detection is a whole-model scan), so the header
                // toggle has to be switched on before any of this can run
                const toggle = panel.querySelector('.floater-panel-header-toggle .pcui-boolean-input-toggle');
                if (!toggle) return { error: 'no toggle' };
                toggle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
                toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                await sleep2(4000);
                const label = () => {
                    const el = panel.querySelector('.floater-panel-result');
                    return el ? { text: el.textContent, title: el.dom ? el.dom.title : el.title } : null;
                };
                const before = label();
                window.__SPLATROOM_FLOATER_AUTO_MAX_SPLATS__ = 1000;
                const gaps = [];
                let last = performance.now();
                const iv = setInterval(() => { const now = performance.now(); gaps.push(now - last); last = now; }, 20);
                scene.events.fire('selection', splat);
                await sleep2(2500);
                clearInterval(iv);
                const gated = label();
                const maxGapMs = Math.round(Math.max(...gaps, 0));
                window.__SPLATROOM_FLOATER_AUTO_MAX_SPLATS__ = undefined;
                scene.events.fire('selection', splat);
                await sleep2(2500);
                const restored = label();
                return { before, gated, restored, maxGapMs };
            })();
            r.floaterGate = gate;

            return r;
        });

        const reacts = (tag) => Object.values(result.pushAfter[tag]).filter(v => v.reacted).length;
        const repeatCounts = result.repeat.map(r => r.selected);
        const g = result.floaterGate || {};
        const checks = [
            {
                name: 'the same box six times selects exactly the same set',
                pass: repeatCounts.length === 6 && repeatCounts.every(c => c === repeatCounts[0]) && repeatCounts[0] > 0,
                detail: repeatCounts.join(', ')
            },
            {
                name: 'a click selects a non-empty set',
                pass: result.click.every(c => c.selected > 0),
                detail: result.click.map(c => `${c.selected}(${c.ms}ms)`).join(', ')
            },
            {
                name: 'ALL six blocks react on the first push after a big box',
                pass: reacts('bigRect') === 6,
                detail: `${reacts('bigRect')}/6 ` + Object.entries(result.pushAfter.bigRect).map(([k, v]) => `${k}:${v.base}->${v.after}`).join(' ')
            },
            {
                name: 'ALL six blocks react on the first push after a SMALL box (old code: tails=null => nothing)',
                pass: reacts('smallRect') === 6,
                detail: `${reacts('smallRect')}/6 ` + Object.entries(result.pushAfter.smallRect).map(([k, v]) => `${k}:${v.base}->${v.after}`).join(' ')
            },
            {
                name: 'ALL six blocks react on the first push after a CLICK (fewest samples)',
                pass: reacts('click') === 6,
                detail: `${reacts('click')}/6 ` + Object.entries(result.pushAfter.click).map(([k, v]) => `${k}:${v.base}->${v.after}`).join(' ')
            },
            {
                name: 'over the auto-detect threshold the floater panel shows a hint and does NOT freeze',
                pass: !!g.gated && g.gated.text === '--' && typeof g.gated.title === 'string' && g.gated.title.length > 10 && g.maxGapMs < 2000,
                detail: JSON.stringify(g)
            },
            {
                name: 'the floater hint clears again once the model is under the threshold',
                pass: !!g.restored && g.restored.text !== '--',
                detail: g.restored ? `restored label=${g.restored.text}` : 'n/a'
            },
            { name: 'no page errors', pass: errors.length === 0, detail: errors.slice(0, 2).join(' | ') }
        ];

        out = { result, checks, failed: checks.filter(c => !c.pass).length, errors };
    } catch (err) {
        out = { fatal: String(err).slice(0, 600), errors, failed: 1 };
    } finally {
        await browser.close();
    }

    console.log(JSON.stringify(out, null, 2));
    if (out.failed > 0) process.exitCode = 1;
})();
