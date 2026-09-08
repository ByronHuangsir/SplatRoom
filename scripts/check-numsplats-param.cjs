const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
               '--enable-webgl', '--enable-webgl2', '--window-size=800,600', '--disable-gpu-vsync']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600 });
    await page.goto('http://localhost:3000/?load=/test-crop.ply', { waitUntil: 'networkidle2', timeout: 90000 });
    await sleep(5000);
    for (let i = 0; i < 6; i++) { await page.evaluate(() => { window.scene.forceRender = true; }); await sleep(250); }
    const r = await page.evaluate(() => {
        const inst = window.scene.events.invoke('scene.splats')[0].entity.gsplat.instance;
        const p = inst.material.getParameter('numSplats');
        return {
            type: typeof p,
            ctor: p?.constructor?.name,
            hasValue: 'value' in (p ?? {}),
            value: p?.value ?? null,
            hasData: 'data' in (p ?? {}),
            data: Array.isArray(p?.data) ? p.data.slice(0, 4) : (typeof p?.data === 'number' ? p.data : 'n/a'),
            rawUniforms: Object.keys(inst.material.uniforms || {}).filter(k => k.includes('numSplat') || k.includes('Count'))
        };
    });
    console.log(JSON.stringify(r, null, 2));
    await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
