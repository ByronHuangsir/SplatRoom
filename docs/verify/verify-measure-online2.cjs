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

    // wait for i18n: poll until a known localized string appears somewhere
    let i18nReady = false;
    for (let i = 0; i < 20; i++) {
      const txt = await page.evaluate(() => document.body.innerText || '').catch(() => '');
      if (txt.includes('文件') || txt.includes('File')) { i18nReady = true; break; }
      await new Promise(r => setTimeout(r, 1000));
    }

    await page.click('#bottom-toolbar-measure').catch(e => errors.push('click: ' + e.message));
    await new Promise(r => setTimeout(r, 2500));

    const report = await page.evaluate(() => {
      const tb = document.querySelector('.select-toolbar');
      if (!tb) return { found: false };
      const btns = Array.from(tb.querySelectorAll('button')).map(b => b.textContent.trim());
      const inputs = tb.querySelectorAll('input').length;
      const labels = Array.from(tb.querySelectorAll('label')).map(l => l.textContent.trim());
      return {
        found: true,
        hidden: tb.classList.contains('pcui-hidden') || tb.style.display === 'none',
        buttons: btns,
        inputs,
        labels,
        html: tb.innerHTML.slice(0, 400)
      };
    }).catch(e => ({ evalErr: String(e) }));

    console.log('i18nReady:', i18nReady);
    console.log('report:', JSON.stringify(report, null, 1));
    console.log('pageerrors:', errors.slice(0, 6));
  } finally {
    await browser.close();
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
