import {
    CULLFACE_NONE,
    DepthState,
    PRIMITIVE_POINTS,
    QuadRender,
    RenderPass,
    SEMANTIC_POSITION,
    TYPE_FLOAT32,
    BlendState,
    GraphicsDevice,
    RenderTarget,
    Shader,
    VertexBuffer,
    VertexFormat
} from 'playcanvas';

let cachedDevice: GraphicsDevice = null;
let cachedVB: VertexBuffer = null;

const getInstancingVB = (device: GraphicsDevice) => {
    if (cachedVB && cachedDevice === device) {
        return cachedVB;
    }
    const format = new VertexFormat(device, [
        { semantic: SEMANTIC_POSITION, components: 1, type: TYPE_FLOAT32 }
    ]);
    (format as any).instancing = true;
    cachedVB = new VertexBuffer(device, format, 1);
    cachedVB.lock();
    cachedVB.unlock();
    cachedDevice = device;
    return cachedVB;
};

// one QuadRender per shader: it owns that shader's uniform buffer and bind group
// (built from the shader's own formats), so it cannot be shared between shaders -
// but it can be reused across calls of the same shader.
const cachedQuads = new Map<Shader, QuadRender>();

const getQuadRender = (shader: Shader) => {
    let quad = cachedQuads.get(shader);
    if (!quad) {
        quad = new QuadRender(shader);
        cachedQuads.set(shader, quad);
    }
    return quad;
};

// WebGPU only. The WebGPU device rejects draw calls outside a render pass and has
// no updateBegin/updateEnd, and a raw device.draw() there neither opens a pass nor
// uploads the shader's device-scope uniforms - QuadRender.render() does both (it
// builds the uniform buffer from shader.meshUniformBufferFormat, reads the scope
// values and binds BINDGROUP_MESH / BINDGROUP_MESH_UB), which is why the bin pass
// runs through RenderPass + QuadRender on that backend instead of through
// drawPointsWithShader's raw point draw.
class BinPass extends RenderPass {
    private quad: QuadRender;
    private blendState: BlendState;
    private numSplats: number;

    constructor(device: GraphicsDevice, shader: Shader, blendState: BlendState, numSplats: number) {
        super(device);
        this.quad = getQuadRender(shader);
        this.blendState = blendState;
        this.numSplats = numSplats;
    }

    execute() {
        const { device } = this;

        device.setBlendState(this.blendState);
        device.setDepthState(DepthState.NODEPTH);
        // the quads are built in clip space, so their winding carries no meaning
        device.setCullMode(CULLFACE_NONE);

        // one instance of the engine's unit quad per splat; the vertex shader places
        // it over its bin's pixel (GSPLAT_BIN_QUADS in histogram-shaders.ts)
        this.quad.render(null, null, this.numSplats);
    }
}

// dispatch one primitive per splat into `target` with `blendState`, so the splat's
// value is accumulated into a bin (see binVS/binFS in histogram-shaders.ts).
//
// WebGL2: one PRIMITIVE_POINTS vertex per splat, gl_PointSize = 1.0 in the shader.
// WebGPU: one instanced quad per splat (see BinPass) - measured with a 20M splat
// model on ?gpu=webgpu, the WebGL sequence here threw
// "d.updateBegin is not a function" (the WebGPU device has no updateBegin/updateEnd)
// and every bin stayed at zero, leaving the data panel histogram empty.
const drawPointsWithShader = (
    device: GraphicsDevice,
    target: RenderTarget,
    shader: Shader,
    count: number,
    blendState: BlendState
) => {
    if (device.isWebGPU) {
        const pass = new BinPass(device, shader, blendState, count);
        pass.init(target);
        // never clear here: the caller clears the target and this pass only adds
        pass.colorOps.clear = false;
        // the shader converts the quad's half-pixel corner offset from pixels to
        // clip space with this size (the WebGPU analogue of gl_PointSize's pixel)
        device.scope.resolve('uHistViewportSize').setValue([target.width, target.height]);
        pass.render();
        return;
    }

    const vb = getInstancingVB(device);
    const d = device as any;

    const oldRt = d.renderTarget;
    const oldVx = d.vx, oldVy = d.vy, oldVw = d.vw, oldVh = d.vh;
    const oldSx = d.sx, oldSy = d.sy, oldSw = d.sw, oldSh = d.sh;

    d.setRenderTarget(target);
    d.updateBegin();

    const w = target ? target.width : d.width;
    const h = target ? target.height : d.height;
    d.setViewport(0, 0, w, h);
    d.setScissor(0, 0, w, h);

    d.setBlendState(blendState);
    d.setDepthState(DepthState.NODEPTH);
    d.setVertexBuffer(vb);
    d.setShader(shader);

    d.draw({
        type: PRIMITIVE_POINTS,
        base: 0,
        count,
        indexed: false
    });

    d.updateEnd();
    d.setRenderTarget(oldRt);
    d.setViewport(oldVx, oldVy, oldVw, oldVh);
    d.setScissor(oldSx, oldSy, oldSw, oldSh);
};

export { drawPointsWithShader };
