// 5 项音频改进验证：1)按钮位置；2)音频名在 lanes；3)波形；4)淡入淡出按钮；5)播放联动
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
  await page.evaluate(() => { window.scene.events.fire('statusBar.panelChanged', 'timeline'); });
  await new Promise(r => setTimeout(r, 500));
  const out = await page.evaluate(() => {
    const bar = document.querySelector('#audio-tools-bar');
    const tools = bar ? Array.from(bar.querySelectorAll('.audio-tool-track')).map(t => ({
        name: t.querySelector('span')?.textContent,
        btns: Array.from(t.querySelectorAll('.audio-tool-btn')).map(b => b.textContent)
    })) : [];
    // 音频 lanes
    const audioHeaders = Array.from(document.querySelectorAll('.audio-lane-header span')).map(s => s.textContent);
    const audioLanes = document.querySelectorAll('.audio-lane-timeline').length;
    // timeline.audioTracks API
    const tracks = window.scene.events.invoke('timeline.audioTracks');
    // 播放联动：尝试 setPlaying → false（音频元素应已创建在 vocal/music）
    let playInvoked = false;
    try {
        window.scene.events.fire('timeline.setPlaying', true);
        window.scene.events.fire('timeline.setPlaying', false);
        playInvoked = true;
    } catch (e) {}
    return {
        toolsInBar: tools,
        audioLaneHeaderNames: audioHeaders,
        audioLaneCount: audioLanes,
        tracksApi: tracks,
        playInvoked
    };
  });
  await page.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/audio-5items.png' });
  console.log(JSON.stringify({ out, errs }, null, 2));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });