// 归档自 _tmp（2026-09-25 unified 通路根因定位那一轮），REPO 路径已按 docs/probes/ 调整。
// 探针 23：两件事一次问清（金丝雀那一步的收口）。
//
// 疑点一：`queue.writeBuffer(buf, off, view, dataOffset, size)` 里的 `size` 到底是
//   **字节**还是**元素个数**？引擎的区间表上传是
//     this.intervalsBuffer.write(0, data2, 0, numIntervals * INTERVAL_STRIDE)
//   其中 data2 = Uint32Array(numIntervals * 4)（即 4 个元素、16 字节），size 传的是 **4**。
//   若 WebGPU 把它当**字节**，则只有第一个 u32 会落盘 ⇒ `interval.splatCount` 恒为 0
//   ⇒ cull 写 0 ⇒ 整条链归零（与本轮所有观测吻合）。
//
// 疑点二：金丝雀（splatCount = 123456）没被吞，是"cull 没跑"还是"读的不是这张表"？
//   这次改用**在范围内**的金丝雀（7），并同时看 countBuffer[1]（前缀和总数）与
//   numSplatsBuffer（writeIndirectArgs 写的总数）有没有变成 7。
//
// usage: node _tmp/probe-unified-units.cjs [model]
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

    const units = await page.evaluate(async () => {
        const dev = window.scene.app.graphicsDevice.wgpu;
        const src = dev.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE });
        const dst = dev.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const read = async () => {
            const enc = dev.createCommandEncoder();
            enc.copyBufferToBuffer(src, 0, dst, 0, 16);
            dev.queue.submit([enc.finish()]);
            await dst.mapAsync(GPUMapMode.READ);
            const v = Array.from(new Uint32Array(dst.getMappedRange().slice(0, 16)));
            dst.unmap();
            return v;
        };
        // 1) 传 size = 4，看落几个 u32
        dev.queue.writeBuffer(src, 0, new Uint32Array([11, 22, 33, 44]), 0, 4);
        const a = await read();
        // 2) 不传 size/dataOffset，看是否全落
        dev.queue.writeBuffer(src, 0, new Uint32Array([55, 66, 77, 88]));
        const b = await read();
        // 3) 传 dataOffset = 1（元素 or 字节？），size = 2
        dev.queue.writeBuffer(src, 0, new Uint32Array([101, 102, 103, 104]), 1, 2);
        const c = await read();
        src.destroy();
        dst.destroy();
        return { sizeIs4: a, noSize: b, off1size2: c };
    });

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

    const chain = await page.evaluate(async () => {
        const scene = window.scene;
        const dev = scene.app.graphicsDevice.wgpu;
        let ic = null;
        scene?.app?.renderer?.gsplatDirector?.camerasMap?.forEach((cd) => {
            cd?.layersMap?.forEach((ld) => {
                const r = ld?.gsplatManager?.renderer;
                if (r) ic = r.intervalCompaction;
            });
        });
        const gpu = (o) => {
            for (const c of [o && o.impl && o.impl.buffer, o && o.impl && o.impl.gpuBuffer, o && o.buffer]) {
                if (c instanceof GPUBuffer) return c;
            }
            return null;
        };
        const readU32 = async (g, off, bytes) => {
            const st = dev.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
            const enc = dev.createCommandEncoder();
            enc.copyBufferToBuffer(g, off, st, 0, bytes);
            dev.queue.submit([enc.finish()]);
            await st.mapAsync(GPUMapMode.READ);
            const v = Array.from(new Uint32Array(st.getMappedRange().slice(0, bytes)));
            st.unmap();
            st.destroy();
            return v;
        };
        const intervals = gpu(ic.intervalsBuffer);
        const count = gpu(ic.countBuffer);
        const numSplats = gpu(ic.numSplatsBuffer);
        const out = { countBefore: await readU32(count, 0, 8), numSplatsBefore: await readU32(numSplats, 0, 4) };
        // 用**元素语义**写：偏移 4 字节 = splatCount；金丝雀取范围外的 7（原值 2000）
        dev.queue.writeBuffer(intervals, 4, new Uint32Array([7]));
        scene.app.renderNextFrame = true;
        await new Promise((r) => requestAnimationFrame(r));
        await dev.queue.onSubmittedWorkDone();
        out.countAfterCanary7 = await readU32(count, 0, 8);
        out.numSplatsAfterCanary7 = await readU32(numSplats, 0, 4);
        return out;
    });

    console.log(JSON.stringify({ model: MODEL, units, chain, errs: errs.slice(0, 3) }, null, 1));
    console.log('\n=== 判定 ===');
    console.log('  ① writeBuffer 的 size 语义（写 [11,22,33,44] 并 size=4）：');
    console.log(`     结果 ${JSON.stringify(units.sizeIs4)} ⇒ ${JSON.stringify(units.sizeIs4) === '[11,0,0,0]' ? '**size 按字节算**（引擎传元素个数 ⇒ 只落了 1/4）' : 'size 按元素算（引擎调用没问题）'}`);
    console.log(`     不传 size：${JSON.stringify(units.noSize)}；dataOffset=1,size=2：${JSON.stringify(units.off1size2)}`);
    console.log(`  ② 金丝雀 7：countBuffer ${JSON.stringify(chain.countBefore)} → ${JSON.stringify(chain.countAfterCanary7)}；numSplatsBuffer ${JSON.stringify(chain.numSplatsBefore)} → ${JSON.stringify(chain.numSplatsAfterCanary7)}`);

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
