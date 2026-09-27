// 归档自 _tmp（2026-09-26），REPO 路径已按 docs/probes/ 调整。
// 探针 67：unified 的裁剪盒为什么会多切？先核对"app 相机的矩阵"与"引擎投影器用的矩阵"是不是同一套。
//
// 背景：unified 通路里 `proj`（顶点拿到的 clip 位置）是**引擎投影器**用**引擎那个相机**算出来的；
// 而我们在 scene.ts 里算 `clipToBoxLocal` 用的是 `scene.camera.camera` 的矩阵。
// 探针 60 已经证明：引擎 `camerasMap` 的 key 与 `scene.camera.camera` **不是同一个对象**
// —— 如果它们的矩阵也不同，那我的盒局部坐标从一开始就是错的（表现为"多切"）。
//
// usage: node _tmp/probe-crop-matrix.cjs
const path = require('path');
const REPO = path.join(__dirname, '..', '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    cleanupOrphanBrowsers();
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 900000
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 620 });
    page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)));
    await page.goto('http://localhost:3100/?gpu=webgpu&unified=1', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1200);
    await page.evaluate(async () => {
        const res = await fetch('./test-model.ply');
        const blob = await res.blob();
        await window.scene.events.invoke('import', [{ filename: 'test-model.ply', contents: new File([blob], 'test-model.ply') }]);
    });
    for (let i = 0; i < 80; i++) {
        await sleep(500);
        if (await page.evaluate(() => (window.scene.elements || []).some((e) => e.entity && e.entity.gsplat))) break;
    }
    await page.evaluate(() => {
        const scene = window.scene;
        const el = (scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        scene.events.fire('selection', el);
        scene.events.fire('camera.focus');
    });
    await sleep(2500);

    const out = await page.evaluate(() => {
        const scene = window.scene;
        const app = scene.app;
        const layer = scene.splatLayer;
        const director = app.renderer.gsplatDirector;
        let engineCam = null;
        director.camerasMap.forEach((d, c) => { if (d?.layersMap?.get(layer)?.gsplatManager) engineCam = c; });
        const appCam = scene.camera.camera;
        const same = engineCam === appCam;
        const arr = (m) => (m && m.data ? Array.from(m.data) : null);
        const diff = (a, b) => (a && b ? a.reduce((acc, v, i) => Math.max(acc, Math.abs(v - b[i])), 0) : null);
        const aView = arr(appCam?.viewMatrix);
        const eView = arr(engineCam?.viewMatrix);
        const aProj = arr(appCam?.projectionMatrix);
        const eProj = arr(engineCam?.projectionMatrix);
        // 裁剪盒的 API 探测（顺便：探针 66 里 getState 返回 null）
        scene.events.fire('cropBox.initialize');
        const cb = scene.events.invoke('cropBox');
        return {
            sameCameraObject: same,
            engineCamName: engineCam?.node?.name ?? engineCam?.entity?.name ?? '(unknown)',
            appCamName: appCam?.node?.name ?? '(unknown)',
            viewMatrixMaxDelta: diff(aView, eView),
            projMatrixMaxDelta: diff(aProj, eProj),
            appView0: aView ? aView.slice(0, 4).map(v => +v.toFixed(3)) : null,
            engineView0: eView ? eView.slice(0, 4).map(v => +v.toFixed(3)) : null,
            appProj0: aProj ? aProj.slice(0, 4).map(v => +v.toFixed(3)) : null,
            engineProj0: eProj ? eProj.slice(0, 4).map(v => +v.toFixed(3)) : null,
            cropBoxApi: cb ? {
                hasGetState: typeof cb.getState === 'function',
                hasToConfig: typeof cb.toConfig === 'function',
                hasSetState: typeof cb.setState === 'function',
                config: typeof cb.toConfig === 'function' ? cb.toConfig() : null
            } : null
        };
    });

    console.log(JSON.stringify(out, null, 1));
    console.log('\n=== 判定 ===');
    console.log(`  引擎相机与 app 相机是同一个对象：${out.sameCameraObject}`);
    console.log(`  viewMatrix 最大差：${out.viewMatrixMaxDelta}；projectionMatrix 最大差：${out.projMatrixMaxDelta}`);
    if (out.viewMatrixMaxDelta > 1e-4 || out.projMatrixMaxDelta > 1e-4) {
        console.log('  ⇒ **两套矩阵不同** ⇒ 我用 app 相机算的 clipToBoxLocal 与顶点拿到的 proj 不匹配 —— 这就是多切的原因');
    } else {
        console.log('  ⇒ 矩阵一致，多切要从别处找（例如盒的局部坐标口径）');
    }
    console.log(`  裁剪盒 API：getState=${out.cropBoxApi?.hasGetState} setState=${out.cropBoxApi?.hasSetState} toConfig=${out.cropBoxApi?.hasToConfig}`);

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
