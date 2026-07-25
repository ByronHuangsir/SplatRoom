const vertexShader = /* glsl*/`
#include "gsplatCommonVS"

uniform sampler2D splatState;

uniform vec4 selectedClr;
uniform vec4 lockedClr;

uniform vec3 clrOffset;
uniform vec4 clrScale;

varying mediump vec4 texCoord_flags;            // xy: texCoord, z: selected, w: locked
varying mediump vec4 color;
varying mediump float vDeleted;                  // 1.0 if deleted-but-shown, 0.0 otherwise

uniform float showDeleted;

#if PICK_PASS
    uniform uint pickOp;                        // 0: add, 1: remove, 2: set
    uniform int pickMode;                       // 0: pick id, 1: depth estimation
#endif

mediump vec4 discardVec = vec4(0.0, 0.0, 2.0, 1.0);

uniform float saturation;

vec3 applySaturation(vec3 color) {
    vec3 grey = vec3(dot(color, vec3(0.299, 0.587, 0.114)));
    return grey + (color - grey) * saturation;
}

void main(void) {
    // read gaussian details
    SplatSource source;
    if (!initSource(source)) {
        gl_Position = discardVec;
        return;
    }

    // get per-gaussian edit state, discard if deleted
    uint vertexState = uint(texelFetch(splatState, splat.uv, 0).r * 255.0 + 0.5) & 7u;

    #if PICK_PASS
        if (pickOp == 0u) {
            // add: skip locked and already-selected; skip deleted unless showDeleted
            if ((vertexState & 2u) != 0u || (vertexState & 1u) != 0u) {
                gl_Position = discardVec;
                return;
            }
            if ((vertexState & 4u) != 0u && showDeleted < 0.5) {
                gl_Position = discardVec;
                return;
            }
        } else if (pickOp == 1u) {
            // remove: pick selected splats (skip locked and unselected)
            if ((vertexState & 2u) != 0u || (vertexState & 1u) == 0u) {
                gl_Position = discardVec;
                return;
            }
        } else {
            // set: skip locked; skip deleted unless showDeleted
            if ((vertexState & 2u) != 0u) {
                gl_Position = discardVec;
                return;
            }
            if ((vertexState & 4u) != 0u && showDeleted < 0.5) {
                gl_Position = discardVec;
                return;
            }
        }
    #else
        // skip deleted splats (unless showDeleted is enabled)
        vDeleted = 0.0;
        if ((vertexState & 4u) != 0u) {
            if (showDeleted < 0.5) {
                gl_Position = discardVec;
                return;
            }
            vDeleted = 1.0;
        }
    #endif

    // get center
    vec3 modelCenter = getCenter();

    SplatCenter center;
    center.modelCenterOriginal = modelCenter;
    center.modelCenterModified = modelCenter;
    if (!initCenter(modelCenter, center)) {
        gl_Position = discardVec;
        return;
    }

    SplatCorner corner;
    if (!initCorner(source, center, corner)) {
        gl_Position = discardVec;
        return;
    }

    gl_Position = center.proj + vec4(corner.offset, 0.0);

    // store texture coord and locked state
    texCoord_flags = vec4(
        corner.uv,
        (vertexState & 1u) != 0u ? 1.0 : 0.0,       // selected
        (vertexState & 2u) != 0u ? 1.0 : 0.0        // locked
    );

    #if PICK_PASS
        if (pickMode == 1) {
            // depth estimation mode: compute normalized depth in vertex shader
            float linearDepth = -center.view.z;
            float normalizedDepth = (linearDepth - camera_params.z) / (camera_params.y - camera_params.z);
            vec4 clr = getColor();
            color = vec4(normalizedDepth, 0.0, 0.0, 1.0) * clr.a;
        } else {
            // pick id
            uvec4 bits = (uvec4(splat.index) >> uvec4(0u, 8u, 16u, 24u)) & uvec4(255u);
            color = vec4(bits) / 255.0;
        }
    // handle splat color
    #elif FORWARD_PASS
        // read color
        color = getColor();

        // evaluate spherical harmonics
        #if SH_BANDS > 0
        // calculate the model-space view direction
            vec3 dir = normalize(center.view * mat3(center.modelView));

            // read sh coefficients
            vec3 sh[SH_COEFFS];
            float scale;
            readSHData(sh, scale);

            // evaluate
            color.xyz += evalSH(sh, dir) * scale;
        #endif

        // apply tint/brightness
        color = color * clrScale + vec4(clrOffset, 0.0);

        // apply saturation
        color.xyz = applySaturation(color.xyz);

        // don't allow out-of-range alpha
        color.a = clamp(color.a, 0.0, 1.0);

        // apply tonemapping
        color = vec4(prepareOutputFromGamma(max(color.xyz, 0.0), -center.view.z), color.w);

        // apply locked/selected colors
        if ((vertexState & 2u) != 0u) {
            // locked
            color *= lockedClr;
        } else if ((vertexState & 1u) != 0u) {
            // selected
            color.xyz = mix(color.xyz, selectedClr.xyz, selectedClr.a);
        }
    #endif
}
`;

const fragmentShader = /* glsl*/`
varying mediump vec4 texCoord_flags;
varying mediump vec4 color;
varying mediump float vDeleted;

uniform bool outlineMode;
uniform float ringSize;
uniform float highlights;
uniform float shadows;
uniform float contrast;

// HSL per-channel uniforms (8 zones packed into 2 vec4s each)
// A = [R, O, Y, G], B = [A, B, P, M]
uniform vec4 hslHueA;
uniform vec4 hslHueB;
uniform vec4 hslSatA;
uniform vec4 hslSatB;
uniform vec4 hslLumA;
uniform vec4 hslLumB;

#if PICK_PASS
    uniform int pickMode;           // 0: id, 1: depth estimation
#endif

const float EXP4 = exp(-4.0);
const float INV_EXP4 = 1.0 / (1.0 - EXP4);

float normExp(float x) {
    return (exp(x * -4.0) - EXP4) * INV_EXP4;
}

vec3 applyHighlights(vec3 c) {
    float lum = dot(c, vec3(0.299, 0.587, 0.114));
    float mask = smoothstep(0.4, 0.8, lum);
    return c + c * mask * highlights * 0.5;
}

vec3 applyShadows(vec3 c) {
    float lum = dot(c, vec3(0.299, 0.587, 0.114));
    float mask = 1.0 - smoothstep(0.2, 0.5, lum);
    return c + c * mask * shadows * 0.5;
}

vec3 applyContrast(vec3 c) {
    return (c - 0.5) * (1.0 + contrast) + 0.5;
}

// ---- Per-channel HSL (Lightroom-style) ----

// Zone centers in [0,1] hue space (degrees / 360)
const float ZC_RED     = 0.0;
const float ZC_ORANGE  = 30.0 / 360.0;
const float ZC_YELLOW  = 60.0 / 360.0;
const float ZC_GREEN   = 120.0 / 360.0;
const float ZC_AQUA    = 180.0 / 360.0;
const float ZC_BLUE    = 225.0 / 360.0;
const float ZC_PURPLE  = 270.0 / 360.0;
const float ZC_MAGENTA = 315.0 / 360.0;

float hueDistance(float h1, float h2) {
    float d = abs(h1 - h2);
    return min(d, 1.0 - d);
}

float zoneWeight(float hue, float center) {
    float d = hueDistance(hue, center);
    return 1.0 - smoothstep(15.0 / 360.0, 45.0 / 360.0, d);
}

vec3 rgb2hsl(vec3 c) {
    float maxC = max(c.r, max(c.g, c.b));
    float minC = min(c.r, min(c.g, c.b));
    float l = (maxC + minC) * 0.5;
    float d = maxC - minC;
    float h = 0.0;
    float s = 0.0;
    if (d > 0.0001) {
        if (maxC == c.r) {
            h = mod((c.g - c.b) / d, 6.0) / 6.0;
        } else if (maxC == c.g) {
            h = ((c.b - c.r) / d + 2.0) / 6.0;
        } else {
            h = ((c.r - c.g) / d + 4.0) / 6.0;
        }
        s = d / (1.0 - abs(2.0 * l - 1.0) + 0.0001);
    }
    return vec3(h, s, l);
}

float hue2rgb(float p, float q, float t) {
    if (t < 0.0) t += 1.0;
    if (t > 1.0) t -= 1.0;
    if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
    if (t < 0.5) return q;
    if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
    return p;
}

vec3 hsl2rgb(float h, float s, float l) {
    if (s < 0.0001) return vec3(l);
    float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
    float p = 2.0 * l - q;
    return vec3(
        hue2rgb(p, q, h + 1.0 / 3.0),
        hue2rgb(p, q, h),
        hue2rgb(p, q, h - 1.0 / 3.0)
    );
}

vec3 applyPerChannelHSL(vec3 c) {
    // Early-out: skip if all adjustments are zero
    vec4 sum = hslHueA + hslHueB + hslSatA + hslSatB + hslLumA + hslLumB;
    if (dot(sum, sum) < 0.0001) return c;

    c = clamp(c, 0.0, 1.0);
    vec3 hsl = rgb2hsl(c);
    float h = hsl.x;
    float s = hsl.y;
    float l = hsl.z;

    float totalHue = 0.0;
    float totalSat = 0.0;
    float totalLum = 0.0;
    float totalW = 0.0;

    // Unrolled 8 zones
    float w;
    w = zoneWeight(h, ZC_RED);     totalHue += w * hslHueA.x; totalSat += w * hslSatA.x; totalLum += w * hslLumA.x; totalW += w;
    w = zoneWeight(h, ZC_ORANGE);  totalHue += w * hslHueA.y; totalSat += w * hslSatA.y; totalLum += w * hslLumA.y; totalW += w;
    w = zoneWeight(h, ZC_YELLOW);  totalHue += w * hslHueA.z; totalSat += w * hslSatA.z; totalLum += w * hslLumA.z; totalW += w;
    w = zoneWeight(h, ZC_GREEN);   totalHue += w * hslHueA.w; totalSat += w * hslSatA.w; totalLum += w * hslLumA.w; totalW += w;
    w = zoneWeight(h, ZC_AQUA);    totalHue += w * hslHueB.x; totalSat += w * hslSatB.x; totalLum += w * hslLumB.x; totalW += w;
    w = zoneWeight(h, ZC_BLUE);    totalHue += w * hslHueB.y; totalSat += w * hslSatB.y; totalLum += w * hslLumB.y; totalW += w;
    w = zoneWeight(h, ZC_PURPLE);  totalHue += w * hslHueB.z; totalSat += w * hslSatB.z; totalLum += w * hslLumB.z; totalW += w;
    w = zoneWeight(h, ZC_MAGENTA); totalHue += w * hslHueB.w; totalSat += w * hslSatB.w; totalLum += w * hslLumB.w; totalW += w;

    if (totalW > 0.0001) {
        h = mod(h + totalHue / totalW * 0.5 + 1.0, 1.0);
        s = clamp(s + totalSat / totalW, 0.0, 1.0);
        l = clamp(l + totalLum / totalW * 0.5, 0.0, 1.0);
    }

    return hsl2rgb(h, s, l);
}

void main(void) {
    mediump float A = dot(texCoord_flags.xy, texCoord_flags.xy);

    if (A > 1.0) {
        discard;
    }

    #if PICK_PASS
        if (pickMode == 1) {
            // depth estimation
            mediump float alpha = normExp(A);
            if (alpha < 1.0 / 255.0) {
                discard;
            }
            // we should multiply by alpha here to take into account gaussian falloff,
            // but it results in less accurate depth for some reason
            gl_FragColor = color * alpha;
        } else {
            // pick id
            gl_FragColor = color;
        }
    #else
        mediump float norm = normExp(A);
        mediump float alpha = norm * color.a;

        vec3 finalColor = color.xyz;
        finalColor = applyHighlights(finalColor);
        finalColor = applyShadows(finalColor);
        finalColor = applyContrast(finalColor);
        finalColor = applyPerChannelHSL(finalColor);

        // apply deleted point visual (red tint, reduced opacity)
        if (vDeleted > 0.5) {
            finalColor = mix(finalColor, vec3(1.0, 0.25, 0.25), 0.6);
            alpha *= 0.4;
        }

        if (texCoord_flags.w == 0.0 && ringSize > 0.0) {
            // rings mode
            if (A < 1.0 - ringSize) {
                alpha = max(0.05, alpha);
            } else {
                alpha = 0.6;
            }
        }

        bool selected = texCoord_flags.z != 0.0 && texCoord_flags.w == 0.0;

        if (outlineMode) {
            pcFragColor0 = vec4(finalColor * alpha, alpha);
            pcFragColor1 = vec4(0.0, 0.0, 0.0, selected ? norm : 0.0);
        } else {
            if (selected) {
                pcFragColor0 = vec4(finalColor * alpha * 0.8, alpha);
                pcFragColor1 = vec4(finalColor * alpha * 0.2, alpha);
            } else {
                pcFragColor0 = vec4(finalColor * alpha, alpha);
                pcFragColor1 = vec4(0.0, 0.0, 0.0, 0.0);
            }
        }
    #endif
}
`;

const gsplatCenter = /* glsl*/`
uniform highp usampler2D splatTransform;        // per-splat index into transform palette
uniform sampler2D transformPalette;             // palette of transform matrices

mat4 applyPaletteTransform(mat4 model) {
    uint transformIndex = texelFetch(splatTransform, splat.uv, 0).r;
    if (transformIndex == 0u) {
        return model;
    }

    // read transform matrix
    int u = int(transformIndex % 512u) * 3;
    int v = int(transformIndex / 512u);

    mat4 t;
    t[0] = texelFetch(transformPalette, ivec2(u, v), 0);
    t[1] = texelFetch(transformPalette, ivec2(u + 1, v), 0);
    t[2] = texelFetch(transformPalette, ivec2(u + 2, v), 0);
    t[3] = vec4(0.0, 0.0, 0.0, 1.0);

    return model * transpose(t);
}

uniform mat4 matrix_model;
uniform mat4 matrix_view;
#ifndef GSPLAT_CENTER_NOPROJ
    uniform vec4 camera_params;             // 1 / far, far, near, isOrtho
    uniform mat4 matrix_projection;
#endif

// project the model space gaussian center to view and clip space
bool initCenter(vec3 modelCenter, inout SplatCenter center) {
    mat4 modelView = matrix_view * applyPaletteTransform(matrix_model);
    vec4 centerView = modelView * vec4(modelCenter, 1.0);

    #ifndef GSPLAT_CENTER_NOPROJ

        // early out if splat is behind the camera (perspective only)
        // orthographic projections don't need this check as frustum culling handles it
        if (camera_params.w != 1.0 && centerView.z > 0.0) {
            return false;
        }

        vec4 centerProj = matrix_projection * centerView;

        // ensure gaussians are not clipped by camera near and far
        #if WEBGPU
            centerProj.z = clamp(centerProj.z, 0, abs(centerProj.w));
        #else
            centerProj.z = clamp(centerProj.z, -abs(centerProj.w), abs(centerProj.w));
        #endif

        center.proj = centerProj;
        center.projMat00 = matrix_projection[0][0];

    #endif

    center.view = centerView.xyz / centerView.w;
    center.modelView = modelView;
    return true;
}
`;

export { vertexShader, fragmentShader, gsplatCenter };
