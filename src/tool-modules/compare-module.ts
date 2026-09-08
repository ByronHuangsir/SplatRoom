import { Events } from '../events';

/**
 * 对比工具模块（模块 1）— "高斯训练对比-飞羽实验室"
 *
 * 实现：src/compare/（独立 PlayCanvas 应用，`?mode=compare` 启动）。
 * 此处只负责工具菜单入口：点击菜单 → 打开新窗口加载 ?mode=compare。
 */
export const registerCompareModule = (events: Events) => {
    // open the comparison tool in a separate browser window (plugin entry)
    events.on('compare.open', () => {
        const u = new URL(window.location.href);
        u.searchParams.set('mode', 'compare');
        window.open(u.toString(), '_blank')?.focus();
    });
};
