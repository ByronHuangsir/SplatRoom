// 调色"黑场/白场"数值范围护栏（2026-09-21）。
//
// 用户报「黑场拉到底变成过曝了」。实测两条**叠加**的 bug（`docs/probes/grade-blackpoint.cjs` 复现）：
//
//  ① **映射范围可以变成 0**：UI 黑场滑块反向映射 `blackPoint = -sliderB`（−1..1）、白场
//     `whitePoint = 2 - sliderW`（0..2），旧护栏只保证 `whitePoint - blackPoint >= 0`，
//     **等号可达**：默认白场滑块 1 时把黑场滑块拉到 −1 正好落在该边界。而视口那条公式是
//     `denom = max(0.001, whitePoint - blackPoint)` ⇒ **scale = 1000**（实测冲白像素 98.9%）。
//  ② **offset 没乘 scale**：层级映射本应是 `(color - lo) / (hi - lo)`，即 `offset = -lo * scale`；
//     旧代码写的是 `-lo`。于是范围 ≠ 1 时"压黑场"会把中间调整体抬亮（实测平均亮度
//     0.29 → 0.58 → 0.99 一路**变亮**），这才是"拉到底变过曝"更根本的那一半。
//  另外直方图（`calc-histogram.ts`）与范围选择（`select-by-range.ts`）里是**裸的**
//  `1 / (whitePoint - blackPoint)`：相等时 `Infinity`、交叉时负数 ⇒ 那两条 GPU 通路拿到 Inf/NaN。
//
// 本套件断言（全部通过真实的 splat 材质参数与真实像素，不复制公式）：
//   1. 关键帧…（无关）—— 沿黑场滑块扫一遍：**平均亮度单调下降**，且每一步都不冲白；
//   2. 极端值（含 UI 够不到的范围 0）：scale 有界（≤ 1/MIN_TONE_RANGE）、offset = -lo*scale、
//      画面变**黑**而不是变白；
//   3. 交叉（白场 < 黑场，`.ssproj` 可直接给出）：与有序公式一致（视口 == 导出），不过曝；
//   4. 材质参数全程有限（无 NaN/Inf）；
//   5. UI 护栏：真实鼠标把"黑场"标签拖到最左端后 `whitePoint - blackPoint >= MIN_TONE_RANGE`
//      （并顺带守住"面板行不重叠、标签可命中"这个 2026-09-21 新查出的布局缺陷）；
//   6. 直方图 / 范围选择在退化参数下不抛错、不产生 NaN（真实调用 dataProcessor）。
//
// usage: node docs/verify/verify-tone-range.cjs "<url>" [model]
const path = require('path');
const puppeteer = require(path.join(__dirname, '..', '..', 'node_modules', 'puppeteer-core'));

const { BROWSER_PATH: EDGE , launchPatched: _launchPatched } = require('./lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const MIN_TONE_RANGE = 0.05;
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
    page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 200)));

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
    await sleep(3000);

    const checks = [];
    const check = (name, pass, detail) => checks.push({ name, pass, detail });

    try {
        // ---- hook：把"量一张画面 + 读材质参数"封装进页面 ----
        await page.evaluate(async () => {
            const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
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
            scene.events.fire('camera.focus');
            await sleep2(2500);
            splat.colorGradeEnabled = true;
            // 关掉会干扰亮度统计的东西
            splat.saturation = 1;
            splat.brightness = 0;
            splat.temperature = 0;
            splat.tintClr = splat.tintClr.clone();
            await window.__render(4);

            window.__stats = async () => {
                await window.__render(2);
                const src = scene.canvas;
                const off = document.createElement('canvas');
                off.width = src.width;
                off.height = src.height;
                const ctx = off.getContext('2d');
                ctx.drawImage(src, 0, 0);
                const d = ctx.getImageData(0, 0, off.width, off.height).data;
                let sum = 0;
                let n = 0;
                let blown = 0;
                let black = 0;
                for (let i = 0; i < d.length; i += 4 * 3) {
                    const lum = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
                    sum += lum;
                    n++;
                    if (lum > 0.98) blown++;
                    if (lum < 0.02) black++;
                }
                return { meanLum: sum / n, blownPct: (blown / n) * 100, blackPct: (black / n) * 100 };
            };
            window.__params = () => {
                const material = splat.entity.gsplat.instance.material;
                const pick = (name) => {
                    const p = material.getParameter(name);
                    const v = p && typeof p === 'object' && 'data' in p ? p.data : p;
                    return Array.isArray(v) ? v : v;
                };
                const sc = pick('clrScale');
                const of = pick('clrOffset');
                return {
                    scale: sc ? sc[0] : null,
                    offset: of ? of[0] : null,
                    finite: !!(sc && of) && Number.isFinite(sc[0]) && Number.isFinite(of[0])
                };
            };
            window.__set = async (bp, wp) => {
                splat.blackPoint = bp;
                splat.whitePoint = wp;
                await window.__render(3);
            };
            window.__restore = async () => {
                splat.blackPoint = 0;
                splat.whitePoint = 1;
                await window.__render(3);
            };
        });

        // ---- 1/2/4：沿黑场滑块扫一遍（含 UI 够不到的极端）----
        const sweep = await page.evaluate(async () => {
            const rows = [];
            // 模拟 UI 护栏的联动（黑场滑块 b → blackPoint=-b；必要时把白场推上去）
            let whiteSlider = 1;
            for (const b of [0, -0.25, -0.5, -0.75, -0.9, -0.99, -1]) {
                if (b <= whiteSlider - 2) {
                    whiteSlider = b + 2;
                }
                await window.__set(-b, 2 - whiteSlider);
                const st = await window.__stats();
                rows.push({
                    blackSlider: b,
                    blackPoint: -b,
                    whitePoint: 2 - whiteSlider,
                    ...window.__params(),
                    meanLum: +st.meanLum.toFixed(4),
                    blownPct: +st.blownPct.toFixed(2),
                    blackPct: +st.blackPct.toFixed(2)
                });
            }
            // UI 够不到的极端：范围真的为 0（只可能来自文档/.ssproj）
            await window.__set(1, 1);
            const degenerate = { ...(await window.__stats()), ...window.__params() };
            // 交叉
            await window.__set(1.2, 0.8);
            const crossed = { ...(await window.__stats()), ...window.__params() };
            await window.__restore();
            return { rows, degenerate, crossed };
        });

        const monotonic = sweep.rows.every((r, i) => i === 0 || r.meanLum <= sweep.rows[i - 1].meanLum + 0.005);
        const noBlow = sweep.rows.every(r => r.blownPct < 1);
        check('sweeping the black point down darkens the image monotonically (no reversal into blow-out)',
            monotonic && noBlow,
            `meanLum: ${sweep.rows.map(r => r.meanLum.toFixed(3)).join(' -> ')}; ` +
            `max blown ${Math.max(...sweep.rows.map(r => r.blownPct)).toFixed(2)}% ` +
            `(before the fix the tail read 0.994 with 98.9% blown)`);

        const lastRow = sweep.rows[sweep.rows.length - 1];
        check('black point at its limit crushes the image to black (not white)',
            lastRow.blackPct > 50 && lastRow.blownPct < 1,
            `blackSlider=${lastRow.blackSlider} range=${(lastRow.whitePoint - lastRow.blackPoint).toFixed(3)} ` +
            `scale=${lastRow.scale} offset=${lastRow.offset} black=${lastRow.blackPct}% blown=${lastRow.blownPct}%`);

        check('the mapping scale stays bounded and offset is -lo*scale (levels mapping)',
            sweep.rows.every((r) => {
                const lo = Math.min(r.blackPoint, r.whitePoint);
                const range = Math.max(MIN_TONE_RANGE, Math.abs(r.whitePoint - r.blackPoint));
                return Number.isFinite(r.scale) && r.scale <= 1 / MIN_TONE_RANGE + 1e-6 &&
                    Math.abs(r.offset - (-lo * (1 / range))) < 1e-4;
            }),
            `scales: ${sweep.rows.map(r => r.scale.toFixed(2)).join(', ')} (cap ${(1 / MIN_TONE_RANGE).toFixed(0)}), ` +
            `offsets: ${sweep.rows.map(r => Number(r.offset).toFixed(2)).join(', ')}`);

        // ---- 3b：另一端（白场滑块拉到底）—— 语义上就是"冲白"，但必须同样有界 ----
        // UI 护栏：whiteSlider - blackSlider <= 2 - MIN_TONE_RANGE；超了抬黑场滑块。
        // 用途：① 证明"另一端"不是另一处过曝 bug；② 把"有界 + 单调"这条不变量钉在两侧。
        const whiteSweep = await page.evaluate(async () => {
            const rows = [];
            let blackSlider = 0;
            for (const w of [1, 1.25, 1.5, 1.75, 1.95, 2]) {
                if (w - blackSlider > 2 - 0.05) {
                    blackSlider = w - (2 - 0.05);
                }
                await window.__set(-blackSlider, 2 - w);
                const st = await window.__stats();
                rows.push({
                    whiteSlider: w,
                    blackSlider: +blackSlider.toFixed(2),
                    blackPoint: -blackSlider,
                    whitePoint: 2 - w,
                    range: Math.abs(2 - w - (-blackSlider)),
                    ...window.__params(),
                    meanLum: +st.meanLum.toFixed(4),
                    blownPct: +st.blownPct.toFixed(2)
                });
            }
            await window.__restore();
            return rows;
        });
        const wLast = whiteSweep[whiteSweep.length - 1];
        check('the other end (white point at its limit) brightens monotonically and stays bounded too',
            whiteSweep.every((r, i) => i === 0 || r.meanLum >= whiteSweep[i - 1].meanLum - 0.005) &&
            whiteSweep.every(r => Number.isFinite(r.scale) && r.scale <= 1 / MIN_TONE_RANGE + 1e-6) &&
            Math.abs(wLast.offset - (-Math.min(wLast.blackPoint, wLast.whitePoint) * wLast.scale)) < 1e-4,
            `meanLum: ${whiteSweep.map(r => r.meanLum.toFixed(3)).join(' -> ')}; ` +
            `scales: ${whiteSweep.map(r => r.scale.toFixed(2)).join(', ')} (cap ${(1 / MIN_TONE_RANGE).toFixed(0)}); ` +
            `blown: ${whiteSweep.map(r => `${r.blownPct}%`).join(', ')} — ` +
            `白场到底 = 冲白是**设计语义**，这里守的是"scale 有界、单调、offset 仍 = -lo*scale"`);

        check('degenerate range (blackPoint == whitePoint, unreachable from the UI) stays finite and crushes to black',
            sweep.degenerate.finite && sweep.degenerate.scale <= 1 / MIN_TONE_RANGE + 1e-6 &&
            sweep.degenerate.blownPct < 1 && sweep.degenerate.blackPct > 50,
            `scale=${sweep.degenerate.scale} offset=${sweep.degenerate.offset} ` +
            `meanLum=${sweep.degenerate.meanLum.toFixed(4)} black=${sweep.degenerate.blackPct.toFixed(1)}% ` +
            `blown=${sweep.degenerate.blownPct.toFixed(2)}%`);

        check('crossed range (whitePoint < blackPoint, e.g. from a .ssproj) matches the ordered formula and does not blow out',
            sweep.crossed.finite && Math.abs(sweep.crossed.scale - 2.5) < 1e-3 &&
            Math.abs(sweep.crossed.offset - (-2)) < 1e-3 && sweep.crossed.blownPct < 1,
            `scale=${sweep.crossed.scale} (ordered formula expects 2.5) offset=${sweep.crossed.offset} ` +
            `(expects -2) meanLum=${sweep.crossed.meanLum.toFixed(4)} blown=${sweep.crossed.blownPct.toFixed(2)}% — ` +
            `before the fix the viewport read scale=1000 / 98.9% blown while export read 2.5`);

        // ---- 5：UI 护栏（把黑场"拉到底"）----
        // 三个前提（缺一个就会空过，所以本检查自己把它们断言出来）：
        //   ① 颜色面板是 `hidden: true` 创建的，要先 `colorPanel.toggleVisible`；
        //   ② 面板的 `selected` 由 `selection.changed` 事件赋值 —— 先选中 splat；
        //   ③ 数值是**在标签上横向拖拽**微调（`attachScrub`，2px/步），标签必须真的能被鼠标打到。
        //      2026-09-21 顺手查出**行重叠**缺陷：分区默认可收缩 + 面板 `overflow: hidden`，
        //      窗口高度不足（实测 1280x800）时"黑场"行溢出自己分区 56px，被下一个分区的容器盖住，
        //      于是 `elementFromPoint` 落在容器而不是标签上 —— 这一行**根本拖不动**。
        //      CSS 已修（分区 flex: 0 0 auto + 面板 overflow-y: auto），这里一并守住。
        await page.evaluate(() => {
            const scene = window.scene;
            const splat = window.__splat;
            splat.blackPoint = 0;
            splat.whitePoint = 1;
            scene.events.fire('colorPanel.toggleVisible');
            scene.events.fire('selection', splat);
            scene.events.fire('selection.changed', splat); // 同时把滑块同步回 0/1 并打开 color-grade
        });
        await sleep(700);

        const layout = await page.evaluate(async () => {
            await window.__render(2);
            const panel = document.querySelector('#color-panel');
            const rows = Array.from(panel.querySelectorAll('.color-panel-row'))
                .filter(r => r.getBoundingClientRect().height > 1);
            const overflowing = [];
            rows.forEach((r) => {
                const content = r.closest('.color-panel-category-content');
                if (!content) return;
                const over = r.getBoundingClientRect().bottom - content.getBoundingClientRect().bottom;
                if (over > 0.5) {
                    overflowing.push({ text: (r.querySelector('.color-panel-row-label').textContent || '').trim(), over: +over.toFixed(1) });
                }
            });
            const row = rows.find(r => (r.querySelector('.color-panel-row-label').textContent || '').includes('黑场'));
            if (!row) {
                return { ok: false, reason: 'black-point row not found', labels: rows.map(r => (r.querySelector('.color-panel-row-label').textContent || '').trim()).slice(0, 24) };
            }
            const label = row.querySelector('.color-panel-row-label');
            const rect = label.getBoundingClientRect();
            const x = rect.x + rect.width / 2;
            const y = rect.y + rect.height / 2;
            const hit = document.elementFromPoint(x, y);
            return {
                ok: true,
                overflowing,
                overflowY: getComputedStyle(panel).overflowY,
                scroll: [panel.clientHeight, panel.scrollHeight],
                label: (label.textContent || '').trim(),
                center: { x, y },
                hitIsLabel: hit === label,
                hitCls: hit ? String(hit.className) : null,
                before: { bp: window.__splat.blackPoint, wp: window.__splat.whitePoint, ...window.__params() },
                stats: await window.__stats()
            };
        });

        check('color panel layout: every row fits its section and the black-point label is hit-testable',
            layout.ok && layout.overflowing.length === 0 && layout.hitIsLabel,
            layout.ok
                ? `overflowing rows: ${layout.overflowing.length ? layout.overflowing.map(o => `${o.text} +${o.over}px`).join(', ') : 'none'}` +
                  ` | panel overflow-y=${layout.overflowY} clientH/scrollH=${layout.scroll.join('/')}` +
                  ` | elementFromPoint(${Math.round(layout.center.x)}, ${Math.round(layout.center.y)}) -> ` +
                  `${layout.hitIsLabel ? `label "${layout.label}"` : layout.hitCls}` +
                  ` — 改前 1280x800 下这里是 "黑场 +56px" 且命中到下一个分区的容器`
                : `${layout.reason}: ${(layout.labels || []).join(', ')}`);

        // 真实鼠标：在"黑场"标签上往左拖 260px（2px/步 × 0.01 ⇒ 够把滑块推到底）
        let uiGuard = null;
        if (layout.ok) {
            await page.mouse.move(layout.center.x, layout.center.y);
            await page.mouse.down();
            await page.mouse.move(layout.center.x - 130, layout.center.y, { steps: 10 });
            await page.mouse.move(layout.center.x - 260, layout.center.y, { steps: 10 });
            const cursor = await page.evaluate(() => document.body.style.cursor);
            await page.mouse.up();
            await sleep(400);
            uiGuard = await page.evaluate(async () => {
                await window.__render(3);
                return {
                    bp: window.__splat.blackPoint,
                    wp: window.__splat.whitePoint,
                    ...window.__params(),
                    stats: await window.__stats()
                };
            });
            uiGuard.cursor = cursor;
            const range = uiGuard.wp - uiGuard.bp;
            check('dragging the black-point label to its limit keeps a usable tone range (no range-0 blow-out)',
                uiGuard.bp > 0.95 && range >= MIN_TONE_RANGE - 1e-6 &&
                uiGuard.scale <= 1 / MIN_TONE_RANGE + 1e-6 &&
                uiGuard.stats.blackPct > 50 && uiGuard.stats.blownPct < 1,
                `cursor while dragging=${uiGuard.cursor || '(unset -> 拖拽没被接住)'}; ` +
                `blackPoint ${layout.before.bp} -> ${uiGuard.bp}, whitePoint ${layout.before.wp} -> ${uiGuard.wp}, ` +
                `range=${range.toFixed(4)} (>= ${MIN_TONE_RANGE}) scale=${uiGuard.scale} offset=${uiGuard.offset} | ` +
                `pixels: meanLum ${layout.stats.meanLum.toFixed(3)} -> ${uiGuard.stats.meanLum.toFixed(3)}, ` +
                `black ${uiGuard.stats.blackPct.toFixed(1)}%, blown ${uiGuard.stats.blownPct.toFixed(2)}% ` +
                `— 改前这个位置正好是 range 0 / scale 1000 / 98.9% 冲白`);
        } else {
            check('dragging the black-point label to its limit keeps a usable tone range (no range-0 blow-out)', false, 'layout guard failed, drag not attempted');
        }

        // 键盘通道（不依赖命中测试）：走的是滑块自己的 `change` 事件 ⇒ 同一个护栏
        const kbGuard = await page.evaluate(async () => {
            const scene = window.scene;
            const splat = window.__splat;
            splat.blackPoint = 0;
            splat.whitePoint = 1;
            scene.events.fire('selection.changed', splat); // 滑块同步回 0 / 1
            await window.__render(2);
            const row = Array.from(document.querySelectorAll('.color-panel-row')).find(r =>
                (r.querySelector('.color-panel-row-label').textContent || '').includes('黑场'));
            const handle = row.querySelector('.pcui-slider-handle');
            handle.focus();
            const trail = [];
            for (let i = 0; i < 14; i++) {
                handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true, cancelable: true }));
                await new Promise((r) => setTimeout(r, 25));
                trail.push(splat.blackPoint);
            }
            await window.__render(3);
            return { bp: splat.blackPoint, wp: splat.whitePoint, ...window.__params(), trail };
        });
        check('the same clamp holds on the slider-change path (keyboard-driven black point)',
            kbGuard.bp > 0.95 && (kbGuard.wp - kbGuard.bp) >= MIN_TONE_RANGE - 1e-6 &&
            kbGuard.scale <= 1 / MIN_TONE_RANGE + 1e-6,
            `blackPoint trail ${kbGuard.trail.map(v => v.toFixed(2)).join(' -> ')} | final blackPoint=${kbGuard.bp} ` +
            `whitePoint=${kbGuard.wp} range=${(kbGuard.wp - kbGuard.bp).toFixed(4)} scale=${kbGuard.scale} ` +
            `(cap ${(1 / MIN_TONE_RANGE).toFixed(0)})`);

        // ---- 6：直方图 / 范围选择在退化参数下不炸 ----
        const dataPath = await page.evaluate(async () => {
            const scene = window.scene;
            const splat = window.__splat;
            const out = {};
            const run = async (label, bp, wp) => {
                splat.blackPoint = bp;
                splat.whitePoint = wp;
                await window.__render(2);
                const r = { label, bp, wp };
                try {
                    // 返回形状是 { selected, unselected, min, max, numValues }（不是 bins）
                    //
                    // **模式必须是颜色模式（5..7 / 18..20），不能用 1**：`propMode = 1` 是
                    // `worldPos.y`（坐标），根本不经过 `applyColorGrade`，用它测"调色有没有
                    // 影响这条通路"会永远读到"没变化"（HANDOFF 53）。这里用 5 = 最终颜色 R，
                    // 也就是黑场/白场真正作用的那条通路。
                    const hist = await scene.dataProcessor.calcHistogram(splat, 5);
                    const sel = hist && hist.selected ? Array.from(hist.selected) : [];
                    const uns = hist && hist.unselected ? Array.from(hist.unselected) : [];
                    r.histBins = sel.length;
                    r.histFinite = sel.every(v => Number.isFinite(v)) && uns.every(v => Number.isFinite(v)) &&
                        Number.isFinite(hist.min) && Number.isFinite(hist.max);
                    r.histSum = +(sel.reduce((a, b) => a + b, 0) + uns.reduce((a, b) => a + b, 0)).toFixed(1);
                    r.histValues = hist.numValues;
                    r.histRange = [hist.min, hist.max];
                } catch (e) {
                    r.histError = String(e).slice(0, 120);
                }
                try {
                    const minMax = [0, 1];
                    const mask = await scene.dataProcessor.selectByRange(splat, 5, {
                        min: minMax[0], max: minMax[1], numBins: 256, rangeStart: 0, rangeEnd: 255, onScreenOnly: false
                    });
                    let sel = 0;
                    if (mask) {
                        const arr = mask instanceof Uint8Array ? mask : new Uint8Array(mask);
                        for (let i = 0; i < arr.length; i++) {
                            if (arr[i]) sel++;
                        }
                        scene.dataProcessor.releaseMask(mask);
                    }
                    r.selected = sel;
                    r.total = splat.numSplats;
                    r.selFinite = Number.isFinite(sel);
                } catch (e) {
                    r.selectError = String(e).slice(0, 120);
                }
                return r;
            };
            out.degenerate = await run('degenerate', 1, 1);
            out.crossed = await run('crossed', 1.2, 0.8);
            out.normal = await run('normal', 0.5, 1);
            await window.__restore();
            return out;
        });

        const dpOk = ['degenerate', 'crossed', 'normal'].every(k => {
            const r = dataPath[k];
            return !r.histError && !r.selectError && r.histFinite === true && r.histBins > 0 &&
                r.selFinite === true && r.selected > 0;
        });
        check('histogram + range selection stay sane at degenerate/crossed tone range (no Infinity/NaN)',
            dpOk,
            ['degenerate', 'crossed', 'normal'].map(k => {
                const r = dataPath[k];
                return `${k}: hist=${r.histError ? 'ERR:' + r.histError : (r.histBins + ' bins, values=' + r.histValues + ', finite=' + r.histFinite + ', sum=' + r.histSum)} ` +
                    `sel=${r.selectError ? 'ERR:' + r.selectError : (r.selected + '/' + r.total)}`;
            }).join(' | '));

        // 上面那条只证明"不炸"。这条证明**黑场/白场真的走到了颜色通路**（mode 5 = 最终颜色 R）：
        // 退化档（黑场=白场=1，被 MIN_TONE_RANGE 兜住）与正常档（黑场 0.5）应该给出不同的
        // 直方图 min/max。用 mode 1（坐标）时这条会**永远读到"一样"**，也就测不出东西（HANDOFF 53）。
        const d = dataPath.degenerate;
        const n = dataPath.normal;
        const reachable = !!(d && n && Array.isArray(d.histRange) && Array.isArray(n.histRange));
        const moved = reachable &&
            (Math.abs(d.histRange[0] - n.histRange[0]) > 0.02 || Math.abs(d.histRange[1] - n.histRange[1]) > 0.02);
        check('the tone range actually reaches the graded colour path (histogram mode 5 moves with it)',
            reachable && moved,
            reachable
                ? `最终颜色 R 范围：退化档(黑场=白场=1) ${d.histRange.map(v => v.toFixed(3)).join('..')} vs ` +
                  `正常档(黑场 0.5) ${n.histRange.map(v => v.toFixed(3)).join('..')}；` +
                  `选中数 ${d.selected}/${d.total} vs ${n.selected}/${n.total}` +
                  `（改前这两条检查用的是 mode 1 = worldPos.y，根本不经过调色）`
                : 'phase missing');
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
