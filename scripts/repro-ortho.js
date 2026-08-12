// Headless reproduction harness for the "X/Y/Z ortho view model disappears" bug.
// Launches Edge headless with SwiftShader WebGL, loads SplatRoom with a test model,
// switches to ortho axis views, screenshots and dumps runtime state.
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
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--ignore-gpu-blocklist',
            '--enable-unsafe-swiftshader',
            '--use-gl=angle',
            '--use-angle=swiftshader',
            '--enable-webgl',
            '--enable-webgl2',
            '--window-size=1440,900',
            '--hide-scrollbars',
            '--disable-dev-shm-usage'
        ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    const consoleLogs = [];
    const pageErrors = [];
    page.on('console', (msg) => {
        const t = msg.type();
        if (t === 'error' || t === 'warning' || t === 'info' || t === 'log') {
            consoleLogs.push(`[${t}] ${msg.text()}`);
        }
    });
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    // state probe injected into the page
    const PROBE = `(() => {
        const sc = window.scene;
        if (!sc || !sc.camera) return null;
        const cam = sc.camera;
        const cc = cam.camera; // CameraComponent
        const c = cc.camera;   // Camera math instance
        const pos = cam.mainCamera.getLocalPosition();
        const fwd = cam.mainCamera.forward;
        const az = cam.azimElevTween ? cam.azimElevTween.value : null;
        const tgt = cam.azimElevTween ? cam.azimElevTween.target : null;
        // find first splat element
        let splat = null;
        for (const e of sc.elements) {
            if (e.type === 'splat') { splat = e; break; }
        }
        let splatInfo = null;
        const ginst = splat && splat.entity && splat.entity.gsplat ? splat.entity.gsplat.instance : null;
        if (ginst) {
            splatInfo = {
                instancingCount: ginst.meshInstance ? ginst.meshInstance.instancingCount : null,
                numSplatsParam: ginst.material ? ginst.material.getParameter('numSplats') : null,
                visible: ginst.meshInstance ? ginst.meshInstance.visible : null,
                aabb: ginst.meshInstance && ginst.meshInstance._aabb ? {
                    c: [+ginst.meshInstance._aabb.center.x.toFixed(3), +ginst.meshInstance._aabb.center.y.toFixed(3), +ginst.meshInstance._aabb.center.z.toFixed(3)],
                    he: [+ginst.meshInstance._aabb.halfExtents.x.toFixed(3), +ginst.meshInstance._aabb.halfExtents.y.toFixed(3), +ginst.meshInstance._aabb.halfExtents.z.toFixed(3)]
                } : null
            };
        }
        // camera_params scope value (as set last frame)
        let cameraParams = null;
        try {
            cameraParams = sc.app.graphicsDevice.scope.resolve('camera_params').getValue();
        } catch (e) { cameraParams = 'err:' + e; }
        let frustumCulled = null;
        try {
            const layer = sc.splatLayer;
            const ci = layer.getCulledInstances(c);
            frustumCulled = {
                opaque: ci.opaque.length,
                transparent: ci.transparent.length,
                all: (ci.opaque.length + ci.transparent.length)
            };
        } catch (e) { frustumCulled = 'err:' + e; }
        const numSplats = splat ? (splat.splatData ? splat.splatData.numSplats : null) : null;
        return {
            azim: az ? az.azim.toFixed(2) : null,
            elev: az ? az.elev.toFixed(2) : null,
            target: tgt ? { azim: tgt.azim.toFixed(2), elev: tgt.elev.toFixed(2) } : null,
            ortho: cam.ortho,
            orthoHeight: cc.orthoHeight,
            proj: cc.projection,
            near: cc.nearClip,
            far: cc.farClip,
            camPos: pos ? [+pos.x.toFixed(3), +pos.y.toFixed(3), +pos.z.toFixed(3)] : null,
            fwd: fwd ? [+fwd.x.toFixed(3), +fwd.y.toFixed(3), +fwd.z.toFixed(3)] : null,
            cameraParams: cameraParams ? Array.from(cameraParams).map(v => +v.toFixed(4)) : null,
            splatInfo,
            numSplats,
            frustumCulled,
            elements: sc.elements.length
        };
    })()`;

    const shot = async (name) => {
        await page.screenshot({ path: `${OUT_DIR}/${name}.png` });
    };

    try {
        console.log('navigating...');
        await page.goto(BASE + '?load=/test.ply&filename=test.ply', { waitUntil: 'networkidle0', timeout: 60000 });

        // wait for scene + splat loaded
        let loaded = false;
        for (let i = 0; i < 60; i++) {
            await sleep(500);
            const state = await page.evaluate(`(() => { const sc = window.scene; if (!sc) return {scene:false}; for (const e of sc.elements) { if (e.type==='splat' && e.splatData) return {scene:true, splat:true, n:e.splatData.numSplats}; } return {scene:true, splat:false}; })()`);
            if (state && state.splat) { loaded = true; console.log('model loaded:', JSON.stringify(state)); break; }
        }
        if (!loaded) {
            console.log('MODEL DID NOT LOAD — dumping console:');
            console.log(consoleLogs.slice(-40).join('\n'));
            await shot('00-load-failed');
            await browser.close();
            return;
        }

        // settle camera + sorter
        await sleep(1500);
        await shot('01-perspective-default');
        let s = await page.evaluate(PROBE);
        console.log('STATE default:', JSON.stringify(s, null, 1));

        // ---- TEST 1: ViewCube align px (ortho) ----
        console.log('--- align px (ortho) ---');
        await page.evaluate(`window.scene.events.fire('camera.align', 'px')`);
        await sleep(800);
        await shot('02-align-px-ortho');
        s = await page.evaluate(PROBE);
        console.log('STATE px:', JSON.stringify(s, null, 1));

        // ---- TEST 2: align py ----
        console.log('--- align py (ortho) ---');
        await page.evaluate(`window.scene.events.fire('camera.align', 'py')`);
        await sleep(800);
        await shot('03-align-py-ortho');
        s = await page.evaluate(PROBE);
        console.log('STATE py:', JSON.stringify(s, null, 1));

        // ---- TEST 3: align pz ----
        console.log('--- align pz (ortho) ---');
        await page.evaluate(`window.scene.events.fire('camera.align', 'pz')`);
        await sleep(800);
        await shot('04-align-pz-ortho');
        s = await page.evaluate(PROBE);
        console.log('STATE pz:', JSON.stringify(s, null, 1));

        // ---- TEST 4: same angle but PERSPECTIVE (setAzimElev then ortho=false) ----
        console.log('--- perspective axis view pz ---');
        await page.evaluate(`(() => { window.scene.camera.setAzimElev(0, 0, 0); window.scene.camera.ortho = false; })()`);
        await sleep(600);
        await shot('05-pz-perspective');
        s = await page.evaluate(PROBE);
        console.log('STATE pz-persp:', JSON.stringify(s, null, 1));

        // ---- TEST 5: ortho at NON-axis angle (azim=45) ----
        console.log('--- ortho at 45deg ---');
        await page.evaluate(`(() => { window.scene.camera.setAzimElev(45, 20, 0); window.scene.camera.ortho = true; })()`);
        await sleep(600);
        await shot('06-ortho-45deg');
        s = await page.evaluate(PROBE);
        console.log('STATE ortho45:', JSON.stringify(s, null, 1));

        // ---- TEST 6: toggle ortho OFF at axis angle (perspective at axis) ----
        console.log('--- perspective at axis (align then ortho off) ---');
        await page.evaluate(`(() => { window.scene.events.fire('camera.align', 'px'); window.scene.camera.ortho = false; })()`);
        await sleep(600);
        await shot('07-px-perspective');
        s = await page.evaluate(PROBE);
        console.log('STATE px-persp:', JSON.stringify(s, null, 1));

        // ---- TEST 7: epsilon-departure from axis (ortho) ----
        console.log('--- ortho at axis + epsilon (90.01, 0.01) ---');
        await page.evaluate(`(() => { window.scene.camera.setAzimElev(90.01, 0.01, 0); window.scene.camera.ortho = true; })()`);
        await sleep(600);
        await shot('08-ortho-px-eps');
        s = await page.evaluate(PROBE);
        console.log('STATE px+eps:', JSON.stringify(s, null, 1));

        // ---- TEST 8: exact axis again but read canvas pixels ----
        console.log('--- read canvas pixels at exact axis (px) ---');
        await page.evaluate(`window.scene.events.fire('camera.align', 'px')`);
        await sleep(800);
        const pixelProbe = await page.evaluate(`(() => {
            const canvas = document.querySelector('canvas');
            if (!canvas) return 'no canvas';
            // grab via 2D copy
            const off = document.createElement('canvas');
            off.width = canvas.clientWidth; off.height = canvas.clientHeight;
            const ctx = off.getContext('2d');
            ctx.drawImage(canvas, 0, 0, off.width, off.height);
            const w = off.width, h = off.height;
            const pts = [[w/2|0,h/2|0],[w/4|0,h/2|0],[3*w/4|0,h/2|0],[w/2|0,h/4|0]];
            const out = [];
            for (const [x,y] of pts) {
                const d = ctx.getImageData(x, y, 1, 1).data;
                out.push({x, y, rgba: [d[0],d[1],d[2],d[3]]});
            }
            return { size: [w,h], samples: out };
        })()`);
        console.log('PIXELS px-ortho:', JSON.stringify(pixelProbe));
        await shot('09-axis-pixels');

        console.log('=== page errors ===');
        console.log(pageErrors.length ? pageErrors.join('\n') : '(none)');
        console.log('=== recent console (last 60) ===');
        console.log(consoleLogs.slice(-60).join('\n'));
    } catch (err) {
        console.log('HARNESS ERROR:', err);
        console.log('console tail:', consoleLogs.slice(-30).join('\n'));
    } finally {
        await browser.close();
    }
})();
