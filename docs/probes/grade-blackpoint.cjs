// 调色"黑场拉到底变成过曝"的复现与量化。
//
// 机制（读代码得到，本探针把它量成数字）：UI 的黑场滑块是**反向映射**（`blackPoint = -sliderB`，
// 滑块 -1..1），白场 `whitePoint = 2 - sliderW`（滑块 0..2），护栏只保证
// `whitePoint - blackPoint >= 0` —— **等号可达**：默认白场滑块 1（whitePoint=1）时把黑场滑块拉到 -1，
// 护栏会把白场滑块也压到 1 ⇒ `whitePoint == blackPoint`，范围 = 0。
// 而视口那条公式是 `denom = Math.max(0.001, whitePoint - blackPoint)` ⇒ **scale = 1000**、
// `offset = -blackPoint = -1` ⇒ 片元着色器 `color * 1000 - 1` ⇒ 画面整体冲白 **（过曝）**，
// 与用户预期（拉黑场 = 压暗/压黑）正好相反。
//
// 本探针沿黑场滑块扫一遍，逐步记录：材质里实际下发的 clrScale/clrOffset、画面平均亮度、
// 冲白像素占比（>0.98）、纯黑像素占比（<0.02），以及导出侧 `ColorGrade` 的对照值。
//
// 用法：node docs/probes/grade-blackpoint.cjs "<url>" [model]
const path = require('path');
const REPO = path.join(__dirname, '..', '..');
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const { BROWSER_PATH: EDGE } = require('../verify/lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
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
    page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });

    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1500);
    await page.evaluate(async (m) => {
        const buf = await (await fetch('./' + m)).arrayBuffer();
        window.scene.events.invoke('import', [{ filename: m, contents: new File([buf], m) }]).catch(() => {});
    }, MODEL);
    for (let i = 0; i < 60; i++) {
        await sleep(1000);
        if (await page.evaluate(() => window.scene.getElementsByType('splat').length) > 0) break;
    }
    await sleep(3000);

    const out = await page.evaluate(async () => {
        const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
        const scene = window.scene;
        const events = scene.events;
        const splat = scene.getElementsByType('splat').slice(-1)[0];
        const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const render = async (k = 3) => {
            for (let i = 0; i < k; i++) {
                scene.forceRender = true;
                await nextFrame();
            }
        };
        events.fire('camera.focus');
        await sleep2(2500);
        splat.colorGradeEnabled = true;
        await render(4);

        const grabStats = async () => {
            await render(2);
            const src = scene.canvas;
            const off = document.createElement('canvas');
            off.width = src.width;
            off.height = src.height;
            const ctx = off.getContext('2d');
            ctx.drawImage(src, 0, 0);
            const img = ctx.getImageData(0, 0, off.width, off.height);
            const d = img.data;
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
            return {
                meanLum: +(sum / n).toFixed(4),
                blownPct: +((blown / n) * 100).toFixed(2),
                blackPct: +((black / n) * 100).toFixed(2)
            };
        };

        const mat = () => {
            const material = splat.entity.gsplat.instance.material;
            const pick = (name) => {
                const p = material.getParameter(name);
                const v = p && typeof p === 'object' && 'data' in p ? p.data : p;
                return Array.isArray(v) ? v.map(x => +Number(x).toFixed(4)) : v;
            };
            return { clrScale: pick('clrScale'), clrOffset: pick('clrOffset') };
        };

        // 导出侧（ColorGrade）用的公式：先排序再取 max，与视口不是同一套
        const exportFormula = (bp, wp, brightness) => {
            const lo = Math.min(bp, wp);
            const hi = Math.max(bp, wp);
            const denom = Math.max(0.001, hi - lo);
            return { scale: +(1 / denom).toFixed(4), offset: +(-lo + brightness).toFixed(4) };
        };

        const rows = [];
        // 沿"黑场滑块"从 0 扫到 -1（用户说的"拉到底"），并按 UI 护栏联动白场
        let whiteSlider = 1;
        for (const b of [0, -0.25, -0.5, -0.75, -0.9, -0.99, -1]) {
            if (b <= whiteSlider - 2) {
                whiteSlider = b + 2;               // ← UI 护栏（color-panel.ts:584）
            }
            const blackPoint = -b;
            const whitePoint = 2 - whiteSlider;
            splat.blackPoint = blackPoint;
            splat.whitePoint = whitePoint;
            await render(3);
            const stats = await grabStats();
            rows.push({
                blackSlider: b,
                whiteSlider: +whiteSlider.toFixed(2),
                blackPoint: +blackPoint.toFixed(2),
                whitePoint: +whitePoint.toFixed(2),
                range: +(whitePoint - blackPoint).toFixed(4),
                material: mat(),
                exportFormula: exportFormula(blackPoint, whitePoint, splat.brightness),
                ...stats
            });
        }

        // 沿"白场滑块"从 1 扫到 2（另一端到底），按同一条 UI 护栏联动黑场滑块
        // 护栏：whiteSlider - blackSlider <= 2 - MIN_TONE_RANGE ⇒ 超了就抬黑场滑块
        const whiteRows = [];
        let blackSlider = 0;
        for (const w of [1, 1.25, 1.5, 1.75, 1.95, 2]) {
            if (w - blackSlider > 2 - 0.05) {
                blackSlider = w - (2 - 0.05);
            }
            const blackPoint = -blackSlider;
            const whitePoint = 2 - w;
            splat.blackPoint = blackPoint;
            splat.whitePoint = whitePoint;
            await render(3);
            const stats = await grabStats();
            whiteRows.push({
                whiteSlider: w,
                blackSlider: +blackSlider.toFixed(2),
                blackPoint: +blackPoint.toFixed(2),
                whitePoint: +whitePoint.toFixed(2),
                range: Math.abs(whitePoint - blackPoint),
                material: mat(),
                ...stats
            });
        }

        // 交叉（白场 < 黑场）：文档/.ssproj 可以直接给出这种值，绕过 UI 护栏
        splat.blackPoint = 1.2;
        splat.whitePoint = 0.8;
        await render(3);
        const crossed = { ...(await grabStats()), material: mat(), exportFormula: exportFormula(1.2, 0.8, 0) };

        // 复原
        splat.blackPoint = 0;
        splat.whitePoint = 1;
        await render(3);
        const restored = await grabStats();

        return { rows, whiteRows, crossed, restored };
    });

    console.log(JSON.stringify({ model: MODEL, url: URL, ...out, errors: errs.slice(0, 5) }, null, 1));
    await browser.close();
    process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ fatal: String(e).slice(0, 400) })); process.exit(1); });
