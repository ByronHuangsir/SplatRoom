// 归档自 _tmp（2026-09-25 unified 通路根因定位那一轮），REPO 路径已按 docs/probes/ 调整。
// 探针 26：**用裸 compute 去读引擎自己的区间表** —— 判定"引擎写进去的数据在 GPU 侧到底有没有"。
//
// 前情（全部为有效读数）：
//   · JS 层截 `intervalsBuffer.write()` 的入参 = `[0, 2000, 0, 0]`（splatCount = 2000）；
//   · cull 的 bind group 里 slot0 **就是** `ic.intervalsBuffer`（id 9，gpuSize 16）——身份比对过；
//   · cull 的管线存在（不 invalid）、bind group 已更新（dirty=false）、dispatch 1 个 workgroup、
//     且这些 compute 与渲染在同一个被提交的 command buffer 里；
//   · 但链尾（numSplatsBuffer / sortElementCountBuffer，带 COPY_SRC）恒为 0，金丝雀也不被吞。
// ⇒ 只剩两种可能：
//   (甲) 引擎那次 `queue.writeBuffer` 没落到 GPU 上 ⇒ cull 读到的 splatCount = 0 ⇒ 全链为 0；
//   (乙) 数据在，但 cull 的写入没发生。
//
// 本探针用一个裸 compute 直接读 `ic.intervalsBuffer`（STORAGE 绑定合法），把前几个 u32 写进
// 我自己创建、可读回的 buffer：
//   out[0] = intervals[1]  // splatCount
//   out[1] = intervals[0]  // workBufferBase
//   out[2] = intervals[2]  // boundsIndex
//   · out[0] == 2000 ⇒ 数据在 ⇒ (乙)；· out[0] == 0 ⇒ **(甲)：引擎那次写没落盘**。
//
// usage: node _tmp/probe-unified-readinterval.cjs [model]
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
    await page.evaluate(async () => {
        for (let i = 0; i < 2; i++) {
            window.scene.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
        }
    });
    await sleep(300);

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
        const intervalsGpu = ic.intervalsBuffer.impl.buffer;
        const out = { intervalsSize: intervalsGpu.size, intervalsUsage: intervalsGpu.usage };

        const test = dev.createBuffer({
            size: 32,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        });
        const staging = dev.createBuffer({ size: 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const readTest = async () => {
            const enc = dev.createCommandEncoder();
            enc.copyBufferToBuffer(test, 0, staging, 0, 32);
            dev.queue.submit([enc.finish()]);
            await staging.mapAsync(GPUMapMode.READ);
            const v = Array.from(new Uint32Array(staging.getMappedRange().slice(0, 32)));
            staging.unmap();
            return v;
        };

        // 裸 compute：把引擎区间表的前几个 u32 抄到 test
        const mod = dev.createShaderModule({
            code: `
@group(0) @binding(0) var<storage, read> intervals: array<u32>;
@group(0) @binding(1) var<storage, read_write> out: array<u32>;
@compute @workgroup_size(1)
fn main() {
    out[0] = intervals[1];   // splatCount
    out[1] = intervals[0];   // workBufferBase
    out[2] = intervals[2];   // boundsIndex
    out[3] = 9999u;          // 探针有效性的自证
}
`
        });
        const pipe = dev.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'main' } });
        const bg = dev.createBindGroup({
            layout: pipe.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: intervalsGpu } }, { binding: 1, resource: { buffer: test } }]
        });
        const enc = dev.createCommandEncoder();
        const pass = enc.beginComputePass();
        pass.setPipeline(pipe);
        pass.setBindGroup(0, bg);
        pass.dispatchWorkgroups(1);
        pass.end();
        dev.queue.submit([enc.finish()]);
        await dev.queue.onSubmittedWorkDone();
        out.rawReadEngineIntervals = await readTest();

        // 对照：把金丝雀种进引擎区间表，再用同一个裸 compute 读一次
        dev.queue.writeBuffer(intervalsGpu, 4, new Uint32Array([7]));
        const enc2 = dev.createCommandEncoder();
        const pass2 = enc2.beginComputePass();
        pass2.setPipeline(pipe);
        pass2.setBindGroup(0, bg);
        pass2.dispatchWorkgroups(1);
        pass2.end();
        dev.queue.submit([enc2.finish()]);
        await dev.queue.onSubmittedWorkDone();
        out.rawReadAfterCanary7 = await readTest();

        test.destroy();
        staging.destroy();
        return out;
    });

    console.log(JSON.stringify({ model: MODEL, res, errs: errs.slice(0, 3) }, null, 1));
    console.log('\n=== 判定（裸 compute 读引擎自己的区间表）===');
    if (res.error) console.log('  ' + res.error);
    else {
        const r = res.rawReadEngineIntervals ?? [];
        console.log(`  区间表 buffer：size=${res.intervalsSize} usage=${res.intervalsUsage}`);
        console.log(`  裸 compute 读到：splatCount=${r[0]} workBufferBase=${r[1]} boundsIndex=${r[2]} 自证位=${r[3]}（应为 9999）`);
        console.log(`  种金丝雀 7 之后再读：${JSON.stringify(res.rawReadAfterCanary7)}`);
        console.log(`  ⇒ ${r[0] === 2000 || r[0] === 7
            ? '**数据确实在 GPU 上** ⇒ 问题在引擎 cull 的写入（(乙)）'
            : '**(甲)：引擎那次 queue.writeBuffer 没有落到 GPU 上** ⇒ cull 读到的 splatCount = 0 ⇒ 全链归零'}`);
    }

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
