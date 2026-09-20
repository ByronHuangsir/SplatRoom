/**
 * 每个高斯状态字节的位定义（CPU/GPU 镜像）。
 *
 * 单独一个模块是为了让 **worker 也能用同一份位定义**：`splat-state.ts` 里那份枚举要
 * `import { Texture } from 'playcanvas'`，worker 一旦间接引到 playcanvas，整包引擎就会被
 * 打进 worker bundle（几 MB）。所以位值住在这里，`splat-state.ts` 的 `State` 枚举直接引用它们，
 * 位值只有一处定义、不会漂移。
 */
export const STATE_SELECTED = 1;
export const STATE_LOCKED = 2;
export const STATE_DELETED = 4;
