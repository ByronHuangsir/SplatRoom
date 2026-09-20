// PLY 导出/re-导入的往返校验（A2 的硬约束是「输出字节不变」）。
//
// 为什么需要它：33 套批量里**没有任何一套碰过 `splat-serialize`** —— 导出是"先数一遍、再填一遍"，
// 两遍都用完整谓词（PLY 导出路径还强制 removeInvalid=true，于是每点都要遍历全部顶点属性）。
// A2 把前置那遍换成**廉价谓词定上界 + 完整谓词单遍填充**，并补了 `idx > bound` 的硬报错。
// 这里用 App 自己的公开流程做端到端往返，而不是只看条数：
//
//   import test-model → 框选出一个已知子集 → `edit.duplicate`
//   （内部就是 writeSplatFile(selected: true) → Blob → 重新 load 成新 splat）
//   → 断言：新 splat 的点数 == 选中数，且**逐行的 x/y/z 与源里被选中的那些行完全一致**
//
// 「完全一致」是关键：旧实现里两遍谓词一旦不一致，映射表尾部会留 0 ⇒ 每行都指向源的第 0 行 ⇒
// 行数照样对、内容全错。逐行比值才能抓住这种静默错误。
//
// usage: node docs/verify/verify-export-roundtrip.cjs [url]
const puppeteer = require('puppeteer-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'], protocolTimeout: 900000 });
    const errors = [];
    let out = null;
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        page.on('pageerror', e => errors.push('pageerror: ' + String(e).slice(0, 300)));
        page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });

        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForFunction('!!window.scene', { timeout: 60000 });
        await sleep(1500);

        await page.evaluate(async () => {
            const buf = await (await fetch('./test-model.ply')).arrayBuffer();
            await window.scene.events.invoke('import', [{ filename: 'test-model.ply', contents: new File([buf], 'test-model.ply') }]);
        });
        await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 60000, polling: 300 });
        await sleep(2500);

        const result = await page.evaluate(async () => {
            const sleep2 = (ms) => new Promise(r => setTimeout(r, ms));
            const scene = window.scene;
            const src = scene.getElementsByType('splat')[0];
            scene.events.fire('selection', src);
            await sleep2(600);
            scene.events.fire('camera.focus');
            await sleep2(3000);
            scene.events.fire('tool.rectSelection');
            await sleep2(500);
            scene.events.fire('selection.resetRange');
            await sleep2(300);

            // 框一个已知子集
            await scene.events.invoke('select.rect', 'set', { start: { x: 0.35, y: 0.35 }, end: { x: 0.65, y: 0.65 } });
            await sleep2(1000);

            const state = src.splatData.getProp('state');
            const sx = src.splatData.getProp('x');
            const sy = src.splatData.getProp('y');
            const sz = src.splatData.getProp('z');
            // 导出的过滤条件是 (state & deleted) === 0 && (state & selected) !== 0（bit 测试）
            const keep = [];
            for (let i = 0; i < state.length; i++) {
                if ((state[i] & 4) === 0 && (state[i] & 1) !== 0) keep.push(i);
            }

            // edit.duplicate = writeSplatFile(selected:true) → 重新 load 成新 splat
            const beforeNames = scene.getElementsByType('splat').map(s => s.name);
            scene.events.fire('edit.duplicate');
            // the handler is async and fire-and-forget, so poll for the new element
            for (let i = 0; i < 40; i++) {
                await sleep2(250);
                if (scene.getElementsByType('splat').length > beforeNames.length) break;
            }
            const splats = scene.getElementsByType('splat');
            const copy = splats[splats.length - 1];
            const madeNew = splats.length > beforeNames.length;
            const afterNames = splats.map(s => s.name);

            const dst = copy.splatData;
            const dx = dst.getProp('x');
            const dy = dst.getProp('y');
            const dz = dst.getProp('z');
            const n = dst.numSplats;

            // 逐行比对是**行序无关**的：重新 load 时 loader 会做一次空间(morton)重排，
            // 所以拿导出的第 k 行去对源里第 k 个选中行并不成立。这里把两边都按 (x,y,z) 排序后比。
            const rowsOf = (arrx, arry, arrz, indices) => {
                const rows = [];
                for (let k = 0; k < indices.length; k++) {
                    const i = indices[k];
                    rows.push([arrx[i], arry[i], arrz[i]]);
                }
                rows.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]));
                return rows;
            };
            const srcRows = rowsOf(sx, sy, sz, keep);
            const dstIdx = [];
            for (let k = 0; k < n; k++) dstIdx.push(k);
            const dstRows = rowsOf(dx, dy, dz, dstIdx);

            let mismatches = 0;
            let firstMismatch = null;
            const check = Math.min(n, srcRows.length);
            for (let k = 0; k < check; k++) {
                const a = srcRows[k];
                const b = dstRows[k];
                if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) {
                    mismatches++;
                    if (firstMismatch === null) {
                        firstMismatch = { sortedRow: k, src: a, dst: b };
                    }
                }
            }

            // 顺带确认没退化成"每行都是源第 0 行"
            let distinctFirstRows = 0;
            for (let k = 0; k < Math.min(n, 50); k++) {
                if (dx[k] !== sx[keep[0]] || dy[k] !== sy[keep[0]]) distinctFirstRows++;
            }

            // ④ 的事前提示：把"问用户的门槛"压到极低，再让查看器导出跑一次 ——
            // 应当弹一个 yes/no 确认，把预估体积与耗时说清楚；这里 stub 掉弹窗（返回 undefined，
            // 等价于用户没有点"继续"）⇒ 导出应当**安静地取消**（不是报错、也不是硬跑）。
            // 注意 `showPopup` 是 events.function（invoke 不触发 on 监听），真弹窗还会等用户点确定。
            const guard = await (async () => {
                const seen = [];
                const original = scene.events.functions.get('showPopup');
                scene.events.functions.set('showPopup', (opts) => { seen.push(opts); return undefined; });
                window.__SPLATROOM_EXPORT_MAX_GB__ = 0.0001;
                let threw = null;
                try {
                    await Promise.race([
                        scene.events.invoke('scene.write', 'htmlViewer', {
                            filename: 'output.html',
                            splatIdx: 'all',
                            serializeSettings: { maxSHBands: 3 },
                            viewerExportSettings: { type: 'html', background: '#000000' }
                        }),
                        sleep2(20000)
                    ]);
                } catch (e) {
                    threw = String(e).slice(0, 200);
                }
                scene.events.functions.set('showPopup', original);
                window.__SPLATROOM_EXPORT_MAX_GB__ = undefined;
                const last = seen.length ? seen[seen.length - 1] : null;
                const msg = last ? String(last.message || '') : '';
                return {
                    popups: seen.length,
                    type: last ? last.type : null,
                    message: msg.slice(0, 220),
                    threw,
                    asksForSize: /[0-9.]+ *GB/.test(msg) && /[0-9]+ *秒|秒|[0-9]+s\b/.test(msg)
                };
            })();

            return {
                srcNumSplats: src.splatData.numSplats,
                selectedRows: keep.length,
                madeNew,
                copyNumSplats: n,
                compared: check,
                mismatches,
                firstMismatch,
                distinctFirstRows,
                beforeNames,
                afterNames,
                guard
            };
        });

        const checks = [
            { name: '框选出了一个非空子集（不是全选也不是空）', pass: result.selectedRows > 0 && result.selectedRows < result.srcNumSplats, detail: `选中 ${result.selectedRows} / ${result.srcNumSplats}` },
            { name: 'edit.duplicate 导出了新的 splat', pass: result.madeNew, detail: '' },
            { name: '导出点数 == 选中点数', pass: result.copyNumSplats === result.selectedRows, detail: `导出 ${result.copyNumSplats} vs 选中 ${result.selectedRows}` },
            { name: '★ 导出的点集与源里被选中的点集完全一致（排序后逐点比 x/y/z，行序无关）', pass: result.mismatches === 0 && result.compared > 0, detail: `比对 ${result.compared} 个点，不一致 ${result.mismatches} 个` + (result.firstMismatch ? `，首个不一致 ${JSON.stringify(result.firstMismatch)}` : '') },
            { name: '★ 没有退化成"每行都是源第 0 行"（映射表尾部留 0 的旧故障形态）', pass: result.distinctFirstRows > 0, detail: `前 50 行里与源首行不同的有 ${result.distinctFirstRows} 行` },
            {
                name: '★ 大导出会先问一句（报出预估 GB 与秒数），用户不点继续就安静取消、不报错',
                pass: !!result.guard && result.guard.popups > 0 && result.guard.type === 'yesno' &&
                    result.guard.asksForSize === true && result.guard.threw === null,
                detail: JSON.stringify(result.guard)
            }
        ];

        out = { result, checks, failed: checks.filter(c => !c.pass).length, errors };
    } catch (err) {
        out = { fatal: String(err).slice(0, 600), errors, failed: 1 };
    } finally {
        await browser.close();
    }

    console.log(JSON.stringify(out, null, 2));
    if (out.failed > 0) process.exitCode = 1;
})();
