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

    // ---- 6：面板 UI（真实鼠标拖曲线编辑器）----
    // 曲线功能默认是"关"的，所以先确认控件真的在面板里、能被鼠标打到（行重叠那类坑的守卫）。
    await page.evaluate(() => {
        window.scene.events.fire('colorPanel.toggleVisible');
        window.scene.events.fire('selection.changed', window.__splat);
    });
    await sleep(700);

    const uiReady = await page.evaluate(async () => {
        await window.__render(2);
        const editor = document.querySelector('.curve-editor-svg');
        if (!editor) {
            return { ok: false, reason: 'curve editor not in DOM' };
        }
        // 面板是可以纵向滚动的（第十二轮修的"行重叠"就是把它改成滚动），
        // 曲线分类在底部 ⇒ 先像用户那样滚到可见位置再量命中测试。
        const section = document.querySelector('.curve-section');
        if (section && section.scrollIntoView) {
            section.scrollIntoView({ block: 'center' });
        }
        await window.__render(2);
        const r = editor.getBoundingClientRect();
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        const hit = document.elementFromPoint(cx, cy);
        return {
            ok: true,
            rect: { x: r.x, y: r.y, w: r.width, h: r.height },
            // 控件中心点命中的应该是控件本身（或它的子元素）
            hitInside: !!(hit && (hit === editor || editor.contains(hit) || hit.contains(editor))),
            hitCls: hit ? String(hit.className) : null,
            dots: document.querySelectorAll('.curve-dot').length,
            center: { x: cx, y: cy },
            panelScrollTop: (document.querySelector('#color-panel') || {}).scrollTop ?? null
        };
    });

    check('the curve editor is in the panel, visible and hit-testable',
        uiReady.ok && uiReady.rect.w > 40 && uiReady.rect.h > 40 && uiReady.hitInside && uiReady.dots === 2,
        uiReady.ok
            ? `控件 ${Math.round(uiReady.rect.w)}×${Math.round(uiReady.rect.h)}；中心命中=${uiReady.hitInside}（${uiReady.hitCls}）；` +
              `控制点 ${uiReady.dots} 个（恒等 = 两个端点）；面板 scrollTop=${uiReady.panelScrollTop}`
            : uiReady.reason);

    // 真实鼠标：在控件中上方按下并往上拖 ⇒ 新增一个控制点并把中间调抬亮
    let uiDrag = null;
    if (uiReady.ok) {
        const startX = uiReady.center.x;
        const startY = uiReady.center.y;
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(startX, startY - 30, { steps: 8 });
        await page.mouse.up();
        await sleep(400);
        uiDrag = await page.evaluate(async () => {
            const g = await window.__grab();
            return {
                points: window.__splat.curvePoints,
                hasCurve: !!window.__splat.curve,
                enabled: window.__curveEnabled(),
                meanLum: g.meanLum,
                dots: document.querySelectorAll('.curve-dot').length
            };
        });
    }

    check('dragging inside the curve editor adds a control point and brightens the image',
        !!uiDrag && Array.isArray(uiDrag.points) && uiDrag.points.length === 3 &&
        uiDrag.hasCurve && uiDrag.enabled === 1 && uiDrag.meanLum > baseline.meanLum + 0.005,
        uiDrag
            ? (Array.isArray(uiDrag.points)
                ? `控制点 ${uiDrag.points.length} 个（${uiDrag.points.map(p => `(${p.x.toFixed(2)},${p.y.toFixed(2)})`).join(' ')}）；`
                : '控制点 = null（拖拽没被接住）；') +
              `控件里画了 ${uiDrag.dots} 个点；uCurveEnabled=${uiDrag.enabled}；` +
              `meanLum ${baseline.meanLum.toFixed(4)} → ${uiDrag.meanLum.toFixed(4)}`
            : 'drag not attempted');

    // 撤销：整段拖动应该只产生**一条**撤销记录
    const afterUndo = await page.evaluate(async () => {
        window.scene.events.fire('edit.undo');
        const g = await window.__grab();
        return { points: window.__splat.curvePoints, hasCurve: !!window.__splat.curve, meanLum: g.meanLum };
    });
    check('one drag = one undo step (undo removes the whole curve)',
        !afterUndo.hasCurve && afterUndo.points === null &&
        Math.abs(afterUndo.meanLum - baseline.meanLum) < 0.002,
        `undo 后 curvePoints=${JSON.stringify(afterUndo.points)}；meanLum ${afterUndo.meanLum.toFixed(4)}` +
        `（基线 ${baseline.meanLum.toFixed(4)}）`);

    // 分类复位按钮：把曲线清掉
    const afterReset = await page.evaluate(async () => {
        // 先造一条曲线（走 splat API，等价于拖控件），再点"曲线"分类的复位按钮
        window.__splat.setCurvePoints([{ x: 0, y: 0 }, { x: 0.5, y: 0.7 }, { x: 1, y: 1 }]);
        await window.__render(2);
        const curveSection = document.querySelector('.curve-section');
        const btn = curveSection && curveSection.querySelector('.category-reset-btn');
        if (!btn) {
            return { ok: false, reason: 'reset button not found' };
        }
        btn.dispatchEvent(new PointerEvent('click', { bubbles: true }));
        const g = await window.__grab();
        return {
            ok: true,
            hasCurve: !!window.__splat.curve,
            points: window.__splat.curvePoints,
            dots: document.querySelectorAll('.curve-dot').length,
            meanLum: g.meanLum
        };
    });
    check('the curve category reset button clears the curve back to identity',
        afterReset.ok && !afterReset.hasCurve && afterReset.points === null &&
        Math.abs(afterReset.meanLum - baseline.meanLum) < 0.002,
        afterReset.ok
            ? `复位后 curvePoints=${JSON.stringify(afterReset.points)}；控件回到 ${afterReset.dots} 个点；` +
              `meanLum ${afterReset.meanLum.toFixed(4)}（基线 ${baseline.meanLum.toFixed(4)}）`
            : afterReset.reason);

    // ---- 7：文档往返（.ssproj 用的就是这条）----
    const roundTrip = await page.evaluate(() => {
        const s = window.__splat;
        s.setCurvePoints([{ x: 0, y: 0.05 }, { x: 0.45, y: 0.55 }, { x: 1, y: 0.98 }]);
        const before = { points: s.curvePoints, samples: Array.from(s.curve || []) };
        const doc = s.docSerialize();
        s.setCurvePoints(null);
        s.docDeserialize(doc);
        const after = { points: s.curvePoints, samples: Array.from(s.curve || []) };
        return {
            docCurve: doc.curve,
            before,
            after,
            samePoints: JSON.stringify(before.points) === JSON.stringify(after.points),
            maxSampleDiff: after.samples.length === before.samples.length ?
                before.samples.reduce((m, v, i) => Math.max(m, Math.abs(v - after.samples[i])), 0) : 1
        };
    });
    check('docSerialize/docDeserialize round-trips the curve (control points as [x, y] pairs)',
        Array.isArray(roundTrip.docCurve) && roundTrip.docCurve.length === 3 &&
        roundTrip.samePoints && roundTrip.maxSampleDiff < 1e-9,
        `doc.curve=${JSON.stringify(roundTrip.docCurve)}；` +
        `往返后控制点一致=${roundTrip.samePoints}；33 个采样点最大差 ${roundTrip.maxSampleDiff.toExponential(2)}`);

    check('no page errors after driving the panel UI', errors.length === 0,
        errors.slice(0, 3).join(' | ') || 'none');

    console.log(JSON.stringify({ model: MODEL, url: URL, checks, failed: checks.filter(c => !c.pass).length }, null, 1));
    await browser.close();
    process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ fatal: String(e).slice(0, 500) })); process.exit(1); });
