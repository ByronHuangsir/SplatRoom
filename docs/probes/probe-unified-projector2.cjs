// 归档自 _tmp（2026-09-25 unified 通路根因定位那一轮），REPO 路径已按 docs/probes/ 调整。
// 探针 31：投影器参数现场（只回传**纯量**，避免上一版那种循环引用导致的序列化失败）。
//
// 链条已定位到（全部为有效读数）：
//   cull [0,2000] ✓ → 前缀和 ✓ → scatter ✓ → IntervalWriteIndirectArgs **确实写了 2000** ✓
//   → GSplatProjector 按 8 个 workgroup 派发 ✓
//   → ProjectorWriteIndirectArgs：`let count = renderCounter[0]; numSplatsBuf[0] = count;`
//     把 2000 **覆盖成 renderCounter[0]**（playcanvas.mjs:85906-85916）
//   → 实测 numSplatsBuffer = 0 ⇒ **renderCounter = 0 ⇒ 投影器一个有效 splat 都没算出**。
// 本探针回答"投影器为什么判所有 splat 无效"：把它的阈值类参数与 uniform 数值打出来。
//
// usage: node _tmp/probe-unified-projector2.cjs [model]
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

    const summary = await page.evaluate(async () => {
        const prim = (v) => {
            if (v === null || v === undefined) return null;
            const t = typeof v;
            if (t === 'number' || t === 'string' || t === 'boolean') return v;
            if (ArrayBuffer.isView(v)) return `view(${v.constructor.name},len=${v.length})`;
            return `obj(${v.constructor ? v.constructor.name : t})`;
        };
        const scene = window.scene;
        const dev = scene.app.graphicsDevice;
        const out = { computes: [], notes: [], strings: [] };
        let r = null;
        let mgr = null;
        scene?.app?.renderer?.gsplatDirector?.camerasMap?.forEach((cd) => {
            cd?.layersMap?.forEach((ld) => {
                if (ld?.gsplatManager?.renderer) { mgr = ld.gsplatManager; r = ld.gsplatManager.renderer; }
            });
        });
        if (!r) return { error: 'no renderer' };
        const p = r.projector;
        // renderCounter
        const g = p.renderCounter && p.renderCounter.impl && p.renderCounter.impl.buffer;
        if (g) {
            const st = dev.wgpu.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
            const enc = dev.wgpu.createCommandEncoder();
            enc.copyBufferToBuffer(g, 0, st, 0, 4);
            dev.wgpu.queue.submit([enc.finish()]);
            await st.mapAsync(GPUMapMode.READ);
            out.renderCounter = Array.from(new Uint32Array(st.getMappedRange().slice(0, 4)))[0];
            st.unmap();
            st.destroy();
        }
        const st2 = mgr && mgr.world ? mgr.world.currentState : null;
        out.worldState = st2 ? {
            version: prim(st2.version),
            needsUpload: prim(st2.needsUpload),
            needsUploadIds: st2.needsUploadIds ? (st2.needsUploadIds.size ?? st2.needsUploadIds.length ?? prim(st2.needsUploadIds)) : null,
            fullRebuild: prim(st2.fullRebuild),
            sortedBefore: prim(st2.sortedBefore),
            sortParametersSet: prim(st2.sortParametersSet),
            textureSize: prim(st2.textureSize),
            totalActiveSplats: prim(st2.totalActiveSplats)
        } : null;
        // 投影器 compute
        const computes = p._projectorComputes;
        let list = [];
        if (Array.isArray(computes)) list = computes;
        else if (computes && computes.values) list = [...computes.values()];
        out.computeCount = list.length;
        for (const c of list.slice(0, 2)) {
            const info = { name: prim(c.name), count: [prim(c.countX), prim(c.countY), prim(c.countZ)], params: [] };
            for (const [name, param] of c.parameters) {
                info.params.push({ name, value: prim(param.value), hasValue: param.value !== undefined && param.value !== null });
            }
            const impl = c.impl;
            if (impl && impl.uniformBuffers) {
                info.uniforms = impl.uniformBuffers.map(ub => ({
                    byteSize: ub.format ? ub.format.byteSize : null,
                    fields: ub.format ? ub.format.uniforms.map(u => `${u.name}@${u.offset}`) : null,
                    cpuF32: ub.storageFloat32 ? Array.from(ub.storageFloat32).slice(0, 20).map(x => +x.toFixed(4)) : null,
                    cpuU32: ub.storageUint32 ? Array.from(ub.storageUint32).slice(0, 20) : null
                }));
            }
            out.computes.push(info);
        }
        // 资源贴图
        try {
            const wb = mgr.world.workBuffer;
            out.textures = (wb.format.resourceStreams ?? []).map(s2 => {
                const t = wb.getTexture(s2.name);
                return `${s2.name}:${t ? `${t.width}x${t.height}` : 'none'}`;
            });
        } catch (e) { out.notes.push('textures: ' + String(e).slice(0, 100)); }
        try { out.projectorKeys = Object.keys(p).map(k => String(k)); } catch (e) { out.notes.push('keys: ' + String(e).slice(0, 80)); }
        return out;
    });

    console.log(JSON.stringify({ model: MODEL, summary, errs: errs.slice(0, 3) }, null, 1));
    console.log('\n=== 投影器现场 ===');
    if (summary.error) console.log('  ' + summary.error);
    else {
        console.log(`  renderCounter = ${summary.renderCounter}（0 ⇒ 没有有效 splat）`);
        console.log(`  worldState = ${JSON.stringify(summary.worldState)}`);
        console.log(`  资源贴图 = ${JSON.stringify(summary.textures)}`);
        console.log(`  projector 字段 = ${JSON.stringify(summary.projectorKeys)}`);
        for (const c of summary.computes ?? []) {
            console.log(`  compute ${c.name} count=${JSON.stringify(c.count)}`);
            console.log(`    参数：${JSON.stringify(c.params)}`);
            for (const u of c.uniforms ?? []) {
                console.log(`    uniform(${u.byteSize}B) 字段=${JSON.stringify(u.fields)}`);
                console.log(`      CPU f32=${JSON.stringify(u.cpuF32)}  CPU u32=${JSON.stringify(u.cpuU32)}`);
            }
        }
    }

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
