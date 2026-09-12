// Verify 自定义操控: menu entry, dialog renders, mouse bindings + shortcut rebind work
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        headless: 'new',
        args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-gl=angle',
               '--use-angle=swiftshader', '--enable-webgl', '--enable-webgl2', '--window-size=1440,900', '--hide-scrollbars']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e).slice(0, 300)));
    page.on('console', m => { if (m.type() === 'error' && !m.text().includes('404')) errors.push('CONSOLE:' + m.text().slice(0, 200)); });

    await page.goto('http://localhost:3000/?load=/test-crop.ply', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(6000);

    const out = await page.evaluate(async () => {
        const sc = window.scene;
        const res = {};

        // 1. mouse bindings module registered
        const before = sc.events.invoke('mouseBindings.get');
        res.defaultBindings = before;

        // 2. set custom mapping → get reflects it
        sc.events.fire('mouseBindings.set', { left: 'pan', middle: 'zoom', right: 'orbit' });
        res.afterSet = sc.events.invoke('mouseBindings.get');

        // 3. shortcut manager rebind works + persists to localStorage
        const sm = sc.events.invoke('shortcutManager');
        const beforeKb = sm.get('camera.focus');
        sm.rebind('camera.focus', { keys: ['g'], shift: 'required' });
        const afterKb = sm.get('camera.focus');
        const stored = JSON.parse(localStorage.getItem('splatroom.shortcutBindings') || '{}');
        res.shortcutRebind = {
            before: beforeKb,
            after: afterKb,
            storedFocus: stored['camera.focus']
        };

        // 4. reset mouse → back to defaults
        sc.events.fire('mouseBindings.reset');
        res.afterReset = sc.events.invoke('mouseBindings.get');

        // 5. open dialog → rows render
        sc.events.fire('show.controlCustomizeDialog');
        await new Promise(r => setTimeout(r, 300));
        const dlg = document.querySelector('#control-customize-dialog');
        const visible = dlg && getComputedStyle(dlg).display !== 'none';
        const selects = dlg ? dlg.querySelectorAll('.select').length : 0;
        const kbRows = dlg ? dlg.querySelectorAll('.kb-row').length : 0;
        const sectionLabels = dlg ? Array.from(dlg.querySelectorAll('.section-label')).map(el => el.textContent) : [];
        res.dialog = { visible, selectCount: selects, kbRowCount: kbRows, sectionLabels };

        // 6. dialog select reflects current binding
        const leftSelect = dlg ? dlg.querySelector('.select') : null;
        res.leftSelectValue = leftSelect ? leftSelect.value : null;

        // screenshot
        return res;
    });
    console.log(JSON.stringify({ out, errors }, null, 2));
    await page.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/control-customize.png' });
    await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
