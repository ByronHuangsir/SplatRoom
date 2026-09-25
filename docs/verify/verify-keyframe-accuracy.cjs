// 关键帧"位置不对、跳出去很远"的两条根因护栏（2026-09-21）。
//
// 用户报："webgpu 模式下，时间线大关键帧有时候会出现关键帧位置不在当前帧位置，跳出去很远"。
// 实测（`docs/probes/keyframe-marker.cjs`）两条**与后端无关**的真 bug：
//
//  ① **弧长分段记账错一格**（`src/anim/spline.ts`）：`_segmentStartArcs[seg]` 记的是"上一段倒数第二个
//     采样点"的弧长 ⇒ `localFraction = 0` 求值出的是**关键帧之前 1% 段长**的位置、`= 1` 也停在下一
//     关键帧前 1%。相机与关键帧标记（都走这条求值）因此**永远落不到关键帧上**，段越长偏得越多
//     （压力夹具实测：关键帧 118 前一段 114 帧 → 偏 0.0904；176 → 0.0656，正好是各段弧长的 1%）。
//  ② **删掉最后一个关键帧后残留幽灵标记**（`src/camera/camera-path-3d.ts`）：`rebuildMesh()` 的
//     早退分支只把路径网格 count 置 0，没清 `kfMarkers` 等数组 ⇒ 画面里多出一个停在旧位置的关键帧方块
//     （实测：轨道 0 个关键帧，元素仍留 1 个标记 / 108 个顶点）。
//
// 本套件断言：关键帧帧号处的求值**逐位等于**关键帧自身值（含不均匀间距、插入后、含隐藏控制点、
// 含 `_fixCameraPosition` 的距离钳制路径），且删光关键帧后标记数据与标记网格都归零。
//
// usage: node docs/verify/verify-keyframe-accuracy.cjs "<url>" [model]
const path = require('path');
const puppeteer = require(path.join(__dirname, '..', '..', 'node_modules', 'puppeteer-core'));

const { BROWSER_PATH: EDGE } = require('./lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
    });
    const errors = [];
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 200)));

    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1500);

    await page.evaluate(async (m) => {
        const buf = await (await fetch('./' + m)).arrayBuffer();
        window.__loadErr = null;
        window.scene.events.invoke('import', [{ filename: m, contents: new File([buf], m) }])
            .catch((e) => { window.__loadErr = String(e).slice(0, 200); });
    }, MODEL);
    for (let i = 0; i < 60; i++) {
        await sleep(1000);
        const st = await page.evaluate(() => ({
            n: window.scene.getElementsByType('splat').length,
            err: window.__loadErr
        }));
        if (st.n > 0) break;
        if (st.err) throw new Error(st.err);
    }
    await sleep(2500);

    const checks = [];
    const check = (name, pass, detail) => checks.push({ name, pass, detail });

    try {
        const setup = await page.evaluate(async () => {
            const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
            const scene = window.scene;
            const events = scene.events;
            const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
            window.__render = async (k = 2) => {
                for (let i = 0; i < k; i++) {
                    scene.forceRender = true;
                    await nextFrame();
                }
            };
            events.fire('statusBar.panel', 'timeline');
            events.fire('camera.showPoses', true);
            await window.__render(3);
            window.__pathEl = scene.getElementsByType('debug').find(e => Array.isArray(e && e.kfMarkers));
            window.__track = events.invoke('animation.controller')?.getTrack?.('camera');
            window.__totalFrames = events.invoke('timeline.frames');
            // 逐关键帧量：求值 vs 关键帧自身值（位置与 target 都要）
            window.__measure = (label) => {
                const track = window.__track;
                const rows = [];
                for (const k of (track.keyframes ?? []).filter(kk => !kk.isControlPoint)) {
                    const v = track.getValueAt(k.frame);
                    const dev = v ? Math.hypot(v[0] - k.value[0], v[1] - k.value[1], v[2] - k.value[2]) : null;
                    const devT = v ? Math.hypot(v[3] - k.value[3], v[4] - k.value[4], v[5] - k.value[5]) : null;
                    rows.push({ frame: k.frame, devPos: dev, devTarget: devT });
                }
                const worst = rows.reduce((a, b) => (b.devPos > a.devPos ? b : a), { devPos: -1 });
                const worstT = rows.reduce((a, b) => (b.devTarget > a.devTarget ? b : a), { devTarget: -1 });
                return {
                    label,
                    keys: (track.keyframes ?? []).length,
                    worstDevPos: worst.devPos === null ? null : +worst.devPos.toExponential(2),
                    worstDevPosFrame: worst.frame,
                    worstDevTarget: worstT.devTarget === null ? null : +worstT.devTarget.toExponential(2),
                    rows: rows.length
                };
            };
            // 造关键帧：frames 与姿态都可控
            window.__makeKeys = async (frames, spanStep) => {
                for (const f of frames) {
                    scene.camera.setAzimElev(-180 + f * 3.1, -12 + (f % 6) * 5, 0);
                    scene.camera.setDistance(0.7 + (f % 5) * (spanStep ?? 0.5), 0);
                    await window.__render(2);
                    events.fire('track.addKey', { frame: f });
                    await sleep2(120);
                }
                await window.__render(3);
            };
            window.__removeKeys = async (frames) => {
                for (const f of frames) {
                    events.fire('track.removeKey', f);
                    await sleep2(80);
                }
                await window.__render(3);
            };
            return {
                hasView: !!window.__pathEl,
                totalFrames: window.__totalFrames,
                cameraViewModeSupported: !!scene.camera
            };
        });

        check('probe hooks are available (timeline + CameraPath3D element)',
            setup.hasView === true, `pathEl=${setup.hasView} totalFrames=${setup.totalFrames}`);

        // ---- ① 均匀间距：关键帧处求值必须逐位等于关键帧值 ----
        const uniform = await page.evaluate(async () => {
            const step = Math.max(1, Math.floor((window.__totalFrames - 1) / 6));
            const frames = [1, 2, 3, 4, 5].map(i => Math.min(window.__totalFrames - 2, i * step));
            await window.__makeKeys(frames);
            return { frames, m: window.__measure('uniform') };
        });
        check('uniform spacing: evaluation at a keyframe equals the keyframe exactly',
            uniform.m.worstDevPos !== null && uniform.m.worstDevPos < 1e-9 && uniform.m.worstDevTarget < 1e-9,
            `frames=[${uniform.frames.join(',')}] worstPosDev=${uniform.m.worstDevPos} worstTargetDev=${uniform.m.worstDevTarget}`);

        // ---- ② 压力布局：不均匀间距 + 大跨距（长段是"跳出去很远"的放大镜）----
        const stress = await page.evaluate(async () => {
            await window.__removeKeys([...window.__track.keyframes].map(k => k.frame));
            const n = window.__totalFrames;
            const frames = [0, 4, n - 62, n - 58, n - 4];
            await window.__makeKeys(frames, 0.9);
            return { frames, m: window.__measure('stress') };
        });
        check('uneven spacing with long segments: evaluation at a keyframe still exact',
            stress.m.worstDevPos !== null && stress.m.worstDevPos < 1e-9 && stress.m.worstDevTarget < 1e-9,
            `frames=[${stress.frames.join(',')}] worstPosDev=${stress.m.worstDevPos} worstTargetDev=${stress.m.worstDevTarget} ` +
            `(before the fix this was up to ~0.09 world units = 8% of sceneRadius)`);

        // ---- ③ 插入隐藏控制点（真实编辑会产生）后仍然精确 ----
        const withCp = await page.evaluate(async () => {
            const track = window.__track;
            const kfs = track.keyframes.slice().sort((a, b) => a.frame - b.frame);
            const a = kfs[1];
            const b = kfs[2];
            const mid = Math.round((a.frame + b.frame) / 2);
            const v = track.getValueAt(mid) ?? a.value;
            track.keyframes.push({
                frame: mid,
                value: [v[0] + 0.3, v[1] + 0.2, v[2] - 0.25, v[3], v[4], v[5], v[6]],
                easingIn: 'linear',
                easingOut: 'linear',
                easingInTension: 1,
                easingOutTension: 1,
                isControlPoint: true
            });
            track.rebuild?.(true);
            window.scene.events.fire('track.keyUpdated');
            await window.__render(3);
            return { mid, m: window.__measure('with control point') };
        });
        check('with a hidden control point inserted: user keyframes still evaluate exactly',
            withCp.m.worstDevPos !== null && withCp.m.worstDevPos < 1e-9,
            `control point at frame ${withCp.mid}; worstPosDev=${withCp.m.worstDevPos}`);

        // ---- ④ 视口相机（相机视图模式）落在关键帧上 ----
        const viewport = await page.evaluate(async () => {
            const scene = window.scene;
            const track = window.__track;
            if (!scene.camera.cameraViewMode) {
                scene.events.fire('camera.toggleViewMode');
            }
            await window.__render(3);
            const rows = [];
            for (const k of track.keyframes.filter(kk => !kk.isControlPoint)) {
                scene.events.fire('timeline.setFrame', k.frame);
                await window.__render(2);
                const p = scene.camera.mainCamera.getPosition();
                rows.push({
                    frame: k.frame,
                    dev: Math.hypot(p.x - k.value[0], p.y - k.value[1], p.z - k.value[2])
                });
            }
            const worst = rows.reduce((a, b) => (b.dev > a.dev ? b : a), rows[0]);
            const result = {
                viewMode: scene.camera.cameraViewMode,
                worstDev: +worst.dev.toExponential(2),
                worstFrame: worst.frame,
                sceneRadius: +scene.camera.sceneRadius.toFixed(3)
            };
            scene.events.fire('camera.toggleViewMode');
            await window.__render(2);
            return result;
        });
        check('camera view mode: scrubbing to a keyframe puts the viewport camera on it',
            viewport.viewMode === true && viewport.worstDev < 1e-6,
            `viewMode=${viewport.viewMode} worstDev=${viewport.worstDev} at frame ${viewport.worstFrame} ` +
            `(sceneRadius=${viewport.sceneRadius})`);

        // ---- ⑤ 删光关键帧：不得残留幽灵标记 ----
        const cleared = await page.evaluate(async () => {
            const track = window.__track;
            const frames = track.keyframes.map(k => k.frame);
            await window.__removeKeys(frames);
            const el = window.__pathEl;
            return {
                keysLeft: (track.keyframes ?? []).length,
                markerCount: el.kfMarkers.length,
                markerFrames: el.kfMarkerFrames.slice(),
                controlPoints: el.controlPoints.length,
                coneCount: el.kfConePositions.length,
                meshVerts: el._cpMesh.primitive[0].count,
                pathVerts: el.mesh.primitive[0].count
            };
        });
        check('deleting every keyframe leaves no ghost marker (data + marker mesh are cleared)',
            cleared.keysLeft === 0 && cleared.markerCount === 0 && cleared.meshVerts === 0 &&
            cleared.controlPoints === 0 && cleared.coneCount === 0 && cleared.pathVerts === 0,
            `keys=${cleared.keysLeft} markers=${cleared.markerCount} (frames=[${cleared.markerFrames.join(',')}]) ` +
            `controlPoints=${cleared.controlPoints} cones=${cleared.coneCount} markerMeshVerts=${cleared.meshVerts} ` +
            `pathMeshVerts=${cleared.pathVerts} — before the fix: markers=1 / verts=108`);

        // ---- ⑥ 删光后再加关键帧：路径与标记要回来（不能修成"删了就永久空"）----
        const revived = await page.evaluate(async () => {
            const frames = [10, 40, 90];
            await window.__makeKeys(frames);
            const el = window.__pathEl;
            return {
                markers: el.kfMarkers.length,
                markerFrames: el.kfMarkerFrames.slice(),
                meshVerts: el._cpMesh.primitive[0].count,
                m: window.__measure('revived')
            };
        });
        check('after the clear, new keyframes rebuild markers and stay exact',
            revived.markers === 3 && revived.markerFrames.join(',') === '10,40,90' &&
            revived.meshVerts > 0 && revived.m.worstDevPos < 1e-9,
            `markers=${revived.markers} frames=[${revived.markerFrames.join(',')}] verts=${revived.meshVerts} ` +
            `worstDev=${revived.m.worstDevPos}`);
    } catch (e) {
        check('suite ran without throwing', false, String(e).slice(0, 200));
    }

    console.log(JSON.stringify({ checks, failed: checks.filter((c) => !c.pass).length, errors: errors.slice(0, 5) }, null, 1));
    await browser.close();
    process.exit(0);
})().catch((e) => {
    console.log(JSON.stringify({ fatal: String(e).slice(0, 400) }));
    process.exit(1);
});
