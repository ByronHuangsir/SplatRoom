// 大模型上的 A/B：查看器 html / 打包 zip 各跑一遍"流式 vs 官方 writer"，外加 SOG，
// 量 ≥8MB 分配合计、单次最大分配与耗时（本会话用它标定 src/app/file-handler.ts 里的 memoryMultiple）。
// 需要 dist\merged-scene.ply（或 scan.ply）在站点目录里；导入偶发挂住时页内自动重试。
// 用法：node docs/probes/viewer-ab-13m.cjs <url> [model]
const puppeteer = require('puppeteer-core');
const { BROWSER_PATH: EDGE } = require('../verify/lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'merged-scene.ply';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const t0 = Date.now();
    const mark = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
    const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'], protocolTimeout: 1800000 });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    page.on('pageerror', e => console.log('[pageerror] ' + String(e).slice(0, 300)));
    page.on('console', (m) => { const t = m.text(); if (t.startsWith('[diag]') || m.type() === 'warning') console.log('[console] ' + t.slice(0, 300)); });

    await page.evaluateOnNewDocument(() => {
        window.__allocs = [];
        const MB = 1024 * 1024;
        const wrap = (name) => {
            const Orig = window[name];
            const Patched = function (...args) {
                const size = typeof args[0] === 'number' ? args[0] * (Orig.BYTES_PER_ELEMENT || 1) : 0;
                if (size >= 8 * MB) {
                    const st = (new Error().stack || '').split('\n').slice(1, 7).map(s => s.trim().replace(/^at\s+/, '').replace(/https?:\/\/[^ )]+/, '')).join(' <- ');
                    window.__allocs.push({ ctor: name, bytes: size, stack: st });
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
                const st = (new Error().stack || '').split('\n').slice(1, 7).map(s => s.trim().replace(/^at\s+/, '').replace(/https?:\/\/[^ )]+/, '')).join(' <- ');
                window.__allocs.push({ ctor: 'ArrayBuffer', bytes: args[0], stack: st });
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
    mark('fetch ' + MODEL);
    await page.evaluate(async (m) => {
        window.__buf = new Uint8Array(await (await fetch('./' + m)).arrayBuffer());
    }, MODEL);
    mark('fetched');

    // 导入偶尔会"挂住"（app 启动竞态）：这里在页内重试，别让一次假死废掉整趟测量
    let imported = 0;
    for (let attempt = 1; attempt <= 3 && imported === 0; attempt++) {
        await page.evaluate(async (m) => {
            window.__loadDone = false;
            window.__loadErr = null;
            window.scene.events.invoke('import', [{ filename: m, contents: new File([window.__buf], m) }])
                .then(() => { window.__loadDone = true; })
                .catch((e) => { window.__loadErr = String(e).slice(0, 200); });
        }, MODEL);
        for (let i = 0; i < 30; i++) {
            await sleep(3000);
            const st = await page.evaluate(() => ({ n: window.scene.getElementsByType('splat').length, done: window.__loadDone === true, err: window.__loadErr }));
            if (st.n > 0) {
                imported = st.n;
                break;
            }
            if (st.err) {
                mark(`import error: ${st.err}`);
                break;
            }
        }
        mark(`import attempt ${attempt}: splats=${imported}`);
    }
    if (!imported) {
        console.log('IMPORT-STALLED');
        await browser.close();
        process.exit(2);
    }
    await sleep(6000);

    const results = await page.evaluate(async () => {
        const sleep2 = (ms) => new Promise(r => setTimeout(r, ms));
        const scene = window.scene;
        const MB = 1048576;
        const splat = scene.getElementsByType('splat').slice(-1)[0];
        const numSplats = splat ? splat.splatData.numSplats : 0;
        const cols = splat ? splat.splatData.getElement('vertex').properties.length : 0;

        const makeStream = () => {
            let bytes = 0;
            return { bytes: () => bytes, seek: async () => {}, write: async (d) => { bytes += (d && d.byteLength) || 0; }, truncate: async () => {}, close: async () => {}, abort: async () => {} };
        };
        const popups = [];
        const origPopup = scene.events.functions.get('showPopup');
        scene.events.functions.set('showPopup', (o) => { popups.push(o); });

        const origMax = window.__SPLATROOM_EXPORT_MAX_GB__;
        window.__SPLATROOM_EXPORT_MAX_GB__ = 1000;

        const cases = [
            { key: 'htmlViewer-流式', fileType: 'htmlViewer', streaming: true },
            { key: 'htmlViewer-官方', fileType: 'htmlViewer', streaming: false },
            { key: 'packageViewer-流式', fileType: 'packageViewer', streaming: true },
            { key: 'packageViewer-官方', fileType: 'packageViewer', streaming: false },
            { key: 'sog', fileType: 'sog', streaming: null }
        ];

        const out = { numSplats, cols, types: {} };
        for (const c of cases) {
            window.__SPLATROOM_VIEWER_STREAM__ = c.streaming === null ? undefined : c.streaming;
            window.__allocs.length = 0;
            popups.length = 0;
            const stream = makeStream();
            const t = performance.now();
            let err = null;
            try {
                await Promise.race([
                    scene.events.invoke('scene.write', c.fileType, {
                        filename: c.fileType === 'sog' ? 'output.sog' : (c.fileType === 'packageViewer' ? 'output.zip' : 'output.html'),
                        splatIdx: 'all',
                        serializeSettings: { maxSHBands: 3, sogIterations: 10 },
                        viewerExportSettings: { type: c.fileType === 'packageViewer' ? 'zip' : 'html', background: '#000000' },
                        sogIterations: 10
                    }, stream),
                    sleep2(900000)
                ]);
            } catch (e) {
                err = String(e).slice(0, 200);
            }
            const ms = Math.round(performance.now() - t);
            const allocs = window.__allocs.slice().sort((a, b) => b.bytes - a.bytes);
            const bySite = {};
            for (const a of allocs) {
                const key = a.stack.split(' <- ').slice(0, 2).join(' <- ');
                if (!bySite[key]) bySite[key] = { n: 0, MB: 0 };
                bySite[key].n++;
                bySite[key].MB += a.bytes / MB;
            }
            out.types[c.key] = {
                ms,
                writtenMB: +(stream.bytes() / MB).toFixed(1),
                allocCount: allocs.length,
                totalMB: +(allocs.reduce((n, a) => n + a.bytes, 0) / MB).toFixed(1),
                maxMB: allocs.length ? +(allocs[0].bytes / MB).toFixed(1) : 0,
                err,
                popup: popups.length ? String(popups[0].message || '').slice(0, 100) : null,
                topSites: Object.entries(bySite).sort((a, b) => b[1].MB - a[1].MB).slice(0, 6)
                    .map(([site, v]) => ({ site: site.slice(0, 180), n: v.n, MB: +v.MB.toFixed(1) }))
            };
            console.log(`[diag] done ${c.key}: ${ms}ms / ${out.types[c.key].totalMB}MB 瞬时 / 峰值单次 ${out.types[c.key].maxMB}MB / 写出 ${out.types[c.key].writtenMB}MB`);
            await sleep2(3000);
        }
        scene.events.functions.set('showPopup', origPopup);
        window.__SPLATROOM_EXPORT_MAX_GB__ = origMax;
        window.__SPLATROOM_VIEWER_STREAM__ = undefined;
        return out;
    });

    console.log('@@RESULT@@');
    console.log(JSON.stringify(results, null, 2));
    await browser.close();
})().catch(e => { console.log('FATAL ' + String(e).slice(0, 400)); process.exit(1); });
