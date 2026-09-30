// 归档自 _tmp（2026-09-26），REPO 路径已按 docs/probes/ 调整。
// 探针 52：unified 通路上"不显示边界 / 无法选中"到底是哪一层断了。
//
// 用户原话：`unified通路不存在排序问题，但是现在不显示边界、无法选中`。
// 这三件事必须分开量，否则会把"没有视觉反馈"误判成"选中功能坏了"：
//   ① **内部选中状态**：`splatData.state` 里的 selected/deleted 位（真相层，与画什么无关）；
//   ② **画面反馈**：选中高亮（黄色）/ 未选中变蓝、删除后消失（像素统计）；
//   ③ **边界框**：`Splat.onPreRender` 里 `if (this.visible && selected) … drawLine(...)`
//      （`splat.ts:1767-1783`）—— 只有"该 splat 被选为元素"时才画，所以它天然依赖 ①。
// 同一条脚本分别跑主线（unified=0）与 unified=1，两边逐项对照。
//
// usage: node _tmp/probe-unified-parity.cjs [model]
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..', '..');
const { BROWSER_PATH: EDGE, cleanupOrphanBrowsers } = require(path.join(REPO, 'docs', 'verify', 'lib', 'browser.cjs'));
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const { launchPatched: _launchPatched } = require('../verify/lib/browser.cjs');
const { decodePng } = require(path.join(REPO, 'docs', 'verify', 'lib', 'png.cjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL = process.argv[2] || 'test-model.ply';

const analyze = (file) => {
    const P = decodePng(fs.readFileSync(file));
    let r = 0, g = 0, b = 0, yellow = 0, blue = 0;
    const n = P.width * P.height;
    for (let i = 0; i < P.data.length; i += P.channels) {
        const R = P.data[i], G = P.data[i + 1], B = P.data[i + 2];
        r += R; g += G; b += B;
        // 选中高亮是黄色 (1,1,0)，未选中是蓝色 (0,0,1)@0.5 —— 两种反馈的像素占比
        if (R > 120 && G > 120 && B < 90 && Math.abs(R - G) < 60) yellow++;
        if (B > 100 && B > R + 40 && B > G + 40) blue++;
    }
    return {
        mean: [+(r / n).toFixed(1), +(g / n).toFixed(1), +(b / n).toFixed(1)],
        yellowPct: +((yellow / n) * 100).toFixed(2),
        bluePct: +((blue / n) * 100).toFixed(2)
    };
};

const runOne = async (browser, unified) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 620 });
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
    page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 200)));
    const tag = unified ? 'unified' : 'main';
    const q = unified ? '?gpu=webgpu&unified=1' : '?gpu=webgpu';
    await page.goto('http://localhost:3100/' + q, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1500);
    await page.evaluate(async (m) => {
        const res = await fetch('./' + m);
        const blob = await res.blob();
        await window.scene.events.invoke('import', [{ filename: m, contents: new File([blob], m) }]);
    }, MODEL);
    for (let i = 0; i < 60; i++) {
        await sleep(500);
        if (await page.evaluate(() => (window.scene.elements || []).some((e) => e.entity && e.entity.gsplat))) break;
    }
    await page.evaluate(() => {
        const scene = window.scene;
        const el = (scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        // 计数 drawLine（边界框就是它画的）
        window.__dl = 0;
        const orig = scene.app.drawLine.bind(scene.app);
        scene.app.drawLine = (...a) => { window.__dl++; return orig(...a); };
        scene.events.fire('selection', el);
        scene.events.fire('camera.focus');
    });
    await sleep(2500);

    const shoot = async (name) => {
        const f = path.join(REPO, '_tmp', `up-${tag}-${name}.png`);
        fs.writeFileSync(f, Buffer.from(await page.screenshot({ encoding: 'base64' }), 'base64'));
        return analyze(f);
    };
    const counts = () => page.evaluate(() => {
        const el = (window.scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        const st = el && el.splatData ? el.splatData.getProp('state') : null;
        let sel = 0, del = 0;
        if (st) for (let i = 0; i < st.length; i++) { if (st[i] & 1) sel++; if (st[i] & 2) del++; }
        return {
            selected: sel, deleted: del,
            numSplats: el ? el.splatData.numSplats : null,
            visibleSplats: el ? el.numSplats : null,
            numSelected: el ? el.numSelected : null,
            elementSelected: window.scene.events.invoke('selection') === el,
            boundVisible: window.scene.events.invoke('camera.bound'),
            drawLine: window.__dl,
            unified: globalThis.__SPLATROOM_UNIFIED__ === true,
            hasInstance: !!(el && el.entity && el.entity.gsplat && el.entity.gsplat.instance),
            sourceKind: (() => {
                const m = globalThis.__SPLATROOM_UNIFIED_MATERIAL_INSTALLED__;
                return m ? m.sourceKind ?? null : null;
            })()
        };
    });
    const frames = (n) => page.evaluate(async (k) => {
        for (let i = 0; i < k; i++) { window.scene.app.renderNextFrame = true; await new Promise((r) => requestAnimationFrame(r)); }
    }, n);

    const steps = [];
    const step = async (name, act) => {
        if (act) await act();
        await frames(4);
        await sleep(400);
        const c = await counts();
        const px = await shoot(name);
        steps.push({ name, ...c, px });
        console.log(`  [${tag}] ${name.padEnd(14)} 内部选中=${c.selected} 删除位=${c.deleted} 元素选中=${c.elementSelected} 边界框开关=${c.boundVisible} drawLine=${c.drawLine} 画面=${JSON.stringify(px.mean)} 黄=${px.yellowPct}% 蓝=${px.bluePct}% instance=${c.hasInstance}`);
        return c;
    };

    await step('0-导入后', null);
    await step('1-全选', () => page.evaluate(() => window.scene.events.fire('select.all')));
    await step('2-删除', () => page.evaluate(() => window.scene.events.fire('select.delete')));
    await step('3-撤销', () => page.evaluate(() => window.scene.events.fire('edit.undo')));
    await step('4-取消选择', () => page.evaluate(() => window.scene.events.fire('select.none')));
    await step('5-重新选中元素', () => page.evaluate(() => {
        const el = (window.scene.elements || []).find((e) => e.entity && e.entity.gsplat);
        window.scene.events.fire('selection', el);
    }));
    await step('6-框选一半', () => page.evaluate(async () => {
        await window.scene.events.invoke('select.rect', 'set', { start: { x: 0.25, y: 0.25 }, end: { x: 0.75, y: 0.75 } });
    }));

    await page.close();
    return { tag, steps, errs: errs.slice(0, 5) };
};

(async () => {
    cleanupOrphanBrowsers();
    const browser = await _launchPatched(puppeteer, {
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 600000
    });
    const main = await runOne(browser, false);
    const uni = await runOne(browser, true);

    console.log(`\n=== 对照（${MODEL}，WebGPU）===`);
    console.log('步骤                主线：内部/黄/蓝/drawLine    unified：内部/黄/蓝/drawLine');
    for (let i = 0; i < main.steps.length; i++) {
        const a = main.steps[i], b = uni.steps[i];
        console.log(`  ${a.name.padEnd(16)} ${String(a.selected).padStart(6)}/${String(a.px.yellowPct).padStart(5)}%/${String(a.px.bluePct).padStart(5)}%/${String(a.drawLine).padStart(4)}   ${String(b.selected).padStart(6)}/${String(b.px.yellowPct).padStart(5)}%/${String(b.px.bluePct).padStart(5)}%/${String(b.drawLine).padStart(4)}`);
    }
    const lastMain = main.steps[main.steps.length - 1], lastUni = uni.steps[uni.steps.length - 1];
    console.log(`\n  ⇒ unified 开关生效：${lastUni.unified}（材质来源 ${lastUni.sourceKind}，有 per-instance instance=${lastUni.hasInstance}）`);
    console.log(`  ⇒ 内部选中状态：主线 ${lastMain.selected} / unified ${lastUni.selected}${lastUni.selected === lastMain.selected ? '（一致 ✓）' : '（**不一致**）'}`);
    console.log(`  ⇒ 选中高亮（黄色像素）：主线 ${lastMain.px.yellowPct}% / unified ${lastUni.px.yellowPct}%${lastUni.px.yellowPct < 0.05 && lastMain.px.yellowPct > 0.5 ? ' ⇒ **unified 没有视觉反馈**' : ''}`);
    console.log(`  ⇒ 边界框（drawLine 次数）：主线 ${lastMain.drawLine} / unified ${lastUni.drawLine}${lastUni.drawLine === 0 && lastMain.drawLine > 0 ? ' ⇒ **unified 不画边界框**' : ''}`);
    if (uni.errs.length) console.log(`  unified 错误：${JSON.stringify(uni.errs)}`);
    fs.writeFileSync(path.join(REPO, '_tmp', 'up-parity.json'), JSON.stringify({ main, uni }, null, 1));

    await browser.close();
    cleanupOrphanBrowsers();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
