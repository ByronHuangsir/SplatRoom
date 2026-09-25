// A3 的可见提示（docs/audit/00-总结.md A3 的兜底项）。
//
// 背景：投影缓存改成按字节预算之后，超过 3200 万点就 `createRangeCache` 返回 null，
// 推杆退回逐点重算（13M 上实测约 2 秒）。旧行为是**完全静默** —— 用户看到的只是"滑块好像坏了"。
// 现在 `runRangeSelection` 会 fire `selection.rangeCacheRefused`，范围浮条把标题换成一句说明。
//
// 真的做不出 3200 万点的模型来触发阈值，所以这里验证**接线**（事件 → 标题/类名切换），
// 阈值本身由常量表达：`CACHE_BYTES_PER_SPLAT × CACHE_MAX_SPLATS ≤ CACHE_MAX_BYTES`（见源码注释）。
//
// usage: node docs/verify/verify-range-cache-hint.cjs [url]
const puppeteer = require('puppeteer-core');

const { BROWSER_PATH: EDGE } = require('./lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
    const errors = [];
    let out = null;
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        page.on('pageerror', e => errors.push('pageerror: ' + String(e).slice(0, 300)));

        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForFunction('!!window.scene', { timeout: 60000 });
        await sleep(1500);
        await page.evaluate(async () => {
            const buf = await (await fetch('./test-model.ply')).arrayBuffer();
            await window.scene.events.invoke('import', [{ filename: 'test-model.ply', contents: new File([buf], 'test-model.ply') }]);
        });
        await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 60000, polling: 300 });
        await sleep(2500);

        const result = await page.evaluate(async () => {
            const sleep2 = (ms) => new Promise(r => setTimeout(r, ms));
            const scene = window.scene;
            const splat = scene.getElementsByType('splat')[0];
            scene.events.fire('selection', splat);
            await sleep2(500);
            scene.events.fire('camera.focus');
            await sleep2(2500);
            scene.events.fire('tool.rectSelection');
            await sleep2(600);

            const bar = document.getElementById('selection-range-bar');
            if (!bar) return { error: 'no #selection-range-bar' };
            const title = bar.querySelector('.select-toolbar-label');
            if (!title) return { error: 'no title label' };

            const readTitle = () => ({
                text: title.textContent,
                tooltip: title.dom ? title.dom.title : title.title,
                refused: title.classList.contains('range-refused')
            });

            // 一次真实手势：小模型不会被拒 ⇒ 标题应当是正常的「选区范围」
            await scene.events.invoke('select.rect', 'set', { start: { x: 0.35, y: 0.35 }, end: { x: 0.65, y: 0.65 } });
            await sleep2(1500);
            const normal = readTitle();

            // 手动触发被拒事件（阈值在真实模型上做不到 3200 万点）
            scene.events.fire('selection.rangeCacheRefused', true);
            await sleep2(400);
            const refused = readTitle();

            scene.events.fire('selection.rangeCacheRefused', false);
            await sleep2(400);
            const restored = readTitle();

            return { normal, refused, restored };
        });

        const checks = [
            { name: '范围浮条标题存在', pass: !!result.normal && !result.error, detail: result.error ?? '' },
            { name: '正常情况标题是「选区范围」且没有警示类名', pass: !!result.normal && !result.normal.refused && !/太大/.test(result.normal.text || ''), detail: JSON.stringify(result.normal) },
            { name: '★ 缓存被拒时标题换成说明文字且带上 range-refused 类', pass: !!result.refused && result.refused.refused && (result.refused.text || '').length > 8, detail: JSON.stringify(result.refused) },
            { name: '★ 提示可撤销（恢复后回到「选区范围」）', pass: !!result.restored && !result.restored.refused && result.restored.text === result.normal.text, detail: JSON.stringify(result.restored) }
        ];

        out = { result, checks, failed: checks.filter(c => !c.pass).length, errors };
    } catch (err) {
        out = { fatal: String(err).slice(0, 500), errors, failed: 1 };
    } finally {
        await browser.close();
    }

    console.log(JSON.stringify(out, null, 2));
    if (out.failed > 0) process.exitCode = 1;
})();
