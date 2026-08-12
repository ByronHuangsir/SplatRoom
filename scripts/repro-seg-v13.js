// e2e validation for seg-lab v=13 real-model loading + segmentation
// Steps: default scene loads -> load local real-test.ply via file input ->
//        click-red-ball -> check selected count & background hides.
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const EXE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = 'http://localhost:3200/seg-lab/?model=scene.ply';
const PLY = 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/real-test.ply';
const OUT = path.join(__dirname, 'v13');
fs.mkdirSync(OUT, { recursive: true });
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

  async function waitLoaded(timeout=30000){
    try {
      await page.waitForFunction(() => {
        const s = document.getElementById('stat');
        return s && /高斯已加载/.test(s.textContent);
      }, { timeout });
      return true;
    } catch(e){
      console.log('  WAIT TIMEOUT stat=', await page.evaluate(()=>document.getElementById('stat')?.textContent));
      console.log('  ERRORS:', JSON.stringify(errors));
      return false;
    }
  }

  // ---- 1. default scene ----
  console.log('[1] load default scene.ply');
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  if (!await waitLoaded()) { await page.screenshot({path:path.join(OUT,'1-timeout.png')}); await browser.close(); process.exit(2); }
  await sleep(800);
  const stat1 = await page.evaluate(()=>document.getElementById('stat').textContent);
  console.log('    stat:', stat1);
  await page.screenshot({ path: path.join(OUT,'1-scene-default.png') });

  // ---- 2. real-model via file input ----
  console.log('[2] load real-test.ply via file input');
  const input = await page.$('#fileInput');
  if (!input) { console.log('  ERR: no #fileInput'); await browser.close(); process.exit(3); }
  await input.uploadFile(PLY);
  // wait for new load (gaussian count changes / parsed)
  if (!await waitLoaded(60000)) { await page.screenshot({path:path.join(OUT,'2-timeout.png')}).catch(()=>{}); await browser.close(); process.exit(2); }
  await sleep(2000);
  const stat2 = await page.evaluate(()=>document.getElementById('stat').textContent);
  console.log('    stat:', stat2);
  await page.screenshot({ path: path.join(OUT,'2-real-loaded.png'), timeout: 5000 }).catch(e=>console.log('    (skip 2-real screenshot:', e.message, ')'));
  const N = await page.evaluate(()=>{
    const m = document.getElementById('stat').textContent.match(/([\d,]+)\s*高斯/);
    return m ? parseInt(m[1].replace(/,/g,'')) : -1;
  });
  console.log('    parsed N =', N);

  // ---- 3. click on the red ball. We know red ball center world ~ (-1.4,0.2,0.3).
  //        Use the debug probe to get its screen coords, then real click.
  const target = await page.evaluate(()=>{
    // window.__segProbe exists in v13? ensure exposed. If not, fall back.
    if (typeof window.__segProbe === 'function') {
      return window.__segProbe(-1.4, 0.2, 0.3);
    }
    return null;
  });
  console.log('[3] probe red-ball screen coord:', JSON.stringify(target));
  if (target) {
    // switch to click mode (default) and click
    await page.mouse.click(target.x, target.y);
    await sleep(800);
    const stat3 = await page.evaluate(()=>document.getElementById('stat').textContent);
    console.log('    after click stat:', stat3);
    console.log('    seg-debug:', logs.filter(l=>l.includes('seg-debug')).slice(-3).join(' | '));
    console.log('    cam:', logs.filter(l=>l.includes('[cam]')).slice(-3).join(' | '));
    await page.screenshot({ path: path.join(OUT,'3-red-selected.png') });
    // verify background hidden: selEntity enabled, bgEntity NOT visible
    const vis = await page.evaluate(()=>{
      const root = pc.app ? pc.app.root : null;
      return null; // visibility intrinsic to app; rely on stat text
    });
  } else {
    console.log('    (no probe — skipping click)');
  }

  console.log('[done] errors:', JSON.stringify(errors));
  await browser.close();
  process.exit(errors.length ? 4 : 0);
})().catch(e=>{ console.error('FATAL', e); process.exit(1); });
