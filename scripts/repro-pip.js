// Verify Symptom B (PiP "画面显示不正常" after adding timeline keyframes):
// open the timeline panel, add a camera keyframe, then capture the PiP canvas
// with the crop box both ACTIVE (the reported scenario) and DISABLED. The crop
// box is an editing aid for the main view; it must not clip the PiP preview.
//
// Without the fix: crop box active → uViewToBoxLocal was computed for the main
// camera but the shared splat material is reused for the PiP render → PiP
// fragments are clipped using the wrong transform → PiP shows a clipped view.
// With the fix: uCropBoxEnabled is forced to 0 during the PiP render and
// restored after → PiP shows the full model regardless of the main view.

const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = 'http://localhost:3000/';
const OUT_DIR = 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/.workbuddy/debug-shots';

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
               '--use-gl=angle', '--use-angle=swiftshader',
               '--window-size=1440,900']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const logs = [];
    page.on('console', m => logs.push('[' + m.type() + '] ' + m.text()));
    page.on('pageerror', e => logs.push('PAGEERROR: ' + String(e).slice(0, 300)));

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    try {
        await page.goto(BASE + '?load=/test.ply&filename=test.ply',
                        { waitUntil: 'networkidle0', timeout: 60000 });

        // Wait for model load
        let loaded = false;
        for (let i = 0; i < 60; i++) {
            await sleep(500);
            loaded = await page.evaluate(`(() => {
                const sc = window.scene; if (!sc) return false;
                for (const e of sc.elements) if (e.type === 'splat' && e.splatData) return true;
                return false;
            })()`);
            if (loaded) break;
        }
        console.log('loaded:', loaded);
        await sleep(1200);

        // Make sure we're in perspective so the keyframe snapshot has a
        // sensible camera pose, and zoom in a bit so the PiP actually shows
        // visible content.
        await page.evaluate(`(() => {
            const cam = window.scene.camera;
            if (cam.ortho) cam.ortho = false;
        })()`);
        await sleep(400);

        // Activate the crop tool → crop box enabled by default. THIS is the
        // scenario the user reported: the crop box was active and they then
        // added keyframes, after which the PiP showed abnormally.
        await page.evaluate(`window.scene.events.fire('tool.crop')`);
        await sleep(600);
        const cropEnabled = await page.evaluate(
            `window.scene.events.invoke('cropBox')?.enabled`);
        console.log('crop enabled:', cropEnabled);

        // Open the timeline panel (sets statusBar.panel = 'timeline')
        await page.evaluate(`window.scene.events.fire('statusBar.panelChanged', 'timeline')`);
        await sleep(300);

        // Add a camera keyframe at frame 0 — snapshots the current camera.
        // The 'track.addKey' handler is wired by track-manager.ts.
        await page.evaluate(`window.scene.events.fire('track.addKey', { trackId: 'camera', frame: 0 })`);
        await sleep(400);

        const state = await page.evaluate(`(() => {
            const sc = window.scene;
            const cp = sc.cameraPreview;
            const crop = sc.events.invoke('cropBox');
            const ctrl = sc.events.invoke('animation.controller');
            const track = ctrl?.getTrack('camera');
            return {
                panel: sc.events.invoke('statusBar.panel'),
                hasTrack: !!(track && track.keys && track.keys.length > 0),
                piplen: cp?.keys?.length,
                pipEnabled: cp?.enabled,
                pipHasTrack: cp?.hasTrack,
                cropEnabled: crop?.enabled,
                cropVisible: crop?.visible,
                timelineFrame: sc.events.invoke('timeline.frame')
            };
        })()`);
        console.log('state:', JSON.stringify(state));

        // Force several renders to give the PiP plenty of cycles (it throttles to
        // every 10 frames) and verify the post-render pipeline is executing.
        const pipDiag = await page.evaluate(`(() => {
            const cp = window.scene.cameraPreview;
            const counter = cp._pipUpdateCounter;
            const lastFrame = cp.lastFrame;
            const ce = cp.cameraEntity;
            const pos = ce ? [ce.getLocalPosition().x, ce.getLocalPosition().y, ce.getLocalPosition().z] : null;
            return { counter, lastFrame, pos, enabled: cp.enabled, hasTrack: cp.hasTrack };
        })()`);
        console.log('pip runtime:', JSON.stringify(pipDiag));

        // Diagnose captureToCanvas: trigger it and immediately read the canvas.
        const capDiag = await page.evaluate(`(() => {
            const cp = window.scene.cameraPreview;
            if (!cp || !cp.captureToCanvas) return { error: 'no captureToCanvas' };
            const before = (() => {
                const c = document.querySelector('.camera-pip-canvas');
                const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
                let n=0; for (let i=0;i<d.length;i+=4) if (d[i]>8||d[i+1]>8||d[i+2]>8) n++;
                return n;
            })();
            cp.captureToCanvas();
            const after = (() => {
                const c = document.querySelector('.camera-pip-canvas');
                const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
                let n=0; for (let i=0;i<d.length;i+=4) if (d[i]>8||d[i+1]>8||d[i+2]>8) n++;
                return n;
            })();
            const rt = cp.colorBuffer;
            const impl = rt?.impl?._glTexture ?? rt?._glTexture ?? null;
            return { before, after, hasGlTex: !!impl };
        })()`);
        console.log('captureToCanvas diag:', JSON.stringify(capDiag));

        // Headless browsers throttle RAF, so the editor's render loop barely
        // runs and the PiP's 10-frame throttle never fires — the canvas
        // never gets populated. Force the PiP pipeline by driving onPostRender
        // directly until the throttle lets the body through.
        const forceRes = await page.evaluate(`(() => {
            const cp = window.scene.cameraPreview;
            if (!cp || !cp.onPostRender) return { error: 'no onPostRender' };
            for (let i = 0; i < 40; i++) {
                try { cp.onPostRender(); } catch(e) { return { error: 'onPostRender throw: ' + e.message, i }; }
            }
            // count non-bg pixels after forced renders
            const c = document.querySelector('.camera-pip-canvas');
            const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
            let n=0; for (let i=0;i<d.length;i+=4) if (d[i]>8||d[i+1]>8||d[i+2]>8) n++;
            return { counter: cp._pipUpdateCounter, lastFrame: cp.lastFrame, nonBg: n };
        })()`);
        console.log('after forced renders (crop ACTIVE):', JSON.stringify(forceRes));
        const pipCanvas2 = await page.$('.camera-pip-canvas');
        if (pipCanvas2) await pipCanvas2.screenshot({ path: OUT_DIR + '/pip-canvas-with-crop.png' });
        await page.screenshot({ path: OUT_DIR + '/pip-with-crop.png' });

        // Now disable crop box, force renders again, capture for comparison.
        await page.evaluate(`(() => {
            const box = window.scene.events.invoke('cropBox');
            if (box) box.enabled = false;
        })()`);
        const forceRes2 = await page.evaluate(`(() => {
            const cp = window.scene.cameraPreview;
            for (let i = 0; i < 40; i++) { try { cp.onPostRender(); } catch(e) {} }
            const c = document.querySelector('.camera-pip-canvas');
            const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
            let n=0; for (let i=0;i<d.length;i+=4) if (d[i]>8||d[i+1]>8||d[i+2]>8) n++;
            return { counter: cp._pipUpdateCounter, lastFrame: cp.lastFrame, nonBg: n };
        })()`);
        console.log('after forced renders (crop DISABLED):', JSON.stringify(forceRes2));
        if (pipCanvas2) await pipCanvas2.screenshot({ path: OUT_DIR + '/pip-canvas-nocrop.png' });
        await page.screenshot({ path: OUT_DIR + '/pip-nocrop.png' });

        console.log('=== console errors ===');
        console.log(logs.filter(l => l.includes('PAGEERROR') || l.toLowerCase().includes('error')).join('\n').slice(0, 600) || '(none)');
    } catch (err) {
        console.log('ERR', err && err.message ? err.message : err);
    } finally {
        await browser.close();
    }
})();