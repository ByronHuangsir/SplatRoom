// Verify crop-box + axis-aligned ortho no longer hides the model.
// Root cause: NaN corner.offset at exact axis-ortho views propagated into the
// crop-box varyings (vScreenOffset) → NaN cropFade in fragment → model gone.
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = 'http://localhost:3000/';
const OUT_DIR = 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/.workbuddy/debug-shots';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1440,900']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const logs = [];
    page.on('console', (m) => logs.push('[' + m.type() + '] ' + m.text()));
    page.on('pageerror', (e) => logs.push('PAGEERROR: ' + String(e).slice(0, 300)));
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

        // activate crop tool (creates crop box, enabled=true by default)
        await page.evaluate(`window.scene.events.fire('tool.crop')`);
        await sleep(800);
        const cropState = await page.evaluate(`(() => {
            const box = window.scene.events.invoke('cropBox');
            return box ? { exists: true, enabled: box.enabled, visible: box.visible, pos: box.pivot.getLocalPosition().data } : { exists: false };
        })()`);
        console.log('cropBox:', JSON.stringify(cropState));
        await sleep(500);

        // screenshot: crop box active, perspective view — model should be visible
        await page.screenshot({ path: OUT_DIR + '/crop-persp.png' });

        // switch to axis-aligned ortho (px) — the bug trigger
        await page.evaluate(`window.scene.events.fire('camera.align', 'px')`);
        await sleep(1000);
        const state = await page.evaluate(`(() => {
            const sc = window.scene;
            const cam = sc.camera;
            const cc = cam.camera;
            return { ortho: cam.ortho, proj: cc.projection, orthoHeight: cc.orthoHeight, near: cc.nearClip, far: cc.farClip };
        })()`);
        console.log('ortho state:', JSON.stringify(state));
        await page.screenshot({ path: OUT_DIR + '/crop-px-ortho.png' });

        // sanity: same view but crop disabled → should also render
        await page.evaluate(`(() => { const box = window.scene.events.invoke('cropBox'); if (box) box.enabled = false; })()`);
        await sleep(600);
        await page.screenshot({ path: OUT_DIR + '/crop-px-ortho-nocrop.png' });

        console.log('=== console (filtered) ===');
        console.log(logs.filter(l => l.includes('PAGEERROR') || l.toLowerCase().includes('error')).join('\n').slice(0, 600) || '(no errors)');
    } catch (err) {
        console.log('ERR', err);
    } finally {
        await browser.close();
    }
})();
