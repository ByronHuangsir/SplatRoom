import { computeSplatValueGLSL } from './splat-value-shader';

const fullscreenVS = /* glsl */ `
    attribute vec2 vertex_position;
    void main(void) {
        gl_Position = vec4(vertex_position, 0.0, 1.0);
    }
`;

// pass 1: tile min/max
// each fragment owns a contiguous range of splat indices and reduces them inline
const tileMinMaxFS = /* glsl */ `
    ${computeSplatValueGLSL}

    uniform int tileSize;
    uniform int gridDim;

    #define MAX_TILE_SIZE 65536

    void main(void) {
        ivec2 tileXY = ivec2(gl_FragCoord);
        int tileId = tileXY.y * gridDim + tileXY.x;
        int baseIdx = tileId * tileSize;
        int endIdx = min(baseIdx + tileSize, splat_params.y);

        float minVal =  1e30;
        float maxVal = -1e30;

        for (int k = 0; k < MAX_TILE_SIZE; k++) {
            int idx = baseIdx + k;
            if (idx >= endIdx) break;
            float val;
            bool sel;
            bool vis;
            bool valid = computeSplatValue(idx, val, sel, vis);
            if (!valid || !vis) continue;
            minVal = min(minVal, val);
            maxVal = max(maxVal, val);
        }

        gl_FragColor = vec4(minVal, maxVal, 0.0, 0.0);
    }
`;

// pass 2: reduce 64×64 → 1×1
const finalReduceFS = /* glsl */ `
    uniform sampler2D inputTex;
    uniform int gridDim;

    #define MAX_GRID_DIM 64

    void main(void) {
        float minVal =  1e30;
        float maxVal = -1e30;

        for (int y = 0; y < MAX_GRID_DIM; y++) {
            if (y >= gridDim) break;
            for (int x = 0; x < MAX_GRID_DIM; x++) {
                if (x >= gridDim) break;
                vec2 v = texelFetch(inputTex, ivec2(x, y), 0).rg;
                minVal = min(minVal, v.x);
                maxVal = max(maxVal, v.y);
            }
        }

        gl_FragColor = vec4(minVal, maxVal, 0.0, 0.0);
    }
`;

// pass 3: bin counting (one splat per primitive, additive blending).
//
// WebGL2 draws one 1-pixel POINT per splat (gl_PointSize = 1.0). WGSL has no point
// size, and a vertex shader that assigns gl_PointSize loses its entry point when it
// is transpiled to WGSL, which produced an invalid pipeline on the WebGPU backend
// (see the NOTE in splat-overlay-shader.ts). The WebGPU variant is therefore
// compiled with GSPLAT_BIN_QUADS (set by CalcHistogram.getBinShader) and expands
// each splat into a screen-space quad that covers exactly the same single pixel:
// the host draws one instance of the engine's unit quad per splat, `vertex_position`
// carries that quad's corner (-1,-1)..(1,1) and uHistViewportSize is the size of the
// bin render target in pixels.
const binVS = /* glsl */ `
    ${computeSplatValueGLSL}

    uniform sampler2D minMax;
    uniform int numBins;

    #ifdef GSPLAT_BIN_QUADS
    // size of the bin render target in pixels (numBins x 1), used to convert the
    // half-pixel corner offset below from pixels to clip space
    uniform vec2 uHistViewportSize;
    // corner of the instanced unit quad, supplied by the engine's shared quad
    // vertex buffer: (-1,-1) (1,-1) (-1,1) (1,1), two triangles over indices
    // 0,1,2 / 2,1,3 that share their vertex positions.
    attribute vec2 vertex_position;
    #endif

    varying float v_flag;

    void main(void) {
        #ifdef GSPLAT_BIN_QUADS
        // one instance per splat; the quad mesh supplies four vertices per instance
        int splatIndex = gl_InstanceID;
        #else
        int splatIndex = gl_VertexID;
        #endif

        float val;
        bool sel;
        bool vis;
        bool valid = computeSplatValue(splatIndex, val, sel, vis);
        bool include = valid && vis;
        v_flag = include ? (sel ? 2.0 : 1.0) : 0.0;

        if (!include) {
            // all four quad corners (or the single point) land outside the viewport,
            // so nothing is rasterized
            gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
            #ifndef GSPLAT_BIN_QUADS
            gl_PointSize = 0.0;
            #endif
            return;
        }

        vec2 mm = texelFetch(minMax, ivec2(0, 0), 0).rg;
        float minV = mm.x;
        float maxV = mm.y;
        float n = (maxV == minV) ? 0.0 : (val - minV) / (maxV - minV);
        int bin = clamp(int(n * float(numBins)), 0, numBins - 1);

        float xNDC = (float(bin) + 0.5) / float(numBins) * 2.0 - 1.0;
        gl_Position = vec4(xNDC, 0.0, 0.0, 1.0);
        #ifdef GSPLAT_BIN_QUADS
        // half a pixel in clip space is 1 / viewportSize (the whole NDC range of 2
        // spans the viewport), so the corner sign gives a quad of exactly one pixel
        // around the bin centre - the coverage gl_PointSize = 1.0 has on WebGL2.
        gl_Position.xy += vertex_position / uHistViewportSize;
        #else
        gl_PointSize = 1.0;
        #endif
    }
`;

const binFS = /* glsl */ `
    varying float v_flag;
    void main(void) {
        float sel   = v_flag == 2.0 ? 1.0 : 0.0;
        float unsel = v_flag == 1.0 ? 1.0 : 0.0;
        gl_FragColor = vec4(sel, unsel, 0.0, 0.0);
    }
`;

export {
    fullscreenVS,
    tileMinMaxFS,
    finalReduceFS,
    binVS,
    binFS
};
