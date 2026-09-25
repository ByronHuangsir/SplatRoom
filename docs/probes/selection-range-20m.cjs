// ③ 的量化（用户 2026-09-20 报的"选择范围只能收缩、无法扩展"）：
// 在 20M 模型上全屏框选后，用 selection.setDepthRange 逐档推深度、再推一次左右，
// 记下每一步的选中点数 —— 用来判断"密集区落在滑块行程的哪一段"。
// 实测结论（test-20m.ply）：0–100→19,282,378；40–60→13,930,757；48–52→2,644,133；
// 50–50.5→358,006 ⇒ 有用行程是一根针（密集区挤在深度 ≈50），这是"拉了没反应"的根因。
// 用法：node docs/probes/selection-range-20m.cjs <url> [model]
const puppeteer = require('puppeteer-core');
const { BROWSER_PATH: EDGE } = require('../verify/lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-20m.ply';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 3600000
    });
    const consoleErrors = [];
    const consoleWarns = [];
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        page.on('pageerror', e => consoleErrors.push('pageerror: ' + String(e).slice(0, 200)));
        page.on('console', (m) => {
            const t = m.text();
            if (m.type() === 'error') consoleErrors.push(t.slice(0, 200));
            if (m.type() === 'warning') consoleWarns.push(t.slice(0, 200));
        });

        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
        await sleep(1500);

        await page.evaluate(async (m) => {
            const head = await fetch('./' + m, { headers: { Range: 'bytes=0-0' } });
            const total = parseInt(head.headers.get('content-range').split('/')[1], 10);
            const CHUNK = 256 * 1048576;
            const parts = [];
            for (let off = 0; off < total; off += CHUNK) {
                const end = Math.min(off + CHUNK - 1, total - 1);
                parts.push(await (await fetch('./' + m, { headers: { Range: `bytes=${off}-${end}` } })).blob());
            }
            window.__file = new File(parts, m);
            window.__loadErr = null;
            window.scene.events.invoke('import', [{ filename: m, contents: window.__file }]).catch(e => { window.__loadErr = String(e).slice(0, 200); });
        }, MODEL);
        for (let i = 0; i < 90; i++) {
            await sleep(5000);
            const st = await page.evaluate(() => ({ n: window.scene.getElementsByType('splat').length, s: window.scene.getElementsByType('splat').map(x => x.splatData ? x.splatData.numSplats : 0), err: window.__loadErr }));
            if (st.n > 0 && st.s[0] > 0) break;
            if (st.err) throw new Error(st.err);
        }
        await sleep(8000);

        const result = await page.evaluate(async () => {
            const sleep2 = (ms) => new Promise(r => setTimeout(r, ms));
            const scene = window.scene;
            const splat = scene.getElementsByType('splat').slice(-1)[0];
            const state = splat.splatData.getProp('state');
            const total = splat.splatData.numSplats;
            const selCount = () => { let n = 0; for (let i = 0; i < total; i++) if ((state[i] & 1) !== 0) n++; return n; };

            const out = { total, mode: scene.events.invoke('camera.mode'), rows: [] };

            // 框住"整屏"（相机已按密集区取景）——这是用户实际会做的操作
            scene.events.fire('selection', splat);
            await sleep2(800);
            scene.events.fire('camera.focus');
            await sleep2(4000);

            const push = async (label, payload) => {
                const t = performance.now();
                await scene.events.invoke('select.rect', 'set', { start: { x: -1, y: -1 }, end: { x: 2, y: 2 } });
                await sleep2(2500);
                const full = selCount();
                scene.events.fire('selection.setDepthRange', payload);
                await sleep2(3500);
                const after = selCount();
                const range = scene.events.invoke('selection.depthRange');
                out.rows.push({ label, fullScreenSelected: full, afterPush: after, ms: Math.round(performance.now() - t), range });
            };

            await push('深度 0-100（默认整段）', { near: 0, far: 100 });
            await push('深度 10-90', { near: 10, far: 90 });
            await push('深度 25-75', { near: 25, far: 75 });
            await push('深度 40-60', { near: 40, far: 60 });
            await push('深度 48-52', { near: 48, far: 52 });
            await push('深度 49-51', { near: 49, far: 51 });
            await push('深度 50-50.5', { near: 50, far: 50.5 });
            await push('左右 40-60', { near: 0, far: 100, /* 复位深度后再只收左右 */ });
            scene.events.fire('selection.setScreenRange', { x: { low: 40, high: 60 } });
            await sleep2(3500);
            out.rows.push({ label: '左右 40-60（深度 0-100）', afterPush: selCount() });

            // 深度条的 DOM：看有没有 NaN / 行程信息
            const bar = document.querySelector('.selection-depth-bar') || document.querySelector('#selection-depth-bar');
            out.depthBar = {
                exists: !!bar,
                text: bar ? (bar.innerText || '').slice(0, 200) : null,
                html: bar ? bar.innerHTML.replace(/\s+/g, ' ').slice(0, 600) : null
            };
            // 检查页面里有没有 NaN 的 transform
            out.nanTransforms = Array.from(document.querySelectorAll('[transform]'))
                .map(e => e.getAttribute('transform'))
                .filter(t => t && t.includes('NaN'))
                .slice(0, 5);
            return out;
        });

        console.log('@@RESULT@@');
        console.log(JSON.stringify({ model: MODEL, ...result, consoleErrors: consoleErrors.slice(0, 8), consoleWarns: consoleWarns.slice(0, 8) }, null, 2));
    } catch (e) {
        console.log('@@RESULT@@');
        console.log(JSON.stringify({ fatal: String(e).slice(0, 400), consoleErrors: consoleErrors.slice(0, 8) }, null, 2));
    } finally {
        await browser.close();
    }
})();
