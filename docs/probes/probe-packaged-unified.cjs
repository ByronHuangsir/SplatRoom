// 归档自 _tmp（2026-09-26 凌晨：?unified=1 导入卡死修复 + 打包验收），REPO 路径已按 docs/probes/ 调整。
// 打包版验收：`SplatRoom-3.23.44.exe --gpu=webgpu --unified=1` 能不能把开关带进渲染进程。
//
// 为什么值得单独验：`--gpu` 早就在 `electron-main.js` 里做过转发（拼成 `?gpu=`），
// 而 `--unified` 是**今天新加的**同款转发；打包之后没有任何别的入口能带查询参数，
// 所以"用户能不能打开 unified 通路"完全取决于这一段。
//
// usage: node _tmp/probe-packaged-unified.cjs [exePath] [extraArgs...]
const path = require('path');
const { spawn } = require('child_process');
const REPO = path.join(__dirname, '..', '..');
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXE = process.argv[2] || path.join(REPO, 'release', 'SplatRoom-3.23.44.exe');
const PORT = 9223;

(async () => {
    const child = spawn(EXE, [
        `--remote-debugging-port=${PORT}`,
        '--remote-allow-origins=*',
        '--gpu=webgpu',
        '--unified=1'
    ], { detached: false, stdio: 'ignore' });

    let browser = null;
    for (let i = 0; i < 40; i++) {
        await sleep(1000);
        try {
            browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
            break;
        } catch (e) { /* 还没起来 */ }
    }
    if (!browser) {
        console.log(JSON.stringify({ ok: false, why: '没能连上调试端口' }));
        try { child.kill(); } catch (e) { /* ignore */ }
        process.exit(1);
    }

    const pages = await browser.pages();
    const info = [];
    for (const p of pages) {
        try {
            const r = await p.evaluate(() => ({
                url: location.href,
                search: location.search,
                unified: globalThis.__SPLATROOM_UNIFIED__ === true,
                hasScene: !!window.scene,
                hasWebGPU: !!navigator.gpu
            }));
            info.push(r);
        } catch (e) {
            info.push({ url: p.url(), err: String(e).slice(0, 120) });
        }
    }

    // 等场景就绪后再看一次（主窗口可能在启动页之后才加载完）
    let sceneInfo = null;
    for (const p of pages) {
        try {
            await p.waitForFunction('!!window.scene', { timeout: 40000, polling: 500 });
            sceneInfo = await p.evaluate(() => ({
                search: location.search,
                unified: globalThis.__SPLATROOM_UNIFIED__ === true,
                gpu: (window.scene.app.graphicsDevice && window.scene.app.graphicsDevice.isWebGPU) ? 'webgpu' : 'webgl2',
                elements: (window.scene.elements || []).length
            }));
            break;
        } catch (e) { /* 换下一个页面 */ }
    }

    console.log(JSON.stringify({ exe: path.basename(EXE), pages: info, sceneInfo }, null, 1));
    console.log('\n=== 判定 ===');
    const okUnified = !!(sceneInfo && sceneInfo.unified);
    console.log(`  渲染进程 URL：${info.map(i => i.search).join(' | ')}`);
    console.log(`  __SPLATROOM_UNIFIED__ = ${sceneInfo ? sceneInfo.unified : '(场景未就绪)'}`);
    console.log(`  后端：${sceneInfo ? sceneInfo.gpu : '?'}`);
    console.log(`  ⇒ ${okUnified ? '**打包版 `--unified=1` 转发生效**' : '**没生效**（要么转发没拼上，要么渲染进程读不到）'}`);

    try { await browser.disconnect(); } catch (e) { /* ignore */ }
    try { child.kill(); } catch (e) { /* ignore */ }
    await sleep(1000);
    // 兜底：杀掉这次启动的实例（按进程名，仅本探针使用）
    try {
        require('child_process').execSync('taskkill /IM SplatRoom.exe /F', { stdio: 'ignore' });
    } catch (e) { /* 已经没有进程了 */ }
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
