import { Events } from '../events';
import { ElementType } from '../scene/element';
import { Scene } from '../scene/scene';
import { Splat } from '../splat/splat';

/**
 * 特效轨道管理器（SplatRoom 特效模块 v4）
 *
 * 特效轨道支持两个独立图层，可同时开启：
 *   - 开场（intro）：start 处 progress=1（粒子云）→ end 处 progress=0（完整模型）
 *     「从无到有」：粒子聚拢成为模型本身
 *   - 散场（outro）：start 处 progress=0（完整模型）→ end 处 progress=1（粒子云散开）
 *     「从有到无」：模型散开消失
 * 两图层可同时开启——时间线首尾各有特效；区间可独立拖动/调长、
 * 缓入/缓出、预设。
 *
 * 进度合并规则（同一帧同时落在两图层区间时取更"散开"的值）：
 *   progress = max(introProgress, outroProgress)
 *   - 开场前/散场后：1（粒子态）
 *   - 开场区间：1→0 渐变
 *   - 中间：0（完整模型）
 *   - 散场区间：0→1 渐变
 *
 * 驱动：监听 timeline.frame / timeline.time（旋转台渲染 prepareFrame 每帧
 * fire timeline.time），帧落在图层区间内即按缓入/缓出计算并应用散射进度。
 *
 * 事件：
 *   effects.setEnabled    — 开关图层 { which: 'intro'|'outro', enabled: boolean }
 *   effects.setClip       — 设置图层区间 { which, start, end }
 *   effects.setEasingIn   — 缓入开关 { which, enabled }
 *   effects.setEasingOut  — 缓出开关 { which, enabled }
 *   effects.setPreset     — 选择预设 { which, presetId }
 *   effects.getState      — 查询当前状态（供 UI 重建）
 *   effects.activeChanged — 粒子激活时强制持续渲染 { active: boolean }
 */

/** 散射预设（不同半径/风格/效果模式） */
export interface EffectPreset {
    id: string;
    title: string;
    /** 散射半径相对包围盒对角线的倍数 */
    radiusScale: number;
    /** 特效模式：0=默认散射，1=波纹开场，2=飘散散场 */
    mode: number;
    /** 效果高亮色（波纹/火花色）；null=使用模型本色 */
    color: [number, number, number] | null;
    /** 适用图层：intro=开场专用，outro=散场专用，both=通用（默认粒子化） */
    kind: 'intro' | 'outro' | 'both';
}

/**
 * 内置散射预设（保留默认粒子化，新增波纹开场与飘散散场）。
 *
 * 散场特效设计备注（后续新增散场预设时务必遵循）：
 *   散场动画必须是「渐进三段」过程——
 *     1. 特效加载（区间 0→~50%）：模型逐渐变成特效的初始样子
 *        （无突变、无提前爆散），effectTime 缓慢从 0 升到 ~0.2；
 *     2. 特效发展（~50%→~75%）：特效扩散/飘散进一步发展，
 *        effectTime 快速升到 1；
 *     3. 消散（~75%→100%）：透明度逐渐下降，到区间末尾完全消失。
 *   实现上由 applyAtFrame 的 outro 分支统一完成：
 *     - effectTime：前段缓入平方（初始加载），后段 smoothstep(0.5,0.75)
 *       快速展开到 1（与 shader 的 burstT 同步，无提前爆散）
 *     - fade = 1 - smoothstep(0.75, 1.0, outroProg)：消散程度
 *     新增预设只需定义 mode/颜色/半径，无需关心时间曲线。
 */
const EFFECT_PRESETS: EffectPreset[] = [
    { id: 'scatter', title: '粒子化（默认）', radiusScale: 1.2, mode: 0, color: null, kind: 'both' },
    { id: 'ripple', title: '波纹开场', radiusScale: 1.4, mode: 1, color: [1.0, 0.95, 0.85], kind: 'intro' },
    { id: 'drift', title: '飘散散场', radiusScale: 1.1, mode: 2, color: [1.0, 0.85, 0.5], kind: 'outro' }
];

/** 获取某图层可用的预设（开场只显示开场预设，散场只显示散场预设） */
const presetsFor = (which: EffectClipKind): EffectPreset[] => {
    return EFFECT_PRESETS.filter(p => p.kind === 'both' || p.kind === which);
};

/** 平滑阶梯（同 GLSL smoothstep） */
function smoothstep(edge0: number, edge1: number, x: number): number {
    const t = Math.min(1, Math.max(0, (x - edge0) / Math.max(1e-6, edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

/** 单个特效图层状态 */
export interface EffectClipState {
    enabled: boolean;
    start: number;
    end: number;
    easingIn: boolean;
    easingOut: boolean;
    presetId: string;
}

/** 特效轨道状态（intro + outro 两个独立图层） */
export interface EffectsState {
    intro: EffectClipState;
    outro: EffectClipState;
}

export type EffectClipKind = 'intro' | 'outro';

const easeInCubic = (t: number) => t * t * t;
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOutCubic = (t: number) => {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};

/** 按缓入/缓出开关对 t∈[0,1] 施加缓动 */
function applyEasing(t: number, easingIn: boolean, easingOut: boolean): number {
    if (easingIn && easingOut) return easeInOutCubic(t);
    if (easingIn) return easeInCubic(t);
    if (easingOut) return easeOutCubic(t);
    return t;
}

/** 创建默认图层状态 */
function defaultClip(): EffectClipState {
    return {
        enabled: false,
        start: 0,
        end: 10,
        easingIn: true,
        easingOut: true,
        presetId: 'scatter'
    };
}

/**
 * 特效轨道管理器：持有 intro/outro 两个图层状态，
 * 按时间线帧驱动所有 splat 的散射进度。
 */
class EffectsManager {
    private scene: Scene;
    private state: EffectsState = {
        intro: defaultClip(),
        outro: defaultClip()
    };

    constructor(scene: Scene) {
        this.scene = scene;

        // 时间线播放 / 旋转台渲染每帧驱动
        this.scene.events.on('timeline.frame', (frame: number) => this.applyAtFrame(frame));
        this.scene.events.on('timeline.time', (time: number) => this.applyAtFrame(Math.floor(time)));
    }

    /** 开关图层：开场→自动放起始位；散场→自动放结尾位（可同时开启） */
    setEnabled(which: EffectClipKind, enabled: boolean) {
        const clip = this.state[which];
        clip.enabled = enabled;
        if (enabled) {
            const frames = (this.scene.events.invoke('timeline.frames') as number) ?? 180;
            // 特效图层默认时长 30 帧（1 秒 @30fps）
            const DEFAULT_FX_FRAMES = 30;
            if (which === 'intro') {
                // 开场：从时间线起点开始 30 帧
                clip.start = 0;
                clip.end = Math.min(frames - 1, DEFAULT_FX_FRAMES);
            } else {
                // 散场：锚定时间线结尾 30 帧
                clip.start = Math.max(0, frames - DEFAULT_FX_FRAMES);
                clip.end = frames - 1;
            }
        }
        this.applyAtFrame(this.scene.events.invoke('timeline.frame') as number ?? 0);
        this.scene.events.fire('effects.changed');
    }

    /**
     * 设置图层区间（调长度）。
     * 开场图层左端锚定在时间线起点（帧 0），散场图层右端锚定在
     * 时间线终点（最后一帧）——图层固定在最前/最尾，只能调长。
     */
    setClip(which: EffectClipKind, start: number, end: number) {
        const clip = this.state[which];
        if (!clip.enabled) return;
        const frames = (this.scene.events.invoke('timeline.frames') as number) ?? 180;
        const maxF = Math.max(0, frames - 1);
        if (which === 'intro') {
            // 开场：起点固定 0，只调整结束帧
            clip.start = 0;
            clip.end = Math.max(clip.start + 1, Math.min(maxF, end));
        } else {
            // 散场：终点固定最后一帧，只调整起始帧
            clip.start = Math.max(0, Math.min(maxF - 1, start));
            clip.end = maxF;
        }
        this.applyAtFrame(this.scene.events.invoke('timeline.frame') as number ?? 0);
        this.scene.events.fire('effects.changed');
    }

    /** 缓入开关 */
    setEasingIn(which: EffectClipKind, enabled: boolean) {
        this.state[which].easingIn = enabled;
        this.scene.events.fire('effects.changed');
    }

    /** 缓出开关 */
    setEasingOut(which: EffectClipKind, enabled: boolean) {
        this.state[which].easingOut = enabled;
        this.scene.events.fire('effects.changed');
    }

    /** 选择预设（仅接受该图层可用的预设） */
    setPreset(which: EffectClipKind, presetId: string) {
        const available = presetsFor(which);
        if (!available.some(p => p.id === presetId)) return;
        this.state[which].presetId = presetId;
        this.applyAtFrame(this.scene.events.invoke('timeline.frame') as number ?? 0);
        this.scene.events.fire('effects.changed');
    }

    /** 当前状态（供 UI 重建） */
    getState(): EffectsState {
        return {
            intro: { ...this.state.intro },
            outro: { ...this.state.outro }
        };
    }

    /** 单个图层在当前帧的散射贡献（区间外：开场前=1，开场后=0；散场前=0，散场后=1） */
    private clipProgress(clip: EffectClipState, which: EffectClipKind, frame: number): number {
        if (!clip.enabled) return 0;
        const p = (frame - clip.start) / Math.max(1, clip.end - clip.start);
        let eased = 0;
        if (p <= 0) eased = 0;
        else if (p >= 1) eased = 1;
        else eased = applyEasing(p, clip.easingIn, clip.easingOut);
        // intro：粒子(1) → 模型(0)；outro：模型(0) → 粒子(1)
        return which === 'intro' ? 1 - eased : eased;
    }

    /** 当前散射进度（0=完整模型，1=全粒子）= 两图层贡献取最大 */
    get progress(): number {
        const frame = (this.scene.events.invoke('timeline.frame') as number) ?? 0;
        const intro = this.clipProgress(this.state.intro, 'intro', frame);
        const outro = this.clipProgress(this.state.outro, 'outro', frame);
        return Math.max(intro, outro);
    }

    /** 按当前帧应用散射进度到所有 splat */
    applyAtFrame(frame: number) {
        // 使用调用方传入的帧：视频/旋转台渲染每帧 fire timeline.time，
        // 但不会更新全局 timeline.frame（只有播放循环/拖拽播放头会），
        // 若改查全局会导致渲染时特效冻结在用户最后停留的帧上。
        const intro = this.state.intro;
        const outro = this.state.outro;
        const introProg = this.clipProgress(intro, 'intro', frame);
        const outroProg = this.clipProgress(outro, 'outro', frame);

        // 主导图层 = 贡献 max 进度者（同值且都启用时开场优先）
        // 开场效果只作用于开场图层区间、散场效果只作用于散场图层区间：
        // 帧落在哪个图层的区间内，就用哪个图层的预设；两区间之外
        // progress=0（完整模型）且强制 mode=0，杜绝跨区间残留。
        // fade：开场淡入（0→100% 不透明度）、散场淡出（100%→0）。
        //
        // 散场「渐进三段」设计（见 EFFECT_PRESETS 备注）：
        //   1. 特效加载（outro 0→0.5）：effectTime 缓慢从 0 升到 ~0.2，
        //      模型逐渐变成特效的初始样子（无突变）；
        //   2. 特效发展（0.5→0.75）：effectTime 升到 1，特效扩散/飘散
        //      进一步发展；
        //   3. 消散（0.75→1）：fade 从 1 降到 0，特效逐渐消失。
        // 实现：effectTime 用缓入平方曲线（前慢后快），fade 用平滑阶梯。
        let progress: number;
        let preset: EffectPreset;
        let effectTime: number;
        let fade: number;
        const inIntro = intro.enabled && frame >= intro.start && frame <= intro.end;
        const inOutro = outro.enabled && frame >= outro.start && frame <= outro.end;
        if (inOutro && (!inIntro || outroProg > introProg)) {
            preset = presetsFor('outro').find(p => p.id === outro.presetId) ?? EFFECT_PRESETS[0];
            // 散场渐进三段：特效加载(0→0.5) 发展(0.5→0.75) 消散(0.75→1)
            // effectTime 前段慢升（特效初始→展开），后段快速到 1
            const effRaw = outroProg < 0.5 ? 0.2 * (outroProg / 0.5) * (outroProg / 0.5) : 0.2 + 0.8 * smoothstep(0.5, 0.75, outroProg);
            const fadeT = smoothstep(0.75, 1.0, outroProg);
            progress = effRaw;
            effectTime = effRaw;
            fade = 1 - fadeT;
        } else if (inIntro) {
            progress = introProg;
            preset = presetsFor('intro').find(p => p.id === intro.presetId) ?? EFFECT_PRESETS[0];
            // 开场效果时间：progress 从 1（粒子）→ 0（模型）；
            // 波纹从 start 的 0（中心亮点）→ end 的 1（全模型呈现），故 1 - introProg
            effectTime = 1 - introProg;
            // 开场：不透明度 0% → 100%（淡入）
            fade = 1 - introProg;
        } else {
            // 两区间之外：完整模型，无任何特效（强制 mode=0），完全不透明
            progress = 0;
            preset = EFFECT_PRESETS[0];
            effectTime = 0;
            fade = 1;
        }

        const splats = this.scene.getElementsByType(ElementType.splat) as Splat[];
        let anyActive = false;
        for (const s of splats) {
            s.setScatterProgress(progress, preset.radiusScale, preset.mode, effectTime, preset.color ?? undefined, fade);
            if (progress > 0.01) anyActive = true;
        }
        // 粒子存在时强制持续渲染（仅当 progress 非零且场景当前未锁定渲染）
        this.scene.events.fire('effects.activeChanged', anyActive);
    }
}

/** 注册特效事件（main() 调用） */
export const registerEffectsEvents = (events: Events, getScene: () => Scene | null) => {
    let manager: EffectsManager | null = null;

    const getManager = (): EffectsManager | null => {
        if (manager) return manager;
        const scene = getScene();
        if (!scene) return null;
        manager = new EffectsManager(scene);
        return manager;
    };

    const defaultState: EffectsState = {
        intro: defaultClip(),
        outro: defaultClip()
    };

    events.on('effects.setEnabled', (which: EffectClipKind, enabled: boolean) => {
        getManager()?.setEnabled(which, enabled);
    });

    events.on('effects.setClip', (which: EffectClipKind, start: number, end: number) => {
        getManager()?.setClip(which, start, end);
    });

    events.on('effects.setEasingIn', (which: EffectClipKind, enabled: boolean) => {
        getManager()?.setEasingIn(which, enabled);
    });

    events.on('effects.setEasingOut', (which: EffectClipKind, enabled: boolean) => {
        getManager()?.setEasingOut(which, enabled);
    });

    events.on('effects.setPreset', (which: EffectClipKind, presetId: string) => {
        getManager()?.setPreset(which, presetId);
    });

    events.function('effects.getState', () => {
        return manager ? manager.getState() : defaultState;
    });

    // 预设列表（供时间线下拉选框；按图层过滤——开场只显示开场预设，散场只显示散场预设）
    events.function('effects.presets', (which?: EffectClipKind) => {
        return (which ? presetsFor(which) : EFFECT_PRESETS).map(p => ({ id: p.id, title: p.title }));
    });
};
