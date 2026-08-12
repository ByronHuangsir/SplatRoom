const p = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
(async () => {
  let browser;
  try {
    browser = await p.launch({
      executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      headless: true,
      args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--no-sandbox']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto('https://fd3cf952a80e4ba3a65a00654e4d571c.bj8.agentos-app.net/?mode=merge', { waitUntil: 'networkidle0', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));
    // activate fake marker at origin to show gizmo
    await page.evaluate(() => {
      const scene = window.__mergeDebug.scene;
      scene.selectMarker({
        model: { entity: scene.app.root, visible: true },
        hitLocal: { x: 0, y: 0, z: 0 },
        group: 0,
        key: 'm1'
      });
      scene.updateMarkerGizmo();
    });
    await new Promise(r => setTimeout(r, 500));
    const out = path.join('C:', 'Users', 'Byon Huang', 'WorkBuddy', 'SplatRoom', 'scripts', 'gizmo-capture.png');
    await page.screenshot({ path: out, type: 'png' });
    console.log('SAVED', out);
  } catch (e) {
    console.log('FATAL', e.message);
  } finally {
    if (browser) await browser.close();
  }
})();
