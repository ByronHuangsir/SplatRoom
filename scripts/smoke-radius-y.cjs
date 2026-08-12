// Verify sphere R3 (Y) radius: independent triaxial ellipsoid, uniform lock sync, shader compiles
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
        sc.events.fire('tool.crop');
        await new Promise(r => setTimeout(r, 800));
        const cb = sc.events.invoke('cropBox');
        if (!cb) return { err: 'no cropBox' };
        cb.enabled = true;
        cb.extent.set(1, 1, 1);

        const res = {};

        // --- sphere: three independent radii (triaxial ellipsoid) ---
        cb.shape = 'sphere';
        cb.uniformScale = false;
        cb.radiusX = 0.4;
        cb.radiusY = 0.25;
        cb.radiusZ = 0.3;
        res.sphereIndependent = {
            rx: cb.radiusX, ry: cb.radiusY, rz: cb.radiusZ,
            shaderRy: null // filled below from uniforms
        };

        // --- sphere + uniform lock: all three equal ---
        cb.uniformScale = true;
        cb.radiusY = 0.45;   // driving Y
        res.sphereUniformDrivenY = { rx: cb.radiusX, ry: cb.radiusY, rz: cb.radiusZ };
        cb.radiusX = 0.38;   // driving X
        res.sphereUniformDrivenX = { rx: cb.radiusX, ry: cb.radiusY, rz: cb.radiusZ };

        // --- cylinder: R3 (Y) NOT used; height independent ---
        cb.uniformScale = false;
        cb.shape = 'cylinder';
        cb.radiusY = 0.5;    // should NOT affect cylinder
        cb.radiusX = 0.32;
        cb.radiusZ = 0.28;
        cb.height = 0.7;
        res.cylinderUnaffectedByRy = { rx: cb.radiusX, ry: cb.radiusY, rz: cb.radiusZ, h: cb.height };

        // --- render frames (shader compile check with all shapes) ---
        const shapes = ['box', 'cylinder', 'sphere'];
        for (const s of shapes) {
            cb.shape = s;
            sc.forceRender = true;
            await new Promise(r => setTimeout(r, 250));
        }
        // final sphere state with distinct radii, force a few frames
        cb.shape = 'sphere';
        cb.uniformScale = false;
        cb.radiusX = 0.4; cb.radiusY = 0.22; cb.radiusZ = 0.3;
        for (let i = 0; i < 4; i++) { sc.forceRender = true; await new Promise(r => setTimeout(r, 200)); }

        // check shader uniform value (triaxial)
        const splat = sc.events.invoke('scene.splats')[0];
        const inst = splat.entity.gsplat.instance;
        const pY = inst.material.getParameter('uCropBoxRadiusY');
        res.sphereIndependent.shaderRy = pY?.data ?? null;

        // count splats inside (triaxial sphere should keep ~correct count)
        res.count = cb.countSplatsInside(sc.events.invoke('scene.splats'));

        // handles: sphere should have 3 (X/Y/Z radius handles)
        const sh = window.__shapeHandles;
        res.sphereHandleCount = sh ? sh.handles.length : 'n/a';

        return res;
    });

    console.log(JSON.stringify({ out, errors }, null, 2));
    await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
