// 交互期降级时"选区虚影"的像素级复现/回归检查。
//
// 用户报告：使用选择工具时，选区在移动/旋转视角时会在右上方形成一个虚影。
// 根因（2026-09-21 定位并修复）：体积形状（BoxShape / SphereShape）的片元着色器用
// `clip = gl_FragCoord / targetSize` 反推世界射线来做体积内部着色，而 `targetSize` 这个 uniform
// 原来一直填的是**画布**尺寸（`device.width/height`）。没有缩放渲染目标时两者相等，所以一直没暴露；
// 交互期降级把主 render target 缩到 `camera.targetSizeOverride` 之后，射线就是按错误的像素位置
// 还原的 —— 方块/球体的网格与棱线被画成一份错位的重影。
//
// 本探针在**同一个相机位姿**下拍两张：全分辨率 vs 降级（moving 触发的真实降级路径），
// 分成 16×16 的瓦片比较平均色差，并与"没有选区形状"时的对照相减：
//   有形状时的最差瓦片色差 与 对照的最差瓦片色差 之差，就是虚影的强度。
// 修复后两者应当基本一致（差异只来自分辨率下降本身）。
//
// 用法：node docs/probes/shape-ghost.cjs "<url>" [model]
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
        const importFile = async (name) => {
            const res = await fetch('./' + name);
            const blob = await res.blob();
            window.scene.events.invoke('import', [{ filename: name, contents: new File([blob], name) }]).catch(() => {});
        };
        await importFile(m);
    }, MODEL);
    for (let i = 0; i < 60; i++) {
        await sleep(1000);
        if (await page.evaluate(() => window.scene.getElementsByType('splat').length) > 0) break;
    }
    await sleep(3000);

    const out = await page.evaluate(async () => {
        const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
        const scene = window.scene;
        const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const render = async (n = 3) => {
            for (let i = 0; i < n; i++) {
                scene.forceRender = true;
                await nextFrame();
            }
        };

        // 画布像素抓取（intrinsic 尺寸 = 设备像素）
        const grab = () => {
            const src = scene.canvas;
            const off = document.createElement('canvas');
            off.width = src.width;
            off.height = src.height;
            const ctx = off.getContext('2d');
            ctx.drawImage(src, 0, 0);
            return ctx.getImageData(0, 0, off.width, off.height);
        };

        // 16×16 瓦片平均 |ΔRGB|；返回最差瓦片与超过阈值的瓦片数
        const tileDiff = (a, b) => {
            const T = 16;
            const tw = Math.floor(a.width / T);
            const th = Math.floor(a.height / T);
            const tiles = [];
            for (let ty = 0; ty < T; ty++) {
                for (let tx = 0; tx < T; tx++) {
                    let sum = 0;
                    let n = 0;
                    for (let y = ty * th; y < (ty + 1) * th; y += 2) {
                        for (let x = tx * tw; x < (tx + 1) * tw; x += 2) {
                            const i = (y * a.width + x) * 4;
                            sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
                            n += 3;
                        }
                    }
                    tiles.push({ tx, ty, mean: sum / n });
                }
            }
            tiles.sort((p, q) => q.mean - p.mean);
            const all = tiles.reduce((acc, t) => acc + t.mean, 0) / tiles.length;
            return {
                worst: +tiles[0].mean.toFixed(2),
                worstTile: [tiles[0].tx, tiles[0].ty],
                top4: tiles.slice(0, 4).map(t => `${t.tx},${t.ty}=${t.mean.toFixed(1)}`),
                mean: +all.toFixed(2),
                over8: tiles.filter(t => t.mean > 8).length
            };
        };

        scene.events.fire('camera.focus');
        await sleep2(2500);

        const cam = scene.camera;
        const size = { w: scene.app.graphicsDevice.width, h: scene.app.graphicsDevice.height };

        // 同一相机位姿下：静止（全分辨率）与"移动中"（降级）各抓一张。
        // 移动用一个"出去再回来"的小幅摆动制造：最后一位姿与静止时完全相同，
        // 但最后一次位姿变化距抓图 < settleMs(200ms) ⇒ cameraMotion.moving = true。
        const pair = async (label) => {
            scene.motionQuality.forceEngaged = true;
            // 静止：等降级完全恢复
            await sleep2(700);
            const az0 = cam.azim;
            const el0 = cam.elevation;
            cam.setAzimElev(az0, el0, 0);
            await render(4);
            const full = grab();
            const fullInfo = {
                renderScale: scene.motionQuality.renderScale,
                moving: scene.cameraMotion.moving,
                target: [scene.camera.mainTarget.width, scene.camera.mainTarget.height]
            };

            // 移动：小幅摆动后回到原位姿
            for (let i = 0; i < 3; i++) {
                cam.setAzimElev(az0 + 0.05, el0, 0);
                await render(1);
            }
            cam.setAzimElev(az0, el0, 0);
            scene.forceRender = true;
            await nextFrame();
            const half = grab();
            const halfInfo = {
                renderScale: scene.motionQuality.renderScale,
                moving: scene.cameraMotion.moving,
                target: [scene.camera.mainTarget.width, scene.camera.mainTarget.height],
                azimDelta: +(cam.azim - az0).toFixed(4)
            };
            scene.motionQuality.forceEngaged = null;
            await sleep2(600);
            return { label, fullInfo, halfInfo, diff: tileDiff(full, half) };
        };

        const results = {};

        // 1) 没有选区形状（对照：只有分辨率下降带来的差异）
        scene.events.fire('tool.deactivate');
        await sleep2(800);
        results.control = await pair('control');

        // 2) 方块选区工具（BoxShape）
        scene.events.fire('tool.boxSelection');
        await sleep2(1500);
        results.box = await pair('box');
        scene.events.fire('tool.deactivate');
        await sleep2(600);

        // 3) 球形选区工具（SphereShape）
        scene.events.fire('tool.sphereSelection');
        await sleep2(1500);
        results.sphere = await pair('sphere');
        scene.events.fire('tool.deactivate');

        return {
            device: size,
            results,
            boxOverControlWorst: +(results.box.diff.worst - results.control.diff.worst).toFixed(2),
            sphereOverControlWorst: +(results.sphere.diff.worst - results.control.diff.worst).toFixed(2)
        };
    });

    console.log(JSON.stringify({ model: MODEL, ...out, errors: errs.slice(0, 5) }, null, 1));
    await browser.close();
    process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ fatal: String(e).slice(0, 400) })); process.exit(1); });
