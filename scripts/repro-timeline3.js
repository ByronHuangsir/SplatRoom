// Multi-phase repro: capture main-canvas file size + state at each step to
// pinpoint EXACTLY which action blanks the view (panel-open? keyframe-add?
// scrub? playback?). Tests crop+ortho state (user's likely context).
const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 3003;
const BASE = 'http://127.0.0.1:' + PORT + '/';
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
server.listen(PORT, '127.0.0.1', () => console.log('server up ' + PORT));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const MODE = process.argv[2] || 'crop-ortho';

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

    const dump = async (label) => {
        const s = await page.evaluate(`(() => {
            const sc = window.scene; if (!sc) return { err:'no scene' };
            const cam = sc.camera;
            const ctrl = sc.events.invoke('animation.controller');
            const track = ctrl && ctrl.getTrack ? ctrl.getTrack('camera') : null;
            const anim = sc.animCameraEntity;
            let val0=null,valF=null;
            try { val0 = track && track.getValueAt ? track.getValueAt(0) : null; } catch(e){ val0='ERR'; }
            const frame = sc.events.invoke('timeline.frame');
            try { valF = track && track.getValueAt ? track.getValueAt(frame) : null; } catch(e){ valF='ERR'; }
            const cp = sc.cameraPreview;
            return {
                camMode: cam.cameraViewMode, pose: !!cam.poseOverride, ortho: cam.ortho,
                panel: sc.events.invoke('statusBar.panel'),
                hasTrack: !!(track&&track.keys&&track.keys.length),
                animPos: anim?[+anim.getLocalPosition().x.toFixed(3),+anim.getLocalPosition().y.toFixed(3),+anim.getLocalPosition().z.toFixed(3)]:null,
                mainPos: (()=>{const e=cam.camera.entity;const p=e.getLocalPosition();return [+p.x.toFixed(3),+p.y.toFixed(3),+p.z.toFixed(3)];})(),
                frame, val0, valF,
                pipEn: cp?cp.enabled:null, pipLast: cp?cp.lastFrame:null
            };
        })()`);
        console.log(label, JSON.stringify(s));
        return s;
    };
    const shot = async (name) => {
        const c = await page.$('canvas');
        if (c) { try { await c.screenshot({ path: OUT_DIR + '/' + name }); } catch(e){} }
    };
    const pipInfo = async () => page.evaluate(`(() => {
        const cp = window.scene.cameraPreview; if (!cp) return {err:'no pip'};
        const c = document.querySelector('.camera-pip-canvas'); if (!c) return {err:'no canvas'};
        const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
        let n=0; for (let i=0;i<d.length;i+=4) if (d[i]>8||d[i+1]>8||d[i+2]>8) n++;
        return { nonBg:n, w:c.width, h:c.height };
    })()`);
    const fsz = (name) => { try { return fs.statSync(OUT_DIR + '/' + name).size; } catch(e){ return -1; } };

    try {
        await page.goto(BASE + '?load=/test.ply&filename=test.ply', { waitUntil: 'networkidle0', timeout: 60000 });
        let loaded=false;
        for (let i=0;i<60;i++){ await sleep(500);
            loaded = await page.evaluate(`(()=>{const sc=window.scene;if(!sc)return false;for(const e of sc.elements)if(e.type==='splat'&&e.splatData)return true;return false;})()`);
            if(loaded)break;
        }
        console.log('MODE', MODE, 'loaded', loaded);
        await sleep(1000);

        if (MODE === 'crop-ortho') {
            await page.evaluate(`window.scene.events.fire('cropBox.initialize')`); await sleep(300);
            await page.evaluate(`(()=>{window.scene.events.fire('cropBox.setClipping',true);window.scene.events.fire('cropBox.setVisible',true);})()`); await sleep(300);
            await page.evaluate(`window.scene.events.fire('camera.align','px')`); await sleep(500);
        } else if (MODE === 'persp') {
            // default perspective
        }

        await dump('PHASE0_initial');
        await shot('tl3-0-initial.png');
        console.log('  main size', fsz('tl3-0-initial.png'));

        // Step A: expand timeline panel
        await page.evaluate(`window.scene.events.fire('statusBar.panelChanged','timeline')`); await sleep(500);
        await dump('PHASE1_panelopen');
        await shot('tl3-1-panel.png');
        console.log('  main size', fsz('tl3-1-panel.png'), 'pip', JSON.stringify(await pipInfo()));

        // Step B: add keyframe at frame 0
        await page.evaluate(`window.scene.events.fire('track.addKey',{trackId:'camera',frame:0})`); await sleep(900);
        await page.evaluate(`(()=>{const cp=window.scene.cameraPreview;if(cp&&cp.onPostRender)for(let i=0;i<40;i++){try{cp.onPostRender();}catch(e){}}})()`);
        await sleep(500);
        await dump('PHASE2_key0');
        await shot('tl3-2-key0.png');
        console.log('  main size', fsz('tl3-2-key0.png'), 'pip', JSON.stringify(await pipInfo()));

        // Step C: scrub to frame 30 then add 2nd keyframe
        await page.evaluate(`window.scene.events.fire('timeline.setFrame',30)`); await sleep(400);
        await dump('PHASE3_scrub30');
        await shot('tl3-3-scrub30.png');
        console.log('  main size', fsz('tl3-3-scrub30.png'));
        await page.evaluate(`window.scene.events.fire('track.addKey',{trackId:'camera',frame:30})`); await sleep(700);
        await dump('PHASE4_key30');
        await shot('tl3-4-key30.png');
        console.log('  main size', fsz('tl3-4-key30.png'));

        // Step D: playback
        await page.evaluate(`window.scene.events.fire('timeline.setPlaying',true)`); await sleep(1500);
        await page.evaluate(`(()=>{const cp=window.scene.cameraPreview;if(cp&&cp.onPostRender)for(let i=0;i<40;i++){try{cp.onPostRender();}catch(e){}}})()`);
        await sleep(500);
        await dump('PHASE5_playing');
        await shot('tl3-5-playing.png');
        console.log('  main size', fsz('tl3-5-playing.png'), 'pip', JSON.stringify(await pipInfo()));

        console.log('=== errors ===');
        console.log(logs.filter(l=>l.includes('PAGEERROR')||l.toLowerCase().includes('error')).join('\n').slice(0,600)||'(none)');
    } catch (err) { console.log('ERR', err && err.message ? err.message : err); }
    finally { await browser.close(); server.close(); }
})();
