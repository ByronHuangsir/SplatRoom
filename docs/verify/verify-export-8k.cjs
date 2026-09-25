// 8K 导出的端到端回归（第十八轮）：**三条导出路径在 8K 下都要真的出片**，
// 而且 8K 的编码器/容器自动切换要能看见（H.264 在 8K 被 WebCodecs 拒，只能 VP9/AV1）。
//
// 为什么必须真出片：`isConfigSupported` 说行不等于能编（同机实测 H.265 全分辨率被拒）；
// 而且四条导出路径各有各的坑（渲染目标尺寸、equirect 的立方体面、PNG 逐帧写盘、编码器维度上限）。
//
// 实测基线（本机 RTX 5090 / Edge，`docs/probes/export-8k.cjs`）：
//   设备 maxTextureSize = 16384；8K 一帧回读 126.6 MiB（174–295 ms）；
//   PNG 8K 一帧 18.62 MB / ~1.6 s；H.264 8K 被拒、VP9/AV1 8K 可编。
//
// usage: node docs/verify/verify-export-8k.cjs "<url>" [model]
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require(path.join(__dirname, '..', '..', 'node_modules', 'puppeteer-core'));

const { BROWSER_PATH: EDGE } = require('./lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const W8K = 7680;
const H8K = 4320;
const W360_8K = 8192;
const H360_8K = 4096;
const SPEED = 360;        // °/s ⇒ 1 秒一圈
const FRAME_RATE = 12;    // ⇒ 12 帧

const readPng = (file) => {
    const bytes = fs.readFileSync(file);
    return {
        bytes,
        sigOk: bytes.length > 33 && bytes[0] === 0x89 && bytes.toString('ascii', 1, 4) === 'PNG',
        width: bytes.readUInt32BE(16),
        height: bytes.readUInt32BE(20),
        bitDepth: bytes[24],
        colorType: bytes[25]
    };
};

(async () => {
    const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-8k-'));
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 0
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));

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

    // ---- 0. 设备能力：8K 放得下才有后面的意义 ----
    const device = await page.evaluate(() => {
        const dev = window.scene.graphicsDevice;
        return { maxTextureSize: dev.maxTextureSize, isWebGL2: !!dev.isWebGL2 };
    });
    const deviceFits8k = device.maxTextureSize >= W360_8K;
    check('the device can hold an 8K render target (maxTextureSize ≥ 8192)',
        deviceFits8k,
        `maxTextureSize=${device.maxTextureSize}（后端 ${device.isWebGL2 ? 'webgl2' : 'webgpu'}）` +
        `${deviceFits8k ? '' : ' ⇒ 本机跑不了 8K，后面的 8K 检查会失败（这是环境问题，不是回归）'}`);

    // ---- 1. 图像导出 8K：不传 stream ⇒ 走 downloadFile 兜底，CDP 收文件 ----
    // 注意：两次导出会撞同一个文件名，浏览器可能覆盖而不是新开一个 ⇒ 每次导出前把目录清空，
    // 否则第二次会"看不到新文件"（第一版就是这么假红的）。
    const imageExport = async (width, height, projection) => {
        for (const f of fs.readdirSync(downloadDir)) {
            try {
                fs.unlinkSync(path.join(downloadDir, f));
            } catch {
                // 还在被占用：忽略，下面的等待会重试
            }
        }
        const r = await page.evaluate(async (w, h, proj) => {
            const t0 = performance.now();
            const ok = await window.scene.events.invoke('render.image', {
                width: w, height: h, format: 'png', transparentBg: false, showDebug: false, projection: proj
            });
            return { ok, ms: Math.round(performance.now() - t0) };
        }, width, height, projection);
        for (let i = 0; i < 120; i++) {
            await sleep(500);
            const now = fs.readdirSync(downloadDir).filter(f => f.endsWith('.png'));
            if (now.length) {
                const file = path.join(downloadDir, now[0]);
                // 下载可能还在写：等大小稳定
                let last = -1;
                for (let k = 0; k < 60; k++) {
                    const size = fs.statSync(file).size;
                    if (size === last && size > 0) break;
                    last = size;
                    await sleep(250);
                }
                return { ...r, file: now[0], ...readPng(file) };
            }
        }
        return { ...r, file: null };
    };

    const img8k = await imageExport(W8K, H8K, 'standard');
    check('standard 8K PNG export really produces a 7680×4320 image',
        img8k.ok && img8k.file && img8k.sigOk && img8k.width === W8K && img8k.height === H8K &&
        img8k.bytes.length > 8 * 1048576,
        img8k.file
            ? `${img8k.file}：${img8k.width}×${img8k.height}、colorType=${img8k.colorType}、` +
              `${(img8k.bytes.length / 1048576).toFixed(2)} MiB、耗时 ${img8k.ms} ms`
            : `没有落盘（ok=${img8k.ok}）`);

    const img360 = await imageExport(W360_8K, H360_8K, 'equirect');
    check('360 8K (8192×4096) PNG export really produces its file',
        img360.ok && img360.file && img360.sigOk && img360.width === W360_8K && img360.height === H360_8K,
        img360.file
            ? `${img360.file}：${img360.width}×${img360.height}、${(img360.bytes.length / 1048576).toFixed(2)} MiB、` +
              `耗时 ${img360.ms} ms（equirect 走 6 个 4096² 立方体面再投影，比标准路径慢是正常的）`
            : `没有落盘（ok=${img360.ok}）`);

    // ---- 2. 旋转台 8K PNG 帧序列 ----
    const seqDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-8k-seq-'));
    await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: seqDir, eventsEnabled: true });
    await page.evaluate((speed) => window.scene.events.fire('camera.setAutoRotateSpeed', speed), SPEED);
    const seq = await page.evaluate(async (opts) => {
        const t0 = performance.now();
        let result = null;
        let error = null;
        try {
            result = await window.scene.events.invoke('render.turntableVideo', {
                frameRate: opts.frameRate,
                width: opts.width,
                height: opts.height,
                bitrate: 0,
                format: 'png',
                codec: 'h264',
                mode: 'orbit'
            }, undefined, undefined);
        } catch (e) {
            error = String(e).slice(0, 300);
        }
        return { result, error, ms: Math.round(performance.now() - t0) };
    }, { frameRate: FRAME_RATE, width: W8K, height: H8K });

    let seqFiles = [];
    for (let i = 0; i < 240; i++) {
        await sleep(500);
        seqFiles = fs.readdirSync(seqDir).filter(f => f.toLowerCase().endsWith('.png'));
        if (seqFiles.length >= FRAME_RATE) break;
    }
    seqFiles.sort();
    const firstSeq = seqFiles.length ? readPng(path.join(seqDir, seqFiles[0])) : null;
    const seqBytes = seqFiles.reduce((a, f) => a + fs.statSync(path.join(seqDir, f)).size, 0);
    check('turntable 8K PNG sequence writes one 7680×4320 RGBA frame per frame',
        seq.error === null && seqFiles.length === FRAME_RATE && !!firstSeq &&
        firstSeq.width === W8K && firstSeq.height === H8K && firstSeq.colorType === 6,
        seq.error
            ? `error=${seq.error}`
            : `${seqFiles.length}/${FRAME_RATE} 帧、首帧 ${firstSeq?.width}×${firstSeq?.height}、` +
              `colorType=${firstSeq?.colorType}（6=RGBA）、合计 ${(seqBytes / 1048576).toFixed(1)} MiB、` +
              `耗时 ${seq.ms} ms（≈${Math.round(seq.ms / Math.max(1, seqFiles.length))} ms/帧）`);

    // ---- 3. 旋转台 8K 视频（VP9/WebM）：真编真落盘 ----
    const vidDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-8k-vid-'));
    await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: vidDir, eventsEnabled: true });
    const vid = await page.evaluate(async (opts) => {
        const t0 = performance.now();
        let result = null;
        let error = null;
        try {
            result = await window.scene.events.invoke('render.turntableVideo', {
                frameRate: opts.frameRate,
                width: opts.width,
                height: opts.height,
                bitrate: opts.bitrate,
                format: 'webm',
                codec: 'vp9',
                mode: 'orbit'
            }, undefined, undefined);
        } catch (e) {
            error = String(e).slice(0, 300);
        }
        return { result, error, ms: Math.round(performance.now() - t0) };
    }, { frameRate: FRAME_RATE, width: W8K, height: H8K, bitrate: 124416000 });

    let vidFiles = [];
    for (let i = 0; i < 240; i++) {
        await sleep(500);
        vidFiles = fs.readdirSync(vidDir).filter(f => /\.(webm|mkv|mp4|mov)$/i.test(f));
        if (vidFiles.length) {
            const f = path.join(vidDir, vidFiles[0]);
            let last = -1;
            for (let k = 0; k < 40; k++) {
                const size = fs.statSync(f).size;
                if (size === last && size > 0) break;
                last = size;
                await sleep(250);
            }
            break;
        }
    }
    const vidBytes = vidFiles.length ? fs.readFileSync(path.join(vidDir, vidFiles[0])) : null;
    const ebml = vidBytes && vidBytes.length > 4 && vidBytes[0] === 0x1a && vidBytes[1] === 0x45 && vidBytes[2] === 0xdf && vidBytes[3] === 0xa3;
    check('turntable 8K video export encodes a real WebM/VP9 file (H.264 cannot do 8K)',
        vid.error === null && !!ebml && vidBytes.length > 50 * 1024,
        vid.error
            ? `error=${vid.error}`
            : `${vidFiles[0] ?? '(无)'}：${(vidBytes ? vidBytes.length / 1048576 : 0).toFixed(2)} MiB、` +
              `EBML 魔数=${ebml}、耗时 ${vid.ms} ms、bitrate=124416000 bps（改前 8K 那档是 NaN ⇒ configure 直接失败）`);

    // ---- 4. 三条对话框都要能选到 8K，且 8K 下编码器被自动换掉 ----
    const dialogRows = await page.evaluate(async () => {
        const grab = (sel) => {
            const dlg = document.querySelector(sel);
            if (!dlg) {
                return null;
            }
            return Array.from(dlg.querySelectorAll('.row')).map(r => ({
                hidden: r.hidden || getComputedStyle(r).display === 'none',
                text: (r.textContent || '').slice(0, 120)
            }));
        };
        const events = window.scene.events;

        // PCUI 把实例挂在 DOM 节点的 `.ui` 上；按"初始值"认控件（分辨率=1080、投影=standard）
        const findSelect = (root, startValue) => {
            for (const el of Array.from(root.querySelectorAll('*'))) {
                const inst = el.ui;
                if (inst && typeof inst.on === 'function' && String(inst.value) === startValue) {
                    return inst;
                }
            }
            return null;
        };

        // 图像对话框：先把投影切到 360，预设列表才会变成 2:1 那一套
        events.invoke('show.imageSettingsDialog');
        await new Promise(r => setTimeout(r, 1200));
        const imageDlg = document.querySelector('#image-settings-dialog');
        const image = grab('#image-settings-dialog');
        const projection = imageDlg ? findSelect(imageDlg, 'standard') : null;
        let image360 = null;
        if (projection) {
            projection.value = 'equirect';
            await new Promise(r => setTimeout(r, 1000));
            image360 = grab('#image-settings-dialog');
        }

        // 旋转台对话框
        events.invoke('show.turntableVideoDialog', 'orbit');
        await new Promise(r => setTimeout(r, 1500));
        const turntableBefore = grab('#turntable-video-dialog');

        // 把分辨率设成 8k：策略应当把容器换 WebM、编码器换 VP9/AV1 并给出说明
        const dlg = document.querySelector('#turntable-video-dialog');
        const resolution = dlg ? findSelect(dlg, '1080') : null;
        if (resolution) {
            resolution.value = '8k';
        }
        await new Promise(r => setTimeout(r, 1500));
        const turntable8k = grab('#turntable-video-dialog');

        return { image, image360, turntableBefore, turntable8k, switched: !!resolution, projected: !!projection };
    });

    const flat = (rows) => (rows ?? []).map(r => r.text).join(' || ');
    check('the image export dialog offers 8K (and 360 8K) as presets',
        !!dialogRows.image && !!dialogRows.image360 &&
        flat(dialogRows.image).includes('8K') && flat(dialogRows.image).includes('4K') &&
        flat(dialogRows.image360).includes('8192x4096') && flat(dialogRows.image360).includes('4096x2048'),
        dialogRows.image
            ? `标准投影预设：${(dialogRows.image.find(r => r.text.includes('8K')) ?? {}).text ?? '(找不到 8K)'}\n         ` +
              `切到 360 后：${(dialogRows.image360 ?? []).map(r => r.text).join(' || ').slice(0, 160) ?? '(切不过去)'}`
            : '找不到 #image-settings-dialog');

    const ttBefore = flat(dialogRows.turntableBefore);
    const tt8k = flat(dialogRows.turntable8k);
    check('the turntable dialog offers 8K and auto-switches to VP9/AV1 with a visible note',
        !!dialogRows.turntableBefore && ttBefore.includes('7680x4320') &&
        dialogRows.switched && tt8k.includes('WebM') && tt8k.includes('VP9') &&
        !tt8k.includes('H.264') && /VP9\/AV1/.test(tt8k),
        dialogRows.turntableBefore
            ? `选 8K 前：分辨率行含 7680x4320=${ttBefore.includes('7680x4320')}；` +
              `选 8K 后：容器含 WebM=${tt8k.includes('WebM')}、编码器含 VP9=${tt8k.includes('VP9')}、` +
              `含 H.264=${tt8k.includes('H.264')}、说明行=${/VP9\/AV1/.test(tt8k)}\n         ` +
              `说明文案：${(dialogRows.turntable8k ?? []).find(r => /VP9\/AV1/.test(r.text))?.text ?? '(无)'}`
            : '找不到 #turntable-video-dialog');

    // 关掉对话框，别把状态留给后面的检查
    await page.evaluate(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await sleep(800);

    check('no page errors during the 8K exports',
        errors.length === 0,
        errors.slice(0, 3).join(' | ') || 'none');

    console.log(JSON.stringify({
        url: URL, model: MODEL, device, checks, failed: checks.filter(c => !c.pass).length
    }, null, 1));

    try {
        fs.rmSync(downloadDir, { recursive: true, force: true });
        fs.rmSync(seqDir, { recursive: true, force: true });
        fs.rmSync(vidDir, { recursive: true, force: true });
    } catch {
        // 临时目录清理失败不影响结论
    }

    await browser.close();
    process.exit(0);
})().catch((e) => {
    console.log(JSON.stringify({ fatal: String(e && e.stack || e).slice(0, 800) }));
    process.exit(1);
});
