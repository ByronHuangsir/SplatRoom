// 归档自 _tmp（2026-09-25 unified 通路根因定位那一轮），REPO 路径已按 docs/probes/ 调整。
// 探针 33：**验证根因修复** —— 强制引擎做一次 work buffer 全量上传。
//
// 根因（这条链的终点，全部为有效读数）：
//   引擎首次把 splat 数据填进 work buffer 的贴图**只发生在** `GSplatWorld.markSorted()` 里：
//       if (worldState && !worldState.sortedBefore) {
//           worldState.sortedBefore = true;
//           this.rebuildWorkBuffer(worldState, count, false, camera, updateBounds);   // ← 真正的上传
//       }
//   （playcanvas.mjs:85002-85008）
//   之后每帧走 `bake()`：`_workBufferRebuildRequired ? rebuildWorkBuffer(..., true, ...) : applyWorkBufferUpdates(...)`
//   （:85025-85033）。而我们的 worldState 报的是 **`sortedBefore: true`**、`fullRebuild: true`、
//   `needsUpload: 1` ⇒ markSorted 那条路被跳过、bake 只走增量路径（本帧上传 0 块）。
//   证据：unified 期间对 48×48 的三张数据贴图 **一次上传都没有**（拦 `queue.writeTexture` /
//   `copyBufferToTexture` 统计），而投影器实测 `renderCounter = 0`（一个有效 splat 都没有）
//   ⇒ `ProjectorWriteIndirectArgs` 把计数写成 0 ⇒ 绘制 instanceCount = 0 ⇒ **零图元**。
//
// 引擎自己留了强制重建的入口：`world.invalidate({ workBuffer: true })` 会把
// `_workBufferRebuildRequired` 置真（:84770-84772），下一帧 `bake()` 就会走
// `rebuildWorkBuffer(..., forceFullRebuild = true, ...)`。
//
// 本探针：开 unified → 记录"修前"的 renderCounter / numSplatsBuffer / 截图 →
// 调 `world.invalidate({workBuffer:true})` → 渲染几帧 → 再记录同样三项。
//
// usage: node _tmp/probe-unified-fix-upload.cjs [model]
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..', '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const { decodePng } = require(path.join(REPO, 'docs', 'verify', 'lib', 'png.cjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL = process.argv[2] || 'test-model.ply';

const mean = (f) => {
    const P = decodePng(fs.readFileSync(f));
    let r = 0;
    let g = 0;
    let b = 0;
    let lit = 0;
    const n = P.width * P.height;
    for (let i = 0; i < P.data.length; i += P.channels) {
        r += P.data[i];
        g += P.data[i + 1];
        b += P.data[i + 2];
        if (0.299 * P.data[i] + 0.587 * P.data[i + 1] + 0.114 * P.data[i + 2] > 60) lit++;
    }
    return { meanRGB: [+(r / n).toFixed(2), +(g / n).toFixed(2), +(b / n).toFixed(2)], litPct: +((lit / n) * 100).toFixed(2) };
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
        window.__SR_UP2__ = { writeTexture: 0, copyBufferToTexture: 0, sizes: [] };
        const hook = () => {
            const Q = globalThis.GPUQueue;
            if (!Q || !Q.prototype || Q.prototype.__srUp2) return false;
            Q.prototype.__srUp2 = true;
            const w = Q.prototype.writeTexture;
            Q.prototype.writeTexture = function (dst, data, layout, size) {
                try {
                    const t = dst && dst.texture;
                    window.__SR_UP2__.writeTexture++;
                    window.__SR_UP2__.sizes.push(`${t ? `${t.width}x${t.height}` : '?'}`);
                } catch (e) { /* ignore */ }
                return w.call(this, dst, data, layout, size);
            };
            const c = Q.prototype.copyBufferToTexture;
            Q.prototype.copyBufferToTexture = function (src, dst, size) {
                try {
                    const t = dst && dst.texture;
                    window.__SR_UP2__.copyBufferToTexture++;
                    window.__SR_UP2__.sizes.push(`cbt:${t ? `${t.width}x${t.height}` : '?'}`);
                } catch (e) { /* ignore */ }
                return c.call(this, src, dst, size);
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

    const frames = (n) => page.evaluate(async (k) => {
        for (let i = 0; i < k; i++) {
            window.scene.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
        }
    }, n);
    const shot = async (name) => {
        const f = path.join(REPO, '_tmp', `fx-${name}.png`);
        fs.writeFileSync(f, Buffer.from(await page.screenshot({ encoding: 'base64' }), 'base64'));
        return f;
    };
    const metrics = () => page.evaluate(async () => {
        const scene = window.scene;
        const dev = scene.app.graphicsDevice;
        const out = {};
        let r = null;
        let mgr = null;
        scene?.app?.renderer?.gsplatDirector?.camerasMap?.forEach((cd) => {
            cd?.layersMap?.forEach((ld) => {
                if (ld?.gsplatManager?.renderer) { mgr = ld.gsplatManager; r = ld.gsplatManager.renderer; }
            });
        });
        if (!r) return { error: 'no renderer' };
        const readU32 = async (sb) => {
            const g = sb && sb.impl && sb.impl.buffer;
            if (!g) return null;
            const bytes = Math.min(4, g.size);
            const st = dev.wgpu.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
            const enc = dev.wgpu.createCommandEncoder();
            enc.copyBufferToBuffer(g, 0, st, 0, bytes);
            dev.wgpu.queue.submit([enc.finish()]);
            await st.mapAsync(GPUMapMode.READ);
            const v = Array.from(new Uint32Array(st.getMappedRange().slice(0, bytes)))[0];
            st.unmap();
            st.destroy();
            return v;
        };
        out.renderCounter = await readU32(r.projector.renderCounter);
        const ic = r.intervalCompaction;
        out.numSplats = await readU32(ic.numSplatsBuffer);
        out.sortElementCount = await readU32(ic.sortElementCountBuffer);
        const st = mgr && mgr.world ? mgr.world.currentState : null;
        out.state = st ? { sortedBefore: st.sortedBefore, fullRebuild: st.fullRebuild, needsUpload: st.needsUpload ? st.needsUpload.length : null } : null;
        out.rebuildRequired = mgr && mgr.world ? mgr.world._workBufferRebuildRequired : null;
        out.copyUploaded = mgr && mgr.world ? mgr.world.bufferCopyUploaded : null;
        out.copyTotal = mgr && mgr.world ? mgr.world.bufferCopyTotal : null;
        out.uploads = JSON.parse(JSON.stringify(window.__SR_UP2__));
        return out;
    });

    const cpu = await shot('cpu');

    await page.evaluate(async () => {
        const scene = window.scene;
        window.__SR_UP2__ = { writeTexture: 0, copyBufferToTexture: 0, sizes: [] };
        window.__SPLATROOM_UNIFIED__ = true;
        const el = (scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        el.entity.gsplat.unified = true;
        for (let i = 0; i < 60; i++) {
            scene.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
        }
    });
    await sleep(1500);
    const before = await metrics();
    const beforeShot = await shot('before');

    // ===== 修复尝试：强制引擎重建 work buffer =====
    const fix = await page.evaluate(() => {
        const scene = window.scene;
        let n = 0;
        scene?.app?.renderer?.gsplatDirector?.camerasMap?.forEach((cd) => {
            cd?.layersMap?.forEach((ld) => {
                const w = ld?.gsplatManager?.world;
                if (w && typeof w.invalidate === 'function') {
                    w.invalidate({ workBuffer: true });
                    n++;
                }
            });
        });
        window.__SR_UP2__ = { writeTexture: 0, copyBufferToTexture: 0, sizes: [] };
        return n;
    });
    await frames(6);
    await sleep(500);
    const after = await metrics();
    const afterShot = await shot('after');

    // 旋转对照（修好之后画面应当跟着相机变）
    await page.evaluate(async () => {
        const s = window.scene;
        s.camera.setAzimElev(s.camera.azim + 30, s.camera.elevation, 0);
        for (let i = 0; i < 4; i++) {
            s.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
        }
    });
    await sleep(400);
    const rotShot = await shot('after-rot');

    console.log(JSON.stringify({
        model: MODEL, fix,
        before: { rc: before.renderCounter, numSplats: before.numSplats, sort: before.sortElementCount, state: before.state, rebuildRequired: before.rebuildRequired, uploads: before.uploads },
        after: { rc: after.renderCounter, numSplats: after.numSplats, sort: after.sortElementCount, state: after.state, rebuildRequired: after.rebuildRequired, uploads: after.uploads },
        means: { cpu: mean(cpu), before: mean(beforeShot), after: mean(afterShot) },
        d: { afterVsBefore: diff(beforeShot, afterShot), afterVsCpu: diff(cpu, afterShot), rotControl: diff(afterShot, rotShot) },
        errs: errs.slice(0, 3)
    }, null, 1));

    console.log('\n=== 判定 ===');
    console.log(`  world.invalidate({workBuffer:true}) 调用 ${fix} 次`);
    console.log(`  修前：renderCounter=${before.renderCounter} numSplats=${before.numSplats} sortElementCount=${before.sortElementCount} rebuildRequired=${before.rebuildRequired} state=${JSON.stringify(before.state)}`);
    console.log(`        上传：${JSON.stringify(before.uploads)}`);
    console.log(`  修后：renderCounter=${after.renderCounter} numSplats=${after.numSplats} sortElementCount=${after.sortElementCount} rebuildRequired=${after.rebuildRequired} state=${JSON.stringify(after.state)}`);
    console.log(`        上传：${JSON.stringify(after.uploads)}`);
    console.log(`  画面：cpu=${JSON.stringify(mean(cpu))} 修前=${JSON.stringify(mean(beforeShot))} 修后=${JSON.stringify(mean(afterShot))}`);
    console.log(`  修后 vs 修前 ${JSON.stringify(diff(beforeShot, afterShot))}；修后 vs CPU ${JSON.stringify(diff(cpu, afterShot))}；转 30° ${JSON.stringify(diff(afterShot, rotShot))}`);

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
