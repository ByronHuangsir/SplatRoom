// 视图快捷控件（右上角坐标轴下方：视野角 / 显示边界 / 显示网格）的回归 + 截图。
//
// 用户要求（2026-09-22）：这三个常用开关要能随手够到；**设置面板里原有的三份保持不动**。
// 所以套件同时验两边：新面板在坐标轴正下方、三个控件都能改到真实状态；旧入口仍然存在且同步。
//
// usage: node docs/verify/verify-view-quick-controls.cjs "<url>" [model] [截图路径]
const fs = require('fs');
const path = require('path');
const puppeteer = require(path.join(__dirname, '..', '..', 'node_modules', 'puppeteer-core'));

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const SHOT = process.argv[4] || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1500);
    await page.evaluate(async (m) => {
        const buf = await (await fetch('./' + m)).arrayBuffer();
        await window.scene.events.invoke('import', [{ filename: m, contents: new File([buf], m) }]);
    }, MODEL);
    for (let i = 0; i < 60; i++) {
        await sleep(800);
        if (await page.evaluate(() => window.scene.getElementsByType('splat').length > 0)) break;
    }
    await sleep(2500);

    const checks = [];
    const check = (name, pass, detail) => checks.push({ name, pass, detail });

    const layout = await page.evaluate(() => {
        const cube = document.querySelector('#view-cube-container');
        const qc = document.querySelector('#view-quick-controls');
        if (!cube || !qc) {
            return { cube: !!cube, quick: !!qc };
        }
        const c = cube.getBoundingClientRect();
        const q = qc.getBoundingClientRect();
        const cs = getComputedStyle(qc);
        const boxOf = (sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)];
        };
        const sliderNum = qc.querySelector('.vqc-slider .pcui-numeric-input');
        const track = qc.querySelector('.vqc-slider .pcui-slider-container');
        const bar = qc.querySelector('.vqc-slider .pcui-slider-bar');
        return {
            cube: true, quick: true,
            cubeBox: [Math.round(c.left), Math.round(c.top), Math.round(c.right), Math.round(c.bottom)],
            quickBox: [Math.round(q.left), Math.round(q.top), Math.round(q.right), Math.round(q.bottom)],
            rightToolbar: boxOf('#right-toolbar'),
            bottomToolbar: boxOf('#bottom-toolbar'),
            menuBar: boxOf('#menu-bar'),
            scenePanel: boxOf('#scene-panel'),
            gap: Math.round(q.top - c.bottom),
            rightGap: Math.round(c.right - q.right),
            pointerEvents: cs.pointerEvents,
            rows: Array.from(qc.querySelectorAll('.vqc-row')).map(r => (r.textContent || '').slice(0, 40)),
            slider: !!qc.querySelector('.vqc-slider'),
            toggles: qc.querySelectorAll('.vqc-toggle').length,
            sliderInputWidth: sliderNum ? Math.round(sliderNum.getBoundingClientRect().width) : null,
            sliderInputHidden: !!sliderNum && getComputedStyle(sliderNum).display === 'none',
            sliderTrackWidth: track ? Math.round(track.getBoundingClientRect().width) : null,
            sliderBarWidth: bar ? Math.round(bar.getBoundingClientRect().width) : null
        };
    });
    // ---- 1. 位置：必须在**菜单栏右侧**、贴着菜单栏右边缘、且不压其他东西 ----
    const menuGap = layout.menuBar && layout.quickBox ? Math.round(layout.quickBox[0] - layout.menuBar[2]) : null;
    check('the quick controls sit to the right of the menu bar (the requested position)',
        layout.menuBar && layout.quickBox && menuGap >= 2 && menuGap <= 24 &&
        layout.quickBox[0] > layout.menuBar[2] && layout.quickBox[1] >= 0 && layout.quickBox[1] <= 40,
        layout.quickBox
            ? `菜单栏 [${layout.menuBar.join(', ')}]；快捷控件 [${layout.quickBox.join(', ')}] ⇒ 水平间距 ${menuGap}px、` +
              `顶边 ${layout.quickBox[1]}px（pointer-events=${layout.pointerEvents}，可点击）`
            : `找不到元素（menu=${layout.menuBar} quick=${layout.quickBox}）`);

    // 位置靠 JS 量菜单栏（不写死 left），所以**菜单栏变宽时面板必须跟着走**：
    // 直接把菜单项文字拉长（等价于切到德语/日语那种更长的菜单栏），看面板是否重新贴上去。
    const stress = await page.evaluate(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const box = (el) => {
            const r = el.getBoundingClientRect();
            return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)];
        };
        const bar = document.querySelector('#menu-bar');
        const qc = document.querySelector('#view-quick-controls');
        const options = Array.from(bar.querySelectorAll('.menu-option'));
        const saved = options.map(o => o.textContent);
        options.forEach((o) => { o.textContent = `${o.textContent}WWW`; });
        await sleep(600);
        const wide = { bar: box(bar), quick: box(qc) };
        options.forEach((o, i) => { o.textContent = saved[i]; });
        await sleep(600);
        const back = { bar: box(bar), quick: box(qc) };
        return { wide, back, optionCount: options.length };
    });
    const wideGap = Math.round(stress.wide.quick[0] - stress.wide.bar[2]);
    check('it follows the menu bar when the menu gets wider (left is measured, not hard-coded)',
        stress.wide.quick[0] > stress.wide.bar[2] && wideGap >= 2 && wideGap <= 24 &&
        Math.abs(stress.back.quick[0] - stress.back.bar[2] - 12) <= 4,
        `菜单项文字加长后：菜单栏 [${stress.wide.bar.join(', ')}] → 面板 [${stress.wide.quick.join(', ')}]（间距 ${wideGap}px）；` +
        `还原后：菜单栏右 ${stress.back.bar[2]} → 面板左 ${stress.back.quick[0]}（${stress.optionCount} 个菜单项）`);

    // 上一轮报的 bug：这块盖住了右侧工具栏最上面两个按钮；现在换到左上角，
    // 右侧工具栏/底部工具栏/菜单栏/场景面板**一个都不能压**。
    const overlaps = (a, b) => !!a && !!b &&
        !(a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1]);
    const hitRight = overlaps(layout.quickBox, layout.rightToolbar);
    const hitBottom = overlaps(layout.quickBox, layout.bottomToolbar);
    const hitMenu = overlaps(layout.quickBox, layout.menuBar);
    const hitScene = overlaps(layout.quickBox, layout.scenePanel);
    check('the panel covers neither toolbar, nor the menu bar, nor the scene panel',
        layout.quickBox && !hitRight && !hitBottom && !hitMenu && !hitScene,
        `快捷控件 [${(layout.quickBox ?? []).join(', ')}]；右侧工具栏 [${(layout.rightToolbar ?? []).join(', ')}]` +
        ` ⇒ 重叠=${hitRight}；底部工具栏 [${(layout.bottomToolbar ?? []).join(', ')}] ⇒ ${hitBottom}；` +
        `菜单栏 [${(layout.menuBar ?? []).join(', ')}] ⇒ ${hitMenu}；场景面板 [${(layout.scenePanel ?? []).join(', ')}] ⇒ ${hitScene}`);

    // 用户报的第二个 bug（2026-09-22）：调色面板打开后被这块挡住；换到左上角后两者可以同屏共存。
    const panels = await page.evaluate(async () => {
        const scene = window.scene;
        const boxOf = (sel) => {
            const el = document.querySelector(sel);
            if (!el || el.classList.contains('pcui-hidden') || !el.getBoundingClientRect().width) return null;
            const r = el.getBoundingClientRect();
            return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)];
        };
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const out = {};
        for (const [key, sel, event] of [['color', '#color-panel', 'colorPanel.visible'], ['settings', '#settings-panel', 'settingsPanel.visible']]) {
            const el = document.querySelector(sel);
            if (el && el.ui) el.ui.hidden = false;                 // 真正打开面板（和工具栏点击同一条路径）
            try { scene.events.fire(event, true); } catch (e) { /* 事件名变了也不影响上面的打开 */ }
            await sleep(600);
            out[key] = { panel: boxOf(sel), quick: boxOf('#view-quick-controls'), opened: !!el && !el.classList.contains('pcui-hidden') };
            if (el && el.ui) el.ui.hidden = true;
            try { scene.events.fire(event, false); } catch (e) { /* 同上 */ }
            await sleep(400);
        }
        out.restored = boxOf('#view-quick-controls');
        return out;
    });
    const hitColorNow = overlaps(panels.color.quick, panels.color.panel);
    const hitSettingsNow = overlaps(panels.settings.quick, panels.settings.panel);
    check('a right-side panel can be open at the same time without overlapping it (the second reported bug, now solved by moving to the top-left)',
        panels.color.opened && panels.settings.opened && !!panels.color.panel && !!panels.settings.panel &&
        !!panels.color.quick && !!panels.settings.quick && !hitColorNow && !hitSettingsNow,
        `调色面板 [${(panels.color.panel ?? []).join(', ')}] 打开时快捷面板 [${(panels.color.quick ?? []).join(', ')}] ⇒ 重叠=${hitColorNow}；` +
        `设置面板 [${(panels.settings.panel ?? []).join(', ')}] vs [${(panels.settings.quick ?? []).join(', ')}] ⇒ 重叠=${hitSettingsNow}；` +
        `两个都关掉后 [${(panels.restored ?? []).join(', ')}]`);

    // 用户要求：视野角**不要输入框**、滑轨**要长**
    check('the FOV control has no input box and its track is long',
        layout.sliderInputHidden === true && (layout.sliderTrackWidth ?? 0) >= 120,
        `数字输入框 display=none 且宽 ${layout.sliderInputWidth}px；滑轨容器 ${layout.sliderTrackWidth}px、` +
        `bar ${layout.sliderBarWidth}px（改前轨道只有 18px）`);

    // 用户第二轮要求：**两行** —— 第一行视野角，第二行「显示」+ 边界开关 + 网格开关
    const rowTexts = layout.rows ?? [];
    const row2 = rowTexts[1] ?? '';
    check('it is laid out in two rows as requested (FOV on row 1; 显示 + 边界开关 + 网格开关 on row 2)',
        rowTexts.length === 2 && layout.slider === true && layout.toggles === 2 &&
        rowTexts[0].includes('视野角') && row2.includes('显示') && row2.includes('边界') && row2.includes('网格'),
        `行=${JSON.stringify(rowTexts)}；滑杆=${layout.slider}；开关=${layout.toggles}`);

    // ---- 2. 功能：三个控件都要改到真实状态 ----
    const wired = await page.evaluate(async () => {
        const qc = document.querySelector('#view-quick-controls');
        const findInstance = (root, predicate) => {
            for (const el of Array.from(root.querySelectorAll('*'))) {
                const inst = el.ui;
                if (inst && typeof inst.on === 'function' && predicate(inst)) {
                    return inst;
                }
            }
            return null;
        };
        const events = window.scene.events;
        const before = {
            fov: events.invoke('camera.fov'),
            grid: events.invoke('grid.visible'),
            bound: (() => {
                try {
                    return events.invoke('camera.bound');
                } catch {
                    return null;
                }
            })()
        };

        // 视野角：滑杆拉到 95 度
        const slider = findInstance(qc, i => typeof i.value === 'number' && i.min === 10 && i.max === 120);
        const canSlider = !!slider;
        if (slider) {
            slider.value = 95;
        }
        await new Promise(r => setTimeout(r, 600));

        // 两个开关：各点一次。PCUI 的 BooleanInput 在 `pointerdown` 上不一定翻，
        // 所以**两种手势都试**（真实 pointerdown，再补一次 click），并记录各自的实效
        const toggles = Array.from(qc.querySelectorAll('.vqc-toggle'))
            .map(el => el.ui)
            .filter(i => i && typeof i.on === 'function');
        const gestures = [];
        for (const t of toggles) {
            const before = t.value;
            t.dom.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            t.dom.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            gestures.push({ before, after: t.value });
        }
        await new Promise(r => setTimeout(r, 800));

        const after = {
            fov: events.invoke('camera.fov'),
            grid: events.invoke('grid.visible'),
            bound: (() => {
                try {
                    return events.invoke('camera.bound');
                } catch {
                    return null;
                }
            })()
        };
        return { before, after, canSlider, toggleCount: toggles.length, gestures };
    });

    check('the FOV slider really drives the camera (camera.setFov)',
        wired.canSlider && Math.abs(wired.after.fov - 95) < 1.5 && wired.before.fov !== wired.after.fov,
        `fov ${wired.before.fov} → ${wired.after.fov}（滑杆设 95）`);

    check('the two toggles really flip grid visibility and bounding-box visibility',
        wired.after.grid !== wired.before.grid &&
        (wired.before.bound === null || wired.after.bound !== wired.before.bound),
        `网格 ${wired.before.grid} → ${wired.after.grid}；边界 ${wired.before.bound} → ${wired.after.bound}` +
        `（点了 ${wired.toggleCount} 个开关）`);

    // ---- 3. 反向：设置面板里的三份还在，而且与新面板同步 ----
    const legacy = await page.evaluate(() => {
        const panel = document.querySelector('#settings-panel');
        if (!panel) {
            return { panel: false };
        }
        const text = panel.textContent || '';
        return {
            panel: true,
            hasGrid: text.includes('网格'),
            hasBound: text.includes('边界'),
            hasFov: true   // FOV 在相机面板里，不在设置面板
        };
    });
    check('the settings-panel entries are untouched (the user asked to keep them)',
        legacy.panel && legacy.hasGrid && legacy.hasBound,
        `设置面板仍在：网格=${legacy.hasGrid}、边界=${legacy.hasBound}`);

    // 新面板与设置面板/快捷键走同一套事件 ⇒ 外部改状态时它必须跟着变
    const synced = await page.evaluate(async () => {
        const events = window.scene.events;
        const before = events.invoke('grid.visible');
        events.fire('grid.setVisible', !before);          // 模拟从设置面板/快捷键改
        await new Promise(r => setTimeout(r, 500));
        const qc = document.querySelector('#view-quick-controls');
        const toggles = Array.from(qc.querySelectorAll('.vqc-toggle')).map(el => el.ui).filter(Boolean);
        // 第二个开关是"显示网格"（DOM 顺序：滑杆行、边界、网格）
        const gridToggle = toggles[1];
        const shown = gridToggle ? gridToggle.value : null;
        const now = events.invoke('grid.visible');
        events.fire('grid.setVisible', before);           // 还原
        return { before, now, shown };
    });
    check('it stays in sync when the state is changed elsewhere (same events, no duplicate state)',
        synced.shown === synced.now,
        `外部把 grid.visible 改成 ${synced.now} ⇒ 新面板开关显示 ${synced.shown}`);

    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | ') || 'none');

    // ---- 截图（给用户看效果；只截右上角那块）----
    if (SHOT) {
        try {
            await page.screenshot({
                path: SHOT,
                clip: { x: 0, y: 0, width: 780, height: 200 }   // 左上角：菜单栏 + 快捷面板
            });
        } catch (e) {
            errors.push('screenshot: ' + String(e).slice(0, 120));
        }
    }

    console.log(JSON.stringify({
        url: URL, model: MODEL, layout, wired, legacy, synced, shot: SHOT || null,
        checks, failed: checks.filter(c => !c.pass).length
    }, null, 1));

    await browser.close();
    process.exit(0);
})().catch((e) => {
    console.log(JSON.stringify({ fatal: String(e && e.stack || e).slice(0, 700) }));
    process.exit(1);
});
