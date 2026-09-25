// 归档自 _tmp（2026-09-25 unified 通路排查那一轮），REPO 路径已按 docs/probes/ 调整。
// 探针 3：unified 通路上那颗 splat **到底有没有画进可见画面**，以及为什么。
//
// 背景（_tmp/probe-who-draws2.cjs 的地面真值，见 docs/待办-引擎WebGPU-compute.md §4r）：
//   · unified 帧里**确实**有一次 2 附件 pass 用我们的片元（fragRed = 1.0）画了一次；
//   · 但这一帧的像素与"把 rendering meshInstance 隐藏"、甚至"把整个 splat 实体关掉"**逐位相同**
//     ⇒ 这次绘制**对可见画面零贡献**（画了等于没画）。
// 两个待判定的解释：
//   A. 我们的管线仍然是**无效管线**（`createRenderPipeline` 不抛异常，draw 会静默变成空操作）
//   B. 画进去了，但 alpha = 0 / 被后面的 pass 覆盖
// 判定手段：
//   1. 挂 `device.addEventListener('uncapturederror')`，**逐帧**数错误（A 会每帧报错）；
//   2. 阳性对照的**仪器自检**：把 splat 实体关掉再转相机 30° —— 如果像素**还是**变，
//      说明"转相机画面会变"这个判据根本不是 splat 造成的（上一轮 §4j 的验收判据就是它，
//      那条"unified 通路画面活了"的结论因此可疑）；
//   3. 同一帧里数 pass / draw，确认 splat pass 的位置没变。
//
// usage: node _tmp/probe-unified-invisible.cjs [model] [fragRed]
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..', '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const { decodePng } = require(path.join(REPO, 'docs', 'verify', 'lib', 'png.cjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MODEL = process.argv[2] || 'test-model.ply';
const FRAG_RED = process.argv[3] !== undefined ? Number(process.argv[3]) : 1;

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
        window.__SR_ERRS__ = [];
        window.__SR_ON__ = false;
        const hook = () => {
            const A = globalThis.GPUAdapter;
            if (!A || !A.prototype || A.prototype.__srErr) return false;
            A.prototype.__srErr = true;
            const orig = A.prototype.requestDevice;
            A.prototype.requestDevice = async function (desc) {
                const dev = await orig.call(this, desc);
                try {
                    dev.addEventListener('uncapturederror', (e) => {
                        if (!window.__SR_ON__) return;
                        window.__SR_ERRS__.push(String(e.error && e.error.message ? e.error.message : e.error).slice(0, 400));
                    });
                } catch (e) { /* ignore */ }
                return dev;
            };
            return true;
        };
        hook();
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

    const frames = (n) => page.evaluate(async (k) => {
        for (let i = 0; i < k; i++) {
            window.scene.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
        }
    }, n);
    const shot = async (name) => {
        const f = path.join(REPO, '_tmp', `inv-${name}.png`);
        fs.writeFileSync(f, Buffer.from(await page.screenshot({ encoding: 'base64' }), 'base64'));
        return f;
    };
    const rotate = async (deg) => {
        await page.evaluate(async (d) => {
            const s = window.scene;
            s.camera.setAzimElev(s.camera.azim + d, s.camera.elevation, 0);
            for (let i = 0; i < 3; i++) {
                s.app.renderNextFrame = true;
                await new Promise((r) => requestAnimationFrame(r));
            }
        }, deg);
        await sleep(350);
    };
    const setSplats = (on) => page.evaluate(async (v) => {
        const s = window.scene;
        for (const el of s.elements || []) {
            if (el.entity && el.entity.gsplat) el.entity.enabled = v;
        }
        for (let i = 0; i < 3; i++) {
            s.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
        }
    }, on);
    const errProbe = async (label, n) => {
        await page.evaluate(() => { window.__SR_ERRS__ = []; window.__SR_ON__ = true; });
        await frames(n);
        await sleep(300);
        const out = await page.evaluate(() => ({ n: window.__SR_ERRS__.length, first: window.__SR_ERRS__.slice(0, 2) }));
        return { label, frames: n, errors: out.n, perFrame: +(out.n / n).toFixed(2), first: out.first };
    };

    // ===== 1. CPU 通路基准 =====
    const cpuAlso = await errProbe('cpu', 3);
    const cpu = await shot('cpu');
    const cpuHiddenBase = await (async () => { await setSplats(false); return shot('cpu-hidden'); })();
    await rotate(30);
    const cpuHiddenRot = await shot('cpu-hidden-rot');
    await rotate(-30);
    await setSplats(true);
    await frames(3);
    const cpuBack = await shot('cpu-back');

    // ===== 2. 打开 unified =====
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
    await frames(3);
    const uni = await shot('uni');
    const uniErr = await errProbe('uni', 3);

    // ===== 3. 阳性对照自检：splat 关掉之后，转相机画面还会变吗？ =====
    await setSplats(false);
    const uniHidden = await shot('uni-hidden');
    await rotate(30);
    const uniHiddenRot = await shot('uni-hidden-rot');
    await rotate(-30);
    await setSplats(true);
    await frames(6);
    const uniBack = await shot('uni-back');

    // ===== 4. 转相机时画面真的变了多少（有 splat）=====
    await rotate(30);
    const uniRot = await shot('uni-rot');
    await rotate(-30);
    await frames(3);
    const uniBack2 = await shot('uni-back2');

    const report = {
        model: MODEL, fragRed: FRAG_RED,
        errors: { cpu: cpuAlso, uni: uniErr },
        means: {
            cpu: mean(cpu), cpuHidden: mean(cpuHiddenBase), cpuBack: mean(cpuBack),
            uni: mean(uni), uniHidden: mean(uniHidden), uniBack: mean(uniBack)
        },
        d: {
            'cpu vs cpu-hidden': diff(cpu, cpuHiddenBase),
            'cpu-hidden vs cpu-hidden-rot30': diff(cpuHiddenBase, cpuHiddenRot),
            'cpu vs cpu-back(转回来)': diff(cpu, cpuBack),
            'uni vs uni-hidden': diff(uni, uniHidden),
            'uni-hidden vs uni-hidden-rot30': diff(uniHidden, uniHiddenRot),
            'uni vs uni-rot30': diff(uni, uniRot),
            'uni vs uni-back(转回来)': diff(uni, uniBack),
            'uni vs uni-back2': diff(uni, uniBack2)
        },
        errs: errs.slice(0, 5)
    };
    console.log(JSON.stringify(report, null, 1));

    console.log('\n=== 判定 ===');
    console.log(`  逐帧错误：cpu ${cpuAlso.errors}/${cpuAlso.frames}  unified ${uniErr.errors}/${uniErr.frames}`);
    if (uniErr.first.length) console.log(`  unified 首条错误：${JSON.stringify(uniErr.first)}`);
    console.log(`  CPU 通路：隐藏 splat 前后 ${JSON.stringify(report.d['cpu vs cpu-hidden'])}`);
    console.log(`  **隐藏 splat 后转 30°**：CPU ${JSON.stringify(report.d['cpu-hidden vs cpu-hidden-rot30'])}  unified ${JSON.stringify(report.d['uni-hidden vs uni-hidden-rot30'])}`);
    console.log(`  有 splat 时转 30°：unified ${JSON.stringify(report.d['uni vs uni-rot30'])}`);
    console.log(`  unified 帧 vs 隐藏 splat：${JSON.stringify(report.d['uni vs uni-hidden'])}`);
    console.log(`  转回来是否复原：CPU ${JSON.stringify(report.d['cpu vs cpu-back(转回来)'])}  unified ${JSON.stringify(report.d['uni vs uni-back(转回来)'])}`);
    if (report.errs.length) console.log(`  页面错误：${JSON.stringify(report.errs)}`);

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
