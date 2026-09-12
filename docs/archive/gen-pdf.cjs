/* SplatRoom 探索存档 HTML → PDF 生成脚本（puppeteer-core + Edge） */
const path = require('path');
const puppeteer = require('C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const DOCS = __dirname;
const HTML = path.join(DOCS, 'merge-tool-exploration-archive.html');
const OUT = path.join(DOCS, 'merge-tool-exploration-archive.pdf');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none']
  });
  try {
    const page = await browser.newPage();
    await page.goto('file:///' + HTML.replace(/\\/g, '/'), { waitUntil: 'networkidle0', timeout: 60000 });
    // 等待图片解码
    await page.evaluate(async () => {
      const imgs = Array.from(document.images);
      await Promise.all(imgs.map(img => img.complete ? Promise.resolve() :
        new Promise(res => { img.onload = res; img.onerror = res; })));
    });
    await page.emulateMediaType('print');
    await page.pdf({
      path: OUT,
      format: 'A4',
      printBackground: true,
      margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' },
      displayHeaderFooter: true,
      headerTemplate: '<span style="font-size:8px;color:#888;margin-left:12mm;">SplatRoom · 合并工具探索历程存档</span>',
      footerTemplate: '<div style="font-size:8px;color:#888;width:100%;text-align:center;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>'
    });
    console.log('PDF_OK:', OUT);
  } finally {
    await browser.close();
  }
})().catch(e => { console.error('PDF_FAIL:', e.message); process.exit(1); });
