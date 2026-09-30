// Why do 左右/上下 feel dead? Pushes each x/y block with a real mouse and counts what changes,
// then dumps where the content sits inside the gesture box (the same analysis that fixed 最近/最远).
// usage: node xy-probe.cjs [model] [url]
const puppeteer = require('puppeteer-core');
const { BROWSER_PATH: EDGE , launchPatched: _launchPatched } = require('../verify/lib/browser.cjs');
const MODEL = process.argv[2] || 'big-model.ply';
const URL = process.argv[3] || 'http://localhost:3621/?gpu=webgpu';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const BAR = '#selection-range-bar';

(async () => {
    const browser = await _launchPatched(puppeteer, {
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    page.on('pageerror', e => console.log('[pageerror] ' + String(e).slice(0, 250)));
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 90000 });
    await sleep(1500);
    await page.evaluate(async (m) => {
        const buf = await (await fetch('./' + m)).arrayBuffer();
        await window.scene.events.invoke('import', [{ filename: m, contents: new File([buf], m) }]);
    }, MODEL);
    await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 600000 });
    await sleep(6000);

    const count = () => page.evaluate(() => {
        const splat = window.scene.getElementsByType('splat').slice(-1)[0];
        const st = splat.splatData.getProp('state');
        let n = 0;
        for (let i = 0; i < st.length; i++) if (st[i] & 1) n++;
        return n;
    });
    const ranges = () => page.evaluate(() => ({
        depth: window.scene.events.invoke('selection.depthRange'),
        screen: window.scene.events.invoke('selection.screenRange')
    }));

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
        await scene.events.invoke('select.rect', 'set', { start: { x: 0.35, y: 0.35 }, end: { x: 0.65, y: 0.65 } });
        await sleep(2000);
        return splat.splatData.numSplats;
    });
    const through = await count();
    const base = await ranges();
    console.log(`model ${MODEL}: ${setup} splats | rect 35-65% -> ${through} selected`);
    console.log('range:', JSON.stringify(base.screen));

    const push = async (axis, handle, pixels) => {
        await page.evaluate((sel, a, h) => {
            const row = document.querySelector(`${sel} .select-range-row[data-axis="${a}"]`);
            const t = row.querySelector('.select-range-track').getBoundingClientRect();
            const b = row.querySelector(`.select-range-block[data-block="${h}"]`).getBoundingClientRect();
            window.__g = { fromX: b.left + b.width / 2, y: t.top + t.height / 2 };
        }, BAR, axis, handle);
        const g = await page.evaluate(() => window.__g);
        const before = await count();
        await page.mouse.move(g.fromX, g.y);
        await page.mouse.down();
        const trace = [];
        for (const px of pixels) {
            // low/near blocks are pushed right, high/far blocks are pushed left
            const target = handle === 'low' ? g.fromX + px : g.fromX - px;
            await page.mouse.move(target, g.y, { steps: 1 });
            await sleep(200);
            const r = await ranges();
            trace.push({ px, selected: await count(), value: r.screen[axis][handle] });
        }
        await page.mouse.up();
        await sleep(500);
        await page.evaluate(() => window.scene.events.fire('selection.resetRange'));
        await sleep(500);
        return { before, trace };
    };

    for (const [axis, label] of [['x', '左右'], ['y', '上下']]) {
        for (const handle of ['low', 'high']) {
            const r = await push(axis, handle, [20, 40, 80, 160]);
            console.log(`\n${label} ${handle === 'low' ? '低端(左/上)' : '高端(右/下)'} push:`);
            for (const s of r.trace) {
                console.log(`  ${String(s.px).padStart(3)}px -> ${handle} ${String(s.value).padStart(6)}  selected ${String(s.selected).padStart(7)}  removed ${String(r.before - s.selected).padStart(7)} (${(((r.before - s.selected) / Math.max(r.before, 1)) * 100).toFixed(2)}%)`);
            }
        }
    }

    // where is the content inside the box?
    const spread = await page.evaluate(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        await window.scene.events.invoke('select.rect', 'set', { start: { x: 0.35, y: 0.35 }, end: { x: 0.65, y: 0.65 } });
        await sleep(1500);
        const scene = window.scene;
        const splat = scene.getElementsByType('splat').slice(-1)[0];
        const data = splat.splatData;
        const n = data.numSplats;
        const x = data.getProp('x'), y = data.getProp('y'), z = data.getProp('z'), state = data.getProp('state');
        const cam = scene.camera.camera;
        const mat = new Float32Array(16);
        const proj = cam.projectionMatrix.data;
        const vm = cam.viewMatrix.data;
        // view-projection = proj * view (PlayCanvas mul2)
        for (let c = 0; c < 4; c++) {
            for (let r = 0; r < 4; r++) {
                mat[c * 4 + r] = proj[r] * vm[c * 4] + proj[4 + r] * vm[c * 4 + 1] + proj[8 + r] * vm[c * 4 + 2] + proj[12 + r] * vm[c * 4 + 3];
            }
        }
        const m = splat.worldTransform.data;
        const W = scene.targetSize.width, H = scene.targetSize.height;
        // the gesture box in device pixels
        const px0 = Math.round(0.35 * W), px1 = Math.round(0.65 * W), py0 = Math.round(0.35 * H), py1 = Math.round(0.65 * H);
        const BINS = 40;
        const hist = new Array(BINS).fill(0);
        let inside = 0;
        for (let i = 0; i < n; i++) {
            if ((state[i] & 1) === 0) continue;
            const lx = x[i], ly = y[i], lz = z[i];
            const wx = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
            const wy = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
            const wz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
            const cw = mat[3] * wx + mat[7] * wy + mat[11] * wz + mat[15];
            if (cw <= 0) continue;
            const ndcX = (mat[0] * wx + mat[4] * wy + mat[8] * wz + mat[12]) / cw;
            const sx = Math.floor((ndcX * 0.5 + 0.5) * W);
            if (sx < px0 || sx > px1) continue;
            inside++;
            const b = Math.min(BINS - 1, Math.max(0, Math.floor(((sx - px0) / (px1 - px0)) * BINS)));
            hist[b]++;
        }
        return { inside, hist, BINS, box: [px0, px1, py0, py1], size: [W, H] };
    });
    console.log(`\ncontent across the gesture box (x): ${spread.inside} selected rows inside the box, ${spread.BINS} bins`);
    const mean = spread.inside / spread.BINS;
    console.log(`per-bin mean ${mean.toFixed(0)}`);
    for (let b = 0; b < spread.BINS; b++) {
        const c = spread.hist[b];
        console.log(`${String(b).padStart(3)} ${String((b * (100 / spread.BINS)).toFixed(1)).padStart(6)}%  ${String(c).padStart(7)}  ${'#'.repeat(Math.min(60, Math.round((c / Math.max(mean, 1)) * 6)))}`);
    }
    await browser.close();
})().catch(e => { console.log('FATAL ' + e); process.exit(1); });
