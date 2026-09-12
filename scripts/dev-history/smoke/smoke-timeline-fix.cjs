// 验证：1) resize handle 恢复；2) 音频按钮移到 lane header；3) 拖拽改高度
const puppeteer = require('C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'new',
    args: ['--no-sandbox','--ignore-gpu-blocklist','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader','--enable-webgl','--enable-webgl2','--window-size=1440,900','--hide-scrollbars']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
  await page.goto('http://localhost:3000/?load=/test-crop.ply', { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 4000));
  await page.evaluate(() => window.scene.events.fire('statusBar.panelChanged', 'timeline'));
  await new Promise(r => setTimeout(r, 500));

  // 拖拽 resize handle (向上拖 80px → height 增加)
  const beforeHeight = await page.evaluate(() => document.querySelector('#timeline-panel').offsetHeight);
  await page.evaluate(() => {
    const h = document.querySelector('#timeline-panel-resize-handle');
    const r = h.getBoundingClientRect();
    h.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left, clientY: r.top, isPrimary: true, pointerId: 1, bubbles: true }));
    h.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left, clientY: r.top - 80, isPrimary: true, pointerId: 1, bubbles: true }));
    h.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left, clientY: r.top - 80, isPrimary: true, pointerId: 1, bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 200));
  const afterHeight = await page.evaluate(() => document.querySelector('#timeline-panel').offsetHeight);

  const out = await page.evaluate(() => {
    const resizeHandle = document.querySelector('#timeline-panel-resize-handle');
    const audioHeaders = Array.from(document.querySelectorAll('.audio-lane-header')).map(h => {
      const name = h.querySelector('span')?.textContent;
      const btns = Array.from(h.querySelectorAll('.audio-tool-btn')).map(b => b.textContent);
      return { name, btns };
    });
    const audioToolsBar = document.querySelector('#audio-tools-bar');
    return {
      resizeHandleExists: !!resizeHandle,
      audioLaneHeaders: audioHeaders,
      audioToolsBarEmpty: !audioToolsBar || audioToolsBar.children.length === 0
    };
  });

  await page.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/timeline-fix.png' });
  console.log(JSON.stringify({ beforeHeight, afterHeight, delta: afterHeight - beforeHeight, out, errs }, null, 2));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });