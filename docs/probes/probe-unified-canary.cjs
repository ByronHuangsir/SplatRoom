// 归档自 _tmp（2026-09-25 unified 通路排查那一轮），REPO 路径已按 docs/probes/ 调整。
// 探针 21：**给区间表种一个金丝雀**，检验 cull 到底有没有真的在 GPU 上跑、有没有读到它。
//
// 推理链（全部为有效读数）：
//   · 区间表内容正确：{splatCount: 2000, boundsIndex: 0}（JS 层截住 write 的数值）；
//   · cull 的输入合法：bound = {center:(-0.0005,0,-0.30), radius:1.1563, transformIndex:0}，
//     transforms = 单位（带 -1 的 y 翻转），6 个平面的有符号距离算出来全是正的
//     （最小 0.549），而判定是 `dist <= -radius` ⇒ **应当 visible = true**；
//   · 但 countBuffer 仍是 [0,0] ⇒ 总计 0。
// 所以要么 cull 没在 GPU 上执行，要么它没读到我们写进去的那份区间表。
//
// 做法：区间表是 COPY_DST，可以从 JS 直接改。把 `splatCount` 改成 123456（金丝雀），
// 然后渲染 1 帧：
//   · countBuffer[1]（前缀和的总数）变成 123456 ⇒ cull 确实在跑、也确实读到了这张表
//     ⇒ 那 2000 那次为什么是 0 就另有原因（时序）；
//   · 仍是 0 ⇒ **cull 的写入没有落地**（compute 未被真正执行 / 结果被丢弃）。
//
// usage: node _tmp/probe-unified-canary.cjs [model]
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..', '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const { launchPatched: _launchPatched } = require('../verify/lib/browser.cjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL = process.argv[2] || 'test-model.ply';
const CANARY = 123456;

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

    const out = await page.evaluate(async (canary) => {
        const scene = window.scene;
        const dev = scene.app.graphicsDevice.wgpu;
        const res = {};
        let ic = null;
        scene?.app?.renderer?.gsplatDirector?.camerasMap?.forEach((cd) => {
            cd?.layersMap?.forEach((ld) => {
                const r = ld?.gsplatManager?.renderer;
                if (r) ic = r.intervalCompaction;
            });
        });
        if (!ic) return { error: 'no ic' };
        const gpu = (o) => {
            if (!o) return null;
            if (o instanceof GPUBuffer) return o;
            for (const c of [o.impl && o.impl.buffer, o.impl && o.impl.gpuBuffer, o.buffer]) {
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
        const intervalsGpu = gpu(ic.intervalsBuffer);
        const countGpu = gpu(ic.countBuffer);
        const numSplatsGpu = gpu(ic.numSplatsBuffer);
        res.sizes = { intervals: intervalsGpu && intervalsGpu.size, count: countGpu && countGpu.size, numSplats: numSplatsGpu && numSplatsGpu.size };
        res.countBefore = await readU32(countGpu, 0, 8);

        // 种金丝雀：区间 0 的 splatCount（偏移 4 字节）
        dev.queue.writeBuffer(intervalsGpu, 4, new Uint32Array([canary]));
        res.canaryWritten = canary;
        // 渲染 1 帧（不 invalidateUpload，保证引擎不会覆盖金丝雀）
        scene.app.renderNextFrame = true;
        await new Promise((r) => requestAnimationFrame(r));
        // 等 GPU 追平
        await dev.queue.onSubmittedWorkDone();
        res.countAfter = await readU32(countGpu, 0, 8);
        res.numSplatsAfter = await readU32(numSplatsGpu, 0, 4);
        res.uploadedVersion = ic._uploadedVersion;
        return res;
    }, CANARY);
    await sleep(300);

    console.log(JSON.stringify({ model: MODEL, out, errs: errs.slice(0, 3) }, null, 1));
    console.log('\n=== 判定 ===');
    if (out.error) console.log('  ' + out.error);
    else {
        console.log(`  buffer 大小：${JSON.stringify(out.sizes)}`);
        console.log(`  种金丝雀前 countBuffer = ${JSON.stringify(out.countBefore)}`);
        console.log(`  种金丝雀 splatCount = ${out.canaryWritten}，渲染 1 帧后：`);
        console.log(`    countBuffer = ${JSON.stringify(out.countAfter)}（期望 [0, ${out.canaryWritten}]）`);
        console.log(`    numSplatsBuffer = ${JSON.stringify(out.numSplatsAfter)}`);
        const total = Array.isArray(out.countAfter) ? out.countAfter[1] : null;
        console.log(`  ⇒ ${total === out.canaryWritten
            ? '**cull 确实在 GPU 上跑，也读到了区间表**（金丝雀被吞进去了）⇒ 之前的 0 是"visible=false"或时序问题'
            : '**cull 的写入没有落地**（金丝雀没被吞）⇒ compute 未被真正执行 / 结果被丢弃'}`);
    }

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
