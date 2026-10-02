/**
 * unified（引擎自带 GPU 排序）通路上的材质替换。
 *
 * ## 为什么需要这个文件
 *
 * 引擎有两条 splat 通路（`docs/排序错序-结构性解法-引擎GPU排序通路-2026-09-23.md`）：
 * 我们一直用的 per-instance + worker 排序那条，**顺序永远滞后**（实测 2 帧是物理下限）；
 * 另一条 unified（世界缓冲 + 引擎自带 GPU 基数排序 + indirect draw）**顺序与绘制同帧**。
 *
 * 但引擎**故意**不让 unified 用组件材质：
 * - `GSplatComponent.get material()` 在 `unified` 下返回 `null`，`set material()` 直接 `return`
 *   （`playcanvas.mjs:88810-88825`）；
 * - 那条路的材质是每层的 `GSplatHybridRenderer._material`（`UnifiedSplatHybridMaterial`），
 *   而 `frameUpdate()` 每帧都会用**引擎自己新建的** source material 覆盖它
 *   （`GSplatManager.update()` → `renderer.frameUpdate(params)` → `copyMaterialSettings`）；
 * - 它的 chunk（`gsplatPS` / `gsplatModifyPS`）本地覆盖是空的，真身在**全局 chunk 注册表**里，
 *   所以"改 chunk"这条路对它是死的（实测过：换 `gsplatModifyPS` 画面零变化）。
 *
 * ⇒ 要在那条路上用自己的着色，只能**整块替换那个材质的 shaderDesc**
 * （`ShaderMaterial.shaderDesc` 的 setter 会清掉变体缓存，下次编译用新源），
 * 而且因为每帧被覆盖，需要在渲染前反复确保装好。
 *
 * ## 顶点源为什么要抄一份
 *
 * hybrid 的顶点着色器（`gsplatHybridVS`）从 `sortedIndices` / `projCache` 两个 storage buffer
 * 取投影结果与颜色，和我们 per-instance 那套（顶点属性 + 贴图）完全不同，没有可复用性。
 * 它是**必须的底座**：放在 `unified-shaders.ts` 里，出处与版本标注在那边。
 *
 * ## 当前阶段（二期：把我们的调色接过来）
 *
 * 顶点用**我们自己那一份** hybrid 顶点（`unified-shaders.ts` 的逐字拷贝 + 我们在
 * `prepareOutputFromGamma` 之前插进去的那几步），片元用我们自己那一份；
 * 调色参数由 `scene.ts` 的钩子从 `src/splat/color-params.ts`（与 per-instance 共用的同一份推导）
 * 喂进来，uniform 名与 per-instance 完全一致：
 *   顶点（每 splat）：clrScale/clrOffset → 曲线 → 饱和度
 *   片元（每像素）：高光 → 阴影 → 对比 → 逐通道 HSL
 * 仍未迁移：几何/状态（变换调色板、选区、裁剪盒、特效、环选）—— 那些要 per-splat 的 varyings。
 */
import { ShaderChunks, SHADERLANGUAGE_WGSL } from 'playcanvas';

import { applySplatColorParamsCached, createSplatColorParams, type SplatColorParams } from './color-params';
import { MaterialParamCache } from './material-param-cache';
import { bakeUnifiedFragmentShader, bakeUnifiedModifyVS, bakeUnifiedVertexShader, hashSource } from '../shaders/unified-shaders';

/**
 * 装到 unified 材质上的 uniform。
 * 调色那几项与 per-instance 材质同名同语义（见 src/splat/color-params.ts）；
 * 二期新增的 per-splat 状态那几项用 `sr` 前缀（避免与引擎 chunk 里已有的名字重名，
 * 同一个 WGSL 模块里重复声明会编译失败）。
 */
export type UnifiedMaterialParams = {
    /** 调试用总增益，1 = 引擎默认；不等于 1 时画面必须整体变化（验证用） */
    probeGain?: number;
    /** 颜色分级参数（缺省即中性：clrScale=1、clrOffset=0、饱和度=1、其余 0、曲线关） */
    color?: SplatColorParams;
    /** 曲线 LUT 纹理（33×4 R32F；没有曲线时不绑也可以，`uCurveEnabled = 0`） */
    curveTexture?: unknown;
    /**
     * 二期：per-splat 状态贴图（R8、行主序；就是 `Splat.stateTexture`，两条通路共用同一张）。
     * 顶点着色器用 `cacheIdx`（= 该 splat 在数据里的行号）去 `textureLoad` 它，
     * 于是"选中高亮 / 锁定 / 删除隐藏"在这条通路上也能生效。
     */
    stateTexture?: unknown;
    /** 状态贴图宽度（行主序定位用；与 `stateTexture.width` 一致） */
    stateWidth?: number;
    /** 选中色（rgba，alpha 当混合权重；不选任何东西时传 [0,0,0,0] = 中性） */
    selectedClr?: number[];
    /** 锁定色（rgba，整色相乘；中性 = [1,1,1,1]） */
    lockedClr?: number[];
    /** 1 = 显示"已删除"的高斯（淡红 + 降透明度），0 = 整点隐藏 */
    showDeleted?: number;
    /**
     * 「轮廓选区」开关（= `events.invoke('view.outlineSelection')`）。
     *
     * 为什么必须显式喂进来：RT1（选区覆盖）的两个消费者语义是**互斥**的，与 per-instance
     * 片元逐字对齐（`splat-shader.ts:695-708` / `splat-shader-wgsl.ts:723-737`）：
     *   开着 ⇒ RT0 不染色（调用方把 `selectedClr` 传中性），RT1 写**选中点的高斯 alpha**
     *           —— 描边后处理（`src/scene/outline.ts`）据此膨胀出轮廓；
     *   关着 ⇒ 选中点 RT0 降到 80%，剩下 20% 写 RT1 —— 衬底（`src/scene/underlay.ts`）
     *           加法合成回去。
     * 缺了它，这条通路只能二选一写死；**实测 3.23.65 之前是恒写 0**
     * （`unified-shaders.ts` 的 `output.color1 = vec4f(0,0,0,0)`）⇒ 开着轮廓时
     * 两条高亮腿同时断 = 框选后画面零反馈（用户报障的根因）。
     */
    outlineMode?: number;
    /**
     * 拾取模式：0 = 正常出图，1 = **id 拾取**（片元把 splat 行号写成颜色，供
     * `Picker.prepareId` + `readIds` 读回）。缺省沿用当前值（见 `setUnifiedPickMode`），
     * 所以每帧的 `ensureUnifiedMaterialHook()` 不会把 picker 刚设好的模式冲掉。
     */
    pickMode?: number;
    /**
     * 二期：裁剪盒。`matrix` = inverse(盒世界) × inverse(视图) × inverse(投影)
     * （即"clip 位置 → 盒局部"的合成矩阵），其余字段与 per-instance 的 `uCropBox*` 同义。
     * `enabled = 0` 时整段不生效（画面与不带裁剪盒逐像素一致）。
     */
    crop?: {
        enabled: number;
        matrix?: ArrayLike<number>;
        preview?: number;
        softEdge?: number;
        shape?: number;
        radiusX?: number;
        radiusY?: number;
        radiusZ?: number;
        height?: number;
        capWidth?: number;
        capAlpha?: number;
        /** 盒局部坐标的"中心 ↔ 四角"混合比例（1 = 纯角点） */
        cornerMix?: number;
    };
    /**
     * 二期：粒子特效（散射 / 波纹入场 / 爆散收场）。字段与 per-instance 的 `uScatter*` / `uEffect*`
     * 同义，另加两个矩阵（见 `src/shaders/unified-shaders.ts` 里的说明）。
     */
    effect?: {
        mode?: number;
        time?: number;
        progress?: number;
        radius?: number;
        center?: number[];
        color?: number[];
        fade?: number;
        clipToWorld?: ArrayLike<number>;
        viewProj?: ArrayLike<number>;
    };
};

const UNIFIED_MATERIAL_NAME = 'SplatRoomUnifiedMaterial';
const ATTRS = { vertex_position: 'POSITION' } as const;

let cachedVertexSource: string | null = null;

/**
 * 当前的拾取模式（0 = 正常出图，1 = id 拾取）。
 *
 * 为什么要有这个模块级状态：材质参数是**每帧**由 `Scene.ensureUnifiedMaterialHook()` 重设的，
 * 而 picker 的 `prepareId()` 是在帧中间"设模式 → 立刻渲染一遍 → 立刻回读"的。如果钩子
 * 每次都把 `srPickMode` 写回 0，picker 那一遍绘制就会出成正常的画（读回来的全是垃圾 ——
 * 实测就是这样：47790 个像素里 0 个合法 id）。
 */
let currentPickMode = 0;

/**
 * 当前的粒子特效状态（`Splat.setScatterProgress` 设，每帧的钩子读）。
 *
 * 为什么也要模块级：材质参数每帧由 `Scene.ensureUnifiedMaterialHook()` 重设，而特效是**离散调用**
 * 驱动的（导出/转台在推进进度），不像调色参数那样每帧都能从元素上读回来 —— 更要紧的是
 * `uEffectFade` 根本不落在任何字段上，它是直接写进材质参数的。
 */
let currentEffect: {
    mode: number;
    time: number;
    progress: number;
    radius: number;
    center: number[];
    color: number[];
    fade: number;
} = {
    mode: 0,
    time: 0,
    progress: 0,
    radius: 1,
    center: [0, 0, 0],
    color: [1, 1, 1],
    fade: 1
};

/** 读当前特效状态（给 scene 的钩子/探针用）。 */
export function getUnifiedEffect() {
    return currentEffect;
}

/** 更新特效状态并写进 unified 材质（`Splat.setScatterProgress` 调用）。 */
export function setUnifiedEffect(scene: any, patch: Partial<typeof currentEffect>): boolean {
    currentEffect = { ...currentEffect, ...patch };
    let touched = 0;
    for (const material of collectUnifiedMaterials(scene)) {
        if (!material.__splatRoomUnified) {
            continue;
        }
        material.setParameter('srScatterProgress', currentEffect.progress);
        material.setParameter('srScatterRadius', currentEffect.radius);
        material.setParameter('srScatterCenter', currentEffect.center);
        material.setParameter('srEffectMode', currentEffect.mode);
        material.setParameter('srEffectTime', currentEffect.time);
        material.setParameter('srEffectColor', currentEffect.color);
        material.setParameter('srEffectFade', currentEffect.fade);
        touched++;
    }
    return touched > 0;
}

/** 读当前拾取模式（给探针/套件用）。 */
export function getUnifiedPickMode(): number {
    return currentPickMode;
}

// 探针句柄（与仓库里其它 `__SPLATROOM_*` 逃生开关同一约定：只读/只写自身状态，无副作用）。
// 为什么需要：材质参数是**每帧**由 scene 的钩子重设的，所以"手动 setParameter 再截图"这种
// 验证方式会被下一帧的钩子冲掉（实测踩过：截图里参数已经回到 0，误判成"着色器不听话"）。
// 走这个入口才能把"我们的拾取模式"钉住。
(globalThis as any).__SPLATROOM_UNIFIED_SET_PICK_MODE__ = (scene: unknown, mode: number) => {
    return setUnifiedPickMode(scene, mode);
};
(globalThis as any).__SPLATROOM_UNIFIED_GET_PICK_MODE__ = () => currentPickMode;

/**
 * 只改拾取模式，不动其它参数（别用 `ensureUnifiedMaterial` —— 它会把调色参数一并按缺省重设）。
 * 返回是否真的改到了 unified 材质。
 */
export function setUnifiedPickMode(scene: any, mode: number): boolean {
    currentPickMode = mode;
    let touched = 0;
    for (const material of collectUnifiedMaterials(scene)) {
        if (!material.__splatRoomUnified) {
            continue;
        }
        material.setParameter('srPickMode', mode);
        touched++;
    }
    return touched > 0;
}

/**
 * 已经强制重建过 work buffer 的 world → 版本号（幂等用）。
 * 用 WeakMap 是为了不把引擎对象钉在内存里（world 销毁后条目自动消失）。
 */
const forcedWorldVersions = new WeakMap<object, number>();

/**
 * 取引擎 hybrid 顶点着色器**已展开 #include** 之后的源码。
 *
 * 取的是全局 chunk 注册表里的那一份：它已经在启动时被 `ShaderChunks` 注册过，
 * 这里只是把 `#include` 展开成纯 WGSL 再交给材质（`ShaderMaterial.shaderDesc` 拿到纯源码就能直接编译）。
 */
function resolveVertexSource(device: unknown): string | null {
    if (cachedVertexSource) {
        return cachedVertexSource;
    }
    // 用未展开的原始 chunk 作为源，交给引擎自己的预处理器展开（与引擎构建 Shader 时同一条路）
    const chunks = ShaderChunks.get(device as never, SHADERLANGUAGE_WGSL);
    const raw = chunks?.get?.('gsplatHybridVS') as string | undefined;
    if (!raw) {
        return null;
    }
    cachedVertexSource = raw;
    return cachedVertexSource;
}

/**
 * 找到 unified 通路当前的材质。
 *
 * 路径：`app.renderer.gsplatDirector → camerasMap → layersMap → gsplatManager → material`
 * （`GSplatLayerData.gsplatManager` 是引擎为每个 layer 建的，见 `playcanvas.mjs:88518`）。
 */

// ===== M2-3（2026-09-30）：每帧开销清理 =====
// 每块 unified 材质一个参数缓存：值没变就不调 setParameter（引擎的 setParameter
// 是纯赋值，绘制前每帧会把 parameters 里已有的值重新推进 scope，语义等价）。
// 引擎若原地重置 parameters（copyMaterialSettings），ensureIntact 的哨兵校验会
// 发现缓存引用不在材质上 ⇒ 清账全量重写。
const unifiedParamCaches = new WeakMap<object, MaterialParamCache>();
const paramCacheFor = (material: any): MaterialParamCache => {
    let c = unifiedParamCaches.get(material);
    if (!c) {
        c = new MaterialParamCache();
        unifiedParamCaches.set(material, c);
    }
    return c;
};
// wantName 的三段散列：源码字符串在 bake 记忆化之后**引用稳定**，引用没变就复用上次的
// wantName（省掉每帧 3 次对几 KB~几十 KB 字符串的 FNV 散列 + 模板拼接）。
const wantNameMemo = { frag: '', vs: '', modify: '', out: '' };
// 每帧复用的安装状态对象（探针读它；以前每帧新分配一份）
const installState: any = { hasVertexSource: false, vertexLen: 0, sourceKind: 'none', currentName: null, wantName: '', alreadyDone: false };
// 缺省调色参数（中性）：以前每帧在 ensureUnifiedMaterial 里 new 一份字面量
const NEUTRAL_UNIFIED_COLOR = createSplatColorParams();
const ZERO3 = [0, 0, 0];
const ONE3 = [1, 1, 1];
const ZERO4_UNIFIED = [0, 0, 0, 0];
const ONE4_UNIFIED = [1, 1, 1, 1];
function collectUnifiedMaterials(scene: any): any[] {
    const director = scene?.app?.renderer?.gsplatDirector;
    const dbg = (globalThis as any).__SPLATROOM_UNIFIED_MATERIAL_DEBUG__;
    if (!director?.camerasMap) {
        if (dbg) {
            dbg.calls = (dbg.calls ?? 0) + 1;
            dbg.lastReason = 'no director';
        }
        return [];
    }
    const out: any[] = [];
    let seenManagers = 0;
    let seenRenderers = 0;
    let seenGpuSort = 0;
    let seenMaterials = 0;
    director.camerasMap.forEach((cameraData: any) => {
        cameraData?.layersMap?.forEach((layerData: any) => {
            const manager = layerData?.gsplatManager;
            if (manager) {
                seenManagers++;
                if (manager.renderer) {
                    seenRenderers++;
                    if (manager.renderer.usesGpuSort) {
                        seenGpuSort++;
                    }
                    if (manager.material) {
                        seenMaterials++;
                    }
                    // 只认 GPU 排序那条路：它才是"顺序与绘制同帧"的通路，
                    // 没有它（例如 WebGL2 落回 CPU 排序）就没有理由换我们的材质。
                    if (manager.renderer.usesGpuSort && manager.material) {
                        out.push(manager.material);
                    }
                }
            }
        });
    });
    if (dbg) {
        dbg.calls = (dbg.calls ?? 0) + 1;
        dbg.seenManagers = seenManagers;
        dbg.seenRenderers = seenRenderers;
        dbg.seenGpuSort = seenGpuSort;
        dbg.seenMaterials = seenMaterials;
        dbg.picked = out.length;
        dbg.lastReason = out.length ? 'ok' : 'no gpuSort material';
    }
    return out;
}

/**
 * 确保 unified 材质用的是我们的着色器，并把参数写进去。
 *
 * 幂等：材质已经被换过就只写参数（每帧调用，代价是几次属性赋值）。
 * 若引擎在这一帧重建了材质（`copyMaterialSettings` 覆盖 / renderer 重建），
 * 这里会重新装 —— 这就是调用点放在渲染前的原因。
 *
 * @returns 是否至少装/更新到一块材质
 */
export function ensureUnifiedMaterial(scene: any, params: UnifiedMaterialParams = {}): boolean {
    // ===== 排查用短路（2026-09-25）：怀疑钩子体本身导致导入卡死 =====
    // `__SPLATROOM_UNIFIED_MATERIAL_DISABLED__ = true` 时只做"能不能拿到材质"的探测、不换材质，
    // 用来把"钩子体的副作用"与"开关本身"分开。默认不走这条路。
    if ((globalThis as any).__SPLATROOM_UNIFIED_MATERIAL_DISABLED__ === true) {
        const mats = collectUnifiedMaterials(scene);
        (globalThis as any).__SPLATROOM_UNIFIED_MATERIAL__ = mats[0] ?? null;
        return mats.length > 0;
    }
    const materials = collectUnifiedMaterials(scene);
    // 探针用：钩子到底有没有跑到这里、收集到几块材质（上一轮"安装状态为 null"就是卡在这前面）
    (globalThis as any).__SPLATROOM_UNIFIED_HOOK_STATE__ = {
        reached: true,
        collected: materials.length,
        disabled: (globalThis as any).__SPLATROOM_UNIFIED_MATERIAL_DISABLED__ === true
    };
    if (materials.length === 0) {
        return false;
    }
    let touched = 0;
    for (const material of materials) {
        // 只在**内容真的变了**时才写 chunk：`ShaderChunkMap.set()` 在值不同时会 markDirty，
        // 鑰屽紩鎿庢覆鏌撳墠浼?`update()` 鈫?鍙戠幇 dirty 鈫?`clearVariants()` 鈬?姣忓抚閲嶇紪璇戙€?
        // 所以这里必须用内容比较来保证幂等（每帧都会调进来）。
        const bakedModifyVS = bakeUnifiedModifyVS();
        const chunks = material.shaderChunks?.wgsl;
        if (chunks && chunks.get('gsplatModifyVS') !== bakedModifyVS) {
            chunks.set('gsplatModifyVS', bakedModifyVS);
            material.__splatRoomUnified = UNIFIED_MATERIAL_NAME;
            // 引擎自己会在渲染前清变体（`material.update()` 里 `_shaderChunks.isDirty()` 分支），
            // 这里再调一次是为了让"这一帧就生效"，不必等下一帧。
            material.update();
        }
        // ===== 核心修复（2026-09-25，见 docs/待办-引擎WebGPU-compute.md §4h/§4k）=====
        // 给**绘制材质**装一份自写片元：它同时写 `output.color` 与 `output.color1`。
        //
        // 为什么必须这么做：splat pass 的目标是 2 附件 MRT（`camera.ts` 的 splatTarget），
        // 而引擎自带那份片元在 forward 路径只写 `output.color` ⇒ RT1 有 writeMask 却没有
        // 对应输出 ⇒ 管线校验失败（`createRenderPipeline` 不抛异常、只返回无效管线 ⇒ 画面冻死）。
        //
        // ⚠️ 三条硬约束：
        //   1. 顶点源取**全局 chunk 注册表里的原始 `gsplatHybridVS`** —— 注意：
        //      `material.shader.definition.vshader` 在编译前是 null，实测永远拿不到（见 §4n）；
        //   2. `uniqueName` **必须随源码内容变化** —— 引擎的程序库按源码散列 + 名字建键，
        //      只用长度当键会让"等长的改动"（烘焙值 0 → 1）命中旧着色器、根本不重编译；
        //      实现上用 `hashSource()` 取内容散列，见本文件下方的 `wantName`。
        //   3. 每帧都要确认（引擎的 `copyMaterialSettings` 会覆盖这块材质）。
        // ===== 第 3 条最小验证（2026-09-25，§4l）：只改"输出路数"，不动顶点、不动片元 =====
        // 目的：单独验证"把 fragmentOutputTypes 设成两路"能否消掉那条
        // `Color target has no corresponding fragment stage output ... targets[1]`。
        // 片元仍是引擎那份（只写 output.color）—— 如果错误数**下降**，说明片元结构声明两路
        // 就够满足校验（WebGPU 只看"有没有对应的片元输出"这一层）；如果**不变**，说明
        // 必须真的写第二个输出，那就得走 §4l 的"换顶点源取法 + 自写片元"那条。
        // 这个开关只为实验存在，默认关闭。
        if ((globalThis as any).__SPLATROOM_UNIFIED_OUT_TYPES_ONLY__ === true) {
            const d: any = material.shaderDesc;
            const have = d && Array.isArray(d.fragmentOutputTypes) ? d.fragmentOutputTypes.length : 0;
            if (have < 2) {
                const wantOnly = `${UNIFIED_MATERIAL_NAME}-outtypes`;
                if (material.uniqueName !== wantOnly) {
                    material.shaderDesc = {
                        uniqueName: wantOnly,
                        attributes: d?.attributes,
                        vertexCode: d?.vertexWGSL ?? d?.vertexGLSL,
                        fragmentCode: d?.fragmentWGSL ?? d?.fragmentGLSL,
                        shaderLanguage: SHADERLANGUAGE_WGSL,
                        fragmentOutputTypes: ['vec4', 'vec4']
                    };
                    material.update();
                    (globalThis as any).__SPLATROOM_OUTTYPES_ONLY_DONE__ = {
                        uniqueName: wantOnly,
                        hadVertexCode: !!(d?.vertexWGSL ?? d?.vertexGLSL),
                        hadFragmentCode: !!(d?.fragmentWGSL ?? d?.fragmentGLSL)
                    };
                }
            }
        }

        const vs = material.shader?.definition?.vshader ?? null;
        // 顶点源**不能**依赖已编译 shader（`material.shader` 在编译前是空的 —— 实测
        // `hasVertexSource: false` 永远成立，安装因此一直被自己的守卫挡住）。
        // 改用引擎全局 chunk 注册表里的**原始** `gsplatHybridVS`（它含 `#include`，
        // 材质编译时会自己展开；`shaderDesc.vertexCode` 接受这种源）。
        const rawVs = vs ?? (() => {
            try {
                const reg = ShaderChunks.get(scene?.graphicsDevice, SHADERLANGUAGE_WGSL);
                return reg?.get?.('gsplatHybridVS') ?? null;
            } catch {
                return null;
            }
        })();
        // 顶点源：**始终用我们那一份**拷贝（引擎的逐字拷贝 + 我们在 prepareOutputFromGamma
        // 之前插入的调色步骤）。为什么不再用引擎的原始 chunk：顶点侧那几步（clrScale/clrOffset →
        // 曲线 → 饱和度）必须在 gamma 解码之前做，引擎那一份没有这些代码。
        // 探针的 `vsCover` 烘焙也走同一份（常量默认 0 = 不烘焙）。
        const bakeGlobal = (globalThis as any).__SPLATROOM_UNIFIED_BAKE__ ?? null;
        const vsCover = bakeGlobal && typeof bakeGlobal.vsCover === 'number' ? bakeGlobal.vsCover : 0;
        void vsCover;
        const bakedVs = bakeUnifiedVertexShader();
        const vertexSource = bakedVs ?? rawVs;
        // ⚠️ 缓存键必须含**内容散列**：只用长度会让"等长的改动"（例如烘焙值 0 → 1）
        // 复用同一个 uniqueName，引擎于是命中旧着色器、根本不重编译（实测踩过）。
        // M2-3：bake 记忆化之后三份源码**引用稳定**，引用没变就复用上次的 wantName，
        // 省掉每帧 3 次对整份着色器源码的 hashSource。
        const bakedFrag = bakeUnifiedFragmentShader();
        if (wantNameMemo.frag !== bakedFrag || wantNameMemo.vs !== vertexSource || wantNameMemo.modify !== bakedModifyVS) {
            wantNameMemo.frag = bakedFrag;
            wantNameMemo.vs = vertexSource ?? '';
            wantNameMemo.modify = bakedModifyVS;
            wantNameMemo.out = `${UNIFIED_MATERIAL_NAME}-${hashSource(bakedFrag)}-${hashSource(bakedModifyVS)}-${hashSource(vertexSource ?? '')}`;
        }
        const wantName = wantNameMemo.out;
        // 排查用状态（挂在全局，探针读）：看清到底卡在哪一步
        // M2-3：对象每帧复用（字段与以前逐项一致），不再每帧新分配。
        installState.hasVertexSource = !!vertexSource;
        installState.vertexLen = vertexSource ? vertexSource.length : 0;
        installState.sourceKind = bakedVs ? 'our-baked' : (vs ? 'compiled' : (rawVs ? 'raw-chunk' : 'none'));
        installState.currentName = material.uniqueName ?? null;
        installState.wantName = wantName;
        installState.alreadyDone = material.uniqueName === wantName;
        (globalThis as any).__SPLATROOM_UNIFIED_INSTALL_STATE__ = installState;
        if (vertexSource && material.uniqueName !== wantName) {
            material.shaderDesc = {
                uniqueName: wantName,
                attributes: { vertex_position: 'POSITION' },
                vertexCode: vertexSource,
                fragmentCode: bakedFrag,
                shaderLanguage: SHADERLANGUAGE_WGSL,
                fragmentOutputTypes: ['vec4', 'vec4']
            };
            material.update();
            material.__splatRoomUnified = UNIFIED_MATERIAL_NAME;
            (globalThis as any).__SPLATROOM_UNIFIED_MATERIAL_INSTALLED__ = {
                uniqueName: wantName,
                vsLen: vertexSource.length,
                fsLen: bakedFrag.length,
                outTypes: 2,
                sourceKind: bakedVs ? 'our-baked' : (vs ? 'compiled' : 'raw-chunk')
            };
        }

        // M2-3：这一块以前每帧 ~35 次 setParameter（含多个字面量数组），稳态全是白写。
        // 走 per-material 参数缓存：值没变就不写；哨兵校验防引擎原地重置 parameters。
        const pc = paramCacheFor(material);
        pc.ensureIntact(material, 'clrScale');

        const gain = typeof params.probeGain === 'number' ? params.probeGain : 1;
        pc.setScalar(material, 'uProbeGain', gain);
        // 调色参数：与 per-instance **同一份推导**（`src/splat/color-params.ts`），uniform 名也相同。
        // 缺省即中性（clrScale = 1、clrOffset = 0、饱和度 = 1、其余 0、曲线关）⇒ 画面与
        // "只装了我们的着色器、没做任何调色"逐像素一致。
        applySplatColorParamsCached(pc, material, params.color ?? NEUTRAL_UNIFIED_COLOR);
        if (params.curveTexture) {
            pc.setValue(material, 'uCurve', params.curveTexture);
        }
        // 二期：per-splat 状态（选中 / 锁定 / 删除）。缺省全部中性 ——
        // 不绑状态贴图时 `srState` 恒为 0，着色器整段不生效，画面与"只有调色"逐像素一致。
        if (params.stateTexture) {
            pc.setValue(material, 'srStateTex', params.stateTexture);
        }
        pc.setScalar(material, 'srStateW', typeof params.stateWidth === 'number' && params.stateWidth > 0 ? params.stateWidth : 1);
        pc.setArray(material, 'srSelectedClr', params.selectedClr ?? ZERO4_UNIFIED);
        pc.setArray(material, 'srLockedClr', params.lockedClr ?? ONE4_UNIFIED);
        pc.setScalar(material, 'srOutlineMode', params.outlineMode ?? 0);
        pc.setScalar(material, 'srShowDeleted', typeof params.showDeleted === 'number' ? params.showDeleted : 0);
        // 拾取模式：调用方没给就**沿用上一次设的值** —— 否则每帧的钩子会把
        // picker 刚刚设好的 id 模式冲回 0，而 picker 的那一遍绘制就出成正常的画了。
        const pickMode = typeof params.pickMode === 'number' ? params.pickMode : currentPickMode;
        currentPickMode = pickMode;
        pc.setScalar(material, 'srPickMode', pickMode);
        // 二期：裁剪盒（缺省关闭 = 中性，着色器整段跳过）
        const crop = params.crop;
        pc.setScalar(material, 'srCropEnabled', crop && crop.enabled > 0.5 ? 1 : 0);
        if (crop && crop.enabled > 0.5) {
            if (crop.matrix) {
                pc.setArray(material, 'srClipToBoxLocal', crop.matrix);
            }
            pc.setScalar(material, 'srCropPreview', crop.preview ?? 0);
            pc.setScalar(material, 'srCropSoftEdge', crop.softEdge ?? 0.005);
            pc.setScalar(material, 'srCropShape', crop.shape ?? 0);
            pc.setScalar(material, 'srCropRadiusX', crop.radiusX ?? 0.35);
            pc.setScalar(material, 'srCropRadiusY', crop.radiusY ?? 0.35);
            pc.setScalar(material, 'srCropRadiusZ', crop.radiusZ ?? 0.35);
            pc.setScalar(material, 'srCropHeight', crop.height ?? 0.8);
            pc.setScalar(material, 'srCropCapWidth', crop.capWidth ?? 0);
            pc.setScalar(material, 'srCropCapAlpha', crop.capAlpha ?? 1);
            pc.setScalar(material, 'srCropMix', crop.cornerMix ?? 1);
        }
        // 二期：粒子特效（缺省 = 中性：progress 0 / mode 0 / fade 1 ⇒ 位置与颜色都不变）
        const effect = params.effect ?? {};
        pc.setScalar(material, 'srScatterProgress', effect.progress ?? 0);
        pc.setScalar(material, 'srScatterRadius', effect.radius ?? 1);
        pc.setArray(material, 'srScatterCenter', effect.center ?? ZERO3);
        pc.setScalar(material, 'srEffectMode', effect.mode ?? 0);
        pc.setScalar(material, 'srEffectTime', effect.time ?? 0);
        pc.setArray(material, 'srEffectColor', effect.color ?? ONE3);
        pc.setScalar(material, 'srEffectFade', effect.fade ?? 1);
        if (effect.clipToWorld) {
            pc.setArray(material, 'srClipToWorld', effect.clipToWorld);
        }
        if (effect.viewProj) {
            pc.setArray(material, 'srViewProj', effect.viewProj);
        }
        touched++;
    }

    // 探针/套件用的句柄：这条通路的材质不在组件上（引擎故意断开），
    // 闄や簡娓叉煋寰幆閲岄偅涓€鍒伙紝澶栭潰**娌℃湁鍒殑鍔炴硶**鎷垮埌瀹冦€備笌浠撳簱閲屽叾瀹?
    // `__SPLATROOM_*` 閫冪敓寮€鍏冲悓涓€绫伙紝鍙銆佹棤鍓綔鐢ㄣ€?
    (globalThis as any).__SPLATROOM_UNIFIED_MATERIAL__ = materials[0];
    return touched > 0;
}

/** 是否已经装在 unified 材质上（探针/套件断言用） */
export function isUnifiedMaterialInstalled(scene: any): boolean {
    return collectUnifiedMaterials(scene).every(m => m.__splatRoomUnified === UNIFIED_MATERIAL_NAME);
}

/**
 * unified 通路的**数据首传**：逼引擎把 splat 数据真正填进 work buffer 的三张贴图。
 *
 * ## 为什么必须补这一下（2026-09-25 实测，见 `docs/待办-引擎WebGPU-compute.md` §4t）
 *
 * 引擎只在 `GSplatWorld.markSorted()` 里做首传，且条件是 `!worldState.sortedBefore`：
 *
 *     markSorted(version, count, camera, updateBounds, result) {
 *         const worldState = this._worldStates.get(version);
 *         if (worldState && !worldState.sortedBefore) {          // ← 只有"从没排过序"才首传
 *             worldState.sortedBefore = true;
 *             this.rebuildWorkBuffer(worldState, count, false, camera, updateBounds);
 *         }
 *     }
 *     bake(version, camera, updateBounds, result) {              // 之后每帧走这里
 *         if (sortedState?.sortedBefore) {
 *             if (this._workBufferRebuildRequired) this.rebuildWorkBuffer(sortedState, count, true, ...);
 *             else result.sortNeeded = this.applyWorkBufferUpdates(sortedState, camera);
 *         }
 *     }
 *
 * 我们的用法是**导入完成后再把 `comp.unified` 翻成 true**，那一刻 worldState 已经
 * `sortedBefore = true`（它是给别的通路建的、早就算过）⇒ 首传被永久跳过，
 * 之后每帧只走增量路径 ⇒ 数据贴图全空 ⇒ 投影器把每个 splat 都判无效
 * （实测 `renderCounter = 0`）⇒ `ProjectorWriteIndirectArgs` 把
 * `numSplatsBuf[0]` / 间接绘制参数写成 0 ⇒ **一个图元都没有**（画面全空、且不报任何错）。
 *
 * 引擎自己留了强制入口：`world.invalidate({ workBuffer: true })` 会把
 * `_workBufferRebuildRequired` 置真，下一帧 `bake()` 就走 `forceFullRebuild` 那条路。
 *
 * 幂等：**每个 world 每个版本只强制一次**（版本变了说明模型/放置集合变了，需要重传一次）。
 *
 * @returns 这一次是否真的触发了强制重建
 */
export function ensureUnifiedWorkBuffer(scene: any, force = false): boolean {
    const director = scene?.app?.renderer?.gsplatDirector;
    if (!director?.camerasMap) {
        return false;
    }
    let forced = 0;
    director.camerasMap.forEach((cameraData: any) => {
        cameraData?.layersMap?.forEach((layerData: any) => {
            // `layersMap` 的值在引擎版本间有两种形态：包装对象（`.gsplatManager`）或
            // 直接就是 manager 本身。原来只认前一种，后一种会静默早退 ——
            // 强制重建**一次都没真正执行过**（M3-3 排查时实测：director 里能取到 world，
            // 而这里的 `manager` 是 undefined）。两种都认。
            const manager = layerData?.gsplatManager ?? layerData;
            const world = manager?.world;
            // 只认 GPU 排序那条路（与材质侧同一判据），别的通路没有 work buffer 这回事
            if (!world || !manager?.renderer?.usesGpuSort) {
                return;
            }
            const version = Number(world.currentVersion ?? 0);
            // `force = true`：绕过"每版本一次"的幂等（往 pcId 流里写完 id 之后必须**再**重传一次，
            // 否则投影器读到的还是空的 pcId）。
            if (!force && forcedWorldVersions.get(world) === version) {
                return;
            }
            if (typeof world.invalidate !== 'function') {
                return;
            }
            world.invalidate({ workBuffer: true });
            forcedWorldVersions.set(world, version);
            forced++;
        });
    });
    return forced > 0;
}

/**
 * 把 unified 通路的 **`pcId` 流填成 `[0..numSplats)`** —— GPU 逐 splat 拾取的最后一块。
 *
 * 为什么需要（这一条是量出来的，不是猜的，见 `docs/进度存档.md` 的探针 61~63）：
 *   · 引擎的拾取那一遍（`SHADER_PICK`）用的是**它自己的拾取材质**，我们的片元根本不参与
 *     （绘制瞬间读到的材质 `matIsOurs = false`）⇒ 我们无论怎么设 `srPickMode` 都没用；
 *   · 那份拾取材质写的是 `vPickId`，而 `vPickId` 来自 work buffer 的 **pcId 流**；
 *   · `scene.gsplat.enableIds = true` 只是**声明**了这条流
 *     （`format.addExtraStreams([{ name: 'pcId', format: R32U, storage: GSPLAT_STREAM_RESOURCE }])`），
 *     **没有任何东西往里填每 splat 的值**（引擎自带的写入用的是 `splatInfo.placementId`，
 *     是"按元素"不是"按高斯"）⇒ `vPickId` 恒为 0 ⇒ 拾取读回来全是 0。
 *
 * 填法按 PlayCanvas 的流机制：`GSPLAT_STREAM_RESOURCE` 的流每个都有一张纹理
 * （`GSplatStreams.init` 建的），把 `i` 逐行写进去即可；写完必须**强制重传一次 work buffer**，
 * 否则投影器读到的还是空 pcId。
 *
 * 幂等：同一个 splat 的同一个 `numSplats` 只写一次（`splat._pickIdsWritten` 记账）。
 *
 * @returns 这一次是否真的写了（调用方据此决定要不要强制重传）
 */
export function ensureUnifiedPickIds(scene: any, splat: any): boolean {
    const numSplats = Number(splat?.splatData?.numSplats ?? 0);
    if (!numSplats) {
        return false;
    }
    if (splat._pickIdsWritten === numSplats) {
        return false;
    }
    const component = splat?.entity?.gsplat;
    const resource = component?.instance?.resource ?? component?.resource ?? component?._placement?.resource ?? splat?.asset?.resource;
    const streams = resource?.streams;
    if (!streams?.getTexture) {
        return false;
    }
    // enableIds 打开后 pcId 才出现在格式里，流的纹理要跟格式对齐一次
    try {
        resource.syncWithFormat?.();
    } catch {
        /* 对齐失败就按"这张流还没准备好"处理 */
    }
    const texture = streams.getTexture('pcId');
    if (!texture?.lock) {
        return false;
    }
    let ok = false;
    try {
        const data = texture.lock();
        if (data && data.length >= numSplats) {
            for (let i = 0; i < numSplats; i++) {
                data[i] = i;
            }
            ok = true;
        }
    } catch {
        ok = false;
    } finally {
        texture.unlock();
    }
    if (ok) {
        splat._pickIdsWritten = numSplats;
    }
    return ok;
}
