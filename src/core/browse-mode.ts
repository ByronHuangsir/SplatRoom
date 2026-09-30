// 浏览态（browse）的唯一真源（M3-3）。
//
// 为什么需要这个模块：在此之前"浏览态"只是**一个 UI 概念** —— 手柄的 browse 子模式
// （`src/gamepad/gamepad-controller.ts` 的 `subMode`）会把编辑器 UI 全隐藏 + 进全屏，
// 但渲染层**完全不知道**：它既读不到这个值（控制器只暴露了 config/mode/heightLocked/
// speedGear 四个 `events.function`），也没有任何一行把它接进 LOD 闸门或帧预算。
// 于是"用户正沉浸地看模型"和"用户正准备框选删除"在渲染眼里是同一件事。
//
// 这里把它变成一等状态，并给出**三个进入途径**（后两个是新增的）：
//   1. 手柄 browse 子模式（原有）；
//   2. `?browse=1` URL 逃生门（探针/排障用，也方便没有手柄的用户）；
//   3. `events.fire('browse.set', true)`（设置面板开关）。
//
// 消费方（`Scene.updateLodSwitching`）只读 `browse.active` 这一个查询点，
// 与 unified 通路的"开关唯一来源"纪律一致（见 scene.ts 的 `_unifiedMaterialEnabled` 注释）。
//
// 语义边界（很重要，别越界）：
//   浏览态 = **只看不编辑**。它唯一的作用是允许渲染侧用更便宜的数据/更粗的代理层；
//   一旦有任何编辑动作发生，代理层必须立刻让位给全分辨率（见 editor-lod.ts 的闸门）。

import type { Events } from './events';

/** URL / 探针用的强制开关：`?browse=1|0`，或 `window.__SPLATROOM_BROWSE__ = true|false`。 */
export const BROWSE_GLOBAL = '__SPLATROOM_BROWSE__';

/** 读全局强制值：true / false 强制，null = 不干预（交给 UI / 手柄）。 */
const forced = (): boolean | null => {
    const v = (globalThis as any)[BROWSE_GLOBAL];
    return v === true ? true : (v === false ? false : null);
};

/**
 * 注册浏览态。返回的对象给需要直接持有状态的调用方（Scene）用，
 * 其余一切交互都走 events。
 */
export const registerBrowseMode = (events: Events) => {
    let gamepadBrowse = false;
    let uiBrowsing = false;
    let active = false;

    const evaluate = () => {
        const f = forced();
        const next = f !== null ? f : (uiBrowsing || gamepadBrowse);
        if (next === active) return;
        active = next;
        events.fire('browse.changed', active);
    };

    // 查询点（唯一）：`events.invoke('browse.active') === true`
    //
    // 每次查询都先 `evaluate()` 一次：全局强制值（`window.__SPLATROOM_BROWSE__`）允许在
    // 运行时被探针/控制台改写，而改写它的人不会去 fire 事件。让查询本身自愈，
    // 下游（LOD 闸门要快照 undo 栈、预算控制器要 setActive）就不会拿到过期状态。
    // evaluate 只在值真的变了才 fire，代价是一次布尔比较。
    events.function('browse.active', () => {
        evaluate();
        return active;
    });

    // 设置面板 / 探针
    events.on('browse.set', (value: boolean) => {
        uiBrowsing = !!value;
        evaluate();
    });

    // 手柄 browse 子模式（进入手柄模式时控制器会 fire 一次 'normal'，所以这里能自动复位）
    events.on('gamepad.subModeChanged', (mode: string) => {
        gamepadBrowse = mode === 'browse';
        evaluate();
    });

    // 全局开关也可以在运行时被改（探针）；每帧的查询是 `events.invoke`，
    // 这里额外挂一个 setActive 让持有者能同步预算控制器。
    evaluate();

    return {
        get active() {
            // 全局强制值每次都重读：探针会在场景构造之后才设它
            const f = forced();
            return f !== null ? f : active;
        },
        /** 手动切换（设置面板）。 */
        set(value: boolean) {
            uiBrowsing = !!value;
            evaluate();
        },
        /** 手柄子模式联动（供 GamepadController 之外的地方直接同步）。 */
        setGamepad(value: boolean) {
            gamepadBrowse = !!value;
            evaluate();
        },
        /** 当前是否由 UI/手柄置位（不含全局强制）。 */
        get uiActive() {
            return active;
        }
    };
};

export type BrowseMode = ReturnType<typeof registerBrowseMode>;
