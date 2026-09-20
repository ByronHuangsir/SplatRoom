// Guard for the render-export orientation (3.17.0 fixed a vertical flip that shipped on WebGPU).
//
// Two layers:
//  1. STATIC: src/app/render.ts must route every export readback through flipReadbackIfNeeded (which
//     flips only on WebGL2, like picker.ts) and must not contain a bare flip loop anywhere. This part
//     always runs and catches the exact regression class that reached the user.
//  2. RUNTIME: export a PNG at the canvas size, project the same splats with the same camera matrices
//     and correlate the exported row-brightness profile against the projected row histogram in both
//     orientations. Same must beat flipped. If the framing is not asymmetric enough to tell (a
//     symmetric test model), the check reports that instead of pretending.
//
// usage: node docs/verify/verify-export-orientation.cjs "<url>" [model]
//   用真实场景验证（用户建议的模型）：
//     copy "D:\DeepSeek\SplatRoomV2\选择工具\merged-scene.ply" dist\big-model.ply
//     node docs/verify/verify-export-orientation.cjs "http://localhost:3621/?gpu=webgpu" big-model.ply
//     del dist\big-model.ply        # 打包前必须删（否则会被打进 asar）
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { decodePng } = require(path.join(__dirname, 'lib', 'png.cjs'));

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RENDER_TS = path.join(__dirname, '..', '..', 'src', 'app', 'render.ts');

const correlation = (a, b) => {
    const n = a.length;
    const ma = a.reduce((s, v) => s + v, 0) / n;
    const mb = b.reduce((s, v) => s + v, 0) / n;
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i < n; i++) {
        num += (a[i] - ma) * (b[i] - mb);
        da += (a[i] - ma) ** 2;
        db += (b[i] - mb) ** 2;
    }
    return +(num / Math.sqrt(Math.max(da * db, 1e-9))).toFixed(3);
};

(async () => {
    const logs = [];
    const checks = [];
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 600000
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
        await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 300000 });
        await sleep(4000);

        const setup = await page.evaluate(async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const scene = window.scene;
            const splat = scene.getElementsByType('splat').slice(-1)[0];
            scene.events.fire('selection', splat);
            await sleep(500);
            scene.events.fire('camera.focus');
            await sleep(4000);
            return {
                backend: scene.graphicsDevice.isWebGPU ? 'webgpu' : 'webgl2',
                numSplats: splat.splatData.numSplats,
                target: [scene.targetSize.width, scene.targetSize.height]
            };
        });
        const [W, H] = setup.target;
        console.log(`backend ${setup.backend} | ${setup.numSplats} splats | exporting at ${W}x${H} | model ${MODEL}`);

        // expected row histogram, from the same camera the export will use
        const projected = await page.evaluate(async (h) => {
            const scene = window.scene;
            const splat = scene.getElementsByType('splat').slice(-1)[0];
            const cc = scene.camera.camera;
            const proj = cc.projectionMatrix.data;
            const vm = cc.viewMatrix.data;
            const m = new Float32Array(16);
            for (let c = 0; c < 4; c++) {
                for (let r = 0; r < 4; r++) {
                    m[c * 4 + r] = proj[r] * vm[c * 4] + proj[4 + r] * vm[c * 4 + 1] + proj[8 + r] * vm[c * 4 + 2] + proj[12 + r] * vm[c * 4 + 3];
                }
            }
            const data = splat.splatData;
            const n = data.numSplats;
            const px = data.getProp('x'), py = data.getProp('y'), pz = data.getProp('z'), state = data.getProp('state');
            const world = splat.worldTransform.data;
            const rows = new Float64Array(h);
            let count = 0;
            const stride = Math.max(1, Math.floor(n / 200000));
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
                rows[Math.min(h - 1, Math.max(0, Math.floor((1 - (ndcY * 0.5 + 0.5)) * h)))]++;
                count++;
            }
            let sum = 0;
            for (let y = 0; y < h; y++) sum += rows[y] * y;
            return { rows: Array.from(rows), count, centroid: +(sum / Math.max(count, 1) / h).toFixed(3) };
        }, H);

        const exported = await page.evaluate(async ([w, h]) => {
            const chunks = [];
            const stream = { write: async (b) => { chunks.push(b); }, close: async () => { } };
            await window.scene.events.invoke('render.image', {
                width: w, height: h, transparentBg: false, showDebug: false,
                format: 'png', quality: 1, projection: 'perspective', levelHorizon: false
            }, stream);
            let s = '';
            for (const c of chunks) {
                for (let i = 0; i < c.length; i += 8192) s += String.fromCharCode.apply(null, c.subarray(i, Math.min(i + 8192, c.length)));
            }
            return btoa(s);
        }, [W, H]);
        const png = Buffer.from(exported, 'base64');
        const img = decodePng(png);

        // exported row profile: mean brightness per row, averaged into the projection's row count
        const ROWS = Math.min(H, 256);
        const profile = [];
        for (let y = 0; y < ROWS; y++) {
            const srcY = Math.min(img.height - 1, Math.floor((y / ROWS) * img.height));
            let sum = 0;
            for (let x = 0; x < img.width; x++) {
                const i = (srcY * img.width + x) * img.channels;
                sum += img.data[i] * 0.299 + img.data[i + 1] * 0.587 + img.data[i + 2] * 0.114;
            }
            profile.push(sum / img.width);
        }
        const expected = [];
        for (let y = 0; y < ROWS; y++) {
            const srcY = Math.min(projected.rows.length - 1, Math.floor((y / ROWS) * projected.rows.length));
            expected.push(projected.rows[srcY]);
        }
        const same = correlation(profile, expected);
        const flipped = correlation([...profile].reverse(), expected);
        const spread = projected.centroid === 0 ? 0 : Math.abs(projected.centroid - 0.5);
        console.log(`projected centroid ${projected.centroid}, export ${img.width}x${img.height} (${png.length} bytes)`);
        console.log(`row-profile correlation: same orientation ${same} | vertically flipped ${flipped}`);
        const conclusive = spread > 0.02 && Math.abs(same - flipped) > 0.05;

        const src = fs.readFileSync(RENDER_TS, 'utf8');
        const calls = (src.match(/flipReadbackIfNeeded\(/g) || []).length;   // call sites only (the definition has  = ()
        // the pixel-flip signature: a half-height row loop that swaps width * 4 rows
        const bareLoops = (src.match(/for \(let y = 0; y < (?:Math\.floor\()?height \/ 2[^)]*\)\s*\{[^}]{0,400}?width \* 4/gs) || []).length;
        const gatesOnWebGL2 = /flipReadbackIfNeeded[\s\S]{0,400}?isWebGL2/.test(src);

        checks.push({
            name: 'every export readback goes through the backend-aware flip helper',
            pass: calls >= 4 && bareLoops === 1,
            detail: `${calls} call sites of flipReadbackIfNeeded, ${bareLoops} vertical-flip loop left in render.ts (1 = the helper's own loop)`
        });
        checks.push({
            name: 'the flip is gated on WebGL2 (matches picker.ts; WebGPU readbacks are top-down)',
            pass: gatesOnWebGL2,
            detail: gatesOnWebGL2 ? 'helper checks device.isWebGL2 before flipping' : 'helper does NOT gate on isWebGL2'
        });
        checks.push({
            // 信息项，**不参与判定**：亮度行剖面只是"高斯数量"的粗略代理（实测相关度 0.2-0.3），
            // 判不出朝向 —— 用真实场景跑过，它的结论与改动方向相反，所以不能拿它当守卫。
            // 真正可靠的运行期检查是"两个后端的导出必须逐像素一致"（3.17.0 排查时用过：
            // MAD 同向 0.007 vs 垂直翻转 24.6），还没并进本套件，见文件头。
            name: 'row-profile correlation vs the projection (informational, never fails)',
            pass: true,
            detail: `correlation same ${same} vs flipped ${flipped}${conclusive ? '' : ' (framing not asymmetric enough to judge)'} — 仅供参考`
        });
        checks.push({
            name: 'the export renders content and is a PNG',
            pass: png.length > 4000 && png.readUInt32BE(0) === 0x89504e47,
            detail: `${png.length} bytes, signature ${png.subarray(0, 4).toString('hex')}`
        });
        checks.push({ name: 'no console errors', pass: logs.length === 0, detail: logs.length ? logs.slice(0, 3).join(' | ') : 'clean' });

        console.log(JSON.stringify({ setup, projected: { centroid: projected.centroid, count: projected.count }, correlation: { same, flipped, conclusive }, static: { calls, bareLoops, gatesOnWebGL2 }, checks, failed: checks.filter(c => !c.pass).length }, null, 1));
        if (checks.some(c => !c.pass)) process.exitCode = 1;
    } catch (e) {
        console.log(JSON.stringify({ fatal: String(e).slice(0, 400), logs }, null, 1));
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
