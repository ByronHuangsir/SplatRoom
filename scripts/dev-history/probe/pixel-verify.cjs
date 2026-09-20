// Pixel-level verification with the USER'S REAL 14M model.
// Load → wait for sort → capture pixel stats (color variance = blotch detection)
// → activate PiP (timeline + camera keyframes) → capture again → compare.
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        headless: 'new',
        args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
               '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--enable-webgl2',
               '--window-size=1440,900', '--hide-scrollbars', '--disable-gpu-vsync']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 400)));

    console.log('loading real model...');
    await page.goto('http://localhost:3000/?load=/test-scene.ply', { waitUntil: 'networkidle2', timeout: 180000 });
    await sleep(20000); // big model sort + warmup

    // pixel analysis helper (in-page): draw canvas to 2D, compute per-channel
    // variance + fraction of "flat/blank" pixels + mean saturation.
    const analyze = () => page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        if (!canvas) return { err: 'no canvas' };
        const w = Math.min(320, canvas.width), h = Math.min(180, canvas.height);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        ctx.drawImage(canvas, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        let meanR = 0, meanG = 0, meanB = 0;
        const n = w * h;
        for (let i = 0; i < n; i++) {
            meanR += data[i * 4]; meanG += data[i * 4 + 1]; meanB += data[i * 4 + 2];
        }
        meanR /= n; meanG /= n; meanB /= n;
        let varR = 0, varG = 0, varB = 0, satSum = 0, flat = 0, blank = 0;
        for (let i = 0; i < n; i++) {
            const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
            varR += (r - meanR) ** 2; varG += (g - meanG) ** 2; varB += (b - meanB) ** 2;
            const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
            satSum += mx === 0 ? 0 : (mx - mn) / mx;
            if (mx - mn < 8 && mx > 5) flat++;
            if (mx < 5) blank++;
        }
        return {
            n,
            meanR: meanR.toFixed(1), meanG: meanG.toFixed(1), meanB: meanB.toFixed(1),
            stdDev: Math.sqrt(varR / n).toFixed(1),
            stdG: Math.sqrt(varG / n).toFixed(1),
            stdB: Math.sqrt(varB / n).toFixed(1),
            meanSat: (satSum / n).toFixed(3),
            flatFrac: (flat / n * 100).toFixed(1),
            blankFrac: (blank / n * 100).toFixed(1)
        };
    });

    console.log('baseline pixel stats:');
    const base = await analyze();
    console.log(JSON.stringify(base));
    await page.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/pix-base.png' });

    // simulate user: open timeline + add camera keyframes → PiP active
    await page.evaluate(async () => {
        const sc = window.scene;
        sc.events.fire('statusBar.panelChanged', 'timeline');
        await new Promise((r) => setTimeout(r, 400));
        const ctrl = sc.events.invoke('animation.controller');
        const t = ctrl.getTrack('camera');
        t.addKey(0); sc.events.fire('timeline.frame', 0);
        t.addKey(30); sc.events.fire('timeline.frame', 30);
    });
    await sleep(5000); // let PiP run

    console.log('after PiP pixel stats:');
    const pip = await analyze();
    console.log(JSON.stringify(pip));
    await page.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/pix-pip.png' });

    console.log(JSON.stringify({ errs }));
    await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });