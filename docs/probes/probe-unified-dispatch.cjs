// 归档自 _tmp（2026-09-25 unified 通路排查那一轮），REPO 路径已按 docs/probes/ 调整。
// 探针 9：unified 通路里**排序/压缩的 compute 到底有没有派发**。
//
// 结论链（§4r/§4s）：
//   · 间接绘制的参数实测全 0（indexCount = 0、instanceCount = 0）⇒ 一个图元都没有；
//   · 所以"片元/材质/目标全对却零像素、零错误"完全解释得通。
// 本探针补上最后一环：这些参数由**压缩 compute** 写出来，那它到底派发了没有？
// 同时读 `worldState` 与 `intervalCompaction` 的现场，看卡在哪一级。
//
// usage: node _tmp/probe-unified-dispatch.cjs [model]
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..', '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL = process.argv[2] || 'test-model.ply';

(async () => {
    cleanupOrphanBrowsers();
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 600000
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 640, height: 440 });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));

    await page.evaluateOnNewDocument(() => {
        window.__SR_CP__ = { dispatch: 0, dispatchIndirect: 0, computePasses: 0, draws: 0, drawsIndirect: 0 };
        const hook = () => {
            const CP = globalThis.GPUComputePassEncoder;
            const PR = globalThis.GPURenderPassEncoder;
            if (!CP || !CP.prototype || CP.prototype.__srC) return false;
            CP.prototype.__srC = true;
            const o1 = CP.prototype.dispatchWorkgroups;
            CP.prototype.dispatchWorkgroups = function (...a) {
                window.__SR_CP__.dispatch++;
                return o1.apply(this, a);
            };
            const o2 = CP.prototype.dispatchWorkgroupsIndirect;
            CP.prototype.dispatchWorkgroupsIndirect = function (...a) {
                window.__SR_CP__.dispatchIndirect++;
                return o2.apply(this, a);
            };
            const o3 = CP.prototype.end;
            CP.prototype.end = function (...a) {
                window.__SR_CP__.computePasses++;
                return o3.apply(this, a);
            };
            if (PR && PR.prototype) {
                for (const n of ['draw', 'drawIndexed']) {
                    const o = PR.prototype[n];
                    PR.prototype[n] = function (...a) {
                        window.__SR_CP__.draws++;
                        return o.apply(this, a);
                    };
                }
                for (const n of ['drawIndirect', 'drawIndexedIndirect']) {
                    const o = PR.prototype[n];
                    PR.prototype[n] = function (...a) {
                        window.__SR_CP__.drawsIndirect++;
                        return o.apply(this, a);
                    };
                }
            }
            return true;
        };
        hook();
    });

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
    await page.evaluate(() => {
        const scene = window.scene;
        const el = (scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        if (el) scene.events.fire('selection', el);
    });
    await sleep(400);
    await page.evaluate(() => window.scene.events.fire('camera.focus'));
    await sleep(2000);

    const frames = (n) => page.evaluate(async (k) => {
        for (let i = 0; i < k; i++) {
            window.scene.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
        }
    }, n);
    const reset = () => page.evaluate(() => {
        for (const k of Object.keys(window.__SR_CP__)) window.__SR_CP__[k] = 0;
    });

    await reset();
    await frames(2);
    const cpu = await page.evaluate(() => ({ ...window.__SR_CP__ }));

    await page.evaluate(async () => {
        const scene = window.scene;
        window.__SPLATROOM_UNIFIED__ = true;
        const el = (scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        el.entity.gsplat.unified = true;
        for (let i = 0; i < 60; i++) {
            scene.app.renderNextFrame = true;
            await new Promise((r) => requestAnimationFrame(r));
        }
    });
    await sleep(1500);
    await reset();
    await frames(2);
    const uni = await page.evaluate(() => ({ ...window.__SR_CP__ }));

    const state = await page.evaluate(() => {
        const scene = window.scene;
        const out = [];
        scene?.app?.renderer?.gsplatDirector?.camerasMap?.forEach((cd) => {
            cd?.layersMap?.forEach((ld) => {
                const m = ld?.gsplatManager;
                const r = m && m.renderer;
                const ic = r && r.intervalCompaction;
                const w = m && m.world;
                const st = w && w.currentState;
                out.push({
                    totalActiveSplats: st ? st.totalActiveSplats : null,
                    totalIntervals: st ? st.totalIntervals : null,
                    sortParametersSet: st ? st.sortParametersSet : null,
                    sortedBefore: st ? st.sortedBefore : null,
                    indirectDrawSlot: r ? r.indirectDrawSlot : null,
                    lastCompactedNumIntervals: r ? r.lastCompactedNumIntervals : null,
                    icExists: !!ic,
                    icNumSplatsBuffer: !!(ic && ic.numSplatsBuffer),
                    icIntervals: ic && ic.intervals ? ic.intervals.length : null,
                    icFields: ic ? Object.keys(ic).slice(0, 25) : null,
                    worldVersion: w ? w.currentVersion : null,
                    rendererFields: r ? Object.keys(r).filter((k) => /indirect|compact|dispatch/i.test(k)) : null
                });
            });
        });
        return out;
    });

    console.log(JSON.stringify({ model: MODEL, cpu, uni, state, errs: errs.slice(0, 3) }, null, 1));
    console.log('\n=== 判定 ===');
    console.log(`  CPU 通路（2 帧）：compute pass ${cpu.computePasses}，dispatchWorkgroups ${cpu.dispatch}，dispatchIndirect ${cpu.dispatchIndirect}；draw ${cpu.draws}，drawIndirect ${cpu.drawsIndirect}`);
    console.log(`  unified（2 帧）：compute pass ${uni.computePasses}，dispatchWorkgroups ${uni.dispatch}，dispatchIndirect ${uni.dispatchIndirect}；draw ${uni.draws}，drawIndirect ${uni.drawsIndirect}`);
    console.log(`  ⇒ ${uni.dispatch + uni.dispatchIndirect === 0 ? '**unified 通路的排序/压缩 compute 一次都没派发** ⇒ 间接参数永远是 0 ⇒ 零图元' : 'compute 有派发，问题在参数写入或读取'}`);
    for (const s of state) console.log(`  manager 现场：${JSON.stringify(s)}`);

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
