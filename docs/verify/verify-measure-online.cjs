const puppeteer = require('C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'https://f569b13a56304425a2bfc4913482fb60.app.codebuddy.work';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage']
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + String(e).slice(0, 200)));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 90000 }).catch(e => errors.push('goto: ' + e.message));
    await new Promise(r => setTimeout(r, 4000));

    const hasMeasureBtn = await page.$('#bottom-toolbar-measure').then(Boolean).catch(() => false);

    // click measure tool
    await page.click('#bottom-toolbar-measure').catch(() => {});
    await new Promise(r => setTimeout(r, 1500));

    const toolbarText = await page.evaluate(() => {
      const tb = document.querySelector('.select-toolbar');
      return tb ? tb.textContent.trim().replace(/\s+/g, ' | ') : 'NO_TOOLBAR';
    }).catch(() => 'EVAL_FAIL');

    // also fetch the served sw.js BUILD_ID to confirm cache busting
    const swHead = await page.evaluate(async () => {
      try {
        const r = await fetch('./sw.js');
        return await r.text();
      } catch (e) { return 'sw fetch fail'; }
    }).catch(() => 'n/a');

    console.log('URL:', URL);
    console.log('hasMeasureBtn:', hasMeasureBtn);
    console.log('toolbar:', toolbarText);
    console.log('sw has BUILD_ID timestamp:', swHead.includes('__BUILD_ID__') ? 'NO(placeholder!)' : 'yes(baked)');
    console.log('errors:', errors.slice(0, 8));
  } finally {
    await browser.close();
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
