/**
 * unified锛堝紩鎿庤嚜甯?GPU 鎺掑簭锛夐€氳矾涓婄殑鏉愯川鏇挎崲銆?
 *
 * ## 涓轰粈涔堥渶瑕佽繖涓枃浠?
 *
 * 寮曟搸鏈変袱鏉?splat 閫氳矾锛坄docs/鎺掑簭閿欏簭-缁撴瀯鎬цВ娉?寮曟搸GPU鎺掑簭閫氳矾-2026-09-23.md`锛夛細
 * 鎴戜滑涓€鐩寸敤鐨?per-instance + worker 鎺掑簭閭ｆ潯锛?*椤哄簭姘歌繙婊炲悗**锛堝疄娴?2 甯ф槸鐗╃悊涓嬮檺锛夛紱
 * 鍙︿竴鏉?unified锛堜笘鐣岀紦鍐?+ 寮曟搸鑷甫 GPU 鍩烘暟鎺掑簭 + indirect draw锛?*椤哄簭涓庣粯鍒跺悓甯?*銆?
 *
 * 浣嗗紩鎿?*鏁呮剰**涓嶈 unified 鐢ㄧ粍浠舵潗璐細
 * - `GSplatComponent.get material()` 鍦?`unified` 涓嬭繑鍥?`null`锛宍set material()` 鐩存帴 `return`
 *   锛坄playcanvas.mjs:88810-88825`锛夛紱
 * - 閭ｆ潯璺殑鏉愯川鏄瘡灞傜殑 `GSplatHybridRenderer._material`锛坄UnifiedSplatHybridMaterial`锛夛紝
 *   鑰?`frameUpdate()` 姣忓抚閮戒細鎷?*寮曟搸鑷繁鏂板缓鐨?* source material 瑕嗙洊瀹?
 *   锛坄GSplatManager.update()` 鈫?`renderer.frameUpdate(params)` 鈫?`copyMaterialSettings`锛夛紱
 * - 瀹冪殑 chunk锛坄gsplatPS` / `gsplatModifyPS`锛夋湰鍦拌鐩栨槸绌虹殑锛岀湡韬湪**鍏ㄥ眬 chunk 娉ㄥ唽琛?*閲岋紝
 *   鎵€浠?鏀?chunk"杩欐潯璺瀹冩槸姝荤殑锛堟垜瀹炴祴杩囷細鎹?`gsplatModifyPS` 鐢婚潰闆跺彉鍖栵級銆?
 *
 * 鈬?瑕佸湪閭ｆ潯璺笂鐢ㄨ嚜宸辩殑鐫€鑹诧紝鍙兘**鏁村潡鏇挎崲閭ｄ釜鏉愯川鐨?shaderDesc**
 * 锛坄ShaderMaterial.shaderDesc` 鐨?setter 浼氭竻鎺夊彉浣撶紦瀛橈紝涓嬫缂栬瘧鐢ㄦ柊婧愶級锛?
 * 骞朵笖鍥犱负姣忓抚琚鐩栵紝闇€瑕佸湪娓叉煋鍓嶅弽澶嶇‘淇濊濂姐€?
 *
 * ## 椤剁偣婧愪负浠€涔堣鎶勪竴浠?
 *
 * hybrid 鐨勯《鐐圭潃鑹插櫒锛坄gsplatHybridVS`锛変粠 `sortedIndices` / `projCache` 涓や釜 storage buffer
 * 鍙栨姇褰辩粨鏋滀笌棰滆壊锛屽拰鎴戜滑 per-instance 閭ｅ锛堥《鐐瑰睘鎬?+ 璐村浘锛夊畬鍏ㄤ笉鍚岋紝娌℃湁鍙鐢ㄦ€с€?
 * 瀹冩槸**蹇呴』鐨勫簳搴?*锛氭妱鍦?`unified-shaders.ts` 閲岋紝鍑哄涓庣増鏈爣娉ㄥ湪閭ｈ竟銆?
 *
 * ## 褰撳墠闃舵锛堜竴鏈燂級
 *
 * 鍙仛**鐫€鑹?*锛堢墖鍏冧晶璋冭壊锛夛紝鍑犱綍/鐘舵€侊紙鍙樻崲璋冭壊鏉裤€侀€夊尯銆佽鍓洅銆佺壒鏁堬級閮借繕娌¤縼銆?
 * 鐗囧厓鐜板湪涓庡紩鎿庨粯璁?*閫愪綅绛変环**锛坄uProbeGain = 1` 鏃讹級锛岀敤鏉ュ厛鎶婂湴鍩洪獙绌匡細
 * 鎴戜滑鐨勬簮鐮佺湡鐨勮缂栬瘧銆佹垜浠殑 uniform 鐪熺殑鑳借璇诲埌銆佽瀹屼箣鍚庢瘡涓€甯ч兘杩樺湪銆?
 */
import { ShaderChunks, SHADERLANGUAGE_WGSL } from 'playcanvas';

import { unifiedModifyVS, unifiedFragmentShader } from '../shaders/unified-shaders';

/** 瑁呭埌 unified 鏉愯川涓婄殑 uniform锛堜竴鏈熺殑璋冭壊鍙傛暟锛沬dentity 鍊?= 寮曟搸榛樿鐢婚潰锛?*/
export type UnifiedMaterialParams = {
    /** 璋冭瘯鐢ㄦ€诲鐩婏紝1 = 寮曟搸榛樿锛涗笉绛変簬 1 鏃剁敾闈㈠繀椤绘暣浣撳彉鍖栵紙楠岃瘉鐢級 */
    probeGain?: number;
};

const UNIFIED_MATERIAL_NAME = 'SplatRoomUnifiedMaterial';
const ATTRS = { vertex_position: 'POSITION' } as const;

let cachedVertexSource: string | null = null;

/**
 * 鍙栧紩鎿?hybrid 椤剁偣鐫€鑹插櫒**宸插睍寮€ #include** 涔嬪悗鐨勬簮鐮併€?
 *
 * 鍙栫殑鏄叏灞€ chunk 娉ㄥ唽琛ㄩ噷鐨勯偅涓€浠斤細瀹冨凡缁忓湪鍚姩鏃惰 `ShaderChunks` 娉ㄥ唽杩囷紝
 * 杩欓噷鍙槸鎶?`#include` 灞曞紑鎴愮函 WGSL 鍐嶄氦缁欐潗璐紙`ShaderMaterial.shaderDesc` 鎷垮埌绾簮鐮佸氨鑳界洿鎺ョ紪璇戯級銆?
 */
function resolveVertexSource(device: unknown): string | null {
    if (cachedVertexSource) {
        return cachedVertexSource;
    }
    // 鐢ㄦ湭灞曞紑鐨勫師濮?chunk 浣滀负婧愶紝浜ょ粰寮曟搸鑷繁鐨勯澶勭悊鍣ㄥ睍寮€锛堜笌寮曟搸鏋勯€?Shader 鏃跺悓涓€鏉¤矾锛?
    const chunks = ShaderChunks.get(device as never, SHADERLANGUAGE_WGSL);
    const raw = chunks?.get?.('gsplatHybridVS') as string | undefined;
    if (!raw) {
        return null;
    }
    cachedVertexSource = raw;
    return cachedVertexSource;
}

/**
 * 鎵惧埌 unified 閫氳矾褰撳墠鐨勬潗璐ㄣ€?
 *
 * 璺緞锛歚app.renderer.gsplatDirector 鈫?camerasMap 鈫?layersMap 鈫?gsplatManager 鈫?material`
 * 锛坄GSplatLayerData.gsplatManager` 鏄紩鎿庝负姣忎釜 layer 寤虹殑锛岃 `playcanvas.mjs:88518`锛夈€?
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
                    // 鍙 GPU 鎺掑簭閭ｆ潯璺細瀹冩墠鏄?椤哄簭涓庣粯鍒跺悓甯?鐨勯€氳矾锛?
                    // 娌℃湁瀹冿紙渚嬪 WebGL2 钀藉洖 CPU 鎺掑簭锛夊氨娌℃湁鐞嗙敱鎹㈡垜浠殑鏉愯川銆?
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
 * 纭繚 unified 鏉愯川鐢ㄧ殑鏄垜浠殑鐫€鑹插櫒锛屽苟鎶婂弬鏁板啓杩涘幓銆?
 *
 * 骞傜瓑锛氭潗璐ㄥ凡缁忚鎹㈣繃灏卞彧鍐欏弬鏁帮紙姣忓抚璋冪敤锛屼唬浠锋槸鍑犳灞炴€ц祴鍊硷級銆?
 * 鑻ュ紩鎿庡湪杩欎竴甯ч噸寤轰簡鏉愯川锛坄copyMaterialSettings` 瑕嗙洊 / renderer 閲嶅缓锛夛紝
 * 杩欓噷浼氶噸鏂拌 鈥斺€?杩欏氨鏄皟鐢ㄧ偣鏀惧湪娓叉煋鍓嶇殑鍘熷洜銆?
 *
 * @returns 鏄惁鑷冲皯瑁?鏇存柊鍒颁竴涓潗璐?
 */
export function ensureUnifiedMaterial(scene: any, params: UnifiedMaterialParams = {}): boolean {
    // ===== 鎺掓煡鐢ㄧ煭璺紙2026-09-25锛夛細鎬€鐤戦挬瀛愪綋鏈韩瀵艰嚧瀵煎叆鍗℃ =====
    // `__SPLATROOM_UNIFIED_MATERIAL_DISABLED__ = true` 鏃跺彧鍋?鑳戒笉鑳芥嬁鍒版潗璐?鐨勬帰娴嬨€佷笉鎹㈡潗璐紝
    // 鐢ㄦ潵鎶?閽╁瓙浣撶殑鍓綔鐢?涓?寮€鍏虫湰韬?鍒嗗紑銆傞粯璁や笉璧拌繖鏉¤矾銆?
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
        // 鍙湪**鍐呭鐪熺殑鍙樹簡**鏃舵墠鍐?chunk锛歚ShaderChunkMap.set()` 鍦ㄥ€间笉鍚屾椂浼?markDirty锛?
        // 鑰屽紩鎿庢覆鏌撳墠浼?`update()` 鈫?鍙戠幇 dirty 鈫?`clearVariants()` 鈬?姣忓抚閲嶇紪璇戙€?
        // 鎵€浠ヨ繖閲屽繀椤荤敤鍐呭姣旇緝鏉ヤ繚璇佸箓绛夛紙姣忓抚閮戒細璋冭繘鏉ワ級銆?
        const chunks = material.shaderChunks?.wgsl;
        if (chunks && chunks.get('gsplatModifyVS') !== unifiedModifyVS) {
            chunks.set('gsplatModifyVS', unifiedModifyVS);
            material.__splatRoomUnified = UNIFIED_MATERIAL_NAME;
            // 寮曟搸鑷繁浼氬湪娓叉煋鍓嶆竻鍙樹綋锛坄material.update()` 閲?`_shaderChunks.isDirty()` 鍒嗘敮锛夛紝
            // 杩欓噷鍐嶈皟涓€娆℃槸涓轰簡璁?杩欎竴甯у氨鐢熸晥"锛屼笉蹇呯瓑涓嬩竴甯с€?
            material.update();
        }
        // ===== 鏍稿績淇锛?026-09-25锛岃 docs/寰呭姙-寮曟搸WebGPU-compute.md 搂4h/搂4k锛?====
        // 缁?*缁樺埗鏉愯川**瑁呬竴浠借嚜鍐欑墖鍏冿細瀹冨悓鏃跺啓 `output.color` 涓?`output.color1`銆?
        //
        // 涓轰粈涔堝繀椤昏繖涔堝仛锛歴plat pass 鐨勭洰鏍囨槸 2 闄勪欢 MRT锛坄camera.ts` 鐨?splatTarget锛夛紝
        // 鑰屽紩鎿庤嚜甯﹂偅浠界墖鍏冨湪 forward 璺緞鍙啓 `output.color` 鈬?RT1 鏈?writeMask 鍗存病鏈?
        // 瀵瑰簲杈撳嚭 鈬?绠＄嚎鏍￠獙澶辫触锛坄createRenderPipeline` 涓嶆姏寮傚父銆佸彧杩斿洖鏃犳晥绠＄嚎 鈬?鐢婚潰鍐绘锛夈€?
        //
        // 鈿狅笍 涓夋潯纭害鏉燂細
        //   1. 椤剁偣婧愮敤**寮曟搸宸插睍寮€鐨?* `shader.definition.vshader`锛堝畠灏辨槸 hybrid 椤剁偣锛?
        //      宸茶窇瀹?#include锛夛紱涓嶈兘鑷繁 include锛屽惁鍒欎笌鑷姩甯﹀叆鐨?chunk 鍐茬獊銆?
        //   2. `uniqueName` **蹇呴』闅忔簮鐮佸彉鍖?* 鈥斺€?寮曟搸鐨?`ShaderUtils.createShader` 鎸?
        //      `uniqueName` 缂撳瓨锛坄programLibrary.getCachedShader`锛夛紝鍚嶅瓧涓嶅彉灏辨案杩滃懡涓棫鐫€鑹插櫒锛?
        //      鏀规簮鐮佷篃涓嶄細閲嶇紪璇戙€?
        //   3. 姣忓抚閮借纭锛堝紩鎿庣殑 `copyMaterialSettings` 浼氳鐩栬繖鍧楁潗璐級銆?
        const vs = material.shader?.definition?.vshader ?? null;
        const wantName = `${UNIFIED_MATERIAL_NAME}-${unifiedFragmentShader.length}-${unifiedModifyVS.length}`;
        // 排查用状态（挂在全局，探针读）：看清到底卡在哪一步
        (globalThis as any).__SPLATROOM_UNIFIED_INSTALL_STATE__ = {
            hasVertexSource: !!vs,
            vertexLen: vs ? vs.length : 0,
            currentName: material.uniqueName ?? null,
            wantName,
            alreadyDone: material.uniqueName === wantName
        };
        if (vs && material.uniqueName !== wantName) {
            material.shaderDesc = {
                uniqueName: wantName,
                attributes: { vertex_position: 'POSITION' },
                vertexCode: vs,
                fragmentCode: unifiedFragmentShader,
                shaderLanguage: SHADERLANGUAGE_WGSL,
                fragmentOutputTypes: ['vec4', 'vec4']
            };
            material.update();
            material.__splatRoomUnified = UNIFIED_MATERIAL_NAME;
            (globalThis as any).__SPLATROOM_UNIFIED_MATERIAL_INSTALLED__ = {
                uniqueName: wantName,
                vsLen: vs.length,
                fsLen: unifiedFragmentShader.length,
                outTypes: 2
            };
        }

        const gain = typeof params.probeGain === 'number' ? params.probeGain : 1;
        material.setParameter('uProbeGain', gain);
        touched++;
    }

    // 鎺㈤拡/濂椾欢鐢ㄧ殑鍙ユ焺锛氳繖鏉￠€氳矾鐨勬潗璐ㄤ笉鍦ㄧ粍浠朵笂锛堝紩鎿庢晠鎰忔柇寮€锛夛紝
    // 闄や簡娓叉煋寰幆閲岄偅涓€鍒伙紝澶栭潰**娌℃湁鍒殑鍔炴硶**鎷垮埌瀹冦€備笌浠撳簱閲屽叾瀹?
    // `__SPLATROOM_*` 閫冪敓寮€鍏冲悓涓€绫伙紝鍙銆佹棤鍓綔鐢ㄣ€?
    (globalThis as any).__SPLATROOM_UNIFIED_MATERIAL__ = materials[0];
    return touched > 0;
}

/** 鏄惁宸茬粡瑁呭湪 unified 鏉愯川涓婏紙鎺㈤拡/濂椾欢鏂█鐢級 */
export function isUnifiedMaterialInstalled(scene: any): boolean {
    return collectUnifiedMaterials(scene).every(m => m.__splatRoomUnified === UNIFIED_MATERIAL_NAME);
}

