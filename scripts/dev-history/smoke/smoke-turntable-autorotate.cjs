// 验证 turntable 导出暂停/恢复 autoRotateMode
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
  const errors = [];
  page.on('pageerror', e => errors.push(String(e).slice(0, 300)));
  await page.goto('http://localhost:3000/?load=/test-crop.ply', { waitUntil: 'networkidle2', timeout: 90000 });
  await sleep(4000);

  const out = await page.evaluate(async () => {
    const sc = window.scene;
    const beforeMode = sc.events.invoke('camera.getAutoRotateMode');
    sc.events.fire('camera.setAutoRotateMode', 'orbit');
    const afterSet = sc.events.invoke('camera.getAutoRotateMode');
    const mockStream = { seek: async () => {}, write: async () => {}, truncate: async () => {}, close: async () => {}, abort: async () => {} };
    let threw = false;
    let errMsg = null;
    try {
      await sc.events.invoke('render.turntableVideo', { frameRate: 30, width: 640, height: 360, bitrate: 200000, format: 'mp4', codec: 'h264' }, mockStream);
    } catch (e) {
      threw = true;
      errMsg = (e && e.message) || String(e);
    }
    const finalMode = sc.events.invoke('camera.getAutoRotateMode');
    return { beforeMode, afterSet, finalMode, threw, errMsg };
  });

  console.log(JSON.stringify({ out, errors }, null, 2));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });