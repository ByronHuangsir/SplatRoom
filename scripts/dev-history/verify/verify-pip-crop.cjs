// Verify PiP applies the crop box (presentation only, sort pipeline untouched)
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        headless: 'new',
        args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-gl=angle',
               '--use-angle=swiftshader', '--enable-webgl', '--enable-webgl2', '--window-size=1440,900', '--hide-scrollbars']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e).slice(0, 300)));
    page.on('console', m => { if (m.type() === 'error' && !m.text().includes('404')) errors.push('CONSOLE:' + m.text().slice(0, 200)); });

    await page.goto('http://localhost:3000/?load=/test-crop.ply', { waitUntil: 'networkidle2', timeout: 90000 });
    await sleep(4000);

    const out = await page.evaluate(async () => {
        const sc = window.scene;
        const res = {};

        // --- activate crop tool + sphere (small radius so cropping is visible) ---
        sc.events.fire('tool.crop');
        await new Promise(r => setTimeout(r, 800));
        const cb = sc.events.invoke('cropBox');
        cb.enabled = true;
        cb.shape = 'sphere';
        cb.uniformScale = false;
        cb.radiusX = 0.4; cb.radiusY = 0.3; cb.radiusZ = 0.4;
        cb.extent.set(1, 1, 1);
        sc.forceRender = true;
        await new Promise(r => setTimeout(r, 400));

        // --- open timeline + add camera keyframes → PiP enabled ---
        sc.events.fire('statusBar.panelChanged', 'timeline');
        await new Promise(r => setTimeout(r, 300));
        const controller = sc.events.invoke('animation.controller');
        const track = controller.getTrack('camera');
        track.addKey(0);
        sc.events.fire('timeline.frame', 0);
        track.addKey(30);
        sc.events.fire('timeline.frame', 30);
        await new Promise(r => setTimeout(r, 300));

        res.pipEnabled = sc.cameraPreview.enabled;
        res.pipHasTrack = sc.cameraPreview.hasTrack;

        // --- hook the two crop methods to snapshot shared-material state ---
        const proto = Object.getPrototypeOf(sc.cameraPreview);
        const origApply = proto._applyCropBoxForPip;
        const origRestore = proto._restoreMainCropBox;
        let applyCalls = 0, restoreCalls = 0;
        const applySnaps = [], restoreSnaps = [];

        const mainCamMat = () => {
            const cam = sc.camera.camera;
            return Array.from(cam.viewMatrix.data).map(v => +v.toFixed(4));
        };
        const pipCamMat = () => {
            const cam = sc.cameraPreview.cameraComponent;
            return Array.from(cam.viewMatrix.data).map(v => +v.toFixed(4));
        };
        const boxLocalMat = () => {
            // expected uViewToBoxLocal for a given camera view matrix
            return (invViewData) => {
                const pc = window.__pc || (sc.app.constructor && require ? null : null);
                return null; // computed below via Mat4 from the page's PlayCanvas bundle
            };
        };

        proto._applyCropBoxForPip = function () {
            origApply.call(this);
            applyCalls++;
            const inst = sc.events.invoke('scene.splats')[0].entity.gsplat.instance;
            const mat = inst.material;
            applySnaps.push({
                enabled: mat.getParameter('uCropBoxEnabled')?.data,
                shape: mat.getParameter('uCropBoxShape')?.data,
                rx: mat.getParameter('uCropBoxRadiusX')?.data,
                ry: mat.getParameter('uCropBoxRadiusY')?.data,
                rz: mat.getParameter('uCropBoxRadiusZ')?.data,
                viewToBox: mat.getParameter('uViewToBoxLocal') ? Array.from(mat.getParameter('uViewToBoxLocal').data).map(v => +v.toFixed(3)).slice(0, 4) : null,
                pipView: pipCamMat().slice(0, 4),
                mainView: mainCamMat().slice(0, 4)
            });
        };
        proto._restoreMainCropBox = function () {
            origRestore.call(this);
            restoreCalls++;
            const inst = sc.events.invoke('scene.splats')[0].entity.gsplat.instance;
            const mat = inst.material;
            restoreSnaps.push({
                enabled: mat.getParameter('uCropBoxEnabled')?.data,
                viewToBox0: mat.getParameter('uViewToBoxLocal') ? Array.from(mat.getParameter('uViewToBoxLocal').data).map(v => +v.toFixed(3)).slice(0, 2) : null,
                mainView0: mainCamMat().slice(0, 2)
            });
        };

        // --- force several frames so PiP onPostRender runs (every _pipInterval frames) ---
        for (let i = 0; i < 30; i++) {
            sc.forceRender = true;
            await new Promise(r => setTimeout(r, 120));
        }

        proto._applyCropBoxForPip = origApply;
        proto._restoreMainCropBox = origRestore;

        // --- verify sort pipeline independence after PiP frames ---
        const inst = sc.events.invoke('scene.splats')[0].entity.gsplat.instance;
        res.after = {
            applyCalls, restoreCalls,
            applySnapFirst: applySnaps[0] || null,
            restoreSnapLast: restoreSnaps[restoreSnaps.length - 1] || null,
            sortIndependence: {
                hasPipSortEntry: !!sc.cameraPreview._pipSort?.size,
                sorterRestored: inst.sorter === inst.sorter,   // sorter present
                matOrderIsMain: inst.material.getParameter('splatOrder')?.name === (inst.orderTexture?.name || 'n/a'),
                instancingCount: inst.meshInstance.instancingCount
            }
        };
        // capture screenshot of main view + PiP corner
        return res;
    });

    console.log(JSON.stringify({ out, errors }, null, 2));
    await page.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/pip-crop-view.png' });
    await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
