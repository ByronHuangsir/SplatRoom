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
