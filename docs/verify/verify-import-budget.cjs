// 导入预算（模型分级 × 设备分级）的**行为**回归：`src/core/splat-tier.ts` + `src/io/read/strided-source.ts`。
//
// 为什么要有这一套：分级是纯函数（`verify-splat-tier.mts` 已逐条钉死），但"真的按预算抽稀了、
// 抽稀后还能画、预算之内一个点都不动"这三件事只有真跑一次导入才知道。
// 这里用标准小夹具（`test-model.ply`）+ `window.__SPLATROOM_IMPORT_BUDGET__` 覆盖，
// 所以**不需要大夹具、可以进批量**（1.35 亿点的真机实测在 `docs/probes/huge-model-open.cjs`）。
//
// 断言：
//   1. 强制预算 500 ⇒ 导入后 `numSplats === 500`（精确等距抽样，不是"差不多"）；
//   2. 抽稀信息真的报到 `splat.importReduction` 与 `import.reduced` 事件上（UI/探针都靠它）；
//   3. 抽稀后的点云**仍然画得出来**（litPercent > 0）；
//   4. 抽稀只减点、不挪场景：抽样集的包围盒落在全集包围盒之内（容差一个抽样步长）；
//   5. 预算之内（不设覆盖、模型是 A 档）**一个点都不动**：`numSplats` 与 `importReduction === null`；
//   6. 分级策略事件 `tier.policy` 会带着 A 档 + 今天的默认阶梯报到 scene 上；
//   7. 全程无 pageerror。
//
// usage: node docs/verify/verify-import-budget.cjs "<url>" [model]
const path = require('path');
const puppeteer = require(path.join(__dirname, '..', '..', 'node_modules', 'puppeteer-core'));

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const BUDGET = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
    });
    const errors = [];
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 240)));

    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(1500);

    const checks = [];
    const check = (name, pass, detail) => checks.push({ name, pass, detail });

    // hook：导入一个模型并等它落地
    await page.evaluate(() => {
        const scene = window.scene;
        const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
        window.__render = async (k = 3) => {
            for (let i = 0; i < k; i++) {
                scene.forceRender = true;
                await nextFrame();
            }
        };
        window.__tierEvents = [];
        scene.events.on('tier.policyChanged', (info) => window.__tierEvents.push({ type: 'tier.policyChanged', ...info }));
        window.__reducedEvents = [];
        scene.events.on('import.reduced', (info) => window.__reducedEvents.push({ type: 'import.reduced', ...info }));
        window.__lit = async () => {
            await window.__render(3);
            const src = scene.canvas;
            const off = document.createElement('canvas');
            off.width = Math.min(src.width, 640);
            off.height = Math.max(1, Math.round(src.height * (off.width / src.width)));
            const ctx = off.getContext('2d');
            ctx.drawImage(src, 0, 0, off.width, off.height);
            const d = ctx.getImageData(0, 0, off.width, off.height).data;
            let lit = 0;
            let n = 0;
            for (let i = 0; i < d.length; i += 4) {
                if (Math.max(d[i], d[i + 1], d[i + 2]) > 60) lit++;
                n++;
            }
            return +((lit / n) * 100).toFixed(1);
        };
        window.__sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        window.__import = async (m) => {
            const buf = await (await fetch('./' + m)).arrayBuffer();
            const before = scene.getElementsByType('splat').length;
            await scene.events.invoke('import', [{ filename: m, contents: new File([buf], m) }]);
            for (let i = 0; i < 60; i++) {
                await window.__sleep(250);
                if (scene.getElementsByType('splat').length > before) break;
            }
            await window.__sleep(1200);
            const splats = scene.getElementsByType('splat');
            const s = splats[splats.length - 1];
            const bounds = s.localBound;
            return {
                numSplats: s.numSplats,
                importReduction: s.importReduction,
                bounds: [bounds.getMin().x, bounds.getMin().y, bounds.getMin().z, bounds.getMax().x, bounds.getMax().y, bounds.getMax().z]
            };
        };
    });

    // ---- 相位 1：强制小预算 ----
    await page.evaluate((b) => {
        window.__SPLATROOM_IMPORT_BUDGET__ = b;
    }, BUDGET);
    const reduced = await page.evaluate((m) => window.__import(m), MODEL).catch((e) => ({ error: String(e).slice(0, 200) }));
    const reducedLit = await page.evaluate(() => window.__lit()).catch(() => -1);
    const reducedEvents = await page.evaluate(() => window.__reducedEvents);

    check(`forcing a ${BUDGET}-splat budget reduces the import to exactly ${BUDGET} splats`,
        reduced.numSplats === BUDGET,
        `numSplats=${reduced.numSplats}（原模型 ${reduced.importReduction ? reduced.importReduction.from : '?'} 点）`);

    check('the reduction is reported on the splat and via `import.reduced`',
        !!reduced.importReduction && reduced.importReduction.to === BUDGET &&
        reduced.importReduction.reason === 'forced-budget' &&
        reducedEvents.some(e => e.to === BUDGET && e.reason === 'forced-budget'),
        `splat.importReduction=${JSON.stringify(reduced.importReduction)} 事件=${JSON.stringify(reducedEvents.slice(-1)[0] ?? null)}`);

    check('the reduced model still renders (litPercent > 0)',
        reducedLit > 0,
        `litPercent=${reducedLit}%`);

    // ---- 相位 2：不设覆盖 ⇒ 一个点都不动 ----
    await page.evaluate(() => {
        delete window.__SPLATROOM_IMPORT_BUDGET__;
    });
    const full = await page.evaluate((m) => window.__import(m), MODEL).catch((e) => ({ error: String(e).slice(0, 200) }));
    const fullLit = await page.evaluate(() => window.__lit()).catch(() => -1);

    check('without a forced budget an A-tier model is imported untouched',
        !full.importReduction && full.numSplats > BUDGET,
        `numSplats=${full.numSplats} importReduction=${JSON.stringify(full.importReduction)}`);

    check('the untouched import also renders',
        fullLit > 0,
        `litPercent=${fullLit}%`);

    // ---- 相位 3：抽稀只减点、不挪场景 ----
    const b = reduced.bounds;
    const f = full.bounds;
    const inside = b && f &&
        b[0] >= f[0] - 1e-4 && b[1] >= f[1] - 1e-4 && b[2] >= f[2] - 1e-4 &&
        b[3] <= f[3] + 1e-4 && b[4] <= f[4] + 1e-4 && b[5] <= f[5] + 1e-4;
    const sizeFull = f ? Math.max(f[3] - f[0], f[4] - f[1], f[5] - f[2]) : 0;
    const sizeReduced = b ? Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]) : 0;
    check('the sampled cloud stays inside the full cloud\'s bounds (same scene, fewer points)',
        !!inside && sizeReduced > sizeFull * 0.5,
        `reduced=[${b.map(v => v.toFixed(3)).join(', ')}] full=[${f.map(v => v.toFixed(3)).join(', ')}] ` +
        `尺寸 ${sizeReduced.toFixed(3)} vs ${sizeFull.toFixed(3)}`);

    // ---- 相位 4：分级策略（查得到 + 变化时广播）----
    const tierInfo = await page.evaluate(() => window.scene.events.invoke('tier.policy'));
    const tierEvents = await page.evaluate(() => window.__tierEvents);
    const last = tierEvents.slice(-1)[0];
    check('the tier policy is queryable and reports tier A with today\'s defaults for a 2000-point scene',
        !!tierInfo && tierInfo.tier === 'A' && Array.isArray(tierInfo.policy?.motionLevels) &&
        tierInfo.policy.motionLevels.length === 1 && tierInfo.policy.motionLevels[0].renderScale === 0.7 &&
        tierInfo.policy.engageGpuMs === 60 && tierInfo.policy.lodAuto === false,
        tierInfo ? `numSplats=${tierInfo.numSplats} tier=${tierInfo.tier} device=${tierInfo.device} ` +
            `levels=${JSON.stringify(tierInfo.policy.motionLevels)} engage=${tierInfo.policy.engageGpuMs} lodAuto=${tierInfo.policy.lodAuto}` : 'tier.policy returned null');

    // ---- 相位 5：把设备档位强制成 low ⇒ 策略必须真的变化并广播 ----
    // （真机上没法复现低配电脑，用 `__SPLATROOM_DEVICE_CLASS__` 才能在一台机器上验证三档）
    const lowDevice = await page.evaluate(async () => {
        window.__tierEvents.length = 0;
        window.__SPLATROOM_DEVICE_CLASS__ = 'low';
        await window.__render(4);
        const info = window.scene.events.invoke('tier.policy');
        const mq = window.scene.motionQuality;
        return {
            info,
            applied: { levels: mq.levels.map(l => l.renderScale), engage: mq.engageGpuMs, budget: mq.budgetMs },
            events: window.__tierEvents.slice(0, 2)
        };
    });
    check('forcing the device class to `low` changes the applied policy and broadcasts `tier.policyChanged`',
        !!lowDevice.info && lowDevice.info.device === 'low' &&
        lowDevice.info.policy.motionLevels.length === 2 &&
        lowDevice.info.policy.engageGpuMs === 45 &&
        lowDevice.applied.levels.length === 2 && lowDevice.applied.engage === 45 &&
        lowDevice.events.some(e => e.type === 'tier.policyChanged' && e.device === 'low'),
        lowDevice.info ? `device=${lowDevice.info.device} levels=${JSON.stringify(lowDevice.info.policy.motionLevels.map(l => l.renderScale))} ` +
            `engage=${lowDevice.info.policy.engageGpuMs}（高配是 [0.7] / 60）；` +
            `已应用到 motionQuality: levels=${JSON.stringify(lowDevice.applied.levels)} engage=${lowDevice.applied.engage}；` +
            `事件=${lowDevice.events.map(e => `${e.type}:${e.device}`).join(', ') || 'none'}` : 'null');

    // 复原，免得影响后面的断言
    await page.evaluate(() => {
        delete window.__SPLATROOM_DEVICE_CLASS__;
        return window.__render(3);
    });

    check('no page errors during either import', errors.length === 0, errors.slice(0, 3).join(' | ') || 'none');

    console.log(JSON.stringify({ model: MODEL, url: URL, budget: BUDGET, checks, failed: checks.filter(c => !c.pass).length }, null, 1));
    await browser.close();
    process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ fatal: String(e).slice(0, 500) })); process.exit(1); });
