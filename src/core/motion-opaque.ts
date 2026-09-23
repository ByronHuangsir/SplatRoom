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
//   window.__SPLATROOM_MOTION_OPAQUE__ = true        强制打开（A/B 用，不用重新打包）
//   window.__SPLATROOM_MOTION_OPAQUE__ = false       强制关掉
//   motionOpaque.enabled                            程序入口（套件用）
//
// **默认关闭**（2026-09-21 用户反馈"看着太难受了"）：这条路运动帧失去半透明与软边，
// 硬边在运动时还会闪（时间走样），观感代价太大，不该由我替用户默认开启。
// 想要"猛甩时顺序也不错"这条收益时再开；更好的做法是**按转速门限**只在甩得很快时才切
// （见 docs/perf/交互期降级-实现与实测.md §6.13 末尾）。

import { BLEND_NONE, BLEND_PREMULTIPLIED } from 'playcanvas';

const DEFAULT_ALPHA_CLIP = 0.5;

/**
 * 运动期"不依赖顺序"的两种写法（2026-09-22 第十九轮补上 `stochastic`）：
 *
 *   `off`        关掉这条路 —— 运动帧照常 alpha 混合、照常排序，顺序必然落后 ω·λ（用户报的"旋转时错序"）。
 *   `stochastic` **1 spp 随机透明**：以概率 = alpha 保留片元、其余丢弃，写不透明、深度测试定可见性。
 *                覆盖率在期望上无偏（E = α·C + (1−α)·B）⇒ 观感接近正常混合，只是有细颗粒噪点。
 *                **这就是上游 SuperSplat 运动帧的做法**（`projected-splat-renderer.ts:874`
 *                `setStochastic(scene.movingRender)` + `projected-splat-shader.ts` 的 `STOCHASTIC` 分支），
 *                也是"旋转时看不到错序"的**结构性**原因：运动帧根本不依赖顺序。
 *   `clip`       硬边裁剪（A 方案，2026-09-21）：低于 `alphaClip` 直接丢。更省（无噪声），
 *                但边缘硬、很透明的东西会变稀疏 —— 上一轮用户看过之后说"太难受"，所以不再是默认。
 */
type MotionMode = 'off' | 'stochastic' | 'clip';

/**
 * `alpha` = `norm * color.a`，而 `norm = exp(-A)`（`A` = 归一化半径平方）⇒ **足迹边缘处
 * alpha ≈ 0.368**。所以下限低于 0.368 等于"整块足迹全留"（只是把边缘 alpha 被压低的那些丢掉），
 * 高于它才会真正把高斯缩小。0.5 对应半径 ≈ 0.83 倍，是"保覆盖 + 硬边"的折中。
 */
class MotionOpaque {
    /**
     * 默认**随机透明**：这条路是"旋转时不出现错序"的唯一结构性办法（顺序本来就追不上），
     * 而随机透明的观感代价远小于硬边裁剪。设置面板里给了三档，用户可随时关掉。
     */
    mode: MotionMode = 'stochastic';

    /** alpha 下限（只对 `clip` 模式有效；见上面的取值说明） */
    alphaClip = DEFAULT_ALPHA_CLIP;

    /** 诊断：上一帧实际是否处于不透明路径 */
    applied = false;

    /** 当前生效的下限（含运行时覆盖） */
    get effectiveAlphaClip() {
        const override = (globalThis as any).__SPLATROOM_MOTION_ALPHA_CLIP__;
        return typeof override === 'number' && Number.isFinite(override) ? override : this.alphaClip;
    }

    /**
     * 当前生效的模式。优先级：
     *   `__SPLATROOM_MOTION_MODE__ = 'off' | 'clip' | 'stochastic'`（新逃生开关，探针/套件用）
     * → `__SPLATROOM_MOTION_OPAQUE__ = true | false`（旧逃生开关，历史包袱：true 等价 `clip`）
     * → `this.mode`（设置面板/程序入口）
     */
    get effectiveMode(): MotionMode {
        const mode = (globalThis as any).__SPLATROOM_MOTION_MODE__;
        if (mode === 'off' || mode === 'clip' || mode === 'stochastic') {
            return mode;
        }
        const hatch = (globalThis as any).__SPLATROOM_MOTION_OPAQUE__;
        if (hatch === true) {
            return 'clip';
        }
        if (hatch === false) {
            return 'off';
        }
        return this.mode;
    }

    /**
     * 旧接口兼容（2026-09-21 那批套件/探针用的就是 `enabled`）：
     *   读 = 这条路是否开着（mode !== 'off'）；写 true = 切到 `clip`（当时只有这一种写法）。
     * 保留它是为了**不让旧断言静默失效**（直接删掉的话 `x.enabled = true` 会变成无害的无效赋值）。
     */
    get enabled() {
        return this.mode !== 'off';
    }

    set enabled(value: boolean) {
        this.mode = value ? 'clip' : 'off';
    }

    /**
     * 当前是否允许启用。语义是**三态**：
     *   `__SPLATROOM_MOTION_OPAQUE__ === true`  → 强制开（覆盖 `enabled`）
     *   `__SPLATROOM_MOTION_OPAQUE__ === false` → 强制关（覆盖 `enabled`）
     *   未设置 → 用 `effectiveMode !== 'off'`
     */
    get active() {
        return this.effectiveMode !== 'off';
    }
}

/**
 * 把一个 splat 材质切到/切回"运动期不透明"状态。**幂等**：状态没变就不碰材质
 * （`blendType` 的 setter 会重建 mesh instance 的 key，不该每帧调）。
 *
 * 原始 blend/depth 状态存在材质对象上（`__srMotionOpaqueOrig`），恢复时按原值还原 ——
 * 这样即使将来上游把默认值改掉（例如开了 dither 的 `BLEND_NONE`），恢复也不会跑偏。
 */
const applyMotionOpaqueMaterial = (material: any, on: boolean, alphaClip: number, mode: MotionMode = 'clip') => {
    if (!material) {
        return;
    }
    const stochastic = on && mode === 'stochastic';
    const params = { on, alphaClip, stochastic };
    const prev = material.__srMotionOpaque as { on: boolean, alphaClip: number, stochastic: boolean } | undefined;
    if (prev && prev.on === params.on && prev.alphaClip === params.alphaClip && prev.stochastic === params.stochastic) {
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
    material.setParameter('uMotionStochastic', stochastic ? 1 : 0);
    material.blendType = on ?
        BLEND_NONE :
        (orig.blendType === BLEND_NONE ? BLEND_PREMULTIPLIED : orig.blendType);
    material.depthWrite = on ? true : orig.depthWrite;
};

/**
 * 把设置面板那条通路接上（Scene 构造函数里调一次）：
 *   `motionRender.setMode`（fire）改模式并回灌 `motionRender.modeChanged`；
 *   `motionRender.mode`（invoke）给面板取初值。
 * 模式**不写偏好、不进 `.ssproj`**（纯渲染期行为，和上一轮的处理一致）。
 */
const registerMotionOpaqueEvents = (events: any, motionOpaque: MotionOpaque) => {
    events.on('motionRender.setMode', (value: string) => {
        if (value === 'off' || value === 'clip' || value === 'stochastic') {
            motionOpaque.mode = value;
        }
        events.fire('motionRender.modeChanged', motionOpaque.effectiveMode);
    });
    events.function('motionRender.mode', () => motionOpaque.effectiveMode);
};

export { MotionOpaque, applyMotionOpaqueMaterial, registerMotionOpaqueEvents, DEFAULT_ALPHA_CLIP };
export type { MotionMode };
