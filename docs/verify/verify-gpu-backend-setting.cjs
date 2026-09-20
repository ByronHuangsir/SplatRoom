// Verify the settings-panel graphics-backend picker: the row must offer WebGL2 and WebGPU,
// persist the choice (the backend is fixed at device creation, so it applies on the next
// start) and tell the user a restart is needed.
//
// usage: node docs/verify/verify-gpu-backend-setting.cjs [url]
const puppeteer = require('puppeteer-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// the PCUI SelectInput that offers a WebGPU option (the only one with that option)
const GPU_SELECT = `Array.from(document.querySelectorAll('.pcui-select-input')).find(el =>
    Array.from(el.querySelectorAll('.pcui-select-input-list .pcui-label')).some(l => l.textContent.trim() === 'WebGPU'))`;

const pickOption = (page, label) => page.evaluate((js, want) => {
    const el = eval(js);
    if (!el) return { ok: false, reason: 'select not found' };
    const option = Array.from(el.querySelectorAll('.pcui-select-input-list .pcui-label'))
        .find(l => l.textContent.trim() === want);
    if (!option) return { ok: false, reason: 'option not found' };
    option.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return {
        ok: true,
        stored: window.localStorage.getItem('splatroom.gpuBackend'),
        selected: el.querySelector('.pcui-select-input-value')?.textContent.trim() ?? null
    };
}, GPU_SELECT, label);

const readState = (page) => page.evaluate((js) => {
    const el = eval(js);
    const popup = document.querySelector('#popup');
    return {
        found: !!el,
        options: el ? Array.from(el.querySelectorAll('.pcui-select-input-list .pcui-label')).map(l => l.textContent.trim()) : [],
        value: el ? el.querySelector('.pcui-select-input-value')?.textContent.trim() ?? null : null,
        stored: window.localStorage.getItem('splatroom.gpuBackend'),
        popupVisible: !!popup && !popup.classList.contains('pcui-hidden'),
        popupText: (popup?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
    };
}, GPU_SELECT);

(async () => {
    const logs = [];
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
    });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        page.on('console', (m) => { if (m.type() === 'error') logs.push(`error: ${m.text().slice(0, 200)}`); });
        page.on('pageerror', e => logs.push('pageerror: ' + String(e).slice(0, 200)));

        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForFunction('!!window.scene', { timeout: 90000 });
        await sleep(2500);

        const initial = await readState(page);

        const toGpu = await pickOption(page, 'WebGPU');
        await sleep(900);
        const afterGpu = await readState(page);

        const toGl = await pickOption(page, 'WebGL2');
        await sleep(900);
        const afterGl = await readState(page);

        // leave the stored preference unset so the harness does not decide the backend
        await page.evaluate(() => window.localStorage.removeItem('splatroom.gpuBackend'));

        const checks = [
            {
                name: 'settings panel offers both backends',
                pass: initial.found && initial.options.includes('WebGL2') && initial.options.includes('WebGPU'),
                detail: JSON.stringify(initial.options)
            },
            {
                name: 'choosing WebGPU persists the preference',
                pass: toGpu.ok && afterGpu.stored === 'webgpu',
                detail: `stored=${afterGpu.stored} shown=${afterGpu.value}`
            },
            {
                name: 'a restart is explained',
                pass: afterGpu.popupVisible && /restart|启动|재시작|Neustart|reinicio|redémarr|リスタート|reinicializ|перезап/i.test(
                    `${afterGpu.popupText}`
                ),
                detail: afterGpu.popupText
            },
            {
                name: 'choosing WebGL2 persists the preference',
                pass: toGl.ok && afterGl.stored === 'webgl2',
                detail: `stored=${afterGl.stored} shown=${afterGl.value}`
            }
        ];

        console.log(JSON.stringify({
            initial, toGpu, afterGpu, toGl, afterGl,
            checks, failed: checks.filter(c => !c.pass).length, logs
        }, null, 2));
        if (checks.some(c => !c.pass) || logs.length) process.exitCode = 1;
    } catch (e) {
        console.log(JSON.stringify({ fatal: String(e).slice(0, 400), logs }, null, 2));
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
