// 归档自 _tmp（2026-09-25 unified 通路排查那一轮），REPO 路径已按 docs/probes/ 调整。
// 探针 4：为什么 unified 那次 splat 绘制对画面**零贡献** —— 三选一。
//
// 已知（_tmp/probe-who-draws2.cjs / probe-unified-invisible.cjs，见 §4r）：
//   · unified 帧里有一次 2 附件 pass，用**我们的片元**画了一次（着色器确实被编译、被使用）；
//   · 但这一帧的像素与该 pass **画与不画**逐位相同 ⇒ 这次绘制对可见画面零贡献。
// 三种解释，本探针一次分清：
//   H1 管线无效（draw 静默变空操作）        → `fragOpaque` 也不变，且 uncapturederror 每帧报错
//   H2 绘制到了目标，但被 discard / alpha 吃掉 → `fragOpaque` 变红
//   H3 绘制去了别的目标（不是我们的 splatTarget）→ `fragOpaque` 不变、也没有错误
// 另外自检"隐藏 meshInstance 是否真的消掉那次 draw"（上一轮的隐藏实验是个未验证的仪器）。
//
// usage: node _tmp/probe-unified-opaque.cjs [model]
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..', '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const { decodePng } = require(path.join(REPO, 'docs', 'verify', 'lib', 'png.cjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MODEL = process.argv[2] || 'test-model.ply';

const mean = (f) => {
    const P = decodePng(fs.readFileSync(f));
    let r = 0;
    let g = 0;
    let b = 0;
    let red = 0;
    const n = P.width * P.height;
    for (let i = 0; i < P.data.length; i += P.channels) {
        r += P.data[i];
        g += P.data[i + 1];
        b += P.data[i + 2];
        if (P.data[i] > 120 && P.data[i + 1] < 80 && P.data[i + 2] < 80) red++;
    }
    return { meanRGB: [+(r / n).toFixed(2), +(g / n).toFixed(2), +(b / n).toFixed(2)], redPct: +((red / n) * 100).toFixed(2) };
};
const diff = (a, b) => {
    const A = decodePng(fs.readFileSync(a));
    const B = decodePng(fs.readFileSync(b));
    let sum = 0;
    let changed = 0;
    const n = A.width * A.height;
    for (let i = 0; i < A.data.length; i += A.channels) {
        let d = 0;
        for (let c = 0; c < 3; c++) d += Math.abs(A.data[i + c] - B.data[i + c]);
        sum += d;
        if (d > 24) changed++;
    }
    return { mad: +(sum / n / 3).toFixed(4), changedPct: +((changed / n) * 100).toFixed(2) };
};

(async () => {
    cleanupOrphanBrowsers();
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 600000
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 640, height: 440 });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));

    await page.evaluateOnNewDocument(() => {
        window.__SPLATROOM_UNIFIED_BAKE__ = { fragOpaque: 1 };
        window.__SR_DIAG__ = { hook: 'start', devices: 0, listeners: 0, errors: [], passes: [], drawnOurs: 0, drawnOther: 0 };
        const hook = () => {
            const A = globalThis.GPUAdapter;
            if (!A || !A.prototype || A.prototype.__srO) return false;
            A.prototype.__srO = true;
            const orig = A.prototype.requestDevice;
            A.prototype.requestDevice = async function (desc) {
                const dev = await orig.call(this, desc);
                window.__SR_DIAG__.devices++;
                try {
                    dev.addEventListener('uncapturederror', (e) => {
                        window.__SR_DIAG__.listeners = 1;
                        window.__SR_DIAG__.errors.push(String(e.error && e.error.message ? e.error.message : e.error).slice(0, 300));
                    });
                } catch (e) { /* ignore */ }
                return dev;
            };
            return true;
        };
        const hookDraw = () => {
            const D = globalThis.GPUDevice;
            const PR = globalThis.GPURenderPassEncoder;
            const CE = globalThis.GPUCommandEncoder;
            if (!D || !D.prototype || D.prototype.__srOd) return false;
            D.prototype.__srOd = true;
            const om = D.prototype.createShaderModule;
            D.prototype.createShaderModule = function (d) {
                const m = om.call(this, d);
                const code = d && d.code ? String(d.code) : '';
                m.__srTag = { ours: /SR_FRAG_GAIN/.test(code), engineDefault: /INV_EXP4/.test(code), opaque: (code.match(/SR_FRAG_OPAQUE: f32 = ([0-9.]+)/) || [])[1] ?? null };
                return m;
            };
            const op = D.prototype.createRenderPipeline;
            D.prototype.createRenderPipeline = function (d) {
                const p = op.call(this, d);
                p.__srPipe = d?.fragment?.module?.__srTag ?? null;
                return p;
            };
            if (PR && PR.prototype) {
                const origSet = PR.prototype.setPipeline;
                PR.prototype.setPipeline = function (p) {
                    this.__srLast = p && p.__srPipe ? p.__srPipe : null;
                    return origSet.call(this, p);
                };
                for (const n of ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect']) {
                    const o = PR.prototype[n];
                    if (typeof o !== 'function') continue;
                    PR.prototype[n] = function (...a) {
                        if (this.__srPass !== undefined) {
                            if (this.__srLast && this.__srLast.ours) window.__SR_DIAG__.drawnOurs++;
                            else window.__SR_DIAG__.drawnOther++;
                        }
                        return o.apply(this, a);
                    };
                }
            }
            if (CE && CE.prototype) {
                const ob = CE.prototype.beginRenderPass;
                CE.prototype.beginRenderPass = function (d) {
                    const pass = ob.call(this, d);
                    pass.__srPass = (d?.colorAttachments?.length ?? 0);
                    return pass;
                };
            }
            return true;
        };
        if (!hook()) window.__SR_DIAG__.hook = 'adapter-not-found';
        else window.__SR_DIAG__.hook = 'ok';
        hookDraw();
    });

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
    await sleep(2000);

    const frames = (n) => page.evaluate(async (k) => {
        for (let i = 0; i < k; i++) {
            window.scene.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
        }
    }, n);
    const shot = async (name) => {
        const f = path.join(REPO, '_tmp', `op-${name}.png`);
        fs.writeFileSync(f, Buffer.from(await page.screenshot({ encoding: 'base64' }), 'base64'));
        return f;
    };
    const diagReset = () => page.evaluate(() => {
        window.__SR_DIAG__.errors = [];
        window.__SR_DIAG__.drawnOurs = 0;
        window.__SR_DIAG__.drawnOther = 0;
    });
    const diagRead = () => page.evaluate(() => ({
        hook: window.__SR_DIAG__.hook, devices: window.__SR_DIAG__.devices, listeners: window.__SR_DIAG__.listeners,
        errors: window.__SR_DIAG__.errors.length, firstErr: window.__SR_DIAG__.errors.slice(0, 2),
        drawnOurs: window.__SR_DIAG__.drawnOurs, drawnOther: window.__SR_DIAG__.drawnOther
    }));

    await frames(3);
    const cpu = await shot('cpu');

    await page.evaluate(async () => {
        const scene = window.scene;
        window.__SPLATROOM_UNIFIED__ = true;
        const el = (scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        el.entity.gsplat.unified = true;
        for (let i = 0; i < 60; i++) {
            scene.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
        }
    });
    await sleep(1500);

    await diagReset();
    await frames(3);
    const uniDiag = await diagRead();
    const uni = await shot('uni-opaque');

    // 自检：隐藏 meshInstance 之后，那次 draw 还在不在
    const hide = await page.evaluate(async () => {
        const scene = window.scene;
        const touched = [];
        scene?.app?.renderer?.gsplatDirector?.camerasMap?.forEach((cd) => {
            cd?.layersMap?.forEach((ld) => {
                const r = ld?.gsplatManager?.renderer;
                if (r?.meshInstance) {
                    r.meshInstance.visible = false;
                    touched.push(!!r.meshInstance.visible);
                }
            });
        });
        for (let i = 0; i < 3; i++) {
            scene.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
        }
        return touched;
    });
    await diagReset();
    await frames(3);
    const hiddenDiag = await diagRead();
    await sleep(300);
    const hidden = await shot('uni-hidden');

    const report = {
        model: MODEL,
        diag: { afterLoad: await diagRead(), unified: uniDiag, hidden: hiddenDiag },
        means: { cpu: mean(cpu), uni: mean(uni), hidden: mean(hidden) },
        d: { 'uni vs 隐藏': diff(uni, hidden), 'cpu vs uni': diff(cpu, uni) },
        hideTouched: hide,
        errs: errs.slice(0, 5)
    };
    console.log(JSON.stringify(report, null, 1));

    console.log('\n=== 判定（fragOpaque = 1：无条件写不透明红）===');
    console.log(`  仪器自检：hook=${report.diag.afterLoad.hook} devices=${report.diag.afterLoad.devices} uncapturederror监听=${report.diag.afterLoad.listeners}`);
    console.log(`  片元红像素占比：cpu ${report.means.cpu.redPct}%  unified ${report.means.uni.redPct}%  隐藏后 ${report.means.hidden.redPct}%`);
    console.log(`  unified 每 3 帧：我们的 draw ${uniDiag.drawnOurs} 次，其它 draw ${uniDiag.drawnOther} 次，错误 ${uniDiag.errors} 条`);
    console.log(`  隐藏 meshInstance 后每 3 帧：我们的 draw ${hiddenDiag.drawnOurs} 次，其它 draw ${hiddenDiag.drawnOther} 次`);
    if (uniDiag.firstErr.length) console.log(`  unified 首条错误：${JSON.stringify(uniDiag.firstErr)}`);
    console.log(`  unified 帧 vs 隐藏帧：${JSON.stringify(report.d['uni vs 隐藏'])}`);
    if (report.errs.length) console.log(`  页面错误：${JSON.stringify(report.errs)}`);

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
