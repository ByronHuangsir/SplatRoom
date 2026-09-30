// "大关键帧位置不在当前帧位置、跳出去很远"的复现/定位探针。
//
// 关键帧在视口里由 CameraPath3D 画成**屏幕空间方块**（KF_TARGET_PX = 12px，比控制点菱形 8px 大），
// 每次重建时它把世界坐标算成线段顶点塞进 `_cpMesh`。所以"标记位置不对"可能出在三个环节：
//   ① `el.kfMarkers[i]`（元素持有的世界坐标）与轨道在该帧的值不一致；
//   ② 上传到 `_cpMesh` 的**几何**与 `kfMarkers` 不一致（缓冲/顶点数/重建时序问题 ⇒ 会跳到别处）；
//   ③ 底部时间线面板的点位置（DOM left）与帧号不一致。
// 外加两个"看着像跳出去很远"的候选：cone（目标位置）与 sphere（焦距）是按 `sceneRadius` 缩放摆放的
// —— 模型 AABB 被噪声撑大时（用户真机扫描件实测 ×54）它们会离关键帧很远。
//
// 用法：node docs/probes/keyframe-marker.cjs "<url>" [model]
const path = require('path');
const REPO = path.join(__dirname, '..', '..');
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const { BROWSER_PATH: EDGE , launchPatched: _launchPatched } = require('../verify/lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = await _launchPatched(puppeteer, {
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 3600000
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });

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

    const out = await page.evaluate(async () => {
        const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
        const scene = window.scene;
        const events = scene.events;
        const cam = scene.camera;
        const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const render = async (k = 2) => {
            for (let i = 0; i < k; i++) {
                scene.forceRender = true;
                await nextFrame();
            }
        };

        // 打开时间线面板 + 显示相机姿态（CameraPath3D 的可见条件）
        events.fire('statusBar.panel', 'timeline');
        events.fire('camera.showPoses', true);
        await render(3);

        const pathEl = scene.getElementsByType('debug').find(e => Array.isArray(e && e.kfMarkers));
        if (!pathEl) {
            return { fatal: 'CameraPath3D element not found' };
        }

        const totalFrames = events.invoke('timeline.frames');
        const splat = scene.getElementsByType('splat').slice(-1)[0];
        const bounds = splat?.localBound ?? splat?.worldBound;
        const diag = {
            totalFrames,
            pathVisible: pathEl.isVisible(),
            sceneRadius: +cam.sceneRadius.toFixed(3),
            modelHalfExtents: bounds ? [+bounds.halfExtents.x.toFixed(2), +bounds.halfExtents.y.toFixed(2), +bounds.halfExtents.z.toFixed(2)] : null,
            coneVisualDist: bounds ? +(cam.sceneRadius * 0.3).toFixed(3) : null,
            sphereDist: bounds ? +(cam.sceneRadius * 0.18).toFixed(3) : null
        };

        // ---- 造 5 个姿态差别很大的关键帧 ----
        const kfFrames = [];
        const step = Math.max(1, Math.floor((totalFrames - 1) / 6));
        for (let i = 1; i <= 5; i++) {
            kfFrames.push(Math.min(totalFrames - 2, i * step));
        }
        for (const f of kfFrames) {
            cam.setAzimElev(-180 + f * 2.4, -12 + (f % 7) * 3, 0);
            cam.setDistance(0.8 + (f % 5) * 0.25, 0);
            await render(2);
            events.fire('track.addKey', { frame: f });
            await sleep2(120);
        }
        await render(3);

        // ---- 检查工具 ----
        const track = events.invoke('animation.controller')?.getTrack?.('camera');
        const trackPosAt = (f) => {
            const v = track?.getValueAt?.(f);
            return v && v.length >= 6 ? [v[0], v[1], v[2]] : null;
        };
        const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

        const meshPositions = () => {
            const holder = [];
            pathEl._cpMesh.getPositions(holder);
            return holder[0];
        };

        const checkMarkers = (label) => {
            const pos = meshPositions();
            const rows = [];
            for (let i = 0; i < pathEl.kfMarkers.length; i++) {
                const frame = pathEl.kfMarkerFrames[i];
                const markerWorld = pathEl.kfMarkers[i];
                const expected = trackPosAt(frame);
                const info = pathEl.kfMarkerIndices[i];
                let geomCenter = null;
                if (pos && info && info.vertexStart >= 0 && info.vertexCount > 0) {
                    let mnx = Infinity, mny = Infinity, mnz = Infinity;
                    let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
                    for (let v = info.vertexStart; v < info.vertexStart + info.vertexCount; v++) {
                        const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
                        mnx = Math.min(mnx, x); mxx = Math.max(mxx, x);
                        mny = Math.min(mny, y); mxy = Math.max(mxy, y);
                        mnz = Math.min(mnz, z); mxz = Math.max(mxz, z);
                    }
                    geomCenter = [(mnx + mxx) / 2, (mny + mxy) / 2, (mnz + mxz) / 2];
                }
                rows.push({
                    i,
                    frame,
                    marker: [+markerWorld.x.toFixed(3), +markerWorld.y.toFixed(3), +markerWorld.z.toFixed(3)],
                    expected: expected ? expected.map(n => +n.toFixed(3)) : null,
                    markerVsTrack: expected ? +d3([markerWorld.x, markerWorld.y, markerWorld.z], expected).toFixed(4) : null,
                    geomVsMarker: geomCenter ? +d3(geomCenter, [markerWorld.x, markerWorld.y, markerWorld.z]).toFixed(4) : null,
                    vertexCount: info ? info.vertexCount : null,
                    coneDistFromKf: pathEl.kfConePositions[i] ? +pathEl.kfConePositions[i].distance(markerWorld).toFixed(3) : null
                });
            }
            return { label, count: pathEl.kfMarkers.length, frames: pathEl.kfMarkerFrames.slice(), rows };
        };

        const steps = [];
        steps.push(checkMarkers('after creating 5 keyframes'));

        // ---- 时间线面板的点位置 vs 帧号 ----
        const dotCheck = () => {
            const dots = Array.from(document.querySelectorAll('[data-sub-track]'));
            const timeline = dots[0]?.parentElement;
            const tlw = timeline ? timeline.getBoundingClientRect().width : 0;
            const rows = dots.slice(0, 20).map((d) => {
                const frameAttr = d.getAttribute('title') ?? '';
                const m = /Frame (\d+)/.exec(frameAttr);
                const frame = m ? parseInt(m[1], 10) : null;
                const left = parseFloat(d.style.left || 'NaN');
                const expectedLeft = frame === null || !tlw ? null : (frame / Math.max(1, totalFrames - 1)) * tlw;
                return { frame, left: +left.toFixed(1), expectedLeft: expectedLeft === null ? null : +expectedLeft.toFixed(1) };
            });
            return { dots: dots.length, tlw: +tlw.toFixed(1), rows };
        };
        const dotsBefore = dotCheck();

        // ---- 逐帧擦洗 + 检查 ----
        // 两个都要查：
        //   ① 标记的世界坐标 vs 轨道值（上一段已查过 = 0）
        //   ② **擦洗到该关键帧时，相机真的在那个关键帧的位置上吗** —— "跳到很远"最经典的来源是
        //      三次样条过冲（animation-track-base.ts 里就有"极端位置的三关键帧 Catmull-Rom 会过冲"的注释）
        const camVsTrack = [];
        for (const f of kfFrames) {
            events.fire('timeline.setFrame', f);
            await render(3);
            const camPos = cam.mainCamera.getPosition();
            const expected = trackPosAt(f);
            camVsTrack.push({
                frame: f,
                camera: [+camPos.x.toFixed(3), +camPos.y.toFixed(3), +camPos.z.toFixed(3)],
                track: expected ? expected.map(n => +n.toFixed(3)) : null,
                deviation: expected ? +d3([camPos.x, camPos.y, camPos.z], expected).toFixed(4) : null
            });
            steps.push(checkMarkers(`at keyframe frame ${f}`));
        }

        // ---- 插一个关键帧到已有两个之间（索引会重排！）----
        const insertFrame = Math.round((kfFrames[1] + kfFrames[2]) / 2);
        events.fire('timeline.setFrame', insertFrame);
        await render(2);
        cam.setAzimElev(40, 25, 0);
        cam.setDistance(2.2, 0);
        await render(2);
        events.fire('track.addKey', { frame: insertFrame });
        await sleep2(200);
        await render(3);
        steps.push(checkMarkers(`after inserting a keyframe at ${insertFrame} (index shift)`));

        // ---- 模拟拖拽反馈（moveKeyframeMarker）----
        const dragIdx = Math.min(2, pathEl.kfMarkers.length - 1);
        const before = [pathEl.kfMarkers[dragIdx].x, pathEl.kfMarkers[dragIdx].y, pathEl.kfMarkers[dragIdx].z];
        const V = pathEl.kfMarkers[dragIdx].constructor;
        const target = new V(before[0] + 1.5, before[1] + 0.75, before[2] - 1.25);
        pathEl.moveKeyframeMarker(dragIdx, target);
        await render(3);
        const carried = checkMarkers(`after moveKeyframeMarker(${dragIdx})`);

        // ---- 相机移动（80ms 节流路径）----
        for (let k = 0; k < 12; k++) {
            cam.setAzimElev(cam.azim + 4, cam.elevation, 0);
            await render(1);
        }
        await render(4);
        const afterCameraMove = checkMarkers('after camera moved (throttled rebuild path)');

        const dotsAfter = dotCheck();

        // ---- 相机视图模式：擦洗时间轴时，视口相机是否真的落在关键帧上 ----
        // 这是"关键帧位置不在当前帧位置、跳出去很远"最可能的机制：视口只在该模式下跟随动画相机
        // （camera.ts:876），而动画姿态来自样条求值 —— 样条不过关键帧、或 _fixCameraPosition 的
        // 距离钳制在关键帧处生效，都会让相机离开关键帧。
        events.fire('camera.toggleViewMode');
        await render(3);
        const viewMode = cam.cameraViewMode;

        const sweep = [];
        for (let f = 0; f < totalFrames; f += 2) {
            events.fire('timeline.setFrame', f);
            await render(1);
            const p = cam.mainCamera.getPosition();
            const v = trackPosAt(f);
            if (v) {
                sweep.push({ f, dev: +d3([p.x, p.y, p.z], v).toFixed(4) });
            }
        }
        const devs = sweep.map(s => s.dev).sort((a, b) => a - b);
        const worst = sweep.reduce((a, b) => (b.dev > a.dev ? b : a), sweep[0]);

        const atKeyframes = [];
        for (const f of kfFrames) {
            events.fire('timeline.setFrame', f);
            await render(2);
            const p = cam.mainCamera.getPosition();
            const v = trackPosAt(f);
            const kf = (track.keyframes ?? []).find(k => k.frame === f);
            atKeyframes.push({
                frame: f,
                viewportVsSpline: v ? +d3([p.x, p.y, p.z], v).toFixed(4) : null,
                splineVsKeyframe: (v && kf) ? +d3(v, [kf.value[0], kf.value[1], kf.value[2]]).toFixed(4) : null,
                viewportVsKeyframe: kf ? +d3([p.x, p.y, p.z], [kf.value[0], kf.value[1], kf.value[2]]).toFixed(4) : null
            });
        }
        events.fire('camera.toggleViewMode');
        await render(2);
        const sweepSummary = {
            viewMode,
            samples: sweep.length,
            medianDev: devs.length ? +devs[Math.floor(devs.length / 2)].toFixed(4) : null,
            p95Dev: devs.length ? +devs[Math.floor(devs.length * 0.95)].toFixed(4) : null,
            maxDev: devs.length ? +devs[devs.length - 1].toFixed(4) : null,
            maxDevFrame: worst ? worst.f : null,
            sceneRadius: +cam.sceneRadius.toFixed(3),
            maxDevInSceneRadius: devs.length && cam.sceneRadius ? +(devs[devs.length - 1] / cam.sceneRadius).toFixed(3) : null,
            top5: sweep.slice().sort((a, b) => b.dev - a.dev).slice(0, 5)
        };

        // ---- 样条精度：擦洗到关键帧时，相机/标记为什么不在关键帧的精确位置上 ----
        // 相机（onEvaluate）与标记（getValueAt）**都**走 `evaluateBySegmentArcLength`（弧长重参数化），
        // 所以两者一致（实测 viewportVsSpline = 0），但它在关键帧帧号上的取值与关键帧自身值不一定相等
        // （实测差 0.012~0.048）。这里把"均匀参数化 spline.evaluate"与"弧长参数化"分开量，
        // 定位偏差来自哪儿；并用**不均匀间距 + 大跨距**的压力布局看能放大到多少。
        const splineAccuracy = () => {
            const sp = track.spline;
            if (!sp) {
                return { fatal: 'no spline' };
            }
            // 关键：把"钳制前"的弧长求值也算出来 —— `getValueAt` 里带了 _fixCameraPosition，
            // 而它会把位置沿视线方向推到 [minSafe, maxSafe] 之内 ⇒ 关键帧处也可能被推到很远。
            const clampInfo = (() => {
                const uk = (track.keyframes ?? []).filter(kk => !kk.isControlPoint);
                if (!uk.length) {
                    return null;
                }
                let mn = Infinity;
                let mx = -Infinity;
                for (const k of uk) {
                    const d = Math.hypot(k.value[3] - k.value[0], k.value[4] - k.value[1], k.value[5] - k.value[2]);
                    mn = Math.min(mn, d);
                    mx = Math.max(mx, d);
                }
                return { minKeyDist: +mn.toFixed(3), maxKeyDist: +mx.toFixed(3), minSafe: +(mn * 0.25).toFixed(3), maxSafe: +Math.max(mx * 3, mn * 5).toFixed(3) };
            })();

            const rawArc = (frame) => {
                const out = [];
                const { times } = sp;
                const n = times.length;
                let seg = 0;
                while (seg < n - 2 && frame >= times[seg + 1]) seg++;
                const segStart = times[seg];
                const segEnd = times[seg + 1];
                const segRange = segEnd - segStart;
                if (segRange > 1e-6) {
                    const localF = (frame - segStart) / segRange;
                    sp.evaluateBySegmentArcLength(seg, Math.max(0, Math.min(1, localF)), out);
                } else {
                    sp.evaluate(frame, out);
                }
                return out;
            };

            const rows = [];
            for (const k of (track.keyframes ?? []).filter(kk => !kk.isControlPoint)) {
                const f = k.frame;
                let uniform = [];
                try {
                    sp.evaluate(f, uniform);
                } catch (e) {
                    uniform = [];
                }
                const arc = track.getValueAt(f) ?? [];
                const raw = rawArc(f);
                const rawDist = raw.length >= 6 ?
                    Math.hypot(raw[3] - raw[0], raw[4] - raw[1], raw[5] - raw[2]) : null;
                const clampFired = (clampInfo && rawDist !== null) ?
                    (rawDist < clampInfo.minSafe || rawDist > clampInfo.maxSafe) : null;
                rows.push({
                    frame: f,
                    knotPos: [k.value[0], k.value[1], k.value[2]].map(n => +n.toFixed(4)),
                    uniformPos: uniform.length >= 3 ? [uniform[0], uniform[1], uniform[2]].map(n => +n.toFixed(4)) : null,
                    rawArcPos: raw.length >= 3 ? [raw[0], raw[1], raw[2]].map(n => +n.toFixed(4)) : null,
                    arcPos: arc.length >= 3 ? [arc[0], arc[1], arc[2]].map(n => +n.toFixed(4)) : null,
                    devUniformPos: uniform.length >= 3 ? +d3(uniform, k.value).toFixed(4) : null,
                    devRawArcPos: raw.length >= 3 ? +d3(raw, k.value).toFixed(4) : null,
                    devArcPos: arc.length >= 3 ? +d3(arc, k.value).toFixed(4) : null,
                    rawDist: rawDist === null ? null : +rawDist.toFixed(4),
                    clampFired,
                    clampDelta: (raw.length >= 3 && arc.length >= 3) ? +d3(raw, arc).toFixed(4) : null
                });
            }
            return {
                splineTimes: sp.times.slice(),
                keyframes: (track.keyframes ?? []).map(k => ({ frame: k.frame, isCp: !!k.isControlPoint })),
                clampRanges: clampInfo,
                rows
            };
        };

        const uniformLayout = splineAccuracy();

        // ---- 压力布局：不均匀间距 + 大跨距（长段 + 短段相邻）----
        for (const f of [...kfFrames, insertFrame]) {
            events.fire('track.removeKey', f);
            await sleep2(60);
        }
        await render(2);
        const stressFrames = [0, 4, 118, 122, 176];
        const stressPoses = [];
        for (let i = 0; i < stressFrames.length; i++) {
            cam.setAzimElev(i * 85, -20 + i * 12, 0);
            cam.setDistance(0.7 + i * 0.9, 0);
            await render(2);
            events.fire('track.addKey', { frame: stressFrames[i] });
            await sleep2(100);
            const p = cam.mainCamera.getPosition();
            stressPoses.push([+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)]);
        }
        await render(3);
        const stressLayout = splineAccuracy();

        // 压力布局下：擦洗到关键帧时相机离该关键帧多远
        const stressViewport = [];
        for (const f of stressFrames) {
            events.fire('timeline.setFrame', f);
            await render(2);
            const p = cam.mainCamera.getPosition();
            const kf = (track.keyframes ?? []).find(k => k.frame === f);
            stressViewport.push({
                frame: f,
                viewportVsKeyframe: kf ? +d3([p.x, p.y, p.z], [kf.value[0], kf.value[1], kf.value[2]]).toFixed(4) : null,
                inSceneRadius: (kf && cam.sceneRadius) ? +(d3([p.x, p.y, p.z], [kf.value[0], kf.value[1], kf.value[2]]) / cam.sceneRadius).toFixed(3) : null
            });
        }
        const stressSampled = { poses: stressPoses, sceneRadius: +cam.sceneRadius.toFixed(3) };

        return {
            diag,
            kfFrames,
            camVsTrack,
            sweepSummary,
            atKeyframes,
            uniformLayout,
            stressLayout,
            stressViewport,
            stressSampled,
            steps,
            dragStep: { dragIdx, movedTo: [+target.x.toFixed(3), +target.y.toFixed(3), +target.z.toFixed(3)], carriedRows: carried.rows },
            afterCameraMove,
            dots: { before: dotsBefore, after: dotsAfter }
        };
    });

    console.log(JSON.stringify({ model: MODEL, url: URL, ...out, errors: errs.slice(0, 6) }, null, 1));
    await browser.close();
    process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ fatal: String(e).slice(0, 400) })); process.exit(1); });
