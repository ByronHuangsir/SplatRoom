// 归档自 _tmp（2026-09-26），REPO 路径已按 docs/probes/ 调整。
// 探针 66：**裁剪盒**在 unified 通路上的迁移验收（主线 vs unified 对照）。
//
// 判据（不靠"看着像"）：
//   ① 基线：不开裁剪时两边的"亮点占比 / 均值"应当接近；
//   ② 开裁剪 + 缩小盒子之后，**亮像素占比必须明显下降**（模型被切掉一部分）；
//   ③ 关掉裁剪后必须回到基线（说明不是"一次性画坏"）；
//   ④ preview（幽灵预览）模式：外面的部分变得很淡（占比回升但仍与基线不同）。
//
// 用法：node _tmp/probe-crop-parity.cjs
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..', '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const { launchPatched: _launchPatched } = require('../verify/lib/browser.cjs');
const { decodePng } = require(path.join(REPO, 'docs', 'verify', 'lib', 'png.cjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const analyze = (file) => {
    const P = decodePng(fs.readFileSync(file));
    let r = 0, g = 0, b = 0, lit = 0;
    const n = P.width * P.height;
    for (let i = 0; i < P.data.length; i += P.channels) {
        const R = P.data[i], G = P.data[i + 1], B = P.data[i + 2];
        r += R; g += G; b += B;
        if (R + G + B > 60) lit++;
    }
    return {
        mean: [+(r / n).toFixed(1), +(g / n).toFixed(1), +(b / n).toFixed(1)],
        litPct: +((lit / n) * 100).toFixed(2)
    };
};

const runOne = async (browser, unified) => {
    const tag = unified ? 'unified' : 'main';
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 620 });
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
    page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 250)));
    await page.goto(unified ? 'http://localhost:3100/?gpu=webgpu&unified=1' : 'http://localhost:3100/?gpu=webgpu', { waitUntil: 'domcontentloaded', timeout: 120000 });
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
        window.__frames = async (k) => {
            for (let i = 0; i < k; i++) { scene.app.renderNextFrame = true; await new Promise((r) => requestAnimationFrame(r)); }
        };
    });
    await sleep(2500);

    const shoot = async (name) => {
        await page.evaluate(() => window.__frames(4));
        await sleep(300);
        const f = path.join(REPO, '_tmp', `crop-${tag}-${name}.png`);
        fs.writeFileSync(f, Buffer.from(await page.screenshot({ encoding: 'base64' }), 'base64'));
        return analyze(f);
    };

    const out = { tag };
    out.base = await shoot('0-base');

    // 初始化裁剪盒（按模型包围盒）。**缩小要改 pivot 的 scale，不是 radius** ——
    // box 形状的判定是 `0.5 - max|local|`（局部单位立方体），radius* 只对圆柱/椭球生效；
    // 第一版探针改的是 radius，结果主线"纹丝不动"，差点被误判成主线坏了。
    const init = await page.evaluate(async () => {
        const scene = window.scene;
        scene.events.fire('cropBox.initialize');
        await window.__frames(2);
        const cb = scene.events.invoke('cropBox');
        if (!cb) return { ok: false };
        const st = cb.getState ? cb.getState() : null;
        const before = st ? { pos: st.position.toArray(), scale: st.scale.toArray() } : null;
        if (st) {
            cb.setState(st.position, st.scale.clone().mulScalar(0.55), st.rotation);
        }
        scene.events.fire('cropBox.changed');
        scene.events.fire('cropBox.setClipping', true);
        await window.__frames(3);
        const after = cb.getState ? { scale: cb.getState().scale.toArray() } : null;
        return { ok: true, enabled: cb.enabled, shape: cb.shape, soft: cb.softEdge, before, after };
    });
    out.init = init;
    out.clipped = await shoot('1-clipped');

    out.preview = await page.evaluate(async () => {
        window.scene.events.fire('cropBox.setPreview', true);
        await window.__frames(3);
        return true;
    }).then(() => shoot('2-preview'));

    await page.evaluate(async () => {
        window.scene.events.fire('cropBox.setPreview', false);
        window.scene.events.fire('cropBox.setClipping', false);
        await window.__frames(4);
    });
    out.off = await shoot('3-off');

    out.errs = errs.slice(0, 3);
    await page.close();
    return out;
};

(async () => {
    cleanupOrphanBrowsers();
    const browser = await _launchPatched(puppeteer, {
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 900000
    });
    const main = await runOne(browser, false);
    const uni = await runOne(browser, true);

    console.log('\n=== 裁剪盒对照 ===');
    for (const r of [main, uni]) {
        console.log(`  [${r.tag}] init=${JSON.stringify(r.init)}`);
        console.log(`     基线 ${JSON.stringify(r.base)}`);
        console.log(`     开裁剪+缩小 ${JSON.stringify(r.clipped)}`);
        console.log(`     预览模式 ${JSON.stringify(r.preview)}`);
        console.log(`     关裁剪 ${JSON.stringify(r.off)}`);
        if (r.errs.length) console.log(`     错误：${JSON.stringify(r.errs)}`);
    }
    console.log('\n=== 判定 ===');
    const drop = (r) => +(r.base.litPct - r.clipped.litPct).toFixed(2);
    const restore = (r) => Math.abs(r.off.litPct - r.base.litPct).toFixed(2);
    for (const r of [main, uni]) {
        console.log(`  [${r.tag}] 开裁剪后亮点占比 ${r.base.litPct}% → ${r.clipped.litPct}%（下降 ${drop(r)}）⇒ ${drop(r) > 3 ? 'PASS（确实切掉了）' : 'FAIL（没切）'}`);
        console.log(`         关掉后回到 ${r.off.litPct}%（与基线差 ${restore(r)}）⇒ ${Math.abs(r.off.litPct - r.base.litPct) < 2 ? 'PASS' : 'FAIL'}`);
        console.log(`         预览模式 ${r.preview.litPct}% ⇒ ${r.preview.litPct > r.clipped.litPct ? 'PASS（外面变淡可见）' : 'FAIL'}`);
    }

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
