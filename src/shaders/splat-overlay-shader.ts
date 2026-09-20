// NOTE: WGSL has no point size, and glslang/twgsl silently drops the entry point of a
// vertex shader that assigns gl_PointSize, which produced an invalid pipeline on the
// WebGPU backend. The WebGPU path therefore defines GSPLAT_QUAD_SPRITES (see
// splat-overlay.ts) and expands every splat center into a screen-space quad there, which
// gives the overlay the same pixel size as gl_PointSize does on WebGL2.
//
// The WebGPU path also defines GSPLAT_OVERLAY_PARAM_MATRICES: it takes the model and
// view-projection matrices from material parameters instead of the engine's mesh/view
// uniform buffers, which are not bound correctly for these custom materials on WebGPU
// (the same issue the splat material solves with uSplatView/uSplatViewProj).
const vertexShader = /* glsl */ `
    #ifdef GSPLAT_OVERLAY_PARAM_MATRICES
        uniform mat4 uOverlayModel;
        uniform mat4 uOverlayViewProj;
        #define OV_MODEL uOverlayModel
        #define OV_VIEWPROJ uOverlayViewProj
    #else
        uniform mat4 matrix_model;
        uniform mat4 matrix_viewProjection;
        #define OV_MODEL matrix_model
        #define OV_VIEWPROJ matrix_viewProjection
    #endif

    #ifdef GSPLAT_QUAD_SPRITES
    // size of the render target in pixels, used to place the sprite corners
    uniform vec2 uOverlayViewportSize;
    #endif

    uniform highp usampler2D splatOrder;            // order texture mapping render order to splat ID
    uniform uint splatTextureSize;                  // width of order texture

    // 1 = 也画已删除的高斯（与 splat 材质的 showDeleted 同源；默认 0）
    uniform float overlayShowDeleted;

    uniform sampler2D splatState;
    uniform highp usampler2D splatPosition;
    uniform highp usampler2D splatTransform;        // per-splat index into transform palette
    uniform sampler2D transformPalette;             // palette of transform matrices
    uniform sampler2D splatColor;                   // Gaussian color texture (RGBA16F)

    // SH textures (for uncompressed format)
    #if SH_BANDS > 0
    uniform highp usampler2D splatSH_1to3;
    #if SH_BANDS > 1
    uniform highp usampler2D splatSH_4to7;
    uniform highp usampler2D splatSH_8to11;
    #if SH_BANDS > 2
    uniform highp usampler2D splatSH_12to15;
    #endif
    #endif
    #endif

    uniform vec3 view_position;                     // camera position in world space

    uniform uvec2 texParams;

    uniform float splatSize;
    uniform float useGaussianColor;                 // 0.0 = use selection colors, 1.0 = use gaussian color
    uniform vec4 selectedClr;
    uniform vec4 unselectedClr;

    varying vec4 varying_color;

    // calculate the current splat index and uv
    ivec2 calcSplatUV(uint index, uint width) {
        return ivec2(int(index % width), int(index / width));
    }

    #if SH_BANDS > 0

    // include SH evaluation from engine (provides SH_COEFFS, constants, and evalSH)
    #include "gsplatEvalSHVS"

    // unpack signed 11 10 11 bits
    vec3 unpack111011s(uint bits) {
        return vec3((uvec3(bits) >> uvec3(21u, 11u, 0u)) & uvec3(0x7ffu, 0x3ffu, 0x7ffu)) / vec3(2047.0, 1023.0, 2047.0) * 2.0 - 1.0;
    }

    // fetch quantized spherical harmonic coefficients with scale
    void fetchScale(in uvec4 t, out float scale, out vec3 a, out vec3 b, out vec3 c) {
        scale = uintBitsToFloat(t.x);
        a = unpack111011s(t.y);
        b = unpack111011s(t.z);
        c = unpack111011s(t.w);
    }

    // fetch quantized spherical harmonic coefficients
    void fetchSH(in uvec4 t, out vec3 a, out vec3 b, out vec3 c, out vec3 d) {
        a = unpack111011s(t.x);
        b = unpack111011s(t.y);
        c = unpack111011s(t.z);
        d = unpack111011s(t.w);
    }

    void fetchSH1(in uint t, out vec3 a) {
        a = unpack111011s(t);
    }

    #if SH_BANDS == 1
    void readSHData(in ivec2 uv, out vec3 sh[3], out float scale) {
        fetchScale(texelFetch(splatSH_1to3, uv, 0), scale, sh[0], sh[1], sh[2]);
    }
    #elif SH_BANDS == 2
    void readSHData(in ivec2 uv, out vec3 sh[8], out float scale) {
        fetchScale(texelFetch(splatSH_1to3, uv, 0), scale, sh[0], sh[1], sh[2]);
        fetchSH(texelFetch(splatSH_4to7, uv, 0), sh[3], sh[4], sh[5], sh[6]);
        fetchSH1(texelFetch(splatSH_8to11, uv, 0).x, sh[7]);
    }
    #elif SH_BANDS == 3
    void readSHData(in ivec2 uv, out vec3 sh[15], out float scale) {
        fetchScale(texelFetch(splatSH_1to3, uv, 0), scale, sh[0], sh[1], sh[2]);
        fetchSH(texelFetch(splatSH_4to7, uv, 0), sh[3], sh[4], sh[5], sh[6]);
        fetchSH(texelFetch(splatSH_8to11, uv, 0), sh[7], sh[8], sh[9], sh[10]);
        fetchSH(texelFetch(splatSH_12to15, uv, 0), sh[11], sh[12], sh[13], sh[14]);
    }
    #endif

    #endif

    void main(void) {
        // WebGPU: one quad per splat (six vertices), WebGL2: one point per splat
        #ifdef GSPLAT_QUAD_SPRITES
            uint splatIndex = uint(gl_VertexID) / 6u;
            uint splatCorner = uint(gl_VertexID) - splatIndex * 6u;
        #else
            uint splatIndex = uint(gl_VertexID);
        #endif

        // Which splat this vertex belongs to. WebGL2 reads the engine's order texture (the
        // sorted, visible set). WebGPU has no order texture — the engine sorts into a storage
        // buffer there — so the host hands us a texture seeded with the identity mapping
        // (splat i at slot i) instead: mirroring the real sorted order would cost a ~20 MB
        // upload per sort (measured: 180 MB/s while orbiting a 5M splat model) for a
        // diagnostic overlay. Holding the identity mapping means drawing every splat in
        // storage order, which for center dots is visually equivalent (off-screen splats are
        // clipped).
        ivec2 orderUV = ivec2(int(splatIndex % splatTextureSize), int(splatIndex / splatTextureSize));
        uint splatId = texelFetch(splatOrder, orderUV, 0).r;

        ivec2 splatUV = calcSplatUV(splatId, texParams.x);
        uint splatState = uint(texelFetch(splatState, splatUV, 0).r * 255.0);

        // 跳过"锁定"和"删除"的点。
        // 2026-09-20（用户 2000 万点实测 ①）：这里原来只判 bit 2（锁定），注释写着
        // "deleted splats are already excluded from order texture" —— 那只在 WebGL2 成立
        // （引擎的 order texture 是排序后的可见集合）。WebGPU 走的是恒等映射 + 画满
        // splatData.numSplats 行，删除位根本没人管，于是"显示/隐藏 Splats"一按下去，
        // 之前删掉的点全部又画出来了。所以删除位必须在这里自己判，两个后端一致。
        // overlayShowDeleted 与 splat 材质的 showDeleted 同源：打开"显示已删除"时
        // 覆盖层也不该瞒着用户。
        bool skipDeleted = overlayShowDeleted < 0.5 && (splatState & 4u) != 0u;
        if ((splatState & 2u) != 0u || skipDeleted) {
            // locked / deleted
            gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
            #ifndef GSPLAT_QUAD_SPRITES
                gl_PointSize = 0.0;
            #endif
        } else {
            mat4 model = OV_MODEL;

            // handle per-splat transform
            uint transformIndex = texelFetch(splatTransform, splatUV, 0).r;
            if (transformIndex > 0u) {
                // read transform matrix
                int u = int(transformIndex % 512u) * 3;
                int v = int(transformIndex / 512u);

                mat4 t;
                t[0] = texelFetch(transformPalette, ivec2(u, v), 0);
                t[1] = texelFetch(transformPalette, ivec2(u + 1, v), 0);
                t[2] = texelFetch(transformPalette, ivec2(u + 2, v), 0);
                t[3] = vec4(0.0, 0.0, 0.0, 1.0);

                model = OV_MODEL * transpose(t);
            }

            vec3 center = uintBitsToFloat(texelFetch(splatPosition, splatUV, 0).xyz);

            vec3 gaussianClr;

            if (useGaussianColor > 0.0) {
                // get base gaussian color
                gaussianClr = texelFetch(splatColor, splatUV, 0).xyz;

                #if SH_BANDS > 0
                    // calculate world position and view direction
                    vec3 worldPos = (model * vec4(center, 1.0)).xyz;
                    vec3 viewDir = normalize(worldPos - view_position);
                    // transform view direction to model space
                    vec3 modelViewDir = normalize(viewDir * mat3(model));

                    // read and evaluate SH
                    vec3 sh[SH_COEFFS];
                    float scale;
                    readSHData(splatUV, sh, scale);
                    gaussianClr += evalSH(sh, modelViewDir) * scale;
                #endif
            } else {
                gaussianClr = unselectedClr.xyz;
            }

            // choose between selection colors and gaussian color
            varying_color = vec4(mix(gaussianClr, selectedClr.xyz, (splatState == 1u) ? selectedClr.w : 0.0), unselectedClr.w);

            gl_Position = OV_VIEWPROJ * model * vec4(center, 1.0);

            // disable depth clipping so the centers always draw on top of the model. the
            // nearest clip-space z differs per backend: GL's clip space is [-1, 1] (so
            // z = -w is the near plane, z = 0 would land in the middle of the depth range
            // and let the model occlude the dots), WebGPU's is [0, 1] where 0 is nearest.
            #ifdef GSPLAT_QUAD_SPRITES
                gl_Position.z = 0.0;
            #else
                gl_Position.z = -gl_Position.w;
            #endif

            #ifdef GSPLAT_QUAD_SPRITES
                // expand the center into a screen-space quad of splatSize pixels: the corner
                // offset is converted from pixels to clip space and scaled by w, so the
                // perspective divide keeps the sprite a constant size on screen. corner
                // order is (0,0) (1,0) (0,1) / (0,1) (1,0) (1,1) — two counter-clockwise
                // triangles in clip space.
                vec2 corner = vec2(
                    (splatCorner == 1u || splatCorner == 4u || splatCorner == 5u) ? 1.0 : 0.0,
                    (splatCorner == 2u || splatCorner == 3u || splatCorner == 5u) ? 1.0 : 0.0
                );
                gl_Position.xy += (corner * 2.0 - 1.0) * splatSize / uOverlayViewportSize * gl_Position.w;
            #else
                gl_PointSize = splatSize;
            #endif
        }
    }
`;

const fragmentShader = /* glsl */ `
    varying vec4 varying_color;

    void main(void) {
        gl_FragColor = varying_color;
    }
`;

export { vertexShader, fragmentShader };
