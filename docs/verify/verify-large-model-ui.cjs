// 大模型 UI 行为判定（用户 2026-09-20 报的 ①④⑤，2000 万点 / WebGPU 模式下形成）。
//
// 为什么单独一套：这三条都不是小夹具能暴露的（①是"WebGPU 下覆盖层不判删除位"，④⑤是
// "取景半径用了被远处噪声撑爆的 AABB"），而且需要真·大夹具，所以**不进批量**，按需跑。
//
// 判定：
//   ① 右侧"显示/隐藏 Splats"（= 点覆盖层）在 WebGPU 下不能再画已删除的点：
//      开覆盖层 → 量"屏幕发亮像素比例" → 删掉左半边的点 → 再量，必须明显下降。
//      （修复前：覆盖层画的是前 N 行、删除位无人过问，两次数值基本相同。）
//   ④ 框显所选：相机到密集中心的距离 / 取景半径 必须是个位数（修复前实测 ×54）；
//      同时记录 AABB 半径与密集半径的比值（本夹具应远大于 1，说明噪声点把 AABB 撑爆了）。
//   ⑤ 重置相机：相机必须在焦点上方（y 更大），仰角 = -15°，且取景距离同样是个位数。
//
// usage: node docs/verify/verify-large-model-ui.cjs [url] [model]
const puppeteer = require('puppeteer-core');
const { decodePng } = require('./lib/png.cjs');

const { BROWSER_PATH: EDGE , launchPatched: _launchPatched } = require('./lib/browser.cjs');
const URL = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'merged-scene.ply';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 画布区域的"亮像素比例"：点覆盖层/高斯画得越多，这个数越大
const litStats = async (page) => {
    const rect = await page.evaluate(() => {
        const c = document.querySelector('canvas').getBoundingClientRect();
        return { x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.width), h: Math.round(c.height) };
    });
    const png = await page.screenshot({
        type: 'png',
        clip: {
            x: Math.round(rect.x + rect.w * 0.25),
            y: Math.round(rect.y + rect.h * 0.2),
            width: Math.round(rect.w * 0.5),
            height: Math.round(rect.h * 0.6)
        }
    });
    const img = decodePng(Buffer.from(png));
    let lit = 0;
    const n = img.width * img.height;
    for (let i = 0; i < img.data.length; i += img.channels) {
        if (Math.max(img.data[i], img.data[i + 1], img.data[i + 2]) > 60) lit++;
    }
    return +((lit / n) * 100).toFixed(2);
};

(async () => {
    const browser = await _launchPatched(puppeteer, {
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 3600000
    });
    const errors = [];
    let out = null;
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        page.on('pageerror', e => errors.push('pageerror: ' + String(e).slice(0, 250)));
        page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });

        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
        await sleep(1500);

        // 大文件（>2GB）走 Range 分块拼 File；小文件直接 fetch
        await page.evaluate(async (m) => {
            const head = await fetch('./' + m, { method: 'HEAD' });
            const size = parseInt(head.headers.get('content-length') || '0', 10);
            if (size > 1.5e9) {
                const total = size;
                const CHUNK = 256 * 1048576;
                const parts = [];
                for (let off = 0; off < total; off += CHUNK) {
                    const end = Math.min(off + CHUNK - 1, total - 1);
                    parts.push(await (await fetch('./' + m, { headers: { Range: `bytes=${off}-${end}` } })).blob());
                }
                window.__file = new File(parts, m);
            } else {
                const buf = await (await fetch('./' + m)).arrayBuffer();
                window.__file = new File([buf], m);
            }
            window.__loadErr = null;
            window.scene.events.invoke('import', [{ filename: m, contents: window.__file }])
                .catch((e) => { window.__loadErr = String(e).slice(0, 200); });
        }, MODEL);

        for (let i = 0; i < 90; i++) {
            await sleep(5000);
            const st = await page.evaluate(() => ({
                n: window.scene.getElementsByType('splat').length,
                splats: window.scene.getElementsByType('splat').map(s => s.splatData ? s.splatData.numSplats : 0),
                err: window.__loadErr
            }));
            if (st.n > 0 && st.splats[0] > 0) break;
            if (st.err) throw new Error('import error: ' + st.err);
        }
        await sleep(8000);

        const info = await page.evaluate(() => {
            const scene = window.scene;
            const splat = scene.getElementsByType('splat').slice(-1)[0];
            scene.events.fire('selection', splat);
            return { numSplats: splat.splatData.numSplats, rows: splat.splatData.numSplats };
        });

        // ---- ① 覆盖层必须跳过已删除的点 ----
        await page.evaluate(async () => {
            const scene = window.scene;
            scene.events.fire('camera.setMode', 'centers');
            scene.events.fire('camera.setOverlay', true);
            scene.events.fire('camera.setSplatSize', 3);
            scene.events.fire('camera.focus');
            await new Promise(r => setTimeout(r, 4000));
        });
        await sleep(2000);
        const litBefore = await litStats(page);

        const deleted = await page.evaluate(async () => {
            const sleep2 = (ms) => new Promise(r => setTimeout(r, ms));
            const scene = window.scene;
            // 删掉左半边（覆盖层若照画全部行，亮像素比例就不会降）
            await scene.events.invoke('select.rect', 'set', { start: { x: 0, y: 0 }, end: { x: 0.5, y: 1 } });
            await sleep2(3000);
            const splat = scene.getElementsByType('splat').slice(-1)[0];
            const state = splat.splatData.getProp('state');
            let sel = 0;
            for (let i = 0; i < state.length; i++) if ((state[i] & 1) !== 0) sel++;
            scene.events.fire('select.delete');
            await sleep2(6000);
            let del = 0;
            for (let i = 0; i < state.length; i++) if ((state[i] & 4) !== 0) del++;
            // 覆盖层的绘制数量（WebGPU 下应当 = 全部行数，由着色器过滤删除位）。
            // 生产构建里类名会被压缩，所以按实体名找（SplatOverlay 的 entity 名固定是 splatOverlay）。
            const overlay = scene.elements.find(e => e.entity && e.entity.name === 'splatOverlay');
            return {
                selected: sel,
                deleted: del,
                deletedPct: +(100 * del / splat.splatData.numSplats).toFixed(1),
                overlayDraw: overlay ? overlay.drawPoints : null,
                totalRows: splat.splatData.numSplats,
                visible: splat.numSplats
            };
        });
        await sleep(3000);
        const litAfter = await litStats(page);

        // 恢复现场（撤销删除）
        await page.evaluate(async () => {
            window.scene.events.fire('edit.undelete');
            await new Promise(r => setTimeout(r, 4000));
        });

        // ---- ④ 框显所选 / ⑤ 重置相机 的取景 ----
        const framing = await page.evaluate(async () => {
            const sleep2 = (ms) => new Promise(r => setTimeout(r, ms));
            const scene = window.scene;
            const cam = scene.camera;
            const splat = scene.getElementsByType('splat').slice(-1)[0];
            const dense = splat.focalPoint();
            const denseArr = [dense.x, dense.y, dense.z];
            const pos = () => { const p = cam.mainCamera.getPosition(); return [p.x, p.y, p.z]; };
            const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

            const framingRadius = splat.framingRadius();
            const aabbRadius = splat.worldBound.halfExtents.length();

            scene.events.fire('camera.focus');
            await sleep2(4000);
            const afterFocus = {
                distToDense: +dist(pos(), denseArr).toFixed(2),
                ratio: +(dist(pos(), denseArr) / framingRadius).toFixed(2),
                cameraY: +pos()[1].toFixed(2),
                denseY: +denseArr[1].toFixed(2)
            };

            scene.events.fire('camera.reset');
            await sleep2(4000);
            const p = pos();
            const afterReset = {
                distToDense: +dist(p, denseArr).toFixed(2),
                ratio: +(dist(p, denseArr) / framingRadius).toFixed(2),
                cameraY: +p[1].toFixed(2),
                denseY: +denseArr[1].toFixed(2),
                above: p[1] > denseArr[1],
                elevation: +(cam.elevation ?? 0).toFixed(1),
                azimuth: +(cam.azim ?? 0).toFixed(1)
            };

            return { framingRadius: +framingRadius.toFixed(3), aabbRadius: +aabbRadius.toFixed(1), denseRadius: +splat.denseRadius().toFixed(3), afterFocus, afterReset };
        });

        const checks = [
            {
                name: '① 覆盖层开着时，删掉一半点后屏幕亮像素明显减少（= 已删除的点不再被画）',
                pass: deleted.deletedPct > 20 && litAfter < litBefore * 0.8,
                detail: `删了 ${deleted.deletedPct}% 的点；亮像素 ${litBefore}% → ${litAfter}%`
            },
            {
                name: '①（状态级）WebGPU 下覆盖层画全部行（删除位交给着色器判），且不等于"可见行数"',
                pass: deleted.overlayDraw === deleted.totalRows,
                detail: `overlayDraw=${deleted.overlayDraw}、全部行=${deleted.totalRows}、可见行=${deleted.visible}`
            },
            {
                name: '④ 框显所选：相机到密集中心的距离 / 取景半径 是个位数（修复前实测 ×54）',
                pass: framing.afterFocus.ratio < 3,
                detail: JSON.stringify(framing.afterFocus)
            },
            {
                name: '⑤ 重置相机：相机在焦点上方、仰角 -15°、距离/半径 是个位数',
                pass: framing.afterReset.above === true && Math.abs(framing.afterReset.elevation + 15) < 3 && framing.afterReset.ratio < 3,
                detail: JSON.stringify(framing.afterReset)
            },
            {
                name: '夹具确实是"噪声把 AABB 撑爆"的那一类（AABB 半径 ≥ 取景半径 ×5），否则 ④⑤ 的判据没有说服力',
                pass: framing.aabbRadius >= framing.framingRadius * 5,
                detail: `AABB 半径 ${framing.aabbRadius} vs 取景半径 ${framing.framingRadius}（密集半径 ${framing.denseRadius}）`
            }
        ];

        out = { model: MODEL, info, deleted, litBefore, litAfter, framing, checks, failed: checks.filter(c => !c.pass).length, errors: errors.slice(0, 10) };
    } catch (err) {
        out = { fatal: String(err).slice(0, 600), errors: errors.slice(0, 10), failed: 1 };
    } finally {
        await browser.close();
    }

    console.log(JSON.stringify(out, null, 2));
    if (out.failed > 0) process.exitCode = 1;
})();
