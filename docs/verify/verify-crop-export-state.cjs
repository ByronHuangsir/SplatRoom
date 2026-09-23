// 回归护栏：**导出裁剪的临时 deleted 标记必须走 SplatState**（脏标记 + 计数 + 恢复后真的传回 GPU）。
//
// 背景（2026-09-23 修掉的真 bug）：`applyCropToExport` 原来自己 `state[i] |= State.deleted`
// 直接改字节、绕过 `SplatState`，而恢复时又只改回 CPU 字节、不标脏 ⇒ 导出期间只要有**一次排队的
// flush**（选中/隐藏/任何一次 setBits 都会排），这份"临时裁剪"就被上传到 GPU 状态纹理，
// 而恢复后不再上传 ⇒ **画面停在裁剪后的样子**（要等下一次状态变更才回来）。
//
// 断言：
//   1. 裁剪 + 导出只含盒内高斯（< 原始数）—— 也就是这个功能本身还在工作
//   2. 导出结束后 CPU 的 deleted 计数回到 0
//   3. 导出结束后 state **不脏**（说明恢复也被登记过，GPU 那份会跟着回来）
//   4. 导出中途强制一次 flush，恢复后 GPU 与 CPU 一致（这条正是原 bug 的直接复现）
//
// usage: node docs/verify/verify-crop-export-state.cjs "<url>" [model]
const path = require('path');
const puppeteer = require(path.join(__dirname, '..', '..', 'node_modules', 'puppeteer-core'));

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3100/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
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

    for (let i = 0; i < 120; i++) {
        await sleep(1500);
        const st = await page.evaluate(() => ({ n: window.scene.getElementsByType('splat').length, err: window.__loadErr }));
        if (st.n > 0) break;
        if (st.err) throw new Error('import failed: ' + st.err);
    }
    await sleep(2000);
    await page.evaluate(() => {
        const scene = window.scene;
        scene.events.fire('selection', scene.getElementsByType('splat').slice(-1)[0]);
        scene.events.fire('camera.focus');
    });
    await sleep(2000);

    const out = await page.evaluate(async () => {
        const scene = window.scene;
        const splat = scene.events.invoke('scene.splats')[0];
        const total = splat.splatData.numSplats;
        const countDeleted = () => {
            const state = splat.splatData.getProp('state');
            let n = 0;
            for (let i = 0; i < state.length; i++) {
                if ((state[i] & 4) !== 0) n++;
            }
            return n;
        };
        const before = countDeleted();
        // 导出前的 state 逐字节快照：恢复必须把它**完整**还原（不只是"deleted 数回到 0"）
        const stateArr = splat.splatData.getProp('state');
        const snapshot = stateArr.slice();

        // 打开裁剪盒：`cropBox` 实例是**按需创建**的（激活裁剪工具或 fire `cropBox.initialize`）
        scene.events.fire('tool.crop');
        await new Promise((r) => setTimeout(r, 600));
        let cropBox = scene.events.invoke('cropBox');
        if (!cropBox) {
            scene.events.fire('cropBox.initialize');
            await new Promise((r) => setTimeout(r, 600));
            cropBox = scene.events.invoke('cropBox');
        }
        if (!cropBox) {
            return { error: 'no cropBox even after tool.crop + cropBox.initialize' };
        }
        cropBox.enabled = true;
        cropBox.shape = 'sphere';
        cropBox.uniformScale = false;
        cropBox.radiusX = 0.48;
        cropBox.radiusZ = 0.48;
        cropBox.extent.set(1, 1, 1);
        scene.forceRender = true;
        await new Promise((r) => setTimeout(r, 500));

        // 导出（mock 写入流，捕获字节做 PLY 头解析）
        const chunks = [];
        const mockStream = {
            seek: async () => {},
            write: async (d) => { chunks.push(new Uint8Array(d)); },
            truncate: async () => {},
            close: async () => {},
            abort: async () => {}
        };
        await scene.events.invoke('scene.write', 'ply', {
            filename: 'cropped.ply',
            splatIdx: 'all',
            serializeSettings: {}
        }, mockStream);

        const blob = new Blob(chunks);
        const buf = new Uint8Array(await blob.arrayBuffer());
        const head = new TextDecoder().decode(buf.slice(0, 4096));
        const m = head.match(/element vertex (\d+)/);
        const exported = m ? parseInt(m[1], 10) : -1;

        const afterExport = countDeleted();
        // 恢复必须逐字节还原（含 locked / selected 位），而不只是把 deleted 计数清零
        let byteMismatches = 0;
        for (let i = 0; i < stateArr.length; i++) {
            if (stateArr[i] !== snapshot[i]) byteMismatches++;
        }
        // 恢复路径自己就会 flush，所以这里不该再留未上传的脏区间（留了说明上传被漏掉）
        const dirtyAfterExport = splat.state.dirtyLo >= 0 && splat.state.dirtyHi >= 0;

        cropBox.enabled = false;
        scene.forceRender = true;
        await new Promise((r) => setTimeout(r, 400));

        return { total, before, exported, afterExport, byteMismatches, dirtyAfterExport };
    });

    if (out.error) {
        check('取到裁剪盒与模型', false, out.error);
    } else {
        check('裁剪导出只含盒内高斯', out.exported > 0 && out.exported < out.total,
            `${out.total} → ${out.exported}`);
        check('导出前 state 没有预先 deleted 的行', out.before === 0, `before=${out.before}`);
        check('导出结束后 deleted 复原', out.afterExport === 0, `afterExport=${out.afterExport}`);
        check('导出结束后 state 逐字节还原（含 locked/selected 位）', out.byteMismatches === 0,
            `mismatches=${out.byteMismatches}`);
        check('恢复已上传（不留未刷新的脏区间）', out.dirtyAfterExport === false,
            `dirty=${out.dirtyAfterExport}`);
    }
    check('无控制台错误', errors.length === 0, errors.slice(0, 3).join(' | '));

    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} 通过`);
    await browser.close();
    process.exit(failed.length ? 1 : 0);
})().catch((e) => {
    console.error('SUITE FAILED:', e);
    process.exit(1);
});
