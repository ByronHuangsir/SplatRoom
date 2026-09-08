import {
    ADDRESS_CLAMP_TO_EDGE,
    PIXELFORMAT_RGBA32F,
    SEMANTIC_POSITION,
    drawQuadWithShader,
    GraphicsDevice,
    RenderTarget,
    ScopeSpace,
    Shader,
    ShaderUtils,
    Texture,
    BlendState
} from 'playcanvas';

import { vertexShader, fragmentShader } from '../shaders/position-shader';
import { Splat } from '../splat';
import { waitForGpuDrain, withReadbackTimeout } from './gpu-readback';

const resolve = (scope: ScopeSpace, values: any) => {
    for (const key in values) {
        scope.resolve(key).setValue(values[key]);
    }
};

class CalcPositions {
    private device: GraphicsDevice;
    private shader: Shader = null;
    private texture: Texture = null;
    private renderTarget: RenderTarget = null;
    private data: Float32Array = null;

    constructor(device: GraphicsDevice) {
        this.device = device;
    }

    private getResources(width: number, height: number) {
        const { device } = this;

        if (!this.shader) {
            this.shader = ShaderUtils.createShader(device, {
                uniqueName: 'calcPositionShader',
                attributes: {
                    vertex_position: SEMANTIC_POSITION
                },
                vertexGLSL: vertexShader,
                fragmentGLSL: fragmentShader
            });
        }

        if (!this.texture || this.texture.width !== width || this.texture.height !== height) {
            if (this.texture) {
                this.texture.destroy();
                this.renderTarget.destroy();
            }

            this.texture = new Texture(device, {
                name: 'positionTex',
                width,
                height,
                format: PIXELFORMAT_RGBA32F,
                mipmaps: false,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE
            });

            this.renderTarget = new RenderTarget({
                colorBuffer: this.texture,
                depth: false
            });

            this.data = new Float32Array(width * height * 4);
        }

        return {
            shader: this.shader,
            texture: this.texture,
            renderTarget: this.renderTarget,
            data: this.data
        };
    }

    async run(splat: Splat): Promise<Float32Array> {
        const { device } = this;
        const { scope } = device;

        const numSplats = splat.splatData.numSplats;
        const transformA = (splat.entity.gsplat.instance.resource as any).getTexture('transformA');
        const splatTransform = splat.transformTexture;
        const transformPalette = splat.transformPalette.texture;

        // allocate resources
        const resources = this.getResources(transformA.width, transformA.height);

        resolve(scope, {
            transformA,
            splatTransform,
            transformPalette,
            splat_params: [transformA.width, numSplats]
        });

        device.setBlendState(BlendState.NOBLEND);
        drawQuadWithShader(device, resources.renderTarget, resources.shader);

        // Same driver-TDR guard as calcBound: yield a frame so the GPU queue
        // drains, then bound the readback. On failure return the previous data
        // (still resident in resources.data) instead of blocking the pipeline.
        await waitForGpuDrain();

        try {
            const data = await withReadbackTimeout(resources.texture.read(0, 0, resources.texture.width, resources.texture.height, {
                renderTarget: resources.renderTarget,
                data: resources.data,
                immediate: false
            }));
            return data as Float32Array;
        } catch (err) {
            console.warn('[CalcPositions] readback failed or timed out, using previous positions', err);
            return resources.data as Float32Array;
        }
    }
}

export { CalcPositions };
