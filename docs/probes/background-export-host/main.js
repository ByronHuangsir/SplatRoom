// 探针专用的 Electron 主进程（**不是产品代码**；Electron 只认"目录 + package.json"这种 app 形态）。
//
// 为什么需要它：Electron 不支持 CDP 的 `Browser.setWindowBounds`（那是 Chrome 浏览器级的），
// 所以"最小化窗口"只能由主进程 `win.minimize()` 发起。这个宿主做三件事：
//   • 载入已经在跑的静态服务（默认 http://127.0.0.1:3621/?gpu=webgpu）
//   • `webPreferences.backgroundThrottling` 由 argv 决定 —— A/B 的就是产品里那个开关
//   • 开一个本地控制端口，接受 `GET /minimize` / `GET /restore` / `GET /state`
//   • 调试端口用 `app.commandLine.appendSwitch` 打开（CLI 传参在某些启动方式下会被吞掉）
//
// usage: electron <hostDir> <backgroundThrottling:0|1> [appUrl] [controlPort] [debugPort]
const { app, BrowserWindow } = require('electron');
const http = require('http');

const argv = process.argv.slice(2);
const throttling = argv[0] !== '0';
const appUrl = argv[1] || 'http://127.0.0.1:3621/?gpu=webgpu';
const controlPort = Number(argv[2] || 9226);
const debugPort = Number(argv[3] || 9225);

console.log(`[bg-host] start throttling=${throttling} url=${appUrl} control=${controlPort} debug=${debugPort}`);

// 必须在 whenReady 之前
app.commandLine.appendSwitch('remote-debugging-port', String(debugPort));
app.commandLine.appendSwitch('remote-allow-origins', '*');

let win = null;
const state = { minimized: false, throttling, events: [] };

app.whenReady().then(() => {
    win = new BrowserWindow({
        width: 1400,
        height: 900,
        show: true,
        webPreferences: {
            backgroundThrottling: throttling,
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    win.loadURL(appUrl).then(
        () => console.log('[bg-host] loaded'),
        (e) => console.log('[bg-host] load error ' + e)
    );

    const server = http.createServer((req, res) => {
        const url = (req.url || '/').split('?')[0];
        if (url === '/minimize') {
            win.minimize();
            state.minimized = true;
            state.events.push({ at: Date.now(), what: 'minimize' });
            console.log('[bg-host] minimize');
            res.end('ok');
        } else if (url === '/restore') {
            win.restore();
            win.show();
            state.minimized = false;
            state.events.push({ at: Date.now(), what: 'restore' });
            console.log('[bg-host] restore');
            res.end('ok');
        } else if (url === '/state') {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({
                minimized: win.isMinimized(),
                visible: win.isVisible(),
                focused: win.isFocused(),
                backgroundThrottling: throttling,
                events: state.events
            }));
        } else {
            res.statusCode = 404;
            res.end('nope');
        }
    });
    server.listen(controlPort, '127.0.0.1', () => console.log('[bg-host] control ready'));
});

app.on('window-all-closed', () => {
    app.quit();
});
