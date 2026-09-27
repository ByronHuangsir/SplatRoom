// 归档自 _tmp（2026-09-26），REPO 路径已按 docs/probes/ 调整。
// 探针 51：**验证新增的崩溃诊断真的会记下来**（不是"代码看起来对"）。
//
// 做法：启动打包好的 exe（带 --remote-debugging-port），用 CDP 连上去，
// 调 `Page.crash` **真的把渲染进程杀掉** —— 这正是用户"白屏且没有弹窗"的那一类事件。
// 然后去读 crash.log，应该能看到一条 `render-process-gone`（reason/exitCode）。
//
// usage: node _tmp/probe-crash-log.cjs [exe路径]
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const REPO = path.join(__dirname, '..', '..');
const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXE = process.argv[2] || path.join(REPO, 'release', 'SplatRoom-3.23.47.exe');
const PORT = 9333;

/** 在几个候选位置里找出真正的 crash.log（SplatRoom 的 userData = %APPDATA%\splatroom）。 */
const findCrashLogs = () => {
    const roots = [process.env.APPDATA, path.join(process.env.APPDATA, '..', 'Local')].filter(Boolean);
    const out = [];
    for (const root of roots) {
        let entries = [];
        try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            // 只认 SplatRoom 自己的目录：%APPDATA% 下还有别的应用（例如训练工具 spirula-studio）
            // 也叫 crash.log，混淆过一次。
            if (!/^splatroom$/i.test(e.name)) continue;
            const p = path.join(root, e.name, 'crash.log');
            if (fs.existsSync(p)) out.push(p);
        }
    }
    return out;
};

(async () => {
    if (!fs.existsSync(EXE)) {
        console.error('找不到 exe：' + EXE);
        process.exit(1);
    }
    const before = findCrashLogs().map((p) => [p, fs.statSync(p).size]);
    console.log('启动前已存在的 crash.log：', JSON.stringify(before));

    const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, '--remote-allow-origins=*'], {
        detached: true,
        stdio: 'ignore'
    });
    child.unref();
    console.log(`已启动 ${path.basename(EXE)}（pid=${child.pid}），等 CDP 端口 …`);

    let browser = null;
    for (let i = 0; i < 60; i++) {
        await sleep(1000);
        try {
            browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
            break;
        } catch { /* 还没起来 */ }
    }
    if (!browser) {
        console.error('CDP 连不上（60s）');
        process.exit(1);
    }
    const pages = await browser.pages();
    const page = pages.find((p) => p.url().startsWith('http')) || pages[0];
    console.log('已连上，页面：', page.url().slice(0, 80));

    // 确认打包版里的新代码在位（读渲染进程的版本 + 统一/主线判定）
    const info = await page.evaluate(() => ({
        versions: { electron: navigator.userAgent.match(/Electron\/[\d.]+/)?.[0] },
        unified: globalThis.__SPLATROOM_UNIFIED__ === true,
        hasScene: !!window.scene
    })).catch((e) => ({ error: String(e).slice(0, 120) }));
    console.log('页面信息：', JSON.stringify(info));

    console.log('→ 故意把渲染进程杀掉（CDP Page.crash）…');
    try {
        // 这个仓库里的 puppeteer-core 没有 `page.crash()`，直接走 CDP。
        const client = await page.createCDPSession();
        await client.send('Page.crash');
    } catch (e) {
        console.log('  （Page.crash 的报错是预期的：' + String(e).slice(0, 100) + '）');
    }
    await sleep(8000);

    const after = findCrashLogs();
    let verdict = 'FAIL（没有找到任何 crash.log）';
    for (const p of after) {
        const text = fs.readFileSync(p, 'utf8');
        const lines = text.trim().split('\n');
        const hit = lines.filter((l) => l.includes('render-process-gone')).slice(-2);
        console.log(`\n  ${p}（${text.length} 字节，${lines.length} 行）`);
        for (const l of lines.slice(-4)) console.log('    ' + l.slice(0, 200));
        if (hit.length) verdict = 'PASS（render-process-gone 已记录：' + hit[hit.length - 1].slice(0, 160) + '）';
    }
    console.log('\n⇒ 结论：' + verdict);

    try { await browser.disconnect(); } catch { }
    // 收拾干净：把这次启动的进程组杀掉
    try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch { }
    console.log('（已请求结束进程）');
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
