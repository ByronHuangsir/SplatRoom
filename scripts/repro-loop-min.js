const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = 'http://localhost:3000/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
    const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=800,600'] });
    const page = await browser.newPage();
    try {
        await page.goto(BASE + '?load=/test.ply&filename=test.ply', { waitUntil: 'networkidle0', timeout: 60000 });
        let loaded = false;
        for (let i = 0; i < 60; i++) { await sleep(500); loaded = await page.evaluate(`(() => { const sc = window.scene; if (!sc) return false; for (const e of sc.elements) if (e.type==='splat' && e.splatData) return true; return false; })()`); if (loaded) break; }
        console.log('loaded:', loaded);
        await sleep(1000);
        const r = await page.evaluate(`(() => {
            let cnt = 0;
            for (let i = 0; i < 4000; i++) { cnt++; }
            const arr = new Array(4000);
            for (let i = 0; i < arr.length; i++) { arr[i] = { shape: 0 }; }
            let cnt2 = 0;
            for (let i = 0; i < arr.length; i++) { cnt2++; }
            // 带内层 shadow 循环的 for（模拟 detectOutliers）
            let cnt3 = 0;
            for (let e = 0; e < 4000; e++) {
                cnt3++;
                let d = 0;
                for (let t = -1; t <= 1; t++) for (let e2 = -1; e2 <= 1; e2++) for (let n = -1; n <= 1; n++) { d++; }
            }
            return JSON.stringify({ plain: cnt, array: cnt2, nested: cnt3 });
        })()`);
        console.log('loop test:', r);
    } catch (err) { console.log('ERR', String(err).slice(0, 200)); }
    finally { await browser.close(); }
})();
