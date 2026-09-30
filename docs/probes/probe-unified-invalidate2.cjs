// 归档自 _tmp（2026-09-25 unified 通路排查那一轮），REPO 路径已按 docs/probes/ 调整。
// 探针 17：把 probe-14 的读数修好（拷贝长度 = min(32, buffer 大小)）后重做"强制重传区间表"实验。
//
// 为什么要重做：probe-14 的读数**无效** —— 它从 16B / 8B / 4B 的 buffer 里各抄 32 字节，
// 拷贝被校验拒绝、一次都没发生，staging 保持新建时的全 0。所以那一轮"修了没用"的结论不成立。
//
// 已知（探针 12 的调用链 trace，这一条是 JS 层的参数记录，有效）：
//   {"t":"uploadIntervals","version":1,"before":1,"totalIntervals":1,"totalActiveSplats":2000,"skipped":true}
// 即 `uploadIntervals` 的 `if (worldState.version === this._uploadedVersion) return;` 永远命中。
//
// usage: node _tmp/probe-unified-invalidate2.cjs [model]
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..', '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const { launchPatched: _launchPatched } = require('../verify/lib/browser.cjs');
const { decodePng } = require(path.join(REPO, 'docs', 'verify', 'lib', 'png.cjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL = process.argv[2] || 'test-model.ply';

const mean = (f) => {
    const P = decodePng(fs.readFileSync(f));
    let r = 0;
    let g = 0;
    let b = 0;
    const n = P.width * P.height;
    for (let i = 0; i < P.data.length; i += P.channels) {
        r += P.data[i];
        g += P.data[i + 1];
        b += P.data[i + 2];
    }
    return [+(r / n).toFixed(2), +(g / n).toFixed(2), +(b / n).toFixed(2)];
};
const diff = (a, b) => {
    const A = decodePng(fs.readFileSync(a));
    const B = decodePng(fs.readFileSync(b));
    let sum = 0;
    let changed = 0;
    const n = A.width * A.height;
    for (let i = 0; i < A.data.length; i += A.channels) {
        let d = 0;
        for (let c = 0; c < 3; c++) d += Math.abs(A.data[i + c] - B.data[i + c]);
        sum += d;
        if (d > 24) changed++;
    }
    return { mad: +(sum / n / 3).toFixed(4), changedPct: +((changed / n) * 100).toFixed(2) };
};

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
        const hook = () => {
            const A = globalThis.GPUAdapter;
            if (!A || !A.prototype || A.prototype.__srX) return false;
            A.prototype.__srX = true;
            const orig = A.prototype.requestDevice;
            A.prototype.requestDevice = async function (desc) {
                const dev = await orig.call(this, desc);
                try {
                    dev.addEventListener('uncapturederror', (e) => {
                        if (window.__SR_ON__) window.__SR_ERR__.push(String(e.error && e.error.message ? e.error.message : e.error).slice(0, 200));
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

    const frames = (n) => page.evaluate(async (k) => {
        for (let i = 0; i < k; i++) {
            window.scene.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
        }
    }, n);
    const shot = async (name) => {
        const f = path.join(REPO, '_tmp', `inv3-${name}.png`);
        fs.writeFileSync(f, Buffer.from(await page.screenshot({ encoding: 'base64' }), 'base64'));
        return f;
    };
    const probe = () => page.evaluate(async () => {
        const scene = window.scene;
        const dev = window.__SR_DEV__;
        const out = { reads: [], uploadedVersion: null, install: window.__SPLATROOM_UNIFIED_MATERIAL_INSTALLED__ ?? null };
        const findGpu = (o) => {
            if (!o) return null;
            if (o instanceof GPUBuffer) return o;
            for (const c of [o.impl && o.impl.gpuBuffer, o.impl && o.impl.buffer, o.buffer, o.gpuBuffer]) {
                if (c instanceof GPUBuffer) return c;
            }
            return null;
        };
        const readBuf = async (label, g) => {
            if (!g) { out.reads.push({ label, missing: true }); return; }
            const bytes = Math.min(32, g.size);
            const st = dev.createBuffer({ size: Math.max(bytes, 4), usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
            const enc = dev.createCommandEncoder();
            enc.copyBufferToBuffer(g, 0, st, 0, bytes);
            dev.queue.submit([enc.finish()]);
            await st.mapAsync(GPUMapMode.READ);
            const u = Array.from(new Uint32Array(st.getMappedRange().slice(0, bytes)));
            st.unmap();
            st.destroy();
            out.reads.push({ label, size: g.size, bytes, u32: u });
        };
        let ic = null;
        let r = null;
        scene?.app?.renderer?.gsplatDirector?.camerasMap?.forEach((cd) => {
            cd?.layersMap?.forEach((ld) => {
                if (ld?.gsplatManager?.renderer) { r = ld.gsplatManager.renderer; ic = r.intervalCompaction; }
            });
        });
        out.uploadedVersion = ic ? ic._uploadedVersion : null;
        out.worldVersion = scene?.app?.renderer?.gsplatDirector ? (() => {
            let v = null;
            scene.app.renderer.gsplatDirector.camerasMap.forEach((cd) => {
                cd?.layersMap?.forEach((ld) => {
                    const st = ld?.gsplatManager?.world?.currentState;
                    if (st) v = st.version;
                });
            });
            return v;
        })() : null;
        if (ic) {
            await readBuf('ic.intervalsBuffer', findGpu(ic.intervalsBuffer));
            await readBuf('ic.countBuffer', findGpu(ic.countBuffer));
            await readBuf('ic.numSplatsBuffer', findGpu(ic.numSplatsBuffer));
            await readBuf('ic.sortElementCountBuffer', findGpu(ic.sortElementCountBuffer));
            await readBuf('ic.compactedSplats', findGpu(ic.compactedSplatIds));
        }
        await readBuf('device.indirectDrawBuffer', findGpu(scene.app.graphicsDevice.indirectDrawBuffer));
        void r;
        return out;
    });

    const cpu = await shot('cpu');

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

    const before = await probe();
    const shotBefore = await shot('before');

    const invalidated = await page.evaluate(() => {
        let n = 0;
        window.scene?.app?.renderer?.gsplatDirector?.camerasMap?.forEach((cd) => {
            cd?.layersMap?.forEach((ld) => {
                const ic = ld?.gsplatManager?.renderer?.intervalCompaction;
                if (ic && typeof ic.invalidateUpload === 'function') { ic.invalidateUpload(); n++; }
            });
        });
        return n;
    });
    await frames(3);
    await sleep(400);

    const after = await probe();
    const shotAfter = await shot('after');

    // 稳态错误清零后再数一遍
    await page.evaluate(() => { window.__SR_ERR__ = []; window.__SR_ON__ = true; });
    await frames(3);
    await sleep(300);
    const errsAfter = await page.evaluate(() => ({ n: window.__SR_ERR__.length, first: window.__SR_ERR__.slice(0, 2) }));

    const fmt = (p) => p.reads.map(r => `${r.label}=${r.missing ? '(缺)' : JSON.stringify(r.u32)}`).join('\n    ');
    console.log(JSON.stringify({ model: MODEL, invalidated, before, after, errsAfter, means: { cpu: mean(cpu), before: mean(shotBefore), after: mean(shotAfter) }, d: diff(shotBefore, shotAfter), errs: errs.slice(0, 3) }, null, 1));
    console.log('\n=== 判定 ===');
    console.log(`  invalidateUpload 调用 ${invalidated} 次`);
    console.log(`  修前（uploadedVersion=${before.uploadedVersion} worldVersion=${before.worldVersion}）：\n    ${fmt(before)}`);
    console.log(`  修后（uploadedVersion=${after.uploadedVersion} worldVersion=${after.worldVersion}）：\n    ${fmt(after)}`);
    console.log(`  稳态 3 帧未捕获错误：${errsAfter.n} 条 ${JSON.stringify(errsAfter.first)}`);
    console.log(`  画面：cpu=${JSON.stringify(mean(cpu))} 修前=${JSON.stringify(mean(shotBefore))} 修后=${JSON.stringify(mean(shotAfter))}；修后 vs 修前 ${JSON.stringify(diff(shotBefore, shotAfter))}`);

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
