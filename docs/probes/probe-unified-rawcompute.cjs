// 归档自 _tmp（2026-09-25 unified 通路排查那一轮），REPO 路径已按 docs/probes/ 调整。
// 探针 24：最后的 A/B —— **我自己写的裸 compute 能不能写进同一个 buffer**。
//
// 已知（本轮全部为有效读数）：
//   · 引擎侧 JS 层的输入都对（区间表 {splatCount:2000}、平面、边界球、变换、dispatch 次数）；
//   · GPU 侧输出全 0（countBuffer / numSplatsBuffer / sortElementCountBuffer，都是带 COPY_SRC 的有效读数）；
//   · compute pass 确实被派发（"GSplatIntervalCull"，1 个 workgroup）也确实随命令缓冲提交；
//   · 0 条校验错误；把金丝雀种进区间表也不被吞。
// 本探针用一个**完全不经过引擎**的裸 compute（`buf[0] = 42u`）写同一个 countBuffer：
//   · 读到 42 ⇒ 设备/缓冲本身没问题 ⇒ "引擎那批 compute 不落地"是引擎侧（绑定/参数/时序）的问题；
//   · 读不到 42 ⇒ 连裸 compute 都写不进这块 buffer ⇒ 问题在设备/缓冲这一层（与本文档标题的
//     "引擎侧 WebGPU compute 不落地"是同一现象）。
//
// usage: node _tmp/probe-unified-rawcompute.cjs [model]
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

    await page.evaluateOnNewDocument(() => {
        window.__SR_E2__ = [];
        const hook = () => {
            const A = globalThis.GPUAdapter;
            if (!A || !A.prototype || A.prototype.__srR) return false;
            A.prototype.__srR = true;
            const orig = A.prototype.requestDevice;
            A.prototype.requestDevice = async function (desc) {
                const dev = await orig.call(this, desc);
                try {
                    dev.addEventListener('uncapturederror', (e) => {
                        window.__SR_E2__.push(String(e.error && e.error.message ? e.error.message : e.error).slice(0, 250));
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
        const out = {};
        let ic = null;
        scene?.app?.renderer?.gsplatDirector?.camerasMap?.forEach((cd) => {
            cd?.layersMap?.forEach((ld) => {
                const r = ld?.gsplatManager?.renderer;
                if (r) ic = r.intervalCompaction;
            });
        });
        // ⚠️ 目标必须换成**带 COPY_SRC** 的 buffer：countBuffer 只有 STORAGE（拷不出来），
        //    上一版因此得出过一个无效读数。numSplatsBuffer = STORAGE | COPY_SRC | COPY_DST。
        const countGpu = ic && ic.numSplatsBuffer && ic.numSplatsBuffer.impl && ic.numSplatsBuffer.impl.buffer;
        if (!(countGpu instanceof GPUBuffer)) return { error: '拿不到 numSplatsBuffer 的 GPUBuffer' };
        const readU32 = async (g, off, bytes, dst) => {
            const enc = dev.createCommandEncoder();
            enc.copyBufferToBuffer(g, off, dst, 0, bytes);
            dev.queue.submit([enc.finish()]);
            await dst.mapAsync(GPUMapMode.READ);
            const v = Array.from(new Uint32Array(dst.getMappedRange().slice(0, bytes)));
            dst.unmap();
            return v;
        };
        const staging = dev.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        // ⚠️ 拷贝长度必须 ≤ 目标 buffer 大小（numSplatsBuffer 只有 4 字节）
        const BYTES = Math.min(4, countGpu.size);
        out.targetSize = countGpu.size;
        out.before = await readU32(countGpu, 0, BYTES, staging);
        out.usage = countGpu.usage;
        // 清干净再试验（用裸 encoder 写 0）
        const zero = dev.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
        dev.queue.writeBuffer(zero, 0, new Uint32Array([0, 0, 0, 0]));
        {
            const enc = dev.createCommandEncoder();
            enc.copyBufferToBuffer(zero, 0, countGpu, 0, BYTES);
            dev.queue.submit([enc.finish()]);
        }
        out.afterClear = await readU32(countGpu, 0, BYTES, staging);

        // ===== 裸 compute：buf[0] = 42 =====
        const mod = dev.createShaderModule({
            code: `
@group(0) @binding(0) var<storage, read_write> data: array<u32>;
@compute @workgroup_size(1)
fn main() {
    data[0] = 42u;
}
`
        });
        const pipe = dev.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'main' } });
        const bg = dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: countGpu } }] });
        const enc = dev.createCommandEncoder();
        const pass = enc.beginComputePass();
        pass.setPipeline(pipe);
        pass.setBindGroup(0, bg);
        pass.dispatchWorkgroups(1);
        pass.end();
        dev.queue.submit([enc.finish()]);
        await dev.queue.onSubmittedWorkDone();
        out.afterRawCompute = await readU32(countGpu, 0, BYTES, staging);
        staging.destroy();
        zero.destroy();
        return out;
    });

    const devErrs = await page.evaluate(() => window.__SR_E2__.slice(0, 5));

    console.log(JSON.stringify({ model: MODEL, res, devErrs, errs: errs.slice(0, 3) }, null, 1));
    console.log('\n=== 判定 ===');
    if (res.error) console.log('  ' + res.error);
    else {
        console.log(`  countBuffer 的 usage 位：${res.usage}`);
        console.log(`  清 0 后：${JSON.stringify(res.afterClear)}`);
        console.log(`  裸 compute(buf[0]=42) 之后：${JSON.stringify(res.afterRawCompute)}`);
        console.log(`  设备错误 ${devErrs.length} 条 ${JSON.stringify(devErrs)}`);
        const v = Array.isArray(res.afterRawCompute) ? res.afterRawCompute[0] : null;
        console.log(`  ⇒ ${v === 42 ? '**裸 compute 能写进这块 buffer** ⇒ 设备/缓冲没问题 ⇒ 引擎那批 compute 不落地是引擎侧问题' : '**连裸 compute 都写不进去** ⇒ 问题在设备/缓冲这一层'}`);
    }

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
