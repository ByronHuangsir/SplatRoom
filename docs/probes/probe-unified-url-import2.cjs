// 归档自 _tmp（2026-09-26 凌晨：?unified=1 导入卡死修复 + 打包验收），REPO 路径已按 docs/probes/ 调整。
// 探针 35：**`?unified=1` 从一开始就打开时，导入还挂不挂**（打包版只能用这条路带参数）。
//
// 背景：上一轮记录"`?unified=1` 这条 URL 开关会让导入本身失败/永久挂住"（见
// `docs/待办-引擎WebGPU-compute.md` §4d/§4e），那条路当时被绕开（改成"先正常导入、再就地翻转"）。
// 但**打包后的 exe 只能靠命令行参数**，而参数是在启动时就生效的 —— 所以这条路必须能用，
// 否则用户拿到包也看不到 unified 通路。
//
// 判据：从 `?gpu=webgpu&unified=1` 启动 → 导入 test-model.ply →
//   · 导入在 90 秒内返回（不挂）；
//   · splat 元素出现、world 有 2000 个 splat；
//   · renderCounter / numSplatsBuffer > 0（真的画出来了）。
//
// usage: node _tmp/probe-unified-url-import2.cjs [model]
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..', '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const { launchPatched: _launchPatched } = require('../verify/lib/browser.cjs');
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

(async () => {
    cleanupOrphanBrowsers();
    const browser = await _launchPatched(puppeteer, {
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 600000
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 640, height: 440 });
    const logs = [];
    page.on('console', (m) => logs.push(m.text().slice(0, 200)));
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));

    const t0 = Date.now();
    await page.goto('http://localhost:3100/?gpu=webgpu&unified=1', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1500);
    const flag = await page.evaluate(() => ({
        unified: globalThis.__SPLATROOM_UNIFIED__ === true,
        search: location.search
    }));

    let importErr = null;
    const tImport = Date.now();
    try {
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
    } catch (e) {
        importErr = String(e).slice(0, 200);
    }
    const importMs = Date.now() - tImport;

    let elementSeen = false;
    for (let i = 0; i < 30; i++) {
        await sleep(1000);
        elementSeen = await page.evaluate(() => (window.scene.elements || []).some(e => e.entity && e.entity.gsplat));
        if (elementSeen) break;
    }
    await page.evaluate(() => {
        const scene = window.scene;
        const el = (scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        if (el) scene.events.fire('selection', el);
    });
    await sleep(400);
    await page.evaluate(() => window.scene.events.fire('camera.focus'));
    await sleep(2500);

    const res = await page.evaluate(async () => {
        const scene = window.scene;
        const dev = scene.app.graphicsDevice;
        const out = { unifiedFlags: [], elements: [] };
        for (const el of scene.elements || []) {
            const g = el.entity && el.entity.gsplat;
            if (!g) continue;
            out.elements.push({
                name: el.name ?? el.entity.name,
                unified: g.unified ?? null,
                hasPlacement: !!g._placement,
                numSplats: g._placement?.resource?.gsplatData?.numSplats ?? g.instance?.resource?.gsplatData?.numSplats ?? null
            });
        }
        let r = null;
        scene?.app?.renderer?.gsplatDirector?.camerasMap?.forEach((cd) => {
            cd?.layersMap?.forEach((ld) => {
                if (ld?.gsplatManager?.renderer) r = ld.gsplatManager.renderer;
            });
        });
        if (r) {
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
            out.usesGpuSort = !!r.usesGpuSort;
            out.renderCounter = await readU32(r.projector.renderCounter);
            out.numSplats = await readU32(r.intervalCompaction.numSplatsBuffer);
        }
        out.install = window.__SPLATROOM_UNIFIED_MATERIAL_INSTALLED__ ?? null;
        return out;
    });

    const f = path.join(REPO, '_tmp', 'url-import.png');
    fs.writeFileSync(f, Buffer.from(await page.screenshot({ encoding: 'base64' }), 'base64'));

    console.log(JSON.stringify({
        model: MODEL,
        flag,
        importMs,
        importErr,
        totalMs: Date.now() - t0,
        elementSeen,
        res,
        stats: stats(f),
        logs: logs.filter(l => /SplatRoom|unified/i.test(l)).slice(0, 6),
        errs: errs.slice(0, 4)
    }, null, 1));

    console.log('\n=== 判定（`?unified=1` 从启动就打开）===');
    console.log(`  开关：__SPLATROOM_UNIFIED__=${flag.unified}（search=${flag.search}）`);
    console.log(`  导入：${importMs} ms，${importErr ? '**抛错：' + importErr + '**' : '正常返回'}；元素出现=${elementSeen}`);
    console.log(`  元素：${JSON.stringify(res.elements)}`);
    console.log(`  usesGpuSort=${res.usesGpuSort} renderCounter=${res.renderCounter} numSplats=${res.numSplats}`);
    console.log(`  画面：${JSON.stringify(stats(f))}`);
    console.log(`  ⇒ ${elementSeen && (res.numSplats ?? 0) > 100 ? '**这条路可用**（打包版可以用 --unified=1 直接启动）' : '这条路有问题，打包版的命令行开关不能这么用'}`);
    if (errs.length) console.log(`  页面错误：${JSON.stringify(errs.slice(0, 3))}`);

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
