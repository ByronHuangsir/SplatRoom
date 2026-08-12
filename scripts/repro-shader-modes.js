// Shader-debug harness: at ortho+axis, toggle uDbgMode 0..3 and screenshot each.
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = 'http://localhost:3000/';
const OUT_DIR = 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/.workbuddy/debug-shots';
const fs = require('fs');
fs.mkdirSync(OUT_DIR, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--enable-webgl2', '--window-size=1440,900', '--hide-scrollbars']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 300)));

    const setMode = async (m) => {
        await page.evaluate(`(() => {
            const sc = window.scene;
            for (const e of sc.elements) {
                if (e.type === 'splat' && e.entity && e.entity.gsplat) {
                    const inst = e.entity.gsplat.instance;
                    if (inst.material) {
                        inst.material.setDefine('DEBUG_ORTHO_MODE', ${m});
                        inst.material.update();
                    }
                }
            }
        })()`);
    };
    const probeUniform = async () => {
        return page.evaluate(`(() => {
            const sc = window.scene;
            for (const e of sc.elements) {
                if (e.type === 'splat' && e.entity && e.entity.gsplat) {
                    const inst = e.entity.gsplat.instance;
                    const m = inst.material;
                    let chunkSrc = '';
                    try { chunkSrc = m.shaderChunks.glsl.get('gsplatVS') || ''; } catch (err) { chunkSrc = 'err:' + err; }
                    const defines = m._shaderDefines ? JSON.stringify(m._shaderDefines) : '(none)';
                    return { chunkHasDebug: chunkSrc.includes('DEBUG_ORTHO_MODE'), chunkLen: chunkSrc.length, defines };
                }
            }
            return null;
        })()`);
    };

    try {
        await page.goto(BASE + '?load=/test.ply&filename=test.ply', { waitUntil: 'networkidle0', timeout: 60000 });
        let loaded = false;
        for (let i = 0; i < 60; i++) {
            await sleep(500);
            loaded = await page.evaluate(`(() => { const sc = window.scene; if (!sc) return false; for (const e of sc.elements) if (e.type==='splat' && e.splatData) return true; return false; })()`);
            if (loaded) break;
        }
        console.log('loaded:', loaded);
        await sleep(1200);

        console.log('uniform probe:', JSON.stringify(await probeUniform()));
        console.log('step: probing done');

        // go to ortho axis px
        console.log('step: aligning px...');
        await page.evaluate(`window.scene.events.fire('camera.align', 'px')`);
        await sleep(1000);
        console.log('step: aligned px');

        for (const mode of [0, 1, 2, 3]) {
            console.log(`step: setting mode ${mode}...`);
            await setMode(mode);
            await sleep(600);
            console.log(`step: mode ${mode} set, screenshotting...`);
            await page.screenshot({ path: `${OUT_DIR}/dbg-px-mode${mode}.png` });
            console.log(`step: mode ${mode} done`);
        }

        console.log('step: switching to 45deg...');
        await page.evaluate(`(() => { window.scene.camera.setAzimElev(45, 20, 0); window.scene.camera.ortho = true; })()`);
        await sleep(800);
        for (const mode of [0, 1, 2, 3]) {
            console.log(`step: 45 mode ${mode}...`);
            await setMode(mode);
            await sleep(600);
            await page.screenshot({ path: `${OUT_DIR}/dbg-45-mode${mode}.png` });
        }
        await setMode(0);
        await sleep(400);
        console.log('ALL DONE');
    } catch (err) {
        console.log('HARNESS ERROR:', err);
    } finally {
        await browser.close();
    }
})();
