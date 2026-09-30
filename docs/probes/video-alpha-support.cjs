// 透明背景视频导出的**可行性判据**（2026-09-22，任务 4）。
//
// 问题：用户要"旋转台视频导出透明背通道视频（mov 格式）"。要回答的其实是两件事：
//   ① 这台机器上的 Chromium（Electron 43 / Chromium 150）到底支不支持**带 alpha 的编码**，
//      支持哪些 codec —— 用 `VideoEncoder.isConfigSupported({ alpha: 'keep' })` 逐个问；
//   ② 就算编出来了，**容器**能不能装：本项目的封装库是 mediabunny 1.50.8，
//      alpha 只有 Matroska/WebM 的 muxer 会写（`EBMLId.AlphaMode` + BlockAdditions），
//      ISOBMFF（mp4/mov）muxer 里连 `sideData` 都不存在 ⇒ MOV + alpha 在这套架构下写不出来。
//
// 本探针只做 ① 的实测（② 是读源码得到的结论），并做一次**往返验证**：
// 编一帧"左半边不透明、右半边全透明"的 RGBA，再用 `VideoDecoder` 解回来读 alpha，
// 看 alpha 通道到底有没有被保住（这是"透明视频"成立与否的分水岭）。
//
// usage: node docs/probes/video-alpha-support.cjs "<url>" [extraChromiumArgs]
//   第 2 个参数是**追加的 Chromium 开关**（逗号分隔），用来验证"alpha 编码是不是被特性开关挡住"，
//   例：node docs/probes/video-alpha-support.cjs "http://localhost:3621/?gpu=webgpu" "--enable-features=WebCodecsAlphaEncoder"
const path = require('path');
const puppeteer = require(path.join(__dirname, '..', '..', 'node_modules', 'puppeteer-core'));

const { BROWSER_PATH: EDGE , launchPatched: _launchPatched } = require('../verify/lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const EXTRA_ARGS = String(process.argv[3] || '').split(',').map(s => s.trim()).filter(Boolean);

(async () => {
    const browser = await _launchPatched(puppeteer, {
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', ...EXTRA_ARGS],
        protocolTimeout: 0
    });
    const page = await browser.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });

    const out = await page.evaluate(async () => {
        const result = { ua: navigator.userAgent, codecs: [], roundTrip: null, recorder: [], notes: [] };

        // ---- ① codec × alpha 支持矩阵 ----
        const codecs = [
            ['vp8', 'vp8'],
            ['vp9', 'vp09.00.10.08'],
            ['av1', 'av01.0.05M.08'],
            ['h264', 'avc1.42001f'],
            ['h265', 'hev1.1.6.L93.B0']
        ];
        for (const [name, codec] of codecs) {
            const row = { name, codec };
            for (const alpha of ['discard', 'keep']) {
                try {
                    const r = await VideoEncoder.isConfigSupported({ codec, width: 1280, height: 720, bitrate: 6_000_000, alpha });
                    row[alpha] = !!r.supported;
                } catch (e) {
                    row[alpha] = `throw: ${String(e).slice(0, 60)}`;
                }
            }
            result.codecs.push(row);
        }

        // ---- ② 往返：编一帧带 alpha 的 RGBA，解回来读 alpha ----
        const tryRoundTrip = async (codec) => {
            const W = 256;
            const H = 128;
            try {
                const cfg = { codec, width: W, height: H, bitrate: 2_000_000, alpha: 'keep' };
                const support = await VideoEncoder.isConfigSupported(cfg);
                if (!support.supported) return { codec, ok: false, why: 'isConfigSupported=false' };

                const chunks = [];
                const encoder = new VideoEncoder({
                    output: (chunk) => chunks.push(chunk),
                    error: (e) => { chunks.push({ error: String(e) }); }
                });
                encoder.configure(cfg);

                // 左半边：不透明红（预乘 alpha=1 时 rgb 保持不变）；右半边：完全透明
                const data = new Uint8ClampedArray(W * H * 4);
                for (let y = 0; y < H; y++) {
                    for (let x = 0; x < W; x++) {
                        const i = (y * W + x) * 4;
                        const opaque = x < W / 2;
                        data[i] = opaque ? 255 : 0;
                        data[i + 1] = 0;
                        data[i + 2] = 0;
                        data[i + 3] = opaque ? 255 : 0;
                    }
                }
                const frame = new VideoFrame(data, { format: 'RGBA', codedWidth: W, codedHeight: H, timestamp: 0 });
                encoder.encode(frame, { keyFrame: true });
                frame.close();
                await encoder.flush();
                encoder.close();

                if (!chunks.length || chunks[0].error) {
                    return { codec, ok: false, why: chunks[0]?.error ?? 'no output chunk' };
                }
                const dec = new VideoDecoder({
                    output: () => { },
                    error: () => { }
                });
                const decoded = [];
                const dec2 = new VideoDecoder({
                    output: (f) => decoded.push(f),
                    error: (e) => decoded.push({ error: String(e) })
                });
                dec.close();
                dec2.configure({ codec, codedWidth: W, codedHeight: H });
                dec2.decode(chunks[0]);
                await dec2.flush();
                const f = decoded.find(d => d && !d.error);
                if (!f) {
                    return { codec, ok: false, why: 'decode produced nothing', chunks: chunks.length, decoderConfig: chunks[0].decoderConfig?.codec ?? null };
                }
                const fmt = f.format;
                // 读回像素（VideoFrame 支持 copyTo，格式可能是 I420 等，用 canvas 统一）
                const c = document.createElement('canvas');
                c.width = W; c.height = H;
                const ctx = c.getContext('2d', { willReadFrequently: true });
                ctx.clearRect(0, 0, W, H);
                ctx.drawImage(f, 0, 0);
                const px = ctx.getImageData(0, 0, W, H).data;
                const leftAlpha = px[(H / 2 * W + W / 4) * 4 + 3];
                const rightAlpha = px[(H / 2 * W + (W * 3) / 4) * 4 + 3];
                const leftRgb = [px[(H / 2 * W + W / 4) * 4], px[(H / 2 * W + W / 4) * 4 + 1], px[(H / 2 * W + W / 4) * 4 + 2]];
                f.close();
                dec2.close();
                return {
                    codec, ok: true, frameFormat: fmt, leftAlpha, rightAlpha, leftRgb,
                    alphaPreserved: leftAlpha > 200 && rightAlpha < 40
                };
            } catch (e) {
                return { codec, ok: false, why: String(e).slice(0, 160) };
            }
        };
        result.roundTrip = [];
        for (const codec of ['vp09.00.10.08', 'vp8', 'av01.0.05M.08']) {
            result.roundTrip.push(await tryRoundTrip(codec));
        }

        // ---- ③ MediaRecorder 侧（另一条老路）----
        for (const t of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4;codecs=avc1.42001f', 'video/quicktime']) {
            result.recorder.push({ type: t, supported: MediaRecorder.isTypeSupported(t) });
        }
        result.notes.push('MOV/MP4 + alpha：ISOBMFF muxer（mediabunny）不写 alpha side data ⇒ 架构上写不出透明 MOV');
        return result;
    });

    console.log(JSON.stringify({ extraArgs: EXTRA_ARGS, ...out }, null, 1));
    await browser.close().catch(() => { });
    process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ fatal: String(e).slice(0, 400) })); process.exit(1); });
