// Final v=5 check: both single-sphere (test.ply) and multi-object (scene.ply)
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function check(url, label, expectedFragment) {
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: 'new',
        args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

    await page.goto(url, { waitUntil: 'networkidle0' });
    await sleep(2500);

    await page.mouse.click(700, 450);
    await sleep(1500);
    const stat = await page.evaluate(() => document.getElementById('stat').textContent);
    const ok = stat.includes(expectedFragment) && errs.length === 0;
    console.log(`[${label}] url=${url}`);
    console.log(`  stat: ${stat}`);
    console.log(`  errors: ${errs.length ? errs.join(' | ') : 'NONE'}`);
    console.log(`  ${ok ? 'PASS' : 'FAIL'} (expected "${expectedFragment}")`);
    await browser.close();
    return ok;
}

(async () => {
    const a = await check('http://localhost:3000/seg-lab/?model=test.ply', 'TEST.PLY single-sphere', '⚠ 选中了全部');
    const b = await check('http://localhost:3000/seg-lab/?model=scene.ply', 'SCENE.PLY multi-object', '隐藏背景');
    const c = await check('http://localhost:3000/seg-lab/', 'DEFAULT fallback (no query)', '隐藏背景');
    process.exit((a && b && c) ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
