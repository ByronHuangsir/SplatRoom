// 归档自 _tmp（2026-09-25 unified 通路排查那一轮），REPO 路径已按 docs/probes/ 调整。
// 探针 18：在 **JS 层**截住区间表的上传内容（不依赖 GPU 读回），找"第一个 0"。
//
// 为什么换法子：`copyBufferToBuffer` 要求源 buffer 有 COPY_SRC。引擎里
//   intervalsBuffer  = new StorageBuffer(dev, n*4*4, BUFFERUSAGE_COPY_DST)          ← 没有 COPY_SRC
//   indirectDrawBuffer = ... BUFFERUSAGE_INDIRECT | BUFFERUSAGE_COPY_DST            ← 没有 COPY_SRC
// ⇒ 我从这两个 buffer 抄数据的尝试**全部无效**（拷贝被校验拒绝，staging 保持新建时的 0），
// 之前据此得出的"区间表全 0 / 间接参数全 0"两条读数**作废**。
// 而 countBuffer / numSplatsBuffer / sortElementCountBuffer / compactedSplatIds 是带 COPY_SRC 的，
// 那几项读数是有效的：{countBuffer:[0,0], numSplatsBuffer:[0], sortElementCountBuffer:[0],
// compactedSplatIds:[0,1,2,3,...]}（scatter 从未写入）。
//
// 本探针：包住 `ic.intervalsBuffer.write()`，把**真正上传的数值**记下来；再自己调一次
// `uploadIntervals(currentState)` 强制上传，看传的是什么。
//
// usage: node _tmp/probe-unified-intervalwrite.cjs [model]
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..', '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL = process.argv[2] || 'test-model.ply';

(async () => {
    cleanupOrphanBrowsers();
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 600000
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 640, height: 440 });
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

    const result = await page.evaluate(async () => {
        const scene = window.scene;
        const out = { writes: [], manual: null, state: null, readableCounters: [] };
        let ic = null;
        let mgr = null;
        scene?.app?.renderer?.gsplatDirector?.camerasMap?.forEach((cd) => {
            cd?.layersMap?.forEach((ld) => {
                if (ld?.gsplatManager?.renderer) { mgr = ld.gsplatManager; ic = ld.gsplatManager.renderer.intervalCompaction; }
            });
        });
        if (!ic) return { error: '没有 intervalCompaction' };
        const st = mgr.world.currentState;
        out.state = {
            version: st.version,
            totalActiveSplats: st.totalActiveSplats,
            totalIntervals: st.totalIntervals,
            splats: st.splats.map(s => ({
                activeSplats: s.activeSplats,
                boundsBaseIndex: s.boundsBaseIndex,
                intervalsLen: s.intervals ? s.intervals.length : null,
                intervalOffsets: s.intervalOffsets ? Array.from(s.intervalOffsets).slice(0, 4) : null
            }))
        };
        out.uploadedVersion = ic._uploadedVersion;
        out.allocatedIntervalCount = ic.allocatedIntervalCount;
        out.intervalsBufferByteSize = ic.intervalsBuffer ? ic.intervalsBuffer.byteSize : null;

        // 包住 write：把真正上传的数值记下来
        if (ic.intervalsBuffer && typeof ic.intervalsBuffer.write === 'function' && !ic.intervalsBuffer.__srW) {
            const buf = ic.intervalsBuffer;
            const ow = buf.write.bind(buf);
            buf.write = function (bufferOffset, data, dataOffset, size) {
                try {
                    window.__SR_TRACE__ = window.__SR_TRACE__ || [];
                    window.__SR_TRACE__.push({
                        bufferOffset, dataOffset, size,
                        dataLen: data && data.length,
                        first: data ? Array.from(data).slice(0, 8) : null
                    });
                } catch (e) { /* ignore */ }
                return ow(bufferOffset, data, dataOffset, size);
            };
            buf.__srW = true;
            out.wrapped = true;
        } else out.wrapped = false;

        // 自己强制上传一次，看传的是什么
        try {
            ic.invalidateUpload();
            ic.uploadIntervals(st);
            out.manual = 'ok';
        } catch (e) {
            out.manual = 'threw: ' + String(e).slice(0, 140);
        }
        out.uploadedVersionAfter = ic._uploadedVersion;
        out.trace = (window.__SR_TRACE__ ?? []).slice(-4);

        // 有效可读的计数器（这几个带 COPY_SRC）
        const dev = scene.app.graphicsDevice.wgpu;
        const findGpu = (o) => {
            if (!o) return null;
            if (o instanceof GPUBuffer) return o;
            for (const c of [o.impl && o.impl.buffer, o.impl && o.impl.gpuBuffer, o.buffer]) {
                if (c instanceof GPUBuffer) return c;
            }
            return null;
        };
        for (const key of ['countBuffer', 'numSplatsBuffer', 'sortElementCountBuffer']) {
            const g = findGpu(ic[key]);
            if (!g) { out.readableCounters.push({ key, missing: true }); continue; }
            const bytes = Math.min(32, g.size);
            const staging = dev.createBuffer({ size: Math.max(bytes, 4), usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
            const enc = dev.createCommandEncoder();
            enc.copyBufferToBuffer(g, 0, staging, 0, bytes);
            dev.queue.submit([enc.finish()]);
            await staging.mapAsync(GPUMapMode.READ);
            out.readableCounters.push({ key, size: g.size, u32: Array.from(new Uint32Array(staging.getMappedRange().slice(0, bytes))) });
            staging.unmap();
            staging.destroy();
        }
        return out;
    });

    console.log(JSON.stringify({ model: MODEL, result, errs: errs.slice(0, 3) }, null, 1));
    console.log('\n=== 判定 ===');
    if (result.error) console.log('  ' + result.error);
    else {
        console.log(`  world 状态：${JSON.stringify(result.state)}`);
        console.log(`  _uploadedVersion=${result.uploadedVersion}（手动上传前）→ ${result.uploadedVersionAfter}；allocatedIntervalCount=${result.allocatedIntervalCount}；intervalsBuffer=${result.intervalsBufferByteSize}B`);
        console.log(`  我手动 uploadIntervals 的结果：${result.manual}；write 是否被包住=${result.wrapped}`);
        console.log(`  实际上传的数值：${JSON.stringify(result.trace)}`);
        console.log(`  有效可读的计数器：${JSON.stringify(result.readableCounters)}`);
    }

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
