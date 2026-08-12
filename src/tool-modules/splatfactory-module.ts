import { Events } from '../events';

/**
 * 格式工厂（邵青）模块（模块 2）— 3D 高斯格式转换
 *
 * 实现：src/splatfactory/（独立应用，`?mode=splatfactory` 启动）。
 * 菜单点击 → 打开新窗口加载 ?mode=splatfactory。
 */
export const registerSplatFactoryModule = (events: Events) => {
    events.on('splatfactory.open', () => {
        const u = new URL(window.location.href);
        u.searchParams.set('mode', 'splatfactory');
        window.open(u.toString(), '_blank')?.focus();
    });
};
