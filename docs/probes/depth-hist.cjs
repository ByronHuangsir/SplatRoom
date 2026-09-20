// Where is the selected content along the view axis? Dumps the depth histogram of the splats a
// through-pass gesture selects, so the "empty tail" can be defined by density instead of quantiles.
// usage: node depth-hist.cjs [model] [url]
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const MODEL = process.argv[2] || 'big-model.ply';
const URL = process.argv[3] || 'http://localhost:3621/?gpu=webgpu';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    page.on('pageerror', e => console.log('[pageerror] ' + String(e).slice(0, 200)));
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 90000 });
    await sleep(1500);
    await page.evaluate(async (m) => {
        const buf = await (await fetch('./' + m)).arrayBuffer();
        await window.scene.events.invoke('import', [{ filename: m, contents: new File([buf], m) }]);
    }, MODEL);
    await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 600000 });
    await sleep(6000);

    const out = await page.evaluate(async () => {
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
        await scene.events.invoke('select.rect', 'set', { start: { x: 0.3, y: 0.3 }, end: { x: 0.7, y: 0.7 } });
        await sleep(2000);

        const cam = scene.camera.mainCamera;
        const pos = cam.getPosition();
        const dir = cam.forward;
        const data = splat.splatData;
        const n = data.numSplats;
        const x = data.getProp('x');
        const y = data.getProp('y');
        const z = data.getProp('z');
        const state = data.getProp('state');
        const hidden = data.getProp('hidden') || null;

        // the local->world transform of the splat entity
        const m = splat.worldTransform.data; // column-major 4x4
        const tx = (i) => m[0] * x[i] + m[4] * y[i] + m[8] * z[i] + m[12];
        const ty = (i) => m[1] * x[i] + m[5] * y[i] + m[9] * z[i] + m[13];
        const tz = (i) => m[2] * x[i] + m[6] * y[i] + m[10] * z[i] + m[14];

        let min = Infinity;
        let max = -Infinity;
        const selected = [];
        for (let i = 0; i < n; i++) {
            const px = tx(i) - pos.x;
            const py = ty(i) - pos.y;
            const pz = tz(i) - pos.z;
            const t = px * dir.x + py * dir.y + pz * dir.z;
            if (t < min) min = t;
            if (t > max) max = t;
            if ((state[i] & 1) !== 0 && (!hidden || (hidden[i] & 1) === 0)) selected.push(t);
        }
        const span = max - min;
        const BINS = 40;
        const bins = new Array(BINS).fill(0);
        for (const t of selected) {
            const b = Math.min(BINS - 1, Math.max(0, Math.floor(((t - min) / span) * BINS)));
            bins[b]++;
        }
        return { n, selected: selected.length, min, max, bins, BINS };
    });

    console.log(`model ${MODEL}: ${out.n} splats, through-pass selects ${out.selected}`);
    console.log(`depth extent ${out.min.toFixed(3)} .. ${out.max.toFixed(3)} (span ${(out.max - out.min).toFixed(3)})`);
    const mean = out.selected / out.BINS;
    console.log(`per-bin mean ${mean.toFixed(0)} splats (bins of ${(100 / out.BINS).toFixed(1)}% depth)`);
    console.log('bin  depth%   count   share   bar');
    for (let b = 0; b < out.BINS; b++) {
        const c = out.bins[b];
        const share = ((c / Math.max(out.selected, 1)) * 100).toFixed(2);
        const barLen = Math.min(50, Math.round((c / Math.max(mean, 1)) * 5));
        console.log(`${String(b).padStart(3)}  ${String(b * (100 / out.BINS)).padStart(6)}  ${String(c).padStart(7)}  ${share.padStart(5)}%  ${'#'.repeat(barLen)}`);
    }
    await browser.close();
})().catch(e => { console.log('FATAL ' + e); process.exit(1); });
