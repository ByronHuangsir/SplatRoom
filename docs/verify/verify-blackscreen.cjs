const puppeteer = require('C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'https://59c60cb96be04e9c8494bfb8ab3639d4.bj10.agentos-app.net/?mode=merge';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new',
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    const logs = [];
    page.on('pageerror', e => errors.push(String(e).slice(0, 400)));
    page.on('console', m => { const t = m.text(); if (m.type() === 'error' || t.includes('merge')) logs.push(t.slice(0, 300)); });
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 90000 }).catch(e => errors.push('goto: ' + e.message));
    await new Promise(r => setTimeout(r, 6000));

    // 截图判断是否黑屏
    const shot = await page.screenshot({ encoding: 'binary' });
    // 采样截图中心区域颜色（判断是否纯黑）
    const centerPx = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      if (!c) return 'NO_CANVAS';
      try {
        const g = c.getContext('webgl2') || c.getContext('webgl');
        if (!g) return 'NO_GL';
        const px = new Uint8Array(4);
        g.readPixels(Math.floor(c.width/2), Math.floor(c.height/2), 1, 1, g.RGBA, g.UNSIGNED_BYTE, px);
        return `rgba(${px[0]},${px[1]},${px[2]},${px[3]})`;
      } catch (e) { return 'READ_ERR:' + String(e).slice(0,80); }
    }).catch(e => 'EVAL:' + String(e).slice(0,80));

    const ui = await page.evaluate(() => ({
      canvas: !!document.querySelector('canvas'),
      mergePanel: !!document.querySelector('.merge-panel'),
      viewCube: !!document.getElementById('merge-view-cube'),
      viewBtns: !!document.getElementById('merge-view-btns')
    })).catch(e => ({ err: String(e) }));

    console.log('shot bytes:', shot.length);
    console.log('centerPixel:', centerPx);
    console.log('ui:', JSON.stringify(ui));
    console.log('pageerrors:', errors.slice(0, 8));
    console.log('console:', logs.slice(0, 10));
  } finally {
    await browser.close();
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
