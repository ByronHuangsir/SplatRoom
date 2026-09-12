const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
               '--enable-webgl', '--enable-webgl2', '--window-size=1280,720', '--disable-gpu-vsync']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e).slice(0, 200)));

    // Restore the 14M real model from recycle bin
    const fs = require('fs');
    const path = require('path');
    const RB = 'C:/$Recycle.Bin/S-1-5-21-3134951201-1836015697-2390204083-1001';
    const realModelPath = 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/dist/test-scene.ply';
    let recovered = false;
    if (!fs.existsSync(realModelPath)) {
        try {
            const files = fs.readdirSync(RB);
            for (const f of files) {
                if (!f.startsWith('$I')) continue;
                const idata = fs.readFileSync(path.join(RB, f));
                if (idata.length < 28) continue;
                const plen = idata.readUInt32LE(24);
                const p = idata.slice(28, 28 + plen).toString('utf16le');
                if (p.endsWith('test-scene.ply') || p.includes('MIPMAP')) {
                    const rname = '$R' + f.slice(2);
                    const rpath = path.join(RB, rname);
                    if (fs.existsSync(rpath)) {
                        fs.copyFileSync(rpath, realModelPath);
                        const sz = fs.statSync(realModelPath).size;
                        if (sz > 100000000) {
                            console.log('recovered real model:', sz, 'bytes');
                            recovered = true;
                        } else {
                            fs.unlinkSync(realModelPath);
                        }
                    }
                }
            }
        } catch (e) { console.log('recover err:', e.message); }
    }

    await page.goto('http://localhost:3000/?load=/test-scene.ply', { waitUntil: 'networkidle2', timeout: 300000 });
    await sleep(15000); // big model needs time to upload splat resources

    // Position camera at the angle the user reported
    const out = await page.evaluate(async () => {
        const sc = window.scene;
        sc.camera.setAzimElev(-30, 25, 0); // user-report-ish angle
        sc.camera.onUpdate(0);
        for (let i = 0; i < 8; i++) { sc.forceRender = true; await new Promise(r => setTimeout(r, 500)); }
        return {
            azim: sc.camera.azim, elev: sc.camera.elevation,
            instancingCount: window.scene.events.invoke('scene.splats')[0].entity.gsplat.instance.meshInstance.instancingCount
        };
    });

    await page.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/diagnose-rotate.png', timeout: 30000 }).catch(e => console.log('shot err:', e.message));

    // Open PiP (timeline panel) to compare
    await page.evaluate(() => { window.scene.events.fire('statusBar.panelChanged', 'timeline'); });
    await sleep(1000);
    // Find PiP and add a camera track so PiP activates
    await page.evaluate(async () => {
        const sc = window.scene;
        // Direct activation: trigger PiP
        const cpreviews = window.scene.elements?.filter?.(e => e.constructor?.name === 'CameraPreview') || [];
        return { cpreviewCount: cpreviews.length };
    });

    console.log(JSON.stringify({ out, errors, recovered }, null, 2));
    await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });