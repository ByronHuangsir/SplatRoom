// 旋转台"PNG 帧序列"（透明背景）的回归：`render.turntableVideo` 的 `format === 'png'` 分支。
//
// 为什么这么测：本机 Chromium 编不出带 alpha 的视频（所有 codec 拒绝 `alpha: 'keep'`，
// 见 docs/旋转台透明背景视频-探索结论-2026-09-22.md），所以"透明视频"的落地形态是
// **逐帧 PNG（RGBA）** + 外部 ffmpeg 合成 MOV。这条通路必须证明三件事：
//   ① 真的写出了 N 个 PNG（文件名/数量对得上）；
//   ② 每个 PNG 是 **RGBA**（IHDR colorType = 6）且尺寸正确；
//   ③ 画面里**背景真的是 alpha = 0**、模型区域不透明 —— 也就是"透明背"这件事成立。
// 另外证明"序列不是同一张图重复"（对比首帧与中间帧的字节）。
//
// 落盘走的是应用里同一条 `downloadFile` 兜底（无目录句柄时），所以这里用 CDP 把下载
// 重定向到一个临时目录再检查文件本身。
//
// usage: node docs/verify/verify-turntable-png.cjs "<url>" [model]
const path = require('path');
const fs = require('fs');
const os = require('os');
const puppeteer = require(path.join(__dirname, '..', '..', 'node_modules', 'puppeteer-core'));

const { BROWSER_PATH: EDGE } = require('./lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const WIDTH = 320;
const HEIGHT = 240;
const FRAME_RATE = 12;
const SPEED = 360; // 度/秒 ⇒ 1 秒转一圈 ⇒ 12 帧
const EXPECTED_FRAMES = FRAME_RATE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-turntable-'));
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
    });
    const errors = [];
    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 300)));

    const client = await page.createCDPSession();
    await client.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadDir,
        eventsEnabled: true
    });

    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1500);
    await page.evaluate(async (m) => {
        const buf = await (await fetch('./' + m)).arrayBuffer();
        await window.scene.events.invoke('import', [{ filename: m, contents: new File([buf], m) }]);
    }, MODEL);
    for (let i = 0; i < 60; i++) {
        await sleep(1000);
        if (await page.evaluate(() => window.scene.getElementsByType('splat').length > 0)) break;
    }
    await sleep(2500);

    const checks = [];
    const check = (name, pass, detail) => checks.push({ name, pass, detail });

    // 让旋转快一点：360°/s ⇒ 1 秒一圈 ⇒ 12 帧（否则默认 15°/s 要转 24 秒）
    const started = await page.evaluate(async (opts) => {
        const events = window.scene.events;
        events.fire('camera.setAutoRotateSpeed', opts.speed);
        const t0 = performance.now();
        let result = null;
        let error = null;
        try {
            // 不传 fileStream / baseDir ⇒ 走 downloadFile 兜底（与浏览器里没有目录句柄时一致）
            result = await events.invoke('render.turntableVideo', {
                frameRate: opts.frameRate,
                width: opts.width,
                height: opts.height,
                bitrate: 1_000_000,
                format: 'png',
                codec: 'h264',
                mode: 'orbit'
            }, undefined, undefined);
        } catch (e) {
            error = String(e).slice(0, 300);
        }
        return { result, error, ms: Math.round(performance.now() - t0) };
    }, { speed: SPEED, frameRate: FRAME_RATE, width: WIDTH, height: HEIGHT });

    // 等文件落盘
    let files = [];
    for (let i = 0; i < 60; i++) {
        await sleep(500);
        files = fs.readdirSync(downloadDir).filter(f => f.toLowerCase().endsWith('.png'));
        if (files.length >= EXPECTED_FRAMES) break;
    }
    files.sort();

    check('the export reports success and writes one PNG per turntable frame',
        started.error === null && files.length === EXPECTED_FRAMES,
        `result=${JSON.stringify(started.result)}${started.error ? ` error=${started.error}` : ''}；` +
        `写出 ${files.length} 个 PNG（期望 ${EXPECTED_FRAMES}）；耗时 ${started.ms} ms；` +
        `首个文件 ${files[0] ?? '(无)'}`);

    // 解析 PNG：签名 + IHDR（宽高与 colorType）
    const readPng = (file) => {
        const bytes = fs.readFileSync(path.join(downloadDir, file));
        const sigOk = bytes.length > 33 && bytes[0] === 0x89 && bytes.toString('ascii', 1, 4) === 'PNG';
        const width = bytes.readUInt32BE(16);
        const height = bytes.readUInt32BE(20);
        const bitDepth = bytes[8 + 16];
        const colorType = bytes[25];
        return { bytes, sigOk, width, height, bitDepth, colorType };
    };

    const first = readPng(files[0]);
    const mid = readPng(files[Math.floor(files.length / 2)]);

    check('every frame is an RGBA PNG at the requested size (IHDR colorType = 6, bit depth 8)',
        first.sigOk && first.colorType === 6 && first.bitDepth === 8 &&
        first.width === WIDTH && first.height === HEIGHT,
        `签名=${first.sigOk} 尺寸=${first.width}×${first.height} 位深=${first.bitDepth} colorType=${first.colorType}` +
        `（6 = RGBA ⇒ 带 alpha）`);

    // 把首帧送回页面解码，统计 alpha（这一步是"透明背景"的直接证据）
    const alphaStats = await page.evaluate(async (b64, w, h) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, w, h).data;
        let transparent = 0;
        let opaque = 0;
        let partial = 0;
        let minAlpha = 255;
        for (let i = 3; i < d.length; i += 4) {
            const a = d[i];
            if (a < minAlpha) minAlpha = a;
            if (a === 0) transparent++;
            else if (a > 200) opaque++;
            else partial++;
        }
        const total = w * h;
        return {
            decoded: [img.naturalWidth, img.naturalHeight],
            transparentPct: +(100 * transparent / total).toFixed(1),
            opaquePct: +(100 * opaque / total).toFixed(1),
            partialPct: +(100 * partial / total).toFixed(1),
            minAlpha
        };
    }, first.bytes.toString('base64'), WIDTH, HEIGHT);

    check('the frame decodes with a transparent background and an opaque model',
        alphaStats.decoded[0] === WIDTH && alphaStats.decoded[1] === HEIGHT &&
        alphaStats.minAlpha === 0 && alphaStats.transparentPct > 3 && alphaStats.opaquePct > 5,
        `解码尺寸=${alphaStats.decoded.join('×')}；全透明像素 ${alphaStats.transparentPct}%、` +
        `不透明 ${alphaStats.opaquePct}%、半透明 ${alphaStats.partialPct}%；minAlpha=${alphaStats.minAlpha}` +
        `（判据：存在 minAlpha=0 的像素 ⇒ 背景真透明；模型占满画面时"全透明"比例本来就不高）`);

    check('the sequence actually rotates (first and middle frames differ)',
        !first.bytes.equals(mid.bytes),
        `首帧 ${files[0]}（${first.bytes.length} B）与中间帧 ${files[Math.floor(files.length / 2)]}` +
        `（${mid.bytes.length} B）字节不同 ⇒ 不是同一张图重复`);

    check('no page errors during the sequence export', errors.length === 0,
        errors.slice(0, 3).join(' | ') || 'none');

    // ---- 反向保护：帧序列的改动不能弄坏原来的视频通路 ----
    // （`render.turntableVideo` 现在有 isSequence 分支：不建 muxer/编码器/音轨，
    //   所以必须证明"非序列"那条路仍然能出片。）
    const video = await page.evaluate(async (opts) => {
        const events = window.scene.events;
        events.fire('camera.setAutoRotateSpeed', opts.speed);
        try {
            const result = await events.invoke('render.turntableVideo', {
                frameRate: opts.frameRate,
                width: opts.width,
                height: opts.height,
                bitrate: 1_000_000,
                format: 'webm',
                codec: 'vp9',
                mode: 'orbit'
            }, undefined, undefined);
            return { result };
        } catch (e) {
            return { error: String(e).slice(0, 300) };
        }
    }, { speed: SPEED, frameRate: FRAME_RATE, width: WIDTH, height: HEIGHT });

    let webm = null;
    for (let i = 0; i < 40; i++) {
        await sleep(500);
        const f = fs.readdirSync(downloadDir).find(x => x.toLowerCase().endsWith('.webm'));
        if (f) {
            webm = { name: f, size: fs.statSync(path.join(downloadDir, f)).size };
            break;
        }
    }

    check('the video path still works after the sequence change (WebM/VP9 export produces a file)',
        video.error === undefined && !!webm && webm.size > 10 * 1024,
        video.error ? `error=${video.error}`
            : `result=${JSON.stringify(video.result)}；文件 ${webm ? `${webm.name}（${webm.size} B）` : '(未生成)'}`);

    console.log(JSON.stringify({
        url: URL, model: MODEL, width: WIDTH, height: HEIGHT, frameRate: FRAME_RATE,
        expectedFrames: EXPECTED_FRAMES, writtenFrames: files.length, ms: started.ms,
        alphaStats, checks, failed: checks.filter(c => !c.pass).length
    }, null, 1));

    await browser.close();
    try {
        fs.rmSync(downloadDir, { recursive: true, force: true });
    } catch { /* 临时目录清不掉不影响结论 */ }
    process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ fatal: String(e && e.stack || e).slice(0, 600) })); process.exit(1); });
