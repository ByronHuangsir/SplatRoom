// 归档自 _tmp（2026-09-25 unified 通路排查那一轮），REPO 路径已按 docs/probes/ 调整。
// 探针 2：**帧内到底画了什么** —— 拦 GPU 绘制的三个环节，拿到地面真值。
//
// 背景（docs/待办-引擎WebGPU-compute.md §4q/§4r）：
//   · 我们在 unified 材质上换了自写片元，烘焙 `SR_FRAG_RED = 1`（应整屏变红）；
//   · `createShaderModule` 的记录证明**这份源码确实被设备编译了**（len 4122，fragRed=1）；
//   · 但画面逐位不变，而阳性对照（相机转 30°）有效 ⇒ 画的不是这份片元。
// 所以这里直接记录**每个 render pass 用了哪份着色器模块画了什么**：
//   beginRenderPass → 记 pass（颜色附件数）
//   setPipeline     → 记这个 pass 用的管线（管线带上是哪份片元模块）
//   drawIndexed / drawIndirect / draw → 记绘制次数
// 片元模块的身份由 createShaderModule 时打标记（`__srTag`）建立。
//
// usage: node _tmp/probe-who-draws2.cjs [model] [fragRed]
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..', '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const { decodePng } = require(path.join(REPO, 'docs', 'verify', 'lib', 'png.cjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MODEL = process.argv[2] || 'test-model.ply';
const FRAG_RED = process.argv[3] !== undefined ? Number(process.argv[3]) : 0;

const mean = (f) => {
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

    await page.evaluateOnNewDocument((fragRed) => {
        window.__SPLATROOM_UNIFIED_BAKE__ = fragRed > 0 ? { fragRed } : null;
        window.__SR_SRC__ = [];
        window.__SR_PASSES__ = [];
        window.__SR_PIPES__ = [];
        const tag = (code) => ({
            len: code.length,
            ours: /SR_FRAG_GAIN/.test(code),
            fragRed: (code.match(/SR_FRAG_RED: f32 = ([0-9.]+)/) || [])[1] ?? null,
            engineDefault: /INV_EXP4/.test(code),
            color1Write: /output\.color1\s*=/.test(code)
        });
        const install = () => {
            const D = globalThis.GPUDevice;
            if (!D || !D.prototype || D.prototype.__sr3) return false;
            D.prototype.__sr3 = true;
            const PR = globalThis.GPURenderPassEncoder;

            const origModule = D.prototype.createShaderModule;
            D.prototype.createShaderModule = function (desc) {
                const m = origModule.call(this, desc);
                try {
                    const info = tag(desc && desc.code ? String(desc.code) : '');
                    info.idx = window.__SR_SRC__.length;
                    window.__SR_SRC__.push(info);
                    m.__srTag = info;
                } catch (e) { /* ignore */ }
                return m;
            };

            const origPipe = D.prototype.createRenderPipeline;
            D.prototype.createRenderPipeline = function (desc) {
                const p = origPipe.call(this, desc);
                try {
                    p.__srPipe = {
                        frag: desc?.fragment?.module?.__srTag ?? null,
                        vert: desc?.vertex?.module?.__srTag ?? null,
                        targets: Array.isArray(desc?.fragment?.targets) ? desc.fragment.targets.length : null
                    };
                    window.__SR_PIPES__.push(p.__srPipe);
                } catch (e) { /* ignore */ }
                return p;
            };

            if (PR && PR.prototype) {
                const origSet = PR.prototype.setPipeline;
                PR.prototype.setPipeline = function (p) {
                    try {
                        const rec = this.__srPass;
                        if (rec) {
                            rec.pipes.push(p && p.__srPipe ? p.__srPipe.frag : null);
                            rec.lastPipe = p && p.__srPipe ? p.__srPipe.frag : null;
                        }
                    } catch (e) { /* ignore */ }
                    return origSet.call(this, p);
                };
                for (const name of ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect']) {
                    const orig = PR.prototype[name];
                    if (typeof orig !== 'function') continue;
                    PR.prototype[name] = function (...a) {
                        try {
                            const rec = this.__srPass;
                            if (rec) {
                                rec.draws.push({ fn: name, frag: rec.lastPipe });
                            }
                        } catch (e) { /* ignore */ }
                        return orig.apply(this, a);
                    };
                }
            }

            const CE = globalThis.GPUCommandEncoder;
            if (CE && CE.prototype) {
                const origBegin = CE.prototype.beginRenderPass;
                CE.prototype.beginRenderPass = function (desc) {
                    const pass = origBegin.call(this, desc);
                    try {
                        const rec = {
                            colorAttachments: Array.isArray(desc?.colorAttachments) ? desc.colorAttachments.length : 0,
                            hasDepth: !!desc?.depthStencilAttachment,
                            pipes: [],
                            draws: [],
                            lastPipe: null
                        };
                        pass.__srPass = rec;
                        window.__SR_PASSES__.push(rec);
                    } catch (e) { /* ignore */ }
                    return pass;
                };
            }
            return true;
        };
        install();
    }, FRAG_RED);

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

    const oneFrame = async () => {
        await page.evaluate(() => { window.__SR_PASSES__ = []; });
        await page.evaluate(async () => {
            for (let i = 0; i < 2; i++) {
                window.scene.app.renderNextFrame = true;
                await new Promise((r) => requestAnimationFrame(r));
            }
        });
        await sleep(200);
    };
    const shot = async (name) => {
        const f = path.join(REPO, '_tmp', `wd2-${name}.png`);
        fs.writeFileSync(f, Buffer.from(await page.screenshot({ encoding: 'base64' }), 'base64'));
        return f;
    };
    const passes = () => page.evaluate(() => window.__SR_PASSES__.map((p) => ({
        colorAttachments: p.colorAttachments,
        hasDepth: p.hasDepth,
        draws: p.draws.length,
        drawnFrags: p.draws.map((d) => d.frag)
    })));

    // ---- CPU（per-instance）通路的帧 ----
    await oneFrame();
    const cpuPasses = await passes();
    const cpu = await shot('cpu');

    // ---- 打开 unified ----
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
    await oneFrame();
    const uniPasses = await passes();
    const uni = await shot('uni');

    // ---- 关掉 unified 渲染器的 meshInstance：画面变不变？ ----
    const hideInfo = await page.evaluate(async () => {
        const scene = window.scene;
        const out = [];
        const director = scene?.app?.renderer?.gsplatDirector;
        director?.camerasMap?.forEach((cd) => {
            cd?.layersMap?.forEach((ld) => {
                const m = ld?.gsplatManager;
                if (!m?.renderer?.meshInstance) return;
                m.renderer.meshInstance.visible = false;
                out.push({ hidden: true, renderer: m.renderer.constructor.name });
            });
        });
        for (let i = 0; i < 3; i++) {
            scene.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
        }
        return out;
    });
    await sleep(400);
    const uniHidden = await shot('uni-hidden');

    // ---- 关掉整个 splat 实体：背景长什么样 ----
    await page.evaluate(async () => {
        const scene = window.scene;
        for (const el of scene.elements || []) {
            if (el.entity && el.entity.gsplat) el.entity.enabled = false;
        }
        for (let i = 0; i < 3; i++) {
            scene.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
        }
    });
    await sleep(400);
    const empty = await shot('empty');

    const srcs = await page.evaluate(() => window.__SR_SRC__.map((s) => ({ ...s })));
    const pipes = await page.evaluate(() => window.__SR_PIPES__.map((p) => ({
        fragLen: p.frag?.len ?? null, fragOurs: p.frag?.ours ?? null, fragFragRed: p.frag?.fragRed ?? null,
        fragEngineDefault: p.frag?.engineDefault ?? null, targets: p.targets
    })));

    const report = {
        model: MODEL, fragRed: FRAG_RED,
        ourSrcs: srcs.filter((s) => s.ours),
        engineSrcs: srcs.filter((s) => s.engineDefault).map((s) => ({ len: s.len, color1: s.color1Write })),
        pipes,
        cpuPasses, uniPasses, hideInfo,
        means: { cpu: mean(cpu), uni: mean(uni), uniHidden: mean(uniHidden), empty: mean(empty) },
        d: {
            uniVsHidden: diff(uni, uniHidden),
            uniVsEmpty: diff(uni, empty),
            hiddenVsEmpty: diff(uniHidden, empty),
            cpuVsUni: diff(cpu, uni)
        },
        errs: errs.slice(0, 6)
    };
    console.log(JSON.stringify(report, null, 1));

    console.log('\n=== 判定 ===');
    console.log(`  含我们片元标记、且被编译的源码：${JSON.stringify(report.ourSrcs)}`);
    console.log(`  含引擎默认片元标记、且被编译的源码：${JSON.stringify(report.engineSrcs)}`);
    console.log(`  创建的管线（片元模块）：${JSON.stringify(pipes)}`);
    console.log(`  CPU 帧各 pass：${JSON.stringify(cpuPasses)}`);
    console.log(`  unified 帧各 pass：${JSON.stringify(uniPasses)}`);
    console.log(`  平均色：${JSON.stringify(report.means)}`);
    console.log(`  unified 帧 vs 隐藏渲染器帧：${JSON.stringify(report.d.uniVsHidden)}`);
    console.log(`  unified 帧 vs 全隐藏(背景)：${JSON.stringify(report.d.uniVsEmpty)}`);
    console.log(`  隐藏渲染器帧 vs 全隐藏：${JSON.stringify(report.d.hiddenVsEmpty)}`);
    console.log(`  CPU 帧 vs unified 帧：${JSON.stringify(report.d.cpuVsUni)}`);
    if (report.errs.length) console.log(`  错误：${JSON.stringify(report.errs)}`);

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
