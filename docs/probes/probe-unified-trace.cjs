// 归档自 _tmp（2026-09-25 unified 通路排查那一轮），REPO 路径已按 docs/probes/ 调整。
// 探针 12：把 unified 通路的**调用链参数**逐个记下来，找"第一个 0"。
//
// 已知（§4r + probe-unified-counts）：
//   · 间接参数全 0（零图元）；compute 有派发；但 countBuffer / numSplatsBuffer /
//     sortElementCountBuffer / intervalsBuffer / compactedSplatIds 全都是"没被写过"的样子。
// 本探针在页面上**包住引擎对象的方法**，把每一级的入参记下来：
//   renderer.sortAndProjectForCamera → ic.uploadIntervals → ic.dispatchCompact →
//   ic.writeIndirectArgs → renderer.prepareForCamera … 以及 device.computeDispatch 的每一步
//   （名字 + 工作组数）与 createComputePipeline 的次数。
// 于是"第一个 0 出现在哪一级"是读出来的，不是猜的。
//
// usage: node _tmp/probe-unified-trace.cjs [model]
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
        window.__SR_TRACE__ = [];
        window.__SR_CPIPE__ = 0;
        const hook = () => {
            const D = globalThis.GPUDevice;
            const CP = globalThis.GPUComputePassEncoder;
            if (!D || !D.prototype || D.prototype.__srT) return false;
            D.prototype.__srT = true;
            const cp = D.prototype.createComputePipeline;
            D.prototype.createComputePipeline = function (d) {
                window.__SR_CPIPE__++;
                return cp.call(this, d);
            };
            if (CP && CP.prototype) {
                const o = CP.prototype.dispatchWorkgroups;
                CP.prototype.dispatchWorkgroups = function (x, y, z) {
                    window.__SR_TRACE__.push({ t: 'dispatchWorkgroups', x, y, z });
                    return o.call(this, x, y, z);
                };
                const o2 = CP.prototype.dispatchWorkgroupsIndirect;
                CP.prototype.dispatchWorkgroupsIndirect = function (buf, off) {
                    window.__SR_TRACE__.push({ t: 'dispatchWorkgroupsIndirect', off });
                    return o2.call(this, buf, off);
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

    // 打开 unified，并在**翻转之后**包住引擎方法（对象这时才建好）
    await page.evaluate(async () => {
        const scene = window.scene;
        window.__SPLATROOM_UNIFIED__ = true;
        const el = (scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        el.entity.gsplat.unified = true;
        for (let i = 0; i < 30; i++) {
            scene.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
        }
    });
    await sleep(1000);

    const hooked = await page.evaluate(() => {
        const scene = window.scene;
        const gd = scene.app.graphicsDevice;
        const out = { hooked: [], missing: [] };
        scene?.app?.renderer?.gsplatDirector?.camerasMap?.forEach((cd) => {
            cd?.layersMap?.forEach((ld) => {
                const mgr = ld?.gsplatManager;
                const r = mgr && mgr.renderer;
                if (!r) return;
                const ic = r.intervalCompaction;
                const cs = mgr.createSorter ? null : null;
                void cs;
                // renderer.sortAndProjectForCamera
                if (typeof r.sortAndProjectForCamera === 'function' && !r.__srWrapped) {
                    const orig = r.sortAndProjectForCamera;
                    r.sortAndProjectForCamera = function (world, worldState, cameraNode, w, h, ac, pm, st, params) {
                        window.__SR_TRACE__.push({
                            t: 'sortAndProjectForCamera',
                            worldVersion: worldState && worldState.version,
                            totalActiveSplats: worldState && worldState.totalActiveSplats,
                            totalIntervals: worldState && worldState.totalIntervals,
                            cameraNode: cameraNode && cameraNode.name,
                            w, h,
                            hasBounds: !!(world && world.hasBounds)
                        });
                        return orig.apply(this, arguments);
                    };
                    r.__srWrapped = true;
                    out.hooked.push('renderer.sortAndProjectForCamera');
                } else out.missing.push('renderer.sortAndProjectForCamera');
                if (ic && typeof ic.uploadIntervals === 'function' && !ic.__srWrapped) {
                    const o1 = ic.uploadIntervals;
                    ic.uploadIntervals = function (ws) {
                        const before = this._uploadedVersion;
                        const res = o1.apply(this, arguments);
                        window.__SR_TRACE__.push({
                            t: 'uploadIntervals', version: ws && ws.version, before,
                            totalIntervals: ws && ws.totalIntervals, totalActiveSplats: ws && ws.totalActiveSplats,
                            skipped: ws && ws.version === before
                        });
                        return res;
                    };
                    const o2 = ic.dispatchCompact;
                    ic.dispatchCompact = function (fc, numIntervals, totalActiveSplats, fisheye) {
                        window.__SR_TRACE__.push({
                            t: 'dispatchCompact', numIntervals, totalActiveSplats, fisheye,
                            frustumPlanes: fc && fc.frustumPlanes ? Array.from(fc.frustumPlanes).map(v => +(+v).toFixed(3)) : null,
                            boundsEntries: fc && fc.totalBoundsEntries
                        });
                        return o2.apply(this, arguments);
                    };
                    const o3 = ic.writeIndirectArgs;
                    ic.writeIndirectArgs = function (drawSlot, base, numIntervals, info) {
                        window.__SR_TRACE__.push({ t: 'writeIndirectArgs', drawSlot, dispatchSlotBase: base, numIntervals, hasInfo: !!info });
                        return o3.apply(this, arguments);
                    };
                    ic.__srWrapped = true;
                    out.hooked.push('ic.uploadIntervals/dispatchCompact/writeIndirectArgs');
                } else out.missing.push('ic methods');
                // device.computeDispatch 的名字
                if (typeof gd.computeDispatch === 'function' && !gd.__srWrapped) {
                    const od = gd.computeDispatch.bind(gd);
                    gd.computeDispatch = function (computes, name) {
                        window.__SR_TRACE__.push({ t: 'computeDispatch', name, n: Array.isArray(computes) ? computes.length : 1 });
                        return od(computes, name);
                    };
                    gd.__srWrapped = true;
                    out.hooked.push('device.computeDispatch');
                } else out.missing.push('device.computeDispatch');
            });
        });
        return out;
    });

    await page.evaluate(() => { window.__SR_TRACE__ = []; });
    await page.evaluate(async () => {
        for (let i = 0; i < 2; i++) {
            window.scene.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
        }
    });
    await sleep(400);
    const trace = await page.evaluate(() => window.__SR_TRACE__.slice(0, 80));
    const cpipe = await page.evaluate(() => window.__SR_CPIPE__);

    console.log(JSON.stringify({ model: MODEL, hooked, cpipe, errs: errs.slice(0, 3) }, null, 1));
    console.log('\n=== 两帧的调用链 ===');
    for (const e of trace) console.log('  ' + JSON.stringify(e));

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
