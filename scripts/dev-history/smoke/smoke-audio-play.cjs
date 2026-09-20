// 验证：play 按钮在 user gesture 同步调用 audio.play()
const puppeteer = require('puppeteer-core');
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
  const out = await page.evaluate(() => {
    // Spy on Audio.prototype.play to confirm play is invoked in the click handler
    const origPlay = HTMLMediaElement.prototype.play;
    let playCallCount = 0;
    let playInUserGesture = false;
    HTMLMediaElement.prototype.play = function () { playCallCount++; return origPlay.call(this); };
    const playBtn = document.querySelector('#button-controls .button:nth-child(2)');
    if (!playBtn) return { error: 'play button not found' };
    playBtn.click();
    return new Promise(r => setTimeout(() => {
        HTMLMediaElement.prototype.play = origPlay;
        r({ playCallCount, timelinePlaying: window.scene.events.invoke('timeline.playing') });
    }, 600));
  });
  console.log(JSON.stringify({ out, errs }, null, 2));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });