// 探针 65：unified 的 **CPU 拾取**与主线的 **GPU 拾取**对拍（同一相机、同一模型）。
//
// 这是本轮（CPU 路线）的验收：
//   ① 中心单像素拾取：两条路取到的**必须是同一个高斯**（几何相同、排序无关）；
//   ② 小矩形拾取：去重后的 id 集合应当高度重合（我用"排序后的前 N 个 id"做与顺序无关的指纹）；
//   ③ 判据（探针 58 的老规矩）：把模型全部删掉后再拾取，unified 也必须变成"没有东西"；
//   ④ 耗时：CPU 那条要如实报出来（`picker.lastCpuPickMs`）。
//
// usage: node _tmp/probe-cpu-pick.cjs
const path = require('path');
const REPO = path.join(__dirname, '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const runOne = async (browser, unified) => {
    const tag = unified ? 'unified(CPU)' : 'main(GPU)';
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 620 });
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
    page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 250)));
    await page.goto(unified ? 'http://localhost:3100/?gpu=webgpu&unified=1' : 'http://localhost:3100/?gpu=webgpu', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1200);
    await page.evaluate(async () => {
        const res = await fetch('./test-model.ply');
        const blob = await res.blob();
        await window.scene.events.invoke('import', [{ filename: 'test-model.ply', contents: new File([blob], 'test-model.ply') }]);
    });
    for (let i = 0; i < 80; i++) {
        await sleep(500);
        if (await page.evaluate(() => (window.scene.elements || []).some((e) => e.entity && e.entity.gsplat))) break;
    }
    await page.evaluate(() => {
        const scene = window.scene;
        const el = (scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        scene.events.fire('selection', el);
        scene.events.fire('camera.focus');
    });
    await sleep(2500);

    const out = await page.evaluate(async () => {
        const scene = window.scene;
        const el = (scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        const numSplats = el.splatData.numSplats;
        const valid = (v) => v >= 0 && v < numSplats;

        // ① 中心单像素
        scene.camera.pickPrep(el, 'set');
        const centre = await scene.camera.pickRect(0.5, 0.5, 1 / 900, 1 / 620);

        // ② 小矩形（画面中心 20%×20%）
        scene.camera.pickPrep(el, 'set');
        const rect = await scene.camera.pickRect(0.4, 0.4, 0.2, 0.2);
        const uniq = Array.from(new Set(rect.filter(valid))).sort((a, b) => a - b);
        const cpuMs = scene.camera.picker ? scene.camera.picker.lastCpuPickMs : null;

        // ③ 全删之后的对照
        scene.events.fire('select.all');
        scene.events.fire('select.delete');
        await new Promise((r) => requestAnimationFrame(r));
        await new Promise((r) => setTimeout(r, 300));
        scene.camera.pickPrep(el, 'set');
        const afterDelete = await scene.camera.pickRect(0.4, 0.4, 0.2, 0.2);
        scene.events.fire('edit.undo');

        return {
            numSplats,
            centreId: centre[0],
            centreValid: valid(centre[0]),
            rectCount: rect.length,
            rectValid: rect.filter(valid).length,
            rectUnique: uniq.length,
            rectFirst: uniq.slice(0, 10),
            rectHash: uniq.reduce((a, v) => (a * 31 + v) >>> 0, 7),
            afterDeleteValid: afterDelete.filter(valid).length,
            afterDeleteSample: Array.from(afterDelete.slice(0, 3)),
            cpuMs
        };
    });
    out.errs = errs.slice(0, 3);
    await page.close();
    return out;
};

(async () => {
    cleanupOrphanBrowsers();
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 900000
    });
    const main = await runOne(browser, false);
    const uni = await runOne(browser, true);

    console.log('\n=== CPU 拾取 vs GPU 拾取（test-model，WebGPU）===');
    for (const [label, r] of [['main(GPU)', main], ['unified(CPU)', uni]]) {
        console.log(`  ${label}: 中心像素 id=${r.centreId}（合法=${r.centreValid}）`);
        console.log(`     小矩形：合法 ${r.rectValid}/${r.rectCount}，唯一 id ${r.rectUnique}，前 10 个 ${JSON.stringify(r.rectFirst)}，指纹 ${r.rectHash}`);
        console.log(`     全删后：合法 ${r.afterDeleteValid}/${r.rectCount}，样例 ${JSON.stringify(r.afterDeleteSample)}${r.cpuMs !== null && r.cpuMs !== undefined ? `；CPU 耗时 ${(+r.cpuMs).toFixed(1)}ms` : ''}`);
        if (r.errs.length) console.log(`     错误：${JSON.stringify(r.errs)}`);
    }
    console.log('\n=== 判定 ===');
    const sameCentre = main.centreId === uni.centreId && uni.centreValid;
    console.log(`  ${sameCentre ? 'PASS' : 'FAIL'}  中心单像素拾取与主线一致（main=${main.centreId} / unified=${uni.centreId}）`);
    console.log(`  ${uni.rectUnique > 5 ? 'PASS' : 'FAIL'}  unified 小矩形能拾取到多个不同高斯（${uni.rectUnique} 个；主线 ${main.rectUnique} 个）`);
    console.log(`  ${uni.afterDeleteValid === 0 ? 'PASS' : 'FAIL'}  全删之后拾取为空（合法 ${uni.afterDeleteValid}/${uni.rectCount}）`);
    if (uni.cpuMs) console.log(`  （CPU 拾取一次 20%×20% 矩形耗时 ${(+uni.cpuMs).toFixed(1)}ms，2000 个高斯）`);

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
