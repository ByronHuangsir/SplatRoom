const puppeteer = require('puppeteer-core');
(async () => {
    const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'new', args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] });
    const page = await browser.newPage();
    page.on('response', (r) => { if (r.status() >= 400) console.log('HTTP', r.status(), r.url()); });
    await page.goto('http://localhost:3000/seg-lab/?model=test.ply', { waitUntil: 'networkidle0', timeout: 60000 });
    await new Promise(r => setTimeout(r, 2500));
    const info = await page.evaluate(`(() => {
        const scriptTags = [...document.querySelectorAll('script')].map(s => s.src);
        const res = performance.getEntriesByType('resource').filter(e => e.name.includes('localhost')).map(e => e.name.split('/').pop());
        return { scripts: scriptTags, resources: res, stat: document.getElementById('stat').textContent };
    })()`);
    console.log(JSON.stringify(info, null, 1));
    await browser.close();
})();
