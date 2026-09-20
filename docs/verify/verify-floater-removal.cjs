// Verify the 去浮云 / 连通簇 apply path on the editor side.
//
// `floater.apply` carries one mask PER MODEL plus whether to delete, and the editor turns that
// into a single undoable MultiOp of [deselect, select mask, (delete)]. Three things this guards,
// all of which were broken at some point:
//   1. the mask is applied per model - the panel used to detect against the primary model and
//      then apply that one mask to every selected model, which mis-targets rows in the others;
//   2. "select only" selects the mask without deleting, so the detection can be reviewed first;
//   3. re-applying the same action while those rows are ALREADY selected still works. The ops
//      used to snapshot their index ranges when they were constructed, so the second press found
//      an empty range ("already selected" -> nothing to select) and the delete that follows an
//      empty selection removed nothing. Ranges are now resolved when each op runs, so every op
//      in the MultiOp sees the state left by the one before it.
//
// usage: node docs/verify/verify-floater-removal.cjs "<url>" [model]
const puppeteer = require('puppeteer-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// mask helpers: hit the first `count` gaussians of the model
const maskFor = (count) => ({ first: 0, count });

(async () => {
    const logs = [];
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
    });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });
        page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text().slice(0, 200)); });
        page.on('pageerror', e => logs.push('pageerror: ' + String(e).slice(0, 200)));
        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForFunction('!!window.scene', { timeout: 90000 });
        await sleep(1500);
        // import the model twice: two independent splat elements to prove per-model masks
        for (let i = 0; i < 2; i++) {
            await page.evaluate(async (model) => {
                const buf = await (await fetch('./' + model)).arrayBuffer();
                const name = `${model}`;
                await window.scene.events.invoke('import', [{ filename: name, contents: new File([buf], name) }]);
            }, MODEL);
            await sleep(2500);
        }
        await page.waitForFunction("window.scene.getElementsByType('splat').length >= 2", { timeout: 300000 });
        await sleep(2000);

        const backend = await page.evaluate(() => (window.scene.graphicsDevice.isWebGPU ? 'webgpu' : 'webgl2'));

        const state = (tag) => page.evaluate((t) => {
            const scene = window.scene;
            const splats = scene.getElementsByType('splat');
            const read = (splat) => {
                const st = splat.splatData.getProp('state');
                let sel = 0;
                let del = 0;
                let both = 0;
                for (let i = 0; i < st.length; i++) {
                    if (st[i] & 1) sel++;
                    if (st[i] & 4) del++;
                    if (st[i] === 5) both++;
                }
                return { name: splat.name, numSplats: splat.numSplats, selected: sel, deleted: del, selectedAndDeleted: both };
            };
            return { tag: t, models: splats.map(read) };
        }, tag);

        const apply = (plan) => page.evaluate(async (p) => {
            const scene = window.scene;
            const splats = scene.getElementsByType('splat');
            const targets = p.targets.map((entry) => {
                const splat = splats[entry.model];
                const mask = new Uint8Array(splat.splatData.numSplats);
                for (let i = entry.first; i < entry.first + entry.count; i++) mask[i] = 255;
                return { splat, mask };
            });
            scene.events.fire('floater.apply', { targets, remove: p.remove, count: p.count });
            await new Promise(r => setTimeout(r, 2500));
        }, plan);

        const before = await state('before');

        // 1) select only, with a DIFFERENT mask per model
        await apply({ targets: [{ model: 0, first: 0, count: 30 }, { model: 1, first: 0, count: 50 }], remove: false, count: 80 });
        const afterSelectPerModel = await state('after select-only with per-model masks');

        // 2) re-apply a selection over rows that are ALREADY selected (the "press twice" case),
        //    then delete: the delete has to act on the selection this same operation creates
        await apply({ targets: [{ model: 0, first: 0, count: 30 }], remove: false, count: 30 });
        const afterReSelect = await state('after re-selecting the same rows');
        await apply({ targets: [{ model: 0, first: 0, count: 30 }], remove: true, count: 30 });
        const afterRemove = await state('after removing the same rows');

        // 3) undo brings everything back
        await page.evaluate(() => window.scene.events.fire('edit.undo'));
        await sleep(2500);
        const afterUndo = await state('after one undo');

        const m0 = (s) => s.models[0];
        const m1 = (s) => s.models[1];

        const checks = [
            {
                name: 'per-model masks: each model gets its own count',
                pass: m0(afterSelectPerModel).selected === 30 && m1(afterSelectPerModel).selected === 50 && afterSelectPerModel.models.every(m => m.deleted === 0),
                detail: `model0 selected ${m0(afterSelectPerModel).selected} (expected 30), model1 selected ${m1(afterSelectPerModel).selected} (expected 50), deleted ${afterSelectPerModel.models.map(m => m.deleted).join('/')}`
            },
            {
                name: 'select-only selects without deleting',
                pass: afterSelectPerModel.models.every(m => m.deleted === 0),
                detail: `deleted ${afterSelectPerModel.models.map(m => m.deleted).join('/')}`
            },
            {
                name: 're-applying over already-selected rows still selects them',
                pass: m0(afterReSelect).selected === 30,
                detail: `selected ${m0(afterReSelect).selected} (expected 30; a construction-time range snapshot used to give 0 here)`
            },
            {
                name: 'the delete that follows acts on the selection the same call created',
                pass: m0(afterRemove).deleted === 30 && m0(afterRemove).numSplats === m0(before).numSplats - 30,
                detail: `deleted ${m0(afterRemove).deleted} (expected 30), live splats ${m0(before).numSplats} -> ${m0(afterRemove).numSplats}`
            },
            {
                name: 'the other model is untouched by a single-model action',
                pass: m1(afterRemove).deleted === 0 && m1(afterRemove).numSplats === m1(before).numSplats,
                detail: `model1 deleted ${m1(afterRemove).deleted}, live splats ${m1(afterRemove).numSplats}`
            },
            {
                name: 'one undo restores both models',
                pass: afterUndo.models.every((m, i) => m.deleted === before.models[i].deleted && m.numSplats === before.models[i].numSplats),
                detail: `deleted ${afterRemove.models.map(m => m.deleted).join('/')} -> ${afterUndo.models.map(m => m.deleted).join('/')}, live splats ${afterUndo.models.map(m => m.numSplats).join('/')}`
            },
            {
                name: 'no console errors',
                pass: logs.length === 0,
                detail: logs.length ? JSON.stringify(logs.slice(0, 3)) : 'clean'
            }
        ];

        console.log(JSON.stringify({
            backend,
            url: URL,
            before,
            afterSelectPerModel,
            afterReSelect,
            afterRemove,
            afterUndo,
            checks,
            failed: checks.filter(c => !c.pass).length,
            logs
        }, null, 2));
        if (checks.some(c => !c.pass)) process.exitCode = 1;
    } catch (e) {
        console.log(JSON.stringify({ fatal: String(e).slice(0, 400), logs }, null, 2));
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
