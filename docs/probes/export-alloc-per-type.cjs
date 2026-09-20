// 诊断 ④ 的真正归属：逐个导出类型量分配（用"假 stream"走流式路径，隔离序列化器自身）。
// 用法：node export-alloc-per-type.cjs <url> [model]
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'scan.ply';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'], protocolTimeout: 1800000 });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    page.on('pageerror', e => console.log('[pageerror] ' + String(e).slice(0, 300)));
    page.on('console', (m) => { const t = m.text(); if (t.startsWith('[diag]')) console.log(t); });

    await page.evaluateOnNewDocument(() => {
        window.__allocs = [];
        const MB = 1024 * 1024;
        const wrap = (name) => {
            const Orig = window[name];
            const Patched = function (...args) {
                const size = typeof args[0] === 'number' ? args[0] * (Orig.BYTES_PER_ELEMENT || 1) : 0;
                if (size >= 8 * MB) {
                    window.__allocs.push({ ctor: name, bytes: size, stack: (new Error().stack || '').split('\n').slice(2, 6).join(' | ') });
                }
                return new Orig(...args);
            };
            Patched.prototype = Orig.prototype;
            Patched.BYTES_PER_ELEMENT = Orig.BYTES_PER_ELEMENT;
            Patched.from = Orig.from && Orig.from.bind(Orig);
            Patched.of = Orig.of && Orig.of.bind(Orig);
            window[name] = Patched;
        };
        ['Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array', 'Uint8ClampedArray'].forEach(wrap);
        const OrigAB = window.ArrayBuffer;
        const PatchedAB = function (...args) {
            if (typeof args[0] === 'number' && args[0] >= 8 * MB) {
                window.__allocs.push({ ctor: 'ArrayBuffer', bytes: args[0], stack: (new Error().stack || '').split('\n').slice(2, 6).join(' | ') });
            }
            return new OrigAB(...args);
        };
        PatchedAB.prototype = OrigAB.prototype;
        PatchedAB.isView = OrigAB.isView;
        window.ArrayBuffer = PatchedAB;
    });

    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 90000, polling: 500 });
    await sleep(1500);
    await page.evaluate(async (m) => {
        window.__buf = new Uint8Array(await (await fetch('./' + m)).arrayBuffer());
    }, MODEL);
    await page.evaluate(async (m) => {
        const scene = window.scene;
        window.__loadDone = false;
        scene.events.invoke('import', [{ filename: m, contents: new File([window.__buf], m) }])
            .then(() => { window.__loadDone = true; })
            .catch((e) => { window.__loadErr = String(e).slice(0, 200); });
    }, MODEL);
    for (let i = 0; i < 40 && !(await page.evaluate(() => window.__loadDone || window.__loadErr)); i++) await sleep(5000);
    console.log('[diag] loaded');
    await sleep(5000);

    const results = await page.evaluate(async () => {
        const sleep2 = (ms) => new Promise(r => setTimeout(r, ms));
        const scene = window.scene;
        const MB = 1048576;

        // 假 stream：走流式写盘那条分支，但不真的落盘/不真的建 Blob
        const makeStream = () => {
            let bytes = 0;
            return {
                bytes: () => bytes,
                seek: async () => {},
                write: async (d) => { bytes += (d && d.byteLength) || 0; },
                truncate: async () => {},
                close: async () => {},
                abort: async () => {}
            };
        };

        // 拦掉弹窗，避免套件等用户点确定
        const popups = [];
        const originalPopup = scene.events.functions.get('showPopup');
        scene.events.functions.set('showPopup', (opts) => { popups.push(opts); });

        const types = ['ply', 'compressedPly', 'splat', 'spz', 'sog', 'htmlViewer', 'packageViewer'];
        const out = {};
        for (const fileType of types) {
            window.__allocs.length = 0;
            popups.length = 0;
            const stream = makeStream();
            const options = {
                filename: fileType === 'htmlViewer' ? 'output.html' : (fileType === 'packageViewer' ? 'output.zip' : 'output.ply'),
                splatIdx: 'all',
                serializeSettings: { maxSHBands: 3, sogIterations: 10 },
                viewerExportSettings: { type: fileType === 'packageViewer' ? 'zip' : 'html', background: '#000000' },
                sogIterations: 10,
                spzVersion: 4
            };
            const t = performance.now();
            let err = null;
            try {
                await Promise.race([
                    scene.events.invoke('scene.write', fileType, options, stream),
                    sleep2(240000)
                ]);
            } catch (e) {
                err = String(e).slice(0, 200);
            }
            const ms = Math.round(performance.now() - t);
            const allocs = window.__allocs.slice().sort((a, b) => b.bytes - a.bytes);
            out[fileType] = {
                ms,
                bytesWritten: stream.bytes(),
                allocCount: allocs.length,
                totalMB: +(allocs.reduce((n, a) => n + a.bytes, 0) / MB).toFixed(1),
                maxMB: +((allocs.length ? allocs[0].bytes : 0) / MB).toFixed(1),
                topStack: allocs.length ? allocs[0].stack.slice(0, 260) : null,
                err,
                popup: popups.length ? String(popups[0].message || '').slice(0, 120) : null
            };
            await sleep2(1500);
        }
        scene.events.functions.set('showPopup', originalPopup);
        return out;
    });

    console.log(JSON.stringify(results, null, 2));
    await browser.close();
})().catch(e => { console.log('FATAL ' + String(e).slice(0, 400)); process.exit(1); });
