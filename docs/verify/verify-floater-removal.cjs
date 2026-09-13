// Verify the 去浮云 (floater removal) apply path really deletes.
//
// `floater.apply` builds a MultiOp of [deselect, select the floater mask, delete selection].
// DeleteSelectionOp captures "the splats selected right now" as its input, and it used to
// capture that when the op was CONSTRUCTED - i.e. while the selection was still empty - so
// pressing 移除浮云 selected the floaters and deleted nothing (the deletion only happened on a
// second press, when the floaters were already selected from the first). This harness drives the
// event directly with a known mask and checks the state bits, then checks that one undo restores
// everything.
//
// usage: node docs/verify/verify-floater-removal.cjs "<url>" [model]
const puppeteer = require('C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const MASK_COUNT = 50;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
        await page.evaluate(async (model) => {
            const buf = await (await fetch('./' + model)).arrayBuffer();
            await window.scene.events.invoke('import', [{ filename: model, contents: new File([buf], model) }]);
        }, MODEL);
        await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 300000 });
        await sleep(3000);

        const backend = await page.evaluate(() => (window.scene.graphicsDevice.isWebGPU ? 'webgpu' : 'webgl2'));

        const readState = (tag) => page.evaluate((t) => {
            const splat = window.scene.getElementsByType('splat')[0];
            const state = splat.splatData.getProp('state');
            let sel = 0;
            let del = 0;
            let deletedAndSelected = 0;
            for (let i = 0; i < state.length; i++) {
                if (state[i] & 1) sel++;
                if (state[i] & 4) del++;
                if (state[i] === 5) deletedAndSelected++;
            }
            return {
                tag: t,
                numSelected: splat.numSelected,
                numDeleted: splat.numDeleted,
                numSplats: splat.numSplats,
                rawSelectedBits: sel,
                rawDeletedBits: del,
                // state 5 = selected|deleted, which is what a deleted-but-still-selected splat
                // looks like (and what UndeleteSelectionOp looks for)
                selectedOnlyBits: sel - deletedAndSelected,
                deletedAndSelectedBits: deletedAndSelected
            };
        }, tag);

        const before = await readState('before');

        // drive the same event the panel's 移除浮云 button fires, with a known mask
        await page.evaluate((count) => {
            const splat = window.scene.getElementsByType('splat')[0];
            const n = splat.splatData.numSplats;
            const mask = new Uint8Array(n);
            for (let i = 0; i < Math.min(count, n); i++) mask[i] = 255;
            window.scene.events.fire('floater.apply', { mask, count });
        }, MASK_COUNT);
        await sleep(2500);
        const after = await readState('after floater.apply');

        // one undo must bring the deleted splats back
        await page.evaluate(() => window.scene.events.fire('edit.undo'));
        await sleep(2500);
        const afterUndo = await readState('after one undo');

        const checks = [
            {
                name: 'floater removal deletes the detected splats in one press',
                pass: after.rawDeletedBits === MASK_COUNT && after.numDeleted === MASK_COUNT,
                detail: `deleted bits ${before.rawDeletedBits} -> ${after.rawDeletedBits} (mask was ${MASK_COUNT}), live splats ${before.numSplats} -> ${after.numSplats}`
            },
            {
                name: 'the mask is marked deleted, not merely selected',
                pass: after.deletedAndSelectedBits === MASK_COUNT && after.selectedOnlyBits === 0,
                detail: `state bytes: ${after.deletedAndSelectedBits} splats at selected|deleted (5), ${after.selectedOnlyBits} left at selected only (1) - the selection-only outcome is the regression this guards`
            },
            {
                name: 'one undo restores the deleted splats',
                pass: afterUndo.rawDeletedBits === before.rawDeletedBits && afterUndo.numSplats === before.numSplats,
                detail: `deleted bits ${after.rawDeletedBits} -> ${afterUndo.rawDeletedBits}, live splats ${after.numSplats} -> ${afterUndo.numSplats}`
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
            after,
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
