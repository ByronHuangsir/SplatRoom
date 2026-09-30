// 归档自 _tmp（2026-09-25 unified 通路根因定位那一轮），REPO 路径已按 docs/probes/ 调整。
// 探针 27：用裸 compute 读引擎的 **countBuffer**（它没有 COPY_SRC，只能这样读）。
//
// 为什么是它：`GSplatIntervalCull` 写 `countBuffer[0] = splatCount`；`PrefixSumScan` 再把
// countBuffer 扫描成"排除式前缀和"（out[0]=0、out[1]=总数）；`WriteIndirectArgs` 读
// `prefixSumBuffer[numIntervals]`（即 countBuffer[1]）算出总数。我们已知：
//   · 区间表在 GPU 上是对的（裸 compute 读到 splatCount = 2000）；
//   · cull 的 bind group 绑的就是那两个 buffer、管线存在、dispatch 1 个 workgroup、命令缓冲已提交；
//   · 但 `numSplatsBuffer` / `sortElementCountBuffer`（可读）恒为 0。
// 那么 countBuffer 的内容会直接指出断点：
//   [2000, 0] ⇒ cull 跑了、**前缀和没跑**（断点在 PrefixSumScan）
//   [0, 2000] ⇒ cull 与前缀和都跑了 ⇒ 断点在 WriteIndirectArgs
//   [0, 0]    ⇒ cull 的写入没落地
//
// usage: node _tmp/probe-unified-readcount.cjs [model]
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

    const res = await page.evaluate(async () => {
        const scene = window.scene;
        const dev = scene.app.graphicsDevice.wgpu;
        let ic = null;
        scene?.app?.renderer?.gsplatDirector?.camerasMap?.forEach((cd) => {
            cd?.layersMap?.forEach((ld) => {
                const r = ld?.gsplatManager?.renderer;
                if (r) ic = r.intervalCompaction;
            });
        });
        if (!ic) return { error: 'no ic' };
        const interGpu = ic.intervalsBuffer.impl.buffer;
        const countGpu = ic.countBuffer.impl.buffer;
        const out = { intervalsSize: interGpu.size, countSize: countGpu.size };

        // 目标：一次读回 countBuffer（8B）+ intervalsBuffer（16B）+ numSplatsBuffer（4B）
        const readBuf = dev.createBuffer({ size: 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
        const staging = dev.createBuffer({ size: 64, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const mod = dev.createShaderModule({
            code: `
@group(0) @binding(0) var<storage, read> countBuf: array<u32>;
@group(0) @binding(1) var<storage, read> intervals: array<u32>;
@group(0) @binding(2) var<storage, read> splats: array<u32>;
@group(0) @binding(3) var<storage, read_write> out: array<u32>;
@compute @workgroup_size(1)
fn main() {
    out[0] = countBuf[0];
    out[1] = countBuf[1];
    out[2] = intervals[0];
    out[3] = intervals[1];
    out[4] = splats[0];
    out[5] = 9999u;
}
`
        });
        const pipe = dev.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'main' } });
        const snap = async () => {
            const bg = dev.createBindGroup({
                layout: pipe.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: countGpu } },
                    { binding: 1, resource: { buffer: interGpu } },
                    { binding: 2, resource: { buffer: ic.numSplatsBuffer.impl.buffer } },
                    { binding: 3, resource: { buffer: readBuf } }
                ]
            });
            const enc = dev.createCommandEncoder();
            const pass = enc.beginComputePass();
            pass.setPipeline(pipe);
            pass.setBindGroup(0, bg);
            pass.dispatchWorkgroups(1);
            pass.end();
            dev.queue.submit([enc.finish()]);
            await dev.queue.onSubmittedWorkDone();
            const enc2 = dev.createCommandEncoder();
            enc2.copyBufferToBuffer(readBuf, 0, staging, 0, 32);
            dev.queue.submit([enc2.finish()]);
            await staging.mapAsync(GPUMapMode.READ);
            const v = Array.from(new Uint32Array(staging.getMappedRange().slice(0, 32)));
            staging.unmap();
            return { countBuffer: [v[0], v[1]], intervals: [v[2], v[3]], numSplats: v[4], sentinel: v[5] };
        };

        // 渲染 1 帧后再快照
        scene.app.renderNextFrame = true;
        await new Promise((r) => requestAnimationFrame(r));
        await dev.queue.onSubmittedWorkDone();
        out.afterFrame = await snap();

        // 种金丝雀 7 到区间表，再渲染 1 帧
        dev.queue.writeBuffer(interGpu, 4, new Uint32Array([7]));
        scene.app.renderNextFrame = true;
        await new Promise((r) => requestAnimationFrame(r));
        await dev.queue.onSubmittedWorkDone();
        out.afterCanary7 = await snap();

        readBuf.destroy();
        staging.destroy();
        return out;
    });

    console.log(JSON.stringify({ model: MODEL, res, errs: errs.slice(0, 3) }, null, 1));
    console.log('\n=== 判定 ===');
    if (res.error) console.log('  ' + res.error);
    else {
        const a = res.afterFrame;
        console.log(`  正常帧：countBuffer=${JSON.stringify(a.countBuffer)} intervals=[base=${a.intervals[0]}, splatCount=${a.intervals[1]}] numSplats=${a.numSplats} 自证=${a.sentinel}`);
        console.log(`  金丝雀帧：countBuffer=${JSON.stringify(res.afterCanary7.countBuffer)} intervals=[base=${res.afterCanary7.intervals[0]}, splatCount=${res.afterCanary7.intervals[1]}] numSplats=${res.afterCanary7.numSplats}`);
        const [c0, c1] = a.countBuffer;
        console.log(`  ⇒ ${c0 > 0 && c1 === 0
            ? '**cull 跑了、前缀和没跑**（断点在 PrefixSumScan）'
            : c1 > 0
                ? '**cull 与前缀和都跑了** ⇒ 断点在 WriteIndirectArgs'
                : '**cull 的写入没落地**（countBuffer[0] 仍是 0）'}`);
    }

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
