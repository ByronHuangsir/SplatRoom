// 归档自 _tmp（2026-09-26 凌晨：?unified=1 导入卡死修复 + 打包验收），REPO 路径已按 docs/probes/ 调整。
// 探针 39：用**裸 WebGPU 拷贝**把曲线 LUT 纹理读回来（`Texture.lock()` 在 WebGPU 上读回是空的，
// 实测返回全 0，不能当仪器 —— 这正是当初要绕开 lock 的原因之一）。
//
// 要验证的是今天修的那条直传路径（`writeCurveTable`）：`queue.writeTexture` 写进去的内容是否正确 ——
// 33×4 的 R32F，四行都应等于恒等表 `i/32`。
//
// usage: node _tmp/probe-curve-table2.cjs [model]
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..', '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const { launchPatched: _launchPatched } = require('../verify/lib/browser.cjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL = process.argv[2] || 'test-model.ply';

(async () => {
    cleanupOrphanBrowsers();
    const browser = await _launchPatched(puppeteer, {
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 300000
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 640, height: 440 });
    const logs = [];
    page.on('console', (m) => logs.push(m.text().slice(0, 200)));
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));

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

    const res = await page.evaluate(async () => {
        const scene = window.scene;
        const dev = scene.app.graphicsDevice.wgpu;
        const splat = (scene.elements || []).find(e => e.entity && e.entity.gsplat);
        if (!splat) return { error: 'no splat element' };
        const tex = splat.curveTexture;
        const gpu = tex?.impl?.gpuTexture;
        if (!gpu) return { error: 'no gpuTexture', implKeys: tex?.impl ? Object.keys(tex.impl) : null };
        const width = tex.width;
        const height = tex.height;
        const bytesPerRow = width * 4;          // R32F = 4 字节/像素；WebGPU 要求 256 对齐？——
        // 注意：copyTextureToBuffer 的 bytesPerRow 必须是 256 的倍数。33*4=132 不是 ⇒ 用 256 对齐的缓冲。
        const padded = Math.ceil(bytesPerRow / 256) * 256;
        const buf = dev.createBuffer({ size: padded * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const enc = dev.createCommandEncoder();
        enc.copyTextureToBuffer(
            { texture: gpu },
            { buffer: buf, bytesPerRow: padded, rowsPerImage: height },
            { width, height }
        );
        dev.queue.submit([enc.finish()]);
        await buf.mapAsync(GPUMapMode.READ);
        const u8 = new Uint8Array(buf.getMappedRange().slice(0));
        buf.unmap();
        buf.destroy();
        const rows = [];
        for (let row = 0; row < height; row++) {
            const off = row * padded;
            const f = new Float32Array(u8.buffer, u8.byteOffset + off, width);
            rows.push(Array.from(f).map(v => +v.toFixed(5)));
        }
        return {
            width, height,
            usage: gpu.usage,
            rows: rows.map(r => ({ first3: r.slice(0, 3), mid: r[16], last2: r.slice(-2) })),
            matchesIdentity: rows.every(r => r.every((v, i) => Math.abs(v - i / (width - 1)) < 1e-5))
        };
    });

    console.log(JSON.stringify({ model: MODEL, res, curveWarn: logs.filter(l => /uCurve|curve/i.test(l)).slice(0, 4), errors: errors.slice(0, 3) }, null, 1));
    console.log('\n=== 判定（曲线 LUT 直传内容，裸 WebGPU 读回）===');
    if (res.error) console.log('  ⚠️ ' + res.error + ' ' + JSON.stringify(res.implKeys ?? null));
    else {
        console.log(`  纹理：${res.width}×${res.height}（usage=${res.usage}）`);
        console.log(`  四行样本：${JSON.stringify(res.rows)}`);
        console.log(`  ⇒ ${res.matchesIdentity ? '**内容正确**（四行都是恒等表 i/32）' : '**内容不对**'}`);
    }
    if (logs.some(l => /uCurve direct upload failed/.test(l))) console.log('  ⚠️ 仍有 "uCurve direct upload failed" 警告');

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
