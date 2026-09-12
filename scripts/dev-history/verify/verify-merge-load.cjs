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
    await page.goto('https://62c5e9fe25d8498086362cfb2af7d57b.sh1.agentos-app.net/?mode=merge', { waitUntil: 'networkidle0', timeout: 60000 });
    await new Promise(r => setTimeout(r, 2500));
    const info = await page.evaluate(() => ({ canvas: !!document.querySelector('canvas'), title: document.title }));
    console.log('ERRS ' + JSON.stringify(errs));
    console.log('INFO ' + JSON.stringify(info));
  } catch (e) {
    console.log('FATAL ' + e.message);
  } finally {
    if (browser) await browser.close();
  }
})();
