// 归档自 _tmp（2026-09-25 unified 通路根因定位那一轮），REPO 路径已按 docs/probes/ 调整。
// 探针 28：writeArgs 那条 compute 的 **uniform 到底有没有被填上**（断点就在这一步的最后一个候选）。
//
// 已知（探针 27，裸 compute 读引擎自己的 countBuffer）：`countBuffer = [0, 2000]` —— 说明
// cull 与前缀和**都跑了**，共 2000 个可见 splat 就在 countBuffer[1] 里。
// 而 `GSplatIntervalWriteIndirectArgs` 的 WGSL 是：
//     let count = prefixSumBuffer[uniforms.totalSplats];   // = countBuffer[numIntervals] = 2000
//     indirectDrawArgs[uniforms.drawSlot] = DrawIndexedIndirectArgs(uniforms.indexCount, (count+N-1)/N, ...)
//     numSplatsBuf[0] = count;
// 若 `uniforms.totalSplats` 读到 0，则 count = countBuffer[0] = 0 ⇒ numSplatsBuf[0] = 0、
// instanceCount = 0、indexCount = 0 ⇒ **零图元**，与本轮所有观测完全一致。
//
// 引擎的 uniform 取值链（playcanvas.mjs:11231-11239）：
//     UniformBuffer.update() → uniforms[i].scopeId.value → setUniform(...)
// 而 `compute.setParameter(name, v)` 写的是 **device.scope.resolve(name)**（playcanvas.mjs:17129-17137）。
// 只要这两处的 ScopeId **不是同一个对象**，参数就永远进不了 uniform buffer（而且不报错）。
// 本探针把这条链逐环打出来：identity 比较 + CPU 侧 storage 的实际数值。
//
// usage: node _tmp/probe-unified-uniforms.cjs [model]
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

    const res = await page.evaluate(() => {
        const scene = window.scene;
        const dev = scene.app.graphicsDevice;
        const out = { computes: [], notes: [] };
        let ic = null;
        scene?.app?.renderer?.gsplatDirector?.camerasMap?.forEach((cd) => {
            cd?.layersMap?.forEach((ld) => {
                const r = ld?.gsplatManager?.renderer;
                if (r) ic = r.intervalCompaction;
            });
        });
        if (!ic) return { error: 'no ic' };

        const dumpCompute = (tag, compute) => {
            if (!compute) { out.computes.push({ tag, missing: true }); return; }
            const info = { tag, name: compute.name, params: [], uniformBuffers: [] };
            // 参数：值 + scopeId 身份
            for (const [name, param] of compute.parameters) {
                const deviceScope = dev.scope.resolve(name);
                info.params.push({
                    name,
                    valueType: typeof param.value === 'object' && param.value !== null
                        ? (param.value.constructor ? param.value.constructor.name : 'obj') : typeof param.value,
                    value: (typeof param.value === 'number') ? param.value : undefined,
                    sameScopeAsDevice: param.scopeId === deviceScope,
                    deviceScopeValue: (typeof deviceScope.value === 'number') ? deviceScope.value
                        : (deviceScope.value && deviceScope.value.constructor ? deviceScope.value.constructor.name : typeof deviceScope.value)
                });
            }
            const impl = compute.impl;
            if (impl && impl.uniformBuffers) {
                impl.uniformBuffers.forEach((ub, i) => {
                    const fmt = ub.format;
                    info.uniformBuffers.push({
                        i,
                        byteSize: fmt ? fmt.byteSize : null,
                        offsets: fmt ? fmt.uniforms.map(u => `${u.name}@${u.offset}`) : null,
                        // 每个 uniform 的 scopeId 是否就是 device.scope.resolve(同名)
                        scopeIdentity: fmt ? fmt.uniforms.map(u => ({
                            name: u.name,
                            sameAsDevice: u.scopeId === dev.scope.resolve(u.name),
                            value: (typeof u.scopeId.value === 'number') ? u.scopeId.value
                                : (u.scopeId.value && u.scopeId.value.constructor ? u.scopeId.value.constructor.name : typeof u.scopeId.value)
                        })) : null,
                        cpuStorageU32: ub.storageUint32 ? Array.from(ub.storageUint32).slice(0, 12) : null
                    });
                });
            }
            out.computes.push(info);
        };

        try { dumpCompute('cull', ic['_getCullCompute'](false)); } catch (e) { out.notes.push('cull: ' + String(e).slice(0, 100)); }
        dumpCompute('scatter', ic['_scatterCompute']);
        dumpCompute('writeArgs', ic['_writeIndirectArgsCompute']);
        return out;
    });

    console.log(JSON.stringify({ model: MODEL, res, errs: errs.slice(0, 3) }, null, 1));
    console.log('\n=== uniform 链逐环 ===');
    for (const c of res.computes) {
        if (c.missing) { console.log(`  ${c.tag}: (没有)`); continue; }
        console.log(`  ${c.tag} (${c.name})`);
        for (const p of c.params) {
            console.log(`    参数 ${p.name}: ${p.sameScopeAsDevice ? 'scopeId 与 device.scope 同一对象 ✓' : '**scopeId 与 device.scope 不是同一对象 ✗**'}（device 侧值=${p.deviceScopeValue}，值=${p.value ?? p.valueType}）`);
        }
        for (const ub of c.uniformBuffers) {
            console.log(`    uniformBuffer[${ub.i}] byteSize=${ub.byteSize} CPU侧=${JSON.stringify(ub.cpuStorageU32)}`);
            if (ub.scopeIdentity) {
                const bad = ub.scopeIdentity.filter(s => !s.sameAsDevice);
                console.log(`      字段：${ub.offsets.join(', ')}`);
                console.log(`      scopeId 同一性：${bad.length === 0 ? '全部一致 ✓' : '**不一致：' + bad.map(b => b.name).join(',') + ' ✗**'}`);
            }
        }
    }

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
