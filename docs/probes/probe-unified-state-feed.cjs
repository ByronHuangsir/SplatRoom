// 归档自 _tmp（2026-09-26），REPO 路径已按 docs/probes/ 调整。
// 探针 53：unified 通路的"状态进着色器"链条**逐环**读数，别猜。
//
// 背景：探针 52 显示"删除隐藏"已经生效（删除后画面变暗），但"选中高亮"没生效、
// 撤销也没把画面救回来。这条链有四个环，必须分开看是谁断的：
//   ① 应用有没有把 uniform 喂进材质（srSelectedClr / srLockedClr / srShowDeleted / srStateW）；
//   ② 状态贴图有没有真的绑上（材质参数里有没有那一项、尺寸对不对）；
//   ③ 状态值有没有正确读出来（拿一个"全是选中"的局面，看着色器端能不能区分）；
//   ④ 染色有没有作用到最终颜色（画面统计）。
//
// usage: node _tmp/probe-unified-state-feed.cjs [model] [webgpu]
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..', '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const { decodePng } = require(path.join(REPO, 'docs', 'verify', 'lib', 'png.cjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL = process.argv[2] || 'test-model.ply';

const analyze = (file) => {
    const P = decodePng(fs.readFileSync(file));
    let r = 0, g = 0, b = 0, yellow = 0;
    const n = P.width * P.height;
    for (let i = 0; i < P.data.length; i += P.channels) {
        const R = P.data[i], G = P.data[i + 1], B = P.data[i + 2];
        r += R; g += G; b += B;
        if (R > 120 && G > 120 && B < 90 && Math.abs(R - G) < 60) yellow++;
    }
    return { mean: [+(r / n).toFixed(1), +(g / n).toFixed(1), +(b / n).toFixed(1)], yellowPct: +((yellow / n) * 100).toFixed(2) };
};

(async () => {
    cleanupOrphanBrowsers();
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 600000
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 620 });
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 240)); });
    page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 300)));

    await page.goto('http://localhost:3100/?gpu=webgpu&unified=1', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1500);
    await page.evaluate(async (m) => {
        const res = await fetch('./' + m);
        const blob = await res.blob();
        await window.scene.events.invoke('import', [{ filename: m, contents: new File([blob], m) }]);
    }, MODEL);
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

    const look = (label) => page.evaluate((lbl) => {
        const scene = window.scene;
        const el = (scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        const m = globalThis.__SPLATROOM_UNIFIED_MATERIAL__;
        const p = m && m.parameters ? m.parameters : {};
        // PlayCanvas 把材质参数存成 { scopeId: { value }, data } 包装，取值要先拆一层
        const raw = (v) => (v && typeof v === 'object' && !Array.isArray(v) && !('width' in v) && (v.data !== undefined || v.scopeId))
            ? (v.data !== undefined ? v.data : v.scopeId?.value)
            : v;
        const arr = (v) => {
            const r = raw(v);
            if (Array.isArray(r)) return r.map(n => +(+n).toFixed(3));
            if (r && typeof r === 'object' && 'x' in r) return [r.x, r.y, r.z, r.w];
            return r;
        };
        const num = (v) => { const r = raw(v); return typeof r === 'number' ? +r.toFixed(3) : r; };
        const st = el && el.splatData ? el.splatData.getProp('state') : null;
        let sel = 0, locked = 0, del = 0;
        if (st) for (let i = 0; i < st.length; i++) { if (st[i] & 1) sel++; if (st[i] & 2) locked++; if (st[i] & 4) del++; }
        // 状态贴图是否绑上：按名字找参数（PlayCanvas 纹理参数就是那张 Texture 对象）
        const stTex = raw(p.srStateTex);
        return {
            label: lbl,
            params: {
                srSelectedClr: arr(p.srSelectedClr),
                srLockedClr: arr(p.srLockedClr),
                srShowDeleted: num(p.srShowDeleted),
                srStateW: num(p.srStateW),
                srStateTex: stTex ? (stTex.name || 'texture') + ' ' + stTex.width + 'x' + stTex.height : null,
                sameAsSplatState: !!(stTex && el && stTex === el.stateTexture)
            },
            state: { selected: sel, locked, deleted: del },
            visibleSplats: el ? el.numSplats : null,
            numDeleted: el ? el.numDeleted : null,
            outlineSelection: scene.events.invoke('view.outlineSelection'),
            elementSelected: scene.events.invoke('selection') === el,
            unified: globalThis.__SPLATROOM_UNIFIED__ === true
        };
    }, label);

    const shoot = async (name) => {
        const f = path.join(REPO, '_tmp', `sf-${name}.png`);
        fs.writeFileSync(f, Buffer.from(await page.screenshot({ encoding: 'base64' }), 'base64'));
        return analyze(f);
    };
    const frames = (n) => page.evaluate(async (k) => {
        for (let i = 0; i < k; i++) { window.scene.app.renderNextFrame = true; await new Promise((r) => requestAnimationFrame(r)); }
    }, n);

    const step = async (name, act) => {
        if (act) await act();
        await frames(4);
        await sleep(400);
        const l = await look(name);
        const px = await shoot(name);
        console.log(`\n[${name}] 画面=${JSON.stringify(px.mean)} 黄=${px.yellowPct}%`);
        console.log(`   内部状态：选中=${l.state.selected} 锁定=${l.state.locked} 删除=${l.state.deleted}  可见=${l.visibleSplats} numDeleted=${l.numDeleted}`);
        console.log(`   材质 uniform：srSelectedClr=${JSON.stringify(l.params.srSelectedClr)} srLockedClr=${JSON.stringify(l.params.srLockedClr)} srShowDeleted=${l.params.srShowDeleted} srStateW=${l.params.srStateW}`);
        console.log(`   状态贴图：${l.params.srStateTex}（是元素那张 = ${l.params.sameAsSplatState}）  轮廓选区=${l.outlineSelection} 元素被选中=${l.elementSelected}`);
        return { name, px, ...l };
    };

    const out = [];
    out.push(await step('0-导入后', null));
    out.push(await step('1-全选', () => page.evaluate(() => window.scene.events.fire('select.all'))));
    out.push(await step('2-删除', () => page.evaluate(() => window.scene.events.fire('select.delete'))));
    // 删除但"仍显示"：应该淡红 + 降透明度（与主线同款）。这条以前没验过，顺手补上。
    out.push(await step('2b-显示已删除', () => page.evaluate(() => {
        const el = (window.scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        el.showDeleted = true;
    })));
    out.push(await step('2c-再隐藏已删除', () => page.evaluate(() => {
        const el = (window.scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        el.showDeleted = false;
    })));
    out.push(await step('3-撤销', () => page.evaluate(() => window.scene.events.fire('edit.undo'))));
    out.push(await step('4-取消选择', () => page.evaluate(() => window.scene.events.fire('select.none'))));

    console.log('\n=== 逐环判定 ===');
    // 按**名字**取，不按下标 —— 插入步骤后下标会漂（第一次就是这么读错的）。
    const s0 = out.find(s => s.name === '0-导入后');
    const s1 = out.find(s => s.name === '1-全选');
    const s2 = out.find(s => s.name === '2-删除');
    const s3 = out.find(s => s.name === '3-撤销');
    console.log(`① 应用喂 uniform：全选后 srSelectedClr = ${JSON.stringify(s1.params.srSelectedClr)} ⇒ ${Array.isArray(s1.params.srSelectedClr) && s1.params.srSelectedClr[3] > 0 ? 'PASS' : 'FAIL（中性=没喂进去）'}`);
    console.log(`② 状态贴图绑上：${s1.params.srStateTex} / 是元素那张 = ${s1.params.sameAsSplatState} ⇒ ${s1.params.sameAsSplatState ? 'PASS' : 'FAIL'}`);
    console.log(`③ 画面染色：全选后黄像素 ${s1.px.yellowPct}%（主线同步骤是 46%）⇒ ${s1.px.yellowPct > 5 ? 'PASS' : 'FAIL'}`);
    console.log(`④ 删除隐藏：删除后画面 ${JSON.stringify(s2.px.mean)}（导入后 ${JSON.stringify(s0.px.mean)}）⇒ ${s2.px.mean[0] < s0.px.mean[0] - 20 ? 'PASS' : 'FAIL'}`);
    console.log(`⑤ 撤销恢复：撤销后可见 ${s3.visibleSplats}（删除后 ${s2.visibleSplats}）画面 ${JSON.stringify(s3.px.mean)} ⇒ 内部 ${s3.visibleSplats > s2.visibleSplats ? 'PASS' : 'FAIL'}；`
        + `画面应等于"全选"那张（撤销回来的点仍是选中态）：${Math.abs(s3.px.yellowPct - s1.px.yellowPct) < 3 ? 'PASS' : 'FAIL'}`);
    const s2b = out.find(s => s.name === '2b-显示已删除');
    const s2c = out.find(s => s.name === '2c-再隐藏已删除');
    if (s2b && s2c) {
        const rg = s2b.px.mean[0] - s2b.px.mean[1];
        console.log(`⑥ 删除但显示（showDeleted）：${JSON.stringify(s2b.px.mean)}（R−G = ${rg.toFixed(1)}）；再隐藏回去 = ${JSON.stringify(s2c.px.mean)} ⇒ ${rg > 15 ? 'PASS（淡红）' : 'FAIL（没染红）'}；${s2c.px.mean[0] < s2b.px.mean[0] - 20 ? '隐藏恢复 PASS' : '隐藏恢复 FAIL'}`);
    }
    if (errs.length) console.log(`错误：${JSON.stringify(errs.slice(0, 4))}`);

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
