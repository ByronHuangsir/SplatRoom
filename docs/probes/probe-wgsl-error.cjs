// 归档自 _tmp（2026-09-26 二期第一步：调色接到 unified 通路），REPO 路径已按 docs/probes/ 调整。
// 探针 42：抓 **WGSL 编译错误原文**（`createShaderModule` + `getCompilationInfo()`）。
// 背景：`uncapturederror` 只给出 "[Invalid RenderPipeline] is invalid due to a previous error"，
// 真正的编译错误挂在 shader module 的 compilationInfo 上，必须主动读。
// usage: node _tmp/probe-wgsl-error.cjs [model] [unified]
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..', '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL = process.argv[2] || 'test-model.ply';
const UNIFIED = process.argv[3] !== '0';

(async () => {
    cleanupOrphanBrowsers();
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 600000
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 640, height: 440 });
    const pageErrs = [];
    page.on('pageerror', (e) => pageErrs.push(String(e).slice(0, 200)));

    await page.evaluateOnNewDocument(() => {
        window.__SR_CI__ = [];
        const hook = () => {
            const D = globalThis.GPUDevice;
            if (!D || !D.prototype || D.prototype.__srCI) return false;
            D.prototype.__srCI = true;
            const orig = D.prototype.createShaderModule;
            D.prototype.createShaderModule = function (desc) {
                const m = orig.call(this, desc);
                const code = desc && desc.code ? String(desc.code) : '';
                try {
                    m.getCompilationInfo().then((info) => {
                        const msgs = (info.messages || []).map((x) => ({
                            type: x.type,
                            line: x.lineNum,
                            col: x.linePos,
                            msg: String(x.message).slice(0, 300),
                            srcLine: code.split('\n')[(x.lineNum || 1) - 1] ?? null
                        }));
                        if (msgs.length) {
                            window.__SR_CI__.push({
                                len: code.length,
                                ours: /SR_FRAG_GAIN|srApplyHighlights|srApplyCurve/.test(code),
                                pick: /PICK_PASS/.test(code),
                                msgs
                            });
                        }
                    }).catch(() => { /* ignore */ });
                } catch (e) { /* ignore */ }
                return m;
            };
            return true;
        };
        hook();
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
    if (UNIFIED) {
        await page.evaluate(async () => {
            const scene = window.scene;
            window.__SPLATROOM_UNIFIED__ = true;
            const el = (scene.elements || []).find((e) => e.entity && e.entity.gsplat);
            el.entity.gsplat.unified = true;
            for (let i = 0; i < 40; i++) {
                scene.app.renderNextFrame = true;
                await new Promise((r) => requestAnimationFrame(r));
            }
        });
        await sleep(1500);
        await page.evaluate(async () => {
            window.scene.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
        });
        await sleep(600);
    }

    const ci = await page.evaluate(() => window.__SR_CI__ ?? []);
    console.log(JSON.stringify({ model: MODEL, unified: UNIFIED, modulesWithMessages: ci.length, ci, pageErrs: pageErrs.slice(0, 3) }, null, 1));
    console.log('\n=== WGSL 编译信息 ===');
    for (const m of ci) {
        console.log(`  模块 len=${m.len} ours=${m.ours} pick=${m.pick}（${m.msgs.length} 条）`);
        for (const x of m.msgs.slice(0, 6)) {
            console.log(`    [${x.type}] ${x.line}:${x.col} ${x.msg.split('\n')[0]}`);
            if (x.srcLine) console.log(`       源码：${x.srcLine.trim().slice(0, 140)}`);
        }
    }
    if (!ci.length) console.log('  （没有编译消息：着色器都编译通过了）');

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
