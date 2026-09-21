// 运动期"不依赖顺序"的渲染（A 方案）回归套件。实现见 src/core/motion-opaque.ts。
//
// 断言的机制（小夹具即可，不需要 20M）：
//   1. 运动帧：splat 材质切到**不透明 + 深度写**，`uMotionOpaque` = 1
//   2. 停手帧：恢复到 alpha 混合、深度写关闭、`uMotionOpaque` = 0
//   3. 运动期**不再派发排序**（可见性交给深度测试，排序纯浪费）
//   4. 停手后**仍然补一帧精确排序**（切回半透明时顺序必须是新的）
//   5. 逃生开关 `window.__SPLATROOM_MOTION_OPAQUE__ = false` 生效
//   6. `window.__SPLATROOM_MOTION_ALPHA_CLIP__` 覆盖 alpha 下限
//   7. **顺序无关性**：乱序 vs 正确顺序的画面差异，在不透明路径下必须远小于 alpha 混合路径
//      （夹具对顺序不敏感时只记录数值、不做断言 —— 小夹具可能本来就看不出差别）
//   8. 不动用户设置：`view.bands` 全程不变（纯渲染期行为，不进偏好/文档/导出）
//
// usage: node docs/verify/verify-motion-opaque.cjs "<url>" [model]
//
// 默认夹具不是 test-model.ply，而是**现场生成的"两层平板"夹具**（`docs/probes/gen-layered-splat.cjs`）：
// 顺序无关性需要一个"前后景深度差很大"的场景才测得出（2000 点小夹具的乱序/正确画面差只有 0.3/255，
// 断言会退化成空话）。生成到 `dist/`，与 verify-floater-biggrid.cjs 的做法一致；打包前会连同其它
// 夹具一起挪出 dist。
const path = require('path');
const { execFileSync } = require('child_process');
const puppeteer = require(path.join(__dirname, '..', '..', 'node_modules', 'puppeteer-core'));

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';

const REPO = path.join(__dirname, '..', '..');
const LAYERED = 'test-motion-opaque-layers.ply';
const ensureLayered = () => {
    const out = path.join(REPO, 'dist', LAYERED);
    if (require('fs').existsSync(out)) {
        return;
    }
    execFileSync(process.execPath, [
        path.join(__dirname, '..', 'probes', 'gen-layered-splat.cjs'),
        `--out=${out}`, '--points=200000'
    ], { stdio: 'ignore' });
};
ensureLayered();

const MODEL = process.argv[3] || LAYERED;
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
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

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

    // 采集器：材质状态 / 派发计数 / 顺序无关性
    await page.evaluate(async () => {
        const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
        const scene = window.scene;
        const splat = scene.getElementsByType('splat').slice(-1)[0];
        // 必须先取景：默认机位下分层夹具可能只有一块板可见（另一块被挡/在视野外），
        // 那种情况下"乱序 vs 正确"本来就该是 0，测出来会是"夹具不敏感"的假结论。
        scene.events.fire('selection', splat);
        await sleep2(400);
        scene.events.fire('camera.focus');
        await sleep2(3000);

        const inst = splat.entity.gsplat.instance;
        const ws = inst.sorter;

        window.__state = () => {
            // 引擎的 getParameter 返回的是 { scopeId, data } 包装，不是裸值
            const raw = inst.material.getParameter('uMotionOpaque');
            const rawClip = inst.material.getParameter('uMotionAlphaClip');
            return {
                motionOpaque: splat.motionOpaque,
                transparent: inst.material.transparent,
                depthWrite: inst.material.depthWrite,
                uniform: raw && typeof raw === 'object' ? raw.data : raw,
                alphaClip: rawClip && typeof rawClip === 'object' ? rawClip.data : rawClip,
                moving: scene.cameraMotion.moving,
                viewBands: scene.events.invoke('view.bands')
            };
        };

        window.__posts = 0;
        const realPost = ws.worker.postMessage.bind(ws.worker);
        ws.worker.postMessage = (msg, ...rest) => {
            if (msg && msg.cameraDirection) {
                window.__posts++;
            }
            return realPost(msg, ...rest);
        };

        // 顺序工具：上传有一帧滞后，所以上传两次 + 中间各渲染几帧（见 docs/probes/motion-opaque.cjs）
        // ⚠️ 数量必须取自 `splatData.numSplats`：`ws.orderData.byteLength` 在某些时刻是 0
        // （缓冲区刚被 transfer 走），拿它算 n 会得到**空数组** ⇒ 上传等于没做，
        // 于是"乱序 vs 正确"测出 0.00 这种假结论（第一版就是这么错的）。
        const target = ws.target ?? ws.orderBuffer ?? ws.orderTexture ?? inst.orderBuffer ?? inst.orderTexture;
        const n = splat.splatData.numSplats;
        const identity = new Uint32Array(n);
        for (let i = 0; i < n; i++) {
            identity[i] = i;
        }
        const scrambled = new Uint32Array(identity);
        let seed = 987654321;
        for (let i = n - 1; i > 0; i--) {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            const j = seed % (i + 1);
            const t = scrambled[i];
            scrambled[i] = scrambled[j];
            scrambled[j] = t;
        }
        const zeros = new Uint32Array(n);

        const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const render = async (k) => {
            for (let i = 0; i < k; i++) {
                scene.forceRender = true;
                await nextFrame();
            }
        };
        window.__grab = async () => {
            await render(2);
            const src = scene.canvas;
            const off = document.createElement('canvas');
            off.width = src.width;
            off.height = src.height;
            const ctx = off.getContext('2d');
            ctx.drawImage(src, 0, 0);
            return ctx.getImageData(0, 0, off.width, off.height);
        };
        window.__meanAbs = (a, b) => {
            let sum = 0;
            let c = 0;
            for (let i = 0; i < a.data.length; i += 4 * 3) {
                sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
                c += 3;
            }
            return sum / c;
        };
        window.__setOrder = async (which) => {
            const arr = which === 'scrambled' ? scrambled : (which === 'zeros' ? zeros : identity);
            ws.uploadStream.upload(arr, target);
            await render(4);
            ws.uploadStream.upload(arr, target);
            await render(6);
        };
        // 顺序无关性的完整测量（在页内跑）：
        //   ① alpha 基准：**显式关掉**不透明路径（`motionOpaque.enabled = false`），
        //      否则"静止但补帧欠着/在飞"等状态会让基准其实跑在不透明路径上 ——
        //      那样量出来的 alphaScrambled 会是 0.00（第一版就是这么得到假结论的）。
        //   ② 不透明路径：打开开关 + 抖动（moving）。
        //   alphaZeros / opaqueZeros 是对照：order buffer 若没被着色器读，这两个值会很小。
        window.__orderTest = async () => {
            const scene2 = window.scene;
            const wasEnabled = scene2.motionOpaque.enabled;
            const measure = async (mode) => {
                scene2.motionOpaque.enabled = mode === 'opaque';
                if (mode === 'opaque') {
                    await window.__jiggle(0.05);
                } else {
                    await render(4);
                }
                const state = window.__state();
                await window.__setOrder('identity');
                if (mode === 'opaque') {
                    await window.__jiggle(0.05);
                }
                const a = await window.__grab();
                await window.__setOrder('scrambled');
                if (mode === 'opaque') {
                    await window.__jiggle(0.05);
                }
                const b = await window.__grab();
                await window.__setOrder('zeros');
                if (mode === 'opaque') {
                    await window.__jiggle(0.05);
                }
                const z = await window.__grab();
                await window.__setOrder('identity');
                return {
                    scrambled: window.__meanAbs(a, b),
                    zeros: window.__meanAbs(a, z),
                    transparent: state.transparent,
                    applied: state.motionOpaque,
                    moving: state.moving
                };
            };

            const alpha = await measure('alpha');
            const opaque = await measure('opaque');
            scene2.motionOpaque.enabled = wasEnabled;

            return {
                alpha,
                opaque,
                n,
                targetKind: target ? target.constructor.name : 'none',
                scrambledHead: Array.from(scrambled.slice(0, 4))
            };
        };
        window.__jiggle = async (deg) => {
            const cam = scene.camera;
            const az0 = cam.azim;
            const el0 = cam.elevation;
            for (let i = 0; i < 3; i++) {
                cam.setAzimElev(az0 + deg, el0, 0);
                await render(1);
            }
            cam.setAzimElev(az0, el0, 0);
            await render(1);
        };
        // 停掉引擎自己的顺序消费（否则排序回包会把"正确顺序"写回去，掩盖我们上传的乱序）
        window.__applyPendingOriginal = ws.applyPendingSorted.bind(ws);
        window.__blockConsume = () => { ws.applyPendingSorted = () => -1; };
        window.__unblockConsume = () => { ws.applyPendingSorted = window.__applyPendingOriginal; };
    });

    const checks = [];
    const check = (name, pass, detail) => checks.push({ name, pass, detail });
    const state = () => page.evaluate(() => window.__state());
    const posts = () => page.evaluate(() => window.__posts);
    const rotate = (ms, deg = 6) => page.evaluate(async ([duration, step]) => {
        const cam = window.scene.camera;
        const scene = window.scene;
        const t0 = performance.now();
        let stop = false;
        const loop = () => {
            scene.forceRender = true;
            if (!stop) requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
        while (performance.now() - t0 < duration) {
            cam.setAzimElev(cam.azim + step, cam.elevation, 0);
            await new Promise((r) => setTimeout(r, 16));
        }
        stop = true;
    }, [ms, deg]);

    try {
        const settled = await state();
        check('settled: alpha blending, no depth write, uMotionOpaque = 0',
            settled.transparent === true && settled.depthWrite === false && settled.uniform === 0,
            `transparent=${settled.transparent} depthWrite=${settled.depthWrite} uMotionOpaque=${settled.uniform}`);

        // ---- 运动帧：切到不透明 ----
        const spin = rotate(1200);
        await sleep(400);
        const movingState = await state();
        await spin;
        check('moving: opaque + depth write, uMotionOpaque = 1',
            movingState.moving === true && movingState.motionOpaque === true &&
            movingState.transparent === false && movingState.depthWrite === true && movingState.uniform === 1,
            `moving=${movingState.moving} applied=${movingState.motionOpaque} transparent=${movingState.transparent} ` +
            `depthWrite=${movingState.depthWrite} uMotionOpaque=${movingState.uniform}`);

        // ---- 运动期不派发排序 / 停手仍补一帧：都是一次旋转里的两段计数 ----
        // 计数窗口要避开两类噪声：
        //   ① 相位过渡帧：`cameraMotion.moving` 是时间戳判定，进入运动状态会晚一两帧，
        //      且"进入不透明路径之前派发出去的那次排序"会在运动中被回包 → 补发 1~2 次；
        //   ② 停手补帧：它发生在旋转**结束之后**，所以必须在旋转结束后单独开一个窗口数它，
        //      否则会落在上一个窗口之外（第一版就是这么漏判成 0 的）。
        const countPosts = async (opaqueOn) => {
            await page.evaluate((on) => {
                if (on) {
                    delete window.__SPLATROOM_MOTION_OPAQUE__;
                } else {
                    window.__SPLATROOM_MOTION_OPAQUE__ = false;
                }
            }, opaqueOn);
            const spin = rotate(3200);
            await sleep(1400);                                  // 跳过过渡 + 在飞的那次排序回包
            await page.evaluate(() => { window.__posts = 0; });
            await sleep(1500);
            const during = await posts();
            await spin;
            // ⚠️ 计数窗口必须**从旋转结束的瞬间**开始：不透明路径下 `_sortSettleAt` 在运动期被反复
            // 武装成 now+200，停手补帧正好落在"最后一个位姿变化 +200 ms"处；先 sleep 再清零会把
            // 它漏掉（实测 WebGPU 上 2/3 次假红）。
            let afterSettle = 0;
            for (let attempt = 0; attempt < 2; attempt++) {
                await page.evaluate(() => { window.__posts = 0; });
                for (let i = 0; i < 20; i++) {
                    await sleep(150);
                    afterSettle = await posts();
                    if (afterSettle > 0) {
                        break;
                    }
                }
                if (afterSettle > 0) {
                    break;
                }
                await rotate(1200);
            }
            return { during, afterSettle };
        };
        const postsOff = await countPosts(false);
        const postsOn = await countPosts(true);
        check('moving: the opaque path stops motion-time sorting (A/B against the escape hatch)',
            postsOn.during <= 3 && postsOn.during <= postsOff.during * 0.6,
            `worker posts over the same 1.5 s of rotation: opaque ON = ${postsOn.during} ` +
            `(<= 3, and <= 60% of OFF), alpha (hatch off) = ${postsOff.during} (must still sort) — ` +
            `ON 不为 0 的残余来自"拖动循环与渲染循环错开、cameraMotion.moving 偶尔掉一帧"的过渡，` +
            `不是排序仍在跑（20M 上实测 ON=1 vs OFF=21）`);

        // ---- 停手后补一帧精确排序（计数已在上面的 countPosts(true) 里、旋转结束后单独开窗做的）----
        check('settled: one exact sort is issued so alpha blending comes back with a fresh order',
            postsOn.afterSettle >= 1,
            `worker posts after the drag = ${postsOn.afterSettle} (counted from the moment the drag ended)`);

        // ---- 顺序无关性（决定性判据）----
        await page.evaluate(() => { window.__blockConsume(); });
        await sleep(300);
        const order = await page.evaluate(() => window.__orderTest());
        await page.evaluate(() => { window.__unblockConsume(); });
        const orderDiag = `n=${order.n} target=${order.targetKind} scrambled[0..3]=${JSON.stringify(order.scrambledHead)} ` +
            `alpha{transparent=${order.alpha.transparent}, applied=${order.alpha.applied}} ` +
            `opaque{transparent=${order.opaque.transparent}, applied=${order.opaque.applied}}`;

        // 像素级判据只在"这套宿主真能驱动 order 目标"的后端上断言：
        //   WebGPU：order 是 storage buffer，探针/套件都能写（实测 all-zeros 对照 ~90）
        //   WebGL2：order 是 R32U 纹理，而 `uploadStream.upload(array, texture)` 在套件宿主里
        //           实测写不进去（对照 0.00）⇒ 无法测量，明确记为"未测"而不是假绿。
        // 权威口径仍是 docs/probes/motion-opaque.cjs（600k 分层 36.37 → 0；200k 分层 33.74 → 0；
        // 20M fill 4.68 → 0.07~1.88，都带 all-zeros 对照与"两次抓图收敛"检查）。
        if (order.alpha.zeros > 5) {
            check('order independence: measurement is valid (alpha baseline + order buffer really read)',
                order.alpha.transparent === true,
                `all-zeros order changes the alpha-path image by ${order.alpha.zeros.toFixed(2)} ` +
                `(transparent=${order.alpha.transparent} proves the baseline is the alpha path) | ${orderDiag}`);
            check('order independence: the opaque path is immune to the sort order',
                order.opaque.applied === true &&
                order.opaque.scrambled <= Math.max(0.5, order.alpha.scrambled * 0.25),
                `alpha-path ${order.alpha.scrambled.toFixed(2)} vs opaque-path ${order.opaque.scrambled.toFixed(2)} ` +
                `(opaque must be <= 25% of alpha; applied=${order.opaque.applied}) | ${orderDiag}`);
        } else {
            check('order independence: not measurable on this backend from the suite (probe has the assertion)',
                order.opaque.applied === true && order.opaque.scrambled <= 0.5,
                `the suite cannot drive the order target here (all-zeros control = ${order.alpha.zeros.toFixed(2)}, ` +
                `target=${order.targetKind}) ⇒ measured "0.00" would be meaningless; the decisive pixel numbers are in ` +
                `docs/probes/motion-opaque.cjs | ${orderDiag}`);
        }

        // ---- 逃生开关 ----
        await page.evaluate(() => { window.__SPLATROOM_MOTION_OPAQUE__ = false; });
        const spin2 = rotate(1000);
        await sleep(300);
        const disabled = await state();
        await spin2;
        check('window.__SPLATROOM_MOTION_OPAQUE__ = false keeps alpha blending while moving',
            disabled.moving === true && disabled.transparent === true && disabled.uniform === 0,
            `moving=${disabled.moving} transparent=${disabled.transparent} uMotionOpaque=${disabled.uniform}`);
        await page.evaluate(() => { delete window.__SPLATROOM_MOTION_OPAQUE__; });

        // ---- alpha 下限覆盖 ----
        await page.evaluate(() => { window.__SPLATROOM_MOTION_ALPHA_CLIP__ = 0.7; });
        const spin3 = rotate(1000);
        await sleep(300);
        const clipped = await state();
        await spin3;
        check('window.__SPLATROOM_MOTION_ALPHA_CLIP__ overrides the shader alpha floor',
            clipped.motionOpaque === true && Math.abs(clipped.alphaClip - 0.7) < 1e-3,
            `uMotionAlphaClip=${clipped.alphaClip} (expected 0.7)`);
        await page.evaluate(() => { delete window.__SPLATROOM_MOTION_ALPHA_CLIP__; });

        // ---- 不动用户设置 ----
        await sleep(900);
        const after = await state();
        check('the user setting view.bands is untouched (transient render-only behaviour)',
            after.viewBands === settled.viewBands,
            `view.bands ${settled.viewBands} -> ${after.viewBands}`);
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
