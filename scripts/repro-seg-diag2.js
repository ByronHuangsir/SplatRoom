const puppeteer = require('puppeteer-core');
const path = require('path');
const EXE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = 'http://localhost:3200/seg-lab/?model=scene.ply';
const PLY = 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/real-test.ply';
const OUT = 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/v13';
require('fs').mkdirSync(OUT, { recursive: true });
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EXE, headless: 'new',
    args: ['--no-sandbox','--use-gl=angle','--use-angle=swiftshader',
           '--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--window-size=1280,800']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const logs=[];
  page.on('console', m => logs.push(m.type()+': '+m.text()));
  page.on('pageerror', e => logs.push('PAGEERR: '+e.message));

  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForFunction(()=>{const s=document.getElementById('stat');return s&&/高斯已加载/.test(s.textContent);},{timeout:30000});
  await sleep(800);
  await page.screenshot({ path: path.join(OUT,'diag-default.png') });

  const input = await page.$('#fileInput');
  await input.uploadFile(PLY);
  await page.waitForFunction(()=>{const s=document.getElementById('stat');return s&&/高斯已加载/.test(s.textContent);},{timeout:40000});
  await sleep(1500);
  await page.screenshot({ path: path.join(OUT,'diag-real.png') });

  // dump projection internals directly from the page
  const dbg = await page.evaluate(()=>{
    // recompute projection like the app, expose raw sample
    const cam = pc.app.root.findByName('camera').camera._camera;
    const vp = new pc.Mat4().mul2(cam.projectionMatrix, cam.viewMatrix);
    const data = window.__segData;
    function project(x,y,z){
      const v = new pc.Vec3(x,y,z); vp.transformPoint(v);
      const w = vp.data[3]*x+vp.data[7]*y+vp.data[11]*z+vp.data[15];
      return { X:(v.x/w*0.5+0.5)*1280, Y:(1-(v.y/w*0.5+0.5))*800, w };
    }
    // sample 10 gaussians from the data props
    const px = data.getProp('x'), py=data.getProp('y'), pz=data.getProp('z');
    const samps=[];
    for (let k=0;k<12;k++){ const i=(k*Math.floor(px.length/12))|0; samps.push(Object.assign({i},project(px[i],py[i],pz[i]))); }
    return { samps, n:px.length };
  });
  console.log('DBG samps:', JSON.stringify(dbg,null,1));
  console.log('LOGS seg-debug:', logs.filter(l=>l.includes('seg-debug')).slice(-2).join(' | '));
  await browser.close();
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
