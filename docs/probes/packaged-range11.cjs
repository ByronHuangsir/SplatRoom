// 3.14.0 packaged end-to-end on the real 931k scan: a REAL mouse push of 最远 / 最近 must change the
// selection on the very first small move (the user's "首次滑动就能看到选区范围的变化").
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');

const EXE = process.argv[2] || path.join(__dirname, '..', '..', 'release', 'win-unpacked', 'SplatRoom.exe');
const SCAN = path.join(__dirname, '..', '..', '..', '_tmp', 'scan.ply');
const PORT = 3999;
const DEBUG_PORT = 9222;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const BAR = '#selection-range-bar';

const startServer = () => new Promise((resolve) => {
    const size = fs.statSync(SCAN).size;
    const server = http.createServer((req, res) => {
        if (!req.url.includes('scan.ply')) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size, 'Access-Control-Allow-Origin': '*' });
        fs.createReadStream(SCAN).pipe(res);
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
});

(async () => {
    const server = await startServer();
    const app = spawn(EXE, ['--remote-debugging-port=' + DEBUG_PORT, '--remote-allow-origins=*', '--gpu=webgpu'], { stdio: 'ignore' });
    const logs = [];
    try {
        let version = null;
        for (let i = 0; i < 90; i++) {
            try {
                version = await new Promise((resolve, reject) => {
                    http.get(`http://127.0.0.1:${DEBUG_PORT}/json/version`, (res) => {
                        let data = '';
                        res.on('data', (c) => { data += c; });
                        res.on('end', () => resolve(JSON.parse(data)));
                    }).on('error', reject);
                });
                break;
            } catch { await sleep(1000); }
        }
        if (!version) throw new Error('the packaged app did not open a debugging port');
        console.log('connected to', version.Browser);

        const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DEBUG_PORT}`, defaultViewport: null, protocolTimeout: 900000 });
        const pages = await browser.pages();
        const page = pages.find(p => p.url().startsWith('http://127.0.0.1:5173')) || pages[0];
        page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text().slice(0, 200)); });
        page.on('pageerror', e => logs.push('pageerror: ' + String(e).slice(0, 200)));
        await page.waitForFunction('!!window.scene', { timeout: 180000 });
        await sleep(3000);
        console.log('backend:', await page.evaluate(() => (window.scene.graphicsDevice.isWebGPU ? 'webgpu' : 'webgl2')));

        await page.evaluate(async (url) => {
            const buf = await (await fetch(url)).arrayBuffer();
            await window.scene.events.invoke('import', [{ filename: 'scan.ply', contents: new File([buf], 'scan.ply') }]);
        }, `http://127.0.0.1:${PORT}/scan.ply`);
        await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 600000 });
        await sleep(8000);

        const count = () => page.evaluate(() => {
            const splat = window.scene.getElementsByType('splat').slice(-1)[0];
            const st = splat.splatData.getProp('state');
            let n = 0;
            for (let i = 0; i < st.length; i++) if (st[i] & 1) n++;
            return n;
        });

        const setup = await page.evaluate(async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const scene = window.scene;
            const splat = scene.getElementsByType('splat').slice(-1)[0];
            scene.events.fire('selection', splat);
            await sleep(600);
            scene.events.fire('camera.focus');
            await sleep(3000);
            scene.events.fire('tool.rectSelection');
            await sleep(800);
            scene.events.fire('selection.resetRange');
            await sleep(300);
            scene.events.fire('select.none');
            await sleep(1500);
            const t0 = performance.now();
            await scene.events.invoke('select.rect', 'set', { start: { x: 0.35, y: 0.35 }, end: { x: 0.65, y: 0.65 } });
            return { numSplats: splat.splatData.numSplats, gestureMs: Math.round(performance.now() - t0) };
        });
        const through = await count();
        console.log(`imported ${setup.numSplats} splats | rect 35-65% ${setup.gestureMs} ms -> ${through} selected`);

        // a REAL mouse push of one depth block, counting what each step removes
        const pushDepth = async (handle, steps) => {
            await page.evaluate((sel, h) => {
                const row = document.querySelector(`${sel} .select-range-row[data-axis="depth"]`);
                const t = row.querySelector('.select-range-track').getBoundingClientRect();
                const b = row.querySelector(`.select-range-block[data-block="${h}"]`).getBoundingClientRect();
                window.__push = { fromX: b.left + b.width / 2, y: t.top + t.height / 2, t };
            }, BAR, handle);
            const g = await page.evaluate(() => ({ fromX: window.__push.fromX, y: window.__push.y }));
            await page.mouse.move(g.fromX, g.y);
            await page.mouse.down();
            const trace = [];
            for (const px of steps) {
                // 最近 (low) is pulled inward by pushing right, 最远 (high) by pulling left
                const target = handle === 'low' ? g.fromX + px : g.fromX - px;
                await page.mouse.move(target, g.y, { steps: 1 });
                await sleep(250);
                const n = await count();
                const r = await page.evaluate(() => window.scene.events.invoke('selection.depthRange'));
                trace.push({ px, selected: n, removed: through - n, range: r });
            }
            await page.mouse.up();
            await sleep(800);
            await page.evaluate((sel) => document.querySelector(`${sel} .select-toolbar-button`).click(), BAR);
            await sleep(2500);
            return trace;
        };

        // 最远: dragging the block leftwards pulls the far bound in
        const farPush = await pushDepth('high', [20, 40, 80, 160]);
        console.log('\n最远 push (far bound in, real mouse):');
        for (const s of farPush) {
            console.log(`  ${String(s.px).padStart(3)}px -> far ${String(s.range.far).padStart(6)}  selected ${String(s.selected).padStart(7)}  removed ${String(s.removed).padStart(7)} (${((s.removed / through) * 100).toFixed(2)}%)`);
        }

        const nearPush = await pushDepth('low', [20, 40, 80]);
        console.log('\n最近 push (near bound in, real mouse):');
        for (const s of nearPush) {
            console.log(`  ${String(s.px).padStart(3)}px -> near ${String(s.range.near).padStart(5)}  selected ${String(s.selected).padStart(7)}  removed ${String(s.removed).padStart(7)} (${((s.removed / through) * 100).toFixed(2)}%)`);
        }

        const afterReset = { selected: await count(), range: await page.evaluate(() => window.scene.events.invoke('selection.depthRange')) };
        console.log('\nreset:', JSON.stringify(afterReset.range), '| selected', afterReset.selected, '(through-pass was', through + ')');
        console.log('console errors:', JSON.stringify(logs));
        console.log(JSON.stringify({ setup, through, farPush, nearPush, afterReset, logs }, null, 1));
        await page.evaluate(() => window.scene.events.fire('tool.deactivate'));
        if (logs.length) process.exitCode = 1;
    } catch (e) {
        console.log(JSON.stringify({ fatal: String(e).slice(0, 400), logs }, null, 2));
        process.exitCode = 1;
    } finally {
        app.kill();
        server.close();
    }
})();
