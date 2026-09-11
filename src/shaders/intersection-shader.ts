// Splat selection intersection shader.
//
// One thread per packed output texel; each thread tests up to four splats
// against the selection region. Four modes:
//   0 mask   - splat within the alpha mask (stroke region)
//   1 rect   - splat within the screen-space rect
//   2 sphere - splat within a world-space sphere
//   3 box    - splat within a world-space box
//
// `footprint` selects the hit criterion (SuperSplat 3 style):
//   0  -> the splat's center point is tested (cheap and exact: what SplatRoom
//         has always done)
//   >0 -> the splat's rendered extent (the 2*sqrt(2)-sigma ellipsoid the
//         renderer rasterizes) is tested, scaled by this factor, so a splat
//         counts when its visible footprint touches the region even if its
//         center falls outside it. Screen-space modes (0/1) test the projected
//         ellipse against the region; world-space modes (2/3) use the extent's
//         support function against the volume.
// The footprint factor 1.0 equals the full rendered footprint.

const vertexShader = /* glsl */ `
    attribute vec2 vertex_position;
    void main(void) {
        gl_Position = vec4(vertex_position, 0.0, 1.0);
    }
`;

const fragmentShader = /* glsl */ `
    uniform highp usampler2D transformA;            // splat center x, y, z + packed rotation xy
    uniform sampler2D transformB;                   // splat scale x, y, z + rotation z
    uniform highp usampler2D splatTransform;        // transform palette index
    uniform sampler2D transformPalette;             // palette of transforms
    uniform uvec2 splat_params;                     // splat texture width, num splats

    uniform mat4 matrix_model;
    uniform mat4 matrix_viewProjection;

    uniform uvec2 output_params;                    // output width, height

    // 0: mask, 1: rect, 2: sphere, 3: box, 4: sphere brush path
    uniform int mode;

    // mask params
    uniform sampler2D mask;                         // mask in alpha channel
    uniform vec2 mask_params;                       // mask width, height

    // rect params
    uniform vec4 rect_params;                       // rect in flipped-ndc space: x0, y0, x1, y1

    // sphere/box params: transforms world space into the shape's local space,
    // where the shape is the unit sphere (diameter 1) or unit cube (side 1)
    uniform mat4 shape_matrix_inv;

    // 0: center point test, >0: rendered-footprint test scaled by this factor
    uniform float footprint;

    // sphere brush path (mode 4): world-space xyz + signed radius per point,
    // one RGBA32F texel per point. A negative radius marks the start of a new
    // subpath (a depth discontinuity in the stroke) while keeping that point's
    // sphere. pathMin/pathMax bound the path in world space for cheap culling.
    uniform int pathCount;
    uniform sampler2D pathTexture;
    uniform vec3 pathMin;
    uniform vec3 pathMax;

    // the renderer rasterizes a gaussian out to 2*sqrt(2) sigma
    const float FOOTPRINT_EXTENT = 2.8284271;

    mat3 rotationMatrix(vec4 q) {
        float x = q.x;
        float y = q.y;
        float z = q.z;
        float w = q.w;
        return mat3(
            1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y),
            2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x),
            2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y)
        );
    }

    // the splat's rendered extent basis in the given linear space:
    // rotation * scale, widened by the footprint factor
    mat3 splatBasis(uint packedRotation, float rotationZ, vec3 scale, mat3 linear) {
        vec2 qxy = unpackHalf2x16(packedRotation);
        float z = rotationZ;
        vec4 q = vec4(qxy.x, qxy.y, z, sqrt(max(0.0, 1.0 - dot(vec3(qxy.x, qxy.y, z), vec3(qxy.x, qxy.y, z)))));
        mat3 rs = mat3(scale.x, 0.0, 0.0, 0.0, scale.y, 0.0, 0.0, 0.0, scale.z);
        return linear * rotationMatrix(q) * rs * (footprint * FOOTPRINT_EXTENT);
    }

    // clip-space guard: keeps samples behind the camera out of the tests.
    // returns the flipped-ndc point (the rect space) and the ndc xy.
    bool clipPoint(vec3 world, out vec2 flippedNdc, out vec2 ndcXY) {
        vec4 clip = matrix_viewProjection * vec4(world, 1.0);
        if (clip.w <= 0.0) {
            return false;
        }
        vec3 ndc = clip.xyz / clip.w;
        ndcXY = ndc.xy;
        flippedNdc = ndc.xy * vec2(1.0, -1.0);
        return true;
    }

    bool pointInRect(vec2 p) {
        return all(greaterThan(p, rect_params.xy)) && all(lessThan(p, rect_params.zw));
    }

    bool maskHitAt(vec2 uv) {
        if (any(lessThan(uv, vec2(0.0))) || any(greaterThanEqual(uv, mask_params))) {
            return false;
        }
        return texelFetch(mask, ivec2(uv), 0).a >= 1.0;
    }

    // rect vs projected extent: sample points on the ellipse (the rect region
    // itself cannot be sampled) and, to catch a small rect sitting entirely
    // inside a large extent, test the rect corners against the ellipse conic.
    bool rectFootprintHit(vec3 world, mat3 basis) {
        vec2 center;
        vec2 ndc;
        if (!clipPoint(world, center, ndc)) {
            return false;
        }
        if (pointInRect(center)) {
            return true;
        }

        // projected extent axes (linearized offsets of the basis columns)
        vec2 axes[3];
        for (int i = 0; i < 3; ++i) {
            vec2 p;
            vec2 n;
            axes[i] = clipPoint(world + basis[i], p, n) ? p - center : vec2(0.0);
        }

        for (int i = 0; i < 3; ++i) {
            for (int s = 1; s <= 2; ++s) {
                float f = float(s) * 0.5;
                vec2 p;
                vec2 n;
                if (clipPoint(world + basis[i] * f, p, n) && pointInRect(p)) {
                    return true;
                }
                if (clipPoint(world - basis[i] * f, p, n) && pointInRect(p)) {
                    return true;
                }
            }
        }

        // conic of the projected ellipse: q11 dx^2 + 2 q12 dx dy + q22 dy^2 <= 1
        float c00 = dot(axes[0], axes[0]) + dot(axes[1], axes[1]) + dot(axes[2], axes[2]);
        float c01 = axes[0].x * axes[0].y + axes[1].x * axes[1].y + axes[2].x * axes[2].y;
        float c11 = axes[0].y * axes[0].y + axes[1].y * axes[1].y + axes[2].y * axes[2].y;
        float det = c00 * c11 - c01 * c01;
        if (det < 1e-12) {
            return false;
        }
        float q11 = c11 / det;
        float q12 = -c01 / det;
        float q22 = c00 / det;

        for (int i = 0; i < 4; ++i) {
            vec2 corner = i == 0 ? rect_params.xy : (i == 1 ? vec2(rect_params.z, rect_params.y) :
                (i == 2 ? vec2(rect_params.x, rect_params.w) : rect_params.zw));
            vec2 d = corner - center;
            if (q11 * d.x * d.x + 2.0 * q12 * d.x * d.y + q22 * d.y * d.y <= 1.0) {
                return true;
            }
        }
        return false;
    }

    // mask vs projected extent: the mask is an arbitrary stroke, so sample the
    // extent's center and the two scales along each of its axes - enough to
    // catch a stroke entering, crossing or leaving the extent
    bool maskFootprintHit(vec3 world, mat3 basis) {
        vec2 flipped;
        vec2 ndc;
        if (!clipPoint(world, flipped, ndc)) {
            return false;
        }
        if (maskHitAt((ndc.xy * vec2(0.5, -0.5) + 0.5) * mask_params)) {
            return true;
        }
        for (int i = 0; i < 3; ++i) {
            for (int s = 1; s <= 2; ++s) {
                float f = float(s) * 0.5;
                vec2 p;
                vec2 n;
                if (clipPoint(world + basis[i] * f, p, n) && maskHitAt((n.xy * vec2(0.5, -0.5) + 0.5) * mask_params)) {
                    return true;
                }
                if (clipPoint(world - basis[i] * f, p, n) && maskHitAt((n.xy * vec2(0.5, -0.5) + 0.5) * mask_params)) {
                    return true;
                }
            }
        }
        return false;
    }

    // sphere brush hit: the center point against a brush sphere, widened by the
    // splat's extent along the approach direction when footprint is on
    bool brushHit(vec3 world, vec3 closest, float radius, mat3 basisT, bool useFootprint) {
        vec3 d = world - closest;
        float dist = length(d);
        if (dist <= radius) {
            return true;
        }
        if (!useFootprint || dist < 1e-6) {
            return false;
        }
        return dist - radius <= length(basisT * (d / dist));
    }

    // walk the stroke path: each point is a sphere and consecutive points form a
    // capsule, so a stroked region is covered exactly (no gaps between samples)
    bool brushHitPath(vec3 world, mat3 basisT, bool useFootprint) {
        int width = int(textureSize(pathTexture, 0).x);
        for (int i = 0; i < pathCount; ++i) {
            vec4 point = texelFetch(pathTexture, ivec2(i % width, i / width), 0);
            float radius = abs(point.w);
            if (brushHit(world, point.xyz, radius, basisT, useFootprint)) {
                return true;
            }

            // a negative radius marks a depth discontinuity before this point
            if (i == 0 || point.w < 0.0) {
                continue;
            }

            vec4 previous = texelFetch(pathTexture, ivec2((i - 1) % width, (i - 1) / width), 0);
            vec3 delta = point.xyz - previous.xyz;
            float lengthSquared = dot(delta, delta);
            if (lengthSquared > 0.0) {
                float t = clamp(dot(world - previous.xyz, delta) / lengthSquared, 0.0, 1.0);
                vec3 closest = previous.xyz + delta * t;
                float segmentRadius = mix(abs(previous.w), radius, t);
                if (brushHit(world, closest, segmentRadius, basisT, useFootprint)) {
                    return true;
                }
            }
        }
        return false;
    }

    void main(void) {
        // calculate output id
        uvec2 outputUV = uvec2(gl_FragCoord);
        uint outputId = (outputUV.x + outputUV.y * output_params.x) * 4u;

        vec4 clr = vec4(0.0);

        for (uint i = 0u; i < 4u; i++) {
            uint id = outputId + i;

            if (id >= splat_params.y) {
                continue;
            }

            // calculate splatUV
            ivec2 splatUV = ivec2(
                int(id % splat_params.x),
                int(id / splat_params.x)
            );

            // read splat center + rotation/scale channels
            uvec4 texelA = texelFetch(transformA, splatUV, 0);
            vec4 texelB = texelFetch(transformB, splatUV, 0);
            vec3 center = uintBitsToFloat(texelA.xyz);

            // apply optional per-splat transform
            uint transformIndex = texelFetch(splatTransform, splatUV, 0).r;
            mat3 paletteBasis = mat3(1.0);
            if (transformIndex > 0u) {
                // read transform matrix
                int u = int(transformIndex % 512u) * 3;
                int v = int(transformIndex / 512u);

                mat3x4 t;
                t[0] = texelFetch(transformPalette, ivec2(u, v), 0);
                t[1] = texelFetch(transformPalette, ivec2(u + 1, v), 0);
                t[2] = texelFetch(transformPalette, ivec2(u + 2, v), 0);

                center = vec4(center, 1.0) * t;
                paletteBasis = mat3(t[0].xyz, t[1].xyz, t[2].xyz);
            }

            // transform to world space (sphere/box modes test world-space containment)
            mat3 modelBasis = mat3(matrix_model) * paletteBasis;
            vec3 world = (matrix_model * vec4(center, 1.0)).xyz;

            if (mode == 0 || mode == 1) {
                // screen-space modes: project to clip space and skip offscreen fragments
                vec4 clip = matrix_viewProjection * vec4(world, 1.0);
                if (clip.w <= 0.0) {
                    continue;
                }
                vec3 ndc = clip.xyz / clip.w;

                if (footprint <= 0.0) {
                    if (any(greaterThan(abs(ndc), vec3(1.0)))) {
                        continue;
                    }
                    if (mode == 0) {
                        // select by mask
                        ivec2 maskUV = ivec2((ndc.xy * vec2(0.5, -0.5) + 0.5) * mask_params);
                        clr[i] = texelFetch(mask, maskUV, 0).a < 1.0 ? 0.0 : 1.0;
                    } else {
                        // select by rect
                        clr[i] = all(greaterThan(ndc.xy * vec2(1.0, -1.0), rect_params.xy)) && all(lessThan(ndc.xy * vec2(1.0, -1.0), rect_params.zw)) ? 1.0 : 0.0;
                    }
                } else {
                    // footprint: an offscreen center can still reach into the
                    // region with its extent, so this test is not frustum-gated
                    mat3 basis = splatBasis(texelA.w, texelB.w, texelB.xyz, modelBasis);
                    clr[i] = (mode == 0 ? maskFootprintHit(world, basis) : rectFootprintHit(world, basis)) ? 1.0 : 0.0;
                }
            } else if (mode == 2) {
                // select by sphere (world-space, independent of camera frustum):
                // unit sphere test in shape-local space
                vec3 local = (shape_matrix_inv * vec4(world, 1.0)).xyz;
                if (footprint <= 0.0) {
                    clr[i] = length(local) < 0.5 ? 1.0 : 0.0;
                } else if (length(local) <= 0.5) {
                    clr[i] = 1.0;
                } else {
                    // support-function bound: the separation to the shape must
                    // not exceed the extent along the approach direction
                    float len = length(local);
                    vec3 closest = local * (0.5 / len);
                    vec3 d = local - closest;
                    float dist = length(d);
                    mat3 basis = splatBasis(texelA.w, texelB.w, texelB.xyz, mat3(shape_matrix_inv) * modelBasis);
                    clr[i] = dist <= length(transpose(basis) * (d / dist)) ? 1.0 : 0.0;
                }
            } else if (mode == 3) {
                // select by box (world-space, independent of camera frustum):
                // unit cube test in shape-local space
                vec3 local = (shape_matrix_inv * vec4(world, 1.0)).xyz;
                if (footprint <= 0.0) {
                    clr[i] = all(lessThanEqual(abs(local), vec3(0.5))) ? 1.0 : 0.0;
                } else {
                    vec3 closest = clamp(local, vec3(-0.5), vec3(0.5));
                    if (all(equal(closest, local))) {
                        clr[i] = 1.0;
                    } else {
                        vec3 d = local - closest;
                        float dist = length(d);
                        mat3 basis = splatBasis(texelA.w, texelB.w, texelB.xyz, mat3(shape_matrix_inv) * modelBasis);
                        clr[i] = dist <= length(transpose(basis) * (d / dist)) ? 1.0 : 0.0;
                    }
                }
            } else if (mode == 4) {
                // sphere brush: at footprint 0 a candidate must project inside
                // the stroked mask (what the user sees is what they paint); with
                // a footprint the extent widens both the cull and the capsule
                // test, so grazing splats count even where their center projects
                // outside the stroke or off screen
                if (footprint <= 0.0) {
                    vec4 brushClip = matrix_viewProjection * vec4(world, 1.0);
                    if (brushClip.w <= 0.0) {
                        continue;
                    }
                    vec3 brushNdc = brushClip.xyz / brushClip.w;
                    if (abs(brushNdc.x) > 1.0 || abs(brushNdc.y) > 1.0) {
                        continue;
                    }
                    if (texelFetch(mask, ivec2((brushNdc.xy * vec2(0.5, -0.5) + 0.5) * mask_params), 0).a < 1.0) {
                        continue;
                    }
                }

                if (pathCount == 0) {
                    continue;
                }

                bool useFootprint = footprint > 0.0;
                mat3 basisT = mat3(1.0);
                float margin = 0.0;
                if (useFootprint) {
                    mat3 basis = splatBasis(texelA.w, texelB.w, texelB.xyz, modelBasis);
                    basisT = transpose(basis);
                    // the frobenius norm bounds the extent in any direction
                    margin = sqrt(dot(basis[0], basis[0]) + dot(basis[1], basis[1]) + dot(basis[2], basis[2]));
                }

                if (any(lessThan(world, pathMin - vec3(margin))) || any(greaterThan(world, pathMax + vec3(margin)))) {
                    continue;
                }

                clr[i] = brushHitPath(world, basisT, useFootprint) ? 1.0 : 0.0;
            }
        }

        gl_FragColor = clr;
    }
`;

export { vertexShader, fragmentShader };
