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

import { applySplatColorParams, type SplatColorParams } from './color-params';
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
};

const UNIFIED_MATERIAL_NAME = 'SplatRoomUnifiedMaterial';
const ATTRS = { vertex_position: 'POSITION' } as const;

let cachedVertexSource: string | null = null;

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
        const bakedFrag = bakeUnifiedFragmentShader();
        const wantName = `${UNIFIED_MATERIAL_NAME}-${hashSource(bakedFrag)}-${hashSource(bakedModifyVS)}-${hashSource(vertexSource ?? '')}`;
        // 排查用状态（挂在全局，探针读）：看清到底卡在哪一步
        (globalThis as any).__SPLATROOM_UNIFIED_INSTALL_STATE__ = {
            hasVertexSource: !!vertexSource,
            vertexLen: vertexSource ? vertexSource.length : 0,
            sourceKind: bakedVs ? 'our-baked' : (vs ? 'compiled' : (rawVs ? 'raw-chunk' : 'none')),
            currentName: material.uniqueName ?? null,
            wantName,
            alreadyDone: material.uniqueName === wantName
        };
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

        const gain = typeof params.probeGain === 'number' ? params.probeGain : 1;
        material.setParameter('uProbeGain', gain);
        // 调色参数：与 per-instance **同一份推导**（`src/splat/color-params.ts`），uniform 名也相同。
        // 缺省即中性（clrScale = 1、clrOffset = 0、饱和度 = 1、其余 0、曲线关）⇒ 画面与
        // "只装了我们的着色器、没做任何调色"逐像素一致。
        const color = params.color ?? {
            clrOffset: [0, 0, 0] as [number, number, number],
            clrScale: [1, 1, 1, 1] as [number, number, number, number],
            saturation: 1,
            highlights: 0,
            shadows: 0,
            contrast: 0,
            hslHueA: [0, 0, 0, 0],
            hslHueB: [0, 0, 0, 0],
            hslSatA: [0, 0, 0, 0],
            hslSatB: [0, 0, 0, 0],
            hslLumA: [0, 0, 0, 0],
            hslLumB: [0, 0, 0, 0],
            uCurveEnabled: 0
        };
        applySplatColorParams(material, color);
        if (params.curveTexture) {
            material.setParameter('uCurve', params.curveTexture);
        }
        // 二期：per-splat 状态（选中 / 锁定 / 删除）。缺省全部中性 ——
        // 不绑状态贴图时 `srState` 恒为 0，着色器整段不生效，画面与"只有调色"逐像素一致。
        if (params.stateTexture) {
            material.setParameter('srStateTex', params.stateTexture);
        }
        material.setParameter('srStateW', typeof params.stateWidth === 'number' && params.stateWidth > 0 ? params.stateWidth : 1);
        material.setParameter('srSelectedClr', params.selectedClr ?? [0, 0, 0, 0]);
        material.setParameter('srLockedClr', params.lockedClr ?? [1, 1, 1, 1]);
        material.setParameter('srShowDeleted', typeof params.showDeleted === 'number' ? params.showDeleted : 0);
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
export function ensureUnifiedWorkBuffer(scene: any): boolean {
    const director = scene?.app?.renderer?.gsplatDirector;
    if (!director?.camerasMap) {
        return false;
    }
    let forced = 0;
    director.camerasMap.forEach((cameraData: any) => {
        cameraData?.layersMap?.forEach((layerData: any) => {
            const manager = layerData?.gsplatManager;
            const world = manager?.world;
            // 只认 GPU 排序那条路（与材质侧同一判据），别的通路没有 work buffer 这回事
            if (!world || !manager?.renderer?.usesGpuSort) {
                return;
            }
            const version = Number(world.currentVersion ?? 0);
            if (forcedWorldVersions.get(world) === version) {
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
