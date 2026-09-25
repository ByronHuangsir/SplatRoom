// 视图快捷控件（右上角坐标轴下方：视野角 / 显示边界 / 显示网格）的回归 + 截图。
//
// 用户要求（2026-09-22）：这三个常用开关要能随手够到；**设置面板里原有的三份保持不动**。
// 所以套件同时验两边：新面板在坐标轴正下方、三个控件都能改到真实状态；旧入口仍然存在且同步。
//
// usage: node docs/verify/verify-view-quick-controls.cjs "<url>" [model] [截图路径]
const fs = require('fs');
const path = require('path');
const puppeteer = require(path.join(__dirname, '..', '..', 'node_modules', 'puppeteer-core'));

const { BROWSER_PATH: EDGE } = require('./lib/browser.cjs');
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
            sliderBarWidth: bar ? Math.round(bar.getBoundingClientRect().width) : null,
            // 版式细节（用户第二轮追加要求）：`显示` 与 `视野角` 左对齐；第二行撑满到与第一行同一右边缘
            labelLefts: Array.from(qc.querySelectorAll('.vqc-row .vqc-label')).map(el => Math.round(el.getBoundingClientRect().left)),
            fovRowRight: Math.round(qc.querySelector('.vqc-row').getBoundingClientRect().right),
            displayRowRight: (() => {
                const groups = qc.querySelectorAll('.vqc-display-row .vqc-group');
                const last = groups[groups.length - 1];
                return last ? Math.round(last.getBoundingClientRect().right) : null;
            })()
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

    // 用户第二轮追加要求：`显示` 和 `视野角` 左对齐；`边界` / `网格` 两组往右推开、撑满整行
    check('显示 is left-aligned with 视野角 and the switch groups fill the row to the right edge',
        (layout.labelLefts ?? []).length >= 4 && layout.labelLefts[0] === layout.labelLefts[1] &&
        !!layout.fovRowRight && !!layout.displayRowRight && Math.abs(layout.displayRowRight - layout.fovRowRight) <= 2,
        `标签左边缘=${JSON.stringify(layout.labelLefts)}（前两个分别是「视野角…」与「显示」，必须相等）；` +
        `第一行右端=${layout.fovRowRight}、第二行最右=${layout.displayRowRight}` +
        `（差 ${Math.abs((layout.displayRowRight ?? 0) - (layout.fovRowRight ?? 0))}px；滑轨自身还有 6px 内边距，` +
        `所以不能拿滑轨右端比）`);

    // ---- 2. 功能：三个控件都要改到真实状态 ----
    // ⚠️ 这里**必须用真鼠标事件**（page.mouse），不能用 dispatchEvent：
    // 用户报过"开关点了没反应"，而合成事件在元素上直接派发会**绕过指针捕获**，测不出这个 bug
    // （真凶是相机控制器在 #canvas-container 上 setPointerCapture，把 pointerup/click 改派走了）。
    const geometry = await page.evaluate(() => ({
        toggleCenters: Array.from(document.querySelectorAll('#view-quick-controls .vqc-toggle')).map((el) => {
            const r = el.getBoundingClientRect();
            return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
        }),
        sliderTrack: (() => {
            const t = document.querySelector('#view-quick-controls .vqc-slider .pcui-slider-container');
            const r = t.getBoundingClientRect();
            return [Math.round(r.left), Math.round(r.top + r.height / 2), Math.round(r.right), Math.round(r.height)];
        })(),
        before: {
            fov: window.scene.events.invoke('camera.fov'),
            grid: window.scene.events.invoke('grid.visible'),
            bound: (() => {
                try {
                    return window.scene.events.invoke('camera.bound');
                } catch {
                    return null;
                }
            })()
        },
        userDragging: !!window.scene.camera?.userDragging
    }));

    // 视野角：真拖动滑轨（两段式方向测试，比"拖到某个像素必须等于某个角度"稳得多——
    // 滑轨内部还有 padding，像素→角度的映射不该写死在断言里）。
    // ⚠️ 每次拖动前**必须重新量滑轨**：角度读数并进标签文本里，标签宽度随位数变化
    //（"视野角 75°" → "视野角 117°"），滑轨的 left 会跟着挪几个像素，用旧坐标会按到标签上
    // ——这正是我第一版"第二次拖拽不生效"的原因（PCUI 收不到 pointerdown，值自然不动）。
    const dragTo = async (frac) => {
        const track = await page.evaluate(() => {
            const t = document.querySelector('#view-quick-controls .vqc-slider .pcui-slider-container');
            const r = t.getBoundingClientRect();
            return [r.left, r.top + r.height / 2, r.right];
        });
        const [left, y, right] = track;
        await page.mouse.move(Math.round(left + (right - left) * 0.5), y);
        await page.mouse.down();
        await page.mouse.move(Math.round(left + (right - left) * frac), y, { steps: 8 });
        await page.mouse.up();
        await sleep(600);
        return page.evaluate(() => window.scene.events.invoke('camera.fov'));
    };
    const fovHigh = await dragTo(0.92);
    const fovLow = await dragTo(0.08);

    // 两个开关：各来一次**真点击**
    const clickResults = [];
    for (const [cx, cy] of geometry.toggleCenters) {
        const beforeValue = await page.evaluate(([x, y]) => {
            const el = document.elementFromPoint(x, y);
            const toggle = el && el.closest ? el.closest('.vqc-toggle') : null;
            return { hitToggle: !!toggle, value: toggle && toggle.ui ? toggle.ui.value : null };
        }, [cx, cy]);
        await page.mouse.click(cx, cy);
        await sleep(600);
        const afterValue = await page.evaluate(([x, y]) => {
            const el = document.elementFromPoint(x, y);
            const toggle = el && el.closest ? el.closest('.vqc-toggle') : null;
            return { value: toggle && toggle.ui ? toggle.ui.value : null };
        }, [cx, cy]);
        clickResults.push({ center: [cx, cy], hitToggle: beforeValue.hitToggle, before: beforeValue.value, after: afterValue.value });
    }

    const wired = await page.evaluate((before) => ({
        before,
        after: {
            fov: window.scene.events.invoke('camera.fov'),
            grid: window.scene.events.invoke('grid.visible'),
            bound: (() => {
                try {
                    return window.scene.events.invoke('camera.bound');
                } catch {
                    return null;
                }
            })()
        },
        userDragging: !!window.scene.camera?.userDragging
    }), geometry.before);
    wired.clickResults = clickResults;
    wired.canSlider = true;
    wired.toggleCount = clickResults.length;
    wired.fovHigh = fovHigh;
    wired.fovLow = fovLow;

    check('the FOV slider really drives the camera with a real mouse drag (camera.setFov)',
        Math.abs(fovHigh - 120) < 12 && Math.abs(fovLow - 10) < 12 && fovHigh - fovLow > 60 && wired.before.fov !== fovHigh,
        `初始 fov ${wired.before.fov}；真拖到最右 ${fovHigh}（上限 120）、真拖到最左 ${fovLow}（下限 10）`);

    check('a real mouse click flips both switches (the reported "click does nothing" bug)',
        clickResults.length === 2 && clickResults.every(r => r.hitToggle && r.before !== null && r.after === !r.before) &&
        wired.after.grid !== wired.before.grid &&
        (wired.before.bound === null || wired.after.bound !== wired.before.bound),
        `开关点击结果=${JSON.stringify(clickResults)}；网格 ${wired.before.grid} → ${wired.after.grid}；` +
        `边界 ${wired.before.bound} → ${wired.after.bound}`);

    check('clicking the panel does not hand the pointer to the camera controller (pointer capture)',
        wired.userDragging === false,
        `点完面板后 camera.userDragging=${wired.userDragging}（若为 true 说明 pointerdown 冒泡到了 #canvas-container，` +
        `相机抢走指针捕获 ⇒ click 被改派、开关失灵）`);

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
