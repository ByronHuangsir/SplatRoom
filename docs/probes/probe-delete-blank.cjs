// 归档自 _tmp（2026-09-26），REPO 路径已按 docs/probes/ 调整。
// 探针 47：复现"选中删除过程中白屏"。
//
// 用户反馈：使用中白屏，**发生在选中→删除的过程中**（真实模型 1.5–4.6GB / 6.5M–20M 高斯）。
// 本探针把这条操作链走一遍，每一步查五件事：
//   ① 页面/控制台错误；② 渲染进程是否**崩了**（puppeteer 的 page 'error' / target crash）；
//   ③ 画面是不是"白了/黑了/没在画"（像素统计 + canvas 是否还在）；④ 渲染是否还在推进；
//   ⑤ 这一步花了多久（主线程长时间阻塞 = 窗口假死 = 用户眼里的"白屏"）+ JS 堆占用。
//
// v2 修了两个探针自身的 bug（第一版结论作废）：
//   · `select.rect` 的坐标是**归一化 0..1**（editor.ts:1488 `rect.start.x * width`），
//     第一版传了画布像素 ⇒ 选区在画面外 ⇒ "矩形选不中任何东西"是探针的错，不是应用的；
//   · 等待时间按 600k 模型定的，6.5M 模型每步要几秒 ⇒ 改成轮询 + 计时。
//
// usage: node _tmp/probe-delete-blank.cjs [model] [webgl2|webgpu]
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..', '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const { launchPatched: _launchPatched } = require('../verify/lib/browser.cjs');
const { decodePng } = require(path.join(REPO, 'docs', 'verify', 'lib', 'png.cjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL = process.argv[2] || 'test-model.ply';
const BACKEND = process.argv[3] || 'webgl2';

const analyze = (f) => {
    const P = decodePng(fs.readFileSync(f));
    let white = 0;
    let dark = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    const n = P.width * P.height;
    for (let i = 0; i < P.data.length; i += P.channels) {
        const R = P.data[i];
        const G = P.data[i + 1];
        const B = P.data[i + 2];
        r += R; g += G; b += B;
        if (R > 240 && G > 240 && B > 240) white++;
        if (R < 12 && G < 12 && B < 12) dark++;
    }
    return {
        meanRGB: [+(r / n).toFixed(1), +(g / n).toFixed(1), +(b / n).toFixed(1)],
        whitePct: +((white / n) * 100).toFixed(2),
        darkPct: +((dark / n) * 100).toFixed(2)
    };
};
const diff = (a, b) => {
    const A = decodePng(fs.readFileSync(a));
    const B = decodePng(fs.readFileSync(b));
    let sum = 0;
    const n = A.width * A.height;
    for (let i = 0; i < A.data.length; i += A.channels) {
        let d = 0;
        for (let c = 0; c < 3; c++) d += Math.abs(A.data[i + c] - B.data[i + c]);
        sum += d;
    }
    return +(sum / n / 3).toFixed(3);
};

(async () => {
    cleanupOrphanBrowsers();
    const browser = await _launchPatched(puppeteer, {
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 900000
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 620 });
    const consoleErrs = [];
    const pageErrs = [];
    const crash = { page: null, browser: null, dead: false };
    page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(m.text().slice(0, 300)); });
    page.on('pageerror', (e) => pageErrs.push(String(e).slice(0, 400)));
    // 渲染进程崩溃 / OOM：puppeteer 把它作为 page 'error' 抛出（文本 "Page crashed!"）
    page.on('error', (e) => { crash.page = String(e).slice(0, 300); crash.dead = true; });
    browser.on('disconnected', () => { crash.browser = 'disconnected'; });
    page.on('framedetached', () => { /* 忽略：正常导航也会触发 */ });

    const heap = () => page.evaluate(() => {
        const m = performance.memory;
        if (!m) return null;
        return {
            usedMB: +(m.usedJSHeapSize / 1048576).toFixed(1),
            limitMB: +(m.jsHeapSizeLimit / 1048576).toFixed(1)
        };
    }).catch(() => null);

    await page.goto(`http://localhost:3100/?gpu=${BACKEND}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1500);

    // ---- 导入真实模型（按 256MB 分块；Blob 存在浏览器进程里，不进 JS 堆）----
    const t0 = Date.now();
    await page.evaluate(async (m) => {
        const head = await fetch('./' + m, { headers: { Range: 'bytes=0-0' } });
        if (head.status !== 206) throw new Error(`Range 不支持：status=${head.status}`);
        const total = parseInt(head.headers.get('content-range').split('/')[1], 10);
        const CHUNK = 256 * 1048576;
        const parts = [];
        for (let off = 0; off < total; off += CHUNK) {
            const end = Math.min(off + CHUNK - 1, total - 1);
            parts.push(await (await fetch('./' + m, { headers: { Range: `bytes=${off}-${end}` } })).blob());
        }
        window.__importBytes = total;
        await window.scene.events.invoke('import', [{ filename: m, contents: new File(parts, m) }]);
    }, MODEL);
    let loaded = false;
    for (let i = 0; i < 300; i++) {
        await sleep(1000);
        if (crash.dead) break;
        loaded = await page.evaluate(() => (window.scene.elements || []).some((e) => e.entity && e.entity.gsplat)).catch(() => false);
        if (loaded) break;
    }
    const importMs = Date.now() - t0;
    if (crash.dead || !loaded) {
        console.log(JSON.stringify({ model: MODEL, backend: BACKEND, importMs, loaded, crash, pageErrs: pageErrs.slice(0, 6), consoleErrs: consoleErrs.slice(0, 8) }, null, 1));
        console.log('⇒ 导入阶段就崩了/没进来，后续步骤无法进行');
        try { await browser.close(); } catch { /* already gone */ }
        cleanupOrphanBrowsers();
        return;
    }

    const info = await page.evaluate(() => {
        const el = (window.scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        return {
            numSplats: el ? el.splatData.numSplats : null,
            bytes: window.__importBytes,
            dpr: window.devicePixelRatio,
            target: window.scene.targetSize ? { w: window.scene.targetSize.width, h: window.scene.targetSize.height } : null
        };
    });
    await page.evaluate(() => {
        const scene = window.scene;
        const el = (scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        if (el) scene.events.fire('selection', el);
    });
    await sleep(500);
    await page.evaluate(() => window.scene.events.fire('camera.focus'));
    await sleep(3000);

    const steps = [];
    const shoot = async (name) => {
        const f = path.join(REPO, '_tmp', `db-${BACKEND}-${name}.png`);
        fs.writeFileSync(f, Buffer.from(await page.screenshot({ encoding: 'base64' }), 'base64'));
        return f;
    };
    const frames = (n) => page.evaluate(async (k) => {
        for (let i = 0; i < k; i++) {
            window.scene.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
        }
    }, n);
    // 每一步：计时 + 等主线程空下来（rAF 能排上队就说明没在长阻塞里）+ 取样
    const selCount = () => page.evaluate(() => {
        const el = (window.scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        const st = el && el.splatData ? el.splatData.getProp('state') : null;
        if (!st) return null;
        let n = 0;
        let del = 0;
        for (let i = 0; i < st.length; i++) {
            if (st[i] & 1) n++;
            if (st[i] & 2) del++;
        }
        return { selected: n, deleted: del };
    }).catch(() => null);
    const record = async (name, act, prevFile) => {
        const t = Date.now();
        if (act) await act();
        let blockedMs = 0;
        // 轮询到 rAF 真正跑起来为止（长任务阻塞主线程时这里会一直等）
        while (blockedMs < 60000) {
            const ok = await page.evaluate(() => new Promise((r) => {
                const id = setTimeout(() => r(false), 500);
                requestAnimationFrame(() => { clearTimeout(id); r(true); });
            })).catch(() => false);
            if (ok) break;
            blockedMs += 500;
        }
        const actMs = Date.now() - t;
        await frames(3);
        await sleep(400);
        const f = await shoot(name);
        const st = analyze(f);
        const alive = await page.evaluate(() => {
            const c = document.querySelector('canvas');
            return {
                canvas: !!c,
                w: c ? c.width : null,
                h: c ? c.height : null,
                glLost: (() => {
                    try {
                        const g = c && (c.getContext('webgl2') || c.getContext('webgl'));
                        return g ? g.isContextLost() : null;
                    } catch (e) { return 'err'; }
                })(),
                splats: (window.scene.elements || []).filter(e => e.entity && e.entity.gsplat).length,
                visibleSplats: (() => {
                    const el = (window.scene.elements || []).find(e => e.entity && e.entity.gsplat);
                    return el ? el.numSplats : null;
                })()
            };
        }).catch(() => null);
        steps.push({
            step: name,
            ...st,
            counts: await selCount(),
            actMs,
            blockedMs,
            heap: await heap(),
            alive,
            vsPrev: prevFile ? diff(prevFile, f) : null,
            consoleErrs: consoleErrs.length,
            pageErrs: pageErrs.length,
            crashed: crash.dead
        });
        if (crash.dead) throw new Error(`渲染进程崩溃于步骤 ${name}: ${crash.page}`);
        return f;
    };

    try {
        let last = await record('0-loaded', null);

        // 1) 全选 → 删除 → 撤销
        last = await record('1-selected-all', () => page.evaluate(() => window.scene.events.fire('select.all')), last);
        last = await record('2-deleted-all', () => page.evaluate(() => window.scene.events.fire('select.delete')), last);
        last = await record('3-undone', () => page.evaluate(() => window.scene.events.fire('edit.undo')), last);

        // 2) 矩形选区（归一化坐标）选中间一半 → 删除
        last = await record('4-rect-selected', () => page.evaluate(async () => {
            const scene = window.scene;
            scene.events.fire('select.none');
            await scene.events.invoke('select.rect', 'set', {
                start: { x: 0.25, y: 0.25 },
                end: { x: 0.75, y: 0.75 }
            });
        }), last);
        last = await record('5-rect-deleted', () => page.evaluate(() => window.scene.events.fire('select.delete')), last);
        last = await record('6-rect-undone', () => page.evaluate(() => window.scene.events.fire('edit.undo')), last);

        // 3) 连续"框选→删除→撤销"（看是否累积）
        for (let i = 0; i < 3; i++) {
            const f = (0.1 + i * 0.15).toFixed(2);
            last = await record(`7-${i}-rect`, () => page.evaluate(async (v) => {
                const scene = window.scene;
                scene.events.fire('select.none');
                await scene.events.invoke('select.rect', 'set', {
                    start: { x: parseFloat(v), y: parseFloat(v) },
                    end: { x: 0.95, y: 0.95 }
                });
            }, f), last);
            last = await record(`7-${i}-del`, () => page.evaluate(() => window.scene.events.fire('select.delete')), last);
        }
        last = await record('8-final-undo', async () => {
            for (let i = 0; i < 4; i++) {
                await page.evaluate(() => window.scene.events.fire('edit.undo'));
                await sleep(400);
            }
        }, last);
    } catch (e) {
        steps.push({ step: 'ABORT', error: String(e).slice(0, 300), crash });
    }

    console.log(JSON.stringify({
        model: MODEL, backend: BACKEND, importMs, info, crash,
        consoleErrs: consoleErrs.slice(0, 8), pageErrs: pageErrs.slice(0, 6), steps
    }, null, 1));
    console.log(`\n=== 判定（${BACKEND} / ${MODEL} / ${info.numSplats} 高斯）===`);
    for (const s of steps) {
        if (s.step === 'ABORT') { console.log(`  !! 中断：${s.error}`); continue; }
        console.log(`  ${s.step.padEnd(16)} mean=${JSON.stringify(s.meanRGB)} 白=${s.whitePct}% 黑=${s.darkPct}% 选中=${s.counts ? s.counts.selected : '?'} 删=${s.counts ? s.counts.deleted : '?'} 耗时=${s.actMs}ms(阻塞${s.blockedMs}) 堆=${s.heap ? s.heap.usedMB + '/' + s.heap.limitMB + 'MB' : '?'} canvas=${s.alive && s.alive.canvas ? s.alive.w + 'x' + s.alive.h : '无'} lost=${s.alive ? s.alive.glLost : '?'} 与上一步差=${s.vsPrev} 错误=${s.consoleErrs}/${s.pageErrs}`);
    }
    const blank = steps.filter(s => s.whitePct > 90);
    console.log(`  ⇒ 白屏步骤：${blank.length ? JSON.stringify(blank.map(s => s.step)) : '无'}`);
    console.log(`  ⇒ 渲染进程崩溃：${crash.dead ? crash.page : '无'}`);
    if (consoleErrs.length) console.log(`  控制台错误：${JSON.stringify(consoleErrs.slice(0, 5))}`);
    if (pageErrs.length) console.log(`  页面错误：${JSON.stringify(pageErrs.slice(0, 4))}`);

    try { await browser.close(); } catch { /* already gone */ }
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
