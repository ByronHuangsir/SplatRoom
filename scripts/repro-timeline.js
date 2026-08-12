// Repro for: "timeline panel expanded + camera keyframe added -> model disappears
// in BOTH main view and PiP". Captures main canvas file size + PiP non-bg + full
// state dump (cameraViewMode, animCameraEntity transform, main camera transform,
// track pose) to pinpoint why the MAIN view blanks.
const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = 'http://127.0.0.1:3001/';
const OUT_DIR = 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/.workbuddy/debug-shots';

// In-process static server (same process = same network namespace as puppeteer)
const root = path.resolve(__dirname, '..', 'dist');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.json':'application/json', '.map':'application/json', '.ply':'application/octet-stream', '.wasm':'application/wasm', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' };
const server = http.createServer((req, res) => {
    let rel = req.url.split('?')[0];
    if (rel === '/' || rel === '') rel = 'index.html';
    const p = path.join(root, rel);
    fs.readFile(p, (e, d) => {
        if (e) { res.statusCode = 404; res.end('nf'); }
        else { res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream'); res.setHeader('Cache-Control', 'no-store'); res.end(d); }
    });
});
server.listen(3001, '127.0.0.1', () => console.log('in-process server up on 3001'));

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

    const dumpState = async (label) => {
        const s = await page.evaluate(`(() => {
            const sc = window.scene; if (!sc) return { err: 'no scene' };
            const cam = sc.camera;
            const ctrl = sc.events.invoke('animation.controller');
            const track = ctrl && ctrl.getTrack ? ctrl.getTrack('camera') : null;
            const anim = sc.animCameraEntity;
            let valAt0 = null, valAtLast = null;
            try { valAt0 = track && track.getValueAt ? track.getValueAt(0) : null; } catch(e){ valAt0 = 'ERR:'+e.message; }
            const cp = sc.cameraPreview;
            const out = {
                cameraViewMode: cam.cameraViewMode,
                poseOverride: !!cam.poseOverride,
                ortho: cam.ortho,
                timelineFrame: sc.events.invoke('timeline.frame'),
                hasTrack: !!(track && track.keys && track.keys.length),
                trackKeys: track ? track.keys : null,
                animPos: anim ? [anim.getLocalPosition().x, anim.getLocalPosition().y, anim.getLocalPosition().z] : null,
                animRot: anim ? (() => { const q = anim.getLocalRotation(); return [q.x,q.y,q.z,q.w]; })() : null,
                animFov: anim ? anim.camera.fov : null,
                mainPos: (() => { const e = cam.camera.entity; const p = e.getLocalPosition(); return [p.x,p.y,p.z]; })(),
                mainRot: (() => { const e = cam.camera.entity; const q = e.getLocalRotation(); return [q.x,q.y,q.z,q.w]; })(),
                valAt0: valAt0,
                pipEnabled: cp ? cp.enabled : null,
                pipHasTrack: cp ? cp.hasTrack : null,
                pipLastFrame: cp ? cp.lastFrame : null
            };
            return out;
        })()`);
        console.log(label + ':', JSON.stringify(s));
        return s;
    };

    try {
        await page.goto(BASE + '?load=/test.ply&filename=test.ply', { waitUntil: 'networkidle0', timeout: 60000 });
        let loaded = false;
        for (let i = 0; i < 60; i++) {
            await sleep(500);
            loaded = await page.evaluate(`(() => { const sc = window.scene; if (!sc) return false; for (const e of sc.elements) if (e.type === 'splat' && e.splatData) return true; return false; })()`);
            if (loaded) break;
        }
        console.log('loaded:', loaded);
        await sleep(1200);

        // --- baseline: main view before any keyframe ---
        const mainBefore = await page.$('canvas');
        if (mainBefore) await mainBefore.screenshot({ path: OUT_DIR + '/tl-main-before.png' });
        const stateBefore = await dumpState('BEFORE');

        // Expand timeline panel (the user action)
        await page.evaluate(`window.scene.events.fire('statusBar.panelChanged', 'timeline')`);
        await sleep(400);
        await dumpState('AFTER_PANEL');

        // Add a camera keyframe at frame 0 (snapshots current camera pose)
        await page.evaluate(`window.scene.events.fire('track.addKey', { trackId: 'camera', frame: 0 })`);
        await sleep(800);
        const stateAfter = await dumpState('AFTER_KEY');

        // Force several editor renders (headless throttles RAF) then capture
        await page.evaluate(`(() => { const cp = window.scene.cameraPreview; if (cp && cp.onPostRender) for (let i=0;i<40;i++){ try{cp.onPostRender();}catch(e){} } })()`);
        await sleep(600);

        // Main view screenshot (real compositor pixels)
        const mainAfter = await page.$('canvas');
        if (mainAfter) await mainAfter.screenshot({ path: OUT_DIR + '/tl-main-after.png' });

        // PiP non-bg
        const pip = await page.evaluate(`(() => {
            const cp = window.scene.cameraPreview; if (!cp) return {err:'no pip'};
            const c = document.querySelector('.camera-pip-canvas');
            if (!c) return {err:'no pip canvas'};
            const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
            let n=0; for (let i=0;i<d.length;i+=4) if (d[i]>8||d[i+1]>8||d[i+2]>8) n++;
            return { nonBg: n, w: c.width, h: c.height };
        })()`);
        console.log('PIP after key:', JSON.stringify(pip));
        const pipCanvas = await page.$('.camera-pip-canvas');
        if (pipCanvas) await pipCanvas.screenshot({ path: OUT_DIR + '/tl-pip-after.png' });

        await page.screenshot({ path: OUT_DIR + '/tl-full-after.png' });

        console.log('=== errors ===');
        console.log(logs.filter(l => l.includes('PAGEERROR') || l.toLowerCase().includes('error')).join('\n').slice(0, 600) || '(none)');
    } catch (err) {
        console.log('ERR', err && err.message ? err.message : err);
    } finally {
        await browser.close();
        server.close();
    }
})();
