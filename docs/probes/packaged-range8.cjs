// 3.11.0 packaged end-to-end: the range panel's new drag scaling on the real 931k scan.
//  - the blocks stay 25px wide while dragging, the 扩边 band grows instead
//  - the gap between the two blocks is 126px whatever the thickness (40 / 2 / 0.2 / 0.1)
//  - real mouse drags of the outer BAR (the CSS hit-test fix) and of the inner block
// usage: node packaged-range8.cjs [exePath]
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
        console.log('window:', await page.evaluate(() => [window.innerWidth, window.innerHeight, window.devicePixelRatio].join(' x ')));

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
        const geom = () => page.evaluate((sel) => {
            const track = document.querySelector(`${sel} .select-range-row[data-axis="x"] .select-range-track`);
            const t = track.getBoundingClientRect();
            const box = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.left - t.left), Math.round(b.width)]; };
            return {
                track: Math.round(t.width),
                blocks: Array.from(track.querySelectorAll('.select-range-block')).map(b => ({ side: b.getAttribute('data-block'), box: box(b) })),
                outers: Array.from(track.querySelectorAll('.select-range-handle-outer')).map(h => ({ name: h.getAttribute('data-handle'), box: box(h) })),
                core: box(track.querySelector('.select-range-core')),
                range: window.scene.events.invoke('selection.screenRange').x
            };
        }, BAR);
        const setRange = (x) => page.evaluate((p) => window.scene.events.fire('selection.setScreenRange', { x: p }), x);

        // --- setup: a real rect gesture so the panel is live on the real scan ---
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
            await scene.events.invoke('select.rect', 'set', { start: { x: 0.4, y: 0.4 }, end: { x: 0.6, y: 0.6 } });
            const gestureMs = Math.round(performance.now() - t0);
            const bar = document.querySelector('#selection-range-bar');
            const rows = Array.from(bar.querySelectorAll('.select-range-row'));
            return {
                numSplats: splat.splatData.numSplats,
                gestureMs,
                panel: [Math.round(bar.getBoundingClientRect().width), Math.round(bar.getBoundingClientRect().height)],
                tracks: rows.map(r => Math.round(r.querySelector('.select-range-track').getBoundingClientRect().width)),
                handles: rows.map(r => r.querySelectorAll('.select-range-handle').length),
                outerHandles: rows.map(r => r.querySelectorAll('.select-range-handle-outer').length),
                numericFields: rows.map(r => r.querySelectorAll('.pcui-numeric-input').length)
            };
        });
        const through = await count();
        console.log(`imported ${setup.numSplats} splats | rect 40-60% ${setup.gestureMs} ms -> ${through} selected`);
        console.log('panel:', JSON.stringify(setup.panel), 'tracks:', JSON.stringify(setup.tracks), 'handles/row:', JSON.stringify(setup.handles), 'numeric fields:', JSON.stringify(setup.numericFields));

        // --- 1. the invariant: gap 126px and block width 25px at every thickness ---
        const spanRows = [];
        for (const span of [40, 2, 0.2, 0.1]) {
            const low = 50, high = +(50 + span).toFixed(1);
            await setRange({ low, high, outerLow: low, outerHigh: high });
            await sleep(350);
            const g = await geom();
            spanRows.push({ span, gap: g.core[1], blockW: g.blocks.map(b => b.box[1]) });
            console.log(`  span ${span}: gap ${g.core[1]}px  blockW ${g.blocks.map(b => b.box[1]).join('/')}`);
        }

        // --- 2. real mouse drag of the OUTER bar: 扩边 band grows, block width unchanged ---
        await setRange({ low: 45, high: 55, outerLow: 45, outerHigh: 55 });
        await sleep(400);
        const beforeExpand = await geom();
        const beforeExpandCount = await count();
        const barBox = await page.evaluate((sel) => {
            const t = document.querySelector(`${sel} .select-range-row[data-axis="x"] .select-range-track`).getBoundingClientRect();
            const h = document.querySelector(`${sel} .select-range-row[data-axis="x"] .select-range-handle-outer[data-handle="outerLow"]`).getBoundingClientRect();
            const hit = document.elementFromPoint(h.left + h.width / 2, h.top + h.height / 2);
            return { x: h.left + h.width / 2, y: t.top + t.height / 2, trackLeft: t.left, trackWidth: t.width, hit: hit ? hit.className : null, hitHandle: hit ? hit.getAttribute('data-handle') : null };
        }, BAR);
        await page.mouse.move(barBox.x, barBox.y);
        await page.mouse.down();
        await page.mouse.move(barBox.trackLeft + barBox.trackWidth * 0.12, barBox.y, { steps: 12 });
        await page.mouse.up();
        await sleep(1500);
        const afterExpand = await geom();
        const expanded = await count();
        console.log(`  outer-bar hit-test: elementFromPoint -> ${barBox.hitHandle} (${barBox.hit})`);
        console.log(`  拖外柄扩边: outerLow 45 -> ${afterExpand.range.outerLow}（内边 low 保持 ${afterExpand.range.low}）| 选区带 ${JSON.stringify(beforeExpand.core)} -> ${JSON.stringify(afterExpand.core)} | blockW ${beforeExpand.blocks.map(b => b.box[1]).join('/')} -> ${afterExpand.blocks.map(b => b.box[1]).join('/')} | selected ${beforeExpandCount} -> ${expanded}`);

        // --- 3. real mouse drag of the inner block: deceleration while the gap holds ---
        await setRange({ low: 0, high: 100, outerLow: 0, outerHigh: 100 });
        await sleep(400);
        const start = await page.evaluate((sel) => {
            const t = document.querySelector(`${sel} .select-range-row[data-axis="x"] .select-range-track`).getBoundingClientRect();
            const b = document.querySelector(`${sel} .select-range-row[data-axis="x"] .select-range-block[data-block="low"]`).getBoundingClientRect();
            return { fromX: b.left + b.width / 2, y: t.top + t.height / 2 };
        }, BAR);
        await page.mouse.move(start.fromX, start.y);
        await page.mouse.down();
        const dragTrace = [];
        for (let i = 1; i <= 8; i++) {
            await page.mouse.move(start.fromX + i * 22, start.y, { steps: 1 });
            await sleep(200);
            const g = await geom();
            dragTrace.push({ px: i * 22, low: g.range.low, gap: g.core[1], blockW: g.blocks[0].box[1] });
        }
        await page.mouse.up();
        await sleep(1200);
        const trimmed = await count();
        console.log('  拖内块收边（每 22px）:', dragTrace.map(s => `${s.px}px:${s.low}(gap ${s.gap})`).join(' '));
        console.log(`  selected ${through} -> ${trimmed}`);

        // --- 4. reset ---
        await page.evaluate((sel) => document.querySelector(`${sel} .select-toolbar-button`).click(), BAR);
        await sleep(2500);
        const afterReset = { selected: await count(), range: await page.evaluate(() => window.scene.events.invoke('selection.screenRange').x) };
        console.log(`  reset: ${JSON.stringify(afterReset.range)} | selected ${afterReset.selected}`);

        console.log('  console errors:', JSON.stringify(logs));
        console.log(JSON.stringify({ setup, through, spanRows, expand: { hitHandle: barBox.hitHandle, outerLowBefore: 45, range: afterExpand.range, core: afterExpand.core, blockW: afterExpand.blocks.map(b => b.box[1]), selectedBefore: beforeExpandCount, selected: expanded }, dragTrace, trimmed, afterReset, logs }, null, 1));
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
