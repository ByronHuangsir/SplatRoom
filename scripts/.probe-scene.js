const puppeteer = require('puppeteer-core');
(async () => {
    const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'new', args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] });
    const page = await browser.newPage();
    page.on('console', m => console.log('P:', m.text()));
    await page.goto('http://localhost:3000/seg-lab/?model=scene.ply', { waitUntil: 'networkidle0', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3500));
    const info = await page.evaluate(`(() => {
        const near = (tx, ty, tz) => {
            let bi = -1, bd = Infinity;
            for (let i = 0; i < N; i++) {
                const d = (px[i]-tx)**2 + (py[i]-ty)**2 + (pz[i]-tz)**2;
                if (d < bd) { bd = d; bi = i; }
            }
            return { idx: bi, d: Math.sqrt(bd), pos: [px[bi], py[bi], pz[bi]].map(v=>+v.toFixed(3)) };
        };
        return {
            N,
            red: near(1.35, 0.25, 1.15),
            blue: near(-1.30, -0.15, 1.05),
            green: near(0.10, 1.35, 0.60),
            bbox: [Math.min(...px), Math.max(...px), Math.min(...py), Math.max(...py)]
        };
    })()`);
    console.log(JSON.stringify(info, null, 1));
    await browser.close();
})();
