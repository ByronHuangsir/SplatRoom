// "后台导出"能不能跑：把**打包版**窗口最小化，量导出还在不在走。
//
// 背景（第十八轮）：应用的导出循环靠"让一手宏任务"（`await new Promise(r => setTimeout(r, 1))`，
// 见 `src/app/render.ts`）驱动，而真正的出帧依赖 PlayCanvas 自己的 rAF 渲染循环。
// Electron 的 `webPreferences.backgroundThrottling` **默认 true** ⇒ 窗口被遮挡/最小化时
// rAF 被暂停、`setTimeout` 被降频（先 1 Hz，长时间不可见后 1 次/分钟）——
// 两者叠加会让"导出中最小化窗口"从"慢一点"变成"卡住"。
//
// 为什么用打包版而不是自己起 Electron：Electron 不支持 CDP 的 `Browser.setWindowBounds`，
// 最小化只能由主进程做；自己 spawn 一个探针主进程在本机起不来（见 HANDOFF 坑 65）。
// 打包版本来就是"用户真实运行的东西"，用 PowerShell + user32 `ShowWindow(SW_MINIMIZE=6)`
// 最小化它的主窗口即可（`SW_RESTORE=9` 恢复）。
//
// 口径：
//   • **出片进度**：数**系统下载目录**里新出现的 PNG（导出没有目录句柄时就走下载兜底，
//     这是"真的写出去了"的硬证据；页内包 `convertToBlob` 数不到，PNG 编码不走那条路）
//   • `rafHz`：rAF 回调频率（可见性节流的直接证据）
//   • `timerGap*`：`setInterval(200ms)` 的实际间隔（定时器节流的直接证据）
//   • `hidden`：`document.hidden`（最小化是否真的被页面看到）
//
// usage: node docs/probes/background-export.cjs <exePath> [frames] [width] [height]
//   例：node docs/probes/background-export.cjs release/SplatRoom-3.23.24.exe 12 7680 4320
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');
const puppeteer = require(path.join(__dirname, '..', '..', 'node_modules', 'puppeteer-core'));

const REPO = path.join(__dirname, '..', '..');
const EXE = process.argv[2] || path.join(REPO, 'release', 'SplatRoom-3.23.24.exe');
const FRAMES = Number(process.argv[3] || 12);
const WIDTH = Number(process.argv[4] || 7680);
const HEIGHT = Number(process.argv[5] || 4320);
const PORT = 9222;
const DOWNLOADS = path.join(os.homedir(), 'Downloads');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pngs = () => {
    try {
        return new Set(fs.readdirSync(DOWNLOADS).filter(f => f.toLowerCase().endsWith('.png')));
    } catch {
        return new Set();
    }
};

// user32 的 ShowWindow：6 = SW_MINIMIZE，9 = SW_RESTORE
// 走临时 .ps1 文件而不是 `-Command`：内联时 C# 特性里的引号会被 PowerShell 吃掉
// （`[DllImport(\"user32.dll\")]` → `[DllImport(user32.dll)]` ⇒ 编译失败）。
// 进程名两种都要试：打包版叫 `SplatRoom`，开发版（`npx electron .`）叫 `electron`
// （第一版只按 SplatRoom 找，attach 模式下得到 `no-window`，等于压根没最小化 ⇒ 结论无效）。
const PS_SCRIPT = path.join(os.tmpdir(), 'sr-show-window.ps1');
const showWindow = (cmd) => {
    fs.writeFileSync(PS_SCRIPT, [
        'param([int]$Cmd)',
        "Add-Type -Namespace W -Name U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int c);'",
        "$p = @(Get-Process SplatRoom, electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }) | Select-Object -First 1",
        'if ($p) { [W.U]::ShowWindow($p.MainWindowHandle, $Cmd) | Out-Null; Write-Output ("ok:" + $p.ProcessName + ":" + $p.Id) } else { Write-Output "no-window" }'
    ].join('\n'), 'utf8');
    return execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${PS_SCRIPT}" ${cmd}`, { encoding: 'utf8' }).trim();
};

const killApp = () => {
    try {
        execSync('powershell -NoProfile -Command "Get-Process SplatRoom -ErrorAction SilentlyContinue | Stop-Process -Force"');
    } catch {
        // 没有残留进程
    }
};

const main = async () => {
    // `attach`：连一个已经在跑的应用（用 `npx electron .` 起开发版，改 webPreferences 后不必重新打包）
    const attach = EXE === 'attach';
    if (!attach && !fs.existsSync(EXE)) {
        throw new Error(`找不到打包版：${EXE}`);
    }
    if (!attach) {
        killApp();
        await sleep(1500);
    }

    const before = pngs();
    let child = null;
    if (!attach) {
        child = spawn(EXE, [`--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', '--gpu=webgpu'], {
            cwd: REPO, detached: true, stdio: 'ignore'
        });
        child.unref();
    }

    let browser = null;
    for (let i = 0; i < 60; i++) {
        await sleep(1000);
        try {
            browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
            break;
        } catch {
            // 还没起来
        }
    }
    if (!browser) {
        throw new Error(`${attach ? '要 attach 的应用' : '打包版'}没在 60 s 内开出调试端口`);
    }

    const pages = await browser.pages();
    const page = pages.find(p => !p.url().startsWith('devtools://')) ?? pages[0];
    await page.waitForFunction('!!window.scene', { timeout: 120000, polling: 500 });
    await sleep(2500);

    // 打包版内建静态服务里有 test-model.ply（唯一进包的 PLY）
    await page.evaluate(async () => {
        const buf = await (await fetch('./test-model.ply')).arrayBuffer();
        await window.scene.events.invoke('import', [{ filename: 'test-model.ply', contents: new File([buf], 'test-model.ply') }]);
    });
    for (let i = 0; i < 60; i++) {
        await sleep(1000);
        if (await page.evaluate(() => window.scene.getElementsByType('splat').length > 0)) break;
    }
    await sleep(2500);

    await page.evaluate(() => {
        window.__rafTicks = [];
        window.__timerGaps = [];
        window.__exportDone = false;
        window.__exportErr = null;
        window.__blobs = 0;          // 每帧一次 URL.createObjectURL（downloadFile 兜底路径）
        window.__anchors = 0;        // 每帧一次 a.click()
        window.__trackers = [];

        const origCreate = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (blob) => {
            window.__blobs++;
            return origCreate(blob);
        };
        const origClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function (...args) {
            if (this.download) {
                window.__anchors++;
                window.__trackers.push(String(this.download).slice(0, 80));
            }
            return origClick.apply(this, args);
        };

        const raf = () => {
            window.__rafTicks.push(performance.now());
            requestAnimationFrame(raf);
        };
        requestAnimationFrame(raf);
        let last = performance.now();
        setInterval(() => {
            const now = performance.now();
            window.__timerGaps.push(Math.round(now - last));
            last = now;
        }, 200);
    });

    const written = () => {
        const now = pngs();
        let n = 0;
        for (const f of now) {
            if (!before.has(f)) {
                n++;
            }
        }
        return n;
    };

    // **不要 await**：`page.evaluate(async () => { await export })` 会一直等到导出结束，
    // 于是"最小化期间"的采样全部发生在导出之后（第一版就是这么得出"7 秒就完成"的假结论）。
    await page.evaluate((opts) => {
        window.scene.events.fire('camera.setAutoRotateSpeed', 360);
        window.__exportT0 = performance.now();
        window.__exportPromise = window.scene.events.invoke('render.turntableVideo', {
            frameRate: opts.frames,
            width: opts.width,
            height: opts.height,
            bitrate: 0,
            format: 'png',
            codec: 'h264',
            mode: 'orbit'
        }, undefined, undefined)
            .then(() => {
                window.__exportDone = true;
                window.__exportMs = performance.now() - window.__exportT0;
            })
            .catch((e) => {
                window.__exportErr = String(e).slice(0, 200);
            });
    }, { frames: FRAMES, width: WIDTH, height: HEIGHT });

    const sample = async () => {
        const s = await page.evaluate(() => {
            const gaps = window.__timerGaps.slice(-15);
            const raf = window.__rafTicks.slice(-150);
            const rafSpan = raf.length > 1 ? raf[raf.length - 1] - raf[0] : 0;
            return {
                done: window.__exportDone,
                exportMs: window.__exportMs ?? null,
                err: window.__exportErr,
                hidden: document.hidden,
                blobs: window.__blobs,
                anchors: window.__anchors,
                trackers: window.__trackers.slice(0, 3),
                timerGapMax: gaps.length ? Math.max(...gaps) : 0,
                timerGapAvg: gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 0,
                rafHz: rafSpan > 0 ? +(1000 * (raf.length - 1) / rafSpan).toFixed(1) : 0
            };
        });
        return { ...s, pngsWritten: written() };
    };

    await sleep(3000);
    const foreground = await sample();

    const minimizeResult = showWindow(6);
    const minimized = [];
    for (let i = 0; i < 10; i++) {
        await sleep(4000);
        const s = await sample();
        minimized.push(s);
        if (s.done) break;
    }

    const restoreResult = showWindow(9);
    let after = null;
    for (let i = 0; i < 30; i++) {
        await sleep(2000);
        after = await sample();
        if (after.done) break;
    }

    const lastMin = minimized.length ? minimized[minimized.length - 1] : foreground;
    const bgSeconds = minimized.length * 4;
    const framesMin = lastMin.pngsWritten - foreground.pngsWritten;

    // 清理这次写出去的文件
    let cleaned = 0;
    for (const f of pngs()) {
        if (!before.has(f)) {
            try {
                fs.unlinkSync(path.join(DOWNLOADS, f));
                cleaned++;
            } catch {
                // 占用中：留着
            }
        }
    }

    console.log(JSON.stringify({
        exe: path.basename(EXE), frames: FRAMES, size: `${WIDTH}x${HEIGHT}`,
        minimizeResult, restoreResult,
        foreground, minimized, after,
        framesWhileMinimized: framesMin,
        backgroundSeconds: bgSeconds,
        framesPerSecondWhileMinimized: +(framesMin / Math.max(1, bgSeconds)).toFixed(2),
        completedWhileMinimized: minimized.length ? !!lastMin.done : false,
        cleanedUpPngs: cleaned,
        verdict: (minimized.length && lastMin.done) ?
            '导出在最小化期间跑完了' :
            (after && after.done ? '最小化期间没跑完，恢复窗口后才跑完' : '探针放弃时还没跑完')
    }, null, 1));

    await browser.disconnect();
    killApp();
    process.exit(0);
};

main().catch((e) => {
    console.log(JSON.stringify({ fatal: String(e && e.stack || e).slice(0, 600) }));
    killApp();
    process.exit(1);
});
