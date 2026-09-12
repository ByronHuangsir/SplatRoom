const puppeteer = require('puppeteer-core');
(async () => {
    const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'new', args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] });
    const page = await browser.newPage();
    await page.goto('http://localhost:3000/seg-lab/?model=scene.ply', { waitUntil: 'networkidle0', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3500));
    const info = await page.evaluate(`(() => {
        const show = (i) => ({ i, x: +px[i].toFixed(3), y: +py[i].toFixed(3), z: +pz[i].toFixed(3), r: +rgbCache[i*3].toFixed(2), g: +rgbCache[i*3+1].toFixed(2), b: +rgbCache[i*3+2].toFixed(2) });
        return { s3000: show(3000), s3399: show(3399), s3400: show(3400), s3800: show(3800), props: data.elements[0].properties.map(p => p.name).join(',') };
    })()`);
    console.log(JSON.stringify(info, null, 1));
    await browser.close();
})();
