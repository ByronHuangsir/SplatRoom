// 归档自 _tmp（2026-09-26），REPO 路径已按 docs/probes/ 调整。
// 探针 71：标定 `srCropMix`（盒局部坐标取"中心 ↔ 四角"的混合比例）。
//
// 目标（主线的实测值，作为对照）：
//   · **默认盒子**（= 模型包围盒，本该一点不切）：亮点占比变化 ≈ −0.06%
//   · **盒子缩到 1/4**：亮点占比 98.02% → 48.62%（−49.4%）
// 我这边纯用角点（mix=1）时：默认盒子 −5.1%（多切了一层壳）、小盒子 −49.2%（与主线一致）。
// 所以要在"小盒子仍与主线一致"的前提下，把默认盒子那一档压回 ≈ 0。
//
// usage: node _tmp/probe-crop-mix.cjs
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..', '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const { decodePng } = require(path.join(REPO, 'docs', 'verify', 'lib', 'png.cjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const analyze = (file) => {
    const P = decodePng(fs.readFileSync(file));
    let lit = 0;
    const n = P.width * P.height;
    for (let i = 0; i < P.data.length; i += P.channels) {
        if (P.data[i] + P.data[i + 1] + P.data[i + 2] > 60) lit++;
    }
    return +((lit / n) * 100).toFixed(2);
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
    page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)));
    await page.goto('http://localhost:3100/?gpu=webgpu&unified=1', { waitUntil: 'domcontentloaded', timeout: 120000 });
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
        await sleep(220);
        const f = path.join(REPO, '_tmp', `mix-${name}.png`);
        fs.writeFileSync(f, Buffer.from(await page.screenshot({ encoding: 'base64' }), 'base64'));
        return analyze(f);
    };

    const base = await shoot('base');
    console.log(`基线亮点占比：${base}%`);

    const results = [];
    for (const mix of [1.0, 0.6, 0.5, 0.35, 0.2]) {
        const r = await page.evaluate(async (m) => {
            const scene = window.scene;
            globalThis.__SPLATROOM_CROP_MIX__ = m;
            scene.events.fire('cropBox.initialize');
            await window.__frames(2);
            scene.events.fire('cropBox.setClipping', true);
            await window.__frames(4);
            const cb = scene.events.invoke('cropBox');
            const p = cb.pivot;
            return { scale: p.getLocalScale().toArray() };
        }, mix);
        const defaultBox = await shoot(`mix${mix}-default`);
        // 缩到 1/4（setState 的 scale 是半尺寸，所以传原值的 1/8）
        await page.evaluate(async () => {
            const scene = window.scene;
            const cb = scene.events.invoke('cropBox');
            const p = cb.pivot;
            const pos = p.getLocalPosition().clone();
            const scale = p.getLocalScale().clone();
            cb.setState(pos, scale.clone().mulScalar(0.125), p.getLocalRotation().clone());
            scene.events.fire('cropBox.changed');
            await window.__frames(4);
        });
        const smallBox = await shoot(`mix${mix}-small`);
        await page.evaluate(async () => {
            const scene = window.scene;
            scene.events.fire('cropBox.setClipping', false);
            await window.__frames(3);
        });
        results.push({ mix, defaultBox, smallBox, baseScale: r.scale.map(v => +v.toFixed(2)) });
        console.log(`  mix=${mix}: 默认盒子 ${base}% → ${defaultBox}%（Δ ${+(base - defaultBox).toFixed(2)}）；小盒子 → ${smallBox}%（Δ ${+(base - smallBox).toFixed(2)}）`);
    }

    console.log('\n=== 标定（主线对照：默认 Δ ≈ 0.06、小盒子 48.62%（Δ ≈ 49.4））===');
    for (const r of results) {
        const d1 = +(base - r.defaultBox).toFixed(2);
        const d2 = +(base - r.smallBox).toFixed(2);
        console.log(`  mix=${r.mix}: 默认 ${d1 >= 0 ? '-' : '+'}${Math.abs(d1)}%（目标 ≈ 0.06）  小盒子 ${r.smallBox}%（目标 48.62）`);
    }

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
