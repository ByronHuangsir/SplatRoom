// 归档自 _tmp（2026-09-26），REPO 路径已按 docs/probes/ 调整。
// 探针 68：把"盒局部坐标"这条链在页面里逐项算一遍，看是谁把模型算到了盒子外面。
//
// 测三件事：
//   ① `inverse(盒世界) × 世界坐标`（**真值**）落在什么范围 —— 模型应当落在 ±0.5（着色器判定是
//      `0.5 - max|local|`）；
//   ② 我自己那套 `inverse(盒世界) × inverse(视图) × inverse(投影) × clip` 与①是否一致
//      （矩阵乘法顺序/mul2 语义错了就会差在这里）；
//   ③ 裁剪盒自身的 config（position/extent/rotation）与模型 world 包围盒的关系。
//
// usage: node _tmp/probe-crop-local.cjs
const path = require('path');
const REPO = path.join(__dirname, '..', '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    cleanupOrphanBrowsers();
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 900000
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 620 });
    page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)));
    await page.goto('http://localhost:3100/?gpu=webgpu&unified=1', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1200);
    await page.evaluate(async () => {
        const res = await fetch('./test-model.ply');
        const blob = await res.blob();
        await window.scene.events.invoke('import', [{ filename: 'test-model.ply', contents: new File([blob], 'test-model.ply') }]);
    });
    for (let i = 0; i < 80; i++) {
        await sleep(500);
        if (await page.evaluate(() => (window.scene.elements || []).some((e) => e.entity && e.entity.gsplat))) break;
    }
    await page.evaluate(() => {
        const scene = window.scene;
        const el = (scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        scene.events.fire('selection', el);
        scene.events.fire('camera.focus');
        scene.events.fire('cropBox.initialize');
    });
    await sleep(2500);

    const out = await page.evaluate(() => {
        const scene = window.scene;
        const el = (scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        const cam = scene.camera.camera;
        const cropBox = scene.events.invoke('cropBox');

        const mul = (m, v) => [
            m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
            m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
            m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
            m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3]
        ];
        const invert = (m) => { const out4 = new Float32Array(16); const mm = m.slice(); mm.invert && 0; return null; };
        // 用 PlayCanvas 的 Mat4 求逆，再取 data
        const Mat4 = cam.projectionMatrix.constructor;
        const inv = (mat) => { const c = new Mat4(); c.copy(mat); c.invert(); return c.data; };

        const proj = cam.projectionMatrix.data;
        const view = cam.viewMatrix.data;
        const invProj = inv(cam.projectionMatrix);
        const invView = inv(cam.viewMatrix);
        const boxWorld = cropBox.pivot.getWorldTransform().data;
        const invBox = inv(cropBox.pivot.getWorldTransform());
        const entityWorld = el.entity.getWorldTransform().data;

        // 组合：invBox * invView * invProj（按 data 手算 4x4 相乘）
        const mulM = (a, b) => {
            const r = new Float32Array(16);
            for (let c = 0; c < 4; c++) {
                for (let rw = 0; rw < 4; rw++) {
                    r[c * 4 + rw] = a[rw] * b[c * 4] + a[4 + rw] * b[c * 4 + 1] + a[8 + rw] * b[c * 4 + 2] + a[12 + rw] * b[c * 4 + 3];
                }
            }
            return r;
        };
        const clipToBox = mulM(mulM(invBox, invView), invProj);
        // 另一种等价算法（对照）：invBox * (invView * invProj)
        const clipToBox2 = mulM(invBox, mulM(invView, invProj));

        const xs = el.splatData.getProp('x');
        const ys = el.splatData.getProp('y');
        const zs = el.splatData.getProp('z');
        const stride = Math.max(1, Math.floor(el.splatData.numSplats / 200));
        const aRange = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
        const bRange = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
        let maxDiff = 0;
        let samples = 0;
        for (let i = 0; i < el.splatData.numSplats; i += stride) {
            const local = [xs[i], ys[i], zs[i], 1];
            const world = mul(entityWorld, local);
            const viewPos = mul(view, world);
            const clip = mul(proj, viewPos);

            const la = mul(invBox, world);
            const laN = [la[0] / la[3], la[1] / la[3], la[2] / la[3]];
            const lb = mul(clipToBox, clip);
            const lbN = [lb[0] / lb[3], lb[1] / lb[3], lb[2] / lb[3]];
            for (let k = 0; k < 3; k++) {
                aRange.min[k] = Math.min(aRange.min[k], laN[k]);
                aRange.max[k] = Math.max(aRange.max[k], laN[k]);
                bRange.min[k] = Math.min(bRange.min[k], lbN[k]);
                bRange.max[k] = Math.max(bRange.max[k], lbN[k]);
                maxDiff = Math.max(maxDiff, Math.abs(laN[k] - lbN[k]));
            }
            samples++;
        }

        // clipToBox 与 clipToBox2 是否一致（乘法顺序自检）
        let orderDiff = 0;
        for (let i = 0; i < 16; i++) orderDiff = Math.max(orderDiff, Math.abs(clipToBox[i] - clipToBox2[i]));

        return {
            samples,
            boxConfig: cropBox.toConfig(),
            localTruth: { min: aRange.min.map(v => +v.toFixed(3)), max: aRange.max.map(v => +v.toFixed(3)) },
            localMine: { min: bRange.min.map(v => +v.toFixed(3)), max: bRange.max.map(v => +v.toFixed(3)) },
            maxDiffTruthVsMine: +maxDiff.toFixed(6),
            orderDiff: +orderDiff.toFixed(6)
        };
    });

    console.log(JSON.stringify(out, null, 1));
    console.log('\n=== 判定 ===');
    console.log(`  真值（inverse(盒世界)×世界）范围：${JSON.stringify(out.localTruth)}（判定式是 0.5 - max|local|，所以应当在 ±0.5 内）`);
    console.log(`  我算的（clip→盒局部）范围    ：${JSON.stringify(out.localMine)}`);
    console.log(`  两者最大差：${out.maxDiffTruthVsMine} ⇒ ${out.maxDiffTruthVsMine < 1e-3 ? '一致（矩阵链没错）' : '**不一致**（矩阵链有问题）'}`);
    console.log(`  两种乘法顺序的一致性：${out.orderDiff}`);

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
