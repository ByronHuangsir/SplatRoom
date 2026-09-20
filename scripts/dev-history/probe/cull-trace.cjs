// Trace the ENTIRE sort chain in one render frame on the 4k model:
//   app.render() → culler.cullMeshInstances → drawCall.visible? _isVisible?
//   → instance.cameras.push → renderer.drawFrame → gsplatInstance.update()
//   → sorter.applyPendingSorted → instancingCount
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        headless: 'new',
        args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
               '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--enable-webgl2',
               '--window-size=1440,900', '--hide-scrollbars', '--disable-gpu-vsync']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
    await page.goto('http://localhost:3000/?load=/test-crop.ply', { waitUntil: 'networkidle2', timeout: 90000 });
    await sleep(5000);

    const trace = await page.evaluate(async () => {
        const sc = window.scene;
        const splat = sc.events.invoke('scene.splats')[0];
        const inst = splat.entity.gsplat.instance;
        const mi = inst.meshInstance;
        const log = [];

        // hook culler
        const culler = sc.app.renderer?.culler;
        if (culler) {
            const orig = culler.cullMeshInstances.bind(culler);
            culler.cullMeshInstances = (...args) => {
                const before = inst.cameras?.length ?? -1;
                const res = orig(...args);
                log.push({ ev: 'cull', before, after: inst.cameras?.length ?? -1 });
                return res;
            };
        }
        // hook update
        const origUpdate = inst.update.bind(inst);
        inst.update = () => {
            const before = inst.meshInstance.instancingCount;
            origUpdate();
            log.push({ ev: 'update', beforeCount: before, afterCount: inst.meshInstance.instancingCount, numSplats: inst.material.getParameter('numSplats')?.value });
        };
        // hook sorter setCamera
        const origSetCam = inst.sorter.setCamera.bind(inst.sorter);
        inst.sorter.setCamera = (p, d) => {
            log.push({ ev: 'setCamera', pos: [p.x, p.y, p.z] });
            return origSetCam(p, d);
        };

        // force a few renders
        for (let i = 0; i < 4; i++) {
            sc.forceRender = true;
            await new Promise((r) => setTimeout(r, 400));
        }

        // restore hooks
        if (culler) delete culler.cullMeshInstances;
        delete inst.update;
        delete inst.sorter.setCamera;

        return {
            log,
            mi: {
                visible: mi.visible,
                cull: mi.cull,
                aabbCenter: mi._aabb?.center ? [mi._aabb.center.x, mi._aabb.center.y, mi._aabb.center.z] : null,
                aabbHalf: mi._aabb?.halfExtents ? [mi._aabb.halfExtents.x, mi._aabb.halfExtents.y, mi._aabb.halfExtents.z] : null,
                layers: mi.layers
            },
            sorter: {
                pendingSorted: !!inst.sorter.pendingSorted,
                sortInFlight: inst.sorter._sortInFlight,
                orderDataLen: inst.sorter.orderData?.byteLength ?? -1
            },
            instancingCount: inst.meshInstance.instancingCount
        };
    });

    console.log(JSON.stringify({ trace, errs }, null, 2));
    await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });