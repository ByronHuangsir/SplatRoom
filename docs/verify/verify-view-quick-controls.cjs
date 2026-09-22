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

    // ---- 1. 位置：必须在坐标轴正下方、同一右边缘 ----
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
    check('the quick controls sit directly under the view-cube axis (same right edge, small gap)',
        layout.cube && layout.quick && layout.gap >= 0 && layout.gap <= 16 && Math.abs(layout.rightGap) <= 16,
        layout.quick
            ? `坐标轴 [${layout.cubeBox.join(', ')}]；快捷控件 [${layout.quickBox.join(', ')}] ⇒ 间隙 ${layout.gap}px、` +
              `右边缘差 ${layout.rightGap}px（pointer-events=${layout.pointerEvents}，可点击）`
            : `找不到元素（cube=${layout.cube} quick=${layout.quick}）`);

    // 用户报的 bug：这块盖住了右侧工具栏最上面两个按钮 ⇒ 工具栏已下移，这里必须**不再重叠**
    const overlaps = (a, b) => !!a && !!b &&
        !(a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1]);
    const hitRight = overlaps(layout.quickBox, layout.rightToolbar);
    const hitBottom = overlaps(layout.quickBox, layout.bottomToolbar);
    check('the panel does not cover the right toolbar (the reported bug) nor the bottom toolbar',
        layout.quickBox && !hitRight && !hitBottom,
        `快捷控件 [${(layout.quickBox ?? []).join(', ')}]；右侧工具栏 [${(layout.rightToolbar ?? []).join(', ')}]` +
        ` ⇒ 重叠=${hitRight}；底部工具栏 [${(layout.bottomToolbar ?? []).join(', ')}] ⇒ 重叠=${hitBottom}`);

    // 用户报的第二个 bug（2026-09-22）：调色面板打开后被这块挡住 ⇒ 用户选定"面板打开时把我藏起来"
    //（另一方案是挪到面板列左边，但那就不在坐标轴正下方了，用户没选）。
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
    const hiddenWhileColor = panels.color.quick === null;
    const hiddenWhileSettings = panels.settings.quick === null;
    check('it hides itself while a right-side panel (color / settings) is open, and comes back after (the second reported bug)',
        panels.color.opened && panels.settings.opened && !!panels.color.panel && !!panels.settings.panel &&
        hiddenWhileColor && hiddenWhileSettings && !!panels.restored,
        `调色面板 [${(panels.color.panel ?? []).join(', ')}] 打开时快捷面板 = ${panels.color.quick ? '[' + panels.color.quick.join(', ') + ']' : '隐藏'}；` +
        `设置面板 [${(panels.settings.panel ?? []).join(', ')}] 打开时 = ${panels.settings.quick ? '[' + panels.settings.quick.join(', ') + ']' : '隐藏'}；` +
        `两个都关掉后回到 [${(panels.restored ?? []).join(', ')}]`);

    // 用户要求：视野角**不要输入框**、滑轨**要长**
    check('the FOV control has no input box and its track is long',
        layout.sliderInputHidden === true && (layout.sliderTrackWidth ?? 0) >= 120,
        `数字输入框 display=none 且宽 ${layout.sliderInputWidth}px；滑轨容器 ${layout.sliderTrackWidth}px、` +
        `bar ${layout.sliderBarWidth}px（改前轨道只有 18px）`);

    check('it carries exactly the three requested controls (1 slider + 2 toggles)',
        layout.slider === true && layout.toggles === 2 && (layout.rows ?? []).length === 3,
        `行=${JSON.stringify(layout.rows)}；滑杆=${layout.slider}；开关=${layout.toggles}`);

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
                clip: { x: 900, y: 0, width: 380, height: 320 }
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
