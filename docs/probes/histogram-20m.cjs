// 直方图在带 SH 的大夹具上的验证：WebGPU 的 bin pass（GSPLAT_BIN_QUADS）与 SH_BANDS 正交，
// DC-only 夹具测不到 SH 变体 —— 本探针补这一条：打开数据面板，数直方图柱子与非黑列，并盯 console error。
// 用法：node docs/probes/histogram-20m.cjs <url> [model]
const puppeteer = require('C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-20m.ply';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const t0 = Date.now();
    const mark = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 3600000
    });
    const consoleErrors = [];
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        page.on('pageerror', e => consoleErrors.push('pageerror: ' + String(e).slice(0, 250)));
        page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('console: ' + m.text().slice(0, 250)); });

        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
        await sleep(1500);

        await page.evaluate(async (m) => {
            const head = await fetch('./' + m, { headers: { Range: 'bytes=0-0' } });
            const total = parseInt(head.headers.get('content-range').split('/')[1], 10);
            const CHUNK = 256 * 1048576;
            const parts = [];
            for (let off = 0; off < total; off += CHUNK) {
                const end = Math.min(off + CHUNK - 1, total - 1);
                parts.push(await (await fetch('./' + m, { headers: { Range: `bytes=${off}-${end}` } })).blob());
            }
            window.__file = new File(parts, m);
            window.__loadErr = null;
            window.scene.events.invoke('import', [{ filename: m, contents: window.__file }]).catch(e => { window.__loadErr = String(e).slice(0, 200); });
        }, MODEL);
        mark('fetch+import started');

        let n = 0;
        for (let i = 0; i < 90; i++) {
            await sleep(5000);
            const st = await page.evaluate(() => ({ n: window.scene.getElementsByType('splat').length, splats: window.scene.getElementsByType('splat').map(s => s.splatData ? s.splatData.numSplats : 0), err: window.__loadErr }));
            if (st.n > 0 && st.splats[0] > 0) { n = st.splats[0]; break; }
            if (st.err) throw new Error('import: ' + st.err);
            if (i % 6 === 5) mark(`importing… ${JSON.stringify(st.splats)}`);
        }
        if (!n) throw new Error('import stalled');
        mark(`imported ${n}`);
        await sleep(6000);

        // 打开数据面板，等直方图算完（20M 需要几秒）
        const result = await page.evaluate(async () => {
            const sleep2 = (ms) => new Promise(r => setTimeout(r, ms));
            const scene = window.scene;
            const splat = scene.getElementsByType('splat').slice(-1)[0];
            const rows = splat.splatData.numSplats;
            const cols = splat.splatData.getElement('vertex').properties.length;

            scene.events.fire('dataPanel.toggle');
            // 直方图算完之前 DOM 里可能是空的；轮询到有值或超时
            const read = () => {
                const vals = Array.from(document.querySelectorAll('.histogram-stats-value')).map(e => e.textContent);
                const min = document.querySelector('.histogram-info-min');
                const max = document.querySelector('.histogram-info-max');
                const canvas = document.querySelector('#histogram-canvas-area canvas');
                let bars = 0;
                let colored = 0;
                if (canvas) {
                    const ctx = canvas.getContext('2d');
                    if (ctx) {
                        const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                        for (let x = 0; x < canvas.width; x++) {
                            let colHas = 0;
                            for (let y = 0; y < canvas.height; y++) {
                                const i = (y * canvas.width + x) * 4;
                                // 非黑（histogram 底色）且不透明
                                if (d[i + 3] > 0 && (d[i] > 8 || d[i + 1] > 8 || d[i + 2] > 8)) {
                                    bars++;
                                    colHas = 1;
                                }
                            }
                            if (colHas) colored++;
                        }
                    }
                }
                return {
                    statsValues: vals,
                    infoMin: min ? min.textContent : null,
                    infoMax: max ? max.textContent : null,
                    bars,
                    coloredColumns: colored
                };
            };

            let state = read();
            for (let i = 0; i < 20 && !(state.infoMin && state.infoMax && state.bars > 0); i++) {
                await sleep2(2000);
                state = read();
            }
            const shBands = (splat.entity.gsplat?.instance?.resource)?.shBands ?? null;
            return { rows, cols, shBands, ...state };
        });

        const ok = result.infoMin !== '' && result.infoMax !== '' && result.bars > 0;
        console.log('@@RESULT@@');
        console.log(JSON.stringify({
            model: MODEL,
            ...result,
            consoleErrors: consoleErrors.slice(0, 8),
            pass: ok && consoleErrors.length === 0
        }, null, 2));
    } catch (e) {
        console.log('@@RESULT@@');
        console.log(JSON.stringify({ fatal: String(e).slice(0, 400), consoleErrors: consoleErrors.slice(0, 8), pass: false }, null, 2));
    } finally {
        await browser.close();
    }
})();
