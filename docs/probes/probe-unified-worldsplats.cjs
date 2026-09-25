// 归档自 _tmp（2026-09-25 unified 通路排查那一轮），REPO 路径已按 docs/probes/ 调整。
// 探针 14：**区间表为什么是全 0** —— 直接看 `worldState.splats`。
//
// 线索（probe-unified-invalidate.cjs）：强制 `invalidateUpload()` 之后 `intervalsBuffer` **仍然是全 0**，
// 也就是"重传了，但传上去的就是 0"。引擎的构造器是：
//
//   function buildGSplatIntervalData(worldState) {
//       const data = new Uint32Array(numIntervals * 4);       // 全 0
//       for (let s = 0; s < worldState.splats.length; s++) { ...写入... }
//       return data;                                          // splats 为空 ⇒ 原样返回全 0
//   }
//
// ⇒ 如果 `worldState.splats.length === 0`（而 totalActiveSplats 另有来源），区间表就是全 0，
//   整条链必然归零。本探针读这一层，并试着用引擎自己的入口把它修好（reconcile / invalidate）。
//
// usage: node _tmp/probe-unified-worldsplats.cjs [model]
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
    const n = P.width * P.height;
    for (let i = 0; i < P.data.length; i += P.channels) {
        r += P.data[i];
        g += P.data[i + 1];
        b += P.data[i + 2];
    }
    return [+(r / n).toFixed(2), +(g / n).toFixed(2), +(b / n).toFixed(2)];
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
        const f = path.join(REPO, '_tmp', `ws-${name}.png`);
        fs.writeFileSync(f, Buffer.from(await page.screenshot({ encoding: 'base64' }), 'base64'));
        return f;
    };

    const readWorld = () => page.evaluate(() => {
        const scene = window.scene;
        const out = { managers: [], layers: [] };
        const layersObj = scene.app.scene.layers;
        const list = layersObj.layerList ?? layersObj._layers ?? [];
        for (const l of list) {
            if (!/splat/i.test(l.name ?? '')) continue;
            out.layers.push({
                name: l.name,
                hasPlacements: !!l.gsplatPlacements,
                placements: Array.isArray(l.gsplatPlacements) ? l.gsplatPlacements.length : null,
                meshInstances: (l.meshInstances ?? []).length
            });
        }
        scene?.app?.renderer?.gsplatDirector?.camerasMap?.forEach((cd) => {
            cd?.layersMap?.forEach((ld) => {
                const mgr = ld?.gsplatManager;
                if (!mgr) return;
                const w = mgr.world;
                const st = w && w.currentState;
                const splats = st ? st.splats : null;
                out.managers.push({
                    worldVersion: w ? w.currentVersion : null,
                    worldStates: w ? w._worldStates.size : null,
                    stateFound: !!st,
                    stateVersion: st ? st.version : null,
                    totalActiveSplats: st ? st.totalActiveSplats : null,
                    totalIntervals: st ? st.totalIntervals : null,
                    splatsLen: splats ? splats.length : null,
                    firstSplat: splats && splats.length
                        ? {
                            activeSplats: splats[0].activeSplats,
                            boundsBaseIndex: splats[0].boundsBaseIndex,
                            intervalsLen: splats[0].intervals ? splats[0].intervals.length : null,
                            intervalOffsets: splats[0].intervalOffsets ? Array.from(splats[0].intervalOffsets).slice(0, 4) : null,
                            intervalNodeIndices: splats[0].intervalNodeIndices ? splats[0].intervalNodeIndices.length : null,
                            resourceNumSplats: splats[0].resource && splats[0].resource.gsplatData ? splats[0].resource.gsplatData.numSplats : null
                        }
                        : null,
                    stateKeys: st ? Object.keys(st).slice(0, 30) : null
                });
            });
        });
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

    const before = await readWorld();
    const shotBefore = await shot('unified-before');

    // 试着用引擎自己的入口修：reconcile(placements) + world.invalidate({worldState:true})
    const tried = await page.evaluate(async () => {
        const scene = window.scene;
        const log = [];
        const layersObj = scene.app.scene.layers;
        const list = layersObj.layerList ?? layersObj._layers ?? [];
        scene?.app?.renderer?.gsplatDirector?.camerasMap?.forEach((cd) => {
            cd?.layersMap?.forEach((ld) => {
                const mgr = ld && ld.gsplatManager;
                if (!mgr) return;
                try {
                    if (typeof mgr.reconcile === 'function') {
                        const splatLayer = list.find((l) => /splat/i.test(l.name ?? ''));
                        const placements = (splatLayer && splatLayer.gsplatPlacements) || [];
                        mgr.reconcile(placements);
                        log.push(`reconcile(${placements.length})`);
                    } else log.push('no reconcile');
                } catch (e) { log.push('reconcile threw: ' + String(e).slice(0, 100)); }
                try {
                    mgr.world.invalidate({ worldState: true, workBuffer: false });
                    log.push('world.invalidate({worldState:true})');
                } catch (e) { log.push('invalidate threw: ' + String(e).slice(0, 100)); }
                try {
                    mgr.renderer.intervalCompaction.invalidateUpload();
                    log.push('invalidateUpload()');
                } catch (e) { log.push('invalidateUpload threw: ' + String(e).slice(0, 100)); }
            });
        });
        for (let i = 0; i < 4; i++) {
            scene.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
        }
        return log;
    });
    await sleep(600);

    const after = await readWorld();
    const shotAfter = await shot('unified-after');

    console.log(JSON.stringify({ model: MODEL, tried, before, after, means: { cpu: mean(cpu), before: mean(shotBefore), after: mean(shotAfter) }, errs: errs.slice(0, 3) }, null, 1));
    console.log('\n=== 判定 ===');
    console.log(`  试着修：${JSON.stringify(tried)}`);
    for (const m of before.managers) console.log(`  修前 manager：${JSON.stringify(m)}`);
    for (const m of after.managers) console.log(`  修后 manager：${JSON.stringify(m)}`);
    console.log(`  layer：${JSON.stringify(before.layers)}`);
    console.log(`  画面均值：cpu=${JSON.stringify(mean(cpu))} 修前=${JSON.stringify(mean(shotBefore))} 修后=${JSON.stringify(mean(shotAfter))}`);

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
