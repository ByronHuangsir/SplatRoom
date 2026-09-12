import { Events } from '../core/events';

/**
 * 高斯合并工具（模块 3）— 独立窗口合并工作台
 *
 * 实现：src/merge/（独立应用，`?mode=merge` 启动）。
 * 菜单点击 → 打开新窗口加载 ?mode=merge。
 */
export const registerMergeModule = (events: Events) => {
    events.on('merge.open', () => {
        const u = new URL(window.location.href);
        u.searchParams.set('mode', 'merge');
        window.open(u.toString(), '_blank')?.focus();
    });
};
