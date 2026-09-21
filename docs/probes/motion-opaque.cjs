// 运动期"不依赖顺序"的渲染（A 方案）实测：docs/... §6.13 / src/core/motion-opaque.ts
//
// 三件事，按重要性排：
//
//  ① **顺序无关性（决定性判据）**：同一个相机位姿下，把 order buffer 换成"最坏顺序"（恒等顺序，
//     对合成夹具等于随机），比较画面差异。
//       alpha 混合路径：差很多（这就是用户看到的"背面跑到前面"）
//       不透明+深度路径：应当≈0（谁可见由深度测试决定，与绘制顺序无关）
//     两边的对比就是这条路的全部价值。
//
//  ② **观感代价**：运动期不透明画面 vs 停手后 alpha 混合画面（同一位姿）的平均色差 + 亮像素覆盖率，
//     并扫 alpha 下限（0.37 / 0.5 / 0.65 / 0.8）挑默认值。
//
//  ③ **帧代价/收益**：连续旋转 4 s，模式开/关各一轮 —— 帧分布、运动期派发次数、
//     运动期过主线程的 order 字节数（不透明路径应当把这两个都变成 0）。
//
// 用法：node docs/probes/motion-opaque.cjs "<url>" [model] [seconds]
const path = require('path');
const REPO = path.join(__dirname, '..', '..');
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-20m-fill.ply';
const SECONDS = parseFloat(process.argv[4] || '4');
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
        const head = await fetch('./' + m, { headers: { Range: 'bytes=0-0' } });
        const total = parseInt(head.headers.get('content-range').split('/')[1], 10);
        const CHUNK = 256 * 1048576;
        const parts = [];
        for (let off = 0; off < total; off += CHUNK) {
            const end = Math.min(off + CHUNK - 1, total - 1);
            parts.push(await (await fetch('./' + m, { headers: { Range: `bytes=${off}-${end}` } })).blob());
        }
        window.scene.events.invoke('import', [{ filename: m, contents: new File(parts, m) }]).catch(() => {});
    }, MODEL);

    for (let i = 0; i < 120; i++) {
        await sleep(5000);
        if (await page.evaluate(() => window.scene.getElementsByType('splat').length) > 0) break;
    }
    await sleep(8000);

    const out = await page.evaluate(async ([seconds]) => {
        const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
        const scene = window.scene;
        const splat = scene.getElementsByType('splat').slice(-1)[0];
        scene.events.fire('selection', splat);
        await sleep2(500);
        scene.events.fire('camera.focus');
        await sleep2(5000);

        const inst = splat.entity.gsplat.instance;
        const ws = inst.sorter;
        // 排序目标的取法按可靠性排序：sorter 自己在 init() 里存过一份（ws.target 最稳），
        // 其次是实例上的 orderBuffer/orderTexture（不同引擎版本命名可能不同）。
        const target = ws.target ?? ws.orderBuffer ?? ws.orderTexture ?? inst.orderBuffer ?? inst.orderTexture;
        if (!target) {
            return { fatalProbe: 'no order target found', wsKeys: Object.keys(ws), instKeys: Object.keys(inst) };
        }
        const numSplats = (splat.splatData && splat.splatData.numSplats) || (ws.orderData.byteLength / 4);

        // 恒等顺序；**真正的乱序**（确定性 Fisher-Yates）；全零顺序作为"order 真的被读"的对照。
        // ⚠️ 恒等顺序在分层夹具上其实≈正确顺序（同一块板的高斯下标连续，生成时先写远板），
        // 拿它当"最坏顺序"会测出 0.03 这种空结论 —— 必须用乱序。
        const identity = new Uint32Array(numSplats);
        for (let i = 0; i < numSplats; i++) {
            identity[i] = i;
        }
        const scrambled = new Uint32Array(identity);
        let shuffleSeed = 987654321;
        for (let i = numSplats - 1; i > 0; i--) {
            shuffleSeed = (shuffleSeed * 1103515245 + 12345) & 0x7fffffff;
            const j = shuffleSeed % (i + 1);
            const t = scrambled[i];
            scrambled[i] = scrambled[j];
            scrambled[j] = t;
        }
        const zeros = new Uint32Array(numSplats);

        // ⚠️ 必须把引擎自己的消费路径停掉：只要有一次排序回包，`applyPendingSorted()` 就会把
        // **正确顺序**再写回去，把我上传的"最坏顺序"覆盖掉 —— 第一版就是这么测出
        // alphaOrderDiff ≈ 0.03 这个假结论的（看起来"顺序根本不影响画面"）。
        // 停掉之后（返回 -1，不动 instancingCount）order buffer 的内容就完全由本探针决定。
        const realApply = ws.applyPendingSorted.bind(ws);
        ws.applyPendingSorted = () => -1;

        const uploadOrder = (arr) => {
            ws.uploadStream.upload(arr, target);
        };

        // ⚠️ 上传有一帧滞后：`uploadStream.upload` 把 copy 记进"当前/下一帧"的 command encoder，
        // 只上传一次时抓到的可能是**上一次**的内容（第一版实测：每个变体的画面都落后一档，
        // 于是 alpha 路径读到 0.03 这种假结论）。修法：上传两次、中间各渲染几帧，
        // 再连续抓两张确认已收敛（两张相同才算数）。
        const setOrder = async (arr) => {
            uploadOrder(arr);
            await render(4);
            uploadOrder(arr);
            await render(6);
        };
        // 抓"已收敛"的一对：连续两张相同才算数（上传有一帧滞后）。
        // `keepMoving`：不透明路径要求 cameraMotion.moving 为真 —— 而 grab 本身要渲染好几帧，
        // 一次抖动只能撑 200 ms（settleMs）⇒ 每次抓图前都要重新抖一下，否则会读到"已经切回
        // alpha 混合"的画面（第一版就是这么出现 applied=false + stable=false 的失真行的）。
        const grabConverged = async (keepMoving) => {
            if (keepMoving) {
                await pose.jiggle();
            }
            const a = await grab();
            if (keepMoving) {
                await pose.jiggle();
            }
            const b = await grab();
            return { img: b, stable: meanAbs(a, b) < 0.5, applied: splat.motionOpaque, blend: inst.material.blendType };
        };

        const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const render = async (n) => {
            for (let i = 0; i < n; i++) {
                scene.forceRender = true;
                await nextFrame();
            }
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

        const meanAbs = (a, b) => {
            let sum = 0;
            let n = 0;
            for (let i = 0; i < a.data.length; i += 4 * 3) {       // 抽 1/3 像素
                sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
                n += 3;
            }
            return +(sum / n).toFixed(2);
        };
        const litPercent = (img) => {
            let lit = 0;
            let n = 0;
            for (let i = 0; i < img.data.length; i += 4 * 3) {
                if (Math.max(img.data[i], img.data[i + 1], img.data[i + 2]) > 60) lit++;
                n++;
            }
            return +((lit / n) * 100).toFixed(1);
        };

        const cam = scene.camera;

        // "运动中"但位姿与静止时**完全相同**：小幅摆出去再回原位姿，最后一次位姿变化距抓图 < 200 ms
        // ⇒ cameraMotion.moving = true（不透明路径生效）。见 docs/probes/shape-ghost.cjs 同一手法。
        const settleAtPose = async () => {
            await sleep2(600);
            const az0 = cam.azim;
            const el0 = cam.elevation;
            const jiggle = async () => {
                for (let i = 0; i < 3; i++) {
                    cam.setAzimElev(az0 + 0.05, el0, 0);
                    await render(1);
                }
                cam.setAzimElev(az0, el0, 0);
                await render(1);
            };
            return { az0, el0, jiggle };
        };

        // ---------- 参考：alpha 混合下的"正确画面" ----------
        const pose = await settleAtPose();
        // 先让停手补帧把顺序弄正确（补帧的消费在这里还没被停掉）
        await sleep2(900);
        const correctOrder = new Uint32Array(ws.orderData.slice(0));
        await setOrder(correctOrder);
        const c1 = await grabConverged();
        const alphaCorrect = c1.img;

        // ---------- ① alpha 混合 + 乱序 / 恒等 / 全零 ----------
        await setOrder(identity);
        const i1 = await grabConverged();
        const alphaIdentityDiff = meanAbs(alphaCorrect, i1.img);

        await setOrder(scrambled);
        const s1 = await grabConverged();
        const alphaOrderDiff = meanAbs(alphaCorrect, s1.img);

        await setOrder(zeros);
        const z1 = await grabConverged();
        const alphaZeroDiff = meanAbs(alphaCorrect, z1.img);

        // 恢复正确顺序，并确认可复现（上传路径确定性的自检）
        await setOrder(correctOrder);
        const c2 = await grabConverged();
        const alphaRepro = meanAbs(alphaCorrect, c2.img);

        // ---------- ② 运动期不透明：顺序无关性 + 观感代价 + 阈值扫描 ----------
        const thresholds = [0.37, 0.5, 0.65, 0.8];
        const opaque = [];
        for (const clip of thresholds) {
            window.__SPLATROOM_MOTION_ALPHA_CLIP__ = clip;
            // 正确顺序 + 不透明
            await setOrder(correctOrder);
            const oc = await grabConverged(true);
            const appliedWhenCorrect = {
                applied: oc.applied,
                blend: oc.blend,
                depthWrite: inst.material.depthWrite
            };
            // 乱序 + 不透明（决定性判据）
            await setOrder(scrambled);
            const os = await grabConverged(true);
            // 全零顺序 + 不透明（对照：证明 order 确实被着色器读取）
            await setOrder(zeros);
            const oz = await grabConverged(true);
            await setOrder(correctOrder);
            opaque.push({
                alphaClip: clip,
                applied: appliedWhenCorrect,
                orderDiff: meanAbs(oc.img, os.img),
                zeroDiff: meanAbs(oc.img, oz.img),
                vsSettledAlpha: meanAbs(alphaCorrect, oc.img),
                litPercent: litPercent(oc.img),
                settledLitPercent: litPercent(alphaCorrect),
                stable: oc.stable && os.stable && oz.stable,
                allOpaque: oc.applied && os.applied && oz.applied
            });
        }
        delete window.__SPLATROOM_MOTION_ALPHA_CLIP__;
        await setOrder(correctOrder);
        // 顺序测试结束：**恢复引擎的消费路径**再测运动期帧代价 —— 否则 OFF 相位也不会有
        // 80 MB 上传，等于把 alpha 路径的代价偷偷扣掉了（第一版就是这么测的）。
        ws.applyPendingSorted = realApply;
        await sleep2(400);

        // ---------- ③ 帧代价：连续旋转 4 s，模式关 / 开 ----------
        const counters = () => {
            const real = ws.worker.postMessage.bind(ws.worker);
            const st = { posts: 0, bytes: 0 };
            ws.worker.postMessage = (msg, ...rest) => {
                if (msg && msg.cameraDirection) st.posts++;
                return real(msg, ...rest);
            };
            const realUpload = ws.uploadStream.upload.bind(ws.uploadStream);
            ws.uploadStream.upload = (data, t, o, s) => {
                st.bytes += (data && data.byteLength) || 0;
                return realUpload(data, t, o, s);
            };
            return st;
        };

        const rotatePhase = async (opaqueOn) => {
            if (opaqueOn) {
                delete window.__SPLATROOM_MOTION_OPAQUE__;
            } else {
                window.__SPLATROOM_MOTION_OPAQUE__ = false;
            }
            scene.motionOpaque.enabled = opaqueOn;
            await sleep2(500);
            const st = counters();
            const deltas = [];
            let last = performance.now();
            let stop = false;
            const loop = () => {
                const now = performance.now();
                deltas.push(now - last);
                last = now;
                scene.forceRender = true;
                if (!stop) requestAnimationFrame(loop);
            };
            requestAnimationFrame(loop);
            const t0 = performance.now();
            while (performance.now() - t0 < seconds * 1000) {
                cam.setAzimElev(cam.azim + 6, cam.elevation, 0);
                await sleep2(16);
            }
            stop = true;
            await sleep2(300);
            deltas.shift();
            const sorted = deltas.slice().sort((a, b) => a - b);
            const pick = (p) => (sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(1) : null);
            const appliedFrames = scene.motionOpaque.applied;
            return {
                opaqueOn,
                frames: sorted.length,
                frameP50: pick(0.5),
                frameP95: pick(0.95),
                frameMax: sorted.length ? +sorted[sorted.length - 1].toFixed(1) : null,
                postsDuringMotion: st.posts,
                orderMbDuringMotion: +(st.bytes / 1048576).toFixed(1),
                opaqueApplied: appliedFrames
            };
        };

        const motionOn = await rotatePhase(true);
        const motionOff = await rotatePhase(false);
        scene.motionOpaque.enabled = true;
        await sleep2(800);

        return {
            numSplats,
            alphaOrderDiff,
            alphaIdentityDiff,
            alphaZeroDiff,
            alphaRepro,
            opaque,
            motion: { on: motionOn, off: motionOff },
            alphaSettledLit: litPercent(alphaCorrect)
        };
    }, [SECONDS]);

    console.log(JSON.stringify({ model: MODEL, url: URL, ...out, errors: errs.slice(0, 5) }, null, 1));
    await browser.close();
    process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ fatal: String(e).slice(0, 400) })); process.exit(1); });
