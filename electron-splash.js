/**
 * 启动页（Photoshop 风格）—— 主进程侧的窗口与进度管理。
 *
 * 用户要求（2026-09-22）：加一个启动页（素材 `static/splash.png`，2848×1600），
 * 启动时有**真实的加载进度**，**加载信息显示在左下角**，让用户等待时有缓冲。
 *
 * 设计要点：
 *   • 独立小窗口（`frame: false` / 居中 / `alwaysOnTop` / 不进任务栏），**在主窗口之前**创建
 *     ⇒ 双击后立刻有东西看，不用等静态服务与渲染器；
 *   • 进度来自**真实阶段**：本地服务 → 主窗口加载 → 渲染器初始化 → 首帧就绪；
 *   • 渲染器就绪由页面通过 preload 暴露的 `window.splatroomStartup.ready()` 主动上报
 *     （见 `electron-preload.js` 与 `src/index.ts`），另有 12 s 兜底，不会永远卡在启动页；
 *   • 进度推送走 `webContents.executeJavaScript`（不依赖启动页里有没有 ipc 权限）；
 *   • **所有导出函数整体兜住异常** —— 启动页坏了绝不能挡住应用启动。
 */

const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const WIDTH = 996;    // 2848×1600 的 0.35 倍，16:9
const HEIGHT = 560;
const READY_FALLBACK_MS = 12000;

let splashWindow = null;
let mainWindowRef = null;
let finished = false;
let fallbackTimer = null;
let last = { pct: 0, text: '正在启动…' };

const push = () => {
    try {
        if (!splashWindow || splashWindow.isDestroyed()) {
            return;
        }
        splashWindow.webContents
            .executeJavaScript(`window.__splashSet && window.__splashSet(${last.pct}, ${JSON.stringify(last.text)});`)
            .catch(() => { /* 窗口正在关闭时忽略 */ });
    } catch (e) {
        // 推送失败无所谓，别影响启动
    }
};

const show = () => {
    try {
        if (splashWindow && !splashWindow.isDestroyed()) {
            return;
        }
        splashWindow = new BrowserWindow({
            width: WIDTH,
            height: HEIGHT,
            frame: false,
            resizable: false,
            movable: true,
            maximizable: false,
            minimizable: false,
            fullscreenable: false,
            skipTaskbar: true,
            alwaysOnTop: true,
            center: true,
            show: false,
            backgroundColor: '#14161a',
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                backgroundThrottling: false
            }
        });
        splashWindow.once('ready-to-show', () => {
            try {
                if (splashWindow && !splashWindow.isDestroyed()) {
                    splashWindow.show();
                    push();
                }
            } catch (e) { /* 忽略 */ }
        });
        splashWindow.loadFile(path.join(__dirname, 'static', 'splash.html')).catch((e) => {
            console.error('[splash] loadFile failed:', e && e.message);
        });
    } catch (e) {
        console.error('[splash] show failed:', e && e.message);
        splashWindow = null;
    }
};

/** 设置进度（0-100）与左下角的加载信息（进度只增不减） */
const progress = (pct, text) => {
    try {
        last = { pct: Math.max(last.pct, pct), text: text || last.text };
        push();
    } catch (e) { /* 忽略 */ }
};

/** 主窗口内容就绪时调用：收掉启动页并把主窗口显示出来（幂等） */
const finish = (mainWindow) => {
    try {
        mainWindowRef = mainWindow || mainWindowRef;
        if (finished) {
            return;
        }
        finished = true;
        if (fallbackTimer) {
            clearTimeout(fallbackTimer);
            fallbackTimer = null;
        }
        progress(100, '准备就绪');
        setTimeout(() => {
            try {
                if (splashWindow && !splashWindow.isDestroyed()) {
                    splashWindow.close();
                }
                splashWindow = null;
                if (mainWindowRef && !mainWindowRef.isDestroyed() && !mainWindowRef.isVisible()) {
                    mainWindowRef.show();
                }
            } catch (e) {
                console.error('[splash] finish failed:', e && e.message);
            }
        }, 260);
    } catch (e) {
        console.error('[splash] finish failed:', e && e.message);
    }
};

/** 注册渲染器"启动完成"的上报（`window.splatroomStartup.ready()`） */
const registerStartupReady = (getMainWindow) => {
    try {
        mainWindowRef = getMainWindow;
        ipcMain.on('splatroom:startup-ready', () => {
            const win = getMainWindow();
            if (win) {
                finish(win);
            }
        });
    } catch (e) {
        console.error('[splash] registerStartupReady failed:', e && e.message);
    }
};

/** 主窗口开始加载后调用：兜底计时（渲染器万一没上报也不会永远停在启动页） */
const armFallback = (getMainWindow) => {
    try {
        if (fallbackTimer) {
            return;
        }
        fallbackTimer = setTimeout(() => {
            const win = getMainWindow();
            if (win) {
                finish(win);
            } else if (splashWindow && !splashWindow.isDestroyed()) {
                splashWindow.close();
                splashWindow = null;
            }
        }, READY_FALLBACK_MS);
    } catch (e) { /* 忽略 */ }
};

module.exports = { show, progress, finish, registerStartupReady, armFallback, isOpen: () => !!splashWindow };
