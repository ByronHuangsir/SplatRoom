// merged-scene.ply, decisive probe for "从顶部框选中间的塔只选到一半":
//  - is the camera stable (no drift) while we measure?
//  - does the app's selection equal "the set of splats that project inside the box" (by INDEX)?
//  - if not, along which axis is the cut?
const fs = require('fs');
const http = require('http');
const puppeteer = require('C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PLY = process.argv[2] || 'D:/DeepSeek/SplatRoomV2/选择工具/merged-scene.ply';
const URL = process.argv[3] || 'http://localhost:3621/?gpu=webgpu';
const PORT = 3998;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const startServer = () => new Promise((resolve) => {
    const size = fs.statSync(PLY).size;
    const server = http.createServer((req, res) => {
        if (!req.url.includes('merged-scene.ply')) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size, 'Access-Control-Allow-Origin': '*' });
        fs.createReadStream(PLY).pipe(res);
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
});

(async () => {
    const server = await startServer();
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 1800000
    });
    const logs = [];
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1400, height: 900 });
        page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text().slice(0, 200)); });
        page.on('pageerror', e => logs.push('pageerror: ' + String(e).slice(0, 200)));
        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForFunction('!!window.scene', { timeout: 90000 });
        await sleep(2000);
        await page.evaluate(async (url) => {
            const buf = await (await fetch(url)).arrayBuffer();
            await window.scene.events.invoke('import', [{ filename: 'merged-scene.ply', contents: new File([buf], 'merged-scene.ply') }]);
        }, `http://127.0.0.1:${PORT}/merged-scene.ply`);
        await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 900000 });
        await sleep(12000);

        const out = await page.evaluate(async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const scene = window.scene;
            const splat = scene.getElementsByType('splat').slice(-1)[0];
            scene.events.fire('selection', splat);
            await sleep(800);
            scene.events.fire('camera.focus');
            await sleep(6000);
            scene.events.fire('camera.viewTop');
            await sleep(4000);
            scene.events.fire('tool.rectSelection');
            await sleep(800);
            scene.events.fire('selection.resetRange');
            await sleep(400);

            const data = splat.splatData;
            const n = data.numSplats;
            const px = data.getProp('x'), py = data.getProp('y'), pz = data.getProp('z'), state = data.getProp('state');
            const world = splat.worldTransform.data;
            const cam = scene.camera.camera;
            const canvas = scene.app.graphicsDevice.canvas;
            const size = () => [scene.targetSize.width, scene.targetSize.height];
            const camState = () => {
                const p = scene.camera.mainCamera.getPosition();
                const m = cam.viewMatrix.data;
                let h = 0;
                for (let i = 0; i < 16; i++) h = (h * 31 + Math.round(m[i] * 1e5)) % 1e9;
                return { pos: [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)], viewHash: h };
            };
            const proj = cam.projectionMatrix.data;
            const vm = cam.viewMatrix.data;
            const m = new Float32Array(16);
            for (let c = 0; c < 4; c++) {
                for (let r = 0; r < 4; r++) {
                    m[c * 4 + r] = proj[r] * vm[c * 4] + proj[4 + r] * vm[c * 4 + 1] + proj[8 + r] * vm[c * 4 + 2] + proj[12 + r] * vm[c * 4 + 3];
                }
            }

            const before = camState();
            const [W, H] = size();
            await sleep(2500);
            const after = camState();

            // the "middle tower": densest projected cluster -> take its bounding box
            const GW = 56, GH = 24;
            const cells = new Uint32Array(GW * GH);
            const stride = Math.max(1, Math.floor(n / 400000));
            for (let i = 0; i < n; i += stride) {
                if ((state[i] & 3) !== 0) continue;
                const lx = px[i], ly = py[i], lz = pz[i];
                const wx = world[0] * lx + world[4] * ly + world[8] * lz + world[12];
                const wy = world[1] * lx + world[5] * ly + world[9] * lz + world[13];
                const wz = world[2] * lx + world[6] * ly + world[10] * lz + world[14];
                const cw = m[3] * wx + m[7] * wy + m[11] * wz + m[15];
                if (cw <= 0) continue;
                const ndcX = (m[0] * wx + m[4] * wy + m[8] * wz + m[12]) / cw;
                const ndcY = (m[1] * wx + m[5] * wy + m[9] * wz + m[13]) / cw;
                if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) continue;
                cells[Math.min(GH - 1, Math.floor((1 - (ndcY * 0.5 + 0.5)) * GH)) * GW + Math.min(GW - 1, Math.floor((ndcX * 0.5 + 0.5) * GW))]++;
            }
            let best = 0;
            for (let i = 1; i < cells.length; i++) if (cells[i] > cells[best]) best = i;
            const bx = best % GW, by = Math.floor(best / GW);
            // a box around that cell, 3 cells wide / 4 tall
            const box = {
                start: { x: Math.max(0, (bx - 1) / GW), y: Math.max(0, (by - 1.5) / GH) },
                end: { x: Math.min(1, (bx + 2) / GW), y: Math.min(1, (by + 2.5) / GH) }
            };
            const bx0 = Math.round(box.start.x * W), bx1 = Math.round(box.end.x * W);
            const by0 = Math.round(box.start.y * H), by1 = Math.round(box.end.y * H);

            // the reference set: everything that projects inside that box, at any depth
            const inBox = [];
            const upOf = new Map();
            for (let i = 0; i < n; i++) {
                if ((state[i] & 3) !== 0) continue;
                const lx = px[i], ly = py[i], lz = pz[i];
                const wx = world[0] * lx + world[4] * ly + world[8] * lz + world[12];
                const wy = world[1] * lx + world[5] * ly + world[9] * lz + world[13];
                const wz = world[2] * lx + world[6] * ly + world[10] * lz + world[14];
                const cw = m[3] * wx + m[7] * wy + m[11] * wz + m[15];
                if (cw <= 0) continue;
                const ndcX = (m[0] * wx + m[4] * wy + m[8] * wz + m[12]) / cw;
                const ndcY = (m[1] * wx + m[5] * wy + m[9] * wz + m[13]) / cw;
                if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) continue;
                const sx = Math.floor((ndcX * 0.5 + 0.5) * W);
                const sy = Math.floor((1 - (ndcY * 0.5 + 0.5)) * H);
                if (sx < bx0 || sx > bx1 || sy < by0 || sy > by1) continue;
                inBox.push(i);
                upOf.set(i, wy);
            }

            await sleep(300);
            const t0 = performance.now();
            await scene.events.invoke('select.rect', 'set', box);
            const gestureMs = Math.round(performance.now() - t0);
            await sleep(1500);

            let selectedOfRef = 0;
            const selUp = [], refUp = [];
            const stack = [];
            for (const i of inBox) {
                const wy = upOf.get(i);
                refUp.push(wy);
                if ((state[i] & 1) !== 0) { selectedOfRef++; selUp.push(wy); }
                else stack.push(wy);
            }
            const hist = (arr, lo, hi) => {
                const bins = new Array(20).fill(0);
                for (const v of arr) bins[Math.min(19, Math.max(0, Math.floor(((v - lo) / Math.max(hi - lo, 1e-6)) * 20)))]++;
                return bins;
            };
            let lo = Infinity, hi = -Infinity;
            for (const v of refUp) { if (v < lo) lo = v; if (v > hi) hi = v; }
            return {
                numSplats: n, W, H, canvas: [canvas.width, canvas.height], dpr: window.devicePixelRatio,
                camBefore: before, camAfter: after, cellCount: cells[best], cell: [bx, by], box, boxPx: [bx0, bx1, by0, by1],
                gestureMs, reference: inBox.length, selectedOfRef,
                refLo: +lo.toFixed(3), refHi: +hi.toFixed(3),
                refHist: hist(refUp, lo, hi), selHist: hist(selUp, lo, hi), unselHist: hist(stack, lo, hi),
                depth: scene.events.invoke('selection.depthRange'), screen: scene.events.invoke('selection.screenRange')
            };
        });
        console.log(`splats ${out.numSplats} | targetSize ${out.W}x${out.H} | canvas ${out.canvas.join('x')} | dpr ${out.dpr}`);
        console.log('camera before:', JSON.stringify(out.camBefore), ' after 2.5s:', JSON.stringify(out.camAfter));
        console.log(`dense cell [${out.cell}] had ${out.cellCount} samples; box px ${JSON.stringify(out.boxPx)}`);
        console.log(`gesture ${out.gestureMs} ms | projects inside the box (any depth): ${out.reference} | SELECTED: ${out.selectedOfRef} (${((out.selectedOfRef / Math.max(out.reference, 1)) * 100).toFixed(1)}%)`);
        console.log(`world-up range of the box content: [${out.refLo}, ${out.refHi}]`);
        console.log('up-histogram ALL in box  :', out.refHist.join(' '));
        console.log('up-histogram SELECTED    :', out.selHist.join(' '));
        console.log('up-histogram NOT selected:', out.unselHist.join(' '));
        console.log('depth range:', JSON.stringify(out.depth), '| screen range:', JSON.stringify(out.screen));
        console.log('console errors:', JSON.stringify(logs.slice(0, 4)));
    } catch (e) {
        console.log('FATAL ' + String(e).slice(0, 400));
        process.exitCode = 1;
    } finally {
        await browser.close();
        server.close();
    }
})();
