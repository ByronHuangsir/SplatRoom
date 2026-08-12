const p = require('puppeteer-core');
const path = 'D:/3DGS/训练结果/对比/merged.ply';
(async () => {
  let browser;
  try {
    browser = await p.launch({
      executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      headless: true,
      args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--no-sandbox','--allow-file-access-from-files']
    });
    const page = await browser.newPage();
    const logs = [];
    page.on('pageerror', e => logs.push('PAGEERROR ' + e.message));
    page.on('console', m => { if (m.type()==='error') logs.push('CONSOLE_ERR ' + m.text().slice(0,300)); });
    page.on('popup', async pop => { try { const t = await pop.evaluate(()=>document.body.innerText); logs.push('POPUP ' + t.slice(0,300)); } catch(e){ logs.push('POPUP_ERR '+e.message);} });
    await page.goto('https://7239edfe842a4621b23476f03bd22af6.bj8.agentos-app.net/', { waitUntil: 'networkidle0', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));
    // find file input
    const input = await page.$('input[type=file]');
    if (!input) { console.log('NO_FILE_INPUT'); return; }
    await input.uploadFile(path);
    // wait for load attempt
    await new Promise(r => setTimeout(r, 15000));
    // try to read any error popup text
    const popupText = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('*')).map(e => e.innerText || '').filter(t => /loading|error|failed|无法|打不开/i.test(t));
      return els.slice(0,5).join(' || ').slice(0,500);
    });
    console.log('POPUP_TEXT', popupText);
    console.log('LOGS', JSON.stringify(logs, null, 2));
  } catch (e) {
    console.log('FATAL', e.message);
  } finally {
    if (browser) await browser.close();
  }
})();
