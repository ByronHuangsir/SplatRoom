// 归档自 _tmp（2026-09-26 二期第一步：调色接到 unified 通路），REPO 路径已按 docs/probes/ 调整。
// 探针 41：查"着色改动之后 unified 不画了"的原因（编译/管线校验错误 + 安装状态 + 计数）。
// usage: node _tmp/probe-unified-debug.cjs [model]
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

(async () => {
    cleanupOrphanBrowsers();
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 600000
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 640, height: 440 });
    const consoleErrs = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleErrs.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
    const pageErrs = [];
    page.on('pageerror', (e) => pageErrs.push(String(e).slice(0, 300)));

    await page.evaluateOnNewDocument(() => {
        window.__SR_ERR__ = [];
        window.__SR_ON__ = true;
        const hook = () => {
            const A = globalThis.GPUAdapter;
            if (!A || !A.prototype || A.prototype.__srDbg) return false;
            A.prototype.__srDbg = true;
            const orig = A.prototype.requestDevice;
            A.prototype.requestDevice = async function (desc) {
                const dev = await orig.call(this, desc);
                try {
                    dev.addEventListener('uncapturederror', (e) => {
                        if (window.__SR_ON__) window.__SR_ERR__.push(String(e.error && e.error.message ? e.error.message : e.error).slice(0, 500));
                    });
                } catch (e) { /* ignore */ }
                return dev;
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
    await page.evaluate(() => {
        const scene = window.scene;
        const el = (scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        if (el) scene.events.fire('selection', el);
    });
    await sleep(400);
    await page.evaluate(() => window.scene.events.fire('camera.focus'));
    await sleep(2000);

    const cpuShot = path.join(REPO, '_tmp', 'dbg-cpu.png');
    fs.writeFileSync(cpuShot, Buffer.from(await page.screenshot({ encoding: 'base64' }), 'base64'));

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

    await page.evaluate(() => { window.__SR_ERR__ = []; window.__SR_ON__ = true; });
    await page.evaluate(async () => {
        for (let i = 0; i < 3; i++) {
            window.scene.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
        }
    });
    await sleep(400);

    const info = await page.evaluate(async () => {
        const scene = window.scene;
        const dev = scene.app.graphicsDevice;
        const out = {
            errors: window.__SR_ERR__.slice(0, 6),
            errorCount: window.__SR_ERR__.length,
            install: globalThis.__SPLATROOM_UNIFIED_MATERIAL_INSTALLED__ ?? null,
            installState: globalThis.__SPLATROOM_UNIFIED_INSTALL_STATE__ ?? null
        };
        let r = null;
        scene?.app?.renderer?.gsplatDirector?.camerasMap?.forEach((cd) => {
            cd?.layersMap?.forEach((ld) => {
                if (ld?.gsplatManager?.renderer) r = ld.gsplatManager.renderer;
            });
        });
        if (r) {
            const readU32 = async (sb) => {
                const g = sb && sb.impl && sb.impl.buffer;
                if (!g) return null;
                const st = dev.wgpu.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
                const enc = dev.wgpu.createCommandEncoder();
                enc.copyBufferToBuffer(g, 0, st, 0, Math.min(4, g.size));
                dev.wgpu.queue.submit([enc.finish()]);
                await st.mapAsync(GPUMapMode.READ);
                const v = Array.from(new Uint32Array(st.getMappedRange().slice(0, 4)))[0];
                st.unmap();
                st.destroy();
                return v;
            };
            out.renderCounter = await readU32(r.projector.renderCounter);
            out.numSplats = await readU32(r.intervalCompaction.numSplatsBuffer);
            // 材质编译后的着色器里有没有我们的函数（判断用的是哪一份源码）
            const m = r.material;
            const fsh = m && m.shader && m.shader.definition ? m.shader.definition.fshader : null;
            const vsh = m && m.shader && m.shader.definition ? m.shader.definition.vshader : null;
            out.shader = {
                name: m && m.shader && m.shader.definition ? m.shader.definition.name : null,
                fshaderHasHighlights: !!(fsh && fsh.includes('srApplyHighlights')),
                vshaderHasCurve: !!(vsh && vsh.includes('srApplyCurve')),
                vshaderLen: vsh ? vsh.length : null,
                fshaderLen: fsh ? fsh.length : null
            };
        }
        return out;
    });

    const uniShot = path.join(REPO, '_tmp', 'dbg-uni.png');
    fs.writeFileSync(uniShot, Buffer.from(await page.screenshot({ encoding: 'base64' }), 'base64'));

    console.log(JSON.stringify({ model: MODEL, info, cpu: stats(cpuShot), uni: stats(uniShot), consoleErrs: consoleErrs.slice(-8), pageErrs: pageErrs.slice(0, 3) }, null, 1));
    console.log('\n=== 判定 ===');
    console.log(`  安装：${JSON.stringify(info.install)}`);
    console.log(`  材质着色器：${JSON.stringify(info.shader)}`);
    console.log(`  renderCounter=${info.renderCounter} numSplats=${info.numSplats}`);
    console.log(`  画面：cpu=${JSON.stringify(stats(cpuShot))} unified=${JSON.stringify(stats(uniShot))}`);
    console.log(`  设备错误（${info.errorCount} 条，稳态 3 帧）：`);
    for (const e of info.errors) console.log(`    ${e.split('\n')[0]}`);
    if (consoleErrs.length) { console.log('  console 尾部：'); for (const l of consoleErrs.slice(-5)) console.log(`    ${l}`); }

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
