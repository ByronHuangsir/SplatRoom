// 归档自 _tmp（2026-09-26 二期第一步：调色接到 unified 通路），REPO 路径已按 docs/probes/ 调整。
// 探针 40：**两条通路的调色对齐验收**（二期第一步，2026-09-26）。
//
// 判据（全部与"视觉印象"无关，只用像素统计）：
//   ① 中性参数下：unified 画面 ≈ per-instance 画面（均值差应在个位数以内）；
//   ② 每一项参数改动：两条通路都要**同向**变化，且变化幅度同量级；
//   ③ 主线的 CPU 画面在测完之后与测之前逐位一致（改参数必须能还原）。
//
// 做法（同一会话内 A/B）：
//   阶段 1：正常导入（per-instance）→ 逐项改参数、各截一张；
//   阶段 2：开 unified（导入后翻转，这是已验证可用的入口）→ 逐项改同样的参数、各截一张。
//
// usage: node _tmp/probe-colour-parity.cjs [model]
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..', '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const { decodePng } = require(path.join(REPO, 'docs', 'verify', 'lib', 'png.cjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL = process.argv[2] || 'test-model.ply';

const stats = (f) => {
    const P = decodePng(fs.readFileSync(f));
    let r = 0;
    let g = 0;
    let b = 0;
    const n = P.width * P.height;
    for (let i = 0; i < P.data.length; i += P.channels) {
        r += P.data[i];
        g += P.data[i + 1];
        b += P.data[i + 2];
    }
    return [+(r / n).toFixed(2), +(g / n).toFixed(2), +(b / n).toFixed(2)];
};

// 逐像素差异：均值会互相抵消，所以"两条通路画面一致"必须用逐像素量。
const pixelDiff = (a, b) => {
    const A = decodePng(fs.readFileSync(a));
    const B = decodePng(fs.readFileSync(b));
    const n = A.width * A.height;
    const hist = new Uint32Array(256);
    let sum = 0;
    let changed = 0;
    let max = 0;
    for (let i = 0; i < A.data.length; i += A.channels) {
        let d = 0;
        for (let c = 0; c < 3; c++) d += Math.abs(A.data[i + c] - B.data[i + c]);
        d = d / 3;
        sum += d;
        if (d > 24) changed++;
        if (d > max) max = d;
        hist[Math.min(255, Math.round(d))]++;
    }
    let acc = 0;
    let p95 = 0;
    for (let i = 0; i < 256; i++) {
        acc += hist[i];
        if (acc >= n * 0.95) { p95 = i; break; }
    }
    return { mad: +(sum / n).toFixed(4), changedPct: +((changed / n) * 100).toFixed(2), p95, max: +max.toFixed(1) };
};

// 每项：元素上的字段 → 值。中性 = 全部默认（colorGradeEnabled 保持 false ⇒ 全中性）
const CASES = [
    { name: 'neutral', set: () => ({}) },    { name: 'sat=0.5', set: () => ({ saturation: 0.5 }) },
    { name: 'sat=0', set: () => ({ saturation: 0 }) },
    { name: 'contrast=0.6', set: () => ({ contrast: 0.6 }) },
    { name: 'brightness=0.15', set: () => ({ brightness: 0.15 }) },
    { name: 'highlights=1', set: () => ({ highlights: 1 }) },
    { name: 'shadows=1', set: () => ({ shadows: 1 }) },
    { name: 'temperature=0.6', set: () => ({ temperature: 0.6 }) },
    { name: 'blackPoint=0.2', set: () => ({ blackPoint: 0.2 }) },
    // 曲线：提亮中间调（0.5 → 0.8）。走的是 LUT 纹理那条路，两边的查表实现必须逐字一致。
    { name: 'curve brighten', curve: [{ x: 0, y: 0 }, { x: 0.5, y: 0.8 }, { x: 1, y: 1 }] }
];

(async () => {
    cleanupOrphanBrowsers();
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 600000
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 640, height: 440 });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));

    await page.goto('http://localhost:3100/?gpu=webgpu', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1200);
    await page.evaluate(async (m) => {
        const head = await fetch('./' + m, { headers: { Range: 'bytes=0-0' } });
        const total = parseInt(head.headers.get('content-range').split('/')[1], 10);
        const CHUNK = 256 * 1048576;
        const parts = [];
        for (let off = 0; off < total; off += CHUNK) {
            const end = Math.min(off + CHUNK - 1, total - 1);
            parts.push(await (await fetch('./' + m, { headers: { Range: `bytes=${off}-${end}` } })).blob());
        }
        await window.scene.events.invoke('import', [{ filename: m, contents: new File(parts, m) }]);
    }, MODEL);
    for (let i = 0; i < 40; i++) {
        await sleep(1000);
        if (await page.evaluate(() => (window.scene.elements || []).some((e) => e.entity && e.entity.gsplat))) break;
    }
    await sleep(1500);
    await page.evaluate(() => {
        const scene = window.scene;
        const el = (scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        if (el) scene.events.fire('selection', el);
    });
    await sleep(400);
    await page.evaluate(() => window.scene.events.fire('camera.focus'));
    await sleep(2500);

    // 基线的字段快照：**每项开始前先还原**，否则各项会互相污染
    // （实测踩过：`colorGradeEnabled = false` 只是旁路，不会把字段复位 ⇒ 后面的项全部继承了
    //  前面项的参数，读数看起来"参数没生效"）。
    const base = await page.evaluate(() => {
        const el = window.scene.elements.find(e => e.entity && e.entity.gsplat);
        return {
            saturation: el.saturation,
            contrast: el.contrast,
            brightness: el.brightness,
            highlights: el.highlights,
            shadows: el.shadows,
            temperature: el.temperature,
            blackPoint: el.blackPoint,
            whitePoint: el.whitePoint,
            transparency: el.transparency,
            tint: [el.tintClr.r, el.tintClr.g, el.tintClr.b],
            hslHue: Array.from(el._hslHue),
            hslSat: Array.from(el._hslSat),
            hslLum: Array.from(el._hslLum),
            grade: el.colorGradeEnabled
        };
    });

    const applyCase = (c, tag) => page.evaluate(async (spec, b, t) => {
        const scene = window.scene;
        const el = scene.elements.find(e => e.entity && e.entity.gsplat);
        // 1) 先还原基线
        el.colorGradeEnabled = b.grade;
        el.saturation = b.saturation;
        el.contrast = b.contrast;
        el.brightness = b.brightness;
        el.highlights = b.highlights;
        el.shadows = b.shadows;
        el.temperature = b.temperature;
        el.blackPoint = b.blackPoint;
        el.whitePoint = b.whitePoint;
        el.transparency = b.transparency;
        el.tintClr = new (el.tintClr.constructor)(b.tint[0], b.tint[1], b.tint[2]);
        for (let i = 0; i < 8; i++) {
            el._hslHue[i] = b.hslHue[i];
            el._hslSat[i] = b.hslSat[i];
            el._hslLum[i] = b.hslLum[i];
        }
        // 2) 再按本项设置
        const vals = spec;
        if (Object.keys(vals).length) {
            el.colorGradeEnabled = true;
            for (const k of Object.keys(vals)) el[k] = vals[k];
        }
        if (spec.__curve) {
            el.colorGradeEnabled = true;
            el.setCurvePoints(spec.__curve);
        } else {
            el.setCurvePoints(null);
        }
        for (let i = 0; i < 3; i++) {
            scene.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
        }
        const m = globalThis.__SPLATROOM_UNIFIED_MATERIAL__;
        const num = (n) => {
            const v = m && m.getParameter(n);
            const d = v && v.data;
            return (typeof d === 'number') ? +d.toFixed(4) : (d && d.length ? Array.from(d).slice(0, 4).map(x => +(+x).toFixed(4)) : null);
        };
        void t;
        return {
            grade: el.colorGradeEnabled,
            sat: el.saturation,
            contrast: el.contrast,
            mat: { saturation: num('saturation'), contrast: num('contrast'), highlights: num('highlights'), clrScale: num('clrScale') }
        };
    }, c.curve ? { __curve: c.curve } : c.set(), base, c.name);

    const shoot = async (name) => {
        const f = path.join(REPO, '_tmp', `parity-${name}.png`);
        fs.writeFileSync(f, Buffer.from(await page.screenshot({ encoding: 'base64' }), 'base64'));
        return f;
    };

    const result = { model: MODEL, cpu: {}, uni: {}, cpuDelta: {}, uniDelta: {} };

    // ===== 阶段 1：per-instance =====
    for (const c of CASES) {
        await applyCase(c, 'cpu');
        await sleep(250);
        result.cpu[c.name] = stats(await shoot(`cpu-${c.name.replace(/[^a-z0-9]/gi, '_')}`));
    }

    // ===== 阶段 2：unified =====
    await page.evaluate(async () => {
        const scene = window.scene;
        window.__SPLATROOM_UNIFIED__ = true;
        const el = scene.elements.find(e => e.entity && e.entity.gsplat);
        el.entity.gsplat.unified = true;
        for (let i = 0; i < 60; i++) {
            scene.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
        }
    });
    await sleep(2000);
    const uniInfo = await page.evaluate(() => {
        const scene = window.scene;
        let r = null;
        scene?.app?.renderer?.gsplatDirector?.camerasMap?.forEach((cd) => {
            cd?.layersMap?.forEach((ld) => {
                if (ld?.gsplatManager?.renderer) r = ld.gsplatManager.renderer;
            });
        });
        const el = scene.elements.find(e => e.entity && e.entity.gsplat);
        return {
            usesGpuSort: !!(r && r.usesGpuSort),
            elSaturation: el.saturation,
            install: globalThis.__SPLATROOM_UNIFIED_MATERIAL_INSTALLED__ ?? null,
            colorParamOnMaterial: (() => {
                const m = globalThis.__SPLATROOM_UNIFIED_MATERIAL__;
                if (!m) return null;
                return {
                    saturation: m.getParameter('saturation')?.data ?? null,
                    contrast: m.getParameter('contrast')?.data ?? null,
                    highlights: m.getParameter('highlights')?.data ?? null,
                    uCurveEnabled: m.getParameter('uCurveEnabled')?.data ?? null,
                    hasCurveTexture: !!m.getParameter('uCurve')
                };
            })()
        };
    });

    for (const c of CASES) {
        result.uni[`${c.name}__state`] = await applyCase(c, 'uni');
        await sleep(250);
        result.uni[c.name] = stats(await shoot(`uni-${c.name.replace(/[^a-z0-9]/gi, '_')}`));
    }

    const ref = (arr) => arr;
    const delta = (base, v) => v.map((x, i) => +(x - base[i]).toFixed(2));
    for (const c of CASES) {
        result.cpuDelta[c.name] = delta(ref(result.cpu.neutral), result.cpu[c.name]);
        result.uniDelta[c.name] = delta(ref(result.uni.neutral), result.uni[c.name]);
    }

    console.log(JSON.stringify({ ...result, uniInfo, errs: errs.slice(0, 3) }, null, 1));
    console.log('\n=== 判定：两条通路的调色对齐 ===');
    console.log('  参数             | per-instance 均值 / Δ        | unified 均值 / Δ');
    for (const c of CASES) {
        const st = result.uni[`${c.name}__state`];
        console.log(`  [state] ${c.name.padEnd(16)} ${JSON.stringify(st)}`);
        const a = result.cpu[c.name];
        const b = result.uni[c.name];
        console.log(`  ${c.name.padEnd(16)} | ${JSON.stringify(a)} Δ${JSON.stringify(result.cpuDelta[c.name])} | ${JSON.stringify(b)} Δ${JSON.stringify(result.uniDelta[c.name])}`);
    }
    const n1 = result.cpu.neutral;
    const n2 = result.uni.neutral;
    const gap = n2.map((x, i) => +(x - n1[i]).toFixed(2));
    console.log(`\n  ① 中性帧差（unified − per-instance）：${JSON.stringify(gap)}  ← 应接近 0`);
    // 逐像素对比（比均值强得多：均值可能互相抵消）
    const pd = pixelDiff(
        path.join(REPO, '_tmp', 'parity-cpu-neutral.png'),
        path.join(REPO, '_tmp', 'parity-uni-neutral.png')
    );
    console.log(`     逐像素：mean|ΔRGB|=${pd.mad} / 超阈值(>24)像素占比=${pd.changedPct}% / p95=${pd.p95} / max=${pd.max}`);
    console.log(`  ② 各参数两条通路的 Δ 方向是否一致：`);
    for (const c of CASES.slice(1)) {
        const dc = result.cpuDelta[c.name];
        const du = result.uniDelta[c.name];
        const sameDir = dc.every((x, i) => Math.sign(x) === Math.sign(du[i]) || Math.abs(x) < 0.05);
        console.log(`     ${c.name.padEnd(16)} CPU Δ=${JSON.stringify(dc)}  UNI Δ=${JSON.stringify(du)}  ${sameDir ? '同向 ✓' : '**不同向 ✗**'}`);
    }
    console.log(`  材质上的调色参数：${JSON.stringify(uniInfo.colorParamOnMaterial)}`);
    if (errs.length) console.log(`  页面错误：${JSON.stringify(errs.slice(0, 3))}`);

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
