// 归档自 _tmp（2026-09-26），REPO 路径已按 docs/probes/ 调整。
// 探针 49：按**用户真实工作流**在 20M 真实模型上复现"选中删除过程中白屏"。
//
// 与探针 47 的区别（47 只在 6.5M 上、相机贴着模型、没有 LOD 代理层参与）：
//   ① 用用户真正在用的那一档模型（4.96GB / 20,000,000 高斯）；
//   ② **先把相机拉远**（`LOD_NEAR_RATIO = 6.5` / `LOD_FAR_RATIO = 18`，半径倍数）——
//      拉远后运行时 LOD 代理层才会接管（B 档自动开），而代理层的开关闸门就是**选区状态**：
//      `lod.allowProxy` 要求"没选中、没在拖、没在撤销"。于是"框选/删除"正好把这个闸门来回翻，
//      每次翻动都会走 `Splat.applyLod(-1|level)` → `replaceData()`（对 20M 就是重建整套 GPU 数据）；
//   ③ 给 `replaceData` / `applyLod` 打桩，记录**并发数**（`applyLod` 是 async，
//      而它只在 `await replaceData()` 之后才更新 `lodLevel`/`_lodLastSwitchAt`，
//      中间要等一帧 —— 期间每帧的 `updateLodSwitching` 都会看到**过期的 lodLevel** 并再发一次切换）；
//   ④ 每步都量：画面是否变白/变空、渲染进程是否崩、JS 堆、lodLevel 与实际绑定的 asset 是否一致。
//
// usage: node _tmp/probe-big-workflow.cjs [model] [webgl2|webgpu]
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..', '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const { launchPatched: _launchPatched } = require('../verify/lib/browser.cjs');
const { decodePng } = require(path.join(REPO, 'docs', 'verify', 'lib', 'png.cjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL = process.argv[2] || 'splat_20m.ply';
const BACKEND = process.argv[3] || 'webgl2';

const analyze = (f) => {
    const P = decodePng(fs.readFileSync(f));
    let light = 0;
    let r = 0, g = 0, b = 0;
    const n = P.width * P.height;
    for (let i = 0; i < P.data.length; i += P.channels) {
        const R = P.data[i], G = P.data[i + 1], B = P.data[i + 2];
        r += R; g += G; b += B;
        if (R > 200 && G > 200 && B > 200) light++;
    }
    return {
        mean: [+(r / n).toFixed(1), +(g / n).toFixed(1), +(b / n).toFixed(1)],
        lightPct: +((light / n) * 100).toFixed(2)
    };
};

(async () => {
    cleanupOrphanBrowsers();
    const browser = await _launchPatched(puppeteer, {
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 1800000
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 760 });
    const errs = [];
    const crash = { dead: false, what: null };
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 240)); });
    page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 300)));
    page.on('error', (e) => { crash.dead = true; crash.what = String(e).slice(0, 200); console.log('[CRASH]', crash.what); });

    await page.goto(`http://localhost:3100/?gpu=${BACKEND}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(2000);

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
    if (!ok) {
        console.log(JSON.stringify({ crash, errs: errs.slice(0, 6) }, null, 1));
        try { await browser.close(); } catch { /* gone */ }
        cleanupOrphanBrowsers();
        return;
    }

    // ---- 打桩：记录 LOD 切换的并发与失败 ----
    await page.evaluate(() => {
        const scene = window.scene;
        const el = (scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        window.__lod = { events: [], inFlight: 0, maxInFlight: 0, applyCalls: 0, errors: [] };
        const origReplace = el.replaceData.bind(el);
        el.replaceData = async function (asset, keep) {
            const rec = { t: performance.now(), inFlight: ++window.__lod.inFlight, asset: (asset && asset.file && asset.file.filename) || '?' };
            window.__lod.maxInFlight = Math.max(window.__lod.maxInFlight, rec.inFlight);
            window.__lod.events.push({ ...rec, kind: 'start' });
            try {
                const r = await origReplace(asset, keep);
                window.__lod.events.push({ t: performance.now(), kind: 'end', asset: rec.asset, after: rec.inFlight });
                return r;
            } catch (e) {
                window.__lod.errors.push(String(e).slice(0, 200));
                throw e;
            } finally {
                window.__lod.inFlight--;
            }
        };
        const origApply = el.applyLod.bind(el);
        el.applyLod = async function (level) {
            window.__lod.applyCalls++;
            return origApply(level);
        };
        scene.events.fire('selection', el);
        scene.events.fire('camera.focus');
    });
    await sleep(4000);

    const snap = async () => page.evaluate(() => {
        const scene = window.scene;
        const el = (scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        const cam = scene.camera && scene.camera.mainCamera;
        const p = cam ? cam.getPosition() : null;
        const wb = el && el.worldBound;
        const radius = wb ? wb.halfExtents.length() : 0;
        const c = wb ? wb.center : null;
        const dist = (p && c) ? Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z) : 0;
        const m = performance.memory;
        const st = el && el.splatData ? el.splatData.getProp('state') : null;
        let selected = 0, deleted = 0;
        if (st) for (let i = 0; i < st.length; i++) { if (st[i] & 1) selected++; if (st[i] & 2) deleted++; }
        return {
            heapMB: m ? +(m.usedJSHeapSize / 1048576).toFixed(0) : null,
            limitMB: m ? +(m.jsHeapSizeLimit / 1048576).toFixed(0) : null,
            numSplats: el ? el.splatData.numSplats : null,
            lodAssets: el ? el.lodAssets.length : null,
            lodLevel: el ? el.lodLevel : null,
            lodEnabled: el ? el.lodEnabled : null,
            visibleSplats: el ? el.numSplats : null,
            selected, deleted,
            distRatio: radius ? +(dist / radius).toFixed(2) : null,
            instanceOk: !!(el && el.entity && el.entity.gsplat && el.entity.gsplat.instance),
            lod: { ...window.__lod, events: window.__lod.events.slice(-8) }
        };
    }).catch((e) => ({ error: String(e).slice(0, 160) }));

    const steps = [];
    const shoot = async (name) => {
        const f = path.join(REPO, '_tmp', `bw-${BACKEND}-${name}.png`);
        fs.writeFileSync(f, Buffer.from(await page.screenshot({ encoding: 'base64' }), 'base64'));
        return analyze(f);
    };
    const step = async (name, act) => {
        const t = Date.now();
        if (act) await act();
        await sleep(2500);
        const s = await snap();
        const px = await shoot(name).catch(() => null);
        steps.push({ name, ms: Date.now() - t, ...s, px });
        console.log(`  ${name.padEnd(22)} 堆=${s.heapMB}MB lod=${s.lodLevel}/${s.lodAssets} 可见=${s.visibleSplats} 选=${s.selected} 删=${s.deleted} distRatio=${s.distRatio} 画面=${px ? JSON.stringify(px.mean) + ' 亮' + px.lightPct + '%' : '?'} 并发峰值=${s.lod ? s.lod.maxInFlight : '?'}`);
        if (crash.dead) throw new Error('渲染进程崩溃：' + crash.what);
        return s;
    };

    try {
        await step('0-导入后');
        // 生成代理层（分级 B 档自动开，但 waitForIdle 后才会构建；这里直接催一次）
        await page.evaluate(() => {
            const scene = window.scene;
            const el = (scene.elements || []).find((e) => e.entity && e.entity.gsplat);
            scene.events.invoke('lod.generateForSplat', el);
        });
        for (let i = 0; i < 40; i++) {
            await sleep(1500);
            const n = await page.evaluate(() => {
                const el = (window.scene.elements || []).find((e) => e.entity && e.entity.gsplat);
                return el ? el.lodAssets.length : 0;
            }).catch(() => 0);
            if (n > 0) break;
        }
        await step('1-代理层就绪');

        // **拉远**（用户要看清整个房间就会这么做）→ 代理层应接管
        await page.evaluate(() => {
            const scene = window.scene;
            const el = (scene.elements || []).find((e) => e.entity && e.entity.gsplat);
            const wb = el.worldBound;
            const c = wb.center;
            const r = wb.halfExtents.length();
            scene.events.fire('camera.setPose', {
                position: { x: c.x + r * 30, y: c.y + r * 12, z: c.z + r * 30 },
                target: { x: c.x, y: c.y, z: c.z }
            }, 1e9);
            scene.events.fire('select.none');
        });
        await step('2-拉远(代理接管?)');

        // 用户工作流：框选 → 删除 → 取消选择，来回 4 轮（闸门每轮翻两次）
        for (let i = 0; i < 4; i++) {
            await step(`3-${i}-框选`, async () => {
                await page.evaluate(async () => {
                    const scene = window.scene;
                    scene.events.fire('select.none');
                    await scene.events.invoke('select.rect', 'set', { start: { x: 0.2, y: 0.2 }, end: { x: 0.8, y: 0.8 } });
                });
            });
            await step(`3-${i}-删除`, async () => { await page.evaluate(() => window.scene.events.fire('select.delete')); });
            await step(`3-${i}-取消选择`, async () => { await page.evaluate(() => window.scene.events.fire('select.none')); });
        }
        await step('4-收尾');
    } catch (e) {
        steps.push({ name: 'ABORT', error: String(e).slice(0, 240) });
        console.log('  !! 中断：' + String(e).slice(0, 240));
    }

    console.log(`\n=== ${MODEL} / ${BACKEND} 工作流复现 ===`);
    console.log(`  渲染进程崩溃：${crash.dead ? crash.what : '无'}`);
    const blank = steps.filter((s) => s.px && s.px.lightPct > 85);
    console.log(`  画面大面积变亮（疑似白屏）的步骤：${blank.length ? JSON.stringify(blank.map((s) => s.name)) : '无'}`);
    const last = await snap().catch(() => null);
    if (last && last.lod) {
        console.log(`  LOD 切换：applyLod 调用 ${last.lod.applyCalls} 次，replaceData 并发峰值 ${last.lod.maxInFlight}，错误 ${JSON.stringify(last.lod.errors.slice(0, 3))}`);
        console.log('  最近 8 条 replaceData 事件：');
        for (const e of last.lod.events) console.log(`    ${e.kind} t=${e.t.toFixed(0)} inFlight=${e.inFlight} asset=${e.asset}`);
    }
    if (errs.length) console.log(`  错误（前 6 条）：${JSON.stringify(errs.slice(0, 6))}`);
    fs.writeFileSync(path.join(REPO, '_tmp', `bw-${BACKEND}-steps.json`), JSON.stringify({ MODEL, BACKEND, crash, steps: steps.map(({ lod, ...r }) => r) }, null, 1));

    try { await browser.close(); } catch { /* gone */ }
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
