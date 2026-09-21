// 像素级复现："大关键帧（白色方块标记）画在了不该在的地方"。
//
// 数据链路已验证干净（`docs/probes/keyframe-marker.cjs`：`kfMarkers[i]` 与轨道值逐帧一致，
// 插入关键帧后索引重排也对）。所以问题若存在，只能在**几何/上传/绘制**这一层 —— 于是这里直接看像素：
//
//   1. 把高斯点隐藏（`splat.visible = false`），只留相机路径图层 ⇒ 画面里只有路径/标记各种颜色；
//   2. 按颜色分类像素：白色 = 关键帧方块（KF_TARGET_PX=12，最大）、青色 = 控制点菱形（8px）、
//      橙色 = 位置路径 / 橙色锥体、紫色 = 目标路径、蓝色 = 焦距球；
//   3. 用相机自带的 view/projection 把每个关键帧的**世界坐标投影到屏幕**，作为"应该在哪"；
//   4. 检查：每个期望位置附近必须有白像素（漏画），且**所有**白像素必须落在某个期望位置附近
//      （多画/画错地方）—— 后者就是"跳到很远"的签名，报告离群白像素的质心与最近期望点的距离。
//
// 用法：node docs/probes/keyframe-marker-pixels.cjs "<url>" [model]
const path = require('path');
const REPO = path.join(__dirname, '..', '..');
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 3600000
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1500);

    await page.evaluate(async (m) => {
        const buf = await (await fetch('./' + m)).arrayBuffer();
        window.scene.events.invoke('import', [{ filename: m, contents: new File([buf], m) }]).catch(() => {});
    }, MODEL);
    for (let i = 0; i < 60; i++) {
        await sleep(1000);
        if (await page.evaluate(() => window.scene.getElementsByType('splat').length) > 0) break;
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

        // 只留路径层：隐藏高斯点，避免模型自带的亮像素干扰颜色分类
        const splat = scene.getElementsByType('splat').slice(-1)[0];
        splat.visible = false;

        events.fire('statusBar.panel', 'timeline');
        events.fire('camera.showPoses', true);
        await render(4);

        const pathEl = scene.getElementsByType('debug').find(e => Array.isArray(e && e.kfMarkers));
        if (!pathEl) {
            return { fatal: 'CameraPath3D element not found' };
        }

        const totalFrames = events.invoke('timeline.frames');

        // ---- 屏幕投影（用引擎相机自己的矩阵）----
        const project = (x, y, z) => {
            const camComp = cam.mainCamera.camera;
            const view = camComp.viewMatrix.data;
            const proj = camComp.projectionMatrix.data;
            const vx = view[0] * x + view[4] * y + view[8] * z + view[12];
            const vy = view[1] * x + view[5] * y + view[9] * z + view[13];
            const vz = view[2] * x + view[6] * y + view[10] * z + view[14];
            const vw = view[3] * x + view[7] * y + view[11] * z + view[15];
            const cx = proj[0] * vx + proj[4] * vy + proj[8] * vz + proj[12] * vw;
            const cy = proj[1] * vx + proj[5] * vy + proj[9] * vz + proj[13] * vw;
            const cw = proj[3] * vx + proj[7] * vy + proj[11] * vz + proj[15] * vw;
            if (!(cw > 0.0001)) {
                return null;
            }
            const canvas = scene.canvas;
            return [
                (cx / cw * 0.5 + 0.5) * canvas.width,
                (1 - (cy / cw * 0.5 + 0.5)) * canvas.height
            ];
        };

        const grab = async () => {
            await render(2);
            const src = scene.canvas;
            const off = document.createElement('canvas');
            off.width = src.width;
            off.height = src.height;
            const ctx = off.getContext('2d');
            ctx.drawImage(src, 0, 0);
            return ctx.getImageData(0, 0, off.width, off.height);
        };

        // ---- 造 4 个姿态差别很大的关键帧 ----
        const kfFrames = [];
        const step = Math.max(1, Math.floor((totalFrames - 1) / 5));
        for (let i = 1; i <= 4; i++) {
            kfFrames.push(Math.min(totalFrames - 2, i * step));
        }
        for (const f of kfFrames) {
            cam.setAzimElev(-180 + f * 3.1, -10 + (f % 5) * 4, 0);
            cam.setDistance(0.9 + (f % 4) * 0.3, 0);
            await render(2);
            events.fire('track.addKey', { frame: f });
            await sleep2(120);
        }
        // 相机放到"能同时看到大多数关键帧"的位置：回到第一个关键帧
        events.fire('timeline.setFrame', kfFrames[0]);
        await render(4);
        // 之后再稍微拉开距离，避免标记挤在一起
        cam.setDistance(2.2, 0);
        await render(4);

        const classify = (img) => {
            const white = [];
            const cyan = [];
            const amber = [];
            const blue = [];
            const orange = [];
            const d = img.data;
            for (let i = 0; i < d.length; i += 4) {
                const r = d[i], g = d[i + 1], b = d[i + 2];
                if (r < 40 && g < 40 && b < 40) {
                    continue;
                }
                const px = (i / 4) % img.width;
                const py = Math.floor((i / 4) / img.width);
                if (r > 248 && g > 248 && b > 248) {
                    white.push([px, py]);
                } else if (r < 90 && g > 160 && b > 225) {
                    cyan.push([px, py]);
                } else if (r > 200 && g > 120 && g < 215 && b < 110) {
                    amber.push([px, py]);
                } else if (r < 140 && g > 120 && g < 190 && b > 235) {
                    blue.push([px, py]);
                } else if (r > 225 && g > 100 && g < 175 && b < 60) {
                    orange.push([px, py]);
                }
            }
            return { white, cyan, amber, blue, orange };
        };

        const centroid = (pts) => {
            if (!pts.length) return null;
            let sx = 0, sy = 0;
            for (const p of pts) { sx += p[0]; sy += p[1]; }
            return [sx / pts.length, sy / pts.length];
        };

        const evaluate = async (label) => {
            const img = await grab();
            const cls = classify(img);
            // 颜色直方图（量化到 32 级）—— 用来判断"这堆白像素到底是什么"
            const hist = new Map();
            for (let i = 0; i < img.data.length; i += 4) {
                const r = img.data[i] & 0xe0, g = img.data[i + 1] & 0xe0, b = img.data[i + 2] & 0xe0;
                if (r === 0 && g === 0 && b === 0) {
                    continue;
                }
                const key = `${r},${g},${b}`;
                hist.set(key, (hist.get(key) ?? 0) + 1);
            }
            const topColors = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
                .map(([k, v]) => ({ rgb: k, count: v }));

            // 归属：`onPreRender` 每帧都会重设三个实体的 enabled ⇒ 直接改 enabled 没用（会被立刻覆盖），
            // 必须让 `isVisible()` 返回 false 才真的关掉路径层。
            const whiteWith = async () => (classify(await grab())).white.length;
            const markerWhite = cls.white.length;
            const origVisible = pathEl.isVisible;
            pathEl.isVisible = () => false;
            const withoutAll = await whiteWith();
            pathEl.isVisible = origVisible;
            await render(3);

            const expected = pathEl.kfMarkers.map((m, i) => ({
                i,
                frame: pathEl.kfMarkerFrames[i],
                world: [+m.x.toFixed(3), +m.y.toFixed(3), +m.z.toFixed(3)],
                screen: project(m.x, m.y, m.z)
            }));

            const R = 18;
            const near = (pt, list) => list.some(e => e.screen && Math.hypot(pt[0] - e.screen[0], pt[1] - e.screen[1]) <= R);
            const onScreen = expected.filter(e => e.screen && e.screen[0] > -50 && e.screen[1] > -50 &&
                e.screen[0] < img.width + 50 && e.screen[1] < img.height + 50);

            // ① 每个期望位置附近有多少白像素（漏画检测）
            const perMarker = expected.map((e) => {
                const count = e.screen ? cls.white.filter(p => Math.hypot(p[0] - e.screen[0], p[1] - e.screen[1]) <= R).length : null;
                return {
                    i: e.i,
                    frame: e.frame,
                    screen: e.screen ? [+e.screen[0].toFixed(1), +e.screen[1].toFixed(1)] : null,
                    whitePixelsNearby: count
                };
            });

            // ② 离群白像素（多画/画错地方）
            const outliers = cls.white.filter(p => !near(p, expected));

            // ③ 离群白像素离最近的"别的关键帧"有多远（区分"画到了另一个关键帧"和"画到荒野"）
            let outlierNearestExpected = null;
            if (outliers.length && expected.length) {
                let best = Infinity;
                for (const p of outliers) {
                    for (const e of expected) {
                        if (!e.screen) continue;
                        best = Math.min(best, Math.hypot(p[0] - e.screen[0], p[1] - e.screen[1]));
                    }
                }
                outlierNearestExpected = +best.toFixed(1);
            }

            return {
                label,
                canvas: `${img.width}x${img.height}`,
                topColors,
                whiteAttribution: {
                    all: markerWhite,
                    pathLayerOff: withoutAll,
                    pathLayerOnly: markerWhite - withoutAll
                },
                markers: perMarker,
                onScreenMarkers: onScreen.length,
                whiteTotal: cls.white.length,
                whiteOutliers: outliers.length,
                whiteOutlierCentroid: centroid(outliers) ? centroid(outliers).map(v => +v.toFixed(1)) : null,
                whiteOutlierNearestExpectedPx: outlierNearestExpected,
                cyanTotal: cls.cyan.length,
                amberTotal: cls.amber.length,
                blueTotal: cls.blue.length,
                orangeTotal: cls.orange.length,
                camera: {
                    azim: +cam.azim.toFixed(2),
                    elevation: +cam.elevation.toFixed(2),
                    distance: +cam.distance.toFixed(3),
                    sceneRadius: +cam.sceneRadius.toFixed(3),
                    coneDistFromKf: pathEl.kfConePositions.length ? +pathEl.kfConePositions[0].distance(pathEl.kfMarkers[0]).toFixed(3) : null
                }
            };
        };

        const results = [];
        results.push(await evaluate('pose A (frame of kf0, pulled back)'));

        // 换几个机位重复（"有时候"要多次采样）
        for (let k = 0; k < 3; k++) {
            cam.setAzimElev(cam.azim + 70, -8 + k * 9, 0);
            await render(4);
            results.push(await evaluate(`pose B${k} (camera orbited)`));
        }

        // 回到某个关键帧再测一次（用户报的场景：当前帧就是关键帧）
        events.fire('timeline.setFrame', kfFrames[1]);
        await render(4);
        results.push(await evaluate(`at keyframe frame ${kfFrames[1]}`));

        // 插一个关键帧（索引重排）后再测
        const insertFrame = Math.round((kfFrames[1] + kfFrames[2]) / 2);
        events.fire('timeline.setFrame', insertFrame);
        await render(2);
        cam.setAzimElev(35, 20, 0);
        cam.setDistance(2.5, 0);
        await render(2);
        events.fire('track.addKey', { frame: insertFrame });
        await sleep2(200);
        await render(4);
        results.push(await evaluate(`after inserting keyframe ${insertFrame}`));

        splat.visible = true;
        return {
            totalFrames,
            kfFrames: [...kfFrames, insertFrame].sort((a, b) => a - b),
            kfMarkersNow: pathEl.kfMarkerFrames.slice(),
            results
        };
    });

    console.log(JSON.stringify({ model: MODEL, url: URL, ...out, errors: errs.slice(0, 6) }, null, 1));
    await browser.close();
    process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ fatal: String(e).slice(0, 400) })); process.exit(1); });
