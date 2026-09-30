// 回归护栏：**合并（组）渲染**那条件排序兜底必须真的在派发。
//
// 背景（2026-09-23 修掉的真 bug）：`Scene.onPreRenderInner` 里给合并实体做排序兜底时，
// 原来判的是 `ws._sortInFlight` / 写 `ws._pendingCamera` —— 这两个字段在 playcanvas 2.21.3 里
// **根本不存在**，而 `s _sortInFlight = true` 之后再没有任何代码会清它 ⇒ 第一次派发之后
// **每帧都只记录、不发送**，合并实体的顺序永久冻结在第一次的位姿上（"近小远大"）。
// 主通路 `src/splat/splat.ts` 早就改成自己的合并器（完成事件清零 + 3 s 超时），这条漏了。
//
// 断言：
//   1. 组建立成功、合并实体存在（否则本套件没有测试对象，必须报"没测到"而不是假绿）
//   2. 相机持续转动时，合并实体的 sorter **被派发多次**（旧实现只有 1 次）
//   3. 每次派发都带 `forceUpdate: true`（worker 自己那 1e-3 门限不接受没有它的相机）
//   4. 停手后不再持续派发（按需渲染 + 合并器不会自激）
//
// usage: node docs/verify/verify-group-sort-dispatch.cjs "<url>" [model]
const path = require('path');
const puppeteer = require(path.join(__dirname, '..', '..', 'node_modules', 'puppeteer-core'));

const { BROWSER_PATH: EDGE , launchPatched: _launchPatched } = require('./lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3100/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-layered.ply';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, pass, detail) => {
    results.push({ name, pass, detail });
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

(async () => {
    const browser = await _launchPatched(puppeteer, {
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
    });
    const errors = [];
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1500);

    // import the same file twice -> two splat elements -> a group is possible
    const pump = setInterval(() => { page.evaluate(() => 1).catch(() => {}); }, 3000);
    const importOnce = async (name) => {
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
        }, name);
        for (let i = 0; i < 60; i++) {
            await sleep(1200);
            if (await page.evaluate(() => window.scene.getElementsByType('splat').length) > 0) return;
        }
    };
    await importOnce(MODEL);
    await importOnce(MODEL);
    clearInterval(pump);
    await sleep(2500);

    // group everything that exists
    const setup = await page.evaluate(async () => {
        const scene = window.scene;
        const splats = scene.getElementsByType('splat');
        scene.events.fire('selection.set', splats[0]);
        await new Promise((r) => setTimeout(r, 300));
        for (const s of splats.slice(1)) {
            scene.events.fire('selection.add', s);
            await new Promise((r) => setTimeout(r, 300));
        }
        scene.events.fire('scene.group.toggle');
        // give the group renderer a few frames to build the merged entity
        for (let i = 0; i < 30; i++) {
            scene.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
        }
        scene.events.fire('camera.focus');
        await new Promise((r) => setTimeout(r, 800));
        const merged = scene.groupRenderer.mergedEntity;
        return {
            splatCount: splats.length,
            isActive: scene.groupRenderer.isActive,
            hasMergedEntity: !!merged,
            hasSorter: !!merged?.gsplat?.instance?.sorter,
            hasWorker: !!merged?.gsplat?.instance?.sorter?.worker
        };
    });
    check('组建立成功且合并实体存在', setup.isActive && setup.hasMergedEntity && setup.hasSorter && setup.hasWorker,
        JSON.stringify(setup));
    if (!(setup.isActive && setup.hasMergedEntity && setup.hasSorter && setup.hasWorker)) {
        console.log('\n没测到测试对象（组/合并实体/sorter/worker 缺一）——不计为通过。');
        await browser.close();
        process.exit(1);
    }

    // rotate and count the merged sorter's worker dispatches
    const rotated = await page.evaluate(async () => {
        const scene = window.scene;
        const sorter = scene.groupRenderer.mergedEntity.gsplat.instance.sorter;
        const sent = [];
        const orig = sorter.worker.postMessage.bind(sorter.worker);
        sorter.worker.postMessage = function (msg, ...rest) {
            // 只数**我们**那条强制派发（带 forceUpdate）—— 引擎自己的 sorter.setCamera
            // 也会发同一形状的相机消息，混在一起就分不清是谁发的了
            if (msg && msg.forceUpdate === true) {
                sent.push({ forceUpdate: true });
            }
            return orig(msg, ...rest);
        };

        let updatedEvents = 0;
        const onUpdated = () => { updatedEvents++; };
        sorter.on('updated', onUpdated);

        const cam = scene.camera;
        cam.userDragging = true;
        let azim = 30;
        const timer = setInterval(() => {
            azim += 4;
            cam.setAzimElev(azim, -15, 0);
            scene.app.renderNextFrame = true;
        }, 16);
        await new Promise((r) => setTimeout(r, 3000));
        clearInterval(timer);

        const duringRotation = sent.length;
        const allForceUpdate = sent.every((s) => s.forceUpdate);
        const afterRotationStart = sent.length;
        cam.userDragging = false;
        await new Promise((r) => setTimeout(r, 1500));
        sorter.off('updated', onUpdated);
        sorter.worker.postMessage = orig;
        return { duringRotation, allForceUpdate, idleDispatches: sent.length - afterRotationStart, updatedEvents };
    });

    check('相机转动时合并实体排序被派发多次（旧实现只有 1 次）',
        rotated.duringRotation > 1, `3 s 内派发 ${rotated.duringRotation} 次`);
    check('每次派发都带 forceUpdate: true', rotated.allForceUpdate);
    check('停手后不再持续派发', rotated.idleDispatches <= 2, `停手 1.5 s 内 ${rotated.idleDispatches} 次`);
    check('排序回包（updated 事件）真的到达', rotated.updatedEvents > 0, `${rotated.updatedEvents} 次`);
    check('无控制台错误', errors.length === 0, errors.slice(0, 3).join(' | '));

    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} 通过`);
    await browser.close();
    process.exit(failed.length ? 1 : 0);
})().catch((e) => {
    console.error('SUITE FAILED:', e);
    process.exit(1);
});
