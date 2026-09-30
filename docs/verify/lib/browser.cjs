/**
 * 验证套件 / 探针共用的浏览器启动器与"只清自己人"的清理工具。
 *
 * ## 为什么有这个文件
 *
 * 原来 100 多个套件/探针里各自硬写一行：
 *
 *     const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
 *     args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
 *
 * 两个问题：
 *   1. **换浏览器 / 换机器就要改 100 多处**；
 *   2. 排查时习惯性加的那句"清理残留浏览器"——
 *      `Get-Process msedge | Stop-Process -Force` —— 是**按进程名无差别杀**，
 *      会把用户正在用的 Edge（所有窗口和标签页）一起杀掉。实测因此把用户浏览器
 *      反复关掉三十多次。**这是过度杀伤：要清的是孤儿，杀掉的是用户会话。**
 *
 * 所以这里提供两件东西：
 *   * `launchBrowser(opts)` —— 统一的启动参数（WebGPU + 无沙箱 + 有头/无头）；
 *   * `cleanupOrphanBrowsers()` —— **只杀命令行里带 puppeteer 临时 profile 的实例**，
 *     也就是"上次跑崩留下的孤儿"，绝不碰用户自己开的浏览器。
 *
 * ## 用法
 *
 *     const { launchBrowser, cleanupOrphanBrowsers } = require('./lib/browser.cjs');
 *     cleanupOrphanBrowsers();                 // 可选：先清孤儿
 *     const browser = await launchBrowser();   // 默认无头
 *     ...
 *     await browser.close();
 *
 * 需要看画面时（有头模式，便于人工核对）：`launchBrowser({ headless: false })`。
 * 有头模式下 puppeteer 用独立的临时 profile，**不会**动用户已开的 Edge。
 */
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const REPO = path.join(__dirname, '..', '..', '..');

/** 候选浏览器可执行文件（按顺序取第一个存在的） */
const CANDIDATES = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA.replace(/\\/g, '/')}/Google/Chrome/Application/chrome.exe` : null
].filter(Boolean);

/**
 * 解析浏览器可执行文件路径。
 * 优先级：环境变量 `SPLATROOM_BROWSER` > 候选列表里第一个存在的 > 第一个候选（让它自己报错）。
 */
function resolveBrowserPath() {
    const fromEnv = process.env.SPLATROOM_BROWSER;
    if (fromEnv && fs.existsSync(fromEnv)) {
        return fromEnv;
    }
    for (const c of CANDIDATES) {
        if (fs.existsSync(c)) {
            return c;
        }
    }
    return CANDIDATES[0];
}

const BROWSER_PATH = resolveBrowserPath();

/** 统一的启动参数：WebGPU + 软件/硬件适配 + 无沙箱（CI/无头环境必需） */
const LAUNCH_ARGS = [
    '--no-sandbox',
    '--enable-unsafe-webgpu',
    '--ignore-gpu-blocklist'
];

/**
 * 找一个空闲端口。注意：必须给浏览器**显式的非零端口** ——
 * Edge 154 起 `--remote-debugging-port=0` 会让浏览器立即退出（这正是 launch 失败的根因）。
 */
function findFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
    });
}

/** 轮询 DevTools HTTP 端点直到就绪（或超时）。 */
function waitForDevtools(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const tryOnce = () => {
            const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 2000 }, (res) => {
                res.resume();
                if (res.statusCode === 200) {
                    resolve();
                } else {
                    retry();
                }
            });
            req.on('error', retry);
            req.on('timeout', () => { req.destroy(); retry(); });
        };
        const retry = () => {
            if (Date.now() > deadline) {
                reject(new Error(`devtools endpoint 127.0.0.1:${port} not ready within ${timeoutMs}ms`));
            } else {
                setTimeout(tryOnce, 300);
            }
        };
        tryOnce();
    });
}

/**
 * connect 模式启动（Edge 154 × puppeteer.launch 断裂的绕行，见
 * `docs/换机器-第二台机器适配记录.md` §9）：
 *   1. 自己 spawn 浏览器：显式非零调试端口 + 临时 profile（目录名带 `puppeteer_dev_`，
 *      这样 `cleanupOrphanBrowsers()` 的孤儿判据对它依然生效）；
 *   2. 等 DevTools 端点就绪；
 *   3. `puppeteer.connect` 接管。调用方照常 `browser.close()` 即可关掉浏览器。
 */
async function launchViaConnect(opts) {
    const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
    const port = await findFreePort();
    const profile = path.join(
        os.tmpdir(),
        `puppeteer_dev_connect_profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );
    const headless = opts.headless === undefined ? 'new' : opts.headless;
    const headlessArg = headless === true || headless === 'new' ? '--headless=new' : (headless ? `--headless=${headless}` : null);
    // 过滤会与 connect 模式冲突的参数（用户目录/调试端口/管道由这里自己接管）
    const extraArgs = (opts.args ?? []).filter(a =>
        !a.startsWith('--user-data-dir') &&
        !a.startsWith('--remote-debugging-port') &&
        !a.startsWith('--remote-debugging-pipe') &&
        !a.startsWith('--headless')
    );
    const args = [
        ...(headlessArg ? [headlessArg] : []),
        ...LAUNCH_ARGS,
        ...extraArgs,
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank'
    ];
    const child = spawn(opts.executablePath ?? BROWSER_PATH, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    try {
        await waitForDevtools(port, 30000);
    } catch (err) {
        try {
            process.kill(child.pid, 'SIGKILL');
        } catch {
            // 已经退出了
        }
        throw err;
    }
    return puppeteer.connect({
        browserURL: `http://127.0.0.1:${port}`,
        protocolTimeout: opts.protocolTimeout ?? 3600000
    });
}

/**
 * 启动浏览器。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.headless] 默认 `'new'`（无头）；传 `false` 开有头，便于人工看画面
 * @param {number} [opts.protocolTimeout] 默认 1 小时（大模型导入 + 多档扫描会很久）
 * @param {string[]} [opts.args] 追加参数
 * @param {number} [opts.width] / @param {number} [opts.height] 默认视口（不传则不设）
 * @returns {Promise<import('puppeteer-core').Browser>}
 */
async function launchBrowser(opts = {}) {
    const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer-core'));
    let browser;
    try {
        browser = await puppeteer.launch({
            executablePath: BROWSER_PATH,
            headless: opts.headless === undefined ? 'new' : opts.headless,
            args: [...LAUNCH_ARGS, ...(opts.args ?? [])],
            protocolTimeout: opts.protocolTimeout ?? 3600000
        });
    } catch (err) {
        // Edge 154 起 launch 必败（--remote-debugging-port=0 让浏览器立即退出，Code: 0 且
        // stderr 无 DevTools 行）。不要在这卡死 50+ 个套件：回退 connect 模式。
        console.warn(`[browser.cjs] puppeteer.launch 失败（${String(err?.message ?? err).split('\n')[0]}）`);
        console.warn('[browser.cjs] 回退：固定端口手动 spawn + puppeteer.connect');
        browser = await launchViaConnect(opts);
    }
    if (opts.width || opts.height) {
        const page = await browser.newPage();
        await page.setViewport({ width: opts.width ?? 1280, height: opts.height ?? 800 });
    }
    return browser;
}

/**
 * 给**硬编码 `puppeteer.launch(...)` 的旧套件**用的原位替换：
 *
 *     const { launchPatched } = require('./lib/browser.cjs');   // 相对路径按文件位置调整
 *     const browser = await launchPatched(puppeteer, { executablePath: EDGE, headless: 'new', args: [...] });
 *
 * 行为与 `puppeteer.launch` 完全一致；launch 失败（Edge 154 断裂）时自动回退 connect 模式，
 * 透传 executablePath / headless / args / protocolTimeout，调用方无感。
 */
async function launchPatched(puppeteer, launchOpts = {}) {
    try {
        return await puppeteer.launch(launchOpts);
    } catch (err) {
        console.warn(`[browser.cjs] puppeteer.launch 失败（${String(err?.message ?? err).split('\n')[0]}），回退 connect 模式`);
        return launchViaConnect({
            executablePath: launchOpts.executablePath,
            headless: launchOpts.headless,
            args: launchOpts.args,
            protocolTimeout: launchOpts.protocolTimeout
        });
    }
}

/**
 * 清理**孤儿**浏览器进程 —— 只清"上一次跑探针时崩掉、没被 browser.close() 收走"的那些。
 *
 * 判据是命令行里的 puppeteer 临时 profile 标记（`puppeteer_dev_..._profile` /
 * `--user-data-dir=...puppeteer...`）。**用户自己开的 Edge/Chrome 命令行里没有这个标记，
 * 所以永远不会被这条清掉** —— 这正是它与 `Get-Process msedge | Stop-Process` 的关键区别。
 *
 * 在 Windows 上用 `Get-CimInstance Win32_Process` 读命令行；其它平台直接返回 0（不猜）。
 *
 * @returns {number} 实际杀掉的进程数
 */
function cleanupOrphanBrowsers() {
    if (process.platform !== 'win32') {
        return 0;
    }
    const names = ['msedge.exe', 'chrome.exe'];
    let killed = 0;
    for (const name of names) {
        let rows = '';
        try {
            // ⚠️ 只认 `puppeteer_dev_` 这个临时 profile 标记。
            // 不要加 `--headless` —— 用户自己也可能开着无头 Edge（跑脚本、抓数据），
            // 那属于用户会话，不是我们的孤儿。
            rows = execFileSync('powershell', [
                '-NoProfile', '-Command',
                `Get-CimInstance Win32_Process -Filter "Name='${name}'" | ` +
                'Where-Object { $_.CommandLine -match \'puppeteer_dev_\' } | ' +
                'ForEach-Object { $_.ProcessId }'
            ], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
        } catch {
            // 没有该进程 / 无权读命令行 —— 都不是错误，直接跳过
            continue;
        }
        const pids = String(rows).split(/\s+/).map(s => parseInt(s, 10)).filter(n => Number.isInteger(n) && n > 0);
        for (const pid of pids) {
            try {
                process.kill(pid, 'SIGKILL');
                killed++;
            } catch {
                // 已经退出了
            }
        }
    }
    return killed;
}

/**
 * 走完一个套件后收尾：先正常 `close()`，失败再按 PID 兜底，最后清孤儿。
 * 与 `cleanupOrphanBrowsers()` 一样，**绝不按进程名无差别杀**。
 */
async function closeBrowser(browser) {
    try {
        await browser?.close();
    } catch {
        // 忽略：下面统一清孤儿
    } finally {
        cleanupOrphanBrowsers();
    }
}

module.exports = {
    BROWSER_PATH,
    LAUNCH_ARGS,
    launchBrowser,
    launchPatched,
    cleanupOrphanBrowsers,
    closeBrowser
};
