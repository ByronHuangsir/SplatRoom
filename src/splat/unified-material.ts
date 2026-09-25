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
 *   而 `frameUpdate()` 每帧都会拿**引擎自己新建的** source material 覆盖它
 *   （`GSplatManager.update()` → `renderer.frameUpdate(params)` → `copyMaterialSettings`）；
 * - 它的 chunk（`gsplatPS` / `gsplatModifyPS`）本地覆盖是空的，真身在**全局 chunk 注册表**里，
 *   所以"改 chunk"这条路对它是死的（我实测过：换 `gsplatModifyPS` 画面零变化）。
 *
 * ⇒ 要在那条路上用自己的着色，只能**整块替换那个材质的 shaderDesc**
 * （`ShaderMaterial.shaderDesc` 的 setter 会清掉变体缓存，下次编译用新源），
 * 并且因为每帧被覆盖，需要在渲染前反复确保装好。
 *
 * ## 顶点源为什么要抄一份
 *
 * hybrid 的顶点着色器（`gsplatHybridVS`）从 `sortedIndices` / `projCache` 两个 storage buffer
 * 取投影结果与颜色，和我们 per-instance 那套（顶点属性 + 贴图）完全不同，没有可复用性。
 * 它是**必须的底座**：抄在 `unified-shaders.ts` 里，出处与版本标注在那边。
 *
 * ## 当前阶段（一期）
 *
 * 只做**着色**（片元侧调色），几何/状态（变换调色板、选区、裁剪盒、特效）都还没迁。
 * 片元现在与引擎默认**逐位等价**（`uProbeGain = 1` 时），用来先把地基验穿：
 * 我们的源码真的被编译、我们的 uniform 真的能被读到、装完之后每一帧都还在。
 */
import { ShaderChunks, SHADERLANGUAGE_WGSL } from 'playcanvas';

import { unifiedModifyVS } from '../shaders/unified-shaders';

/** 装到 unified 材质上的 uniform（一期的调色参数；identity 值 = 引擎默认画面） */
export type UnifiedMaterialParams = {
    /** 调试用总增益，1 = 引擎默认；不等于 1 时画面必须整体变化（验证用） */
    probeGain?: number;
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
    // 用未展开的原始 chunk 作为源，交给引擎自己的预处理器展开（与引擎构造 Shader 时同一条路）
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
                    // 只认 GPU 排序那条路：它才是"顺序与绘制同帧"的通路；
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
 * @returns 是否至少装/更新到一个材质
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
    if (materials.length === 0) {
        return false;
    }
    let touched = 0;
    for (const material of materials) {
        // 只在**内容真的变了**时才写 chunk：`ShaderChunkMap.set()` 在值不同时会 markDirty，
        // 而引擎渲染前会 `update()` → 发现 dirty → `clearVariants()` ⇒ 每帧重编译。
        // 所以这里必须用内容比较来保证幂等（每帧都会调进来）。
        const chunks = material.shaderChunks?.wgsl;
        if (chunks && chunks.get('gsplatModifyVS') !== unifiedModifyVS) {
            chunks.set('gsplatModifyVS', unifiedModifyVS);
            material.__splatRoomUnified = UNIFIED_MATERIAL_NAME;
            // 引擎自己会在渲染前清变体（`material.update()` 里 `_shaderChunks.isDirty()` 分支），
            // 这里再调一次是为了让"这一帧就生效"，不必等下一帧。
            material.update();
        }
        // ===== 关键修复（2026-09-25，见 docs/待办-引擎WebGPU-compute.md §4h/§4j）=====
        // splat pass 用的是**两个颜色附件的 MRT**（`camera.ts` 的 splatTarget：
        // RT0 = 场景色、RT1 = 选区覆盖）。而片元结构 `FragmentOutput` 是按
        // `options.fragmentOutputTypes` 生成的（引擎 `ShaderDefinitionUtils.createDefinition`
        // → `#define COLOR_ATTACHMENT_i` / `alias pcOutType_i`），它**默认只有一个 vec4**
        // ⇒ 片元只写 `output.color`，RT1 却有 writeMask ⇒ WebGPU 校验失败：
        //   "Color target has no corresponding fragment stage output ... targets[1]"
        // 而 `createRenderPipeline` **不抛异常**（只返回无效管线），所以这个错误一直隐身。
        //
        // ⚠️ 但**改哪里**是关键：引擎解析"绘制用哪个材质"的是
        // `_writeGsplatParams()`：`p.material = scene.gsplat.material`
        // （`scene.gsplat` 是 `GSplatParams`，它的 `material` 是**场景级** ShaderMaterial）。
        // 所以真正参与编译的是**场景级那块**，不是这里的 `renderer._material`。
        // 这里顺便也补一次（无害），但决定性的是下面 applySceneLevelMaterial()。
        const desc: any = material.shaderDesc;
        if (desc && (!Array.isArray(desc.fragmentOutputTypes) || desc.fragmentOutputTypes.length < 2)) {
            material.shaderDesc = {
                uniqueName: desc.uniqueName ?? UNIFIED_MATERIAL_NAME,
                attributes: desc.attributes,
                vertexCode: desc.vertexWGSL ?? desc.vertexGLSL,
                fragmentCode: desc.fragmentWGSL ?? desc.fragmentGLSL,
                shaderLanguage: SHADERLANGUAGE_WGSL,
                fragmentOutputTypes: ['vec4', 'vec4']
            };
            material.update();
        }

        const gain = typeof params.probeGain === 'number' ? params.probeGain : 1;
        material.setParameter('uProbeGain', gain);
        touched++;
    }

    // 场景级材质（引擎 `p.material` 的来源）—— 这才是决定片元输出的那块
    applySceneLevelMaterial(scene);
    // 探针/套件用的句柄：这条通路的材质不在组件上（引擎故意断开），
    // 除了渲染循环里那一刻，外面**没有别的办法**拿到它。与仓库里其它
    // `__SPLATROOM_*` 逃生开关同一类，只读、无副作用。
    (globalThis as any).__SPLATROOM_UNIFIED_MATERIAL__ = materials[0];
    return touched > 0;
}

/**
 * 给**场景级** gsplat 材质补上第二路片元输出。
 *
 * 为什么是这一块（`docs/待办-引擎WebGPU-compute.md` §4j）：引擎在
 * `GSplatManager._writeGsplatParams()` 里写 `p.material = scene.gsplat.material`，
 * 而 `scene.gsplat` 是 `GSplatParams`、它的 `material` 是**场景级** `ShaderMaterial`
 * （`get material() { return this._material; }`）。渲染与编译用的是这一块，
 * **不是** `GSplatHybridRenderer._material`（前面几轮补错的对象）。
 *
 * 这里只做一件事：把 `fragmentOutputTypes` 补成两路 —— splat pass 的目标是 2 附件 MRT，
 * 片元结构必须声明 `color` **和** `color1`，否则 WebGPU 报
 * "Color target has no corresponding fragment stage output ... targets[1]"，
 * 而 `createRenderPipeline` **不抛异常**（只返回无效管线）⇒ 画面冻死、错误隐身。
 *
 * ⚠️ `GSplatParams.material` **只有 getter 没有 setter**，所以只能直接改内部字段
 * `_material` —— 这属于"打补丁"，升级引擎时必须重新核对。
 *
 * @returns 是否改动过
 */
function applySceneLevelMaterial(scene: any): boolean {
    const params: any = scene?.app?.scene?.gsplat;
    const material: any = params?._material;
    if (!material || !material.shaderDesc) {
        return false;
    }
    const desc: any = material.shaderDesc;
    const have = Array.isArray(desc.fragmentOutputTypes) ? desc.fragmentOutputTypes.length : 0;
    if (have >= 2) {
        return false;
    }
    material.shaderDesc = {
        uniqueName: desc.uniqueName ?? 'SplatRoomUnifiedSceneMaterial',
        attributes: desc.attributes,
        vertexCode: desc.vertexWGSL ?? desc.vertexGLSL,
        fragmentCode: desc.fragmentWGSL ?? desc.fragmentGLSL,
        shaderLanguage: SHADERLANGUAGE_WGSL,
        fragmentOutputTypes: ['vec4', 'vec4']
    };
    material.update();
    (globalThis as any).__SPLATROOM_UNIFIED_SCENE_MATERIAL__ = material;
    return true;
}

/** 是否已经装在 unified 材质上（探针/套件断言用） */
export function isUnifiedMaterialInstalled(scene: any): boolean {
    return collectUnifiedMaterials(scene).every(m => m.__splatRoomUnified === UNIFIED_MATERIAL_NAME);
}
