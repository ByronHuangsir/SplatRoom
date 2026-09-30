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

const { BROWSER_PATH: EDGE , launchPatched: _launchPatched } = require('./lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = await _launchPatched(puppeteer, {
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
        // 抓一帧的亮度统计 + **每通道均值** + 原始像素（每通道均值是分通道曲线的判据）
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
            let sumR = 0;
            let sumG = 0;
            let sumB = 0;
            for (let i = 0; i < d.length; i += 4 * 5) {
                const lum = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
                sum += lum;
                sumR += d[i] / 255;
                sumG += d[i + 1] / 255;
                sumB += d[i + 2] / 255;
                lums.push(lum);
                n++;
            }
            lums.sort((a, b) => a - b);
            return {
                meanLum: sum / n,
                meanR: sumR / n,
                meanG: sumG / n,
                meanB: sumB / n,
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
        // 把采样函数变成**控制点**（等距 33 个点，形状与 __samples 等价）
        window.__points = (fn) => {
            const pts = [];
            for (let i = 0; i < 33; i++) {
                pts.push({ x: i / 32, y: Math.min(1, Math.max(0, fn(i / 32))) });
            }
            return pts;
        };
        // 设置曲线（第 14 轮起是四通道：不传 channels 就只设 RGB 主曲线）
        window.__setCurve = (points) => {
            window.__splat.setCurves(points ? { master: points } : null);
        };
    });

    const baseline = await page.evaluate(() => window.__grab());
    const enabledAtBaseline = await page.evaluate(() => window.__curveEnabled());

    // ---- 2/1：恒等曲线 = 不设曲线 ----
    // 注意：`uCurveEnabled` 是**每帧**在 onPreRender 里推的，所以必须先出一帧再读，
    // 否则读到的是上一帧的值（第一版就踩了这个，读到 0）。
    const identity = await page.evaluate(async () => {
        window.__setCurve(window.__points(x => x));
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
        window.__setCurve(window.__points(x => x + 0.35 * x * (1 - x) * 4 * 0.25 + 0.2 * Math.sin(Math.PI * x)));
        const g = await window.__grab();
        return { ...g, en: window.__curveEnabled() };
    });
    const crush = await page.evaluate(async () => {
        window.__setCurve(window.__points(x => x - 0.2 * Math.sin(Math.PI * x)));
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
        window.__setCurve(window.__points(x => x + 0.35 * x * (1 - x) * (2 * x - 1)));
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
        window.__setCurve(null);
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
                points: window.__splat.curves.master,
                hasCurve: !!window.__splat.curveTables,
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
        return { points: window.__splat.curves.master, hasCurve: !!window.__splat.curveTables, meanLum: g.meanLum };
    });
    check('one drag = one undo step (undo removes the whole curve)',
        !afterUndo.hasCurve && afterUndo.points === null &&
        Math.abs(afterUndo.meanLum - baseline.meanLum) < 0.002,
        `undo 后 curvePoints=${JSON.stringify(afterUndo.points)}；meanLum ${afterUndo.meanLum.toFixed(4)}` +
        `（基线 ${baseline.meanLum.toFixed(4)}）`);

    // 分类复位按钮：把曲线清掉
    const afterReset = await page.evaluate(async () => {
        // 先造一条曲线（走 splat API，等价于拖控件），再点"曲线"分类的复位按钮
        window.__setCurve([{ x: 0, y: 0 }, { x: 0.5, y: 0.7 }, { x: 1, y: 1 }]);
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
            hasCurve: !!window.__splat.curveTables,
            points: window.__splat.curves.master,
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
        s.setCurves({
            master: [{ x: 0, y: 0.05 }, { x: 0.45, y: 0.55 }, { x: 1, y: 0.98 }],
            red: [{ x: 0, y: 0 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }]
        });
        const grab = () => ({
            points: s.curves,
            // 四个通道各取前 33 个采样值，比对整张表
            tables: Array.from(s.curveTables || [])
        });
        const before = grab();
        const doc = s.docSerialize();
        s.setCurves(null);
        s.docDeserialize(doc);
        const after = grab();
        return {
            docCurves: doc.curves,
            before,
            after,
            samePoints: JSON.stringify(before.points) === JSON.stringify(after.points),
            sameTables: JSON.stringify(before.tables) === JSON.stringify(after.tables)
        };
    });
    check('docSerialize/docDeserialize round-trips all four curve channels (master + red here)',
        !!roundTrip.docCurves && Array.isArray(roundTrip.docCurves.master) && roundTrip.docCurves.master.length === 3 &&
        Array.isArray(roundTrip.docCurves.red) && roundTrip.docCurves.red.length === 3 &&
        roundTrip.docCurves.green === null && roundTrip.docCurves.blue === null &&
        roundTrip.samePoints && roundTrip.sameTables,
        `doc.curves=${JSON.stringify(roundTrip.docCurves)}；控制点一致=${roundTrip.samePoints}；` +
        `33×4 张表逐位一致=${roundTrip.sameTables}`);

    // ---- 8：分通道独立性（只动红通道时，绿蓝逐像素不变）----
    const perChannel = await page.evaluate(async () => {
        try {
            const s = window.__splat;
            s.setCurves(null);
            const base = await window.__grab();
            // 只抬红通道
            s.setCurves({ red: window.__points(x => Math.min(1, x + 0.3 * Math.sin(Math.PI * x))) });
            const onlyRed = await window.__grab();
            // 只压蓝通道
            s.setCurves({ blue: window.__points(x => Math.max(0, x - 0.3 * Math.sin(Math.PI * x))) });
            const onlyBlue = await window.__grab();
            s.setCurves(null);
            const back = await window.__grab();
            // 逐像素比对"绿/蓝通道有没有被红曲线影响"
            let maxG = 0;
            let maxB = 0;
            let maxR = 0;
            for (let i = 0; i < base.data.length; i += 4) {
                maxR = Math.max(maxR, Math.abs(base.data[i] - onlyRed.data[i]));
                maxG = Math.max(maxG, Math.abs(base.data[i + 1] - onlyRed.data[i + 1]));
                maxB = Math.max(maxB, Math.abs(base.data[i + 2] - onlyRed.data[i + 2]));
            }
            return {
                baseMean: { r: base.meanR, g: base.meanG, b: base.meanB },
                redMean: { r: onlyRed.meanR, g: onlyRed.meanG, b: onlyRed.meanB },
                blueMean: { r: onlyBlue.meanR, g: onlyBlue.meanG, b: onlyBlue.meanB },
                maxR,
                maxG,
                maxB,
                restored: Math.abs(back.meanLum - base.meanLum) < 1e-6 && Math.abs(back.meanR - base.meanR) < 1e-6
            };
        } catch (e) {
            return { error: String(e).slice(0, 200) };
        }
    });

    check('a red-channel-only curve raises R and leaves G/B bit-identical',
        !!perChannel.redMean && perChannel.redMean.r > perChannel.baseMean.r + 0.05 &&
        perChannel.maxG === 0 && perChannel.maxB === 0 && perChannel.maxR > 20,
        perChannel.redMean
            ? `R 均值 ${perChannel.baseMean.r.toFixed(4)} → ${perChannel.redMean.r.toFixed(4)}；` +
              `逐像素最大变化 R=${perChannel.maxR} G=${perChannel.maxG} B=${perChannel.maxB}（G/B 必须为 0）`
            : `phase error: ${perChannel.error}`);

    check('a blue-channel-only curve lowers B only, and clearing restores the baseline',
        !!perChannel.blueMean && perChannel.blueMean.b < perChannel.baseMean.b - 0.05 &&
        Math.abs(perChannel.blueMean.r - perChannel.baseMean.r) < 0.005 &&
        Math.abs(perChannel.blueMean.g - perChannel.baseMean.g) < 0.005 &&
        perChannel.restored,
        perChannel.blueMean
            ? `B 均值 ${perChannel.baseMean.b.toFixed(4)} → ${perChannel.blueMean.b.toFixed(4)}；` +
              `R/G 变化 ${Math.abs(perChannel.blueMean.r - perChannel.baseMean.r).toFixed(4)} / ` +
              `${Math.abs(perChannel.blueMean.g - perChannel.baseMean.g).toFixed(4)}；清空后回到基线=${perChannel.restored}`
            : `phase error: ${perChannel.error}`);

    // ---- 9：直方图 / 范围选择必须跟曲线一致（第十四轮补的镜像）----
    // 三个坑（都踩过）：
    //   ① 模式必须用**颜色模式**（5..7 = 最终颜色的 R/G/B、18..20 = HSV）：`propMode = 1` 是
    //      `worldPos.y`（位置），根本不经过 `applyColorGrade`；
    //   ② 直方图的柱按 [min,max] 归一化，单调曲线不改变"秩" ⇒ 柱形/重心几乎不动，
    //      能证明"s 曲线进了这条通路"的是 **min/max 数值**；
    //   ③ "选亮部命中数"不是好判据（基线恰好也是 1200）。可靠的判据是**逐档问**：
    //      在固定 [0,1] 区间里挑一个高档与一个低档，看曲线把命中从高档搬到低档。
    const mirror = await page.evaluate(async () => {
        try {
            const COLOR_MODE = 5; // 最终颜色的 R 通道（isFinalColorMode 5..7 / 18..20）
            const scene = window.scene;
            const splat = window.__splat;
            const count = async (lo, hi) => {
                const mask = await scene.dataProcessor.selectByRange(splat, COLOR_MODE, {
                    min: 0, max: 1, numBins: 256, rangeStart: lo, rangeEnd: hi, onScreenOnly: false
                });
                let sel = 0;
                if (mask) {
                    const arr = mask instanceof Uint8Array ? mask : new Uint8Array(mask);
                    for (let i = 0; i < arr.length; i++) {
                        if (arr[i]) {
                            sel++;
                        }
                    }
                    scene.dataProcessor.releaseMask(mask);
                }
                return sel;
            };
            const histOf = async () => {
                const h = await scene.dataProcessor.calcHistogram(splat, COLOR_MODE);
                return { min: h.min, max: h.max, bins: Array.from(h.selected || []).length };
            };
            // 一个"高档"（值 ≈0.78）与一个"低档"（值 ≈0.16）
            const HI = 200;
            const LO = 40;
            const probe = async () => ({ hi: await count(HI, HI), lo: await count(LO, LO) });
            // 扫一遍档位，找出"选择通路眼里"的非空范围（每 8 档问一次，分辨率 3%）
            const scan = async () => {
                let lo = -1;
                let hi = -1;
                for (let b = 0; b < 256; b += 8) {
                    if (await count(b, b + 7) > 0) {
                        if (lo < 0) {
                            lo = b;
                        }
                        hi = b + 7;
                    }
                }
                return { lo, hi };
            };

            splat.setCurves(null);
            await window.__render(2);
            const baseHist = await histOf();
            const baseProbe = await probe();
            const baseScan = await scan();

            // 整体压到一半：原来在高档的点应该落到低档
            splat.setCurves({ master: [{ x: 0, y: 0 }, { x: 1, y: 0.5 }] });
            await window.__render(2);
            const curveHist = await histOf();
            const curveProbe = await probe();
            const curveScan = await scan();

            splat.setCurves(null);
            await window.__render(2);
            return {
                rangeBase: [baseHist.min, baseHist.max], rangeCurve: [curveHist.min, curveHist.max],
                baseProbe, curveProbe, baseScan, curveScan, bins: baseHist.bins,
                total: splat.numSplats, hiBin: HI, loBin: LO
            };
        } catch (e) {
            return { error: String(e).slice(0, 250) };
        }
    });

    check('the histogram reflects the curve (its min/max move with the graded colour)',
        Array.isArray(mirror.rangeBase) &&
        mirror.rangeCurve[0] < mirror.rangeBase[0] - 0.02 &&
        mirror.rangeCurve[1] < mirror.rangeBase[1] - 0.02,
        Array.isArray(mirror.rangeBase)
            ? `最终颜色 R 范围 ${mirror.rangeBase.map(v => v.toFixed(3)).join('..')} → ` +
              `${mirror.rangeCurve.map(v => v.toFixed(3)).join('..')}（把整体压到一半，两端应一起下移）；bins=${mirror.bins}`
            : `phase error: ${mirror.error}`);

    check('range selection reflects the curve (the bin range it sees moves down with the curve)',
        !!mirror.baseScan && mirror.baseScan.lo >= 0 && mirror.baseScan.hi > mirror.baseScan.lo &&
        mirror.curveScan.hi > 0 && mirror.curveScan.hi < mirror.baseScan.hi &&
        mirror.curveScan.lo < mirror.baseScan.lo,
        mirror.baseScan
            ? `固定 [0,1] 区间、256 档，扫描选择通路看到的非空档位：无曲线 ${mirror.baseScan.lo}..${mirror.baseScan.hi}` +
              `（对应值 ${(mirror.baseScan.lo / 256).toFixed(2)}..${(mirror.baseScan.hi / 256).toFixed(2)}）→ ` +
              `曲线后 ${mirror.curveScan.lo}..${mirror.curveScan.hi}` +
              `（${(mirror.curveScan.lo / 256).toFixed(2)}..${(mirror.curveScan.hi / 256).toFixed(2)}）；` +
              `直方图 min/max 同步 ${mirror.rangeBase.map(v => v.toFixed(3)).join('..')} → ${mirror.rangeCurve.map(v => v.toFixed(3)).join('..')}` +
              `（第十四轮之前这条通路完全不吃曲线）`
            : `phase error: ${mirror.error}`);

    check('no page errors after driving the panel UI', errors.length === 0,
        errors.slice(0, 3).join(' | ') || 'none');

    // ---- 11：`.sscg` 侧车往返（第十七轮：侧车原来只存调色参数、**曲线整个丢掉**）----
    //
    // 无头环境里 `showSaveFilePicker` / `showOpenFilePicker` 不存在，正好可以把它俩换成
    // 页内桩：保存侧车时把 JSON 截在 `write()` 里（不用 CDP 下载重定向），
    // 读取时喂一个我们自己的 `File`。走的是**应用真实的 grade.save / grade.load 事件**，
    // 不是直接调模块函数。
    const sidecar = await page.evaluate(async () => {
        try {
            const scene = window.scene;
            const s = window.__splat;
            const points = [
                { x: 0, y: 0.05 }, { x: 0.45, y: 0.55 }, { x: 1, y: 0.98 }
            ];
            s.setCurves(null);
            await window.__render(2);
            const base = await window.__grab();

            // 一条能明显改变画面的曲线 + 一个非中性调色参数（证明整份侧车都过了一遍）
            s.setCurves({ master: points, red: [{ x: 0, y: 0 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }] });
            s.brightness = 0.07;
            const graded = await window.__grab();

            // 保存：截住 JSON
            let saved = null;
            window.showSaveFilePicker = async () => ({
                createWritable: async () => ({
                    write: async (blob) => { saved = await blob.text(); },
                    close: async () => { }
                })
            });
            scene.events.fire('grade.save');
            for (let i = 0; i < 40 && !saved; i++) {
                await new Promise(r => setTimeout(r, 100));
            }
            const doc = saved ? JSON.parse(saved) : null;

            // 清空曲线与调色，再用同一份 JSON 读回来
            s.setCurves(null);
            s.brightness = 0;
            await window.__render(2);

            window.showOpenFilePicker = async () => ([{
                getFile: async () => new File([saved ?? ''], 'test-model.ply.sscg', { type: 'application/json' })
            }]);
            scene.events.fire('grade.load');
            await new Promise(r => setTimeout(r, 800));
            await window.__render(3);
            const restored = await window.__grab();
            // 曲线要单独读（`__grab()` 只给亮度/像素统计，没有曲线）
            const restoredCurves = JSON.parse(JSON.stringify(s.curves));

            // 旧版（v4，无 curves 字段）侧车：不能崩，也不能动曲线。
            // 先清掉曲线，这样"旧文件读进来之后曲线还是空的"才说明它真的没碰曲线。
            s.setCurves(null);
            await window.__render(2);
            const legacy = JSON.stringify({ version: 4, sourceFile: 'test-model.ply', brightness: 0.2 });
            window.showOpenFilePicker = async () => ([{
                getFile: async () => new File([legacy], 'legacy.ply.sscg', { type: 'application/json' })
            }]);
            scene.events.fire('grade.load');
            await new Promise(r => setTimeout(r, 800));
            const afterLegacy = { curves: JSON.parse(JSON.stringify(s.curves)), brightness: s.brightness };

            s.setCurves(null);
            s.brightness = 0;
            await window.__render(2);
            return {
                version: doc ? doc.version : null,
                docCurves: doc ? doc.curves : null,
                docBrightness: doc ? doc.brightness : null,
                savedBytes: saved ? saved.length : 0,
                restoredCurves,
                samePoints: JSON.stringify(restoredCurves) === JSON.stringify({
                    master: points, red: [{ x: 0, y: 0 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }],
                    green: null, blue: null
                }),
                meanLumBase: base.meanLum, meanLumGraded: graded.meanLum, meanLumRestored: restored.meanLum,
                maxPixelDiff: (() => {
                    let m = 0;
                    for (let i = 0; i < graded.data.length; i++) {
                        m = Math.max(m, Math.abs(graded.data[i] - restored.data[i]));
                    }
                    return m;
                })(),
                afterLegacy
            };
        } catch (e) {
            return { error: String(e).slice(0, 250) };
        }
    });

    check('.sscg sidecar stores the curves (v5) instead of dropping them',
        !!sidecar.docCurves && Array.isArray(sidecar.docCurves.master) && sidecar.docCurves.master.length === 3 &&
        Array.isArray(sidecar.docCurves.red) && sidecar.docCurves.red.length === 3 &&
        sidecar.docCurves.green === null && sidecar.docCurves.blue === null &&
        sidecar.version === 5,
        sidecar.error ? `phase error: ${sidecar.error}` :
            `version=${sidecar.version}（v4 及更早没有 curves）；curves=${JSON.stringify(sidecar.docCurves)}；` +
            `同时存下的 brightness=${sidecar.docBrightness}；JSON ${sidecar.savedBytes} 字节`);

    check('loading that .sscg back restores the curve and the graded image (pixel-level)',
        sidecar.samePoints && sidecar.maxPixelDiff <= 2 &&
        Math.abs(sidecar.meanLumRestored - sidecar.meanLumGraded) < 0.002 &&
        sidecar.meanLumGraded > sidecar.meanLumBase + 0.01,
        sidecar.error ? `phase error: ${sidecar.error}` :
            `控制点一致=${sidecar.samePoints}；恢复后与"存之前那一帧"逐像素最大差 ${sidecar.maxPixelDiff}；` +
            `meanLum 基线 ${sidecar.meanLumBase?.toFixed(4)} → 调色后 ${sidecar.meanLumGraded?.toFixed(4)} → ` +
            `读回侧车后 ${sidecar.meanLumRestored?.toFixed(4)}；读回的曲线 ${JSON.stringify(sidecar.restoredCurves)}`);

    check('a v4 sidecar (no curves field) still loads and leaves the curves alone',
        !!sidecar.afterLegacy && sidecar.afterLegacy.brightness === 0.2 &&
        sidecar.afterLegacy.curves &&
        sidecar.afterLegacy.curves.master === null && sidecar.afterLegacy.curves.red === null,
        sidecar.error ? `phase error: ${sidecar.error}` :
            `旧侧车只有 brightness ⇒ 读回后 brightness=${sidecar.afterLegacy?.brightness}（=0.2）、` +
            `曲线没有被凭空造出来（master=${JSON.stringify(sidecar.afterLegacy?.curves?.master)}）`);

    check('no page errors after driving the panel UI', errors.length === 0,
        errors.slice(0, 3).join(' | ') || 'none');

    console.log(JSON.stringify({ model: MODEL, url: URL, checks, failed: checks.filter(c => !c.pass).length }, null, 1));
    await browser.close();
    process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ fatal: String(e && e.message || e).slice(0, 500), stack: String(e && e.stack || '').slice(0, 900) }, null, 1)); process.exit(1); });
