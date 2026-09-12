const p = require('puppeteer-core');
(async () => {
  let browser;
  try {
    browser = await p.launch({
      executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      headless: true,
      args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--no-sandbox']
    });
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE_ERR ' + m.text().slice(0, 200)); });
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto('https://fd3cf952a80e4ba3a65a00654e4d571c.bj8.agentos-app.net/?mode=merge', { waitUntil: 'networkidle0', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));
    const debug = await page.evaluate(() => {
      const scene = window.__mergeDebug.scene;
      // create a fake marker at world origin using scene.app.root as entity
      const fakeMk = {
        model: { entity: scene.app.root, visible: true },
        hitLocal: { x: 0, y: 0, z: 0 },
        group: 0,
        key: 'm1'
      };
      scene.selectMarker(fakeMk);
      scene.updateMarkerGizmo();
      const g = scene.markerGizmo;
      const camPos = scene.camera.getPosition();
      const dist = Math.hypot(camPos.x, camPos.y, camPos.z);
      return {
        gizmoSize: g.size,
        gizmoRootScale: g.root ? g.root.getLocalScale() : null,
        gizmoRootPos: g.root ? g.root.getLocalPosition() : null,
        gizmoEnabled: g.root ? g.root.enabled : null,
        cameraPos: { x: camPos.x, y: camPos.y, z: camPos.z },
        distToOrigin: dist
      };
    });
    console.log('ERRS', JSON.stringify(errs));
    console.log('DEBUG', JSON.stringify(debug, null, 2));
  } catch (e) {
    console.log('FATAL', e.message);
  } finally {
    if (browser) await browser.close();
  }
})();
