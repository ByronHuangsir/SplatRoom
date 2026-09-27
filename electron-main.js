const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
// 启动页（Photoshop 风格）：独立小窗口 + 真实阶段的进度 + 左下角加载信息
const splash = require('./electron-splash');
// Detect dev mode
const isDev = !fs.existsSync(path.join(__dirname, 'dist', 'index.html'));

// 渲染导出（图像 / 视频 / 旋转台帧序列）必须能在**窗口被最小化或被遮挡时继续跑**：
// 第十八轮实测（`docs/probes/background-export.cjs`，8K 旋转台 PNG 序列）：
//   窗口可见时 rafHz 38–60、定时器间隔 ~200 ms，导出正常推进；
//   窗口一最小化，`document.hidden = true`，**rAF 被暂停、定时器被降到 ~1 Hz**
//   （实测定时器最大间隔 1442 ms）⇒ 40 秒里一帧都没写出（进度停在 2/12），
//   恢复窗口后才继续跑完（60.4 s vs 前台 21 s）。
// Electron 的 `backgroundThrottling` 默认 true 就是这个行为；关掉它 + 关掉渲染进程后台化，
// 导出才能在"最小化去干别的"时继续。
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

// MIME types for static file serving
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.wasm': 'application/wasm',
    '.map': 'application/json',
    '.ply': 'application/octet-stream',
    '.sscg': 'application/json',
    '.splat': 'application/octet-stream',
    '.spz': 'application/octet-stream',
};

let mainWindow = null;
let server = null;
let isQuitting = false;

// ---------------------------------------------------------------------------
// 崩溃诊断（"白屏"的解释器）
//
// 背景：用户反馈"使用过程中白屏（选中删除过程中白屏）"，用的是真实模型
// （1.5–4.6GB / 6.5M–20M 高斯）。在这个文件里查过一遍：**一条崩溃处理都没有** ——
// 渲染进程 OOM / 被 kill、GPU 进程崩溃、主框架加载失败，全都是静默的：窗口就停在
// 一张白板或一帧静止画面上，用户看不到原因，我们也拿不到任何线索。
//
// 现在全部落进 `<userData>/crash.log`，并在真正致命时弹一个能读懂的对话框 + 一键重载。
// 渲染进程崩溃 = 窗口白板且**永远不会自己恢复**，这正是"白屏"最典型的成因。
// ---------------------------------------------------------------------------
let crashLogPath = null;
let gpuCrashNoticeAt = 0;

/** 追加一条崩溃记录，返回日志文件路径（日志本身永远不能成为新的崩溃源）。 */
function logCrash(kind, detail) {
    const line = `[${new Date().toISOString()}] ${kind}: ${detail}\n`;
    console.error(line.trim());
    try {
        if (!crashLogPath) {
            crashLogPath = path.join(app.getPath('userData'), 'crash.log');
        }
        fs.appendFileSync(crashLogPath, line);
    } catch { /* ignore */ }
    return crashLogPath;
}

function crashDialog(options) {
    const { title, message, detail, reload = true } = options;
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const buttons = reload ? ['重新加载', '退出'] : ['知道了'];
    dialog.showMessageBox(parent, {
        type: 'error',
        title,
        message,
        detail,
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1,
        noLink: true
    }).then(({ response }) => {
        if (!reload) {
            return;
        }
        if (response === 0) {
            try {
                mainWindow.webContents.reload();
            } catch (e) {
                logCrash('reload-failed', String(e));
            }
        } else {
            isQuitting = true;
            app.quit();
        }
    }).catch(() => { /* 对话框打不开也只能算了 */ });
}

/** GPU / 渲染进程崩溃时给用户看的那段话（含日志路径与最有效的自救动作）。 */
function crashDetailText(reason, extra) {
    const lines = [
        `原因：${reason}`,
        extra ? `细节：${extra}` : null,
        `日志：${crashLogPath || '(未写入)'}`,
        '',
        '怎么处理：',
        '  · 点"重新加载"可以回到干净状态，未保存的编辑会丢失；',
        '  · 如果是在大模型（千万级高斯）上选中/删除时反复出现，先做一次"保存"，再缩小选区分批删除；',
        '  · 崩溃日志请留一份，它能直接指出是显存、内存还是渲染进程被杀。'
    ];
    return lines.filter((l) => l !== null).join('\n');
}

/**
 * Simple static file server.
 * Serves files from the dist/ directory and the static/ directory only.
 * Returns 200 with correct MIME type or 404.
 *
 * Security: only the two whitelisted roots (dist/ and static/) are exposed.
 * Requests are URL-decoded, normalized and prefix-checked so `..` traversal
 * can never escape into the project root (source, configs, node_modules,
 * release artifacts, ...). No CORS header is set: the renderer is same-origin.
 */
function createStaticServer() {
    const rootDist = path.join(__dirname, 'dist');
    const rootStatic = path.join(__dirname, 'static');

    return http.createServer((req, res) => {
        // Parse URL, strip query strings
        let urlPath = req.url.split('?')[0];

        // Default to index.html
        if (urlPath === '/' || urlPath === '') {
            urlPath = '/index.html';
        }

        // Security: decode + normalize, prevent directory traversal.
        // decodeURIComponent throws on malformed input → 400.
        let safePath;
        try {
            safePath = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.(\/|\\|$))+/, '');
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Bad Request');
            return;
        }

        // Try dist/ first, then static/ — never the whole project root.
        let filePath = path.join(rootDist, safePath);
        if (!fs.existsSync(filePath)) {
            const staticFilePath = path.join(rootStatic, safePath);
            if (fs.existsSync(staticFilePath)) {
                filePath = staticFilePath;
            }
        }

        // Defence in depth: reject anything that resolved outside the roots.
        if (!filePath.startsWith(rootDist + path.sep) && !filePath.startsWith(rootStatic + path.sep)) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden');
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        fs.readFile(filePath, (err, data) => {
            if (err) {
                // For SPA fallback: serve index.html for non-file routes
                if (err.code === 'ENOENT' && !path.extname(safePath)) {
                    fs.readFile(path.join(rootDist, 'index.html'), (err2, data2) => {
                        if (err2) {
                            res.writeHead(404, { 'Content-Type': 'text/plain' });
                            res.end('Not Found');
                            return;
                        }
                        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(data2);
                    });
                    return;
                }
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found');
                return;
            }
            res.writeHead(200, {
                'Content-Type': contentType,
                'Cache-Control': 'no-cache'
            });
            res.end(data);
        });
    });
}

/**
 * Find an available port starting from `startPort`.
 */
function findAvailablePort(startPort) {
    return new Promise((resolve, reject) => {
        const server = require('net').createServer();
        server.unref();
        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                resolve(findAvailablePort(startPort + 1));
            } else {
                reject(err);
            }
        });
        server.listen(startPort, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}

async function createWindow() {
    // Start HTTP server first, then create window
    const port = await findAvailablePort(5173);
    server = createStaticServer();

    // Create the browser window upfront (hidden)
    mainWindow = new BrowserWindow({
        width: 1600,
        height: 900,
        minWidth: 1024,
        minHeight: 600,
        title: 'SplatRoom',
        show: false,
        icon: path.join(__dirname, 'static', 'icons', 'icon.ico'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: true,
            preload: path.join(__dirname, 'electron-preload.js'),
            // 见文件顶部：导出要在最小化/被遮挡时继续跑（默认 true 会让 rAF 停摆、
            // 定时器降到 1 Hz ⇒ 导出卡住）
            backgroundThrottling: false
        },
        autoHideMenuBar: true
    });

    // Allow microphone / media capture (recording voice track). Without this
    // Electron denies getUserMedia audio by default.
    mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
        callback(permission === 'media');
    });

    // Explicit zoom handling: before-input-event fires before any renderer handler,
    // so Ctrl+= / Ctrl+- / Ctrl+0 always reach us regardless of page-level keyboard handlers.
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.control && !input.meta && !input.alt) {
            if (input.key === '=' || input.key === '+' || input.key === 'NumpadAdd') {
                event.preventDefault();
                const zf = mainWindow.webContents.getZoomFactor();
                mainWindow.webContents.setZoomFactor(Math.min(zf + 0.1, 5.0));
            } else if (input.key === '-' || input.key === 'NumpadSubtract') {
                event.preventDefault();
                const zf = mainWindow.webContents.getZoomFactor();
                mainWindow.webContents.setZoomFactor(Math.max(zf - 0.1, 0.2));
            } else if (input.key === '0' || input.key === 'Numpad0') {
                event.preventDefault();
                mainWindow.webContents.setZoomFactor(1.0);
            }
        }
    });

    // Tool modules (compare / merge / splatfactory) open themselves via
    // window.open('?...mode=...'). Electron denies window.open by default, so
    // explicitly allow same-origin popups into a sane default window.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        try {
            const u = new URL(url);
            if (u.protocol === 'http:' || u.protocol === 'https:') {
                return {
                    action: 'allow',
                    overrideBrowserWindowOptions: {
                        width: 1600,
                        height: 900,
                        minWidth: 1024,
                        minHeight: 600,
                        autoHideMenuBar: true,
                        webPreferences: {
                            contextIsolation: true,
                            nodeIntegration: false,
                            webSecurity: true,
                            // 弹出窗口（比较/合并/工厂等工具）同样不要被后台节流
                            backgroundThrottling: false
                        }
                    }
                };
            }
        } catch (e) {
            // malformed URL — deny
        }
        return { action: 'deny' };
    });

    // ---- 崩溃 / 假死 / 加载失败：全部记录，致命时给用户一条出路 ----

    // 渲染进程消失（oom / crashed / killed）：窗口会停在一张白板上且**永远不会自己恢复**。
    mainWindow.webContents.on('render-process-gone', (event, details) => {
        if (!details || details.reason === 'clean-exit') {
            return; // 正常收尾（关窗、退出）
        }
        const log = logCrash('render-process-gone', JSON.stringify(details));
        crashDialog({
            title: 'SplatRoom 渲染进程已退出',
            message: `页面进程没了（${details.reason}${details.exitCode !== undefined ? '，退出码 ' + details.exitCode : ''}），窗口不会再自己恢复。`,
            detail: crashDetailText(details.reason, `exitCode=${details.exitCode} log=${log}`)
        });
    });

    // 主线程长时间卡死：大模型上的导入 / 框选 / 删除本来就是秒级到几十秒的任务，
    // **所以这里只记账、不弹窗** —— 弹一个模态框在"正常的慢操作"上只会变成新的骚扰。
    // 需要区分"卡住但活着"和"已经死了"时，crash.log 里的时间戳就是证据。
    mainWindow.webContents.on('unresponsive', () => {
        logCrash('unresponsive', 'renderer 主线程长时间无响应');
    });

    mainWindow.webContents.on('responsive', () => {
        logCrash('responsive', '主线程恢复响应');
    });

    // 主框架加载失败 = 白窗口，且不会重试。
    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        logCrash('did-fail-load', `${errorCode} ${errorDescription} url=${validatedURL} mainFrame=${isMainFrame}`);
        if (!isMainFrame) {
            return;
        }
        crashDialog({
            title: 'SplatRoom 加载失败',
            message: `界面没能加载（${errorCode} ${errorDescription}）。`,
            detail: crashDetailText(`${errorCode} ${errorDescription}`, `url=${validatedURL}`)
        });
    });

    mainWindow.webContents.on('preload-error', (event, preloadPath_, error) => {
        logCrash('preload-error', `${preloadPath_}: ${error && error.stack ? error.stack : error}`);
    });

    // Build menu
    const template = [
        {
            label: 'File',
            submenu: [
                { role: 'quit' }
            ]
        },
        {
            label: 'Edit',
            submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                { role: 'selectAll' }
            ]
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' }
            ]
        },
        {
            label: 'Help',
            submenu: [
                {
                    label: 'SplatRoom Website',
                    click: () => shell.openExternal('https://github.com/photographer-huangsir/splatroom')
                }
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);

    // Only load the URL after the HTTP server is actually listening.
    // This prevents a race where the window tries to fetch before the server is ready.
    // Graphics backend override: `--gpu=webgpu` (or `--gpu webgpu`) is appended
    // as a ?gpu= query param that the renderer reads when creating the device.
    const gpuArg = (() => {
        const eq = process.argv.findIndex((a) => a.startsWith('--gpu='));
        if (eq >= 0) return process.argv[eq].slice(6);
        const sp = process.argv.indexOf('--gpu');
        if (sp >= 0 && process.argv[sp + 1]) return process.argv[sp + 1];
        return null;
    })();
    // 实验通路开关：`--unified=1`（或 `--unified`）→ `?unified=1`。
    //
    // 为什么要在宿主侧转发：渲染进程只读 `location.search`（`src/main.ts` 的 `getURLArgs`），
    // 打包之后没有别的入口能带查询参数，而这个开关的全部判定都挂在它上面
    // （`main.ts` 把 `?unified=1` 归一化成 `__SPLATROOM_UNIFIED__`，下游只认那个全局）。
    // 与 `--gpu` 同一套写法，保持一行一条命令行开关。
    const unifiedArg = (() => {
        const eq = process.argv.findIndex((a) => a.startsWith('--unified='));
        if (eq >= 0) return process.argv[eq].slice(10);
        if (process.argv.includes('--unified')) return '1';
        return null;
    })();
    const withGpu = (url) => {
        let out = url;
        const add = (kv) => {
            out += (out.includes('?') ? '&' : '?') + kv;
        };
        if (gpuArg) add('gpu=' + encodeURIComponent(gpuArg));
        if (unifiedArg) add('unified=' + encodeURIComponent(unifiedArg));
        return out;
    };
    if (isDev) {
        mainWindow.loadURL(withGpu('http://localhost:3000'));
        mainWindow.webContents.openDevTools();
        mainWindow.once('ready-to-show', () => { mainWindow.show(); });
    } else {
        // 启动页（Photoshop 风格）已经单独显示，主窗口保持隐藏到内容就绪，
        // 不再需要一个"Loading..."的占位页面（那是旧做法，会闪一下白底）
        splash.progress(30, '正在启动本地服务…');
        server.listen(port, '127.0.0.1', () => {
            console.log(`SplatRoom server running at http://127.0.0.1:${port}`);
            splash.progress(55, '正在加载界面…');
            mainWindow.loadURL(withGpu(`http://127.0.0.1:${port}`));
            splash.armFallback(() => mainWindow);
        });
    }

    // 启动页与主窗口的两次 ready-to-show 都走同一个收尾（幂等）
    mainWindow.webContents.once('did-finish-load', () => {
        splash.progress(78, '正在初始化引擎…');
    });
    splash.registerStartupReady(() => mainWindow);

    // Show window when content is ready (prevents white flash)。
    // 同时收掉启动页（`finish` 内部会在主窗口还不可见时把它显示出来，幂等）。
    mainWindow.once('ready-to-show', () => {
        splash.finish(mainWindow);
    });

    // Handle window close: if there are unsaved changes, ask the user what to do.
    // The renderer exposes window.__splatroomIsDirty() and window.__splatroomRequestSave().
    mainWindow.on('close', (e) => {
        // already in the process of quitting - let it through
        if (isQuitting) {
            return;
        }

        e.preventDefault();

        const closeNow = () => {
            isQuitting = true;
            mainWindow.destroy();
            isQuitting = false;
        };

        const askClose = () => {
            dialog.showMessageBox(mainWindow, {
                type: 'question',
                buttons: ['保存', '不保存', '取消'],
                defaultId: 0,
                cancelId: 2,
                noLink: true,
                title: '未保存的更改',
                message: '当前场景有未保存的修改，确定要关闭 SplatRoom 吗？',
                detail: '如果关闭窗口，未保存的修改将会丢失。'
            }).then(({ response }) => {
                if (response === 2) {
                    // cancel - keep the window open
                    return;
                }
                if (response === 1) {
                    // discard changes and close
                    closeNow();
                    return;
                }
                // response === 0 - save then close
                mainWindow.webContents.executeJavaScript(
                    'window.__splatroomRequestSave ? window.__splatroomRequestSave() : false'
                ).then((saved) => {
                    // only close if the save actually completed (false = user cancelled)
                    if (saved) {
                        closeNow();
                    }
                }).catch(() => {
                    // save failed or was cancelled - keep the window open
                });
            });
        };

        // query the renderer for unsaved changes
        mainWindow.webContents.executeJavaScript(
            'window.__splatroomIsDirty ? window.__splatroomIsDirty() : false'
        ).then((dirty) => {
            if (!dirty) {
                closeNow();
            } else {
                askClose();
            }
        }).catch(() => {
            // if we can't determine the state, close anyway (safe default)
            closeNow();
        });
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
}

app.whenReady().then(() => {
    // **先把启动页显示出来**（在静态服务与渲染器之前）—— 用户双击后立刻有东西看，
    // 进度与左下角的加载信息由 `electron-splash.js` 按真实阶段推进。
    splash.show();
    splash.progress(8, '正在启动 SplatRoom…');

    // Native output-folder picker for multi-file exports (keyframe images).
    // Using the main-process dialog instead of the File System Access API in
    // the renderer: the web picker requires a transient user activation that
    // is frequently lost after await chains, making it silently fail and
    // falling back to one save dialog per file. Registered once here so
    // re-created windows (macOS activate) do not re-register the handlers.
    ipcMain.handle('splatroom:pick-directory', async () => {
        if (!mainWindow) return null;
        const result = await dialog.showOpenDialog(mainWindow, {
            title: 'Select output folder',
            buttonLabel: 'Select Folder',
            properties: ['openDirectory', 'createDirectory']
        });
        if (result.canceled || result.filePaths.length === 0) {
            return null;
        }
        return result.filePaths[0];
    });

    // Write one exported file into the chosen output folder.
    ipcMain.handle('splatroom:write-file', async (event, dirPath, filename, data) => {
        if (typeof dirPath !== 'string' || typeof filename !== 'string') {
            throw new Error('invalid write-file arguments');
        }
        // Defensive: never allow the renderer to write outside the picked folder.
        const safeName = path.basename(filename);
        const filePath = path.join(dirPath, safeName);
        await fs.promises.writeFile(filePath, Buffer.from(data));
        return filePath;
    });

    createWindow();
});

// GPU / 工具进程崩溃：GPU 进程一死，所有 WebGL 上下文一起失效（渲染器侧的
// `contextlost` 弹窗是同一个事件的下游），画面会停在最后一帧或一张白板上。
app.on('child-process-gone', (event, details) => {
    if (!details) {
        return;
    }
    const log = logCrash('child-process-gone', JSON.stringify(details));
    if (details.type !== 'GPU' || details.reason === 'clean-exit') {
        return;
    }
    // 60 秒内只提示一次：GPU 进程崩溃后 Chromium 会重启它，可能连着来几条。
    if (Date.now() - gpuCrashNoticeAt < 60000) {
        return;
    }
    gpuCrashNoticeAt = Date.now();
    crashDialog({
        title: '显卡进程崩溃',
        message: `GPU 进程退出了（${details.reason}）—— 3D 视图会失效或变白。`,
        detail: crashDetailText(details.reason, `type=${details.type} log=${log}`)
    });
});

// 主进程自身的异常：默认行为是直接死掉（窗口无声消失）。先记账再告诉用户。
let mainProcessErrorShown = false;
process.on('uncaughtException', (error) => {
    const log = logCrash('main-uncaughtException', error && error.stack ? error.stack : String(error));
    if (mainProcessErrorShown) {
        return;
    }
    mainProcessErrorShown = true;
    crashDialog({
        title: 'SplatRoom 内部错误',
        message: '主进程抛出了一个未捕获的异常，程序可能已经不稳定。',
        detail: crashDetailText(String(error && error.message ? error.message : error), `log=${log}`)
    });
});

app.on('window-all-closed', () => {
    if (server) {
        server.close();
    }
    app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});
