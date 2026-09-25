// 归档自 _tmp（2026-09-25 unified 通路根因定位那一轮），REPO 路径已按 docs/probes/ 调整。
// 探针 34：**验证入库的修复**（应用侧自动补 work buffer 首传，探针不再手动 invalidate）。
//
// 与 probe-unified-fix-upload.cjs 的区别：那一个是"人工触发"证明根因；
// 这一个跑的是**现在仓库里的代码路径** —— `scene.ts` 的 preRender 钩子里
// `ensureUnifiedWorkBuffer()` 会在需要时自动 `world.invalidate({ workBuffer: true })`。
// 判据（全部与着色无关）：
//   · renderCounter / numSplatsBuffer / sortElementCountBuffer 从 0 变成 ~1800；
//   · 画面 litPct 大幅上升、均值明显变亮（splat 真的画出来了）；
//   · 转相机 30° 的画面变化与 CPU 通路同量级。
//
// usage: node docs/probes/probe-unified-verified.cjs [model]
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..', '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const { decodePng } = require(path.join(REPO, 'docs', 'verify', 'lib', 'png.cjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL = process.argv[2] || 'test-model.ply';

const stats = (f) => {
    const P = decodePng(fs.readFileSync(f));
    let r = 0;
    let g = 0;
    let b = 0;
    let lit = 0;
    const n = P.width * P.height;
    for (let i = 0; i < P.data.length; i += P.channels) {
        r += P.data[i];
        g += P.data[i + 1];
        b += P.data[i + 2];
        if (0.299 * P.data[i] + 0.587 * P.data[i + 1] + 0.114 * P.data[i + 2] > 60) lit++;
    }
    return { meanRGB: [+(r / n).toFixed(2), +(g / n).toFixed(2), +(b / n).toFixed(2)], litPct: +((lit / n) * 100).toFixed(2) };
};
const diff = (a, b) => {
    const A = decodePng(fs.readFileSync(a));
    const B = decodePng(fs.readFileSync(b));
    let sum = 0;
    let changed = 0;
    const n = A.width * A.height;
    for (let i = 0; i < A.data.length; i += A.channels) {
        let d = 0;
        for (let c = 0; c < 3; c++) d += Math.abs(A.data[i + c] - B.data[i + c]);
        sum += d;
        if (d > 24) changed++;
    }
    return { mad: +(sum / n / 3).toFixed(4), changedPct: +((changed / n) * 100).toFixed(2) };
};

(async () => {
    cleanupOrphanBrowsers();
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 600000
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 640, height: 440 });
    const logs = [];
    page.on('console', (m) => logs.push(m.text().slice(0, 160)));
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));

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
        const f = path.join(REPO, '_tmp', `vf-${name}.png`);
        fs.writeFileSync(f, Buffer.from(await page.screenshot({ encoding: 'base64' }), 'base64'));
        return f;
    };
    const metrics = () => page.evaluate(async () => {
        const scene = window.scene;
        const dev = scene.app.graphicsDevice;
        let r = null;
        let mgr = null;
        scene?.app?.renderer?.gsplatDirector?.camerasMap?.forEach((cd) => {
            cd?.layersMap?.forEach((ld) => {
                if (ld?.gsplatManager?.renderer) { mgr = ld.gsplatManager; r = ld.gsplatManager.renderer; }
            });
        });
        if (!r) return { error: 'no renderer' };
        const readU32 = async (sb) => {
            const g = sb && sb.impl && sb.impl.buffer;
            if (!g) return null;
            const st = dev.wgpu.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
            const enc = dev.wgpu.createCommandEncoder();
            enc.copyBufferToBuffer(g, 0, st, 0, Math.min(4, g.size));
            dev.wgpu.queue.submit([enc.finish()]);
            await st.mapAsync(GPUMapMode.READ);
            const v = Array.from(new Uint32Array(st.getMappedRange().slice(0, 4)))[0];
            st.unmap();
            st.destroy();
            return v;
        };
        return {
            renderCounter: await readU32(r.projector.renderCounter),
            numSplats: await readU32(r.intervalCompaction.numSplatsBuffer),
            sortElementCount: await readU32(r.intervalCompaction.sortElementCountBuffer),
            install: window.__SPLATROOM_UNIFIED_MATERIAL_INSTALLED__ ?? null,
            worldVersion: mgr && mgr.world ? mgr.world.currentVersion : null
        };
    });

    const cpu = await shot('cpu');
    await frames(3);
    const cpuM = await metrics();

    // 开 unified —— 修复应当由应用的 preRender 钩子自动完成（这里**不**手动 invalidate）
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
    await frames(3);
    const uni = await shot('unified');
    const uniM = await metrics();

    await page.evaluate(async () => {
        const s = window.scene;
        s.camera.setAzimElev(s.camera.azim + 30, s.camera.elevation, 0);
        for (let i = 0; i < 4; i++) {
            s.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
        }
    });
    await sleep(400);
    const rot = await shot('unified-rot');
    const rotM = await metrics();

    console.log(JSON.stringify({
        model: MODEL,
        cpu: { metrics: cpuM, stats: stats(cpu) },
        unified: { metrics: uniM, stats: stats(uni) },
        rotated: { metrics: rotM, stats: stats(rot) },
        d: { uniVsCpu: diff(cpu, uni), rotControl: diff(uni, rot) },
        logs: logs.filter(l => /SplatRoom/.test(l)),
        errs: errs.slice(0, 3)
    }, null, 1));

    console.log('\n=== 判定（跑的是仓库里的代码，探针没有手动 invalidate）===');
    console.log(`  CPU  ：renderCounter=${cpuM.renderCounter} numSplats=${cpuM.numSplats} 画面=${JSON.stringify(stats(cpu))}`);
    console.log(`  unified：renderCounter=${uniM.renderCounter} numSplats=${uniM.numSplats} sortElementCount=${uniM.sortElementCount} 画面=${JSON.stringify(stats(uni))}`);
    console.log(`  转 30°：renderCounter=${rotM.renderCounter} numSplats=${rotM.numSplats}；画面变化 ${JSON.stringify(diff(uni, rot))}`);
    console.log(`  应用日志：${JSON.stringify(logs.filter(l => /SplatRoom/.test(l)))}`);
    const ok = (uniM.numSplats ?? 0) > 100 && (uniM.renderCounter ?? 0) > 100;
    console.log(`  ⇒ ${ok ? '**修复生效：unified 通路的 splat 真的画出来了**' : '修复没生效（numSplats 仍为 0 量级）'}`);

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
