// "把排序搬到 GPU 能省多少"的上限测量（2026-09-21 第七轮）。
//
// 现在每次排序完成，引擎的 `GSplatSorter.applyPendingSorted()` 都要把 worker 算好的 20M 个索引
// （20M × 4 B = **80 MB**）从主线程搬进 GPU。本探针把这条代价链**逐段拆开量**：
//
//   ① worker 排序本身           —— 引擎 `scene.fire('gsplat:sorted', sortTime)` 带回来的耗时（不在主线程）
//   ② λ = 派发 → 完成事件        —— 顺序"新鲜度"的上限（我们这轮的延迟补偿就是在补它）
//   ③ 完成 → 消费（排队等待）     —— 结果到了却还没被上传的那段（主线程忙的时候会拉长）
//   ④ upload 本身（主线程）      —— WebGPU 走 staging：80 MB memcpy + copyBufferToBuffer
//   ⑤ ≥1 MB 的 GPU buffer 分配   —— staging 池没赶上就会**每个排序新建一块 80 MB**
//   ⑥ 帧代价：含上传的帧 vs 不含 —— 直接看 ①②④⑤ 砸在帧上是多少
//   ⑦ 反事实相位：把 upload 变成 no-op（顺序会过期，但**画的还是同一批高斯**），
//      量到的帧分布就是"零上传成本"的上界 ⇒ GPU 排序能拿到的最好情况
//
// 计量口径与已有探针一致：帧时间用 rAF 间隔、`litPercent` 保证"快"不是因为没画东西、
// 顺序新鲜度用 `disp`（0 = 正确，0.333 = 随机）。
//
// 用法：node docs/probes/sort-cost.cjs "<url>" [model] [seconds]
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
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
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
        await sleep2(4000);

        const inst = splat.entity.gsplat.instance;
        const ws = inst.sorter;
        const device = scene.graphicsDevice;
        window.__SPLATROOM_SORT_PREDICT__ = false;      // 这一轮量的是代价，不是错位

        // ---- 计量挂钩 ---------------------------------------------------------------------
        const stats = {
            posts: 0,
            completions: 0,
            latencyMs: [],          // ② 派发 → 完成
            replyWaitMs: [],        // ③ 完成 → 被消费
            uploadMs: [],           // ④ upload 内部耗时（主线程）
            uploadBytes: 0,
            workerSortMs: [],       // ① worker 自报
            allocs: [],             // ⑤ ≥1 MB 的 GPU buffer 分配（字节）
            orderBytes: ws.orderBuffer ? ws.orderBuffer.size ?? ws.orderBuffer.byteLength ?? 0 : 0
        };

        const realUpload = ws.uploadStream.upload.bind(ws.uploadStream);
        let uploadNoop = false;
        let lastUploadAt = 0;
        ws.uploadStream.upload = (data, target, offset, size) => {
            if (uploadNoop) {
                lastUploadAt = performance.now();
                return;
            }
            const t0 = performance.now();
            const r = realUpload(data, target, offset, size);
            const dt = performance.now() - t0;
            stats.uploadMs.push(dt);
            stats.uploadBytes += (data && data.byteLength) || 0;
            lastUploadAt = performance.now();
            return r;
        };

        let uploadPhaseAt = -1;                 // 上传发生在哪一帧（帧序号）
        let frameIndex = 0;
        const realApply = ws.applyPendingSorted.bind(ws);
        ws.applyPendingSorted = () => {
            if (ws.pendingSorted) {
                uploadPhaseAt = frameIndex;
            }
            return realApply();
        };

        const realPost = ws.worker.postMessage.bind(ws.worker);
        const pendingPosts = [];
        ws.worker.postMessage = (msg, ...rest) => {
            if (msg && msg.cameraDirection) {
                stats.posts++;
                pendingPosts.push(performance.now());
                if (pendingPosts.length > 4) pendingPosts.shift();
            }
            return realPost(msg, ...rest);
        };
        let lastReplyAt = 0;
        ws.on('updated', () => {
            const t = pendingPosts.shift();
            if (t !== undefined) stats.latencyMs.push(performance.now() - t);
            lastReplyAt = performance.now();
            stats.completions++;
        });
        // ③ 完成 → 消费：在 applyPendingSorted 里用 lastReplyAt 量
        const realApply2 = ws.applyPendingSorted;
        ws.applyPendingSorted = () => {
            if (ws.pendingSorted && lastReplyAt > 0) {
                stats.replyWaitMs.push(performance.now() - lastReplyAt);
                lastReplyAt = 0;
            }
            return realApply2();
        };

        scene.app.scene.on('gsplat:sorted', (sortTime) => {
            if (typeof sortTime === 'number') stats.workerSortMs.push(sortTime);
        });

        if (device.wgpu && device.wgpu.createBuffer) {
            const realCreate = device.wgpu.createBuffer.bind(device.wgpu);
            device.wgpu.createBuffer = (desc) => {
                if (desc && desc.size >= 1048576) {
                    stats.allocs.push(desc.size);
                }
                return realCreate(desc);
            };
        }

        // ---- 顺序新鲜度（disp）--------------------------------------------------------------
        const data = splat.splatData;
        const cx = data.getProp('x');
        const cy = data.getProp('y');
        const cz = data.getProp('z');
        const K = 4000;
        const samplePos = new Int32Array(K);
        const depth = new Float32Array(K);
        const curRank = new Int32Array(K);
        const trueRank = new Int32Array(K);
        const idxByDepth = new Int32Array(K);
        const idxByOrder = new Int32Array(K);
        const localPose = () => {
            const inv = inst.meshInstance.node.getWorldTransform().clone().invert();
            const node = scene.camera.mainCamera;
            const d = node.getWorldTransform().getZ().clone();
            const o = d.clone();
            inv.transformVector(d, o);
            const p = node.getWorldTransform().getTranslation().clone();
            const q = p.clone();
            inv.transformPoint(p, q);
            return { pos: q, dir: o.normalize() };
        };
        const measure = () => {
            try {
                const orderArr = new Uint32Array(ws.orderData);
                const n = orderArr.length;
                const { pos, dir } = localPose();
                let seed = 123456789;
                for (let i = 0; i < K; i++) {
                    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
                    samplePos[i] = seed % n;
                }
                for (let i = 0; i < K; i++) {
                    const v = orderArr[samplePos[i]];
                    depth[i] = (cx[v] - pos.x) * dir.x + (cy[v] - pos.y) * dir.y + (cz[v] - pos.z) * dir.z;
                }
                for (let i = 0; i < K; i++) {
                    idxByDepth[i] = i;
                    idxByOrder[i] = i;
                }
                idxByDepth.sort((a, b) => depth[a] - depth[b]);
                idxByOrder.sort((a, b) => samplePos[a] - samplePos[b]);
                for (let r = 0; r < K; r++) {
                    curRank[idxByOrder[r]] = r;
                    trueRank[idxByDepth[r]] = r;
                }
                let f = 0;
                let rv = 0;
                for (let i = 0; i < K; i++) {
                    f += Math.abs(trueRank[i] - curRank[i]);
                    rv += Math.abs((K - 1 - trueRank[i]) - curRank[i]);
                }
                return Math.min(f, rv) / K / (K - 1);
            } catch (e) {
                return -1;
            }
        };

        // ---- 画布可见性（保证"快"不是因为没画东西）--------------------------------------------
        // 抓图必须紧跟在**一帧真正渲染之后**：WebGPU 的画布在下一帧呈现后就取不到内容了，
        // 在 sleep 里直接 drawImage 会得到全黑（第一版就是这么错的：litPercent 报 0）。
        const litPercent = async () => {
            scene.forceRender = true;
            await new Promise((r) => requestAnimationFrame(() => r()));
            const src = scene.canvas;
            const off = document.createElement('canvas');
            off.width = src.width;
            off.height = src.height;
            const ctx = off.getContext('2d');
            ctx.drawImage(src, 0, 0);
            const img = ctx.getImageData(0, 0, off.width, off.height);
            let lit = 0;
            let n = 0;
            for (let i = 0; i < img.data.length; i += 4 * 7) {          // 抽样 1/7 像素
                if (Math.max(img.data[i], img.data[i + 1], img.data[i + 2]) > 60) lit++;
                n++;
            }
            return +((lit / n) * 100).toFixed(1);
        };

        // ---- 相位执行 -----------------------------------------------------------------------
        const runPhase = async (label, noop, seconds) => {
            uploadNoop = noop;
            stats.posts = 0;
            stats.completions = 0;
            stats.latencyMs.length = 0;
            stats.replyWaitMs.length = 0;
            stats.uploadMs.length = 0;
            stats.uploadBytes = 0;
            stats.workerSortMs.length = 0;
            stats.allocs.length = 0;

            const deltas = [];
            const framesWithUpload = [];
            const framesWithoutUpload = [];
            let last = performance.now();
            let stop = false;
            frameIndex = 0;
            uploadPhaseAt = -1;
            const loop = () => {
                const now = performance.now();
                const dt = now - last;
                last = now;
                if (uploadPhaseAt === frameIndex) {
                    framesWithUpload.push(dt);
                } else {
                    framesWithoutUpload.push(dt);
                }
                frameIndex++;
                scene.forceRender = true;
                if (!stop) requestAnimationFrame(loop);
            };
            requestAnimationFrame(loop);

            const cam = scene.camera;
            const disps = [];
            const t0 = performance.now();
            let nextSample = 0;
            while (performance.now() - t0 < seconds * 1000) {
                cam.setAzimElev(cam.azim + 6, cam.elevation, 0);    // ~375°/s
                await sleep2(16);
                if (performance.now() - t0 >= nextSample) {
                    nextSample += 250;
                    disps.push(measure());
                }
            }
            stop = true;
            await sleep2(300);

            const pick = (arr, p) => (arr.length ? +arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))].toFixed(2) : null);
            const sum = (arr) => arr.reduce((a, b) => a + b, 0);
            return {
                label,
                seconds,
                posts: stats.posts,
                completions: stats.completions,
                workerSortMsP50: pick(stats.workerSortMs, 0.5),
                latencyMsP50: pick(stats.latencyMs, 0.5),
                latencyMsMax: stats.latencyMs.length ? +Math.max(...stats.latencyMs).toFixed(1) : null,
                replyWaitMsP50: pick(stats.replyWaitMs, 0.5),
                uploadCount: stats.uploadMs.length,
                uploadMsP50: pick(stats.uploadMs, 0.5),
                uploadMsMax: stats.uploadMs.length ? +Math.max(...stats.uploadMs).toFixed(2) : null,
                uploadMbTotal: +(stats.uploadBytes / 1048576).toFixed(1),
                uploadMainThreadMsTotal: +sum(stats.uploadMs).toFixed(1),
                uploadShareOfWallPercent: +((sum(stats.uploadMs) / (seconds * 1000)) * 100).toFixed(1),
                bigAllocs: stats.allocs.length,
                bigAllocMbTotal: +(sum(stats.allocs) / 1048576).toFixed(1),
                bigAllocMbEach: stats.allocs.length ? +(stats.allocs[0] / 1048576).toFixed(1) : null,
                frames: framesWithUpload.length + framesWithoutUpload.length,
                frameP50: pick(framesWithUpload.concat(framesWithoutUpload), 0.5),
                frameP95: pick(framesWithUpload.concat(framesWithoutUpload), 0.95),
                frameWithUploadP50: pick(framesWithUpload, 0.5),
                frameWithUploadP95: pick(framesWithUpload, 0.95),
                frameNoUploadP50: pick(framesWithoutUpload, 0.5),
                frameNoUploadP95: pick(framesWithoutUpload, 0.95),
                framesWithUpload: framesWithUpload.length,
                dispP50: pick(disps, 0.5),
                litPercent: await litPercent()
            };
        };

        // 参考点：停手后的顺序误差（度量自检）
        await sleep2(1200);
        const settledDisp = measure();
        const settledLit = await litPercent();

        const baseline = await runPhase('baseline', false, seconds);
        const noUpload = await runPhase('no-upload (counterfactual)', true, seconds);
        // 收尾：恢复上传，确认顺序能回到正确
        uploadNoop = false;
        await sleep2(1500);
        const restoredDisp = measure();
        const restoredLit = await litPercent();

        return {
            model: {},
            orderBytes: ws.orderBuffer ? (ws.orderBuffer.size ?? 0) : 0,
            settledDisp,
            settledLit,
            restoredDisp,
            restoredLit,
            baseline,
            noUpload,
            frameGainMs: baseline.frameP50 !== null && noUpload.frameP50 !== null ?
                +(baseline.frameP50 - noUpload.frameP50).toFixed(1) : null,
            frameGainP95Ms: baseline.frameP95 !== null && noUpload.frameP95 !== null ?
                +(baseline.frameP95 - noUpload.frameP95).toFixed(1) : null,
            uploadFrameGainMs: baseline.frameWithUploadP50 !== null && noUpload.frameWithUploadP50 !== null ?
                +(baseline.frameWithUploadP50 - noUpload.frameWithUploadP50).toFixed(1) : null,
            uploadFrameGainP95Ms: baseline.frameWithUploadP95 !== null && noUpload.frameWithUploadP95 !== null ?
                +(baseline.frameWithUploadP95 - noUpload.frameWithUploadP95).toFixed(1) : null
        };
    }, [SECONDS]);

    console.log(JSON.stringify({ model: MODEL, url: URL, ...out, errors: errs.slice(0, 5) }, null, 1));
    await browser.close();
    process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ fatal: String(e).slice(0, 400) })); process.exit(1); });
