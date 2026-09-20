import {
    ADDRESS_CLAMP_TO_EDGE,
    FILTER_NEAREST,
    PIXELFORMAT_R8,
    PIXELFORMAT_R16U,
    PROJECTION_ORTHOGRAPHIC,
    Asset,
    BoundingBox,
    Color,
    Entity,
    GSplatData,
    GSplatInstance,
    GSplatResource,
    Mat4,
    Quat,
    Texture,
    Vec3
} from 'playcanvas';

import { writeGpuCameraUniforms, GpuCameraSource } from './gpu-camera-uniforms';
import { State, SplatState } from './splat-state';
import { TransformPalette } from './transform-palette';
import { Serializer } from '../core/serializer';
import { suggestLodLevel } from '../lod/lod';
import { Element, ElementType } from '../scene/element';
import { vertexShader, fragmentShader, gsplatCenter, gsplatModifyVS } from '../shaders/splat-shader';
import { vertexShaderWGSL, fragmentShaderWGSL, gsplatCenterWGSL, gsplatModifyWGSL, gsplatCornerWGSL } from '../shaders/splat-shader-wgsl';
import { Transform } from '../transform/transform';

const vec = new Vec3();
const veca = new Vec3();
const vecb = new Vec3();
const invView = new Mat4();
const invBoxWorld = new Mat4();
const viewToBoxLocal = new Mat4();

// SplatRoom patch: scratch buffers for per-frame main-view sort fallback.
const _fallbackCamPos = new Vec3();
const _fallbackCamDir = new Vec3();
const _fallbackLocalPos = new Vec3();
const _fallbackLocalDir = new Vec3();
const _fallbackInvModel = new Mat4();

// P0-2（2026-09-20，用户 2000 万点实测 ⑥）：排序派发/相机闸门的节流参数。
// 为什么是 800 ms：20M 一次全量排序约 0.4 s，把放行间隔设在"一次排序时长"之上，
// worker 才有机会空闲（实测限流前它只要相机在动就一直排 ≈2.5 次/秒，每次排序完成
// 引擎要做一次 ~80 MB 主线程上传 ⇒ 轨道旋转 max 帧 462~490 ms）。
// 停手 200 ms 后补一帧，保证静止画面用的仍是最终位姿的顺序。
const SORT_MIN_INTERVAL_MS = 800;
const SORT_SETTLE_MS = 200;

const boundingPoints =
    [-1, 1].map((x) => {
        return [-1, 1].map((y) => {
            return [-1, 1].map((z) => {
                return [
                    new Vec3(x, y, z), new Vec3(x * 0.75, y, z),
                    new Vec3(x, y, z), new Vec3(x, y * 0.75, z),
                    new Vec3(x, y, z), new Vec3(x, y, z * 0.75)
                ];
            });
        });
    }).flat(3);

class Splat extends Element {
    asset: Asset;
    splatData: GSplatData;
    numSplats = 0;
    numDeleted = 0;
    numLocked = 0;
    numSelected = 0;
    entity: Entity;
    changedCounter = 0;

    // ---- runtime LOD (V3, opt-in) -------------------------------------------
    // Proxy levels decimated from the base data (coarsest last in build order,
    // e.g. [35%, 10%]). Swapping via replaceData to a proxy while the camera is
    // far reduces per-frame sort/vertex cost on very large scans. The feature
    // is inert until setLodAssets() registers levels AND the scene's
    // 'lod.allowProxy' gate reports a non-editing browsing state.
    lodAssets: { asset: Asset; numSplats: number }[] = [];
    lodEnabled = false;
    /** -1 = full-resolution base asset; otherwise index into lodAssets. */
    lodLevel = -1;
    _lodBaseAsset: Asset | null = null;
    _lodLastSwitchAt = 0;
    // 娑撯偓濞嗏剝鈧冩啞鐠€锔界垼鐠佸府绱版稉鑽ゆ祲閺堝搫绱╅悽銊у繁婢舵唻绱欓幒鎺戠碍閸忔粌绨抽弮鐘崇《閸欐牜娴夐張鍝勑幀渚婄礆閸欘亝褰佺粈杞扮濞嗏槄绱?
    // 闁灝鍘ゅВ蹇撴姎閸掑嘲鐫嗛妴鍌濐潌 onPreRender閵?
    _warnedNoMainCam = false;
    stateTexture: Texture;
    // encapsulates per-splat state mirror (cpu Uint8Array + gpu Texture).
    // all writes go through state.setBits/clearBits/toggleBits, then flush().
    state: SplatState;
    transformTexture: Texture;
    selectionBoundStorage: BoundingBox;
    localBoundStorage: BoundingBox;

    // pristine copy of the engine's CPU-computed local AABB (see the constructor)
    private cpuBoundStorage = new BoundingBox();
    worldBoundStorage: BoundingBox;

    // O1 (docs/audit/00-总结.md): set while a range-slider drag is in flight so that
    // selection-only state changes skip the GPU bound pass. See updateState().
    private _boundsDeferred = false;
    private _selectionBoundDirty = false;

    _visible = true;
    transformPalette: TransformPalette;

    // per-splat camera last-pose for the main-view sort fallback (module-level
    // scratch caused splats to compare against each OTHER's last pose, so every
    // splat re-dispatched a sort every frame once any camera moved)
    private _sortLastPos = new Vec3();
    private _sortLastDir = new Vec3();
    // P0-2（2026-09-20，用户 2000 万点实测 ⑥）：交互期排序的"最小间隔 + 停手补一帧"状态。
    // 见 onPreRender 里那段的注释：每帧派发全量排序会让 worker 100% 饱和（实测轨道旋转
    // max 帧 462.8 ms、3 秒内 5 帧 >33 ms），而上游 SuperSplat 3.3.0 在运动帧**根本不排序**。
    private _sortLastDispatch = 0;
    private _sortSettleAt = 0;

    selectionAlpha = 1;

    _name = '';
    _tintClr = new Color(1, 1, 1);
    _temperature = 0;
    _saturation = 1;
    _brightness = 0;
    _blackPoint = 0;
    _whitePoint = 1;
    _transparency = 1;
    _highlights = 0;
    _shadows = 0;
    _contrast = 0;
    _colorGradeEnabled = true;
    _showDeleted = false;

    // 缁帒鐡欓崠鏍ㄦ殠鐏忓嫯绻樻惔锔肩窗0 = 鐎瑰本鏆ｅΟ鈥崇€烽敍? = 鐎瑰苯鍙忛弫锝呯磻閹存劗鐭戠€涙劧绱欐い鍓佸仯閻偓閼规彃娅掗幓鎺戔偓纭风礆
    _scatterProgress = 0;
    // 閺侊絽鐨犻崣鍌涙殶缂傛挸鐡ㄩ敍鍫熌侀崹瀣敄闂傛潙瀵橀崶瀵告磪娑擃厼绺炬稉搴″磹瀵板嫸绱氶敍灞芥躬 bindAsset 閸氬海鏁?
    // ensureScatterParams 鐠侊紕鐣绘稉鈧▎?
    _scatterCenter = new Vec3();
    _scatterRadius = 1;
    // 閻楄鏅ュΟ鈥崇础娑撳骸寮弫甯礄濞夈垻姹楀鈧崷?妞嬫ɑ鏆庨弫锝呮簚缁涘绱?
    _effectMode = 0;
    _effectTime = 0;
    _effectColor = new Vec3(1, 1, 1);

    // HSL per-channel (8 zones: R, O, Y, G, A, B, P, M)
    _hslHue = new Float32Array(8);
    _hslSat = new Float32Array(8);
    _hslLum = new Float32Array(8);

    measurePoints: Vec3[] = [];
    measureSelection = -1;
    // 濞村鍣哄В鏂剧伐鐏忕尨绱? 娑擃亝膩閸ㄥ宕熸担?= measureScale 娑擃亜鐤勯梽鍛礋娴ｅ稄绱眓ull = 閺堫亣顔曠純顕嗙礄閹稿膩閸ㄥ宕熸担宥嗘▔缁€鐚寸礆
    measureScale: number | null = null;
    measureScaleUnit = 'm';

    orientPoints: Vec3[] = [];
    orientSelection = -1;

    rebuildMaterial: (bands: number) => void;

    constructor(asset: Asset, rotation: Quat) {
        super(ElementType.splat);

        const { device } = asset.resource as GSplatResource;

        // create the entity once. its transform persists across frame swaps so
        // an animated sequence can replace its data without losing the user's
        // transform (see replaceData).
        this.entity = new Entity('splatEntity');

        this.selectionBoundStorage = new BoundingBox();

        // create the transform palette (reused across frame swaps; index 0 is identity)
        this.transformPalette = new TransformPalette(device);

        // rebuilds material chunks/params. reads the *current* gsplat instance and
        // state/transform textures so it remains valid after a replaceData swap
        // (the 'view.bands' listener registered in add() keeps pointing at it).
        this.rebuildMaterial = (bands: number) => {
            const instance = this.entity.gsplat.instance;
            const { material } = instance;
            const { glsl, wgsl } = material.shaderChunks;
            glsl.set('gsplatVS', vertexShader);
            glsl.set('gsplatPS', fragmentShader);
            glsl.set('gsplatCenterVS', gsplatCenter);
            glsl.set('gsplatModifyVS', gsplatModifyVS);

            // the WebGPU backend compiles the splat material from WGSL sources, so
            // the GLSL chunks above would be ignored there (the engine's stock WGSL
            // shader would run and our two-attachment splat pass would be invalid)
            if (device.isWebGPU) {
                wgsl.set('gsplatVS', vertexShaderWGSL);
                wgsl.set('gsplatPS', fragmentShaderWGSL);
                wgsl.set('gsplatCenterVS', gsplatCenterWGSL);
                wgsl.set('gsplatModifyVS', gsplatModifyWGSL);
                wgsl.set('gsplatCornerVS', gsplatCornerWGSL);
            }

            material.setDefine('SH_BANDS', `${Math.min(bands, (instance.resource as GSplatResource).shBands)}`);
            material.setParameter('splatState', this.stateTexture);
            material.setParameter('splatTransform', this.transformTexture);
            material.update();

            material.setParameter('saturation', this._saturation);
            material.setParameter('highlights', this._highlights);
            material.setParameter('shadows', this._shadows);
            material.setParameter('contrast', this._contrast);
            material.setParameter('showDeleted', 0);
            material.setParameter('hslHueA', [this._hslHue[0], this._hslHue[1], this._hslHue[2], this._hslHue[3]]);
            material.setParameter('hslHueB', [this._hslHue[4], this._hslHue[5], this._hslHue[6], this._hslHue[7]]);
            material.setParameter('hslSatA', [this._hslSat[0], this._hslSat[1], this._hslSat[2], this._hslSat[3]]);
            material.setParameter('hslSatB', [this._hslSat[4], this._hslSat[5], this._hslSat[6], this._hslSat[7]]);
            material.setParameter('hslLumA', [this._hslLum[0], this._hslLum[1], this._hslLum[2], this._hslLum[3]]);
            material.setParameter('hslLumB', [this._hslLum[4], this._hslLum[5], this._hslLum[6], this._hslLum[7]]);

            // 缁帒鐡欓崠鏍ㄦ殠鐏?uniform閿涘牓绮拋?0 = 鐎瑰本鏆ｅΟ鈥崇€烽敍?
            this.ensureScatterParams();
            material.setParameter('uScatterProgress', this._scatterProgress);
            material.setParameter('uScatterRadius', this._scatterRadius);
            material.setParameter('uScatterCenter', [this._scatterCenter.x, this._scatterCenter.y, this._scatterCenter.z]);
            material.setParameter('uEffectMode', this._effectMode);
            material.setParameter('uEffectTime', this._effectTime);
            material.setParameter('uEffectColor', [this._effectColor.x, this._effectColor.y, this._effectColor.z]);
            material.setParameter('uEffectFade', 1);
        };

        // bind the initial frame's data, applying the file's load rotation
        this.bindAsset(asset, rotation);
    }

    /** 鐠侊紕鐣荤划鎺戠摍閸栨牗鏆庣亸鍕棘閺佸府绱板Ο鈥崇€风粚娲？閸栧懎娲块惄鎺嶈厬韫?+ 閸楀﹤绶為敍鍫濐嚠鐟欐帞鍤庢稉鈧崡?* 1.2閿?*/
    private ensureScatterParams() {
        const bound = this.localBound;
        if (!bound || !bound.center) return;
        this._scatterCenter.copy(bound.center);
        this._scatterRadius = Math.max(0.01, bound.halfExtents.length() * 1.2);
    }

    /**
     * 鐠佸墽鐤嗙划鎺戠摍閸栨牗鏆庣亸鍕箻鎼达讣绱?=濡€崇€烽敍?=缁帒鐡欓敍澶涚礉楠炶泛鎮撳銉ュ煂 GPU material閵?
     * @param progress - 閺侊絽鐨犳潻娑樺 0..1
     * @param radiusScale - 閺侊絽鐨犻崡濠傜窞閻╃顕崠鍛纯閻╂帞娈戦崐宥嗘殶閿涘牓顣╃拋鐐付閸掕绱?
     * @param effectMode - 閻楄鏅ュΟ鈥崇础閿?=姒涙顓婚弫锝呯殸閿?=濞夈垻姹楀鈧崷鐚寸礉2=妞嬫ɑ鏆庨弫锝呮簚
     * @param effectTime - 閺佸牊鐏夋潻娑樺 0..1閿涘牊灏濈痪鐟板磹瀵?/ 妞嬫ɑ鏆庢潻娑樺閿?
     * @param effectColor - 閺佸牊鐏夋妯瑰瘨閼硅绱欏▔銏㈡睏/閻忣偉濮抽懝璇х礉閸欘垶鈧绱?
     * @param fade - 閺佺繝缍嬮柅蹇旀鎼?0..1閿涘牆绱戦崷鐑樿窗閸?0閳?閿涘本鏆庨崷鐑樿窗閸?1閳?閿?
     */
    setScatterProgress(progress: number, radiusScale = 1, effectMode = 0, effectTime = 0, effectColor?: [number, number, number], fade = 1) {
        this._scatterProgress = progress;
        const instance = this.entity.gsplat?.instance;
        const material = instance?.material;
        if (!material) return;
        this.ensureScatterParams();
        material.setParameter('uScatterProgress', progress);
        material.setParameter('uScatterRadius', this._scatterRadius * radiusScale);
        material.setParameter('uScatterCenter', [this._scatterCenter.x, this._scatterCenter.y, this._scatterCenter.z]);
        material.setParameter('uEffectMode', effectMode);
        material.setParameter('uEffectTime', effectTime);
        if (effectColor) {
            this._effectColor.set(effectColor[0], effectColor[1], effectColor[2]);
        }
        material.setParameter('uEffectColor', [this._effectColor.x, this._effectColor.y, this._effectColor.z]);
        material.setParameter('uEffectFade', fade);
    }

    // bind a gsplat asset onto this element's entity: creates the gsplat
    // component, the per-splat state/transform channels and their gpu textures,
    // and caches the instance bounds. When `rotation` is supplied (initial load)
    // the entity rotation is set; on a frame swap it is omitted so the user's
    // transform is preserved.
    private bindAsset(asset: Asset, rotation?: Quat) {
        const splatResource = asset.resource as GSplatResource;
        const splatData = splatResource.gsplatData as GSplatData;
        const { device } = splatResource;

        this.asset = asset;
        this.splatData = splatData;
        this.numSplats = splatData.numSplats;

        // name and orientation are set on the initial bind only; a frame swap
        // (replaceData, no rotation) keeps the element's name and transform
        if (rotation) {
            this._name = (asset.file as any).filename;
            this.entity.setLocalRotation(rotation);
        }

        this.entity.addComponent('gsplat', {
            asset,
            unified: false
        });

        if (!this.entity.gsplat) {
            console.error('[Splat.bindAsset] gsplat component missing after addComponent');
        }
        if (!this.entity.gsplat?.instance) {
            console.warn('[Splat.bindAsset] instance not ready immediately after addComponent, waiting...', this.entity.gsplat);
        }

        const instance = this.entity.gsplat.instance;

        // added per-splat state channel
        // bit 1: selected
        // bit 2: deleted
        // bit 3: locked
        if (!splatData.getProp('state')) {
            splatData.getElement('vertex').properties.push({
                type: 'uchar',
                name: 'state',
                storage: new Uint8Array(splatData.numSplats),
                byteSize: 1
            });
        }

        // per-splat transform matrix
        splatData.getElement('vertex').properties.push({
            type: 'ushort',
            name: 'transform',
            storage: new Uint16Array(splatData.numSplats),
            byteSize: 2
        });

        const { x: width, y: height } = (splatResource as any).textureDimensions;

        // pack spherical harmonic data
        const createTexture = (name: string, format: number) => {
            return new Texture(device, {
                name: name,
                width: width,
                height: height,
                format: format,
                mipmaps: false,
                minFilter: FILTER_NEAREST,
                magFilter: FILTER_NEAREST,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE
            });
        };

        // create the state texture and the SplatState mirror that owns it.
        // splatData.getProp('state') aliases state.data so existing read-only
        // consumers (serialize, status-bar, etc) keep working unchanged.
        this.stateTexture = createTexture('splatState', PIXELFORMAT_R8);
        this.state = new SplatState(splatData.getProp('state') as Uint8Array, this.stateTexture);
        this.transformTexture = createTexture('splatTransform', PIXELFORMAT_R16U);

        this.localBoundStorage = instance.resource.aabb;
        // keep a pristine copy of the engine's CPU-computed AABB: localBoundStorage is
        // an alias of it, so the GPU bound pass below overwrites the CPU values
        // (with zeros on WebGPU, where its readback returns nothing)
        this.cpuBoundStorage.copy(instance.resource.aabb);
        // @ts-ignore
        this.worldBoundStorage = instance.meshInstance._aabb;

        // @ts-ignore
        instance.meshInstance._updateAabb = false;

        // when sort changes, re-render the scene. the instance's sorter is
        // created lazily (and never on WebGPU, which sorts into a storage
        // buffer), so this binding is optional rather than assumed
        instance.sorter?.on('updated', () => {
            this.changedCounter++;
            this.scene.forceRender = true;
        });

        // NOTE: do NOT "prime" instancingCount / numSplats here. The engine's
        // update() sets them only when applyPendingSorted() returns a real count
        // 閳?which requires culler to push cameras into instance.cameras[] first.
        // If the cull path ever skips this instance (e.g. individual splats
        // hidden under groupRenderer, or any code path that prevents the
        // gsplat cameras array from being populated), applyPendingSorted()
        // returns -1 forever and our "prime" would lock instancingCount at the
        // full count with the identity order texture 閳?model renders in raw
        // storage order with NO depth sort 閳?half-transparent gaussians mix
        // randomly 閳?visually identical to "near small / far big" (a.k.a. the
        // PiP order-pollution symptom of pre-v9.1). Letting the engine default
        // (instancingCount=0, numSplats=0) keeps the model blank for the few
        // frames until the first real sort lands, which is the correct trade.
    }

    // wait for the next scene render to complete, with a safety timeout so a
    // stalled render loop (e.g. a backgrounded tab where rAF is paused) can't
    // block frame swapping forever. In a live app postrender fires within a
    // frame, so the timeout never matters.
    private waitForRender(): Promise<void> {
        return new Promise((resolve) => {
            // single finish() removes the listener and clears the timeout, so the
            // common case (postrender fires first) doesn't leave a pending timer.
            const handles: { off?: { off: () => void }, timer?: ReturnType<typeof setTimeout> } = {};
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                handles.off?.off();
                clearTimeout(handles.timer);
                resolve();
            };
            handles.off = this.scene.events.on('postrender', finish);
            // safety: don't block frame swapping forever if the render loop is stalled
            handles.timer = setTimeout(finish, 200);
        });
    }

    // swap in a new frame's gsplat data while preserving this element's identity,
    // transform and visual properties. used by animated sequence playback so each
    // frame doesn't recreate the whole element.
    //
    // The gsplat lives on this.entity (read in many places), so we can't double
    // buffer on a child. Instead we bind the new frame to a *fresh* entity, sort
    // it, and let it render once alongside the still-present old entity before
    // destroying the old one. This overlap avoids a blank/unsorted frame
    // flickering on screen during the swap (the old frame masks the new one's
    // first sort), matching the previous per-frame load behaviour. The user's
    // transform is carried across so it persists.
    //
    // By default the previously-bound asset is unloaded (sequence frames are
    // transient). Pass keepPrevious=true when the caller still owns the old
    // asset 閳?e.g. an undo/redo op swapping between its two snapshots 閳?so the
    // reverse step can bind it again.
    async replaceData(asset: Asset, keepPrevious = false) {
        console.log('[Splat.replaceData] start', this.name, 'asset=', (asset.file as any)?.filename);
        const oldEntity = this.entity;
        const oldAsset = this.asset;
        const oldStateTexture = this.stateTexture;
        const oldTransformTexture = this.transformTexture;

        // carry the current transform onto the new entity
        const position = oldEntity.getLocalPosition().clone();
        const rotation = oldEntity.getLocalRotation().clone();
        const scale = oldEntity.getLocalScale().clone();

        this.entity = new Entity('splatEntity');
        this.entity.setLocalPosition(position);
        this.entity.setLocalRotation(rotation);
        this.entity.setLocalScale(scale);

        // bind the new frame (no rotation: transform already applied above)
        this.bindAsset(asset);
        console.log('[Splat.replaceData] bindAsset done, instance=', !!this.entity.gsplat?.instance);

        // add the new entity to the scene and configure its instance
        this.scene.contentRoot.addChild(this.entity);
        this.entity.gsplat.layers = [this.scene.splatLayer.id];
        this.rebuildMaterial(this.scene.events.invoke('view.bands'));

        // refresh gpu state/counts/bounds, then wait for the new frame to render
        // before removing the old entity, which keeps the previous frame on screen
        // in the meantime. Skip the wait during offline video render
        // (lockedRenderMode): renders are gated on scene.lockedRender there, so
        // blocking on a render would deadlock 閳?and the render loop sorts+captures
        // each frame deterministically anyway.
        await this.updateState(State.deleted);
        console.log('[Splat.replaceData] updateState done, instance=', !!this.entity.gsplat?.instance);
        if (!this.scene.lockedRenderMode) {
            await this.waitForRender();
        }
        console.log('[Splat.replaceData] waitForRender done, instance=', !!this.entity.gsplat?.instance);

        // notify dependents (e.g. the centers overlay, which parents itself under
        // this.entity) to re-bind to the new entity/instance before the old entity
        // is destroyed 閳?otherwise they're torn down with it and never re-attach
        // (no selection.changed fires on a frame swap).
        this.scene.events.fire('splat.replaced', this);

        // tear down the previous frame
        oldEntity.destroy();
        oldStateTexture.destroy();
        oldTransformTexture.destroy();
        if (!keepPrevious) {
            oldAsset.registry?.remove(oldAsset);
            oldAsset.unload();
        }

        this.changedCounter++;
        this.scene.forceRender = true;
        console.log('[Splat.replaceData] finished', this.name, 'instance=', !!this.entity.gsplat?.instance);
    }

    destroy() {
        super.destroy();
        this.releaseLodAssets();
        this.entity.destroy();
        this.asset.registry.remove(this.asset);
        this.asset.unload();
    }

    // ---- runtime LOD helpers (V3) ----

    /**
     * Register decimated proxy levels (coarsest FIRST, e.g. [10%, 35%] so
     * index 0 = most aggressive reduction, higher index = closer proxy).
     * Base data is whatever asset this splat currently renders; pass it via
     * `baseAsset` if the caller wants a specific reference (usually the
     * full-resolution loaded asset).
     */
    setLodAssets(assets: { asset: Asset; numSplats: number }[], baseAsset?: Asset) {
        this.releaseLodAssets();
        // store coarsest-first (reverse of the usual fractions order) so index 0
        // is always the most reduced level used at the greatest distance.
        this.lodAssets = assets.slice().reverse();
        this._lodBaseAsset = baseAsset ?? this.asset;
        this.lodLevel = -1;
        this.lodEnabled = this.lodAssets.length > 0;
    }

    /** Unload and forget proxy assets (called on destroy and re-registration). */
    releaseLodAssets() {
        for (const { asset } of this.lodAssets) {
            try {
                asset.registry?.remove(asset);
                asset.unload();
            } catch { /* ignore */ }
        }
        this.lodAssets = [];
        this.lodEnabled = false;
        this.lodLevel = -1;
    }

    /**
     * Swap the rendered data to proxy level `level` (-1 = full resolution).
     * Keeps the previous asset alive so the next switch back is cheap.
     */
    async applyLod(level: number) {
        const n = this.lodAssets.length;
        const next = level >= 0 && level < n ? level : -1;
        if (next === this.lodLevel && this.lodLevel !== -1) return; // idempotent (full base is level -1 but may be re-applied safely)
        const target = next === -1 ? (this._lodBaseAsset ?? this.asset) : this.lodAssets[next].asset;
        if (!target || target === this.asset) return;
        await this.replaceData(target, true);
        this.lodLevel = next;
        this._lodLastSwitchAt = performance.now();
        this.scene?.events?.fire('splat.lodChanged', this, next);
    }

    /**
     * Decide which LOD level the current camera distance calls for (delegates
     * to the pure lod.suggestLodLevel: per-level thresholds, one level at a
     * time, hysteresis against thrash).
     * @param distRatio - camera distance / model radius (>= ~2 when the model
     * fills the view, large when far away).
     */
    suggestLodLevel(distRatio: number): number {
        if (!this.lodEnabled || this.lodAssets.length === 0) return -1;
        return suggestLodLevel(distRatio, this.lodAssets.length, this.lodLevel);
    }

    /** True if a proxy level is currently rendered. */
    get lodActive() {
        return this.lodLevel >= 0;
    }

    async updateState(changedState = State.selected) {
        // uploads dirty range + refreshes counts in one pass.
        this.state.flush();
        this.numSplats = this.state.data.length - this.state.numDeleted;
        this.numLocked = this.state.numLocked;
        this.numSelected = this.state.numSelected;
        this.numDeleted = this.state.numDeleted;

        // handle splats being added or removed
        if (changedState & State.deleted) {
            await this.updateSorting();
        } else if (this._boundsDeferred) {
            // O1 (docs/audit/00-总结.md): a selection-only change cannot move either bound
            // in a way this pass is needed for. `localBound` is reduced from non-deleted rows
            // only (bound-shader skips state bit 4 and never reads bit 1) and the sole reader
            // of `selectionBound` is the transform handle's pivot (splat.getPivot, selection
            // = true). During a range-slider drag the pass therefore buys nothing while
            // costing a whole frame (waitForGpuDrain) plus four synchronous readbacks on every
            // push — 93k splats: 22-32ms, 13M: 25-60ms, and 99.9% of a push on a 2k fixture.
            // Mark it dirty instead; refreshDeferredBounds() recomputes once the drag settles.
            this._selectionBoundDirty = true;
        } else {
            await this.updateLocalBounds();
        }

        this.scene.forceRender = true;
        this.scene.events.fire('splat.stateChanged', this);
    }

    async updatePositions() {
        const data = await this.scene.dataProcessor.calcPositions(this);

        // update the splat centers which are used for render-time sorting
        const state = this.splatData.getProp('state') as Uint8Array;
        const { sorter } = this.entity.gsplat.instance;
        const { centers } = sorter;
        for (let i = 0; i < this.splatData.numSplats; ++i) {
            if (state[i] === State.selected) {
                centers[i * 3 + 0] = data[i * 4];
                centers[i * 3 + 1] = data[i * 4 + 1];
                centers[i * 3 + 2] = data[i * 4 + 2];
            }
        }

        await this.updateSorting();

        this.scene.forceRender = true;
        this.scene.events.fire('splat.positionsChanged', this);
    }

    async updateSorting() {
        const state = this.splatData.getProp('state') as Uint8Array;

        let mapping;

        // create a sorter mapping to remove deleted splats (unless showDeleted is on)
        if (this.numSplats !== state.length && !this._showDeleted) {
            mapping = new Uint32Array(this.numSplats);
            let idx = 0;
            for (let i = 0; i < state.length; ++i) {
                if ((state[i] & State.deleted) === 0) {
                    mapping[idx++] = i;
                }
            }
        }

        // update sorting instance (absent on WebGPU / before the sorter exists)
        this.entity.gsplat.instance.sorter?.setMapping(mapping);

        // recalculate bounds after sorting changes
        await this.updateLocalBounds();
    }

    get worldTransform() {
        return this.entity.getWorldTransform();
    }

    set name(newName: string) {
        if (newName !== this.name) {
            this._name = newName;
            this.scene.events.fire('splat.name', this);
        }
    }

    get name() {
        return this._name;
    }

    get filename() {
        return (this.asset.file as any).filename;
    }

    calcSplatWorldPosition(splatId: number, result: Vec3) {
        if (splatId >= this.splatData.numSplats) {
            return false;
        }

        // use centers data, which are updated when edits occur
        const { sorter } = this.entity.gsplat.instance;
        const { centers } = sorter;

        result.set(
            centers[splatId * 3 + 0],
            centers[splatId * 3 + 1],
            centers[splatId * 3 + 2]
        );

        this.worldTransform.transformPoint(result, result);

        return true;
    }

    async add() {
        // add the entity to the scene
        this.scene.contentRoot.addChild(this.entity);

        // assign splat to the dedicated splat layer (rendered by splat camera with MRT)
        this.entity.gsplat.layers = [this.scene.splatLayer.id];

        this.scene.events.on('view.bands', this.rebuildMaterial, this);
        this.rebuildMaterial(this.scene.events.invoke('view.bands'));

        // we must update state in case the state data was loaded from ply
        await this.updateState();
    }

    remove() {
        this.scene.events.off('view.bands', this.rebuildMaterial, this);

        this.scene.contentRoot.removeChild(this.entity);
        this.scene.boundDirty = true;
    }

    serialize(serializer: Serializer) {
        serializer.packa(this.entity.getWorldTransform().data);
        serializer.pack(this.changedCounter);
        serializer.pack(this.visible);
        serializer.pack(this.tintClr.r, this.tintClr.g, this.tintClr.b);
        serializer.pack(this.temperature, this.saturation, this.brightness, this.blackPoint, this.whitePoint, this.transparency);
        serializer.pack(this.highlights, this.shadows, this.contrast);
        serializer.pack(this.colorGradeEnabled ? 1 : 0);
        serializer.packa(Array.from(this._hslHue));
        serializer.packa(Array.from(this._hslSat));
        serializer.packa(Array.from(this._hslLum));
    }

    // WebGPU only: upload the camera matrices as material parameters (see the call
    // site in onPreRender and the notes in src/shaders/splat-shader-wgsl.ts). The
    // picture-in-picture preview writes the same parameters for its own camera and restores
    // them afterwards - see writeGpuCameraUniforms.
    private updateGpuCameraUniforms(instance: GSplatInstance) {
        writeGpuCameraUniforms(instance, this.scene.camera as unknown as GpuCameraSource);
    }

    /**
     * 给引擎的排序器装一道"相机闸门"（P0-2，2026-09-20，用户 2000 万点实测 ⑥）。
     *
     * 为什么必须装在**引擎**这一侧：`GSplatInstance.update()` 每帧都会调
     * `sorter.setCamera()`（`gsplat-instance.js:123-126`，引擎自己的门限是 1e-6，等于"动一点就发"），
     * 而 `GSplatSortWorker` 收到相机后按自己的 1e-3 门限决定是否真排（`gsplat-sort-worker.js:43-46`）。
     * 旋转时每帧方向变化远大于 1e-3 ⇒ **worker 只要在动就一直在排**：20M 一次全量排序约 0.4 s
     * （实测 `select.rect` 的那套相位表里 `selectRange` 同量级），也就是 ~2.5 次/秒，
     * 而每次排序完成引擎都要做一次 ~80 MB 的主线程上传 ⇒ 实测轨道旋转 max 帧 462~490 ms、
     * 4 秒内 6 帧 >33 ms（同机 idle median 16.6 ms）。
     * 所以只在"我们自己的派发"上做限流是没用的（实测：限流后仍 45 次/秒 postMessage）。
     *
     * 闸门规则：最快每 SORT_MIN_INTERVAL_MS 放行一次；被挡下的调用记住最新位姿，
     * 相机停稳 SORT_SETTLE_MS 后补发一帧 —— 静止画面用的仍是最终位姿的顺序。
     * 这与上游 SuperSplat 3.3.0 的策略同向（它运动帧完全不排序），只是我们仍保证 ~1 次/秒的
     * 顺序刷新，避免早期"顺序长时间不更新导致画面翻转/穿插"那个老问题（那段历史见下面 onPreRender 的注释）。
     */
    private ensureSorterGate(sorter: any) {
        if (!sorter || sorter.__splatRoomGate) {
            return;
        }
        const orig = sorter.setCamera.bind(sorter);
        sorter.setCamera = (pos: any, dir: any) => {
            const now = performance.now();
            if (now - this._sortLastDispatch >= SORT_MIN_INTERVAL_MS) {
                this._sortLastDispatch = now;
                this._sortSettleAt = 0;
                orig(pos, dir);
            } else if (this._sortSettleAt === 0) {
                // 挡下了：安排"停手后补一帧"。补帧在 onPreRender 里做（它拿到的是同一帧的相机位姿）。
                this._sortSettleAt = now + SORT_SETTLE_MS;
            }
        };
        sorter.__splatRoomGate = true;
    }

    /**
     * 让下一帧补一次"停手后的干净排序"（交互期降级 / 运动期限流的收尾）。
     *
     * 为什么需要显式调用，而不是依赖 `_sortSettleAt` 那套启发式：那条路的截止点**只在"被 800 ms 闸门
     * 挡下的帧"里才会被武装**（`_sortSettleAt === 0` 时置位），而闸门放行时又会把它清零 ——
     * 于是"最后一次放行"之后如果没再出现被挡下的帧，停手时就**没有任何补帧**。2026-09-21 实测：
     * 2.5 秒连续旋转 + 停手 900 ms，`worker.postMessage` **0 次**（`verify-motion-quality.cjs` 的
     * "settling issues one final clean sorted frame" 一项抓到的就是它）。
     * 另外要注意：闸门包的是 `sorter.setCamera`，它**不一定会真的给 worker 发消息**
     * （引擎 worker 自己还有 1e-3 门限），所以"闸门放行次数"也不能当作排序已刷新的证据。
     *
     * 本方法只把截止点置成"已过期"（`1`），真正的派发仍走 onPreRender 里那条停手分支
     * （它用的是**当帧**的相机位姿，因此补出来的顺序与静止画面一致）；已经武装过就什么都不做
     * ⇒ 一次手势最多补一帧，不会重复排序。
     */
    forceSettleSort() {
        if (this._sortSettleAt === 0) {
            this._sortSettleAt = 1;
        }
    }

    /** 是否还有"停手补帧"欠着没派发（Scene 用它决定要不要继续出帧，见 scene.ts） */
    get sortSettlePending() {
        return this._sortSettleAt !== 0;
    }

    /**
     * 直接给排序 worker 派一次全量排序（绕开引擎 1e-3 的 epsilon 门限）。
     *
     * 引擎的 `GSplatInstance.sort()` 对相机方向用 `equalsApprox(..., 1e-3)`：缓慢旋转时
     * 每帧方向变化约 1e-4，远小于门限 ⇒ 引擎把请求丢掉、worker 一直用旧顺序（画面"翻转/穿插"）。
     * 所以这里自己按 splat 局部坐标的相机位姿直接 `postMessage`，并带 `forceUpdate: true`。
     * `_sortInFlight` 的合并逻辑（gsplat-sorter.js 的补丁）保证同一时刻只有一个排序在飞，
     * 飞行期间只记一个"待办位姿"——所以这里派发多少次都不会堆队列。
     */
    private dispatchSort(localPos: Vec3, localDir: Vec3) {
        try {
            const inst = this.entity?.gsplat?.instance;
            const ws = inst?.sorter as any;
            if (!ws || !ws.worker) {
                return;
            }
            if (ws._sortInFlight) {
                ws._pendingCamera = {
                    pos: { x: localPos.x, y: localPos.y, z: localPos.z },
                    dir: { x: localDir.x, y: localDir.y, z: localDir.z }
                };
            } else {
                ws._sortInFlight = true;
                ws.worker.postMessage({
                    cameraPosition: { x: localPos.x, y: localPos.y, z: localPos.z },
                    cameraDirection: { x: localDir.x, y: localDir.y, z: localDir.z },
                    forceUpdate: true
                });
            }
        } catch (e) {
            // best-effort：排序失败不该影响渲染
        }
    }

    onPreRender() {
        // SurfaceRefine / replaceData 閻ㄥ嫬鑻熼崣鎴濇簚閺咁垯绗呴敍灞炬煀 entity 閻?gsplat instance
        // 閸欘垵鍏樻潻妯绘弓鐏忚京鍗庨敍宀冪儲鏉╁洦婀扮敮褍鑻熼崷銊﹀付閸掕泛褰存潏鎾冲毉娑撯偓濞嗏剝鈧嗙槚閺傤厺淇婇幁顖樷偓?
        if (!this.entity?.gsplat?.instance) {
            console.warn(`[Splat.onPreRender] skipped: entity=${!!this.entity}, gsplat=${!!this.entity?.gsplat}, instance=${!!this.entity?.gsplat?.instance}, name=${this.name}, changedCounter=${this.changedCounter}`);
            return;
        }

        // ---- 娑撴槒顫嬮崶鐐笓鎼村繐鍘规惔鏇礄SplatRoom patch閿?---
        // 瀵洘鎼搁惃鍕笓鎼村繘鎽肩捄顖欑贩鐠?culler 濮ｅ繐鎶氶幎濠佸瘜閻╁憡婧€ push 鏉?instance.cameras[]閿?
        // 閻掕泛鎮?GSplatInstance.update() 鐠?instance.sort(cameras[0]) 鐟欙箑褰?
        // worker 濞ｅ崬瀹抽幒鎺戠碍閵嗗倸缍嬬拠銉╂懠鐠侯垰銇戦弫鍫礄culler 娑撳秴锝為崗?cameras 閳ユ柡鈧?婢堆勀侀崹?/
        // 閻楃懓鐣?AABB / group-renderer 閸氬牆鑻熼崥搴濋嚋娴?splat 鐞氼偊娈ｉ挊蹇曠搼閿涘绱漵ort() 娴犲簼绗?
        // 閹笛嗩攽 閳?worker 閹烘帒绨崘鑽ょ波閸︺劌鍨垫慨瀣祲閺堢儤鏌熼崥?閳?閻╁憡婧€缁夎濮╅崥搴㈢箒鎼达箓銆庢惔蹇涙晩鐠?=
        // "鏉╂垵鐨潻婊冦亣"閿涘牆宕愰柅蹇旀妤傛ɑ鏌夋潻婊呮磰鏉╂埊绱氶妴渚緄P 閻劎瀚粩?CPU/Worker 閹烘帒绨紒鏇炵磻
        // cameras 娓氭繆绂嗛幍鈧禒銉︻劀鐢潻绱辨稉鏄忣潒閸ユ儳婀潻娆撳櫡鐞涖儱鎮撻弽椋庢畱"濮ｅ繐鎶氬鍝勫煑 sort"閿?
        //   1. instance.sort() 閸愬懘鍎撮張?equalsApprox 閼哄倹绁﹂敍鍫㈡祲閺堣桨缍呯純?閺傜懓鎮滃▽鈥冲綁
        //      鐏忓彉绗夐柌宥嗘煀閹绘劒姘﹂敍澶涚礉閹碘偓娴犮儲鐦＄敮褑鐨熼悽銊︽Ц瀵ゅ鐜惃鍕剁礉娑撳秳绱扮紒?worker 閸掔兘鍣洪妴?
        //   2. 瀵洘鎼?sorter 閺?_sortInFlight coalesce 鐞涖儰绔甸敍灞惧笓鎼村繋鑵戦崘宥埿曢崣?
        //      娴兼艾鎮庨獮鏈佃礋閺堚偓閺傛壆娴夐張鍝勑幀渚婄礉娑撳秳绱伴崼鍡櫺濋梼鐔峰灙閵?
        //   3. PiP 濠碘偓濞茬粯妞傞張顒€鐤勬笟瀣畱 sorter 鐞?swap 閹?pipSorter閿涘牏瀚粩瀣吀缁惧尅绱氶敍?
        //      閺堫剙鍘规惔鏇犳暏 instance.sort() 娴犲秴褰ф担婊呮暏娴滃骸缍嬮崜?sorter 閳ユ柡鈧?娴?PiP
        //      swap 閸欘亜褰傞悽鐔锋躬 onPostRender 閻ㄥ嫮鐓弳鍌滅崶閸欙絽鍞撮敍灞肩瑬 restore 閸?sorter
        //      閹垹顦叉稉杞板瘜 sorter閿涘本澧嶆禒銉ㄧ箹闁插矁鐨熼悽銊ヮ潗缂佸牆鐣ㄩ崗銊ｂ偓?
        //   4. 閸氬牆鑻熷〒鍙夌厠閿涘潛roupRenderer.isActive閿涘妞傛稉顏冪秼 splat 閻?meshInstance
        //      闁艾鐖剁悮顐︽閽樺骏绱濋張顒€鍘规惔鏇烆嚠鐎瑰啩婊戦弮鐘差唺閿涘牅绗夊〒鍙夌厠閿涘绱遍崥鍫濊嫙鐎圭偘缍嬮懛顏囬煩閻ㄥ嫭甯撴惔?
        //      閻?group-renderer.ts 閹靛濮?sort() 娣囨繆鐦夐妴?
        const inst = this.entity.gsplat.instance;
        // group-renderer 閸氬牆鑻熷┑鈧ú缁樻閿涘奔閲滄担?splat 閻?layers 鐞氼偅绔荤粚鐚寸礄娑撳秴寮稉搴㈣閺屾搫绱氶敍?
        // 閸忚埖甯撴惔蹇撳幑鎼存洘鐦＄敮?postMessage 閺勵垳鍑藉ù顏囧瀭閿涘牆鎮庨獮璺虹杽娴ｆ挻婀侀懛顏勭箒閻ㄥ嫭甯撴惔蹇ョ礉鐟?
        // scene.ts onPreRender閿涘鈧倹顥呭ù瀣煂鐞氼偊娈ｉ挊蹇曟纯閹恒儴鐑︽潻鍥ㄦ殻娑擃亝甯撴惔蹇撳幑鎼存洏鈧?
        const gsplatComp = this.entity.gsplat;
        const hiddenByGroup = !!gsplatComp && gsplatComp.layers.length === 0;
        const mainCamNode = (this.scene.camera as any)?.mainCamera as any;
        if (!mainCamNode) {
            // 娑撹崵娴夐張鍝勭穿閻劎宸辨径鎲嬬窗閹烘帒绨崗婊冪俺閺冪姵纭堕崣鏍祲閺堝搫协閹?閳?worker 閹烘帒绨导姘枙缂佹挸婀?
            // 閸掓繂顫愰惄鍛婃簚閿涘牐銆冮悳棰佽礋"鏉╂垵鐨潻婊冦亣"閿涘鈧倽绻栭弰顖氱磽鐢摜濮搁幀渚婄礉娑撯偓濞嗏剝鈧冩啞鐠€锔芥瘹闂囧眰鈧?
            if (!this._warnedNoMainCam) {
                this._warnedNoMainCam = true;
                console.warn('[Splat.onPreRender] mainCamNode 缂傚搫銇戦敍姘瘜鐟欏棗娴橀幒鎺戠碍閸忔粌绨崇悮顐ョ儲鏉╁浄绱濋惄鍛婃簚缁夎濮╅弮鑸电箒鎼达附甯撴惔蹇撳讲閼宠棄鍠曠紒鎿勭礄鏉╂垵鐨潻婊冦亣閿涘鈧靠cene.camera.mainCamera 閺堫亜姘ㄧ紒顏庣吹');
            }
        }
        if (!hiddenByGroup && mainCamNode && inst.sorter) {
            // P0-2：给引擎的相机派发装闸门（幂等，只会装一次）
            this.ensureSorterGate(inst.sorter);
            // ---- Per-frame main-view sort fallback (bypasses engine epsilon gating) ----
            // Engine GSplatInstance.sort() at gsplat-instance.js L123 uses
            // equalsApprox(...,1e-3) on camera direction. Under slow rotation,
            // each frame's direction change is ~1e-4 per ~16ms 閳?well under
            // 1e-3 閳?so the engine drops the request and the worker keeps
            // serving stale orders. The user sees a "rotated / flipped /
            // intruded" view because the latest camera pose isn't reflected in
            // the depth-binning worker until the delta accumulates past 1e-3
            // (many frames later).
            //
            // We mirror the engine's math exactly (world cam pos/dir 閳?
            // splat-local via invModelMat) but use a much tighter detection
            // threshold (1e-12) so tiny camera motion is noticed at all. Sorter's
            // _sortInFlight coalesce patch (gsplat-sorter.js L129) absorbs the
            // request spike without queueing unlimited worker tasks.
            //
            // FIX (2026-08-12): removed the 3-frame throttle. The throttle was
            // introduced for performance (order-texture upload cost) but caused
            // visible "鏉╂垵鐨潻婊冦亣" when the engine culler skips camera population.
            //
            // P0-2 FIX (2026-09-20，用户 2000 万点实测 ⑥)：真正的瓶颈不在"我们自己的派发"，
            // 而在引擎每帧无条件调 sorter.setCamera()（见 ensureSorterGate 的注释）；
            // 这里保留原来的灵敏检测（1e-12）在间隔到点时主动补一次带 forceUpdate 的派发
            // （绕开 worker 自己的 1e-3 门限），并在停手后补最后一帧。
            const camWorld = mainCamNode.getWorldTransform();
            camWorld.getTranslation(_fallbackCamPos);
            camWorld.getZ(_fallbackCamDir);
            const modelWorld = inst.meshInstance.node.getWorldTransform();
            _fallbackInvModel.copy(modelWorld).invert();
            _fallbackInvModel.transformPoint(_fallbackCamPos, _fallbackLocalPos);
            _fallbackInvModel.transformVector(_fallbackCamDir, _fallbackLocalDir);
            const dx = _fallbackLocalPos.x - this._sortLastPos.x;
            const dy = _fallbackLocalPos.y - this._sortLastPos.y;
            const dz = _fallbackLocalPos.z - this._sortLastPos.z;
            const ddx = _fallbackLocalDir.x - this._sortLastDir.x;
            const ddy = _fallbackLocalDir.y - this._sortLastDir.y;
            const ddz = _fallbackLocalDir.z - this._sortLastDir.z;
            const moved = dx * dx + dy * dy + dz * dz > 1e-12 ||
                ddx * ddx + ddy * ddy + ddz * ddz > 1e-12;

            // ---- P0-2（2026-09-20，用户 2000 万点实测 ⑥）：交互期别再"每帧派一次全量排序" ----
            // 原来只要相机动了（epsilon 1e-12，等于"任何移动"）就派一次 worker 全量排序，
            // 20M 上一次排序 0.3~0.5 s，叠加引擎"排序完成要 80 MB 主线程 memcpy"的上传，
            // 实测轨道旋转期间 worker 100% 饱和、max 帧 462.8 ms、3 秒内 5 帧 >33 ms。
            // 上游 SuperSplat 3.3.0 的做法更激进：运动帧完全不排序，静止帧才 GPU 排序。
            // 这里取中间：在 sorter.setCamera 上装闸门（见 ensureSorterGate），把**引擎那条路**
            // 限到 SORT_MIN_INTERVAL_MS 一次，**停手后 SORT_SETTLE_MS 再补一帧**，
            // 保证最终画面与静止帧一致。
            const now = performance.now();
            if (moved) {
                this._sortLastPos.copy(_fallbackLocalPos);
                this._sortLastDir.copy(_fallbackLocalDir);
                if (now - this._sortLastDispatch >= SORT_MIN_INTERVAL_MS) {
                    // 间隔到了：这一帧用的就是最新位姿，不需要再补帧
                    this._sortLastDispatch = now;
                    this._sortSettleAt = 0;
                    this.dispatchSort(_fallbackLocalPos, _fallbackLocalDir);
                } else if (this._sortSettleAt === 0) {
                    // 被最小间隔挡下了：安排"停手后补一帧干净排序"
                    this._sortSettleAt = now + SORT_SETTLE_MS;
                }
            } else if (this._sortSettleAt !== 0 && now >= this._sortSettleAt) {
                // 相机真的停了（连续 SORT_SETTLE_MS 没有位移）→ 补最后一帧。
                // 注意这里**不能**在"还没到点"时把 deadline 往后推：空闲帧会一直推，
                // 补帧就永远不会发生（第一版就是这么写的）。
                this._sortSettleAt = 0;
                this._sortLastDispatch = now;
                this.dispatchSort(_fallbackLocalPos, _fallbackLocalDir);
            }
        }

        const events = this.scene.events;
        const selected = this.scene.camera.renderOverlays && events.invoke('selection') === this;
        const cameraMode = events.invoke('camera.mode');
        const cameraOverlay = events.invoke('camera.overlay');

        // WebGPU: the splat material reads its camera matrices from material
        // parameters (see splat-shader-wgsl.ts) because the engine's view uniform
        // buffer is not bound correctly for this material in our custom render-pass
        // pipeline 鈥?matrix_view reads as the identity matrix, which collapses every
        // splat to a degenerate point and leaves the viewport empty.
        if (this.scene.graphicsDevice.isWebGPU) {
            this.updateGpuCameraUniforms(this.entity.gsplat.instance);
        }

        // configure rings rendering
        const material = this.entity.gsplat.instance.material;
        material.setParameter('outlineMode', events.invoke('view.outlineSelection') ? 1 : 0);
        material.setParameter('ringSize', (selected && cameraOverlay && cameraMode === 'rings') ? 0.04 : 0);

        // configure colors
        const selectedClr = events.invoke('selectedClr');
        const unselectedClr = events.invoke('unselectedClr');
        const lockedClr = events.invoke('lockedClr');

        if (!selected) {
            material.setParameter('selectedClr', [0, 0, 0, 0]);
        } else if (events.invoke('view.outlineSelection')) {
            material.setParameter('selectedClr', [0, 0, 0, 0]);
        } else {
            material.setParameter('selectedClr', [selectedClr.r, selectedClr.g, selectedClr.b, selectedClr.a * this.selectionAlpha]);
        }
        material.setParameter('unselectedClr', [unselectedClr.r, unselectedClr.g, unselectedClr.b, unselectedClr.a]);
        material.setParameter('lockedClr', [lockedClr.r, lockedClr.g, lockedClr.b, lockedClr.a]);

        // combine black pointer, white point and brightness
        if (this._colorGradeEnabled) {
            const offset = -this.blackPoint + this.brightness;
            const denom = Math.max(0.001, this.whitePoint - this.blackPoint);
            const scale = 1 / denom;

            material.setParameter('clrOffset', [offset, offset, offset]);
            material.setParameter('clrScale', [
                scale * this.tintClr.r * (1 + this.temperature),
                scale * this.tintClr.g,
                scale * this.tintClr.b * (1 - this.temperature),
                this.transparency
            ]);

            material.setParameter('saturation', this.saturation);
            material.setParameter('highlights', this.highlights);
            material.setParameter('shadows', this.shadows);
            material.setParameter('contrast', this.contrast);
            material.setParameter('showDeleted', this._showDeleted ? 1 : 0);
            material.setParameter('hslHueA', [this._hslHue[0], this._hslHue[1], this._hslHue[2], this._hslHue[3]]);
            material.setParameter('hslHueB', [this._hslHue[4], this._hslHue[5], this._hslHue[6], this._hslHue[7]]);
            material.setParameter('hslSatA', [this._hslSat[0], this._hslSat[1], this._hslSat[2], this._hslSat[3]]);
            material.setParameter('hslSatB', [this._hslSat[4], this._hslSat[5], this._hslSat[6], this._hslSat[7]]);
            material.setParameter('hslLumA', [this._hslLum[0], this._hslLum[1], this._hslLum[2], this._hslLum[3]]);
            material.setParameter('hslLumB', [this._hslLum[4], this._hslLum[5], this._hslLum[6], this._hslLum[7]]);
        } else {
            // bypass all color grading 閳?neutral values
            material.setParameter('clrOffset', [0, 0, 0]);
            material.setParameter('clrScale', [1, 1, 1, 1]);
            material.setParameter('saturation', 1);
            material.setParameter('highlights', 0);
            material.setParameter('shadows', 0);
            material.setParameter('contrast', 0);
            material.setParameter('showDeleted', this._showDeleted ? 1 : 0);
            material.setParameter('hslHueA', [0, 0, 0, 0]);
            material.setParameter('hslHueB', [0, 0, 0, 0]);
            material.setParameter('hslSatA', [0, 0, 0, 0]);
            material.setParameter('hslSatB', [0, 0, 0, 0]);
            material.setParameter('hslLumA', [0, 0, 0, 0]);
            material.setParameter('hslLumB', [0, 0, 0, 0]);
        }
        material.setParameter('transformPalette', this.transformPalette.texture);

        // oriented crop-box clipping (SplatRoom)
        const cropBox = events.invoke('cropBox');
        if (cropBox && cropBox.enabled) {
            const cam = this.scene.camera.camera;
            invView.copy(cam.viewMatrix).invert();
            invBoxWorld.copy(cropBox.pivot.getWorldTransform()).invert();
            viewToBoxLocal.mul2(invBoxWorld, invView);
            material.setParameter('uCropBoxEnabled', 1);
            material.setParameter('uViewToBoxLocal', viewToBoxLocal.data);
            material.setParameter('uCropBoxPreview', cropBox.preview ? 1 : 0);
            material.setParameter('uCropBoxSoftEdge', cropBox.softEdge);
            // shape + geometry uniforms
            material.setParameter('uCropBoxShape', cropBox.shape === 'box' ? 0 : cropBox.shape === 'cylinder' ? 1 : 2);
            material.setParameter('uCropBoxRadiusX', cropBox.radiusX);
            material.setParameter('uCropBoxRadiusY', cropBox.radiusY);
            material.setParameter('uCropBoxRadiusZ', cropBox.radiusZ);
            material.setParameter('uCropBoxHeight', cropBox.height);
            // 閸掑洭娼伴敍鍧坅p plane閿涘绱伴棃銏℃緲鐎硅棄瀹抽敍鍫㈡磪 local 閸楁洑缍呴敍澶婂枀鐎规艾鍨忛棃銏犵敨閸樻艾瀹抽垾鏂衡偓?
            // 0.03 閳?閻╂帒顔?6%閿涘牆顧勭€?閳?婢舵矮閲滅悮顐㈠瀼 splat 閹搭亪娼伴柈鍊熺箻閸忋儱鍨忛棃顫礉鐎靛棗瀹虫姗堢礆閿?
            // capAlpha 閹貉冨煑閸掑洭娼伴悧鍥у帗 alpha 閳ユ柡鈧?0.25 閺勵垳鏁庨悙鐧哥窗鏉╁洣缍?0.08)閸涘牆宕愰柅蹇旀
            // 闂嗗墽濮?缁绢垵澹婇崸?閿涘矁绻冩?0.6)閸楁洘鍩呴棃銏犵暚閸忋劏顩惄鏍ф倵缂?閳?濮ｅ繋閲?splat 閹搭亪娼?
            // 閻欘剛鐝涚€圭偛绺?= "鐎圭偛绺鹃悧鍥╁Ц濡烆厼娓?閵?.25 閺冭泛顦挎稉顏呭焻闂堛垹宕愰柅蹇旀閸欑姴濮為敍宀勵杹閼?
            // 濞ｅ嘲鎮庢稉鍝勫隘閸╃喐璐╅崥鍫ｅ閿涘牆鎮庨幋鎰ゴ鐠囨洩绱伴崑蹇撴▕娴?0.02閿涘鈧?
            // 妫版粏澹婃稉宥堫洬閻?閳?閸掑洭娼扮挧鎷岊潶閸掑洭鐝弬顖涙拱閼?+ 閸氬海鐢荤拫鍐缁狅紕鍤庨敍鍦歋L/contrast
            // 缁涘绱氶妴淇pColor 娴犲秳绱堕崗銉ょ稻 shader 娑撳秴鍟€鐠囨眹鈧?
            material.setParameter('uCropBoxCapWidth', 0.03);
            material.setParameter('uCropBoxCapAlpha', 0.25);
            material.setParameter('uCropBoxCapColor', [1, 1, 1, 1]);
        } else {
            material.setParameter('uCropBoxEnabled', 0);
            material.setParameter('uCropBoxPreview', 0);
            material.setParameter('uCropBoxSoftEdge', 0.005);
            material.setParameter('uCropBoxShape', 0);
            material.setParameter('uCropBoxRadiusX', 0.35);
            material.setParameter('uCropBoxRadiusY', 0.35);
            material.setParameter('uCropBoxRadiusZ', 0.35);
            material.setParameter('uCropBoxHeight', 0.8);
            material.setParameter('uCropBoxCapWidth', 0);
            material.setParameter('uCropBoxCapAlpha', 1);
            material.setParameter('uCropBoxCapColor', [1, 1, 1, 1]);
        }

        if (this.visible && selected) {
            // render bounding box
            if (events.invoke('camera.bound')) {
                const bound = this.localBound;
                const scale = new Mat4().setTRS(bound.center, Quat.IDENTITY, bound.halfExtents);
                scale.mul2(this.entity.getWorldTransform(), scale);

                for (let i = 0; i < boundingPoints.length / 2; i++) {
                    const a = boundingPoints[i * 2];
                    const b = boundingPoints[i * 2 + 1];
                    scale.transformPoint(a, veca);
                    scale.transformPoint(b, vecb);

                    this.scene.app.drawLine(veca, vecb, Color.WHITE, true, this.scene.worldLayer);
                }
            }
        }

        this.entity.enabled = this.visible;
    }

    focalPoint() {
        const data = this.splatData;
        if (!data) {
            return this.worldBound.center;
        }

        const numSplats = data.numSplats;
        const x = data.getProp('x') as Float32Array;
        const y = data.getProp('y') as Float32Array;
        const z = data.getProp('z') as Float32Array;
        const opacity = data.getProp('opacity') as Float32Array;
        const sx = data.getProp('scale_0') as Float32Array;
        const sy = data.getProp('scale_1') as Float32Array;
        const sz = data.getProp('scale_2') as Float32Array;

        // fall back to AABB center if any required channel is missing
        if (!x || !y || !z || !opacity || !sx || !sy || !sz) {
            return this.worldBound.center;
        }

        let sumX = 0, sumY = 0, sumZ = 0;
        let totalWeight = 0;

        // 2026-09-20（用户 2000 万点实测 ⑥）：这里原来对**每个点**跑一次加权求和，
        // 每点两次 Math.exp ⇒ 20M 就是 4000 万次 exp（实测秒级），而"框显所选"、
        // 导入取景、camera.reset 每次都会调它。同一个文件里的 denseRadius() 对 >50 万点
        // 早就改成抽样了，这里照做：抽样只影响重心的小数位，不影响取景观感。
        const stride = numSplats > 500000 ? Math.ceil(numSplats / 200000) : 1;

        for (let i = 0; i < numSplats; i += stride) {
            // opacity is stored in raw (pre-sigmoid) log space, apply sigmoid
            // to get [0,1] range. scale is in log space, exp() gives linear size.
            const op = 1 / (1 + Math.exp(-opacity[i]));
            const w = op / (1 + Math.exp(Math.max(sx[i], sy[i], sz[i])));
            sumX += x[i] * w;
            sumY += y[i] * w;
            sumZ += z[i] * w;
            totalWeight += w;
        }

        const result = new Vec3();
        if (totalWeight > 0) {
            result.set(sumX / totalWeight, sumY / totalWeight, sumZ / totalWeight);
        } else {
            return this.worldBound.center;
        }

        // transform from local space to world space
        this.entity.getWorldTransform().transformPoint(result, result);

        return result;
    }

    denseRadius() {
        // Compute a density-weighted radius that covers the concentrated region.
        // Uses weighted standard deviation of positions, with the same alpha*scale
        // weighting as focalPoint(). Returns 3鑴?the max weighted stddev, which
        // captures ~99% of the concentrated Gaussians.
        const data = this.splatData;
        if (!data) {
            return this.worldBound.halfExtents.length();
        }

        const numSplats = data.numSplats;
        const x = data.getProp('x') as Float32Array;
        const y = data.getProp('y') as Float32Array;
        const z = data.getProp('z') as Float32Array;
        const opacity = data.getProp('opacity') as Float32Array;
        const sx = data.getProp('scale_0') as Float32Array;
        const sy = data.getProp('scale_1') as Float32Array;
        const sz = data.getProp('scale_2') as Float32Array;

        if (!x || !y || !z || !opacity || !sx || !sy || !sz) {
            return this.worldBound.halfExtents.length();
        }

        // First pass: compute weighted mean
        let totalWeight = 0;
        let meanX = 0, meanY = 0, meanZ = 0;
        // Use sampling for huge models (>500k points) to avoid blocking
        const stride = numSplats > 500000 ? Math.ceil(numSplats / 200000) : 1;

        for (let i = 0; i < numSplats; i += stride) {
            const op = 1 / (1 + Math.exp(-opacity[i]));
            const w = op / (1 + Math.exp(Math.max(sx[i], sy[i], sz[i])));
            meanX += x[i] * w;
            meanY += y[i] * w;
            meanZ += z[i] * w;
            totalWeight += w;
        }

        if (totalWeight === 0) {
            return this.worldBound.halfExtents.length();
        }

        meanX /= totalWeight;
        meanY /= totalWeight;
        meanZ /= totalWeight;

        // Second pass: compute weighted variance
        let varX = 0, varY = 0, varZ = 0;
        for (let i = 0; i < numSplats; i += stride) {
            const op = 1 / (1 + Math.exp(-opacity[i]));
            const w = op / (1 + Math.exp(Math.max(sx[i], sy[i], sz[i])));
            const dx = x[i] - meanX;
            const dy = y[i] - meanY;
            const dz = z[i] - meanZ;
            varX += dx * dx * w;
            varY += dy * dy * w;
            varZ += dz * dz * w;
        }

        varX /= totalWeight;
        varY /= totalWeight;
        varZ /= totalWeight;

        // 3鑴?sigma covers ~99% of concentrated Gaussians
        const sigma = 3;
        const radius = sigma * Math.sqrt(Math.max(varX, varY, varZ));

        // scale by world transform (uniform scale approximation)
        const worldScale = this.entity.getWorldTransform().getScale();
        return Math.max(radius * (worldScale.x + worldScale.y + worldScale.z) / 3, 0.001);
    }

    /**
     * 取景半径：给相机"把模型框进画面"用。
     *
     * 为什么不是 `worldBound.halfExtents.length()`（AABB 半对角线）：扫描件里常有一小撮
     * 离得很远的噪声点，AABB 会被它们撑爆。用户 2000 万点实测（2026-09-20）：
     *   AABB 半径 8297，而真正看得见的那一坨只有 153 —— 相机因此停在 8~16 km 外，
     *   屏幕上只剩一个点（用户原话："框显所选应该显示完整模型，现在只显示一小块"）。
     *
     * 这里用**裁剪包围盒**：按轴各取 1%~99% 分位，去掉两端极值，再取半对角线。
     * 为什么不是 `denseRadius()`（不透明度×尺度的加权 3σ）：那个量是"密度重心"的统计半径，
     * 对薄墙 / 稀疏结构会明显偏小（实测会让既有取景语义变化：两套回归套件直接失败），
     * 而裁剪分位数只丢极值、不做加权，对正常模型与 AABB 同量级。
     */
    framingRadius(): number {
        const data = this.splatData;
        const x = data?.getProp('x') as Float32Array;
        const y = data?.getProp('y') as Float32Array;
        const z = data?.getProp('z') as Float32Array;
        if (!data || !x || !y || !z) {
            return this.worldBound.halfExtents.length();
        }

        const numSplats = data.numSplats;
        // 抽样上限 20 万：取分位数只要趋势，13M 上一次全扫要 ~500ms，抽样后 ~10ms
        const stride = Math.max(1, Math.ceil(numSplats / 200000));
        const count = Math.ceil(numSplats / stride);
        const sx = new Float32Array(count);
        const sy = new Float32Array(count);
        const sz = new Float32Array(count);
        let k = 0;
        for (let i = 0; i < numSplats; i += stride) {
            sx[k] = x[i];
            sy[k] = y[i];
            sz[k] = z[i];
            k++;
        }
        sx.sort();
        sy.sort();
        sz.sort();

        // 1% / 99% 分位（两端各丢 1% 的极值）
        const lo = Math.floor(count * 0.01);
        const hi = Math.min(count - 1, Math.ceil(count * 0.99));
        const half = (arr: Float32Array) => Math.max((arr[hi] - arr[lo]) * 0.5, 0);

        // 世界尺度（与 denseRadius 同一套近似：三轴平均缩放）
        const worldScale = this.entity.getWorldTransform().getScale();
        const s = (worldScale.x + worldScale.y + worldScale.z) / 3;
        const trimmed = Math.sqrt(half(sx) ** 2 + half(sy) ** 2 + half(sz) ** 2) * s;

        // 取景半径不该比"实心几何"更小：模型整体只有几十个点时上面的分位数会退化成 0
        const bound = this.worldBound.halfExtents.length();
        const radius = Math.max(trimmed * 1.1, Math.min(bound, 1e-3));
        return Math.max(radius, 1e-6);
    }

    move(position?: Vec3, rotation?: Quat, scale?: Vec3) {
        const entity = this.entity;
        if (position) {
            entity.setLocalPosition(position);
        }
        if (rotation) {
            entity.setLocalRotation(rotation);
        }
        if (scale) {
            entity.setLocalScale(scale);
        }

        this.updateWorldBound();

        this.scene.events.fire('splat.moved', this);
    }

    // calculate both selection and local bounds (async, callers must await)
    async updateLocalBounds(): Promise<void> {
        await this.scene.dataProcessor.calcBound(this, this.selectionBoundStorage, this.localBoundStorage);

        // The bound pass can come back unusable. On WebGPU its readback currently returns
        // nothing (every splat bound comes back as all zeros, silently), and on either
        // backend a pass that matched no row at all used to write the shader's ±1e6
        // sentinel straight through — centre 0, halfExtents -1e6. A degenerate local bound
        // collapses the scene bound, so the camera cannot frame the model and its near/far
        // clips end up equal: the projection matrix goes NaN and the viewport stays black
        // for every model, regardless of size, until the offending edit is undone.
        // Fall back to the AABB the engine computed on the CPU when the resource was
        // created (it holds the same local-space extent).
        // CalcBound no longer publishes that sentinel box, so this is the backstop.
        if (!Splat.isUsableBound(this.localBoundStorage) && Splat.isUsableBound(this.cpuBoundStorage)) {
            this.localBoundStorage.copy(this.cpuBoundStorage);
        }

        this.updateWorldBound();

        // the pass just refreshed both bounds, so nothing is pending any more (O1)
        this._selectionBoundDirty = false;
    }

    /** True while selection-only state changes postpone the GPU bound pass (O1). */
    get boundsDeferred() {
        return this._boundsDeferred;
    }

    set boundsDeferred(value: boolean) {
        this._boundsDeferred = value;
    }

    /** True when a selection change landed while the bound pass was postponed (O1). */
    get selectionBoundDirty() {
        return this._selectionBoundDirty;
    }

    /**
     * Recompute the bounds once after a burst of deferred selection changes — i.e. when a
     * range-slider drag settles. No-op when nothing was postponed, and cheap
     * (`state.flush()` is already a no-op by then) when there was.
     */
    async refreshDeferredBounds(): Promise<void> {
        if (this._selectionBoundDirty) {
            await this.updateLocalBounds();
        }
    }

    // a bound is usable when it has a finite centre, finite non-negative extents and a
    // non-zero size. The sign test matters: "no rows matched" used to arrive as
    // halfExtents = -1e6 (see updateLocalBounds), and a negative extent is never a
    // legitimate local bound.
    private static isUsableBound(bound: BoundingBox | null | undefined): boolean {
        if (!bound) {
            return false;
        }
        const { x, y, z } = bound.center;
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
            return false;
        }
        const h = bound.halfExtents;
        if (!Number.isFinite(h.x) || !Number.isFinite(h.y) || !Number.isFinite(h.z)) {
            return false;
        }
        if (h.x < 0 || h.y < 0 || h.z < 0) {
            return false;
        }
        return (h.x + h.y + h.z) > 1e-8;
    }

    // update world bound from local bound (synchronous)
    private updateWorldBound() {
        this.worldBoundStorage.setFromTransformedAabb(this.localBoundStorage, this.entity.getWorldTransform());
        this.scene.boundDirty = true;
    }

    // get the selection bound
    get selectionBound() {
        return this.selectionBoundStorage;
    }

    // get local space bound
    get localBound() {
        return this.localBoundStorage;
    }

    // get world space bound
    get worldBound() {
        return this.worldBoundStorage;
    }

    set visible(value: boolean) {
        if (value !== this.visible) {
            this._visible = value;
            this.scene?.events.fire('splat.visibility', this);
        }
    }

    get visible() {
        return this._visible;
    }

    set showDeleted(value: boolean) {
        if (value !== this._showDeleted) {
            this._showDeleted = value;
            // update sorter mapping to include/exclude deleted points
            this.updateSorting();
            this.scene.forceRender = true;
            this.scene?.events.fire('splat.showDeleted', this);
        }
    }

    get showDeleted() {
        return this._showDeleted;
    }

    set tintClr(value: Color) {
        if (!this._tintClr.equals(value)) {
            this._tintClr.set(value.r, value.g, value.b);
            this.scene.events.fire('splat.tintClr', this);
        }
    }

    get tintClr() {
        return this._tintClr;
    }

    set temperature(value: number) {
        if (value !== this._temperature) {
            this._temperature = value;
            this.scene.events.fire('splat.temperature', this);
        }
    }

    get temperature() {
        return this._temperature;
    }

    set saturation(value: number) {
        if (value !== this._saturation) {
            this._saturation = value;
            this.scene.events.fire('splat.saturation', this);
        }
    }

    get saturation() {
        return this._saturation;
    }

    set brightness(value: number) {
        if (value !== this._brightness) {
            this._brightness = value;
            this.scene.events.fire('splat.brightness', this);
        }
    }

    get brightness() {
        return this._brightness;
    }

    set blackPoint(value: number) {
        if (value !== this._blackPoint) {
            this._blackPoint = value;
            this.scene.events.fire('splat.blackPoint', this);
        }
    }

    get blackPoint() {
        return this._blackPoint;
    }

    set whitePoint(value: number) {
        if (value !== this._whitePoint) {
            this._whitePoint = value;
            this.scene.events.fire('splat.whitePoint', this);
        }
    }

    get whitePoint() {
        return this._whitePoint;
    }

    set transparency(value: number) {
        if (value !== this._transparency) {
            this._transparency = value;
            this.scene.events.fire('splat.transparency', this);
        }
    }

    get transparency() {
        return this._transparency;
    }

    set highlights(value: number) {
        if (value !== this._highlights) {
            this._highlights = value;
            this.scene.events.fire('splat.highlights', this);
        }
    }

    get highlights() {
        return this._highlights;
    }

    set shadows(value: number) {
        if (value !== this._shadows) {
            this._shadows = value;
            this.scene.events.fire('splat.shadows', this);
        }
    }

    get shadows() {
        return this._shadows;
    }

    set contrast(value: number) {
        if (value !== this._contrast) {
            this._contrast = value;
            this.scene.events.fire('splat.contrast', this);
        }
    }

    get contrast() {
        return this._contrast;
    }

    set hslHue(value: ArrayLike<number>) {
        for (let i = 0; i < 8; i++) this._hslHue[i] = value[i] ?? 0;
        this.scene.events.fire('splat.hslHue', this);
    }

    get hslHue() {
        return this._hslHue;
    }

    set hslSat(value: ArrayLike<number>) {
        for (let i = 0; i < 8; i++) this._hslSat[i] = value[i] ?? 0;
        this.scene.events.fire('splat.hslSat', this);
    }

    get hslSat() {
        return this._hslSat;
    }

    set hslLum(value: ArrayLike<number>) {
        for (let i = 0; i < 8; i++) this._hslLum[i] = value[i] ?? 0;
        this.scene.events.fire('splat.hslLum', this);
    }

    get hslLum() {
        return this._hslLum;
    }

    set colorGradeEnabled(value: boolean) {
        if (value !== this._colorGradeEnabled) {
            this._colorGradeEnabled = value;
            this.scene.events.fire('splat.colorGradeEnabled', this);
        }
    }

    get colorGradeEnabled() {
        return this._colorGradeEnabled;
    }

    // get pivot position/rotation/scale (caller should have awaited operation that changed data)
    getPivot(mode: 'center' | 'boundCenter', selection: boolean, result: Transform) {
        const { entity } = this;
        switch (mode) {
            case 'center':
                result.set(entity.getLocalPosition(), entity.getLocalRotation(), entity.getLocalScale());
                break;
            case 'boundCenter': {
                const bound = selection ? this.selectionBound : this.localBound;
                entity.getLocalTransform().transformPoint(bound.center, vec);
                result.set(vec, entity.getLocalRotation(), entity.getLocalScale());
                break;
            }
        }
    }

    docSerialize() {
        const pack3 = (v: Vec3) => [v.x, v.y, v.z];
        const pack4 = (q: Quat) => [q.x, q.y, q.z, q.w];
        const packC = (c: Color) => [c.r, c.g, c.b, c.a];
        return {
            name: this.name,
            position: pack3(this.entity.getLocalPosition()),
            rotation: pack4(this.entity.getLocalRotation()),
            scale: pack3(this.entity.getLocalScale()),
            visible: this.visible,
            tintClr: packC(this.tintClr),
            temperature: this.temperature,
            saturation: this.saturation,
            brightness: this.brightness,
            blackPoint: this.blackPoint,
            whitePoint: this.whitePoint,
            transparency: this.transparency,
            highlights: this.highlights,
            shadows: this.shadows,
            contrast: this.contrast,
            colorGradeEnabled: this.colorGradeEnabled,
            hslHue: Array.from(this._hslHue),
            hslSat: Array.from(this._hslSat),
            hslLum: Array.from(this._hslLum)
        };
    }

    docDeserialize(doc: any) {
        const { name, position, rotation, scale, visible, tintClr, temperature, saturation, brightness, blackPoint, whitePoint, transparency, highlights, shadows, contrast, colorGradeEnabled, hslHue, hslSat, hslLum } = doc;

        this.name = name;
        this.move(new Vec3(position), new Quat(rotation), new Vec3(scale));
        this.visible = visible;
        this.tintClr = new Color(tintClr[0], tintClr[1], tintClr[2], tintClr[3]);
        this.temperature = temperature ?? 0;
        this.saturation = saturation ?? 1;
        this.brightness = brightness;
        this.blackPoint = blackPoint;
        this.whitePoint = whitePoint;
        this.transparency = transparency;
        this.highlights = highlights ?? 0;
        this.shadows = shadows ?? 0;
        this.contrast = contrast ?? 0;
        this.colorGradeEnabled = colorGradeEnabled ?? true;
        if (hslHue) this.hslHue = hslHue;
        if (hslSat) this.hslSat = hslSat;
        if (hslLum) this.hslLum = hslLum;
    }
}

export { Splat };
