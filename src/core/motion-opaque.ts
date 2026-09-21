// 运动期"不依赖顺序"的渲染（A 方案，2026-09-21 第九轮）。
//
// 问题：顺序是一次快照，而快照要 λ 毫秒才能落地（20M 实测 λ≈155 ms）。快速旋转时顺序必然落后
// 几十度 ⇒ 远侧高斯被合成在前面（用户报的"背面内容跑到前面"）。延迟补偿只能把系统性偏差补掉
// （实测典型帧错位 0.199，换向段还有 0.17），**没法把 λ 变短**。
//
// 这条路的思路完全不同：**运动帧干脆不要顺序** ——
//   • 材质切到 `BLEND_NONE`（不透明）+ `depthWrite = true`；
//   • 片元着色器（自写的 `gsplatPS`）加一个 alpha 下限，低于它直接丢弃；
//   • 于是每个像素由**深度测试**决定谁可见 ⇒ 画出来的结果与绘制顺序**无关**。
// 代价是运动帧失去半透明与软边（看起来更"实"、边缘更硬、很透明的东西会变稀疏），
// 停手后立刻恢复正常的 alpha 混合。这正是上游 SuperSplat 运动帧的做法（他们还有 1 spp 随机采样
// 让覆盖率无偏，这里没做）。
//
// 为什么必须自己实现 alpha 下限：引擎的 `alphaClipForward` 在本 fork 是 **no-op**
// （引擎拿它做 `clipCorner`，而我们替换了那个顶点入口），见 docs/perf/交互期降级-实现与实测.md §2。
//
// 三个开关（都不写偏好、不进 `.ssproj`、不影响导出，纯渲染期行为）：
//   window.__SPLATROOM_MOTION_OPAQUE__ = false       整体关掉，回到"顺序 + alpha 混合"
//   window.__SPLATROOM_MOTION_ALPHA_CLIP__ = 0.5     调 alpha 下限（0.37 ≈ 保留整个足迹，越大越稀）
//   motionOpaque.enabled                            同一开关的程序入口（套件用）

import { BLEND_NONE, BLEND_PREMULTIPLIED } from 'playcanvas';

const DEFAULT_ALPHA_CLIP = 0.5;

/**
 * `alpha` = `norm * color.a`，而 `norm = exp(-A)`（`A` = 归一化半径平方）⇒ **足迹边缘处
 * alpha ≈ 0.368**。所以下限低于 0.368 等于"整块足迹全留"（只是把边缘 alpha 被压低的那些丢掉），
 * 高于它才会真正把高斯缩小。0.5 对应半径 ≈ 0.83 倍，是"保覆盖 + 硬边"的折中。
 */
class MotionOpaque {
    /** master switch（逃生开关 `window.__SPLATROOM_MOTION_OPAQUE__ = false` 也走这里） */
    enabled = true;

    /** alpha 下限（见上面的取值说明） */
    alphaClip = DEFAULT_ALPHA_CLIP;

    /** 诊断：上一帧实际是否处于不透明路径 */
    applied = false;

    /** 当前生效的下限（含运行时覆盖） */
    get effectiveAlphaClip() {
        const override = (globalThis as any).__SPLATROOM_MOTION_ALPHA_CLIP__;
        return typeof override === 'number' && Number.isFinite(override) ? override : this.alphaClip;
    }

    /** 当前是否允许启用（含逃生开关） */
    get active() {
        return this.enabled && (globalThis as any).__SPLATROOM_MOTION_OPAQUE__ !== false;
    }
}

/**
 * 把一个 splat 材质切到/切回"运动期不透明"状态。**幂等**：状态没变就不碰材质
 * （`blendType` 的 setter 会重建 mesh instance 的 key，不该每帧调）。
 *
 * 原始 blend/depth 状态存在材质对象上（`__srMotionOpaqueOrig`），恢复时按原值还原 ——
 * 这样即使将来上游把默认值改掉（例如开了 dither 的 `BLEND_NONE`），恢复也不会跑偏。
 */
const applyMotionOpaqueMaterial = (material: any, on: boolean, alphaClip: number) => {
    if (!material) {
        return;
    }
    const params = { on, alphaClip };
    const prev = material.__srMotionOpaque as { on: boolean, alphaClip: number } | undefined;
    if (prev && prev.on === params.on && prev.alphaClip === params.alphaClip) {
        return;
    }
    if (material.__srMotionOpaqueOrig === undefined) {
        material.__srMotionOpaqueOrig = {
            blendType: material.blendType,
            depthWrite: material.depthWrite
        };
    }
    material.__srMotionOpaque = params;

    const orig = material.__srMotionOpaqueOrig;
    material.setParameter('uMotionOpaque', on ? 1 : 0);
    material.setParameter('uMotionAlphaClip', alphaClip);
    material.blendType = on ?
        BLEND_NONE :
        (orig.blendType === BLEND_NONE ? BLEND_PREMULTIPLIED : orig.blendType);
    material.depthWrite = on ? true : orig.depthWrite;
};

export { MotionOpaque, applyMotionOpaqueMaterial, DEFAULT_ALPHA_CLIP };
