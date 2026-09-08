const puppeteer = require('puppeteer-core');
(async () => {
    const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'new', args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] });
    const page = await browser.newPage();
    await page.goto('http://localhost:3000/?load=/test.ply&filename=test.ply', { waitUntil: 'networkidle0', timeout: 60000 });
    await new Promise(r => setTimeout(r, 4000));
    const info = await page.evaluate(`(() => {
        const panel = document.getElementById('surface-panel');
        if (!panel) return 'panel NOT FOUND';
        const text = panel.innerText || '';
        return {
            hasL2Title: text.includes('二级平整') || text.includes('Level 2'),
            hasScatter: text.includes('移除散点') || text.includes('removeScatter') || text.includes('Scatter'),
            hasRadius: text.includes('搜索半径') || text.includes('Radius'),
            hasOutlierSlider: text.includes('离群阈值') || text.includes('Outlier Threshold'),
            hasSplit: text.includes('分裂') || text.includes('Split'),
            sample: text.slice(0, 300)
        };
    })()`);
    console.log(JSON.stringify(info, null, 1));
    await browser.close();
})();
