// 8K 导出的可行性口径（第十八轮）：设备上限 / 编码器支持矩阵 / 真渲一帧 8K 的耗时与内存 / 真出片字节数。
//
// 为什么先量再改：把上限抬到 8K 会一次性碰到四个墙，必须在动 UI 之前知道哪个墙真的存在 ——
//   ① 设备：`maxTextureSize` / `maxRenderTargetSize`（WebGL2）或 `limits.maxTextureDimension2D`（WebGPU）；
//   ② 编码器：WebCodecs 对 H.264/H.265/VP9/AV1 在各分辨率下的 `isConfigSupported`；
//   ③ 内存：8K RGBA 一帧 132.7 MB（360-8K 还要 6 张 4096² 的立方体面 ≈ 402 MB）；
//   ④ 出片：PNG 编码 + 写盘（旋转台逐帧写，一帧就是一张 8K PNG）。
//
// usage: node docs/probes/export-8k.cjs "<url>" [model]
const path = require('path');
const puppeteer = require(path.join(__dirname, '..', '..', 'node_modules', 'puppeteer-core'));

const { BROWSER_PATH: EDGE } = require('../verify/lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-precise-memory-info'],
        protocolTimeout: 0
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1200);

    await page.evaluate(async (m) => {
        const buf = await (await fetch('./' + m)).arrayBuffer();
        await window.scene.events.invoke('import', [{ filename: m, contents: new File([buf], m) }]);
    }, MODEL);
    for (let i = 0; i < 60; i++) {
        await sleep(500);
        if (await page.evaluate(() => window.scene.getElementsByType('splat').length > 0)) break;
    }
    await sleep(2500);

    const out = { url: URL, model: MODEL, errors };

    // ---- ① 设备上限 ----
    out.device = await page.evaluate(() => {
        const scene = window.scene;
        const dev = scene.graphicsDevice;
        const r = {
            isWebGL2: !!dev.isWebGL2,
            maxTextureSize: dev.maxTextureSize,
            maxRenderTargetSize: dev.maxRenderTargetSize,
            maxCubeMapSize: dev.maxCubeMapSize,
            deviceType: dev.deviceType
        };
        try {
            r.limits = dev.limits ? {
                maxTextureDimension2D: dev.limits.maxTextureDimension2D,
                maxTextureDimension3D: dev.limits.maxTextureDimension3D,
                maxColorAttachmentBytesPerSample: dev.limits.maxColorAttachmentBytesPerSample
            } : null;
        } catch (e) {
            r.limits = 'error: ' + String(e);
        }
        const mem = performance.memory;
        r.jsHeapMb = mem ? Math.round(mem.usedJSHeapSize / 1048576) : null;
        return r;
    });

    // ---- ② 编码器支持矩阵（用**应用真实使用的** codec 字符串）----
    // 关键：`isConfigSupported` 必须问应用真去 configure 的那个字符串，
    // 否则"问支持"和"真去编"不是同一件事（见 src/app/render.ts 的 CODEC_CONFIG）。
    out.encoders = await page.evaluate(async () => {
        if (typeof VideoEncoder === 'undefined') {
            return { error: 'no VideoEncoder' };
        }
        const sizes = [
            { label: '1080p', width: 1920, height: 1080 },
            { label: '4K', width: 3840, height: 2160 },
            { label: '360-4K', width: 4096, height: 2048 },
            { label: '8K', width: 7680, height: 4320 },
            { label: '360-8K', width: 8192, height: 4096 },
            { label: '8K-square', width: 8192, height: 8192 }
        ];
        // 与 render.ts CODEC_CONFIG 完全一致的字符串
        const codecs = [
            { label: 'h264', codec: (h) => h < 1080 ? 'avc1.420028' : 'avc1.640033' },
            { label: 'h265', codec: () => 'hev1.1.6.L120.B0' },
            { label: 'vp9', codec: () => 'vp09.00.10.08' },
            { label: 'av1', codec: () => 'av01.0.05M.08' }
        ];
        const rows = [];
        for (const s of codecs) {
            for (const z of sizes) {
                const cfg = {
                    codec: s.codec(z.height), width: z.width, height: z.height,
                    bitrate: Math.floor(10 * z.width * z.height * 30 * 0.1),
                    framerate: 30
                };
                let supported = false;
                let why = '';
                try {
                    const r = await VideoEncoder.isConfigSupported(cfg);
                    supported = !!r.supported;
                    if (!supported) {
                        why = 'rejected';
                    }
                } catch (e) {
                    why = String(e && e.message || e).slice(0, 90);
                }
                rows.push({ codec: s.label, size: z.label, wh: `${z.width}x${z.height}`, cfg: cfg.codec, supported, why });
            }
        }
        return { rows };
    });

    // ---- ②b 真编一帧：`isConfigSupported` 说行不算行，能 configure + encode 才算 ----
    out.encodeProbe = await page.evaluate(async () => {
        const tryEncode = async (label, codecStr, width, height) => {
            try {
                const chunks = [];
                let err = null;
                const enc = new VideoEncoder({
                    output: (chunk) => chunks.push(chunk.byteLength),
                    error: (e) => { err = String(e && e.message || e).slice(0, 160); }
                });
                const cfg = {
                    codec: codecStr, width, height,
                    bitrate: Math.floor(10 * width * height * 30 * 0.1),
                    framerate: 30,
                    latencyMode: 'quality'
                };
                const support = await VideoEncoder.isConfigSupported(cfg);
                if (!support.supported) {
                    return { label, codec: codecStr, wh: `${width}x${height}`, configured: false, why: 'isConfigSupported=false' };
                }
                enc.configure(cfg);
                // 一帧纯色（构造 I420/NV12 需要真数据，用 canvas 造最省事）
                const c = new OffscreenCanvas(width, height);
                const ctx = c.getContext('2d');
                ctx.fillStyle = '#204060';
                ctx.fillRect(0, 0, width, height);
                const frame = new VideoFrame(c, { timestamp: 0, duration: 33333 });
                enc.encode(frame, { keyFrame: true });
                await enc.flush();
                frame.close();
                enc.close();
                return {
                    label, codec: codecStr, wh: `${width}x${height}`, configured: true,
                    chunks: chunks.length, bytes: chunks.reduce((a, b) => a + b, 0), err
                };
            } catch (e) {
                return { label, codec: codecStr, wh: `${width}x${height}`, configured: false, why: String(e && e.message || e).slice(0, 160) };
            }
        };
        return [
            await tryEncode('vp9-4K', 'vp09.00.10.08', 3840, 2160),
            await tryEncode('vp9-8K', 'vp09.00.10.08', 7680, 4320),
            await tryEncode('vp9-360-8K', 'vp09.00.10.08', 8192, 4096),
            await tryEncode('av1-8K', 'av01.0.05M.08', 7680, 4320),
            await tryEncode('h264-4K', 'avc1.640033', 3840, 2160),
            await tryEncode('h264-8K', 'avc1.640033', 7680, 4320)
        ];
    });

    // ---- ③ 真渲一帧 + 回读（含 360 的立方体面路径）----
    const renderAt = (width, height) => page.evaluate(async (w, h) => {
        const scene = window.scene;
        const before = performance.memory ? performance.memory.usedJSHeapSize : 0;
        const t0 = performance.now();
        let bytes = null;
        let err = null;
        try {
            bytes = await scene.events.invoke('render.offscreen', w, h);
        } catch (e) {
            err = String(e && e.message || e).slice(0, 200);
        }
        const dt = performance.now() - t0;
        const after = performance.memory ? performance.memory.usedJSHeapSize : 0;
        // 亮像素比例（验证"真画了东西"，而不是一张空图）
        let lit = 0;
        let opaque = 0;
        if (bytes && bytes.length) {
            const step = 4 * 997;   // 质数步长，避免只采到一行
            let n = 0;
            for (let i = 0; i + 3 < bytes.length; i += step) {
                n++;
                if (bytes[i] + bytes[i + 1] + bytes[i + 2] > 12) lit++;
                if (bytes[i + 3] > 250) opaque++;
            }
            return {
                ok: true, ms: Math.round(dt), bytes: bytes.length,
                mb: +(bytes.length / 1048576).toFixed(1),
                litPct: +(100 * lit / Math.max(1, n)).toFixed(1),
                opaquePct: +(100 * opaque / Math.max(1, n)).toFixed(1),
                heapDeltaMb: Math.round((after - before) / 1048576)
            };
        }
        return { ok: false, ms: Math.round(dt), err };
    }, width, height);

    out.offscreen = {};
    for (const [label, w, h] of [
        ['4K', 3840, 2160],
        ['8K', 7680, 4320],
        ['360-8K(8192x4096)', 8192, 4096]
    ]) {
        out.offscreen[label] = await renderAt(w, h);
        await sleep(500);
    }

    // ---- ④ 真出片：8K PNG（走 render.image + 桩 stream）----
    out.png = await page.evaluate(async () => {
        const scene = window.scene;
        const run = async (width, height, projection) => {
            let captured = 0;
            let capturedType = '';
            const stream = {
                write: async (chunk) => { captured += chunk.byteLength ?? chunk.length ?? 0; },
                close: async () => { },
                abort: async () => { }
            };
            const t0 = performance.now();
            const okFlag = await scene.events.invoke('render.image', {
                width, height, format: 'png', transparentBg: false, showDebug: false, projection
            }, stream);
            return { ok: !!okFlag, ms: Math.round(performance.now() - t0), bytes: captured, mb: +(captured / 1048576).toFixed(2), capturedType };
        };
        return {
            png4k: await run(3840, 2160, 'standard'),
            png8k: await run(7680, 4320, 'standard'),
            png360_8k: await run(8192, 4096, 'equirect')
        };
    });

    out.errors = errors;
    console.log(JSON.stringify(out, null, 1));
    await browser.close();
    process.exit(0);
})().catch((e) => {
    console.log(JSON.stringify({ fatal: String(e && e.stack || e).slice(0, 800) }));
    process.exit(1);
});
