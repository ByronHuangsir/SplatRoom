// 归档自 _tmp（2026-09-25 unified 通路根因定位那一轮），REPO 路径已按 docs/probes/ 调整。
// 探针 32：unified 通路的 **work buffer 贴图到底有没有被上传**（投影器判"全部无效"的最后嫌疑）。
//
// 链条已逐级钉住（全部有效读数）：
//   cull [0,2000] ✓ → 前缀和 ✓ → scatter ✓ → `ic.writeIndirectArgs` **写了 2000** ✓
//   （连带把间接 dispatch 参数写成 8 个 workgroup —— 这与实测 `GSplatProjector` 恰好 8 个 workgroup 吻合）
//   → `GSplatProjector` 读 `sortElementCount[0]`（该值此刻应为 2000）逐 splat 投影
//   → 每个 splat 的有效性由 `projectSplatCommon(...)` 决定（几何/尺度/不透明度阈值）
//   → `renderCounter` 实测 **0** ⇒ 2048 个线程里没有一个判定为有效
//   → `ProjectorWriteIndirectArgs` 把 `numSplatsBuf[0] = renderCounter[0] = 0`
//     ⇒ 绘制 instanceCount = 0 ⇒ **零图元**（这才解释了"着色器/材质/目标全对却一个像素都没有"）。
//
// 那么"为什么每个 splat 都无效"：投影器的输入是 work buffer 的三张贴图
// （dataColor / dataTransformA / dataTransformB，48×48）与 projCache。
// worldState 里 `needsUpload` 非空、`fullRebuild: true` —— 若这些数据从未被上传，贴图里全是 0，
// 投影自然全部无效。本探针：
//   1. 读 `world.bufferCopyUploaded / bufferCopyTotal`（引擎自己的上传计数）；
//   2. 拦 `queue.copyBufferToTexture` / `writeTexture`，统计上传次数与目标贴图尺寸；
//   3. 读 worldState 的上传相关标记。
//
// usage: node _tmp/probe-unified-upload.cjs [model]
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..', '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const { launchPatched: _launchPatched } = require('../verify/lib/browser.cjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL = process.argv[2] || 'test-model.ply';

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
        window.__SR_UP__ = { copyBufferToTexture: [], writeTexture: [], copyTextureToTexture: [] };
        const hook = () => {
            const Q = globalThis.GPUQueue;
            if (!Q || !Q.prototype || Q.prototype.__srUp) return false;
            Q.prototype.__srUp = true;
            const rec = (arr, desc, size) => {
                try {
                    const t = desc && desc.destination ? desc.destination.texture : (desc && desc.texture);
                    arr.push({ w: t ? t.width : null, h: t ? t.height : null, fmt: t ? t.format : null, bytes: size ?? null });
                } catch (e) { /* ignore */ }
            };
            const c1 = Q.prototype.copyBufferToTexture;
            Q.prototype.copyBufferToTexture = function (src, dst, size) {
                rec(window.__SR_UP__.copyBufferToTexture, { destination: dst }, size ? `${size.width}x${size.height}` : null);
                return c1.call(this, src, dst, size);
            };
            const c2 = Q.prototype.writeTexture;
            Q.prototype.writeTexture = function (dst, data, layout, size) {
                rec(window.__SR_UP__.writeTexture, { destination: dst }, size ? `${size.width}x${size.height}` : null);
                return c2.call(this, dst, data, layout, size);
            };
            const c3 = Q.prototype.copyTextureToTexture;
            Q.prototype.copyTextureToTexture = function (src, dst, size) {
                rec(window.__SR_UP__.copyTextureToTexture, { destination: dst }, size ? `${size.width}x${size.height}` : null);
                return c3.call(this, src, dst, size);
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
    await sleep(2500);
    await page.evaluate(() => {
        const scene = window.scene;
        const el = (scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        if (el) scene.events.fire('selection', el);
    });
    await sleep(400);
    await page.evaluate(() => window.scene.events.fire('camera.focus'));
    await sleep(2500);

    const cpuUploads = await page.evaluate(() => JSON.parse(JSON.stringify(window.__SR_UP__)));

    await page.evaluate(async () => {
        const scene = window.scene;
        window.__SR_UP__ = { copyBufferToTexture: [], writeTexture: [], copyTextureToTexture: [] };
        window.__SPLATROOM_UNIFIED__ = true;
        const el = (scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        el.entity.gsplat.unified = true;
        for (let i = 0; i < 60; i++) {
            scene.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
        }
    });
    await sleep(1500);

    const uniUploads = await page.evaluate(() => JSON.parse(JSON.stringify(window.__SR_UP__)));

    const state = await page.evaluate(() => {
        const scene = window.scene;
        const out = {};
        scene?.app?.renderer?.gsplatDirector?.camerasMap?.forEach((cd) => {
            cd?.layersMap?.forEach((ld) => {
                const m = ld?.gsplatManager;
                if (!m) return;
                const st = m.world && m.world.currentState;
                out.manager = {
                    bufferCopyUploaded: m.bufferCopyUploaded,
                    bufferCopyTotal: m.bufferCopyTotal,
                    worldCopyUploaded: m.world ? m.world.bufferCopyUploaded : null,
                    worldCopyTotal: m.world ? m.world.bufferCopyTotal : null,
                    stateVersion: st ? st.version : null,
                    needsUpload: st && st.needsUpload ? (st.needsUpload.length ?? String(st.needsUpload)) : null,
                    needsUploadIds: st && st.needsUploadIds ? (st.needsUploadIds.size ?? st.needsUploadIds.length ?? String(st.needsUploadIds)) : null,
                    fullRebuild: st ? st.fullRebuild : null,
                    sortedBefore: st ? st.sortedBefore : null,
                    textureSize: st ? st.textureSize : null
                };
                const wb = m.world && m.world.workBuffer;
                out.textures = [];
                if (wb && wb.textures) {
                    for (const [k, t] of wb.textures) {
                        out.textures.push(`${k}:${t ? `${t.width}x${t.height}` : 'none'}`);
                    }
                }
            });
        });
        // 说明：CPU 通路（per-instance）不走 work buffer，所以这里的计数只对 unified 有意义
        return out;
    });

    const sum = (arr) => arr.map(x => `${x.w}x${x.h}(${x.bytes ?? '?'})`).join(', ') || '(无)';
    console.log(JSON.stringify({ model: MODEL, cpuUploads, uniUploads, state, errs: errs.slice(0, 3) }, null, 1));
    console.log('\n=== 上传现场 ===');
    console.log(`  CPU 通路期间：copyBufferToTexture ${cpuUploads.copyBufferToTexture.length} 次 [${sum(cpuUploads.copyBufferToTexture)}]；writeTexture ${cpuUploads.writeTexture.length} 次 [${sum(cpuUploads.writeTexture)}]`);
    console.log(`  unified 期间：copyBufferToTexture ${uniUploads.copyBufferToTexture.length} 次 [${sum(uniUploads.copyBufferToTexture)}]；writeTexture ${uniUploads.writeTexture.length} 次 [${sum(uniUploads.writeTexture)}]`);
    console.log(`  manager：${JSON.stringify(state.manager)}`);
    console.log(`  work buffer 贴图：${JSON.stringify(state.textures)}`);
    const up = uniUploads.copyBufferToTexture.length + uniUploads.writeTexture.length;
    console.log(`  ⇒ ${up === 0
        ? '**unified 期间 work buffer 贴图完全没有上传** ⇒ 投影器读到全 0 数据 ⇒ 全部判无效 ⇒ renderCounter = 0 ⇒ 零图元'
        : '有上传发生，需要看目标尺寸是否覆盖 48×48 的三张数据贴图'}`);

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
