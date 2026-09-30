// 归档自 _tmp（2026-09-25 unified 通路排查那一轮），REPO 路径已按 docs/probes/ 调整。
// 探针 22：这些 compute 到底有没有被**提交**（金丝雀实验的收口）。
//
// 已知（探针 21）：把区间表的 `splatCount` 改成金丝雀 123456 之后渲染 1 帧，
// countBuffer 仍是 [0,0] ⇒ cull 的**读写都没落地**（compute 未被真正执行 / 结果被丢弃），
// 而 `device.computeDispatch(..., "GSplatIntervalCull")` 明明被调用了、0 条校验错误。
//
// 本探针把"记录 compute 的那个 encoder"和"被 submit 的 command buffer"对上：
//   beginComputePass → 给该 encoder 打标记 hasCompute
//   finish           → 给产出的 command buffer 打上 encoder 的 id
//   queue.submit     → 记下每次提交了哪些 command buffer（带 id / hasCompute）
// 判据：如果**没有任何带 hasCompute 的 command buffer 被提交**，那根因就是
// "compute 记在了一个从不提交的 encoder 里"（这就是本文档标题里那个"不落地"）。
//
// usage: node _tmp/probe-unified-submit.cjs [model]
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
        window.__SR_LOG__ = { encoders: 0, buffers: [], submits: [], computePasses: 0, computeEncoders: [] };
        const hook = () => {
            const CE = globalThis.GPUCommandEncoder;
            const Q = globalThis.GPUQueue;
            const CP = globalThis.GPUComputePassEncoder;
            const PR = globalThis.GPURenderPassEncoder;
            if (!CE || !CE.prototype || CE.prototype.__srS) return false;
            CE.prototype.__srS = true;
            const mk = (enc) => {
                if (!enc.__srId) {
                    enc.__srId = ++window.__SR_LOG__.encoders;
                    enc.__srHasCompute = false;
                    enc.__srHasRender = false;
                }
                return enc.__srId;
            };
            const bc = CE.prototype.beginComputePass;
            CE.prototype.beginComputePass = function (...a) {
                const p = bc.apply(this, a);
                mk(this);
                this.__srHasCompute = true;
                window.__SR_LOG__.computePasses++;
                p.__srEnc = this;
                return p;
            };
            const br = CE.prototype.beginRenderPass;
            CE.prototype.beginRenderPass = function (...a) {
                const p = br.apply(this, a);
                mk(this);
                this.__srHasRender = true;
                p.__srEnc = this;
                return p;
            };
            const fi = CE.prototype.finish;
            CE.prototype.finish = function (...a) {
                const cb = fi.apply(this, a);
                const id = mk(this);
                try {
                    cb.__srInfo = { id, hasCompute: !!this.__srHasCompute, hasRender: !!this.__srHasRender };
                    window.__SR_LOG__.buffers.push(cb.__srInfo);
                } catch (e) { /* ignore */ }
                return cb;
            };
            if (Q && Q.prototype) {
                const su = Q.prototype.submit;
                Q.prototype.submit = function (cbs) {
                    try {
                        window.__SR_LOG__.submits.push((cbs ?? []).map(c => (c && c.__srInfo) ? { ...c.__srInfo } : 'unknown'));
                    } catch (e) { /* ignore */ }
                    return su.call(this, cbs);
                };
            }
            if (CP && CP.prototype) {
                const o = CP.prototype.dispatchWorkgroupsIndirect;
                CP.prototype.dispatchWorkgroupsIndirect = function (...a) {
                    window.__SR_LOG__.computeEncoders.push(this.__srEnc ? this.__srEnc.__srId : 'no-enc');
                    return o.apply(this, a);
                };
            }
            if (PR && PR.prototype) {
                const o = PR.prototype.drawIndexedIndirect;
                PR.prototype.drawIndexedIndirect = function (...a) {
                    window.__SR_LOG__.drawEncoders = window.__SR_LOG__.drawEncoders || [];
                    window.__SR_LOG__.drawEncoders.push(this.__srEnc ? this.__srEnc.__srId : 'no-enc');
                    return o.apply(this, a);
                };
            }
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
        window.__SR_LOG__ = { encoders: 0, buffers: [], submits: [], computePasses: 0, computeEncoders: [], drawEncoders: [] };
        for (let i = 0; i < 2; i++) {
            window.scene.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
        }
        await window.scene.app.graphicsDevice.wgpu.queue.onSubmittedWorkDone();
        return JSON.parse(JSON.stringify(window.__SR_LOG__));
    });

    console.log(JSON.stringify({ model: MODEL, res, errs: errs.slice(0, 3) }, null, 1));
    console.log('\n=== 判定 ===');
    console.log(`  2 帧里：commandEncoder ${res.encoders} 个、command buffer ${res.buffers.length} 个、compute pass ${res.computePasses} 个`);
    console.log(`  finish 出来的 buffer（id/hasCompute/hasRender）：${JSON.stringify(res.buffers)}`);
    console.log(`  queue.submit 调用 ${res.submits.length} 次：${JSON.stringify(res.submits)}`);
    const submitted = new Set();
    for (const s of res.submits) for (const b of s) if (b && b.id) submitted.add(b.id);
    const withCompute = res.buffers.filter(b => b.hasCompute);
    const computeSubmitted = withCompute.filter(b => submitted.has(b.id));
    console.log(`  带 compute 的 buffer：${withCompute.map(b => b.id).join(',') || '(无)'}`);
    console.log(`  其中被提交的：${computeSubmitted.map(b => b.id).join(',') || '(无)'}`);
    console.log(`  ⇒ ${withCompute.length === 0
        ? '**根本没有 compute pass 落在 encoder 里**（dispatch 记到了别处？）'
        : computeSubmitted.length === 0
            ? '**compute 记在了从不提交的 encoder 里** ⇒ 这就是"引擎侧 compute 不落地"的机理'
            : '带 compute 的 buffer 确实被提交了 ⇒ 问题在别处（管线/绑定/写入时序）'}`);

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
