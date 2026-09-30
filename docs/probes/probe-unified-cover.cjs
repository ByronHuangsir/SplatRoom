// 归档自 _tmp（2026-09-25 unified 通路排查那一轮），REPO 路径已按 docs/probes/ 调整。
// 探针 7：**这块材质到底能不能把像素写到可见目标上** —— 用"铺满屏幕"的顶点把几何问题绕开。
//
// 已知（§4r/§4s）：
//   · unified 帧里引擎的间接绘制**真的发了**（`drawIndexedIndirect(buffer, 0)`，每帧 1 次）；
//   · world 里有 2000 个 active splat、排序器与投影器都在、indirect 槽 0；
//   · 用的确实是我们的片元，且**不透明红烘焙也不上屏**、0 条 WebGPU 错误。
// 所以只剩两类解释：
//   G1 几何退化：顶点算出来的位置全在屏幕外/退化成点（`projCache` 或全局 `viewport_size` 在我们的
//      自建渲染循环里没被正确喂到 ⇒ clipOffset = 0 ⇒ 四边形塌成点 ⇒ 一个片元都不产生）
//   G2 更外层：管线/目标不对（写了但没进可见目标）
// 判据：`vsCover = 1` + `fragOpaque = 1` ⇒ 每个实例铺满屏幕且写不透明红。
//   画面变红 ⇒ G2 排除，问题在几何数据（下一步查 viewport_size / projCache）
//   画面不变 ⇒ G2 成立：绘制根本没进可见目标
//
// usage: node _tmp/probe-unified-cover.cjs [model]
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..', '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const { launchPatched: _launchPatched } = require('../verify/lib/browser.cjs');
const { decodePng } = require(path.join(REPO, 'docs', 'verify', 'lib', 'png.cjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL = process.argv[2] || 'test-model.ply';

const analyze = (f) => {
    const P = decodePng(fs.readFileSync(f));
    let r = 0;
    let g = 0;
    let b = 0;
    let red = 0;
    const n = P.width * P.height;
    for (let i = 0; i < P.data.length; i += P.channels) {
        r += P.data[i];
        g += P.data[i + 1];
        b += P.data[i + 2];
        if (P.data[i] > 150 && P.data[i + 1] < 90 && P.data[i + 2] < 90) red++;
    }
    return { meanRGB: [+(r / n).toFixed(2), +(g / n).toFixed(2), +(b / n).toFixed(2)], redPct: +((red / n) * 100).toFixed(2) };
};

(async () => {
    cleanupOrphanBrowsers();
    const browser = await _launchPatched(puppeteer, {
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 600000
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 640, height: 440 });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));

    await page.evaluateOnNewDocument(() => {
        window.__SPLATROOM_UNIFIED_BAKE__ = { fragOpaque: 1, vsCover: 1 };
        window.__SR_ERR__ = [];
        const hook = () => {
            const A = globalThis.GPUAdapter;
            if (!A || !A.prototype || A.prototype.__srE7) return false;
            A.prototype.__srE7 = true;
            const orig = A.prototype.requestDevice;
            A.prototype.requestDevice = async function (desc) {
                const dev = await orig.call(this, desc);
                try {
                    dev.addEventListener('uncapturederror', (e) => {
                        window.__SR_ERR__.push(String(e.error && e.error.message ? e.error.message : e.error).slice(0, 300));
                    });
                } catch (e) { /* ignore */ }
                return dev;
            };
            return true;
        };
        hook();
    });

    await page.goto('http://localhost:3100/?gpu=webgpu', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1200);
    await page.evaluate(async (m) => {
        const head = await fetch('./' + m, { headers: { Range: 'bytes=0-0' } });
        const total = parseInt(head.headers.get('content-range').split('/')[1], 10);
        const CHUNK = 256 * 1048576;
        const parts = [];
        for (let off = 0; off < total; off += CHUNK) {
            const end = Math.min(off + CHUNK - 1, total - 1);
            parts.push(await (await fetch('./' + m, { headers: { Range: `bytes=${off}-${end}` } })).blob());
        }
        await window.scene.events.invoke('import', [{ filename: m, contents: new File(parts, m) }]);
    }, MODEL);
    for (let i = 0; i < 40; i++) {
        await sleep(1000);
        if (await page.evaluate(() => (window.scene.elements || []).some((e) => e.entity && e.entity.gsplat))) break;
    }
    await sleep(1500);
    await page.evaluate(() => {
        const scene = window.scene;
        const el = (scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        if (el) scene.events.fire('selection', el);
    });
    await sleep(400);
    await page.evaluate(() => window.scene.events.fire('camera.focus'));
    await sleep(2000);

    const frames = (n) => page.evaluate(async (k) => {
        for (let i = 0; i < k; i++) {
            window.scene.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
        }
    }, n);
    const shot = async (name) => {
        const f = path.join(REPO, '_tmp', `cov-${name}.png`);
        fs.writeFileSync(f, Buffer.from(await page.screenshot({ encoding: 'base64' }), 'base64'));
        return f;
    };

    await frames(3);
    const cpu = await shot('cpu');

    await page.evaluate(async () => {
        const scene = window.scene;
        window.__SPLATROOM_UNIFIED__ = true;
        const el = (scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        el.entity.gsplat.unified = true;
        for (let i = 0; i < 60; i++) {
            scene.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
        }
    });
    await sleep(1500);
    await page.evaluate(() => { window.__SR_ERR__ = []; });
    await frames(4);
    await sleep(300);
    const uni = await shot('uni-cover');

    const install = await page.evaluate(() => window.__SPLATROOM_UNIFIED_MATERIAL_INSTALLED__ ?? null);
    const errors = await page.evaluate(() => window.__SR_ERR__.slice(0, 3));
    const errCount = await page.evaluate(() => window.__SR_ERR__.length);

    const aCpu = analyze(cpu);
    const aUni = analyze(uni);
    console.log(JSON.stringify({ model: MODEL, install, errors, errCount, cpu: aCpu, uni: aUni, pageErrs: errs.slice(0, 3) }, null, 1));
    console.log('\n=== 判定（vsCover = 1 每个实例铺满屏幕 + fragOpaque = 1 不透明红）===');
    console.log(`  安装：${JSON.stringify(install)}`);
    console.log(`  cpu 帧  ：${JSON.stringify(aCpu)}`);
    console.log(`  unified ：${JSON.stringify(aUni)}   （红像素占比应接近满屏）`);
    console.log(`  4 帧里 WebGPU 错误 ${errCount} 条`);
    if (errCount) console.log(`  首条：${JSON.stringify(errors[0])}`);
    console.log(`\n  ⇒ ${aUni.redPct > 50 ? '**G1：几何退化**（铺满屏幕就能上屏 ⇒ 问题在 projCache / viewport_size）' : aUni.redPct > 2 ? '部分上屏（半红，需要看截图）' : '**G2：绘制没进可见目标**（铺满屏幕也不上屏）'}`);

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
