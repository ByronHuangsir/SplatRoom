// 导入 worker 的回归：**worker 导入 vs 主线程导入必须产出逐字节相同的模型**，
// 而且"框选"这条历史上被 worker 破坏过的路径必须一致。
//
// 背景（HANDOFF 58）：导入 worker 曾在默认打开后被回滚 —— 同一次框选手势会选满整模
// （2000 点夹具实测 2000 vs 213，而**列字节完全相同**），于是"哪来的差异"一直没查清。
// 第十五轮把它改成"只传 `Blob`、worker 自己分块读 + 抽稀 + 物化 + morton 重排"，
// 这条套件就是重开它的验收线：
//   ① 列数据逐列哈希一致（含 morton 重排后的顺序）；
//   ② 包围盒一致 + **导入姿态一致且有限**（旋转必须是真 Quat：结构化克隆会丢原型，
//      `setLocalRotation(普通对象)` ⇒ 旋转矩阵全 NaN，第十六轮就是这条抓出来的）；
//   ③ **同一段框选手势**选中数与**逐点选择位**哈希一致（历史失败模式的正面回归）；
//   ④ 第 ③ 条在"没有 worker"的那次运行里也必须**只选中一部分**（否则判据本身没意义）；
//   ⑤ 抽稀预算在 worker 路径同样生效（与主线程同一个模块、同一组数字）。
//
// 两个"假绿"陷阱（都踩过）：
//   - `window.__SPLATROOM_ENABLE_LOAD_WORKER__` 是模块顶层常量，必须在
//     `evaluateOnNewDocument` 里设；goto 之后再设两次运行都会走 worker；
//   - 框选探针激活体工具后必须让模型**离原点**，体积才会拟合到模型上（见下方注释）。
//
// usage: node docs/verify/verify-import-worker.cjs "<url>" [model] [budget]
const path = require('path');
const puppeteer = require(path.join(__dirname, '..', '..', 'node_modules', 'puppeteer-core'));

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const BUDGET = Number(process.argv[4] || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 打开一个页面、按给定开关导入模型，并把"模型指纹 + 框选指纹"带回来 */
const runOne = async (browser, workerEnabled, boxOrNull = null) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 240)));

    // 开关必须在**第一次导入之前**设好（模块加载时读一次）。
    // 而且必须用 evaluateOnNewDocument —— `USE_LOAD_WORKER` 是模块顶层常量，
    // goto 之后再设 `window.__SPLATROOM_ENABLE_LOAD_WORKER__` 根本没人读，
    // 两次运行都会走 worker，套件就变成"worker 跟 worker 比"的假绿（第十六轮实测：
    // 基线那次 `__LW_WORKER_RESULTS__` 也是 1，正是这个原因）。
    await page.evaluateOnNewDocument((on, budget) => {
        window.__SPLATROOM_ENABLE_LOAD_WORKER__ = on;
        window.__LW_WORKER_RESULTS__ = 0;
        window.__LW_LAST_TRANSFORM__ = null;
        if (budget > 0) {
            window.__SPLATROOM_IMPORT_BUDGET__ = budget;
        }
    }, workerEnabled, BUDGET);
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1200);

    await page.evaluate(async (m) => {
        const buf = await (await fetch('./' + m)).arrayBuffer();
        window.__importErr = null;
        await window.scene.events.invoke('import', [{ filename: m, contents: new File([buf], m) }]).catch((e) => {
            window.__importErr = String(e).slice(0, 300);
        });
    }, MODEL);
    for (let i = 0; i < 90; i++) {
        await sleep(500);
        if (await page.evaluate(() => window.scene.getElementsByType('splat').length > 0)) break;
    }
    await sleep(3500);

    const fingerprint = await page.evaluate((budget) => {
        const scene = window.scene;
        const splat = scene.getElementsByType('splat').slice(-1)[0];
        if (!splat) {
            return { error: window.__importErr || 'no splat', workerResults: window.__LW_WORKER_RESULTS__ };
        }
        // 列哈希：FNV-1a over the raw bytes of every property column
        const hashBytes = (u8) => {
            let h = 0x811c9dc5;
            for (let i = 0; i < u8.length; i++) {
                h ^= u8[i];
                h = (h * 0x01000193) >>> 0;
            }
            return h >>> 0;
        };
        const element = splat.splatData.getElement('vertex');
        const cols = {};
        for (const prop of element.properties) {
            const storage = prop.storage;
            const u8 = new Uint8Array(storage.buffer, storage.byteOffset, storage.byteLength);
            cols[prop.name] = { hash: hashBytes(u8), len: storage.length, ctor: storage.constructor.name };
        }
        const bound = splat.localBound;
        const min = bound.getMin();
        const max = bound.getMax();
        // 导入姿态：worker 传回来的 `Transform` 是结构化克隆的普通对象，
        // 而 `setLocalRotation()` 用 `instanceof Quat` 分流 —— 漏了还原就会变成
        // (obj, NaN, NaN, NaN) 的旋转矩阵（模型不显示 / 体工具体积 NaN / 框选为空）。
        // 第十六轮就是这条被 vacuity 守卫抓出来的，所以这里把它钉住。
        const r = splat.entity.getLocalRotation();
        const s = splat.entity.getLocalScale();
        const w = splat.entity.getWorldTransform().data;
        const f = (v) => Number.isFinite(v) ? +v.toFixed(6) : String(v);
        return {
            numSplats: splat.numSplats,
            importReduction: splat.importReduction,
            colCount: element.properties.length,
            cols,
            bound: [min.x, min.y, min.z, max.x, max.y, max.z].map(v => +v.toFixed(6)),
            transform: {
                rotCtor: r && r.constructor && r.constructor.name,
                // 结构化克隆出来的普通对象**没有**原型方法：用这个判"是不是真类实例"
                // （打包后类名是压缩过的 `Le`，不能直接跟 'Quat' 比）
                rotMethods: typeof r.clone === 'function' && typeof r.equals === 'function',
                rotProto: Object.getPrototypeOf(r) === Object.prototype ? 'plain' : 'class',
                rot: [r.x, r.y, r.z, r.w].map(f),
                scale: [s.x, s.y, s.z].map(f),
                world: Array.from(w).map(f)
            },
            workerResults: window.__LW_WORKER_RESULTS__ || 0,
            // 第二十轮：巨型灰高斯的统计现在**由 worker 算**（`detectGiantGreyFromColumns`），
            // 主线程只在回退路径上自己扫。两条路的数字必须一致，`source` 必须各是 worker / main。
            giantReport: window.__GIANT_REPORT__ ?? null
        };
    }, BUDGET);

    // ---- 选择等价性（历史失败模式：worker 那次框选会选满整模）----
    //
    // 用**体工具栏**（`tool.boxSelection` + 工具栏的 "set" 按钮）而不是 `select.rect`：
    // 实测 `select.rect` 在无头环境里无论给什么框都会选满整模（归一化坐标、像素坐标、
    // set/add 都试过，main 与 worker 两次完全一样 ⇒ 是探针调用姿势的问题，不是 worker 的差异，
    // 见 _tmp/diag-select-rect.cjs）。体工具的默认体积是模型的 30%，**必然只选一部分**，
    // 因此它是"非空过"的选择等价性判据。
    //
    // 姿势（照抄 verify-shape-selection.cjs 的 movedModelCase）：**必须先把模型挪离原点**
    // 再激活工具，工具才会把体积拟合到模型上（30% 大小、中心取密度中位数）。模型留在原点时
    // 体积趴在原点且尺寸极小，"set" 会选出 0 个点 —— vacuity 守卫因此永远失败（本轮实测 0/2000）。
    await page.evaluate(() => {
        const scene = window.scene;
        scene.events.fire('selection', scene.getElementsByType('splat').slice(-1)[0]);
        scene.events.fire('camera.focus');
    });
    await sleep(1500);
    await page.evaluate(() => window.scene.events.fire('tool.deactivate'));
    await sleep(500);
    await page.evaluate(() => {
        window.scene.getElementsByType('splat').slice(-1)[0].entity.setPosition(8, 3, 0);
        window.scene.forceRender = true;
    });
    await sleep(900);
    await page.evaluate(() => window.scene.events.fire('select.none'));
    await sleep(500);
    await page.evaluate(() => window.scene.events.fire('tool.boxSelection'));
    await sleep(1500);
    await page.evaluate(() => {
        const bars = Array.from(document.querySelectorAll('.select-toolbar'));
        const toolbar = bars.find(t => !t.classList.contains('pcui-hidden'));
        const ops = toolbar ? Array.from(toolbar.querySelectorAll('.select-toolbar-op')) : [];
        if (ops.length) {
            ops[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        }
    });
    await sleep(3000);

    const selection = await page.evaluate(() => {
        const scene = window.scene;
        const splat = scene.getElementsByType('splat').slice(-1)[0];
        const state = splat.state.data;         // 逐点选择位（CPU 镜像）
        let selected = 0;
        let h = 0x811c9dc5;
        for (let i = 0; i < state.length; i++) {
            const v = state[i] & 1;
            if (v) selected++;
            h ^= v;
            h = (h * 0x01000193) >>> 0;          // FNV-1a（>>> 0 保持 32 位无符号）
        }
        const bars = Array.from(document.querySelectorAll('.select-toolbar'));
        return {
            selected,
            total: splat.numSplats,
            stateHash: h >>> 0,
            toolbarVisible: bars.some(t => !t.classList.contains('pcui-hidden'))
        };
    });

    // 模型放回原点，避免影响后面的指纹比对 / 下一次运行
    await page.evaluate(() => {
        const scene = window.scene;
        scene.getElementsByType('splat').slice(-1)[0].entity.setPosition(0, 0, 0);
        scene.events.fire('tool.deactivate');
    });
    await sleep(400);

    await page.close();
    return { fingerprint, selection, usedBox: 'tool.boxSelection', errors };
};

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
    });

    const checks = [];
    const check = (name, pass, detail) => checks.push({ name, pass, detail });

    // 同一台浏览器、同一个模型：先"没有 worker"（顺带挑出那个"只选一部分"的框），
    // 再用同一个框跑"有 worker"的那次 —— 两次必须给出完全一致的选择位。
    const off = await runOne(browser, false, null);
    const on = await runOne(browser, true, off.usedBox);

    const a = off.fingerprint;
    const b = on.fingerprint;

    check('both runs imported a model (baseline + worker)',
        !!a && !a.error && !!b && !b.error && a.numSplats > 0 && b.numSplats > 0,
        `main=${a.error ?? `${a.numSplats} 点`}；worker=${b.error ?? `${b.numSplats} 点`}`);

    check('the baseline really ran on the main thread and the second run really used the worker',
        a.workerResults === 0 && b.workerResults > 0,
        `main 那次 __LW_WORKER_RESULTS__=${a.workerResults}（必须是 0）；worker 那次=${b.workerResults}（必须 >0）` +
        ' —— 开关必须在 evaluateOnNewDocument 里设，模块顶层常量 goto 之后再设就没人读了');

    check('the worker import produces the same splat count',
        a.numSplats === b.numSplats,
        `main=${a.numSplats} worker=${b.numSplats}`);

    // `Transform` 过结构化克隆会丢掉原型（Quat/Vec3 → 普通对象），主线程必须还原成
    // 真类实例，否则 `setLocalRotation()` 走 `set(obj, undefined, undefined, undefined)`
    // ⇒ 旋转矩阵全 NaN。这条同时钉住"旋转/缩放/世界矩阵逐项一致且都有限"。
    const sameTransform = JSON.stringify(a.transform) === JSON.stringify(b.transform);
    const finiteTransform = b.transform.world.every(v => typeof v === 'number') &&
        b.transform.rot.every(v => typeof v === 'number') &&
        b.transform.scale.every(v => typeof v === 'number');
    check('the import transform survives the worker boundary (rotation is a real Quat, no NaN)',
        sameTransform && finiteTransform && b.transform.rotProto === 'class' && b.transform.rotMethods,
        `main   rot=${a.transform.rot.join(',')} scale=${a.transform.scale.join(',')} proto=${a.transform.rotProto}\n` +
        `         worker rot=${b.transform.rot.join(',')} scale=${b.transform.scale.join(',')} proto=${b.transform.rotProto}` +
        ` methods=${b.transform.rotMethods} ctor=${b.transform.rotCtor}`);

    const sameCols = a.colCount === b.colCount && Object.keys(a.cols).every(
        k => b.cols[k] && b.cols[k].hash === a.cols[k].hash && b.cols[k].len === a.cols[k].len
    );
    const firstDiff = Object.keys(a.cols).find(k => !b.cols[k] || b.cols[k].hash !== a.cols[k].hash);
    check('every data column is byte-identical after the worker round-trip (incl. morton order)',
        sameCols,
        sameCols
            ? `${a.colCount} 列逐列 FNV 哈希一致（含重排后的顺序）`
            : `第一处不同：${firstDiff}（main ${a.cols[firstDiff]?.hash} vs worker ${b.cols[firstDiff]?.hash}）`);

    check('the bounding box is identical',
        JSON.stringify(a.bound) === JSON.stringify(b.bound),
        `main=[${a.bound.join(', ')}]\n         worker=[${b.bound.join(', ')}]`);

    check('a selection gesture selects the same point set (the failure mode that got the worker rolled back)',
        off.selection.stateHash === on.selection.stateHash && off.selection.selected === on.selection.selected,
        `main 选中 ${off.selection.selected}/${off.selection.total}（位哈希 ${off.selection.stateHash}）；` +
        `worker 选中 ${on.selection.selected}/${on.selection.total}（位哈希 ${on.selection.stateHash}）`);

    check('the giant-grey scan gives identical numbers on both paths (worker-computed vs main-thread fallback)',
        !!a.giantReport && !!b.giantReport &&
        a.giantReport.source === 'main' && b.giantReport.source === 'worker' &&
        a.giantReport.total === b.giantReport.total &&
        a.giantReport.giantGrey === b.giantReport.giantGrey &&
        a.giantReport.removable === b.giantReport.removable &&
        Math.abs(a.giantReport.diag - b.giantReport.diag) < 1e-6,
        `main: ${JSON.stringify(a.giantReport)}；worker: ${JSON.stringify(b.giantReport)}` +
        '（第二十轮把这份统计搬进 worker，省掉 6000 万行那档约 1.2 s 的主线程阻塞）');

    check('that selection is a real partial selection (so the check above is not vacuous)',
        off.selection.selected > 0 && off.selection.selected < off.selection.total,
        `体工具默认体积（模型 30%）选中 ${off.selection.selected}/${off.selection.total}` +
        `（历史 bug 的表现是 worker 那次选满 ${off.selection.total}；工具栏可见=${off.selection.toolbarVisible}）`);

    if (BUDGET > 0) {
        check('the import budget is applied in the worker path too (same numbers as the main path)',
            !!a.importReduction && !!b.importReduction &&
            a.importReduction.to === b.importReduction.to && a.importReduction.from === b.importReduction.from,
            `main=${JSON.stringify(a.importReduction)} worker=${JSON.stringify(b.importReduction)}`);
    }

    check('no page errors in either run',
        off.errors.length === 0 && on.errors.length === 0,
        [...off.errors, ...on.errors].slice(0, 3).join(' | ') || 'none');

    console.log(JSON.stringify({
        url: URL, model: MODEL, budget: BUDGET || null,
        baseline: { numSplats: a.numSplats, selection: off.selection, workerResults: a.workerResults },
        worker: { numSplats: b.numSplats, selection: on.selection, workerResults: b.workerResults },
        checks, failed: checks.filter(c => !c.pass).length
    }, null, 1));

    await browser.close();
    process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ fatal: String(e && e.stack || e).slice(0, 600) })); process.exit(1); });
