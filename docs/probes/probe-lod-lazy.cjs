// 归档自 _tmp（2026-09-26），REPO 路径已按 docs/probes/ 调整。
// 探针 50：验证"代理层改为按需构建"这两件事。
//
// A) **不再抢建**：导入 2000 万点真实扫描件后放着不动，代理层数应为 0、JS 堆应停在
//    "导入本身"的水平（改前 10.3GB → 建完 13.1GB，即抢建要多花约 2.9GB）。
// B) **该建的时候还会建**：把相机拉到 distRatio ≥ near(6.5) 之后，`lod.needs` 应被触发、
//    代理层建起来（lodAssets > 0），并且**画面仍然有东西**（不是白/黑屏）。
//
// usage: node _tmp/probe-lod-lazy.cjs [model] [A|B|AB] [webgl2|webgpu]
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..', '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const { decodePng } = require(path.join(REPO, 'docs', 'verify', 'lib', 'png.cjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL = process.argv[2] || 'splat_20m.ply';
const MODE = (process.argv[3] || 'AB').toUpperCase();
const BACKEND = process.argv[4] || 'webgl2';

const analyze = (f) => {
    const P = decodePng(fs.readFileSync(f));
    let light = 0, dark = 0, r = 0, g = 0, b = 0;
    const n = P.width * P.height;
    for (let i = 0; i < P.data.length; i += P.channels) {
        const R = P.data[i], G = P.data[i + 1], B = P.data[i + 2];
        r += R; g += G; b += B;
        if (R > 200 && G > 200 && B > 200) light++;
        if (R < 12 && G < 12 && B < 12) dark++;
    }
    return { mean: [+(r / n).toFixed(1), +(g / n).toFixed(1), +(b / n).toFixed(1)], lightPct: +((light / n) * 100).toFixed(2), darkPct: +((dark / n) * 100).toFixed(2) };
};

(async () => {
    cleanupOrphanBrowsers();
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 1800000
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 700 });
    const errs = [];
    const crash = { dead: false, what: null };
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 240)); });
    page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 300)));
    page.on('error', (e) => { crash.dead = true; crash.what = String(e).slice(0, 200); console.log('[CRASH]', crash.what); });

    await page.goto(`http://localhost:3100/?gpu=${BACKEND}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(2000);
    // 记录 lod.needs / lod.ready 有没有真的发生
    await page.evaluate(() => {
        window.__lodTrace = [];
        window.scene.events.on('lod.needs', () => window.__lodTrace.push(['needs', performance.now() | 0]));
        window.scene.events.on('lod.ready', (s, counts) => window.__lodTrace.push(['ready', performance.now() | 0, counts]));
        window.scene.events.on('lod.autoChanged', (v) => window.__lodTrace.push(['autoChanged', v]));
    });

    console.log(`导入 ${MODEL} …`);
    const t0 = Date.now();
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
    let ok = false;
    for (let i = 0; i < 400; i++) {
        await sleep(1000);
        if (crash.dead) break;
        ok = await page.evaluate(() => (window.scene.elements || []).some((e) => e.entity && e.entity.gsplat)).catch(() => false);
        if (ok) break;
    }
    console.log(`导入 ${ok ? '完成' : '失败'} ${Date.now() - t0}ms`);
    if (!ok) { console.log(JSON.stringify({ crash, errs: errs.slice(0, 6) })); try { await browser.close(); } catch { } return; }

    const state = () => page.evaluate(() => {
        const scene = window.scene;
        const el = (scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        const cam = scene.camera && scene.camera.mainCamera;
        const p = cam ? cam.getPosition() : null;
        const wb = el && el.worldBound;
        const radius = wb ? wb.halfExtents.length() : 0;
        const c = wb ? wb.center : null;
        const dist = (p && c) ? Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z) : 0;
        const m = performance.memory;
        return {
            heapMB: m ? +(m.usedJSHeapSize / 1048576).toFixed(0) : null,
            limitMB: m ? +(m.jsHeapSizeLimit / 1048576).toFixed(0) : null,
            numSplats: el ? el.splatData.numSplats : null,
            lodAssets: el ? el.lodAssets.length : null,
            lodLevel: el ? el.lodLevel : null,
            lodEnabled: el ? el.lodEnabled : null,
            buildRequested: el ? el._lodBuildRequested : null,
            camDistanceNorm: scene.camera ? +scene.camera.distance.toFixed(3) : null,
            sceneRadius: scene.camera ? +scene.camera.sceneRadius.toFixed(3) : null,
            distRatio: radius ? +(dist / radius).toFixed(2) : null,
            autoEnabled: scene.events.invoke('lod.autoEnabled'),
            allowProxy: scene.events.invoke('lod.allowProxy'),
            trace: window.__lodTrace.slice(-6)
        };
    }).catch((e) => ({ error: String(e).slice(0, 160) }));

    const shoot = async (name) => {
        const f = path.join(REPO, '_tmp', `lz-${BACKEND}-${name}.png`);
        fs.writeFileSync(f, Buffer.from(await page.screenshot({ encoding: 'base64' }), 'base64'));
        return analyze(f);
    };

    if (MODE.includes('A')) {
        // A) 导入后**什么都不做**，看代理层会不会自己建起来
        console.log('A) 导入后静置 40s（不发任何操作）…');
        const before = await state();
        await sleep(40000);
        const after = await state();
        const px = await shoot('A-idle');
        console.log(`  导入完成时：堆=${before.heapMB}MB 代理层=${before.lodAssets} 堆上限=${before.limitMB}MB autoLOD=${before.autoEnabled}`);
        console.log(`  静置 40s 后：堆=${after.heapMB}MB 代理层=${after.lodAssets} buildRequested=${after.buildRequested} distRatio=${after.distRatio}`);
        console.log(`  画面：${JSON.stringify(px)}    trace=${JSON.stringify(after.trace)}`);
        const grew = after.heapMB - before.heapMB;
        console.log(`  ⇒ 静置期间 JS 堆变化 ${grew >= 0 ? '+' : ''}${grew}MB；代理层数 ${after.lodAssets}（期望 0 = 没有抢建）`);
        console.log(`  ⇒ 结论A：${after.lodAssets === 0 ? 'PASS（没有抢建）' : 'FAIL（仍然抢建了）'}`);
    }

    if (MODE.includes('B')) {
        // B) 把相机拉到远处 → lod.needs 应触发 → 代理层建起来 → 画面还在
        console.log('B) 拉远相机直到 distRatio ≥ 6.5 …');
        let st = await state();
        for (const d of [2, 4, 8, 16, 32]) {
            await page.evaluate((v) => window.scene.camera.setDistance(v, 0), d);
            await sleep(2500);
            st = await state();
            console.log(`  归一化距离=${d} → 实际 distRatio=${st.distRatio} 代理层=${st.lodAssets} buildRequested=${st.buildRequested}`);
            if (st.lodAssets > 0) break;
            if (st.distRatio !== null && st.distRatio >= 6.5) break;
        }
        // 等构建完成（按需构建会在这里发生）
        for (let i = 0; i < 60; i++) {
            await sleep(2000);
            if (crash.dead) break;
            st = await state();
            if (st.lodAssets > 0) break;
        }
        const pxFar = await shoot('B-far');
        console.log(`  拉远后：堆=${st.heapMB}MB 代理层=${st.lodAssets} lodLevel=${st.lodLevel} distRatio=${st.distRatio} trace=${JSON.stringify(st.trace)}`);
        console.log(`  画面（远处）：${JSON.stringify(pxFar)}`);
        // 回到近处，代理层应退回全分辨率
        await page.evaluate(() => window.scene.camera.setDistance(0.5, 0));
        await sleep(4000);
        const stNear = await state();
        const pxNear = await shoot('B-near');
        console.log(`  拉回近处：lodLevel=${stNear.lodLevel} distRatio=${stNear.distRatio} 画面=${JSON.stringify(pxNear)}`);
        console.log(`  ⇒ 结论B：${st.lodAssets > 0 ? 'PASS（远处按需建起来了）' : 'FAIL（远处仍没建）'}；`);
        console.log(`          ${pxFar.lightPct < 85 ? '画面非白屏 PASS' : '画面疑似白屏 FAIL'}`);
    }

    console.log(`  渲染进程崩溃：${crash.dead ? crash.what : '无'}`);
    if (errs.length) console.log(`  错误（前 6 条）：${JSON.stringify(errs.slice(0, 6))}`);
    try { await browser.close(); } catch { }
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
