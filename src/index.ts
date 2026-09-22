import './ui/scss/style.scss';
import { version as pcuiVersion, revision as pcuiRevision } from '@playcanvas/pcui';
import { version as stVersion, revision as stRevision } from '@playcanvas/splat-transform';
import { version as engineVersion, revision as engineRevision } from 'playcanvas';

import { main } from './main';
import { version as appVersion } from '../package.json';

// print out versions of dependent packages
// NOTE: add dummy style reference to prevent tree shaking
console.log(`SplatRoom v${appVersion} | SplatTransform v${stVersion} (${stRevision}) | Engine v${engineVersion} (${engineRevision}) | PCUI v${pcuiVersion} (${pcuiRevision})`);

main();

// 启动页收尾（2026-09-22）：等首帧真的画出来之后再告诉主进程 ——
// 两级 rAF 保证"上一次 DOM/画布改动已经 paint 过"，用户看到主窗口时不会是半成品。
// 浏览器里跑（没有 Electron preload）时 `splatroomStartup` 不存在，静默跳过。
const notifyStartupReady = () => {
    const bridge = (window as any).splatroomStartup;
    if (bridge && typeof bridge.ready === 'function') {
        bridge.ready();
    }
};
if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(notifyStartupReady));
} else {
    setTimeout(notifyStartupReady, 0);
}
