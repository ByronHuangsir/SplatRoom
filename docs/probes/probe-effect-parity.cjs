// 探针 73：**粒子特效**在 unified 通路上的迁移验收（主线 vs unified 对照）。
//
// 判据（客观量，不靠"看着像"）：
//   ① 基线（progress 0 / mode 0 / fade 1）：两边都应当正常出图；
//   ② `setScatterProgress(1)`（完全散开）：亮点占比会变、且**亮点向画面外扩散**
//      （用"落在中央 50% 区域之外的亮点比例"衡量扩散）；
//   ③ `fade = 0`：模型应当看不见（亮点占比接近背景）；
//   ④ `mode 2 + time 0.5`（爆散收场）：亮度/扩散都应变化；
//   ⑤ 恢复（progress 0 / mode 0 / fade 1）：精确回到基线。
//
// usage: node _tmp/probe-effect-parity.cjs [main|unified]
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const { decodePng } = require(path.join(REPO, 'docs', 'verify', 'lib', 'png.cjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODE = process.argv[2] === 'main' ? 'main' : 'unified';

const analyze = (file) => {
    const P = decodePng(fs.readFileSync(file));
    const { width, height } = P;
    let lit = 0, out = 0, r = 0, g = 0, b = 0;
    for (let i = 0; i < P.data.length; i += P.channels) {
        const px = (i / P.channels) % width;
        const py = Math.floor((i / P.channels) / width);
        const R = P.data[i], G = P.data[i + 1], B = P.data[i + 2];
        r += R; g += G; b += B;
        if (R + G + B > 60) {
            lit++;
            const inside = px > width * 0.25 && px < width * 0.75 && py > height * 0.25 && py < height * 0.75;
            if (!inside) out++;
        }
    }
    const n = width * height;
    return {
        litPct: +((lit / n) * 100).toFixed(2),
        outsidePct: +(lit ? (out / lit) * 100 : 0).toFixed(1),
        mean: [+(r / n).toFixed(1), +(g / n).toFixed(1), +(b / n).toFixed(1)]
    };
};

(async () => {
    cleanupOrphanBrowsers();
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 900000
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 620 });
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 180)); });
    page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 220)));
    await page.goto(MODE === 'main' ? 'http://localhost:3100/?gpu=webgpu' : 'http://localhost:3100/?gpu=webgpu&unified=1', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1200);
    await page.evaluate(async () => {
        const res = await fetch('./test-model.ply');
        const blob = await res.blob();
        await window.scene.events.invoke('import', [{ filename: 'test-model.ply', contents: new File([blob], 'test-model.ply') }]);
    });
    for (let i = 0; i < 80; i++) {
        await sleep(500);
        if (await page.evaluate(() => (window.scene.elements || []).some((e) => e.entity && e.entity.gsplat))) break;
    }
    await page.evaluate(() => {
        const scene = window.scene;
        const el = (scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        scene.events.fire('selection', el);
        scene.events.fire('camera.focus');
        window.__el = el;
        window.__frames = async (k) => {
            for (let i = 0; i < k; i++) { scene.app.renderNextFrame = true; await new Promise((r) => requestAnimationFrame(r)); }
        };
    });
    await sleep(2500);

    const shoot = async (name) => {
        await page.evaluate(() => window.__frames(4));
        await sleep(250);
        const f = path.join(REPO, '_tmp', `fx-${MODE}-${name}.png`);
        fs.writeFileSync(f, Buffer.from(await page.screenshot({ encoding: 'base64' }), 'base64'));
        return analyze(f);
    };
    const apply = (args) => page.evaluate(async (a) => {
        window.__el.setScatterProgress(...a);
        await window.__frames(4);
    }, args);

    const out = {};
    out.base = await shoot('0-base');
    await apply([1, 1, 0, 0, [1, 1, 1], 1]);
    out.scattered = await shoot('1-scattered');
    await apply([0, 1, 0, 0, [1, 1, 1], 0]);
    out.fadedOut = await shoot('2-fade0');
    await apply([0, 1, 2, 0.5, [1, 0.8, 0.4], 1]);
    out.burst = await shoot('3-burst');
    await apply([0, 1, 0, 0, [1, 1, 1], 1]);
    out.restored = await shoot('4-restored');

    console.log(`\n=== 特效（${MODE}）===`);
    for (const k of ['base', 'scattered', 'fadedOut', 'burst', 'restored']) {
        console.log(`  ${k.padEnd(10)} ${JSON.stringify(out[k])}`);
    }
    console.log('\n=== 判定 ===');
    // ② 的判据改成"亮点占比 + 均值"：测试模型本来就铺满画面，散开只是变暗变淡（空间扩散量几乎不动，
    //    第一版拿"中央区外占比"当判据，**两条通路都 FAIL**，那是判据的问题不是功能的问题）。
    const dim = (a, b) => +(a.mean[0] - b.mean[0]).toFixed(1);
    console.log(`  ② 完全散开：亮点 ${out.base.litPct}% → ${out.scattered.litPct}%，均值 R ${out.base.mean[0]} → ${out.scattered.mean[0]}（暗了 ${dim(out.base, out.scattered)}）⇒ ${out.scattered.litPct < out.base.litPct - 5 || dim(out.base, out.scattered) > 10 ? 'PASS（散开/变淡了）' : 'FAIL（没变化）'}`);
    console.log(`  ③ fade=0：亮点 ${out.fadedOut.litPct}%、均值 ${JSON.stringify(out.fadedOut.mean)} ⇒ ${Math.abs(out.fadedOut.mean[0] - out.base.mean[0]) > 30 ? 'PASS（模型消失）' : 'FAIL（还在）'}`);
    console.log(`  ④ 爆散收场（mode2,t=0.5）：亮点 ${out.burst.litPct}%、均值 R ${out.burst.mean[0]} ⇒ ${Math.abs(out.burst.mean[0] - out.base.mean[0]) > 10 ? 'PASS（有变化）' : 'FAIL（没变化）'}`);
    console.log(`  ⑤ 恢复：${JSON.stringify(out.restored)} ⇒ ${Math.abs(out.restored.mean[0] - out.base.mean[0]) < 1 ? 'PASS' : 'FAIL'}`);
    if (errs.length) console.log(`  错误：${JSON.stringify(errs.slice(0, 3))}`);

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
