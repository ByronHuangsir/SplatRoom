/**
 * 从引擎设备读"这台机器的事实"，喂给 `src/core/splat-tier.ts` 做分级。
 *
 * 全部字段都是**可选软信号**：取不到就留 `null`，分级会退化到保守判断（见 splat-tier 的单测）。
 * `max*` 三项来自 `graphicsDevice.limits`（WebGPU 与 WebGL2 都有）；
 * `deviceMemoryGb` 是 `navigator.deviceMemory`（Chrome 上限报 8）；
 * `renderer` 用来识别集显/共享显存。
 */
import type { DeviceFacts } from './splat-tier';

/**
 * 读设备事实。
 *
 * @param device - `app.graphicsDevice`（any：WebGPU 的 adapter 信息与 WebGL2 的 unmaskedRenderer 不在同一处）
 * @returns 分级用的设备事实
 */
export const readDeviceFacts = (device: any): DeviceFacts => {
    const limits = device?.limits ?? {};
    const nav: any = typeof navigator === 'undefined' ? {} : navigator;
    const adapter = device?.adapter?.info ?? device?.adapter ?? null;
    const renderer = device?.unmaskedRenderer ??
        (adapter ? [adapter.vendor, adapter.architecture, adapter.device, adapter.description].filter(Boolean).join(' ') : null);
    return {
        maxStorageBufferBindingSize: typeof limits.maxStorageBufferBindingSize === 'number' ? limits.maxStorageBufferBindingSize : null,
        maxBufferSize: typeof limits.maxBufferSize === 'number' ? limits.maxBufferSize : null,
        maxTextureDimension2D: typeof limits.maxTextureDimension2D === 'number' ? limits.maxTextureDimension2D : null,
        deviceMemoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
        hardwareConcurrency: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
        renderer: renderer ? String(renderer) : null,
        isWebGPU: !!device?.isWebGPU,
        // 排障/套件用：`window.__SPLATROOM_DEVICE_CLASS__ = 'low' | 'mid' | 'high'`
        forcedClass: (globalThis as any).__SPLATROOM_DEVICE_CLASS__ ?? null
    };
};
