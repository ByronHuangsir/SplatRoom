/**
 * 释放 splat 资源那些**流纹理的 CPU 侧副本**（无损、只省内存）。
 *
 * 为什么可以放（全部是量出来的，见 `docs/进度存档.md` 探针 74~76）：
 *   · 2000 万点模型导入后，渲染进程 7209MB 活堆里有 **1850MB** 是 7 张流纹理各自的
 *     `_levels[0]` CPU 数组（splatColor / transformA/B / 4 张 splatSH）；
 *     它们由引擎在 `GSplatResource` 构造时 `lock()` 分配、`unlock()` 上传，
 *     **上传之后再没有任何读取路径**（引擎的其余用途都走 GPU 侧）。
 *   · 唯一的"用途"是设备恢复时重新上传 —— 而本仓库对上下文丢失的处理是弹
 *     `doc.gpu-crashed` 提示"无法自恢复"（见 `src/scene/scene.ts` 的 `contextlost`），
 *     也就是说这份副本**并没有换来任何能力**。
 *
 * 只对大模型做（阈值 `RELEASE_MIN_SPLATS`）：小模型的这点内存在噪声里，不做无谓的风险面。
 * 幂等：释放过就把 `_levels[0]` 置空，再调用是空操作。
 */

/** 大于这个高斯数才释放（小模型不值得动它） */
export const RELEASE_MIN_SPLATS = 2_000_000;

/**
 * @returns 释放掉的字节数（0 = 没做任何事）
 */
export function releaseStreamCpuStorage(resource: any, numSplats: number): number {
    if (!resource || !(numSplats >= RELEASE_MIN_SPLATS)) {
        return 0;
    }
    const textures = resource.streams?.textures;
    if (!textures || typeof textures.forEach !== 'function') {
        return 0;
    }
    let freed = 0;
    textures.forEach((texture: any) => {
        const levels = texture?._levels;
        if (!Array.isArray(levels) || levels.length === 0) {
            return;
        }
        for (let i = 0; i < levels.length; i++) {
            const level = levels[i];
            // `_levels[i]` 就是那块 typed array 本身（不是 { data } 包装 —— 探针 74 就是在这里读错的）
            const bytes = level && typeof level.byteLength === 'number' ? level.byteLength : 0;
            if (bytes > 0) {
                freed += bytes;
                levels[i] = null;
            }
        }
    });
    return freed;
}
