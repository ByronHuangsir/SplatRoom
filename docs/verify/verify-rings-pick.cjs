// 环模式（rings）拾取语义护栏。
//
// 为什么单独一套：`editor.ts` 里环模式的拾取掩码实现被改写过（2026-09-20，把"遍历全部点找 picked.has(i)"
// 换成"先 hit.fill(0) 再按拾取集合写 255"）—— 我复核过它逐位等价，但**当时没有任何套件覆盖环模式**
// （grep 全仓只有 verify-selection-range.cjs 提了一次 `rings`）。这条就是给那处改动预先注册的护栏。
//
// 判据（rings 与 centers 同区域对比，夹具自带"前墙 z=0 + 后墙 z=-0.6"）：
//   ① rings 模式下整屏框选**非空**；
//   ② rings 的选中数**明显少于** centers 下的同区域选择（"只选看得见的表面"语义）；
//   ③ rings 模式下推深度滑块**不改变**选中集合（既定语义：环模式沿用这次手势的拾取掩码，
//      见 editor.ts 的 rangeMask：`if (entry.ringPick) return pick`）；切回 centers 后滑块**会**改变。
//
// usage: node docs/verify/verify-rings-pick.cjs [url] [model]
const puppeteer = require('puppeteer-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const TARGET = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'], protocolTimeout: 1800000 });
    const errors = [];
    let out = null;
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        page.on('pageerror', e => errors.push('pageerror: ' + String(e).slice(0, 250)));
        page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });

        await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
        await sleep(1500);
        await page.evaluate(async (m) => {
            const buf = await (await fetch('./' + m)).arrayBuffer();
            await window.scene.events.invoke('import', [{ filename: m, contents: new File([buf], m) }]);
        }, MODEL);
        await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 90000, polling: 300 });
        await sleep(4000);

        const result = await page.evaluate(async () => {
            const sleep2 = (ms) => new Promise(r => setTimeout(r, ms));
            const scene = window.scene;
            const splat = scene.getElementsByType('splat')[0];
            const state = splat.splatData.getProp('state');
            const total = splat.splatData.numSplats;
            const count = () => { let n = 0; for (let i = 0; i < total; i++) if ((state[i] & 1) !== 0) n++; return n; };
            const full = { start: { x: 0, y: 0 }, end: { x: 1, y: 1 } };

            scene.events.fire('selection', splat);
            await sleep2(600);
            scene.events.fire('camera.focus');
            await sleep2(3000);

            const run = async (mode) => {
                scene.events.fire('camera.setMode', mode);
                await sleep2(1200);
                scene.events.fire('selection.resetRange');
                await sleep2(400);
                await scene.events.invoke('select.rect', 'set', full);
                await sleep2(2500);
                const afterRect = count();
                // 推一次深度（40-60），看选中是否变化
                scene.events.fire('selection.setDepthRange', { near: 40, far: 60 });
                await sleep2(2500);
                const afterDepth = count();
                scene.events.fire('selection.resetRange');
                await sleep2(600);
                return { afterRect, afterDepth, mode: scene.events.invoke('camera.mode') };
            };

            const rings = await run('rings');
            const centers = await run('centers');
            return { total, rings, centers };
        });

        const r = result.rings;
        const c = result.centers;
        const checks = [
            { name: '① rings 模式整屏框选非空', pass: r.afterRect > 0, detail: `选中 ${r.afterRect} / ${result.total}` },
            { name: '② rings 的选中数明显少于 centers（"只选看得见的表面"）', pass: r.afterRect > 0 && r.afterRect < c.afterRect, detail: `rings ${r.afterRect} vs centers ${c.afterRect}` },
            { name: '③ rings 模式下推深度滑块不改变选中（既定语义：沿用拾取掩码）', pass: r.afterDepth === r.afterRect, detail: `${r.afterRect} → ${r.afterDepth}` },
            { name: '④ 对照：centers 模式下推深度滑块**会**改变选中', pass: c.afterDepth !== c.afterRect, detail: `${c.afterRect} → ${c.afterDepth}` },
            { name: '⑤ 无 console/page error', pass: errors.length === 0, detail: errors.slice(0, 3).join(' | ') }
        ];

        out = { result, checks, failed: checks.filter(x => !x.pass).length, errors: errors.slice(0, 6) };
    } catch (err) {
        out = { fatal: String(err).slice(0, 500), errors: errors.slice(0, 6), failed: 1 };
    } finally {
        await browser.close();
    }

    console.log(JSON.stringify(out, null, 2));
    if (out.failed > 0) process.exitCode = 1;
})();
