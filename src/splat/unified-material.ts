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
 * ## 当前阶段（一期）
 *
 * 只做**着色**（片元侧调色），几何/状态（变换调色板、选区、裁剪盒、特效）都还没迁移。
 * 片元现在与引擎默认**逐位等价**（`uProbeGain = 1` 时），用来先把地基验空：
 * 我们的源码真的被编译、我们的 uniform 真的能被读到、装完之后每一帧都还在。
 */
import { ShaderChunks, SHADERLANGUAGE_WGSL } from 'playcanvas';

import { bakeUnifiedFragmentShader, bakeUnifiedModifyVS, bakeUnifiedVertexShader, hashSource } from '../shaders/unified-shaders';

/** 装到 unified 材质上的 uniform（一期的调色参数；中性值 = 与引擎默认逐像素一致） */
export type UnifiedMaterialParams = {
    /** 调试用总增益，1 = 引擎默认；不等于 1 时画面必须整体变化（验证用） */
    probeGain?: number;
    /** 饱和度：1 = 中性（与 per-instance 材质同名同语义） */
    saturation?: number;
    /** 对比度：0 = 中性 */
    contrast?: number;
};

const UNIFIED_MATERIAL_NAME = 'SplatRoomUnifiedMaterial';
const ATTRS = { vertex_position: 'POSITION' } as const;

let cachedVertexSource: string | null = null;

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
        // 探针烘焙（§4s）：只有"铺满屏幕"这个实验需要**我们这一份**顶点源（引擎那一份里没有开关）。
        // 平时（bake 关闭）仍然用引擎的原始 chunk，逐字不变。
        const bakeGlobal = (globalThis as any).__SPLATROOM_UNIFIED_BAKE__ ?? null;
        const vsCover = bakeGlobal && typeof bakeGlobal.vsCover === 'number' ? bakeGlobal.vsCover : 0;
        const bakedVs = vsCover > 0 ? bakeUnifiedVertexShader() : null;
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
        // 一期调色参数（中性值：saturation = 1、contrast = 0 ⇒ 整条链恒等）
        material.setParameter('saturation', typeof params.saturation === 'number' ? params.saturation : 1);
        material.setParameter('contrast', typeof params.contrast === 'number' ? params.contrast : 0);
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
