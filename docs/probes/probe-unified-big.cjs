// 归档自 _tmp（2026-09-26 二期第一步：调色接到 unified 通路），REPO 路径已按 docs/probes/ 调整。
// 探针 43：unified 通路在**较大模型**上的现场（本轮补的验收缺口）。
//
// 背景：二期的调色对齐只在小模型（test-model.ply 2000 点）上做过逐像素验证；
// 大模型（test-layered.ply 约 55 万点）只确认过"能出图"。这一版补三件事：
//   ① 导入 + 绘制是否正常（renderCounter / numSplats / 设备错误）；
//   ② 逐帧成本（有需求地渲染 30 帧的均值，与 per-instance 的同一测法对比）；
//   ③ 中性画面在两条通路上的统计（均值/亮度占比）—— 大模型上只看量级，不做逐像素结论。
//
// usage: node _tmp/probe-unified-big.cjs [model]
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..', '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const { launchPatched: _launchPatched } = require('../verify/lib/browser.cjs');
const { decodePng } = require(path.join(REPO, 'docs', 'verify', 'lib', 'png.cjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL = process.argv[2] || 'test-layered.ply';

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
        protocolTimeout: 900000
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 600 });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));

    await page.evaluateOnNewDocument(() => {
        window.__SR_ERR__ = [];
        window.__SR_ON__ = false;
        const hook = () => {
            const A = globalThis.GPUAdapter;
            if (!A || !A.prototype || A.prototype.__srBig) return false;
            A.prototype.__srBig = true;
            const orig = A.prototype.requestDevice;
            A.prototype.requestDevice = async function (desc) {
                const dev = await orig.call(this, desc);
                try {
                    dev.addEventListener('uncapturederror', (e) => {
                        if (window.__SR_ON__) window.__SR_ERR__.push(String(e.error && e.error.message ? e.error.message : e.error).slice(0, 220));
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
    await sleep(1500);

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
    const importMs = Date.now() - t0;
    for (let i = 0; i < 90; i++) {
        await sleep(1000);
        if (await page.evaluate(() => (window.scene.elements || []).some((e) => e.entity && e.entity.gsplat))) break;
    }
    await page.evaluate(() => {
        const scene = window.scene;
        const el = (scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        if (el) scene.events.fire('selection', el);
    });
    await sleep(500);
    await page.evaluate(() => window.scene.events.fire('camera.focus'));
    await sleep(6000);

    const frameCost = () => page.evaluate(async () => {
        const scene = window.scene;
        // 预热
        for (let i = 0; i < 5; i++) {
            scene.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
        }
        const t = [];
        for (let i = 0; i < 30; i++) {
            const a = performance.now();
            scene.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
            t.push(performance.now() - a);
        }
        t.sort((x, y) => x - y);
        return { median: +t[15].toFixed(2), mean: +(t.reduce((s, v) => s + v, 0) / t.length).toFixed(2), max: +t[t.length - 1].toFixed(2) };
    });

    const cpuShot = path.join(REPO, '_tmp', 'big-cpu.png');
    fs.writeFileSync(cpuShot, Buffer.from(await page.screenshot({ encoding: 'base64' }), 'base64'));
    const cpuFrames = await frameCost();

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
    await sleep(4000);
    await page.evaluate(() => { window.__SR_ERR__ = []; window.__SR_ON__ = true; });
    const uniFrames = await frameCost();
    await sleep(500);

    const info = await page.evaluate(async () => {
        const scene = window.scene;
        const dev = scene.app.graphicsDevice;
        const out = {};
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
            out.renderCounter = await readU32(r.projector.renderCounter);
            out.numSplats = await readU32(r.intervalCompaction.numSplatsBuffer);
        }
        const el = scene.elements.find(e => e.entity && e.entity.gsplat);
        out.elementSplats = el ? el.numSplats : null;
        out.install = globalThis.__SPLATROOM_UNIFIED_MATERIAL_INSTALLED__ ?? null;
        out.errors = window.__SR_ERR__.slice(0, 4);
        out.errorCount = window.__SR_ERR__.length;
        return out;
    });

    const uniShot = path.join(REPO, '_tmp', 'big-uni.png');
    fs.writeFileSync(uniShot, Buffer.from(await page.screenshot({ encoding: 'base64' }), 'base64'));

    console.log(JSON.stringify({
        model: MODEL,
        importMs,
        cpuFrames, uniFrames,
        info,
        cpu: stats(cpuShot), uni: stats(uniShot),
        pageErrs: errs.slice(0, 3)
    }, null, 1));
    console.log('\n=== 大模型上的 unified 通路 ===');
    console.log(`  导入 ${importMs} ms；元素 splat 数 ${info.elementSplats}`);
    console.log(`  per-instance 帧耗时：median ${cpuFrames.median} / mean ${cpuFrames.mean} ms`);
    console.log(`  unified     帧耗时：median ${uniFrames.median} / mean ${uniFrames.mean} ms`);
    console.log(`  renderCounter=${info.renderCounter} numSplats=${info.numSplats}`);
    console.log(`  画面：cpu=${JSON.stringify(stats(cpuShot))} unified=${JSON.stringify(stats(uniShot))}`);
    console.log(`  设备错误（unified 30 帧内）：${info.errorCount} 条 ${JSON.stringify(info.errors.map(e => e.split('\n')[0]))}`);
    if (errs.length) console.log(`  页面错误：${JSON.stringify(errs.slice(0, 2))}`);

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
