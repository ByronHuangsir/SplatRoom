const puppeteer = require('puppeteer-core');
const { BROWSER_PATH: EDGE } = require('./lib/browser.cjs');
const URL = 'https://f569b13a56304425a2bfc4913482fb60.app.codebuddy.work';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new',
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e).slice(0, 300)));
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 90000 }).catch(e => errors.push('goto: ' + e.message));
    await new Promise(r => setTimeout(r, 4000));

    // enumerate toolbars BEFORE clicking
    const before = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.select-toolbar')).map((tb, i) => ({
        i, hidden: tb.classList.contains('pcui-hidden'), txt: (tb.textContent || '').trim().slice(0, 60)
      }));
    });

    await page.click('#bottom-toolbar-measure').catch(e => errors.push('click: ' + e.message));
    await new Promise(r => setTimeout(r, 2000));

    const after = await page.evaluate(() => {
      const measureTb = Array.from(document.querySelectorAll('.select-toolbar')).find(tb => {
        const txt = tb.textContent || '';
        return txt.includes('设置比例尺') || txt.includes('Set Scale') || txt.includes('measure');
      });
      return {
        all: Array.from(document.querySelectorAll('.select-toolbar')).map((tb, i) => ({
          i, hidden: tb.classList.contains('pcui-hidden'), txt: (tb.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120)
        })),
        measureFound: !!measureTb,
        measureHidden: measureTb ? measureTb.classList.contains('pcui-hidden') : null,
        measureText: measureTb ? (measureTb.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200) : null
      };
    }).catch(e => ({ evalErr: String(e) }));

    console.log('BEFORE:', JSON.stringify(before));
    console.log('AFTER:', JSON.stringify(after, null, 1));
    console.log('pageerrors:', errors.slice(0, 6));
  } finally {
    await browser.close();
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
