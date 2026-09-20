const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = 'https://b174fc23368348b69c9cc8e6fb68a259.bj10.agentos-app.net/?mode=merge';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new',
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 90000 }).catch(e => errors.push('goto: ' + e.message));
    await new Promise(r => setTimeout(r, 5000));

    const report = await page.evaluate(() => {
      const vc = document.getElementById('merge-view-cube');
      const btns = document.getElementById('merge-view-btns');
      const canvas = document.querySelector('canvas');
      return {
        viewCube: !!vc,
        viewCubeSvgChildren: vc ? vc.querySelectorAll('g > *').length : 0,
        viewButtons: btns ? Array.from(btns.querySelectorAll('button')).map(b => b.textContent) : null,
        canvasExists: !!canvas
      };
    }).catch(e => ({ evalErr: String(e) }));

    console.log(JSON.stringify(report, null, 1));
    console.log('pageerrors:', errors.slice(0, 6));
  } finally {
    await browser.close();
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
