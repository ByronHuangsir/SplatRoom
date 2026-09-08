import { Events } from '../events';
import { registerCompareModule } from './compare-module';
import { registerMergeModule } from './merge-module';
import { registerSplatFactoryModule } from './splatfactory-module';

/**
 * 工具模块（Tools menu plugins）
 *
 * 每个工具菜单项对应一个 ToolModule。接入新模块只需：
 *   1. 在 src/tool-modules/ 下新建 `xxx-module.ts`（导出 registerXxxModule）
 *   2. 在下方 TOOL_MODULES 数组里加一项（title 为菜单显示名）
 *   3. 在 registerToolModules() 中调用其 register
 * 菜单项顺序 = TOOL_MODULES 数组顺序。
 */
export interface ToolModule {
    /** 唯一标识（建议 kebab-case） */
    id: string;
    /** 菜单显示名称 */
    title: string;
    /** 点击菜单项时执行（通常 fire 一个模块事件） */
    open: (events: Events) => void;
}

/** 工具模块注册表 —— 新模块在这里追加，菜单顺序按数组顺序 */
export const TOOL_MODULES: ToolModule[] = [
    {
        id: 'compare',
        title: '高斯训练对比-飞羽实验室',
        open: events => events.fire('compare.open')
    },
    {
        id: 'splatfactory',
        title: '格式工厂（邵青）',
        open: events => events.fire('splatfactory.open')
    },
    {
        id: 'merge',
        title: '高斯合并工具-飞羽实验室',
        open: events => events.fire('merge.open')
    }
];

/** 注册所有工具模块的事件（在 main() 中调用一次） */
export const registerToolModules = (events: Events) => {
    registerCompareModule(events);
    registerSplatFactoryModule(events);
    registerMergeModule(events);
};
