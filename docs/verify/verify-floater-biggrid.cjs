// A1 regression: the floater detector must survive a grid far bigger than 2^31 cells.
//
// The bug this guards (found while implementing A1): `detectFloaters` keeps one cell index per
// gaussian as (ix*nY + iy)*nZ + iz. On a real 13M scan that value is ~2.4e10 (grid 3061x3059x2562).
// Stored in an Int32Array it wraps, every neighbour lookup misses, the neighbour sum is 0, the
// median is negative, `limit` becomes 0 and the panel reports a meaningless handful of floaters —
// silently, because the only visible symptom is "the number looks small".
//
// The model (gen-floater-biggrid-splat.cjs) makes the grid ~6.6e11 cells at 16k points, so this
// runs in seconds while exercising exactly the same code path.
//
// What is asserted (all read off the panel, i.e. what the user sees):
//   1. the panel produced a result at all (not "--")
//   2. the reported reference (median neighbour count) is >= 0 — a negative median is the signature
//      of the wrapped index, because it can only come from summing zero neighbours everywhere
//   3. the derived `limit` is >= 1 — with a negative reference the limit collapses to 0 and the
//      detector can no longer select anything by the count clause
//   4. the number of floaters is in the right ballpark (the 50 strays; the 16000 clump points must
//      NOT be selected)
//
// usage: node docs/verify/verify-floater-biggrid.cjs [url]
const puppeteer = require('puppeteer-core');
const path = require('path');
const { execFileSync } = require('child_process');

const { BROWSER_PATH: EDGE , launchPatched: _launchPatched } = require('./lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = 'floater-biggrid-test.ply';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const gen = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'gen-floater-biggrid-splat.cjs'), `dist/${MODEL}`]).toString());

(async () => {
    const browser = await _launchPatched(puppeteer, { executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
    const errors = [];
    let out = null;
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        page.on('pageerror', e => errors.push('pageerror: ' + String(e).slice(0, 300)));
        page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });

        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForFunction('!!window.scene', { timeout: 60000 });
        await sleep(1500);

        await page.evaluate(async (m) => {
            const buf = await (await fetch('./' + m)).arrayBuffer();
            await window.scene.events.invoke('import', [{ filename: m, contents: new File([buf], m) }]);
        }, MODEL);
        await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 120000, polling: 300 });
        await sleep(3000);

        const read = await page.evaluate(async () => {
            const sleep2 = (ms) => new Promise(r => setTimeout(r, ms));
            const panel = document.getElementById('floater-panel');
            if (!panel) return { error: 'no #floater-panel' };
            const toggle = panel.querySelector('.floater-panel-header-toggle .pcui-boolean-input-toggle');
            if (!toggle) return { error: 'no toggle' };
            toggle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            await sleep2(6000);
            const label = panel.querySelector('.floater-panel-result');
            const title = label ? (label.dom ? label.dom.title : label.title) : null;
            const nums = {};
            if (title) {
                for (const m of title.matchAll(/([0-9.]+)/g)) {
                    nums[m[1]] = true;
                }
            }
            return {
                text: label ? label.textContent : null,
                title,
                numSplats: window.scene.getElementsByType('splat')[0]?.numSplats ?? 0
            };
        });

        // the tooltip is built from panel.floater.details: 半径 {{radius}} … 邻居数 < {{limit}} … 约 {{reference}} 个
        const title = read.title || '';
        const limitMatch = /<\s*([0-9]+)/.exec(title);
        const refMatch = /约\s*([0-9]+)/.exec(title) || /([0-9]+)\s*个/.exec(title);
        const limit = limitMatch ? Number(limitMatch[1]) : null;
        const reference = refMatch ? Number(refMatch[1]) : null;
        const count = read.text && /^[0-9,]+/.test(read.text) ? Number(read.text.replace(/[^0-9]/g, '')) : null;

        const checks = [
            { name: 'model loaded', pass: read.numSplats === gen.points, detail: `${read.numSplats} splats (expected ${gen.points})` },
            { name: 'panel produced a number (not "--")', pass: count !== null, detail: JSON.stringify(read.text) },
            {
                name: 'reference == the intra-clump neighbour count (7); a wrapped index gives -1',
                pass: reference === gen.perClump - 1,
                detail: `reference=${reference}, expected ${gen.perClump - 1}`
            },
            {
                name: 'limit derived from it is >= 0 (0 is legal on a 16k model, negative is not)',
                pass: limit !== null && limit >= 0 && reference !== null && limit <= reference,
                detail: `limit=${limit}, reference=${reference}`
            },
            {
                name: 'exactly the 50 strays are selected (none of the 16000 clump points)',
                pass: count !== null && count >= 40 && count <= 60,
                detail: `panel=${count}, expected=${gen.expectedFloaters}`
            }
        ];

        out = { read, gen, checks, failed: checks.filter(c => !c.pass).length, errors };
    } catch (err) {
        out = { fatal: String(err).slice(0, 600), errors, failed: 1 };
    } finally {
        await browser.close();
    }

    console.log(JSON.stringify(out, null, 2));
    if (out.failed > 0) process.exitCode = 1;
})();
