const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

// Detect dev mode
const isDev = !fs.existsSync(path.join(__dirname, 'dist', 'index.html'));

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
 * Serves files from the dist/ directory and the project root (for static/ files).
 * Returns 200 with correct MIME type or 404.
 */
function createStaticServer() {
    return http.createServer((req, res) => {
        // Parse URL, strip query strings
        let urlPath = req.url.split('?')[0];

        // Default to index.html
        if (urlPath === '/' || urlPath === '') {
            urlPath = '/index.html';
        }

        // Security: prevent directory traversal
        const safePath = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, '');

        // Try dist/ first, then fall back to project root
        let filePath = path.join(__dirname, 'dist', safePath);

        if (!fs.existsSync(filePath)) {
            filePath = path.join(__dirname, safePath);
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        fs.readFile(filePath, (err, data) => {
            if (err) {
                // For SPA fallback: serve index.html for non-file routes
                if (err.code === 'ENOENT' && !path.extname(safePath)) {
                    fs.readFile(path.join(__dirname, 'dist', 'index.html'), (err2, data2) => {
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
                'Cache-Control': 'no-cache',
                'Access-Control-Allow-Origin': '*'
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
            preload: path.join(__dirname, 'electron-preload.js')
        },
        autoHideMenuBar: true
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
    if (isDev) {
        mainWindow.loadURL('http://localhost:3000');
        mainWindow.webContents.openDevTools();
        mainWindow.once('ready-to-show', () => { mainWindow.show(); });
    } else {
        // Show a loading screen while server starts
        mainWindow.loadURL(`data:text/html;charset=utf-8,
            <html>
                <body style="background:#1a1a2e;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif;">
                    <div style="text-align:center;color:#e0e0e0;">
                        <h2 style="margin:0 0 16px 0;font-weight:300;">SplatRoom</h2>
                        <p style="margin:0;color:#888;">Loading...</p>
                    </div>
                </body>
            </html>
        `);

        server.listen(port, '127.0.0.1', () => {
            console.log(`SplatRoom server running at http://127.0.0.1:${port}`);
            mainWindow.loadURL(`http://127.0.0.1:${port}`);
        });
    }

    // Show window when content is ready (prevents white flash)
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    // Handle window close: bypass beforeunload confirmation
    mainWindow.on('close', (e) => {
        if (!isQuitting) {
            isQuitting = true;
            e.preventDefault();
            mainWindow.destroy();
            isQuitting = false;
        }
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

app.whenReady().then(createWindow);

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
