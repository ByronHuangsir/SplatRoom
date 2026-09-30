// 归档自 _tmp（2026-09-25 unified 通路排查那一轮），REPO 路径已按 docs/probes/ 调整。
// 探针 19：cull 那一级到底写了什么 —— 三件事一起量。
//
// 已知（探针 18，JS 层截住 write）：引擎的区间表**内容是对的**：`uploadIntervals` 写的是
//   {workBufferBase: 0, splatCount: 2000, boundsIndex: 0, pad: 0}
// 而 cull 的 WGSL 是：`countBuffer[idx] = select(0u, interval.splatCount, visible);`
//   ⇒ 只要 splatCount 真是 2000，"全被裁掉"也只会 0，否则按平面测试结果给 2000 或 0。
// 但**有效可读**的 countBuffer 读出来是 [0,0]（这个 buffer 带 COPY_SRC，读数有效）。
//
// 所以只剩两种情况，本探针一次分清：
//   (A) cull 那条 compute **没真正执行**（管线无效 / dispatch 空转）
//   (B) cull 执行了，但读到的 splatCount 是 0（即 writeBuffer 没落到 GPU 上）
// 手段：
//   1. 在**引擎自己那次**上传前后记日志（先 invalidateUpload，再渲染 2 帧，抓 write 的数值）；
//   2. 数 compute 管线创建次数 / compute pass 的 setPipeline 次数 / dispatchWorkgroups 次数；
//   3. 每一帧后读 countBuffer（有效拷贝），看它有没有从 0 变成别的值；
//   4. 全程挂 uncapturederror。
//
// usage: node _tmp/probe-unified-cull.cjs [model]
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
        window.__SR_ERR__ = [];
        window.__SR_ON__ = false;
        window.__SR_CPIPE__ = 0;
        window.__SR_CSET__ = 0;
        window.__SR_CDISP__ = 0;
        const hook = () => {
            const A = globalThis.GPUAdapter;
            const D = globalThis.GPUDevice;
            const CP = globalThis.GPUComputePassEncoder;
            if (!D || !D.prototype || D.prototype.__srCl) return false;
            D.prototype.__srCl = true;
            const ccp = D.prototype.createComputePipeline;
            D.prototype.createComputePipeline = function (d) {
                window.__SR_CPIPE__++;
                return ccp.call(this, d);
            };
            if (CP && CP.prototype) {
                const sp = CP.prototype.setPipeline;
                CP.prototype.setPipeline = function (p) {
                    window.__SR_CSET__++;
                    return sp.call(this, p);
                };
                const dw = CP.prototype.dispatchWorkgroups;
                CP.prototype.dispatchWorkgroups = function (...a) {
                    window.__SR_CDISP__++;
                    return dw.apply(this, a);
                };
            }
            if (A && A.prototype && !A.prototype.__srCl2) {
                A.prototype.__srCl2 = true;
                const orig = A.prototype.requestDevice;
                A.prototype.requestDevice = async function (desc) {
                    const dev = await orig.call(this, desc);
                    try {
                        dev.addEventListener('uncapturederror', (e) => {
                            if (window.__SR_ON__) window.__SR_ERR__.push(String(e.error && e.error.message ? e.error.message : e.error).slice(0, 180));
                        });
                    } catch (e) { /* ignore */ }
                    return dev;
                };
            }
            return true;
        };
        hook();
    });

    await page.goto('http://localhost:3100/?gpu=webgpu', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1200);
    await page.evaluate(() => { window.__SR_DEV__ = window.scene.app.graphicsDevice.wgpu; });
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

    const prep = await page.evaluate(() => {
        const scene = window.scene;
        let ic = null;
        scene?.app?.renderer?.gsplatDirector?.camerasMap?.forEach((cd) => {
            cd?.layersMap?.forEach((ld) => {
                if (ld?.gsplatManager?.renderer) ic = ld.gsplatManager.renderer.intervalCompaction;
            });
        });
        if (!ic) return { error: 'no ic' };
        window.__SR_IC__ = ic;
        window.__SR_WRITES__ = [];
        if (!ic.intervalsBuffer.__srW2) {
            const buf = ic.intervalsBuffer;
            const ow = buf.write.bind(buf);
            buf.write = function (bufferOffset, data, dataOffset, size) {
                try {
                    window.__SR_WRITES__.push({ bufferOffset, dataOffset, size, first: data ? Array.from(data).slice(0, 8) : null });
                } catch (e) { /* ignore */ }
                return ow(bufferOffset, data, dataOffset, size);
            };
            buf.__srW2 = true;
        }
        // 计数 cull 的 dispatch：包住 computeDispatch 找名字
        const gd = scene.app.graphicsDevice;
        if (typeof gd.computeDispatch === 'function' && !gd.__srName) {
            const od = gd.computeDispatch.bind(gd);
            gd.computeDispatch = function (computes, name) {
                window.__SR_NAMES__ = window.__SR_NAMES__ || [];
                window.__SR_NAMES__.push(name);
                return od(computes, name);
            };
            gd.__srName = true;
        }
        return { ok: true, uploadedVersion: ic._uploadedVersion };
    });

    const readCount = () => page.evaluate(async () => {
        const dev = window.__SR_DEV__;
        const ic = window.__SR_IC__;
        const findGpu = (o) => {
            if (!o) return null;
            if (o instanceof GPUBuffer) return o;
            for (const c of [o.impl && o.impl.buffer, o.impl && o.impl.gpuBuffer, o.buffer]) {
                if (c instanceof GPUBuffer) return c;
            }
            return null;
        };
        const out = {};
        for (const key of ['countBuffer', 'numSplatsBuffer', 'sortElementCountBuffer']) {
            const g = findGpu(ic[key]);
            if (!g) { out[key] = 'missing'; continue; }
            const bytes = Math.min(16, g.size);
            const st = dev.createBuffer({ size: Math.max(bytes, 4), usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
            const enc = dev.createCommandEncoder();
            enc.copyBufferToBuffer(g, 0, st, 0, bytes);
            dev.queue.submit([enc.finish()]);
            await st.mapAsync(GPUMapMode.READ);
            out[key] = Array.from(new Uint32Array(st.getMappedRange().slice(0, bytes)));
            st.unmap();
            st.destroy();
        }
        return out;
    });

    const before = await readCount();

    // 强制重传，然后只渲染 2 帧，抓引擎自己那次 write 与之后的 countBuffer
    const step = await page.evaluate(async () => {
        window.__SR_WRITES__ = [];
        window.__SR_NAMES__ = [];
        window.__SR_CPIPE__ = 0; window.__SR_CSET__ = 0; window.__SR_CDISP__ = 0;
        window.__SR_ERR__ = []; window.__SR_ON__ = true;
        window.__SR_IC__.invalidateUpload();
        for (let i = 0; i < 2; i++) {
            window.scene.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
        }
        return {
            writes: window.__SR_WRITES__.slice(0, 4),
            names: (window.__SR_NAMES__ ?? []).slice(0, 20),
            cpipe: window.__SR_CPIPE__, cset: window.__SR_CSET__, cdisp: window.__SR_CDISP__,
            errors: window.__SR_ERR__.length, firstErr: window.__SR_ERR__.slice(0, 2),
            uploadedVersion: window.__SR_IC__._uploadedVersion
        };
    });
    await sleep(400);
    const after = await readCount();

    console.log(JSON.stringify({ model: MODEL, prep, before, step, after, errs: errs.slice(0, 3) }, null, 1));
    console.log('\n=== 判定 ===');
    console.log(`  强制重传时引擎自己写的区间数据：${JSON.stringify(step.writes)}`);
    console.log(`  这两帧里的 compute：管线创建 ${step.cpipe} 次、setPipeline ${step.cset} 次、dispatchWorkgroups ${step.cdisp} 次`);
    console.log(`  这两帧的 compute 名字：${JSON.stringify(step.names)}`);
    console.log(`  未捕获错误 ${step.errors} 条 ${JSON.stringify(step.firstErr)}`);
    console.log(`  countBuffer：重传前 ${JSON.stringify(before.countBuffer)} → 重传后 ${JSON.stringify(after.countBuffer)}`);
    console.log(`  numSplatsBuffer：${JSON.stringify(before.numSplatsBuffer)} → ${JSON.stringify(after.numSplatsBuffer)}`);
    console.log(`  sortElementCountBuffer：${JSON.stringify(before.sortElementCountBuffer)} → ${JSON.stringify(after.sortElementCountBuffer)}`);
    const cb = Array.isArray(after.countBuffer) ? after.countBuffer[0] : null;
    console.log(`  ⇒ ${cb === 0 ? '**(B)：cull 读到的 splatCount 是 0**（或 cull 没写）—— 继续看 writeBuffer 是否落盘' : `**(A) 排除**：重传后 countBuffer[0] = ${cb}`}`);

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
