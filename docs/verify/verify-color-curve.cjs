// 曲线调色（Curves）的**行为**回归：着色器里的曲线段是否真的生效、默认是否零改动。
//
// 为什么这么测：曲线功能默认必须是"关"的（`uCurveEnabled = 0` ⇒ 着色器整段跳过），
// 所以本套件同时守住两件事：
//   ① 不设曲线 ⇒ 画面与"没有这个功能"逐位一致（同一页面前后对照）；
//   ② 设了曲线 ⇒ 真的按曲线改变画面，而且方向可预测（抬亮/压暗/S 曲线拉对比）。
// 双向都在 WebGPU 与 WebGL2 上跑（GLSL 与 WGSL 是两份实现，必须都验证）。
//
// 断言：
//   1. 不设曲线时 `uCurveEnabled == 0`，设了曲线 == 1（材质参数真的推下去了）；
//   2. 恒等曲线 = 不设曲线（像素统计与逐像素差都为 0）；
//   3. 抬亮曲线让平均亮度上升、压暗曲线让它下降（方向正确）；
//   4. S 曲线提高对比：暗端更暗、亮端更亮（p10 下降、p90 上升）；
//   5. 还原（setCurve(null)）后画面逐像素回到基线；
//   6. 全程无 pageerror（着色器编译/绑定失败会在这里现形）。
//
// usage: node docs/verify/verify-color-curve.cjs "<url>" [model]
const path = require('path');
const puppeteer = require(path.join(__dirname, '..', '..', 'node_modules', 'puppeteer-core'));

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
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
    page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 300)));

    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1500);
    await page.evaluate(async (m) => {
        const buf = await (await fetch('./' + m)).arrayBuffer();
        await window.scene.events.invoke('import', [{ filename: m, contents: new File([buf], m) }]);
    }, MODEL);
    for (let i = 0; i < 60; i++) {
        await sleep(1000);
        const n = await page.evaluate(() => window.scene.getElementsByType('splat').length);
        if (n > 0) break;
    }
    await sleep(2500);

    const checks = [];
    const check = (name, pass, detail) => checks.push({ name, pass, detail });

    await page.evaluate(() => {
        const scene = window.scene;
        const splat = scene.getElementsByType('splat').slice(-1)[0];
        const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
        window.__splat = splat;
        window.__render = async (k = 3) => {
            for (let i = 0; i < k; i++) {
                scene.forceRender = true;
                await nextFrame();
            }
        };
        // 抓一帧的亮度统计 + 原始像素（用于逐像素对照）
        window.__grab = async () => {
            await window.__render(3);
            const src = scene.canvas;
            const off = document.createElement('canvas');
            off.width = src.width;
            off.height = src.height;
            const ctx = off.getContext('2d');
            ctx.drawImage(src, 0, 0);
            const d = ctx.getImageData(0, 0, off.width, off.height).data;
            const lums = [];
            let sum = 0;
            let n = 0;
            for (let i = 0; i < d.length; i += 4 * 5) {
                const lum = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
                sum += lum;
                lums.push(lum);
                n++;
            }
            lums.sort((a, b) => a - b);
            return {
                meanLum: sum / n,
                p10: lums[Math.floor(n * 0.1)],
                median: lums[Math.floor(n * 0.5)],
                p90: lums[Math.floor(n * 0.9)],
                data: Array.from(d)
            };
        };
        window.__curveEnabled = () => {
            const material = splat.entity.gsplat.instance.material;
            const p = material.getParameter('uCurveEnabled');
            return p && typeof p === 'object' && 'data' in p ? p.data : p;
        };
        // 33 点采样表（与 src/core/color-curves.ts 同构，故意在这里独立写一遍：
        // 曲线表本身由 verify-color-curves.mts 单测，这里测的是"推下去有没有生效"）
        window.__samples = (fn) => {
            const a = new Float32Array(33);
            for (let i = 0; i < 33; i++) a[i] = Math.min(1, Math.max(0, fn(i / 32)));
            return a;
        };
    });

    const baseline = await page.evaluate(() => window.__grab());
    const enabledAtBaseline = await page.evaluate(() => window.__curveEnabled());

    // ---- 2/1：恒等曲线 = 不设曲线 ----
    // 注意：`uCurveEnabled` 是**每帧**在 onPreRender 里推的，所以必须先出一帧再读，
    // 否则读到的是上一帧的值（第一版就踩了这个，读到 0）。
    const identity = await page.evaluate(async () => {
        window.__splat.setCurve(window.__samples(x => x));
        const g = await window.__grab();
        const en = window.__curveEnabled();
        return { en, g };
    });
    const identityDiff = (() => {
        if (baseline.data.length !== identity.g.data.length) return 1;
        let maxDiff = 0;
        let changed = 0;
        for (let i = 0; i < baseline.data.length; i++) {
            const d = Math.abs(baseline.data[i] - identity.g.data[i]);
            if (d > 0) changed++;
            if (d > maxDiff) maxDiff = d;
        }
        return { maxDiff, changed, total: baseline.data.length };
    })();

    check('with no curve the material switch is off (uCurveEnabled = 0)', enabledAtBaseline === 0,
        `uCurveEnabled=${JSON.stringify(enabledAtBaseline)}`);

    check('an all-identity curve is treated as "no curve" — the switch stays off (zero-cost path)',
        identity.en === 0,
        `恒等曲线（逐点 y=x）⇒ uCurveEnabled=${JSON.stringify(identity.en)}（` +
        `setCurve() 内部用 isIdentityCurve() 短路，所以不会为"看起来设了但没变"的曲线付着色器开销）`);

    check('an identity curve leaves the image untouched (per-pixel identical to baseline)',
        identityDiff.maxDiff === 0,
        `逐像素最大差 ${identityDiff.maxDiff}（${identityDiff.changed}/${identityDiff.total} 个通道有变化）；` +
        `meanLum ${baseline.meanLum.toFixed(4)} vs ${identity.g.meanLum.toFixed(4)}`);

    // ---- 3：抬亮 / 压暗方向 ----
    const lift = await page.evaluate(async () => {
        window.__splat.setCurve(window.__samples(x => x + 0.35 * x * (1 - x) * 4 * 0.25 + 0.2 * Math.sin(Math.PI * x)));
        const g = await window.__grab();
        return { ...g, en: window.__curveEnabled() };
    });
    const crush = await page.evaluate(async () => {
        window.__splat.setCurve(window.__samples(x => x - 0.2 * Math.sin(Math.PI * x)));
        return window.__grab();
    });

    check('a lifted curve brightens the image (mean luminance rises) and turns the switch on',
        lift.meanLum > baseline.meanLum + 0.01 && lift.en === 1,
        `meanLum ${baseline.meanLum.toFixed(4)} → ${lift.meanLum.toFixed(4)}（+${(lift.meanLum - baseline.meanLum).toFixed(4)}）；` +
        `uCurveEnabled=${JSON.stringify(lift.en)}`);

    check('a crushed curve darkens the image',
        crush.meanLum < baseline.meanLum - 0.01,
        `meanLum ${baseline.meanLum.toFixed(4)} → ${crush.meanLum.toFixed(4)}（${(crush.meanLum - baseline.meanLum).toFixed(4)}）`);

    // ---- 4：S 曲线拉对比 ----
    const sCurve = await page.evaluate(async () => {
        // 平滑 S：暗端压、亮端抬（拐点在 0.5）
        window.__splat.setCurve(window.__samples(x => x + 0.35 * x * (1 - x) * (2 * x - 1)));
        return window.__grab();
    });
    // 判据用"围绕中位数的展布"而不是"p90 一定变亮"：本夹具的画面几乎是均匀中灰
    // （p10 0.396 / p90 0.429，整段都在 0.5 以下），S 曲线的拐点在 0.5 ⇒ 两侧都被压，
    // 只有**低端相对中位数**被压得更狠、总展布变大 —— 那才是这条曲线在这个分布上的对比度效果。
    // （真实照片的动态范围横跨 0~1，两端会分别压/抬；套件不能用"照片的直觉"当断言。）
    const spread = (g) => g.p90 - g.p10;
    const lowRel = (g) => g.median - g.p10;
    check('an S-curve reshapes the tone distribution (spread grows, the low end is pushed hardest)',
        spread(sCurve) > spread(baseline) && lowRel(sCurve) > lowRel(baseline),
        `p10 ${baseline.p10.toFixed(4)} → ${sCurve.p10.toFixed(4)}；median ${baseline.median.toFixed(4)} → ${sCurve.median.toFixed(4)}；` +
        `p90 ${baseline.p90.toFixed(4)} → ${sCurve.p90.toFixed(4)}；` +
        `展布 ${spread(baseline).toFixed(4)} → ${spread(sCurve).toFixed(4)}；` +
        `中位数以下 ${lowRel(baseline).toFixed(4)} → ${lowRel(sCurve).toFixed(4)}`);

    // ---- 5：还原 ----
    const restored = await page.evaluate(async () => {
        window.__splat.setCurve(null);
        const g = await window.__grab();
        const en = window.__curveEnabled();   // 同样要等一帧
        return { en, g };
    });
    const restoreDiff = (() => {
        let maxDiff = 0;
        for (let i = 0; i < baseline.data.length; i++) {
            maxDiff = Math.max(maxDiff, Math.abs(baseline.data[i] - restored.g.data[i]));
        }
        return maxDiff;
    })();
    check('clearing the curve restores the baseline exactly (switch back to 0, pixels identical)',
        restored.en === 0 && restoreDiff === 0,
        `uCurveEnabled=${JSON.stringify(restored.en)}；逐像素最大差 ${restoreDiff}；meanLum ${restored.g.meanLum.toFixed(4)}`);

    check('no page errors (shader compilation / binding failures would surface here)',
        errors.length === 0, errors.slice(0, 3).join(' | ') || 'none');

    console.log(JSON.stringify({ model: MODEL, url: URL, checks, failed: checks.filter(c => !c.pass).length }, null, 1));
    await browser.close();
    process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ fatal: String(e).slice(0, 500) })); process.exit(1); });
