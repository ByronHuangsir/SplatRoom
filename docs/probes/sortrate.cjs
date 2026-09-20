// P0-2 验证：交互时"每帧派发全量排序"改成"最小间隔 100ms + 停手补一帧"之后，
//   · 轨道旋转期间的排序派发次数（应 ≈ 时长/100ms，而不是 ≈ 帧数）
//   · 帧间隔分布（max 帧应显著下降）
//   · 停手后是否真的补了最后一帧（画面顺序最终是"按最终位姿排序"）
// 用法：node sortrate.cjs <url> [model] [seconds]
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'merged-scene.ply';
const SECONDS = parseInt(process.argv[4] || '4', 10);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 3600000
    });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
        await sleep(1500);

        // 大文件用 Range 分块拼 File（与其它探针一致）
        await page.evaluate(async (m) => {
            const head = await fetch('./' + m, { method: 'HEAD' });
            const size = parseInt(head.headers.get('content-length') || '0', 10);
            if (size > 1.5e9) {
                const CHUNK = 256 * 1048576;
                const parts = [];
                for (let off = 0; off < size; off += CHUNK) {
                    const end = Math.min(off + CHUNK - 1, size - 1);
                    parts.push(await (await fetch('./' + m, { headers: { Range: `bytes=${off}-${end}` } })).blob());
                }
                window.__file = new File(parts, m);
            } else {
                window.__file = new File([await (await fetch('./' + m)).arrayBuffer()], m);
            }
            window.__loadErr = null;
            window.scene.events.invoke('import', [{ filename: m, contents: window.__file }]).catch(e => { window.__loadErr = String(e).slice(0, 200); });
        }, MODEL);
        for (let i = 0; i < 90; i++) {
            await sleep(5000);
            const st = await page.evaluate(() => ({ n: window.scene.getElementsByType('splat').length, s: window.scene.getElementsByType('splat').map(x => x.splatData ? x.splatData.numSplats : 0), err: window.__loadErr }));
            if (st.n > 0 && st.s[0] > 0) break;
            if (st.err) throw new Error(st.err);
        }
        await sleep(8000);

        const result = await page.evaluate(async (seconds) => {
            const sleep2 = (ms) => new Promise(r => setTimeout(r, ms));
            const scene = window.scene;
            const cam = scene.camera;
            const splat = scene.getElementsByType('splat').slice(-1)[0];
            const inst = splat.entity.gsplat.instance;
            const ws = inst.sorter;

            // 数"往排序 worker 派发了几次"：包一层 postMessage
            let posts = 0;
            const realPost = ws.worker.postMessage.bind(ws.worker);
            ws.worker.postMessage = (msg, ...rest) => { posts++; return realPost(msg, ...rest); };

            scene.events.fire('selection', splat);
            await sleep2(500);
            scene.events.fire('camera.focus');
            await sleep2(3000);

            // 帧间隔采样
            const deltas = [];
            let last = performance.now();
            let stop = false;
            const loop = () => {
                const now = performance.now();
                deltas.push(now - last);
                last = now;
                if (!stop) requestAnimationFrame(loop);
            };
            requestAnimationFrame(loop);

            // 模拟连续拖拽旋转（每 16ms 推一次方位角，共 seconds 秒）
            posts = 0;
            const t0 = performance.now();
            const until = t0 + seconds * 1000;
            while (performance.now() < until) {
                cam.setAzimElev(cam.azim + 1.2, cam.elev, 0);
                await sleep2(16);
            }
            const orbitMs = performance.now() - t0;
            const postsDuringOrbit = posts;
            // 停手，等 600ms 看有没有补帧
            await sleep2(600);
            const postsAfterSettle = posts - postsDuringOrbit;
            stop = true;
            await sleep2(300);

            deltas.shift();
            const sorted = deltas.slice().sort((a, b) => a - b);
            const pick = (p) => sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(1) : null;
            ws.worker.postMessage = realPost;
            return {
                numSplats: splat.splatData.numSplats,
                orbitSeconds: +(orbitMs / 1000).toFixed(2),
                sortPostsDuringOrbit: postsDuringOrbit,
                postsPerSecond: +(postsDuringOrbit / (orbitMs / 1000)).toFixed(1),
                sortPostsAfterSettle: postsAfterSettle,
                frames: deltas.length,
                medianMs: pick(0.5),
                p95Ms: pick(0.95),
                maxMs: sorted.length ? +sorted[sorted.length - 1].toFixed(1) : null,
                over33ms: deltas.filter(d => d > 33).length
            };
        }, SECONDS);

        console.log(JSON.stringify({ model: MODEL, ...result }, null, 2));
    } catch (e) {
        console.log(JSON.stringify({ fatal: String(e).slice(0, 300) }, null, 2));
    } finally {
        await browser.close();
    }
})();
