import {
    createChunkDataPool,
    logger as splatTransformLogger,
    MemoryFileSystem,
    Transform,
    writeLodSource,
    writeSource,
    ZipFileSystem,
    type ChunkData,
    type ChunkDataPool,
    type ChunkLayer,
    type ChunkSource,
    type ChunkSourceMetadata,
    type FileSystem,
    type LayerLayout,
    type LogEvent,
    type Options,
    type OutputFormat,
    type ReadRequest,
    type Renderer,
    type SHBands,
    type Writer
} from '@playcanvas/splat-transform';
import {
    GSplatData,
    Mat3,
    Mat4,
    PIXELFORMAT_BGRA8,
    Quat,
    Texture,
    Vec3,
    WebgpuGraphicsDevice
} from 'playcanvas';

import { Splat } from './splat';
import { State } from './splat-state';
import { version } from '../../package.json';
import { ColorGrade, dcDecode, dcEncode, sigmoid } from '../core/color-grade';
import { Events } from '../core/events';
import { SHRotation } from '../core/sh-utils';

type SerializeSettings = {
    maxSHBands?: number;            // specifies the maximum number of bands to be exported
    selected?: boolean;             // only export selected gaussians. used for copy/paste
    minOpacity?: number;            // filter out gaussians with alpha less than or equal to minAlpha
    removeInvalid?: boolean;        // filter out gaussians with invalid data (NaN/Infinity)

    // the following options are used when serializing for document save.
    // keepWorldTransform/keepColorTint flow through to SingleSplat; keepStateData
    // is accepted for compatibility but the streaming writers never export state.
    keepStateData?: boolean;        // keep the state data array
    keepWorldTransform?: boolean;   // don't apply the world transform when resolving splat transforms
    keepColorTint?: boolean;        // refrain from applying color tints
};

type AnimTrack = {
    name: string,
    duration: number,
    frameRate: number,
    loopMode: 'none' | 'repeat' | 'pingpong',
    interpolation: 'step' | 'spline',
    smoothness: number,
    keyframes: {
        times: number[],
        values: {
            position: number[],
            target: number[],
            fov: number[],
        }
    }
};

type CameraPose = {
    position: [number, number, number],
    target: [number, number, number],
    fov: number
};

type Camera = {
    initial: CameraPose,
};

type Annotation = {
    position: [number, number, number],
    title: string,
    text: string,
    extras: any,
    camera: Camera
};

type PostEffectSettings = {
    sharpness: {
        enabled: boolean,
        amount: number,
    },
    bloom: {
        enabled: boolean,
        intensity: number,
        blurLevel: number,
    },
    grading: {
        enabled: boolean,
        brightness: number,
        contrast: number,
        saturation: number,
        tint: [number, number, number],
    },
    vignette: {
        enabled: boolean,
        intensity: number,
        inner: number,
        outer: number,
        curvature: number,
    },
    fringing: {
        enabled: boolean,
        intensity: number
    }
};

const defaultPostEffectSettings: PostEffectSettings = {
    sharpness: { enabled: false, amount: 0 },
    bloom: { enabled: false, intensity: 1, blurLevel: 2 },
    grading: { enabled: false, brightness: 1, contrast: 1, saturation: 1, tint: [1, 1, 1] },
    vignette: { enabled: false, intensity: 0.5, inner: 0.3, outer: 0.75, curvature: 1 },
    fringing: { enabled: false, intensity: 0.5 }
};

type ExperienceSettings = {
    version: 2,
    tonemapping: 'none' | 'linear' | 'filmic' | 'hejl' | 'aces' | 'aces2' | 'neutral',
    highPrecisionRendering: boolean,
    soundUrl?: string,
    background: {
        color: [number, number, number],
        skyboxUrl?: string
    },
    postEffectSettings: PostEffectSettings,
    animTracks: AnimTrack[],
    cameras: Camera[],
    annotations: Annotation[],
    startMode: 'default' | 'animTrack' | 'annotation'
};

type ViewerExportSettings = {
    type: 'html' | 'zip';
    experienceSettings: ExperienceSettings;
    events?: Events;
};

type ProgressFunc = (loaded: number, total: number) => void;

// create a filter for gaussians
class GaussianFilter {
    set: (splat: Splat) => void;
    test: (i: number) => boolean;
    /** 廉价版（不含逐属性有限性检查）：`test` 的**上界**，用来给映射表定长度。 */
    bound: (i: number) => boolean;

    constructor(serializeSettings: SerializeSettings) {
        let splat: Splat = null;
        let state: Uint8Array = null;
        let opacity: Float32Array = null;
        // A2 (docs/audit/00-总结.md): the per-property work used to be done *per gaussian* —
        // `splatData.getElement('vertex')` was re-fetched inside the predicate, and the
        // inf-permission checks were `Set<string>.has(name)` lookups for every property of every
        // gaussian. The PLY export path forces removeInvalid = true, so on 13M gaussians × 14
        // properties that is ~180M string hash lookups plus 13M element lookups. The property
        // list and its two permission flags are constant for a splat, so they are cached in set().
        let props: { storage: any, infOk: boolean, negInfOk: boolean }[] = [];

        this.set = (s: Splat) => {
            splat = s;
            state = splat.splatData.getProp('state') as Uint8Array;
            opacity = splat.splatData.getProp('opacity') as Float32Array;
            props = [];
            if (removeInvalid) {
                const element = splat.splatData.getElement('vertex');
                for (let k = 0; k < element.properties.length; ++k) {
                    const prop = element.properties[k];
                    if (!prop.storage) {
                        continue;
                    }
                    props.push({
                        storage: prop.storage,
                        infOk: infOk.has(prop.name),
                        negInfOk: negInfOk.has(prop.name)
                    });
                }
            }
        };

        const onlySelected = serializeSettings.selected ?? false;
        const minOpacity = serializeSettings.minOpacity ?? 0;
        const removeInvalid = serializeSettings.removeInvalid ?? false;

        // properties where +Infinity and -Infinity are valid values
        const infOk = new Set(['opacity']);
        // properties where -Infinity is a valid value
        const negInfOk = new Set(['scale_0', 'scale_1', 'scale_2']);

        // The cheap half of test(): everything except the per-property finiteness sweep. Anything
        // test() rejects, bound() also rejects (test only adds rejections), so counting with
        // bound() gives a size that is guaranteed to be >= the number of rows test() accepts.
        this.bound = (i: number) => {
            // splat is deleted, always removed
            if ((state[i] & State.deleted) !== 0) {
                return false;
            }

            // optionally filter out unselected gaussians. Use a bit test so a
            // gaussian that is BOTH hidden (locked) and selected (state=3) is
            // still exported — the strict equality used to silently drop it.
            if (onlySelected && (state[i] & State.selected) === 0) {
                return false;
            }

            // optionally filter based on opacity
            if (minOpacity > 0 && sigmoid(opacity[i]) < minOpacity) {
                return false;
            }

            return true;
        };

        this.test = (i: number) => {
            if (!this.bound(i)) {
                return false;
            }

            if (removeInvalid) {
                // check if any property of the gaussian is NaN/Infinity
                for (let k = 0; k < props.length; ++k) {
                    const { storage, infOk: propInfOk, negInfOk: propNegInfOk } = props[k];
                    const v = storage[i];
                    if (!Number.isFinite(v)) {
                        if (v === -Infinity && (propInfOk || propNegInfOk)) continue;
                        if (v === Infinity && propInfOk) continue;
                        return false;
                    }
                }
            }

            return true;
        };
    }
}

// A2: count with the cheap predicate — an upper bound on the exact count, and the whole point of
// it is that it skips the per-property finiteness sweep the exact count would have to pay.
const countGaussianBound = (splats: Splat[], filter: GaussianFilter) => {
    return splats.reduce((accum, splat) => {
        filter.set(splat);
        const n = splat.splatData.numSplats;
        let count = 0;
        for (let i = 0; i < n; ++i) {
            if (filter.bound(i)) {
                count++;
            }
        }
        return accum + count;
    }, 0);
};

const getVertexProperties = (splatData: GSplatData) => {
    return new Set<string>(
        splatData.getElement('vertex')
        .properties.filter((p: any) => p.storage)
        .map((p: any) => p.name)
    );
};

const getCommonPropNames = (splats: Splat[]) => {
    let result: Set<string>;

    for (let i = 0; i < splats.length; ++i) {
        const props = getVertexProperties(splats[i].splatData);
        result = i === 0 ? props : new Set([...result].filter(i => props.has(i)));
    }

    return [...result];
};

const shNames = new Array(45).fill('').map((_, i) => `f_rest_${i}`);
const shBandCoeffs = [0, 3, 8, 15];

// determine the number of sh bands present given an object with 'f_rest_*' properties
const calcSHBands = (data: Set<string>) => {
    return { '9': 1, '24': 2, '-1': 3 }[shNames.findIndex(v => !data.has(v))] ?? 0;
};

const v = new Vec3();
const q = new Quat();

// calculate splat transforms on demand and cache the result for next time
class SplatTransformCache {
    getMat: (index: number) => Mat4;
    getRot: (index: number) => Quat;
    getScale: (index: number) => Vec3;
    getSHRot: (index: number) => SHRotation;

    constructor(splat: Splat, keepWorldTransform = false) {
        const transforms = new Map<number, { transformIndex: number, mat: Mat4, rot: Quat, scale: Vec3, shRot: SHRotation }>();
        const indices = splat.transformTexture.getSource() as unknown as Uint32Array;
        const tmpMat = new Mat4();
        const tmpMat3 = new Mat3();
        const tmpQuat = new Quat();

        const getTransform = (index: number) => {
            const transformIndex = indices?.[index] ?? 0;
            let result = transforms.get(transformIndex);
            if (!result) {
                result = { transformIndex, mat: null, rot: null, scale: null, shRot: null };
                transforms.set(transformIndex, result);
            }
            return result;
        };

        this.getMat = (index: number) => {
            const transform = getTransform(index);

            if (!transform.mat) {
                const mat = new Mat4();

                // we must undo the transform we apply at load time to output data
                if (!keepWorldTransform) {
                    mat.setFromEulerAngles(0, 0, -180);
                    mat.mul2(mat, splat.entity.getWorldTransform());
                }

                // combine with transform palette matrix
                if (transform.transformIndex > 0) {
                    splat.transformPalette.getTransform(transform.transformIndex, tmpMat);
                    mat.mul2(mat, tmpMat);
                }

                transform.mat = mat;
            }

            return transform.mat;
        };

        this.getRot = (index: number) => {
            const transform = getTransform(index);

            if (!transform.rot) {
                transform.rot = new Quat().setFromMat4(this.getMat(index));
            }

            return transform.rot;
        };

        this.getScale = (index: number) => {
            const transform = getTransform(index);

            if (!transform.scale) {
                const scale = new Vec3();
                this.getMat(index).getScale(scale);
                transform.scale = scale;
            }

            return transform.scale;
        };

        this.getSHRot = (index: number) => {
            const transform = getTransform(index);

            if (!transform.shRot) {
                tmpQuat.setFromMat4(this.getMat(index));
                tmpMat3.setFromQuat(tmpQuat);
                transform.shRot = new SHRotation(tmpMat3);
            }

            return transform.shRot;
        };
    }
}

// helper class for extracting and transforming a single splat's data
// to prepare it for export
class SingleSplat {
    // final data keyed on member name
    data: any = {};

    // read a single gaussian's data and transform it for export
    read: (splats: Splat, i: number) => void;

    // specify the data members required
    constructor(members: string[], serializeSettings: SerializeSettings) {
        const data: any = {};
        members.forEach((name) => {
            data[name] = 0;
        });

        const hasPosition = ['x', 'y', 'z'].every(v => data.hasOwnProperty(v));
        const hasRotation = ['rot_0', 'rot_1', 'rot_2', 'rot_3'].every(v => data.hasOwnProperty(v));
        const hasScale = ['scale_0', 'scale_1', 'scale_2'].every(v => data.hasOwnProperty(v));
        const hasColor = ['f_dc_0', 'f_dc_1', 'f_dc_2'].every(v => data.hasOwnProperty(v));
        const hasOpacity = data.hasOwnProperty('opacity');

        const dstSHBands = calcSHBands(new Set(Object.keys(data)));
        const dstSHCoeffs = shBandCoeffs[dstSHBands];
        const tmpSHData = dstSHBands ? new Float32Array(dstSHCoeffs) : null;

        type CacheEntry = {
            splat: Splat;
            transformCache: SplatTransformCache;
            srcProps: { [name: string]: Float32Array };
            grade: ColorGrade;
        };

        const cacheMap = new Map<Splat, CacheEntry>();
        let cacheEntry: CacheEntry;

        const read = (splat: Splat, i: number) => {
            // get the cached data entry for this splat
            if (splat !== cacheEntry?.splat) {
                if (!cacheMap.has(splat)) {
                    const transformCache = new SplatTransformCache(splat, serializeSettings.keepWorldTransform);

                    const srcPropNames = getVertexProperties(splat.splatData);
                    const srcSHBands = calcSHBands(srcPropNames);
                    const srcSHCoeffs = shBandCoeffs[srcSHBands];

                    // cache the props objects
                    const srcProps: { [name: string]: Float32Array } = {};

                    members.forEach((name) => {
                        const shIndex = shNames.indexOf(name);
                        if (shIndex >= 0) {
                            const a = Math.floor(shIndex / dstSHCoeffs);
                            const b = shIndex % dstSHCoeffs;
                            srcProps[name] = (b < srcSHCoeffs) ? splat.splatData.getProp(shNames[a * srcSHCoeffs + b]) as Float32Array : null;
                        } else {
                            srcProps[name] = splat.splatData.getProp(name) as Float32Array;
                        }
                    });

                    const grade = new ColorGrade(splat);

                    cacheEntry = { splat, transformCache, srcProps, grade };

                    cacheMap.set(splat, cacheEntry);
                } else {
                    cacheEntry = cacheMap.get(splat);
                }
            }

            const { transformCache, srcProps, grade } = cacheEntry;

            // copy members
            members.forEach((name) => {
                data[name] = srcProps[name]?.[i] ?? 0;
            });

            // apply transform palette transforms
            const mat = transformCache.getMat(i);

            if (hasPosition) {
                v.set(data.x, data.y, data.z);
                mat.transformPoint(v, v);
                [data.x, data.y, data.z] = [v.x, v.y, v.z];
            }

            if (hasRotation) {
                const quat = transformCache.getRot(i);
                q.set(data.rot_1, data.rot_2, data.rot_3, data.rot_0).mul2(quat, q);
                [data.rot_1, data.rot_2, data.rot_3, data.rot_0] = [q.x, q.y, q.z, q.w];
            }

            if (hasScale) {
                const scale = transformCache.getScale(i);
                data.scale_0 = Math.log(Math.exp(data.scale_0) * scale.x);
                data.scale_1 = Math.log(Math.exp(data.scale_1) * scale.y);
                data.scale_2 = Math.log(Math.exp(data.scale_2) * scale.z);
            }

            if (dstSHBands > 0) {
                for (let c = 0; c < 3; ++c) {
                    for (let d = 0; d < dstSHCoeffs; ++d) {
                        tmpSHData[d] = data[shNames[c * dstSHCoeffs + d]];
                    }

                    transformCache.getSHRot(i).apply(tmpSHData);

                    for (let d = 0; d < dstSHCoeffs; ++d) {
                        data[shNames[c * dstSHCoeffs + d]] = tmpSHData[d];
                    }
                }
            }

            if (!serializeSettings.keepColorTint && hasColor && (grade.hasTint || grade.hasHsl)) {
                const c = {
                    r: dcDecode(data.f_dc_0),
                    g: dcDecode(data.f_dc_1),
                    b: dcDecode(data.f_dc_2)
                };

                grade.applyDC(c);
                data.f_dc_0 = dcEncode(c.r);
                data.f_dc_1 = dcEncode(c.g);
                data.f_dc_2 = dcEncode(c.b);

                if (dstSHBands > 0) {
                    for (let d = 0; d < dstSHCoeffs; ++d) {
                        c.r = data[shNames[d]];
                        c.g = data[shNames[d + dstSHCoeffs]];
                        c.b = data[shNames[d + dstSHCoeffs * 2]];

                        grade.applySH(c);
                        data[shNames[d]] = c.r;
                        data[shNames[d + dstSHCoeffs]] = c.g;
                        data[shNames[d + dstSHCoeffs * 2]] = c.b;
                    }
                }
            }

            if (!serializeSettings.keepColorTint && hasOpacity && splat.transparency !== 1) {
                data.opacity = grade.applyOpacity(data.opacity);
            }
        };

        this.data = data;
        this.read = read;
    }
}

// Number of f_rest_* SH coefficients per band level (mirrors splat-transform's
// SH_REST_COUNTS; that constant isn't exported from the package root).
const SH_REST_COUNTS: Record<number, number> = { 0: 0, 1: 9, 2: 24, 3: 45 };

// Gaussians per chunk when streaming a scene to splat-transform. Chosen to
// bound the transient working set (input layer buffers + writer output buffer)
// rather than scale with the whole scene.
const EXPORT_CHUNK_SIZE = 256 * 1024;

// Build the canonical per-layer byte layout splat-transform expects. The
// interleaved packing here must match splat-transform's readers/materialize:
// position = xyz (stride 12); geometric = rot0-3, scale0-2, opacity (stride 32);
// color = dc0-2 then f_rest_* (stride (3 + numRest) * 4).
const buildLayouts = (numRest: number): Partial<Record<ChunkLayer, LayerLayout>> => ({
    position: {
        stride: 12,
        fields: { position: { byteOffset: 0, components: 3, type: 'float32' } }
    },
    geometric: {
        stride: 32,
        fields: {
            rotation: { byteOffset: 0, components: 4, type: 'float32' },
            scale: { byteOffset: 16, components: 3, type: 'float32' },
            opacity: { byteOffset: 28, components: 1, type: 'float32' }
        }
    },
    color: {
        stride: (3 + numRest) * 4,
        fields: numRest > 0 ? {
            dc: { byteOffset: 0, components: 3, type: 'float32' },
            shRest: { byteOffset: 12, components: numRest, type: 'float32' }
        } : {
            dc: { byteOffset: 0, components: 3, type: 'float32' }
        }
    }
});

/**
 * A lazy, chunked ChunkSource over a set of Splats, for feeding splat-transform's
 * streaming writers (writeSource) without materializing a whole-scene copy.
 *
 * It is the streaming analog of the old extractDataTable/DataTable path:
 * gaussians are filtered
 * (deleted/selection/opacity/invalid) and transformed (world + palette + SH
 * rotation + colour tint + PLY-space flip) on demand via SingleSplat, one chunk
 * at a time. The output is in PLY space, so the source is tagged Transform.PLY
 * (identity) and the writers' bakeTransform is a no-op.
 */
class SplatRoomChunkSource implements ChunkSource {
    meta: ChunkSourceMetadata;

    private splats: Splat[];
    private splatOf: Uint32Array;   // output row -> index into splats
    private localOf: Uint32Array;   // output row -> gaussian index within that splat
    private singleSplat: SingleSplat;
    private numRest: number;

    constructor(splats: Splat[], settings: SerializeSettings) {
        this.splats = splats;

        // Determine the SH band count to export: the highest band present in any
        // splat, capped by maxSHBands. SingleSplat zero-fills missing bands.
        const splatBands = splats.map(s => calcSHBands(getVertexProperties(s.splatData)));
        const outputBands = Math.min(settings.maxSHBands ?? 3, splatBands.length ? Math.max(...splatBands) : 0);
        const numRest = SH_REST_COUNTS[outputBands];
        this.numRest = numRest;

        // Build the filtered output->source index map (in splat order).
        //
        // A2 (docs/audit/00-总结.md): this used to run the FULL predicate twice — once in
        // countGaussians (only to learn the array length) and once to fill the map — and on the
        // PLY export path the full predicate walks every vertex property of every gaussian
        // (removeInvalid is forced on). The length now comes from the cheap `bound` predicate,
        // which is a guaranteed upper bound, and the map is filled in a single exact pass.
        //
        // The tail of the old arrays could stay zero if the two passes ever disagreed, and a zero
        // entry silently exports row 0 — i.e. wrong rows, no error. `idx > bound` is therefore a
        // hard error now, and a loose bound is trimmed (and the oversized buffers dropped) rather
        // than left resident.
        const filter = new GaussianFilter(settings);
        const bound = countGaussianBound(splats, filter);
        let splatOf = new Uint32Array(bound);
        let localOf = new Uint32Array(bound);
        let idx = 0;
        for (let s = 0; s < splats.length; ++s) {
            filter.set(splats[s]);
            const n = splats[s].splatData.numSplats;
            for (let i = 0; i < n; ++i) {
                if (filter.test(i)) {
                    splatOf[idx] = s;
                    localOf[idx] = i;
                    idx++;
                }
            }
        }
        if (idx > bound) {
            // cannot happen: `bound` is a superset of `test`. If it ever does, the map is
            // truncated and the export would silently contain wrong rows, so fail loudly.
            throw new Error(`splat-serialize: filter bound ${bound} exceeded by ${idx} accepted rows`);
        }
        if (idx < bound) {
            // the finiteness sweep rejected rows the cheap bound allowed: keep only what is real.
            // Trim only when the difference is material, so the common case pays no copy.
            if (idx < bound * 0.9) {
                splatOf = splatOf.slice(0, idx);
                localOf = localOf.slice(0, idx);
            } else {
                splatOf = splatOf.subarray(0, idx);
                localOf = localOf.subarray(0, idx);
            }
        }
        const total = idx;
        this.splatOf = splatOf;
        this.localOf = localOf;

        const members = [
            'x', 'y', 'z',
            'scale_0', 'scale_1', 'scale_2',
            'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
            'rot_0', 'rot_1', 'rot_2', 'rot_3',
            ...shNames.slice(0, numRest)
        ];
        this.singleSplat = new SingleSplat(members, settings);

        const numChunks = Math.ceil(total / EXPORT_CHUNK_SIZE);
        this.meta = {
            numGaussians: total,
            numLods: 1,
            lodCounts: [total],
            chunkSize: EXPORT_CHUNK_SIZE,
            numChunks: [numChunks],
            shBands: outputBands as SHBands,
            extraColumns: [],
            transform: Transform.PLY,
            // splat-transform 3.3+: sources must declare their training model.
            // SplatRoom output is ordinary (default) gaussians.
            model: 'default',
            availableLayers: new Set<ChunkLayer>(['position', 'geometric', 'color']),
            layouts: buildLayouts(numRest)
        };
    }

    read(request: ReadRequest): Promise<void> {
        const isGather = 'indices' in request;
        const anyBuf = (request.position ?? request.geometric ?? request.color) as ChunkData;
        const count = isGather ? request.count : anyBuf.count;
        const chunkBase = isGather ? 0 : request.chunkIndex * EXPORT_CHUNK_SIZE;

        const posF = request.position ? new Float32Array(request.position.data) : null;
        const geoF = request.geometric ? new Float32Array(request.geometric.data) : null;
        const colF = request.color ? new Float32Array(request.color.data) : null;
        const cstride = 3 + this.numRest;

        const { data } = this.singleSplat;

        for (let i = 0; i < count; ++i) {
            const outputRow = isGather ? request.indices[request.indexOffset + i] : chunkBase + i;
            const splat = this.splats[this.splatOf[outputRow]];
            this.singleSplat.read(splat, this.localOf[outputRow]);

            if (posF) {
                const o = i * 3;
                posF[o + 0] = data.x;
                posF[o + 1] = data.y;
                posF[o + 2] = data.z;
            }
            if (geoF) {
                const o = i * 8;
                geoF[o + 0] = data.rot_0;
                geoF[o + 1] = data.rot_1;
                geoF[o + 2] = data.rot_2;
                geoF[o + 3] = data.rot_3;
                geoF[o + 4] = data.scale_0;
                geoF[o + 5] = data.scale_1;
                geoF[o + 6] = data.scale_2;
                geoF[o + 7] = data.opacity;
            }
            if (colF) {
                const o = i * cstride;
                colF[o + 0] = data.f_dc_0;
                colF[o + 1] = data.f_dc_1;
                colF[o + 2] = data.f_dc_2;
                for (let r = 0; r < this.numRest; ++r) {
                    colF[o + 3 + r] = data[shNames[r]];
                }
            }
        }

        return Promise.resolve();
    }

    async close(): Promise<void> {
        // nothing to release; the scene data is owned by the editor
    }
}

/**
 * Build a ChunkSource + matching pool over the given splats, or null if nothing
 * passes the export filter.
 */
const createExportSource = (splats: Splat[], settings: SerializeSettings): { source: ChunkSource, pool: ChunkDataPool } | null => {
    const source = new SplatRoomChunkSource(splats, settings);
    if (source.meta.numGaussians === 0) {
        return null;
    }
    const pool = createChunkDataPool({ chunkSize: source.meta.chunkSize });
    return { source, pool };
};

// Thrown when the WebGPU device needed for SOG compression can't be created.
// Callers show a friendly message for this instead of the raw error text.
class WebGPUUnavailableError extends Error {
    constructor() {
        super('WebGPU is not available');
        this.name = 'WebGPUUnavailableError';
    }
}

// Cached WebGPU device for SOG compression
let cachedGpuDevice: WebgpuGraphicsDevice | null = null;
let cachedBackbuffer: Texture | null = null;

const createGpuDevice = async (): Promise<WebgpuGraphicsDevice> => {
    if (cachedGpuDevice) {
        return cachedGpuDevice;
    }

    if (!navigator.gpu) {
        throw new WebGPUUnavailableError();
    }

    // Create a minimal canvas for the graphics device
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 512;

    const graphicsDevice = new WebgpuGraphicsDevice(canvas, {
        antialias: false,
        depth: false,
        stencil: false
    });

    try {
        await graphicsDevice.createDevice();
    } catch (err) {
        // createDevice fails with an obscure internal error when no adapter
        // is available (e.g. blocklisted GPU or missing drivers)
        console.error(err);
        throw new WebGPUUnavailableError();
    }

    // createDevice can also resolve without creating a device (e.g.
    // blocklisted adapters)
    // @ts-ignore - wgpu is an internal property
    if (!graphicsDevice.wgpu) {
        throw new WebGPUUnavailableError();
    }

    // Create external backbuffer (required by PlayCanvas)
    cachedBackbuffer = new Texture(graphicsDevice, {
        width: 1024,
        height: 512,
        name: 'SogComputeBackbuffer',
        mipmaps: false,
        format: PIXELFORMAT_BGRA8
    });

    // @ts-ignore - externalBackbuffer is an internal property
    graphicsDevice.externalBackbuffer = cachedBackbuffer;

    cachedGpuDevice = graphicsDevice;
    return graphicsDevice;
};

/**
 * Stream the given splats to a file via splat-transform's writeSource. Streaming
 * formats (ply/sog/splat) never build a whole-scene copy; the rest materialize a
 * single transient copy inside the library.
 */
const writeSplatFile = async (
    splats: Splat[],
    settings: SerializeSettings,
    outputFormat: OutputFormat,
    filename: string,
    options: Options,
    fs: FileSystem
): Promise<void> => {
    const built = createExportSource(splats, settings);
    if (!built) {
        return;
    }
    const { source, pool } = built;
    try {
        await writeSource({ filename, outputFormat, source, pool, options, createDevice: createGpuDevice }, fs);
    } finally {
        await source.close();
        pool.destroy();
    }
};

/**
 * Extract Splat data into a DataTable for use with splat-transform writers.
 * This is shared between serializeSog and serializeViewer.
 */
// Bridge splat-transform progress events to splatroom's events.
const createProgressRenderer = (header: string, events?: Events): Renderer => ({
    handle: (event: LogEvent) => {
        switch (event.kind) {
            case 'scopeStart':
                if (event.depth === 0) {
                    events?.fire('progressStart', header);
                } else {
                    events?.fire('progressUpdate', {
                        text: event.index !== undefined && event.total !== undefined ?
                            `Step ${event.index} of ${event.total}: ${event.name}` :
                            event.name,
                        progress: 0
                    });
                }
                break;
            case 'scopeEnd':
                if (event.depth === 0) {
                    events?.fire('progressEnd');
                }
                break;
            case 'barStart':
                events?.fire('progressUpdate', { text: event.name, progress: 0 });
                break;
            case 'barTick':
                events?.fire('progressUpdate', {
                    progress: event.total > 0 ? 100 * event.current / event.total : 0
                });
                break;
            case 'barEnd':
                events?.fire('progressUpdate', { progress: 100 });
                break;
            case 'message':
                if (event.level === 'error') console.error(event.text);
                else if (event.level === 'warn') console.warn(event.text);
                else if (event.level === 'info') console.info(event.text);
                else if (event.level === 'debug') console.debug(event.text);
                break;
            case 'output':
                console.log(event.text);
                break;
        }
    }
});

const serializeViewer = async (splats: Splat[], serializeSettings: SerializeSettings, options: ViewerExportSettings, fs: FileSystem): Promise<void> => {
    const { experienceSettings, events } = options;

    splatTransformLogger.setRenderer(createProgressRenderer('Exporting HTML', events));

    // splat-transform's writers leave their top-level scope open on error
    // (their contract is for the caller to unwind), so we explicitly
    // unwind here to deliver a matching depth-0 `scopeEnd(failed)` to the
    // renderer. That fires `progressEnd` and dismisses the dialog before
    // any error popup is shown.
    try {
        if (options.type === 'html') {
            // Bundled HTML - a single self-contained file
            await writeSplatFile(splats, serializeSettings, 'html-bundle', 'output.html', {
                viewerSettingsJson: experienceSettings,
                iterations: 10
            }, fs);
        } else {
            // Package - write unbundled into a MemoryFileSystem, then ZIP
            const memFs = new MemoryFileSystem();
            await writeSplatFile(splats, serializeSettings, 'html', 'index.html', {
                viewerSettingsJson: experienceSettings,
                iterations: 10
            }, memFs);

            // Create ZIP from memory filesystem results. The try/finally
            // ensures zipFs (and its underlying writer) is closed even if a
            // write throws partway through, so we don't leak the output file.
            const zipWriter = await fs.createWriter('output.zip');
            const zipFs = new ZipFileSystem(zipWriter);
            try {
                for (const [filename, data] of memFs.results.entries()) {
                    const writer = await zipFs.createWriter(filename);
                    await writer.write(data);
                    await writer.close();
                }
            } finally {
                await zipFs.close();
            }
        }
    } catch (err) {
        splatTransformLogger.unwindAll(true);
        throw err;
    }
};

// SOG serialization using splat-transform library

type SogSettings = SerializeSettings & {
    iterations: number;
    events?: Events;
};

const serializeSog = async (splats: Splat[], settings: SogSettings, fs: FileSystem): Promise<void> => {
    const { iterations = 10, events } = settings;

    splatTransformLogger.setRenderer(createProgressRenderer('Exporting SOG', events));

    try {
        await writeSplatFile(splats, settings, 'sog-bundle', 'output.sog', { iterations }, fs);
    } catch (err) {
        splatTransformLogger.unwindAll(true);
        throw err;
    }
};

/**
 * Streaming SOG export for large scenes (>8M gaussians).
 * Uses multi-LOD spatial chunking via writeLodSource.
 */
const serializeStreamingSog = async (splats: Splat[], settings: SogSettings, fs: FileSystem): Promise<void> => {
    const { iterations = 8, events } = settings;

    splatTransformLogger.setRenderer(createProgressRenderer('Exporting Streaming SOG', events));

    const built = createExportSource(splats, settings);
    if (!built) return;
    const { source, pool } = built;

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let totalGaussians = 0;
    for (const splat of splats) {
        const data = splat.splatData;
        totalGaussians += data.numSplats;
        const x = data.getProp('x') as Float32Array;
        const y = data.getProp('y') as Float32Array;
        const z = data.getProp('z') as Float32Array;
        if (!x || !y || !z) continue;
        const wt = splat.entity.getWorldTransform();
        for (let i = 0; i < data.numSplats; i++) {
            const wx = x[i] * wt.data[0] + y[i] * wt.data[4] + z[i] * wt.data[8] + wt.data[12];
            const wy = x[i] * wt.data[1] + y[i] * wt.data[5] + z[i] * wt.data[9] + wt.data[13];
            const wz = x[i] * wt.data[2] + y[i] * wt.data[6] + z[i] * wt.data[10] + wt.data[14];
            if (wx < minX) minX = wx; if (wy < minY) minY = wy; if (wz < minZ) minZ = wz;
            if (wx > maxX) maxX = wx; if (wy > maxY) maxY = wy; if (wz > maxZ) maxZ = wz;
        }
    }
    const maxExtent = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
    const chunkExtent = Math.max(0.5, maxExtent / Math.cbrt(totalGaussians / 200000));
    const chunkCount = Math.max(1, Math.ceil(maxExtent / chunkExtent));

    // Streaming SOG produces MULTIPLE files (lod-meta.json + per-unit
    // meta.json / .sog payloads), but the export target is a single output
    // stream (FileSystemWritableFileStream). Writing those files directly to
    // the shared stream breaks: each BrowserFileWriter closes the underlying
    // stream, so the second write throws "Cannot write to a CLOSED writable
    // stream" (reported on >8M-gaussian scenes, which route here). Instead we
    // stage every unit in a MemoryFileSystem and ZIP the whole tree into ONE
    // .sog — a .sog is a zip container, and the loader opens it with
    // ZipReadFileSystem and reads the LOD manifest from inside.
    const memFs = new MemoryFileSystem();
    try {
        await writeLodSource({
            filename: 'output.lod',
            mainSource: source,
            envSource: null,
            iterations,
            createDevice: createGpuDevice,
            chunkCount,
            chunkExtent
        }, memFs);
    } catch (err) {
        splatTransformLogger.unwindAll(true);
        throw err;
    } finally {
        await source.close();
        pool.destroy();
    }

    // Package the staged files into a single zip .sog. Write through a zip
    // wrapper created by the target fs so the output lands on the user's file
    // in one stream.
    const writer = await fs.createWriter('output.sog');
    const zipFs = new ZipFileSystem(writer);
    try {
        for (const [filename, data] of memFs.results.entries()) {
            const w = await zipFs.createWriter(filename);
            await w.write(data);
            await w.close();
        }
    } finally {
        await zipFs.close();
    }
};

type SpzSettings = SerializeSettings & {
    version?: 3 | 4;
    events?: Events;
};

const serializeSpz = async (splats: Splat[], settings: SpzSettings, fs: FileSystem): Promise<void> => {
    const { version = 4, events } = settings;

    splatTransformLogger.setRenderer(createProgressRenderer('Exporting SPZ', events));

    // unwind the logger's top-level scope on error (see serializeSog)
    try {
        await writeSplatFile(splats, settings, 'spz', 'output.spz', { spzVersion: version }, fs);
    } catch (err) {
        splatTransformLogger.unwindAll(true);
        throw err;
    }
};

export {
    Writer,
    writeSplatFile,
    serializeSog,
    serializeStreamingSog,
    serializeSpz,
    serializeViewer,
    AnimTrack,
    CameraPose,
    Camera,
    Annotation,
    PostEffectSettings,
    defaultPostEffectSettings,
    ExperienceSettings,
    SerializeSettings,
    SogSettings,
    SpzSettings,
    ViewerExportSettings,
    WebGPUUnavailableError
};
