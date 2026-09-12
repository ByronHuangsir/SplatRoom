const puppeteer = require('puppeteer-core');
(async () => {
    const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'new', args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] });
    const page = await browser.newPage();
    await page.goto('http://localhost:3000/?load=/test.ply&filename=test.ply', { waitUntil: 'networkidle0', timeout: 60000 });
    await new Promise(r => setTimeout(r, 4000));
    const info = await page.evaluate(`(() => {
        const l2 = document.querySelector('.surface-panel-l2');
        if (!l2) return { l2Exists: false };
        const style = getComputedStyle(l2);
        const panel = document.getElementById('surface-panel');
        return {
            l2Exists: true,
            display: style.display,
            childCount: l2.children.length,
            panelText: (panel ? panel.innerText : '').slice(0, 120)
        };
    })()`);
    console.log(JSON.stringify(info, null, 1));
    await browser.close();
})();
