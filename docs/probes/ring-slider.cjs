// Does the rings-mode surface pick survive a slider push?
// The bug (audit selection.md #1): rangePost used to recompute the analytic through-pass mask on every
// push, silently replacing the picked surface. After the fix the entry keeps its ringPick mask.
// usage: node ring-slider.cjs [model] [url]
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const MODEL = process.argv[2] || 'big-model.ply';
const URL = process.argv[3] || 'http://localhost:3621/?gpu=webgpu';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 600000
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
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
        await sleep(4000);
        scene.events.fire('camera.setMode', 'rings');
        await sleep(700);
        scene.events.fire('tool.rectSelection');
        await sleep(700);
        scene.events.fire('selection.resetRange');
        await sleep(300);
        const count = () => {
            const st = splat.splatData.getProp('state');
            let n = 0;
            for (let i = 0; i < st.length; i++) if (st[i] & 1) n++;
            return n;
        };
        await scene.events.invoke('select.rect', 'set', { start: { x: 0.4, y: 0.4 }, end: { x: 0.6, y: 0.6 } });
        await sleep(1500);
        const afterGesture = count();
        const mode = scene.events.invoke('camera.mode');
        scene.events.fire('selection.setScreenRange', { x: { low: 5 } });
        await sleep(1800);
        const afterPush = count();
        scene.events.fire('selection.resetRange');
        await sleep(600);
        const afterReset = count();
        return { mode, afterGesture, afterPush, afterReset };
    });
    console.log(JSON.stringify(out));
    console.log(out.mode === 'rings' && out.afterGesture > 0 && out.afterPush === out.afterGesture
        ? 'OK: 推滑块后仍是拾取到的表面层（没有被穿透掩码覆盖）'
        : 'MISMATCH: gesture=' + out.afterGesture + ' push=' + out.afterPush);
    await browser.close();
})().catch(e => { console.log('FATAL ' + String(e).slice(0, 300)); process.exit(1); });
