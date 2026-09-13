import {
    ADDRESS_CLAMP_TO_EDGE,
    FILTER_NEAREST,
    PIXELFORMAT_RGBA8,
    PIXELFORMAT_RGBA32F,
    SEMANTIC_POSITION,
    drawQuadWithShader,
    GraphicsDevice,
    Mat4,
    RenderTarget,
    ScopeSpace,
    Shader,
    ShaderUtils,
    Texture,
    BlendState
} from 'playcanvas';

import { BufferPool } from './buffer-pool';
import { waitForGpuDrain, withReadbackTimeout } from './gpu-readback';
import { packedMaskHeight, packedMaskWidth } from './histogram-config';
import { vertexShader, fragmentShader } from '../shaders/intersection-shader';
import { Splat } from '../splat/splat';

// every mode accepts `footprint`: 0 (default) tests the splat's center point,
// >0 widens the test by the splat's rendered extent (the 2*sqrt(2)-sigma
// ellipsoid the renderer rasterizes) scaled by that factor, so a splat whose
// visible footprint touches the region counts even when its center falls
// outside it (SuperSplat 3 semantics).
type MaskOptions = {
    mask: Texture;
    footprint?: number;
};

type RectOptions = {
    rect: { x1: number, y1: number, x2: number, y2: number };
    footprint?: number;
};

type SphereOptions = {
    // transform mapping the unit sphere (diameter 1) to world space
    sphere: { transform: Mat4 };
    footprint?: number;
};

type BoxOptions = {
    // transform mapping the unit cube (side 1) to world space
    box: { transform: Mat4 };
    footprint?: number;
};

// sphere brush: a stroke sampled into a world-space path (SuperSplat's mode 4).
// Points are flattened as x, y, z, signed radius; a negative radius marks the
// start of a new subpath (a depth discontinuity in the stroke) while keeping
// that point's sphere. The stroke mask gates candidates by their projected
// center when footprint is 0, matching the brush's visible-stroke semantics.
type SphereBrushOptions = {
    sphereBrush: {
        // flattened x, y, z, signed radius per path point
        points: Float32Array;
        mask: Texture;
        footprint?: number;
        // slab depth along viewDir, in world units (0/undefined = plain sphere brush):
        // the panel's 厚度 slider, so a stroke selects a slab instead of a ball
        thickness?: number;
        viewDir?: number[];
    };
};

type IntersectOptions = MaskOptions | RectOptions | SphereOptions | BoxOptions | SphereBrushOptions;

const shapeInvMat = new Mat4();
const identityMat = new Mat4();

const resolve = (scope: ScopeSpace, values: any) => {
    for (const key in values) {
        scope.resolve(key).setValue(values[key]);
    }
};

class Intersect {
    private device: GraphicsDevice;
    private dummyTexture: Texture;
    private viewProjectionMat = new Mat4();
    private shader: Shader = null;
    private texture: Texture = null;
    private renderTarget: RenderTarget = null;
    private pathTexture: Texture = null;

    constructor(device: GraphicsDevice) {
        this.device = device;
        this.dummyTexture = new Texture(device, {
            width: 1,
            height: 1,
            format: PIXELFORMAT_RGBA8
        });
    }

    // grow-only path texture (one RGBA32F texel per sphere-brush path point):
    // the shader reads pathCount entries, so a larger retained texture avoids
    // reallocating on every stroke's slightly different sample count
    private getPathTexture(count: number) {
        if (!this.pathTexture || this.pathTexture.width < count) {
            this.pathTexture?.destroy();
            this.pathTexture = new Texture(this.device, {
                name: 'sphereBrushPath',
                width: count,
                height: 1,
                format: PIXELFORMAT_RGBA32F,
                mipmaps: false,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE,
                // float textures are only filterable with an extension, and the
                // shader fetches exact texels anyway
                minFilter: FILTER_NEAREST,
                magFilter: FILTER_NEAREST
            });
        }
        return this.pathTexture;
    }

    private getResources(width: number, numSplats: number) {
        const { device } = this;

        if (!this.shader) {
            this.shader = ShaderUtils.createShader(device, {
                uniqueName: 'intersectByMaskShader',
                attributes: {
                    vertex_position: SEMANTIC_POSITION
                },
                vertexGLSL: vertexShader,
                fragmentGLSL: fragmentShader
            });
        }

        const resultWidth = packedMaskWidth(width);
        const resultHeight = packedMaskHeight(resultWidth, numSplats);

        if (!this.texture || this.texture.width !== resultWidth || this.texture.height !== resultHeight) {
            if (this.texture) {
                this.texture.destroy();
                this.renderTarget.destroy();
            }

            this.texture = new Texture(device, {
                name: 'intersectTexture',
                width: resultWidth,
                height: resultHeight,
                format: PIXELFORMAT_RGBA8,
                mipmaps: false,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE
            });

            this.renderTarget = new RenderTarget({
                colorBuffer: this.texture,
                depth: false
            });
        }

        return {
            shader: this.shader,
            texture: this.texture,
            renderTarget: this.renderTarget
        };
    }

    async run(options: IntersectOptions, splat: Splat, bufferPool: BufferPool): Promise<Uint8Array> {
        const { device } = this;
        const { scope } = device;

        const numSplats = splat.splatData.numSplats;
        const resource = splat.entity.gsplat.instance.resource as any;
        const transformA = resource.getTexture('transformA');
        // per-splat scale (xyz) + rotation z, used by the footprint tests
        const transformB = resource.getTexture('transformB');
        const splatTransform = splat.transformTexture;
        const transformPalette = splat.transformPalette.texture;

        // update view projection matrix
        const camera = splat.scene.camera.camera;
        this.viewProjectionMat.mul2(camera.projectionMatrix, camera.viewMatrix);

        // allocate resources
        const resources = this.getResources(transformA.width, numSplats);

        // footprint is carried by whichever shape option is in play (the brush
        // keeps it inside its own options object)
        const footprint = (options as MaskOptions).footprint ??
            (options as SphereOptions).footprint ??
            (options as SphereBrushOptions).sphereBrush?.footprint ??
            0;

        resolve(scope, {
            transformA,
            transformB,
            splatTransform,
            transformPalette,
            splat_params: [transformA.width, numSplats],
            matrix_model: splat.entity.getWorldTransform().data,
            matrix_viewProjection: this.viewProjectionMat.data,
            output_params: [resources.texture.width, resources.texture.height],
            footprint
        });

        const maskOptions = options as MaskOptions;
        const rectOptions = options as RectOptions;
        const sphereOptions = options as SphereOptions;
        const boxOptions = options as BoxOptions;
        const sphereBrush = (options as SphereBrushOptions).sphereBrush;

        // the sphere brush gates candidates with the stroke mask when footprint
        // is 0 (its "visible stroke" semantics), so that mask doubles as the
        // mode-0 mask
        const maskTexture = sphereBrush?.mask ?? maskOptions.mask;
        resolve(scope, maskTexture ? {
            mask: maskTexture,
            mask_params: [maskTexture.width, maskTexture.height]
        } : {
            mask: this.dummyTexture,
            mask_params: [0, 0]
        });

        if (rectOptions.rect) {
            resolve(scope, {
                rect_params: [
                    rectOptions.rect.x1 * 2.0 - 1.0,
                    rectOptions.rect.y1 * 2.0 - 1.0,
                    rectOptions.rect.x2 * 2.0 - 1.0,
                    rectOptions.rect.y2 * 2.0 - 1.0
                ]
            });
        } else {
            resolve(scope, {
                rect_params: [0, 0, 0, 0]
            });
        }

        // path uniforms are always resolved: a stale path must never be read by
        // a following non-brush pass
        const points = sphereBrush?.points;
        const pathCount = points ? Math.floor(points.length / 4) : 0;
        const pathMin = [0, 0, 0];
        const pathMax = [0, 0, 0];
        if (pathCount > 0) {
            // world-space bounds of the path (each capsule segment widened by
            // its own radius, and by half the brush thickness along the view when
            // a slab is requested); the shader culls candidates against this
            // before walking the path
            const brushReach = Math.max(0, (sphereBrush?.thickness ?? 0) * 0.5);
            pathMin.fill(Infinity);
            pathMax.fill(-Infinity);
            for (let i = 0; i < pathCount; ++i) {
                const radius = Math.abs(points[i * 4 + 3]);
                for (let axis = 0; axis < 3; ++axis) {
                    const v = points[i * 4 + axis];
                    const reach = radius + brushReach;
                    pathMin[axis] = Math.min(pathMin[axis], v - reach);
                    pathMax[axis] = Math.max(pathMax[axis], v + reach);
                }
            }

            const pathTexture = this.getPathTexture(pathCount);
            const pathData = pathTexture.lock() as Float32Array;
            pathData.set(points.subarray(0, pathCount * 4));
            pathTexture.unlock();
        }
        resolve(scope, {
            pathCount,
            pathMin,
            pathMax,
            pathTexture: this.pathTexture ?? this.dummyTexture,
            // brush thickness (0 = plain sphere brush) and the view direction it is
            // measured along; both are always resolved so a stale slab can never
            // clip a following stroke
            brushThickness: sphereBrush?.thickness ?? 0,
            brushViewDir: sphereBrush?.viewDir ?? [0, 0, 1]
        });

        if (sphereBrush) {
            resolve(scope, {
                mode: 4,
                shape_matrix_inv: identityMat.data
            });
        } else if (sphereOptions.sphere) {
            shapeInvMat.copy(sphereOptions.sphere.transform).invert();
            resolve(scope, {
                mode: 2,
                shape_matrix_inv: shapeInvMat.data
            });
        } else if (boxOptions.box) {
            shapeInvMat.copy(boxOptions.box.transform).invert();
            resolve(scope, {
                mode: 3,
                shape_matrix_inv: shapeInvMat.data
            });
        } else {
            resolve(scope, {
                mode: rectOptions.rect ? 1 : 0,
                shape_matrix_inv: identityMat.data
            });
        }

        device.setBlendState(BlendState.NOBLEND);
        drawQuadWithShader(device, resources.renderTarget, resources.shader);

        const byteLen = resources.texture.width * resources.texture.height * 4;
        const buffer = bufferPool.acquire(byteLen);

        // Same driver-TDR guard as the other readback sites.
        await waitForGpuDrain();
        try {
            const data = await withReadbackTimeout(resources.texture.read(0, 0, resources.texture.width, resources.texture.height, {
                renderTarget: resources.renderTarget,
                data: buffer,
                immediate: true
            }));
            return data as Uint8Array;
        } catch (err) {
            // Degrade to an empty mask rather than stalling the GPU pipeline.
            console.warn('[Intersect] readback failed or timed out, returning empty mask', err);
            return new Uint8Array(byteLen);
        }
    }
}

export { Intersect, IntersectOptions, MaskOptions, RectOptions, SphereOptions, BoxOptions, SphereBrushOptions };
