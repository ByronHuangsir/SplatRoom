const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new',
    args: ['--no-sandbox','--ignore-gpu-blocklist','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader','--enable-webgl','--enable-webgl2','--window-size=1440,900','--hide-scrollbars']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 3500));
  await page.evaluate(() => { window.scene.events.fire('statusBar.panelChanged', 'timeline'); });
  await new Promise(r => setTimeout(r, 400));
  await page.evaluate(() => {
    const tl = document.querySelector('#timeline-panel');
    const h = tl.querySelector('#timeline-panel-resize-handle');
    const rect = h.getBoundingClientRect();
    h.dispatchEvent(new PointerEvent('pointerdown', { clientX: rect.left, clientY: rect.top, isPrimary: true, pointerId: 1, bubbles: true }));
    h.dispatchEvent(new PointerEvent('pointermove', { clientX: rect.left, clientY: rect.top + 400, isPrimary: true, pointerId: 1, bubbles: true }));
    h.dispatchEvent(new PointerEvent('pointerup', { clientX: rect.left, clientY: rect.top + 400, isPrimary: true, pointerId: 1, bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 300));
  const out = await page.evaluate(() => {
    const tl = document.querySelector('#timeline-panel');
    const btn = tl.querySelector('.audio-track-btn');
    const audio = document.querySelector('#audio-tracks');
    const lanes = tl.querySelector('#timeline-lanes');
    const childrenOrder = Array.from(tl.children).map(c => c.id || c.className);
    return {
      panelHeight: tl.offsetHeight,
      btnSize: btn ? { w: btn.offsetWidth, h: btn.offsetHeight } : null,
      audioPosition: audio ? getComputedStyle(audio).position : null,
      childOrder: childrenOrder,
      hasLanes: !!lanes
    };
  });
  await page.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/timeline-audio-v2.png' });
  console.log(JSON.stringify({ out, errs }));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });