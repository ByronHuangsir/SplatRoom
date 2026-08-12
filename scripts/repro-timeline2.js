// Variant repro: tests whether crop-box (enabled) + orthographic aligned view
// + timeline-open + camera-keyframe-add blanks BOTH main view and PiP.
// The PiP writes crop-box uniforms onto the SHARED GSplat material, so a bad
// restore could clip the main view too.
const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = 'http://127.0.0.1:3002/';
const OUT_DIR = 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/.workbuddy/debug-shots';

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
server.listen(3002, '127.0.0.1', () => console.log('server up 3002'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SCENARIO = process.argv[2] || 'crop-ortho';

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
               '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1440,900']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const logs = [];
    page.on('console', m => logs.push('[' + m.type() + '] ' + m.text()));
    page.on('pageerror', e => logs.push('PAGEERROR: ' + String(e).slice(0, 400)));

    const dumpState = async (label) => {
        const s = await page.evaluate(`(() => {
            const sc = window.scene; if (!sc) return { err: 'no scene' };
            const cam = sc.camera;
            const ctrl = sc.events.invoke('animation.controller');
            const track = ctrl && ctrl.getTrack ? ctrl.getTrack('camera') : null;
            const anim = sc.animCameraEntity;
            const crop = sc.events.invoke('cropBox');
            let valAt0 = null; try { valAt0 = track && track.getValueAt ? track.getValueAt(0) : null; } catch(e){ valAt0='ERR:'+e.message; }
            const cp = sc.cameraPreview;
            // read shared material crop uniforms
            let matCrop = null;
            try {
                const splats = sc.getElementsByType('splat');
                const inst = splats[0] && (splats[0].entity.gsplat ? splats[0].entity.gsplat.instance : null);
                const mat = inst && inst.material;
                if (mat) {
                    matCrop = {
                        uCropBoxEnabled: mat.getParameters ? (mat.getParameters()['uCropBoxEnabled']): 'n/a',
                    };
                }
            } catch(e){ matCrop = 'ERR:'+e.message; }
            return {
                cameraViewMode: cam.cameraViewMode,
                poseOverride: !!cam.poseOverride,
                ortho: cam.ortho,
                panel: sc.events.invoke('statusBar.panel'),
                hasTrack: !!(track && track.keys && track.keys.length),
                animPos: anim ? [anim.getLocalPosition().x, anim.getLocalPosition().y, anim.getLocalPosition().z] : null,
                mainPos: (() => { const e = cam.camera.entity; const p = e.getLocalPosition(); return [p.x,p.y,p.z]; })(),
                valAt0: valAt0,
                pipEnabled: cp ? cp.enabled : null,
                pipHasTrack: cp ? cp.hasTrack : null,
                pipLastFrame: cp ? cp.lastFrame : null,
                cropEnabled: crop ? crop.enabled : null,
                cropVisible: crop ? crop.visible : null,
                matCrop
            };
        })()`);
        console.log(label + ':', JSON.stringify(s));
        return s;
    };

    const shotMain = async (name) => {
        const c = await page.$('canvas');
        if (c) { try { await c.screenshot({ path: OUT_DIR + '/' + name }); } catch(e){ console.log('shotMain err', e.message); } }
    };
    const pipInfo = async () => page.evaluate(`(() => {
        const cp = window.scene.cameraPreview; if (!cp) return {err:'no pip'};
        const c = document.querySelector('.camera-pip-canvas'); if (!c) return {err:'no pip canvas'};
        const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
        let n=0; for (let i=0;i<d.length;i+=4) if (d[i]>8||d[i+1]>8||d[i+2]>8) n++;
        return { nonBg: n, w: c.width, h: c.height };
    })()`);

    try {
        await page.goto(BASE + '?load=/test.ply&filename=test.ply', { waitUntil: 'networkidle0', timeout: 60000 });
        let loaded = false;
        for (let i = 0; i < 60; i++) { await sleep(500);
            loaded = await page.evaluate(`(() => { const sc = window.scene; if (!sc) return false; for (const e of sc.elements) if (e.type === 'splat' && e.splatData) return true; return false; })()`);
            if (loaded) break;
        }
        console.log('loaded:', loaded, 'scenario:', SCENARIO);
        await sleep(1000);

        // Scenario setup
        if (SCENARIO === 'crop-ortho' || SCENARIO === 'crop-only') {
            // initialize + enable crop box (clipping on, default box covers model)
            await page.evaluate(`(() => {
                window.scene.events.fire('cropBox.initialize');
            })()`);
            await sleep(300);
            await page.evaluate(`(() => {
                window.scene.events.fire('cropBox.setClipping', true);
                window.scene.events.fire('cropBox.setVisible', true);
            })()`);
            await sleep(300);
        }
        if (SCENARIO === 'crop-ortho' || SCENARIO === 'ortho-only') {
            await page.evaluate(`window.scene.events.fire('camera.align', 'px')`);
            await sleep(500);
        }

        await dumpState('SETUP');
        await shotMain('tl2-setup-main.png');
        const pipS = await pipInfo(); console.log('PIP setup:', JSON.stringify(pipS));

        // Expand timeline + add keyframe (the user action)
        await page.evaluate(`window.scene.events.fire('statusBar.panelChanged', 'timeline')`);
        await sleep(400);
        await page.evaluate(`window.scene.events.fire('track.addKey', { trackId: 'camera', frame: 0 })`);
        await sleep(900);

        await page.evaluate(`(() => { const cp = window.scene.cameraPreview; if (cp && cp.onPostRender) for (let i=0;i<40;i++){ try{cp.onPostRender();}catch(e){} } })()`);
        await sleep(600);

        await dumpState('AFTER_KEY');
        await shotMain('tl2-after-main.png');
        const pipA = await pipInfo(); console.log('PIP after:', JSON.stringify(pipA));
        await page.screenshot({ path: OUT_DIR + '/tl2-after-full.png' });

        console.log('=== errors ===');
        console.log(logs.filter(l => l.includes('PAGEERROR') || l.toLowerCase().includes('error')).join('\n').slice(0, 800) || '(none)');
    } catch (err) {
        console.log('ERR', err && err.message ? err.message : err);
    } finally {
        await browser.close();
        server.close();
    }
})();
