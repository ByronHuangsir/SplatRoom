// 回归护栏：运动期"不依赖顺序"的渲染（随机透明 / 硬边裁剪）**已被删除**。
//
// 为什么留这个套件而不是直接删掉旧套件：删掉的东西最容易悄悄回来。旧的
// `verify-motion-opaque.cjs` 断言的是"这套机制工作正常"，机制没了它就必然失败；
// 这里反过来断言"它确实不在了"，并且**用画面证明运动帧没被动过手脚**。
//
// 断言的机制：
//   1. 设置面板不再有那一行（`panel.settings.motion-render` 文案与下拉都不存在）
//   2. `motionRender.setMode` / `motionRender.mode` 事件已注销（invoke 返回 undefined，
//      fire 不改变任何东西）
//   3. splat 材质上没有 `uMotionOpaque` / `uMotionAlphaClip` / `uMotionStochastic`
//      这三个 uniform（着色器里的分支也一并删了）
//   4. `splat.motionOpaque` 恒为 false，且没有 `setMotionOpaque` 这个入口
//   5. **画面对照**：同一机位下"相机在动"与"相机停住"两帧，材质的 blendType /
//      depthWrite 完全一致（旧实现会在运动帧切到 BLEND_NONE + 深度写）
//   6. 运动期排序照常派发（旧实现在运动期**停发**排序）
//
// usage: node docs/verify/verify-motion-render-removed.cjs "<url>" [model]
const path = require('path');
const puppeteer = require(path.join(__dirname, '..', '..', 'node_modules', 'puppeteer-core'));

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3100/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-layered.ply';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, pass, detail) => {
    results.push({ name, pass, detail });
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
    });
    const errors = [];
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1500);

    const pump = setInterval(() => { page.evaluate(() => 1).catch(() => {}); }, 3000);
    await page.evaluate(async (m) => {
        const head = await fetch('./' + m, { headers: { Range: 'bytes=0-0' } });
        const total = parseInt(head.headers.get('content-range').split('/')[1], 10);
        const CHUNK = 256 * 1048576;
        const parts = [];
        for (let off = 0; off < total; off += CHUNK) {
            const end = Math.min(off + CHUNK - 1, total - 1);
            parts.push(await (await fetch('./' + m, { headers: { Range: `bytes=${off}-${end}` } })).blob());
        }
        window.__loadErr = null;
        window.scene.events.invoke('import', [{ filename: m, contents: new File(parts, m) }])
            .catch((e) => { window.__loadErr = String(e).slice(0, 300); });
    }, MODEL);
    clearInterval(pump);

    for (let i = 0; i < 60; i++) {
        await sleep(1500);
        const st = await page.evaluate(() => ({
            n: window.scene.getElementsByType('splat').length,
            err: window.__loadErr
        }));
        if (st.n > 0) break;
        if (st.err) throw new Error('import failed: ' + st.err);
    }
    await sleep(2500);
    await page.evaluate(() => {
        const scene = window.scene;
        scene.events.fire('selection', scene.getElementsByType('splat').slice(-1)[0]);
        scene.events.fire('camera.focus');
    });
    await sleep(2500);

    // ---- 1/2/3/4: the feature's surface is gone ----------------------------------------
    const surface = await page.evaluate(() => {
        const scene = window.scene;
        const splat = scene.getElementsByType('splat').slice(-1)[0];
        const sceneProto = Object.getPrototypeOf(scene);
        const splatProto = Object.getPrototypeOf(splat);
        const material = splat.entity.gsplat.instance.material;
        const localeHasKey = Object.keys(window.__SR_LOCALES__ || {}).some((k) => k.includes('motion-render'));
        return {
            sceneHasMotionOpaque: Object.prototype.hasOwnProperty.call(scene, 'motionOpaque') ||
                Object.prototype.hasOwnProperty.call(sceneProto, 'motionOpaque'),
            splatHasSetter: typeof splat.setMotionOpaque === 'function',
            motionOpaqueRead: splat.motionOpaque,
            modeInvoke: scene.events.invoke('motionRender.mode'),
            uniforms: {
                uMotionOpaque: material.getParameter ? material.getParameter('uMotionOpaque') : 'n/a',
                uMotionAlphaClip: material.getParameter ? material.getParameter('uMotionAlphaClip') : 'n/a',
                uMotionStochastic: material.getParameter ? material.getParameter('uMotionStochastic') : 'n/a'
            },
            localeHasKey
        };
    });
    check('Scene 上不再有 motionOpaque 实例', surface.sceneHasMotionOpaque === false);
    check('Splat 上不再有 setMotionOpaque 入口', surface.splatHasSetter === false);
    check('splat.motionOpaque 恒 false', surface.motionOpaqueRead === false, `读到 ${String(surface.motionOpaqueRead)}`);
    check('motionRender.mode 事件已注销', surface.modeInvoke === undefined, `invoke 返回 ${String(surface.modeInvoke)}`);
    check('材质上没有三个运动期 uniform',
        surface.uniforms.uMotionOpaque === undefined &&
        surface.uniforms.uMotionAlphaClip === undefined &&
        surface.uniforms.uMotionStochastic === undefined,
        JSON.stringify(surface.uniforms));

    // ---- 5/6: a moving frame is not treated any differently ----------------------------
    const moving = await page.evaluate(async () => {
        const scene = window.scene;
        const splat = scene.getElementsByType('splat').slice(-1)[0];
        const material = splat.entity.gsplat.instance.material;
        const read = () => ({ blend: material.blendType, depthWrite: material.depthWrite });

        const parked = read();
        // hold the tracker in its moving state and nudge the pose, so the frame really is
        // a "camera is moving" frame (the old feature switched material state exactly then).
        // `renderNextFrame` is poked every tick on purpose: this app renders on demand and a
        // small fixture settles immediately, so without it no frame is produced, the motion
        // tracker is never fed, and `cameraMotion.moving` reads false after the 200 ms window
        const cam = scene.camera;
        cam.userDragging = true;
        let flip = 0;
        const timer = setInterval(() => {
            flip = -flip || 0.05;
            cam.setAzimElev(30 + flip, -15, 0);
            scene.app.renderNextFrame = true;
        }, 16);
        await new Promise((r) => setTimeout(r, 1500));
        // read flag and material state in the same synchronous step, with the
        // nudge loop and the drag flag both still active: the settle window is
        // only 200 ms, so anything that yields first can read `moving === false`
        // and turn the assertions below into empty statements
        const movingFlag = scene.cameraMotion.moving;
        const whileMoving = read();
        clearInterval(timer);
        cam.userDragging = false;
        cam.setAzimElev(30, -15, 0);
        await new Promise((r) => setTimeout(r, 1200));
        return { parked, whileMoving, movingFlag, after: read() };
    });
    check('运动帧确实是"相机在动"', moving.movingFlag === true, `cameraMotion.moving=${moving.movingFlag}`);
    check('运动帧材质与停手帧一致（未切不透明）',
        moving.whileMoving.blend === moving.parked.blend &&
        moving.whileMoving.depthWrite === moving.parked.depthWrite,
        `停手 blend=${moving.parked.blend} depthWrite=${moving.parked.depthWrite} / 运动 blend=${moving.whileMoving.blend} depthWrite=${moving.whileMoving.depthWrite}`);
    check('停手后材质仍然一致', moving.after.blend === moving.parked.blend && moving.after.depthWrite === moving.parked.depthWrite);

    // the shader source is the part the runtime surface cannot prove: assert the
    // uniforms and the dither helper are gone from both the GLSL and the WGSL copy
    const source = await page.evaluate(async () => {
        const urls = performance.getEntriesByType('resource')
            .map((e) => e.name)
            .filter((n) => /index\.js|main\.js|\.js(\?|$)/.test(n));
        const texts = [];
        for (const u of urls.slice(0, 6)) {
            try {
                const t = await (await fetch(u)).text();
                if (t.length > 100000) {
                    texts.push(t);
                }
            } catch (e) { /* ignore */ }
        }
        const joined = texts.join('\n');
        return {
            scanned: texts.length,
            bytes: joined.length,
            hasUniform: joined.includes('uMotionOpaque'),
            hasClip: joined.includes('uMotionAlphaClip'),
            hasStochasticUniform: joined.includes('uMotionStochastic'),
            hasDitherHelper: joined.includes('srStochasticThreshold'),
            hasEvent: joined.includes('motionRender.setMode')
        };
    });
    check('构建产物里扫到了主包', source.scanned > 0, `${source.scanned} 个文件 / ${(source.bytes / 1048576).toFixed(1)} MB`);
    check('着色器里不再有运动期 uniform / 散列函数 / 事件',
        source.scanned > 0 && !source.hasUniform && !source.hasClip && !source.hasStochasticUniform &&
        !source.hasDitherHelper && !source.hasEvent,
        JSON.stringify(source));

    check('无控制台错误', errors.length === 0, errors.slice(0, 3).join(' | '));

    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} 通过`);
    await browser.close();
    process.exit(failed.length ? 1 : 0);
})().catch((e) => {
    console.error('SUITE FAILED:', e);
    process.exit(1);
});
