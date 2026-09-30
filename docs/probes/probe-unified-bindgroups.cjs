// 归档自 _tmp（2026-09-25 unified 通路根因定位那一轮），REPO 路径已按 docs/probes/ 调整。
// 探针 25：cull 的 **bind group 里到底绑了哪几个 buffer**（与 `ic.*` 的对象逐个比身份）。
//
// 引擎侧机制（playcanvas.mjs:5748-5793 / 5710-5716 / 7211-7218）：
//   BindGroup.update()      → 从 format 的 scopeId 取值 → setStorageBuffer(name, value)
//   setStorageBuffer()      → **只有对象身份变了**才 `dirty = true`
//   update() 末尾            → **只有 dirty** 才 `impl.update(this)`（真正重建 GPU bind group）
// ⇒ 只要 bind group 里存的是"另一个（旧的/别的）StorageBuffer 对象"，GPU 侧就会一直用旧的绑定：
//   cull 的写入落到别的 buffer 上，而我们读的 `ic.countBuffer` 永远保持初值 0。
//   这与本轮全部观测一致（JS 输入全对、dispatch 与 submit 都发生、0 报错、金丝雀不被吞）。
//
// 本探针把 cull / scatter / prefix / projector / writeArgs 各 compute 的
// `impl.bindGroups[0].storageBuffers` 逐个打出来，并与 `ic.*` / `frustumCuller.*` 比身份。
//
// usage: node _tmp/probe-unified-bindgroups.cjs [model]
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
    await page.evaluate(async () => {
        for (let i = 0; i < 2; i++) {
            window.scene.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
        }
    });
    await sleep(300);

    const res = await page.evaluate(() => {
        const scene = window.scene;
        const out = { computes: [], notes: [] };
        let ic = null;
        let fc = null;
        let r = null;
        scene?.app?.renderer?.gsplatDirector?.camerasMap?.forEach((cd) => {
            cd?.layersMap?.forEach((ld) => {
                const rr = ld?.gsplatManager?.renderer;
                if (rr) {
                    r = rr;
                    ic = rr.intervalCompaction;
                    fc = ld.gsplatManager.world?.workBuffer?.frustumCuller;
                }
            });
        });
        if (!ic) return { error: 'no ic' };
        const known = new Map();
        const label = (obj) => {
            if (!obj) return null;
            if (known.has(obj)) return known.get(obj);
            return 'unknown#' + (obj.id ?? '?');
        };
        // 登记已知对象
        const reg = (o, name) => { if (o && typeof o === 'object') known.set(o, name); };
        reg(ic.intervalsBuffer, 'ic.intervalsBuffer');
        reg(ic.countBuffer, 'ic.countBuffer');
        reg(ic.numSplatsBuffer, 'ic.numSplatsBuffer');
        reg(ic.sortElementCountBuffer, 'ic.sortElementCountBuffer');
        reg(ic.compactedSplatIds, 'ic.compactedSplatIds');
        reg(fc && fc.boundsBuffer, 'fc.boundsBuffer');
        reg(fc && fc.transformsBuffer, 'fc.transformsBuffer');
        if (r) {
            reg(r.projector && r.projector.projCache, 'projector.projCache');
            reg(r.projector && r.projector.numSplatsBuffer, 'projector.numSplatsBuffer');
            reg(r.projector && r.projector.indirectDrawSlot, 'projector.indirectDrawSlot');
        }
        const dump = (tag, compute) => {
            if (!compute) { out.computes.push({ tag, missing: true }); return; }
            const impl = compute.impl;
            const info = {
                tag,
                name: compute.name,
                countX: compute.countX, countY: compute.countY, countZ: compute.countZ,
                indirectSlotIndex: compute.indirectSlotIndex,
                hasImpl: !!impl,
                pipeline: !!(impl && impl.pipeline),
                bindGroups: [],
                params: [...(compute.parameters ? compute.parameters.keys() : [])]
            };
            if (impl && impl.bindGroups) {
                impl.bindGroups.forEach((bg, gi) => {
                    if (!bg) return;
                    info.bindGroups.push({
                        gi,
                        dirty: !!bg.dirty,
                        renderVersionUpdated: bg.renderVersionUpdated,
                        storageBuffers: (bg.storageBuffers ?? []).map(sb => ({
                            label: label(sb),
                            id: sb ? sb.id : null,
                            byteSize: sb ? sb.byteSize : null,
                            gpuSize: sb && sb.impl && sb.impl.buffer ? sb.impl.buffer.size : null,
                            isCurrentIcBuffer: sb === ic.countBuffer || sb === ic.intervalsBuffer
                        })),
                        uniformBuffers: (bg.uniformBuffers ?? []).length,
                        implHasBindGroup: !!(bg.impl && bg.impl.bindGroup)
                    });
                });
            }
            out.computes.push(info);
        };
        // cull（透视）/ scatter / 前缀和 / 写参数 / 投影
        try {
            const cull = typeof ic['_getCullCompute'] === 'function' ? ic['_getCullCompute'](false) : null;
            dump('ic.cull(perspective)', cull);
        } catch (e) { out.notes.push('cull: ' + String(e).slice(0, 120)); }
        dump('ic.scatter', ic['_scatterCompute']);
        dump('ic.writeArgs', ic['_writeIndirectArgsCompute']);
        dump('ic.prefixSumKernel.dispatch', ic.prefixSumKernel && ic.prefixSumKernel['_scanCompute']);
        dump('renderer.projector', r && r.projector && r.projector['_compute'] ? r.projector['_compute'] : null);
        out.projectorKeys = r && r.projector ? Object.keys(r.projector).filter(k => /compute|cache|indirect/i.test(k)) : null;
        out.icVersion = ic._uploadedVersion;
        return out;
    });

    console.log(JSON.stringify({ model: MODEL, res, errs: errs.slice(0, 3) }, null, 1));
    console.log('\n=== bind group 现场 ===');
    for (const c of res.computes) {
        if (c.missing) { console.log(`  ${c.tag}: (没有这个 compute)`); continue; }
        console.log(`  ${c.tag} name=${c.name} count=(${c.countX},${c.countY},${c.countZ}) pipeline=${c.pipeline} params=${JSON.stringify(c.params)}`);
        for (const bg of c.bindGroups) {
            console.log(`    group${bg.gi} dirty=${bg.dirty} renderVersionUpdated=${bg.renderVersionUpdated} gpuBindGroup=${bg.implHasBindGroup}`);
            bg.storageBuffers.forEach((sb, i) => console.log(`      slot${i}: ${sb.label} id=${sb.id} byteSize=${sb.byteSize} gpuSize=${sb.gpuSize}`));
        }
    }
    console.log(`  projector 相关字段：${JSON.stringify(res.projectorKeys)}`);

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
