// Final validation: default scene (v12 baseline) + real-model via file input
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const EXE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = 'http://localhost:3200/seg-lab/?model=scene.ply';
const PLY = 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/real-test.ply';
const OUT = 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/v14-final';
fs.mkdirSync(OUT, { recursive: true });
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EXE, headless: 'new',
    args: ['--no-sandbox','--use-gl=angle','--use-angle=swiftshader',
           '--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--window-size=1280,800'],
    protocolTimeout: 120000
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const logs = [], errors = [];
  page.on('console', m => { logs.push(m.type()+': '+m.text()); if (m.type()==='error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERR: '+e.message));

  const waitLoaded = async (t=30000) => page.waitForFunction(()=>{
    const s = document.getElementById('stat');
    return s && /高斯已加载/.test(s.textContent);
  }, { timeout: t });

  // ----- 1. default scene -----
  console.log('[1] default scene.ply');
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await waitLoaded();
  await sleep(800);
  console.log('    stat:', await page.evaluate(()=>document.getElementById('stat').textContent));
  const t1 = await page.evaluate(()=>window.__segProbe(-0.6, 0.6, 0.5));
  await page.mouse.click(t1.x, t1.y);
  await sleep(500);
  console.log('    click seg:', await page.evaluate(()=>document.getElementById('stat').textContent));
  await page.screenshot({ path: path.join(OUT,'1-default-clicked.png'), timeout: 10000 }).catch(()=>{});

  // ----- 2. real-model via file input -----
  console.log('[2] real-model via file input');
  const input = await page.$('#fileInput');
  await input.uploadFile(PLY);
  await waitLoaded(60000);
  await sleep(2500);
  console.log('    stat:', await page.evaluate(()=>document.getElementById('stat').textContent));
  const t2 = await page.evaluate(()=>window.__segProbe(-1.4, 0.2, 0.3));
  console.log('    red probe:', JSON.stringify(t2));
  await page.mouse.click(t2.x, t2.y);
  await sleep(800);
  console.log('    click seg:', await page.evaluate(()=>document.getElementById('stat').textContent));
  await page.screenshot({ path: path.join(OUT,'2-real-clicked.png'), timeout: 15000 }).catch(()=>{});

  console.log('[done] errors:', JSON.stringify(errors));
  await browser.close();
  process.exit(errors.length ? 4 : 0);
})().catch(e=>{console.error('FATAL',e);process.exit(1);});