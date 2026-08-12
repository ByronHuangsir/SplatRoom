// verify seg-lab v=12 (SAM 2D->3D projection) end-to-end on port 3100
const puppeteer = require('puppeteer-core');
const path = require('path');
const EXE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = 'http://localhost:3200/seg-lab/?model=scene.ply';
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EXE, headless: 'new',
    args: ['--no-sandbox','--use-gl=angle','--use-angle=swiftshader',
           '--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--window-size=1280,800']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  const logs = [];
  page.on('console', m => { logs.push(m.type()+': '+m.text()); if (m.type()==='error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERR: '+e.message));

  await page.goto(BASE, { waitUntil: 'networkidle2' });
  try {
    await page.waitForFunction(() => document.getElementById('stat') &&
        /高斯已加载|失败|初始化/.test(document.getElementById('stat').textContent), { timeout: 20000 });
  } catch (e) {
    console.log('WAIT TIMEOUT. stat=', await page.evaluate(()=>document.getElementById('stat')?.textContent));
    console.log('LOGS:', JSON.stringify(logs.slice(-20)));
    console.log('ERRORS:', JSON.stringify(errors));
    await page.screenshot({ path: path.join(__dirname,'v12-timeout.png') });
    await browser.close();
    process.exit(2);
  }
  await sleep(600);

  const rect = await page.evaluate(() => {
    const r = document.getElementById('app').getBoundingClientRect();
    return { w: r.width, h: r.height };
  });
  console.log('canvas', JSON.stringify(rect));

  // Find red ball screen pos via the in-page projection probe.
  // scene.ply red ball center (1.35, 0.25, 1.15).
  const red = await page.evaluate(() => window.__segProbe(1.35, 0.25, 1.15));
  const blue = await page.evaluate(() => window.__segProbe(-1.30, -0.15, 1.05));
  const green = await page.evaluate(() => window.__segProbe(0.10, 1.35, 0.60));
  console.log('red@', JSON.stringify(red), 'blue@', JSON.stringify(blue), 'green@', JSON.stringify(green));

  async function clickWorld(label, wp) {
    const p = await page.evaluate((w)=>window.__segProbe(w[0],w[1],w[2]), wp);
    await page.mouse.click(p.x, p.y);
    await sleep(500);
    const st = await page.evaluate(() => document.getElementById('stat').textContent);
    await page.screenshot({ path: path.join(__dirname, `v12-${label}-click.png`) });
    console.log(`${label} click -> ${st}`);
    return st;
  }

  // 1) click red ball: should select ONLY the red ball (~400), not whole scene
  const stRed = await clickWorld('red', [1.35, 0.25, 1.15]);
  const mRed = stRed.match(/选中 (\d[\d,]*)/);
  const nRed = mRed ? parseInt(mRed[1].replace(/,/g,''),10) : -1;

  // 2) reset, then box-select around blue ball
  await page.evaluate(() => document.getElementById('btnReset').click());
  await sleep(300);
  await page.evaluate(() => { document.querySelector('#modeBar button[data-mode="box"]').click(); });
  await sleep(200);
  // box around blue (project a small area)
  const b0 = await page.evaluate(() => window.__segProbe(-1.30-0.5, -0.15-0.5, 1.05-0.5));
  const b1 = await page.evaluate(() => window.__segProbe(-1.30+0.5, -0.15+0.5, 1.05+0.5));
  await page.mouse.move(b0.x, b0.y);
  await page.mouse.down();
  await page.mouse.move(b1.x, b1.y, {steps: 8});
  await page.mouse.up();
  await sleep(500);
  const stBox = await page.evaluate(() => document.getElementById('stat').textContent);
  await page.screenshot({ path: path.join(__dirname, 'v12-blue-box.png') });
  console.log('blue box ->', stBox);

  console.log('ERRORS:', JSON.stringify(errors));
  await browser.close();
  // summary
  console.log('RESULT nRed=', nRed, '(expect 100-1200, definitely < 3500)');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
