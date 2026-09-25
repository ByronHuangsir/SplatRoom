// 归档自 _tmp（2026-09-26 凌晨：?unified=1 导入卡死修复 + 打包验收），REPO 路径已按 docs/probes/ 调整。
// 打包版端到端验收：`--gpu=webgpu --unified=1` 下**导入一个模型并确认它真的画出来了**。
//
// 为什么必须做：打包版与开发版走的是同一份 dist，但**入口不同**
// （Electron 宿主 + 本地静态服务 + 命令行参数转发），而且要验证的恰恰是
// "用户拿到 exe 能不能看到 unified 通路" 这件事本身。
// 判据（全部与着色无关）：
//   · 导入在超时内完成、出现 splat 元素；
//   · `renderCounter` / `numSplatsBuffer` > 0（引擎投影器算出了可见 splat ⇒ 间接绘制有实例）；
//   · 0 条 error 级 console / 0 条 pageerror。
//
// usage: node _tmp/probe-packaged-unified-e2e.cjs [exePath] [plyPath]
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, execSync } = require('child_process');
const REPO = path.join(__dirname, '..', '..');
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXE = process.argv[2] || path.join(REPO, 'release', 'SplatRoom-3.23.44.exe');
const PLY = process.argv[3] || path.join(REPO, 'dist', 'test-model.ply');
const HTTP_PORT = 3999;
const DEBUG_PORT = 9224;

const startServer = () => new Promise((resolve) => {
    const size = fs.statSync(PLY).size;
    const server = http.createServer((req, res) => {
        if (!req.url.includes('model.ply')) {
            res.writeHead(404).end();
            return;
        }
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': size,
            'Access-Control-Allow-Origin': '*'
        });
        fs.createReadStream(PLY).pipe(res);
    });
    server.listen(HTTP_PORT, '127.0.0.1', () => resolve(server));
});

(async () => {
    const server = await startServer();
    const app = spawn(EXE, [
        '--remote-debugging-port=' + DEBUG_PORT,
        '--remote-allow-origins=*',
        '--gpu=webgpu',
        '--unified=1'
    ], { stdio: 'ignore' });

    const logs = [];
    let browser = null;
    let result = null;
    try {
        for (let i = 0; i < 60; i++) {
            await sleep(1000);
            try {
                browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DEBUG_PORT}`, defaultViewport: null, protocolTimeout: 900000 });
                break;
            } catch (e) { /* 还没起来 */ }
        }
        if (!browser) throw new Error('打包版没有打开调试端口');

        const pages = await browser.pages();
        const page = pages.find(p => p.url().startsWith('http://127.0.0.1')) || pages[0];
        page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text().slice(0, 200)); });
        page.on('pageerror', e => logs.push('pageerror: ' + String(e).slice(0, 200)));
        await page.waitForFunction('!!window.scene', { timeout: 180000 });
        await sleep(2500);

        const boot = await page.evaluate(() => ({
            search: location.search,
            unified: globalThis.__SPLATROOM_UNIFIED__ === true,
            backend: window.scene.graphicsDevice.isWebGPU ? 'webgpu' : 'webgl2'
        }));

        const t0 = Date.now();
        await page.evaluate(async (url) => {
            const buf = await (await fetch(url)).arrayBuffer();
            await window.scene.events.invoke('import', [{ filename: 'model.ply', contents: new File([buf], 'model.ply') }]);
        }, `http://127.0.0.1:${HTTP_PORT}/model.ply`);
        const importMs = Date.now() - t0;
        await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 300000 });
        await sleep(6000);

        const metrics = await page.evaluate(async () => {
            const scene = window.scene;
            const dev = scene.app.graphicsDevice;
            const out = {};
            let r = null;
            scene?.app?.renderer?.gsplatDirector?.camerasMap?.forEach((cd) => {
                cd?.layersMap?.forEach((ld) => {
                    if (ld?.gsplatManager?.renderer) r = ld.gsplatManager.renderer;
                });
            });
            if (!r) return { error: 'no unified renderer' };
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
            out.usesGpuSort = !!r.usesGpuSort;
            out.renderCounter = await readU32(r.projector.renderCounter);
            out.numSplats = await readU32(r.intervalCompaction.numSplatsBuffer);
            out.splats = scene.getElementsByType('splat').length;
            out.install = globalThis.__SPLATROOM_UNIFIED_MATERIAL_INSTALLED__ ?? null;
            return out;
        });

        const shot = path.join(REPO, '_tmp', 'packaged-unified.png');
        fs.writeFileSync(shot, Buffer.from(await page.screenshot({ encoding: 'base64' }), 'base64'));
        result = { boot, importMs, metrics, shot, logs };
    } catch (e) {
        result = { error: String(e).slice(0, 300), logs };
    } finally {
        try { if (browser) await browser.disconnect(); } catch (e) { /* ignore */ }
        server.close();
        await sleep(500);
        try { execSync('taskkill /IM SplatRoom.exe /F', { stdio: 'ignore' }); } catch (e) { /* 已退出 */ }
    }

    console.log(JSON.stringify({ exe: path.basename(EXE), result }, null, 1));
    console.log('\n=== 判定（打包版 + unified）===');
    if (result.error) console.log('  ⚠️ ' + result.error);
    else {
        console.log(`  启动：${JSON.stringify(result.boot)}`);
        console.log(`  导入耗时：${result.importMs} ms；splat 元素 ${result.metrics.splats} 个`);
        console.log(`  usesGpuSort=${result.metrics.usesGpuSort} renderCounter=${result.metrics.renderCounter} numSplats=${result.metrics.numSplats}`);
        console.log(`  材质安装：${JSON.stringify(result.metrics.install)}`);
        console.log(`  截图：${result.shot}`);
        console.log(`  error 级 console / pageerror：${result.logs.length} 条 ${JSON.stringify(result.logs.slice(0, 3))}`);
        const ok = (result.metrics.numSplats ?? 0) > 100;
        console.log(`  ⇒ ${ok ? '**打包版 unified 通路可用：导入完成且真的画出 splat**' : '**没画出来**'}`);
    }
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
