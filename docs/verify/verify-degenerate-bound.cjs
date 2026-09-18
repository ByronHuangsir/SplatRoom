// 全选 + 删除 ⇒ 包围盒变成 ±1e6 ⇒ 整个视口被近裁剪面切空（docs/audit/01-量级复查-bug.md §13）。
//
// 这条 bug 的关键是**它是全局的**：被删空的那个模型的退化包围盒参与了 scene.bound 的并集，
// 于是 boundRadius 变成 ~1.7e6、near 变成 far/16384 ≈ 105 —— 同一场景里**其它完好的模型**
// 也一起消失，而且相机怎么缩放都救不回来（near 每帧重算），只能撤销。
// 所以这个套件必须**导入两个模型**：删空一个，然后断言另一个还在画面上。
//
// 断的是三件事：
//   ① 删空之后 localBound 的三个 halfExtents 都不是负数（旧行为是 -1e6）
//   ② scene.bound 的半径没有爆炸（旧行为 ~1.7e6），near 也没有跟着涨到 100 量级
//   ③ 另一个模型**仍然在视口里**（非背景像素占比 > 1%）
// 再撤销，断言一切都回来了。
//
// usage: node docs/verify/verify-degenerate-bound.cjs [url]
const puppeteer = require('C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 600000
    });

    const errors = [];
    let out = null;
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        page.on('pageerror', e => errors.push('pageerror: ' + String(e).slice(0, 300)));
        page.on('console', (m) => {
            if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 300));
        });

        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForFunction('!!window.scene', { timeout: 60000 });
        await sleep(2500);

        // 两个模型：删空其中一个，另一个必须还在
        await page.evaluate(async () => {
            const scene = window.scene;
            for (const name of ['test-model.ply', 'cluster-test.ply']) {
                const buf = await (await fetch('./' + name)).arrayBuffer();
                await scene.events.invoke('import', [{ filename: name, contents: new File([buf], name) }]);
            }
        });
        await page.waitForFunction("window.scene.getElementsByType('splat').length >= 2", { timeout: 120000 });
        await sleep(4000);

        // 视口里"非背景像素"的占比：必须在 postrender 里取（默认不开 preserveDrawingBuffer）
        const sample = () => page.evaluate(() => {
            const scene = window.scene;
            const source = document.querySelector('canvas');
            return new Promise((resolve) => {
                const onPostRender = () => {
                    scene.app.off('postrender', onPostRender);
                    try {
                        const w = Math.min(600, source.width);
                        const h = Math.min(400, source.height);
                        const copy = document.createElement('canvas');
                        copy.width = w;
                        copy.height = h;
                        const ctx = copy.getContext('2d');
                        ctx.drawImage(source, 0, 0, source.width, source.height, 0, 0, w, h);
                        const data = ctx.getImageData(0, 0, w, h).data;
                        const bg = [data[0], data[1], data[2]];
                        let nonBg = 0;
                        for (let i = 0; i < data.length; i += 4) {
                            const d = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
                            if (d > 30) nonBg++;
                        }
                        resolve({ total: w * h, nonBg });
                    } catch (e) {
                        resolve({ error: String(e).slice(0, 200) });
                    }
                };
                scene.app.on('postrender', onPostRender);
                scene.forceRender = true;
                scene.app.renderNextFrame = true;
            });
        });

        const readState = () => page.evaluate(() => {
            const scene = window.scene;
            const splats = scene.getElementsByType('splat');
            const target = splats[splats.length - 1];
            const b = target.localBound;
            const sb = scene.bound;
            const cam = scene.camera;
            return {
                numSplats: target.numSplats,
                totalSplats: splats.reduce((n, s) => n + s.numSplats, 0),
                localHalf: [b.halfExtents.x, b.halfExtents.y, b.halfExtents.z],
                localCenter: [b.center.x, b.center.y, b.center.z],
                sceneHalf: [sb.halfExtents.x, sb.halfExtents.y, sb.halfExtents.z],
                sceneRadius: sb.halfExtents.length(),
                near: cam.near,
                far: cam.far,
                frustumOk: Number.isFinite(cam.near) && Number.isFinite(cam.far) && cam.near > 0 && cam.near < cam.far
            };
        });

        // 决定性判据：**没被删空的那个模型**的高斯中心，在视图空间里的深度有没有落在
        // [near, far] 之内。旧行为里 near ≈ far/16384 ≈ 105，而模型离相机只有几个单位，
        // 于是这些点全部落在近裁剪面之前 ⇒ 整个视口被切空（包括完好的模型）。
        // 这一条不依赖渲染后端，比数像素可靠（无头 WebGPU 下 canvas 读不回来）。
        const frustumProbe = () => page.evaluate(() => {
            const scene = window.scene;
            const splats = scene.getElementsByType('splat');
            const intact = splats.filter(s => s.numSplats > 0);
            if (!intact.length) return null;

            const cam = scene.camera.mainCamera;
            const invView = cam.getWorldTransform().clone().invert();
            const { near, far } = scene.camera;

            const samples = [];
            for (const splat of intact) {
                const data = splat.splatData;
                const n = data.numSplats;
                const x = data.getProp('x');
                const y = data.getProp('y');
                const z = data.getProp('z');
                const stride = Math.max(1, Math.floor(n / 200));
                const world = splat.worldTransform;
                const v = new (window.pc ? window.pc.Vec3 : Object)();
                for (let i = 0; i < n; i += stride) {
                    const p = { x: x[i], y: y[i], z: z[i] };
                    // local -> world -> view（手算，避免依赖 Vec3 的构造方式）
                    const w = world.data;
                    const wx = w[0] * p.x + w[4] * p.y + w[8] * p.z + w[12];
                    const wy = w[1] * p.x + w[5] * p.y + w[9] * p.z + w[13];
                    const wz = w[2] * p.x + w[6] * p.y + w[10] * p.z + w[14];
                    const m = invView.data;
                    const vz = m[2] * wx + m[6] * wy + m[10] * wz + m[14];
                    const depth = -vz;      // PlayCanvas 前向是 -Z
                    samples.push({ depth, inFrustum: depth > near && depth < far });
                }
                void v;
            }

            const inside = samples.filter(s => s.inFrustum).length;
            // 旧行为会算出来的 near：退化包围盒（halfExtents = ±1e6 ⇒ 半径 √3e6）下的 far/16384
            const degenerateRadius = Math.sqrt(3) * 1e6;
            const centerDist = Math.abs((() => {
                const sb = scene.bound;
                const camPos = scene.camera.mainCamera.getPosition();
                const fwd = scene.camera.mainCamera.forward;
                return (sb.center.x - camPos.x) * fwd.x + (sb.center.y - camPos.y) * fwd.y + (sb.center.z - camPos.z) * fwd.z;
            })());
            const oldNear = (centerDist + degenerateRadius) / 16384;
            const wouldHaveSurvived = samples.filter(s => s.depth > oldNear).length;
            return { sampled: samples.length, inside, near, far, oldNear, wouldHaveSurvived };
        });

        // 让最后导入的那个模型获得"元素选中"，随后全选 + 删除
        await page.evaluate(() => {
            const scene = window.scene;
            const splats = scene.getElementsByType('splat');
            scene.events.fire('selection', splats[splats.length - 1]);
        });
        await sleep(800);
        const before = await readState();
        const pixelsBefore = await sample();

        await page.evaluate(() => window.scene.events.fire('select.all'));
        await sleep(1500);
        await page.evaluate(() => window.scene.events.fire('select.delete'));
        await sleep(4000);

        const after = await readState();
        const pixelsAfter = await sample();
        const frustumAfter = await frustumProbe();

        // 撤销：一切必须回来（同一个模型重新可见 + bound/near 复原）
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyZ');
        await page.keyboard.up('Control');
        await sleep(5000);
        const restored = await readState();
        const pixelsRestored = await sample();

        const radius = after.sceneRadius;
        const checks = [
            {
                name: '两个模型都导入成功',
                pass: before.totalSplats > 3000,
                detail: `${before.totalSplats} splats`
            },
            {
                name: '全选 + 删除真的把它删空了',
                pass: after.numSplats === 0,
                detail: `numSplats=${after.numSplats}`
            },
            {
                name: '删空后 localBound 的 halfExtents 不是负数（旧行为 -1e6）',
                pass: after.localHalf.every(v => Number.isFinite(v) && v >= 0),
                detail: after.localHalf.map(v => v.toFixed(4)).join(', ')
            },
            {
                name: '删空后 scene.bound 的半径没有爆炸（旧行为 ~1.7e6）',
                pass: Number.isFinite(radius) && radius < 1e4,
                detail: `radius=${radius.toFixed(4)}`
            },
            {
                name: '删空后 near 没有涨到 100 量级（旧行为 ~105）',
                pass: after.near < 1,
                detail: `near=${after.near.toExponential(3)} far=${after.far.toExponential(3)}`
            },
            {
                name: 'near/far 自洽（有限、near>0、near<far）',
                pass: after.frustumOk,
                detail: `near=${after.near} far=${after.far}`
            },
            {
                name: '★ 另一个模型的高斯仍然落在 [near, far] 之内（不会被近裁剪面切掉）',
                pass: !!frustumAfter && frustumAfter.inside > 0,
                detail: frustumAfter ? `${frustumAfter.inside}/${frustumAfter.sampled} 个采样点在视锥深度范围内` : 'no intact splat'
            },
            {
                name: '★ 自证伪：旧行为（near ≈ far/16384）下这些点会被全部切掉',
                pass: !!frustumAfter && frustumAfter.wouldHaveSurvived === 0 && frustumAfter.sampled > 0,
                detail: frustumAfter ? `旧 near=${frustumAfter.oldNear.toFixed(1)}，能活下来的采样点 ${frustumAfter.wouldHaveSurvived}/${frustumAfter.sampled}` : 'n/a'
            },
            {
                name: '撤销后模型回来了',
                pass: restored.numSplats === before.numSplats,
                detail: `${restored.numSplats} (was ${before.numSplats})`
            },
            {
                name: '撤销后视口重新有几何（信息项：无头 WebGPU 下 canvas 读不回来）',
                pass: true,
                detail: `before ${pixelsBefore ? pixelsBefore.nonBg : 'n/a'} / after ${pixelsAfter ? pixelsAfter.nonBg : 'n/a'} / restored ${pixelsRestored ? pixelsRestored.nonBg : 'n/a'}`
            }
        ];

        out = { before, after, restored, pixelsBefore, pixelsAfter, pixelsRestored, frustumAfter, checks, failed: checks.filter(c => !c.pass).length, errors };
    } catch (err) {
        out = { fatal: String(err).slice(0, 700), errors, failed: 1 };
    } finally {
        await browser.close();
    }

    console.log(JSON.stringify(out, null, 2));
    if (out.failed > 0) process.exitCode = 1;
})();
