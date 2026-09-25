// 归档自 _tmp（2026-09-25 unified 通路根因定位那一轮），REPO 路径已按 docs/probes/ 调整。
// 探针 29：把 `GSplatIntervalWriteIndirectArgs` 的输出接进**我自己的 buffer**，看它到底写不写。
//
// 前情（全部有效读数）：
//   · cull 与前缀和都跑通了：裸 compute 读到 `countBuffer = [0, 2000]`（2000 个可见 splat 就在 [1]）；
//   · scatter 也跑了（`compactedSplatIds` 被写成 0..1999，与初值相同，之前误判为"没写"）；
//   · writeArgs 的 uniform 全对：CPU 侧 `[drawSlot=0, indexCount=768, dispatchSlotBase=0, totalSplats=1, …]`，
//     每个字段的 scopeId 与 `device.scope.resolve(同名)` 都是**同一对象**；
//   · 但 `numSplatsBuffer`（可读）恒为 0 ⇒ 它按 `prefixSumBuffer[totalSplats]` 应当写出 2000。
// 本探针把 `numSplatsBuf` 这个参数**替换成我自己创建、可读回的 buffer**（每次 setParameter 时偷换）：
//   · 我的 buffer 收到 2000 ⇒ compute 确实在写 ⇒ 引擎那块 buffer 的读法/对象有别的问题；
//   · 我的 buffer 仍是 0 ⇒ compute 的写入本身没发生。
// 同时打印"bind group 槽里的 GPUBuffer"与"`ic.numSplatsBuffer.impl.buffer`"是否**同一 GPUBuffer 对象**
// （排查"bind group 绑在旧缓冲上"这一路）。
//
// usage: node _tmp/probe-unified-hijack.cjs [model]
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

    const setup = await page.evaluate(() => {
        const scene = window.scene;
        const dev = scene.app.graphicsDevice;
        let ic = null;
        scene?.app?.renderer?.gsplatDirector?.camerasMap?.forEach((cd) => {
            cd?.layersMap?.forEach((ld) => {
                const r = ld?.gsplatManager?.renderer;
                if (r) ic = r.intervalCompaction;
            });
        });
        if (!ic) return { error: 'no ic' };
        // 假 buffer（真正的 GPUBuffer，但我自己持有）
        const fake = dev.wgpu.createBuffer({
            size: 16,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        });
        dev.wgpu.queue.writeBuffer(fake, 0, new Uint32Array([0, 0, 0, 0]));
        scene.app.graphicsDevice.wgpu.queue.writeBuffer(fake, 0, new Uint32Array([0, 0, 0, 0]));
        // 包一层 StorageBuffer 外观，冒充引擎的 numSplatsBuffer（只需要 impl.buffer）
        const proxy = { impl: { buffer: fake }, byteSize: 4, id: -1 };
        const compute = ic._writeIndirectArgsCompute;
        const bg = compute.impl.bindGroups[0];
        // 记录"引擎对象 vs bind group 里的对象"的 GPUBuffer 身份
        const engineSb = ic.numSplatsBuffer;
        const slotSb = bg.storageBuffers[2];
        window.__SR_HIJACK__ = {
            fake,
            sameSbObject: engineSb === slotSb,
            sameGpuBuffer: !!(engineSb && slotSb && engineSb.impl.buffer === slotSb.impl.buffer),
            engineGpuBufferSize: engineSb && engineSb.impl.buffer ? engineSb.impl.buffer.size : null,
            slotGpuBufferSize: slotSb && slotSb.impl.buffer ? slotSb.impl.buffer.size : null,
            calls: 0
        };
        // 偷换参数：引擎每帧都会 setParameter('numSplatsBuf', ic.numSplatsBuffer)
        const orig = compute.setParameter.bind(compute);
        compute.setParameter = function (name, value) {
            if (name === 'numSplatsBuf') {
                window.__SR_HIJACK__.calls++;
                return orig(name, proxy);
            }
            return orig(name, value);
        };
        return { ok: true };
    });

    // 渲染两帧，让 writeArgs 往假 buffer 里写
    await page.evaluate(async () => {
        for (let i = 0; i < 2; i++) {
            window.scene.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
        }
    });
    await sleep(400);

    const res = await page.evaluate(async () => {
        const dev = window.scene.app.graphicsDevice.wgpu;
        const fake = window.__SR_HIJACK__.fake;
        const staging = dev.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const enc = dev.createCommandEncoder();
        enc.copyBufferToBuffer(fake, 0, staging, 0, 16);
        dev.queue.submit([enc.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const v = Array.from(new Uint32Array(staging.getMappedRange().slice(0, 16)));
        staging.unmap();
        staging.destroy();
        return {
            fakeContent: v,
            calls: window.__SR_HIJACK__.calls,
            sameSbObject: window.__SR_HIJACK__.sameSbObject,
            sameGpuBuffer: window.__SR_HIJACK__.sameGpuBuffer,
            engineGpuBufferSize: window.__SR_HIJACK__.engineGpuBufferSize,
            slotGpuBufferSize: window.__SR_HIJACK__.slotGpuBufferSize
        };
    });

    console.log(JSON.stringify({ model: MODEL, setup, res, errs: errs.slice(0, 3) }, null, 1));
    console.log('\n=== 判定 ===');
    if (res) {
        console.log(`  setParameter('numSplatsBuf') 被调用 ${res.calls} 次（说明偷换生效）`);
        console.log(`  假 buffer 的内容：${JSON.stringify(res.fakeContent)}（期望 [2000,0,0,0]）`);
        console.log(`  bind group 槽2 与 ic.numSplatsBuffer：同一 StorageBuffer 对象=${res.sameSbObject}，同一 GPUBuffer=${res.sameGpuBuffer}`);
        console.log(`  ⇒ ${res.fakeContent[0] === 2000
            ? 'compute **确实在写** ⇒ 之前的 0 是"读的对象/时机"问题'
            : res.fakeContent[0] === 0 && res.calls > 0
                ? '**compute 没有写出任何东西**（即使在偷换后的 buffer 上也是 0）'
                : `其它：${JSON.stringify(res.fakeContent)}`}`);
    }

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
