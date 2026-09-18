// Load worker A/B: does the import actually go through the worker, and does it help?
//
// Context (docs/audit/00-总结.md 高危 7): the load worker was explicitly opt-in via
// `window.__SPLATROOM_ENABLE_LOAD_WORKER__ === true`, which nothing in the repo ever set, so
// decode + morton sort + row reorder all ran on the main thread (the ~15s freeze on a 13M import).
// The flag is now ON by default (`__SPLATROOM_NO_LOAD_WORKER__ = true` disables it).
//
// This suite loads the same model twice in the same browser, once with the worker on and once
// with it off, and asserts:
//   1. the worker path reports worker dispatches > 0 (the old probe's false green: it compared
//      the loader against itself and never checked that the worker ran)
//   2. the disabled path reports 0 (proves the counter is a real signal, not always > 0)
//   3. both paths produce the same gaussian count
//   4. (informational) the import wall time of each path
//
// usage: node docs/verify/verify-load-worker.cjs [url] [model]
//   the model must exist under dist/ — for the T1 fixture copy _tmp\scan.ply to dist\scan.ply
//   and DELETE it afterwards (otherwise it ends up inside the packaged asar).
const puppeteer = require('C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
const fs = require('fs');
const path = require('path');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'scan.ply';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const modelPath = path.join(__dirname, '..', '..', 'dist', MODEL);

const runOnce = async (browser, enableWorker) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + String(e).slice(0, 200)));
    if (enableWorker) {
        await page.evaluateOnNewDocument(() => { window.__SPLATROOM_ENABLE_LOAD_WORKER__ = true; });
    }
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForFunction('!!window.scene', { timeout: 90000, polling: 500 });
    await sleep(1500);

    await page.evaluate(async (m) => {
        const r = await fetch('./' + m);
        const buf = await r.arrayBuffer();
        window.__buf = new Uint8Array(buf);
    }, MODEL);

    const out = await page.evaluate(async (m) => {
        const sleep2 = (ms) => new Promise(r => setTimeout(r, ms));
        const scene = window.scene;
        const res = { started: Date.now() };
        // 20ms heartbeat: the max gap is how long the main thread was blocked, i.e. the "freeze"
        // the user feels. Moving the decode into the worker should show up here, not in wall time.
        const gaps = [];
        let last = performance.now();
        const iv = setInterval(() => {
            const now = performance.now();
            gaps.push(now - last);
            last = now;
        }, 20);
        const p = scene.events.invoke('import', [{ filename: m, contents: new File([window.__buf], m) }])
            .then(() => { res.importMs = Date.now() - res.started; })
            .catch((e) => { res.importError = String(e).slice(0, 300); });
        for (let i = 0; i < 40; i++) {
            await sleep2(5000);
            console.log('[diag] t=' + ((Date.now() - res.started) / 1000).toFixed(0) + 's splats=' + scene.getElementsByType('splat').length);
            if (res.importMs !== undefined || res.importError) break;
        }
        await Promise.race([p, sleep2(1000)]);
        clearInterval(iv);
        const sorted = gaps.slice().sort((a, b) => b - a);
        res.maxGapMs = Math.round(sorted[0] ?? 0);
        res.blocksOver100ms = gaps.filter(g => g > 100).length;
        const splats = scene.getElementsByType('splat');
        res.numSplats = splats[0] ? splats[0].splatData.numSplats : 0;
        // Column checksums: "same gaussian count" is NOT enough — a row-reorder bug in the worker
        // would keep the count and still shuffle every attribute, which shows up downstream as
        // selections and colours being subtly wrong. FNV-1a over the raw bytes.
        const checksum = (arr) => {
            if (!arr) return 'missing';
            const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
            let h = 0x811c9dc5;
            for (let i = 0; i < bytes.length; i++) {
                h ^= bytes[i];
                h = Math.imul(h, 0x01000193) >>> 0;
            }
            return h.toString(16) + ':' + bytes.length;
        };
        res.checksums = {};
        if (splats[0]) {
            for (const name of ['x', 'y', 'z', 'opacity', 'state', 'rot_0']) {
                res.checksums[name] = checksum(splats[0].splatData.getProp(name));
            }
        }
        res.workerResults = window.__LW_WORKER_RESULTS__ || 0;

        // Behaviour, not just bytes: run the same rect gesture + depth push and count the selection.
        // This is what caught the flag flip: with the worker enabled the same gesture selected the
        // whole model (2000) instead of the ~10% inside the box (213 on the fixture).
        const count = () => {
            const st = splats[0].splatData.getProp('state');
            let n = 0;
            for (let i = 0; i < st.length; i++) if (st[i] & 1) n++;
            return n;
        };
        if (splats[0] && splats[0].splatData.numSplats <= 200000) {
            scene.events.fire('selection', splats[0]);
            await sleep2(600);
            scene.events.fire('camera.focus');
            await sleep2(3000);
            scene.events.fire('tool.rectSelection');
            await sleep2(500);
            scene.events.fire('selection.resetRange');
            await sleep2(300);
            await scene.events.invoke('select.rect', 'set', { start: { x: 0.35, y: 0.35 }, end: { x: 0.65, y: 0.65 } });
            await sleep2(1200);
            res.gestureSelected = count();
            scene.events.fire('selection.resetRange');
            await sleep2(400);
            scene.events.fire('selection.setDepthRange', { far: 99 });
            await sleep2(1500);
            res.pushSelected = count();
        }
        return res;
    }, MODEL);
    await page.close();
    return { ...out, errors };
};

(async () => {
    if (!fs.existsSync(modelPath)) {
        console.log(JSON.stringify({ fatal: `model not found: ${modelPath}` }));
        process.exitCode = 1;
        return;
    }
    const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'], protocolTimeout: 1800000 });
    const off = await runOnce(browser, false);
    const on = await runOnce(browser, true);
    await browser.close();

    const checks = [
        {
            name: 'default path does NOT use the worker (the flag stays opt-in)',
            pass: off.workerResults === 0,
            detail: `workerResults=${off.workerResults}, import ${off.importMs}ms`
        },
        {
            name: 'with the flag on, the worker really runs (fixed 假绿: workerResults > 0)',
            pass: on.workerResults > 0,
            detail: `workerResults=${on.workerResults}, import ${on.importMs}ms`
        },
        {
            name: 'both paths load the same gaussian count',
            pass: on.numSplats > 0 && on.numSplats === off.numSplats,
            detail: `worker=${on.numSplats}, main=${off.numSplats}`
        },
        {
            name: 'both paths load byte-identical columns (x/y/z/opacity/state/rot_0)',
            pass: Object.keys(on.checksums || {}).every(k => on.checksums[k] === off.checksums?.[k]),
            detail: JSON.stringify({ worker: on.checksums, main: off.checksums })
        },
        {
            name: 'worker path blocks the main thread for less time (informational)',
            pass: true,
            detail: `max main-thread gap: worker ${on.maxGapMs}ms (${on.blocksOver100ms} blocks >100ms) vs default ${off.maxGapMs}ms (${off.blocksOver100ms} blocks >100ms); wall ${on.importMs} vs ${off.importMs}ms`
        },
        {
            name: 'WHY THE FLAG IS STILL OFF (informational): the worker path changes selection results',
            pass: true,
            detail: `rect gesture selects: default ${off.gestureSelected} vs worker ${on.gestureSelected} (of ${off.numSplats}); depth push then: default ${off.pushSelected} vs worker ${on.pushSelected}. Byte-identical columns but different selection => the worker output differs in something the column hashes do not capture.`
        },
        {
            name: 'no page errors on either path',
            pass: on.errors.length === 0 && off.errors.length === 0,
            detail: JSON.stringify([...on.errors, ...off.errors]).slice(0, 300)
        }
    ];

    console.log(JSON.stringify({ model: MODEL, worker: on, mainThread: off, checks, failed: checks.filter(c => !c.pass).length }, null, 2));
    if (checks.some(c => !c.pass)) process.exitCode = 1;
})().catch(e => { console.log(JSON.stringify({ fatal: String(e).slice(0, 500) })); process.exitCode = 1; });
