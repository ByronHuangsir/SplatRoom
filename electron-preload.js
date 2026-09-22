// electron-preload.js
// Runs in the renderer process before the page loads.
// Disables beforeunload events so the window close button (X) always works,
// even when the scene has unsaved changes.
const { contextBridge, ipcRenderer } = require('electron');

// 启动页收尾信号（2026-09-22）：渲染器把首帧准备好后调 `window.splatroomStartup.ready()`，
// 主进程据此关掉启动页并显示主窗口（另有 12 s 兜底，见 electron-splash.js）。
contextBridge.exposeInMainWorld('splatroomStartup', {
    ready: () => {
        try {
            ipcRenderer.send('splatroom:startup-ready');
        } catch (e) {
            // 浏览器里跑 dist 时没有 ipc：忽略
        }
    }
});

// Override window.onbeforeunload and neuter addEventListener for 'beforeunload'
// This must run before the app's JS loads, which preload guarantees.
window.onbeforeunload = null;

// Intercept addEventListener to silently ignore beforeunload registrations
const originalAddEventListener = window.addEventListener.bind(window);
window.addEventListener = function (type, listener, options) {
    if (type === 'beforeunload') {
        // Silently skip beforeunload registrations
        return;
    }
    return originalAddEventListener(type, listener, options);
};

// Also override EventTarget.prototype.addEventListener for document-level handlers
const origETAdd = EventTarget.prototype.addEventListener;
EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (type === 'beforeunload') {
        return;
    }
    return origETAdd.call(this, type, listener, options);
};

// Expose a simple API to the renderer (optional, for future use)
contextBridge.exposeInMainWorld('electronApp', {
    platform: process.platform,
    isElectron: true
});

// Native file-system helpers for reliable multi-file export.
// Uses the main-process dialog (no user-activation constraints) and writes
// files through the main process instead of the File System Access API.
contextBridge.exposeInMainWorld('splatroomFS', {
    pickDirectory: () => ipcRenderer.invoke('splatroom:pick-directory'),
    writeFile: (dirPath, filename, data) => ipcRenderer.invoke('splatroom:write-file', dirPath, filename, data)
});
