// 大模型上"查看器/打包/SOG 真的能导出完"的判定（不是只看小夹具）。
//
// 为什么单独一套：`verify-viewer-stream.cjs` 用 2000 点的 test-model 做**等价性**对拍，
// 而用户报的 ④ 是**大模型上跑到一半分配失败**。这条判定需要真·大夹具，跑一次要几分钟，
// 所以像 verify-load-worker / verify-selection-responsiveness 一样**不进批量**，按需跑。
//
// 判据（都要过）：
//   1) 大模型导入成功（≥50 万点）
//   2) 三种导出都**跑完**：htmlViewer / packageViewer / sog（无异常、写出字节 > 0）
//   3) ★ 单次最大分配 ≤ 256 MB —— 这是"包装层已经流式化"的判据：旧 html-bundle 路径在
//      1300 万点上出现过一次 **396.9 MB** 的单次分配（materializeToDataTable + toBase64）
//   4) ★ htmlViewer 的瞬时分配 ≤ 数据字节 × 4.0 —— 旧口径 6.1（包装层那 2.3 GB），
//      流式化之后实测 2.85
//   5) ★ 没有"退回官方 writer"的 warning（走的确实是流式那条路）
//
// 夹具：按 merged-scene.ply → scan.ply → nosh-test.ply 顺序找第一个存在的（放 dist 下）。
// 一个都没有时**跳过**（failed=0，skipped=true），不假装通过。
//
// usage: node docs/verify/verify-viewer-large.cjs [url] [model]
const puppeteer = require('puppeteer-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const TARGET = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const CANDIDATES = process.argv[3] ? [process.argv[3]] : ['merged-scene.ply', 'scan.ply', 'nosh-test.ply'];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'], protocolTimeout: 1800000 });
    const errors = [];
    const warnings = [];
    let out = null;
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        page.on('pageerror', e => errors.push('pageerror: ' + String(e).slice(0, 300)));
        page.on('console', (m) => {
            const t = m.text();
            if (m.type() === 'error') errors.push('console: ' + t.slice(0, 200));
            if (m.type() === 'warning') warnings.push(t.slice(0, 300));
        });

        // 分配跟踪：只记 >=8MB 的分配（与 docs/probes/export-alloc-per-type.cjs 同口径）。
        // 必须在页面加载**之前**注入：这样应用自己的启动分配也在跟踪范围内。
        await page.evaluateOnNewDocument(() => {
            window.__allocs = [];
            const MB = 1024 * 1024;
            const wrap = (name) => {
                const Orig = window[name];
                const Patched = function (...args) {
                    const size = typeof args[0] === 'number' ? args[0] * (Orig.BYTES_PER_ELEMENT || 1) : 0;
                    if (size >= 8 * MB) {
                        window.__allocs.push({ ctor: name, bytes: size });
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
                    window.__allocs.push({ ctor: 'ArrayBuffer', bytes: args[0] });
                }
                return new OrigAB(...args);
            };
            PatchedAB.prototype = OrigAB.prototype;
            PatchedAB.isView = OrigAB.isView;
            window.ArrayBuffer = PatchedAB;
        });

        await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForFunction('!!window.scene', { timeout: 90000, polling: 500 });
        await sleep(1500);

        // 找夹具
        const model = await page.evaluate(async (names) => {
            for (const n of names) {
                const r = await fetch('./' + n, { method: 'HEAD' });
                if (r.ok) return n;
            }
            return null;
        }, CANDIDATES);

        if (!model) {
            out = { skipped: true, reason: `no large fixture in dist (tried ${CANDIDATES.join(', ')})`, checks: [], failed: 0, errors };
            await browser.close();
            console.log(JSON.stringify(out, null, 2));
            return;
        }

        // 导入（app 启动竞态下偶尔挂住：页内重试）
        let numSplats = 0;
        for (let attempt = 1; attempt <= 3 && numSplats === 0; attempt++) {
            await page.evaluate(async (m) => {
                window.__buf = new Uint8Array(await (await fetch('./' + m)).arrayBuffer());
                window.__loadErr = null;
                window.scene.events.invoke('import', [{ filename: m, contents: new File([window.__buf], m) }])
                    .catch((e) => { window.__loadErr = String(e).slice(0, 200); });
            }, model);
            for (let i = 0; i < 30; i++) {
                await sleep(3000);
                const st = await page.evaluate(() => ({ n: window.scene.getElementsByType('splat').length, err: window.__loadErr }));
                if (st.n > 0) {
                    numSplats = st.n;
                    break;
                }
                if (st.err) break;
            }
        }
        if (!numSplats) {
            out = { model, numSplats: 0, checks: [], failed: 1, errors, fatal: 'import stalled 3 times' };
            await browser.close();
            console.log(JSON.stringify(out, null, 2));
            process.exitCode = 1;
            return;
        }
        await sleep(6000);

        const result = await page.evaluate(async () => {
            const sleep2 = (ms) => new Promise(r => setTimeout(r, ms));
            const scene = window.scene;
            const MB = 1048576;
            const splat = scene.getElementsByType('splat').slice(-1)[0];
            const numSplats = splat.splatData.numSplats;
            const props = splat.splatData.getElement('vertex').properties;
            const datasetBytes = numSplats * props.reduce((m, p) => m + (p.byteSize ?? 4), 0);

            const makeStream = () => {
                let bytes = 0;
                return { bytes: () => bytes, seek: async () => {}, write: async (d) => { bytes += (d && d.byteLength) || 0; }, truncate: async () => {}, close: async () => {}, abort: async () => {} };
            };
            const popups = [];
            const origPopup = scene.events.functions.get('showPopup');
            scene.events.functions.set('showPopup', (o) => { popups.push(o); });
            // 这条套件量的是"能不能跑完"，不测门槛：把事前确认抬到不可能触发
            const origMax = window.__SPLATROOM_EXPORT_MAX_GB__;
            window.__SPLATROOM_EXPORT_MAX_GB__ = 1000;

            const cases = [
                { key: 'htmlViewer', fileType: 'htmlViewer', filename: 'output.html', type: 'html' },
                { key: 'packageViewer', fileType: 'packageViewer', filename: 'output.zip', type: 'zip' },
                { key: 'sog', fileType: 'sog', filename: 'output.sog', type: null }
            ];
            const types = {};
            for (const c of cases) {
                window.__allocs.length = 0;
                popups.length = 0;
                const stream = makeStream();
                const t = performance.now();
                let err = null;
                try {
                    await Promise.race([
                        scene.events.invoke('scene.write', c.fileType, {
                            filename: c.filename,
                            splatIdx: 'all',
                            serializeSettings: { maxSHBands: 3, sogIterations: 10 },
                            viewerExportSettings: c.type ? { type: c.type, background: '#000000' } : undefined,
                            sogIterations: 10
                        }, stream),
                        sleep2(900000)
                    ]);
                } catch (e) {
                    err = String(e).slice(0, 200);
                }
                const ms = Math.round(performance.now() - t);
                const allocs = window.__allocs;
                types[c.key] = {
                    ms,
                    writtenMB: +(stream.bytes() / MB).toFixed(1),
                    allocCount: allocs.length,
                    totalMB: +(allocs.reduce((n, a) => n + a.bytes, 0) / MB).toFixed(1),
                    maxMB: allocs.length ? +(Math.max(...allocs.map(a => a.bytes)) / MB).toFixed(1) : 0,
                    err,
                    popup: popups.length ? String(popups[0].message || '').slice(0, 120) : null
                };
                await sleep2(2000);
            }
            scene.events.functions.set('showPopup', origPopup);
            window.__SPLATROOM_EXPORT_MAX_GB__ = origMax;
            return { numSplats, cols: props.length, datasetMB: +(datasetBytes / MB).toFixed(1), types };
        });

        const fallbackWarnings = warnings.filter(w => /viewer stream|viewer template unavailable/i.test(w));
        const t = result.types;
        const done = (k) => t[k] && !t[k].err && t[k].writtenMB > 0;
        const maxSingle = Math.max(t.htmlViewer.maxMB, t.packageViewer.maxMB, t.sog.maxMB);
        const htmlRatio = +(result.datasetMB ? t.htmlViewer.totalMB / result.datasetMB : 0).toFixed(2);

        const checks = [
            { name: `大模型导入成功（≥50 万点）`, pass: result.numSplats >= 500000, detail: `${result.numSplats} 点 / ${result.cols} 列 / 自身数据 ${result.datasetMB} MB` },
            { name: '★ htmlViewer 跑完（无异常、写出了字节）', pass: done('htmlViewer'), detail: JSON.stringify(t.htmlViewer) },
            { name: '★ packageViewer 跑完', pass: done('packageViewer'), detail: JSON.stringify(t.packageViewer) },
            { name: '★ sog 跑完', pass: done('sog'), detail: JSON.stringify(t.sog) },
            { name: '★ 单次最大分配 ≤ 256 MB（包装层已流式化；旧 html-bundle 路径在同样的 1300 万点上出现过 396.9 MB 的单次分配）', pass: maxSingle <= 256, detail: `三种导出里最大的单次分配 = ${maxSingle} MB` },
            { name: '★ htmlViewer 瞬时分配 ≤ 数据字节 × 4.0（旧口径 6.1）', pass: htmlRatio <= 4.0, detail: `${t.htmlViewer.totalMB} MB / ${result.datasetMB} MB = ×${htmlRatio}` },
            { name: '★ 走的是流式那条路（没有"退回官方 writer"的 warning）', pass: fallbackWarnings.length === 0, detail: fallbackWarnings.length ? fallbackWarnings.join(' | ') : '无退回 warning' }
        ];

        out = { model, skipped: false, result, checks, failed: checks.filter(c => !c.pass).length, errors };
    } catch (err) {
        if (!out) {
            out = { fatal: String(err).slice(0, 600), errors, failed: 1 };
        }
    } finally {
        await browser.close();
    }

    console.log(JSON.stringify(out, null, 2));
    if (out.failed > 0) process.exitCode = 1;
})();
